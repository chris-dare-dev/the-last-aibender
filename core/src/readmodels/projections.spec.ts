/**
 * BE-6 projection tests (plan §9.2 BE-6 row) over a REAL in-memory events
 * store (@aibender/schema migration 0002 — the same accessors production
 * uses). Positive: each lead computes hand-checkable numbers. Negative:
 * empty store → empty entries, never fabricated gauges. Edge: single event,
 * week-boundary window cuts, reset boundary in the past, sparse leaderboard
 * flags nothing.
 *
 * FIXTURE POLICY [X2]: synthesized rows only — placeholder labels, synthetic
 * models/paths/raw_refs.
 */

import { openEventsStore, type EventsStore, type NewEventRow } from '@aibender/schema';
import { afterAll, describe, expect, it } from 'vitest';

import {
  MIN_INVOCATIONS_FOR_FLAG,
  apiEquivalentUsdData,
  bedrockCostData,
  burnRateData,
  cacheHitRateData,
  estimateUsdForRow,
  healthData,
  latencyData,
  localOffloadData,
  percentile,
  quotaGaugesData,
  sessionOutcomesData,
  skillLeaderboardData,
  tokensOfRow,
} from './projections.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 2026-07-01T12:00:00Z — mid-month, mid-day, so MTD/day windows are stable.
const NOW = Date.UTC(2026, 6, 1, 12, 0, 0);

const stores: EventsStore[] = [];
afterAll(() => {
  for (const store of stores) store.close();
});

async function openStore(): Promise<EventsStore> {
  const store = await openEventsStore({ path: ':memory:' });
  stores.push(store);
  return store;
}

let rawSeq = 0;
function claudeEvent(overrides: Partial<NewEventRow> = {}): NewEventRow {
  rawSeq += 1;
  return {
    tsMs: NOW - HOUR,
    backend: 'claude_code',
    account: 'MAX_A',
    source: 'claude-jsonl',
    eventType: 'assistant-turn',
    rawRef: `jsonl:/synthetic/transcript.jsonl:${String(rawSeq)}`,
    ...overrides,
  };
}

describe('quota gauges (lead 1)', () => {
  it('maps the latest snapshot per (account, window); past resetsAt is legal (reset-boundary edge)', async () => {
    const store = await openStore();
    store.quotaSnapshots.insert({
      account: 'MAX_A',
      window: '5h',
      usedPct: 30,
      resetsAtMs: NOW + HOUR,
      capturedAtMs: NOW - 2_000,
      source: 'statusline',
    });
    store.quotaSnapshots.insert({
      account: 'MAX_A',
      window: '5h',
      usedPct: 41.5,
      resetsAtMs: NOW + HOUR,
      capturedAtMs: NOW - 1_000,
      source: 'statusline',
    });
    // Reset boundary crossed mid-query: resetsAt already in the past.
    store.quotaSnapshots.insert({
      account: 'MAX_B',
      window: '7d',
      usedPct: 90,
      resetsAtMs: NOW - 5_000,
      capturedAtMs: NOW - 1_000,
      source: 'oauth-poll',
    });

    const data = quotaGaugesData(store);
    expect(data.gauges).toEqual([
      { account: 'MAX_A', window: '5h', usedPct: 41.5, resetsAt: NOW + HOUR },
      { account: 'MAX_B', window: '7d', usedPct: 90, resetsAt: NOW - 5_000 },
    ]);
  });

  it('NEGATIVE: empty store → empty gauges, never a fabricated snapshot', async () => {
    const store = await openStore();
    expect(quotaGaugesData(store).gauges).toEqual([]);
  });
});

