/**
 * BE-9 [X1] sacrifice-order scheduler (plan §9.2 BE-9 rows — the load-bearing
 * invariants):
 *   positive — the shed sequence walks the blueprint §11 order exactly;
 *   negative — an account session is NEVER selected as a victim (property test
 *              over many random registries and both pressure states);
 *   edge     — red-state account spawn is still honored after shedding;
 *              amber sheds only the light reversible levers.
 */

import { describe, expect, it } from 'vitest';

import { SACRIFICE_ORDER, admitSpawn, planShed } from './scheduler.js';
import type { PressureState } from './pressureProbe.js';
import type { AccountLabel, Backend } from '@aibender/protocol';
import type { SupervisedSession, WatchdogClass } from './types.js';

function session(
  id: string,
  account: AccountLabel,
  backend: Backend,
  watchdogClass: WatchdogClass,
  slot: number,
  isAccountSession: boolean,
): SupervisedSession {
  return { sessionId: id, account, backend, watchdogClass, slot, isAccountSession };
}

const registry: readonly SupervisedSession[] = [
  session('ses_a0', 'MAX_A', 'claude_code', 'claude', 0, true),
  session('ses_a1', 'MAX_A', 'claude_code', 'claude', 1, true),
  session('ses_b0', 'MAX_B', 'claude_code', 'claude', 0, true),
  session('ses_e0', 'ENT', 'claude_code', 'claude', 0, true),
  session('ses_oc0', 'AWS_DEV', 'opencode', 'opencode', 0, false),
  session('ses_oc1', 'AWS_DEV', 'opencode', 'opencode', 1, false),
  session('ses_lm', 'LOCAL', 'lmstudio', 'lmstudio', 0, false),
];

describe('BE-9 sacrifice order — the sequence (positive)', () => {
  it('the encoded order is exactly the blueprint §11 sequence (no recycle in it)', () => {
    expect([...SACRIFICE_ORDER]).toEqual([
      'shed-local-model',
      'shed-model-context',
      'shed-frontend-weight',
      'hibernate-non-account',
      'trim-scrollback',
    ]);
  });

  it('red pressure walks the WHOLE order in sequence', () => {
    const plan = planShed({ pressure: 'red', sessions: registry, localModelResident: true });
    // The distinct actions appear in sacrifice order.
    const distinct = [...new Set(plan.map((s) => s.action))];
    expect(distinct).toEqual([
      'shed-local-model',
      'shed-model-context',
      'shed-frontend-weight',
      'hibernate-non-account',
      'trim-scrollback',
    ]);
  });

  it('shed-local-model is skipped when no model is resident (no-op)', () => {
    const plan = planShed({ pressure: 'red', sessions: registry, localModelResident: false });
    expect(plan.some((s) => s.action === 'shed-local-model')).toBe(false);
    // The rest of the order still runs.
    expect(plan.some((s) => s.action === 'hibernate-non-account')).toBe(true);
  });

  it('amber sheds only the light reversible levers (context + frontend weight)', () => {
    const plan = planShed({ pressure: 'amber', sessions: registry, localModelResident: true });
    const distinct = [...new Set(plan.map((s) => s.action))];
    expect(distinct).toEqual(['shed-model-context', 'shed-frontend-weight']);
    // Amber NEVER hibernates or unloads the model.
    expect(plan.some((s) => s.action === 'hibernate-non-account')).toBe(false);
    expect(plan.some((s) => s.action === 'shed-local-model')).toBe(false);
  });

  it('normal pressure sheds nothing', () => {
    expect(planShed({ pressure: 'normal', sessions: registry, localModelResident: true })).toEqual([]);
  });
});

