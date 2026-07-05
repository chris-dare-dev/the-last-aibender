/**
 * GatewayClient behavior (plan §9.2 FE-2 rows):
 * Positive: discovery → connect → control round-trip; replay-requests on
 *           first connect.
 * Negative: malformed envelope dropped + logged with the connection
 *           UNAFFECTED; unauthenticated connect fails VISIBLY (auth-rejected,
 *           no reconnect storm).
 * Edge: reconnect resumes from watermarks with duplicate-seq drops
 *       (exactly-once toward stores); broker restart discards all
 *       watermarks; pending requests reject on close; PTY conduit ack +
 *       byte-axis replay trimming.
 */

import { describe, expect, it } from 'vitest';
import {
  encodePtyFrame,
  type PipelineClientPayload,
  type WorkstreamMergeRequest,
} from '@aibender/protocol';
import { nullLogger } from '../log.ts';
import {
  FAKE_GATEWAY_TOKEN,
  FAKE_NEW_BOOT_TOKEN,
  FakeWebSocket,
  FakeWsHub,
  ManualTimers,
  fakeBootstrap,
  flushAsync,
} from '../testing/fakes.ts';
import { encodeEnvelope } from './outbound.ts';
import {
  GatewayClient,
  type ClientPhase,
  type ProtocolViolation,
} from './wsClient.ts';
import type { InboundMessage } from './inboundRouter.ts';
import type { GatewayBootstrap } from '../bootstrap.ts';

interface Harness {
  client: GatewayClient;
  hub: FakeWsHub;
  timers: ManualTimers;
  phases: ClientPhase[];
  messages: InboundMessage[];
  violations: ProtocolViolation[];
  duplicates: { channel: string; seq: number }[];
  restarts: number;
  setBootstrap(b: GatewayBootstrap | undefined): void;
}

function harness(...args: [] | [GatewayBootstrap | undefined]): Harness {
  // NOTE: an explicit `harness(undefined)` means "no broker advertised";
  // a default parameter would silently swallow that case.
  let bootstrap = args.length === 0 ? fakeBootstrap() : args[0];
  const hub = new FakeWsHub();
  const timers = new ManualTimers();
  const client = new GatewayClient({
    bootstrapProvider: async () => bootstrap,
    wsFactory: hub.factory,
    timers,
    logger: nullLogger,
    discoveryPollMs: 1000,
    backoff: { minMs: 100, maxMs: 5000, factor: 2 },
    requestTimeoutMs: 2000,
  });
  const h: Harness = {
    client,
    hub,
    timers,
    phases: [],
    messages: [],
    violations: [],
    duplicates: [],
    restarts: 0,
    setBootstrap: (b) => {
      bootstrap = b;
    },
  };
  client.subscribe({
    onPhase: (p) => h.phases.push(p),
    onMessage: (m) => h.messages.push(m),
    onViolation: (v) => h.violations.push(v),
    onDuplicateDropped: (channel, seq) => h.duplicates.push({ channel, seq }),
    onBrokerRestart: () => {
      h.restarts += 1;
    },
  });
  return h;
}

function transcriptFrame(seq: number, text: string): string {
  return encodeEnvelope('transcript.ses_fake_1', seq, {
    kind: 'transcript-delta',
    sessionId: 'ses_fake_1',
    messageUuid: 'synthmsg-0',
    text,
  });
}

async function connect(h: Harness): Promise<void> {
  h.client.start();
  await flushAsync();
  h.hub.latest.open();
  await flushAsync();
}

describe('discovery', () => {
  it('treats an absent bootstrap as "no broker advertised" and re-probes calmly', async () => {
    const h = harness(undefined);
    h.client.start();
    await flushAsync();
    expect(h.client.currentPhase).toBe('no-broker');
    expect(h.hub.sockets).toHaveLength(0);

    // The broker appears; the next poll connects with the token URL.
    h.setBootstrap(fakeBootstrap());
    h.timers.advance(1000);
    await flushAsync();
    expect(h.hub.sockets).toHaveLength(1);
    expect(h.hub.latest.url).toBe(`ws://127.0.0.1:49152/?token=${FAKE_GATEWAY_TOKEN}`);
  });
});

