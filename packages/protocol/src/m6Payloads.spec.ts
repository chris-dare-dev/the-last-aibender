/**
 * M6 freeze surface: the eleventh `read-model-snapshot` kind `resource-health`
 * (the supervision/governor instrument, blueprint §11), carried on the EXISTING
 * `events` channel. Positive / negative / edge per plan §9.2 (the BE-ORCH
 * contract-package bar). The wire-byte contract lives in the golden corpus
 * (@aibender/testkit `events-readmodel-resource-health-*`); this suite drives
 * the `validateEventsPayload` dispatch directly for fast, exhaustive coverage.
 *
 * [X2]: every fixture is labels + numbers only — placeholder account labels,
 * per-account display ordinals (never native ids), no paths, no titles.
 */

import { describe, expect, it } from 'vitest';

import {
  PRESSURE_STATES,
  READ_MODEL_IDS,
  SHED_ACTIONS,
  WATCHDOG_BANDS,
  isPressureState,
  isReadModelId,
  isShedAction,
  isWatchdogBand,
  validateEventsPayload,
  type ResourceHealthSnapshot,
} from './index.js';

function healthy(): ResourceHealthSnapshot {
  return {
    kind: 'read-model-snapshot',
    readModel: 'resource-health',
    capturedAt: 90100000,
    sources: [{ source: 'lmstudio', state: 'fresh', lastIngestAt: 90099000 }],
    data: {
      pressureLevel: 0,
      pressureState: 'normal',
      freeRamPct: 62.5,
      swapUsedBytes: 0,
      residentSessionCount: 0,
      sessions: [],
      notices: [],
    },
  };
}

// A structurally-typed clone helper that lets us mutate `data` for negatives
// while keeping the compiler honest about the happy path.
function mutate(data: Record<string, unknown>): Record<string, unknown> {
  const base = healthy() as unknown as Record<string, unknown>;
  return { ...base, data: { ...(base['data'] as Record<string, unknown>), ...data } };
}

