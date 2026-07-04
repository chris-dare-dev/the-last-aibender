/**
 * Mock OpenCode serve HTTP server (plan §3 testkit deliverable: "mock
 * OpenCode /global/event SSE server" — promoted from
 * core/src/adapters/testing/ via ICR-0008, the ICR-0001 path).
 *
 * Real HTTP over 127.0.0.1 (node:http) so the adapters exercise their real
 * fetch/SSE paths. Faithful to the probed v1.17.13 behavior
 * (docs/research/findings/opencode-serve-event-probe.md):
 *   - HTTP Basic auth (`opencode:<password>`) — 401 without/with wrong pw;
 *   - `GET /global/event`: per-connection `server.connected` (fresh evt_ id),
 *     scripted bus events with monotonic `evt_` ids, DOUBLE DELIVERY of
 *     durable events (plain + `type:"sync"` wrapper), `server.heartbeat`
 *     injection, unknown-event injection, forced disconnects;
 *   - `GET /api/session/{id}/event?after=<seq>`: durable replay with SSE
 *     `id:`/`event:` fields, then the stream stays open (like the real
 *     server) unless `closeReplayAfterCatchUp` is set;
 *   - `GET /global/health` → `{healthy:true, version:"<synthetic>"}`;
 *   - `POST /session` → synthesized Session JSON echoing `parentID` [X4].
 *
 * FIXTURE POLICY [X2]: every id/value synthesized (`evt_synth…`,
 * `ses_synth…`); no real directories, accounts, or tokens.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Options / shapes
// ---------------------------------------------------------------------------

export interface MockOpencodeServerOptions {
  readonly password: string;
  /** Reported by /global/health. Default `1.17.13-synthetic`. */
  readonly version?: string;
  /** Close each replay stream once scripted events are sent. Default true. */
  readonly closeReplayAfterCatchUp?: boolean;
  /**
   * Accept ANY well-formed Basic header (supervisor handle tests: the
   * per-boot password is closure-hidden by design, so the test cannot know
   * it). Requests with no Authorization at all still answer 401.
   */
  readonly acceptAnyBasicAuth?: boolean;
}

export interface MockBusEventInput {
  readonly type: string;
  readonly properties?: unknown;
  /** Directory envelope value; omit to mimic stream-synthesized events. */
  readonly directory?: string;
  /** Durable events get a sync-wrapper twin. */
  readonly durable?: { readonly aggregateId: string; readonly version?: number };
  /** Override the generated evt_ id (duplicate-delivery tests). */
  readonly id?: string;
}

export interface MockDurableSessionEvent {
  readonly sessionId: string;
  readonly seq: number;
  readonly type: string;
  readonly data?: unknown;
}

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorized: boolean;
  readonly body?: unknown;
}

export interface MockOpencodeServer {
  readonly url: string;
  readonly port: number;
  /** Emit one bus event to every connected /global/event client. */
  emitBusEvent(event: MockBusEventInput): string;
  /** Re-send a previously emitted event verbatim (at-least-once delivery). */
  reemitLast(): void;
  emitHeartbeat(): void;
  /** Raw SSE injection (malformed-payload tolerance tests). */
  emitRaw(data: string): void;
  /** Script the durable log served by /api/session/{id}/event. */
  addDurableEvents(...events: readonly MockDurableSessionEvent[]): void;
  /** Sever every open SSE connection (reconnect tests). */
  dropConnections(): void;
  /** Number of currently attached /global/event clients. */
  sseClientCount(): number;
  readonly requests: readonly RecordedRequest[];
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

let evtCounter = 0;
const nextEvtId = (): string => `evt_synth${String((evtCounter += 1)).padStart(8, '0')}`;

export async function startMockOpencodeServer(
  options: MockOpencodeServerOptions,
): Promise<MockOpencodeServer> {
  const version = options.version ?? '1.17.13-synthetic';
  const closeReplay = options.closeReplayAfterCatchUp ?? true;
  const expectedAuth = `Basic ${Buffer.from(`opencode:${options.password}`, 'utf8').toString('base64')}`;

  const sseClients = new Set<ServerResponse>();
  const durableLog: MockDurableSessionEvent[] = [];
  const requests: RecordedRequest[] = [];
  let lastWire: string[] = [];
  let sessionCounter = 0;

  const isAuthorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization;
    if (options.acceptAnyBasicAuth === true) {
      return typeof header === 'string' && header.startsWith('Basic ');
    }
    return header === expectedAuth;
  };

