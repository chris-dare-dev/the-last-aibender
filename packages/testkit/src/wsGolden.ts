/**
 * Golden WS-protocol fixture corpus (plan §3 testkit row; §9.3 BE↔FE #1;
 * ICR-0003; extended at the M2 full freeze). One set of EXACT wire frames —
 * text envelopes and binary PTY frames — replayed by BOTH departments' CI:
 * the BE-3 gateway must produce these verdicts for inbound frames, and the
 * FE-2 client must produce them for broker-pushed frames. A fixture change
 * requires both orchestrators' sign-off (docs/contracts/icr/).
 *
 * VERSIONING: {@link GOLDEN_WS_CORPUS_FREEZE} names the protocol freeze this
 * corpus pins (must equal @aibender/protocol's PROTOCOL_FREEZE — asserted in
 * the suite). The M2 extension adds fixtures for every surface promoted at
 * the M2 freeze: transcript/approvals/quota/context-graph payloads and the
 * JSON `replay-request`. The `events` payload union is still DRAFT (M3) —
 * the corpus pins only its channel POLICY (client payloads rejected;
 * broker pushes treated as opaque until M3).
 *
 * Every fixture pins:
 *   - the exact frame bytes (text: the UTF-8 string sent as one WS text
 *     frame; binary: lowercase hex of the WS binary frame);
 *   - the expected verdict — valid, or the exact frozen ErrorCode;
 *   - the STAGE that must produce the verdict (json-parse → envelope →
 *     channel-specific validator), mirroring the gateway's routing order.
 *
 * {@link replayGoldenWsFixture} is the reference replay: it routes a fixture
 * through the FROZEN @aibender/protocol validators exactly the way the
 * gateway's routeTextFrame/routeBinaryFrame do. Departments may replay the
 * raw frames through their own stacks instead — the bytes and verdicts are
 * the contract, the helper is a convenience.
 *
 * [X2]: all fixture content is synthesized — placeholder labels, `ses_fake_*`
 * ids, `/synthetic/...` paths. The suite screens every frame through the
 * jsonl.ts identity-shape guard.
 */

import {
  PROTOCOL_FREEZE,
  decodePtyFrame,
  isReplayableChannel,
  sessionIdOfChannel,
  validateApprovalsClientMessage,
  validateApprovalsServerMessage,
  validateContextGraphTouch,
  validateControlRequest,
  validateControlResponse,
  validateEnvelope,
  validateErrorPayload,
  validateJsonReplayRequest,
  validatePtyClientMessage,
  validateQuotaSnapshot,
  validateTranscriptPayload,
  type ErrorCode,
} from '@aibender/protocol';

/** The protocol freeze this corpus pins (asserted equal to PROTOCOL_FREEZE). */
export const GOLDEN_WS_CORPUS_FREEZE: typeof PROTOCOL_FREEZE = 'FROZEN-M2';

// ---------------------------------------------------------------------------
// Fixture types
// ---------------------------------------------------------------------------

export type GoldenWsDirection = 'client-to-broker' | 'broker-to-client';

/** The validation stage that must produce the fixture's verdict. */
export type GoldenWsStage =
  | 'json-parse'
  | 'envelope'
  | 'control-request'
  | 'control-response'
  | 'error-payload'
  | 'pty-client-message'
  /**
   * Verdict comes from channel POLICY, not a payload validator: channels
   * whose payload union is still draft (events until M3) accept no client
   * payloads and their broker pushes pass as opaque envelopes.
   */
  | 'channel-policy'
  | 'pty-frame-codec'
  // M2 freeze stages ---------------------------------------------------------
  | 'transcript-payload'
  | 'approvals-client-message'
  | 'approvals-server-message'
  | 'quota-payload'
  | 'context-graph-payload'
  | 'replay-request';

export type GoldenWsExpectation =
  | { readonly valid: true }
  | { readonly valid: false; readonly code: ErrorCode };

export interface GoldenWsTextFixture {
  readonly name: string;
  readonly kind: 'text';
  readonly direction: GoldenWsDirection;
  /** EXACT text-frame content — replay verbatim, never re-serialize. */
  readonly frame: string;
  readonly stage: GoldenWsStage;
  readonly expect: GoldenWsExpectation;
  readonly notes?: string;
}

export interface GoldenWsBinaryFixture {
  readonly name: string;
  readonly kind: 'binary';
  readonly direction: GoldenWsDirection;
  /** EXACT binary-frame bytes as lowercase hex (see goldenFrameBytes). */
  readonly frameHex: string;
  readonly stage: 'pty-frame-codec';
  readonly expect: GoldenWsExpectation;
  /** Decoded field expectations for valid frames (round-trip pin). */
  readonly decoded?: {
    readonly type: 'output' | 'input';
    readonly sessionId: string;
    readonly streamOffset: number;
    readonly payloadUtf8: string;
  };
  readonly notes?: string;
}

export type GoldenWsFixture = GoldenWsTextFixture | GoldenWsBinaryFixture;

