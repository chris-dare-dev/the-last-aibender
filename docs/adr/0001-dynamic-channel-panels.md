# ADR-0001 — Render channel instrument panels from the account registry (N panels, positional hues)

- Date: 2026-07-05
- Author: FE-ORCH (Stage-3 account-registry generalization, lane FE)
- Status: accepted

## Context

DESIGN.md §2.5 ("Channels — fixed positions, engraved labels, low-sat index
hues") specifies FIVE channel panels rendered in a fixed slot order 1→5 in the
right zone, each with a named index hue (slate/sand/mint/rose/ash), on the
flight-deck principle: the operator learns where to glance and instruments
never reflow or reorder in response to data.

[X1] scalability (ICR-0013) makes the Claude account set OPEN: the owner can
provision MAX_C, MAX_D, … The cockpit must show one channel panel per
CONFIGURED Claude account plus the two fixed backend panels (BEDROCK/LMSTUDIO).
That is N panels, not exactly five — a direct tension with the literal "five,
slots 1→5" wording of §2.5. This is a decision beyond what the tokens can
express, so it is recorded here rather than silently taken.

## Decision

The channel instrument stack renders **one panel per account-registry entry**:
the configured Claude accounts first (in registry order), then the two fixed
backend entries, always in that order. The flight-deck INVARIANTS are preserved
exactly:

- **Stable, data-independent order.** Panels are ordered by the registry
  (Claude accounts by their configured slot, then AWS_DEV, then LOCAL). The
  order never changes in response to telemetry — only when the CONFIGURED set
  changes (a deliberate provisioning action, not runtime data), exactly like
  adding a session never reorders the existing ones.
- **Slots retained, never vanish.** A down channel still dims to
  `--ig-ink-faint` with the NO SIGNAL treatment; it never disappears.
- **The two backend panels keep their fixed hues** (`--ig-channel-bedrock`,
  `--ig-channel-lmstudio`) and always occupy the tail slots.
- **Channel index hues stay a fixed positional palette.** The five
  `--ig-channel-*` custom properties in tokens.ts (FE-1's locked source) are
  UNCHANGED. Claude accounts draw their 2×16px index tick from the three
  Claude-hue tokens (max-a/max-b/ent) assigned BY SLOT POSITION, reused
  cyclically for a 4th/5th account. The hue is only a positional tick; the
  ENGRAVED LABEL (MAX_C) is the account identity. No new hue is invented, so
  tokens.ts, DESIGN.md §2.5's hue table, and `pnpm -F app lint:tokens` are all
  untouched.

The right zone is a vertical stack that already scrolls; N panels stack the
same way five did. No new layout token is introduced.

## Blueprint section overridden

None of `01-architecture-blueprint.md` — this is a DESIGN.md §2.5 refinement,
not a blueprint override. §2.5's "five channels / slots 1→5" is reinterpreted as
"one panel per configured channel in a stable registry order"; the underlying
flight-deck principle (fixed placement, no data-driven reflow, dimmed-not-gone
down state) is upheld verbatim. The three seed accounts + two backends still
render as the same five panels in the same order when no additional account is
configured, so the default cockpit is visually identical to the pre-ICR-0013
build.

## Consequence

- **Easier:** adding a Claude account is now a pure data change (the registry
  gains an entry); the cockpit grows a panel with zero code or token edits. The
  honest answer to [X1] "is it easy to add an account?" becomes YES.
- **Harder / to revisit:** with many accounts the right zone can exceed the
  viewport; today it scrolls (acceptable for the realistic 3–6 account range).
  If the account count grows large enough that scrolling hurts glanceability, a
  future ADR should introduce a compaction/grouping treatment — that is a
  DESIGN.md change requiring FE-1 sign-off, out of scope here.
- **Hue reuse** means a 4th Claude account shares a tick hue with the 1st. This
  is acceptable because the engraved label disambiguates and the hue is
  explicitly a low-salience positional tick (§2.5: "index/tick use only");
  a dedicated per-account palette would require new tokens and an FE-1 sign-off.