describe('BE-9 [X1] account sessions are NEVER the victim (property test — negative)', () => {
  const backends: readonly [AccountLabel, Backend, WatchdogClass, boolean][] = [
    ['MAX_A', 'claude_code', 'claude', true],
    ['MAX_B', 'claude_code', 'claude', true],
    ['ENT', 'claude_code', 'claude', true],
    ['AWS_DEV', 'opencode', 'opencode', false],
    ['LOCAL', 'lmstudio', 'lmstudio', false],
  ];

  it('over 500 random registries × {amber, red}, no shed step targets an account session', () => {
    const rng = mulberry32(0xbe9);
    for (let iter = 0; iter < 500; iter++) {
      const n = 1 + Math.floor(rng() * 8);
      const perAccountSlot = new Map<AccountLabel, number>();
      const sessions: SupervisedSession[] = [];
      for (let i = 0; i < n; i++) {
        const pick = backends[Math.floor(rng() * backends.length)]!;
        const [account, backend, cls, isAcct] = pick;
        const slot = perAccountSlot.get(account) ?? 0;
        perAccountSlot.set(account, slot + 1);
        sessions.push(session(`ses_${iter}_${i}`, account, backend, cls, slot, isAcct));
      }
      for (const pressure of ['amber', 'red'] as PressureState[]) {
        const plan = planShed({
          pressure,
          sessions,
          localModelResident: rng() > 0.5,
          alreadyHibernated: new Set(),
        });
        for (const step of plan) {
          if (step.sessionId === undefined) continue;
          const target = sessions.find((s) => s.sessionId === step.sessionId);
          expect(target?.isAccountSession, `shed step ${step.action} targeted an account session`).not.toBe(
            true,
          );
        }
      }
    }
  });

  it('a registry of ONLY account sessions produces no per-session shed target at all', () => {
    const onlyAccounts = registry.filter((s) => s.isAccountSession);
    const plan = planShed({ pressure: 'red', sessions: onlyAccounts, localModelResident: true });
    // Whole-machine levers still fire, but hibernate-non-account has no victim.
    expect(plan.every((s) => s.sessionId === undefined)).toBe(true);
  });
});

describe('BE-9 [X1] account spawns honored after shedding (edge)', () => {
  it('a red-pressure ACCOUNT spawn is admitted even mid-shed', () => {
    expect(admitSpawn({ pressure: 'red', isAccountSpawn: true })).toEqual({ admit: true });
  });

  it('a red-pressure NON-account spawn is refused', () => {
    expect(admitSpawn({ pressure: 'red', isAccountSpawn: false })).toEqual({
      admit: false,
      reason: 'red-pressure-non-account',
    });
  });

  it('amber admits both account and non-account spawns', () => {
    expect(admitSpawn({ pressure: 'amber', isAccountSpawn: true }).admit).toBe(true);
    expect(admitSpawn({ pressure: 'amber', isAccountSpawn: false }).admit).toBe(true);
  });

  it('normal admits everything', () => {
    expect(admitSpawn({ pressure: 'normal', isAccountSpawn: false }).admit).toBe(true);
  });
});

describe('OS-4 [X1] resident-account soft ceiling (N-account back-pressure)', () => {
  it('admits an account spawn UNDER the ceiling with no advisory', () => {
    expect(
      admitSpawn({
        pressure: 'normal',
        isAccountSpawn: true,
        residentAccountCount: 5,
        residentAccountSoftCeiling: 8,
      }),
    ).toEqual({ admit: true });
  });

  it('admits an account spawn AT/OVER the ceiling but flags the amber advisory (never refused)', () => {
    const atCeiling = admitSpawn({
      pressure: 'red', // even at RED, an account is never refused
      isAccountSpawn: true,
      residentAccountCount: 8,
      residentAccountSoftCeiling: 8,
    });
    expect(atCeiling).toEqual({ admit: true, advisory: 'resident-account-soft-ceiling' });

    const overCeiling = admitSpawn({
      pressure: 'normal',
      isAccountSpawn: true,
      residentAccountCount: 12,
      residentAccountSoftCeiling: 8,
    });
    expect(overCeiling).toEqual({ admit: true, advisory: 'resident-account-soft-ceiling' });
  });

  it('the soft ceiling NEVER applies to a non-account spawn (that still follows the red rule)', () => {
    // A non-account over any account count is unaffected by the account ceiling.
    expect(
      admitSpawn({
        pressure: 'red',
        isAccountSpawn: false,
        residentAccountCount: 99,
        residentAccountSoftCeiling: 3,
      }),
    ).toEqual({ admit: false, reason: 'red-pressure-non-account' });
  });

  it('an absent or non-positive ceiling is the M6 behavior (no advisory)', () => {
    expect(admitSpawn({ pressure: 'normal', isAccountSpawn: true, residentAccountCount: 20 })).toEqual({
      admit: true,
    });
    expect(
      admitSpawn({
        pressure: 'normal',
        isAccountSpawn: true,
        residentAccountCount: 20,
        residentAccountSoftCeiling: 0,
      }),
    ).toEqual({ admit: true });
  });
});

/** Deterministic PRNG for the property test (no external dep). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
