# SPIKE-A verdict — xterm 6 WebGL viability in WKWebView (i) + `navigator.gpu` probe (iv)

- **Spikes:** plan §8.2 M0 (i) + (iv); blueprint §13.5 items (i), (iv)
- **Harness:** `spikes/webview-render/` (quarantined; results in `spikes/webview-render/results/`)
- **Date / host:** 2026-07-04, macOS 26.6 (25G5028f), Apple Silicon (darwin arm64), Node v25.8.0
- **Status:** executed headlessly; T3 (live Tauri WKWebView) confirmation items listed at the end

---

## Question

1. **(i)** Does `@xterm/xterm` **6.0.0** with `@xterm/addon-webgl` **0.19.0** work inside a
   WKWebView-class WebKit on macOS 26.6 — the canvas renderer no longer exists in xterm 6, and
   "Safari-26 WebGL breakage" was an open risk — and what throughput does it sustain? What does
   the DOM-renderer fallback floor look like if WebGL is broken on the real host?
2. **(iv)** Is `navigator.gpu` (WebGPU) present in that WebKit, and does `requestAdapter()`
   return an adapter?

## Method

**Proxy:** Playwright **WebKit 26.5** (build `webkit-2311`) driving `page/index.html` from a
loopback static server. Playwright WebKit is the same WebKit engine family that backs WKWebView
on this macOS — it exercises the engine-level questions (does WebGL2 exist, does the xterm 6
WebGL renderer initialize, does context loss recover) — but it is **not** WKWebView-as-embedded-
by-Tauri: GPU-process configuration, compositing (IOSurface), and feature flags can differ.
Stated limitations:

- **Headless-first.** The canonical run is headless; one `--headed` run (a real window on this
  Mac) was also captured and agreed with headless on every conclusion. rAF cadence in this
  environment varied between ~60 and ~85 Hz across runs; real-display vsync behavior is a T3
  item.
- **Synthetic data.** 100,000 synthesized ANSI-SGR-colored lines (~12.5 MB, ~125 B/line),
  deterministic generator — no real transcripts, no identifiers [X2]. No real `claude` TUI.
- **Simulated context loss** via `WEBGL_lose_context.loseContext()` on the addon's canvas — a
  spec-correct trigger, but not a real GPU reset / backgrounding eviction (T3 item).
- Memory/VRAM growth is unmeasurable here (`performance.memory` is Chromium-only).

Workloads per renderer (WebGL-preferred run, then forced-DOM run on a fresh page):
100k-line bulk write (1,000-line chunks, completion via `term.write` callback + double-rAF
settle, rAF gap sampler running throughout); paced streaming (40 lines/frame × 300 frames);
then, on the WebGL run only: context-loss drill and post-loss marker write; `navigator.gpu`
probe; raw WebGL2 vendor probe. Terminal: 160×45, scrollback 10,000.

## Result (measured)

**(i) xterm 6 WebGL: WORKS in the proxy.** Across three final-harness runs (2 headless,
1 headed), all nine PASS gates held:

| Measure | WebGL renderer | DOM renderer (fallback) |
|---|---|---|
| Addon load | loads clean, no throw; 1 WebGL2 canvas + link-layer; texture atlas present | n/a (xterm 6 default) |
| 100k-line bulk (12.5 MB) | **154–195 ms wall → 513k–649k lines/s (64–81 MB/s)** | **150–185 ms → 540k–667k lines/s (68–83 MB/s)** |
| Bulk-phase rAF gaps | mean 20–31 ms, p95 28–80 ms | mean 15–27 ms, p95 19–40 ms |
| Paced stream, 40 lines/frame | **holds the env rAF ceiling** (60–85 Hz across runs), p95 gap ≤18 ms, zero long frames | same |
| Context losses during writes | **0** in every run | 0 |
| Buffer after 100k lines | 10,045 lines (scrollback cap + viewport) — correct | same |

Bulk throughput is **parser-bound**, not renderer-bound (WebGL/DOM ratio 0.89×–1.19× across
runs, i.e. noise). Both renderers absorb 100k lines in ~0.2 s. The DOM fallback floor is
comfortably above any realistic TUI stream rate — ~0.5M lines/s against a `claude` TUI that
emits orders of magnitude less.

