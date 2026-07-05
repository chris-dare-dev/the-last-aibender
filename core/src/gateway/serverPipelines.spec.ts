/**
 * M5 pipelines slice of the gateway (ICR-0012; ws-protocol.md §18): the six
 * client verbs routed to the engine port, the §18.4 error contract, the
 * absent-engine degrade, `publishPipeline` validated broadcast, and
 * reconnect-replay on the pipelines channel. Positive / negative / edge per
 * plan §9.2.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateEnvelope, type Envelope } from '@aibender/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';

import { FakeKernel, FakeQueryRunner } from './fakeKernel.js';
import type { PipelineEnginePort, PipelineVerbErrorLike } from './ports.js';
import { startGateway, type GatewayHandle, type GatewayOptions } from './server.js';

const VALID_DOC = {
  schemaVersion: 1,
  id: 'wf_gw',
  name: 'gw pipeline',
  steps: [{ kind: 'prompt', id: 'a', prompt: 'x' }],
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
  async waitFor(predicate: (e: Envelope) => boolean, timeoutMs = 2000): Promise<Envelope> {
    const start = Date.now();
    for (;;) {
      const hit = this.envelopes.find(predicate);
      if (hit !== undefined) return hit;
      if (Date.now() - start > timeoutMs) throw new Error(`timed out; saw ${JSON.stringify(this.envelopes)}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  close(): void {
    this.ws.close();
  }
}

function payloadKind(e: Envelope): string | undefined {
  const p = e.payload;
  if (typeof p === 'object' && p !== null && !Array.isArray(p)) {
    const k = (p as Record<string, unknown>)['kind'];
    return typeof k === 'string' ? k : undefined;
  }
  return undefined;
}
function errorCode(e: Envelope): string | undefined {
  const p = e.payload;
  if (typeof p === 'object' && p !== null && (p as Record<string, unknown>)['kind'] === 'error') {
    const c = (p as Record<string, unknown>)['code'];
    return typeof c === 'string' ? c : undefined;
  }
  return undefined;
}

let home: string;
let handle: GatewayHandle;
const clients: Client[] = [];

async function boot(extra: Partial<GatewayOptions> = {}): Promise<void> {
  home = await mkdtemp(join(tmpdir(), 'aibender-gw-pl-'));
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

/** A minimal fake engine port recording calls + scripting outcomes. */
function fakeEngine(over: Partial<PipelineEnginePort> = {}): {
  engine: PipelineEnginePort;
  calls: string[];
} {
  const calls: string[] = [];
  const engine: PipelineEnginePort = {
    validate: () => {
      calls.push('validate');
      return { valid: true };
    },
    save: (doc) => {
      calls.push('save');
      return { pipelineId: doc.id };
    },
    launch: () => {
      calls.push('launch');
      return { runId: 'run_gw1' };
    },
    pause: (runId) => {
      calls.push(`pause:${runId}`);
    },
    resume: (runId) => {
      calls.push(`resume:${runId}`);
      return { runId };
    },
    cancel: (runId) => {
      calls.push(`cancel:${runId}`);
    },
    ...over,
  };
  return { engine, calls };
}

