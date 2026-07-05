/**
 * M4 workstream slice of the gateway (ICR-0011; ws-protocol.md §16):
 * merge-request routing (validate → engine port; absent-engine degrade),
 * `workstream-merge-resolved` fan-out, `publishWorkstream` validated
 * broadcast, and reconnect-replay on the workstream channel. Positive /
 * negative / edge per plan §9.2.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validateEnvelope,
  type Envelope,
  type WorkstreamMergeRequest,
  type WorkstreamMergeResolved,
} from '@aibender/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';

import { FakeKernel, FakeQueryRunner } from './fakeKernel.js';
import { KernelVerbError } from './kernel.js';
import type { WorkstreamEnginePort } from './ports.js';
import { startGateway, type GatewayHandle, type GatewayOptions } from './server.js';

const MERGE_PAYLOAD = {
  kind: 'workstream-merge-request',
  mergeId: 'mrg_01',
  params: {
    parents: ['ses_fake_1', 'ses_fake_2'],
    accountLabel: 'MAX_A',
    backend: 'claude_code',
    cwd: '/synthetic/workspace',
    purpose: 'spec merge',
    briefBody: 'merge brief: conflicts surfaced.',
  },
} as const;

class Client {
  readonly envelopes: Envelope[] = [];

  private constructor(private readonly ws: WsClient) {
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const validated = validateEnvelope(JSON.parse(String(data)));
      if (validated.ok) this.envelopes.push(validated.value);
    });
    ws.on('error', () => {});
  }

  static async connect(handle: GatewayHandle): Promise<Client> {
    const ws = new WsClient(`${handle.url}/?token=${handle.token}`);
    const client = new Client(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return client;
  }

  send(channel: string, seq: number, payload: unknown): void {
    this.ws.send(JSON.stringify({ stream: channel, channel, seq, payload }));
  }

  async waitFor(predicate: (envelope: Envelope) => boolean, timeoutMs = 2000): Promise<Envelope> {
    const start = Date.now();
    for (;;) {
      const hit = this.envelopes.find(predicate);
      if (hit !== undefined) return hit;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out; saw ${JSON.stringify(this.envelopes)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  close(): void {
    this.ws.close();
  }
}

function errorCode(envelope: Envelope): string | undefined {
  const payload = envelope.payload;
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (record['kind'] === 'error' && typeof record['code'] === 'string') return record['code'];
  }
  return undefined;
}

let home: string;
let handle: GatewayHandle;
const clients: Client[] = [];

async function boot(extra: Partial<GatewayOptions> = {}): Promise<void> {
  home = await mkdtemp(join(tmpdir(), 'aibender-gw-ws-'));
  handle = await startGateway({
    kernel: new FakeKernel(new FakeQueryRunner()),
    aibenderHome: home,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...extra,
  });
}

async function connect(): Promise<Client> {
  const client = await Client.connect(handle);
  clients.push(client);
  return client;
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await handle.close();
  await rm(home, { recursive: true, force: true });
});

describe('gateway workstream slice (M4, ICR-0011)', () => {
  // -- positive ---------------------------------------------------------------

  it('routes a valid merge request to the engine and fans out the resolution to ALL clients', async () => {
    const seen: WorkstreamMergeRequest[] = [];
    const engine: WorkstreamEnginePort = {
      merge: (request) => {
        seen.push(request);
        const resolved: WorkstreamMergeResolved = {
          kind: 'workstream-merge-resolved',
          mergeId: request.mergeId,
          sessionId: 'ses_fake_3',
          briefId: 'br_fake_1',
        };
        return Promise.resolve(resolved);
      },
    };
    await boot({ workstreams: engine });
    const decider = await connect();
    const observer = await connect();
    decider.send('workstream', 0, MERGE_PAYLOAD);

    const isResolved = (envelope: Envelope): boolean =>
      envelope.channel === 'workstream' &&
      typeof envelope.payload === 'object' &&
      envelope.payload !== null &&
      (envelope.payload as Record<string, unknown>)['kind'] === 'workstream-merge-resolved';
    await decider.waitFor(isResolved);
    await observer.waitFor(isResolved); // fan-out reaches every client
    expect(seen).toHaveLength(1);
    expect(seen[0]?.params.parents).toEqual(['ses_fake_1', 'ses_fake_2']);
  });

  it('publishWorkstream journals + fans out a validated payload (replayable §8)', async () => {
    await boot();
    const before = await connect();
    handle.publishWorkstream({
      kind: 'branch-advisory',
      sessionId: 'ses_fake_1',
      contextUsedPct: 71.5,
      ts: 90500000,
    });
    await before.waitFor(
      (envelope) =>
        envelope.channel === 'workstream' &&
        (envelope.payload as Record<string, unknown>)['kind'] === 'branch-advisory',
    );

    // A reconnecting client replays from seq 0 and receives the same frame.
    const late = await connect();
    late.send('workstream', 0, { kind: 'replay-request', channel: 'workstream', fromSeq: 0 });
    const replayed = await late.waitFor(
      (envelope) =>
        envelope.channel === 'workstream' &&
        (envelope.payload as Record<string, unknown>)['kind'] === 'branch-advisory',
    );
    expect(replayed.seq).toBe(0);
  });

  // -- negative ---------------------------------------------------------------

  it('answers the frozen validation code for a malformed merge request', async () => {
    await boot();
    const client = await connect();
    client.send('workstream', 0, {
      ...MERGE_PAYLOAD,
      params: { ...MERGE_PAYLOAD.params, parents: ['ses_fake_1'] },
    });
    const pushed = await client.waitFor((envelope) => errorCode(envelope) !== undefined);
    expect(errorCode(pushed)).toBe('bad-request');
  });

  it('degrades to session-not-found (runtime, correlated) when NO engine is composed', async () => {
    await boot();
    const client = await connect();
    client.send('workstream', 0, MERGE_PAYLOAD);
    const pushed = await client.waitFor((envelope) => errorCode(envelope) !== undefined);
    expect(errorCode(pushed)).toBe('session-not-found');
    expect((pushed.payload as Record<string, unknown>)['correlatesTo']).toBe('mrg_01');
    expect((pushed.payload as Record<string, unknown>)['channel']).toBe('workstream');
  });

  it('maps engine KernelVerbError codes onto correlated pushed errors', async () => {
    const engine: WorkstreamEnginePort = {
      merge: () =>
        Promise.reject(new KernelVerbError('workstream-not-found', 'unknown workstream')),
    };
    await boot({ workstreams: engine });
    const client = await connect();
    client.send('workstream', 0, MERGE_PAYLOAD);
    const pushed = await client.waitFor((envelope) => errorCode(envelope) !== undefined);
    expect(errorCode(pushed)).toBe('workstream-not-found');
    expect((pushed.payload as Record<string, unknown>)['correlatesTo']).toBe('mrg_01');
  });

  it('maps a non-KernelVerbError engine crash to a GENERIC internal error [X2]', async () => {
    const engine: WorkstreamEnginePort = {
      merge: () => Promise.reject(new Error('secret /Users/nobody path detail')),
    };
    await boot({ workstreams: engine });
    const client = await connect();
    client.send('workstream', 0, MERGE_PAYLOAD);
    const pushed = await client.waitFor((envelope) => errorCode(envelope) !== undefined);
    expect(errorCode(pushed)).toBe('internal');
    expect(JSON.stringify(pushed.payload)).not.toContain('nobody');
  });

  it('publishWorkstream refuses invalid AND unregistered-kind payloads', async () => {
    await boot();
    expect(() =>
      handle.publishWorkstream({
        kind: 'branch-advisory',
        sessionId: 'ses_fake_1',
        contextUsedPct: 120,
        ts: 1,
      } as never),
    ).toThrow(RangeError);
    expect(() =>
      handle.publishWorkstream({ kind: 'm5-pipeline-lens' } as never),
    ).toThrow(RangeError);
  });

  // -- edge ---------------------------------------------------------------------

  it('an invalid engine resolution is dropped loudly, never put on the wire', async () => {
    const engine: WorkstreamEnginePort = {
      merge: () =>
        Promise.resolve({
          kind: 'workstream-merge-resolved',
          mergeId: 'mrg_01',
          sessionId: 'bad id',
          briefId: 'br_fake_1',
        } as WorkstreamMergeResolved),
    };
    await boot({ workstreams: engine });
    const client = await connect();
    client.send('workstream', 0, MERGE_PAYLOAD);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(
      client.envelopes.filter((envelope) => envelope.channel === 'workstream'),
    ).toEqual([]);
  });
});
