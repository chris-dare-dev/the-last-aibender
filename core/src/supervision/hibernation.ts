/**
 * IDLE HIBERNATION planner (BE-9; plan §4/BE-9, blueprint §11: "Idle
 * hibernation after 30 min (never auto-applied to the three account
 * sessions)").
 *
 * A session that has been idle (no activity) for at least the idle window is a
 * hibernation candidate — UNLESS it is a claude account session, which is
 * NEVER auto-hibernated regardless of idle time. This is the [X1] invariant in
 * the hibernation dimension (the scheduler enforces it in the shed dimension).
 *
 * PURE decision logic over injected activity timestamps + `nowMs`. The
 * governor supplies last-activity per session (from the lineage recorder's
 * `noteActivity` axis / the ptyHost byte clock); this module never reads a
 * clock or a process itself. It issues NO cost-incurring call.
 */

import { DEFAULT_IDLE_HIBERNATION_MS, type SupervisedSession } from './types.js';

export interface IdleHibernationInput {
  readonly sessions: readonly SupervisedSession[];
  /** Last-activity epoch ms per harness session id (absent → never active). */
  readonly lastActivityMs: ReadonlyMap<string, number>;
  readonly nowMs: number;
  /** Ids already hibernated (skipped so the plan does not re-hibernate). */
  readonly alreadyHibernated?: ReadonlySet<string>;
  /** Idle window ms. Default 30 min (blueprint §11). */
  readonly idleWindowMs?: number;
}

/** One idle-hibernation candidate — a harness id + its idle duration. */
export interface HibernationCandidate {
  readonly sessionId: string;
  readonly idleMs: number;
}

/**
 * Sessions idle at least the window and NOT account sessions and NOT already
 * hibernated. Account sessions are excluded BY CONSTRUCTION (the filter never
 * even considers `isAccountSession` entries) — the [X1] "never auto-applied to
 * account sessions" rule. Returned in slot order for determinism.
 */
export function planIdleHibernation(input: IdleHibernationInput): readonly HibernationCandidate[] {
  const windowMs = input.idleWindowMs ?? DEFAULT_IDLE_HIBERNATION_MS;
  const already = input.alreadyHibernated ?? new Set<string>();

  return input.sessions
    .filter((s) => !s.isAccountSession) // [X1]: account sessions are NEVER candidates
    .filter((s) => !already.has(s.sessionId))
    .map((s) => {
      // A session with no recorded activity is treated as active-since-now
      // (conservative — we never hibernate a just-launched session we have not
      // yet seen tick). Only a session with a KNOWN old last-activity qualifies.
      const last = input.lastActivityMs.get(s.sessionId);
      const idleMs = last === undefined ? 0 : Math.max(0, input.nowMs - last);
      return { sessionId: s.sessionId, idleMs, slot: s.slot };
    })
    .filter((c) => c.idleMs >= windowMs)
    .sort((a, b) => a.slot - b.slot)
    .map(({ sessionId, idleMs }) => ({ sessionId, idleMs }));
}
