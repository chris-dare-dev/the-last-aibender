/**
 * @aibender/protocol — WS envelope, channel, and message types shared by the
 * aibender-core gateway (BE-3) and every frontend client (FE-2).
 *
 * ============================================================================
 * FROZEN-M2 (2026-07-04) — owner BE-ORCH, FE-ORCH co-signs. The M2 FULL
 * freeze (plan §3: "M1 core, M2 full"). Amendments ONLY via ICR
 * (docs/contracts/icr/).
 *
 * Carried forward unchanged from FROZEN-M1-CORE (2026-07-04):
 *   - wire vocabularies (vocab.ts): account labels, backends, substrates,
 *     session states, label↔backend pairing
 *   - channel registry (channels.ts): control · events · quota · approvals ·
 *     pty.<sid> · transcript.<sid> · context-graph, stream mapping
 *   - envelope (envelope.ts): { stream, channel, seq, payload }
 *   - control verbs (control.ts): launch · resume · kill · status
 *   - binary PTY frame format + codec, ack-watermark flow-control messages
 *     incl. pty-resize (pty.ts)
 *   - error envelope + code registry (errors.ts)
 *
 * Promoted to FROZEN at M2:
 *   - transcript.<sid> payloads (transcript.ts): delta · tool · result
 *   - approvals payloads (approvals.ts): request · decision · resolved,
 *     covering can-use-tool, hook-floor and workflow-gate sources
 *   - quota snapshot (quota.ts)
 *   - context-graph touch (contextGraph.ts) — identity-free by design [X2]
 *   - JSON reconnect-replay (replay.ts): per-(boot, channel) seq journal +
 *     `replay-request`; PTY byte replay was already frozen at M1
 *   - the WS auth transport: connect-time token (query param or bearer
 *     header) — the M1 "handshake message" placeholder was resolved as NOT
 *     NEEDED (ws-protocol.md §1)
 *   - error code `approval-not-pending` (amendment-recorded)
 *
 * Decisions recorded at this freeze:
 *   - the reserved `approve` control verb is retired-as-reserved: decisions
 *     ride the approvals channel; the verb name stays registered-and-rejected
 *     (`verb-reserved`) so nothing can squat on it
 *   - the `events` payload union is DEFERRED TO M3 (draft.ts) — the only
 *     surface still open after this freeze
 *
 * Prose of record: docs/contracts/ws-protocol.md. If code and prose disagree,
 * file an ICR — never a silent divergence.
 * ============================================================================
 */

/**
 * Protocol version. `1.0.0` = the M2 full freeze (`1.0.0-m1-core` was the
 * M1-CORE freeze). Consumers may assert against {@link PROTOCOL_FREEZE}.
 */
export const PROTOCOL_VERSION = '1.0.0' as const;

/** Freeze marker for runtime assertions and golden fixtures. */
export const PROTOCOL_FREEZE = 'FROZEN-M2' as const;

// FROZEN surfaces (M1-CORE, carried forward) ----------------------------------
export {
  ACCOUNT_LABELS,
  BACKENDS,
  LABEL_BACKENDS,
  SESSION_STATES,
  SUBSTRATES,
  isAccountLabel,
  isBackend,
  isSessionState,
  isSubstrate,
  type AccountLabel,
  type Backend,
  type SessionState,
  type Substrate,
} from './vocab.js';

export {
  CHANNEL,
  MAX_SESSION_ID_BYTES,
  SESSION_ID_SEGMENT_RE,
  STATIC_CHANNELS,
  STREAMS,
  isChannelName,
  isSessionIdSegment,
  ptyChannel,
  sessionIdOfChannel,
  streamForChannel,
  transcriptChannel,
  type ChannelName,
  type PtyChannelName,
  type StaticChannelName,
  type StreamName,
  type TranscriptChannelName,
} from './channels.js';

export {
  isEnvelope,
  validateEnvelope,
  type Envelope,
  type FrozenM1Payload,
  type FrozenPayload,
} from './envelope.js';

export {
  CONTROL_VERBS,
  REQUEST_ID_RE,
  RESERVED_CONTROL_VERBS,
  type ControlRequest,
  type ControlResponse,
  type ControlResult,
  type ControlVerb,
  type KillRequest,
  type LaunchParams,
  type LaunchRequest,
  type ResumeRequest,
  type SessionStatus,
  type StatusRequest,
} from './control.js';

export {
  PTY_CLIENT_MESSAGE_KINDS,
  PTY_FRAME_HEADER_BYTES,
  PTY_FRAME_MAGIC,
  PTY_FRAME_MAX_PAYLOAD_BYTES,
  PTY_FRAME_TYPE,
  PTY_FRAME_VERSION,
  PTY_MAX_COLS,
  PTY_MAX_ROWS,
  decodePtyFrame,
  encodePtyFrame,
  type PtyAck,
  type PtyClientMessage,
  type PtyFrame,
  type PtyFrameKind,
  type PtyReplayRequest,
  type PtyResize,
} from './pty.js';

export {
  ERROR_CODES,
  isErrorCode,
  type ErrorCode,
  type ErrorDetail,
  type ErrorPayload,
} from './errors.js';

export { invalid, valid, type ValidationResult } from './result.js';

// FROZEN surfaces promoted at M2 ------------------------------------------------
export {
  TRANSCRIPT_PAYLOAD_KINDS,
  type TranscriptDelta,
  type TranscriptPayload,
  type TranscriptResult,
  type TranscriptToolEvent,
  type TranscriptUsage,
} from './transcript.js';

export {
  APPROVAL_ID_RE,
  APPROVAL_OUTCOMES,
  APPROVAL_SOURCES,
  APPROVAL_VERDICTS,
  type ApprovalDecision,
  type ApprovalOutcome,
  type ApprovalRequest,
  type ApprovalResolved,
  type ApprovalSource,
  type ApprovalVerdict,
  type ApprovalsClientPayload,
  type ApprovalsPayload,
  type ApprovalsServerPayload,
} from './approvals.js';

export {
  QUOTA_SOURCES,
  QUOTA_WINDOWS,
  type QuotaSnapshot,
  type QuotaSource,
  type QuotaWindow,
} from './quota.js';

export {
  CONTEXT_GRAPH_RELATIONS,
  type ContextGraphRelation,
  type ContextGraphTouch,
} from './contextGraph.js';

export {
  REPLAYABLE_STREAMS,
  isReplayableChannel,
  type JsonReplayRequest,
} from './replay.js';

export {
  validateApprovalsClientMessage,
  validateApprovalsServerMessage,
  validateContextGraphTouch,
  validateControlRequest,
  validateControlResponse,
  validateErrorPayload,
  validateJsonReplayRequest,
  validatePtyClientMessage,
  validateQuotaSnapshot,
  validateTranscriptPayload,
} from './validate.js';

// DRAFT surfaces (M3 freeze — events only) --------------------------------------
export { type DraftPayloadBase, type EventsPayloadDraft } from './draft.js';