describe('control round-trip', () => {
  it('correlates a status request with its result', async () => {
    const h = harness();
    await connect(h);
    expect(h.client.currentPhase).toBe('connected');

    const pending = h.client.request({ kind: 'status', id: 'req_09' });
    const sent = h.hub.latest.sentTexts;
    // control is per-connection seq; replay-requests ride OTHER channels, so
    // the first control frame of this connection carries seq 0.
    expect(sent).toContain(encodeEnvelope('control', 0, { kind: 'status', id: 'req_09' }));

    h.hub.latest.receiveText(
      encodeEnvelope('control', 0, {
        kind: 'result',
        id: 'req_09',
        ok: true,
        result: { verb: 'status', sessions: [] },
      }),
    );
    await expect(pending).resolves.toEqual({ verb: 'status', sessions: [] });
  });

  it('rejects with the frozen ErrorDetail on ok:false', async () => {
    const h = harness();
    await connect(h);
    const pending = h.client.request({ kind: 'resume', id: 'req_05', params: { sessionId: 'ses_fake_1' } });
    h.hub.latest.receiveText(
      encodeEnvelope('control', 1, {
        kind: 'result',
        id: 'req_05',
        ok: false,
        error: {
          code: 'double-resume-blocked',
          message: 'session is in a running-family state; resume with fork:true instead',
          retryable: false,
        },
      }),
    );
    await expect(pending).rejects.toMatchObject({
      name: 'ControlRequestError',
      detail: { code: 'double-resume-blocked' },
    });
  });

  it('rejects pending requests when the connection dies (edge)', async () => {
    const h = harness();
    await connect(h);
    const pending = h.client.request({ kind: 'status' });
    h.hub.latest.serverClose(1006);
    await expect(pending).rejects.toThrow('gateway connection closed');
  });
});

describe('malformed frames (negative)', () => {
  it('drops + reports them; the connection and later frames are unaffected', async () => {
    const h = harness();
    await connect(h);

    h.hub.latest.receiveText('synthesized non-json text frame');
    h.hub.latest.receiveText(
      JSON.stringify({ stream: 'events', channel: 'control', seq: 0, payload: {} }),
    );
    expect(h.violations.map((v) => v.code)).toEqual(['bad-envelope', 'bad-envelope']);
    expect(h.client.currentPhase).toBe('connected');

    h.hub.latest.receiveText(transcriptFrame(0, 'still alive'));
    expect(h.messages.filter((m) => m.kind === 'transcript')).toHaveLength(1);
  });
});

describe('unauthenticated connect (negative)', () => {
  it('fails visibly: auth-rejected phase, no reconnect storm', async () => {
    const h = harness();
    await connect(h);

    h.hub.latest.receiveText(
      encodeEnvelope('control', 0, {
        kind: 'error',
        code: 'bad-auth',
        message: 'missing or invalid gateway token',
        retryable: false,
        channel: 'control',
      }),
    );
    h.hub.latest.serverClose(1008);
    expect(h.client.currentPhase).toBe('auth-rejected');

    const socketCount = h.hub.sockets.length;
    h.timers.advance(60_000);
    await flushAsync();
    expect(h.hub.sockets).toHaveLength(socketCount); // NO storm

    // Manual retry is the sanctioned way out.
    h.client.retry();
    await flushAsync();
    expect(h.hub.sockets.length).toBe(socketCount + 1);
  });
});

