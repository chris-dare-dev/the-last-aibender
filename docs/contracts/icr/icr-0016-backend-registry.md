# ICR-0016 — backend-registry generalization (BackendDescriptor + registry)

- Requesting lane: **BE-ORCH** (owner of the frozen vocabulary; this AMENDS
  FROZEN-M1-CORE `vocab.ts` `BACKENDS` + the schema backend/pairing/pty CHECKs).
- Surface: `packages/protocol/src/vocab.ts` (+ `index.ts` re-exports, the
  `vocab.spec.ts` / `index.spec.ts` / `m5Payloads.spec.ts` version pins),
  `packages/schema/src/migrations/0007-backend-registry.ts` (new, kernel DB) +
  `0008-backend-registry-events.ts` (new, events DB) +
  `0009-backend-registry-step-attempt.ts` (new, kernel DB — the `step_attempt`
  account amendment 0007 skipped) + the migration-list wiring
  in `0001-kernel.ts` / `0002-events.ts` + `index.ts` re-exports + the accessor
  pty-rule seam (`kernel.ts` `substrateLegalFor`) + the schema specs, the golden
  corpora (`testkit/src/wsGolden.ts` + `.spec.ts`, `GOLDEN_WS_CORPUS_FREEZE` /
  `GOLDEN_HOOK_CORPUS_FREEZE`), and the contracts of record
  (`ws-protocol.md` §4.1 + banner, `sqlite-ddl.md` §10.8 + banner). Protocol bump
  `1.5.0` → `1.6.0`, `FROZEN-M7` → `FROZEN-M8`.
- Freeze state at request time: M7 (Stage-2 + M7 account-registry). The backend
  set was a CLOSED frozen 3-tuple (`BACKENDS = [claude_code, opencode, lmstudio]`);
  `Backend` was the union of them; `isBackend` tested array membership;
  `backendForLabel` was a hardcoded if-chain; the `sourceForBackend` mapping lived
  as a hardcoded if-chain in `core/src/pipelines/lineageCost.ts`; and every schema
  migration hardcoded `backend IN ('claude_code','opencode','lmstudio')` plus a
  pairing CHECK and a `substrate != 'pty' OR backend = 'claude_code'` CHECK.

## Motivation ([X1] scalability, finding OS-1 — HIGH, gate-verified)

Adding a new local LLM / backend beyond the built-in three was a CROSS-CODEBASE
FORK, not an extension. `BACKENDS` was a frozen 3-tuple; `backendForLabel` was a
hardcoded if-chain; those three literals were branched at ~42 non-spec files
(`core/src/pipelines/lineageCost.ts` `sourceForBackend`,
`core/src/readmodels/projections.ts` `localTokens`, the `core/src/collector/**`
normalize/ingest sites, `core/src/kernel/sessionKernel.ts`,
`core/src/kernel/pty/ptyHost.ts`, …); and EVERY schema migration hardcoded a
CHECK constraint pinning `backend` to the three literals (0001 lines 48/74,
0002 line 63, 0006 line 36). This is the BACKEND twin of the account-label
problem ICR-0013 solved for accounts — this ICR applies the SAME pattern to
backends so the honest answer to "is it easy to add a new backend?" becomes YES.

## Change (validation-widening, additive; the pairing invariants preserved)

Introduce a **`BackendDescriptor`** interface + a **registry**, mirroring how
ICR-0013 kept `ACCOUNT_LABELS` as a seed while the FORM became the ceiling:

1. **`BackendDescriptor`** (`vocab.ts`): `id` (the wire/DB backend literal),
   `servesLabel(label): boolean` (the account-label form this backend serves —
   the backend side of the label↔backend pairing), `sourceName` (the events
   `source` a step on this backend feeds), `substrates` (its legal `sdk`/`pty`
   set — the pty-is-claude-only rule generalized), `builtin`, and OPTIONAL
   `adapterFactoryKey` / `healthProbeKey` (stable keys the core composition root
   maps to the concrete adapter/probe — the protocol package stays
   dependency-free and holds no live adapter).
