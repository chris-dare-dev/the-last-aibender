/**
 * BE-3 M1 control-channel round-trip suite (plan §9.2 BE-3 row, M1 slice):
 *  - positive: bootstrap discovery + perms, launch/resume/kill/status
 *    round-trips against the kernel port (FakeKernel over FakeQueryRunner),
 *    golden cross-checks through the FROZEN protocol validators, per-channel
 *    seq monotonicity;
 *  - negative: bad token, malformed envelope, unknown channel, unknown verb,
 *    reserved verb, bad requests, unknown sessions, malformed binary frames;
 *  - edge: two concurrent clients, kill-while-launching, shutdown semantics.
 */

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CHANNEL,
  encodePtyFrame,
  isSessionIdSegment,
  streamForChannel,
  validateControlResponse,
  validateEnvelope,
  validateErrorPayload,
  type ChannelName,
  type ControlRequest,
  type ControlResponse,
  type Envelope,
  type ErrorPayload,
  type LaunchParams,
  type SessionStatus,
} from '@aibender/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';

import { readBootstrapFile } from './bootstrap.js';
import { FakeKernel, FakeQueryRunner } from './fakeKernel.js';
import { startGateway, type GatewayHandle } from './server.js';

// ---------------------------------------------------------------------------
// Test client (ws client; supports both query-param and header auth)
// ---------------------------------------------------------------------------

interface ReceivedClose {
  readonly code: number;
  readonly reason: string;
}

class TestClient {
  private readonly buffered: Envelope[] = [];
  private readonly waiters: Array<{
    predicate: (envelope: Envelope) => boolean;
    resolve: (envelope: Envelope) => void;
  }> = [];
  private readonly seqByChannel = new Map<ChannelName, number>();
  readonly closed: Promise<ReceivedClose>;