**Context-loss → fallback chain: PROVEN end to end.**
`WEBGL_lose_context` on the addon's canvas → addon's internal handler (`preventDefault()` +
**3,000 ms restoration grace window** — measured in the shipped addon bundle:
`setTimeout(..., 3e3)` before `onContextLoss` fires) → our `onContextLoss` handler disposes the
addon → xterm reverts to the DOM renderer (canvas count 2→0, `.xterm-rows` 0→45) → post-loss
marker line written and read back from the buffer (**marker FOUND**), scrollback intact at
10,045 lines, zero page errors. The terminal buffer is CPU-side; renderer death loses no data.

**Raw WebGL2:** available; vendor `WebKit`/`WebKit WebGL`, unmasked `Apple Inc. / Apple GPU` —
a genuinely GPU-backed context even headless.

**(iv) `navigator.gpu`: ABSENT in the proxy — headless AND headed.** `'gpu' in navigator` is
`false` (`typeof navigator.gpu === 'undefined'`), so `requestAdapter()` was never reachable.
This is a property of **Playwright's WebKit build/feature flags**, not proof about WKWebView:
Safari 26 ships WebGPU, and WKWebView exposure depends on embedder preferences (what Tauri v2
enables on macOS 26.6 is exactly the open question). The probe therefore returns
**inconclusive-negative**: presence cannot be confirmed from this proxy; only the probe's shape
and its well-formed negative path were validated.

## Confidence

- **(i) WebGL viability: MEDIUM-HIGH.** Engine-level breakage (the actual top-risk scenario:
  "Safari-26 WebGL broken → xterm 6 has no canvas renderer to hide behind") is effectively ruled
  out — WebKit 26.5 initializes the xterm 6 WebGL renderer and survives the workload in both
  headless and headed modes. Residual risk is embedder-level (Tauri's WKWebView GPU-process
  config), which the runtime-detection contract below absorbs regardless.
- **(i) DOM fallback floor: HIGH.** Measured directly; parser-bound; no GPU dependence at all.
- **(iv) WebGPU presence: LOW.** The proxy cannot answer it (flag-dependent). The product must
  runtime-probe; nothing in v1 is load-bearing on WebGPU.

## Verdict

**(i) GO: FE-3 ships the WebGL addon as the preferred renderer, wrapped in the mandatory
runtime detection + DOM fallback below.** The plan's fallback ladder (§11: "WebGL broken → ship
DOM renderer; if throughput unacceptable → escalate to Chrome-as-frontend — never rebuild on
canvas") stands, but the measured DOM floor (~0.5M lines/s, paced streaming at the rAF
ceiling) means the
**Chrome-as-frontend escalation is very unlikely to be needed even if WebGL is broken in the
real WKWebView** — the DOM renderer alone would be acceptable for TUI-rate streams. No
canvas-renderer rebuild, ever.

**(iv) INCONCLUSIVE-NEGATIVE, and deliberately non-blocking: treat WebGPU as absent in
WKWebView until the T3 probe says otherwise.** Consequence per blueprint §2/§8: the context
graph stays on **PixiJS v8 / WebGL2** (no change), and Chrome remains the free second frontend
whenever WebGPU is wanted. FE-4 must not require WebGPU on the Tauri path; the runtime probe
(below) reports the real answer as env telemetry from the live app.

---

## The renderer-detection contract FE-3 must implement

This is the normative design the spike validated (module sketch —
`app/src/islands/terminal/renderer.ts`; FE-3 reimplements it, never imports spike code):

```ts
type RendererMode = 'webgl' | 'dom';
type RendererReason = 'webgl-ok' | 'webgl-throw' | 'context-loss' | 'forced-dom';

interface RendererSelection {
  mode: RendererMode;
  reason: RendererReason;
  webglAddon: WebglAddon | null;      // null when mode === 'dom'
  detail?: string;                     // throw message, for telemetry only
}

/** Call once per terminal attach (and again on every reattach). */
function attachRenderer(
  term: Terminal,
  opts: { forceDom?: boolean; onFallback?: (sel: RendererSelection) => void },
): RendererSelection;
```

