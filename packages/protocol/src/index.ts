/**
 * @aibender/protocol — WS envelope, channel, and message types shared by the
 * aibender-core gateway (BE-3) and every frontend client (FE-2).
 *
 * ============================================================================
 * FROZEN-M1-CORE (2026-07-04) — owner BE-ORCH, FE-ORCH co-signs.
 *
 * Frozen at M1-CORE (amendments ONLY via ICR in docs/contracts/icr/):
 *   - wire vocabularies (vocab.ts): account labels, backends, substrates,
 *     session states, label↔backend pairing
 *   - channel registry (channels.ts): control · events · quota · approvals ·
 *     pty.<sid> · transcript.<sid> · context-graph, stream mapping
 *   - envelope (envelope.ts): { stream, channel, seq, payload }
 *   - control verbs (control.ts): launch · resume · kill · status
 *     (`approve` RESERVED, shape lands M2)
 *   - binary PTY frame format + codec, ack-watermark flow-control messages
 *     (pty.ts)
 *   - error envelope + code registry (errors.ts)
 *   - inbound validators (validate.ts; hand-rolled — justification at the top
 *     of that file)
 *
 * DRAFT until M2 (draft.ts — do NOT build against as stable):
 *   - events / quota / approvals / transcript / context-graph payload unions
 *   - the WS auth-handshake message (per-boot token)
 *
 * Prose of record: docs/contracts/ws-protocol.md. If code and prose disagree,
 * file an ICR — never a silent divergence.
 * ============================================================================
 */

/**
 * Protocol version. `1.0.0-m1-core` = the M1-CORE freeze; the M2 full freeze
 * bumps to `1.0.0`. Consumers may assert against {@link PROTOCOL_FREEZE}.
 */
export const PROTOCOL_VERSION = '1.0.0-m1-core' as const;

/** Freeze marker for runtime assertions and golden fixtures. */
export const PROTOCOL_FREEZE = 'FROZEN-M1-CORE' as const;

// FROZEN-M1-CORE surfaces -----------------------------------------------------
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

export {
  validateControlRequest,
  validateControlResponse,
  validateErrorPayload,
  validatePtyClientMessage,
} from './validate.js';

// DRAFT surfaces (M2 freeze) --------------------------------------------------
export {
  type ApprovalsPayloadDraft,
  type ContextGraphPayloadDraft,
  type DraftPayloadBase,
  type EventsPayloadDraft,
  type QuotaPayloadDraft,
  type TranscriptPayloadDraft,
} from './draft.js';
