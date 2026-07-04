/**
 * BE-3 M2 streaming integration suite (plan §9.2 BE-3 row, M2 full slice):
 *
 *  - positive: transcript.<sid> projection fan-out to multiple clients;
 *    approvals round-trip against FakeKernel + FakeApprovalBroker; quota/
 *    events/context-graph pass-through publishers; binary PTY streaming with
 *    acks, input, resize;
 *  - negative: watermark-out-of-range on both axes (JSON seq + PTY bytes),
 *    approval-not-pending on double/unknown decisions and with no broker
 *    attached, invalid publisher payloads THROW and never touch the wire;
 *  - edge: reconnect-with-replay exactly-once on JSON channels and the PTY
 *    byte axis; slow consumer → bounded delivery window + producer
 *    backpressure with ZERO byte loss (SPIKE-D wire-level).
 *
 * Every broker→client frame received by the test clients is additionally
 * screened through the FROZEN validators (the outbound half of the golden
 * corpus contract — see conformBrokerEnvelope).
 *
 * [X2]: every fixture value is synthesized.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CHANNEL,
  decodePtyFrame,
  encodePtyFrame,
  ptyChannel,
  sessionIdOfChannel,
  streamForChannel,
  transcriptChannel,
  validateApprovalsServerMessage,
  validateContextGraphTouch,
  validateControlResponse,
  validateEnvelope,
  validateErrorPayload,
  validateQuotaSnapshot,
  validateTranscriptPayload,
  type ApprovalRequest,
  type ChannelName,
  type ContextGraphTouch,
  type Envelope,
  type PtyFrame,
  type QuotaSnapshot,
} from '@aibender/protocol';
import { FakeApprovalBroker, FakePtyHost, FakeTranscriptSource } from '@aibender/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';

import { FakeKernel, FakeQueryRunner } from './fakeKernel.js';
import { startGateway, type GatewayHandle, type GatewayOptions } from './server.js';

// ---------------------------------------------------------------------------
// Broker-frame conformance (outbound golden contract)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Route a broker→client envelope through the frozen validators; undefined = conformant. */
function conformBrokerEnvelope(envelope: Envelope): string | undefined {
  const { channel, payload } = envelope;
  if (channel === CHANNEL.CONTROL) {
    const result =
      isRecord(payload) && payload['kind'] === 'error'
        ? validateErrorPayload(payload)
        : validateControlResponse(payload);
    return result.ok ? undefined : `control: ${result.message}`;
  }
  if (channel === CHANNEL.APPROVALS) {
    const result = validateApprovalsServerMessage(payload);
    return result.ok ? undefined : `approvals: ${result.message}`;
  }
  if (channel === CHANNEL.QUOTA) {
    const result = validateQuotaSnapshot(payload);
    return result.ok ? undefined : `quota: ${result.message}`;
  }
  if (channel === CHANNEL.CONTEXT_GRAPH) {
    const result = validateContextGraphTouch(payload);
    return result.ok ? undefined : `context-graph: ${result.message}`;
  }
  const sid = sessionIdOfChannel(channel);
  if (sid !== undefined && channel.startsWith('transcript.')) {
    const result = validateTranscriptPayload(payload, sid);
    return result.ok ? undefined : `transcript: ${result.message}`;
  }
  if (sid !== undefined && channel.startsWith('pty.')) {
    return 'broker JSON on a pty channel (broker sends binary frames + control errors only)';
  }
  // events: payload union DRAFT until M3 — opaque envelopes by policy.
  return undefined;
}

// ---------------------------------------------------------------------------
// Test client (text + binary)
// ---------------------------------------------------------------------------

class StreamClient {
  readonly envelopes: Envelope[] = [];
  readonly frames: PtyFrame[] = [];
  readonly conformanceFailures: string[] = [];
  readonly closed: Promise<void>;
  private readonly seqByChannel = new Map<ChannelName, number>();