describe('reconnect-replay watermarks (edge)', () => {
  it('sends replay-request fromSeq 0 on the first connect of a boot', async () => {
    const h = harness();
    await connect(h);
    const sent = h.hub.latest.sentTexts;
    expect(sent).toContain(
      encodeEnvelope('approvals', 0, { kind: 'replay-request', channel: 'approvals', fromSeq: 0 }),
    );
    expect(sent).toContain(
      encodeEnvelope('quota', 0, { kind: 'replay-request', channel: 'quota', fromSeq: 0 }),
    );
    // EVENTS joined the default set at M3: retained read-model snapshots
    // hydrate the observability instruments on app start.
    expect(sent).toContain(
      encodeEnvelope('events', 0, { kind: 'replay-request', channel: 'events', fromSeq: 0 }),
    );
    // WORKSTREAM + CONTEXT_GRAPH joined at M4: retained §16.5 list/detail
    // snapshots hydrate the lineage view, and the retained touch window
    // warm-starts the graph island's activity read model.
    expect(sent).toContain(
      encodeEnvelope('workstream', 0, {
        kind: 'replay-request',
        channel: 'workstream',
        fromSeq: 0,
      }),
    );
    expect(sent).toContain(
      encodeEnvelope('context-graph', 0, {
        kind: 'replay-request',
        channel: 'context-graph',
        fromSeq: 0,
      }),
    );
    // PIPELINES joined the default set at M5: the retained §18 catalog snapshot
    // + run/step-status window hydrate the builder palette + run monitor on the
    // first connect of a broker boot (the golden pipelines-replay-request-valid
    // fixture).
    expect(sent).toContain(
      encodeEnvelope('pipelines', 0, {
        kind: 'replay-request',
        channel: 'pipelines',
        fromSeq: 0,
      }),
    );
  });

  it('resumes from lastSeq+1 and drops replayed duplicates exactly-once', async () => {
    const h = harness();
    await connect(h);

    for (let seq = 0; seq <= 5; seq += 1) h.hub.latest.receiveText(transcriptFrame(seq, `t${seq}`));
    expect(h.client.watermarkOf('transcript.ses_fake_1')).toBe(5);

    // Connection dies; backoff reconnects to the SAME boot.
    h.hub.latest.serverClose(1006);
    h.timers.advance(100);
    await flushAsync();
    const socket = h.hub.latest;
    socket.open();
    await flushAsync();

    expect(socket.sentTexts).toContain(
      encodeEnvelope('transcript.ses_fake_1', 0, {
        kind: 'replay-request',
        channel: 'transcript.ses_fake_1',
        fromSeq: 6,
      }),
    );
    // No fromSeq-0 re-pull: this is NOT the first connect of the boot.
    expect(socket.sentTexts.filter((f) => f.includes('"fromSeq":0'))).toHaveLength(0);

    // Broker replays an overlapping window 4..8 with ORIGINAL seq values.
    const before = h.messages.filter((m) => m.kind === 'transcript').length;
    for (let seq = 4; seq <= 8; seq += 1) socket.receiveText(transcriptFrame(seq, `t${seq}`));
    const after = h.messages.filter((m) => m.kind === 'transcript').length;
    expect(after - before).toBe(3); // 6,7,8 applied — 4,5 dropped as duplicates
    expect(h.duplicates.map((d) => d.seq)).toEqual([4, 5]);
    expect(h.client.watermarkOf('transcript.ses_fake_1')).toBe(8);
  });

  it('discards every watermark on broker restart (boot identity change)', async () => {
    const h = harness();
    await connect(h);
    h.hub.latest.receiveText(transcriptFrame(0, 'old boot'));
    expect(h.client.watermarkOf('transcript.ses_fake_1')).toBe(0);

    h.hub.latest.serverClose(1006);
    h.setBootstrap(fakeBootstrap({ token: FAKE_NEW_BOOT_TOKEN, pid: 54321 }));
    h.timers.advance(100);
    await flushAsync();
    const socket = h.hub.latest;
    socket.open();
    await flushAsync();

    expect(h.restarts).toBe(1);
    expect(h.client.watermarkOf('transcript.ses_fake_1')).toBeUndefined();
    // Fresh boot ⇒ first-connect replay-from-zero fires again; no stale
    // transcript watermark survives.
    expect(socket.sentTexts).toContain(
      encodeEnvelope('approvals', 0, { kind: 'replay-request', channel: 'approvals', fromSeq: 0 }),
    );
    expect(
      socket.sentTexts.some((f) => f.includes('transcript.ses_fake_1') && f.includes('replay-request')),
    ).toBe(false);
  });
});

