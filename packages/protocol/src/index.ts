/**
 * @aibender/protocol — WS envelope, channel, and message types shared by the
 * aibender-core gateway (BE-3) and every frontend client (FE-2).
 *
 * ============================================================================
 * FROZEN-M8 (2026-07-05) — owner BE-ORCH, FE-ORCH co-signs (ICR-0016). The
 * BACKEND-registry generalization ([X1] scalability, finding OS-1): the BACKEND
 * twin of the ICR-0013 account problem. Before this, `BACKENDS` was a CLOSED
 * frozen 3-tuple and `isBackend` tested membership in it; adding a fourth local
 * LLM / backend was a cross-codebase fork. vocab.ts now carries a
 * `BackendDescriptor` (id, the account-label form it serves, events source,
 * legal substrates, adapter/probe keys) + a registry (`registerBackend` /
 * `backendById` / `allBackends`), pre-populated with the three built-ins as
 * descriptors. `isBackend` validates registry membership (built-ins + any
 * registered), `backendForLabel`/`isAccountLabel` resolve through the
 * descriptors, and `sourceForBackend`/`substrateLegalFor` move onto the registry.
 * `BACKENDS` stays a KNOWN/SEED list (like `ACCOUNT_LABELS` after M7). This is a
 * validation-WIDENING additive change — every M1–M7 backend id/label is still
 * valid, the label↔backend + pty-is-claude-only pairing invariants are
 * preserved, and NO wire SHAPE changed — so a minor bump: `1.5.0` → `1.6.0`,
 * `FROZEN-M7` → `FROZEN-M8`. Prose of record: docs/contracts/ws-protocol.md §4.1
 * (backend vocabulary); docs/contracts/sqlite-ddl.md;
 * docs/contracts/icr/icr-0016-backend-registry.md.
 *
 * FROZEN-M7 (2026-07-05) — owner BE-ORCH, FE-ORCH co-signs (ICR-0013). The
 * account-registry generalization ([X1] scalability): the CLOSED 5-label
 * account set becomes an OPEN, validated FORM so a new Claude Max subscription
 * (MAX_C, MAX_D, …) is admitted WITHOUT a code change. vocab.ts splits FIXED
 * BACKEND LABELS {AWS_DEV, LOCAL} (closed) from CLAUDE ACCOUNT LABELS (open:
 * `^MAX_[A-Z]$` + exact `ENT`); `isAccountLabel` keys off the form, not a
 * hardcoded array; `LABEL_BACKENDS` (a Record) becomes `backendForLabel()` (a
 * function). This is a validation-WIDENING additive change — every M1–M6 label
 * is still valid, the label↔backend pairing invariant is preserved, and NO wire
 * SHAPE changed — so a minor bump: `1.4.0` → `1.5.0`, `FROZEN-M6` →
 * `FROZEN-M7`. Prose of record: docs/contracts/ws-protocol.md §4.1;
 * docs/contracts/icr/icr-0013-account-registry.md.
 *
 * FROZEN-M6 (2026-07-05) — owner BE-ORCH, FE-ORCH co-signs. The FINAL Stage-2
 * freeze. LIGHT by design (supervision is mostly core-internal): the ONE
 * boundary-crossing addition is the `resource-health` read model (the
 * supervision/governor instrument, blueprint §11) — an eleventh
 * `read-model-snapshot` kind on the EXISTING `events` channel carrying pressure
 * STATE + per-session footprints + shed/recycle notices, labels + numbers only
 * [X2]. Because `READ_MODEL_IDS` is a CLOSED registry (unknown `readModel`s are
 * REFUSED, unlike unknown `kind`s which are tolerated), this is a genuine
 * additive wire bump: `1.3.0` → `1.4.0`, `FROZEN-M5` → `FROZEN-M6`. NO M1–M5
 * wire shape changed. See docs/contracts/integration-suite.md for the §9.3/§9.4
 * integration-suite contract-of-record note landed alongside this freeze.
 *
 * FROZEN-M5 (2026-07-04) — owner BE-ORCH, FE-ORCH co-signs. The M5 freeze adds
 * the features-4/5 surfaces (catalog scanner + pipeline engine); every M1–M4
 * shape is carried forward unchanged. Amendments ONLY via ICR
 * (docs/contracts/icr/).
 *
 * Promoted to FROZEN at M5:
 *   - the versioned JSON DAG document format + validator (dag/): step kinds
 *     {prompt|skill|agent|workflow-script|approval}, `needs:` edges, `when`
 *     conditionals, `forEach`+`maxParallel`, `loop`, first-class `approval`
 *     gates; per-step account/backend/cwd/permissionMode/budget/retry/
 *     outputSchema; document `schemaVersion` with the forward-INCOMPAT rule
 *     (unknown versions + unknown step kinds are REFUSED, the opposite of the
 *     wire channels' forward-tolerant unknown-KIND rule — a DAG document is
 *     load-bearing execution state, not fire-and-forget fan-out). Validation
 *     semantics: cycle detection, unknown-step-kind, dangling-needs,
 *     duplicate-step-id, invalid-account (+ account/backend consistency),
 *     bad-shape. Prose of record: docs/contracts/dag-schema.md v1.
 *   - the `pipelines` channel payloads (pipelines.ts): broker→client
 *     `catalog-snapshot` (the builder palette; paths+names+labels only [X2])
 *     + `pipeline-run-snapshot`/`pipeline-run-status`/`pipeline-step-status`
 *     (the run monitor, per-step cost reference + resume-from-journal
 *     affordance) + `pipeline-validation-result` + `pipeline-saved`; client
 *     verbs `pipeline-validate|save|launch|pause|resume|cancel`; unknown
 *     broker-pushed kinds stay legal-and-ignored by the same forward-tolerant
 *     reader rule the events/workstream channels froze. Approval GATES ride
 *     the EXISTING approvals channel via the frozen `workflow-gate` source
 *     (§10.1) — no new gate wire (the M2 one-inbox precedent).
 *   - error codes `pipeline-not-found` / `pipeline-run-not-found` /
 *     `pipeline-invalid` / `step-not-found` (errors.ts amendment)
 *   - the `pipelines` channel joins the replayable fan-out set (replay.ts)
 *
 * FROZEN-M4 (2026-07-04). The M4 freeze added the X4 lineage surfaces; every
 * M1–M3 shape is carried forward unchanged.
 *
 * Promoted to FROZEN at M4 (workstreams.ts + amendments recorded in the
 * owning modules and docs):
 *   - the `workstream` channel (channels.ts amendment; replayable, replay.ts
 *     amendment): broker→client lineage fan-out (list/detail snapshots,
 *     node upserts, edge appends, brief bodies, the "branch now" advisory,
 *     merge resolutions) + the client `workstream-merge-request` — merge =
 *     ONE new node with N merge_parent edges seeded by a conflict-surfacing
 *     brief; unknown broker-pushed kinds stay legal-and-ignored by the same
 *     forward-tolerant reader rule the events channel froze at M3
 *   - lineage vocabularies shared with @aibender/schema migration 0003
 *     CHECKs: WORKSTREAM_STATUSES, SESSION_NODE_STATES, SESSION_EDGE_TYPES
 *     (exactly continue|fork|merge_parent|compact|sidechain|handoff|import|
 *     workflow), LINEAGE_CONFIDENCES (recorded|inferred),
 *     SESSION_NODE_ORIGINS, BRIEF_KINDS, BRIEF_PROVENANCES
 *   - error code `workstream-not-found` (errors.ts amendment)
 *   - the kernel-facing {@link LineageRecorder} port (launch/resume/fork/
 *     recycle/merge recorded AT ACTION TIME — generalizes the M2
 *     ContinuationEdgeEmitter stub; BE-7 implements, composition injects)
 *   - the {@link SessionIdResolver} seam (ws-protocol.md §12 M4 pin: the
 *     composition root injects the ledger resolver into the graphfeed)
 *   - hooks [X4] automation routing (hooks.ts amendment): SessionEnd →
 *     auto-brief, PreCompact → snapshot + compact edge, SessionStart →
 *     brief-injection response (HookSessionStartOutput + ackForSessionStart;
 *     WorkstreamHookRouting is the handler port BE-7 registers with BE-5)
 *
 * FROZEN-M3 (2026-07-04) — the M3 freeze closed the ONE surface the M2
 * full freeze left open and added the M3 read-model/hooks-acceptance types.
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
 * Carried forward from FROZEN-M1-CORE (2026-07-04), account-label form WIDENED
 * at M7 (ICR-0013):
 *   - wire vocabularies (vocab.ts): account labels (now an OPEN validated FORM —
 *     `^MAX_[A-Z]$` + `ENT` + the fixed backend labels AWS_DEV/LOCAL), backends,
 *     substrates, session states, label↔backend pairing (now `backendForLabel()`)
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
 * NOTHING remains draft after this freeze. New payload kinds on the events
 * and workstream channels may still land in later milestones WITHOUT a
 * version break (the forward-tolerant reader rule); every other change is
 * an ICR.
 *
 * Prose of record: docs/contracts/ws-protocol.md (WS surfaces) and
 * docs/contracts/hooks-contract.md (hooks acceptance + routing). If code and
 * prose disagree, file an ICR — never a silent divergence.
 * ============================================================================
 */