/** Decode a binary fixture's hex into the exact wire bytes. */
export function goldenFrameBytes(fixture: GoldenWsBinaryFixture): Uint8Array {
  const hex = fixture.frameHex;
  if (hex.length % 2 !== 0 || /[^0-9a-f]/.test(hex)) {
    throw new RangeError(`golden fixture ${fixture.name} has malformed frameHex`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Frame builders (module-local; JSON.stringify key order is insertion order,
// so frames built from literals are deterministic across engines)
// ---------------------------------------------------------------------------

function controlFrame(seq: number, payload: unknown): string {
  return JSON.stringify({ stream: 'control', channel: 'control', seq, payload });
}

function ptyJsonFrame(sessionId: string, seq: number, payload: unknown): string {
  return JSON.stringify({ stream: 'pty', channel: `pty.${sessionId}`, seq, payload });
}

function transcriptFrame(sessionId: string, seq: number, payload: unknown): string {
  return JSON.stringify({
    stream: 'transcript',
    channel: `transcript.${sessionId}`,
    seq,
    payload,
  });
}

function staticFrame(
  channel: 'events' | 'quota' | 'approvals' | 'context-graph',
  seq: number,
  payload: unknown,
): string {
  return JSON.stringify({ stream: channel, channel, seq, payload });
}

const FULL_STATUS = {
  sessionId: 'ses_fake_1',
  accountLabel: 'MAX_A',
  backend: 'claude_code',
  substrate: 'sdk',
  state: 'running',
  cwd: '/synthetic/workspace',
  purpose: 'golden status',
  workstreamHint: 'ws_golden',
  nativeSessionId: 'fake-native-0',
  pid: 40001,
} as const;

const MINIMAL_STATUS = {
  sessionId: 'ses_fake_2',
  accountLabel: 'ENT',
  backend: 'claude_code',
  substrate: 'pty',
  state: 'spawning',
  cwd: '/synthetic/workspace',
  purpose: 'golden minimal status',
} as const;

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

export const GOLDEN_WS_FIXTURES: readonly GoldenWsFixture[] = Object.freeze([
  // ---- client → broker: valid control verbs ---------------------------------
  {
    name: 'control-launch-min',
    kind: 'text',
    direction: 'client-to-broker',
    frame: controlFrame(0, {
      kind: 'launch',
      id: 'req_01',
      params: {
        accountLabel: 'MAX_A',
        backend: 'claude_code',
        substrate: 'sdk',
        cwd: '/synthetic/workspace',
        purpose: 'golden launch',
      },
    }),
    stage: 'control-request',
    expect: { valid: true },
  },
  {
    name: 'control-launch-full',
    kind: 'text',
    direction: 'client-to-broker',
    frame: controlFrame(1, {
      kind: 'launch',
      id: 'req_02',
      params: {
        accountLabel: 'AWS_DEV',
        backend: 'opencode',
        substrate: 'sdk',
        cwd: '/synthetic/workspace',
        purpose: 'golden headless one-off',
        workstreamHint: 'ws_golden',
        prompt: 'synthesized one-off prompt',
      },
    }),
    stage: 'control-request',
    expect: { valid: true },
  },
  {
    name: 'control-launch-pty',
    kind: 'text',
    direction: 'client-to-broker',
    frame: controlFrame(2, {
      kind: 'launch',
      id: 'req_03',
      params: {
        accountLabel: 'MAX_B',
        backend: 'claude_code',
        substrate: 'pty',
        cwd: '/synthetic/workspace',
        purpose: 'golden attended session',
      },
    }),
    stage: 'control-request',
    expect: { valid: true },
    notes: 'pty substrate is claude_code-only — this is the allowed pairing',
  },
  {
    name: 'control-launch-local',
    kind: 'text',
    direction: 'client-to-broker',
    frame: controlFrame(3, {
      kind: 'launch',
      id: 'req_04',
      params: {
        accountLabel: 'LOCAL',
        backend: 'lmstudio',
        substrate: 'sdk',
        cwd: '/synthetic/workspace',
        purpose: 'golden local-model launch',
      },
    }),
    stage: 'control-request',
    expect: { valid: true },
  },
  {
    name: 'control-resume-in-place',
    kind: 'text',
    direction: 'client-to-broker',
    frame: controlFrame(4, {
      kind: 'resume',
      id: 'req_05',
      params: { sessionId: 'ses_fake_1' },
    }),
    stage: 'control-request',
    expect: { valid: true },
  },
  {
    name: 'control-resume-fork',
    kind: 'text',
    direction: 'client-to-broker',
    frame: controlFrame(5, {
      kind: 'resume',
      id: 'req_06',
      params: { sessionId: 'ses_fake_1', fork: true },
    }),
    stage: 'control-request',
    expect: { valid: true },
  },
  {
    name: 'control-resume-with-prompt',
    kind: 'text',
    direction: 'client-to-broker',
    frame: controlFrame(18, {
      kind: 'resume',
      id: 'req_20',
      params: { sessionId: 'ses_fake_1', fork: false, prompt: 'synthesized next user prompt' },
    }),
    stage: 'control-request',
    expect: { valid: true },
    notes:
      'ICR-0004: optional next-user-prompt on resume — REQUIRED broker-side for sdk sessions at M1',
  },
  {
    name: 'control-kill-default',
    kind: 'text',
    direction: 'client-to-broker',
    frame: controlFrame(6, {
      kind: 'kill',
      id: 'req_07',
      params: { sessionId: 'ses_fake_1' },
    }),
    stage: 'control-request',
    expect: { valid: true },
  },
  {
    name: 'control-kill-force',
    kind: 'text',
    direction: 'client-to-broker',
    frame: controlFrame(7, {
      kind: 'kill',
      id: 'req_08',
      params: { sessionId: 'ses_fake_1', mode: 'force' },
    }),
    stage: 'control-request',
    expect: { valid: true },
  },
  {
    name: 'control-status-all',
    kind: 'text',
    direction: 'client-to-broker',
    frame: controlFrame(8, { kind: 'status', id: 'req_09' }),
    stage: 'control-request',
    expect: { valid: true },
  },
  {
    name: 'control-status-one',
    kind: 'text',
    direction: 'client-to-broker',
    frame: controlFrame(9, {
      kind: 'status',
      id: 'req_10',
      params: { sessionId: 'ses_fake_1' },
    }),
    stage: 'control-request',
    expect: { valid: true },
  },

  // ---- client → broker: invalid frames ---------------------------------------
  {
    name: 'text-frame-not-json',
    kind: 'text',
    direction: 'client-to-broker',
    frame: 'synthesized non-json text frame',
    stage: 'json-parse',
    expect: { valid: false, code: 'bad-envelope' },
  },
  {
    name: 'envelope-stream-channel-mismatch',
    kind: 'text',
    direction: 'client-to-broker',
    frame: JSON.stringify({
      stream: 'events',
      channel: 'control',
      seq: 0,
      payload: { kind: 'status', id: 'req_11' },
    }),
    stage: 'envelope',
    expect: { valid: false, code: 'bad-envelope' },
  },
  {
    name: 'envelope-unknown-channel',
    kind: 'text',
    direction: 'client-to-broker',
    frame: JSON.stringify({
      stream: 'telemetry',
      channel: 'telemetry',
      seq: 0,
      payload: {},
    }),
    stage: 'envelope',
    expect: { valid: false, code: 'unknown-channel' },
  },
  {
    name: 'envelope-negative-seq',
    kind: 'text',
    direction: 'client-to-broker',
    frame: JSON.stringify({
      stream: 'control',
      channel: 'control',
      seq: -1,
      payload: { kind: 'status', id: 'req_12' },
    }),
    stage: 'envelope',
    expect: { valid: false, code: 'bad-envelope' },
  },
  {
    name: 'envelope-missing-payload',
    kind: 'text',
    direction: 'client-to-broker',
    frame: JSON.stringify({ stream: 'control', channel: 'control', seq: 0 }),
    stage: 'envelope',
    expect: { valid: false, code: 'bad-envelope' },
  },
  {
    name: 'control-approve-reserved',
    kind: 'text',
    direction: 'client-to-broker',
    frame: controlFrame(10, { kind: 'approve', id: 'req_13', params: {} }),
    stage: 'control-request',
    expect: { valid: false, code: 'verb-reserved' },
    notes: 'approve is registered but its shape is deliberately unfrozen until M2',
  },
  {
    name: 'control-unknown-verb',
    kind: 'text',
    direction: 'client-to-broker',
    frame: controlFrame(11, { kind: 'hibernate', id: 'req_14', params: {} }),
    stage: 'control-request',
    expect: { valid: false, code: 'unknown-verb' },
  },
  {
    name: 'control-bad-request-id',
    kind: 'text',
    direction: 'client-to-broker',
    frame: controlFrame(12, {
      kind: 'status',
      id: 'bad id!',
    }),
    stage: 'control-request',
    expect: { valid: false, code: 'bad-request' },
  },
  {
    name: 'control-launch-label-backend-mismatch',
    kind: 'text',
    direction: 'client-to-broker',
    frame: controlFrame(13, {
      kind: 'launch',
      id: 'req_15',
      params: {
        accountLabel: 'MAX_A',
        backend: 'opencode',
        substrate: 'sdk',
        cwd: '/synthetic/workspace',
        purpose: 'golden pairing violation',
      },
    }),
    stage: 'control-request',
    expect: { valid: false, code: 'bad-request' },
  },
  {
    name: 'control-launch-pty-non-claude',
    kind: 'text',
    direction: 'client-to-broker',
    frame: controlFrame(14, {
      kind: 'launch',
      id: 'req_16',
      params: {
        accountLabel: 'AWS_DEV',
        backend: 'opencode',
        substrate: 'pty',
        cwd: '/synthetic/workspace',
        purpose: 'golden substrate violation',
      },
    }),
    stage: 'control-request',
    expect: { valid: false, code: 'bad-request' },
  },
  {
    name: 'control-launch-relative-cwd',
    kind: 'text',
    direction: 'client-to-broker',
    frame: controlFrame(15, {
      kind: 'launch',
      id: 'req_17',
      params: {
        accountLabel: 'MAX_A',
        backend: 'claude_code',
        substrate: 'sdk',
        cwd: 'synthetic/relative',
        purpose: 'golden cwd violation',
      },
    }),
    stage: 'control-request',
    expect: { valid: false, code: 'bad-request' },
  },
  {
    name: 'control-resume-malformed-session',
    kind: 'text',
    direction: 'client-to-broker',
    frame: controlFrame(16, {
      kind: 'resume',
      id: 'req_18',
      params: { sessionId: 'ses fake 1' },
    }),
    stage: 'control-request',
    expect: { valid: false, code: 'bad-request' },
  },
  {
    name: 'control-resume-blank-prompt',
    kind: 'text',
    direction: 'client-to-broker',
    frame: controlFrame(19, {
      kind: 'resume',
      id: 'req_21',
      params: { sessionId: 'ses_fake_1', prompt: '' },
    }),
    stage: 'control-request',
    expect: { valid: false, code: 'bad-request' },
    notes: 'ICR-0004: a prompt, when present, must be a non-empty string',
  },
  {
    name: 'control-kill-bad-mode',
    kind: 'text',
    direction: 'client-to-broker',
    frame: controlFrame(17, {
      kind: 'kill',
      id: 'req_19',
      params: { sessionId: 'ses_fake_1', mode: 'terminate' },
    }),
    stage: 'control-request',
    expect: { valid: false, code: 'bad-request' },
  },
  {
    name: 'events-channel-client-payload',
    kind: 'text',
    direction: 'client-to-broker',
    frame: JSON.stringify({
      stream: 'events',
      channel: 'events',
      seq: 0,
      payload: { kind: 'noise' },
    }),
    stage: 'channel-policy',
    expect: { valid: false, code: 'bad-request' },
    notes: 'events/quota/context-graph/transcript are broker→client only at M1',
  },

  // ---- client → broker: pty flow-control JSON ---------------------------------
  {
    name: 'pty-ack-valid',
    kind: 'text',
    direction: 'client-to-broker',
    frame: ptyJsonFrame('ses_fake_1', 0, {
      kind: 'pty-ack',
      sessionId: 'ses_fake_1',
      watermark: 4096,
    }),
    stage: 'pty-client-message',
    expect: { valid: true },
  },
  {
    name: 'pty-replay-request-valid',
    kind: 'text',
    direction: 'client-to-broker',
    frame: ptyJsonFrame('ses_fake_1', 1, {
      kind: 'pty-replay-request',
      sessionId: 'ses_fake_1',
      fromWatermark: 2048,
    }),
    stage: 'pty-client-message',
    expect: { valid: true },
  },
  {
    name: 'pty-resize-valid',
    kind: 'text',
    direction: 'client-to-broker',
    frame: ptyJsonFrame('ses_fake_1', 2, {
      kind: 'pty-resize',
      sessionId: 'ses_fake_1',
      cols: 80,
      rows: 24,
    }),
    stage: 'pty-client-message',
    expect: { valid: true },
  },
  {
    name: 'pty-session-channel-mismatch',
    kind: 'text',
    direction: 'client-to-broker',
    frame: ptyJsonFrame('ses_fake_1', 3, {
      kind: 'pty-ack',
      sessionId: 'ses_fake_2',
      watermark: 4096,
    }),
    stage: 'pty-client-message',
    expect: { valid: false, code: 'bad-request' },
  },
  {
    name: 'pty-resize-cols-overflow',
    kind: 'text',
    direction: 'client-to-broker',
    frame: ptyJsonFrame('ses_fake_1', 4, {
      kind: 'pty-resize',
      sessionId: 'ses_fake_1',
      cols: 5000,
      rows: 24,
    }),
    stage: 'pty-client-message',
    expect: { valid: false, code: 'bad-request' },
  },
  {
    name: 'pty-unknown-kind',
    kind: 'text',
    direction: 'client-to-broker',
    frame: ptyJsonFrame('ses_fake_1', 5, {
      kind: 'pty-pause',
      sessionId: 'ses_fake_1',
    }),
    stage: 'pty-client-message',
    expect: { valid: false, code: 'bad-request' },
    notes: 'pause/resume NEVER crosses the wire — backpressure is broker-internal',
  },

  // ---- broker → client: valid responses / pushes -------------------------------
  {
    name: 'result-launch-ok',
    kind: 'text',
    direction: 'broker-to-client',
    frame: controlFrame(0, {
      kind: 'result',
      id: 'req_01',
      ok: true,
      result: { verb: 'launch', sessionId: 'ses_fake_1', state: 'spawning' },
    }),
    stage: 'control-response',
    expect: { valid: true },
    notes: 'launch answers spawning: the ledger row exists, the spawn is async',
  },
  {
    name: 'result-resume-fork-ok',
    kind: 'text',
    direction: 'broker-to-client',
    frame: controlFrame(1, {
      kind: 'result',
      id: 'req_06',
      ok: true,
      result: {
        verb: 'resume',
        sessionId: 'ses_fake_2',
        state: 'resumed',
        forkedFrom: 'ses_fake_1',
      },
    }),
    stage: 'control-response',
    expect: { valid: true },
  },
  {
    name: 'result-kill-ok',
    kind: 'text',
    direction: 'broker-to-client',
    frame: controlFrame(2, {
      kind: 'result',
      id: 'req_07',
      ok: true,
      result: { verb: 'kill', sessionId: 'ses_fake_1', state: 'exited' },
    }),
    stage: 'control-response',
    expect: { valid: true },
  },
  {
    name: 'result-status-ok',
    kind: 'text',
    direction: 'broker-to-client',
    frame: controlFrame(3, {
      kind: 'result',
      id: 'req_09',
      ok: true,
      result: { verb: 'status', sessions: [FULL_STATUS, MINIMAL_STATUS] },
    }),
    stage: 'control-response',
    expect: { valid: true },
  },
  {
    name: 'result-error-double-resume',
    kind: 'text',
    direction: 'broker-to-client',
    frame: controlFrame(4, {
      kind: 'result',
      id: 'req_05',
      ok: false,
      error: {
        code: 'double-resume-blocked',
        message: 'session is in a running-family state; resume with fork:true instead',
        retryable: false,
      },
    }),
    stage: 'control-response',
    expect: { valid: true },
  },
  {
    name: 'result-error-session-not-resumable',
    kind: 'text',
    direction: 'broker-to-client',
    frame: controlFrame(5, {
      kind: 'result',
      id: 'req_05',
      ok: false,
      error: {
        code: 'session-not-resumable',
        message: 'session state orphan_killed cannot be resumed in place',
        retryable: false,
      },
    }),
    stage: 'control-response',
    expect: { valid: true },
  },
  {
    name: 'result-error-internal',
    kind: 'text',
    direction: 'broker-to-client',
    frame: controlFrame(6, {
      kind: 'result',
      id: 'req_01',
      ok: false,
      error: {
        code: 'internal',
        message: 'internal broker error while handling launch',
        retryable: false,
      },
    }),
    stage: 'control-response',
    expect: { valid: true },
    notes: 'non-KernelVerbError failures answer a GENERIC message — never echoed [X2]',
  },
  {
    name: 'pushed-error-bad-auth',
    kind: 'text',
    direction: 'broker-to-client',
    frame: controlFrame(0, {
      kind: 'error',
      code: 'bad-auth',
      message: 'missing or invalid gateway token',
      retryable: false,
      channel: 'control',
    }),
    stage: 'error-payload',
    expect: { valid: true },
    notes: 'frozen requirement: unauthenticated connections answer bad-auth and close',
  },
  {
    name: 'pushed-error-session-not-found',
    kind: 'text',
    direction: 'broker-to-client',
    frame: controlFrame(1, {
      kind: 'error',
      code: 'session-not-found',
      message: 'no such pty session (pty channels land at M2)',
      retryable: false,
      channel: 'pty.ses_fake_9',
    }),
    stage: 'error-payload',
    expect: { valid: true },
  },
  {
    name: 'pushed-error-watermark-out-of-range',
    kind: 'text',
    direction: 'broker-to-client',
    frame: controlFrame(2, {
      kind: 'error',
      code: 'watermark-out-of-range',
      message: 'ack watermark is beyond the delivered offset',
      retryable: false,
      channel: 'pty.ses_fake_1',
    }),
    stage: 'error-payload',
    expect: { valid: true },
  },
  {
    name: 'pushed-error-oversized-frame',
    kind: 'text',
    direction: 'broker-to-client',
    frame: controlFrame(3, {
      kind: 'error',
      code: 'oversized-frame',
      message: 'frame length does not match its header-declared length',
      retryable: false,
      channel: 'pty.ses_fake_1',
    }),
    stage: 'error-payload',
    expect: { valid: true },
  },

  // ---- broker → client: invalid (client-side validation) ------------------------
  {
    name: 'result-unknown-state',
    kind: 'text',
    direction: 'broker-to-client',
    frame: controlFrame(7, {
      kind: 'result',
      id: 'req_01',
      ok: true,
      result: { verb: 'launch', sessionId: 'ses_fake_1', state: 'zombie' },
    }),
    stage: 'control-response',
    expect: { valid: false, code: 'bad-request' },
  },
  {
    name: 'result-unregistered-error-code',
    kind: 'text',
    direction: 'broker-to-client',
    frame: controlFrame(8, {
      kind: 'result',
      id: 'req_01',
      ok: false,
      error: { code: 'quota-exceeded', message: 'synthesized unregistered code', retryable: false },
    }),
    stage: 'control-response',
    expect: { valid: false, code: 'bad-request' },
    notes: 'the ErrorCode registry is CLOSED — adding a code is an ICR',
  },
  {
    name: 'pushed-error-malformed-channel',
    kind: 'text',
    direction: 'broker-to-client',
    frame: controlFrame(9, {
      kind: 'error',
      code: 'bad-request',
      message: 'synthesized malformed channel reference',
      retryable: false,
      channel: 'pty.',
    }),
    stage: 'error-payload',
    expect: { valid: false, code: 'bad-request' },
  },

  // ==== M2 freeze: transcript.<sid> (broker → client) ===========================
  {
    name: 'transcript-delta-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: transcriptFrame('ses_fake_1', 0, {
      kind: 'transcript-delta',
      sessionId: 'ses_fake_1',
      messageUuid: 'synthmsg-0',
      text: 'synthesized streamed text',
    }),
    stage: 'transcript-payload',
    expect: { valid: true },
  },
  {
    name: 'transcript-tool-start-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: transcriptFrame('ses_fake_1', 1, {
      kind: 'transcript-tool',
      sessionId: 'ses_fake_1',
      toolUseId: 'synthtool-0',
      toolName: 'Read',
      phase: 'start',
    }),
    stage: 'transcript-payload',
    expect: { valid: true },
  },
  {
    name: 'transcript-tool-result-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: transcriptFrame('ses_fake_1', 2, {
      kind: 'transcript-tool',
      sessionId: 'ses_fake_1',
      toolUseId: 'synthtool-0',
      toolName: 'Read',
      phase: 'result',
      ok: true,
    }),
    stage: 'transcript-payload',
    expect: { valid: true },
  },
  {
    name: 'transcript-result-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: transcriptFrame('ses_fake_1', 3, {
      kind: 'transcript-result',
      sessionId: 'ses_fake_1',
      ok: true,
      detail: 'success',
      usage: { inputTokens: 120, outputTokens: 340, cacheReadTokens: 64, cacheCreationTokens: 8 },
      costUsd: 0.0421,
      durationMs: 5400,
    }),
    stage: 'transcript-payload',
    expect: { valid: true },
    notes: 'four ground-truth token classes (blueprint §6.2); costUsd is an ESTIMATE',
  },
  {
    name: 'transcript-unknown-kind',
    kind: 'text',
    direction: 'broker-to-client',
    frame: transcriptFrame('ses_fake_1', 4, {
      kind: 'transcript-thought',
      sessionId: 'ses_fake_1',
    }),
    stage: 'transcript-payload',
    expect: { valid: false, code: 'bad-request' },
  },
  {
    name: 'transcript-session-channel-mismatch',
    kind: 'text',
    direction: 'broker-to-client',
    frame: transcriptFrame('ses_fake_1', 5, {
      kind: 'transcript-delta',
      sessionId: 'ses_fake_2',
      messageUuid: 'synthmsg-1',
      text: 'synthesized mismatched delta',
    }),
    stage: 'transcript-payload',
    expect: { valid: false, code: 'bad-request' },
  },
  {
    name: 'transcript-tool-ok-on-start',
    kind: 'text',
    direction: 'broker-to-client',
    frame: transcriptFrame('ses_fake_1', 6, {
      kind: 'transcript-tool',
      sessionId: 'ses_fake_1',
      toolUseId: 'synthtool-1',
      toolName: 'Bash',
      phase: 'start',
      ok: true,
    }),
    stage: 'transcript-payload',
    expect: { valid: false, code: 'bad-request' },
    notes: 'phase/ok matrix: a start has no outcome; ok is REQUIRED on result only',
  },
  {
    name: 'transcript-result-negative-tokens',
    kind: 'text',
    direction: 'broker-to-client',
    frame: transcriptFrame('ses_fake_1', 7, {
      kind: 'transcript-result',
      sessionId: 'ses_fake_1',
      ok: false,
      detail: 'error_during_execution',
      usage: { inputTokens: -1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }),
    stage: 'transcript-payload',
    expect: { valid: false, code: 'bad-request' },
  },

  // ==== M2 freeze: approvals (broker → client) ===================================
  {
    name: 'approval-request-can-use-tool',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('approvals', 0, {
      kind: 'approval-request',
      approvalId: 'apr_fake_1',
      source: 'can-use-tool',
      summary: 'synthesized tool escalation',
      accountLabel: 'MAX_A',
      sessionId: 'ses_fake_1',
      toolName: 'Bash',
      toolUseId: 'synthtool-2',
      expiresAt: 90061000,
    }),
    stage: 'approvals-server-message',
    expect: { valid: true },
  },
  {
    name: 'approval-request-hook-floor',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('approvals', 1, {
      kind: 'approval-request',
      approvalId: 'apr_fake_2',
      source: 'hook-floor',
      summary: 'synthesized policy-floor escalation',
      accountLabel: 'ENT',
      sessionId: 'ses_fake_2',
      toolName: 'Write',
    }),
    stage: 'approvals-server-message',
    expect: { valid: true },
    notes: 'hook-floor covers ALL sessions incl. external ones (hooks-contract.md)',
  },
  {
    name: 'approval-request-workflow-gate',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('approvals', 2, {
      kind: 'approval-request',
      approvalId: 'apr_fake_3',
      source: 'workflow-gate',
      summary: 'synthesized pipeline gate',
      accountLabel: 'AWS_DEV',
      runId: 'run_fake_1',
      stepId: 'step_fake_2',
    }),
    stage: 'approvals-server-message',
    expect: { valid: true },
    notes: 'designed at M2 for the M5 pipeline slice — no wire change needed later',
  },
  {
    name: 'approval-resolved-expired',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('approvals', 3, {
      kind: 'approval-resolved',
      approvalId: 'apr_fake_1',
      outcome: 'expired',
    }),
    stage: 'approvals-server-message',
    expect: { valid: true },
  },
  {
    name: 'approval-request-unknown-source',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('approvals', 4, {
      kind: 'approval-request',
      approvalId: 'apr_fake_4',
      source: 'vibes',
      summary: 'synthesized unknown source',
      accountLabel: 'MAX_A',
      sessionId: 'ses_fake_1',
      toolName: 'Bash',
    }),
    stage: 'approvals-server-message',
    expect: { valid: false, code: 'bad-request' },
  },
  {
    name: 'approval-request-matrix-violation',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('approvals', 5, {
      kind: 'approval-request',
      approvalId: 'apr_fake_5',
      source: 'workflow-gate',
      summary: 'synthesized matrix violation',
      accountLabel: 'AWS_DEV',
      runId: 'run_fake_1',
      stepId: 'step_fake_2',
      toolName: 'Bash',
    }),
    stage: 'approvals-server-message',
    expect: { valid: false, code: 'bad-request' },
    notes: 'per-source field matrix: workflow-gate must not carry tool refs',
  },

  // ==== M2 freeze: approvals (client → broker) ===================================
  {
    name: 'approval-decision-allow',
    kind: 'text',
    direction: 'client-to-broker',
    frame: staticFrame('approvals', 0, {
      kind: 'approval-decision',
      approvalId: 'apr_fake_1',
      verdict: 'allow',
      updatedInput: { command: 'ls -la' },
    }),
    stage: 'approvals-client-message',
    expect: { valid: true },
    notes: 'updatedInput relays the canUseTool replacement input (allow only)',
  },
  {
    name: 'approval-decision-deny-note',
    kind: 'text',
    direction: 'client-to-broker',
    frame: staticFrame('approvals', 1, {
      kind: 'approval-decision',
      approvalId: 'apr_fake_2',
      verdict: 'deny',
      note: 'synthesized denial rationale',
    }),
    stage: 'approvals-client-message',
    expect: { valid: true },
  },
  {
    name: 'approval-decision-unknown-verdict',
    kind: 'text',
    direction: 'client-to-broker',
    frame: staticFrame('approvals', 2, {
      kind: 'approval-decision',
      approvalId: 'apr_fake_1',
      verdict: 'maybe',
    }),
    stage: 'approvals-client-message',
    expect: { valid: false, code: 'bad-request' },
  },
  {
    name: 'approval-decision-updated-input-on-deny',
    kind: 'text',
    direction: 'client-to-broker',
    frame: staticFrame('approvals', 3, {
      kind: 'approval-decision',
      approvalId: 'apr_fake_1',
      verdict: 'deny',
      updatedInput: { command: 'rm -rf /synthetic' },
    }),
    stage: 'approvals-client-message',
    expect: { valid: false, code: 'bad-request' },
  },
  {
    name: 'approval-request-from-client-rejected',
    kind: 'text',
    direction: 'client-to-broker',
    frame: staticFrame('approvals', 4, {
      kind: 'approval-request',
      approvalId: 'apr_fake_9',
      source: 'can-use-tool',
      summary: 'synthesized spoofed request',
      accountLabel: 'MAX_A',
      sessionId: 'ses_fake_1',
      toolName: 'Bash',
    }),
    stage: 'approvals-client-message',
    expect: { valid: false, code: 'bad-request' },
    notes: 'clients send decisions only — a client-minted approval-request is rejected',
  },

  // ==== M2 freeze: quota (broker → client) =======================================
  {
    name: 'quota-snapshot-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('quota', 0, {
      kind: 'quota-snapshot',
      account: 'MAX_A',
      window: '5h',
      usedPct: 41.5,
      resetsAt: 90200000,
      capturedAt: 90100000,
      source: 'statusline',
    }),
    stage: 'quota-payload',
    expect: { valid: true },
  },
  {
    name: 'quota-snapshot-7d-sonnet-oauth',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('quota', 1, {
      kind: 'quota-snapshot',
      account: 'MAX_B',
      window: '7d_sonnet',
      usedPct: 100,
      resetsAt: 89900000,
      capturedAt: 90100000,
      source: 'oauth-poll',
    }),
    stage: 'quota-payload',
    expect: { valid: true },
    notes: '100% with resetsAt in the past is LEGAL — reset-due rendering is FE-5 concern',
  },
  {
    name: 'quota-snapshot-unknown-window',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('quota', 2, {
      kind: 'quota-snapshot',
      account: 'MAX_A',
      window: '24h',
      usedPct: 10,
      resetsAt: 90200000,
      capturedAt: 90100000,
      source: 'statusline',
    }),
    stage: 'quota-payload',
    expect: { valid: false, code: 'bad-request' },
  },
  {
    name: 'quota-snapshot-pct-overflow',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('quota', 3, {
      kind: 'quota-snapshot',
      account: 'MAX_A',
      window: '5h',
      usedPct: 108.2,
      resetsAt: 90200000,
      capturedAt: 90100000,
      source: 'statusline',
    }),
    stage: 'quota-payload',
    expect: { valid: false, code: 'bad-request' },
    notes: 'usedPct is 0..100 inclusive — the collector clamps upstream noise',
  },

  // ==== M2 freeze: context-graph (broker → client) ===============================
  {
    name: 'context-touch-read-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('context-graph', 0, {
      kind: 'context-touch',
      sessionId: 'ses_fake_1',
      path: '/synthetic/workspace/src/main.ts',
      relation: 'read',
      ts: 90100000,
    }),
    stage: 'context-graph-payload',
    expect: { valid: true },
  },
  {
    name: 'context-touch-instructions-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('context-graph', 1, {
      kind: 'context-touch',
      sessionId: 'ses_fake_1',
      path: '/synthetic/workspace/CLAUDE.md',
      relation: 'instructions',
      ts: 90100500,
    }),
    stage: 'context-graph-payload',
    expect: { valid: true },
    notes: 'InstructionsLoaded hook → instructions relation (hooks-contract.md)',
  },
  {
    name: 'context-touch-relative-path',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('context-graph', 2, {
      kind: 'context-touch',
      sessionId: 'ses_fake_1',
      path: 'relative/file.ts',
      relation: 'read',
      ts: 90100000,
    }),
    stage: 'context-graph-payload',
    expect: { valid: false, code: 'bad-request' },
  },
  {
    name: 'context-touch-account-key-rejected',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('context-graph', 3, {
      kind: 'context-touch',
      sessionId: 'ses_fake_1',
      path: '/synthetic/workspace/src/main.ts',
      relation: 'read',
      ts: 90100000,
      account: 'MAX_A',
    }),
    stage: 'context-graph-payload',
    expect: { valid: false, code: 'bad-request' },
    notes: '[X2] design pin: the graph feed is identity-free — account keys REJECTED, not sanitized',
  },

  // ==== M2 freeze: JSON reconnect-replay (client → broker) =======================
  {
    name: 'replay-request-transcript-valid',
    kind: 'text',
    direction: 'client-to-broker',
    frame: transcriptFrame('ses_fake_1', 0, {
      kind: 'replay-request',
      channel: 'transcript.ses_fake_1',
      fromSeq: 42,
    }),
    stage: 'replay-request',
    expect: { valid: true },
  },
  {
    name: 'replay-request-events-valid',
    kind: 'text',
    direction: 'client-to-broker',
    frame: staticFrame('events', 0, {
      kind: 'replay-request',
      channel: 'events',
      fromSeq: 0,
    }),
    stage: 'replay-request',
    expect: { valid: true },
    notes: 'fromSeq 0 = full retained history; below-floor answers watermark-out-of-range at runtime',
  },
  {
    name: 'replay-request-channel-mismatch',
    kind: 'text',
    direction: 'client-to-broker',
    frame: staticFrame('quota', 0, {
      kind: 'replay-request',
      channel: 'events',
      fromSeq: 0,
    }),
    stage: 'replay-request',
    expect: { valid: false, code: 'bad-request' },
    notes: 'embedded channel must equal the envelope channel (same rule as pty sessionIds)',
  },
  {
    name: 'replay-request-negative-seq',
    kind: 'text',
    direction: 'client-to-broker',
    frame: staticFrame('events', 1, {
      kind: 'replay-request',
      channel: 'events',
      fromSeq: -1,
    }),
    stage: 'replay-request',
    expect: { valid: false, code: 'bad-request' },
  },
  {
    name: 'replay-request-on-control-unknown-verb',
    kind: 'text',
    direction: 'client-to-broker',
    frame: controlFrame(20, {
      kind: 'replay-request',
      channel: 'control',
      fromSeq: 0,
    }),
    stage: 'control-request',
    expect: { valid: false, code: 'unknown-verb' },
    notes: 'control is NOT replayable — a replay-request there is just an unknown verb',
  },

  // ==== M2 freeze: events channel policy (payload union DRAFT until M3) ==========
  {
    name: 'events-broker-payload-draft-opaque',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('events', 0, { kind: 'synthesized-draft-event' }),
    stage: 'channel-policy',
    expect: { valid: true },
    notes:
      'events payload union is DRAFT until M3 — clients accept broker pushes as opaque envelopes',
  },

  // ==== M2 freeze: pushed errors for the new code ================================
  {
    name: 'pushed-error-approval-not-pending',
    kind: 'text',
    direction: 'broker-to-client',
    frame: controlFrame(4, {
      kind: 'error',
      code: 'approval-not-pending',
      message: 'approval is not pending (already resolved or expired)',
      retryable: false,
      channel: 'approvals',
    }),
    stage: 'error-payload',
    expect: { valid: true },
    notes: 'the expiry-vs-click race is NORMAL — never conflated with malformed traffic',
  },

  // ---- binary PTY frames ---------------------------------------------------------
  {
    name: 'pty-frame-output-valid',
    kind: 'binary',
    direction: 'broker-to-client',
    frameHex:
      'ab01010a000000000000000000000009' + '7365735f66616b655f31' + '73796e74682d6f7574',
    stage: 'pty-frame-codec',
    expect: { valid: true },
    decoded: {
      type: 'output',
      sessionId: 'ses_fake_1',
      streamOffset: 0,
      payloadUtf8: 'synth-out',
    },
  },
  {
    name: 'pty-frame-input-valid',
    kind: 'binary',
    direction: 'client-to-broker',
    frameHex: 'ab010203' + '0000000000001000' + '00000003' + '733031' + '6c730a',
    stage: 'pty-frame-codec',
    expect: { valid: true },
    decoded: { type: 'input', sessionId: 's01', streamOffset: 4096, payloadUtf8: 'ls\n' },
  },
  {
    name: 'pty-frame-bad-magic',
    kind: 'binary',
    direction: 'client-to-broker',
    frameHex: 'aa010203' + '0000000000001000' + '00000003' + '733031' + '6c730a',
    stage: 'pty-frame-codec',
    expect: { valid: false, code: 'oversized-frame' },
  },
  {
    name: 'pty-frame-bad-version',
    kind: 'binary',
    direction: 'client-to-broker',
    frameHex: 'ab020203' + '0000000000001000' + '00000003' + '733031' + '6c730a',
    stage: 'pty-frame-codec',
    expect: { valid: false, code: 'oversized-frame' },
  },
  {
    name: 'pty-frame-unknown-type',
    kind: 'binary',
    direction: 'client-to-broker',
    frameHex: 'ab010303' + '0000000000001000' + '00000003' + '733031' + '6c730a',
    stage: 'pty-frame-codec',
    expect: { valid: false, code: 'oversized-frame' },
  },
  {
    name: 'pty-frame-truncated',
    kind: 'binary',
    direction: 'client-to-broker',
    frameHex: 'ab0102',
    stage: 'pty-frame-codec',
    expect: { valid: false, code: 'oversized-frame' },
  },
  {
    name: 'pty-frame-payload-over-cap',
    kind: 'binary',
    direction: 'client-to-broker',
    frameHex: 'ab010203' + '0000000000000000' + '00200000' + '733031',
    stage: 'pty-frame-codec',
    expect: { valid: false, code: 'oversized-frame' },
    notes: 'header declares a 2 MiB payload — over the 1 MiB frozen cap',
  },
  {
    name: 'pty-frame-length-mismatch',
    kind: 'binary',
    direction: 'client-to-broker',
    frameHex: 'ab010203' + '0000000000001000' + '00000003' + '733031' + '6c730a' + '00',
    stage: 'pty-frame-codec',
    expect: { valid: false, code: 'oversized-frame' },
    notes: 'one trailing byte beyond the header-declared length',
  },
  {
    name: 'pty-frame-sid-length-zero',
    kind: 'binary',
    direction: 'client-to-broker',
    frameHex: 'ab010200' + '0000000000000000' + '00000001' + '41',
    stage: 'pty-frame-codec',
    expect: { valid: false, code: 'oversized-frame' },
  },
] satisfies readonly GoldenWsFixture[]);

