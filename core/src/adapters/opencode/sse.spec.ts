import { startMockOpencodeServer, type MockOpencodeServer } from '@aibender/testkit';
import { describe, expect, it } from 'vitest';

import { serveBasicAuthHeader } from './password.js';
import {
  createOpencodeSseTransport,
  parseSseStream,
  type OpencodeEvent,
  type OpencodeSseTransport,
} from './sse.js';

const PASSWORD = 'synthetic-sse-password';

async function withMock(
  run: (mock: MockOpencodeServer, transport: OpencodeSseTransport) => Promise<void>,
): Promise<void> {
  const mock = await startMockOpencodeServer({ password: PASSWORD });
  const transport = createOpencodeSseTransport({
    baseUrl: mock.url,
    authHeader: serveBasicAuthHeader(PASSWORD),
    sleepFn: async () => undefined, // instant reconnect in tests
  });
  try {
    await run(mock, transport);
  } finally {
    transport.close();
    await mock.close();
  }
}

/** Wait until the mock sees `count` attached SSE clients. */
async function untilClients(mock: MockOpencodeServer, count: number): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (mock.sseClientCount() === count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`mock never reached ${String(count)} sse client(s)`);
}

/** Poll a condition (pump-side effects land asynchronously to the consumer). */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(what);
}

/** Collect events from an iterator until the predicate says stop. */
async function collectUntil(
  iterator: AsyncIterator<OpencodeEvent>,
  done: (events: OpencodeEvent[]) => boolean,
): Promise<OpencodeEvent[]> {
  const events: OpencodeEvent[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done === true) return events;
    events.push(next.value);
    if (done(events)) return events;
  }
}

describe('parseSseStream', () => {
  const streamOf = (text: string): AsyncIterable<Uint8Array> => ({
    [Symbol.asyncIterator]: async function* () {
      // Deliberately tiny chunks: parsing must survive arbitrary splits.
      for (const char of text) yield new TextEncoder().encode(char);
    },
  });

  it('parses data/event/id fields, multi-line data, comments and CRLF', async () => {
    const messages = [];
    const wire =
      ': heartbeat comment\r\n' +
      'id: 7\r\nevent: session.next.step.ended\r\ndata: {"a":1,\r\ndata: "b":2}\r\n\r\n' +
      'data: plain\n\n';
    for await (const message of parseSseStream(streamOf(wire))) messages.push(message);
    expect(messages).toEqual([
      { id: '7', event: 'session.next.step.ended', data: '{"a":1,\n"b":2}' },
      { data: 'plain' },
    ]);
  });

  it('dispatches a trailing message without a final blank line', async () => {
    const messages = [];
    for await (const message of parseSseStream(streamOf('data: tail'))) messages.push(message);
    expect(messages).toEqual([{ data: 'tail' }]);
  });
});

