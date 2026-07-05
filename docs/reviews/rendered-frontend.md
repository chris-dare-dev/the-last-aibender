# Stage-3 Review — Rendered-Frontend (screen capture)

The mandatory rendered pass: findings from the **actual running cockpit**, not
source. Captured by the driving session against the vite dev server
(`http://localhost:5173`, viewport 1600×1000, Chromium via the preview MCP) at
`HEAD = 5c34978`. Evidence: a full-cockpit screenshot, the accessibility tree
(`preview_snapshot`), and the ⌘K command-palette overlay.

> **Scope of this pass (honest limits).** Captured in the **disconnected /
> no-broker state** (no gateway advertised → every panel shows NO SIGNAL / NO
> GATEWAY), and against the **seed-3 account fallback** (MAX_A/MAX_B/ENT +
> AWS_DEV + LOCAL) because the bare dev server sets no
> `window.AIBENDER_CLAUDE_ACCOUNTS`. Populated states (live dashboards, the
> context-graph island, workstream lineage, a running pipeline), the
> 5-Claude-account density, and motion/transitions were **not** exercised —
> they need a live broker (owner logins are done, so a follow-up populated pass
> is now possible). This pass therefore critiques **chrome, layout,
> information architecture, empty-state, contrast, and navigation** — the
> aspects a disconnected render can show truthfully.

---

## What's genuinely good (record, don't "fix")

- **The anti-slop bar is cleared.** The aesthetic is a dense, engraved
  "instrument-grade" flight-deck — mono labels, index ticks, three fixed zones
  (fleet · work · instruments), a bottom approval rail. It reads as a bespoke
  cockpit, **not** the generic centered-card shadcn/Tailwind "AI app" look the
  brief forbids.
- **Accessibility structure is strong.** The a11y tree exposes proper landmarks
  (`banner`, `complementary "fleet zone"`, `main "work zone"`,
  `complementary "instruments zone"`), a `region` + `sectionheader` per channel
  and per instrument, and real `button`s (RECONNECT, GRAPH, BUILDER, APPROVALS,
  SETTINGS, ⌘K). Named regions like "channel MAX_A" / "instrument QUOTA" are
  screen-reader-navigable.
- **⌘K palette is right.** Verb-first, keyboard-operable, one clean overlay:
  focus-channel-*, focus context graph / dashboards, open approval inbox /
  pipelines / settings / workstreams, reconnect gateway.
- **The M6 resource-health instrument is live in the deck** (RESOURCE HEALTH
  region present alongside the 10 §6.3 leads).

## Findings (5): 0 high · 3 medium · 2 low

### RF-1 (MEDIUM) — Disconnected state is an undifferentiated wall of "NO SIGNAL / NO GATEWAY"
- **Evidence:** the full-cockpit capture shows ~16 stacked regions (5 channel
  panels + 11 instruments) plus the 3 fleet cards, **every one** reading
  "NO SIGNAL" + "NO GATEWAY" in the same dim gray. At a glance the whole app
  reads as *broken*, not *waiting for a broker*, and a genuinely-down single
  source (the intended NO-SIGNAL doctrine) would be **indistinguishable** from
  this everything-disconnected state.
- **Recommendation:** differentiate "the broker isn't up yet" (a single
  cockpit-level banner/empty-state with one primary CTA) from "this individual
  source is down" (the per-instrument NO SIGNAL). When the gateway itself is
  absent, collapse the 16 identical per-panel "NO GATEWAY" strings into one
  prominent connect affordance rather than repeating it 16×.

### RF-2 (MEDIUM) — Contrast / legibility likely below WCAG AA
- **Evidence:** labels, "NO SIGNAL", palette items, and the quota `5H/7D —`
  read as low-contrast gray on near-black charcoal. The instrument-grade
  dimness is intentional, but several text tiers appear to fall under the
  4.5:1 (AA) / 3:1 (large) thresholds.
- **Recommendation:** run a contrast audit against the DESIGN.md tokens
  (`preview_inspect` computed color vs background per text tier); lift the
  lowest tiers to at least AA, or document a deliberate AA-exempt "ambient"
  tier. This is measurable, not subjective — do it with the inspector.

