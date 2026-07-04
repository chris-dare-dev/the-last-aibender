# Motion + 3D technology research — the live force-directed context graph

**Stage-1 discovery research · the-last-aibender · researched 2026-07-03**

Topic: renderer + animation stack for the flagship feature — a LIVE, Obsidian-style force-directed
context graph that grows in real time as an active session references/reads/writes context artifacts
(CLAUDE.md files, memory files, agent artifacts, references), plus the general UI motion stack for
the harness frontend.

---

## TL;DR

1. **Graph stack (recommended): d3-force layout in a Web Worker + PixiJS v8 WebGL/WebGPU renderer** — the exact architecture Obsidian itself uses (Pixi rendering, custom layout). Total visual freedom, proven at our 100–5,000 node scale, trivial on an M4 Max.
2. **Incremental growth is a solved problem at this scale**: keep node objects stable, mutate the nodes/links arrays, re-call `simulation.nodes()/force.links()`, spawn new nodes at their parent's position, and reheat gently with `alphaTarget(0.3)` → decay. Never rebuild the simulation.
3. **Escape hatch for scale**: cosmos.gl (`@cosmos.gl/graph` v3.1, OpenJS incubating, GPU layout+render, 100k–1M nodes) behind the same graph-store interface if we ever visualize the whole `~/.claude` corpus. **Optional 3D showcase mode**: `3d-force-graph` (three.js), not the default view.
4. **UI animation stack: Motion (motion.dev, v12, MIT)** for the React frontend — springs, layout animations, `useReducedMotion`, and a renderer-agnostic `animate()` we can reuse to tween canvas values. GSAP (now 100% free incl. all former Club plugins) is the fallback if timeline choreography dominates; anime.js v4 only for SVG-drawing flourishes.
5. **Graph-internal animation does NOT use a DOM animation library** — node ease-in (scale/alpha spring, ~400 ms), edge progressive draw (parametric 0→1), and reference-pulse are driven inside the Pixi ticker from interpolators.
6. **WebGPU in 2026 is real but not required**: all major browsers ship it (Chrome 113+, Safari 26, Firefox 141/145), ~85% global support; Pixi v8 gives us a WebGPU backend for free later; three.js WebGPURenderer+TSL is production-usable but its compute path is overkill for ≤5k nodes.
7. **Live updates**: hooks/transcript-tail → WebSocket → frontend mutation queue → batch-commit once per animation frame (or 100–250 ms window) → single reheat per batch. SSE is an acceptable fallback; WebSocket preferred for bidirectional (pin/unpin, focus).
8. **Reduced motion is a first-class mode**: `prefers-reduced-motion` (plus an in-app toggle) swaps physics-jiggle + fly-to for settled layouts and opacity-only fades.

---

## Current landscape

### The reference experience: Obsidian's graph view

Obsidian's graph view — the visual benchmark named in the project vision — is **PixiJS rendering
with a fully custom layout/interaction layer**; the team moved off D3 rendering for performance and
kept everything else proprietary ("Pixi.js is doing the rendering, everything else is custom" —
Obsidian developer on the official forum). Two takeaways:

- At personal-knowledge-graph scale (hundreds to low thousands of nodes), **CPU force layout +
  WebGL 2D rendering is the proven architecture**. Obsidian did not need GPU layout.
- The "Obsidian look" (dark field, soft glowing dots sized by degree, hover-neighborhood
  highlighting, labels fading in with zoom, gentle continuous jiggle) is a **custom rendering
  aesthetic**, not something any library ships as a default. Whatever we pick, we write the visual
  layer ourselves — which argues for stacks that make custom drawing easy rather than stacks with
  pretty defaults.

### The 2026 renderer field

| Library | Version (verified via npm/GitHub, 2026-07) | Layout | Rendering | Sweet spot |
|---|---|---|---|---|
| d3-force (+ canvas/Pixi) | d3-force 3.x; PixiJS v8.16+ | CPU (Barnes–Hut quadtree, velocity Verlet) | Anything you write (Canvas2D, Pixi WebGL/WebGPU) | ≤ ~10k nodes, maximum custom visuals |
| sigma.js + graphology | sigma 3.0.3 (v4 alpha in progress) | CPU, separate (graphology FA2, worker) | WebGL, custom shader "programs" | 1k–100k nodes, network-analysis UIs |
| cosmos.gl | @cosmos.gl/graph 3.1.0 | **GPU** (WebGL2 fragment/vertex shaders via luma.gl) | WebGL2 | 10k–1M+ nodes, embedding clouds |
| 3d-force-graph / three-forcegraph | 3d-force-graph 1.80.0 (three ≥ 0.179) | CPU (d3-force-3d or ngraph) | three.js WebGL (WebGPU import path appearing) | 3D graphs, ≤ ~10k nodes |
| three.js custom + TSL compute | three r185 (mid-2026) | You write it (WGSL/TSL compute) | WebGPURenderer (production since ~r171) | Bespoke GPU experiences |
| PlayCanvas | engine 2.x | none built-in | WebGL2 + WebGPU engine + visual editor | Games/products, not embeddable widgets |

