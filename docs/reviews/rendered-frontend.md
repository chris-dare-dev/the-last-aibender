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

## Follow-up (needs a live broker — now unblocked by the 5 logins)

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
