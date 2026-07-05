# Backend-registry generalization (OS-1) — Stage-3 change record ([X1] scalability)

**Status:** record (Stage 3 hardening, 2026-07-05) · **Audience:** engineers +
owner
**Sources of record:** ICR-0016
([../contracts/icr/icr-0016-backend-registry.md](../contracts/icr/icr-0016-backend-registry.md));
`docs/contracts/ws-protocol.md` §4.1 (backend vocabulary),
`docs/contracts/sqlite-ddl.md` §10.8 (backend-CHECK-derivation decision);
the finding [docs/reviews/optimization-scalability.md](../reviews/optimization-scalability.md)
OS-1. Operator procedure: [add-a-backend.md](add-a-backend.md). Companion:
[account-registry.md](account-registry.md) is the [X1] **account** twin of this
same generalization (ICR-0013) — this record mirrors its shape.

This record documents WHAT changed and WHY, states the descriptor/registry
model, cites the end-to-end proof that a synthetic 4th backend routes with no
branch edit, and captures the co-sign. The ICR is the amendment contract;
`add-a-backend.md` is the minimal operator procedure.

---

## The motivation (finding OS-1, HIGH, gate-verified)

The Stage-3 optimization/scalability review asked the [X1] framing question:
*is it easy to add a new local LLM / backend beyond the built-in three?* The
honest answer was **no**. `BACKENDS` was a **frozen 3-tuple**
(`vocab.ts`: `claude_code`, `opencode`, `lmstudio`), `backendForLabel` was a
hardcoded if-chain, those three literals were branched at **~42 non-spec
files** (e.g. `core/src/pipelines/lineageCost.ts` `sourceForBackend`,
`core/src/readmodels/projections.ts` local-offload `localTokens`, the
`core/src/collector/**` ingest/normalize sites, `core/src/kernel/sessionKernel.ts`,
`core/src/kernel/pty/ptyHost.ts`), and **every** schema migration hardcoded a
`CHECK (backend IN ('claude_code','opencode','lmstudio'))` plus the
label↔backend pairing and the `substrate != 'pty' OR backend = 'claude_code'`
clauses. Adding a fourth backend was a **cross-codebase fork**, not an
extension. This is the BACKEND twin of the account-label problem ICR-0013 solved
for accounts; OS-1 applies the SAME pattern to backends. Now adding a backend is
**one descriptor + one `registerBackend` call + an adapter + a health probe** —
no `vocab.ts` literal edit, no ~42-site branch fork, and **no migration**.

## The design — a descriptor + a registry

Everything the cross-codebase dispatch needs to route a backend now lives in one
`BackendDescriptor` (`packages/protocol/src/vocab.ts`):

| Field | What it is |
|---|---|
| `id` | the wire/DB backend literal (`session_node.backend`, `events.backend`); unique in the registry |
| `servesLabel(label)` | the account-label predicate this backend serves — the backend side of the label↔backend pairing |
| `sourceName` | the events-store `source` a step on this backend feeds (resolves `sourceForBackend`) |
| `substrates` | the legal execution substrates (`'sdk'` and/or `'pty'`; pty is Claude-only) |
| `builtin` | `true` only for the three seed backends (they carry the authoritative built-in label forms and may not be re-registered / removed) |
| `adapterFactoryKey?` / `healthProbeKey?` | OPTIONAL stable keys the **core composition root** maps to the concrete adapter/probe (the protocol package stays dependency-free and holds no live adapter) |

The registry API (`vocab.ts`):

- `registerBackend(descriptor)` — the ONE seam a new-backend author touches;
  refuses a built-in id, a conflicting id, an overlapping `servesLabel`, an
  unknown substrate, or a malformed descriptor (a **real gate**, throws
  `BackendRegistrationError`);
- `backendById(id)` / `allBackends()` / `allBackendIds()` — deterministic
  enumeration (built-ins first, then registered additions in registration
  order) for the FE chips, diagnostics;
- `unregisterBackend(id)` — test/teardown hygiene; never for a built-in.

The three built-ins (`claude_code`, `opencode`, `lmstudio`) are pre-seeded as
`BUILTIN_BACKEND_DESCRIPTORS` reproducing the pre-OS-1 behaviour **exactly**:
`claude_code` serves the open Claude-account form (`MAX_<X>` + `ENT`), feeds
`claude-otel`, and is the only pty-eligible backend; `opencode` serves `AWS_DEV`,
feeds `opencode-sse`, sdk-only; `lmstudio` serves `LOCAL`, feeds `lmstudio`,
sdk-only. `BACKENDS` stays a KNOWN/SEED array (back-compat, seeding, tests) but
is **no longer the validation ceiling** — mirroring how ICR-0013 kept
`ACCOUNT_LABELS` a seed.

