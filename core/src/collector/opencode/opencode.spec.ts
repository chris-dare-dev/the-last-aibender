/**
 * BE-5 sources 4+5 suite (plan §9.2 BE-5 rows; M3 DoD):
 *   positive — live SSE events deduped strictly on evt_ ids (re-emit is a
 *              no-op); message metrics land (cost/tokens/latency)
 *   negative — unknown SSE event ignored SILENTLY; credential-table reads
 *              impossible through the consumed guard [X2]
 *   edge     — SSE gap → after=<seq> replay heals exactly (induced
 *              disconnect against the testkit mock); db scrape reconciles
 *              to IDENTICAL evt_ ids
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openEventsStore, type EventsStore } from '@aibender/schema';
import { buildFakeOpencodeDb, startMockOpencodeServer, type MockOpencodeServer } from '@aibender/testkit';

import { createOpencodeSseTransport, type OpencodeSseTransport } from '../../adapters/opencode/sse.js';
import { ForbiddenDbStatementError } from '../../adapters/errors.js';
import { openOpencodeDbReadOnly } from '../../adapters/opencode/dbAccess.js';
import { createOpencodeDbScraper } from './dbScrape.js';
import { normalizeLiveOpencodeEvent } from './normalize.js';
import { createOpencodeSseCollector, type OpencodeSseCollector } from './sseSource.js';

const PASSWORD = 'synthetic-serve-password';
const AUTH = `Basic ${Buffer.from(`opencode:${PASSWORD}`, 'utf8').toString('base64')}`;

const MESSAGE_PROPS = {
  info: {
    sessionID: 'ses_synth00000001',
    role: 'assistant',
    cost: 0.054208,
    tokens: { total: 9496, input: 9424, output: 72, reasoning: 0, cache: { write: 0, read: 0 } },
    modelID: 'openai.gpt-synth',
    providerID: 'amazon-bedrock',
    time: { created: 1_783_097_463_410, completed: 1_783_097_465_291 },
  },
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(10);
  }
}

describe('normalizeLiveOpencodeEvent', () => {
  it('maps message.updated metrics (cost, token split incl. reasoning/cache, latency)', () => {
    const outcome = normalizeLiveOpencodeEvent({
      account: 'AWS_DEV',
      id: 'evt_synth00000042',
      type: 'message.updated',
      properties: MESSAGE_PROPS,
      fallbackTsMs: 0,
    });
    if (outcome.kind !== 'row') throw new Error('expected row');
    expect(outcome.row).toMatchObject({
      backend: 'opencode',
      account: 'AWS_DEV',
      source: 'opencode-sse',
      rawRef: 'evt_synth00000042',
      nativeSessionId: 'ses_synth00000001',
      model: 'openai.gpt-synth',
      provider: 'amazon-bedrock',
      costEstimatedUsd: 0.054208,
      inputTokens: 9424,
      outputTokens: 72,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      latencyMs: 1_881,
      tsMs: 1_783_097_463_410,
    });
  });

  it('ignores unknown event types SILENTLY (heartbeats mint no rows)', () => {
    expect(
      normalizeLiveOpencodeEvent({
        account: 'AWS_DEV',
        id: 'evt_synth00000001',
        type: 'server.heartbeat',
        properties: {},
        fallbackTsMs: 0,
      }).kind,
    ).toBe('ignored');
  });
});

describe('createOpencodeSseCollector against the testkit mock server', () => {
  let server: MockOpencodeServer;
  let transport: OpencodeSseTransport;
  let collector: OpencodeSseCollector;
  let store: EventsStore;
  let running: Promise<void>;

  beforeEach(async () => {
    store = await openEventsStore({ path: ':memory:' });
    server = await startMockOpencodeServer({ password: PASSWORD });
    transport = createOpencodeSseTransport({
      baseUrl: server.url,
      authHeader: AUTH,
      reconnectInitialMs: 5,
      reconnectMaxMs: 20,
    });
    collector = createOpencodeSseCollector({
      transport,
      events: store.events,
      account: 'AWS_DEV',
      nowMs: () => 42,
    });
    running = collector.start();
    await waitFor(() => server.sseClientCount() === 1);
  });

  afterEach(async () => {
    collector.close();
    transport.close();
    await server.close();
    await running.catch(() => undefined);
    store.close();
  });

  it('refuses non-opencode labels (programmer error)', () => {
    expect(() =>
      createOpencodeSseCollector({ transport, events: store.events, account: 'MAX_A' }),
    ).toThrowError(/opencode/);
  });

  it('ingests live events once; a verbatim re-emit dedupes on the evt_ id', async () => {
    server.emitBusEvent({ type: 'message.updated', properties: MESSAGE_PROPS });
    await waitFor(() => store.events.list().length === 1);
    server.reemitLast(); // at-least-once wire delivery
    await sleep(50);
    expect(store.events.list()).toHaveLength(1); // strict evt_ dedupe
    expect(collector.stats().ignoredEvents).toBeGreaterThanOrEqual(1); // server.connected
  });

  it('SSE gap → after=<seq> replay heals EXACTLY (induced disconnect)', async () => {
    const sid = 'ses_synth00000001';
    // Two durable events while connected.
    server.emitBusEvent({
      type: 'message.updated',
      properties: MESSAGE_PROPS,
      durable: { aggregateId: sid },
    });
    server.emitBusEvent({
      type: 'message.updated',
      properties: { info: { ...MESSAGE_PROPS.info, cost: 0.06 } },
      durable: { aggregateId: sid },
    });
    await waitFor(() => store.events.list().length === 2);
    // A benign extra event forces one more consumer pass so the collector's
    // watermark snapshot includes BOTH sync wrappers deterministically.
    server.emitHeartbeat();
    await waitFor(() => collector.healedSeq(sid) === 1);

    // Induce the disconnect; events emitted now are LOST from /global/event.
    server.dropConnections();
    server.emitBusEvent({
      type: 'message.updated',
      properties: { info: { ...MESSAGE_PROPS.info, cost: 0.07 } },
      durable: { aggregateId: sid },
    });
    server.emitBusEvent({
      type: 'message.updated',
      properties: { info: { ...MESSAGE_PROPS.info, cost: 0.08 } },
      durable: { aggregateId: sid },
    });
    expect(store.events.list()).toHaveLength(2); // the gap is real

    // Transport reconnects on its own; then the collector repairs.
    await waitFor(() => server.sseClientCount() === 1);
    const healedRows = await collector.repairGaps();
    expect(healedRows).toBe(2); // EXACTLY the missed slots — no more, no less

    const rows = store.events.list();
    expect(rows).toHaveLength(4);
    // The healed rows carry replay-stable durable raw_refs for seqs 2 and 3.
    const durableRefs = rows.filter((row) => row.rawRef.startsWith('oc-durable:'));
    expect(durableRefs.map((row) => row.rawRef).sort()).toEqual([
      `oc-durable:${sid}:2`,
      `oc-durable:${sid}:3`,
    ]);
    // Healing again is a no-op (replay-safe).
    expect(await collector.repairGaps()).toBe(0);
    expect(store.events.list()).toHaveLength(4);
  });

  it('sync correlation covers a slot WITHOUT a follow-up event (one-chunk window closed)', async () => {
    const sid = 'ses_synth_window';
    server.emitBusEvent({
      type: 'message.updated',
      properties: { info: { ...MESSAGE_PROPS.info, sessionID: sid } },
      durable: { aggregateId: sid },
    });
    await waitFor(() => store.events.list().length === 1);
    // NO extra event after this one. Pre-hardening, the healed watermark
    // waited for the NEXT consumer pass (the documented one-chunk
    // at-least-once window); the transport's onSync correlation now marks
    // the slot covered as soon as both twins have been seen.
    await waitFor(() => collector.healedSeq(sid) === 0);
    // Repair replays after=0 → empty: the live row is NOT re-delivered
    // under an oc-durable: raw_ref.
    expect(await collector.repairGaps()).toBe(0);
    const rows = store.events.list();
    expect(rows).toHaveLength(1);
    expect(rows.filter((row) => row.rawRef.startsWith('oc-durable:'))).toHaveLength(0);
  });
});

describe('createOpencodeDbScraper (fake db builder)', () => {
  let dir: string;
  let store: EventsStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aibender-ocdb-'));
    store = await openEventsStore({ path: ':memory:' });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('scrapes durable events read-only and reconciles to IDENTICAL evt_ ids', async () => {
    const path = join(dir, 'opencode.db');
    buildFakeOpencodeDb({
      path,
      sessions: [
        { sessionId: 'ses_synth00000001', eventTypes: ['session.created', 'message.updated'] },
      ],
    });
    const db = openOpencodeDbReadOnly({ path });
    const scraper = createOpencodeDbScraper({
      db,
      events: store.events,
      account: 'AWS_DEV',
      nowMs: () => 42,
    });

    // Simulate the SSE stream having already ingested the FIRST event under
    // its evt_ id (the fake builder's ids are deterministic).
    store.events.insert({
      tsMs: 1,
      backend: 'opencode',
      account: 'AWS_DEV',
      source: 'opencode-sse',
      eventType: 'session.created',
      rawRef: 'evt_synthdb00000001',
    });

    expect(scraper.scrape()).toBe(1); // only the second row is new
    expect(scraper.stats().rowsReconciled).toBe(1); // identical-id reconcile
    const rows = store.events.list();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.rawRef).sort()).toEqual([
      'evt_synthdb00000001',
      'evt_synthdb00000002',
    ]);
    // A re-scrape is a full dedupe no-op.
    expect(scraper.scrape()).toBe(0);
    db.close();
  });

  it('the consumed guard still refuses credential-table reads [X2] (negative)', () => {
    const path = join(dir, 'opencode.db');
    buildFakeOpencodeDb({ path, sessions: [] });
    const db = openOpencodeDbReadOnly({ path });
    expect(() => db.select('SELECT secret FROM credential')).toThrowError(
      ForbiddenDbStatementError,
    );
    expect(() => db.select('SELECT email FROM account')).toThrowError(ForbiddenDbStatementError);
    db.close();
  });
});
