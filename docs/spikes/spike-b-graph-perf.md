# Spike B — Pixi v8 5k-node soak + d3-force worker layout round-trip

**Plan spikes (ii) + (iii)** (plan §8.2 M0, blueprint §13.5) · Harness: `spikes/graph-perf/` ·
Raw numbers: `spikes/graph-perf/results/*.json` · Status: **executed 2026-07-04, headless**

## Question

Can the locked FE-4 graph stack — graphology store → d3-force simulation in a worker
exchanging transferable `Float32Array` position epochs → PixiJS v8 renderer on WebGL2 with
`antialias: false` (blueprint §8, ledger #4) — hold the 60 fps target / 30 fps floor at the
product ceiling of **5,000 nodes / 8,000 edges**, and is the worker round-trip cheap enough
that layout can never stall the render loop?

## Method

Two quarantined benchmarks, both on synthesized clustered graphs (seeded PRNG, exact
n/e counts, no real transcript data — [X2]). Host: the actual target machine (Apple
M4 Max, macOS 26.6, Node v25.8.0).

**(iii) Worker layout round-trip** — `src/bench-layout.ts`. d3-force 3.0.0 inside a Node
`worker_threads` worker with the FE-4-representative force set (`forceLink` distance 30 ·
`forceManyBody` strength −30, Barnes-Hut θ 0.9 · weak x/y centering) held at
`alphaTarget(0.3)` — the "gentle reheat, never settles" live-graph steady state. Measured at
1k/3k/5k nodes (edges = 1.6×): worker-side tick cost, ping-pong round-trip (buffer
transferred main→worker, one tick, filled + transferred back; 300 samples after 30 warmup),
echo-only round-trip (200 samples, zero compute — isolates messaging), and free-run epoch
throughput (300 epochs, fresh 8n-byte buffer per epoch).

**(ii) Pixi v8 render soak** — `src/bench-pixi.ts` + `browser/pixi-soak.ts`. pixi.js 8.19.0,
`antialias: false`, 1600×1000 canvas at `resolution: 1`. Scene: n sprites (one shared
generated circle texture, per-cluster tint, varied scale) + e edges in a single `Graphics`
**fully cleared and re-stroked every frame**, with every node position changing every frame
(deterministic drift) — the worst-case "layout still hot" regime; both hairline
(`pixelLine: true`, native GL lines) and default tessellated strokes measured. Two phases per
run: 8 s rAF-paced (after 1.5 s warmup) and 300 unthrottled back-to-back `app.render()` calls
(main-thread submission cost). Driven by Playwright 1.61 in three configs: Chromium headless
default (SwiftShader), Chromium headless `--use-angle=metal` (real M4 Max GPU), WebKit
headless (Apple GPU).

**Headless limitations (explicit):**

- **No real GUI window, no Tauri.** Playwright WebKit approximates WKWebView (same engine
  lineage, different embedder/compositor); the Chromium runs are not the product web view at
  all. The plan's "in a Tauri window" clause is deliberately deferred to T3.
- **rAF pacing artifacts:** headless Chromium+ANGLE-Metal paced frames at 120 Hz and headless
  WebKit at ~85 Hz; both engines *pinned* their pacing rate, so measured rAF fps is a floor
  ("never missed a slot"), not a ceiling. The unthrottled phase carries the headroom signal.
- **Unthrottled numbers under-count GPU-side cost on hardware** (GL submission is async; a
  final `gl.finish()` drains the queue but per-frame raster overlaps). On SwiftShader the
  raster runs on CPU threads, making the *rAF* numbers there an honest full-pipeline software
  lower bound.
- **worker_threads ≈ browser module worker:** same V8, same structured-clone +
  transfer-list semantics; a browser adds main-thread compositor contention this cannot see.
- No user-interaction load (pan/zoom/hit-testing) and DPR fixed at 1 (retina is ~4× fragment
  load) — both T3 items.

## Result

### (iii) Layout worker — measured

| n / e | worker tick mean / p95 | tick round-trip mean / p95 | transfer overhead mean | echo RT mean | free-run epochs/s |
|---|---|---|---|---|---|
| 1,000 / 1,600 | 1.70 / 1.94 ms | 1.74 / 2.01 ms | 0.04 ms | 0.023 ms | 586 |
| 3,000 / 4,800 | 6.40 / 6.90 ms | 6.53 / 7.07 ms | 0.13 ms | 0.018 ms | 156 |
| 5,000 / 8,000 | 11.23 / 11.91 ms | 11.66 / 12.36 ms | 0.43 ms | 0.025 ms | **87** |

(Table matches the committed `results/layout-latest.json` ==
`results/layout-run-2026-07-04T05-23-31-172Z.json` capture — 2026-07-04, mains power,
no other heavy workload; captures are append-only, one timestamped file per run.
Run-to-run honesty: an earlier same-day run under ambient host load — preserved as
`layout-run-2026-07-04T05-16-22-994Z.json` — inflated the *small-n* cells up to ~1.8×
(1k worker tick 3.12 ms vs 1.70 ms) while the verdict-bearing 5k cells moved < 3%
(worker tick 11.55 vs 11.23 ms, free-run 89 vs 87 epochs/s). Small-n cells are
noise-sensitive; the 5k row is robust.)

Sim build (init from arrays): 1.7 / 4.2 / 5.0 ms at 1k/3k/5k. A 5k position epoch is 40 KB;
zero-copy transfer of it costs ~0.02–0.5 ms round-trip — **messaging is noise; the tick is
everything, and the tick lives on the worker thread.** At 5k the worker sustains ~87
epochs/s, comfortably above a 60 Hz consumption rate; the worst tick observed across runs
(a ~43 ms GC outlier at 5k) means one late epoch, invisible behind interpolated rendering.
Corollary: on the main
thread the same tick would eat ~67% of a 16.7 ms frame budget — **the worker is mandatory,
not an optimization.**

### (ii) Pixi v8 soak — measured

| Config (renderer string) | n / e | edges | rAF fps | frame mean / p95 | frames >16.7 ms | frames >33.3 ms | unthrottled ms/frame (mean) |
|---|---|---|---|---|---|---|---|
| Chromium **SwiftShader** (software) | 1k / 1.6k | hairline | 114.6 | 8.7 / 10.3 ms | 0% | 0% | 0.35 |
| Chromium SwiftShader | 3k / 4.8k | hairline | 33.9 | 29.5 / 34.4 ms | 100% | 7.7% | 1.01 |
| Chromium SwiftShader | 5k / 8k | hairline | 20.3 | 49.4 / 56.7 ms | 100% | 100% | 2.02 |
| Chromium SwiftShader | 5k / 8k | tessellated | 12.9 | 77.3 / 87.3 ms | 100% | 100% | 2.24 |
| Chromium **ANGLE-Metal (Apple M4 Max)** | 5k / 8k | hairline | **120.0 (pinned)** | 8.33 / 9.9 ms | **0%** | 0% | 1.88 |
| Chromium ANGLE-Metal | 5k / 8k | tessellated | **120.0 (pinned)** | 8.33 / 9.8 ms | **0%** | 0% | 2.17 |
| WebKit **Apple GPU** | 1k / 1.6k | hairline | 85.0 (pinned) | 11.8 / 14.0 ms | 0% | 0% | 0.45 |
| WebKit Apple GPU | 5k / 8k | hairline | **85.0 (pinned)** | 11.8 / 13.0 ms | 0.1% | 0% | 1.91 |
| WebKit Apple GPU | 5k / 8k | tessellated | **85.0 (pinned)** | 11.8 / 13.0 ms | **0%** | 0% | 2.09 |

Readings:

- **On real hardware, both engines pin their pacing rate at 5k/8k with essentially zero
  dropped frames** — including the tessellated-stroke worst case and with the entire edge
  set re-tessellated every frame.
- **Main-thread render cost at 5k/8k is ~1.9–2.2 ms/frame** (path rebuild + tessellation +
  buffer upload + draw submission). Against a 16.7 ms budget that is ~87% headroom — room
  for React islands, WS ingestion, and the position-apply loop on the same thread.
- The SwiftShader rows are the software-rasterizer lower bound, not the product
  environment; even fully software, 3k nodes with hairlines stays above the 30 fps floor.
  They also expose the real raster cost ordering: switching hairline (`pixelLine`) edges to
  tessellated strokes drops software fps by ~36% (20.3 → 12.9) — a delta invisible on
  hardware but decisive without it.
- Scaling is linear and gentle: 1k→5k multiplies unthrottled main-thread cost by ~5.7×
  (0.35→2.0 ms), no cliff.

### Combined budget at the 5k/8k ceiling (measured, hardware)

Render main thread ~2.2 ms/frame + epoch receive ~0.5 ms ≪ 16.7 ms; layout ~11.2 ms/tick
confined to the worker at ~87 epochs/s. The two loops are decoupled by construction
(renderer interpolates between epochs, per the findings doc), so even a 2× layout
degradation (~43 Hz epochs) degrades motion smoothness, not frame rate.

## Confidence

**Medium-high.**

- **High** on spike (iii): CPU-bound, same V8 as the shipped WebView, measured on the actual
  target machine; browser-side messaging semantics are identical by spec.
- **Medium** on spike (ii): the GPU numbers come from real M4 Max hardware through two
  independent engines (ANGLE-Metal Chromium and Apple-GPU WebKit) — but neither is the real
  WKWebView inside a real Tauri window with a real compositor, retina DPR, and ProMotion
  pacing. Margins are so large (0% dropped frames, ~87% main-thread headroom, and even a
  pure *software* rasterizer still delivering 20 fps at the full 5k ceiling) that a
  WKWebView-specific pathology
  severe enough to erase them would be a categorical breakage — the same class of risk
  spike (i)/(iv) watch — not a perf shortfall.

## Verdict

**GO — the graphology → d3-force-worker → Pixi v8 WebGL2 stack is confirmed for FE-4 at the
5k-node/8k-edge ceiling** (blueprint ledger #4 stands; no renderer re-litigation).

**The fps floor M4 must hold** (referenced by the plan's M4 DoD "5k-node soak still meets
the M0 spike's fps floor" and the §9.2 FE-4 edge column):

> **60 fps sustained at 5,000 nodes / 8,000 edges during active layout** on the live host —
> operationally: rAF frame-time p95 ≤ 16.7 ms with < 1% of frames over 16.7 ms across an
> 8 s+ hot-layout soak window, `antialias: false`, retina DPR. **30 fps (any sustained
> frame time > 33.3 ms) is the hard floor and degrade trigger**, not the target.

Locked by the measurements (copy conclusions, not spike code):

1. **Layout runs in the worker, mandatory** — an ~11.2 ms tick on main would consume ~67% of
   the frame budget by itself.
2. **Transferable `Float32Array` epochs are the confirmed protocol** — ~0.02–0.5 ms
   round-trip at 5k; never copy, never JSON.
3. **`antialias: false` stays normative** (all numbers above are with it off; pixi #10413).
4. **Hairline edges (`stroke({ pixelLine: true })`) are the default edge style** — equal on
   hardware, ~57% higher fps on software rasterizers, and the correct Obsidian-style look.
5. **Renderer interpolates between epochs**; sim tick rate is allowed to float (~87 Hz
   measured, 30 Hz acceptable) without touching frame rate.

**Fallback ladder if the T3 Tauri-window run misses the floor** (go/fallback consequence):

- *Miss at 60 but hold 30:* ship with the day-one FE-4 degrade levers — layer toggles +
  cluster-dim (cuts drawn edges), LOD node capping, reduced sim tick rate. These are already
  mandated features, not new work.
- *Miss 30 (categorical WKWebView GL problem):* swap the renderer behind the normative
  GraphStore → LayoutBridge → GraphRenderer contract (cosmos.gl GPU path is the named
  plug-in candidate) without touching store or worker; if WKWebView GL is broken outright,
  that co-occurs with spike (i) xterm-WebGL breakage and escalates to the blueprint §2
  Chrome-as-frontend route — never a canvas rebuild.
- *Layout (not render) degrades on live data:* tune `forceLink.iterations`/θ, or switch to
  graphology's official FA2 worker build — the epoch protocol is engine-agnostic.

## What remains for a live-host (T3) confirmation

1. **Re-run `browser/pixi-soak.ts` inside the real Tauri WKWebView window** (M2, once FE-2's
   shell exists) on macOS 26.6: confirm ProMotion/uncapped pacing (the macOS-26 60 fps-cap
   removal), `devicePixelRatio: 2` cost (headless ran DPR 1; retina ≈ 4× fragments — measured
   headroom covers it, but verify), and the unmasked renderer string is Apple-GPU hardware,
   not a software fallback.
2. **Browser module worker round-trip in WKWebView** (Vite module worker + transferables,
   Safari 15+ path per the coherence findings) replacing the worker_threads proxy, measured
   with the compositor under load.
3. **Interaction soak:** pixi-viewport pan/zoom + hover hit-testing at 5k while the layout is
   hot, plus the incremental-mutation path (batch per rAF/150 ms, `alphaTarget(0.3)` reheat).
4. **Duration soak (M4/T4 gate):** 30+ min at 5k/8k watching for RSS growth from the
   per-frame `Graphics` clear/re-stroke cycle and epoch-buffer churn.
