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
export default defineWorkspace(['packages/*', 'core', 'app']);