  private constructor(private readonly ws: WsClient) {
    this.closed = new Promise((resolve) => ws.on('close', () => resolve()));
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const decoded = decodePtyFrame(toUint8(data as Buffer));
        if (!decoded.ok) {
          this.conformanceFailures.push(`binary frame failed the frozen codec: ${decoded.message}`);
          return;
        }
        this.frames.push(decoded.value);
        return;
      }
      const parsed: unknown = JSON.parse(String(data));
      const validated = validateEnvelope(parsed);
      if (!validated.ok) {
        this.conformanceFailures.push(`envelope failed frozen validation: ${validated.message}`);
        return;
      }
      const failure = conformBrokerEnvelope(validated.value);
      if (failure !== undefined) this.conformanceFailures.push(failure);
      this.envelopes.push(validated.value);
    });
    ws.on('error', () => {
      /* closing races are expected */
    });
  }

  static async connect(url: string, token: string): Promise<StreamClient> {
    const ws = new WsClient(`${url}/?token=${token}`);
    const client = new StreamClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return client;
  }

  sendEnvelope(channel: ChannelName, payload: unknown): void {
    const seq = this.seqByChannel.get(channel) ?? 0;
    this.seqByChannel.set(channel, seq + 1);
    this.ws.send(JSON.stringify({ stream: streamForChannel(channel), channel, seq, payload }));
  }

  sendBinary(bytes: Uint8Array): void {
    this.ws.send(bytes, { binary: true });
  }

  on(channel: ChannelName): Envelope[] {
    return this.envelopes.filter((envelope) => envelope.channel === channel);
  }

  framesFor(sessionId: string): PtyFrame[] {
    return this.frames.filter((frame) => frame.sessionId === sessionId);
  }

  /** Total OUTPUT payload bytes received for a session. */
  ptyBytesFor(sessionId: string): number {
    return this.framesFor(sessionId).reduce((sum, frame) => sum + frame.payload.byteLength, 0);
  }

  /** Reassemble the session's byte stream from frames (offset-ordered). */
  ptyStreamFor(sessionId: string): { readonly firstOffset: number; readonly bytes: Uint8Array } {
    const frames = [...this.framesFor(sessionId)].sort((a, b) => a.streamOffset - b.streamOffset);
    const first = frames[0]?.streamOffset ?? 0;
    let cursor = first;
    const parts: Uint8Array[] = [];
    for (const frame of frames) {
      if (frame.streamOffset !== cursor) {
        throw new Error(
          `non-contiguous pty stream: expected offset ${cursor}, got ${frame.streamOffset}`,
        );
      }
      parts.push(frame.payload);
      cursor += frame.payload.byteLength;
    }
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.byteLength;
    }
    return { firstOffset: first, bytes };
  }

  close(): void {
    this.ws.close();
  }
}

function toUint8(data: Buffer): Uint8Array {
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function settle(windowMs = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, windowMs));
}

// ---------------------------------------------------------------------------
// Fixtures (synthesized only [X2])
// ---------------------------------------------------------------------------

const SID = 'ses_fake_stream';

const assistantText = (uuid: string, text: string): Record<string, unknown> => ({
  type: 'assistant',
  uuid,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

const approvalRequest = (approvalId: string): ApprovalRequest => ({
  kind: 'approval-request',
  approvalId,
  source: 'can-use-tool',
  summary: 'synthesized tool escalation',
  accountLabel: 'MAX_A',
  sessionId: SID,
  toolName: 'Bash',
  toolUseId: 'synthtool-9',
});

const quotaSnapshot = (over: Partial<QuotaSnapshot> = {}): QuotaSnapshot => ({
  kind: 'quota-snapshot',
  account: 'MAX_A',
  window: '5h',
  usedPct: 41.5,
  resetsAt: 90200000,
  capturedAt: 90100000,
  source: 'statusline',
  ...over,
});

const contextTouch = (): ContextGraphTouch => ({
  kind: 'context-touch',
  sessionId: SID,
  path: '/synthetic/workspace/src/main.ts',
  relation: 'read',
  ts: 90100000,
});

const isErrorWithCode =
  (code: string) =>
  (envelope: Envelope): boolean =>
    envelope.channel === CHANNEL.CONTROL &&
    isRecord(envelope.payload) &&
    envelope.payload['kind'] === 'error' &&
    envelope.payload['code'] === code;

// PTY flow-control sizes for wire tests (mechanism = contract; values = config).
const WIRE_FLOW = {
  capBytes: 4096,
  highWater: 2048,
  lowWater: 512,
  deliveryWindowBytes: 1024,
  maxFramePayloadBytes: 512,
} as const;

// ---------------------------------------------------------------------------
// Suite plumbing
// ---------------------------------------------------------------------------

let home: string;
let kernel: FakeKernel;
let ptyHost: FakePtyHost;
let approvals: FakeApprovalBroker;
let transcripts: FakeTranscriptSource;
let handle: GatewayHandle;
const openClients: StreamClient[] = [];

async function bootGateway(
  overrides: Partial<GatewayOptions> = {},
  wiring: { readonly withApprovals?: boolean } = {},
): Promise<void> {
  kernel = new FakeKernel(new FakeQueryRunner());
  ptyHost = new FakePtyHost();
  approvals = new FakeApprovalBroker();
  transcripts = new FakeTranscriptSource();
  handle = await startGateway({
    kernel,
    ptyHost,
    ...(wiring.withApprovals !== false ? { approvals } : {}),
    transcripts,
    flowControl: WIRE_FLOW,
    aibenderHome: home,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...overrides,
  });
}

async function connect(): Promise<StreamClient> {
  const client = await StreamClient.connect(handle.url, handle.token);
  openClients.push(client);
  return client;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'aibender-gw-m2-'));
  await bootGateway();
});

