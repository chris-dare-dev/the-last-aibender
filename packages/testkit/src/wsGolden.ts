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
 * the suite). The M2 extension added fixtures for every surface promoted at
 * the M2 freeze: transcript/approvals/quota/context-graph payloads and the
 * JSON `replay-request`. The M3 extension closes the last open surface: the
 * `events` payload union (event-summary + every §6.3 read-model snapshot,
 * valid + every invalid class) and pins the frozen FORWARD-TOLERANT READER
 * rule (unknown events kinds are legal-and-ignored). Client payloads on
 * `events` other than `replay-request` still answer `bad-request`.
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
  validateEventsPayload,
  validateJsonReplayRequest,
  validatePtyClientMessage,
  validateQuotaSnapshot,
  validateTranscriptPayload,
  validateWorkstreamClientMessage,
  validateWorkstreamServerPayload,
  validatePipelineClientMessage,
  validatePipelineServerPayload,
  type ErrorCode,
} from '@aibender/protocol';

/** The protocol freeze this corpus pins (asserted equal to PROTOCOL_FREEZE). */
export const GOLDEN_WS_CORPUS_FREEZE: typeof PROTOCOL_FREEZE = 'FROZEN-M5';

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
   * Verdict comes from channel POLICY, not a payload validator: client
   * payloads on broker→client-only channels (other than `replay-request`)
   * are rejected here regardless of shape.
   */
  | 'channel-policy'
  | 'pty-frame-codec'
  // M2 freeze stages ---------------------------------------------------------
  | 'transcript-payload'
  | 'approvals-client-message'
  | 'approvals-server-message'
  | 'quota-payload'
  | 'context-graph-payload'
  | 'replay-request'
  // M3 freeze stage -----------------------------------------------------------
  | 'events-payload'
  // M4 freeze stages ----------------------------------------------------------
  | 'workstream-payload'
  | 'workstream-client-message'
  // M5 freeze stages ----------------------------------------------------------
  | 'pipelines-payload'
  | 'pipelines-client-message';

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
  channel: 'events' | 'quota' | 'approvals' | 'context-graph' | 'workstream' | 'pipelines',
  seq: number,
  payload: unknown,
): string {
  return JSON.stringify({ stream: channel, channel, seq, payload });
}

// Shared M4 workstream fixture records (synthesized, [X2]).
const GOLDEN_WS_NODE = {
  kind: 'workstream-node',
  sessionId: 'ses_fake_1',
  workstreamId: 'ws_golden',
  backend: 'claude_code',
  account: 'MAX_A',
  state: 'running',
  origin: 'harness',
  confidence: 'recorded',
  displayName: 'golden node',
  cwd: '/synthetic/workspace',
  tokensIn: 1200,
  tokensOut: 340,
  costEstimatedUsd: 0.02,
  createdAt: 90100000,
  lastActiveAt: 90200000,
} as const;

const GOLDEN_WS_EDGE = {
  kind: 'workstream-edge',
  edgeId: 'edg_fake_1',
  fromSessionId: 'ses_fake_1',
  toSessionId: 'ses_fake_2',
  edgeType: 'continue',
  confidence: 'recorded',
  ts: 90300000,
} as const;

const GOLDEN_WS_SUMMARY = {
  workstreamId: 'ws_golden',
  title: 'golden workstream',
  status: 'active',
  tags: ['golden'],
  nodeCount: 2,
  updatedAt: 90300000,
} as const;

const GOLDEN_WS_MERGE_REQUEST = {
  kind: 'workstream-merge-request',
  mergeId: 'mrg_01',
  params: {
    parents: ['ses_fake_1', 'ses_fake_2'],
    accountLabel: 'MAX_A',
    backend: 'claude_code',
    cwd: '/synthetic/workspace',
    purpose: 'golden merge',
    briefBody: 'merge brief: shared goal; conflicts surfaced explicitly.',
    workstreamId: 'ws_golden',
  },
} as const;

// Shared M5 pipeline fixture records (synthesized, [X2]).
const GOLDEN_CATALOG_ENTRY = {
  capId: 'cap_fake_1',
  kind: 'skill',
  name: 'write-report',
  scope: 'project',
  backendFamily: 'claude',
  workspace: '/synthetic/workspace',
  sourcePath: '/synthetic/workspace/.claude/skills/write-report/SKILL.md',
  contentHash: 'sha256:deadbeefcafe',
  slash: '/write-report',
} as const;

const GOLDEN_DAG_DOCUMENT = {
  schemaVersion: 1,
  id: 'wf_fake_1',
  name: 'golden pipeline',
  steps: [{ id: 'a', kind: 'prompt', prompt: 'do the thing' }],
} as const;

