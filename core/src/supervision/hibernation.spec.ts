/**
 * BE-9 idle hibernation (plan §9.2 BE-9 edge row: "hibernation never
 * auto-applied to account sessions"):
 *   positive — a non-account session idle >30 min is a candidate;
 *   negative — an account session is NEVER a candidate regardless of idle time;
 *   edge     — a session with no recorded activity is not hibernated (treated
 *              as active-since-now); an already-hibernated session is skipped.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_IDLE_HIBERNATION_MS } from './types.js';
import { planIdleHibernation } from './hibernation.js';
import type { SupervisedSession } from './types.js';

const account: SupervisedSession = {
  sessionId: 'ses_acct',
  account: 'MAX_A',
  backend: 'claude_code',
  watchdogClass: 'claude',
  slot: 0,
  isAccountSession: true,
};
const opencode: SupervisedSession = {
  sessionId: 'ses_oc',
  account: 'AWS_DEV',
  backend: 'opencode',
  watchdogClass: 'opencode',
  slot: 0,
  isAccountSession: false,
};

const NOW = 1_000_000_000;
const IDLE = DEFAULT_IDLE_HIBERNATION_MS;

describe('BE-9 idle hibernation', () => {
  it('a non-account session idle >30 min is a candidate (positive)', () => {
    const plan = planIdleHibernation({
      sessions: [opencode],
      lastActivityMs: new Map([['ses_oc', NOW - IDLE - 1]]),
      nowMs: NOW,
    });
    expect(plan.map((c) => c.sessionId)).toEqual(['ses_oc']);
    expect(plan[0]?.idleMs).toBeGreaterThan(IDLE);
  });

  it('an ACCOUNT session is NEVER a candidate, even after hours idle (negative [X1])', () => {
    const plan = planIdleHibernation({
      sessions: [account],
      lastActivityMs: new Map([['ses_acct', NOW - IDLE * 10]]), // 5 h idle
      nowMs: NOW,
    });
    expect(plan).toEqual([]);
  });

  it('mixed registry: only the idle non-account session is picked', () => {
    const plan = planIdleHibernation({
      sessions: [account, opencode],
      lastActivityMs: new Map([
        ['ses_acct', NOW - IDLE * 10],
        ['ses_oc', NOW - IDLE - 5000],
      ]),
      nowMs: NOW,
    });
    expect(plan.map((c) => c.sessionId)).toEqual(['ses_oc']);
  });

  it('a session with no recorded activity is not hibernated (edge)', () => {
    const plan = planIdleHibernation({
      sessions: [opencode],
      lastActivityMs: new Map(), // never seen tick
      nowMs: NOW,
    });
    expect(plan).toEqual([]);
  });

  it('a session idle but under the window is not a candidate (edge)', () => {
    const plan = planIdleHibernation({
      sessions: [opencode],
      lastActivityMs: new Map([['ses_oc', NOW - IDLE + 1]]),
      nowMs: NOW,
    });
    expect(plan).toEqual([]);
  });

  it('an already-hibernated session is skipped (idempotent)', () => {
    const plan = planIdleHibernation({
      sessions: [opencode],
      lastActivityMs: new Map([['ses_oc', NOW - IDLE - 1]]),
      nowMs: NOW,
      alreadyHibernated: new Set(['ses_oc']),
    });
    expect(plan).toEqual([]);
  });

  it('default candidates carry isAccount:false (non-account idle hibernation)', () => {
    const plan = planIdleHibernation({
      sessions: [opencode],
      lastActivityMs: new Map([['ses_oc', NOW - IDLE - 1]]),
      nowMs: NOW,
    });
    expect(plan[0]?.isAccount).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OS-4: sustained-RED account CHECKPOINT hibernation (opt-in, reversible)
// ---------------------------------------------------------------------------

describe('OS-4 account checkpoint hibernation under sustained RED', () => {
  const acctB: SupervisedSession = { ...account, sessionId: 'ses_acct_b', account: 'MAX_B', slot: 1 };

  it('allowAccountUnderRed includes an idle account session, tagged isAccount:true', () => {
    const plan = planIdleHibernation({
      sessions: [account],
      lastActivityMs: new Map([['ses_acct', NOW - IDLE - 1]]),
      nowMs: NOW,
      allowAccountUnderRed: true,
    });
    expect(plan.map((c) => c.sessionId)).toEqual(['ses_acct']);
    expect(plan[0]?.isAccount).toBe(true);
  });

  it('drains NON-account sessions FIRST, then account sessions (relief order)', () => {
    const plan = planIdleHibernation({
      sessions: [account, opencode, acctB],
      lastActivityMs: new Map([
        ['ses_acct', NOW - IDLE * 3],
        ['ses_acct_b', NOW - IDLE * 3],
        ['ses_oc', NOW - IDLE * 3],
      ]),
      nowMs: NOW,
      allowAccountUnderRed: true,
    });
    // Non-account (ses_oc) precedes the account sessions; accounts in slot order.
    expect(plan.map((c) => c.sessionId)).toEqual(['ses_oc', 'ses_acct', 'ses_acct_b']);
    expect(plan.map((c) => c.isAccount)).toEqual([false, true, true]);
  });

  it('a NON-idle account session is still not a candidate even under the RED opt-in', () => {
    const plan = planIdleHibernation({
      sessions: [account],
      lastActivityMs: new Map([['ses_acct', NOW - 5000]]), // recently active
      nowMs: NOW,
      allowAccountUnderRed: true,
    });
    expect(plan).toEqual([]);
  });
});
