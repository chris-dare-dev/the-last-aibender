/**
 * Serve-process argv matching (BE-4; blueprint §4.2 "Match on argv `serve`,
 * never on process name — the desktop app is unrelated").
 *
 * The OpenCode desktop app is a separate Electron process tree whose
 * executable names contain "opencode"/"OpenCode" — a name-based scan would
 * conflate them (opencode-serve-event-probe §7). The ONLY sanctioned match is:
 * argv[0] resolves to an `opencode` binary AND the first subcommand token is
 * literally `serve`.
 */

/** One process row as produced by whatever process scanner feeds the check. */
export interface ProcessArgvRow {
  readonly pid: number;
  /** Full argv, argv[0] = executable path or name. */
  readonly argv: readonly string[];
}

/** Basename without requiring node:path (argv values may be non-paths). */
function basenameOf(value: string): string {
  const idx = value.lastIndexOf('/');
  return idx === -1 ? value : value.slice(idx + 1);
}

/**
 * True only for a real `opencode serve` invocation:
 *   - argv[0] basename is exactly `opencode` (case-sensitive — the CLI binary;
 *     the desktop app's executables are `OpenCode`/`OpenCode Helper …`);
 *   - the first non-flag argument after argv[0] is exactly `serve`.
 *
 * Never matches on process NAME, window title, or substring containment.
 */
export function matchesOpencodeServeArgv(argv: readonly string[]): boolean {
  const executable = argv[0];
  if (executable === undefined) return false;
  if (basenameOf(executable) !== 'opencode') return false;
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) return false;
    if (token.startsWith('-')) {
      // Flags before the subcommand (e.g. --print-logs) are tolerated; flag
      // VALUES are not consumed here — `serve` must appear as its own token
      // before any non-flag token.
      continue;
    }
    return token === 'serve';
  }
  return false;
}

/** Filter a process scan down to genuine serve children. */
export function findServeProcesses(rows: readonly ProcessArgvRow[]): ProcessArgvRow[] {
  return rows.filter((row) => matchesOpencodeServeArgv(row.argv));
}