2. **Registry**: `registerBackend` / `unregisterBackend` / `backendById` /
   `allBackends` / `allBackendIds`, pre-populated with the three built-ins as
   descriptors (`BUILTIN_BACKEND_DESCRIPTORS`). `registerBackend` refuses a
   built-in id, a conflicting id, a `servesLabel` that overlaps ANY built-in
   label form (so a descriptor cannot hijack `MAX_<X>`/`ENT`/`AWS_DEV`/`LOCAL`),
   an unknown substrate, and a malformed descriptor — a REAL gate.
3. **Resolution moves onto the registry** (byte-identical for the three
   built-ins): `isBackend(v)` tests registry membership; `backendForLabel(label)`
   resolves built-in labels FIRST (verbatim) then a registered descriptor's
   `servesLabel`; `isAccountLabel` admits a label served by a registered backend;
   `sourceForBackend(backend)` reads the descriptor's `sourceName` (REPLACES the
   hardcoded `lineageCost.ts` if-chain); `substrateLegalFor(substrate, backend)`
   reads the descriptor's `substrates` (the registry form of pty-is-claude-only).
4. `BACKENDS` stays a KNOWN/SEED list; the `Backend` TYPE stays the seed union
   (compile-time exhaustiveness at the built-in call sites) and `BackendId` is
   the widened `string` alias for registry-driven code.

- **Schema**: a SQLite CHECK is static SQL and CANNOT query the runtime registry.
  Decision (b) in the OS-1 contract (app-layer validated insert): migrations
  **0007** (kernel: `account_profiles`, `resume_ledger`, `session_node` [the
  inbound-FK table-rebuild recipe from 0005]) and **0008** (events: `events`)
  relax `backend`/`source` to `length(...) > 0` and relax the account + pairing +
  pty CHECKs to "the built-in clauses hold for the built-in backends, OR the
  backend is NOT one of the three built-ins (defer to the app layer)". The
  accessor's `isBackend`/`backendForLabel`/`substrateLegalFor` (now
  registry-driven) is the authoritative gate; the built-in clauses stay
  CHECK-enforced (defense-in-depth, byte-identical). The account CHECK also
  relaxes because a registered backend serves labels outside the built-in form
  — the M7 open MAX_<X> form is a strict SUBSET of what the relaxed CHECK admits.
  Table-rebuild via `defer_foreign_keys` + rename-old-aside for the one inbound-FK
  table. Frozen migrations 0001–0006 stay byte-identical; changes ride 0007/0008.
  See sqlite-ddl.md §10.8.
- **Schema follow-up — migration 0009 (`step_attempt` amendment).** 0007's
  comment SKIPPED `step_attempt` reasoning "no backend column", overlooking that
  its `account` CHECK (open M7 form from 0005) still admitted ONLY the built-in
  account-label forms — so a full pipeline RUN on a registered 4th backend's
  account (e.g. `SYNTH_L`) was refused at the FIRST journal write
  (`step_attempt.record` → `CHECK constraint failed: account IS NULL ...`), even
  though `resolveBackend` routed the label through the registry with no core
  branch and 0007/0008 already accepted it in the lineage/events stores.
  Migration **0009** (kernel DB, `KERNEL_MIGRATIONS`) rebuilds `step_attempt`
  (no inbound FK; outbound FK + indexes preserved) with only its nullable
  `account` CHECK widened exactly as 0008 widened `events.account` — but keyed on
  the LABEL FORM (no backend column here): `account IS NULL OR (built-in open
  MAX_<X> form) OR (length(account) > 0 AND NOT built-in form)`. The M7 form is a
  strict SUBSET (every M1–M8 row validates byte-identically); the registry-aware
  `isAccountLabel()` at `stepAttempts.record`/`complete` is the authoritative
  value gate; the DB keeps NULL + built-in-form as defense-in-depth (EMPTY still
  refused). Bumps kernel `ddl_version=9` (milestone stays M8). Frozen migrations
  0001–0008 untouched. With 0009 landed the core `backendRegistryRoute.spec`
  full-engine-run-on-SYNTH_L test flips from asserting the schema REFUSAL to
  asserting COMPLETION — NO core edit. See sqlite-ddl.md §10.9.

## Compatibility

