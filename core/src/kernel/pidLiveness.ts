/**
 * Pid-liveness + argv-nonce probe (BE-1; SPIKE-D finding 2 + scenario vii).
 *
 * The resume ledger records the pid of the ACTUAL session process plus an
 * argv spawn nonce (sqlite-ddl.md §3.3). Before the kernel un-forked-resumes
 * a `running`-state row from a previous broker life, it must prove the child
 * is DEAD — re-driving the same native session while the original child is
 * alive is the blueprint §5 transcript-corruption mode. This probe answers
 * "is the recorded pid still the SAME process the ledger described?":
 *
 *   1. `process.kill(pid, 0)` — existence check, no signal delivered.
 *      ESRCH → dead. EPERM → a process exists but is not ours; fall through
 *      to the nonce check (argv is still readable via ps).
 *   2. argv-nonce identity (SPIKE-D pid-reuse guard): when the ledger carries
 *      a spawn nonce, the live process's argv must contain it. A live pid
 *      WITHOUT the nonce is a pid-reuse stranger — the real child is gone →
 *      dead. When NO nonce was recorded, a live pid answers alive
 *      (conservative: a false "alive" refuses a resume; a false "dead" risks
 *      corruption).
 *
 * Injectable (SessionKernelOptions.pidProbe) so tests never depend on real
 * pid tables; the default implementation probes the real process table.
 */

import { execFileSync } from 'node:child_process';

export interface PidLivenessProbe {
  /**
   * True when `pid` is alive AND — when a spawn nonce is recorded — its argv
   * carries the nonce (same-process proof, SPIKE-D pid-reuse guard).
   */
  isSameProcessAlive(pid: number, spawnNonce: string | null): boolean;
}

/** Read the live process's argv line, or undefined when it cannot be read. */
function readArgvLine(pid: number): string | undefined {
  try {
    // POSIX ps: `command=` prints the full argv with no header. Available and
    // identically shaped on darwin and Linux CI.
    const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = out.trim();
    return line.length > 0 ? line : undefined;
  } catch {
    // ps exits non-zero when the pid vanished between checks.
    return undefined;
  }
}

export const defaultPidLivenessProbe: PidLivenessProbe = {
  isSameProcessAlive: (pid, spawnNonce) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0); // signal 0: existence probe only
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return false; // no such process
      if (code !== 'EPERM') return false; // unexpected — treat as gone
      // EPERM: pid exists under another uid. Fall through to the nonce
      // check; without a nonce we cannot disprove identity → alive.
    }
    if (spawnNonce === null || spawnNonce.length === 0) return true;
    const argv = readArgvLine(pid);
    if (argv === undefined) return false; // vanished between checks
    return argv.includes(spawnNonce);
  },
};