describe('burn rate (lead 2)', () => {
  it('reconstructs the active block per account and joins the quota pct', async () => {
    const store = await openStore();
    const blockStart = Date.UTC(2026, 6, 1, 10, 0, 0); // NOW - 2h, on the hour
    store.events.insert(
      claudeEvent({ tsMs: blockStart, inputTokens: 600, outputTokens: 400 }),
    );
    store.events.insert(claudeEvent({ tsMs: blockStart + HOUR, inputTokens: 1_000 }));

    const data = burnRateData(store, {
      nowMs: NOW,
      usedPctByAccount: new Map([['MAX_A', 40]]),
    });
    expect(data.entries).toHaveLength(1);
    const entry = data.entries[0];
    expect(entry?.account).toBe('MAX_A');
    expect(entry?.blockStartAt).toBe(blockStart);
    expect(entry?.blockEndAt).toBe(blockStart + 5 * HOUR);
    // 2000 tokens over 2h elapsed → 1000 tokens/hour.
    expect(entry?.tokensPerHour).toBeCloseTo(1_000, 6);
    expect(entry?.usedPct).toBe(40);
    // 40% in 2h → 20%/h → exhaustion 3h from now.
    expect(entry?.projectedExhaustionAt).toBe(blockStart + 5 * HOUR);
  });

  it('NEGATIVE: no quota join → no usedPct/projection; no events → no entries (never zeros)', async () => {
    const store = await openStore();
    expect(burnRateData(store, { nowMs: NOW }).entries).toEqual([]);

    store.events.insert(claudeEvent({ tsMs: NOW - HOUR, inputTokens: 100 }));
    const data = burnRateData(store, { nowMs: NOW });
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0]?.usedPct).toBeUndefined();
    expect(data.entries[0]?.projectedExhaustionAt).toBeUndefined();
  });

  it('EDGE: a session idle past its block produces no active-block entry', async () => {
    const store = await openStore();
    store.events.insert(claudeEvent({ tsMs: NOW - 6 * HOUR, inputTokens: 100 }));
    expect(burnRateData(store, { nowMs: NOW }).entries).toEqual([]);
  });

  it('EDGE clock skew: a future-stamped event still yields finite, non-negative burn', async () => {
    const store = await openStore();
    store.events.insert(claudeEvent({ tsMs: NOW + 30_000, inputTokens: 500 }));
    const data = burnRateData(store, { nowMs: NOW });
    expect(data.entries).toHaveLength(1);
    const rate = data.entries[0]?.tokensPerHour ?? Number.NaN;
    expect(Number.isFinite(rate)).toBe(true);
    expect(rate).toBeGreaterThanOrEqual(0);
  });
});

describe('bedrock cost (lead 3)', () => {
  it('sums MTD estimates; actuals + yesterday + lag only when backfill landed', async () => {
    const store = await openStore();
    const yesterday = NOW - DAY; // 2026-06-30T12:00Z — inside MTD? No: June!
    // NOTE: NOW is July 1 12:00Z, so "yesterday" (June 30) predates MTD —
    // deliberately proving the month boundary; only today's rows count.
    store.events.insert(
      claudeEvent({
        tsMs: NOW - HOUR,
        backend: 'opencode',
        account: 'AWS_DEV',
        source: 'opencode-sse',
        rawRef: 'evt_synth_001',
        costEstimatedUsd: 0.5,
      }),
    );
    store.events.insert(
      claudeEvent({
        tsMs: yesterday,
        backend: 'opencode',
        account: 'AWS_DEV',
        source: 'opencode-sse',
        rawRef: 'evt_synth_002',
        costEstimatedUsd: 9.9,
      }),
    );

    const withoutActuals = bedrockCostData(store, NOW);
    expect(withoutActuals.hasActuals).toBe(false);
    expect(withoutActuals.data).toEqual({ estimateMtdUsd: 0.5 });

    store.events.backfillCostActual('opencode', 'evt_synth_001', 0.44);
    const withActuals = bedrockCostData(store, NOW);
    expect(withActuals.hasActuals).toBe(true);
    expect(withActuals.data.actualMtdUsd).toBeCloseTo(0.44, 10);
    expect(withActuals.data.actualLagHours).toBe(24);
    // The backfilled row is today, not yesterday → no yesterday slice.
    expect(withActuals.data.actualYesterdayUsd).toBeUndefined();
    // Backfill never touched the estimate (schema semantics).
    expect(withActuals.data.estimateMtdUsd).toBeCloseTo(0.5, 10);
  });
});