### Dispatch resolves through the registry (no literal branches)

- `isBackend(v)` tests **registry membership** (was: `BACKENDS`-array membership).
- `backendForLabel(label)` resolves built-in labels FIRST and verbatim (so a
  descriptor can never shadow a built-in), then a registered descriptor's
  `servesLabel`.
- `isAccountLabel(v)` admits the built-in forms OR a label a registered backend
  serves.
- `sourceForBackend(backend)` returns the descriptor's `sourceName` — the
  former if-chain in `core/src/pipelines/lineageCost.ts` was **deleted** in
  favour of this registry call.
- `substrateLegalFor(substrate, backend)` is the registry form of the
  pty-is-Claude-only rule (fail-closed for an unregistered backend).
- `core/src/readmodels/projections.ts` local-offload classifies a row as LOCAL
  by comparing the backend's descriptor `sourceName` to the built-in `lmstudio`
  source (`backendById('lmstudio')?.sourceName`), **not** `row.backend ===
  'lmstudio'` — so a registered 4th local backend counts with no edit.
- `app/src/lib/backendLabels.ts` (`backendLabel`) derives the FE engraved label
  from the registry, byte-identical for the built-ins (`CLAUDE`/`OPENCODE`/
  `LMSTUDIO`) and derived-from-id for a fourth (`SYNTHBACKEND`), never blank.

### The schema CHECK moved to the app layer (no migration per backend)

A SQLite `CHECK` is static SQL and cannot query the runtime registry, so the
`backend`-VALUE set moved to the **app layer** (the M3-events open-vocabulary
precedent, where `event_type`/`model`/`provider` are un-CHECK'd and the accessor
screens them). Three new migrations relax the pinned CHECKs while keeping every
built-in invariant CHECK-enforced (defense-in-depth):

- **0007** (kernel DB) — `account_profiles`, `resume_ledger`, `session_node`:
  `backend` → `length(backend) > 0`; the pairing + pty clauses become "the
  built-in triples hold for the built-in backends, OR the backend is not a
  built-in (defer to the accessor)". The account-label CHECK (the M7 open
  `MAX_<X>` form) is preserved and widened to also admit a non-empty label
  paired with a non-built-in backend.
- **0008** (events DB) — `events`: same relaxation for `backend`, `source`
  (`length(source) > 0`; the app-layer `isEventSource` gate stays the closed
  source vocabulary), the account CHECK, and the pairing.
- **0009** (kernel DB) — `step_attempt`: the ONE table 0007 explicitly SKIPPED
  on the "no backend column" reasoning. It carries an `account` column whose M7
  CHECK still pinned the built-in forms, so a full pipeline RUN on a 4th-backend
  account was refused at the FIRST journal write. 0009 relaxes that account
  CHECK exactly as 0008 relaxed `events.account` — keyed on the label FORM,
  since the table has no backend column — closing the gap.

The built-in clauses stay CHECK-enforced verbatim (a bypassing raw-SQL writer
still cannot land an illegal *built-in* row, and an EMPTY `backend` is still
refused), and the M7 open account form is a strict SUBSET of what the relaxed
CHECK admits, so every M1–M8 row still validates.

## What behaviour is preserved (byte-identical for the three built-ins)

- Same wire SHAPE — no protocol frame changed; the launch/control payloads are
  identical. The bump is validation-widening: `1.5.0` → `1.6.0`, `FROZEN-M7` →
  `FROZEN-M8`.
- Same ids, same label↔backend pairing, same events `source` per backend, same
  substrate rules. `backendLabel('claude_code')` still reads `CLAUDE`.
- Every prior golden fixture replays byte-identically (both sides). The corpus
  gained the two unregistered/garbage-backend REJECTION fixtures (pure replay)
  and the register→replay→unregister `SYNTHETIC_BACKEND_WS_FIXTURE`.

## The end-to-end proof (a synthetic 4th backend, no branch edit)

A synthetic non-built-in descriptor — `SYNTHETIC_BACKEND_DESCRIPTOR` in
`@aibender/testkit` (id `synthbackend`, serves `SYNTH_L`, feeds the local
`lmstudio` source, sdk-only) — is introduced by ONE `registerBackend` call and
rides every dispatch seam:

