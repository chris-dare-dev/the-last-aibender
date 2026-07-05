# ICR-0013 — account-registry generalization (open Claude-account label FORM)

- Requesting lane: **BE-ORCH** (owner of the frozen vocabulary; this AMENDS
  FROZEN-M1-CORE `vocab.ts` — the highest-stakes freeze of the program).
- Surface: `packages/protocol/src/vocab.ts` (+ every protocol consumer:
  `validate.ts`, `dag/types.ts`, `dag/validate.ts`, `control.ts`, `index.ts`,
  `dag/index.ts`), `packages/schema/src/{kernel,events,lineage}.ts` accessors,
  `packages/schema/src/migrations/0005-account-registry.ts` (new, kernel DB) +
  `0006-account-registry-events.ts` (new, events DB), `packages/shared/src/
  identityMap.ts`, the golden corpora (`testkit/src/{wsGolden,hooksGolden}.ts`),
  and the [X2] placeholder doctrine of record (SECURITY.md §1, .gitleaks.toml
  header). Protocol bump `1.4.0` → `1.5.0`, `FROZEN-M6` → `FROZEN-M7`.
- Freeze state at request time: M6 (final Stage-2). The account label set was a
  CLOSED frozen array of exactly 5 strings; `AccountLabel` was the union of
  them; `LABEL_BACKENDS` was a fixed `Record<AccountLabel,Backend>`;
  `isAccountLabel` tested membership; schema CHECK constraints pinned
  `account ∈ {5 literals}`.

## Motivation ([X1] scalability, owner-surfaced)

The owner logged into TWO more Claude Max accounts (labels `MAX_C`, `MAX_D`)
exactly like the three provisioned ones. The keychain isolation mechanism
scaled automatically (distinct `CLAUDE_CONFIG_DIR` → distinct securestorage-dir
sha256 → distinct `Claude Code-credentials-<hash8>` keychain item — verified
distinct). But the new accounts were INVISIBLE to the harness because the label
set was hardcoded to `{MAX_A, MAX_B, ENT}` (+ backend labels `AWS_DEV`,
`LOCAL`). The [X1] requirement asks "is it easy to add a new Claude subscription
account?" — this ICR makes the honest answer YES.

## Change (validation-widening, additive; the pairing invariant preserved)

Separate TWO concepts that the closed set conflated:

1. **FIXED BACKEND LABELS** `{AWS_DEV, LOCAL}` — NOT accounts; each is the single
   stand-in for one backend substrate. Set stays **CLOSED**
   (`FIXED_BACKEND_LABELS`, `isFixedBackendLabel`). A new one would be a new
   backend — its own ICR.
2. **CLAUDE ACCOUNT LABELS** — an **OPEN, validated FORM**:
   `CLAUDE_ACCOUNT_LABEL_RE = /^MAX_[A-Z]$/` (Max accounts, A–Z) **plus** the
   exact literal `ENT` (enterprise). `isClaudeAccountLabel` tests the form. A
   future `ENT_x` form is deliberately NOT admitted (kept minimal + [X2]).

- `isAccountLabel(v)` = `isClaudeAccountLabel(v) || isFixedBackendLabel(v)`. The
  form, not a hardcoded 5-set, is the validation ceiling. `AccountLabel` widens
  to `` `MAX_${string}` | 'ENT' | 'AWS_DEV' | 'LOCAL' `` (a structural
  approximation; `isAccountLabel` is the authoritative single-uppercase-letter
  gate). `ACCOUNT_LABELS` stays as a KNOWN/SEED list for back-compat + DB
  seeding + tests, but is NO LONGER the ceiling.
- `LABEL_BACKENDS` (a `Record`) → **`backendForLabel(label): Backend`** (a
  function; throws `UnknownAccountLabelError` on a non-form label per the
  typed-refusal convention) + `backendForLabelOrUndefined` (total). The
  account↔backend pairing invariant is preserved verbatim (any `MAX_<X>`/`ENT`
  → `claude_code`; `AWS_DEV` → `opencode`; `LOCAL` → `lmstudio`). The DAG
  `ACCOUNT_STEP_BACKENDS` Record → `accountStepBackendsFor(label)` for the same
  reason (a 5-key Record would return `undefined` for MAX_C at runtime).
