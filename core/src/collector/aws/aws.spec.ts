/**
 * BE-5 source 6 suite (plan §9.2 BE-5 rows) — FAKES ONLY (rule 3: no live
 * AWS call anywhere in tests; Cost Explorer bills per request):
 *   positive — daily actuals rows land; CloudWatch samples normalize
 *   negative — live clients REFUSED without the SI-4-gated opt-in
 *   edge     — Cost Explorer backfill overwrites ESTIMATE NOT RAW; poll
 *              floors (1–2×/day, 5–15 min while active); activity gate
 */

import { describe, expect, it } from 'vitest';

import { openEventsStore } from '@aibender/schema';

import { LiveAwsDisabledError } from '../errors.js';
import {
  createCloudWatchPoller,
  createLiveCloudWatchClient,
  normalizeBedrockSample,
  type BedrockMetricSample,
} from './cloudwatch.js';
import {
  createCostExplorerPoller,
  createLiveCostExplorerClient,
  normalizeCostAndUsage,
  type CostAndUsageResponse,
} from './costExplorer.js';

function ceResponse(days: readonly (readonly [string, string])[]): CostAndUsageResponse {
  return {
    resultsByTime: days.map(([start, amount]) => ({
      timePeriod: { start, end: start },
      total: { unblendedCost: { amount, unit: 'USD' } },
    })),
  };
}

describe('Cost Explorer poller (fake client)', () => {
  it('lands authoritative daily actuals rows (positive)', async () => {
    const store = await openEventsStore({ path: ':memory:' });
    let now = Date.parse('2026-07-04T06:00:00Z');
    const poller = createCostExplorerPoller({
      client: { getBedrockDailyCost: async () => ceResponse([['2026-07-02', '1.25'], ['2026-07-03', '0.80']]) },
      events: store.events,
      account: 'AWS_DEV',
      nowMs: () => now,
    });
    expect(poller.freshness()).toBe('estimate-only'); // honest until a poll lands
    expect(await poller.poll()).toBe(2);
    expect(poller.freshness()).toBe('actuals');
    const rows = store.events.list();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.source).toBe('bedrock-cost-explorer');
    expect(rows[0]?.costActualUsd).toBe(1.25);
    expect(rows[0]?.rawRef).toBe('bedrock-ce:2026-07-02');
    store.close();
  });

  it('re-poll BACKFILLS cost_actual_usd only — estimate and raw untouched (edge)', async () => {
    const store = await openEventsStore({ path: ':memory:' });
    // A pre-existing estimate row for the same day key would be a different
    // raw_ref; the backfill contract is proven on the CE day row itself:
    let now = Date.parse('2026-07-04T06:00:00Z');
    let usd = '1.25';
    const poller = createCostExplorerPoller({
      client: { getBedrockDailyCost: async () => ceResponse([['2026-07-02', usd]]) },
      events: store.events,
      account: 'AWS_DEV',
      minIntervalMs: 1_000,
      nowMs: () => now,
    });
    await poller.poll();
    // Estimate lives on a DIFFERENT row (client-side estimate from SSE) and
    // must survive the authoritative backfill untouched.
    store.events.insert({
      tsMs: 1,
      backend: 'opencode',
      account: 'AWS_DEV',
      source: 'opencode-sse',
      eventType: 'message.updated',
      rawRef: 'evt_synth_est_1',
      costEstimatedUsd: 0.054,
    });

    usd = '1.31'; // Cost Explorer revised the day (~24 h lag settles)
    now += 2_000;
    await poller.poll();

    const dayRow = store.events.getByRawRef('opencode', 'bedrock-ce:2026-07-02');
    expect(dayRow?.costActualUsd).toBe(1.31); // actual updated
    expect(dayRow?.costEstimatedUsd).toBeUndefined(); // estimate column untouched
    const estimateRow = store.events.getByRawRef('opencode', 'evt_synth_est_1');
    expect(estimateRow?.costEstimatedUsd).toBe(0.054); // raw estimate intact
    expect(estimateRow?.costActualUsd).toBeUndefined();
    expect(poller.stats().daysBackfilled).toBe(1);
    store.close();
  });

  it('enforces the 1–2×/day floor (edge)', async () => {
    const store = await openEventsStore({ path: ':memory:' });
    let calls = 0;
    let now = 0;
    const poller = createCostExplorerPoller({
      client: {
        getBedrockDailyCost: async () => {
          calls += 1;
          return ceResponse([]);
        },
      },
      events: store.events,
      account: 'AWS_DEV',
      nowMs: () => now,
    });
    await poller.poll();
    now = 6 * 60 * 60 * 1000; // 6 h — under the 12 h default floor
    await poller.poll();
    expect(calls).toBe(1);
    expect(poller.stats().skippedNotDue).toBe(1);
    now = 13 * 60 * 60 * 1000;
    await poller.poll();
    expect(calls).toBe(2);
    store.close();
  });

  it('normalizer skips malformed day entries', () => {
    expect(
      normalizeCostAndUsage({
        resultsByTime: [
          { timePeriod: { start: 'not-a-date', end: '' }, total: { unblendedCost: { amount: '1' } } },
          { timePeriod: { start: '2026-07-02', end: '' }, total: { unblendedCost: { amount: 'NaN' } } },
          { timePeriod: { start: '2026-07-03', end: '' }, total: { unblendedCost: { amount: '2.5' } } },
        ],
      }),
    ).toEqual([{ date: '2026-07-03', usd: 2.5 }]);
  });

  it('refuses the wrong label and the live client without the opt-in (negative)', async () => {
    const store = await openEventsStore({ path: ':memory:' });
    expect(() =>
      createCostExplorerPoller({
        client: { getBedrockDailyCost: async () => ceResponse([]) },
        events: store.events,
        account: 'MAX_A',
      }),
    ).toThrowError(/opencode/);
    expect(() =>
      createLiveCostExplorerClient({
        enableLiveAws: false,
        callGetCostAndUsage: async () => ceResponse([]),
      }),
    ).toThrowError(LiveAwsDisabledError);
    store.close();
  });
});

