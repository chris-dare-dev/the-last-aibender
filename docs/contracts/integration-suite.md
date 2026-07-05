# Cross-department integration suite — contract of record (M6)

> **Frozen at M6** (2026-07-05), owner BE-ORCH (FE-ORCH + SI-ORCH co-sign the
> seams they own). This is the **contract-of-record note** for plan §9.3
> (cross-department integration tests) and §9.4 (what is deliberately NOT
> CI-automated). It is prose, not a new wire type: no protocol/schema surface
> is added here. Where a specific seam has a machine-checkable device (the
> golden corpus, an architectural import test, a fs-audit), this note points at
> it; where a seam is inherently live-host (T3), it points at the runner that
> executes it at the gate.

---

## 0. Why this exists

The blueprint builds three departments against shared contracts
(`packages/protocol`, `packages/schema`) so 2–4 agents per department can build
in parallel with zero file conflicts. The risk that survives that discipline is
**seam drift**: two departments each pass their own unit suites while disagreeing
about the surface between them. Plan §9.3 answers this with cross-department
integration suites executed at every milestone gate from M2 onward; §9.4 records
which seams are physically impossible to run in hosted CI and therefore live in
the T3 live-check runner. M6 (the hardened-v0 ship) is where those two lists
become a contract, so the ship gate can assert them.

The three seams (plan §9.3):

- **BE ↔ FE** — the WS contract boundary.
- **BE ↔ SI** — broker launched by SI's launchd/hooks/AWS/colima wiring.
- **SI ↔ FE** — packaging, bootstrap discovery, freshness surfaces, design tokens.

---

## 1. Where the integration suite lives (M6 expectation)

A top-level **INTEG** home exercises the synthetic-provable slices of all three
seams end-to-end. "Synthetic-provable" = runnable in hosted CI against
`packages/testkit` fakes + real SQLite, with **no** real Keychain / `claude`
binary / launchd / GPU / AWS. Everything else is T3 (§4 below).

**Invocation (T4/gate device, not every-commit).** Per plan §9.1, soak/perf is
a *gate* tier (M2/M4/M6), not folded into the every-commit unit run. The INTEG
suite's BE↔FE #2 slice drives the real `soak:m2` harness (6 real node-pty
children + a ~24 MB pump with a 120 s internal drain timeout), so it is run via
the dedicated **`pnpm test:integration`** script (→ `pnpm -F @aibender/integration
test:integration`) — a serial, isolated step — and is deliberately **excluded**
from `pnpm -r test` and the default root `vitest.workspace.ts`. Folding it into
the parallel workspace sweep starves the soak's drain timeout under CPU
contention and produces a false-red. CI runs it as its own `linux-tests` step;
the milestone gate runs it standalone.

Two devices already carry most of the synthetic-provable weight and are the
**contract of record** for the seams they cover — the INTEG package composes and
extends them rather than re-inventing:

| Seam slice | Device (already frozen) | Location |
|---|---|---|
| BE↔FE #1 — golden protocol replay both sides | `GOLDEN_WS_FIXTURES` (`GOLDEN_WS_CORPUS_FREEZE = PROTOCOL_FREEZE`) | `packages/testkit/src/wsGolden.ts` (replayed in BE gateway specs + FE `app/src/lib/ws/goldenCorpus.spec.ts`) |
| BE↔SI #3/#4 — hook POST + statusline shapes BE-5 ingests | `GOLDEN_HOOK_FIXTURES` (`GOLDEN_HOOK_CORPUS_FREEZE = PROTOCOL_FREEZE`) + statusline/OTLP fixture builders | `packages/testkit/src/hooksGolden.ts`, `statuslineFeed.ts`, `otlpEmitter.ts` |
| BE↔FE #3 — dashboard truth (golden store → read models → gauges) | events-store fixtures → BE-6 publisher → §13 read-model snapshots → FE deck | `core/src/readmodels/publisher.spec.ts` + `app/src/features/observability/golden.spec.tsx` |
| BE↔FE composed round-trip | `composeBroker` launch→pty→approval→transcript over one socket | `core/src/main/composedBroker.spec.ts` |
| [X3] non-dependency | architectural test: `core/` imports nothing from `infra/` | BE arch test (see §3) |
| [X4] native-store immutability | fs-audit: reconciler/adapters have no write path to native stores | BE-7 fs-audit spec |