describe('api-equivalent USD (lead 4)', () => {
  it('prefers the ingest estimate, falls back to the pinned prices table, keeps the pairing', async () => {
    const store = await openStore();
    store.prices.upsert({
      provider: 'synthetic',
      model: 'synth-model-1',
      inputUsdPerMtok: 3,
      outputUsdPerMtok: 15,
      source: 'litellm-pinned',
    });
    // Price-math row: 1M input + 1M output → 3 + 15 = 18 USD.
    store.events.insert(
      claudeEvent({
        provider: 'synthetic',
        model: 'synth-model-1',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    );
    // Ingest-estimate row wins over price math.
    store.events.insert(
      claudeEvent({
        account: 'MAX_B',
        costEstimatedUsd: 2.5,
        provider: 'synthetic',
        model: 'synth-model-1',
        inputTokens: 1_000_000,
      }),
    );

    const data = apiEquivalentUsdData(store, NOW, 7);
    expect(data.basis).toBe('api-equivalent'); // the frozen honesty literal
    expect(data.windowDays).toBe(7);
    expect(data.entries).toEqual(
      expect.arrayContaining([
        { account: 'MAX_A', backend: 'claude_code', equivalentUsd: 18 },
        { account: 'MAX_B', backend: 'claude_code', equivalentUsd: 2.5 },
      ]),
    );
  });

  it('EDGE week boundary: rows outside windowDays are cut; unknown models contribute 0', async () => {
    const store = await openStore();
    store.events.insert(
      claudeEvent({ tsMs: NOW - 7 * DAY - 1, costEstimatedUsd: 99 }), // outside
    );
    store.events.insert(
      claudeEvent({ tsMs: NOW - 7 * DAY, costEstimatedUsd: 1 }), // exactly on the edge: included
    );
    store.events.insert(
      claudeEvent({ provider: 'synthetic', model: 'unpriced-model', inputTokens: 1_000_000 }),
    );
    const data = apiEquivalentUsdData(store, NOW, 7);
    expect(data.entries).toEqual([
      { account: 'MAX_A', backend: 'claude_code', equivalentUsd: 1 },
    ]);
  });
});

describe('cache hit rate (lead 5)', () => {
  it('hitRate = read/(input+read); TTL split carried through', async () => {
    const store = await openStore();
    store.events.insert(
      claudeEvent({
        inputTokens: 250,
        cacheReadTokens: 750,
        cacheCreation5mTokens: 100,
        cacheCreation1hTokens: 40,
      }),
    );
    const data = cacheHitRateData(store, NOW, 7);
    expect(data.entries).toEqual([
      {
        account: 'MAX_A',
        hitRatePct: 75,
        readTokens: 750,
        creation5mTokens: 100,
        creation1hTokens: 40,
      },
    ]);
  });

  it('NEGATIVE: accounts with no cache-bearing traffic get NO entry (no zero fabrication)', async () => {
    const store = await openStore();
    store.events.insert(claudeEvent({ outputTokens: 10 }));
    expect(cacheHitRateData(store, NOW, 7).entries).toEqual([]);
  });
});

describe('latency (lead 6)', () => {
  it('nearest-rank p50/p95 per backend with optional TTFT; p95 >= p50 by construction', async () => {
    const store = await openStore();
    const samples = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1_000];
    for (const [index, latencyMs] of samples.entries()) {
      store.events.insert(
        claudeEvent({
          latencyMs,
          ...(index < 3 ? { ttftMs: latencyMs / 10 } : {}),
          rawRef: `jsonl:/synthetic/latency.jsonl:${String(index)}`,
        }),
      );
    }
    const data = latencyData(store, NOW, 7);
    expect(data.entries).toHaveLength(1);
    const entry = data.entries[0];
    expect(entry?.backend).toBe('claude_code');
    expect(entry?.p50Ms).toBe(500); // nearest-rank over 10 samples
    expect(entry?.p95Ms).toBe(1_000);
    expect(entry?.ttftP50Ms).toBe(20);
    expect(entry?.ttftP95Ms).toBe(30);
    expect(entry?.sampleCount).toBe(10);
  });

  it('EDGE single event: p50 = p95 = the one sample; no TTFT block when unsampled', async () => {
    const store = await openStore();
    store.events.insert(claudeEvent({ latencyMs: 42 }));
    const entry = latencyData(store, NOW, 7).entries[0];
    expect(entry?.p50Ms).toBe(42);
    expect(entry?.p95Ms).toBe(42);
    expect(entry?.ttftP50Ms).toBeUndefined();
    expect(entry?.sampleCount).toBe(1);
  });

  it('percentile refuses an empty sample (programmer error, not wire data)', () => {
    expect(() => percentile([], 50)).toThrow(RangeError);
  });
});

describe('health (lead 7)', () => {
  it('counts error kinds per source in the rolling window; unclassified failures count as errors', async () => {
    const store = await openStore();
    store.events.insert(claudeEvent({ tsMs: NOW - 60_000, ok: false, errorKind: 'throttle' }));
    store.events.insert(claudeEvent({ tsMs: NOW - 50_000, ok: false })); // unclassified
    store.events.insert(claudeEvent({ tsMs: NOW - 40_000, ok: true }));
    store.events.insert(claudeEvent({ tsMs: NOW - 30_000, errorKind: 'retry' }));
    store.events.insert(claudeEvent({ tsMs: NOW - 2 * HOUR, errorKind: 'error' })); // outside 60m

    const data = healthData(store, NOW, 60);
    expect(data.entries).toEqual([
      {
        source: 'claude-jsonl',
        errorCount: 1,
        retryCount: 1,
        throttleCount: 1,
        timeoutCount: 0,
        windowMinutes: 60,
      },
    ]);
  });
});

describe('skill leaderboard (lead 8)', () => {
  async function seedSkill(
    store: EventsStore,
    skillName: string,
    invocations: number,
    okCount: number,
  ): Promise<void> {
    for (let i = 0; i < invocations; i += 1) {
      store.events.insert(
        claudeEvent({
          skillName,
          ok: i < okCount,
          inputTokens: 100,
          rawRef: `jsonl:/synthetic/${skillName}.jsonl:${String(i)}`,
        }),
      );
    }
  }

  it('rates, tokens-per-outcome, and worst-quartile flags on a big-enough cohort', async () => {
    const store = await openStore();
    await seedSkill(store, 'skill-a', 8, 8); // 100%
    await seedSkill(store, 'skill-b', 8, 7); // 87.5%
    await seedSkill(store, 'skill-c', 8, 6); // 75%
    await seedSkill(store, 'skill-d', 8, 2); // 25% — the worst quartile

    const data = skillLeaderboardData(store, { nowMs: NOW, windowDays: 7 });
    const byName = new Map(data.entries.map((entry) => [entry.skillName, entry]));
    expect(byName.get('skill-d')?.worstQuartile).toBe(true);
    expect(byName.get('skill-a')?.worstQuartile).toBe(false);
    expect(byName.get('skill-b')?.worstQuartile).toBe(false);
    expect(byName.get('skill-c')?.worstQuartile).toBe(false);
    expect(byName.get('skill-a')?.successRatePct).toBe(100);
    expect(byName.get('skill-d')?.successRatePct).toBe(25);
    expect(byName.get('skill-a')?.tokensPerOutcome).toBe(100);
    // Correction rates ABSENT until the local-model job ran.
    expect(byName.get('skill-a')?.correctionRatePct).toBeUndefined();
  });

  it('EDGE sparse data flags NOTHING (plan §9.2 BE-6 edge row)', async () => {
    const store = await openStore();
    // Three rateable skills — below the 4-skill cohort floor.
    await seedSkill(store, 'skill-a', MIN_INVOCATIONS_FOR_FLAG, 5);
    await seedSkill(store, 'skill-b', MIN_INVOCATIONS_FOR_FLAG, 3);
    await seedSkill(store, 'skill-c', MIN_INVOCATIONS_FOR_FLAG, 1);
    // One busy-but-unrated skill (too few outcomes for a rate).
    store.events.insert(claudeEvent({ skillName: 'skill-d', inputTokens: 10 }));

    const data = skillLeaderboardData(store, { nowMs: NOW, windowDays: 7 });
    expect(data.entries.every((entry) => !entry.worstQuartile)).toBe(true);
    const skillD = data.entries.find((entry) => entry.skillName === 'skill-d');
    expect(skillD?.successRatePct).toBeUndefined(); // sparse → unrated, not 0%
  });

  it('joins correction rates from the classification job when provided', async () => {
    const store = await openStore();
    await seedSkill(store, 'skill-a', 4, 4);
    const data = skillLeaderboardData(store, {
      nowMs: NOW,
      windowDays: 7,
      correctionRatePctBySkill: new Map([['skill-a', 12.5]]),
    });
    expect(data.entries[0]?.correctionRatePct).toBe(12.5);
  });
});

describe('session outcomes (lead 9)', () => {
  it('counts outcomes inside the window', async () => {
    const store = await openStore();
    store.sessionOutcomes.insert({
      account: 'MAX_A',
      nativeSessionId: 'nat-ses-01',
      outcome: 'completed',
      capturedAtMs: NOW - DAY,
      rawRef: 'facets:/synthetic/session-meta.json:1',
    });
    store.sessionOutcomes.insert({
      account: 'MAX_B',
      nativeSessionId: 'nat-ses-02',
      outcome: 'completed',
      capturedAtMs: NOW - DAY,
      rawRef: 'facets:/synthetic/session-meta.json:2',
    });
    store.sessionOutcomes.insert({
      account: 'MAX_A',
      nativeSessionId: 'nat-ses-03',
      outcome: 'friction',
      capturedAtMs: NOW - 8 * DAY, // outside the 7d window
      rawRef: 'facets:/synthetic/session-meta.json:3',
    });
    const data = sessionOutcomesData(store, NOW, 7);
    expect(data).toEqual({ entries: [{ outcome: 'completed', count: 2 }], windowDays: 7 });
  });
});

describe('local offload (lead 10)', () => {
  it('localTokens/totalTokens over the window; honest zero on an empty window', async () => {
    const store = await openStore();
    store.events.insert(
      claudeEvent({
        backend: 'lmstudio',
        account: 'LOCAL',
        source: 'lmstudio',
        inputTokens: 300,
        outputTokens: 200,
        rawRef: 'lmstudio:/synthetic/call:1',
      }),
    );
    store.events.insert(claudeEvent({ inputTokens: 900, outputTokens: 600 }));
    const data = localOffloadData(store, NOW, 7);
    expect(data.localTokens).toBe(500);
    expect(data.totalTokens).toBe(2_000);
    expect(data.offloadRatioPct).toBe(25);
    expect(data.localTokens).toBeLessThanOrEqual(data.totalTokens); // frozen honesty pin

    const empty = await openStore();
    expect(localOffloadData(empty, NOW, 7)).toEqual({
      offloadRatioPct: 0,
      localTokens: 0,
      totalTokens: 0,
      windowDays: 7,
    });
  });
});

describe('shared helpers', () => {
  it('tokensOfRow sums exactly the four ground-truth classes', async () => {
    const store = await openStore();
    const { row } = store.events.insert(
      claudeEvent({
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheCreationTokens: 4,
        reasoningTokens: 100, // NOT one of the four burn classes
      }),
    );
    expect(tokensOfRow(row)).toBe(10);
  });

  it('estimateUsdForRow: ingest estimate > price math > honest 0', async () => {
    const store = await openStore();
    const { row } = store.events.insert(claudeEvent({}));
    expect(estimateUsdForRow(row, store.prices)).toBe(0);
  });
});
