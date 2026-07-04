/**
 * M3 freeze suite — events payload union (event-summary + read-model
 * snapshots + the forward-tolerant reader rule) and the hooks acceptance
 * types. Positive / negative / edge per plan §9.2.
 */

import { describe, expect, it } from 'vitest';

import {
  EVENT_ERROR_KINDS,
  EVENT_SOURCES,
  GATING_CAPABLE_HOOK_EVENTS,
  HOOK_EVENT_VOCABULARY,
  READ_MODEL_IDS,
  SOURCE_FRESHNESS_STATES,
  ackForHookOutcome,
  hookFloorRelayInput,
  mapHookEventName,
  validateEventsPayload,
  validateHookPost,
  type EventSummary,
  type ReadModelSnapshot,
} from './index.js';

// ---------------------------------------------------------------------------
// Builders (synthesized [X2])
// ---------------------------------------------------------------------------

const SUMMARY: EventSummary = {
  kind: 'event-summary',
  eventId: 7,
  ts: 90_100_000,
  account: 'MAX_A',
  backend: 'claude_code',
  source: 'claude-jsonl',
  eventType: 'assistant-turn',
};

const FRESH = [{ source: 'claude-quota', state: 'fresh', lastIngestAt: 90_000_000 }] as const;

function snapshot(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'read-model-snapshot',
    capturedAt: 90_100_000,
    sources: [...FRESH],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// events: event-summary
// ---------------------------------------------------------------------------

describe('validateEventsPayload — event-summary', () => {
  // -- positive --------------------------------------------------------------
  it('accepts a minimal summary and echoes only contract keys', () => {
    const result = validateEventsPayload({ ...SUMMARY, sneaky: 'extra' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(SUMMARY);
      expect('sneaky' in result.value).toBe(false);
    }
  });

  it('accepts a fully-loaded summary (usage, costs, latency, attribution)', () => {
    const result = validateEventsPayload({
      ...SUMMARY,
      account: 'AWS_DEV',
      backend: 'opencode',
      source: 'opencode-sse',
      sessionId: 'ses_fake_1',
      model: 'synthetic-model',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheCreationTokens: 2 },
      costEstimatedUsd: 0.01,
      costActualUsd: 0.009,
      latencyMs: 1200,
      ttftMs: 250,
      toolName: 'Read',
      skillName: 'synthetic-skill',
      ok: true,
      errorKind: 'retry',
    });
    expect(result.ok).toBe(true);
  });

  // -- negative --------------------------------------------------------------
  it('rejects a label/backend pairing violation', () => {
    const result = validateEventsPayload({ ...SUMMARY, backend: 'opencode' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('bad-request');
  });

  it('rejects unknown sources, error kinds, and non-enum accounts', () => {
    for (const bad of [
      { ...SUMMARY, source: 'mystery-feed' },
      { ...SUMMARY, errorKind: 'catastrophe' },
      { ...SUMMARY, account: 'PERSONAL' },
    ]) {
      const result = validateEventsPayload(bad);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('rejects negative token counts and negative costs', () => {
    expect(
      validateEventsPayload({
        ...SUMMARY,
        usage: { inputTokens: -1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      }).ok,
    ).toBe(false);
    expect(validateEventsPayload({ ...SUMMARY, costEstimatedUsd: -0.01 }).ok).toBe(false);
  });

  // -- edge ------------------------------------------------------------------
  it('rejects eventId 0 (store row ids are positive) but accepts ts 0', () => {
    expect(validateEventsPayload({ ...SUMMARY, eventId: 0 }).ok).toBe(false);
    expect(validateEventsPayload({ ...SUMMARY, ts: 0 }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// events: read-model snapshots
// ---------------------------------------------------------------------------

describe('validateEventsPayload — read-model snapshots', () => {
  // -- positive: one valid snapshot per §6.3 lead ------------------------------
  const VALID: Record<(typeof READ_MODEL_IDS)[number], Record<string, unknown>> = {
    'quota-gauges': snapshot({
      readModel: 'quota-gauges',
      data: {
        gauges: [{ account: 'MAX_A', window: '5h', usedPct: 41.5, resetsAt: 90_200_000 }],
      },
    }),
    'burn-rate': snapshot({
      readModel: 'burn-rate',
      data: {
        entries: [
          {
            account: 'MAX_B',
            blockStartAt: 90_000_000,
            blockEndAt: 108_000_000,
            tokensPerHour: 120_000,
            usedPct: 30,
            projectedExhaustionAt: 104_000_000,
          },
        ],
      },
    }),
    'bedrock-cost': snapshot({
      readModel: 'bedrock-cost',
      sources: [{ source: 'bedrock-cost-explorer', state: 'estimate-only' }],
      data: { estimateMtdUsd: 12.5 },
    }),
    'api-equivalent-usd': snapshot({
      readModel: 'api-equivalent-usd',
      data: {
        basis: 'api-equivalent',
        entries: [{ account: 'ENT', backend: 'claude_code', equivalentUsd: 42.0 }],
        windowDays: 7,
      },
    }),
    'cache-hit-rate': snapshot({
      readModel: 'cache-hit-rate',
      data: {
        entries: [
          {
            account: 'MAX_A',
            hitRatePct: 87.5,
            readTokens: 70_000,
            creation5mTokens: 4_000,
            creation1hTokens: 6_000,
          },
        ],
      },
    }),
    latency: snapshot({
      readModel: 'latency',
      data: {
        entries: [
          { backend: 'lmstudio', p50Ms: 300, p95Ms: 900, ttftP50Ms: 80, ttftP95Ms: 200, sampleCount: 40 },
        ],
      },
    }),
    health: snapshot({
      readModel: 'health',
      data: {
        entries: [
          {
            source: 'opencode-sse',
            errorCount: 1,
            retryCount: 2,
            throttleCount: 0,
            timeoutCount: 0,
            windowMinutes: 60,
          },
        ],
      },
    }),
    'skill-leaderboard': snapshot({
      readModel: 'skill-leaderboard',
      data: {
        entries: [
          {
            skillName: 'synthetic-skill',
            invocations: 12,
            successRatePct: 75,
            tokensPerOutcome: 5_400.5,
            worstQuartile: false,
          },
        ],
      },
    }),
    'session-outcomes': snapshot({
      readModel: 'session-outcomes',
      data: { entries: [{ outcome: 'completed', count: 9 }], windowDays: 7 },
    }),
    'local-offload': snapshot({
      readModel: 'local-offload',
      data: { offloadRatioPct: 22.2, localTokens: 200, totalTokens: 900, windowDays: 7 },
    }),
  };

  for (const id of READ_MODEL_IDS) {
    it(`accepts a valid ${id} snapshot`, () => {
      const result = validateEventsPayload(VALID[id]);
      expect(result.ok, id).toBe(true);
      if (result.ok) expect((result.value as ReadModelSnapshot).readModel).toBe(id);
    });
  }

  // -- negative --------------------------------------------------------------
  it('rejects an unknown read model id', () => {
    const result = validateEventsPayload(snapshot({ readModel: 'vibes', data: {} }));
    expect(result.ok).toBe(false);
  });

  it('rejects unknown freshness sources/states and empty sources', () => {
    const base = VALID['quota-gauges'];
    expect(validateEventsPayload({ ...base, sources: [] }).ok).toBe(false);
    expect(
      validateEventsPayload({ ...base, sources: [{ source: 'psychic', state: 'fresh' }] }).ok,
    ).toBe(false);
    expect(
      validateEventsPayload({
        ...base,
        sources: [{ source: 'claude-quota', state: 'broken' }],
      }).ok,
    ).toBe(false);
  });

  it('rejects out-of-range percentages and violated invariants', () => {
    expect(
      validateEventsPayload(
        snapshot({
          readModel: 'quota-gauges',
          data: { gauges: [{ account: 'MAX_A', window: '5h', usedPct: 101, resetsAt: 1 }] },
        }),
      ).ok,
    ).toBe(false);
    // p95 < p50
    expect(
      validateEventsPayload(
        snapshot({
          readModel: 'latency',
          data: { entries: [{ backend: 'opencode', p50Ms: 900, p95Ms: 300, sampleCount: 5 }] },
        }),
      ).ok,
    ).toBe(false);
    // localTokens > totalTokens
    expect(
      validateEventsPayload(
        snapshot({
          readModel: 'local-offload',
          data: { offloadRatioPct: 10, localTokens: 10, totalTokens: 5, windowDays: 1 },
        }),
      ).ok,
    ).toBe(false);
    // dishonest basis label
    expect(
      validateEventsPayload(
        snapshot({
          readModel: 'api-equivalent-usd',
          data: { basis: 'spend', entries: [], windowDays: 7 },
        }),
      ).ok,
    ).toBe(false);
  });

  // -- edge ------------------------------------------------------------------
  it('accepts a gauge whose resetsAt is in the past (reset due) and empty entry lists', () => {
    expect(
      validateEventsPayload(
        snapshot({
          readModel: 'quota-gauges',
          data: { gauges: [{ account: 'MAX_A', window: '7d', usedPct: 100, resetsAt: 0 }] },
        }),
      ).ok,
    ).toBe(true);
    // NO SIGNAL renders from freshness — an empty entries list is legal.
    expect(
      validateEventsPayload(
        snapshot({
          readModel: 'skill-leaderboard',
          sources: [{ source: 'claude-otel', state: 'no-signal' }],
          data: { entries: [] },
        }),
      ).ok,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// events: forward-tolerant reader rule
// ---------------------------------------------------------------------------

describe('validateEventsPayload — forward tolerance (frozen rule)', () => {
  it('decodes unknown kinds as opaque (legal-and-ignored), sanitized to their kind', () => {
    const result = validateEventsPayload({ kind: 'm4-workstream-lens', payload: { x: 1 } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ kind: 'm4-workstream-lens', opaque: true });
  });

  it('still rejects payloads with no usable kind', () => {
    expect(validateEventsPayload({}).ok).toBe(false);
    expect(validateEventsPayload({ kind: '' }).ok).toBe(false);
    expect(validateEventsPayload('event').ok).toBe(false);
    expect(validateEventsPayload(null).ok).toBe(false);
  });

  it('does NOT tolerate malformed REGISTERED kinds', () => {
    expect(validateEventsPayload({ kind: 'event-summary' }).ok).toBe(false);
    expect(validateEventsPayload({ kind: 'read-model-snapshot' }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hooks acceptance (hooks-contract.md §2/§4)
// ---------------------------------------------------------------------------

describe('hooks acceptance types', () => {
  const BODY = {
    hook_event_name: 'PreToolUse',
    session_id: 'synth-native-session',
    tool_name: 'Read',
    tool_input: { file_path: '/synthetic/file' },
    tool_use_id: 'toolu_synth_1',
    custom_future_field: 'passes through',
  };

  // -- positive --------------------------------------------------------------
  it('accepts a gating-capable post, preserving the body verbatim', () => {
    const outcome = validateHookPost('MAX_A', BODY);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.accepted.accountLabel).toBe('MAX_A');
      expect(outcome.accepted.group).toBe('tool-lifecycle');
      expect(outcome.accepted.gatingCapable).toBe(true);
      expect(outcome.accepted.body['custom_future_field']).toBe('passes through');
    }
  });

  it('accepts UNKNOWN event names as unmapped (vocabulary-bump tolerance)', () => {
    const outcome = validateHookPost('ENT', {
      hook_event_name: 'FutureEventFromMinorBump',
      session_id: 'synth-native-session',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.accepted.group).toBe('unmapped');
      expect(outcome.accepted.gatingCapable).toBe(false);
    }
  });

  it('maps the full §3 vocabulary and gating set', () => {
    expect(mapHookEventName('SessionEnd')).toBe('session-lifecycle');
    expect(mapHookEventName('PermissionRequest')).toBe('permission-floor');
    expect(mapHookEventName('PreCompact')).toBe('compaction');
    expect(mapHookEventName('nonsense')).toBe('unmapped');
    expect(Object.keys(HOOK_EVENT_VOCABULARY)).toHaveLength(29);
    expect(GATING_CAPABLE_HOOK_EVENTS).toEqual(['PermissionRequest', 'PreToolUse']);
  });

  // -- negative --------------------------------------------------------------
  it('answers 404 for an unknown label segment — never a guess', () => {
    const outcome = validateHookPost('max_a', BODY);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.httpStatus).toBe(404);
    expect(ackForHookOutcome(outcome)).toEqual({ status: 404 });
  });

  it('answers 400 for malformed bodies', () => {
    for (const bad of [
      null,
      'text',
      ['array'],
      { session_id: 'synth-native-session' }, // no hook_event_name
      { hook_event_name: 'Stop' }, // no session_id
      { hook_event_name: '', session_id: 'x' },
      { hook_event_name: 'Stop', session_id: 42 },
    ]) {
      const outcome = validateHookPost('MAX_A', bad);
      expect(outcome.ok, JSON.stringify(bad)).toBe(false);
      if (!outcome.ok) expect(outcome.httpStatus).toBe(400);
    }
  });

  it('never gates a non-gating-capable event, even when an opinion is passed', () => {
    const outcome = validateHookPost('MAX_A', {
      hook_event_name: 'SessionEnd',
      session_id: 'synth-native-session',
    });
    expect(outcome.ok).toBe(true);
    expect(ackForHookOutcome(outcome, { permissionDecision: 'deny' })).toEqual({ status: 204 });
  });

  // -- edge ------------------------------------------------------------------
  it('gates a gating-capable accept when an opinion exists, else 204', () => {
    const outcome = validateHookPost('MAX_A', BODY);
    expect(ackForHookOutcome(outcome)).toEqual({ status: 204 });
    expect(
      ackForHookOutcome(outcome, {
        permissionDecision: 'deny',
        permissionDecisionReason: 'blocked by harness policy floor',
      }),
    ).toEqual({
      status: 200,
      body: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'blocked by harness policy floor',
      },
    });
  });

  it('extracts the hook-floor relay only for gating-capable posts with a tool name', () => {
    const gating = validateHookPost('MAX_B', BODY);
    if (!gating.ok) throw new Error('expected accept');
    expect(hookFloorRelayInput(gating.accepted)).toEqual({
      accountLabel: 'MAX_B',
      nativeSessionId: 'synth-native-session',
      toolName: 'Read',
      toolUseId: 'toolu_synth_1',
    });

    const noTool = validateHookPost('MAX_B', {
      hook_event_name: 'PermissionRequest',
      session_id: 'synth-native-session',
    });
    if (!noTool.ok) throw new Error('expected accept');
    expect(hookFloorRelayInput(noTool.accepted)).toBeUndefined();

    const notGating = validateHookPost('MAX_B', {
      hook_event_name: 'PostToolUse',
      session_id: 'synth-native-session',
      tool_name: 'Read',
    });
    if (!notGating.ok) throw new Error('expected accept');
    expect(hookFloorRelayInput(notGating.accepted)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// vocabulary pins (closed registries — growing any is an ICR)
// ---------------------------------------------------------------------------

describe('M3 vocabulary pins', () => {
  it('pins the frozen vocabularies exactly', () => {
    expect(EVENT_SOURCES).toEqual([
      'claude-jsonl',
      'claude-otel',
      'claude-quota',
      'hooks',
      'opencode-sse',
      'opencode-db',
      'bedrock-cost-explorer',
      'bedrock-cloudwatch',
      'lmstudio',
      'ent-analytics',
    ]);
    expect(SOURCE_FRESHNESS_STATES).toEqual([
      'fresh',
      'stale',
      'no-signal',
      'lmstudio-down',
      'cluster-absent',
      'sso-expired',
      'account-logged-out',
      'estimate-only',
    ]);
    expect(EVENT_ERROR_KINDS).toEqual(['error', 'retry', 'throttle', 'timeout']);
    expect(READ_MODEL_IDS).toEqual([
      'quota-gauges',
      'burn-rate',
      'bedrock-cost',
      'api-equivalent-usd',
      'cache-hit-rate',
      'latency',
      'health',
      'skill-leaderboard',
      'session-outcomes',
      'local-offload',
    ]);
  });
});
