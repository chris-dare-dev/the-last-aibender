/**
 * Child-process-group reaper (BE-8; findings pipeline-workflow-builder §R3
 * "The engine must also reap the child CLI processes it spawned (SIGTERM the
 * process group) — lesson from native issue #69856", plan §9.2 negative
 * "budget breach aborts; ... process-group reaping (no orphan children)").
 *
 * When an executable step spawns a child CLI (the SDK/OpenCode process), the
 * executor registers that child's PROCESS-GROUP id (pgid) with the reaper for
 * the step attempt. On budget breach / run cancel the runner aborts the step's
 * signal AND calls {@link reapStep} — which sends SIGTERM to the whole process
 * GROUP (`process.kill(-pgid, ...)`), then SIGKILL after a grace window if the
 * group is still alive. Killing the GROUP (negative pid) — not just the
 * child — is what prevents orphaned grandchildren (the #69856 failure mode:
 * the child spawns its own workers; killing only the child leaves them
 * running).
 *
 * The kill primitive is INJECTABLE so tests drive a real spawned
 * `setsid`/`detached` process group (proving the negative-pid signal reaches
 * the whole group) without this module hard-coding `process.kill`.
 */

import type { Logger } from '@aibender/shared';

/** Signal delivery — injected so tests can observe/drive it. */
export type KillGroup = (pgid: number, signal: NodeJS.Signals) => void;

export interface ProcessGroupReaperOptions {
  /** Signal primitive. Default: `process.kill(-pgid, signal)` (the group form). */
  readonly killGroup?: KillGroup;
  /** ms between the SIGTERM and the escalating SIGKILL. Default 2000. */
  readonly graceMs?: number;
  /** Liveness probe (default `process.kill(-pgid, 0)` — throws when gone). */
  readonly isGroupAlive?: (pgid: number) => boolean;
  readonly logger?: Logger;
  /** Timer scheduler (tests inject a fake). */
  readonly setTimeoutFn?: (fn: () => void, ms: number) => unknown;
}

export interface ProcessGroupReaper {
  /** Register a spawned child's process-group id for a step attempt. */
  register(key: string, pgid: number): void;
  /**
   * Reap a step attempt's process group: SIGTERM the group, then SIGKILL after
   * the grace window if still alive. Idempotent; unknown key is a no-op.
   * Returns true when a group was signalled.
   */
  reapStep(key: string): boolean;
  /** Reap every registered group (run cancel / broker shutdown). */
  reapAll(): void;
  /** Drop a step's registration once it settled cleanly (no reap needed). */
  clear(key: string): void;
}

const DEFAULT_GRACE_MS = 2000;

const defaultKillGroup: KillGroup = (pgid, signal) => {
  // Negative pid → the whole process GROUP (POSIX). The child must have been
  // spawned with its own session/group (`detached: true` / `setsid`) for this
  // to reach grandchildren — the executor's spawn responsibility.
  process.kill(-pgid, signal);
};

const defaultIsGroupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0); // signal 0 = liveness probe; throws ESRCH when gone
    return true;
  } catch {
    return false;
  }
};

export function createProcessGroupReaper(
  options: ProcessGroupReaperOptions = {},
): ProcessGroupReaper {
  const killGroup = options.killGroup ?? defaultKillGroup;
  const isGroupAlive = options.isGroupAlive ?? defaultIsGroupAlive;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const schedule = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const logger = options.logger;
  const groups = new Map<string, number>();

  const reapOne = (key: string, pgid: number): boolean => {
    try {
      killGroup(pgid, 'SIGTERM');
    } catch (cause) {
      // ESRCH = already gone (the common, benign case).
      logger?.debug('reaper SIGTERM found no group (already exited)', {
        detail: (cause as Error).message,
      });
      groups.delete(key);
      return false;
    }
    // Escalate to SIGKILL if the group survives the grace window.
    const timer = schedule(() => {
      if (!isGroupAlive(pgid)) {
        groups.delete(key);
        return;
      }
      try {
        killGroup(pgid, 'SIGKILL');
      } catch (cause) {
        logger?.debug('reaper SIGKILL found no group', { detail: (cause as Error).message });
      }
      groups.delete(key);
    }, graceMs);
    (timer as { unref?: () => void } | undefined)?.unref?.();
    return true;
  };

  return {
    register: (key, pgid) => {
      if (Number.isInteger(pgid) && pgid > 0) groups.set(key, pgid);
    },
    reapStep: (key) => {
      const pgid = groups.get(key);
      if (pgid === undefined) return false;
      return reapOne(key, pgid);
    },
    reapAll: () => {
      for (const [key, pgid] of [...groups.entries()]) reapOne(key, pgid);
    },
    clear: (key) => {
      groups.delete(key);
    },
  };
}