The **freeze device that ties BE and FE together is a single constant**:
`GOLDEN_WS_CORPUS_FREEZE` and `GOLDEN_HOOK_CORPUS_FREEZE` are both typed
`typeof PROTOCOL_FREEZE` and asserted equal to it in their suites. When a freeze
bumps `PROTOCOL_FREEZE`, both departments' golden-corpus suites replay against
the new bytes; a mismatch is a hard test failure, not a silent divergence. This
IS the anti-drift mechanism for BE↔FE #1.

---

## 2. The synthetic-provable slices (run at every gate from M2, hosted-CI-safe)

Enumerated from plan §9.3; each names the fixture/device that proves it. A gate
runs these; a red one blocks the milestone.

**Backend ↔ Frontend (the WS contract boundary)**

1. Golden protocol fixtures replayed against BOTH the FE client and BE gateway;
   a fixture change requires both orchestrators' sign-off (`GOLDEN_WS_FIXTURES`).
2. PTY round-trip echo p95 <100 ms locally + 6-PTY flow-control soak with one
   slow consumer — bounded memory, no interleaving corruption (`soak:m2`).
3. Dashboard truth: golden SQLite store → read models → rendered gauges equal
   SQL-computed values exactly (publisher spec + FE deck golden spec).
4. Approval round-trip: `canUseTool` → inbox → decision → session proceeds;
   workflow `approval` gate pause/resume via the same inbox
   (`m2ApprovalRoundTrip.spec.ts`).
5. Reconnect: kill WS mid-stream → FE resumes from watermarks with no
   duplicated/lost rows; context-graph converges to identical state after replay.

**Backend ↔ Server-side (synthetic slices; the live ones are §4)**

3s. A hook POST shaped by SI-3's templates is accepted by BE-5's hooks endpoint
    and normalized into `events` (`GOLDEN_HOOK_FIXTURES` replay).
4s. SI-3 OTel env → BE-5 OTLP receiver rows carry `account=<LABEL>` attribution
    (OTLP fixture emitter).
7. Seeded-canary branch proves gitleaks blocks agent-authored leaks (fake
   literals only — `.gitleaks.toml` Tier-1, exercised in CI + the seeded-failure
   check).

**Server-side ↔ Frontend (synthetic slices)**

3. DESIGN.md → theme build chain: an off-token style fails `lint:tokens` before
   reaching the app (FE-1 token lint).
4. Freshness surfaces: LM-Studio-down / cluster-absent / SSO-expired each render
   the NO SIGNAL instrument, never an error toast (FE observability freshness
   spec, driven by `SOURCE_FRESHNESS_STATES`).

**M6 addition — the supervision instrument seam (BE↔FE).** `resource-health`
(ws-protocol §13.4) is a synthetic-provable BE↔FE slice: a governor-shaped
`read-model-snapshot` (golden fixtures `events-readmodel-resource-health-*`)
round-trips through the FE resource/pressure instrument exactly as the §6.3 leads
do. The fake-process watchdog harness (plan M6 DoD) produces the numbers; the
wire carries STATES; the FE renders them. No live bloat of a real session is ever
required to exercise the seam (blueprint §3 rule: the watchdog is tested with a
fake-process harness).

---

## 3. Architectural (import-graph) invariants — CI-cheap, always on

These are not "integration tests" in the fixture sense but they police the same
seams and cost nothing, so the gate runs them every time:

- **[X3]** `core/` imports nothing from `infra/` — k3s/colima is never a launch
  dependency (BE architectural test).
- **[X4]** native stores are never mutated — reconciler + adapters have no write
  path; proven by fs-audit + the absence of a write import (BE-7).
- **[X2]** no identity-bearing value in any committed file or stored row —
  gitleaks Tier-1 in CI, the testkit `assertSynthesizedSafeText` guard on every
  golden frame, and the events-store ingest audit (nothing identity-bearing
  enters the store).

---

## 4. What is deliberately NOT CI-automated (plan §9.4) — the T3 live list

These seams are physically unobservable in hosted CI (no Keychain, no real
`claude` binary, no Aqua launchd, no GPU, no AWS). They are **enumerated in
`infra/ci/live-check.sh`** and run at milestone gates + after any
SDK/colima/macOS upgrade (the version-gate and upgrade-gate runbooks make these
mandatory, not best-effort):

