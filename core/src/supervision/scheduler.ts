/**
 * THE [X1] SACRIFICE ORDER, ENCODED IN THE SCHEDULER (BE-9; plan §4/BE-9,
 * blueprint §11). The load-shedding sequence, IN ORDER:
 *
 *   1. shed-local-model     — evict the resident local model (biggest single
 *                             line; ~6.5 GB for an 8B Q4). The residency
 *                             ledger's global budget line.
 *   2. shed-model-context   — drop the model's KV/context (shorten TTL, ctx).
 *   3. shed-frontend-weight — reduce the frontend shell weight (scrollback
 *                             caps, disable heavy graph layers).
 *   4. hibernate-non-account— hibernate a NON-Claude (opencode) session.
 *   5. trim-scrollback      — trim per-session scrollback/buffers.
 *   (recycle-session is NOT part of the shed order — it is the per-session
 *    checkpoint→kill→resume path the watchdog triggers; SHED_ACTIONS lists it
 *    last purely as a vocabulary member.)
 *
 * THE HARD [X1] INVARIANTS (asserted by property tests, plan §9.2 BE-9):
 *   - ACCOUNT SESSIONS ARE NEVER THE VICTIM. No shed step ever selects a
 *     claude account session (MAX_A/MAX_B/ENT). `hibernate-non-account`
 *     considers ONLY `!isAccountSession` sessions by construction, and the
 *     whole shed plan is filtered so an account session can never appear as a
 *     notice's affected line.
 *   - ACCOUNT SPAWNS ARE STILL HONORED AFTER SHEDDING. `admitSpawn` returns
 *     the [X1] admission decision: under RED pressure a NON-account spawn is
 *     refused, but an account spawn (`isAccountSpawn`) is ALWAYS admitted —
 *     even mid-shed, even at red. This is the one thing red-pressure load
 *     shedding must never break.
 *
 * PURE decision logic. The scheduler decides WHICH actions to take and in what
 * order; the governor executes them (evict the model, ask the FE to shed
 * weight, hibernate a session) and records the {@link ShedNotice}s onto the
 * snapshot. This module performs NO I/O and issues NO cost-incurring call.
 */

import type { AccountLabel, Backend } from '@aibender/protocol';

import type { PressureState } from './pressureProbe.js';
import type { SupervisedSession } from './types.js';

/** The FROZEN shed-action vocabulary (readModels.ts SHED_ACTIONS), in order. */
export type ShedAction =
  | 'shed-local-model'
  | 'shed-model-context'
  | 'shed-frontend-weight'
  | 'hibernate-non-account'
  | 'trim-scrollback'
  | 'recycle-session';

/**
 * The [X1] SACRIFICE ORDER as the scheduler walks it (blueprint §11). This is
 * the sequence, exactly; `recycle-session` is deliberately ABSENT (it is the
 * watchdog's per-session path, not a load-shed step).
 */
export const SACRIFICE_ORDER: readonly ShedAction[] = Object.freeze([
  'shed-local-model',
  'shed-model-context',
  'shed-frontend-weight',
  'hibernate-non-account',
  'trim-scrollback',
]);

/** One planned shed step — an action and (when it applies) its target line. */
export interface ShedStep {
  readonly action: ShedAction;
  /** The affected session's harness id (governor maps to slot for the wire). */
  readonly sessionId?: string;
  /** Present when the action targets a specific line (never an account one). */
  readonly account?: AccountLabel;
  readonly backend?: Backend;
}

export interface ShedPlanInput {
  readonly pressure: PressureState;
  readonly sessions: readonly SupervisedSession[];
  /** True when a local model is currently resident (gates step 1). */
  readonly localModelResident: boolean;
  /** Ids the governor already hibernated (so the plan does not re-hibernate). */
  readonly alreadyHibernated?: ReadonlySet<string>;
}

/**
 * Plan the shed sequence for the current pressure. `normal` → no steps.
 * `amber` → the light steps (model context, frontend weight — "stop prewarm,
 * shorten TTL, offer hibernation"). `red` → the full order (unload the model,
 * force-hibernate idle NON-account sessions). NEVER selects an account session.
 */
