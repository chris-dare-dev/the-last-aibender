# DESIGN.md — Instrument Grade

**System name:** Instrument Grade · token namespace `--ig-*`
**Status:** AUTHORED (FE-1, M0) — awaiting FE-ORCH lock mark. Until locked, no other FE package may merge UI code (plan §5, FE-1 gate).
**Normative sources:** [ui-anti-slop-design](docs/research/findings/ui-anti-slop-design.md) · blueprint §8 · plan §5/FE-1.
**Implementation:** `app/src/chrome/theme/tokens.ts` (typed source of truth) → generated `tokens.css` + `tailwind.theme.css` → enforced by `app/scripts/lint-tokens.mjs` (§8).

> **North star: flight instrument, not spaceship cosplay.**
> This harness is a calibrated instrument used all day in a dark room. Every
> screen is a panel, every value is a readout, every control is labeled like
> hardware. Rams' "as little design as possible," executed at night.
>
> This document exists because the harness is largely built **by coding
> agents** — the exact systems that produce "AI slop" when unconstrained. It is
> injected into every build agent's context. The token tables are closed sets;
> the FORBIDDEN list (§7) is a set of literal negative prompts; the lint (§8)
> makes the mechanical subset unmergeable. **If a value is not in this
> document, it does not exist.**

**Change control.** Any token change requires: edit here → mirrored edit in
`tokens.ts` → `pnpm -F aibender-app build:tokens` → FE-ORCH sign-off (ADR for
anything that widens a set). Agents never invent values; they file an ICR/ADR.

---

## 1. Identity in one table

| Question | Answer |
|---|---|
| What is it? | A mission-control **instrument**, not a website, not a SaaS dashboard |
| Mode | Dark-only v1 ("day cockpit" is out of scope; darkness is a brand constraint) |
| Palette | Warm charcoal surfaces, bone ink, **one** amber signal accent |
| Structure | Hairline rules and fixed panels — no cards, no shadows, no nesting |
| Type | Mono-forward; character grid on every data surface; tabular numerals always |
| Motion | Mechanical 120–180 ms ease-out; phosphor decay on live telemetry; 320 ms graph camera fly-to; **one** ceremony |
| Speed | Latency budgets are tokens (§5); the command palette is the primary verb surface (§6) |
| Voice | Terse instrument labeling; no marketing verbs, no sparkle |

---

## 2. Color tokens

All colors in the product come from the tables below. Any hex/rgb/hsl/oklch
literal not in these tables is a lint failure outside `app/src/chrome/theme/`.

### 2.1 Surfaces — warm charcoal, never navy

| Token | Value | Use |
|---|---|---|
| `--ig-surface-base` | `#111110` | App background |
| `--ig-surface-panel` | `#1A1917` | Panel fill, one step up |
| `--ig-surface-raised` | `#242220` | Palette, menus, dialogs |
| `--ig-surface-well` | `#0C0C0B` | Terminal viewport, graph canvas |
| `--ig-surface-scrim` | `rgba(12, 12, 11, 0.55)` | Modal scrim — flat opacity, **never** blur |

Texture: one 2–3% opacity SVG noise overlay is permitted on `base` only
(single asset, no per-panel grain). Nothing else may be textured.

### 2.2 Ink — bone, never pure white

| Token | Value | Use |
|---|---|---|
| `--ig-ink-primary` | `#E8E6E1` | Primary text and readouts (≈13.8:1 on base) |
| `--ig-ink-secondary` | `#B7B3AA` | Supporting copy, secondary readouts |
| `--ig-ink-muted` | `#8A867E` | Engraved labels, units, metadata (≈4.8:1 on panel) |
| `--ig-ink-faint` | `#57544E` | Disabled + NO SIGNAL (sub-AA **by intent**: disabled states) |
| `--ig-ink-on-accent` | `#111110` | Text on amber |

`#FFFFFF` and `#000000` do not exist. `bg-white`/`text-white` do not compile
(§8.2).

### 2.3 The accent — instrument amber, exactly one