### WebGPU readiness in 2026 (matters for "future-proof", not for launch)

- **Chrome/Edge**: default since Chrome 113 (April 2023); Android since 121.
- **Safari 26.0**: ships WebGPU on macOS Tahoe 26 / iOS 26 / visionOS 26 — i.e. **on this exact
  machine (macOS 26.6)**, WKWebView/Safari have WebGPU today. Safari 26.2 added WebXR-WebGPU.
- **Firefox**: 141 on Windows, 145 on ARM64 macOS.
- caniuse puts global support around **84–85% (March 2026)**.
- Practical consequence for the harness: if the frontend is Electron (Chromium) or Tauri (WKWebView
  on macOS 26), **WebGPU is available either way**, but WebGL 2 remains the safe default —
  PixiJS itself still recommends WebGL for production and made WebGL the `autoDetectRenderer`
  default again in v8.1 due to cross-browser WebGPU inconsistencies. WebGPU here is an upgrade
  path, not a launch requirement.

### Host hardware ground truth (verified on this machine)

Apple M4 Max: 14 CPU cores, **32-core GPU, Metal 4**, 36 GB unified memory, driving a 3440×1440@85 Hz
external display plus the built-in ProMotion panel. Browser WebGL/WebGPU on Apple Silicon goes
through ANGLE→Metal (Chromium) or WebKit→Metal (Safari). At the feature's stated scale (100–5,000
nodes; realistically hundreds of context artifacts per session), *every* option in the table above
is GPU-bound nowhere and CPU-bound almost nowhere: a 5k-node d3-force tick is ~1–3 ms on this class
of CPU, and Pixi v8 batches 100k sprites at interactive rates. Performance is therefore **not the
deciding axis** — layout stability under live insertion and visual freedom are.

### Live/streaming dynamic-graph patterns (state of the art)

- **Transport**: WebSocket for bidirectional (frontend sends pin/focus/filter commands back);
  SSE suffices for one-way append-only feeds and auto-reconnects for free. Industry guidance for
  live dashboards: *batch, sample, or aggregate when updates outpace rendering, and sync applies
  to `requestAnimationFrame`*.
- **Mutation batching**: never apply per-event graph mutations directly to the renderer. Queue
  mutations, coalesce per rAF or a 100–250 ms window, apply as one commit, reheat once.
- **Layout reheating** (d3-force idiom, documented in d3 docs and the Stamen "Forcing Functions"
  write-up): positions live on node objects, so preserving object identity preserves the layout;
  after adding nodes call `simulation.nodes(nodes)`, `link.links(links)`, then
  `simulation.alphaTarget(0.3).restart()` and later `alphaTarget(0)` so the graph "warms" smoothly
  instead of exploding. `fx`/`fy` pin nodes the user has grabbed.
- **Spawn positioning**: initialize a new node at (or jittered around) the node that referenced it,
  not at the origin — d3's default phyllotaxis placement flings unrelated nodes through the
  viewport. This one detail is most of the difference between "calm, alive" and "boiling soup".
- **vasturiano's dynamic example** (3d-force-graph `example/dynamic`) demonstrates the same
  pattern at the API level: read `graphData()`, spread-append nodes/links, set it back; existing
  node objects are reused so their positions persist and the sim reheats.

### UI motion library field, 2026

- **Motion** (motion.dev, formerly Framer Motion): went fully independent in mid-2025; package is
  `motion`, import `motion/react`; v12.42 as of 2026-07. MIT core; hybrid engine (WAAPI
  hardware-accelerated where possible, JS where needed); springs, layout/shared-layout animations,
  gestures, `useReducedMotion`; vanilla `animate()` works on plain objects — usable to tween canvas
  values. Motion+ is a paid component/examples layer, not needed.
- **anime.js v4** (v4.5.0): full rewrite — modular/tree-shakeable, `createTimeline`, separate
  spring module (bounce/duration/over-damped), WAAPI bridge module, `createScope` (media-query
  scoping), `createDraggable`, `onScroll`, `createLayout` (v4.3), text splitting, and notably a
  **new adapter API with a built-in three.js adapter** (v4.5) for animating Object3D/materials.
  MIT. Strongest at SVG line-drawing/morphing (`createDrawable`, `morphTo`) and staggered
  choreography.