Required behavior (each clause was exercised by the spike):

1. **Override first.** `forceDom` (settings/env) skips WebGL entirely →
   `{mode:'dom', reason:'forced-dom'}`. Needed for T3 triage and degraded-GPU hosts.
2. **Try-throw selection.** Construct `WebglAddon`, subscribe `onContextLoss` **before**
   `term.loadAddon(addon)`, then load. Any throw → catch, discard the addon →
   `{mode:'dom', reason:'webgl-throw', detail}`. xterm 6's default renderer IS the DOM
   renderer, so "fallback" is simply *not loading the addon*.
3. **Context loss at runtime.** The addon fires `onContextLoss` only after its internal
   **3 s restoration grace window** (it `preventDefault()`s `webglcontextlost` and waits for
   `webglcontextrestored`). On fire: `addon.dispose()` (guarded — dispose exactly once), flip to
   `{mode:'dom', reason:'context-loss'}`, invoke `onFallback`. **Do not re-attempt WebGL within
   the same attach** — loss loops must degrade permanently to DOM, not flap.
4. **Data is never at risk.** The buffer/scrollback is CPU-side; the spike proved writes issued
   during and after loss land intact (post-loss marker check). No save/restore logic is needed
   in the fallback path — only renderer swap.
5. **Reattach resets selection.** On serialize-addon detach→reattach, run `attachRenderer`
   from step 1 again: a fresh attach may succeed at WebGL even if a prior one fell back.
6. **Stale-canvas window.** Up to ~3 s of frozen pixels can precede the fallback after a real
   loss. Optional polish: also listen to raw `webglcontextlost` on the addon canvas for an early
   "renderer degraded" hairline notice; never block on it.
7. **Telemetry, no identifiers.** Emit one collector event per selection/fallback:
   `{mode, reason, detail?}` — file-path/session-scope only, no account data [X2].
8. **Test signals** (used by the spike, reusable in FE-3 component tests): WebGL active ⇔
   `term.element.querySelectorAll('canvas').length > 0` and `.xterm-rows` absent/empty;
   DOM active ⇔ `.xterm-rows` populated; secondary signal `addon.textureAtlas != null`.

## The WebGPU runtime probe FE-4/shell must implement

```ts
interface WebGPUProbe {
  available: boolean;                  // true only if adapter obtained
  reason?: 'no-navigator-gpu' | 'no-adapter' | 'error';
  adapterInfo?: { vendor: string | null; architecture: string | null };
}
async function probeWebGPU(): Promise<WebGPUProbe>;
```

- Check `'gpu' in navigator` first; a present `navigator.gpu` with a **null adapter** is still
  "unavailable" (seen in headless/GPU-process-denied environments elsewhere).
- Run once at shell boot, report as env telemetry; **never gate a v1 feature on it**. Pixi v8
  graph stays WebGL2 either way; WebGPU is a Chrome-frontend-only nicety until proven in T3.

## What remains for live-host (T3) confirmation

1. **Real Tauri v2 WKWebView on macOS 26.6:** load this same harness page in a Tauri dev window
   and re-run both workloads — confirm addon load, 0 context losses, and throughput within ~2×
   of the proxy numbers. (The harness's static server + `window.__spike` API need no changes.)
2. **Real context-loss triggers:** window occlusion/minimize, display sleep, external-display
   unplug, and GPU-process kill — confirm the 3 s-grace → dispose → DOM chain fires outside the
   simulated `WEBGL_lose_context` path.
3. **`navigator.gpu` in the real WKWebView** (the actual spike-iv answer): probe in the Tauri
   window; if absent, check what WKPreferences/feature flags Tauri v2 exposes; append the result
   to this doc as a dated addendum.
4. **Display-true frame pacing:** paced-stream fps on the physical (ProMotion) display — the
   proxy's ~60–85 Hz rAF is synthetic.
5. **Long-session soak** (≥30 min continuous stream): texture-atlas/VRAM growth and RSS — not
   measurable headlessly.