| Token | Value | Use |
|---|---|---|
| `--ig-accent` | `#FFB000` | Interactive/attention ONLY (≈10:1 on base) |
| `--ig-accent-press` | `#D99600` | Pressed/active state |
| `--ig-accent-halo` | `rgba(255, 176, 0, 0.22)` | THE one sanctioned "glow" — see rule below |

Rules:
- Amber means **signal**: focused control, primary action, live datum,
  attention required. It is never decorative, never a large fill, never a
  heading color.
- `--ig-accent-halo` may appear in exactly two places: phosphor-decay live
  telemetry (§3.2) and the live-artifact pulse in the context graph. It is
  applied via `color`/`opacity`/`outline` — **never** via `box-shadow`
  (shadows do not exist, §2.7).
- There is no second accent. Ever.

### 2.4 Status — semantic use ONLY

Status hues encode **state**, never decoration, never emphasis, never
identity. Their meanings are normative:

| Token | Value | Meaning (exhaustive) |
|---|---|---|
| `--ig-status-ok` | `#3FB950` | Healthy / connected / within budget |
| `--ig-status-degraded` | `#D29922` | Soft-threshold breach: stale data, retrying, quota ≥75%, memory amber |
| `--ig-status-fault` | `#F85149` | Hard failure: budget breached, auth lost, process dead, quota 100% |
| `--ig-status-nosignal` | `#57544E` | Source absent or switched off — a **dimmed instrument**, never red |
| `--ig-status-ok-tint` | `rgba(63, 185, 80, 0.12)` | Row strip behind ok rows (only tinted bg allowed) |
| `--ig-status-degraded-tint` | `rgba(210, 153, 34, 0.12)` | Row strip behind degraded rows |
| `--ig-status-fault-tint` | `rgba(248, 81, 73, 0.12)` | Row strip behind fault rows |

NO SIGNAL doctrine (blueprint FE-5): a down source (LM Studio off, collector
gap, SI-4 not applied) renders as a dimmed instrument with an engraved
`NO SIGNAL` readout in `--ig-ink-faint`, plus a one-click remediation
affordance. It is **not** an error toast, not red, not a skeleton loader.
Status transitions snap instantly (§3.6) — a relay, not a fade.

### 2.5 Channels — fixed positions, engraved labels, low-sat index hues

The five channels are the visual backbone. Placeholder labels only ([X2]).

| Slot | Channel | Token | Index hue | Hue family |
|---|---|---|---|---|
| 1 | `MAX_A` | `--ig-channel-max-a` | `#8FB0C9` | slate |
| 2 | `MAX_B` | `--ig-channel-max-b` | `#C9B18F` | sand |
| 3 | `ENT` | `--ig-channel-ent` | `#8FC9B0` | mint |
| 4 | `BEDROCK` | `--ig-channel-bedrock` | `#C98FA0` | rose |
| 5 | `LMSTUDIO` | `--ig-channel-lmstudio` | `#A0A69B` | ash |

Rules:
- **Fixed placement** (flight-deck principle): the channel instrument stack
  always renders in slot order 1→5, top to bottom, in the right zone (§4).
  The user learns *where to glance*; panels never reflow or reorder.
- Index hues are **identity ticks only**: the 2×16 px label underline tick,
  the session-block spine, graph node stroke. Never fills, never text color,
  never buttons. Max area at any time: hairline-scale.
- All five sit at ≈65–70% lightness, ≈25% saturation — deliberately quieter
  than every status hue and far quieter than amber.
- Engraved label spec (the sanctioned mono-caps exception, see §7 item 12):
  `--ig-font-mono` at `--ig-type-label` (11px/16px), uppercase,
  `letter-spacing: var(--ig-tracking-engraved)` (0.08em), color
  `--ig-ink-muted`, with the channel index tick beneath. No text-shadow — the
  "engraved" read comes from muted-on-panel contrast, as if machined.