- **GSAP 3.13+**: Webflow acquired GreenSock (fall 2024) and made **everything free including all
  former Club plugins** (SplitText, MorphSVG, DrawSVG, ScrollTrigger, ScrollSmoother, Inertia) as
  of 2025-04-30, commercial use included. The deepest timeline/sequencing tooling in the field;
  framework-agnostic; imperative style that fights React's declarative model somewhat.
- **CSS/WAAPI baseline**: view transitions, scroll-driven animations, and plain CSS springs cover
  more every year; any library should be reserved for what CSS can't express.

### Tasteful 3D/motion principles (synthesized from 2025-26 accessibility + dataviz guidance)

- **Depth must encode signal.** A third dimension earns its place only when it maps to a variable
  (artifact type as layer, recency as z). Obsidian's graph is 2D for a reason: label legibility,
  no occlusion, no camera management. Default 2D; 3D as an explicit optional mode.
- **Motion is information**: node ease-in says "this just got referenced"; a pulse says "referenced
  again"; edge draw direction says "who pulled in whom". Decorative motion that encodes nothing
  (parallax, camera drift) is the first thing to cut.
- **Short distances, soft fades** — long travel and large pans/zooms are the top vestibular
  triggers per current accessibility guidance (Pope Tech 2025, MDN). Keep the camera still by
  default; move nodes, not the world.
- **`prefers-reduced-motion` + in-app toggle**: reduced mode = pre-settled layout (run the sim to
  convergence off-screen), opacity-only enter, no continuous jiggle, no fly-to-node. The EU
  European Accessibility Act (in force since mid-2025) has made this table-stakes.
- **120 Hz awareness**: ProMotion + the 85 Hz external display mean tween durations should be
  time-based (they always are in the candidate libs) and the sim tick decoupled from render rate.

---

## Options considered

### Option A — d3-force layout + PixiJS v8 renderer (custom 2D WebGL/WebGPU) — RECOMMENDED

**How it works.** d3-force runs the physics (many-body via Barnes–Hut quadtree, springs, centering,
collision) on plain JS node objects; PixiJS draws sprites/graphics for nodes, lines/meshes for
edges, reading `node.x/node.y` each ticker frame. Layout runs in a Web Worker posting
`Float32Array` positions (transferable) to keep the main thread at 0 layout cost. Pixi v8 has both
WebGL and WebGPU backends behind one API. This is the GraphAware/dianaow "PixiJS + D3" pattern and,
architecturally, what Obsidian ships.

**Pros.**
- **Unlimited visual customization** — we own every pixel: glow shaders, degree-sized discs,
  ring-progress around "hot" files, custom label LOD, themed per-artifact-type glyphs. Zero risk
  of "default demo look" because there is no default.
- **Best-in-class incremental behavior**: full control of alpha/reheat, per-node pinning,
  spawn-at-parent, per-force tuning while running. d3-force's API is explicitly designed for
  live mutation (`simulation.nodes()` re-init contract documented).
- Enter/exit animation quality is whatever we build: spring-scale node entry, parametric edge draw,
  pulse — all trivially driven in the Pixi ticker.
- Pixi v8 perf headroom is absurd for our scale (100k moving sprites ≈ 15 ms CPU in their bench);
  5k nodes + 10k edges won't register on an M4 Max.
- WebGPU upgrade path built-in (Pixi WebGPU backend), WebGL 2 default = zero-risk launch.
- MIT everything; huge communities on both libs.

**Cons.**
- Most "assembly required" of all options: hit-testing (Pixi handles pointer events per display
  object, but graph-semantic picking at scale wants a spatial index), zoom/pan (d3-zoom or
  pixi-viewport), label collision, minimap — all ours to write.
- d3-force is 2D; a later 3D mode would come from d3-force-3d + a different renderer (see Option D)
  rather than this stack.
- CPU layout ceiling ~10–20k live nodes; fine for the feature as scoped, not for whole-corpus viz.

**Risks.** Scope creep in the custom layer (mitigate: crib interaction patterns from sigma/
force-graph sources); Pixi v8 WebGPU backend inconsistencies (mitigate: ship WebGL, flip later).

### Option B — sigma.js v3 + graphology

**How it works.** graphology is the data model (events on add/drop/attribute change); sigma is a
WebGL renderer over it with "programs" (shader pairs) per node/edge type and "reducers" (functions
that restyle nodes/edges at render time without touching the data). Layout is bring-your-own:
`graphology-layout-forceatlas2` has an official Web Worker build with `background`/`autoStop`;
d3-force also works. v3 (2024) rewrote update management — instanced rendering, per-index partial
updates driven by graphology events, so incremental insertion is efficient. v4 alpha exists.

