/**
 * @aibender/protocol — WS envelope, channel, and message types shared by the
 * aibender-core gateway (BE-3) and every frontend client (FE-2).
 *
 * ============================================================================
 * FROZEN-M3 (2026-07-04) — owner BE-ORCH, FE-ORCH co-signs (SI-ORCH co-signs
 * the hooks acceptance slice). The M3 freeze closes the ONE surface the M2
 * full freeze left open and adds the M3 read-model/hooks-acceptance types.
 * Amendments ONLY via ICR (docs/contracts/icr/).
 *
 * Promoted to FROZEN at M3:
 *   - the `events` channel payload union (events.ts + readModels.ts):
 *     `event-summary` (normalized events-store row fan-out) and
 *     `read-model-snapshot` (the ten §6.3 dashboard leads, each with an
 *     explicit per-source freshness field — degraded sources are STATES,
 *     never errors); unknown kinds stay legal-and-ignored by the frozen
 *     forward-tolerant reader rule (the M2 opaque policy, made permanent)
 *   - EVENT_SOURCES / SOURCE_FRESHNESS_STATES / EVENT_ERROR_KINDS /
 *     READ_MODEL_IDS vocabularies (shared with @aibender/schema migration
 *     0002 CHECK constraints)
 *   - hooks acceptance-side types (hooks.ts): POST validation outcome, ack
 *     shape, PermissionRequest→hook-floor relay contract
 *     (docs/contracts/hooks-contract.md; BE-5 collector + gateway agree here)
 *
 * Verified sufficient at M3 (no amendment needed):
 *   - quota snapshot (quota.ts) carries the statusline tee data exactly
 *     (five_hour/seven_day → 5h/7d windows, usedPct, resetsAt countdowns)
 *   - context-graph touch (contextGraph.ts) stays file-paths + session-ids
 *     ONLY [X2]
 *
 * Carried forward unchanged from FROZEN-M2 (2026-07-04):
 *   - transcript.<sid> payloads · approvals payloads · quota snapshot ·
 *     context-graph touch · JSON reconnect-replay · connect-time auth token
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
 *   - the M2 decisions: `approve` retired-as-reserved (decisions ride the
 *     approvals channel); connect-time auth token; `approval-not-pending`
 *
 * NOTHING remains draft after this freeze (draft.ts was removed — its last
 * occupant, the events union, is now frozen). New payload kinds on the
 * events channel may still land in later milestones WITHOUT a version break
 * (the forward-tolerant reader rule); every other change is an ICR.
 *
 * Prose of record: docs/contracts/ws-protocol.md (WS surfaces) and
 * docs/contracts/hooks-contract.md (hooks acceptance). If code and prose
 * disagree, file an ICR — never a silent divergence.
 * ============================================================================
 */

/**
 * Protocol version. `1.1.0` = the M3 freeze (additive: events union +
 * read-model snapshots + hooks acceptance; `1.0.0` was the M2 full freeze,
 * `1.0.0-m1-core` the M1-CORE freeze). Consumers may assert against
 * {@link PROTOCOL_FREEZE}.
 */
export const PROTOCOL_VERSION = '1.1.0' as const;

/** Freeze marker for runtime assertions and golden fixtures. */
export const PROTOCOL_FREEZE = 'FROZEN-M3' as const;

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
  type EventsServerPayload,
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
  validateEventsPayload,
  validateJsonReplayRequest,
  validatePtyClientMessage,
  validateQuotaSnapshot,
  validateTranscriptPayload,
} from './validate.js';

// FROZEN surfaces promoted at M3 ------------------------------------------------
export {
  EVENT_ERROR_KINDS,
  EVENT_SOURCES,
  SOURCE_FRESHNESS_STATES,
  isEventErrorKind,
  isEventSource,
  isSourceFreshnessState,
  type EventErrorKind,
  type EventSource,
  type EventSummary,
  type OpaqueEventsPayload,
  type SourceFreshness,
  type SourceFreshnessState,
} from './events.js';

export {
  READ_MODEL_IDS,
  isReadModelId,
  type ApiEquivalentUsdEntry,
  type ApiEquivalentUsdSnapshot,
  type BedrockCostSnapshot,
  type BurnRateEntry,
  type BurnRateSnapshot,
  type CacheHitRateEntry,
  type CacheHitRateSnapshot,
  type HealthEntry,
  type HealthSnapshot,
  type LatencyEntry,
  type LatencySnapshot,
  type LocalOffloadSnapshot,
  type QuotaGauge,
  type QuotaGaugesSnapshot,
  type ReadModelId,
  type ReadModelSnapshot,
  type ReadModelSnapshotBase,
  type SessionOutcomeEntry,
  type SessionOutcomesSnapshot,
  type SkillLeaderboardEntry,
  type SkillLeaderboardSnapshot,
} from './readModels.js';

export {
  DEFAULT_HOOKS_PORT,
  GATING_CAPABLE_HOOK_EVENTS,
  HOOKS_PORT_ENV_VAR,
  HOOK_EVENT_GROUPS,
  HOOK_EVENT_VOCABULARY,
  HOOK_PATH_PREFIX,
  HOOK_PERMISSION_DECISIONS,
  ackForHookOutcome,
  hookFloorRelayInput,
  isGatingCapableHookEvent,
  mapHookEventName,
  validateHookPost,
  type AcceptedHookPost,
  type HookAck,
  type HookEventGroup,
  type HookFloorRelayInput,
  type HookGatingOutput,
  type HookPermissionDecision,
  type HookPostOutcome,
  type HookPostRejection,
} from './hooks.js';
