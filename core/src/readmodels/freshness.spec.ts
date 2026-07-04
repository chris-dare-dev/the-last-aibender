/**
 * BE-6 freshness state machine tests (plan §9.2: "freshness transitions
 * correct"; edge: source up→down→up, clock skew). Degraded sources are
 * STATES, never errors — nothing in here throws.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FRESH_WINDOW_MS,
  FRESHNESS_CONDITIONS,
  createFreshnessTracker,
  isFreshnessCondition,
} from './freshness.js';

const T0 = 90_000_000;

describe('freshness tracker — signal-derived states', () => {
  it('never-ingested source is no-signal (NO fabricated timestamps)', () => {
    const tracker = createFreshnessTracker();
    expect(tracker.stateOf('claude-jsonl', T0)).toEqual({
      source: 'claude-jsonl',
      state: 'no-signal',
    });
  });

  it('signal within the window is fresh; past the window is stale; new signal re-freshens', () => {
    const tracker = createFreshnessTracker();
    tracker.recordSignal('claude-quota', T0);
    expect(tracker.stateOf('claude-quota', T0 + 1_000).state).toBe('fresh');
    expect(tracker.stateOf('claude-quota', T0 + DEFAULT_FRESH_WINDOW_MS).state).toBe('fresh');
    expect(tracker.stateOf('claude-quota', T0 + DEFAULT_FRESH_WINDOW_MS + 1).state).toBe('stale');
    tracker.recordSignal('claude-quota', T0 + DEFAULT_FRESH_WINDOW_MS + 2);
    expect(tracker.stateOf('claude-quota', T0 + DEFAULT_FRESH_WINDOW_MS + 3).state).toBe('fresh');
  });

  it('carries lastIngestAt on every signal-bearing state', () => {
    const tracker = createFreshnessTracker();
    tracker.recordSignal('opencode-sse', T0);
    expect(tracker.stateOf('opencode-sse', T0 + 1).lastIngestAt).toBe(T0);
  });

  it('per-source windows override the default (Cost Explorer cadence)', () => {
    const tracker = createFreshnessTracker();
    tracker.recordSignal('bedrock-cost-explorer', T0);
    // 20 h later: way past the default window, inside the 48 h CE window.
    expect(tracker.stateOf('bedrock-cost-explorer', T0 + 20 * 3_600_000).state).toBe('fresh');
    expect(tracker.stateOf('bedrock-cost-explorer', T0 + 49 * 3_600_000).state).toBe('stale');
  });

  it('EDGE clock skew: a future-stamped signal reads fresh, never negative-age stale', () => {
    const tracker = createFreshnessTracker();
    tracker.recordSignal('claude-otel', T0 + 60_000); // source clock ahead
    expect(tracker.stateOf('claude-otel', T0).state).toBe('fresh');
  });

  it('EDGE late-arriving older signal never rewinds freshness (monotonic)', () => {
    const tracker = createFreshnessTracker();
    tracker.recordSignal('hooks', T0);
    tracker.recordSignal('hooks', T0 - 10_000);
    expect(tracker.stateOf('hooks', T0 + 1).lastIngestAt).toBe(T0);
  });
});

describe('freshness tracker — conditions (down-as-state)', () => {
  it('up → down → up: lmstudio-down overrides fresh and lifts cleanly', () => {
    const tracker = createFreshnessTracker();
    tracker.recordSignal('lmstudio', T0);
    expect(tracker.stateOf('lmstudio', T0 + 1).state).toBe('fresh');

    tracker.setCondition('lmstudio', 'lmstudio-down');
    const down = tracker.stateOf('lmstudio', T0 + 2);
    expect(down.state).toBe('lmstudio-down');
    // The last known signal stays visible while down — honest, not erased.
    expect(down.lastIngestAt).toBe(T0);

    tracker.clearCondition('lmstudio');
    expect(tracker.stateOf('lmstudio', T0 + 3).state).toBe('fresh');
  });

  it('a condition on a never-ingested source renders without lastIngestAt', () => {
    const tracker = createFreshnessTracker();
    tracker.setCondition('bedrock-cost-explorer', 'sso-expired');
    expect(tracker.stateOf('bedrock-cost-explorer', T0)).toEqual({
      source: 'bedrock-cost-explorer',
      state: 'sso-expired',
    });
  });

  it('all five frozen conditions are representable and idempotent', () => {
    const tracker = createFreshnessTracker();
    expect(FRESHNESS_CONDITIONS).toEqual([
      'lmstudio-down',
      'cluster-absent',
      'sso-expired',
      'account-logged-out',
      'estimate-only',
    ]);
    for (const condition of FRESHNESS_CONDITIONS) {
      expect(isFreshnessCondition(condition)).toBe(true);
      tracker.setCondition('ent-analytics', condition);
      tracker.setCondition('ent-analytics', condition); // idempotent
      expect(tracker.stateOf('ent-analytics', T0).state).toBe(condition);
    }
    tracker.clearCondition('ent-analytics');
    tracker.clearCondition('ent-analytics'); // idempotent
    expect(tracker.stateOf('ent-analytics', T0).state).toBe('no-signal');
    expect(isFreshnessCondition('fresh')).toBe(false);
    expect(isFreshnessCondition('no-signal')).toBe(false);
  });

  it('snapshotFor returns entries in input order for a snapshot source set', () => {
    const tracker = createFreshnessTracker();
    tracker.recordSignal('claude-jsonl', T0);
    tracker.setCondition('lmstudio', 'lmstudio-down');
    const entries = tracker.snapshotFor(['claude-jsonl', 'lmstudio', 'claude-quota'], T0 + 1);
    expect(entries.map((entry) => entry.source)).toEqual([
      'claude-jsonl',
      'lmstudio',
      'claude-quota',
    ]);
    expect(entries.map((entry) => entry.state)).toEqual(['fresh', 'lmstudio-down', 'no-signal']);
  });
});