**Pros.**
- Graph-native data model with events = clean live-update wiring; reducers are a great fit for
  hover-neighborhood highlighting and "recency heat" styling.
- Custom node/edge programs (e.g. `@sigma/edge-curve`) allow real visual customization at the
  shader level; label rendering, picking, camera all built in — much less assembly than Option A.
- Solid at 5k nodes; proven to ~100k+.

**Cons.**
- **2D only**, and the out-of-box look is recognizably "sigma network-analysis demo" unless we
  invest in custom programs — at which point we're writing shaders anyway, with less freedom than
  Pixi display objects give us (sigma programs are point-sprite-oriented; multi-part glyphs, ring
  progress, animated dashes are awkward).
- Per-node enter animations aren't a first-class concept; you animate by mutating attributes per
  frame (graphology event flood) or via reducers keyed on a clock — workable but bolted-on.
- FA2's layout character (cluster-separating, non-deterministic under reheat) reads less "Obsidian"
  than d3-force's springs; d3-force-in-worker with sigma is possible but then sigma is only buying
  us rendering, where Pixi is more flexible.

**Risks.** v3→v4 transition churn; smaller maintainer team (OuestWare/Sciences-Po médialab).

### Option C — cosmos.gl (`@cosmos.gl/graph`, formerly `@cosmograph/cosmos`)