afterEach(async () => {
  for (const client of openClients.splice(0)) {
    expect(client.conformanceFailures).toEqual([]);
    client.close();
  }
  await handle.close();
  await rm(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// transcript.<sid> fan-out + reconnect replay
// ---------------------------------------------------------------------------

describe('transcript channels (positive)', () => {
  it('projects the SDK message stream onto transcript.<sid> and fans out to BOTH clients', async () => {
    const clientA = await connect();
    const clientB = await connect();
    const channel = transcriptChannel(SID);

    transcripts.emit(SID, assistantText('synthmsg-1', 'synthesized streamed text'));
    transcripts.emit(SID, {
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    for (const client of [clientA, clientB]) {
      await waitFor(() => client.on(channel).length === 2, 'two transcript envelopes');
      const [delta, result] = client.on(channel);
      expect(delta?.seq).toBe(0);
      expect(result?.seq).toBe(1);
      expect(delta?.payload).toMatchObject({ kind: 'transcript-delta', text: 'synthesized streamed text' });
      expect(result?.payload).toMatchObject({ kind: 'transcript-result', ok: true, detail: 'success' });
    }
  });

  it('scopes seq per (boot, channel): two sessions each start at 0', async () => {
    const client = await connect();
    transcripts.emit(SID, assistantText('m1', 'one'));
    transcripts.emit('ses_fake_other', assistantText('m2', 'two'));
    await waitFor(
      () => client.on(transcriptChannel(SID)).length === 1 && client.on(transcriptChannel('ses_fake_other')).length === 1,
      'both sessions',
    );
    expect(client.on(transcriptChannel(SID))[0]?.seq).toBe(0);
    expect(client.on(transcriptChannel('ses_fake_other'))[0]?.seq).toBe(0);
  });
});

describe('transcript channels (edge: reconnect exactly-once)', () => {
  it('replays from the watermark with ORIGINAL seqs, exactly once, then live flow continues', async () => {
    const channel = transcriptChannel(SID);
    const first = await connect();
    transcripts.emit(SID, assistantText('m0', 'zero'));
    transcripts.emit(SID, assistantText('m1', 'one'));
    await waitFor(() => first.on(channel).length === 2, 'first client caught up');
    first.close();
    await first.closed;

    // Broadcasts continue while the client is away (seq continues per boot).
    transcripts.emit(SID, assistantText('m2', 'two'));
    transcripts.emit(SID, assistantText('m3', 'three'));

    const second = await connect();
    // The client processed seqs 0..1; the first unprocessed seq is 2.
    second.sendEnvelope(channel, { kind: 'replay-request', channel, fromSeq: 2 });
    await waitFor(() => second.on(channel).length === 2, 'replayed envelopes');
    expect(second.on(channel).map((envelope) => envelope.seq)).toEqual([2, 3]);

    // Live flow continues after replay with the next seq — nothing duplicated.
    transcripts.emit(SID, assistantText('m4', 'four'));
    await waitFor(() => second.on(channel).length === 3, 'live envelope after replay');
    expect(second.on(channel).map((envelope) => envelope.seq)).toEqual([2, 3, 4]);
    const texts = second.on(channel).map((envelope) => (envelope.payload as { text: string }).text);
    expect(texts).toEqual(['two', 'three', 'four']);
  });

  it('fromSeq === lastSeq + 1 is a legal no-op ("I am current")', async () => {
    const channel = transcriptChannel(SID);
    const client = await connect();
    transcripts.emit(SID, assistantText('m0', 'zero'));
    await waitFor(() => client.on(channel).length === 1, 'the live envelope');
    client.sendEnvelope(channel, { kind: 'replay-request', channel, fromSeq: 1 });
    await settle();
    expect(client.on(channel).length).toBe(1); // nothing replayed
    expect(client.on(CHANNEL.CONTROL).filter((e) => isRecord(e.payload) && e.payload['kind'] === 'error')).toEqual([]);
  });

  it('fromSeq beyond lastSeq + 1 answers watermark-out-of-range', async () => {
    const channel = transcriptChannel(SID);
    const client = await connect();
    client.sendEnvelope(channel, { kind: 'replay-request', channel, fromSeq: 42 });
    await waitFor(() => client.envelopes.some(isErrorWithCode('watermark-out-of-range')), 'the refusal');
    const error = client.envelopes.find(isErrorWithCode('watermark-out-of-range'));
    expect((error?.payload as { channel?: string }).channel).toBe(channel);
  });

  it('fromSeq below the bounded journal floor answers watermark-out-of-range', async () => {
    await handle.close();
    await bootGateway({ replayJournal: { maxEntriesPerChannel: 2 } });
    const channel = transcriptChannel(SID);
    for (let i = 0; i < 5; i += 1) transcripts.emit(SID, assistantText(`m${i}`, `text-${i}`));

    const client = await connect();
    client.sendEnvelope(channel, { kind: 'replay-request', channel, fromSeq: 0 });
    await waitFor(() => client.envelopes.some(isErrorWithCode('watermark-out-of-range')), 'the refusal');

    // The retained window (seqs 3..4) is still replayable.
    client.sendEnvelope(channel, { kind: 'replay-request', channel, fromSeq: 3 });
    await waitFor(() => client.on(channel).length === 2, 'the retained window');
    expect(client.on(channel).map((envelope) => envelope.seq)).toEqual([3, 4]);
  });
});

// ---------------------------------------------------------------------------
// approvals bridge
// ---------------------------------------------------------------------------

describe('approvals channel (positive: round-trip against FakeKernel + FakeApprovalBroker)', () => {
  it('request fans out to every client; one decision resolves; ALL clients converge', async () => {
    const clientA = await connect();
    const clientB = await connect();

    approvals.emitRequest(approvalRequest('apr_fake_rt'));
    for (const client of [clientA, clientB]) {
      await waitFor(() => client.on(CHANNEL.APPROVALS).length === 1, 'the approval-request');
      expect(client.on(CHANNEL.APPROVALS)[0]?.payload).toMatchObject({
        kind: 'approval-request',
        approvalId: 'apr_fake_rt',
        source: 'can-use-tool',
      });
    }

    clientA.sendEnvelope(CHANNEL.APPROVALS, {
      kind: 'approval-decision',
      approvalId: 'apr_fake_rt',
      verdict: 'allow',
      updatedInput: { command: 'ls -la' },
    });

    // Terminal fan-out reaches EVERY client, including the decider.
    for (const client of [clientA, clientB]) {
      await waitFor(() => client.on(CHANNEL.APPROVALS).length === 2, 'the approval-resolved');
      expect(client.on(CHANNEL.APPROVALS)[1]?.payload).toEqual({
        kind: 'approval-resolved',
        approvalId: 'apr_fake_rt',
        outcome: 'allowed',
      });
    }
    expect(approvals.appliedDecisions).toHaveLength(1);
    expect(approvals.appliedDecisions[0]?.updatedInput).toEqual({ command: 'ls -la' });
  });

  it('deny decisions resolve as denied and relay the note to the broker', async () => {
    const client = await connect();
    approvals.emitRequest(approvalRequest('apr_fake_deny'));
    await waitFor(() => client.on(CHANNEL.APPROVALS).length === 1, 'the request');
    client.sendEnvelope(CHANNEL.APPROVALS, {
      kind: 'approval-decision',
      approvalId: 'apr_fake_deny',
      verdict: 'deny',
      note: 'synthesized denial rationale',
    });
    await waitFor(() => client.on(CHANNEL.APPROVALS).length === 2, 'the resolution');
    expect(client.on(CHANNEL.APPROVALS)[1]?.payload).toMatchObject({ outcome: 'denied' });
    expect(approvals.appliedDecisions[0]?.note).toBe('synthesized denial rationale');
  });

  it('requests and resolutions replay on reconnect (§8)', async () => {
    approvals.emitRequest(approvalRequest('apr_fake_replay'));
    approvals.resolveWithout('apr_fake_replay', 'expired');

    const client = await connect(); // connected AFTER both broadcasts
    client.sendEnvelope(CHANNEL.APPROVALS, { kind: 'replay-request', channel: 'approvals', fromSeq: 0 });
    await waitFor(() => client.on(CHANNEL.APPROVALS).length === 2, 'the replayed pair');
    expect(client.on(CHANNEL.APPROVALS).map((envelope) => envelope.seq)).toEqual([0, 1]);
    expect(client.on(CHANNEL.APPROVALS)[1]?.payload).toMatchObject({ outcome: 'expired' });
  });
});

describe('approvals channel (negative: idempotent double-decision handling)', () => {
  it('the SECOND decision answers approval-not-pending; resolution fans out exactly once', async () => {
    const clientA = await connect();
    const clientB = await connect();
    approvals.emitRequest(approvalRequest('apr_fake_double'));
    for (const client of [clientA, clientB]) {
      await waitFor(() => client.on(CHANNEL.APPROVALS).length === 1, 'the request');
    }

    const decision = { kind: 'approval-decision', approvalId: 'apr_fake_double', verdict: 'allow' };
    clientA.sendEnvelope(CHANNEL.APPROVALS, decision);
    for (const client of [clientA, clientB]) {
      await waitFor(() => client.on(CHANNEL.APPROVALS).length === 2, 'the resolution');
    }

    clientB.sendEnvelope(CHANNEL.APPROVALS, decision); // the two-window race
    await waitFor(() => clientB.envelopes.some(isErrorWithCode('approval-not-pending')), 'the race answer');
    await settle();
    // The decider never sees the race error; nobody sees a second resolution.
    expect(clientA.envelopes.some(isErrorWithCode('approval-not-pending'))).toBe(false);
    expect(clientA.on(CHANNEL.APPROVALS)).toHaveLength(2);
    expect(clientB.on(CHANNEL.APPROVALS)).toHaveLength(2);
    expect(approvals.appliedDecisions).toHaveLength(1);
  });

  it('a decision for an unknown approval answers approval-not-pending', async () => {
    const client = await connect();
    client.sendEnvelope(CHANNEL.APPROVALS, {
      kind: 'approval-decision',
      approvalId: 'apr_fake_unknown',
      verdict: 'deny',
    });
    await waitFor(() => client.envelopes.some(isErrorWithCode('approval-not-pending')), 'the answer');
  });

  it('a decision after broker-side expiry answers approval-not-pending', async () => {
    const client = await connect();
    approvals.emitRequest(approvalRequest('apr_fake_expiry'));
    await waitFor(() => client.on(CHANNEL.APPROVALS).length === 1, 'the request');
    approvals.resolveWithout('apr_fake_expiry', 'expired');
    await waitFor(() => client.on(CHANNEL.APPROVALS).length === 2, 'the expiry fan-out');

    client.sendEnvelope(CHANNEL.APPROVALS, {
      kind: 'approval-decision',
      approvalId: 'apr_fake_expiry',
      verdict: 'allow',
    });
    await waitFor(() => client.envelopes.some(isErrorWithCode('approval-not-pending')), 'the race answer');
  });

  it('with NO approval broker attached every decision answers approval-not-pending', async () => {
    await handle.close();
    await bootGateway({}, { withApprovals: false });
    const client = await connect();
    client.sendEnvelope(CHANNEL.APPROVALS, {
      kind: 'approval-decision',
      approvalId: 'apr_fake_nobroker',
      verdict: 'allow',
    });
    await waitFor(() => client.envelopes.some(isErrorWithCode('approval-not-pending')), 'the answer');
  });

  it('a malformed decision answers bad-request (validation precedes broker dispatch)', async () => {
    const client = await connect();
    approvals.emitRequest(approvalRequest('apr_fake_malformed'));
    await waitFor(() => client.on(CHANNEL.APPROVALS).length === 1, 'the request');
    client.sendEnvelope(CHANNEL.APPROVALS, {
      kind: 'approval-decision',
      approvalId: 'apr_fake_malformed',
      verdict: 'deny',
      updatedInput: { command: 'rm -rf /synthetic' }, // updatedInput is allow-only
    });
    await waitFor(() => client.envelopes.some(isErrorWithCode('bad-request')), 'the refusal');
    expect(approvals.isPending('apr_fake_malformed')).toBe(true); // never reached the broker
  });
});

// ---------------------------------------------------------------------------
// quota / events / context-graph pass-through stubs
// ---------------------------------------------------------------------------

describe('quota, events, context-graph pass-throughs (sources land M3)', () => {
  it('publishQuota fans out a frozen-valid snapshot and replays on reconnect', async () => {
    const client = await connect();
    handle.publishQuota(quotaSnapshot());
    await waitFor(() => client.on(CHANNEL.QUOTA).length === 1, 'the snapshot');
    expect(client.on(CHANNEL.QUOTA)[0]?.seq).toBe(0);

    handle.publishQuota(quotaSnapshot({ window: '7d_sonnet', usedPct: 100, source: 'oauth-poll' }));
    const late = await connect();
    late.sendEnvelope(CHANNEL.QUOTA, { kind: 'replay-request', channel: 'quota', fromSeq: 0 });
    await waitFor(() => late.on(CHANNEL.QUOTA).length === 2, 'the replayed snapshots');
    expect(late.on(CHANNEL.QUOTA).map((envelope) => envelope.seq)).toEqual([0, 1]);
  });

  it('publishQuota THROWS on an invalid snapshot and nothing reaches the wire', async () => {
    const client = await connect();
    expect(() => handle.publishQuota(quotaSnapshot({ usedPct: 108.2 }))).toThrow(RangeError);
    await settle();
    expect(client.on(CHANNEL.QUOTA)).toEqual([]);
  });

  it('publishContextTouch fans out; identity-carrying payloads THROW ([X2] design pin)', async () => {
    const client = await connect();
    handle.publishContextTouch(contextTouch());
    await waitFor(() => client.on(CHANNEL.CONTEXT_GRAPH).length === 1, 'the touch');

    expect(() =>
      handle.publishContextTouch({ ...contextTouch(), account: 'MAX_A' } as unknown as ContextGraphTouch),
    ).toThrow(RangeError);
    await settle();
    expect(client.on(CHANNEL.CONTEXT_GRAPH)).toHaveLength(1);
  });

  it('publishEvent pushes opaque DRAFT envelopes on events (client payloads still rejected)', async () => {
    const client = await connect();
    handle.publishEvent({ kind: 'synthesized-draft-event' });
    await waitFor(() => client.on(CHANNEL.EVENTS).length === 1, 'the event');
    expect(client.on(CHANNEL.EVENTS)[0]?.payload).toEqual({ kind: 'synthesized-draft-event' });

    client.sendEnvelope(CHANNEL.EVENTS, { kind: 'noise' });
    await waitFor(() => client.envelopes.some(isErrorWithCode('bad-request')), 'the policy reject');
  });
});

// ---------------------------------------------------------------------------
// PTY byte streaming (§5/§6 on the wire)
// ---------------------------------------------------------------------------

describe('pty streaming (positive)', () => {
  it('attach-by-replay-request delivers OUTPUT frames with the frozen codec and contiguous offsets', async () => {
    const session = ptyHost.announce(SID);
    session.emitOutput('before-attach;');

    const client = await connect();
    client.sendEnvelope(ptyChannel(SID), { kind: 'pty-replay-request', sessionId: SID, fromWatermark: 0 });
    await waitFor(() => client.ptyBytesFor(SID) === 14, 'the retained bytes');

    session.emitOutput('after-attach');
    await waitFor(() => client.ptyBytesFor(SID) === 26, 'the live bytes');

    const stream = client.ptyStreamFor(SID);
    expect(stream.firstOffset).toBe(0);
    expect(new TextDecoder().decode(stream.bytes)).toBe('before-attach;after-attach');
  });

  it('INPUT frames write through to the host session', async () => {
    const session = ptyHost.announce(SID);
    const client = await connect();
    client.sendBinary(
      encodePtyFrame({
        type: 'input',
        sessionId: SID,
        streamOffset: 0,
        payload: new TextEncoder().encode('ls\n'),
      }),
    );
    await waitFor(() => session.written.length === 1, 'the input write');
    expect(session.writtenUtf8()).toEqual(['ls\n']);
  });

  it('pty-resize propagates geometry to the host session', async () => {
    const session = ptyHost.announce(SID);
    const client = await connect();
    client.sendEnvelope(ptyChannel(SID), { kind: 'pty-resize', sessionId: SID, cols: 120, rows: 40 });
    await waitFor(() => session.resizes.length === 1, 'the resize');
    expect(session.resizes[0]).toEqual({ cols: 120, rows: 40 });
  });

  it('fans out one session to TWO clients, each with its own ack cursor', async () => {
    const session = ptyHost.announce(SID);
    const clientA = await connect();
    const clientB = await connect();
    for (const client of [clientA, clientB]) {
      client.sendEnvelope(ptyChannel(SID), { kind: 'pty-replay-request', sessionId: SID, fromWatermark: 0 });
    }
    await settle(); // both attached
    session.emitOutput('shared-output');
    for (const client of [clientA, clientB]) {
      await waitFor(() => client.ptyBytesFor(SID) === 13, 'fan-out bytes');
      expect(new TextDecoder().decode(client.ptyStreamFor(SID).bytes)).toBe('shared-output');
    }
  });
});

describe('pty streaming (negative)', () => {
  it('pty traffic for an unknown session answers session-not-found', async () => {
    const client = await connect();
    client.sendEnvelope(ptyChannel('ses_fake_ghost'), {
      kind: 'pty-ack',
      sessionId: 'ses_fake_ghost',
      watermark: 0,
    });
    await waitFor(() => client.envelopes.some(isErrorWithCode('session-not-found')), 'the refusal');
  });

  it('an ack beyond the delivered offset answers watermark-out-of-range', async () => {
    const session = ptyHost.announce(SID);
    const client = await connect();
    client.sendEnvelope(ptyChannel(SID), { kind: 'pty-replay-request', sessionId: SID, fromWatermark: 0 });
    await settle();
    session.emitOutput('tiny');
    await waitFor(() => client.ptyBytesFor(SID) === 4, 'the bytes');
    client.sendEnvelope(ptyChannel(SID), { kind: 'pty-ack', sessionId: SID, watermark: 4096 });
    await waitFor(() => client.envelopes.some(isErrorWithCode('watermark-out-of-range')), 'the refusal');
  });

  it('an ack from a never-attached connection is beyond its delivered offset (0)', async () => {
    ptyHost.announce(SID);
    const client = await connect();
    client.sendEnvelope(ptyChannel(SID), { kind: 'pty-ack', sessionId: SID, watermark: 10 });
    await waitFor(() => client.envelopes.some(isErrorWithCode('watermark-out-of-range')), 'the refusal');
  });

  it('a replay below the released floor is unrecoverable by design', async () => {
    const session = ptyHost.announce(SID);
    const client = await connect();
    const channel = ptyChannel(SID);
    client.sendEnvelope(channel, { kind: 'pty-replay-request', sessionId: SID, fromWatermark: 0 });
    await settle();
    session.emitOutput('0123456789');
    await waitFor(() => client.ptyBytesFor(SID) === 10, 'the bytes');
    client.sendEnvelope(channel, { kind: 'pty-ack', sessionId: SID, watermark: 10 }); // releases them
    await settle();
    client.sendEnvelope(channel, { kind: 'pty-replay-request', sessionId: SID, fromWatermark: 2 });
    await waitFor(() => client.envelopes.some(isErrorWithCode('watermark-out-of-range')), 'the refusal');
  });

  it('a client-sent OUTPUT frame is rejected as bad-request (direction violation)', async () => {
    ptyHost.announce(SID);
    const client = await connect();
    client.sendBinary(
      encodePtyFrame({ type: 'output', sessionId: SID, streamOffset: 0, payload: new Uint8Array([1]) }),
    );
    await waitFor(() => client.envelopes.some(isErrorWithCode('bad-request')), 'the refusal');
  });
});

describe('pty streaming (edge: slow consumer + reconnect, SPIKE-D on the wire)', () => {
  it('slow consumer: bounded delivery, producer backpressure, ZERO byte loss', async () => {
    const session = ptyHost.announce(SID);
    const fast = await connect();
    const slow = await connect();
    const channel = ptyChannel(SID);
    fast.sendEnvelope(channel, { kind: 'pty-replay-request', sessionId: SID, fromWatermark: 0 });
    slow.sendEnvelope(channel, { kind: 'pty-replay-request', sessionId: SID, fromWatermark: 0 });
    await settle(); // both attached

    // Produce until the gateway pulls the pause lever (a compliant producer
    // stops at the lever, exactly like the node-pty host will).
    const emitted: number[] = [];
    for (let i = 0; i < 64 && !session.paused; i += 1) {
      const chunk = new Uint8Array(256).fill(i);
      emitted.push(...chunk);
      session.emitOutput(chunk);
    }
    expect(session.paused).toBe(true);
    expect(session.pauseCount).toBe(1);
    expect(emitted.length).toBe(WIRE_FLOW.highWater); // paused exactly at highWater

    // The slow consumer is capped at the delivery window; the fast one too
    // (it has not acked yet) — bounded memory on every axis.
    await waitFor(() => fast.ptyBytesFor(SID) === WIRE_FLOW.deliveryWindowBytes, 'fast window');
    await waitFor(() => slow.ptyBytesFor(SID) === WIRE_FLOW.deliveryWindowBytes, 'slow window');
    await settle();
    expect(slow.ptyBytesFor(SID)).toBe(WIRE_FLOW.deliveryWindowBytes);

    // Fast consumer drains fully; the slow one still pins the buffer: paused.
    const ackAll = async (client: StreamClient): Promise<void> => {
      let previous = -1;
      while (client.ptyBytesFor(SID) > previous) {
        previous = client.ptyBytesFor(SID);
        client.sendEnvelope(channel, { kind: 'pty-ack', sessionId: SID, watermark: previous });
        await settle(30);
      }
    };
    await ackAll(fast);
    expect(fast.ptyBytesFor(SID)).toBe(emitted.length);
    expect(session.paused).toBe(true); // slow consumer gates release

    // The slow consumer finally acks: buffer drains, producer resumes,
    // and it has received EVERY byte in order — zero loss, zero dup.
    await ackAll(slow);
    await waitFor(() => !session.paused, 'the resume lever');
    expect(session.resumeCount).toBeGreaterThanOrEqual(1);

    for (const client of [fast, slow]) {
      const stream = client.ptyStreamFor(SID);
      expect(stream.firstOffset).toBe(0);
      expect(stream.bytes).toEqual(new Uint8Array(emitted));
    }

    // Live flow continues for both after the drain.
    session.emitOutput('post-drain');
    for (const client of [fast, slow]) {
      await waitFor(() => client.ptyBytesFor(SID) === emitted.length + 10, 'post-drain bytes');
    }
  });

  it('reconnect replays retained OUTPUT bytes from the watermark exactly once', async () => {
    const session = ptyHost.announce(SID);
    const channel = ptyChannel(SID);
    const first = await connect();
    first.sendEnvelope(channel, { kind: 'pty-replay-request', sessionId: SID, fromWatermark: 0 });
    await settle();

    session.emitOutput(new Uint8Array(600).fill(7));
    await waitFor(() => first.ptyBytesFor(SID) === 600, 'first client bytes');
    first.sendEnvelope(channel, { kind: 'pty-ack', sessionId: SID, watermark: 400 });
    await settle();
    first.close();
    await first.closed;

    // More output lands while nobody is attached (floor frozen at 400).
    session.emitOutput(new Uint8Array(200).fill(9));

    const second = await connect();
    second.sendEnvelope(channel, { kind: 'pty-replay-request', sessionId: SID, fromWatermark: 400 });
    await waitFor(() => second.ptyBytesFor(SID) === 400, 'the replayed tail');
    const stream = second.ptyStreamFor(SID);
    expect(stream.firstOffset).toBe(400);
    expect(stream.bytes).toEqual(new Uint8Array([...new Array<number>(200).fill(7), ...new Array<number>(200).fill(9)]));
    // ptyStreamFor throws on overlap/gap — reaching here proves exactly-once.
  });

  it('trailing output of an exited session stays replayable', async () => {
    const session = ptyHost.announce(SID);
    session.emitOutput('final words');
    session.emitExit();

    const client = await connect();
    client.sendEnvelope(ptyChannel(SID), { kind: 'pty-replay-request', sessionId: SID, fromWatermark: 0 });
    await waitFor(() => client.ptyBytesFor(SID) === 11, 'the trailing bytes');
    expect(new TextDecoder().decode(client.ptyStreamFor(SID).bytes)).toBe('final words');
  });

  it('a disconnecting slow consumer un-pins the buffer (floor recomputes on detach)', async () => {
    const session = ptyHost.announce(SID);
    const channel = ptyChannel(SID);
    const fast = await connect();
    const slow = await connect();
    fast.sendEnvelope(channel, { kind: 'pty-replay-request', sessionId: SID, fromWatermark: 0 });
    slow.sendEnvelope(channel, { kind: 'pty-replay-request', sessionId: SID, fromWatermark: 0 });
    await settle();

    for (let i = 0; i < 64 && !session.paused; i += 1) {
      session.emitOutput(new Uint8Array(256).fill(i));
    }
    expect(session.paused).toBe(true);

    // Fast consumer catches up; slow one pins, then disconnects.
    let previous = -1;
    while (fast.ptyBytesFor(SID) > previous) {
      previous = fast.ptyBytesFor(SID);
      fast.sendEnvelope(channel, { kind: 'pty-ack', sessionId: SID, watermark: previous });
      await settle(30);
    }
    expect(session.paused).toBe(true);
    slow.close();
    await slow.closed;
    await waitFor(() => !session.paused, 'resume after detach');
  });
});

// ---------------------------------------------------------------------------
// multi-channel fan-out sanity (two clients, one session, all M2 surfaces)
// ---------------------------------------------------------------------------

describe('multi-client fan-out (edge)', () => {
  it('two clients share one session across transcript + approvals + pty simultaneously', async () => {
    const session = ptyHost.announce(SID);
    const clientA = await connect();
    const clientB = await connect();
    const tChannel = transcriptChannel(SID);
    const pChannel = ptyChannel(SID);
    for (const client of [clientA, clientB]) {
      client.sendEnvelope(pChannel, { kind: 'pty-replay-request', sessionId: SID, fromWatermark: 0 });
    }
    await settle();

    transcripts.emit(SID, assistantText('m-multi', 'multi-surface'));
    approvals.emitRequest(approvalRequest('apr_fake_multi'));
    session.emitOutput('pty-multi');

    for (const client of [clientA, clientB]) {
      await waitFor(
        () =>
          client.on(tChannel).length === 1 &&
          client.on(CHANNEL.APPROVALS).length === 1 &&
          client.ptyBytesFor(SID) === 9,
        'all three surfaces on both clients',
      );
    }
  });
});