### RF-3 (MEDIUM) — Right-rail density won't hold at N accounts
- **Evidence:** at the seed 3 Claude accounts the right rail already stacks 5
  channel panels + 11 instruments (16 regions). With the owner's **5** Claude
  accounts it becomes 7 channel panels (18 regions), and the M7 registry
  permits more — the rail will overflow into scrolling, pushing the
  lower instruments (OUTCOMES, LOCAL OFFLOAD, RESOURCE HEALTH) below the fold.
- **Recommendation:** design the rail for N — collapsible channel panels, a
  compact multi-account summary strip, or a channels/instruments tab split — so
  the flight-deck stays glanceable past 5 accounts. Pairs with the code-side
  OS-3/OS-5 N-scaling theme.

### RF-4 (LOW) — Command palette orders channels alphabetically, burying the primary account
- **Evidence:** the palette lists "focus channel AWS_DEV" **first**, then ENT,
  LOCAL, MAX_A, MAX_B — pure alpha sort, so the backend (AWS_DEV) leads and the
  primary Claude account (MAX_A) is 4th. The spec calls the palette
  frequency-ranked; empty-state ranking should still lead with the Claude
  accounts, not a backend.
- **Recommendation:** default channel ordering to accounts-before-backends (and
  frequency once there's history), so ⌘K → Enter lands on a Claude account.

### RF-5 (LOW) — Dev-only `createRoot` re-invocation warning
- **Evidence:** the console emits `ReactDOMClient.createRoot() on a container
  that has already been passed to createRoot()` ~30× under vite HMR.
- **Recommendation:** guard the entry (`app/src/main.tsx`) against re-mount
  (cache the root, or `if (!import.meta.hot) ...`) so HMR re-executions call
  `root.render()` rather than a second `createRoot`. Dev hygiene only — no
  production impact — but it floods the dev console.

---

## Follow-up (EXECUTED — see "Populated pass" below)

A second rendered pass should capture the **populated** states and critique
motion/depth, which a disconnected render can't show:
- the observability deck with live gauges/burn-rate/latency;
- the **context-graph island** (GRAPH) live-populating (depth, force layout,
  the anti-hairball layer/cluster-dim, reduced-motion);
- **workstream lineage** (branch/continue/merge rendering) and the one
  ceremonial animation;
- the **pipeline builder + run monitor** with per-step account routing;
- the cockpit at the real **5 Claude accounts** (RF-3 density in practice);
- responsive behavior at narrower widths.

Method for the follow-up: start the broker + inject the account list (or run
against the real gateway), then re-capture per view via the preview MCP.

---

## Populated pass (fixture-populated broker) — HEAD `b656b7e`

**Method.** Booted the **full real broker** via a new dev-only harness,
`core/scripts/demo-populated.ts` — `composeBroker` with the *only* substitution
being `@aibender/testkit`'s `FakeQueryRunner`/`FakePtyBackend` (the same swap
`demo-m1` uses). Every frame rides the **real frozen-protocol gateway publish
methods**, which validate against the frozen validators and journal for
reconnect-replay, so a freshly connecting cockpit gets the whole populated set
replayed from watermark 0. The harness floods every channel with representative
`[X2]` fixture data: quota 5h/7d for all five Claude accounts, all eleven §6.3
read-model snapshots, ~30 context-touches forming a small graph, a
branch/continue/merge lineage tree, a paused pipeline run with an approval gate,
one launched fake session, and one pending approval. The vite cockpit
(`localhost:5173`, viewport 1600×1000) was pointed at it through the FE dev
discovery global (`window.__AIBENDER_BOOTSTRAP__`, read by
`nativeBootstrapProvider` outside Tauri) + RECONNECT.

> **Honest limits.** (1) Data is **fixture-injected**, not a live end-to-end run
> through real Claude / OpenCode / LM Studio (owner-gated + no-cost constraints)
> — this proves the FE renders populated *frames* correctly, not the live
> production data path. (2) The preview screen-capture returned **downscaled
> thumbnails** (a preview-tool artifact — the app is genuinely 1600×1000 per
> `getBoundingClientRect`), so the assessment leans on `preview_inspect` /
> `eval` computed styles + the DOM (authoritative per the tool's own guidance
> for color/text/layout) plus gross-layout thumbnails — **not** pixel-peeping
> the screenshots. Motion/transition/reduced-motion was therefore **not**
> rigorously exercised. (3) AWS_DEV/LOCAL backends are genuinely down (Bedrock /
> LM Studio not running) — their NO SIGNAL is truthful, not a gap.