describe('opencode SSE transport (probe contract: dedupe/sync/unknown/replay)', () => {
  // -- positive ---------------------------------------------------------------

  it('connects to /global/event and yields enveloped events', async () => {
    await withMock(async (mock, transport) => {
      const iterator = transport.events()[Symbol.asyncIterator]();
      await untilClients(mock, 1);
      mock.emitBusEvent({
        type: 'session.created',
        directory: '/synthetic/workspace',
        properties: { sessionID: 'ses_synth00000001' },
      });
      const events = await collectUntil(iterator, (all) =>
        all.some((event) => event.type === 'session.created'),
      );
      const created = events.find((event) => event.type === 'session.created');
      expect(created?.directory).toBe('/synthetic/workspace');
      expect(created?.id).toMatch(/^evt_synth/);
      expect(created?.properties).toEqual({ sessionID: 'ses_synth00000001' });
      // server.connected passed through first (unknown-type tolerance).
      expect(events[0]?.type).toBe('server.connected');
    });
  });

  it('dedupes strictly on the evt_ id across at-least-once delivery', async () => {
    await withMock(async (mock, transport) => {
      const iterator = transport.events()[Symbol.asyncIterator]();
      await untilClients(mock, 1);
      mock.emitBusEvent({ type: 'session.idle', properties: { sessionID: 'ses_a' } });
      mock.reemitLast(); // duplicate delivery, same evt_ id
      mock.emitBusEvent({ type: 'session.compacted', properties: { sessionID: 'ses_a' } });
      const events = await collectUntil(iterator, (all) =>
        all.some((event) => event.type === 'session.compacted'),
      );
      expect(events.filter((event) => event.type === 'session.idle')).toHaveLength(1);
      expect(transport.stats().deduped).toBeGreaterThanOrEqual(1);
    });
  });

  it('drops sync wrappers AFTER capturing seq watermarks; plain twin passes', async () => {
    await withMock(async (mock, transport) => {
      const iterator = transport.events()[Symbol.asyncIterator]();
      await untilClients(mock, 1);
      mock.emitBusEvent({
        type: 'session.created',
        durable: { aggregateId: 'ses_synth_wm', version: 1 },
        properties: { sessionID: 'ses_synth_wm' },
      });
      mock.emitBusEvent({
        type: 'session.updated',
        durable: { aggregateId: 'ses_synth_wm', version: 1 },
        properties: { sessionID: 'ses_synth_wm' },
      });
      const events = await collectUntil(iterator, (all) =>
        all.some((event) => event.type === 'session.updated'),
      );
      expect(events.filter((event) => event.type === 'sync')).toHaveLength(0);
      expect(events.filter((event) => event.type === 'session.created')).toHaveLength(1);
      expect(transport.watermark('ses_synth_wm')).toBe(1);
      expect(transport.stats().syncWrappersDropped).toBe(2);
    });
  });

  it('onSync fans the evt_↔seq correlation out at parse time (M3 stewarding ICR)', async () => {
    await withMock(async (mock, transport) => {
      const seen: { aggregateId: string; seq: number; eventId?: string }[] = [];
      const unsubscribe = transport.onSync((correlation) => seen.push(correlation));
      // A throwing observer must never kill the pump (tolerance clause).
      const unsubscribeThrowing = transport.onSync(() => {
        throw new Error('observer bug — must be swallowed');
      });
      const iterator = transport.events()[Symbol.asyncIterator]();
      await untilClients(mock, 1);
      const eventId = mock.emitBusEvent({
        type: 'session.created',
        durable: { aggregateId: 'ses_synth_corr', version: 1 },
        properties: { sessionID: 'ses_synth_corr' },
      });
      await collectUntil(iterator, (all) => all.some((e) => e.type === 'session.created'));
      // The sync twin is co-delivered; poll briefly for its parse.
      await until(() => seen.length === 1, 'sync correlation never observed');
      expect(seen).toEqual([{ aggregateId: 'ses_synth_corr', seq: 0, eventId }]);
      unsubscribe();
      unsubscribeThrowing();
      mock.emitBusEvent({
        type: 'session.updated',
        durable: { aggregateId: 'ses_synth_corr', version: 1 },
        properties: { sessionID: 'ses_synth_corr' },
      });
      await collectUntil(iterator, (all) => all.some((e) => e.type === 'session.updated'));
      await until(
        () => transport.watermark('ses_synth_corr') === 1,
        'second sync wrapper never captured',
      );
      expect(seen).toHaveLength(1); // unsubscribed — no further fan-out
    });
  });

  it('sync-first arrival still lets the plain twin through (order edge)', async () => {
    await withMock(async (mock, transport) => {
      const iterator = transport.events()[Symbol.asyncIterator]();
      await untilClients(mock, 1);
      // Handcraft the wire: sync wrapper FIRST, then the plain event, same id.
      mock.emitRaw(
        JSON.stringify({
          payload: {
            type: 'sync',
            id: 'evt_synth_order_edge',
            syncEvent: {
              id: 'evt_synth_order_edge',
              type: 'session.created.1',
              seq: 0,
              aggregateID: 'ses_synth_edge',
              data: {},
            },
          },
        }),
      );
      mock.emitRaw(
        JSON.stringify({
          payload: { id: 'evt_synth_order_edge', type: 'session.created', properties: {} },
        }),
      );
      const events = await collectUntil(iterator, (all) =>
        all.some((event) => event.type === 'session.created'),
      );
      expect(events.filter((event) => event.id === 'evt_synth_order_edge')).toHaveLength(1);
      expect(transport.watermark('ses_synth_edge')).toBe(0);
    });
  });

  it('tolerates heartbeats, unknown event types and malformed payloads', async () => {
    await withMock(async (mock, transport) => {
      const iterator = transport.events()[Symbol.asyncIterator]();
      await untilClients(mock, 1);
      mock.emitHeartbeat();
      mock.emitBusEvent({ type: 'totally.new.event.kind.99', properties: { synthetic: true } });
      mock.emitRaw('this is not json at all');
      mock.emitRaw(JSON.stringify({ payload: { properties: {} } })); // typeless
      mock.emitBusEvent({ type: 'session.idle', properties: { sessionID: 'ses_t' } });
      const events = await collectUntil(iterator, (all) =>
        all.some((event) => event.type === 'session.idle'),
      );
      expect(events.some((event) => event.type === 'server.heartbeat')).toBe(true);
      expect(events.some((event) => event.type === 'totally.new.event.kind.99')).toBe(true);
      expect(transport.stats().malformedDropped).toBe(2);
    });
  });

  // -- edge: reconnect --------------------------------------------------------

  it('reconnects after a dropped connection and keeps yielding (no duplicates)', async () => {
    await withMock(async (mock, transport) => {
      const iterator = transport.events()[Symbol.asyncIterator]();
      await untilClients(mock, 1);
      mock.emitBusEvent({ type: 'session.idle', properties: { sessionID: 'ses_r' } });
      await collectUntil(iterator, (all) => all.some((event) => event.type === 'session.idle'));

      mock.dropConnections();
      await untilClients(mock, 1); // transport reconnected on its own
      mock.emitBusEvent({ type: 'session.compacted', properties: { sessionID: 'ses_r' } });
      const after = await collectUntil(iterator, (all) =>
        all.some((event) => event.type === 'session.compacted'),
      );
      expect(after.some((event) => event.type === 'session.compacted')).toBe(true);
      expect(transport.stats().connects).toBeGreaterThanOrEqual(2);
    });
  });

  // -- positive: after=<seq> durable replay ------------------------------------

  it('replaySession replays only durable events AFTER the watermark', async () => {
    await withMock(async (mock, transport) => {
      mock.addDurableEvents(
        { sessionId: 'ses_gap', seq: 0, type: 'session.created.1', data: { n: 0 } },
        { sessionId: 'ses_gap', seq: 1, type: 'message.updated.1', data: { n: 1 } },
        { sessionId: 'ses_gap', seq: 2, type: 'message.updated.1', data: { n: 2 } },
        { sessionId: 'ses_other', seq: 0, type: 'session.created.1', data: { n: 99 } },
      );
      const replayed = [];
      for await (const event of transport.replaySession('ses_gap', 0)) replayed.push(event);
      expect(replayed.map((event) => event.seq)).toEqual([1, 2]);
      expect(replayed[0]?.sseEvent).toBe('message.updated.1');
      expect(replayed[0]?.sseId).toBe('1');
    });
  });

  // -- negative ---------------------------------------------------------------

  it('supports exactly ONE live consumer', async () => {
    await withMock(async (mock, transport) => {
      const first = transport.events()[Symbol.asyncIterator]();
      await untilClients(mock, 1);
      expect(() => transport.events()).toThrow(/single consumer/);
      mock.emitBusEvent({ type: 'session.idle', properties: {} });
      await collectUntil(first, (all) => all.some((event) => event.type === 'session.idle'));
    });
  });

  it('close() ends the stream (after draining buffered events) and marks state closed', async () => {
    await withMock(async (mock, transport) => {
      const iterator = transport.events()[Symbol.asyncIterator]();
      await untilClients(mock, 1);
      transport.close();
      // Buffered events (server.connected) drain, then the stream ends.
      let done = false;
      for (let i = 0; i < 10 && !done; i += 1) {
        done = (await iterator.next()).done === true;
      }
      expect(done).toBe(true);
      expect(transport.state()).toBe('closed');
    });
  });

  it('bad auth never connects (401 loop stays internal, no events)', async () => {
    const mock = await startMockOpencodeServer({ password: PASSWORD });
    const transport = createOpencodeSseTransport({
      baseUrl: mock.url,
      authHeader: serveBasicAuthHeader('wrong-password'),
      sleepFn: async () => undefined,
    });
    try {
      const iterator = transport.events()[Symbol.asyncIterator]();
      const race = await Promise.race([
        iterator.next().then(() => 'event'),
        new Promise((resolve) => setTimeout(() => resolve('silence'), 100)),
      ]);
      expect(race).toBe('silence');
      expect(mock.sseClientCount()).toBe(0);
    } finally {
      transport.close();
      await mock.close();
    }
  });
});