- Additive / validation-widening: every M1–M7 backend id, account label, source,
  and pairing is still valid; NO wire SHAPE changed (only which `backend`/
  `account`/`source` VALUES validate). Every prior golden fixture replays
  byte-identically. The corpus gains the UNREGISTERED (`ollama`) + garbage
  (`CLAUDE_CODE`) rejection fixtures (pure replay) proving the registry is a real
  gate, plus the register→replay→unregister `SYNTHETIC_BACKEND_WS_FIXTURE`
  (valid only once its descriptor is registered) proving a 4th backend routes
  end-to-end with no branch edit.
- The registry is a REAL gate, not anything-goes: an unregistered/garbage backend
  id is REJECTED at the wire validator, the schema accessor + CHECK, and the
  events accessor. The [X2] identifier-audit invariant is untouched (backend ids
  are generic identifiers, never secrets; no gitleaks rule changed).
- Out-of-`packages/` consumers (the build lanes' job — the ~42 branch sites,
  classified in the BE-ORCH return): `core/**` still imports `Backend`/`isBackend`
  (unchanged signatures) but should swap the literal `backend === 'lmstudio'` /
  `sourceForBackend` if-chains for the registry (`backendById` / `sourceForBackend`
  / `allBackends`); `app/**`'s launch picker + channel panels + observability chips
  should enumerate `allBackends()` instead of the hardcoded three; the FE launch
  `wire.spec.ts` freeze-literal assertion (`FROZEN-M7` → `FROZEN-M8`) advances in
  the consuming FE lane's commit (the M3/M4/M5/M6/M7 precedent).
- Reversal path: restore the closed `BACKENDS`-membership `isBackend` + the
  hardcoded `backendForLabel`/`sourceForBackend` chains, revert 0007/0008 (a
  re-tightening migration), and re-pin the version to `1.5.0`/`FROZEN-M7`.
  Nothing outside the listed surfaces depends on the widening.

## Sign-off

- Owning orchestrator (BE-ORCH): **RATIFIED 2026-07-05** — landed by the OS-1
  backend-registry contract change; protocol (253→276), schema (98→100), testkit
  (95→96) suites + typechecks green (see the BE-ORCH return); the label↔backend
  + pty pairing invariants and the [X2] identifier-audit invariant preserved;
  migrations proven on a seeded-with-FK-data DB (a registered 4th backend lands
  end-to-end; unregistered/empty/mispaired still rejected).
- Counterpart orchestrator (FE-ORCH): **CO-SIGNED 2026-07-05** — verified at the
  OS-1 gate review. The FE consumes the frozen backend REGISTRY correctly: the
  two closed `Record<Backend, string>` engraved-label maps (ObservabilityDeck +
  ResourceHealthInstrument) were replaced by the FE-owned registry-driven seam
  `backendLabel()` (app/src/lib/backendLabels.ts) — the built-in three render
  BYTE-IDENTICALLY (`claude_code`→`CLAUDE` etc.) and a registered 4th backend
  derives its engraved label from its id (never blank/`undefined`). The launch
  `wire.spec.ts` freeze assertion advanced `FROZEN-M7`→`FROZEN-M8` and was
  STRENGTHENED to `GOLDEN_WS_CORPUS_FREEZE === PROTOCOL_FREEZE` (the single
  source of truth, can never drift) — no invariant weakened. `channelHealth.ts`'s
  fixed-backend branches are correctly account-registry-scoped (ICR-0013 surface)
  and left untouched — a 4th backend never becomes a channel-panel entry, with a
  safe NO-SIGNAL fall-through. Proven green (all run at review): the
  `fourthBackendRender.spec.tsx` fixture (register `SYNTHETIC_BACKEND_DESCRIPTOR`,
  route wire snapshots through the REAL stores, assert the deck latency row +
  resource-health session/notice rows render `SYNTHBACKEND` with the [X2] audit
  passing) + `backendLabels.spec.ts` (byte-identical built-ins, no-drift guard,
  4th-backend derivation, [X2] never identity-shaped); app 779/70, testkit 96,
  protocol 253, schema 101, core `backendRegistryRoute` 6; typecheck clean;
  lint:tokens 203 files / 0 violations (no token/layout change → no ADR); gitleaks
  Tier-1 clean. The runtime backend set is enumerable from `allBackends()`; no new
  bootstrap carrier is needed (the built-in three are always present; a 4th
  arrives via a descriptor the composition root registers at boot).