- A channel's down state = NO SIGNAL treatment (§2.4) with the panel dimmed to
  `--ig-ink-faint`; the slot is retained (instruments don't disappear).

### 2.6 Lines & rules — hairlines instead of cards

| Token | Value | Use |
|---|---|---|
| `--ig-line-hairline` | `#2A2825` | Default divider |
| `--ig-line-emphasis` | `#3B3733` | Zone/section boundaries |
| `--ig-line-width` | `1px` | Every rule in the app |

Structure is expressed with 1px rules and spacing — never with cards, borders
+ shadow, or nested bordered containers. Maximum one border level between the
surface and any content.

### 2.7 Radii, elevation, effects

| Token | Value |
|---|---|
| `--ig-radius-0` | `0px` (default — everything) |
| `--ig-radius-1` | `1px` (small controls: inputs, ticks) |
| `--ig-radius-2` | `2px` (maximum — palette, dialogs) |
| `--ig-shadow` | `none` |

- Radii above 2px do not exist. `rounded-md`…`rounded-full` do not compile.
- **Shadows do not exist.** Elevation is expressed with surface steps
  (base→panel→raised) and hairlines. Focus uses outlines (§2.8).
- No blur, no glass, no gradients, no glows (see §7).

### 2.8 Focus

| Token | Value |
|---|---|
| `--ig-focus-outline` | `1px solid #FFB000` |
| `--ig-focus-offset` | `1px` |

Focus is always visible, always amber, always an `outline` (never a shadow
ring). Focus appearance is instant (never animated).

---

## 3. Motion grammar

Motion budget philosophy (the Family lesson): near-zero motion everywhere,
spent deliberately in exactly four places — mechanical state feedback,
phosphor-decay telemetry, context-graph camera moves, and one ceremony.
Only `transform`, `opacity`, `color`, and `stroke-dashoffset` are ever
animated. Nothing animates on scroll, on load, or on hover beyond
`hover-feedback`.

### 3.1 Mechanical baseline

| Token | Value |
|---|---|
| `--ig-motion-fast` | `120ms` |
| `--ig-motion-base` | `150ms` |
| `--ig-motion-deliberate` | `180ms` |
| `--ig-ease-mechanical` | `cubic-bezier(0.2, 0, 0, 1)` |

All UI state transitions live in 120–180 ms with `--ig-ease-mechanical` — an
ease-out decelerate that lands like a relay. There is no ease-in, no
ease-in-out, no spring, no overshoot, no duration above 180 ms outside
§3.2/§3.3/§3.4 (camera moves).

### 3.2 Phosphor decay — the live-telemetry signature

Applied to live data updates: quota gauge movement, event rows landing,
transcript block arrival, graph node activity.

| Phase | Spec |
|---|---|
| Attack | `0ms` — value snaps to bright state instantly (amber or bright ink) |
| Hold | `80ms` at full brightness |
| Decay | `640ms` (`--ig-motion-phosphor-decay-duration`), easing `--ig-ease-decay` = `cubic-bezier(0.19, 1, 0.22, 1)` — steep initial luminance drop, long faint tail |
| Properties | `opacity` and `color` only, bright → resting ink. Never size, blur, or box-shadow |
| Brightness ceiling | `--ig-accent` for attention-bearing data; `--ig-ink-primary` for routine updates |

The decay tail is the room's "alive" signal — telemetry glows and settles like
a phosphor trace. It is the ONLY repeating animation in the product.

### 3.3 The one ceremony — workstream lineage (`ceremony-lineage`)

Exactly one ceremonial animation exists in the entire product, reserved for
**ledger-committed workstream lineage events** (branch / continue / merge,
[X4]). Nothing else — not session start, not app launch, not completion — gets
ceremony.

| Aspect | Spec |
|---|---|
| Trigger | A lineage edge is committed to the workstream ledger (event from BE-7); fires once per event |
| Phase 1 | The new lineage edge draws itself along the rail: `stroke-dashoffset` sweep, `480ms`, `--ig-ease-mechanical` |
| Phase 2 | On draw completion, the terminal node ring lights `--ig-accent` instantly and phosphor-decays (§3.2, 640 ms) to the channel index hue at rest |
| Budget | Hard cap `1200ms` total (`--ig-latency-ceremony-budget`); never blocks input; runs at lineage-view z-level only |
| Coalescing | If multiple lineage events land within one frame, only the newest animates; the rest render settled |
| Non-triggers | Hover, scroll, load, resume, selection — never |

### 3.4 Camera moves — the sanctioned fly-to (`camera-ease`)

The context-graph camera is the one surface allowed above the §3.1 band: a
spatial reframe at ≤180 ms reads as a teleport, not a move — the eye loses the
path. It stays mechanical: same easing, `transform` only, no overshoot.

| Aspect | Spec |
|---|---|
| Trigger | Context-graph camera moves (focus node, fit-to-selection) driven via Motion `animate()` |
| Duration | `320ms` (`--ig-motion-camera-ease-duration`) |
| Easing | `--ig-ease-mechanical` — the same relay decelerate, never a spring |
| Properties | `transform` only (camera translate/scale) — never opacity, never blur |
| Non-triggers | Data updates, node arrival, hover, scroll — the camera moves only on explicit user navigation |
| Reduced motion | instant — no fly-to; jump cut to the target framing (§3.5) |

### 3.5 Reduced-motion — total mapping

`@media (prefers-reduced-motion: reduce)` remaps **every** animated token; the
table is total by construction (`tokens.ts` requires a `reducedMotion` variant
per token; the theme test asserts totality; the generated CSS zeroes every
duration).

| Animated token | Duration | Reduced-motion behavior |
|---|---|---|
| `hover-feedback` | 120ms | instant — state applies with no tween |
| `panel-transition` | 150ms | instant — panels appear/disappear in a single frame |
| `focus-shift` | 120ms | instant — highlight jumps, no travel |
| `palette-open` | 120ms | instant — palette appears settled; no translate, no fade |
| `phosphor-decay` | 640ms | discrete — static amber freshness tick while sample <2s old, removed in one step |
| `camera-ease` | 320ms | instant — no fly-to; jump cut to target framing |
| `ceremony-lineage` | 480ms (+decay) | discrete — edge renders settled; static amber ring 1200ms, then reverts in one step |

"Discrete" means non-tweened state steps (allowed under reduced motion);
nothing ever slides, scales, or fades for these users.

### 3.6 Never animated

Status color changes (ok↔degraded↔fault↔nosignal) snap in 0 ms — a relay
click, not a crossfade. Layout/zone geometry never tweens on data changes.
Text is never revealed per-token/per-character by the UI layer (streaming
content renders as it arrives; the terminal island owns its own bytes).

---

## 4. Layout — the three-zone cockpit

Ultrawide-first: the deployment target is a 3440×1440 ultrawide plus an XDR
laptop panel (findings §7). Design at ≥1440 px first; collapse downward.

### 4.1 Zones

| Token | Value | Zone |
|---|---|---|
| `--ig-zone-left` | `304px` | **Left — fleet:** workstream tree, session list, pipeline runs |
| `--ig-zone-center-min` | `640px` | **Center — work:** active session (terminal/transcript), graph, builder |
| `--ig-zone-right` | `352px` | **Right — instruments:** the five channel panels in slot order (§2.5), then aggregate gauges |

Panels have fixed positions inside their zone. State must be *glanceable*: the
same reading is always in the same place. Panel geometry never reflows in
response to data (only to explicit user layout actions).

### 4.2 Breakpoints

| Token | Value | Behavior |
|---|---|---|
| `--ig-breakpoint-ultrawide` | `2200px` | Cockpit + persistent secondary session columns in center |
| `--ig-breakpoint-cockpit` | `1440px` | Full three-zone cockpit |
| `--ig-breakpoint-compact` | `1024px` | Left zone collapses to a 48px icon rail; right zone overlays on demand |
| below compact | — | Single column; instruments become a top strip (laptop fallback) |

These three are the ONLY breakpoints (`--breakpoint-*` defaults are erased
from Tailwind, §8.2).

### 4.3 Spacing & the character grid

| Token | Value |
|---|---|
| `--ig-space-unit` | `4px` (all spacing is a multiple) |
| steps | `2 · 4 · 8 · 12 · 16 · 20 · 24 · 32 · 48` px |
| `--ig-grid-ch` | `1ch` — data-surface column unit |
| `--ig-grid-row` | `20px` — data-surface row rhythm |

**Data surfaces** (transcripts, event tables, quota readouts, cost tables) are
laid out on the monospace character grid: column widths in `ch`, rows on the
20 px rhythm, alignment achieved with the grid — not with per-cell padding.
Chrome surfaces (nav, settings) use the 4 px scale.

### 4.4 Type

| Token | Size/LH | Use |
|---|---|---|
| `--ig-type-label` | 11/16 | Engraved labels, units |
| `--ig-type-data` | 12/20 | Data-grid content, code |
| `--ig-type-body` | 13/20 | Prose (briefs, docs) |
| `--ig-type-ui` | 14/20 | Controls, menus |
| `--ig-type-heading` | 18/24 | Panel headings |
| `--ig-type-display` | 23/28 | View titles |
| `--ig-type-numeral` | 29/32 | Gauge readouts |
| `--ig-type-numeral-lg` | 36/40 | Hero readouts (odometer, fuel gauge) |

Scale ratio ≈1.28 across display steps. **Numerals are always tabular**
(`--ig-numeric: tabular-nums`) on every data surface — a readout may never
jitter in width.

Font stacks (license-clean; **font binaries never enter the tree**):

| Token | Stack |
|---|---|
| `--ig-font-mono` | `"Berkeley Mono", "TX-02", "IBM Plex Mono", "JetBrains Mono", "Commit Mono", ui-monospace, "SF Mono", Menlo, monospace` |
| `--ig-font-display` | `"Cabinet Grotesk", "General Sans", system-ui, "Helvetica Neue", sans-serif` |

- Mono carries data, readouts, labels, code — the instrument voice.
  Committed reality = the free faces: **IBM Plex Mono** (OFL 1.1, primary),
  **JetBrains Mono** (OFL 1.1), **Commit Mono** (MIT). "Berkeley Mono"/"TX-02"
  are optional machine-local commercial faces resolved only if the owner has
  installed them ([X2]-class: their binaries/licenses never enter the repo).
- Display grotesque carries headings and chrome: **Cabinet Grotesk** /
  **General Sans** (Fontshare, ITF Free Font License — self-hosting permitted,
  binaries still untracked).
- Free-face files land in `app/assets/fonts/` (gitignored — SI-1 owns the
  pattern) via a fetch step at dev-setup time; stacks degrade gracefully to
  system faces if absent.
- FORBIDDEN faces (§7): Inter, Geist, Space Grotesk, Roboto, italic-serif
  display of any kind.

---

## 5. Latency — first-class tokens

Speed is the aesthetic (the Linear/Zed lesson). These budgets are design
tokens; perf tests enforce them downstream (plan §9, T4).

| Token | Budget | Meaning |
|---|---|---|
| `--ig-latency-interaction` | `100ms` | Any input paints visible feedback within 100 ms |
| `--ig-latency-keystroke-echo-p95` | `100ms` | Terminal typing echo p95 (M2 DoD) |
| `--ig-latency-palette-open` | `100ms` | Palette summon → interactive |
| `--ig-latency-spinner-threshold` | `300ms` | Below this, NO loading indicator may render |
| `--ig-latency-ceremony-budget` | `1200ms` | Ceremony wall-clock cap (§3.3) |

Loading doctrine: under 300 ms, nothing. Over 300 ms, a mono ellipsis ticker
(`…`) in `--ig-ink-muted` or the NO SIGNAL treatment — never a spinner
carousel, never skeleton shimmer (§7 item 14), never a progress bar for
indeterminate work.

---

## 6. Command palette — the primary verb surface

Raycast-grammar: every action reachable in two keystrokes.

| Token | Value |
|---|---|
| summon | `⌘K` (`Mod+K`) |
| `--ig-palette-width` | `640px` |
| `--ig-palette-offset-y` | `160px` from viewport top, centered horizontally |
| `--ig-palette-row` | `28px` |
| `--ig-palette-max-rows` | `12` |
| surface | `--ig-surface-raised`, border `1px solid --ig-line-emphasis`, radius `--ig-radius-2` |
| scrim | `--ig-surface-scrim` — flat, no blur |
| motion | `palette-open` token (120 ms fade + 8 px translateY settle) |

Grammar: verb-first fuzzy match (`launch prompt on MAX_B`, `open workstream…`,
`lms server start`). Frequency-ranked. Kill-switch rule: anything a mouse can
do in the cockpit, the palette can do in two keystrokes.

---

## 7. FORBIDDEN — the anti-slop lock

Each entry is a literal negative constraint for every build agent.
**Mechanical** = caught by `lint-tokens.mjs` (rule id in parentheses, §8.3);
**review** = FE-ORCH review gate.

| # | Forbidden | Enforcement |
|---|---|---|
| 1 | Purple/violet/indigo anything — hue band 250–290° at any saturation >15%: fills, text, accents | mechanical (`off-token-hex`, `color-fn` — no such token exists) |
| 2 | Gradients of any kind: `linear/radial/conic-gradient`, `bg-gradient-*`, gradient text | mechanical (`gradient`) |
| 3 | Glassmorphism: `backdrop-filter`, `backdrop-blur`, frosted translucent panels | mechanical (`glass`) |
| 4 | Shadows and colored glows: any `box-shadow`/`text-shadow`/`drop-shadow` ≠ `none`, `shadow-*` utilities | mechanical (`shadow`) |
| 5 | Radius >2px: `rounded-sm/md/lg/xl/2xl/3xl/full`, pill buttons, circular avatars | mechanical (`radius`) |
| 6 | Inter, Geist, Space Grotesk, Roboto as UI faces; any literal font stack outside the theme | mechanical (`font-family`) |
| 7 | Italic-serif hero/display type (the "AI-startup hero" tell) | review (no serif token exists; mechanical via `font-family`) |
| 8 | Bounce/elastic/spring easing, overshoot, `type:"spring"`, off-token `cubic-bezier` | mechanical (`easing`) |
| 9 | ✨ sparkles, 🪄 wands, 🤖 robots, 🧠 brains, ⚡ bolts as AI signifiers; sparkle icon imports; emoji in chrome generally | mechanical (`iconography`) + review |
| 10 | Skeleton shimmer / `animate-pulse` loaders | mechanical (`loader`) |
| 11 | Cards: bordered rounded containers with shadow; cards inside cards; gray 1px border on everything | review (mechanically starved by 4+5; hairline doctrine §2.6) |
| 12 | Uppercase-tracked marketing "kicker" labels above headings. *Sanctioned exception:* engraved instrument panel labels per §2.5 spec | review |
| 13 | Bento grids; three icon+heading+text feature cards in a row; icon-in-rounded-square containers | review |
| 14 | Chat bubbles for transcripts (transcripts are document blocks — the Warp lesson) | review |
| 15 | Dark navy surfaces, blurred gradient "orbs", cyan-on-dark neon | mechanical (`off-token-hex`) |
| 16 | Warm cream/beige "tasteful" light surfaces; any light mode in v1 | mechanical (`off-token-hex`) |
| 17 | Error toasts for absent sources (NO SIGNAL doctrine §2.4 instead) | review |
| 18 | Copy: "streamline, empower, supercharge, world-class, enterprise-grade"; "It's not X. It's Y."; em-dash-cadence microcopy | review |
| 19 | Scroll-triggered reveals, hover scale/rotate on images, animated page transitions | review (§3 grammar leaves them no tokens) |
| 20 | Sci-fi HUD cosplay: scanlines, barrel distortion, RGB-shift, arwes-style chrome (the *next* cliché) | review |

Meta-rule: distinctiveness comes from the coherent system above, not from
adopting the brutalist/terminal counter-uniform. When in doubt: **would this
belong on a Braun instrument panel? If not, it doesn't belong here.**

---

## 8. Enforcement — the token build chain

### 8.1 Chain

```
DESIGN.md  (this lock — human/agent readable, normative)
   │  mirrored by hand under FE-ORCH sign-off
   ▼
app/src/chrome/theme/tokens.ts          typed source of truth (closed sets)
   │  pnpm -F aibender-app build:tokens
   ├──► app/src/chrome/theme/tokens.css           --ig-* custom properties
   │      + total prefers-reduced-motion remap     (runtime, incl. WebGL islands
   │                                                reading via getComputedStyle)
   └──► app/src/chrome/theme/tailwind.theme.css   Tailwind 4 @theme
```

Generated files are committed; `theme.spec.ts` fails the build if they drift
from `tokens.ts`.

### 8.2 Tailwind theme discipline

`tailwind.theme.css` **first erases** the default namespaces
(`--color-*`, `--font-*`, `--text-*`, `--radius-*`, `--shadow-*`, `--blur-*`,
`--ease-*`, `--animate-*`, `--tracking-*`, `--breakpoint-*`, …`: initial`) and
then defines only Instrument Grade tokens. Consequence: `bg-indigo-500`,
`shadow-xl`, `rounded-2xl`, `backdrop-blur-md` **do not compile to anything**
— the slop vocabulary is not renamed, it is removed.

### 8.3 Token lint

`pnpm -F aibender-app lint:tokens` (plain Node, zero deps) scans everything
under `app/src` **except** `app/src/chrome/theme/` and fails CI on:
`off-token-hex`, `color-fn`, `radius`, `shadow`, `gradient`, `glass`,
`font-family`, `easing`, `iconography`, `loader` (rule definitions in the
script header). The allowlist is parsed from the *generated* `tokens.css`, so
the lint is automatically in lock-step with this document.

### 8.4 Escape hatch

A line containing `token-lint-allow` is skipped by the lint. Using it requires
FE-ORCH sign-off recorded in an ADR. There is no other suppression mechanism,
and no agent may add one.

### 8.5 How to consume tokens (build agents, read this twice)

- In Tailwind-styled markup: use the generated utilities only
  (`bg-surface-panel`, `text-ink-muted`, `border-line-hairline`,
  `rounded-2`, `ease-mechanical`, `font-mono`, `text-data`…).
- In CSS/inline styles: use `var(--ig-…)` only.
- In canvas/WebGL islands: read `--ig-*` via `getComputedStyle` at init and on
  theme-relevant events; never bake hex literals into shader/renderer code.
- Never write a hex/rgb/hsl literal, a px radius, a shadow, a gradient, a font
  name, or a `cubic-bezier` outside `app/src/chrome/theme/`.

---

## 9. Accessibility

- Contrast (WCAG-2 ratios; APCA adoption tracked as an open item):
  `ink-primary` on `surface-base` ≈13.8:1 · `accent` on `base` ≈10:1 ·
  `ink-muted` on `panel` ≈4.8:1 (AA at 11 px mono labels) · `ink-faint` is
  sub-AA **only** for disabled/NO SIGNAL states, which carry a text label, never
  color-only meaning.
- Status is never color-only: every status hue is paired with an engraved text
  readout (`OK` / `DEGRADED` / `FAULT` / `NO SIGNAL`) or a glyph with a text
  tooltip.
- Reduced motion: total mapping, §3.5 — enforced by test.
- Focus: always-visible amber outline, §2.8; full keyboard reachability is an
  FE-2 acceptance requirement (palette-first grammar, §6).
- Hit targets: minimum 20 px (one grid row) on desktop pointer targets.

---

## 10. Open items (tracked, non-blocking for the lock)

1. APCA contrast targets to supersede WCAG-2 ratios once real screens exist
   (findings open question 6).
2. The "cosplay line" for phosphor dosage — re-evaluate §3.2 brightness ceiling
   after 8-hour daily-driver use (findings open question 7).
3. Owner decision on purchasing Berkeley Mono TX-02 for machine-local use
   (never committed either way).
4. P3/XDR accent calibration on the actual display (findings §7) — may adjust
   `--ig-accent-halo` alpha only; the hue is locked.