// ---------------------------------------------------------------------------
// Reference replay
// ---------------------------------------------------------------------------

export interface GoldenWsReplayResult {
  readonly valid: boolean;
  readonly code?: ErrorCode;
  /** The stage that produced the verdict (mirrors gateway routing order). */
  readonly stage: GoldenWsStage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Route one fixture through the frozen protocol validators exactly the way
 * the gateway's routeTextFrame/routeBinaryFrame (and the FE client's inbound
 * path) do: json-parse → envelope → channel/direction-specific validator.
 * M2 routing order on non-control JSON channels:
 *   1. `pty.<sid>` → pty flow-control validator (M1, unchanged);
 *   2. client → broker `replay-request` on a replayable channel → replay
 *      validator;
 *   3. client → broker on `approvals` → decision validator; any other
 *      client payload on a broker→client channel → channel policy reject;
 *   4. broker → client → the channel's payload validator (`events` excepted:
 *      its union is DRAFT until M3 — opaque passthrough by policy).
 */
export function replayGoldenWsFixture(fixture: GoldenWsFixture): GoldenWsReplayResult {
  if (fixture.kind === 'binary') {
    const decoded = decodePtyFrame(goldenFrameBytes(fixture));
    return decoded.ok
      ? { valid: true, stage: 'pty-frame-codec' }
      : { valid: false, code: decoded.code, stage: 'pty-frame-codec' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fixture.frame);
  } catch {
    return { valid: false, code: 'bad-envelope', stage: 'json-parse' };
  }

  const envelope = validateEnvelope(parsed);
  if (!envelope.ok) return { valid: false, code: envelope.code, stage: 'envelope' };
  const { channel, payload } = envelope.value;

  if (channel === 'control') {
    if (fixture.direction === 'client-to-broker') {
      const request = validateControlRequest(payload);
      return request.ok
        ? { valid: true, stage: 'control-request' }
        : { valid: false, code: request.code, stage: 'control-request' };
    }
    if (isRecord(payload) && payload['kind'] === 'error') {
      const pushed = validateErrorPayload(payload);
      return pushed.ok
        ? { valid: true, stage: 'error-payload' }
        : { valid: false, code: pushed.code, stage: 'error-payload' };
    }
    const response = validateControlResponse(payload);
    return response.ok
      ? { valid: true, stage: 'control-response' }
      : { valid: false, code: response.code, stage: 'control-response' };
  }

  const sid = sessionIdOfChannel(channel);
  if (sid !== undefined && channel.startsWith('pty.')) {
    const message = validatePtyClientMessage(payload, sid);
    return message.ok
      ? { valid: true, stage: 'pty-client-message' }
      : { valid: false, code: message.code, stage: 'pty-client-message' };
  }

  if (fixture.direction === 'client-to-broker') {
    // M2: reconnect-replay rides the replayable channel itself.
    if (isRecord(payload) && payload['kind'] === 'replay-request' && isReplayableChannel(channel)) {
      const replay = validateJsonReplayRequest(payload, channel);
      return replay.ok
        ? { valid: true, stage: 'replay-request' }
        : { valid: false, code: replay.code, stage: 'replay-request' };
    }
    // M2: approvals is the one bidirectional fan-out channel (decisions).
    if (channel === 'approvals') {
      const decision = validateApprovalsClientMessage(payload);
      return decision.ok
        ? { valid: true, stage: 'approvals-client-message' }
        : { valid: false, code: decision.code, stage: 'approvals-client-message' };
    }
    // Everything else stays broker→client only.
    return { valid: false, code: 'bad-request', stage: 'channel-policy' };
  }

  // broker → client (FE-2 inbound path)
  if (channel === 'approvals') {
    const message = validateApprovalsServerMessage(payload);
    return message.ok
      ? { valid: true, stage: 'approvals-server-message' }
      : { valid: false, code: message.code, stage: 'approvals-server-message' };
  }
  if (channel === 'quota') {
    const snapshot = validateQuotaSnapshot(payload);
    return snapshot.ok
      ? { valid: true, stage: 'quota-payload' }
      : { valid: false, code: snapshot.code, stage: 'quota-payload' };
  }
  if (channel === 'context-graph') {
    const touch = validateContextGraphTouch(payload);
    return touch.ok
      ? { valid: true, stage: 'context-graph-payload' }
      : { valid: false, code: touch.code, stage: 'context-graph-payload' };
  }
  if (sid !== undefined && channel.startsWith('transcript.')) {
    const transcript = validateTranscriptPayload(payload, sid);
    return transcript.ok
      ? { valid: true, stage: 'transcript-payload' }
      : { valid: false, code: transcript.code, stage: 'transcript-payload' };
  }

  // events: payload union DRAFT until M3 — opaque passthrough by policy.
  return { valid: true, stage: 'channel-policy' };
}