**How it works.** The entire force simulation AND rendering run on the GPU in WebGL2 shaders
(ported to luma.gl in v3.0); positions live in GPU textures. API takes typed arrays
(`setPointPositions`, `setPointColors`, `setLinks`), simulation controlled via
`start/stop/pause/unpause`; v3 added async init, attribute **transitions animated by default**
(800 ms cubic in-out), link sampling for label overlays, per-point shapes/outlines. MIT; joined the
OpenJS Foundation as an incubating project 2025-05-14 (announced with "over one million nodes and
links" real-time claims). Cosmograph is the commercial app/widget family built on it.

**Pros.**
- Silky GPU physics with by-default animated attribute changes — the "alive" feel is nearly free.
- Only option that keeps working if the graph becomes the whole `~/.claude` corpus (100k+ files/
  chunks/sessions).
- Now foundation-governed → longevity signal; active releases (v3.1, mid-2026).

**Cons.**
- **Data model is typed-array-slot-oriented, not object-incremental**: growing the graph means
  re-supplying position/color/link arrays; the GPU sim re-settles globally, and fine-grained
  per-node reheat control (pin this, freeze that neighborhood) is much cruder than d3's
  `fx`/`alphaTarget` idioms. Fixable with bookkeeping, but we'd be fighting the grain of an
  engine designed for big static-ish datasets that get *explored*, not small graphs that *grow*.
- Visual vocabulary is dot/link-centric (per-point color/size/shape/outline). Compound glyphs,
  ring meters, textured labels need overlay layers (`@interacta/css-labels`, sampled link
  positions) — the "not a default demo" bar is harder to clear than with Pixi.
- Labels/hover at small scale feel less crisp than CPU-side hit-testing; iOS/old-Android WebGL
  extension gaps (EXT_float_blend) break the many-body force — irrelevant on macOS but signals
  platform sensitivity.
- No published WebGPU roadmap (still WebGL2/luma.gl as of v3.1).

**Risks.** Using a 1M-node engine for a 500-node graph buys nothing and costs control. Right tool,
wrong problem size — unless corpus-scale mode becomes real.

### Option D — 3d-force-graph / three-forcegraph / react-force-graph (three.js)

**How it works.** vasturiano's family: d3-force-3d (1D/2D/3D velocity Verlet) or ngraph for layout,
three.js for rendering; `three-forcegraph` is a `THREE.Object3D` you can drop into any scene;
`3d-force-graph` wraps it with camera/controls/tooltips; `react-force-graph` adds React bindings
(2D/3D/VR/AR variants). `graphData()` supports documented incremental updates (spread-append,
object identity preserved → positions kept, sim reheats; `d3ReheatSimulation()`,
`cooldownTicks/Time`, `d3AlphaDecay` exposed). `nodeThreeObject()` lets every node be an arbitrary
three.js object. Current builds track three ≥ 0.179, and `three-render-objects` now imports from
`three/webgpu` (surfaced in issue #691), i.e. the WebGPURenderer path is arriving in this stack.

**Pros.**
- Fastest path to a genuinely impressive 3D graph; `nodeThreeObject` = full custom visuals
  (glow sprites, text sprites, models).
- Incremental updates are an explicitly supported, example-documented workflow (`example/dynamic`).
- One data shape across 2D (`force-graph` canvas) and 3D (`3d-force-graph`) siblings.

**Cons.**
- 3D-by-default is the wrong default for a *reading* surface (occlusion, label legibility, camera
  cost — see principles above). The 2D sibling (`force-graph`) renders Canvas2D, weaker than Pixi
  for custom GPU-accelerated styling.
- Single-maintainer ecosystem (prolific, but bus-factor 1); kapsule-style API is imperative and
  less composable inside React.
- Fine-grained enter animation (ease-in on spawn) must be hand-rolled against three objects anyway.

**Risks.** Adopting it as the core commits us to three.js scene management for what is 90% a 2D
feature. Better held as the optional "showcase/3D mode" package.

### Option E — Custom three.js WebGPURenderer + TSL compute

**How it works.** three.js's WebGPURenderer became production-usable around r171 (with automatic
WebGL 2 fallback; `import * as THREE from 'three/webgpu'`), and TSL (Three Shading Language) is now
the official shader authoring layer, compiling to WGSL and GLSL. Compute shaders enable million-
particle systems; prior art for WebGPU force layout exists (GraphWaGu — Fruchterman-Reingold +
Barnes-Hut in compute shaders; GraphGPU — O(n²) GPU physics), and r183–r185 keep improving compute/
TSL. react-three-fiber v9 (React 19) treats WebGPU/TSL as first-class (`useUniforms`, async
renderer constructors), with drei's large helper ecosystem.

**Pros.** Maximum ceiling: bespoke GPU layout + bespoke rendering + post-processing (bloom on hot
nodes) in one modern pipeline; TSL single-source shaders; R3F makes it livable in React.

**Cons.** We would be **building a graph engine, not a feature**: Barnes-Hut in WGSL, GPU picking,
label pipelines — GraphWaGu is a research system, not a library. TSL is still under-documented and
moving release-to-release. All of this to beat d3-force at a node count where d3-force isn't even
breathing hard.

**Risks.** Multi-week detour, single-digit-percent visual payoff at our scale. Keep as a
post-v1 experiment (e.g. GPU mode for corpus-scale view, or bloom post-processing on top of a
Pixi-rendered texture instead).

### Option F — PlayCanvas

**How it works.** Full open-source game engine (WebGL2 + genuinely mature WebGPU incl. compute
since 1.70, open-sourced visual editor, Gaussian-splat tooling), scene-graph + ECS + asset
pipeline.

**Where it fits / doesn't.** It's an app-authoring platform: the editor workflow, asset system, and
runtime assume you're building *the* experience, not embedding a data-bound widget in a React
dashboard. No graph/layout primitives; data binding would be as manual as three.js with more
framework around it. **Not a fit** for this harness; noted only so future stages don't re-litigate.

### UI animation options (frontend chrome, not the graph internals)

**Motion (motion.dev v12)** — *how*: hybrid WAAPI/JS engine; React components (`motion.div`,
`AnimatePresence`, layout animations) + vanilla `animate(object, keyframes, {type: "spring"})`.
*Pros*: MIT, React-native mental model, springs as first-class citizens, `useReducedMotion`,
independent since 2025 with strong sponsorship (Framer, Figma, Tailwind); the vanilla `animate` can
tween arbitrary object properties → reusable for camera/zoom easing in the graph. *Cons*: deep
timeline orchestration weaker than GSAP; some premium examples paywalled (Motion+ — not needed).

**anime.js v4 (4.5.0)** — *pros*: MIT, tiny modular imports, best-in-class SVG line draw/morph
(`createDrawable`, `morphTo`), springs with perceived-duration, WAAPI bridge, **three.js adapter
(v4.5)** if a 3D mode appears; lovely stagger system. *Cons*: framework-agnostic imperative API =
manual React lifecycle glue; overlaps ~80% with Motion — carrying both is unjustified except for
SVG flourishes.

**GSAP 3.13+** — *pros*: free since 2025-04-30 including SplitText/MorphSVG/DrawSVG/ScrollTrigger/
Inertia; unmatched timeline sequencing and killer plugins (Inertia would suit flick-panning the
graph). *Cons*: imperative, React integration via `useGSAP` hook is fine but non-idiomatic; not MIT
(custom "no-charge" license — fine for a public repo's use, but a consideration); heavier default
bundle.

---

## Recommendation

### Graph stack (the flagship)

**Build the context graph as: graphology data model → d3-force simulation in a Web Worker →
PixiJS v8 renderer (WebGL now, WebGPU flag later).**

- **graphology as the store** even without sigma: typed attributes, events, serialization, and the
  standard-library algorithms (degree, communities) for free — and it keeps a future sigma or
  cosmos.gl renderer swappable behind one interface.
- **d3-force in a worker** (`d3-force` on the main data, or `d3-force-3d` in 2D mode to keep a 3D
  door open): tick loop posts transferable `Float32Array` positions at sim rate; main thread
  interpolates between position frames for buttery 85–120 Hz rendering regardless of tick rate.
- **PixiJS v8** for drawing: node = container (disc + glow sprite + ring meter + label), edge =
  mesh/rope with parametric draw progress. `pixi-viewport` (or d3-zoom on the stage) for pan/zoom.
- **Do not adopt** cosmos.gl, sigma, or 3d-force-graph as the core — but keep the graph-store →
  renderer boundary clean so (a) cosmos.gl can back a "whole-corpus constellation" view later and
  (b) 3d-force-graph can back an optional 3D showcase mode, both feeding from the same graphology
  store.

**Incremental-insertion protocol** (the heart of "live"):

```js
// batch-commit once per rAF or 150ms window
function commit(batch) {
  for (const ev of batch) {
    if (!graph.hasNode(ev.id)) {
      const parent = pos(ev.referencedBy);           // spawn at referrer
      graph.addNode(ev.id, { ...ev.attrs,
        x: parent.x + jitter(), y: parent.y + jitter() });
      enterAnim(ev.id);                              // spring scale 0->1, alpha fade, ~400ms
    } else pulse(ev.id);                             // re-reference: ring pulse, heat++
    if (ev.edge && !graph.hasEdge(...)) { graph.addEdge(...); drawEdgeIn(ev.edge); }
  }
  worker.post({ type: 'sync', nodes, links });       // sim.nodes()/links() re-init in worker
  worker.post({ type: 'reheat', alphaTarget: 0.3 }); // gentle, not alpha(1)
  scheduleCooldown(1500 /*ms*/);                     // then alphaTarget(0)
}
```

Pinning = set `fx/fy` on grab and on user-pin; recency heat decays on a timer and maps to
glow intensity/saturation; degree maps to radius (Obsidian convention).

### UI animation stack

**Motion v12 (`motion` / `motion/react`) as the single UI animation dependency.**
Panels, list reorder, tab transitions, command palette, toasts: React layout animations + springs.
Its vanilla `animate()` doubles as the tween driver for graph camera moves (fly-to-node with
reduced-motion guard) so we don't hand-roll easing there. Add **GSAP only if** a concrete need for
its Inertia/DrawSVG-class plugins or long orchestrated sequences materializes (it's free now, so
this is a complexity decision, not a budget one). anime.js v4: not in v1; revisit for SVG
line-drawing embellishments or if a three.js mode wants its animation adapter.
**Graph-internal animations stay in the Pixi ticker** — per-node interpolators, no DOM lib in the
hot path.

### Integration sketch (harness ↔ graph)

```
Claude Code hooks (PostToolUse: Read/Write/Edit/Grep …)      OpenCode session events
        │  (JSONL transcript tail: ~/.claude/projects/**.jsonl)        │
        ▼                                                              ▼
   harness backend (Node/Bun): event normalizer ── artifact classifier (CLAUDE.md/memory/
        │                                            agent-artifact/reference; workstream id)
        ▼
   WebSocket  ─ msg: {type: node|edge|pulse, id, path, kind, referencedBy, sessionId, ts}
        ▼
   frontend graph store (graphology) ← mutation queue ← batcher (rAF/150ms)
        │                                   │
        ▼                                   ▼
   d3-force worker (positions out)     Pixi v8 stage (enter/pulse/edge-draw anims)
```

Verified event sources on this machine: `~/.claude/projects/<project>/*.jsonl` transcripts,
`history.jsonl`, `hooks/` (Claude Code 2.1.193) — a PostToolUse hook or transcript tailer yields
file-reference events with zero polling of the filesystem; an `fswatch`-based watcher covers
non-session edits. Session identity keys tie graph pulses to workstreams [X4]; account identity
(MAX_A / MAX_B / ENT / Bedrock-via-AWS_DEV_ACCOUNT_ID) can color-code which backend touched an
artifact. All identifiers in the rendered graph come from local paths — no account identifiers
are needed in the graph payload at all, which keeps [X2] trivially satisfied.

**Reduced motion**: `matchMedia('(prefers-reduced-motion: reduce)')` + settings toggle → sim runs
to convergence before paint, enter = opacity fade only, no pulse loops, no camera fly-to (instant
pan with crossfade). Motion's `useReducedMotion` handles the React chrome side.

---

## Implications for the harness

1. **Dependency set (frontend)**: `graphology`, `d3-force` (+`d3-quadtree`), `pixi.js@8`,
   `pixi-viewport`, `motion` — all MIT. No paid or license-encumbered code lands in the public
   repo [X2]; no secrets are involved anywhere in this stack.
2. **Web Worker requirement** shapes the frontend build: bundler must support module workers
   (Vite does); Tauri/Electron choice does not block it. If Tauri (WKWebView), we get Safari 26's
   WebGPU; if Electron, Chromium's — either way WebGL 2 first.
3. **The graph-store boundary is an architectural contract** other stage-2 features must respect:
   pipeline-builder scans (.claude dirs, OpenCode .json) and observability events publish into the
   same normalized artifact/edge schema the graph consumes, so the graph is a *view*, not a silo.
4. **Backend event bus doubles for observability**: the same WebSocket channel feeding the graph
   can feed usage tickers (tokens, cache hits) — design the message envelope generically
   (`{stream: 'context-graph' | 'usage' | ...}`) now to avoid a second transport later.
5. **LM Studio down-state and k3s [X3] are irrelevant to this feature** — the graph consumes local
   file/session events only; but if the harness backend ever moves into Colima/k3s, the transcript
   tailer must still see `~/.claude` (host mount), which is another argument for the host-native
   fallback stance.
6. **Performance budget on this hardware is a non-issue at spec scale** — so spend the budget on
   polish (glow, springs, label LOD), and enforce the reduced-motion mode from day one rather than
   retrofitting.
7. **Public-repo hygiene for the doc/feature**: graph node payloads are file paths and session
   UUIDs; screenshots/demos must not leak real account emails in rendered labels — use the
   MAX_A/MAX_B/ENT placeholders in any fixture data committed to the repo.

---

## Sources

Graph renderers
- https://github.com/cosmosgl/graph — cosmos.gl README (WebGL2/luma.gl, v3 async init, transitions, setPointPositions/setLinks, iOS/Android limitations)
- https://github.com/cosmosgl/graph/releases — v3.0/v3.1 release notes
- https://www.npmjs.com/package/@cosmos.gl/graph — v3.1.0, MIT, luma.gl deps (registry verified)
- https://openjsf.org/blog/introducing-cosmos-gl — OpenJS incubation announcement (2025-05-14), 1M+ node claims
- https://www.sigmajs.org/ and https://www.sigmajs.org/docs/advanced/customization/ — sigma.js, reducers, custom programs
- https://github.com/jacomyal/sigma.js/discussions/1469 — sigma status/roadmap (v3 stable, v4 alpha, instanced rendering, partial index updates)
- https://www.ouestware.com/2024/03/21/sigma-js-3-0-en/ — sigma v3 rewrite notes
- https://www.npmjs.com/package/@sigma/edge-curve — curved edge program
- https://github.com/graphology/graphology + https://graphology.github.io/standard-library/ — graphology and FA2 worker layout
- https://github.com/vasturiano/3d-force-graph — README: graphData incremental updates, d3ReheatSimulation, cooldown, nodeThreeObject
- https://github.com/vasturiano/3d-force-graph/blob/master/example/dynamic/index.html — dynamic insertion example (spread-append pattern)
- https://github.com/vasturiano/3d-force-graph/issues/379 and /issues/360 — incremental update feature threads
- https://github.com/vasturiano/3d-force-graph/issues/691 — `three/webgpu` import surfacing in three-render-objects
- https://github.com/vasturiano/d3-force-3d — 1D/2D/3D velocity Verlet layout
- https://registry.npmjs.org/3d-force-graph/latest — v1.80.0, three ≥ 0.179 (registry verified)
- https://d3js.org/d3-force/simulation — nodes() re-init contract, alpha/alphaTarget/restart reheating, fx/fy pinning
- https://stamen.com/forcing-functions-inside-d3-v4-forces-and-layout-transitions-f3e89ee02d12/ — alphaTarget smooth-reheat pattern
- https://forum.obsidian.md/t/understanding-the-graph-view-core/41020 — Obsidian graph = Pixi rendering + custom (moved off D3)
- https://graphaware.com/blog/scale-up-your-d3-graph-visualisation-webgl-canvas-with-pixi-js/ and https://dianaow.com/posts/pixijs-d3-graph — d3-force + PixiJS pattern (incl. worker layout)
- https://pixijs.com/blog/pixi-v8-launches and https://pixijs.com/8.x/guides/components/renderers — Pixi v8 perf, WebGPU backend status, WebGL default guidance

WebGPU / three.js / engines
- https://github.com/gpuweb/gpuweb/wiki/Implementation-Status and https://caniuse.com/webgpu — browser support matrix (~84.7% global, 2026-03)
- https://web.dev/blog/webgpu-supported-major-browsers — all major browsers ship WebGPU (Safari 26, Firefox 141/145)
- https://github.com/mrdoob/three.js/releases — r185 latest (mid-2026); ongoing WebGPURenderer/TSL work
- https://blog.maximeheckel.com/posts/field-guide-to-tsl-and-webgpu/ — TSL state and gaps
- https://r3f.docs.pmnd.rs/tutorials/v9-migration-guide and https://github.com/pmndrs/react-three-fiber/releases — R3F v9 + React 19, WebGPU/TSL first-class
- https://blog.loopspeed.co.uk/react-three-fiber-webgpu-typescript — R3F + WebGPU/TSL practicalities
- https://github.com/harp-lab/GraphWaGu (via https://www.willusher.io/publications/graphwagu/) — WebGPU compute force layout research system
- https://github.com/drkameleon/GraphGPU — WebGPU graph viz library (GPU compute physics)
- https://playcanvas.com/ + https://blog.playcanvas.com/initial-webgpu-support-lands-in-playcanvas-engine-1-62/ + https://github.com/playcanvas/engine — PlayCanvas WebGPU/compute + open-source editor

UI motion
- https://motion.dev/magazine/framer-motion-is-now-independent-introducing-motion and https://motion.dev/blog/motion-independence-one-year-in-review — Motion independence, vanilla APIs, MIT
- https://registry.npmjs.org/motion/latest — v12.42.2, MIT (registry verified)
- https://motion.dev/plus — Motion+ scope (paid extras, not required)
- https://github.com/juliangarnier/anime/releases and https://animejs.com/documentation/ — anime.js v4.x features (timeline, springs, WAAPI, createLayout, three.js adapter in v4.5)
- https://registry.npmjs.org/animejs/latest — v4.5.0, MIT (registry verified)
- https://webflow.com/blog/gsap-becomes-free and https://gsap.com/pricing/ — GSAP 100% free incl. Club plugins (2025-04-30)
- https://css-tricks.com/gsap-is-now-completely-free-even-for-commercial-use/ — independent confirmation

Streaming + accessibility
- https://www.fusioncharts.com/blog/visualize-real-time-data-socket-io-charts/ and https://dev.to/byte-sized-news/real-time-chart-updates-using-websockets-to-build-live-dashboards-3hml — batching/rAF-sync guidance for live streams
- https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion — reduced-motion media query
- https://blog.pope.tech/2025/12/08/design-accessible-animation-and-movement/ — 2025 motion accessibility guidance (distances, fades, triggers)
- https://www.tatianamac.com/posts/prefers-reduced-motion — no-motion-first approach

Machine ground truth (verified locally, read-only): Apple M4 Max, 32-core GPU, Metal 4
(`system_profiler SPDisplaysDataType`); Claude Code 2.1.193; `~/.claude/{projects,history.jsonl,hooks,usage-data,telemetry,sessions}` present.

## Open questions

1. **Electron vs Tauri decision (owned by another workstream) changes the WebGPU story** (Chromium vs WKWebView) and worker/file-access ergonomics — this doc assumes either works; confirm before locking Pixi's WebGPU flag plans.
2. **Event source of record**: PostToolUse hooks vs transcript-JSONL tailing vs fswatch — which combination gives complete coverage for OpenCode sessions (whose event/log format needs its own probe), and what is the dedup key when several fire for one file touch?
3. **cosmos.gl WebGPU roadmap** is unpublished — if a corpus-scale view becomes a requirement, re-check whether cosmos.gl gained WebGPU or whether GraphWaGu-style custom compute is warranted then.
4. **sigma v4** (alpha now) may materially improve custom rendering ergonomics — re-evaluate only if the custom Pixi layer stalls.
5. **Graph persistence across sessions** ([X4] workstreams): does the graph rehydrate a workstream's historical subgraph on open (needs positions persisted per workstream) or always re-grow live? Affects store schema now.
6. **Label strategy at 1k+ nodes** (SDF text vs sprite atlas vs HTML overlay) needs a spike; Pixi v8's BitmapText is the default bet but CJK/emoji in file paths may force MSDF or HTML overlay.
7. **d3-force-3d as the 2D engine** (to keep one API for a later 3D mode) vs plain d3-force — micro-benchmark tick cost in-worker before committing.
