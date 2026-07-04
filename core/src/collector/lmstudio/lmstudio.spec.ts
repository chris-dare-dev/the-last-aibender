/**
 * BE-5 source 7 suite — LM Studio inline usage capture, consuming BE-4's
 * real /v1 client against the testkit fake server:
 *   positive — a routed chat lands one events row (tokens, latency, $0)
 *   negative — down-state passes through and mints NO row (freshness is
 *              BE-6's concern, never an error row)
 *   edge     — repeated captures stay unique (raw_ref counter)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openEventsStore, type EventsStore } from '@aibender/schema';
import { startFakeLmStudioServer, type FakeLmStudioServer } from '@aibender/testkit';

import { createLmStudioClient } from '../../adapters/lmstudio/client.js';
import { createLmStudioUsageCapture, instrumentLmStudioClient } from './usageCapture.js';

describe('LM Studio inline usage capture', () => {
  let server: FakeLmStudioServer;
  let store: EventsStore;

  beforeEach(async () => {
    server = await startFakeLmStudioServer();
    server.addModel({ key: 'synth-8b-q4', state: 'not-loaded' });
    store = await openEventsStore({ path: ':memory:' });
  });
  afterEach(async () => {
    await server.close();
    store.close();
  });

  it('captures one row per routed /v1 call through the instrumented client', async () => {
    const capture = createLmStudioUsageCapture({ events: store.events, nowMs: () => 4242 });
    const client = instrumentLmStudioClient(
      createLmStudioClient({ baseUrl: server.url, timeoutMs: 2_000 }),
      capture,
    );

    const result = await client.chat({
      model: 'synth-8b-q4',
      messages: [{ role: 'user', content: 'synthesized prompt' }],
    });
    expect(result.state).toBe('ok');

    const rows = store.events.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      backend: 'lmstudio',
      account: 'LOCAL',
      source: 'lmstudio',
      eventType: 'chat_completion',
      costEstimatedUsd: 0, // $0 marginal — the local-offload ratio input
    });
    expect(rows[0]?.inputTokens).toBeGreaterThanOrEqual(0);
    expect(rows[0]?.outputTokens).toBeGreaterThanOrEqual(0);
    expect(rows[0]?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(capture.stats().captures).toBe(1);
  });

  it('down-state passes through unchanged and mints NO row (negative)', async () => {
    const capture = createLmStudioUsageCapture({ events: store.events });
    const client = instrumentLmStudioClient(
      createLmStudioClient({ baseUrl: server.url, timeoutMs: 2_000 }),
      capture,
    );
    server.failNextChat('socket'); // down mid-request (the BE-4 edge)
    const result = await client.chat({
      model: 'synth-8b-q4',
      messages: [{ role: 'user', content: 'synthesized prompt' }],
    });
    expect(result.state).toBe('down');
    expect(store.events.list()).toHaveLength(0);
    expect(capture.stats().captures).toBe(0);
  });

  it('repeated captures at the same instant stay unique (edge)', async () => {
    const capture = createLmStudioUsageCapture({ events: store.events, nowMs: () => 7 });
    for (let i = 0; i < 3; i += 1) {
      capture.capture({
        content: 'synthesized',
        model: 'synth-8b-q4',
        durationMs: 10,
        ttlSeconds: 1800,
        usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
      });
    }
    expect(store.events.list()).toHaveLength(3);
  });
});