- **Schema**: migrations 0005 (kernel: account_profiles, resume_ledger,
  session_node, step_attempt) + 0006 (events: events, quota_snapshots,
  session_outcomes) relax the CHECK from the 5-literal set to
  `account[_label] GLOB 'MAX_[A-Z]' OR IN ('ENT','AWS_DEV','LOCAL')` — the SQL
  mirror of the regex (GLOB treats `_` literally, `[A-Z]` is case-sensitive).
  The label↔backend pairing CHECK is preserved (GLOB form). Table-rebuild
  (SQLite cannot ALTER a CHECK) via `defer_foreign_keys` + the rename-old-first
  recipe for the one inbound-FK table (session_node ← session_edge). Seed rows +
  indexes preserved; frozen 0001–0004 untouched. See sqlite-ddl.md §10.7.
- **[X2] doctrine**: SECURITY.md §1 + the .gitleaks.toml header generalize the
  Max-account placeholder from `MAX_A`/`MAX_B` to the `MAX_<X>` form; `MAX_C` /
  `MAX_D` are now first-class sanctioned placeholders. NO gitleaks rule changed
  (a `MAX_<X>` label is not secret-shaped — verified against all three Tier-1
  rules).

## Compatibility

- Additive / validation-widening: every M1–M6 label is still valid; NO wire
  SHAPE changed (only which `accountLabel`/`account` VALUES validate). Every
  prior golden fixture replays byte-identically; the corpus gains valid
  `MAX_C`/`MAX_D` launch fixtures + rejected non-sanctioned fixtures (`HACKER`,
  lowercase `max_c`) proving the form is a real gate.
- The form is a REAL gate, not anything-goes: the identifier-audit invariant
  (no raw identity can render) is untouched — a non-sanctioned label is
  REJECTED at every layer (wire validator, schema accessor + CHECK, identity-map
  loader, hook-POST path). Proven by `vocab.spec.ts`, the golden corpora,
  `identityMap.spec.ts`, `kernel.spec.ts`, and the migration smoke.
- Out-of-`packages/` consumers (the build lanes' job — listed in the BE-ORCH
  return): `core/**` and `app/**` still import `AccountLabel`/`isAccountLabel`
  (unchanged signatures) but must swap `LABEL_BACKENDS[x]` → `backendForLabel(x)`
  and `ACCOUNT_STEP_BACKENDS[x]` → `accountStepBackendsFor(x)`; the FE picker's
  "exactly five labels" audit (`app/src/features/launch/views.spec.ts`) must
  render the runtime registry instead of asserting a hardcoded 5.
- Reversal path: restore the closed `ACCOUNT_LABELS`-membership `isAccountLabel`
  + the `LABEL_BACKENDS` Record, revert the two migrations (a 0007 that
  re-tightens the CHECK), and re-pin the version to `1.4.0`/`FROZEN-M6`. Nothing
  outside the listed surfaces depends on the widening.

## Sign-off

- Owning orchestrator (BE-ORCH): **RATIFIED 2026-07-05** — landed by the
  account-registry contract change; protocol + schema + shared + testkit suites
  and typechecks green (see the return); the pairing invariant and the
  identifier-audit invariant both preserved; migrations proven on a
  seeded-with-FK-data DB.
- Counterpart orchestrator (FE-ORCH): **co-signed 2026-07-05.** The FE change
  landed: the launch picker + channel instrument panels + observability/
  pipelines/workstreams account chips enumerate the runtime account registry
  (the `app/src/lib/accountRegistry.ts` seam — N Claude accounts + the two
  fixed backend labels), not a hardcoded five. Verified at the Stage-3 gate
  review: the `AccountLabel`/`isAccountLabel` widened FORM is consumed
  correctly (golden WS corpus advanced FROZEN-M6→FROZEN-M7 and replays green on
  both sides; `wire.spec.ts` pins the freeze; every prior launch fixture
  byte-identical), the picker + channel-panel + 3/4/5-Claude registry suites
  are green (app 745/745), and the `views.spec.ts`/`audit.spec.ts` "exactly
  five" assertion was correctly re-expressed as the runtime registry + the
  sanctioned FORM — the [X2] identifier-audit invariant is INTACT and
  STRENGTHENED (a raw identity — email/12-digit id/token/`HACKER`/`MAX_AB`/
  lowercase — is DROPPED fail-closed by the registry and never renders for any
  N, while `MAX_C`/`MAX_D` are admitted by form). `LABEL_BACKENDS[x]` →
  `backendForLabel(x)` swapped at all app call sites; the pairing invariant
  holds. tokens.ts / DESIGN.md untouched (positional-hue palette reuse; ADR-0001
  records the §2.5 refinement); `lint:tokens` green; no locked-dependency drift;
  full workspace typecheck clean; gitleaks Tier-1 clean.
