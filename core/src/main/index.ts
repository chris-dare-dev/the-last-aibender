/**
 * aibender-core — composition root (core/src/main/, owner BE-ORCH).
 *
 * M0 PLACEHOLDER: prints the daemon name and exits. No broker logic lands here
 * until BE-1 (M1). The real composition root will wire, in startup order:
 * config → schema migrations → kernel → gateway → adapters → collector →
 * workstreams → pipelines (plan §2/§4), and own shutdown ordering.
 *
 * Sibling directories (kernel/ supervision/ gateway/ adapters/ collector/
 * readmodels/ workstreams/ pipelines/) are created by their owning BE lanes —
 * deliberately absent from the M0 skeleton.
 */

import { pathToFileURL } from 'node:url';

export const DAEMON_NAME = 'aibender-core' as const;

/**
 * Placeholder entry point. Writes one line naming the daemon and returns the
 * process exit code (0). Output goes through `out` so tests can capture it.
 */
export function main(out: (line: string) => void = console.log): number {
  out(`${DAEMON_NAME}: broker daemon placeholder (M0 scaffold) — no logic yet, exiting 0.`);
  return 0;
}

// Executed directly (`pnpm --filter aibender-core start`)? Run and exit.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = main();
}