  const sendSse = (res: ServerResponse, data: string, fields?: { id?: string; event?: string }): void => {
    let frame = '';
    if (fields?.id !== undefined) frame += `id: ${fields.id}\n`;
    if (fields?.event !== undefined) frame += `event: ${fields.event}\n`;
    frame += `data: ${data}\n\n`;
    res.write(frame);
  };

  const broadcast = (payloads: readonly string[]): void => {
    for (const client of sseClients) {
      for (const payload of payloads) sendSse(client, payload);
    }
  };

  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const authorized = isAuthorized(req);
      const url = req.url ?? '';
      const method = req.method ?? 'GET';
      const body = method === 'POST' ? await readBody(req) : undefined;
      requests.push({ method, url, authorized, ...(body !== undefined ? { body } : {}) });

      if (!authorized) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('Unauthorized');
        return;
      }

      if (method === 'GET' && url === '/global/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ healthy: true, version }));
        return;
      }

      if (method === 'GET' && url === '/global/event') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        sseClients.add(res);
        res.once('close', () => sseClients.delete(res));
        // Per-connection server.connected with a FRESH id (probe §2).
        sendSse(
          res,
          JSON.stringify({ payload: { id: nextEvtId(), type: 'server.connected', properties: {} } }),
        );
        return;
      }

      const replayMatch = /^\/api\/session\/([^/?]+)\/event\?after=(\d+)$/.exec(url);
      if (method === 'GET' && replayMatch !== null) {
        const sessionId = decodeURIComponent(replayMatch[1] ?? '');
        const after = Number(replayMatch[2]);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of durableLog) {
          if (event.sessionId !== sessionId || event.seq <= after) continue;
          sendSse(
            res,
            JSON.stringify({
              id: nextEvtId(),
              type: event.type,
              durable: { aggregateID: event.sessionId, seq: event.seq, version: 1 },
              data: event.data ?? {},
            }),
            { id: String(event.seq), event: event.type },
          );
        }
        if (closeReplay) res.end();
        // else: stream stays open like the real durable stream.
        return;
      }

      if (method === 'POST' && url.startsWith('/session')) {
        sessionCounter += 1;
        const record = (typeof body === 'object' && body !== null ? body : {}) as Record<
          string,
          unknown
        >;
        const id = `ses_synth${String(sessionCounter).padStart(8, '0')}`;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id,
            projectID: 'prj_synth00000001',
            directory: '/synthetic/workspace',
            ...(typeof record['parentID'] === 'string' ? { parentID: record['parentID'] } : {}),
            title: typeof record['title'] === 'string' ? record['title'] : 'synthesized session',
            version: version,
            time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
          }),
        );
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    })().catch(() => {
      res.destroy();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('mock opencode server did not bind a port');
  }
  const port = address.port;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    port,
    emitBusEvent: (event) => {
      const id = event.id ?? nextEvtId();
      const envelopeBase = {
        ...(event.directory !== undefined
          ? { directory: event.directory, project: 'global' }
          : {}),
      };
      const wire: string[] = [
        JSON.stringify({
          ...envelopeBase,
          payload: { id, type: event.type, properties: event.properties ?? {} },
        }),
      ];
      if (event.durable !== undefined) {
        // Double delivery: the sync wrapper mirrors the durable store row.
        const seq =
          durableLog.filter((d) => d.sessionId === event.durable?.aggregateId).length;
        durableLog.push({
          sessionId: event.durable.aggregateId,
          seq,
          type: `${event.type}.${String(event.durable.version ?? 1)}`,
          data: event.properties ?? {},
        });
        wire.push(
          JSON.stringify({
            ...envelopeBase,
            payload: {
              type: 'sync',
              id,
              syncEvent: {
                id,
                type: `${event.type}.${String(event.durable.version ?? 1)}`,
                seq,
                aggregateID: event.durable.aggregateId,
                data: event.properties ?? {},
              },
            },
          }),
        );
      }
      lastWire = wire;
      broadcast(wire);
      return id;
    },
    reemitLast: () => broadcast(lastWire),
    emitHeartbeat: () =>
      broadcast([
        JSON.stringify({ payload: { id: nextEvtId(), type: 'server.heartbeat', properties: {} } }),
      ]),
    emitRaw: (data) => broadcast([data]),
    addDurableEvents: (...events) => {
      durableLog.push(...events);
    },
    dropConnections: () => {
      for (const client of sseClients) client.destroy();
      sseClients.clear();
    },
    sseClientCount: () => sseClients.size,
    requests,
    close: async () => {
      for (const client of sseClients) client.destroy();
      sseClients.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
