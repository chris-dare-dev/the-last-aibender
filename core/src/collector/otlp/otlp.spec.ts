/**
 * BE-5 source 3 suite (plan §9.2 BE-5 rows):
 *   positive — OTel account attribution from the harness-stamped resource
 *              attribute; api_request join with JSONL token truth
 *   negative — identity attrs dropped at ingest; label-less batch dropped,
 *              never guessed
 *   edge     — loopback-only bind; graceful port-in-use; protobuf 415;
 *              exporter batch retry dedupes (content-derived raw_ref)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openEventsStore, type EventsStore } from '@aibender/schema';
import {
  SYNTHETIC_OTLP_ACCOUNT_UUID,
  SYNTHETIC_OTLP_EMAIL,
  otlpApiRequestRecord,
  otlpAttr,
  otlpLogsBatch,
} from '@aibender/testkit';

import { createApiRequestJoiner, type ApiRequestJoiner } from '../ingest.js';
import { startOtlpReceiver, type OtlpReceiver } from './receiver.js';

// OTLP JSON batch builders: the promoted testkit "fake OTLP emitter"
// (ICR-0010). Identity drop-probe values are runtime-built there [X2].
const attr = otlpAttr;
const logsBatch = otlpLogsBatch;
const apiRequestRecord = otlpApiRequestRecord;
const RUNTIME_EMAIL = SYNTHETIC_OTLP_EMAIL;
const RUNTIME_ACCOUNT_UUID = SYNTHETIC_OTLP_ACCOUNT_UUID;

async function postJson(url: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('startOtlpReceiver', () => {
  let store: EventsStore;
  let joiner: ApiRequestJoiner;
  let receiver: OtlpReceiver;

  beforeEach(async () => {
    store = await openEventsStore({ path: ':memory:' });
    joiner = createApiRequestJoiner(store.events, { nowMs: () => 0, windowMs: 0 });
    receiver = await startOtlpReceiver({ events: store.events, joiner, port: 0 });
    expect(receiver.state).toBe('listening');
  });
  afterEach(async () => {
    await receiver.close();
    store.close();
  });

  // -- positive ---------------------------------------------------------------

  it('binds loopback-only (127.0.0.1 in the advertised URL)', () => {
    expect(receiver.url.startsWith('http://127.0.0.1:')).toBe(true);
  });

  it('attributes rows to the harness-stamped account resource attribute', async () => {
    const response = await postJson(
      receiver.url,
      '/v1/logs',
      logsBatch({
        resourceAttrs: [attr('account', 'MAX_A'), attr('service.name', 'claude-code')],
        records: [
          {
            timeUnixNano: String(1_767_225_600_000 * 1e6),
            attributes: [attr('event.name', 'user_prompt'), attr('session.id', 'synth-native-1')],
          },
        ],
      }),
    );
    expect(response.status).toBe(200);
    const rows = store.events.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.account).toBe('MAX_A');
    expect(rows[0]?.source).toBe('claude-otel');
    expect(rows[0]?.eventType).toBe('user_prompt');
    expect(rows[0]?.tsMs).toBe(1_767_225_600_000);
  });

  it('api_request records join with the JSONL half (OTel attribution wins)', async () => {
    joiner.offerJsonl({
      requestId: 'req_synth_0001',
      account: 'MAX_A',
      tsMs: 1_767_225_610_000,
      nativeSessionId: 'synth-native-1',
      usage: { inputTokens: 6, outputTokens: 244, cacheCreation1hTokens: 20_144 },
    });
    await postJson(
      receiver.url,
      '/v1/logs',
      logsBatch({ resourceAttrs: [attr('account', 'MAX_A')], records: [apiRequestRecord()] }),
    );
    const rows = store.events.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.inputTokens).toBe(6); // JSONL token truth
    expect(rows[0]?.cacheCreation1hTokens).toBe(20_144);
    expect(rows[0]?.skillName).toBe('synth-skill'); // OTel attribution
    expect(rows[0]?.costEstimatedUsd).toBe(0.42);
    expect(rows[0]?.latencyMs).toBe(1234);
  });

  // -- negative ---------------------------------------------------------------

  it('DROPS identity-bearing attributes at ingest [X2]', async () => {
    await postJson(
      receiver.url,
      '/v1/logs',
      logsBatch({ resourceAttrs: [attr('account', 'MAX_B')], records: [apiRequestRecord()] }),
    );
    joiner.flush(0); // land the unmatched half as an OTel-only row
    const rows = store.events.list();
    expect(rows).toHaveLength(1);
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain(RUNTIME_EMAIL);
    expect(serialized).not.toContain(RUNTIME_ACCOUNT_UUID);
  });

  it('drops batches without a valid account label — never guessed', async () => {
    const response = await postJson(
      receiver.url,
      '/v1/logs',
      logsBatch({
        resourceAttrs: [attr('service.name', 'claude-code')], // no account
        records: [apiRequestRecord()],
      }),
    );
    expect(response.status).toBe(200); // acked; ingestion never breaks the CLI
    expect(store.events.list()).toHaveLength(0);
    expect(receiver.stats().batchesDroppedNoLabel).toBe(1);
  });

  it('answers 400 on unparseable bodies and counts them', async () => {
    const response = await fetch(`${receiver.url}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{torn',
    });
    expect(response.status).toBe(400);
    expect(receiver.stats().malformedBodies).toBe(1);
  });

  // -- edge -------------------------------------------------------------------

  it('acks metrics/traces without ingesting (token truth rides the log events)', async () => {
    const metrics = await postJson(receiver.url, '/v1/metrics', { resourceMetrics: [] });
    const traces = await postJson(receiver.url, '/v1/traces', { resourceSpans: [] });
    expect(metrics.status).toBe(200);
    expect(traces.status).toBe(200);
    expect(store.events.list()).toHaveLength(0);
    expect(receiver.stats().metricsAcked).toBe(1);
    expect(receiver.stats().tracesAcked).toBe(1);
  });

  it('rejects protobuf bodies with 415 (SI-3 pins http/json) without crashing', async () => {
    const response = await fetch(`${receiver.url}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: Buffer.from([0x0a, 0x00]),
    });
    expect(response.status).toBe(415);
    expect(receiver.stats().protobufRejected).toBe(1);
  });

  it('an exporter batch RETRY dedupes on the content-derived raw_ref', async () => {
    const batch = logsBatch({
      resourceAttrs: [attr('account', 'ENT')],
      records: [
        {
          timeUnixNano: String(1_767_225_600_000 * 1e6),
          attributes: [attr('event.name', 'tool_decision'), attr('session.id', 'synth-native-2')],
        },
      ],
    });
    await postJson(receiver.url, '/v1/logs', batch);
    await postJson(receiver.url, '/v1/logs', batch); // the retry
    expect(store.events.list()).toHaveLength(1);
  });

  it('handles port-in-use gracefully (state, not a crash)', async () => {
    const second = await startOtlpReceiver({
      events: store.events,
      joiner,
      port: receiver.port, // already taken
    });
    expect(second.state).toBe('port-in-use');
    await second.close(); // safe no-op
  });
});