const SAMPLE: BedrockMetricSample = {
  modelId: 'us.anthropic.claude-synth-4',
  periodStartMs: 1_767_225_600_000,
  periodSeconds: 300,
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 50,
  cacheWriteTokens: 25,
  invocations: 4,
  throttles: 2,
  avgLatencyMs: 900.4,
  avgTtftMs: 210.7,
};

describe('CloudWatch AWS/Bedrock poller (fake client)', () => {
  it('normalizes a sample into a usage row + a throttle row (positive)', () => {
    const rows = normalizeBedrockSample('AWS_DEV', SAMPLE);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      source: 'bedrock-cloudwatch',
      eventType: 'bedrock_usage_period',
      model: 'us.anthropic.claude-synth-4',
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheCreationTokens: 25,
      latencyMs: 900,
      ttftMs: 211,
    });
    expect(rows[1]).toMatchObject({
      eventType: 'bedrock_throttle_period',
      ok: false,
      errorKind: 'throttle',
    });
  });

  it('polls only while ACTIVE and within the 5–15 min band (edge)', async () => {
    const store = await openEventsStore({ path: ':memory:' });
    let calls = 0;
    let now = 0;
    let active = false;
    const poller = createCloudWatchPoller({
      client: {
        fetchBedrockSamples: async () => {
          calls += 1;
          return [SAMPLE];
        },
      },
      events: store.events,
      account: 'AWS_DEV',
      isActive: () => active,
      nowMs: () => now,
    });
    await poller.poll();
    expect(calls).toBe(0); // idle harness never accrues API charges
    expect(poller.stats().skippedInactive).toBe(1);

    active = true;
    expect(await poller.poll()).toBe(2);
    now = 2 * 60 * 1000; // under the 5 min floor
    await poller.poll();
    expect(calls).toBe(1);
    now = 6 * 60 * 1000;
    await poller.poll();
    expect(calls).toBe(2);
    // Overlapping lookbacks dedupe on the (model, period) raw_ref.
    expect(store.events.list()).toHaveLength(2);
    expect(poller.stats().rowsDeduped).toBe(2);
    store.close();
  });

  it('refuses the live client without the opt-in (negative)', () => {
    expect(() =>
      createLiveCloudWatchClient({ enableLiveAws: false, callGetMetricData: async () => [] }),
    ).toThrowError(LiveAwsDisabledError);
  });
});