describe('M6 freeze: resource-health read model (blueprint §11)', () => {
  // -- registration ----------------------------------------------------------

  it('is the eleventh read model, appended after local-offload', () => {
    expect(READ_MODEL_IDS).toContain('resource-health');
    expect(READ_MODEL_IDS[READ_MODEL_IDS.length - 1]).toBe('resource-health');
    // The ten §6.3 leads are carried forward unchanged.
    expect(READ_MODEL_IDS.slice(0, 10)).toEqual([
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
    expect(isReadModelId('resource-health')).toBe(true);
  });

  it('freezes the supervision vocabularies', () => {
    expect([...PRESSURE_STATES]).toEqual(['normal', 'amber', 'red']);
    expect([...WATCHDOG_BANDS]).toEqual(['ok', 'warn', 'recycle']);
    // The [X1] sacrifice order (blueprint §11), in order, + recycle.
    expect([...SHED_ACTIONS]).toEqual([
      'shed-local-model',
      'shed-model-context',
      'shed-frontend-weight',
      'hibernate-non-account',
      'trim-scrollback',
      'recycle-session',
    ]);
    expect(isPressureState('amber')).toBe(true);
    expect(isPressureState('orange')).toBe(false);
    expect(isWatchdogBand('recycle')).toBe(true);
    expect(isWatchdogBand('panic')).toBe(false);
    expect(isShedAction('shed-local-model')).toBe(true);
    expect(isShedAction('kill-everything')).toBe(false);
  });

  // -- positive --------------------------------------------------------------

  it('accepts the healthy baseline (empty sessions + notices)', () => {
    const r = validateEventsPayload(healthy());
    expect(r.ok).toBe(true);
    if (r.ok && 'readModel' in r.value && r.value.readModel === 'resource-health') {
      expect(r.value.kind).toBe('read-model-snapshot');
      expect(r.value.data.pressureState).toBe('normal');
      expect(r.value.data.sessions).toHaveLength(0);
    }
  });

  it('accepts a red-pressure snapshot with the sacrifice order playing out', () => {
    const frame = mutate({
      pressureLevel: 4,
      pressureState: 'red',
      freeRamPct: 9.5,
      swapUsedBytes: 27_917_287_424,
      residentSessionCount: 3,
      localModelResidentBytes: 0,
      sessions: [
        { account: 'MAX_A', backend: 'claude_code', slot: 0, footprintMb: 2100, band: 'ok' },
        { account: 'MAX_A', backend: 'claude_code', slot: 1, footprintMb: 3200, band: 'warn' },
        { account: 'AWS_DEV', backend: 'opencode', slot: 0, footprintMb: 1600, band: 'recycle', hibernated: false },
        { account: 'LOCAL', backend: 'lmstudio', slot: 0, footprintMb: 6400, band: 'ok', hibernated: true },
      ],
      notices: [
        { action: 'shed-local-model', at: 90100400 },
        { action: 'hibernate-non-account', at: 90100450, account: 'AWS_DEV', backend: 'opencode' },
        { action: 'recycle-session', at: 90100480, account: 'MAX_A', backend: 'claude_code' },
      ],
    });
    const r = validateEventsPayload(frame);
    expect(r.ok).toBe(true);
  });

  it('accepts a whole-machine notice with no account (shed-local-model)', () => {
    const r = validateEventsPayload(
      mutate({ notices: [{ action: 'shed-local-model', at: 90100000 }] }),
    );
    expect(r.ok).toBe(true);
  });

  // -- negative --------------------------------------------------------------

  it('rejects an unknown readModel id (closed registry — not forward-tolerant)', () => {
    const bad = { ...healthy(), readModel: 'vibes' } as unknown;
    const r = validateEventsPayload(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad-request');
  });

  it('rejects pressureLevel outside 0..4', () => {
    const r = validateEventsPayload(mutate({ pressureLevel: 5 }));
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown pressureState', () => {
    const r = validateEventsPayload(mutate({ pressureState: 'orange' }));
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown watchdog band', () => {
    const r = validateEventsPayload(
      mutate({
        residentSessionCount: 1,
        sessions: [{ account: 'MAX_A', backend: 'claude_code', slot: 0, footprintMb: 2000, band: 'panic' }],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it('rejects a per-session label/backend pairing violation', () => {
    const r = validateEventsPayload(
      mutate({
        residentSessionCount: 1,
        sessions: [{ account: 'MAX_A', backend: 'opencode', slot: 0, footprintMb: 2000, band: 'ok' }],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown shed action', () => {
    const r = validateEventsPayload(mutate({ notices: [{ action: 'kill-everything', at: 90100000 }] }));
    expect(r.ok).toBe(false);
  });

  it('rejects a notice with a label/backend pairing violation', () => {
    const r = validateEventsPayload(
      mutate({ notices: [{ action: 'recycle-session', at: 1, account: 'LOCAL', backend: 'claude_code' }] }),
    );
    expect(r.ok).toBe(false);
  });

  it('rejects a missing sessions array (required, may be empty)', () => {
    const frame = healthy() as unknown as { data: Record<string, unknown> };
    const data = { ...frame.data };
    delete data['sessions'];
    const r = validateEventsPayload({ ...healthy(), data } as unknown);
    expect(r.ok).toBe(false);
  });

  it('rejects a missing notices array (required, may be empty)', () => {
    const frame = healthy() as unknown as { data: Record<string, unknown> };
    const data = { ...frame.data };
    delete data['notices'];
    const r = validateEventsPayload({ ...healthy(), data } as unknown);
    expect(r.ok).toBe(false);
  });

  it('rejects an empty sources array (freshness is required)', () => {
    const r = validateEventsPayload({ ...healthy(), sources: [] } as unknown);
    expect(r.ok).toBe(false);
  });

  // -- edge ------------------------------------------------------------------

  it('rejects a fractional / negative slot but accepts 0', () => {
    expect(
      validateEventsPayload(
        mutate({
          residentSessionCount: 1,
          sessions: [{ account: 'LOCAL', backend: 'lmstudio', slot: 0, footprintMb: 0, band: 'ok' }],
        }),
      ).ok,
    ).toBe(true);
    expect(
      validateEventsPayload(
        mutate({
          residentSessionCount: 1,
          sessions: [{ account: 'LOCAL', backend: 'lmstudio', slot: -1, footprintMb: 0, band: 'ok' }],
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateEventsPayload(
        mutate({
          residentSessionCount: 1,
          sessions: [{ account: 'LOCAL', backend: 'lmstudio', slot: 0.5, footprintMb: 0, band: 'ok' }],
        }),
      ).ok,
    ).toBe(false);
  });

  it('rejects a non-boolean hibernated flag but accepts absent/true/false', () => {
    for (const hibernated of [undefined, true, false]) {
      const session: Record<string, unknown> = {
        account: 'LOCAL',
        backend: 'lmstudio',
        slot: 0,
        footprintMb: 100,
        band: 'ok',
      };
      if (hibernated !== undefined) session['hibernated'] = hibernated;
      expect(
        validateEventsPayload(mutate({ residentSessionCount: 1, sessions: [session] })).ok,
      ).toBe(true);
    }
    expect(
      validateEventsPayload(
        mutate({
          residentSessionCount: 1,
          sessions: [{ account: 'LOCAL', backend: 'lmstudio', slot: 0, footprintMb: 100, band: 'ok', hibernated: 'yes' }],
        }),
      ).ok,
    ).toBe(false);
  });

  it('treats localModelResidentBytes as optional but non-negative-integer when present', () => {
    expect(validateEventsPayload(mutate({ localModelResidentBytes: 6_500_000_000 })).ok).toBe(true);
    expect(validateEventsPayload(mutate({ localModelResidentBytes: -1 })).ok).toBe(false);
    expect(validateEventsPayload(mutate({ localModelResidentBytes: 1.5 })).ok).toBe(false);
  });

  it('rejects freeRamPct outside 0..100', () => {
    expect(validateEventsPayload(mutate({ freeRamPct: 0 })).ok).toBe(true);
    expect(validateEventsPayload(mutate({ freeRamPct: 100 })).ok).toBe(true);
    expect(validateEventsPayload(mutate({ freeRamPct: 120 })).ok).toBe(false);
    expect(validateEventsPayload(mutate({ freeRamPct: -1 })).ok).toBe(false);
  });

  it('requires an epoch-ms at on every notice', () => {
    expect(validateEventsPayload(mutate({ notices: [{ action: 'shed-local-model' }] })).ok).toBe(false);
    expect(
      validateEventsPayload(mutate({ notices: [{ action: 'shed-local-model', at: -1 }] })).ok,
    ).toBe(false);
  });
});