describe('workstream merge sender (ws-protocol.md §16.2)', () => {
  const mergeRequest: WorkstreamMergeRequest = {
    kind: 'workstream-merge-request',
    mergeId: 'mrg_fe_spec_1',
    params: {
      parents: ['ses_fake_1', 'ses_fake_2'],
      accountLabel: 'MAX_A',
      backend: 'claude_code',
      cwd: '/synth/dir',
      purpose: 'merge sender spec',
      briefBody: '## synthesized merge brief\n\npaths + session ids only.',
    },
  };

  it('rides the workstream channel with the sendApprovalDecision mirror (positive)', async () => {
    const h = harness();
    await connect(h);
    expect(h.client.sendWorkstreamMergeRequest(mergeRequest)).toBe(true);
    // seq 1: the first-connect replay-request took seq 0 on this channel.
    expect(h.hub.latest.sentTexts).toContain(encodeEnvelope('workstream', 1, mergeRequest));
  });

  it('returns false while not connected — the unsendable posture, never a throw (negative)', () => {
    const h = harness(undefined);
    h.client.start();
    expect(h.client.sendWorkstreamMergeRequest(mergeRequest)).toBe(false);
  });

  it('satisfies the FE-6 sender port structurally (compile-enforced pin)', () => {
    const h = harness();
    // The features/workstreams/ports.ts WorkstreamMergeSender shape, inlined
    // (lib never imports features): registerWorkstreams detects this method
    // structurally, so the deck wires merge dispatch with no FE-6 change.
    const sender: { sendWorkstreamMergeRequest(r: WorkstreamMergeRequest): boolean } = h.client;
    expect(typeof sender.sendWorkstreamMergeRequest).toBe('function');
  });
});

describe('pipeline verb sender (ws-protocol.md §18.2)', () => {
  // A minimal document-free verb (resume) exercises the sender end-to-end
  // without depending on a DAG document shape.
  const resumeVerb: PipelineClientPayload = {
    kind: 'pipeline-resume',
    requestId: 'req_fe_pl_1',
    runId: 'run_fe_spec_1',
  };

  it('rides the pipelines channel with the sendApprovalDecision mirror (positive)', async () => {
    const h = harness();
    await connect(h);
    expect(h.client.sendPipelineMessage(resumeVerb)).toBe(true);
    // seq 1: the first-connect replay-request took seq 0 on this channel.
    expect(h.hub.latest.sentTexts).toContain(encodeEnvelope('pipelines', 1, resumeVerb));
  });

  it('returns false while not connected — the unsendable posture, never a throw (negative)', () => {
    const h = harness(undefined);
    h.client.start();
    expect(h.client.sendPipelineMessage(resumeVerb)).toBe(false);
  });

  it('satisfies the FE-6 PipelineVerbSender port structurally (compile-enforced pin)', () => {
    const h = harness();
    // The features/pipelines/ports.ts PipelineVerbSender shape, inlined (lib
    // never imports features): register.tsx detects this method structurally,
    // so the deck wires every verb dispatch with no FE-6 change.
    const sender: { sendPipelineMessage(m: PipelineClientPayload): boolean } = h.client;
    expect(typeof sender.sendPipelineMessage).toBe('function');
  });
});