const GOLDEN_PIPELINE_STEP = {
  runId: 'run_fake_1',
  stepId: 'a',
  iteration: 0,
  attempt: 0,
  state: 'memoized',
  sessionId: 'ses_fake_1',
  account: 'MAX_A',
  costEstimatedUsd: 0.01,
} as const;

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

  // ==== M3 freeze: events payload union (event-summary + read models) ============
  {
    name: 'events-broker-payload-draft-opaque',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('events', 0, { kind: 'synthesized-draft-event' }),
    stage: 'events-payload',
    expect: { valid: true },
    notes:
      'M3: union frozen; this M2-era frame stays VALID under the frozen forward-tolerant ' +
      'reader rule — unknown kinds decode opaque and are ignored (stage moved from ' +
      'channel-policy at the M3 freeze, verdict unchanged)',
  },
  {
    name: 'events-summary-min-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('events', 1, {
      kind: 'event-summary',
      eventId: 1,
      ts: 90100000,
      account: 'MAX_A',
      backend: 'claude_code',
      source: 'claude-jsonl',
      eventType: 'assistant-turn',
    }),
    stage: 'events-payload',
    expect: { valid: true },
  },
  {
    name: 'events-summary-full-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('events', 2, {
      kind: 'event-summary',
      eventId: 42,
      ts: 90100500,
      account: 'AWS_DEV',
      backend: 'opencode',
      source: 'opencode-sse',
      eventType: 'message.part.updated',
      sessionId: 'ses_fake_1',
      model: 'synthetic-model',
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 30, cacheCreationTokens: 20 },
      costEstimatedUsd: 0.012,
      costActualUsd: 0.011,
      latencyMs: 900,
      ttftMs: 120,
      toolName: 'Read',
      skillName: 'synthetic-skill',
      ok: true,
      errorKind: 'retry',
    }),
    stage: 'events-payload',
    expect: { valid: true },
  },
  {
    name: 'events-summary-label-backend-mismatch',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('events', 3, {
      kind: 'event-summary',
      eventId: 2,
      ts: 90100000,
      account: 'MAX_A',
      backend: 'opencode',
      source: 'claude-jsonl',
      eventType: 'assistant-turn',
    }),
    stage: 'events-payload',
    expect: { valid: false, code: 'bad-request' },
    notes: 'the frozen label↔backend pairing applies on the events wire too',
  },
  {
    name: 'events-summary-negative-tokens',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('events', 4, {
      kind: 'event-summary',
      eventId: 3,
      ts: 90100000,
      account: 'MAX_A',
      backend: 'claude_code',
      source: 'claude-jsonl',
      eventType: 'assistant-turn',
      usage: { inputTokens: -1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }),
    stage: 'events-payload',
    expect: { valid: false, code: 'bad-request' },
  },
  {
    name: 'events-summary-unknown-source',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('events', 5, {
      kind: 'event-summary',
      eventId: 4,
      ts: 90100000,
      account: 'MAX_A',
      backend: 'claude_code',
      source: 'psychic-feed',
      eventType: 'assistant-turn',
    }),
    stage: 'events-payload',
    expect: { valid: false, code: 'bad-request' },
    notes: 'EVENT_SOURCES is a closed registry — growing it is an ICR',
  },
  {
    name: 'events-readmodel-quota-gauges-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('events', 6, {
      kind: 'read-model-snapshot',
      readModel: 'quota-gauges',
      capturedAt: 90100000,
      sources: [{ source: 'claude-quota', state: 'fresh', lastIngestAt: 90099000 }],
      data: {
        gauges: [
          { account: 'MAX_A', window: '5h', usedPct: 41.5, resetsAt: 90200000 },
          { account: 'MAX_B', window: '7d', usedPct: 100, resetsAt: 90000000 },
        ],
      },
    }),
    stage: 'events-payload',
    expect: { valid: true },
    notes: 'resetsAt in the past is legal (FE renders "reset due")',
  },
  {
    name: 'events-readmodel-burn-rate-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('events', 7, {
      kind: 'read-model-snapshot',
      readModel: 'burn-rate',
      capturedAt: 90100000,
      sources: [{ source: 'claude-jsonl', state: 'fresh', lastIngestAt: 90099000 }],
      data: {
        entries: [
          {
            account: 'MAX_A',
            blockStartAt: 90000000,
            blockEndAt: 108000000,
            tokensPerHour: 120000,
            usedPct: 30,
            projectedExhaustionAt: 104000000,
          },
        ],
      },
    }),
    stage: 'events-payload',
    expect: { valid: true },
  },
  {
    name: 'events-readmodel-bedrock-cost-estimate-only',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('events', 8, {
      kind: 'read-model-snapshot',
      readModel: 'bedrock-cost',
      capturedAt: 90100000,
      sources: [
        { source: 'bedrock-cost-explorer', state: 'estimate-only' },
        { source: 'bedrock-cloudwatch', state: 'sso-expired', lastIngestAt: 90000000 },
      ],
      data: { estimateMtdUsd: 12.5 },
    }),
    stage: 'events-payload',
    expect: { valid: true },
    notes:
      'actuals absent while gated — estimate-only/sso-expired are freshness STATES, never errors',
  },
  {
    name: 'events-readmodel-api-equivalent-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('events', 9, {
      kind: 'read-model-snapshot',
      readModel: 'api-equivalent-usd',
      capturedAt: 90100000,
      sources: [{ source: 'claude-jsonl', state: 'fresh', lastIngestAt: 90099000 }],
      data: {
        basis: 'api-equivalent',
        entries: [{ account: 'ENT', backend: 'claude_code', equivalentUsd: 42 }],
        windowDays: 7,
      },
    }),
    stage: 'events-payload',
    expect: { valid: true },
    notes: 'the basis literal freezes honest labeling: equivalence, never spend',
  },
  {
    name: 'events-readmodel-cache-hit-rate-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('events', 10, {
      kind: 'read-model-snapshot',
      readModel: 'cache-hit-rate',
      capturedAt: 90100000,
      sources: [{ source: 'claude-jsonl', state: 'fresh', lastIngestAt: 90099000 }],
      data: {
        entries: [
          {
            account: 'MAX_A',
            hitRatePct: 87.5,
            readTokens: 70000,
            creation5mTokens: 4000,
            creation1hTokens: 6000,
          },
        ],
      },
    }),
    stage: 'events-payload',
    expect: { valid: true },
    notes: 'the 5m/1h TTL split rides the read model (blueprint §6.2 ground truth)',
  },
  {
    name: 'events-readmodel-latency-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('events', 11, {
      kind: 'read-model-snapshot',
      readModel: 'latency',
      capturedAt: 90100000,
      sources: [{ source: 'lmstudio', state: 'fresh', lastIngestAt: 90099000 }],
      data: {
        entries: [
          {
            backend: 'lmstudio',
            p50Ms: 300,
            p95Ms: 900,
            ttftP50Ms: 80,
            ttftP95Ms: 200,
            sampleCount: 40,
          },
        ],
      },
    }),
    stage: 'events-payload',
    expect: { valid: true },
  },
  {
    name: 'events-readmodel-health-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('events', 12, {
      kind: 'read-model-snapshot',
      readModel: 'health',
      capturedAt: 90100000,
      sources: [{ source: 'opencode-sse', state: 'stale', lastIngestAt: 90000000 }],
      data: {
        entries: [
          {
            source: 'opencode-sse',
            errorCount: 1,
            retryCount: 2,
            throttleCount: 0,
            timeoutCount: 0,
            windowMinutes: 60,
          },
        ],
      },
    }),
    stage: 'events-payload',
    expect: { valid: true },
  },
  {
    name: 'events-readmodel-skill-leaderboard-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('events', 13, {
      kind: 'read-model-snapshot',
      readModel: 'skill-leaderboard',
      capturedAt: 90100000,
      sources: [{ source: 'claude-otel', state: 'fresh', lastIngestAt: 90099000 }],
      data: {
        entries: [
          {
            skillName: 'synthetic-skill',
            invocations: 12,
            successRatePct: 75,
            tokensPerOutcome: 5400.5,
            worstQuartile: false,
          },
        ],
      },
    }),
    stage: 'events-payload',
    expect: { valid: true },
    notes: 'correctionRatePct absent — the local-model classification job has not run',
  },
  {
    name: 'events-readmodel-session-outcomes-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('events', 14, {
      kind: 'read-model-snapshot',
      readModel: 'session-outcomes',
      capturedAt: 90100000,
      sources: [{ source: 'claude-jsonl', state: 'fresh', lastIngestAt: 90099000 }],
      data: { entries: [{ outcome: 'completed', count: 9 }], windowDays: 7 },
    }),
    stage: 'events-payload',
    expect: { valid: true },
  },
  {
    name: 'events-readmodel-local-offload-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('events', 15, {
      kind: 'read-model-snapshot',
      readModel: 'local-offload',
      capturedAt: 90100000,
      sources: [{ source: 'lmstudio', state: 'lmstudio-down' }],
      data: { offloadRatioPct: 22.2, localTokens: 200, totalTokens: 900, windowDays: 7 },
    }),
    stage: 'events-payload',
    expect: { valid: true },
    notes: 'lmstudio-down is a first-class freshness state (blueprint §4.3) — never an error',
  },
  {
    name: 'events-readmodel-unknown-id',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('events', 16, {
      kind: 'read-model-snapshot',
      readModel: 'vibes',
      capturedAt: 90100000,
      sources: [{ source: 'claude-jsonl', state: 'fresh' }],
      data: {},
    }),
    stage: 'events-payload',
    expect: { valid: false, code: 'bad-request' },
    notes: 'READ_MODEL_IDS is a closed registry — tolerance applies to KINDS, not read models',
  },
  {
    name: 'events-readmodel-empty-sources',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('events', 17, {
      kind: 'read-model-snapshot',
      readModel: 'quota-gauges',
      capturedAt: 90100000,
      sources: [],
      data: { gauges: [] },
    }),
    stage: 'events-payload',
    expect: { valid: false, code: 'bad-request' },
    notes: 'per-source freshness is REQUIRED — a snapshot with no sources cannot be honest',
  },
  {
    name: 'events-readmodel-unknown-freshness-state',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('events', 18, {
      kind: 'read-model-snapshot',
      readModel: 'quota-gauges',
      capturedAt: 90100000,
      sources: [{ source: 'claude-quota', state: 'broken' }],
      data: { gauges: [] },
    }),
    stage: 'events-payload',
    expect: { valid: false, code: 'bad-request' },
  },
  {
    name: 'events-readmodel-quota-pct-overflow',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('events', 19, {
      kind: 'read-model-snapshot',
      readModel: 'quota-gauges',
      capturedAt: 90100000,
      sources: [{ source: 'claude-quota', state: 'fresh' }],
      data: { gauges: [{ account: 'MAX_A', window: '5h', usedPct: 100.5, resetsAt: 1 }] },
    }),
    stage: 'events-payload',
    expect: { valid: false, code: 'bad-request' },
  },
  {
    name: 'events-unknown-kind-tolerated',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('events', 20, {
      kind: 'm4-workstream-lens',
      lens: { nodes: 3 },
    }),
    stage: 'events-payload',
    expect: { valid: true },
    notes:
      'THE frozen forward-tolerant reader rule: M4/M5 kinds land without breaking M3 clients — ' +
      'decode opaque, ignore',
  },
  {
    name: 'events-payload-missing-kind',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('events', 21, { readModel: 'quota-gauges' }),
    stage: 'events-payload',
    expect: { valid: false, code: 'bad-request' },
    notes: 'tolerance requires a non-empty string kind — kindless payloads are malformed',
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

  // ==== M4 freeze: workstream channel — broker → client =========================
  {
    name: 'workstream-list-snapshot-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('workstream', 0, {
      kind: 'workstream-list-snapshot',
      capturedAt: 90000000,
      workstreams: [GOLDEN_WS_SUMMARY],
      detachedNodeCount: 1,
    }),
    stage: 'workstream-payload',
    expect: { valid: true },
    notes: 'the workstream rail: summaries + the detached-HEAD orphan count',
  },
  {
    name: 'workstream-detail-snapshot-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('workstream', 1, {
      kind: 'workstream-detail-snapshot',
      capturedAt: 90000000,
      scope: 'workstream',
      workstream: GOLDEN_WS_SUMMARY,
      nodes: [GOLDEN_WS_NODE],
      edges: [GOLDEN_WS_EDGE],
    }),
    stage: 'workstream-payload',
    expect: { valid: true },
  },
  {
    name: 'workstream-detail-detached-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('workstream', 2, {
      kind: 'workstream-detail-snapshot',
      capturedAt: 90000000,
      scope: 'detached',
      nodes: [
        {
          kind: 'workstream-node',
          sessionId: 'ses_fake_ext',
          backend: 'opencode',
          account: 'AWS_DEV',
          state: 'external',
          origin: 'reconciled',
          confidence: 'inferred',
          createdAt: 90100000,
        },
      ],
      edges: [],
    }),
    stage: 'workstream-payload',
    expect: { valid: true },
    notes:
      'the detached-HEAD bucket: reconciled inferred-confidence orphans, NO workstream summary ' +
      '(scope matrix)',
  },
  {
    name: 'workstream-node-upsert-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('workstream', 3, GOLDEN_WS_NODE),
    stage: 'workstream-payload',
    expect: { valid: true },
    notes: 'node events are UPSERTS keyed on sessionId (add AND attribute change)',
  },
  {
    name: 'workstream-edge-continue-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('workstream', 4, GOLDEN_WS_EDGE),
    stage: 'workstream-payload',
    expect: { valid: true },
    notes: 'edge events are APPENDS keyed on edgeId — edges are immutable once recorded',
  },
  {
    name: 'workstream-edge-import-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('workstream', 5, {
      kind: 'workstream-edge',
      edgeId: 'edg_fake_2',
      toSessionId: 'ses_fake_1',
      edgeType: 'import',
      confidence: 'inferred',
      ts: 90300000,
    }),
    stage: 'workstream-payload',
    expect: { valid: true },
    notes: 'import edges have NO in-graph parent — fromSessionId is FORBIDDEN here',
  },
  {
    name: 'workstream-brief-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('workstream', 6, {
      kind: 'workstream-brief',
      briefId: 'br_fake_1',
      briefKind: 'session-end',
      body: 'continuation brief: /synthetic/workspace, sessions ses_fake_1',
      sourceSessionIds: ['ses_fake_1'],
      provenance: 'native-summary',
      createdAt: 90400000,
      workstreamId: 'ws_golden',
    }),
    stage: 'workstream-payload',
    expect: { valid: true },
    notes: 'brief bodies carry paths + session ids + labels only [X2] (producer duty)',
  },
  {
    name: 'workstream-branch-advisory-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('workstream', 7, {
      kind: 'branch-advisory',
      sessionId: 'ses_fake_1',
      contextUsedPct: 71.5,
      ts: 90500000,
    }),
    stage: 'workstream-payload',
    expect: { valid: true },
    notes: 'the context-pressure "branch now" proposal (~70%, blueprint §5)',
  },
  {
    name: 'workstream-merge-resolved-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('workstream', 8, {
      kind: 'workstream-merge-resolved',
      mergeId: 'mrg_01',
      sessionId: 'ses_fake_3',
      briefId: 'br_fake_2',
    }),
    stage: 'workstream-payload',
    expect: { valid: true },
    notes: 'merge success fans out to every client, correlated by mergeId',
  },
  {
    name: 'workstream-unknown-kind-tolerated',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('workstream', 9, { kind: 'm5-pipeline-lens', lens: { runs: 1 } }),
    stage: 'workstream-payload',
    expect: { valid: true },
    notes:
      'the frozen forward-tolerant reader rule, applied to workstream exactly as events §13.3: ' +
      'M5 kinds land without breaking M4 clients — decode opaque, ignore',
  },
  {
    name: 'workstream-payload-missing-kind',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('workstream', 10, { workstreams: [] }),
    stage: 'workstream-payload',
    expect: { valid: false, code: 'bad-request' },
    notes: 'tolerance requires a non-empty string kind — kindless payloads are malformed',
  },
  {
    name: 'workstream-node-native-id-rejected',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('workstream', 11, { ...GOLDEN_WS_NODE, nativeSessionId: 'fake-native-0' }),
    stage: 'workstream-payload',
    expect: { valid: false, code: 'bad-request' },
    notes:
      '[X2] design pin: native ids NEVER ride the workstream channel — a payload that even ' +
      'CARRIES the key is rejected (the context-touch account-key precedent)',
  },
  {
    name: 'workstream-node-pairing-violation',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('workstream', 12, { ...GOLDEN_WS_NODE, account: 'AWS_DEV' }),
    stage: 'workstream-payload',
    expect: { valid: false, code: 'bad-request' },
  },
  {
    name: 'workstream-node-unknown-state',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('workstream', 13, { ...GOLDEN_WS_NODE, state: 'spawning' }),
    stage: 'workstream-payload',
    expect: { valid: false, code: 'bad-request' },
    notes: 'node states are the LINEAGE enum — resume-ledger process states are a different axis',
  },
  {
    name: 'workstream-edge-unknown-type',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('workstream', 14, { ...GOLDEN_WS_EDGE, edgeType: 'rebase' }),
    stage: 'workstream-payload',
    expect: { valid: false, code: 'bad-request' },
    notes: 'the edge vocabulary is CLOSED: continue|fork|merge_parent|compact|sidechain|handoff|import|workflow',
  },
  {
    name: 'workstream-edge-missing-from',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('workstream', 15, {
      kind: 'workstream-edge',
      edgeId: 'edg_fake_3',
      toSessionId: 'ses_fake_2',
      edgeType: 'continue',
      confidence: 'recorded',
      ts: 90300000,
    }),
    stage: 'workstream-payload',
    expect: { valid: false, code: 'bad-request' },
    notes: 'fromSessionId is REQUIRED for every edge type except import',
  },
  {
    name: 'workstream-edge-import-with-from',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('workstream', 16, { ...GOLDEN_WS_EDGE, edgeType: 'import' }),
    stage: 'workstream-payload',
    expect: { valid: false, code: 'bad-request' },
  },
  {
    name: 'workstream-edge-handoff-without-brief',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('workstream', 17, { ...GOLDEN_WS_EDGE, edgeType: 'handoff' }),
    stage: 'workstream-payload',
    expect: { valid: false, code: 'bad-request' },
    notes: 'handoff briefs are MANDATORY — context travels by brief (blueprint §5)',
  },
  {
    name: 'workstream-detail-scope-matrix-violation',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('workstream', 18, {
      kind: 'workstream-detail-snapshot',
      capturedAt: 90000000,
      scope: 'detached',
      workstream: GOLDEN_WS_SUMMARY,
      nodes: [],
      edges: [],
    }),
    stage: 'workstream-payload',
    expect: { valid: false, code: 'bad-request' },
    notes: 'scope detached FORBIDS the workstream summary (the approvals §10.1 matrix precedent)',
  },
  {
    name: 'workstream-brief-empty-sources',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('workstream', 19, {
      kind: 'workstream-brief',
      briefId: 'br_fake_1',
      briefKind: 'merge',
      body: 'merge brief body',
      sourceSessionIds: [],
      provenance: 'refined',
      createdAt: 90400000,
    }),
    stage: 'workstream-payload',
    expect: { valid: false, code: 'bad-request' },
  },
  {
    name: 'workstream-branch-advisory-pct-out-of-range',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('workstream', 20, {
      kind: 'branch-advisory',
      sessionId: 'ses_fake_1',
      contextUsedPct: 120,
      ts: 90500000,
    }),
    stage: 'workstream-payload',
    expect: { valid: false, code: 'bad-request' },
    notes: 'honesty pin: contextUsedPct is 0..100, validated like quota usedPct',
  },

  // ==== M4 freeze: workstream channel — client → broker =========================
  {
    name: 'workstream-merge-request-valid',
    kind: 'text',
    direction: 'client-to-broker',
    frame: staticFrame('workstream', 0, GOLDEN_WS_MERGE_REQUEST),
    stage: 'workstream-client-message',
    expect: { valid: true },
    notes:
      'THE merge verb: one new node with N merge_parent edges seeded by a conflict-surfacing ' +
      'brief. A broker with no lineage engine composed answers the RUNTIME error ' +
      'session-not-found (parents unknown there) — the corpus pins the VALIDATION verdict.',
  },
  {
    name: 'workstream-replay-request-valid',
    kind: 'text',
    direction: 'client-to-broker',
    frame: staticFrame('workstream', 1, {
      kind: 'replay-request',
      channel: 'workstream',
      fromSeq: 0,
    }),
    stage: 'replay-request',
    expect: { valid: true },
    notes: 'workstream joined the replayable fan-out set at M4',
  },
  {
    name: 'workstream-merge-single-parent',
    kind: 'text',
    direction: 'client-to-broker',
    frame: staticFrame('workstream', 2, {
      ...GOLDEN_WS_MERGE_REQUEST,
      params: { ...GOLDEN_WS_MERGE_REQUEST.params, parents: ['ses_fake_1'] },
    }),
    stage: 'workstream-client-message',
    expect: { valid: false, code: 'bad-request' },
    notes: 'merge requires 2..16 parents',
  },
  {
    name: 'workstream-merge-duplicate-parents',
    kind: 'text',
    direction: 'client-to-broker',
    frame: staticFrame('workstream', 3, {
      ...GOLDEN_WS_MERGE_REQUEST,
      params: { ...GOLDEN_WS_MERGE_REQUEST.params, parents: ['ses_fake_1', 'ses_fake_1'] },
    }),
    stage: 'workstream-client-message',
    expect: { valid: false, code: 'bad-request' },
  },
  {
    name: 'workstream-merge-pairing-violation',
    kind: 'text',
    direction: 'client-to-broker',
    frame: staticFrame('workstream', 4, {
      ...GOLDEN_WS_MERGE_REQUEST,
      params: { ...GOLDEN_WS_MERGE_REQUEST.params, backend: 'opencode' },
    }),
    stage: 'workstream-client-message',
    expect: { valid: false, code: 'bad-request' },
  },
  {
    name: 'workstream-merge-blank-brief',
    kind: 'text',
    direction: 'client-to-broker',
    frame: staticFrame('workstream', 5, {
      ...GOLDEN_WS_MERGE_REQUEST,
      params: { ...GOLDEN_WS_MERGE_REQUEST.params, briefBody: '' },
    }),
    stage: 'workstream-client-message',
    expect: { valid: false, code: 'bad-request' },
    notes: 'merge briefs are MANDATORY (blueprint §5: merge = synthesis, not concatenation)',
  },
  {
    name: 'workstream-client-unknown-kind',
    kind: 'text',
    direction: 'client-to-broker',
    frame: staticFrame('workstream', 6, GOLDEN_WS_NODE),
    stage: 'workstream-client-message',
    expect: { valid: false, code: 'bad-request' },
    notes:
      'clients send exactly workstream-merge-request (+ the generic replay-request) — the ' +
      'approvals-channel precedent; server payload kinds from a client are rejected',
  },

  // ==== M4 freeze: pushed error for the new code =================================
  {
    name: 'pushed-error-workstream-not-found',
    kind: 'text',
    direction: 'broker-to-client',
    frame: controlFrame(5, {
      kind: 'error',
      code: 'workstream-not-found',
      message: 'merge request named an unknown workstream',
      retryable: false,
      correlatesTo: 'mrg_01',
      channel: 'workstream',
    }),
    stage: 'error-payload',
    expect: { valid: true },
    notes:
      'the merge verb error contract: failures answer PUSHED errors with correlatesTo=mergeId; ' +
      'unknown workstreamId is runtime state, never conflated with malformed traffic',
  },

  // ==== M5 freeze: pipelines channel — broker → client ==========================
  {
    name: 'pipelines-catalog-snapshot-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('pipelines', 0, {
      kind: 'catalog-snapshot',
      capturedAt: 90000000,
      workspace: '/synthetic/workspace',
      entries: [GOLDEN_CATALOG_ENTRY],
    }),
    stage: 'pipelines-payload',
    expect: { valid: true },
    notes: 'the builder palette: capability entries (paths+names+labels only [X2])',
  },
  {
    name: 'pipelines-run-snapshot-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('pipelines', 1, {
      kind: 'pipeline-run-snapshot',
      capturedAt: 90000000,
      run: {
        runId: 'run_fake_1',
        pipelineId: 'wf_fake_1',
        state: 'running',
        resumable: true,
        schemaHash: 'sha256:deadbeefcafe',
      },
      steps: [GOLDEN_PIPELINE_STEP],
    }),
    stage: 'pipelines-payload',
    expect: { valid: true },
    notes: 'the run monitor: run + per-step status (memoized = resumed-from-journal cache hit)',
  },
  {
    name: 'pipelines-run-status-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('pipelines', 2, {
      kind: 'pipeline-run-status',
      runId: 'run_fake_1',
      pipelineId: 'wf_fake_1',
      state: 'completed',
      costEstimatedUsd: 1.5,
    }),
    stage: 'pipelines-payload',
    expect: { valid: true },
  },
  {
    name: 'pipelines-step-status-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('pipelines', 3, { kind: 'pipeline-step-status', ...GOLDEN_PIPELINE_STEP }),
    stage: 'pipelines-payload',
    expect: { valid: true },
  },
  {
    name: 'pipelines-validation-result-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('pipelines', 4, {
      kind: 'pipeline-validation-result',
      requestId: 'req_v1',
      valid: false,
      issueCode: 'cycle',
      issueMessage: 'the needs graph is not a DAG',
      issuePath: 'steps',
    }),
    stage: 'pipelines-payload',
    expect: { valid: true },
    notes: 'validation failure is a NORMAL answer (not an error envelope) — carries the issue class',
  },
  {
    name: 'pipelines-saved-valid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('pipelines', 5, {
      kind: 'pipeline-saved',
      requestId: 'req_s1',
      pipelineId: 'wf_fake_1',
    }),
    stage: 'pipelines-payload',
    expect: { valid: true },
  },
  {
    name: 'pipelines-unknown-kind-tolerated',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('pipelines', 6, { kind: 'pipeline-cost-rollup-m6', foo: 1 }),
    stage: 'pipelines-payload',
    expect: { valid: true },
    notes: 'the frozen forward-tolerant reader rule: unknown kinds are legal-and-ignored (opaque)',
  },
  {
    name: 'pipelines-payload-missing-kind',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('pipelines', 7, { capturedAt: 90000000 }),
    stage: 'pipelines-payload',
    expect: { valid: false, code: 'bad-request' },
    notes: 'tolerance is for KINDS only — a kindless payload is malformed',
  },
  {
    name: 'pipelines-catalog-relative-sourcepath',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('pipelines', 8, {
      kind: 'catalog-snapshot',
      capturedAt: 90000000,
      entries: [{ ...GOLDEN_CATALOG_ENTRY, sourcePath: 'relative/SKILL.md' }],
    }),
    stage: 'pipelines-payload',
    expect: { valid: false, code: 'bad-request' },
  },
  {
    name: 'pipelines-run-status-unknown-state',
    kind: 'text',
    direction: 'broker-to-client',
    frame: staticFrame('pipelines', 9, {
      kind: 'pipeline-run-status',
      runId: 'run_fake_1',
      pipelineId: 'wf_fake_1',
      state: 'exploded',
    }),
    stage: 'pipelines-payload',
    expect: { valid: false, code: 'bad-request' },
  },

  // ==== M5 freeze: pipelines channel — client → broker ==========================
  {
    name: 'pipelines-validate-valid',
    kind: 'text',
    direction: 'client-to-broker',
    frame: staticFrame('pipelines', 0, {
      kind: 'pipeline-validate',
      requestId: 'req_v1',
      document: GOLDEN_DAG_DOCUMENT,
    }),
    stage: 'pipelines-client-message',
    expect: { valid: true },
  },
  {
    name: 'pipelines-save-valid',
    kind: 'text',
    direction: 'client-to-broker',
    frame: staticFrame('pipelines', 1, {
      kind: 'pipeline-save',
      requestId: 'req_s1',
      document: GOLDEN_DAG_DOCUMENT,
    }),
    stage: 'pipelines-client-message',
    expect: { valid: true },
  },
  {
    name: 'pipelines-launch-by-id-valid',
    kind: 'text',
    direction: 'client-to-broker',
    frame: staticFrame('pipelines', 2, {
      kind: 'pipeline-launch',
      requestId: 'req_l1',
      pipelineId: 'wf_fake_1',
      inputs: { paths: ['/synthetic/a.ts'] },
      workstreamId: 'ws_golden',
    }),
    stage: 'pipelines-client-message',
    expect: { valid: true },
    notes: 'the [X1] differentiator: per-step account routing rides the DAG; launch binds inputs',
  },
  {
    name: 'pipelines-resume-valid',
    kind: 'text',
    direction: 'client-to-broker',
    frame: staticFrame('pipelines', 3, {
      kind: 'pipeline-resume',
      requestId: 'req_r1',
      runId: 'run_fake_1',
    }),
    stage: 'pipelines-client-message',
    expect: { valid: true },
    notes: 'resume-from-journal: completed steps return cached output without re-execution (M5 DoD)',
  },
  {
    name: 'pipelines-replay-request-valid',
    kind: 'text',
    direction: 'client-to-broker',
    frame: staticFrame('pipelines', 4, { kind: 'replay-request', channel: 'pipelines', fromSeq: 0 }),
    stage: 'replay-request',
    expect: { valid: true },
    notes: 'pipelines joined the replayable fan-out set at M5',
  },
  {
    name: 'pipelines-launch-both-id-and-document',
    kind: 'text',
    direction: 'client-to-broker',
    frame: staticFrame('pipelines', 5, {
      kind: 'pipeline-launch',
      requestId: 'req_l2',
      pipelineId: 'wf_fake_1',
      document: GOLDEN_DAG_DOCUMENT,
    }),
    stage: 'pipelines-client-message',
    expect: { valid: false, code: 'bad-request' },
    notes: 'launch names EXACTLY ONE of pipelineId | document',
  },
  {
    name: 'pipelines-validate-cyclic-document',
    kind: 'text',
    direction: 'client-to-broker',
    frame: staticFrame('pipelines', 6, {
      kind: 'pipeline-validate',
      requestId: 'req_v2',
      document: {
        schemaVersion: 1,
        id: 'wf_fake_c',
        name: 'cyclic',
        steps: [{ id: 'a', kind: 'prompt', prompt: 'p', needs: ['a'] }],
      },
    }),
    stage: 'pipelines-client-message',
    expect: { valid: false, code: 'bad-request' },
    notes: 'a structurally invalid DAG on the wire verb is a shape error',
  },
  {
    name: 'pipelines-client-unknown-kind',
    kind: 'text',
    direction: 'client-to-broker',
    frame: staticFrame('pipelines', 7, { kind: 'pipeline-teleport', requestId: 'req_x' }),
    stage: 'pipelines-client-message',
    expect: { valid: false, code: 'bad-request' },
    notes: 'clients send exactly the six pipeline verbs (+ the generic replay-request)',
  },

  // ==== M5 freeze: pushed errors for the new codes ==============================
  {
    name: 'pushed-error-pipeline-not-found',
    kind: 'text',
    direction: 'broker-to-client',
    frame: controlFrame(6, {
      kind: 'error',
      code: 'pipeline-not-found',
      message: 'no saved pipeline for that id',
      retryable: false,
      correlatesTo: 'req_l1',
      channel: 'pipelines',
    }),
    stage: 'error-payload',
    expect: { valid: true },
  },
  {
    name: 'pushed-error-pipeline-run-not-found',
    kind: 'text',
    direction: 'broker-to-client',
    frame: controlFrame(7, {
      kind: 'error',
      code: 'pipeline-run-not-found',
      message: 'no run for that id',
      retryable: false,
      correlatesTo: 'req_r1',
      channel: 'pipelines',
    }),
    stage: 'error-payload',
    expect: { valid: true },
  },
  {
    name: 'pushed-error-pipeline-invalid',
    kind: 'text',
    direction: 'broker-to-client',
    frame: controlFrame(8, {
      kind: 'error',
      code: 'pipeline-invalid',
      message: 'the pipeline document failed validation',
      retryable: false,
      correlatesTo: 'req_l1',
      channel: 'pipelines',
    }),
    stage: 'error-payload',
    expect: { valid: true },
    notes: 'launch/save carrying a document that fails static validation → generic error [X2]',
  },
  {
    name: 'pushed-error-step-not-found',
    kind: 'text',
    direction: 'broker-to-client',
    frame: controlFrame(9, {
      kind: 'error',
      code: 'step-not-found',
      message: 'the run has no such step',
      retryable: false,
      channel: 'pipelines',
    }),
    stage: 'error-payload',
    expect: { valid: true },
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
 * Routing order on non-control JSON channels (M2, closed at M3, extended by
 * the M4 workstream channel):
 *   1. `pty.<sid>` → pty flow-control validator (M1, unchanged);
 *   2. client → broker `replay-request` on a replayable channel → replay
 *      validator (incl. `workstream` since M4);
 *   3. client → broker on `approvals` → decision validator; on `workstream`
 *      → merge-request validator (M4); any other client payload on a
 *      broker→client channel → channel policy reject;
 *   4. broker → client → the channel's payload validator — `events` since
 *      M3 and `workstream` since M4 (unknown kinds valid-and-ignored by the
 *      frozen forward-tolerant reader rule on both).
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
    // M4: workstream is the second one (merge requests).
    if (channel === 'workstream') {
      const merge = validateWorkstreamClientMessage(payload);
      return merge.ok
        ? { valid: true, stage: 'workstream-client-message' }
        : { valid: false, code: merge.code, stage: 'workstream-client-message' };
    }
    // M5: pipelines is the third one (the six pipeline verbs).
    if (channel === 'pipelines') {
      const verb = validatePipelineClientMessage(payload);
      return verb.ok
        ? { valid: true, stage: 'pipelines-client-message' }
        : { valid: false, code: verb.code, stage: 'pipelines-client-message' };
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

  // workstream (M4): the lineage union, forward-tolerant on unknown kinds.
  if (channel === 'workstream') {
    const workstream = validateWorkstreamServerPayload(payload);
    return workstream.ok
      ? { valid: true, stage: 'workstream-payload' }
      : { valid: false, code: workstream.code, stage: 'workstream-payload' };
  }

  // pipelines (M5): the catalog + run-monitor union, forward-tolerant on unknown kinds.
  if (channel === 'pipelines') {
    const pipelines = validatePipelineServerPayload(payload);
    return pipelines.ok
      ? { valid: true, stage: 'pipelines-payload' }
      : { valid: false, code: pipelines.code, stage: 'pipelines-payload' };
  }

  // events (M3): the frozen payload union, forward-tolerant on unknown kinds.
  const events = validateEventsPayload(payload);
  return events.ok
    ? { valid: true, stage: 'events-payload' }
    : { valid: false, code: events.code, stage: 'events-payload' };
}