### Confirmed with data (record, don't "fix")

- **Connection + hydration works.** Setting the bootstrap global + clicking
  RECONNECT dropped the panel-level "NO GATEWAY" count from **19 → 0**; every
  Claude channel hydrated.
- **Account states read distinctly with data** (this is what resolves RF-1 —
  see below): `MAX_A — OK · 5H 41.5% · 7D 30.0% · WITHIN BUDGET`;
  `MAX_B — DEGRADED · 5H 88% · 7D 100% · QUOTA HIGH` (a visibly distinct
  warning state, reset already due); `ENT — OK · 5H 63% · 7D 55.5% · WITHIN
  BUDGET · FEA…`. Per-window reset countdowns render (`R 22:35` / `R 19:35`).
- **FLEET** shows the live launched session `ses_2068…` — `1 SES · RUNNING ·
  MAX_A · SDK`.
- **Left zone populated:** a context-pressure **BRANCH-NOW advisory** on the
  running merge session (`ses_ws_merge · 71.5% CTX`) beside the WORKSTREAMS dock.
- **GRAPH view:** a **944×888 canvas** force-directed context graph paints a
  populated node cluster (the context-graph island is canvas-based per FE-4, so
  node/edge counts aren't DOM-queryable, but the render surface + cluster are
  present).
- The **7 remaining NO SIGNAL** instruments are exactly the AWS_DEV + LOCAL
  panels — honest.

### Findings — updates to the disconnected pass

- **RF-1 → confirmed DISCONNECTED-ONLY (effective downgrade).** With a broker,
  the "undifferentiated wall" is gone: OK / DEGRADED / QUOTA-HIGH / WITHIN-BUDGET
  states are visually distinct, and a genuinely-down source sits legibly among
  healthy ones. RF-1's recommendation still stands **for the disconnected
  state** (collapse the 16× "NO GATEWAY" into one connect CTA), but it is a
  disconnected-empty-state concern, not a general one.
- **RF-2 → MEASURED; the dominant tier PASSES (refinement).** Real WCAG ratios
  computed on *populated* text: the primary dim-label tier — ash
  `rgb(138,134,126)` on charcoal `rgb(26,25,23)` at 11px — measures **4.85:1**,
  *above* the 4.5:1 AA line (labels FLEET / WORKSTREAMS / "1 SES" / "0 WS·0 DET"
  all 4.85). So the disconnected-pass guess ("likely below AA") was pessimistic
  for the dominant tier. **Caveat (feeds RF-6):** text set *over the translucent
  status chips* could not be measured reliably — alpha compositing defeats a
  computed-style walk — so that tier stays unverified.
- **RF-3 → holds, not yet breached.** At five Claude accounts the right rail is
  denser but did **not** overflow in this 1600×1000 capture; the concern (7
  channel panels + instruments as N grows) remains valid and pairs with
  OS-3/OS-5.
- **RF-4 / RF-5 unchanged** (palette account ordering; dev `createRoot` HMR
  warning) — not re-exercised in this pass.

### New finding

### RF-6 (LOW) — status-chip interior contrast unverified (measure the composited pixel)
- **Evidence:** text rendered on the translucent color-fill chips (the green
  "RUNNING" fleet chip; the amber "BRANCH NOW" advisory card) resisted automated
  contrast measurement — the chip background is a low-alpha color over charcoal,
  so a computed-style walk reads the *pre-composite* fill and returns a
  meaningless ratio (e.g. green-on-green = 1.0). These are the **highest-risk
  tiers** precisely because they sit on non-charcoal fills, and this pass could
  not clear them.
- **Recommendation:** sample the **composited** pixel (canvas readback, or solve
  the alpha-over-charcoal by hand) for these chips and confirm the label / value
  / DISMISS tiers clear AA against the *effective* background. Cheap, one-time,
  and closes the one hole RF-2's measurement left open.

### Reproducing this pass

`tsx core/scripts/demo-populated.ts` from the repo root boots the populated
broker and prints the gateway url/token + the exact FE discovery snippet. It is
dev-only, spawns no real session, spends no quota, and starts neither LM Studio
nor Bedrock; every value is synthesized `[X2]` (placeholder labels,
`/synthetic/...` paths, obviously-fake ids). Ctrl-C retracts the bootstrap file.