/**
 * Protocol version. `1.6.0` = the M8 BACKEND-registry generalization (ICR-0016,
 * additive/validation-widening: the backend CLOSED 3-tuple became a
 * `BackendDescriptor` REGISTRY — `isBackend` validates registry membership,
 * `backendForLabel`/`sourceForBackend`/`substrateLegalFor` resolve through
 * descriptors; the three built-ins behave byte-identically; no wire SHAPE
 * changed). `1.5.0` = the M7 account-registry generalization (ICR-0013,
 * additive/validation-widening: the account-label CLOSED 5-set became an OPEN
 * validated FORM — `^MAX_[A-Z]$` + `ENT` + fixed backend labels — and
 * `LABEL_BACKENDS` became `backendForLabel()`; no wire SHAPE changed).
 * `1.4.0` was the M6 freeze (additive: the eleventh read model `resource-health`
 * — the supervision/governor instrument, blueprint §11 — on the existing events
 * channel); `1.3.0` was the M5 freeze (pipelines channel + DAG schema module),
 * `1.2.0` the M4 freeze, `1.1.0` the M3 freeze, `1.0.0` the M2 full freeze,
 * `1.0.0-m1-core` the M1-CORE freeze. Consumers may assert against
 * {@link PROTOCOL_FREEZE}.
 */