| DoD item | Proof (cite) |
|---|---|
| Registry rejects an unregistered/garbage backend (protocol) | `packages/testkit/src/wsGolden.ts` fixtures `control-launch-unregistered-backend` + `control-launch-garbage-backend` (pure-corpus replay to `bad-request`), asserted by `packages/testkit/src/wsGolden.spec.ts` |
| Registry rejects (schema) | `packages/schema/src/kernel.spec.ts` "admits a REGISTERED 4th backend end-to-end + still rejects an unregistered one"; "the DDL backend CHECK still refuses an EMPTY backend"; `packages/schema/src/events.spec.ts` unregistered insert throws; `packages/schema/src/pipelines.spec.ts` "the app-layer registry gate is the REAL screen" |
| 4th backend routes vocab → pipeline cost → read-model with no branch edit | `core/src/pipelines/backendRegistryRoute.spec.ts` (vocab resolution; `landCost` events row keyed to `synthbackend` with descriptor source; full engine run COMPLETES on `SYNTH_L`; local-offload counts it LOCAL) |
| Schema round-trip (kernel + events + step_attempt) admits it | `packages/schema/src/{kernel,events,pipelines}.spec.ts` (migrations 0007/0008/0009) |
| Golden register→route→unregister (no leak) | `packages/testkit/src/wsGolden.spec.ts` "a synthetic 4th backend is REFUSED unregistered and VALID once registered" |
| FE renders the 4th backend with the [X2] audit intact | `app/src/features/observability/fourthBackendRender.spec.tsx` (deck latency row + resource-health session/notice rows render the derived label, `assertSynthesizedSafeText` passes); `app/src/lib/backendLabels.spec.ts` (built-ins byte-identical; derived label; never identity-shaped) |
| Operator procedure | [add-a-backend.md](add-a-backend.md) |

## [X2] discipline

A backend `id` is a **generic identifier**, never a secret, account, endpoint,
token, or AWS account id (`ollama`, `vllm`, `synthbackend` are fine
placeholders). `registerBackend` and the [X2] policy forbid identity-bearing
ids; the FE derived label is a mechanical uppercasing of a registered generic id
and can never be identity-shaped; the pre-commit two-tier gitleaks gate enforces
it, never bypassed. Full-tree gitleaks (both tiers) is clean except the known 12
`.git/logs` reflog echoes.

## Scope boundaries (honest residuals)

- **`sourceName` is not free.** The events-store `source` vocabulary
  (`EVENT_SOURCES`) stays a **closed** registry gated by `isEventSource`
  (deliberately not widened). A descriptor's `sourceName` MUST be an existing
  `EVENT_SOURCES` literal (a local-LLM backend reuses `'lmstudio'`); introducing
  a genuinely NEW source value is its own events-vocabulary ICR. Documented in
  `add-a-backend.md` and its troubleshooting table.
- **Remaining `=== 'claude_code'` sites are correct anchors, not forks.** The
  OTel/JSONL `ApiRequestJoiner` (`core/src/collector/ingest.ts`) and the pty
  paths (`sessionKernel.ts`, `ptyHost.ts`) are **Claude-only by blueprint §4.1**;
  a 4th backend does not feed them (it feeds its own source inline). The
  `backendForLabel(x) !== 'claude_code'` guards resolve THROUGH the registry and
  are semantic filters, not extension-blocking dispatch.
- **The M2 cockpit channel-health detail text** (`app/src/lib/stores/channelHealth.ts`)
  produces backend-specific liveness strings for `opencode`/`lmstudio` and
  degrades a 4th-backend account panel to a graceful `NO SIGNAL` (never blank,
  never a crash). The finding's named FE surfaces (observability deck +
  resource-health instrument) render the 4th backend from the registry; a
  backend-specific liveness string for a fourth is a cosmetic follow-up, not an
  extension cliff.
- **OS-2 and OS-6 remain OPEN** (dashboard-projection SQL aggregation; the
  ApiRequestJoiner pending-map bound) — separate future work.

## Co-sign

- **BE-ORCH RATIFIED 2026-07-05.** BE-ORCH owns `packages/*`: the
  `BackendDescriptor` type + registry, `sourceForBackend`/`substrateLegalFor`,
  and the schema CHECK derivation (migrations 0007/0008/0009).
- **FE-ORCH co-signed 2026-07-05.** The FE launch picker + observability/
  resource-health panels enumerate `allBackends()`; the launch freeze literal
  (`app/src/features/launch/wire.spec.ts`) advanced from `FROZEN-M7` to
  `=== PROTOCOL_FREEZE` (now `FROZEN-M8`) — the ICR-0013→ICR-0014 shape. The
  fourth-backend render proof (`fourthBackendRender.spec.tsx`) and the
  byte-identical built-in labels (`backendLabels.spec.ts`) are green.