  private constructor(private readonly ws: WsClient) {
    this.closed = new Promise((resolve) => {
      ws.on('close', (code: number, reason: Buffer) =>
        resolve({ code, reason: reason.toString('utf8') }),
      );
    });
    ws.on('message', (data) => {
      const parsed = JSON.parse(String(data)) as Envelope;
      const waiterIndex = this.waiters.findIndex((w) => w.predicate(parsed));
      if (waiterIndex >= 0) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        waiter?.resolve(parsed);
      } else {
        this.buffered.push(parsed);
      }
    });
  }

  static async connect(
    url: string,
    options: { headers?: Record<string, string> } = {},
  ): Promise<TestClient> {
    const ws = new WsClient(url, options.headers ? { headers: options.headers } : {});
    // Attach the buffering listeners BEFORE awaiting open: a rejected
    // connection's bad-auth envelope can arrive in the same tick as the
    // handshake completion and must not be missed.
    const client = new TestClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.removeAllListeners('error');
    ws.on('error', () => {
      /* closing races are expected in negative tests */
    });
    return client;
  }

  /** Next envelope matching the predicate (buffered or future). Consumes it. */
  async expect(
    predicate: (envelope: Envelope) => boolean,
    timeoutMs = 2000,
  ): Promise<Envelope> {
    const bufferedIndex = this.buffered.findIndex(predicate);
    if (bufferedIndex >= 0) {
      const [envelope] = this.buffered.splice(bufferedIndex, 1);
      return envelope as Envelope;
    }
    return new Promise<Envelope>((resolve, reject) => {
      const waiter = { predicate, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
          reject(new Error('timed out waiting for a matching envelope'));
        }
      }, timeoutMs).unref();
    });
  }

  /** Asserts NO matching envelope arrives within the window (non-consuming). */
  async expectNone(predicate: (envelope: Envelope) => boolean, windowMs = 75): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    expect(this.buffered.some(predicate)).toBe(false);
  }

  sendEnvelope(channel: ChannelName, payload: unknown): void {
    const seq = this.seqByChannel.get(channel) ?? 0;
    this.seqByChannel.set(channel, seq + 1);
    this.ws.send(JSON.stringify({ stream: streamForChannel(channel), channel, seq, payload }));
  }

  sendRawText(text: string): void {
    this.ws.send(text);
  }

  sendBinary(bytes: Uint8Array): void {
    this.ws.send(bytes, { binary: true });
  }

  /** Fire a control request and await its correlated response payload. */
  async request(request: ControlRequest, timeoutMs = 2000): Promise<ControlResponse> {
    this.sendEnvelope(CHANNEL.CONTROL, request);
    const envelope = await this.expect(
      (e) =>
        e.channel === CHANNEL.CONTROL &&
        isRecord(e.payload) &&
        e.payload['kind'] === 'result' &&
        e.payload['id'] === request.id,
      timeoutMs,
    );
    const validated = validateControlResponse(envelope.payload);
    if (!validated.ok) throw new Error(`response failed golden validation: ${validated.message}`);
    return validated.value;
  }

  /** Await the next pushed error payload matching `code` and validate it. */
  async expectPushedError(code: string, timeoutMs = 2000): Promise<ErrorPayload> {
    const envelope = await this.expect(
      (e) =>
        e.channel === CHANNEL.CONTROL &&
        isRecord(e.payload) &&
        e.payload['kind'] === 'error' &&
        e.payload['code'] === code,
      timeoutMs,
    );
    const validated = validateErrorPayload(envelope.payload);
    if (!validated.ok) throw new Error(`error payload failed golden validation: ${validated.message}`);
    return validated.value;
  }

  close(): void {
    this.ws.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Fixtures (synthesized only [X2])
// ---------------------------------------------------------------------------

const launchParams = (over: Partial<LaunchParams> = {}): LaunchParams => ({
  accountLabel: 'MAX_A',
  backend: 'claude_code',
  substrate: 'sdk',
  cwd: '/synthesized/workspace',
  purpose: 'synthesized gateway round-trip',
  ...over,
});

let requestCounter = 0;
const nextRequestId = (): string => `req_${(requestCounter += 1)}`;

const launchRequest = (over: Partial<LaunchParams> = {}): ControlRequest => ({
  kind: 'launch',
  id: nextRequestId(),
  params: launchParams(over),
});

function expectOk(response: ControlResponse): Extract<ControlResponse, { ok: true }> {
  expect(response.ok).toBe(true);
  if (!response.ok) throw new Error('expected ok response');
  return response;
}

function expectErr(response: ControlResponse): Extract<ControlResponse, { ok: false }> {
  expect(response.ok).toBe(false);
  if (response.ok) throw new Error('expected error response');
  return response;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

let home: string;
let runner: FakeQueryRunner;
let kernel: FakeKernel;
let handle: GatewayHandle;
const openClients: TestClient[] = [];

async function connectAuthed(): Promise<TestClient> {
  const client = await TestClient.connect(`${handle.url}/?token=${handle.token}`);
  openClients.push(client);
  return client;
}

async function bootGateway(options: { autoStart?: boolean } = {}): Promise<void> {
  runner = new FakeQueryRunner({ autoStart: options.autoStart ?? true });
  kernel = new FakeKernel(runner);
  handle = await startGateway({
    kernel,
    aibenderHome: home,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'aibender-gw-'));
  await bootGateway();
});

afterEach(async () => {
  for (const client of openClients.splice(0)) client.close();
  await handle.close();
  await rm(home, { recursive: true, force: true });
});

describe('gateway boot + bootstrap discovery (positive)', () => {
  it('listens on 127.0.0.1 with an OS-assigned port', () => {
    expect(handle.url).toBe(`ws://127.0.0.1:${handle.port}`);
    expect(handle.port).toBeGreaterThan(0);
  });

  it('advertises {port, token, pid, startedAt} in a 0600 bootstrap file', async () => {
    const body = await readBootstrapFile({ aibenderHome: home });
    expect(body).toBeDefined();
    expect(body?.port).toBe(handle.port);
    expect(body?.token).toBe(handle.token);
    expect(body?.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(body?.startedAt ?? ''))).toBe(false);
    const mode = (await stat(handle.bootstrapPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('a client can dial straight from the bootstrap file', async () => {
    const body = await readBootstrapFile({ aibenderHome: home });
    const client = await TestClient.connect(
      `ws://127.0.0.1:${body?.port}/?token=${body?.token}`,
    );
    openClients.push(client);
    const response = await client.request({ kind: 'status', id: nextRequestId() });
    const ok = expectOk(response);
    expect(ok.result).toEqual({ verb: 'status', sessions: [] });
  });
});

describe('control round-trip against the kernel (positive)', () => {
  it('launch answers spawning immediately, then status shows running', async () => {
    const client = await connectAuthed();
    const response = expectOk(await client.request(launchRequest()));
    if (response.result.verb !== 'launch') throw new Error('wrong verb');
    const { sessionId, state } = response.result;
    expect(isSessionIdSegment(sessionId)).toBe(true);
    expect(state).toBe('spawning'); // row-before-spawn: spawn proceeds async

    // Poll status until the async spawn lands in `running`.
    let statuses: readonly SessionStatus[] = [];
    for (let i = 0; i < 20; i += 1) {
      const statusResponse = expectOk(
        await client.request({ kind: 'status', id: nextRequestId(), params: { sessionId } }),
      );
      if (statusResponse.result.verb !== 'status') throw new Error('wrong verb');
      statuses = statusResponse.result.sessions;
      if (statuses[0]?.state === 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.state).toBe('running');
    expect(statuses[0]?.accountLabel).toBe('MAX_A');
    expect(statuses[0]?.pid).toBeGreaterThan(0);
  });

  it('fork-resume creates a continuation CHILD; kill exits it; in-place resume revives it', async () => {
    const client = await connectAuthed();
    const launch = expectOk(await client.request(launchRequest()));
    if (launch.result.verb !== 'launch') throw new Error('wrong verb');
    const parent = launch.result.sessionId;

    const fork = expectOk(
      await client.request({ kind: 'resume', id: nextRequestId(), params: { sessionId: parent, fork: true } }),
    );
    if (fork.result.verb !== 'resume') throw new Error('wrong verb');
    expect(fork.result.forkedFrom).toBe(parent);
    expect(fork.result.sessionId).not.toBe(parent);
    expect(fork.result.state).toBe('resumed');

    const child = fork.result.sessionId;
    const kill = expectOk(
      await client.request({ kind: 'kill', id: nextRequestId(), params: { sessionId: child } }),
    );
    if (kill.result.verb !== 'kill') throw new Error('wrong verb');
    expect(kill.result.state).toBe('exited');

    const revive = expectOk(
      await client.request({ kind: 'resume', id: nextRequestId(), params: { sessionId: child } }),
    );
    if (revive.result.verb !== 'resume') throw new Error('wrong verb');
    expect(revive.result.sessionId).toBe(child);
    expect(revive.result.state).toBe('resumed');
    expect(revive.result.forkedFrom).toBeUndefined();
  });

  it('every outbound envelope passes the frozen validators with monotonic per-channel seq', async () => {
    const client = await connectAuthed();
    const raw: Envelope[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = nextRequestId();
      client.sendEnvelope(CHANNEL.CONTROL, { kind: 'status', id });
      const envelope = await client.expect(
        (e) => isRecord(e.payload) && e.payload['id'] === id,
      );
      raw.push(envelope);
    }
    const seqs = raw.map((envelope) => {
      const validated = validateEnvelope(envelope);
      expect(validated.ok).toBe(true);
      expect(envelope.stream).toBe('control');
      return envelope.seq;
    });
    expect(seqs).toEqual([0, 1, 2]);
  });
});

describe('authentication (negative)', () => {
  it('wrong token answers bad-auth on control and closes 1008', async () => {
    const client = await TestClient.connect(`${handle.url}/?token=wrong-synthesized-token`);
    const error = await client.expectPushedError('bad-auth');
    expect(error.retryable).toBe(false);
    const closed = await client.closed;
    expect(closed.code).toBe(1008);
    expect(handle.connectionCount()).toBe(0);
  });

  it('missing token answers bad-auth and closes', async () => {
    const client = await TestClient.connect(handle.url);
    await client.expectPushedError('bad-auth');
    const closed = await client.closed;
    expect(closed.code).toBe(1008);
  });

  it('the token never appears inside an error message [X2]', async () => {
    const client = await TestClient.connect(`${handle.url}/?token=wrong-synthesized-token`);
    const error = await client.expectPushedError('bad-auth');
    expect(error.message).not.toContain(handle.token);
    await client.closed;
  });

  it('Authorization: Bearer header authenticates (Node clients)', async () => {
    const client = await TestClient.connect(handle.url, {
      headers: { authorization: `Bearer ${handle.token}` },
    });
    openClients.push(client);
    const ok = expectOk(await client.request({ kind: 'status', id: nextRequestId() }));
    expect(ok.result.verb).toBe('status');
  });
});

describe('malformed frames (negative)', () => {
  it('non-JSON text answers bad-envelope', async () => {
    const client = await connectAuthed();
    client.sendRawText('this is not json {');
    await client.expectPushedError('bad-envelope');
  });

  it('stream/channel mismatch answers bad-envelope', async () => {
    const client = await connectAuthed();
    client.sendRawText(
      JSON.stringify({ stream: 'events', channel: 'control', seq: 0, payload: {} }),
    );
    await client.expectPushedError('bad-envelope');
  });

  it('a malformed channel name answers unknown-channel', async () => {
    const client = await connectAuthed();
    client.sendRawText(
      JSON.stringify({ stream: 'pty', channel: 'pty.bad!id', seq: 0, payload: {} }),
    );
    await client.expectPushedError('unknown-channel');
  });

  it('an unknown verb with a well-formed id answers a CORRELATED unknown-verb result', async () => {
    const client = await connectAuthed();
    const id = nextRequestId();
    client.sendEnvelope(CHANNEL.CONTROL, { kind: 'destroy', id });
    const envelope = await client.expect(
      (e) => isRecord(e.payload) && e.payload['kind'] === 'result' && e.payload['id'] === id,
    );
    const validated = validateControlResponse(envelope.payload);
    expect(validated.ok).toBe(true);
    if (!validated.ok || validated.value.ok) throw new Error('expected error result');
    expect(validated.value.error.code).toBe('unknown-verb');
  });

  it('the reserved approve verb answers verb-reserved', async () => {
    const client = await connectAuthed();
    const id = nextRequestId();
    client.sendEnvelope(CHANNEL.CONTROL, { kind: 'approve', id, params: {} });
    const envelope = await client.expect(
      (e) => isRecord(e.payload) && e.payload['kind'] === 'result' && e.payload['id'] === id,
    );
    const validated = validateControlResponse(envelope.payload);
    if (!validated.ok || validated.value.ok) throw new Error('expected error result');
    expect(validated.value.error.code).toBe('verb-reserved');
  });

  it('a control payload with NO parseable id answers an UNCORRELATED pushed error', async () => {
    const client = await connectAuthed();
    // kind IS registered, so validation fails on the malformed id → there is
    // no correlation id to answer on; the error is pushed instead.
    client.sendEnvelope(CHANNEL.CONTROL, { kind: 'launch', id: '###', params: {} });
    const error = await client.expectPushedError('bad-request');
    expect(error.correlatesTo).toBeUndefined();
    expect(error.channel).toBe('control');
  });

  it('label/backend pairing violation answers a correlated bad-request', async () => {
    const client = await connectAuthed();
    const response = expectErr(await client.request(launchRequest({ backend: 'opencode' })));
    expect(response.error.code).toBe('bad-request');
    expect(response.error.retryable).toBe(false);
  });

  it('kill/status/resume of an unknown session answer session-not-found', async () => {
    const client = await connectAuthed();
    for (const request of [
      { kind: 'kill', id: nextRequestId(), params: { sessionId: 'ses_missing' } },
      { kind: 'status', id: nextRequestId(), params: { sessionId: 'ses_missing' } },
      { kind: 'resume', id: nextRequestId(), params: { sessionId: 'ses_missing' } },
    ] as const satisfies readonly ControlRequest[]) {
      const response = expectErr(await client.request(request));
      expect(response.error.code).toBe('session-not-found');
    }
  });

  it('un-forked resume of a running session answers double-resume-blocked', async () => {
    const client = await connectAuthed();
    const launch = expectOk(await client.request(launchRequest()));
    if (launch.result.verb !== 'launch') throw new Error('wrong verb');
    const response = expectErr(
      await client.request({
        kind: 'resume',
        id: nextRequestId(),
        params: { sessionId: launch.result.sessionId },
      }),
    );
    expect(response.error.code).toBe('double-resume-blocked');
  });
});

describe('non-control channels at M1 (negative)', () => {
  it('binary garbage answers oversized-frame', async () => {
    const client = await connectAuthed();
    client.sendBinary(new Uint8Array([1, 2, 3, 4]));
    await client.expectPushedError('oversized-frame');
  });

  it('a well-formed PTY frame answers session-not-found (no pty sessions before M2)', async () => {
    const client = await connectAuthed();
    client.sendBinary(
      encodePtyFrame({
        type: 'input',
        sessionId: 'ses_synthesized01',
        streamOffset: 0,
        payload: new Uint8Array([120]),
      }),
    );
    const error = await client.expectPushedError('session-not-found');
    expect(error.channel).toBe('pty.ses_synthesized01');
  });

  it('a valid pty-ack for a nonexistent session answers session-not-found', async () => {
    const client = await connectAuthed();
    client.sendEnvelope('pty.ses_synthesized01', {
      kind: 'pty-ack',
      sessionId: 'ses_synthesized01',
      watermark: 0,
    });
    const error = await client.expectPushedError('session-not-found');
    expect(error.channel).toBe('pty.ses_synthesized01');
  });

  it('a pty payload whose sessionId disagrees with the channel answers bad-request', async () => {
    const client = await connectAuthed();
    client.sendEnvelope('pty.ses_synthesized01', {
      kind: 'pty-ack',
      sessionId: 'ses_other',
      watermark: 0,
    });
    const error = await client.expectPushedError('bad-request');
    expect(error.channel).toBe('pty.ses_synthesized01');
  });

  it('broker→client channels accept no client payloads', async () => {
    const client = await connectAuthed();
    client.sendEnvelope(CHANNEL.EVENTS, { anything: true });
    const error = await client.expectPushedError('bad-request');
    expect(error.channel).toBe('events');
  });
});

describe('edges', () => {
  it('two clients get isolated responses and independent seq counters', async () => {
    const clientA = await connectAuthed();
    const clientB = await connectAuthed();
    expect(handle.connectionCount()).toBe(2);

    const idA = nextRequestId();
    const idB = nextRequestId();
    clientA.sendEnvelope(CHANNEL.CONTROL, { kind: 'status', id: idA });
    clientB.sendEnvelope(CHANNEL.CONTROL, { kind: 'status', id: idB });

    const envelopeA = await clientA.expect(
      (e) => isRecord(e.payload) && e.payload['id'] === idA,
    );
    const envelopeB = await clientB.expect(
      (e) => isRecord(e.payload) && e.payload['id'] === idB,
    );
    // Each connection's control seq starts at 0 — counters are per-connection.
    expect(envelopeA.seq).toBe(0);
    expect(envelopeB.seq).toBe(0);
    // Neither client ever sees the other's correlation id.
    await clientA.expectNone((e) => isRecord(e.payload) && e.payload['id'] === idB);
    await clientB.expectNone((e) => isRecord(e.payload) && e.payload['id'] === idA);
  });

  it('kill-while-launching waits for the spawn to settle, then exits the session', async () => {
    // Re-boot with a gated runner so launches hold in `spawning`.
    await handle.close();
    await bootGateway({ autoStart: false });

    const client = await connectAuthed();
    const launch = expectOk(await client.request(launchRequest()));
    if (launch.result.verb !== 'launch') throw new Error('wrong verb');
    const sessionId = launch.result.sessionId;
    expect(launch.result.state).toBe('spawning');

    const killId = nextRequestId();
    client.sendEnvelope(CHANNEL.CONTROL, { kind: 'kill', id: killId, params: { sessionId } });
    // The kill must NOT answer while the spawn is still in flight.
    await client.expectNone((e) => isRecord(e.payload) && e.payload['id'] === killId, 100);
    expect(runner.pendingStartCount()).toBe(1);

    runner.releaseStart(sessionId);
    const envelope = await client.expect(
      (e) => isRecord(e.payload) && e.payload['id'] === killId,
    );
    const validated = validateControlResponse(envelope.payload);
    if (!validated.ok || !validated.value.ok) throw new Error('expected ok kill result');
    if (validated.value.result.verb !== 'kill') throw new Error('wrong verb');
    expect(validated.value.result.state).toBe('exited');
    expect(runner.stoppedSessionIds).toContain(sessionId);
    expect(kernel.stateOf(sessionId)).toBe('exited');
  });

  it('close() disconnects clients with 1001, removes the bootstrap file, and is idempotent', async () => {
    const client = await connectAuthed();
    await client.request({ kind: 'status', id: nextRequestId() });

    await handle.close();
    const closed = await client.closed;
    expect(closed.code).toBe(1001);
    expect(handle.connectionCount()).toBe(0);
    expect(await readBootstrapFile({ aibenderHome: home })).toBeUndefined();
    await expect(handle.close()).resolves.toBeUndefined();
  });
});
