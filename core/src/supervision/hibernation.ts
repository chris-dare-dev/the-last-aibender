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
  /**
   * OS-4: when true, IDLE account sessions become candidates too — a
   * CHECKPOINT-hibernation (reversible; the resume ledger resumes them). The
   * governor sets this ONLY under SUSTAINED RED pressure, as N-account
   * back-pressure relief when the resident footprint envelope is exhausted.
   * DEFAULT false → the M6 rule (account sessions NEVER auto-hibernated) holds.
   * This is NOT a shed: an account is never KILLED involuntarily; a checkpoint
   * hibernation is resumable, and account ACTIVITY immediately un-hibernates it
   * (governor.noteActivity). Candidates are tagged {@link HibernationCandidate.isAccount}.
   */
  readonly allowAccountUnderRed?: boolean;
}

/** One idle-hibernation candidate — a harness id + its idle duration. */
export interface HibernationCandidate {
  readonly sessionId: string;
  readonly idleMs: number;
  /**
   * OS-4: true when this candidate is an ACCOUNT session included only because
   * `allowAccountUnderRed` was set (sustained RED). The governor treats it as a
   * reversible CHECKPOINT hibernation, never a shed — and only ever hibernates
   * account sessions when this flag is set.
   */
  readonly isAccount: boolean;
}

/**
 * Sessions idle at least the window and NOT already hibernated. Account sessions
 * are excluded BY DEFAULT ([X1] "never auto-applied to account sessions") —
 * UNLESS `allowAccountUnderRed` is set (OS-4: sustained-RED checkpoint
 * hibernation), in which case idle account sessions are included and TAGGED
 * `isAccount: true` so the governor treats them as reversible checkpoints, not
 * sheds. Returned in slot order for determinism, non-account first so relief
 * always drains the shed-eligible sessions before touching an account.
 */
export function planIdleHibernation(input: IdleHibernationInput): readonly HibernationCandidate[] {
  const windowMs = input.idleWindowMs ?? DEFAULT_IDLE_HIBERNATION_MS;
  const already = input.alreadyHibernated ?? new Set<string>();
  const allowAccount = input.allowAccountUnderRed ?? false;

  return input.sessions
    // [X1]: account sessions are candidates ONLY under the RED opt-in.
    .filter((s) => !s.isAccountSession || allowAccount)
    .filter((s) => !already.has(s.sessionId))
    .map((s) => {
      // A session with no recorded activity is treated as active-since-now
      // (conservative — we never hibernate a just-launched session we have not
      // yet seen tick). Only a session with a KNOWN old last-activity qualifies.
      const last = input.lastActivityMs.get(s.sessionId);
      const idleMs = last === undefined ? 0 : Math.max(0, input.nowMs - last);
      return { sessionId: s.sessionId, idleMs, slot: s.slot, isAccount: s.isAccountSession };
    })
    .filter((c) => c.idleMs >= windowMs)
    // Non-account first (drain shed-eligible before touching an account), then
    // slot order for determinism.
    .sort((a, b) => Number(a.isAccount) - Number(b.isAccount) || a.slot - b.slot)
    .map(({ sessionId, idleMs, isAccount }) => ({ sessionId, idleMs, isAccount }));
}
