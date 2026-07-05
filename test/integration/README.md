# `@aibender/integration` — cross-department integration suite (plan §9.3 / §9.4)

The "Testing between departments" Stage-2 requirement (plan §9.3), plus the
enumeration of what is deliberately **not** CI-automated (plan §9.4). This suite
**assembles** the BE/FE/SI seams end-to-end from the **already-frozen** devices
(golden corpora, `composeBroker`, the read-model publisher, the architectural
import tests, the `soak:m2` harness, the `live-check.sh` registry). It never
re-implements logic a single package already unit-tests — it proves the seams
**between** departments agree.

Run it:

```
pnpm test:integration                              # from the repo root
pnpm -F @aibender/integration test:integration     # equivalent, from anywhere
```

This suite is a **T4/gate device** (plan §9.1: soak/perf runs at the M2/M4/M6
gates, not every commit). Its BE↔FE #2 slice drives the real `soak:m2` harness
(6 real node-pty children + a 24 MB pump with a 120 s internal drain timeout),
so it is **deliberately NOT** part of `pnpm -r test` or the default root vitest
workspace (`vitest.workspace.ts`) — folding it into the parallel workspace sweep
starves the soak's drain timeout under contention and makes the everyday run
flaky. It runs standalone and reliably via the dedicated `test:integration`
script above; CI invokes that as its own serial step in the `linux-tests` job.
It stays a workspace member for install/typecheck. `environment: 'node'` by
default; the one FE-render seam opts into jsdom per-file
(`// @vitest-environment jsdom`).

The contract-of-record for these seams is
[`docs/contracts/integration-suite.md`](../../docs/contracts/integration-suite.md).

## §9.3 coverage map — synthetic-green here vs T3-enumerated

Each test names the §9.3 row it covers. "Synthetic-green" = runnable in hosted
CI against `packages/testkit` fakes + real SQLite (no Keychain / `claude` /
launchd / GPU / AWS). "T3-enumerated" = the live-host half, enumerated (not run)
in `infra/ci/live-check.sh`, asserted present by the meta-test.

### Backend ↔ Frontend (the WS contract boundary) — `src/be-fe/`
| §9.3 row | File | Status |
|---|---|---|
| #1 golden protocol replayed against BOTH client and gateway, agreeing frame-for-frame | `golden-both-sides.spec.ts` | synthetic-green |
| #2 PTY round-trip + 6-PTY flow-control soak (bounded memory, no interleaving, echo p95 <100 ms) | `pty-flow-control.spec.ts` (drives the real `soak:m2` harness) | synthetic-green |
| #3 dashboard truth: golden store → read models → values == SQL-computed exactly | `dashboard-truth.spec.ts` | synthetic-green |
| #4 approval round-trip: `canUseTool` → inbox → decision AND workflow gate pause/resume via the SAME inbox | `approval-round-trip.spec.ts` (ties M2 + M5) | synthetic-green |
| #5 reconnect: kill WS mid-stream → resume from watermarks, no dup/lost; context-graph converges | `reconnect.spec.ts` | synthetic-green |

### Backend ↔ Server-side — `src/be-si/`
| §9.3 row | File | Status |
|---|---|---|
| #2 SI-2 dirs → BE-1 spawn env → expected keychain SERVICE NAMES (name computation only) | `keychain-service-names.spec.ts` | synthetic-green |
| #3 SI-3 hook templates → BE-5 ingest into `events` | `hooks-otel-ingest.spec.ts` | synthetic-green |
| #4 SI-3 OTel env → BE-5 OTLP rows carry `account=<LABEL>` | `hooks-otel-ingest.spec.ts` | synthetic-green |
| #5 [X3] non-dependency: `core/` imports nothing from `infra/`; LM Studio path has no k3s dep | `x3-non-dependency.spec.ts` (arch test, strengthened to the whole tree) | synthetic-green |
| #1/#2 live keychain reads · #3 real hooks · #5 real LM Studio + Colima stopped · #6 AWS post-apply | — | **T3-enumerated** (`src/t3/`) |

### Server-side ↔ Frontend — `src/si-fe/`
| §9.3 row | File | Status |
|---|---|---|
| #3 DESIGN.md → theme build chain: off-token style fails `lint:tokens` before the app | `design-token-propagation.spec.ts` | synthetic-green |
| #4 freshness surfaces render NO SIGNAL, never a toast | `freshness-no-signal.spec.tsx` | synthetic-green |
| #1 Tauri cold-start sidecar discovery · #2 login-bootstrap UX · #5 signing dry-run launch | — | **T3-enumerated** (`src/t3/`) |

### T3 enumeration meta-test — `src/t3/`
`live-check-enumeration.spec.ts` greps `infra/ci/live-check.sh` and asserts every
genuinely-T3 §9.3 seam (real login, keychain reads, Aqua launchd, real LM Studio,
Colima probe, signed-artifact clean-user launch, the 24 h soak) is **enumerated
with pending-owner status** — so nothing is silently dropped, and no T3 seam is
falsely reported green. Offline, every milestone reports only PASS/SKIP, never
FAIL; the 24 h soak is honestly marked T4/owner.

## What this suite deliberately does NOT do
- It does not duplicate any per-package unit suite; it composes the seams.
- It runs no real accounts, no keychain reads, no launchd flips, no GPU, no AWS,
  no real 24 h soak (all T3/T4 — enumerated, gated to the owner).
- It adds no protocol/schema surface (the contract-of-record note is prose).
