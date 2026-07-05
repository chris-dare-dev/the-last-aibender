import { defineWorkspace } from 'vitest/config';

// Root-level test orchestration (plan §2: vitest 3 workspace): `pnpm test` at
// the repo root runs every project below in one vitest invocation;
// `pnpm -r test` runs each package's own `vitest run` instead — both must pass.
//
// app/ is included: the FE-1 theme/token chain landed with its own suite
// (app/src/chrome/theme/*.spec.ts). Other FE surface remains gated until
// FE-ORCH marks DESIGN.md locked, but tests that exist must run at the root.
//
// Deliberate absences:
//   - spikes/ — quarantined harnesses, never part of the workspace (spikes/README.md).
//   - test/integration/ — the INTEG cross-department suite (@aibender/integration,
//     plan §9.3/§9.4) is a T4/gate device (plan §9.1: soak/perf runs at the
//     M2/M4/M6 gates, not every commit). Its BE↔FE #2 slice drives the real
//     `soak:m2` harness (6 real node-pty children + a 24 MB pump with a 120 s
//     internal drain timeout); folding it into the default parallel workspace
//     sweep starves that timeout under contention and makes the everyday run
//     flaky + slow. It runs standalone and reliably via the dedicated
//     `pnpm test:integration` gate entry point (→ `pnpm -F @aibender/integration
//     test:integration`), which CI invokes as its own serial step. It stays a
//     workspace member for install/typecheck; it is not in `pnpm -r test`.
export default defineWorkspace(['packages/*', 'core', 'app']);