export const PROTOCOL_VERSION = '1.6.0' as const;

/** Freeze marker for runtime assertions and golden fixtures. */
export const PROTOCOL_FREEZE = 'FROZEN-M8' as const;

// FROZEN surfaces (M1-CORE; account-label form widened at M7 — ICR-0013;
// backend registry added at M8 — ICR-0016) -----------------------------------
export {
  ACCOUNT_LABELS,
  BACKENDS,
  BUILTIN_BACKEND_DESCRIPTORS,
  BackendRegistrationError,
  CLAUDE_ACCOUNT_LABEL_RE,
  ENTERPRISE_ACCOUNT_LABEL,
  FIXED_BACKEND_LABELS,
  SESSION_STATES,
  SUBSTRATES,
  UnknownAccountLabelError,
  UnknownBackendError,
  allBackendIds,
  allBackends,
  backendById,
  backendForLabel,
  backendForLabelOrUndefined,
  isAccountLabel,
  isBackend,
  isClaudeAccountLabel,
  isFixedBackendLabel,
  isSessionState,
  isSubstrate,
  registerBackend,
  sourceForBackend,
  substrateLegalFor,
  unregisterBackend,
  type AccountLabel,
  type Backend,
  type BackendDescriptor,
  type BackendId,
  type ClaudeAccountLabel,
  type EnterpriseAccountLabel,
  type FixedBackendLabel,
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
  type PipelineChannelPayload,
  type WorkstreamChannelPayload,
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
  validateWorkstreamClientMessage,
  validateWorkstreamServerPayload,
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
  PRESSURE_STATES,
  READ_MODEL_IDS,
  SHED_ACTIONS,
  WATCHDOG_BANDS,
  isPressureState,
  isReadModelId,
  isShedAction,
  isWatchdogBand,
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
  type PressureState,
  type QuotaGauge,
  type QuotaGaugesSnapshot,
  type ReadModelId,
  type ReadModelSnapshot,
  type ReadModelSnapshotBase,
  type ResourceHealthSnapshot,
  type SessionFootprint,
  type SessionOutcomeEntry,
  type SessionOutcomesSnapshot,
  type ShedAction,
  type ShedNotice,
  type SkillLeaderboardSnapshot,
  type SkillLeaderboardEntry,
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

// FROZEN surfaces promoted at M4 ------------------------------------------------
export {
  X4_AUTOMATION_HOOK_EVENTS,
  ackForSessionStart,
  x4AutomationRouteFor,
  type HookSessionStartOutput,
  type WorkstreamHookRouting,
  type X4AutomationHookEvent,
} from './hooks.js';

export {
  BRIEF_KINDS,
  BRIEF_PROVENANCES,
  LINEAGE_CONFIDENCES,
  MERGE_ID_RE,
  MERGE_MAX_PARENTS,
  MERGE_MIN_PARENTS,
  SESSION_EDGE_TYPES,
  SESSION_NODE_ORIGINS,
  SESSION_NODE_STATES,
  WORKSTREAM_SERVER_PAYLOAD_KINDS,
  WORKSTREAM_STATUSES,
  isBriefKind,
  isBriefProvenance,
  isLineageConfidence,
  isLineageIdSegment,
  isSessionEdgeType,
  isSessionNodeOrigin,
  isSessionNodeState,
  isWorkstreamStatus,
  noopLineageRecorder,
  type BranchAdvisory,
  type BriefKind,
  type BriefProvenance,
  type LineageAction,
  type LineageConfidence,
  type LineageForkAction,
  type LineageLaunchAction,
  type LineageMergeAction,
  type LineageRecorder,
  type LineageRecycleAction,
  type LineageResumeAction,
  type OpaqueWorkstreamPayload,
  type SessionEdgeType,
  type SessionIdResolver,
  type SessionNodeOrigin,
  type SessionNodeState,
  type WorkstreamBriefPayload,
  type WorkstreamClientPayload,
  type WorkstreamDetailSnapshot,
  type WorkstreamEdgeEvent,
  type WorkstreamEdgeRecord,
  type WorkstreamListSnapshot,
  type WorkstreamMergeParams,
  type WorkstreamMergeRequest,
  type WorkstreamMergeResolved,
  type WorkstreamNodeEvent,
  type WorkstreamNodeRecord,
  type WorkstreamServerPayload,
  type WorkstreamStatus,
  type WorkstreamSummary,
} from './workstreams.js';

// FROZEN surfaces promoted at M5 ------------------------------------------------

// The versioned JSON DAG document format + validator (dag-schema.md v1).
export {
  CAPABILITY_SCOPES,
  DAG_ID_RE,
  DAG_ISSUE_CODES,
  DAG_NAME_RE,
  DAG_SCHEMA_VERSION,
  EXECUTABLE_STEP_KINDS,
  ON_ERROR_POLICIES,
  PERMISSION_MODES,
  RETRY_ON_CLASSES,
  STEP_BACKENDS,
  STEP_ID_RE,
  STEP_KINDS,
  accountStepBackendsFor,
  isCapabilityScope,
  isPermissionMode,
  isRetryOnClass,
  isStepBackend,
  isStepKind,
  validateDagDocument,
  type AgentStep,
  type ApprovalStep,
  type CapabilityRef,
  type CapabilityScope,
  type DagDefaults,
  type DagDocument,
  type DagInputSchema,
  type DagIssueCode,
  type DagValidationIssue,
  type DagValidationResult,
  type ExecutableStepKind,
  type LoopControl,
  type OnErrorLiteral,
  type OnErrorPolicy,
  type PermissionMode,
  type PipelineStep,
  type PromptStep,
  type RetryOnClass,
  type RetryPolicy,
  type SkillStep,
  type StepBackend,
  type StepBudget,
  type StepKind,
  type WorkflowScriptStep,
} from './dag/index.js';

// The `pipelines` channel payloads + client verbs (ws-protocol.md §18).
export {
  CAPABILITY_BACKEND_FAMILIES,
  CAPABILITY_KINDS,
  CATALOG_SCOPES,
  PIPELINE_CLIENT_VERBS,
  PIPELINE_ID_RE,
  PIPELINE_REQUEST_ID_RE,
  PIPELINE_RUN_STATES,
  PIPELINE_RUN_VERBS,
  PIPELINE_SERVER_PAYLOAD_KINDS,
  PIPELINE_STEP_STATES,
  isCapabilityBackendFamily,
  isCapabilityKind,
  isCatalogScope,
  isPipelineRunState,
  isPipelineStepState,
  type CapabilityBackendFamily,
  type CapabilityKind,
  type CatalogEntry,
  type CatalogScope,
  type CatalogSnapshot,
  type OpaquePipelinePayload,
  type PipelineCancelRequest,
  type PipelineClientPayload,
  type PipelineClientVerb,
  type PipelineLaunchRequest,
  type PipelinePauseRequest,
  type PipelineResumeRequest,
  type PipelineRunSnapshot,
  type PipelineRunState,
  type PipelineRunStatusEvent,
  type PipelineRunStatusRecord,
  type PipelineSaveRequest,
  type PipelineSaved,
  type PipelineServerPayload,
  type PipelineStepState,
  type PipelineStepStatusEvent,
  type PipelineStepStatusRecord,
  type PipelineValidateRequest,
  type PipelineValidationResult,
} from './pipelines.js';

export { validatePipelineClientMessage, validatePipelineServerPayload } from './validate.js';