describe('pty conduit', () => {
  function outputFrame(streamOffset: number, text: string): Uint8Array {
    return encodePtyFrame({
      type: 'output',
      sessionId: 'ses_fake_1',
      streamOffset,
      payload: new TextEncoder().encode(text),
    });
  }

  it('attaches on openPty-while-connected: the FIRST pty-replay-request is sent immediately (§6 attach pin)', async () => {
    const h = harness();
    await connect(h);
    h.client.openPty('ses_fake_1');
    // No implicit attach at subscribe time — the client must send the attach
    // verb itself or it would receive zero bytes from the real gateway.
    expect(h.hub.latest.sentTexts).toContain(
      encodeEnvelope('pty.ses_fake_1', 0, {
        kind: 'pty-replay-request',
        sessionId: 'ses_fake_1',
        fromWatermark: 0,
      }),
    );
  });

  it('withholds OUTPUT until attach in the fake (contract enforcement, negative)', () => {
    // Drive the fake directly: a never-attached connection receives nothing.
    const socket = new FakeWebSocket('ws://127.0.0.1:1/?token=t');
    const delivered: unknown[] = [];
    socket.open();
    socket.onmessage = (ev) => delivered.push(ev.data);
    socket.receiveBinary(outputFrame(0, 'pre-attach bytes'));
    expect(delivered).toHaveLength(0); // §6: no implicit attach at subscribe
    socket.send(
      encodeEnvelope('pty.ses_fake_1', 0, {
        kind: 'pty-replay-request',
        sessionId: 'ses_fake_1',
        fromWatermark: 0,
      }),
    );
    socket.receiveBinary(outputFrame(0, 'post-attach bytes'));
    expect(delivered).toHaveLength(1);
  });

  it('delivers OUTPUT bytes, acks consumption, replays from the consumed watermark', async () => {
    const h = harness();
    await connect(h);
    const conduit = h.client.openPty('ses_fake_1');
    const received: string[] = [];
    conduit.onBytes((chunk) => received.push(new TextDecoder().decode(chunk)));

    h.hub.latest.receiveBinary(outputFrame(0, 'hello '));
    h.hub.latest.receiveBinary(outputFrame(6, 'world'));
    expect(received.join('')).toBe('hello world');

    conduit.consume(6);
    await flushAsync();
    // seq 1: the attach pty-replay-request took seq 0 on this channel.
    expect(h.hub.latest.sentTexts).toContain(
      encodeEnvelope('pty.ses_fake_1', 1, { kind: 'pty-ack', sessionId: 'ses_fake_1', watermark: 6 }),
    );

    // Reconnect (same boot): replay is requested from the CONSUMED offset
    // and the overlapping replay is trimmed — no byte arrives twice.
    h.hub.latest.serverClose(1006);
    h.timers.advance(100);
    await flushAsync();
    const socket = h.hub.latest;
    socket.open();
    await flushAsync();
    expect(socket.sentTexts).toContain(
      encodeEnvelope('pty.ses_fake_1', 0, {
        kind: 'pty-replay-request',
        sessionId: 'ses_fake_1',
        fromWatermark: 6,
      }),
    );
    socket.receiveBinary(outputFrame(6, 'world again'));
    expect(received.join('')).toBe('hello worldworld again');
  });

  it('encodes island keystrokes as INPUT frames on the input byte axis', async () => {
    const h = harness();
    await connect(h);
    const conduit = h.client.openPty('ses_fake_1');
    conduit.write('ls\n');
    conduit.write('x');
    const frames = h.hub.latest.sentBinary;
    expect(frames).toHaveLength(2);
    const first = frames[0] as Uint8Array;
    expect(first[2]).toBe(0x02); // INPUT frame type
    // Second frame continues the input offset axis (3 bytes written).
    const second = frames[1] as Uint8Array;
    const view = new DataView(second.buffer, second.byteOffset);
    expect(Number(view.getBigUint64(4))).toBe(3);
  });
});