export function planShed(input: ShedPlanInput): readonly ShedStep[] {
  if (input.pressure === 'normal') return [];
  const steps: ShedStep[] = [];
  const already = input.alreadyHibernated ?? new Set<string>();

  // The steps eligible at this pressure. Amber sheds the cheap, reversible
  // levers; red walks the whole order including model unload + hibernation.
  const eligible: ReadonlySet<ShedAction> =
    input.pressure === 'red'
      ? new Set(SACRIFICE_ORDER)
      : new Set<ShedAction>(['shed-model-context', 'shed-frontend-weight']);

  for (const action of SACRIFICE_ORDER) {
    if (!eligible.has(action)) continue;
    switch (action) {
      case 'shed-local-model': {
        // Only when a model is actually resident (else the step is a no-op).
        if (input.localModelResident) steps.push({ action });
        break;
      }
      case 'shed-model-context':
      case 'shed-frontend-weight':
      case 'trim-scrollback':
        // Whole-machine levers — no per-session target.
        steps.push({ action });
        break;
      case 'hibernate-non-account': {
        // THE invariant, encoded structurally: ONLY non-account sessions, and
        // never one already hibernated. Pick the non-account sessions in
        // registration (slot) order for determinism.
        const victims = input.sessions
          .filter((s) => !s.isAccountSession && !already.has(s.sessionId))
          .sort((a, b) => a.slot - b.slot);
        for (const victim of victims) {
          steps.push({
            action: 'hibernate-non-account',
            sessionId: victim.sessionId,
            account: victim.account,
            backend: victim.backend,
          });
        }
        break;
      }
      case 'recycle-session':
        // Not part of the shed order (see module doc).
        break;
    }
  }

  // Belt-and-braces [X1] guard: assert no account session leaked into a target
  // (a defensive filter — the construction above already guarantees it).
  return steps.filter((step) => {
    if (step.sessionId === undefined) return true;
    const target = input.sessions.find((s) => s.sessionId === step.sessionId);
    return target === undefined || !target.isAccountSession;
  });
}

// ---------------------------------------------------------------------------
// [X1] spawn admission — account spawns honored post-shedding
// ---------------------------------------------------------------------------

export interface SpawnAdmissionInput {
  readonly pressure: PressureState;
  /**
   * True when the spawn is a claude ACCOUNT session (MAX_A/MAX_B/ENT). Account
   * spawns are ALWAYS admitted, at any pressure, even mid-shed [X1].
   */
  readonly isAccountSpawn: boolean;
  /**
   * OS-4: how many account sessions are currently RESIDENT (live, not
   * hibernated). Optional — absent means "not tracked" and the soft ceiling is
   * not evaluated (the M6 3-account behavior exactly). The governor supplies
   * the live count.
   */
  readonly residentAccountCount?: number;
  /**
   * OS-4: the resident-account SOFT ceiling (config-derived, generalizes the
   * blueprint §11 "3 account sessions" budget to N). At/above it, an account
   * spawn is STILL admitted (the [X1] priority is absolute — an account is
   * never refused) but carries an AMBER ADVISORY so the operator sees the
   * back-pressure (blueprint §11 N-account math). Absent → no ceiling
   * evaluated. A non-positive value disables it.
   */
  readonly residentAccountSoftCeiling?: number;
}

/**
 * OS-4: an admission decision. `advisory` (present only on an admitted account
 * spawn) surfaces resident-account back-pressure WITHOUT ever refusing the
 * account — the [X1] "account spawns always honored" invariant is absolute; the
 * soft ceiling is advisory back-pressure, never a hard gate.
 */
export type SpawnAdmission =
  | { readonly admit: true; readonly advisory?: 'resident-account-soft-ceiling' }
  | { readonly admit: false; readonly reason: 'red-pressure-non-account' };

/**
 * The [X1] admission rule (blueprint §11): red pressure "refuse non-account
 * spawns ... account spawns are still honored after shedding". An account
 * spawn is admitted unconditionally; a non-account spawn is refused ONLY at
 * red.
 *
 * OS-4 generalizes the "3 accounts" budget to N: when a resident-account SOFT
 * ceiling is configured and the live account count is at/over it, an account
 * spawn is STILL admitted but flagged with an amber `advisory` — surfacing
 * back-pressure so the operator can hibernate an idle account before the
 * footprint envelope is exhausted. The account is NEVER refused (that would
 * break [X1]); the advisory is the only new signal.
 */
export function admitSpawn(input: SpawnAdmissionInput): SpawnAdmission {
  if (input.isAccountSpawn) {
    // NEVER refused [X1]. Surface the soft-ceiling advisory when configured
    // and the resident account count is at/over it.
    const ceiling = input.residentAccountSoftCeiling;
    const resident = input.residentAccountCount;
    if (
      ceiling !== undefined &&
      ceiling > 0 &&
      resident !== undefined &&
      resident >= ceiling
    ) {
      return { admit: true, advisory: 'resident-account-soft-ceiling' };
    }
    return { admit: true };
  }
  if (input.pressure === 'red') return { admit: false, reason: 'red-pressure-non-account' };
  return { admit: true };
}