| # | Live seam | Runner entry |
|---|---|---|
| L1 | Broker via SI-3 Aqua LaunchAgent reads keychain values for all 3 accounts (`auth status --json`); Background-domain variant fails as documented | live-check keychain / launchd |
| L2 | BE-1 spawn using SI-2 dirs → expected per-config-dir keychain service names; version gate detects simulated drift | live-check version-gate |
| L3 | Real session with SI-3 hook templates → statusline quota files + http-hook POSTs BE-5 ingests | live-check hooks |
| L4 | LM Studio via `lms` LaunchAgent: up → healthy, stopped → down-state; **Colima stopped entirely → LM Studio unaffected** ([X3] non-dependency proof) | live-check lmstudio + colima |
| L5 | SI-4-applied inference-profile ARN (post owner-gate) → OpenCode step cost non-zero client-side, reconciles with Cost Explorer backfill | live-check aws (post-apply) |
| L6 | Tauri cold-start boots the sidecar + discovers port/token via the bootstrap-file contract on a clean user account | live-check packaging |
| L7 | Login-bootstrap UX: fresh SI-2 profile → attended PTY login → account panel flips authenticated (semi-manual) | live-check login |
| L8 | Signed (dry-run) Tauri v0 sidecar build launches on a clean macOS user account; LaunchAgent-v1 plist validated Aqua-side but NOT flipped | live-check packaging |
| L9 | 24 h mixed soak (3 account + 2 OpenCode + local model JIT) within the ~17 GB pessimistic envelope, no unsupervised growth — **inherently owner/T4**; the mechanism is proven by an accelerated/scaled synthetic soak + a runbook for the real one (blueprint §11; plan M6 DoD) | live-check soak (accelerated) + runbook |

`infra/ci/live-check.sh` is the enumerated home of record for §9.4; it supports
`--list` and `--milestone M1|M2|M3|M4|M6`, reports PASS/FAIL/SKIP per check with
a runbook pointer on SKIP, and is runnable offline today (unenabled prerequisites
SKIP, never FAIL). The M1–M4 checks + the M6 `signing-dryrun` entry are landed;
the remaining M6 entries (the accelerated soak L9, packaging cold-start L6/L8) are
appended by the SI-6/BE-9 M6 work as those land — this note freezes the
EXPECTATION that every §9.4 seam is enumerated there, and the gate asserts the
registry is not silently shrunk (an entry deleted without an ADR is a gate
failure). The 24 h soak (L9) is honestly a T4/pending-owner item — the harness
proves the watchdog/sacrifice mechanism via a fake-process harness and an
accelerated soak, and runbooks the real 24 h run; it does NOT claim a real 24 h
soak executed in CI.

---

## 5. Amendment record

| Date | Change |
|---|---|
| 2026-07-05 | **M6 freeze.** Created the §9.3/§9.4 contract-of-record note: named the two golden-corpus devices as the frozen BE↔FE / BE↔SI anti-drift mechanism, enumerated the synthetic-provable slices with their fixture devices, the always-on architectural invariants, and the T3 live list (home = `infra/ci/live-check.sh`). Added the `resource-health` supervision seam (ws-protocol §13.4) as a synthetic-provable BE↔FE slice provable with the fake-process watchdog harness. No wire type added. |
| 2026-07-05 | **M6 gate (BE-ORCH steward).** Recorded the suite's invocation contract (§1): it is a T4/gate device run via the dedicated `pnpm test:integration` script (serial, isolated), and is deliberately excluded from `pnpm -r test` and the default root `vitest.workspace.ts`. Rationale: the BE↔FE #2 soak-driving slice starves its 120 s internal drain timeout under the parallel workspace sweep's CPU contention (observed false-red under `pnpm -r test`; standalone runs green in ~2.5 s across repeats). The integration package's runnable script was renamed `test`→`test:integration` so `-r test` no longer sweeps it; CI's `linux-tests` job gained a serial `Integration suite` step. SI-ORCH co-owns `.github/workflows/` — this is a test-orchestration wiring change, not a pipeline redesign; SI-ORCH review noted. No wire/schema/contract-surface change. |