describe('gateway pipelines slice (M5, ICR-0012)', () => {
  // -- pipeline-validate: pure static validation, engine or not ---------------

  it('answers pipeline-validate directly with a validation-result (composed or not)', async () => {
    await boot();
    const client = await connect();
    client.send('pipelines', 0, { kind: 'pipeline-validate', requestId: 'req1', document: VALID_DOC });
    const answer = await client.waitFor((e) => payloadKind(e) === 'pipeline-validation-result');
    expect((answer.payload as Record<string, unknown>)['valid']).toBe(true);
    expect((answer.payload as Record<string, unknown>)['requestId']).toBe('req1');
  });

  it('a structurally-invalid pipeline-validate document is a bad-request on the VERB (§18.2)', async () => {
    await boot();
    const client = await connect();
    // The frozen contract: the wire verb must carry a PARSEABLE document; an
    // unparseable one is a bad-request shape error on the verb (not a
    // validation-result). The client-message validator enforces this.
    client.send('pipelines', 0, {
      kind: 'pipeline-validate',
      requestId: 'req2',
      document: { schemaVersion: 1, id: 'x', name: 'x', steps: [] }, // empty steps → bad-shape
    });
    const err = await client.waitFor((e) => errorCode(e) === 'bad-request');
    // The error payload names the pipelines channel (pushed on the control stream).
    expect((err.payload as Record<string, unknown>)['channel']).toBe('pipelines');
  });

  // -- verb delegation --------------------------------------------------------

  it('routes save/launch/pause/resume/cancel to the engine port', async () => {
    const { engine, calls } = fakeEngine();
    await boot({ pipelines: engine });
    const client = await connect();

    client.send('pipelines', 0, { kind: 'pipeline-save', requestId: 'r1', document: VALID_DOC });
    await client.waitFor((e) => payloadKind(e) === 'pipeline-saved');
    client.send('pipelines', 1, { kind: 'pipeline-launch', requestId: 'r2', document: VALID_DOC });
    client.send('pipelines', 2, { kind: 'pipeline-pause', requestId: 'r3', runId: 'run_gw1' });
    client.send('pipelines', 3, { kind: 'pipeline-resume', requestId: 'r4', runId: 'run_gw1' });
    client.send('pipelines', 4, { kind: 'pipeline-cancel', requestId: 'r5', runId: 'run_gw1' });

    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toContain('save');
    expect(calls).toContain('launch');
    expect(calls).toContain('pause:run_gw1');
    expect(calls).toContain('resume:run_gw1');
    expect(calls).toContain('cancel:run_gw1');
  });

  it('pipeline-saved carries the persisted id, correlated to the requestId', async () => {
    const { engine } = fakeEngine();
    await boot({ pipelines: engine });
    const client = await connect();
    client.send('pipelines', 0, { kind: 'pipeline-save', requestId: 'save1', document: VALID_DOC });
    const saved = await client.waitFor((e) => payloadKind(e) === 'pipeline-saved');
    expect((saved.payload as Record<string, unknown>)['pipelineId']).toBe('wf_gw');
    expect((saved.payload as Record<string, unknown>)['requestId']).toBe('save1');
  });

  // -- §18.4 error contract ---------------------------------------------------

  it('maps a pipeline-not-found engine refusal onto a pushed error correlated to requestId', async () => {
    const { engine } = fakeEngine({
      launch: () => {
        const err: PipelineVerbErrorLike = { code: 'pipeline-not-found', message: 'no such pipeline' };
        throw err;
      },
    });
    await boot({ pipelines: engine });
    const client = await connect();
    client.send('pipelines', 0, { kind: 'pipeline-launch', requestId: 'req9', pipelineId: 'wf_ghost' });
    const err = await client.waitFor((e) => errorCode(e) === 'pipeline-not-found');
    expect((err.payload as Record<string, unknown>)['correlatesTo']).toBe('req9');
  });

  it('a pipeline-invalid refusal pushes a validation-result AND a generic error [X2]', async () => {
    const { engine } = fakeEngine({
      launch: () => {
        const err: PipelineVerbErrorLike = {
          code: 'pipeline-invalid',
          message: 'invalid',
          validation: { issueCode: 'unresolved-capability', issueMessage: 'ghost skill', issuePath: 'steps.a' },
        };
        throw err;
      },
    });
    await boot({ pipelines: engine });
    const client = await connect();
    client.send('pipelines', 0, { kind: 'pipeline-launch', requestId: 'req10', document: VALID_DOC });
    const vr = await client.waitFor((e) => payloadKind(e) === 'pipeline-validation-result');
    expect((vr.payload as Record<string, unknown>)['issueCode']).toBe('unresolved-capability');
    const err = await client.waitFor((e) => errorCode(e) === 'pipeline-invalid');
    expect((err.payload as Record<string, unknown>)['correlatesTo']).toBe('req10');
  });

  it('an engine that throws a non-typed error answers GENERIC internal [X2]', async () => {
    const { engine } = fakeEngine({
      launch: () => {
        throw new Error('secret internal detail /Users/private/path');
      },
    });
    await boot({ pipelines: engine });
    const client = await connect();
    client.send('pipelines', 0, { kind: 'pipeline-launch', requestId: 'req11', document: VALID_DOC });
    const err = await client.waitFor((e) => errorCode(e) === 'internal');
    // The message is generic — it never leaks the thrown detail.
    expect((err.payload as Record<string, unknown>)['message']).not.toContain('/Users/private');
  });

  // -- absent-engine degrade --------------------------------------------------

  it('with NO engine: pipeline-validate answers, every other verb degrades to pipeline-not-found', async () => {
    await boot(); // no pipelines engine
    const client = await connect();
    client.send('pipelines', 0, { kind: 'pipeline-launch', requestId: 'req12', document: VALID_DOC });
    const err = await client.waitFor((e) => errorCode(e) === 'pipeline-not-found');
    expect((err.payload as Record<string, unknown>)['correlatesTo']).toBe('req12');
  });

  // -- publishPipeline fan-out + replay --------------------------------------

  it('publishPipeline journals + fans out a validated payload (replayable §8)', async () => {
    await boot();
    const before = await connect();
    handle.publishPipeline({
      kind: 'pipeline-run-status',
      runId: 'run_x',
      pipelineId: 'wf_gw',
      state: 'running',
    });
    await before.waitFor((e) => payloadKind(e) === 'pipeline-run-status');

    const late = await connect();
    late.send('pipelines', 0, { kind: 'replay-request', channel: 'pipelines', fromSeq: 0 });
    const replayed = await late.waitFor((e) => payloadKind(e) === 'pipeline-run-status');
    expect(replayed.seq).toBe(0);
  });

  it('publishPipeline refuses an invalid payload (producer discipline)', async () => {
    await boot();
    expect(() =>
      handle.publishPipeline({ kind: 'pipeline-run-status', runId: '', pipelineId: 'x', state: 'running' } as never),
    ).toThrow();
    // An unregistered kind is refused too (forward tolerance is a READER rule).
    expect(() => handle.publishPipeline({ kind: 'made-up-kind' } as never)).toThrow();
  });
});
