# Frontend stack coherence — resolving the graph-renderer and framework contradictions

**Stage-1 gap-filler / tie-break research · the-last-aibender · researched 2026-07-03**

Scope: this doc resolves the two contradictions between
`frontend-app-shell-stack.md` and `ui-motion-3d-context-graph.md` — (a) the flagship
context-graph renderer (three.js/`3d-force-graph` vs graphology + d3-force worker + PixiJS v8)
and (b) framework/animation coherence (Svelte 5 vs the React assumptions baked into Motion v12
`motion/react` and react-three-fiber) — and then locks ONE coherent, versioned, license-checked
frontend dependency set that **supersedes the conflicting lists in both prior docs**.
Account identifiers are placeholders only: MAX_A, MAX_B, ENT, AWS_DEV_ACCOUNT_ID.

---

## TL;DR

1. **Graph renderer (contradiction a): CONFIRM the deep-dive.** Primary stack = **graphology (store) + d3-force in a Web Worker + PixiJS v8 renderer on WebGL2**. `3d-force-graph` is demoted to an optional, deferred 3D showcase mode behind the renderer interface. The one-line three.js pick in `frontend-app-shell-stack.md` §Recommendation is superseded.
2. **Framework (contradiction b): React 19.2 + zustand 5 + React Compiler 1.0** — resolving the framework hedge by exercising the app-shell doc's own documented fallback, not by inventing a third option. Svelte 5 is superseded for this project.
3. Decisive evidence: Motion v12 officially supports **React, Vue, and vanilla JS only** — no Svelte adapter (open request since 2024-11; the community wrapper is a dead 0.0.1 experiment pinned to motion@11). TanStack Virtual's `anchorTo: 'end'` **is core-level** (virtual-core ≥ 3.16.0) so Svelte *could* reach it — but the Svelte adapter is Svelte-4-store-based with an open Svelte 5 element-binding bug (#866), while the React adapter is the reference implementation the chat guide is written against.
4. AI-codegen fluency seals it: this harness is largely built BY coding agents (`ui-anti-slop-design.md`), LLM Svelte-5/runes regressions are a documented failure mode requiring MCP/llms.txt mitigation, and the LLM webdev evaluation ecosystem (WebDev Arena) is React/Next-first. React needs no mitigation layer.
5. Svelte's genuine runtime advantages are **neutralized by this architecture**: the three hot surfaces (Pixi graph ticker, xterm canvas, virtual-core-measured transcript DOM) bypass framework reactivity entirely; the mandated non-reactive ring buffer + rAF-batched projection maps 1:1 onto zustand vanilla stores with transient `subscribe`.
6. The **store→renderer boundary contract** both docs gestured at is specified below (graphology events → worker layout protocol with transferable `Float32Array` position epochs → `GraphRenderer` interface) — Pixi is the first implementation; cosmos.gl (corpus mode) and 3d-force-graph (showcase) plug in later without touching the store.
7. **Locked dependency set** (registry-verified 2026-07-03, §Recommendation): react/react-dom 19.2.7, zustand 5.0.14, motion 12.42.2, graphology 0.26.0, d3-force 3.0.0, pixi.js 8.19.0, pixi-viewport 6.0.3, @tanstack/react-virtual 3.14.5 (core 3.17.3), @xterm/xterm 6.0.0 + webgl/fit/serialize addons, vite 8.1.3, tailwindcss 4.3.2 (token-locked). All MIT except d3-force (ISC, MIT-equivalent). No paid/binary assets.
8. **New risk surfaced:** xterm.js WebGL rendering is reported broken in Safari on macOS 26.5 beta (open issue #5816, 2026-04) **and** xterm 6.0.0 removed the canvas renderer — so in WKWebView the only fallback is the DOM renderer. A WKWebView terminal-renderer spike joins the Stage-2 list.
9. PixiJS v8 in WKWebView: desk research finds **no known blockers** at 1–5k nodes on WebGL2 (ANGLE-on-Metal); known footgun is `antialias: true` (#10413 — keep it off); macOS 26 removed WKWebView's 60 fps cap. Module workers + transferable `ArrayBuffer` are supported from Safari 15+, so the Vite module-worker layout design is safe. The `navigator.gpu` WebGPU probe remains a separate Stage-2 spike.

---

## Current landscape

### What exactly contradicts what

| Axis | `frontend-app-shell-stack.md` | `ui-motion-3d-context-graph.md` | Coherent? |
|---|---|---|---|
| Graph renderer | "three.js (WebGL2) via `3d-force-graph`, or Cosmograph if node counts grow" (one line in §Recommendation) | graphology + d3-force worker + PixiJS v8; 3d-force-graph explicitly demoted to optional 3D showcase (a full options analysis) | ✗ |
| Framework | Svelte 5 (runes) primary; "React 19 + zustand" as documented fallback | Assumes React throughout: Motion imported as `motion/react`, react-three-fiber cited for a 3D mode | ✗ |
| Animation | (not covered) | Motion v12 as the single UI animation dependency | ✗ with Svelte pick |
| Virtualization | TanStack Virtual `anchorTo: 'end'` for streaming transcripts (framework-agnostic claim implied) | (not covered) | needs verification |
| Everything else | Tauri v2 shell + TS daemon + WS transport + xterm.js — **no conflict**; the deep-dive's event pipeline and the app-shell's daemon design compose cleanly | | ✓ |

Both docs were researched the same day by different agents; the contradiction is a coordination
artifact, not a disagreement about evidence. The deep-dive spent its entire budget on the graph
question; the app-shell doc spent one sentence on it. Conversely the app-shell doc did the real
framework analysis; the deep-dive silently assumed React. This doc arbitrates with fresh
verification on every load-bearing claim.

### Verified facts (2026-07-03, registry/GitHub/docs + read-only local checks)

**Motion v12 framework support.** Motion's own site markets it as an animation library "for React,
JavaScript and Vue" ([motion.dev](https://motion.dev/)). There is **no official Svelte adapter**;
the request for one ([motion #2895](https://github.com/motiondivision/motion/issues/2895), opened
2024-11-18) remains open with no maintainer commitment. The community `motion-svelte` wrapper
([epavanello/motion-svelte](https://github.com/epavanello/motion-svelte)) is an explicitly
"experimental" 0.0.1 published 2024-12, peer-pinned to `motion ^11` — i.e. effectively abandoned
against motion 12.42.2. The older `svelte-motion` project is a port of legacy Framer Motion.
Motion's **vanilla** `animate()` / springs / timeline work in any framework (that part of the
deep-dive holds), but the features the harness chrome wants from Motion — layout animations,
`AnimatePresence` exit choreography, `useReducedMotion` — live in `motion/react` (and a Vue
equivalent), not in vanilla.

**Svelte-native animation coverage.** `svelte/motion` ships `Spring` and `Tween` **classes**
(Svelte 5.8+, replacing the deprecated `spring()`/`tweened()` stores) with real spring physics
(`stiffness`, `damping`, `preserveMomentum`) plus a built-in `prefersReducedMotion` query (5.7+)
([svelte.dev/docs/svelte/svelte-motion](https://svelte.dev/docs/svelte/svelte-motion)). Combined
with Svelte transitions and the FLIP `animate:` directive, this covers **springs, tweens, camera
easing, and keyed-list reorder** — but has no equivalent of Motion's shared-layout transitions or
exit-presence orchestration; those would be hand-rolled or GSAP-assisted under Svelte.

**TanStack Virtual end-anchored mode.** `anchorTo` is documented as an option of the
**framework-agnostic core `Virtualizer`**, along with `followOnAppend`, `scrollEndThreshold`,
`scrollToEnd()`, `isAtEnd()`, `getDistanceFromEnd()`
([Virtualizer API](https://tanstack.com/virtual/latest/docs/api/virtualizer)); it shipped in
`@tanstack/virtual-core` 3.16.0 (current core: 3.17.3; announcement:
[Chat UIs Are Lists Until They Aren't](https://tanstack.com/blog/tanstack-virtual-chat)). So the
mode is **not React-only at the engine level**. However: the chat guide and example are
React-only; `@tanstack/react-virtual` 3.14.5 is the reference adapter; and
`@tanstack/svelte-virtual` 3.13.31, while peer-ranged for `svelte ^3.48 || ^4 || ^5` and wrapping
core 3.17.3 (so it can *pass* `anchorTo` through), is still **Svelte-store-based** (not runes) and
carries an open Svelte 5 bug — empty render due to lost scroll-element binding, worked around by
manually calling `$virtualizer._willUpdate()`
([TanStack/virtual #866](https://github.com/TanStack/virtual/issues/866); Svelte 5 adapter
discussion [#796](https://github.com/TanStack/virtual/discussions/796)). Verdict: **available in
Svelte with friction (buggy adapter or a hand-rolled ~50-line rune binding over virtual-core);
first-class in React.** This confirms the app-shell doc's reliance on `anchorTo: 'end'` is safe —
under React.

**React 19 / Compiler status.** React 19.2 went stable 2025-10-01
([react.dev](https://react.dev/blog/2025/10/01/react-19-2)); React Compiler 1.0 (automatic
memoization, Vite/Next/Expo integrations, compiler-powered lint rules) went stable 2025-10-07
([react.dev](https://react.dev/blog/2025/10/07/react-compiler-1)). Current npm: react/react-dom
19.2.7, `babel-plugin-react-compiler` 1.0.0. The compiler removes most of the manual-memo tax
that motivated the app-shell doc's "no dependency-array/memo tax while streaming" argument for
Svelte.

**Svelte 5 + AI codegen.** Svelte 5.56.4 is current. The "LLMs emit Svelte 4 syntax / mix runes
with legacy reactivity" problem is real and documented
([khromov](https://khromov.se/getting-better-ai-llm-assistance-for-svelte-5-and-sveltekit/),
[sveltejs/svelte discussion #14125](https://github.com/sveltejs/svelte/discussions/14125)).
Mitigations are now official — `svelte.dev/docs/ai` llms.txt bundles and an official MCP server
(`@sveltejs/mcp`, remote at mcp.svelte.dev, with a `svelte-autofixer` static-analysis tool)
([svelte.dev/docs/ai](https://svelte.dev/docs/ai)) — but they are *mitigations that every build
agent must carry*. React requires none. The de-facto LLM webdev evaluation arena (WebDev Arena /
LMArena) generates and judges **Next.js/React** apps as its first-class target
([arena.ai blog](https://arena.ai/blog/webdev-arena/)), which both reflects and reinforces where
model fluency is concentrated. For a codebase whose stated build strategy is "agents build it
under a token lock" (`ui-anti-slop-design.md`), framework fluency is a first-order engineering
input, not a taste preference.

**xterm.js moved to 6.0.0 — with a Safari-26 warning.** `@xterm/xterm` is now 6.0.0 (released
~Dec 2025; the app-shell doc's "5.x" is already stale). 6.0.0 **removed the canvas renderer
entirely** — remaining renderers are DOM and WebGL — and adopted VS Code's viewport/scrollbar
base ([release notes](https://github.com/xtermjs/xterm.js/releases/tag/6.0.0)). Meanwhile an open
issue reports xterm's **WebGL rendering "totally broken" in Safari on macOS 26.5 beta**
([xterm.js #5816](https://github.com/xtermjs/xterm.js/issues/5816), 2026-04-17) — and the
workaround named there (canvas addon) no longer exists in v6. This machine runs macOS 26.6, and
Tauri's WKWebView is Safari-26-class WebKit. Nothing confirms WKWebView is affected, but this is
now the highest-priority WKWebView spike: if `@xterm/addon-webgl` 0.19.0 misrenders, the fallback
ladder is DOM renderer (correct but ~3–5× slower) or pinning xterm 5.5.x (keeps canvas addon).

**PixiJS v8 in WKWebView (desk research; spike deferred to Stage 2 as instructed).**
pixi.js 8.19.0 current. No Pixi-specific WKWebView/Tauri blocker issues were found in the pixijs
or tauri/wry trackers. Relevant adjacent facts: (i) `antialias: true` on `Application.init()`
causes severe idle-frame cost in v8 — keep it off and rely on `resolution: devicePixelRatio`
([pixijs #10413](https://github.com/pixijs/pixijs/issues/10413)); (ii) WKWebView's historical
60 fps cap was removed in macOS 26 (WKWebView renders at native refresh by default; the
`tauri-plugin-macos-fps` workaround documents the history —
[repo](https://github.com/userFRM/tauri-plugin-macos-fps),
[tauri discussion #8436](https://github.com/tauri-apps/tauri/discussions/8436)); (iii) WebGL2 in
WKWebView is mature (ANGLE-on-Metal; established in `frontend-app-shell-stack.md`); (iv) Pixi v8
keeps WebGL as the production-recommended `autoDetectRenderer` default, WebGPU opt-in later.
At 1–5k sprites + edges an M4 Max is nowhere near any of these ceilings; the deep-dive's
performance analysis stands. The one Safari-class caution signal is the xterm WebGL breakage
above — evidence that Safari/WebKit WebGL regressions do happen on macOS 26.x point releases,
which is an argument for keeping the "open the same SPA in Chrome" escape hatch warm, not an
argument against Pixi.

**Web Worker layout path in WKWebView.** Module workers (`new Worker(url, { type: 'module' })`)
are supported in Safari **15+** ([caniuse](https://caniuse.com/mdn-api_worker_worker_ecmascript_modules)),
so Safari-26-class WKWebView is long past it; Vite's `new Worker(new URL(...), import.meta.url)`
pattern is the bundler-blessed form ([vite worker resolution issue](https://github.com/vitejs/vite/issues/17766),
[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers)).
Typed arrays post across with their underlying `ArrayBuffer` in the transfer list
([MDN transferable objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects)).
OffscreenCanvas is **not required** by this design (the worker computes positions only; all
drawing stays on the main thread), which sidesteps Safari's patchier OffscreenCanvas-WebGL story.

**pixi-viewport is v8-compatible and maintained.** pixi-viewport 6.0.3, MIT, peer `pixi.js >= 8`,
now under the `pixijs-userland` org ([repo](https://github.com/pixijs-userland/pixi-viewport),
[v8 support issue](https://github.com/davidfig/pixi-viewport/issues/476)).

---

## Options considered

### (a) Graph renderer

#### Option A1 — three.js (WebGL2) via `3d-force-graph` as the primary graph stack (app-shell doc's line)

**How it works.** vasturiano's `3d-force-graph` (1.80.0, MIT, `three >= 0.179`) wraps
`three-forcegraph` with camera/controls/tooltips; layout via d3-force-3d/ngraph on the CPU;
`graphData()` supports documented incremental append with object identity preserved;
`nodeThreeObject()` for custom visuals.

**Pros.** Fastest path to *any* working graph (hours, not days); one data shape across the 2D
canvas sibling (`force-graph`) and 3D; incremental updates documented; impressive demo ceiling;
if React is the framework, `react-force-graph` bindings exist.

**Cons.** 3D-by-default is the wrong default for a reading surface (occlusion, label legibility,
camera management) — a conclusion `ui-anti-slop-design.md` independently reached ("2D WebGL force
graph first… treat 3D as a later demo-mode toggle, not the default; the 3D galaxy prior art is
spectacle over legibility"). The 2D sibling renders Canvas2D — materially weaker than Pixi WebGL
for the custom "Instrument Grade" styling (glow accents, ring meters, label LOD) the design doc
requires. Commits the flagship feature to three.js scene management for what is ~90% a 2D
problem. Single-maintainer ecosystem (prolific but bus-factor 1). The Obsidian benchmark —
explicitly named in the project vision — is a 2D Pixi-architecture experience; shipping the
default `3d-force-graph` look would land squarely in "default demo aesthetic," the exact failure
mode the anti-slop doc exists to prevent.

**Risks.** Locking the visual identity of the flagship feature to a stack whose defaults fight
the locked design system; later migrating a shipped 3D UX back to 2D is a redesign, not a swap.

#### Option A2 — graphology store + d3-force in a Web Worker + PixiJS v8 renderer (deep-dive) — **CONFIRMED PRIMARY**

**How it works.** As specified in `ui-motion-3d-context-graph.md` §Recommendation: graphology
(0.26.0) is the single source of truth with typed attributes + events; d3-force (3.0.0) runs
physics in a module worker posting transferable `Float32Array` positions; PixiJS v8 (8.19.0)
draws nodes (container: disc + glow sprite + ring meter + label) and edges (mesh/rope with
parametric draw progress) on WebGL2; pixi-viewport (6.0.3) provides pan/zoom; incremental
insertion via batch-commit + `alphaTarget(0.3)` reheat + spawn-at-referrer.

**Pros.** It is architecturally what Obsidian ships (Pixi rendering + custom layout/interaction —
[Obsidian forum](https://forum.obsidian.md/t/understanding-the-graph-view-core/41020)), i.e. the
proven architecture for exactly the benchmark experience at exactly this scale. Total visual
ownership — mandatory for the Instrument Grade token system (there is no "default look" to leak
through). Best-in-class live-mutation control (`alphaTarget`, `fx/fy` pinning, per-force tuning).
WebGPU upgrade path built into Pixi behind the same API. Every package MIT, multi-maintainer
orgs (pixijs, graphology, d3).

**Cons.** Most assembly required: picking/hit-testing at scale, label LOD, minimap are ours to
write. 2D-committed; a 3D mode is a separate renderer, not a flag.

**Risks.** Custom-layer scope creep (mitigation: crib interaction patterns from sigma/force-graph
sources); Safari-class WebGL regressions on macOS point releases (mitigation: the daemon+SPA
architecture makes Chrome a zero-cost second frontend; renderer smoke test in CI).

**Tie-break rationale — why A2 wins.** (1) *Depth of analysis*: the deep-dive examined six
renderer options against the live-insertion and visual-freedom axes and chose A2; the app-shell
doc spent one sentence, with its stated fallback ("Cosmograph if node counts grow") already
half-conceding the scale argument the deep-dive resolved properly (cosmos.gl held as corpus-mode
escape hatch). (2) *Two-of-three convergence*: the anti-slop doc independently mandates 2D-first
+ custom-styled WebGL, which only A2 satisfies without fighting its own defaults. (3) *The
Obsidian-architecture argument is the strongest single fact in either doc* — the reference
experience named in the project vision runs Pixi+custom-layout, and no counterargument to it
exists in the app-shell doc (its three.js line was chosen for WebGL2 safety, which Pixi provides
equally). (4) The only pro unique to A1 — time-to-first-demo — is the wrong axis for a flagship
feature in a design-locked project. **Resolution: A2 primary; A1 (`3d-force-graph` 1.80.0)
retained strictly as the optional 3D showcase mode behind the renderer interface, deferred, not
in v1 dependencies.**

#### The store→renderer boundary contract (normative)

Both prior docs gestured at "keep the boundary clean"; here is the contract Stage-2 builds
against. Three layers, all framework-free TypeScript modules (React only *hosts* them):

```ts
// 1. GraphStore — graphology instance + the ONLY mutation API (fed by the WS envelope
//    {stream:'context-graph', type:'node'|'edge'|'pulse', id, path, kind, referencedBy, sessionId, ts})
interface GraphStore {
  graph: Graph;                                  // graphology; single source of truth
  applyBatch(events: ContextEvent[]): BatchDiff; // coalesced per rAF/150ms window (deep-dive protocol)
  on(evt: 'diff', cb: (d: BatchDiff) => void): Unsub;
  pin(id: NodeId, x: number, y: number): void;   // sets fx/fy through to layout
  unpin(id: NodeId): void;
}

// 2. LayoutBridge — worker protocol; node order is fixed per epoch; store keeps id→slot map
//    main → worker:  {t:'init'|'sync', nodes, links}   (structural changes only; bumps epoch)
//                    {t:'reheat', alphaTarget: 0.3} · {t:'pin'|'unpin', id, x?, y?}
//    worker → main:  {t:'positions', epoch, buf: ArrayBuffer /* Float32Array xy-pairs, transferred */}
//    Renderer discards position frames whose epoch ≠ current; main thread interpolates
//    between frames so render rate is decoupled from sim tick rate.

// 3. GraphRenderer — Pixi implements it first; CosmosRenderer / ForceGraph3DRenderer plug in later
interface GraphRenderer {
  mount(canvas: HTMLCanvasElement, tokens: DesignTokens): void;  // tokens = plain JS object from DESIGN.md
  syncStructure(diff: BatchDiff): void;          // create/destroy display objects; enter/pulse anims
  applyPositions(buf: Float32Array, epoch: number): void;
  setViewport(v: {x: number; y: number; zoom: number}): void;
  pick(px: number, py: number): NodeId | null;
  setReducedMotion(on: boolean): void;
  destroy(): void;
  onNodeEvent(cb: (e: {type: 'click'|'hover'|'pinstart'|'pinend'; id: NodeId}) => void): Unsub;
}
```

Contract rules: the renderer never mutates the store; the store never touches display objects;
positions flow only worker→renderer (via the epoch-stamped buffer); user gestures flow only
renderer→store (pin) or renderer→UI (select). Graph-internal animation (enter spring, pulse,
edge draw) lives inside the renderer's ticker; camera easing is driven by Motion's vanilla
`animate()` writing to `setViewport` — no DOM library in the per-frame path. Theming enters as a
data object derived from the DESIGN.md tokens, never as CSS.

### (b) Framework + animation

#### Option B1 — Svelte 5 (runes), per the app-shell doc

**How it would work.** Svelte 5.56 + Vite; rune stores in `.svelte.ts` for the session registry;
`svelte/motion` `Spring`/`Tween` classes + `prefersReducedMotion` for chrome motion; Motion's
vanilla `animate()` for anything spring-physics-exotic and for graph camera easing; transcripts
via `@tanstack/svelte-virtual` (with the #866 `_willUpdate()` workaround) or a hand-rolled rune
binding over `@tanstack/virtual-core`; xterm.js attached in `onMount` (clean); every build agent
session carries the official Svelte MCP + llms.txt context to suppress Svelte-4-syntax
regressions.

**Pros.** Compile-time fine-grained reactivity with no compiler-service dependency; smallest
bundles; rune stores are genuinely elegant for "many live sessions"; no StrictMode double-effect
gotchas around imperative libs; `svelte/motion` covers springs/tweens natively; official MCP +
autofixer exist and work.

**Cons.** Motion v12's *framework layer* (layout animations, `AnimatePresence`,
`useReducedMotion`) is unavailable — the deep-dive's animation recommendation would be partially
un-implementable as written; shared-layout/exit orchestration would be hand-rolled or GSAP.
TanStack Virtual is second-class today: store-based adapter, open Svelte 5 binding bug, no
end-anchored chat example — and the streaming transcript is a core surface, not chrome.
react-three-fiber (named for the 3D showcase) has no Svelte equivalent of comparable maturity
(threlte exists but is another ecosystem bet). AI-codegen fluency is measurably weaker and
requires a permanent mitigation layer in every agent's context — stacked on top of the DESIGN.md
token-lock the agents must already obey. Ecosystem risk compounds across *three* second-class
adapters (motion, virtual, 3D) rather than zero.

**Risks.** Each Svelte-side workaround (virtual adapter bug, missing Motion layer, threlte-vs-R3F)
is individually small; jointly they put the *flagship surfaces* on the least-travelled path of
every dependency — the exact place agent-generated code fails silently.

#### Option B2 — React 19.2 + zustand 5 + React Compiler 1.0 — **CHOSEN**

**How it works.** React 19.2.7 + Vite 8 (`@vitejs/plugin-react` with `babel-plugin-react-compiler`
1.0.0); zustand 5.0.14 for state; Motion 12.42.2 via `motion/react` for chrome and vanilla
`animate()` for graph camera; `@tanstack/react-virtual` 3.14.5 with `anchorTo: 'end'` +
`followOnAppend` for transcripts; xterm.js and the Pixi graph mounted imperatively inside
ref-owned components.

The high-frequency stream discipline maps exactly from the app-shell doc's rune design:

```ts
// non-reactive ring buffer (outside React entirely) — one per session, owned by the WS demux
const ring = createRingBuffer(sessionId, CAP);          // plain JS/Uint8Array, never in state

// zustand vanilla store; rAF-batched projection writes summaries only
const sessions = createStore<SessionSummaries>(...);    // zustand/vanilla
rafBatch(() => sessions.setState(project(ring)));       // ≤1 commit per frame

// components: selector-subscribed summaries re-render normally (Compiler-memoized);
// per-frame consumers (status LEDs, tick counters) use transient subscribe — zero re-render:
useEffect(() => sessions.subscribe(s => ledRef.current?.set(s[id].status)), [id]);
```

Transient `subscribe` is zustand's documented pattern for frequently-changing state
([zustand #1179](https://github.com/pmndrs/zustand/discussions/1179)); it is the exact React
equivalent of "non-reactive buffer + batched projection into rune stores."

**Pros.** Motion v12 first-class (the deep-dive's animation recommendation becomes coherent as
written); TanStack Virtual first-class incl. the chat guide the transcript UX is modeled on;
react-three-fiber v9 (React 19-native) available if/when the 3D showcase mode is built; highest
AI-codegen fluency of any framework with zero mitigation overhead (WebDev Arena's React/Next
first-class support is representative of where LLM webdev competence is benchmarked and
concentrated); React Compiler 1.0 removes the historical memo tax that was Svelte's headline
advantage; largest pool of reference implementations for every peripheral (command palette,
tray-adjacent UI, xterm wrappers).

**Cons.** Larger runtime than Svelte (~40 kB more gzipped baseline) — irrelevant against a
36 GB machine and canvas-dominated surfaces. Re-render semantics still exist under the Compiler;
the ring-buffer/transient-subscribe discipline is *mandatory*, not optional (it was mandatory
under Svelte too). React 19 StrictMode double-invokes effects in dev — xterm/Pixi mount code must
be idempotent (attach/dispose pairs), a known one-time cost. JSX + Tailwind is the statistical
center of "AI slop" (`ui-anti-slop-design.md`) — the DESIGN.md token lock is the countermeasure
and applies with extra force here.

**Risks.** Low and priced-in: the app-shell doc already documented this exact configuration as
its fallback and judged "the swap cost is contained to the chrome around canvas components."
We are exercising that clause in the opposite direction — before any code exists, when the swap
cost is zero.

**Why B2 over B1 — the consequence chain, explicitly.**
1. The framework's job in this app is *hosting three framework-agnostic canvases and rendering
   chrome*. Svelte's runtime superiority applies mostly to surfaces this app doesn't render
   through the framework; React's ecosystem superiority applies precisely to the libraries this
   app depends on (Motion, TanStack Virtual, optionally R3F).
2. Two of the three UI research docs already assume React APIs; only one recommends Svelte, and
   it names React as an approved fallback while conceding "if AI-codegen fluency/ecosystem is
   later judged to matter more." This doc judges exactly that, on evidence: the build strategy
   is agent-driven, Svelte 5 codegen requires standing mitigation, React does not.
3. Choosing React makes **zero** prior architecture invalid: Tauri shell, TS daemon, WS
   multiplexing, ring-buffer discipline, xterm stack, graph stack, DESIGN.md tokens all carry
   over unchanged. Choosing Svelte would invalidate the deep-dive's animation stack and put the
   transcript virtualizer on a buggy adapter.
4. xterm.js ergonomics are a wash (imperative attach either way; React pays a StrictMode
   idempotency tax, Svelte pays nothing) — verified not to be a deciding axis.

#### Animation stack under the chosen framework (closes the sub-contradiction)

**Motion 12.42.2 is the single animation dependency** — `motion/react` for chrome (springs,
layout, presence, `useReducedMotion`), vanilla `animate()` for graph camera easing through
`GraphRenderer.setViewport`. Graph-internal animation stays in the Pixi ticker (deep-dive §5,
unchanged). GSAP remains the documented escalation if Inertia-grade flick-panning or long
orchestrations materialize (free since 2025, but not MIT — keep it out until needed). anime.js:
not in v1. `svelte/motion`: moot. The motion-token constraints from `ui-anti-slop-design.md`
(120–180 ms ease-out, transform/opacity only, one ceremonial animation, phosphor-decay fades)
govern *what* these libraries are allowed to do.

### (c) The locked dependency set

See Recommendation below — presented once, as the normative list.

---

## Recommendation

### The locked frontend stack (supersedes §Recommendation bullet "Graph" and "UI" of `frontend-app-shell-stack.md` and §Implications item 1 of `ui-motion-3d-context-graph.md`)

| Role | Package | Version (npm, 2026-07-03) | License | Notes |
|---|---|---|---|---|
| Framework | `react` + `react-dom` | 19.2.7 | MIT | React 19.2 stable line |
| Compiler | `babel-plugin-react-compiler` | 1.0.0 | MIT | via `@vitejs/plugin-react`; dev-time only |
| State | `zustand` | 5.0.14 | MIT | vanilla stores + transient subscribe for hot paths |
| Graph store | `graphology` | 0.26.0 | MIT | single source of truth; events; algorithms |
| Graph layout | `d3-force` | 3.0.0 | **ISC** | permissive, MIT-compatible; runs in module worker |
| Graph renderer | `pixi.js` | 8.19.0 | MIT | WebGL2; `antialias: false`; WebGPU flag later |
| Viewport/zoom | `pixi-viewport` | 6.0.3 | MIT | peer `pixi.js >= 8`; d3-zoom fallback if it stalls |
| Animation | `motion` | 12.42.2 | MIT | `motion/react` chrome + vanilla `animate()` camera |
| Virtualization | `@tanstack/react-virtual` | 3.14.5 | MIT | wraps virtual-core 3.17.3; `anchorTo: 'end'` needs core ≥ 3.16.0 ✓ |
| Terminal | `@xterm/xterm` | 6.0.0 | MIT | canvas renderer removed in v6 — see spike |
| Terminal addons | `@xterm/addon-webgl` / `-fit` / `-serialize` | 0.19.0 / 0.11.0 / 0.14.0 | MIT | WebGL primary, DOM renderer fallback |
| Build | `vite` | 8.1.3 | MIT | module workers via `new Worker(new URL(...), import.meta.url)` |
| CSS | `tailwindcss` | 4.3.2 | MIT | *token-locked*: DESIGN.md tokens as `@theme` CSS variables; default palette effectively banned by the FORBIDDEN list |

**Deferred (not in v1 `package.json`, kept plug-compatible by the renderer contract):**
`3d-force-graph` 1.80.0 (MIT — optional 3D showcase mode), `@cosmos.gl/graph` 3.1.0 (MIT —
corpus-scale constellation view), `react-three-fiber` v9 (MIT — only if the showcase mode is
built), GSAP (free, non-MIT custom license — only on demonstrated need).

License check: every v1 package is MIT except d3-force (ISC — functionally equivalent
permissive; OSI-approved; no public-repo concern [X2]). No paid components, no binary assets;
fonts are governed by `ui-anti-slop-design.md` (paid faces never committed).

Pin policy for agents: exact-pin the table above in v1 (`save-exact`), upgrade deliberately.
These are "known-good as of 2026-07-03," not floors.

### Decision summary

1. **(a) resolved:** graphology + d3-force-in-worker + PixiJS v8 on WebGL2 is THE context-graph
   stack; the store→renderer contract in §Options(a) is normative; `3d-force-graph` is showcase
   -mode-only and deferred. The app-shell doc's three.js line is superseded.
2. **(b) resolved:** React 19.2 + zustand 5 + Compiler 1.0; Motion 12 becomes coherent as
   specified in the deep-dive; TanStack Virtual end-anchored transcripts run on the reference
   adapter. The app-shell doc's Svelte 5 recommendation is superseded via its own fallback
   clause; everything else in that doc (Tauri shell, TS daemon, WS transport, ring-buffer
   discipline, xterm choice) stands unchanged.
3. **(c) resolved:** the versioned table above is the single frontend dependency list of record.

---

## Implications for the harness

1. **Build agents scaffold against:** Vite 8 + React 19.2 + TypeScript strict + the dependency
   table above, with `DESIGN.md` (Stage-2 deliverable per `ui-anti-slop-design.md`) in context
   from the first component. The React choice *raises* slop risk statistically — the token lock
   plus the FORBIDDEN list are the enforcement mechanism, and Tailwind 4 must be configured with
   the DESIGN.md `@theme` variables before any component is generated.
2. **Component ownership pattern (normative):** three imperative islands — `<TerminalPane>`
   (xterm), `<ContextGraph>` (GraphStore/LayoutBridge/PixiGraphRenderer), `<TranscriptView>`
   (react-virtual, `anchorTo: 'end'`, `followOnAppend`) — each mounting framework-agnostic
   modules in ref-owned effects with idempotent attach/dispose (React 19 StrictMode double-invokes
   effects in dev). React renders chrome only; no per-token state updates ever enter React.
3. **The renderer contract is load-bearing for other tracks:** the pipeline-builder scans and
   observability events publish into the same normalized artifact/edge schema the GraphStore
   consumes (deep-dive §Implications 3–4 unchanged); the WS envelope
   `{stream: 'context-graph' | 'usage' | ...}` design carries over.
4. **Stage-2 spikes (updated list, ordered by risk):**
   (i) **xterm 6 WebGL in WKWebView on macOS 26.6** — render `claude` TUI output through
   `@xterm/addon-webgl`; if broken (cf. #5816), decide DOM renderer vs pin xterm 5.5.x;
   (ii) Pixi v8 soak in a Tauri window — 5k nodes/10k edges, `antialias: false`, measure frame
   time on the 85 Hz external display (60 fps cap is gone on macOS 26);
   (iii) worker-layout round-trip latency (positions epoch protocol) under live insertion;
   (iv) the `navigator.gpu` WebGPU probe — remains a **separate** Stage-2 item as scoped, now
   relevant to both Pixi's WebGPU flag and xterm alternatives;
   (v) `@tanstack/react-virtual` chat-mode behavior with items that resize during streaming
   (the exact transcript case).
5. **[X1]/[X4] untouched:** framework and renderer choices are UI-side; PTY-per-account,
   `CLAUDE_CONFIG_DIR` isolation, and workstream lineage live in the daemon and are unaffected.
   Account identity appears in the UI only as MAX_A / MAX_B / ENT / Bedrock(AWS_DEV_ACCOUNT_ID
   placeholder) channel labels per the design tokens; no identifier ever enters graph payloads
   or fixture data [X2].
6. **Escape hatches, re-priced under this decision:** Chrome-as-second-frontend now also hedges
   Safari-class WebGL regressions (xterm #5816 pattern); Electron shell swap remains available;
   a future Svelte migration would cost the chrome layer only (the three islands are
   framework-free by construction) — the same containment the app-shell doc designed, pointed
   the other way.
7. **Doc hygiene:** `frontend-app-shell-stack.md` and `ui-motion-3d-context-graph.md` should be
   annotated (one line each, Stage-2 chore) pointing at this doc as the resolution of record for
   renderer/framework/deps, so future agents don't re-open the contradiction.

---

## Sources

Prior docs resolved (repo-local)
- `docs/research/findings/frontend-app-shell-stack.md` — Svelte 5 recommendation + React fallback clause; three.js graph line; ring-buffer/rAF discipline; xterm/WS architecture
- `docs/research/findings/ui-motion-3d-context-graph.md` — graph options analysis; Obsidian/Pixi architecture; Motion v12 recommendation; integration sketch
- `docs/research/findings/ui-anti-slop-design.md` — token-lock strategy; 2D-first graph mandate; motion tokens; agent-built premise

Motion / animation
- https://motion.dev/ — "for React, JavaScript and Vue" (no Svelte)
- https://github.com/motiondivision/motion/issues/2895 — open Svelte 5 wrapper request (2024-11)
- https://github.com/epavanello/motion-svelte — experimental community wrapper, 0.0.1, peer `motion ^11`
- https://registry.npmjs.org/motion/latest — 12.42.2, MIT (registry-verified)
- https://svelte.dev/docs/svelte/svelte-motion — Spring/Tween classes (5.8+), prefersReducedMotion (5.7+)

TanStack Virtual
- https://tanstack.com/virtual/latest/docs/api/virtualizer — `anchorTo`, `followOnAppend`, `scrollToEnd`/`isAtEnd`/`getDistanceFromEnd` documented on the core Virtualizer
- https://tanstack.com/blog/tanstack-virtual-chat — end-anchored mode announcement (core 3.16.0); React chat guide
- https://github.com/TanStack/virtual/issues/866 and https://github.com/TanStack/virtual/discussions/796 — Svelte 5 adapter bug + status
- https://registry.npmjs.org/@tanstack/react-virtual/latest — 3.14.5, MIT, core 3.17.3 (registry-verified)
- https://registry.npmjs.org/@tanstack/svelte-virtual/latest — 3.13.31, MIT, svelte ^3.48||^4||^5, core 3.17.3 (registry-verified)
- https://github.com/TanStack/virtual/releases — lockstep adapter releases; core 3.17.3 current

React / Svelte / codegen fluency
- https://react.dev/blog/2025/10/01/react-19-2 — React 19.2 stable
- https://react.dev/blog/2025/10/07/react-compiler-1 — React Compiler 1.0 stable
- https://registry.npmjs.org/react/latest , /react-dom/latest — 19.2.7, MIT; /babel-plugin-react-compiler/latest — 1.0.0, MIT; /zustand/latest — 5.0.14, MIT (registry-verified)
- https://registry.npmjs.org/svelte/latest — 5.56.4, MIT (registry-verified)
- https://khromov.se/getting-better-ai-llm-assistance-for-svelte-5-and-sveltekit/ and https://github.com/sveltejs/svelte/discussions/14125 — documented LLM Svelte-4-syntax regression problem
- https://svelte.dev/docs/ai — official llms.txt + MCP server (mcp.svelte.dev, `@sveltejs/mcp`, svelte-autofixer)
- https://arena.ai/blog/webdev-arena/ — WebDev Arena: Next.js/React first-class LLM webdev evaluation target
- https://github.com/pmndrs/zustand/discussions/1179 — transient subscribe for frequently-changing state

Graph stack
- https://registry.npmjs.org/pixi.js/latest — 8.19.0, MIT; /graphology/latest — 0.26.0, MIT; /d3-force/latest — 3.0.0, ISC; /pixi-viewport/latest — 6.0.3, MIT, peer pixi>=8; /3d-force-graph/latest — 1.80.0, MIT, three ≥0.179 (all registry-verified)
- https://github.com/pixijs-userland/pixi-viewport and https://github.com/davidfig/pixi-viewport/issues/476 — v6 = pixi v8 line, maintained under pixijs-userland
- https://github.com/pixijs/pixijs/issues/10413 — v8 `antialias: true` performance footgun
- https://forum.obsidian.md/t/understanding-the-graph-view-core/41020 — Obsidian graph = Pixi + custom (via deep-dive)

WKWebView / workers / terminal
- https://github.com/xtermjs/xterm.js/releases/tag/6.0.0 — xterm 6.0.0: canvas renderer removed; DOM/WebGL only; VS Code viewport base
- https://github.com/xtermjs/xterm.js/issues/5816 — WebGL rendering broken in Safari on macOS 26.5 beta (open, 2026-04)
- https://registry.npmjs.org/@xterm/xterm/latest (6.0.0), /@xterm/addon-webgl/latest (0.19.0), /@xterm/addon-fit/latest (0.11.0), /@xterm/addon-serialize/latest (0.14.0) — all MIT (registry-verified)
- https://github.com/userFRM/tauri-plugin-macos-fps and https://github.com/tauri-apps/tauri/discussions/8436 — WKWebView 60 fps cap history; removed in macOS 26
- https://caniuse.com/mdn-api_worker_worker_ecmascript_modules — module workers Safari 15+
- https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects — ArrayBuffer transfer semantics
- https://github.com/vitejs/vite/issues/17766 — Vite worker URL-resolution pattern
- https://registry.npmjs.org/vite/latest — 8.1.3, MIT; /tailwindcss/latest — 4.3.2, MIT (registry-verified)

Machine ground truth (read-only, 2026-07-03): macOS 26.6 on Apple M4 Max / 36 GB (established in
prior docs); target repo present at `~/Personal/SourceCode/the-last-aibender` with the three
input docs under `docs/research/findings/`.

---

## Open questions

1. **xterm 6 WebGL on WKWebView/macOS 26.6** (Stage-2 spike i): does #5816 reproduce inside a
   Tauri window? If yes — DOM renderer (slower) or pin `@xterm/xterm` 5.5.x (retains canvas
   addon) — which passes the multi-terminal soak?
2. **Pixi v8 devicePixelRatio strategy on XDR + external displays** without antialiasing:
   `resolution: window.devicePixelRatio` vs capped-at-2 — measure fill-rate cost at 5k nodes on
   the 3440×1440 display during spike (ii).
3. **`@tanstack/react-virtual` chat mode with mid-stream item growth** — the blog demonstrates
   it, but the transcript case (tool-call blocks expanding while streaming, images/diffs
   materializing) needs the spike (v) before the transcript component API freezes.
4. **React Compiler + zustand transient patterns** — confirm the compiler's memoization doesn't
   interfere with intentionally-non-reactive ref writes from `subscribe` callbacks (expected
   safe; verify with `eslint-plugin-react-hooks` recommended-latest in the scaffold).
5. **Threlte-vs-R3F re-check is moot** under React — but if the 3D showcase mode is ever
   promoted, decide `react-force-graph-3d` (bindings) vs plain `3d-force-graph` behind
   `GraphRenderer` (leaning plain — keeps the contract framework-free).
6. **Tailwind 4 in a token-locked system**: adopt (`@theme` bound to DESIGN.md variables) or drop
   for vanilla CSS custom properties? Decide when DESIGN.md lands; the dependency is listed but
   trivially removable.
7. **When do the two superseded docs get their pointer annotations** (Implication 7) — fold into
   the Stage-2 kickoff chore list so no build agent scaffolds from the stale lines.
