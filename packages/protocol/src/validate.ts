/**
 * Runtime validators for every INBOUND wire type.
 *
 * WHY HAND-ROLLED, NOT ZOD (decision, BE-ORCH, M1 freeze):
 *  1. Zero runtime dependencies. This package is the frozen contract consumed
 *     by BOTH the Node broker and the WKWebView bundle (FE-2). A zod version
 *     bump would silently change frozen-validation behavior in two departments
 *     at once — the exact drift the freeze exists to prevent. The M0 stub also
 *     shipped dependency-free; staying that way keeps the surface auditable.
 *  2. The inbound surface is small and closed (4 control verbs, 3 pty
 *     messages, the M2 channel payload unions, 1 error payload, 1 envelope,
 *     1 binary codec). Hand-rolled checks under `strict` +
 *     `exactOptionalPropertyTypes` are shorter than the equivalent zod
 *     schemas and produce exactly the ErrorCode taxonomy the gateway answers
 *     with (zod errors would need mapping anyway).
 *  3. Golden-fixture protocol tests (plan §9.3 BE↔FE #1) pin behavior; a
 *     validation-library swap later is an internal change, not an ICR.
 *
 * All validators are total over `unknown`, never throw on wire data, and
 * return sanitized values containing ONLY contract keys (unknown keys are
 * dropped, never echoed — [X2]-friendly).
 *
 * ============================================================================
 * FROZEN-M1-CORE (2026-07-04) → FROZEN-M2 (2026-07-04) → FROZEN-M3
 * (2026-07-04). Amendments only via ICR (docs/contracts/icr/); BE-ORCH
 * lands, FE-ORCH co-signs. Prose of record: docs/contracts/ws-protocol.md.
 * M2 additions: transcript / approvals / quota / context-graph payload
 * validators + the JSON replay-request validator.
 * M3 additions: the `events` payload validator (event-summary +
 * read-model-snapshot, with the frozen forward-tolerant unknown-kind rule).
 * M4 additions: the `workstream` payload validators (server union with the
 * same frozen forward-tolerant unknown-kind rule; client merge-request).
 * ============================================================================
 */

import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolved,
  ApprovalsClientPayload,
  ApprovalsServerPayload,
} from './approvals.js';
import { APPROVAL_ID_RE, APPROVAL_OUTCOMES, APPROVAL_SOURCES, APPROVAL_VERDICTS } from './approvals.js';
import { isSessionIdSegment } from './channels.js';
import { isChannelName } from './channels.js';
import type { ContextGraphTouch } from './contextGraph.js';
import { CONTEXT_GRAPH_RELATIONS } from './contextGraph.js';
import type {
  ControlRequest,
  ControlResponse,
  ControlResult,
  KillRequest,
  LaunchParams,
  LaunchRequest,
  ResumeRequest,
  SessionStatus,
  StatusRequest,
} from './control.js';
import { CONTROL_VERBS, REQUEST_ID_RE, RESERVED_CONTROL_VERBS } from './control.js';
import type { ErrorDetail, ErrorPayload } from './errors.js';
import { isErrorCode } from './errors.js';
import type { EventSummary, OpaqueEventsPayload, SourceFreshness } from './events.js';
import { isEventErrorKind, isEventSource, isSourceFreshnessState } from './events.js';
import type { PtyAck, PtyClientMessage, PtyReplayRequest, PtyResize } from './pty.js';
import { PTY_MAX_COLS, PTY_MAX_ROWS } from './pty.js';
import type { QuotaSnapshot, QuotaWindow } from './quota.js';
import { QUOTA_SOURCES, QUOTA_WINDOWS } from './quota.js';
import type {
  ApiEquivalentUsdEntry,
  BurnRateEntry,
  CacheHitRateEntry,
  HealthEntry,
  LatencyEntry,
  QuotaGauge,
  ReadModelSnapshot,
  SessionFootprint,
  SessionOutcomeEntry,
  ShedNotice,
  SkillLeaderboardEntry,
} from './readModels.js';
import { isPressureState, isReadModelId, isShedAction, isWatchdogBand } from './readModels.js';
import type { JsonReplayRequest } from './replay.js';
import { isReplayableChannel } from './replay.js';
import type { ValidationResult } from './result.js';
import { invalid, valid } from './result.js';
import type {
  TranscriptDelta,
  TranscriptPayload,
  TranscriptResult,
  TranscriptToolEvent,
  TranscriptUsage,
} from './transcript.js';
import {
  LABEL_BACKENDS,
  isAccountLabel,
  isBackend,
  isSessionState,
  isSubstrate,
} from './vocab.js';
import type {
  BranchAdvisory,
  OpaqueWorkstreamPayload,
  WorkstreamBriefPayload,
  WorkstreamClientPayload,
  WorkstreamDetailSnapshot,
  WorkstreamEdgeRecord,
  WorkstreamListSnapshot,
  WorkstreamMergeParams,
  WorkstreamMergeResolved,
  WorkstreamNodeRecord,
  WorkstreamServerPayload,
  WorkstreamSummary,
} from './workstreams.js';
import {
  MERGE_ID_RE,
  MERGE_MAX_PARENTS,
  MERGE_MIN_PARENTS,
  isBriefKind,
  isBriefProvenance,
  isLineageConfidence,
  isLineageIdSegment,
  isSessionEdgeType,
  isSessionNodeOrigin,
  isSessionNodeState,
  isWorkstreamStatus,
} from './workstreams.js';
import type {
  CatalogEntry,
  CatalogSnapshot,
  OpaquePipelinePayload,
  PipelineClientPayload,
  PipelineRunSnapshot,
  PipelineRunStatusEvent,
  PipelineRunStatusRecord,
  PipelineSaved,
  PipelineServerPayload,
  PipelineStepStatusEvent,
  PipelineStepStatusRecord,
  PipelineValidationResult,
} from './pipelines.js';
import {
  PIPELINE_ID_RE,
  PIPELINE_REQUEST_ID_RE,
  isCapabilityBackendFamily,
  isCapabilityKind,
  isCatalogScope,
  isPipelineRunState,
  isPipelineStepState,
} from './pipelines.js';
import { validateDagDocument } from './dag/index.js';

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_RE.test(value);
}

function isApprovalId(value: unknown): value is string {
  return typeof value === 'string' && APPROVAL_ID_RE.test(value);
}

/** Epoch milliseconds on the wire: non-negative safe integer. */
function isEpochMs(value: unknown): value is number {
  return isNonNegativeSafeInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// ---------------------------------------------------------------------------
// Control requests (inbound to the broker)
// ---------------------------------------------------------------------------

function validateLaunchParams(value: unknown): ValidationResult<LaunchParams> {
  if (!isRecord(value)) return invalid('bad-request', 'launch params must be an object');
  const accountLabel = value['accountLabel'];
  if (!isAccountLabel(accountLabel)) {
    return invalid('bad-request', `unknown account label ${JSON.stringify(accountLabel)}`);
  }
  const backend = value['backend'];
  if (!isBackend(backend)) {
    return invalid('bad-request', `unknown backend ${JSON.stringify(backend)}`);
  }
  if (LABEL_BACKENDS[accountLabel] !== backend) {
    return invalid(
      'bad-request',
      `label/backend pairing violation: ${accountLabel} requires ${LABEL_BACKENDS[accountLabel]}, got ${backend}`,
    );
  }
  const substrate = value['substrate'];
  if (!isSubstrate(substrate)) {
    return invalid('bad-request', `unknown substrate ${JSON.stringify(substrate)}`);
  }
  if (substrate === 'pty' && backend !== 'claude_code') {
    return invalid('bad-request', `substrate pty is claude_code-only (blueprint §4.1), got backend ${backend}`);
  }
  const cwd = value['cwd'];
  if (!isNonEmptyString(cwd) || !cwd.startsWith('/')) {
    return invalid('bad-request', 'cwd must be an absolute path (byte-stable string; blueprint §3 rule 2)');
  }
  const purpose = value['purpose'];
  if (!isNonEmptyString(purpose)) {
    return invalid('bad-request', 'purpose must be a non-empty string');
  }
  const workstreamHint = value['workstreamHint'];
  if (workstreamHint !== undefined && !isNonEmptyString(workstreamHint)) {
    return invalid('bad-request', 'workstreamHint, when present, must be a non-empty string');
  }
  const prompt = value['prompt'];
  if (prompt !== undefined && !isNonEmptyString(prompt)) {
    return invalid('bad-request', 'prompt, when present, must be a non-empty string');
  }
  const params: LaunchParams = {
    accountLabel,
    backend,
    substrate,
    cwd,
    purpose,
    ...(workstreamHint !== undefined ? { workstreamHint } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
  };
  return valid(params);
}

/**
 * Validate an inbound control-channel request payload. Reserved verbs
 * (`approve`) answer `verb-reserved`; unregistered kinds answer `unknown-verb`.
 */
export function validateControlRequest(value: unknown): ValidationResult<ControlRequest> {
  if (!isRecord(value)) return invalid('bad-request', 'control request must be an object');
  const kind = value['kind'];
  if (typeof kind !== 'string') return invalid('unknown-verb', 'control request has no kind');
  if ((RESERVED_CONTROL_VERBS as readonly string[]).includes(kind)) {
    return invalid('verb-reserved', `verb ${JSON.stringify(kind)} is reserved until its freeze milestone (M2)`);
  }
  if (!(CONTROL_VERBS as readonly string[]).includes(kind)) {
    return invalid('unknown-verb', `unknown control verb ${JSON.stringify(kind)}`);
  }
  const id = value['id'];
  if (!isRequestId(id)) {
    return invalid('bad-request', `request id must match ${REQUEST_ID_RE.source}`);
  }

  switch (kind as ControlRequest['kind']) {
    case 'launch': {
      const params = validateLaunchParams(value['params']);
      if (!params.ok) return params;
      const request: LaunchRequest = { kind: 'launch', id, params: params.value };
      return valid(request);
    }
    case 'resume': {
      const p = value['params'];
      if (!isRecord(p)) return invalid('bad-request', 'resume params must be an object');
      const sessionId = p['sessionId'];
      if (!isSessionIdSegment(sessionId)) {
        return invalid('bad-request', `resume sessionId ${JSON.stringify(sessionId)} is malformed`);
      }
      const fork = p['fork'];
      if (fork !== undefined && typeof fork !== 'boolean') {
        return invalid('bad-request', 'resume fork, when present, must be a boolean');
      }
      // ICR-0004: optional next-user-prompt; the sdk substrate requires it at
      // M1 (enforced broker-side with `bad-request`, not by this validator —
      // the wire shape stays substrate-agnostic).
      const prompt = p['prompt'];
      if (prompt !== undefined && !isNonEmptyString(prompt)) {
        return invalid('bad-request', 'resume prompt, when present, must be a non-empty string');
      }
      const request: ResumeRequest = {
        kind: 'resume',
        id,
        params: {
          sessionId,
          ...(fork !== undefined ? { fork } : {}),
          ...(prompt !== undefined ? { prompt } : {}),
        },
      };
      return valid(request);
    }
    case 'kill': {
      const p = value['params'];
      if (!isRecord(p)) return invalid('bad-request', 'kill params must be an object');
      const sessionId = p['sessionId'];
      if (!isSessionIdSegment(sessionId)) {
        return invalid('bad-request', `kill sessionId ${JSON.stringify(sessionId)} is malformed`);
      }
      const mode = p['mode'];
      if (mode !== undefined && mode !== 'graceful' && mode !== 'force') {
        return invalid('bad-request', `kill mode must be graceful|force, got ${JSON.stringify(mode)}`);
      }
      const request: KillRequest = {
        kind: 'kill',
        id,
        params: { sessionId, ...(mode !== undefined ? { mode } : {}) },
      };
      return valid(request);
    }
    case 'status': {
      const p = value['params'];
      if (p === undefined) {
        const request: StatusRequest = { kind: 'status', id };
        return valid(request);
      }
      if (!isRecord(p)) return invalid('bad-request', 'status params, when present, must be an object');
      const sessionId = p['sessionId'];
      if (sessionId !== undefined && !isSessionIdSegment(sessionId)) {
        return invalid('bad-request', `status sessionId ${JSON.stringify(sessionId)} is malformed`);
      }
      const request: StatusRequest = {
        kind: 'status',
        id,
        params: sessionId !== undefined ? { sessionId } : {},
      };
      return valid(request);
    }
  }
}

// ---------------------------------------------------------------------------
// Control responses (inbound to the frontend client)
// ---------------------------------------------------------------------------

function validateErrorDetail(value: unknown): ValidationResult<ErrorDetail> {
  if (!isRecord(value)) return invalid('bad-request', 'error detail must be an object');
  const code = value['code'];
  if (!isErrorCode(code)) return invalid('bad-request', `unknown error code ${JSON.stringify(code)}`);
  const message = value['message'];
  if (!isNonEmptyString(message)) return invalid('bad-request', 'error message must be a non-empty string');
  const retryable = value['retryable'];
  if (typeof retryable !== 'boolean') return invalid('bad-request', 'error retryable must be a boolean');
  return valid({ code, message, retryable });
}

function validateSessionStatus(value: unknown): ValidationResult<SessionStatus> {
  if (!isRecord(value)) return invalid('bad-request', 'session status must be an object');
  const sessionId = value['sessionId'];
  if (!isSessionIdSegment(sessionId)) return invalid('bad-request', 'session status sessionId malformed');
  const accountLabel = value['accountLabel'];
  if (!isAccountLabel(accountLabel)) return invalid('bad-request', 'session status accountLabel unknown');
  const backend = value['backend'];
  if (!isBackend(backend)) return invalid('bad-request', 'session status backend unknown');
  const substrate = value['substrate'];
  if (!isSubstrate(substrate)) return invalid('bad-request', 'session status substrate unknown');
  const state = value['state'];
  if (!isSessionState(state)) return invalid('bad-request', 'session status state unknown');
  const cwd = value['cwd'];
  if (!isNonEmptyString(cwd)) return invalid('bad-request', 'session status cwd must be a non-empty string');
  const purpose = value['purpose'];
  if (!isNonEmptyString(purpose)) return invalid('bad-request', 'session status purpose must be a non-empty string');
  const workstreamHint = value['workstreamHint'];
  if (workstreamHint !== undefined && !isNonEmptyString(workstreamHint)) {
    return invalid('bad-request', 'session status workstreamHint malformed');
  }
  const nativeSessionId = value['nativeSessionId'];
  if (nativeSessionId !== undefined && !isNonEmptyString(nativeSessionId)) {
    return invalid('bad-request', 'session status nativeSessionId malformed');
  }
  const pid = value['pid'];
  if (pid !== undefined && (!isNonNegativeSafeInteger(pid) || pid === 0)) {
    return invalid('bad-request', 'session status pid must be a positive integer');
  }
  return valid({
    sessionId,
    accountLabel,
    backend,
    substrate,
    state,
    cwd,
    purpose,
    ...(workstreamHint !== undefined ? { workstreamHint } : {}),
    ...(nativeSessionId !== undefined ? { nativeSessionId } : {}),
    ...(pid !== undefined ? { pid } : {}),
  });
}

function validateControlResult(value: unknown): ValidationResult<ControlResult> {
  if (!isRecord(value)) return invalid('bad-request', 'control result must be an object');
  const verb = value['verb'];
  switch (verb) {
    case 'launch':
    case 'kill': {
      const sessionId = value['sessionId'];
      if (!isSessionIdSegment(sessionId)) return invalid('bad-request', `${verb} result sessionId malformed`);
      const state = value['state'];
      if (!isSessionState(state)) return invalid('bad-request', `${verb} result state unknown`);
      return valid({ verb, sessionId, state });
    }
    case 'resume': {
      const sessionId = value['sessionId'];
      if (!isSessionIdSegment(sessionId)) return invalid('bad-request', 'resume result sessionId malformed');
      const state = value['state'];
      if (!isSessionState(state)) return invalid('bad-request', 'resume result state unknown');
      const forkedFrom = value['forkedFrom'];
      if (forkedFrom !== undefined && !isSessionIdSegment(forkedFrom)) {
        return invalid('bad-request', 'resume result forkedFrom malformed');
      }
      return valid({
        verb: 'resume',
        sessionId,
        state,
        ...(forkedFrom !== undefined ? { forkedFrom } : {}),
      });
    }
    case 'status': {
      const sessions = value['sessions'];
      if (!Array.isArray(sessions)) return invalid('bad-request', 'status result sessions must be an array');
      const out: SessionStatus[] = [];
      for (const entry of sessions) {
        const parsed = validateSessionStatus(entry);
        if (!parsed.ok) return parsed;
        out.push(parsed.value);
      }
      return valid({ verb: 'status', sessions: out });
    }
    default:
      return invalid('bad-request', `unknown result verb ${JSON.stringify(verb)}`);
  }
}

/** Validate an inbound control-channel response payload (frontend side). */
export function validateControlResponse(value: unknown): ValidationResult<ControlResponse> {
  if (!isRecord(value)) return invalid('bad-request', 'control response must be an object');
  if (value['kind'] !== 'result') return invalid('bad-request', 'control response kind must be "result"');
  const id = value['id'];
  if (!isRequestId(id)) return invalid('bad-request', `response id must match ${REQUEST_ID_RE.source}`);
  const ok = value['ok'];
  if (ok === true) {
    const result = validateControlResult(value['result']);
    if (!result.ok) return result;
    return valid({ kind: 'result', id, ok: true, result: result.value });
  }
  if (ok === false) {
    const error = validateErrorDetail(value['error']);
    if (!error.ok) return error;
    return valid({ kind: 'result', id, ok: false, error: error.value });
  }
  return invalid('bad-request', 'control response ok must be a boolean');
}

// ---------------------------------------------------------------------------
// PTY flow-control messages (inbound to the broker)
// ---------------------------------------------------------------------------

/**
 * Validate an inbound JSON message on a `pty.<sid>` channel. When
 * `expectedSessionId` is given (from the channel name), the payload's
 * sessionId must agree — the gateway always passes it.
 */
export function validatePtyClientMessage(
  value: unknown,
  expectedSessionId?: string,
): ValidationResult<PtyClientMessage> {
  if (!isRecord(value)) return invalid('bad-request', 'pty message must be an object');
  const kind = value['kind'];
  const sessionId = value['sessionId'];
  if (!isSessionIdSegment(sessionId)) {
    return invalid('bad-request', `pty message sessionId ${JSON.stringify(sessionId)} is malformed`);
  }
  if (expectedSessionId !== undefined && sessionId !== expectedSessionId) {
    return invalid(
      'bad-request',
      `pty message sessionId ${sessionId} does not match channel session ${expectedSessionId}`,
    );
  }
  switch (kind) {
    case 'pty-ack': {
      const watermark = value['watermark'];
      if (!isNonNegativeSafeInteger(watermark)) {
        return invalid('bad-request', 'pty-ack watermark must be a non-negative safe integer');
      }
      const message: PtyAck = { kind: 'pty-ack', sessionId, watermark };
      return valid(message);
    }
    case 'pty-replay-request': {
      const fromWatermark = value['fromWatermark'];
      if (!isNonNegativeSafeInteger(fromWatermark)) {
        return invalid('bad-request', 'pty-replay-request fromWatermark must be a non-negative safe integer');
      }
      const message: PtyReplayRequest = { kind: 'pty-replay-request', sessionId, fromWatermark };
      return valid(message);
    }
    case 'pty-resize': {
      const cols = value['cols'];
      const rows = value['rows'];
      if (!isNonNegativeSafeInteger(cols) || cols < 1 || cols > PTY_MAX_COLS) {
        return invalid('bad-request', `pty-resize cols must be 1..${PTY_MAX_COLS}`);
      }
      if (!isNonNegativeSafeInteger(rows) || rows < 1 || rows > PTY_MAX_ROWS) {
        return invalid('bad-request', `pty-resize rows must be 1..${PTY_MAX_ROWS}`);
      }
      const message: PtyResize = { kind: 'pty-resize', sessionId, cols, rows };
      return valid(message);
    }
    default:
      return invalid('bad-request', `unknown pty message kind ${JSON.stringify(kind)}`);
  }
}

// ---------------------------------------------------------------------------
// Pushed error payloads (inbound to the frontend client)
// ---------------------------------------------------------------------------

export function validateErrorPayload(value: unknown): ValidationResult<ErrorPayload> {
  if (!isRecord(value)) return invalid('bad-request', 'error payload must be an object');
  if (value['kind'] !== 'error') return invalid('bad-request', 'error payload kind must be "error"');
  const detail = validateErrorDetail(value);
  if (!detail.ok) return detail;
  const correlatesTo = value['correlatesTo'];
  if (correlatesTo !== undefined && !isRequestId(correlatesTo)) {
    return invalid('bad-request', 'error payload correlatesTo malformed');
  }
  const channel = value['channel'];
  if (channel !== undefined && !isChannelName(channel)) {
    return invalid('bad-request', 'error payload channel malformed');
  }
  return valid({
    kind: 'error',
    ...detail.value,
    ...(correlatesTo !== undefined ? { correlatesTo } : {}),
    ...(channel !== undefined ? { channel } : {}),
  });
}

// ---------------------------------------------------------------------------
// Transcript payloads (inbound to the frontend client) — FROZEN-M2
// ---------------------------------------------------------------------------

function validateTranscriptUsage(value: unknown): ValidationResult<TranscriptUsage> {
  if (!isRecord(value)) return invalid('bad-request', 'transcript usage must be an object');
  const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const;
  for (const field of fields) {
    if (!isNonNegativeSafeInteger(value[field])) {
      return invalid('bad-request', `transcript usage ${field} must be a non-negative safe integer`);
    }
  }
  return valid({
    inputTokens: value['inputTokens'] as number,
    outputTokens: value['outputTokens'] as number,
    cacheReadTokens: value['cacheReadTokens'] as number,
    cacheCreationTokens: value['cacheCreationTokens'] as number,
  });
}

/**
 * Validate an inbound payload on a `transcript.<sid>` channel (client side).
 * When `expectedSessionId` is given (from the channel name), the payload's
 * sessionId must agree — the client always passes it.
 */
export function validateTranscriptPayload(
  value: unknown,
  expectedSessionId?: string,
): ValidationResult<TranscriptPayload> {
  if (!isRecord(value)) return invalid('bad-request', 'transcript payload must be an object');
  const kind = value['kind'];
  const sessionId = value['sessionId'];
  if (!isSessionIdSegment(sessionId)) {
    return invalid('bad-request', `transcript payload sessionId ${JSON.stringify(sessionId)} is malformed`);
  }
  if (expectedSessionId !== undefined && sessionId !== expectedSessionId) {
    return invalid(
      'bad-request',
      `transcript payload sessionId ${sessionId} does not match channel session ${expectedSessionId}`,
    );
  }
  switch (kind) {
    case 'transcript-delta': {
      const messageUuid = value['messageUuid'];
      if (!isNonEmptyString(messageUuid)) {
        return invalid('bad-request', 'transcript-delta messageUuid must be a non-empty string');
      }
      const text = value['text'];
      if (!isNonEmptyString(text)) {
        return invalid('bad-request', 'transcript-delta text must be a non-empty string (empty deltas are never sent)');
      }
      const payload: TranscriptDelta = { kind: 'transcript-delta', sessionId, messageUuid, text };
      return valid(payload);
    }
    case 'transcript-tool': {
      const toolUseId = value['toolUseId'];
      if (!isNonEmptyString(toolUseId)) {
        return invalid('bad-request', 'transcript-tool toolUseId must be a non-empty string');
      }
      const toolName = value['toolName'];
      if (!isNonEmptyString(toolName)) {
        return invalid('bad-request', 'transcript-tool toolName must be a non-empty string');
      }
      const phase = value['phase'];
      if (phase !== 'start' && phase !== 'result') {
        return invalid('bad-request', `transcript-tool phase must be start|result, got ${JSON.stringify(phase)}`);
      }
      const ok = value['ok'];
      if (phase === 'start' && ok !== undefined) {
        return invalid('bad-request', 'transcript-tool ok must be absent on phase start (a start has no outcome)');
      }
      if (phase === 'result' && typeof ok !== 'boolean') {
        return invalid('bad-request', 'transcript-tool ok is required (boolean) on phase result');
      }
      const payload: TranscriptToolEvent = {
        kind: 'transcript-tool',
        sessionId,
        toolUseId,
        toolName,
        phase,
        ...(phase === 'result' ? { ok: ok as boolean } : {}),
      };
      return valid(payload);
    }
    case 'transcript-result': {
      const ok = value['ok'];
      if (typeof ok !== 'boolean') {
        return invalid('bad-request', 'transcript-result ok must be a boolean');
      }
      const detail = value['detail'];
      if (!isNonEmptyString(detail)) {
        return invalid('bad-request', 'transcript-result detail must be a non-empty string');
      }
      const usage = validateTranscriptUsage(value['usage']);
      if (!usage.ok) return usage;
      const costUsd = value['costUsd'];
      if (costUsd !== undefined && (!isFiniteNumber(costUsd) || costUsd < 0)) {
        return invalid('bad-request', 'transcript-result costUsd, when present, must be a non-negative finite number');
      }
      const durationMs = value['durationMs'];
      if (durationMs !== undefined && !isNonNegativeSafeInteger(durationMs)) {
        return invalid('bad-request', 'transcript-result durationMs, when present, must be a non-negative safe integer');
      }
      const payload: TranscriptResult = {
        kind: 'transcript-result',
        sessionId,
        ok,
        detail,
        usage: usage.value,
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      };
      return valid(payload);
    }
    default:
      return invalid('bad-request', `unknown transcript payload kind ${JSON.stringify(kind)}`);
  }
}

// ---------------------------------------------------------------------------
// Approvals payloads — FROZEN-M2
// ---------------------------------------------------------------------------

/** Validate an inbound `approvals` payload on the BROKER side (decisions). */
export function validateApprovalsClientMessage(
  value: unknown,
): ValidationResult<ApprovalsClientPayload> {
  if (!isRecord(value)) return invalid('bad-request', 'approvals message must be an object');
  const kind = value['kind'];
  if (kind !== 'approval-decision') {
    return invalid('bad-request', `unknown approvals client kind ${JSON.stringify(kind)} (clients send approval-decision)`);
  }
  const approvalId = value['approvalId'];
  if (!isApprovalId(approvalId)) {
    return invalid('bad-request', `approval-decision approvalId must match ${APPROVAL_ID_RE.source}`);
  }
  const verdict = value['verdict'];
  if (!(APPROVAL_VERDICTS as readonly string[]).includes(verdict as string)) {
    return invalid('bad-request', `approval-decision verdict must be allow|deny, got ${JSON.stringify(verdict)}`);
  }
  const updatedInput = value['updatedInput'];
  if (updatedInput !== undefined) {
    if (verdict !== 'allow') {
      return invalid('bad-request', 'approval-decision updatedInput is only legal with verdict allow');
    }
    if (!isRecord(updatedInput)) {
      return invalid('bad-request', 'approval-decision updatedInput, when present, must be an object');
    }
  }
  const note = value['note'];
  if (note !== undefined && !isNonEmptyString(note)) {
    return invalid('bad-request', 'approval-decision note, when present, must be a non-empty string');
  }
  const decision: ApprovalDecision = {
    kind: 'approval-decision',
    approvalId,
    verdict: verdict as ApprovalDecision['verdict'],
    ...(updatedInput !== undefined ? { updatedInput: updatedInput as Record<string, unknown> } : {}),
    ...(note !== undefined ? { note } : {}),
  };
  return valid(decision);
}

/**
 * Validate an inbound `approvals` payload on the CLIENT side (requests +
 * resolutions pushed by the broker).
 */
export function validateApprovalsServerMessage(
  value: unknown,
): ValidationResult<ApprovalsServerPayload> {
  if (!isRecord(value)) return invalid('bad-request', 'approvals message must be an object');
  const kind = value['kind'];
  switch (kind) {
    case 'approval-request': {
      const approvalId = value['approvalId'];
      if (!isApprovalId(approvalId)) {
        return invalid('bad-request', `approval-request approvalId must match ${APPROVAL_ID_RE.source}`);
      }
      const source = value['source'];
      if (!(APPROVAL_SOURCES as readonly string[]).includes(source as string)) {
        return invalid('bad-request', `unknown approval source ${JSON.stringify(source)}`);
      }
      const summary = value['summary'];
      if (!isNonEmptyString(summary)) {
        return invalid('bad-request', 'approval-request summary must be a non-empty string');
      }
      const accountLabel = value['accountLabel'];
      if (!isAccountLabel(accountLabel)) {
        return invalid('bad-request', `approval-request accountLabel unknown ${JSON.stringify(accountLabel)}`);
      }
      const sessionId = value['sessionId'];
      if (sessionId !== undefined && !isSessionIdSegment(sessionId)) {
        return invalid('bad-request', 'approval-request sessionId malformed');
      }
      const toolName = value['toolName'];
      if (toolName !== undefined && !isNonEmptyString(toolName)) {
        return invalid('bad-request', 'approval-request toolName, when present, must be a non-empty string');
      }
      const toolUseId = value['toolUseId'];
      if (toolUseId !== undefined && !isNonEmptyString(toolUseId)) {
        return invalid('bad-request', 'approval-request toolUseId, when present, must be a non-empty string');
      }
      const runId = value['runId'];
      if (runId !== undefined && !isNonEmptyString(runId)) {
        return invalid('bad-request', 'approval-request runId, when present, must be a non-empty string');
      }
      const stepId = value['stepId'];
      if (stepId !== undefined && !isNonEmptyString(stepId)) {
        return invalid('bad-request', 'approval-request stepId, when present, must be a non-empty string');
      }
      const expiresAt = value['expiresAt'];
      if (expiresAt !== undefined && !isEpochMs(expiresAt)) {
        return invalid('bad-request', 'approval-request expiresAt, when present, must be epoch ms (non-negative safe integer)');
      }
      // Per-source field matrix (ws-protocol.md §10.1).
      if (source === 'can-use-tool' || source === 'hook-floor') {
        if (sessionId === undefined) {
          return invalid('bad-request', `approval-request source ${source} requires sessionId`);
        }
        if (toolName === undefined) {
          return invalid('bad-request', `approval-request source ${source} requires toolName`);
        }
        if (runId !== undefined || stepId !== undefined) {
          return invalid('bad-request', `approval-request source ${source} must not carry runId/stepId`);
        }
      } else {
        // workflow-gate
        if (runId === undefined || stepId === undefined) {
          return invalid('bad-request', 'approval-request source workflow-gate requires runId and stepId');
        }
        if (toolName !== undefined || toolUseId !== undefined) {
          return invalid('bad-request', 'approval-request source workflow-gate must not carry toolName/toolUseId');
        }
      }
      const request: ApprovalRequest = {
        kind: 'approval-request',
        approvalId,
        source: source as ApprovalRequest['source'],
        summary,
        accountLabel,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(toolName !== undefined ? { toolName } : {}),
        ...(toolUseId !== undefined ? { toolUseId } : {}),
        ...(runId !== undefined ? { runId } : {}),
        ...(stepId !== undefined ? { stepId } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      };
      return valid(request);
    }
    case 'approval-resolved': {
      const approvalId = value['approvalId'];
      if (!isApprovalId(approvalId)) {
        return invalid('bad-request', `approval-resolved approvalId must match ${APPROVAL_ID_RE.source}`);
      }
      const outcome = value['outcome'];
      if (!(APPROVAL_OUTCOMES as readonly string[]).includes(outcome as string)) {
        return invalid('bad-request', `unknown approval outcome ${JSON.stringify(outcome)}`);
      }
      const resolved: ApprovalResolved = {
        kind: 'approval-resolved',
        approvalId,
        outcome: outcome as ApprovalResolved['outcome'],
      };
      return valid(resolved);
    }
    default:
      return invalid('bad-request', `unknown approvals server kind ${JSON.stringify(kind)}`);
  }
}

// ---------------------------------------------------------------------------
// Quota snapshots (inbound to the frontend client) — FROZEN-M2
// ---------------------------------------------------------------------------

export function validateQuotaSnapshot(value: unknown): ValidationResult<QuotaSnapshot> {
  if (!isRecord(value)) return invalid('bad-request', 'quota payload must be an object');
  if (value['kind'] !== 'quota-snapshot') {
    return invalid('bad-request', `unknown quota payload kind ${JSON.stringify(value['kind'])}`);
  }
  const account = value['account'];
  if (!isAccountLabel(account)) {
    return invalid('bad-request', `quota-snapshot account unknown ${JSON.stringify(account)}`);
  }
  const window = value['window'];
  if (!(QUOTA_WINDOWS as readonly string[]).includes(window as string)) {
    return invalid('bad-request', `quota-snapshot window must be 5h|7d|7d_sonnet, got ${JSON.stringify(window)}`);
  }
  const usedPct = value['usedPct'];
  if (!isFiniteNumber(usedPct) || usedPct < 0 || usedPct > 100) {
    return invalid('bad-request', 'quota-snapshot usedPct must be a finite number in 0..100');
  }
  const resetsAt = value['resetsAt'];
  if (!isEpochMs(resetsAt)) {
    return invalid('bad-request', 'quota-snapshot resetsAt must be epoch ms (non-negative safe integer)');
  }
  const capturedAt = value['capturedAt'];
  if (!isEpochMs(capturedAt)) {
    return invalid('bad-request', 'quota-snapshot capturedAt must be epoch ms (non-negative safe integer)');
  }
  const source = value['source'];
  if (!(QUOTA_SOURCES as readonly string[]).includes(source as string)) {
    return invalid('bad-request', `quota-snapshot source must be statusline|oauth-poll, got ${JSON.stringify(source)}`);
  }
  return valid({
    kind: 'quota-snapshot',
    account,
    window: window as QuotaSnapshot['window'],
    usedPct,
    resetsAt,
    capturedAt,
    source: source as QuotaSnapshot['source'],
  });
}

// ---------------------------------------------------------------------------
// Context-graph touches (inbound to the frontend client) — FROZEN-M2
// ---------------------------------------------------------------------------

export function validateContextGraphTouch(value: unknown): ValidationResult<ContextGraphTouch> {
  if (!isRecord(value)) return invalid('bad-request', 'context-graph payload must be an object');
  if (value['kind'] !== 'context-touch') {
    return invalid('bad-request', `unknown context-graph payload kind ${JSON.stringify(value['kind'])}`);
  }
  // [X2] design pin: the feed is identity-free by construction — a payload
  // that even CARRIES an account key is rejected, not silently sanitized.
  if ('account' in value || 'accountLabel' in value) {
    return invalid('bad-request', 'context-touch must not carry account keys (identity-free feed by design [X2])');
  }
  const sessionId = value['sessionId'];
  if (!isSessionIdSegment(sessionId)) {
    return invalid('bad-request', `context-touch sessionId ${JSON.stringify(sessionId)} is malformed`);
  }
  const path = value['path'];
  if (!isNonEmptyString(path) || !path.startsWith('/')) {
    return invalid('bad-request', 'context-touch path must be an absolute file path');
  }
  const relation = value['relation'];
  if (!(CONTEXT_GRAPH_RELATIONS as readonly string[]).includes(relation as string)) {
    return invalid('bad-request', `context-touch relation must be read|write|instructions|watched, got ${JSON.stringify(relation)}`);
  }
  const ts = value['ts'];
  if (!isEpochMs(ts)) {
    return invalid('bad-request', 'context-touch ts must be epoch ms (non-negative safe integer)');
  }
  return valid({
    kind: 'context-touch',
    sessionId,
    path,
    relation: relation as ContextGraphTouch['relation'],
    ts,
  });
}

// ---------------------------------------------------------------------------
// JSON channel replay-request (inbound to the broker) — FROZEN-M2
// ---------------------------------------------------------------------------

/**
 * Validate a `replay-request` sent ON a replayable channel. When
 * `expectedChannel` is given (from the envelope), the payload's channel must
 * agree — the gateway always passes it.
 */
export function validateJsonReplayRequest(
  value: unknown,
  expectedChannel?: string,
): ValidationResult<JsonReplayRequest> {
  if (!isRecord(value)) return invalid('bad-request', 'replay-request must be an object');
  if (value['kind'] !== 'replay-request') {
    return invalid('bad-request', `unknown replay payload kind ${JSON.stringify(value['kind'])}`);
  }
  const channel = value['channel'];
  if (!isChannelName(channel)) {
    return invalid('bad-request', `replay-request channel ${JSON.stringify(channel)} is malformed`);
  }
  if (!isReplayableChannel(channel)) {
    return invalid('bad-request', `channel ${channel} is not replayable (control correlates by id; pty replays on the byte axis)`);
  }
  if (expectedChannel !== undefined && channel !== expectedChannel) {
    return invalid(
      'bad-request',
      `replay-request channel ${channel} does not match envelope channel ${expectedChannel}`,
    );
  }
  const fromSeq = value['fromSeq'];
  if (!isNonNegativeSafeInteger(fromSeq)) {
    return invalid('bad-request', 'replay-request fromSeq must be a non-negative safe integer');
  }
  return valid({ kind: 'replay-request', channel, fromSeq });
}

// ---------------------------------------------------------------------------
// Events payloads (inbound to the frontend client) — FROZEN-M3
// ---------------------------------------------------------------------------

function isPct(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 100;
}

function isNonNegativeFinite(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function validateSourceFreshnessList(value: unknown): ValidationResult<readonly SourceFreshness[]> {
  if (!Array.isArray(value) || value.length === 0) {
    return invalid('bad-request', 'read-model-snapshot sources must be a non-empty array');
  }
  const out: SourceFreshness[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry)) return invalid('bad-request', 'source freshness entry must be an object');
    const source = entry['source'];
    if (!isEventSource(source)) {
      return invalid('bad-request', `unknown freshness source ${JSON.stringify(source)}`);
    }
    const state = entry['state'];
    if (!isSourceFreshnessState(state)) {
      return invalid('bad-request', `unknown freshness state ${JSON.stringify(state)}`);
    }
    const lastIngestAt = entry['lastIngestAt'];
    if (lastIngestAt !== undefined && !isEpochMs(lastIngestAt)) {
      return invalid('bad-request', 'freshness lastIngestAt, when present, must be epoch ms');
    }
    out.push({ source, state, ...(lastIngestAt !== undefined ? { lastIngestAt } : {}) });
  }
  return valid(out);
}

function validateEventSummary(value: Record<string, unknown>): ValidationResult<EventSummary> {
  const eventId = value['eventId'];
  if (!isPositiveSafeInteger(eventId)) {
    return invalid('bad-request', 'event-summary eventId must be a positive safe integer');
  }
  const ts = value['ts'];
  if (!isEpochMs(ts)) return invalid('bad-request', 'event-summary ts must be epoch ms');
  const account = value['account'];
  if (!isAccountLabel(account)) {
    return invalid('bad-request', `event-summary account unknown ${JSON.stringify(account)}`);
  }
  const backend = value['backend'];
  if (!isBackend(backend)) {
    return invalid('bad-request', `event-summary backend unknown ${JSON.stringify(backend)}`);
  }
  if (LABEL_BACKENDS[account] !== backend) {
    return invalid(
      'bad-request',
      `event-summary label/backend pairing violation: ${account} requires ${LABEL_BACKENDS[account]}`,
    );
  }
  const source = value['source'];
  if (!isEventSource(source)) {
    return invalid('bad-request', `event-summary source unknown ${JSON.stringify(source)}`);
  }
  const eventType = value['eventType'];
  if (!isNonEmptyString(eventType)) {
    return invalid('bad-request', 'event-summary eventType must be a non-empty string');
  }
  const sessionId = value['sessionId'];
  if (sessionId !== undefined && !isSessionIdSegment(sessionId)) {
    return invalid('bad-request', 'event-summary sessionId malformed');
  }
  const model = value['model'];
  if (model !== undefined && !isNonEmptyString(model)) {
    return invalid('bad-request', 'event-summary model, when present, must be a non-empty string');
  }
  let usage: EventSummary['usage'];
  if (value['usage'] !== undefined) {
    const parsed = validateTranscriptUsage(value['usage']);
    if (!parsed.ok) return parsed;
    usage = parsed.value;
  }
  const costEstimatedUsd = value['costEstimatedUsd'];
  if (costEstimatedUsd !== undefined && !isNonNegativeFinite(costEstimatedUsd)) {
    return invalid('bad-request', 'event-summary costEstimatedUsd must be a non-negative finite number');
  }
  const costActualUsd = value['costActualUsd'];
  if (costActualUsd !== undefined && !isNonNegativeFinite(costActualUsd)) {
    return invalid('bad-request', 'event-summary costActualUsd must be a non-negative finite number');
  }
  const latencyMs = value['latencyMs'];
  if (latencyMs !== undefined && !isNonNegativeSafeInteger(latencyMs)) {
    return invalid('bad-request', 'event-summary latencyMs must be a non-negative safe integer');
  }
  const ttftMs = value['ttftMs'];
  if (ttftMs !== undefined && !isNonNegativeSafeInteger(ttftMs)) {
    return invalid('bad-request', 'event-summary ttftMs must be a non-negative safe integer');
  }
  const toolName = value['toolName'];
  if (toolName !== undefined && !isNonEmptyString(toolName)) {
    return invalid('bad-request', 'event-summary toolName, when present, must be a non-empty string');
  }
  const skillName = value['skillName'];
  if (skillName !== undefined && !isNonEmptyString(skillName)) {
    return invalid('bad-request', 'event-summary skillName, when present, must be a non-empty string');
  }
  const ok = value['ok'];
  if (ok !== undefined && typeof ok !== 'boolean') {
    return invalid('bad-request', 'event-summary ok, when present, must be a boolean');
  }
  const errorKind = value['errorKind'];
  if (errorKind !== undefined && !isEventErrorKind(errorKind)) {
    return invalid('bad-request', `event-summary errorKind unknown ${JSON.stringify(errorKind)}`);
  }
  return valid({
    kind: 'event-summary',
    eventId,
    ts,
    account,
    backend,
    source,
    eventType,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(costEstimatedUsd !== undefined ? { costEstimatedUsd } : {}),
    ...(costActualUsd !== undefined ? { costActualUsd } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(ttftMs !== undefined ? { ttftMs } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
    ...(skillName !== undefined ? { skillName } : {}),
    ...(ok !== undefined ? { ok } : {}),
    ...(errorKind !== undefined ? { errorKind } : {}),
  });
}

type SnapshotData<M extends ReadModelSnapshot['readModel']> = Extract<
  ReadModelSnapshot,
  { readModel: M }
>['data'];

function validateQuotaGauges(value: unknown): ValidationResult<SnapshotData<'quota-gauges'>> {
  if (!isRecord(value) || !Array.isArray(value['gauges'])) {
    return invalid('bad-request', 'quota-gauges data must carry a gauges array');
  }
  const gauges: QuotaGauge[] = [];
  for (const entry of value['gauges'] as unknown[]) {
    if (!isRecord(entry)) return invalid('bad-request', 'quota gauge must be an object');
    const account = entry['account'];
    if (!isAccountLabel(account)) return invalid('bad-request', 'quota gauge account unknown');
    const window = entry['window'];
    if (!(QUOTA_WINDOWS as readonly string[]).includes(window as string)) {
      return invalid('bad-request', 'quota gauge window must be 5h|7d|7d_sonnet');
    }
    const usedPct = entry['usedPct'];
    if (!isPct(usedPct)) return invalid('bad-request', 'quota gauge usedPct must be in 0..100');
    const resetsAt = entry['resetsAt'];
    if (!isEpochMs(resetsAt)) return invalid('bad-request', 'quota gauge resetsAt must be epoch ms');
    gauges.push({ account, window: window as QuotaWindow, usedPct, resetsAt });
  }
  return valid({ gauges });
}

function validateBurnRate(value: unknown): ValidationResult<SnapshotData<'burn-rate'>> {
  if (!isRecord(value) || !Array.isArray(value['entries'])) {
    return invalid('bad-request', 'burn-rate data must carry an entries array');
  }
  const entries: BurnRateEntry[] = [];
  for (const entry of value['entries'] as unknown[]) {
    if (!isRecord(entry)) return invalid('bad-request', 'burn-rate entry must be an object');
    const account = entry['account'];
    if (!isAccountLabel(account)) return invalid('bad-request', 'burn-rate account unknown');
    const blockStartAt = entry['blockStartAt'];
    const blockEndAt = entry['blockEndAt'];
    if (!isEpochMs(blockStartAt) || !isEpochMs(blockEndAt) || blockEndAt < blockStartAt) {
      return invalid('bad-request', 'burn-rate block bounds must be epoch ms with end >= start');
    }
    const tokensPerHour = entry['tokensPerHour'];
    if (!isNonNegativeFinite(tokensPerHour)) {
      return invalid('bad-request', 'burn-rate tokensPerHour must be a non-negative finite number');
    }
    const usedPct = entry['usedPct'];
    if (usedPct !== undefined && !isPct(usedPct)) {
      return invalid('bad-request', 'burn-rate usedPct, when present, must be in 0..100');
    }
    const projectedExhaustionAt = entry['projectedExhaustionAt'];
    if (projectedExhaustionAt !== undefined && !isEpochMs(projectedExhaustionAt)) {
      return invalid('bad-request', 'burn-rate projectedExhaustionAt must be epoch ms');
    }
    entries.push({
      account,
      blockStartAt,
      blockEndAt,
      tokensPerHour,
      ...(usedPct !== undefined ? { usedPct } : {}),
      ...(projectedExhaustionAt !== undefined ? { projectedExhaustionAt } : {}),
    });
  }
  return valid({ entries });
}

function validateBedrockCost(value: unknown): ValidationResult<SnapshotData<'bedrock-cost'>> {
  if (!isRecord(value)) return invalid('bad-request', 'bedrock-cost data must be an object');
  const estimateMtdUsd = value['estimateMtdUsd'];
  if (!isNonNegativeFinite(estimateMtdUsd)) {
    return invalid('bad-request', 'bedrock-cost estimateMtdUsd must be a non-negative finite number');
  }
  const actualMtdUsd = value['actualMtdUsd'];
  if (actualMtdUsd !== undefined && !isNonNegativeFinite(actualMtdUsd)) {
    return invalid('bad-request', 'bedrock-cost actualMtdUsd must be a non-negative finite number');
  }
  const actualYesterdayUsd = value['actualYesterdayUsd'];
  if (actualYesterdayUsd !== undefined && !isNonNegativeFinite(actualYesterdayUsd)) {
    return invalid('bad-request', 'bedrock-cost actualYesterdayUsd must be a non-negative finite number');
  }
  const actualLagHours = value['actualLagHours'];
  if (actualLagHours !== undefined && !isNonNegativeFinite(actualLagHours)) {
    return invalid('bad-request', 'bedrock-cost actualLagHours must be a non-negative finite number');
  }
  return valid({
    estimateMtdUsd,
    ...(actualMtdUsd !== undefined ? { actualMtdUsd } : {}),
    ...(actualYesterdayUsd !== undefined ? { actualYesterdayUsd } : {}),
    ...(actualLagHours !== undefined ? { actualLagHours } : {}),
  });
}

function validateApiEquivalentUsd(
  value: unknown,
): ValidationResult<SnapshotData<'api-equivalent-usd'>> {
  if (!isRecord(value) || !Array.isArray(value['entries'])) {
    return invalid('bad-request', 'api-equivalent-usd data must carry an entries array');
  }
  if (value['basis'] !== 'api-equivalent') {
    return invalid('bad-request', "api-equivalent-usd basis must be the literal 'api-equivalent' (honest labeling, §6.3)");
  }
  const windowDays = value['windowDays'];
  if (!isPositiveSafeInteger(windowDays)) {
    return invalid('bad-request', 'api-equivalent-usd windowDays must be a positive safe integer');
  }
  const entries: ApiEquivalentUsdEntry[] = [];
  for (const entry of value['entries'] as unknown[]) {
    if (!isRecord(entry)) return invalid('bad-request', 'api-equivalent-usd entry must be an object');
    const account = entry['account'];
    if (!isAccountLabel(account)) return invalid('bad-request', 'api-equivalent-usd account unknown');
    const backend = entry['backend'];
    if (!isBackend(backend) || LABEL_BACKENDS[account] !== backend) {
      return invalid('bad-request', 'api-equivalent-usd entry violates the label/backend pairing');
    }
    const equivalentUsd = entry['equivalentUsd'];
    if (!isNonNegativeFinite(equivalentUsd)) {
      return invalid('bad-request', 'api-equivalent-usd equivalentUsd must be a non-negative finite number');
    }
    entries.push({ account, backend, equivalentUsd });
  }
  return valid({ basis: 'api-equivalent', entries, windowDays });
}

function validateCacheHitRate(value: unknown): ValidationResult<SnapshotData<'cache-hit-rate'>> {
  if (!isRecord(value) || !Array.isArray(value['entries'])) {
    return invalid('bad-request', 'cache-hit-rate data must carry an entries array');
  }
  const entries: CacheHitRateEntry[] = [];
  for (const entry of value['entries'] as unknown[]) {
    if (!isRecord(entry)) return invalid('bad-request', 'cache-hit-rate entry must be an object');
    const account = entry['account'];
    if (!isAccountLabel(account)) return invalid('bad-request', 'cache-hit-rate account unknown');
    const hitRatePct = entry['hitRatePct'];
    if (!isPct(hitRatePct)) return invalid('bad-request', 'cache-hit-rate hitRatePct must be in 0..100');
    for (const field of ['readTokens', 'creation5mTokens', 'creation1hTokens'] as const) {
      if (!isNonNegativeSafeInteger(entry[field])) {
        return invalid('bad-request', `cache-hit-rate ${field} must be a non-negative safe integer`);
      }
    }
    entries.push({
      account,
      hitRatePct,
      readTokens: entry['readTokens'] as number,
      creation5mTokens: entry['creation5mTokens'] as number,
      creation1hTokens: entry['creation1hTokens'] as number,
    });
  }
  return valid({ entries });
}

function validateLatency(value: unknown): ValidationResult<SnapshotData<'latency'>> {
  if (!isRecord(value) || !Array.isArray(value['entries'])) {
    return invalid('bad-request', 'latency data must carry an entries array');
  }
  const entries: LatencyEntry[] = [];
  for (const entry of value['entries'] as unknown[]) {
    if (!isRecord(entry)) return invalid('bad-request', 'latency entry must be an object');
    const backend = entry['backend'];
    if (!isBackend(backend)) return invalid('bad-request', 'latency backend unknown');
    const p50Ms = entry['p50Ms'];
    const p95Ms = entry['p95Ms'];
    if (!isNonNegativeFinite(p50Ms) || !isNonNegativeFinite(p95Ms) || p95Ms < p50Ms) {
      return invalid('bad-request', 'latency percentiles must be non-negative with p95 >= p50');
    }
    const ttftP50Ms = entry['ttftP50Ms'];
    if (ttftP50Ms !== undefined && !isNonNegativeFinite(ttftP50Ms)) {
      return invalid('bad-request', 'latency ttftP50Ms must be a non-negative finite number');
    }
    const ttftP95Ms = entry['ttftP95Ms'];
    if (ttftP95Ms !== undefined && !isNonNegativeFinite(ttftP95Ms)) {
      return invalid('bad-request', 'latency ttftP95Ms must be a non-negative finite number');
    }
    const sampleCount = entry['sampleCount'];
    if (!isNonNegativeSafeInteger(sampleCount)) {
      return invalid('bad-request', 'latency sampleCount must be a non-negative safe integer');
    }
    entries.push({
      backend,
      p50Ms,
      p95Ms,
      ...(ttftP50Ms !== undefined ? { ttftP50Ms } : {}),
      ...(ttftP95Ms !== undefined ? { ttftP95Ms } : {}),
      sampleCount,
    });
  }
  return valid({ entries });
}

function validateHealth(value: unknown): ValidationResult<SnapshotData<'health'>> {
  if (!isRecord(value) || !Array.isArray(value['entries'])) {
    return invalid('bad-request', 'health data must carry an entries array');
  }
  const entries: HealthEntry[] = [];
  for (const entry of value['entries'] as unknown[]) {
    if (!isRecord(entry)) return invalid('bad-request', 'health entry must be an object');
    const source = entry['source'];
    if (!isEventSource(source)) return invalid('bad-request', 'health source unknown');
    for (const field of ['errorCount', 'retryCount', 'throttleCount', 'timeoutCount'] as const) {
      if (!isNonNegativeSafeInteger(entry[field])) {
        return invalid('bad-request', `health ${field} must be a non-negative safe integer`);
      }
    }
    const windowMinutes = entry['windowMinutes'];
    if (!isPositiveSafeInteger(windowMinutes)) {
      return invalid('bad-request', 'health windowMinutes must be a positive safe integer');
    }
    entries.push({
      source,
      errorCount: entry['errorCount'] as number,
      retryCount: entry['retryCount'] as number,
      throttleCount: entry['throttleCount'] as number,
      timeoutCount: entry['timeoutCount'] as number,
      windowMinutes,
    });
  }
  return valid({ entries });
}

function validateSkillLeaderboard(
  value: unknown,
): ValidationResult<SnapshotData<'skill-leaderboard'>> {
  if (!isRecord(value) || !Array.isArray(value['entries'])) {
    return invalid('bad-request', 'skill-leaderboard data must carry an entries array');
  }
  const entries: SkillLeaderboardEntry[] = [];
  for (const entry of value['entries'] as unknown[]) {
    if (!isRecord(entry)) return invalid('bad-request', 'skill-leaderboard entry must be an object');
    const skillName = entry['skillName'];
    if (!isNonEmptyString(skillName)) {
      return invalid('bad-request', 'skill-leaderboard skillName must be a non-empty string');
    }
    const invocations = entry['invocations'];
    if (!isNonNegativeSafeInteger(invocations)) {
      return invalid('bad-request', 'skill-leaderboard invocations must be a non-negative safe integer');
    }
    const successRatePct = entry['successRatePct'];
    if (successRatePct !== undefined && !isPct(successRatePct)) {
      return invalid('bad-request', 'skill-leaderboard successRatePct must be in 0..100');
    }
    const correctionRatePct = entry['correctionRatePct'];
    if (correctionRatePct !== undefined && !isPct(correctionRatePct)) {
      return invalid('bad-request', 'skill-leaderboard correctionRatePct must be in 0..100');
    }
    const tokensPerOutcome = entry['tokensPerOutcome'];
    if (tokensPerOutcome !== undefined && !isNonNegativeFinite(tokensPerOutcome)) {
      return invalid('bad-request', 'skill-leaderboard tokensPerOutcome must be a non-negative finite number');
    }
    const worstQuartile = entry['worstQuartile'];
    if (typeof worstQuartile !== 'boolean') {
      return invalid('bad-request', 'skill-leaderboard worstQuartile must be a boolean');
    }
    entries.push({
      skillName,
      invocations,
      ...(successRatePct !== undefined ? { successRatePct } : {}),
      ...(correctionRatePct !== undefined ? { correctionRatePct } : {}),
      ...(tokensPerOutcome !== undefined ? { tokensPerOutcome } : {}),
      worstQuartile,
    });
  }
  return valid({ entries });
}

function validateSessionOutcomes(
  value: unknown,
): ValidationResult<SnapshotData<'session-outcomes'>> {
  if (!isRecord(value) || !Array.isArray(value['entries'])) {
    return invalid('bad-request', 'session-outcomes data must carry an entries array');
  }
  const windowDays = value['windowDays'];
  if (!isPositiveSafeInteger(windowDays)) {
    return invalid('bad-request', 'session-outcomes windowDays must be a positive safe integer');
  }
  const entries: SessionOutcomeEntry[] = [];
  for (const entry of value['entries'] as unknown[]) {
    if (!isRecord(entry)) return invalid('bad-request', 'session-outcomes entry must be an object');
    const outcome = entry['outcome'];
    if (!isNonEmptyString(outcome)) {
      return invalid('bad-request', 'session-outcomes outcome must be a non-empty string');
    }
    const count = entry['count'];
    if (!isNonNegativeSafeInteger(count)) {
      return invalid('bad-request', 'session-outcomes count must be a non-negative safe integer');
    }
    entries.push({ outcome, count });
  }
  return valid({ entries, windowDays });
}

function validateLocalOffload(value: unknown): ValidationResult<SnapshotData<'local-offload'>> {
  if (!isRecord(value)) return invalid('bad-request', 'local-offload data must be an object');
  const offloadRatioPct = value['offloadRatioPct'];
  if (!isPct(offloadRatioPct)) {
    return invalid('bad-request', 'local-offload offloadRatioPct must be in 0..100');
  }
  const localTokens = value['localTokens'];
  const totalTokens = value['totalTokens'];
  if (!isNonNegativeSafeInteger(localTokens) || !isNonNegativeSafeInteger(totalTokens)) {
    return invalid('bad-request', 'local-offload token counts must be non-negative safe integers');
  }
  if (localTokens > totalTokens) {
    return invalid('bad-request', 'local-offload localTokens must not exceed totalTokens');
  }
  const windowDays = value['windowDays'];
  if (!isPositiveSafeInteger(windowDays)) {
    return invalid('bad-request', 'local-offload windowDays must be a positive safe integer');
  }
  return valid({ offloadRatioPct, localTokens, totalTokens, windowDays });
}

function validateSessionFootprints(
  value: unknown,
): ValidationResult<readonly SessionFootprint[]> {
  if (!Array.isArray(value)) {
    return invalid('bad-request', 'resource-health sessions must be an array');
  }
  const out: SessionFootprint[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry)) return invalid('bad-request', 'resource-health session must be an object');
    const account = entry['account'];
    if (!isAccountLabel(account)) {
      return invalid('bad-request', `resource-health session account unknown ${JSON.stringify(account)}`);
    }
    const backend = entry['backend'];
    if (!isBackend(backend)) {
      return invalid('bad-request', `resource-health session backend unknown ${JSON.stringify(backend)}`);
    }
    if (LABEL_BACKENDS[account] !== backend) {
      return invalid(
        'bad-request',
        `resource-health session label/backend pairing violation: ${account} requires ${LABEL_BACKENDS[account]}`,
      );
    }
    const slot = entry['slot'];
    if (!isNonNegativeSafeInteger(slot)) {
      return invalid('bad-request', 'resource-health session slot must be a non-negative safe integer');
    }
    const footprintMb = entry['footprintMb'];
    if (!isNonNegativeFinite(footprintMb)) {
      return invalid('bad-request', 'resource-health session footprintMb must be a non-negative finite number');
    }
    const band = entry['band'];
    if (!isWatchdogBand(band)) {
      return invalid('bad-request', `resource-health session band unknown ${JSON.stringify(band)}`);
    }
    const hibernated = entry['hibernated'];
    if (hibernated !== undefined && typeof hibernated !== 'boolean') {
      return invalid('bad-request', 'resource-health session hibernated, when present, must be a boolean');
    }
    out.push({
      account,
      backend,
      slot,
      footprintMb,
      band,
      ...(hibernated !== undefined ? { hibernated } : {}),
    });
  }
  return valid(out);
}

function validateShedNotices(value: unknown): ValidationResult<readonly ShedNotice[]> {
  if (!Array.isArray(value)) {
    return invalid('bad-request', 'resource-health notices must be an array');
  }
  const out: ShedNotice[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry)) return invalid('bad-request', 'resource-health notice must be an object');
    const action = entry['action'];
    if (!isShedAction(action)) {
      return invalid('bad-request', `resource-health notice action unknown ${JSON.stringify(action)}`);
    }
    const at = entry['at'];
    if (!isEpochMs(at)) return invalid('bad-request', 'resource-health notice at must be epoch ms');
    const account = entry['account'];
    if (account !== undefined && !isAccountLabel(account)) {
      return invalid('bad-request', `resource-health notice account unknown ${JSON.stringify(account)}`);
    }
    const backend = entry['backend'];
    if (backend !== undefined && !isBackend(backend)) {
      return invalid('bad-request', `resource-health notice backend unknown ${JSON.stringify(backend)}`);
    }
    if (account !== undefined && backend !== undefined && LABEL_BACKENDS[account] !== backend) {
      return invalid(
        'bad-request',
        `resource-health notice label/backend pairing violation: ${account} requires ${LABEL_BACKENDS[account]}`,
      );
    }
    out.push({
      action,
      at,
      ...(account !== undefined ? { account } : {}),
      ...(backend !== undefined ? { backend } : {}),
    });
  }
  return valid(out);
}

function validateResourceHealth(value: unknown): ValidationResult<SnapshotData<'resource-health'>> {
  if (!isRecord(value)) return invalid('bad-request', 'resource-health data must be an object');
  const pressureLevel = value['pressureLevel'];
  if (!isNonNegativeSafeInteger(pressureLevel) || pressureLevel > 4) {
    return invalid('bad-request', 'resource-health pressureLevel must be an integer in 0..4');
  }
  const pressureState = value['pressureState'];
  if (!isPressureState(pressureState)) {
    return invalid('bad-request', `resource-health pressureState unknown ${JSON.stringify(pressureState)}`);
  }
  const freeRamPct = value['freeRamPct'];
  if (!isPct(freeRamPct)) {
    return invalid('bad-request', 'resource-health freeRamPct must be in 0..100');
  }
  const swapUsedBytes = value['swapUsedBytes'];
  if (!isNonNegativeSafeInteger(swapUsedBytes)) {
    return invalid('bad-request', 'resource-health swapUsedBytes must be a non-negative safe integer');
  }
  const residentSessionCount = value['residentSessionCount'];
  if (!isNonNegativeSafeInteger(residentSessionCount)) {
    return invalid('bad-request', 'resource-health residentSessionCount must be a non-negative safe integer');
  }
  const localModelResidentBytes = value['localModelResidentBytes'];
  if (localModelResidentBytes !== undefined && !isNonNegativeSafeInteger(localModelResidentBytes)) {
    return invalid('bad-request', 'resource-health localModelResidentBytes must be a non-negative safe integer');
  }
  const sessions = validateSessionFootprints(value['sessions']);
  if (!sessions.ok) return sessions;
  const notices = validateShedNotices(value['notices']);
  if (!notices.ok) return notices;
  return valid({
    pressureLevel,
    pressureState,
    freeRamPct,
    swapUsedBytes,
    residentSessionCount,
    ...(localModelResidentBytes !== undefined ? { localModelResidentBytes } : {}),
    sessions: sessions.value,
    notices: notices.value,
  });
}

function validateReadModelSnapshot(
  value: Record<string, unknown>,
): ValidationResult<ReadModelSnapshot> {
  const readModel = value['readModel'];
  if (!isReadModelId(readModel)) {
    return invalid('bad-request', `unknown read model ${JSON.stringify(readModel)}`);
  }
  const capturedAt = value['capturedAt'];
  if (!isEpochMs(capturedAt)) {
    return invalid('bad-request', 'read-model-snapshot capturedAt must be epoch ms');
  }
  const sources = validateSourceFreshnessList(value['sources']);
  if (!sources.ok) return sources;

  const data = value['data'];
  const base = {
    kind: 'read-model-snapshot',
    capturedAt,
    sources: sources.value,
  } as const;
  switch (readModel) {
    case 'quota-gauges': {
      const parsed = validateQuotaGauges(data);
      return parsed.ok ? valid({ ...base, readModel, data: parsed.value }) : parsed;
    }
    case 'burn-rate': {
      const parsed = validateBurnRate(data);
      return parsed.ok ? valid({ ...base, readModel, data: parsed.value }) : parsed;
    }
    case 'bedrock-cost': {
      const parsed = validateBedrockCost(data);
      return parsed.ok ? valid({ ...base, readModel, data: parsed.value }) : parsed;
    }
    case 'api-equivalent-usd': {
      const parsed = validateApiEquivalentUsd(data);
      return parsed.ok ? valid({ ...base, readModel, data: parsed.value }) : parsed;
    }
    case 'cache-hit-rate': {
      const parsed = validateCacheHitRate(data);
      return parsed.ok ? valid({ ...base, readModel, data: parsed.value }) : parsed;
    }
    case 'latency': {
      const parsed = validateLatency(data);
      return parsed.ok ? valid({ ...base, readModel, data: parsed.value }) : parsed;
    }
    case 'health': {
      const parsed = validateHealth(data);
      return parsed.ok ? valid({ ...base, readModel, data: parsed.value }) : parsed;
    }
    case 'skill-leaderboard': {
      const parsed = validateSkillLeaderboard(data);
      return parsed.ok ? valid({ ...base, readModel, data: parsed.value }) : parsed;
    }
    case 'session-outcomes': {
      const parsed = validateSessionOutcomes(data);
      return parsed.ok ? valid({ ...base, readModel, data: parsed.value }) : parsed;
    }
    case 'local-offload': {
      const parsed = validateLocalOffload(data);
      return parsed.ok ? valid({ ...base, readModel, data: parsed.value }) : parsed;
    }
    case 'resource-health': {
      const parsed = validateResourceHealth(data);
      return parsed.ok ? valid({ ...base, readModel, data: parsed.value }) : parsed;
    }
  }
}

/**
 * Validate an inbound payload on the `events` channel (client side).
 *
 * The FROZEN forward-tolerant reader rule (M3): a payload whose `kind` is a
 * non-empty string OUTSIDE the frozen set decodes as an
 * {@link OpaqueEventsPayload} and MUST be ignored — M4/M5 add kinds without
 * breaking M3 clients. Registered kinds (`event-summary`,
 * `read-model-snapshot`) validate strictly; a payload with no string kind is
 * malformed.
 */
export function validateEventsPayload(
  value: unknown,
): ValidationResult<EventSummary | ReadModelSnapshot | OpaqueEventsPayload> {
  if (!isRecord(value)) return invalid('bad-request', 'events payload must be an object');
  const kind = value['kind'];
  if (!isNonEmptyString(kind)) {
    return invalid('bad-request', 'events payload kind must be a non-empty string');
  }
  if (kind === 'event-summary') return validateEventSummary(value);
  if (kind === 'read-model-snapshot') return validateReadModelSnapshot(value);
  // Forward-tolerant: unknown kinds are legal-and-ignored (sanitized to kind).
  return valid({ kind, opaque: true });
}

// ---------------------------------------------------------------------------
// Workstream payloads (the X4 lineage channel) — FROZEN-M4
// ---------------------------------------------------------------------------

function validateWorkstreamSummary(value: unknown): ValidationResult<WorkstreamSummary> {
  if (!isRecord(value)) return invalid('bad-request', 'workstream summary must be an object');
  const workstreamId = value['workstreamId'];
  if (!isLineageIdSegment(workstreamId)) {
    return invalid('bad-request', 'workstream summary workstreamId malformed');
  }
  const title = value['title'];
  if (!isNonEmptyString(title)) {
    return invalid('bad-request', 'workstream summary title must be a non-empty string');
  }
  const status = value['status'];
  if (!isWorkstreamStatus(status)) {
    return invalid('bad-request', `unknown workstream status ${JSON.stringify(status)}`);
  }
  const tags = value['tags'];
  let parsedTags: readonly string[] | undefined;
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.some((tag) => !isNonEmptyString(tag))) {
      return invalid('bad-request', 'workstream summary tags, when present, must be non-empty strings');
    }
    parsedTags = tags as string[];
  }
  const nodeCount = value['nodeCount'];
  if (!isNonNegativeSafeInteger(nodeCount)) {
    return invalid('bad-request', 'workstream summary nodeCount must be a non-negative safe integer');
  }
  const updatedAt = value['updatedAt'];
  if (!isEpochMs(updatedAt)) {
    return invalid('bad-request', 'workstream summary updatedAt must be epoch ms');
  }
  return valid({
    workstreamId,
    title,
    status,
    ...(parsedTags !== undefined ? { tags: parsedTags } : {}),
    nodeCount,
    updatedAt,
  });
}

function validateWorkstreamNodeRecord(value: unknown): ValidationResult<WorkstreamNodeRecord> {
  if (!isRecord(value)) return invalid('bad-request', 'workstream node must be an object');
  // [X2]: nodes carry HARNESS ids only — a native-id key is rejected outright
  // (the context-touch account-key precedent, §12).
  if ('nativeSessionId' in value || 'native_session_id' in value) {
    return invalid('bad-request', 'workstream node must not carry native session ids (store attribute only [X2])');
  }
  const sessionId = value['sessionId'];
  if (!isSessionIdSegment(sessionId)) {
    return invalid('bad-request', 'workstream node sessionId malformed');
  }
  const workstreamId = value['workstreamId'];
  if (workstreamId !== undefined && !isLineageIdSegment(workstreamId)) {
    return invalid('bad-request', 'workstream node workstreamId malformed');
  }
  const account = value['account'];
  if (!isAccountLabel(account)) {
    return invalid('bad-request', `workstream node account unknown ${JSON.stringify(account)}`);
  }
  const backend = value['backend'];
  if (!isBackend(backend) || LABEL_BACKENDS[account] !== backend) {
    return invalid('bad-request', 'workstream node violates the label/backend pairing');
  }
  const state = value['state'];
  if (!isSessionNodeState(state)) {
    return invalid('bad-request', `unknown workstream node state ${JSON.stringify(state)}`);
  }
  const origin = value['origin'];
  if (!isSessionNodeOrigin(origin)) {
    return invalid('bad-request', `unknown workstream node origin ${JSON.stringify(origin)}`);
  }
  const confidence = value['confidence'];
  if (!isLineageConfidence(confidence)) {
    return invalid('bad-request', `unknown workstream node confidence ${JSON.stringify(confidence)}`);
  }
  const displayName = value['displayName'];
  if (displayName !== undefined && !isNonEmptyString(displayName)) {
    return invalid('bad-request', 'workstream node displayName, when present, must be a non-empty string');
  }
  const cwd = value['cwd'];
  if (cwd !== undefined && (!isNonEmptyString(cwd) || !cwd.startsWith('/'))) {
    return invalid('bad-request', 'workstream node cwd, when present, must be an absolute path');
  }
  const gitBranch = value['gitBranch'];
  if (gitBranch !== undefined && !isNonEmptyString(gitBranch)) {
    return invalid('bad-request', 'workstream node gitBranch, when present, must be a non-empty string');
  }
  const tokensIn = value['tokensIn'];
  if (tokensIn !== undefined && !isNonNegativeSafeInteger(tokensIn)) {
    return invalid('bad-request', 'workstream node tokensIn must be a non-negative safe integer');
  }
  const tokensOut = value['tokensOut'];
  if (tokensOut !== undefined && !isNonNegativeSafeInteger(tokensOut)) {
    return invalid('bad-request', 'workstream node tokensOut must be a non-negative safe integer');
  }
  const costEstimatedUsd = value['costEstimatedUsd'];
  if (costEstimatedUsd !== undefined && !isNonNegativeFinite(costEstimatedUsd)) {
    return invalid('bad-request', 'workstream node costEstimatedUsd must be a non-negative finite number');
  }
  const createdAt = value['createdAt'];
  if (!isEpochMs(createdAt)) {
    return invalid('bad-request', 'workstream node createdAt must be epoch ms');
  }
  const lastActiveAt = value['lastActiveAt'];
  if (lastActiveAt !== undefined && !isEpochMs(lastActiveAt)) {
    return invalid('bad-request', 'workstream node lastActiveAt must be epoch ms');
  }
  return valid({
    sessionId,
    ...(workstreamId !== undefined ? { workstreamId } : {}),
    backend,
    account,
    state,
    origin,
    confidence,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(gitBranch !== undefined ? { gitBranch } : {}),
    ...(tokensIn !== undefined ? { tokensIn } : {}),
    ...(tokensOut !== undefined ? { tokensOut } : {}),
    ...(costEstimatedUsd !== undefined ? { costEstimatedUsd } : {}),
    createdAt,
    ...(lastActiveAt !== undefined ? { lastActiveAt } : {}),
  });
}

function validateWorkstreamEdgeRecord(value: unknown): ValidationResult<WorkstreamEdgeRecord> {
  if (!isRecord(value)) return invalid('bad-request', 'workstream edge must be an object');
  const edgeId = value['edgeId'];
  if (!isLineageIdSegment(edgeId)) {
    return invalid('bad-request', 'workstream edge edgeId malformed');
  }
  const edgeType = value['edgeType'];
  if (!isSessionEdgeType(edgeType)) {
    return invalid('bad-request', `unknown workstream edge type ${JSON.stringify(edgeType)}`);
  }
  const fromSessionId = value['fromSessionId'];
  if (fromSessionId !== undefined && !isSessionIdSegment(fromSessionId)) {
    return invalid('bad-request', 'workstream edge fromSessionId malformed');
  }
  // The frozen from/import matrix: REQUIRED for every type except `import`,
  // FORBIDDEN for `import` (imports have no in-graph parent).
  if (edgeType === 'import' && fromSessionId !== undefined) {
    return invalid('bad-request', 'workstream edge type import must not carry fromSessionId');
  }
  if (edgeType !== 'import' && fromSessionId === undefined) {
    return invalid('bad-request', `workstream edge type ${edgeType} requires fromSessionId`);
  }
  const toSessionId = value['toSessionId'];
  if (!isSessionIdSegment(toSessionId)) {
    return invalid('bad-request', 'workstream edge toSessionId malformed');
  }
  const briefId = value['briefId'];
  if (briefId !== undefined && !isLineageIdSegment(briefId)) {
    return invalid('bad-request', 'workstream edge briefId malformed');
  }
  // Handoff briefs are MANDATORY (blueprint §5: context travels by brief).
  if (edgeType === 'handoff' && briefId === undefined) {
    return invalid('bad-request', 'workstream edge type handoff requires briefId');
  }
  const confidence = value['confidence'];
  if (!isLineageConfidence(confidence)) {
    return invalid('bad-request', `unknown workstream edge confidence ${JSON.stringify(confidence)}`);
  }
  const ts = value['ts'];
  if (!isEpochMs(ts)) return invalid('bad-request', 'workstream edge ts must be epoch ms');
  return valid({
    edgeId,
    ...(fromSessionId !== undefined ? { fromSessionId } : {}),
    toSessionId,
    edgeType,
    ...(briefId !== undefined ? { briefId } : {}),
    confidence,
    ts,
  });
}

function validateWorkstreamListSnapshot(
  value: Record<string, unknown>,
): ValidationResult<WorkstreamListSnapshot> {
  const capturedAt = value['capturedAt'];
  if (!isEpochMs(capturedAt)) {
    return invalid('bad-request', 'workstream-list-snapshot capturedAt must be epoch ms');
  }
  const workstreams = value['workstreams'];
  if (!Array.isArray(workstreams)) {
    return invalid('bad-request', 'workstream-list-snapshot workstreams must be an array');
  }
  const out: WorkstreamSummary[] = [];
  for (const entry of workstreams as unknown[]) {
    const parsed = validateWorkstreamSummary(entry);
    if (!parsed.ok) return parsed;
    out.push(parsed.value);
  }
  const detachedNodeCount = value['detachedNodeCount'];
  if (!isNonNegativeSafeInteger(detachedNodeCount)) {
    return invalid('bad-request', 'workstream-list-snapshot detachedNodeCount must be a non-negative safe integer');
  }
  return valid({
    kind: 'workstream-list-snapshot',
    capturedAt,
    workstreams: out,
    detachedNodeCount,
  });
}

function validateWorkstreamDetailSnapshot(
  value: Record<string, unknown>,
): ValidationResult<WorkstreamDetailSnapshot> {
  const capturedAt = value['capturedAt'];
  if (!isEpochMs(capturedAt)) {
    return invalid('bad-request', 'workstream-detail-snapshot capturedAt must be epoch ms');
  }
  const scope = value['scope'];
  if (scope !== 'workstream' && scope !== 'detached') {
    return invalid('bad-request', `workstream-detail-snapshot scope must be workstream|detached, got ${JSON.stringify(scope)}`);
  }
  // Scope matrix (the approvals §10.1 REQUIRED/FORBIDDEN precedent).
  let workstream: WorkstreamSummary | undefined;
  if (scope === 'workstream') {
    const parsed = validateWorkstreamSummary(value['workstream']);
    if (!parsed.ok) {
      return invalid('bad-request', 'workstream-detail-snapshot scope workstream requires a valid workstream summary');
    }
    workstream = parsed.value;
  } else if (value['workstream'] !== undefined) {
    return invalid('bad-request', 'workstream-detail-snapshot scope detached must not carry a workstream summary');
  }
  const nodes = value['nodes'];
  if (!Array.isArray(nodes)) {
    return invalid('bad-request', 'workstream-detail-snapshot nodes must be an array');
  }
  const parsedNodes: WorkstreamNodeRecord[] = [];
  for (const entry of nodes as unknown[]) {
    const parsed = validateWorkstreamNodeRecord(entry);
    if (!parsed.ok) return parsed;
    parsedNodes.push(parsed.value);
  }
  const edges = value['edges'];
  if (!Array.isArray(edges)) {
    return invalid('bad-request', 'workstream-detail-snapshot edges must be an array');
  }
  const parsedEdges: WorkstreamEdgeRecord[] = [];
  for (const entry of edges as unknown[]) {
    const parsed = validateWorkstreamEdgeRecord(entry);
    if (!parsed.ok) return parsed;
    parsedEdges.push(parsed.value);
  }
  return valid({
    kind: 'workstream-detail-snapshot',
    capturedAt,
    scope,
    ...(workstream !== undefined ? { workstream } : {}),
    nodes: parsedNodes,
    edges: parsedEdges,
  });
}

function validateWorkstreamBrief(
  value: Record<string, unknown>,
): ValidationResult<WorkstreamBriefPayload> {
  const briefId = value['briefId'];
  if (!isLineageIdSegment(briefId)) {
    return invalid('bad-request', 'workstream-brief briefId malformed');
  }
  const briefKind = value['briefKind'];
  if (!isBriefKind(briefKind)) {
    return invalid('bad-request', `unknown brief kind ${JSON.stringify(briefKind)}`);
  }
  const body = value['body'];
  if (!isNonEmptyString(body)) {
    return invalid('bad-request', 'workstream-brief body must be a non-empty string');
  }
  const sourceSessionIds = value['sourceSessionIds'];
  if (
    !Array.isArray(sourceSessionIds) ||
    sourceSessionIds.length === 0 ||
    sourceSessionIds.some((id) => !isSessionIdSegment(id))
  ) {
    return invalid('bad-request', 'workstream-brief sourceSessionIds must be a non-empty array of session ids');
  }
  const provenance = value['provenance'];
  if (!isBriefProvenance(provenance)) {
    return invalid('bad-request', `unknown brief provenance ${JSON.stringify(provenance)}`);
  }
  const createdAt = value['createdAt'];
  if (!isEpochMs(createdAt)) {
    return invalid('bad-request', 'workstream-brief createdAt must be epoch ms');
  }
  const workstreamId = value['workstreamId'];
  if (workstreamId !== undefined && !isLineageIdSegment(workstreamId)) {
    return invalid('bad-request', 'workstream-brief workstreamId malformed');
  }
  return valid({
    kind: 'workstream-brief',
    briefId,
    briefKind,
    body,
    sourceSessionIds: sourceSessionIds as string[],
    provenance,
    createdAt,
    ...(workstreamId !== undefined ? { workstreamId } : {}),
  });
}

function validateBranchAdvisory(value: Record<string, unknown>): ValidationResult<BranchAdvisory> {
  const sessionId = value['sessionId'];
  if (!isSessionIdSegment(sessionId)) {
    return invalid('bad-request', 'branch-advisory sessionId malformed');
  }
  const contextUsedPct = value['contextUsedPct'];
  if (!isPct(contextUsedPct)) {
    return invalid('bad-request', 'branch-advisory contextUsedPct must be a finite number in 0..100');
  }
  const ts = value['ts'];
  if (!isEpochMs(ts)) return invalid('bad-request', 'branch-advisory ts must be epoch ms');
  return valid({ kind: 'branch-advisory', sessionId, contextUsedPct, ts });
}

function validateWorkstreamMergeResolved(
  value: Record<string, unknown>,
): ValidationResult<WorkstreamMergeResolved> {
  const mergeId = value['mergeId'];
  if (typeof mergeId !== 'string' || !MERGE_ID_RE.test(mergeId)) {
    return invalid('bad-request', `workstream-merge-resolved mergeId must match ${MERGE_ID_RE.source}`);
  }
  const sessionId = value['sessionId'];
  if (!isSessionIdSegment(sessionId)) {
    return invalid('bad-request', 'workstream-merge-resolved sessionId malformed');
  }
  const briefId = value['briefId'];
  if (!isLineageIdSegment(briefId)) {
    return invalid('bad-request', 'workstream-merge-resolved briefId malformed');
  }
  return valid({ kind: 'workstream-merge-resolved', mergeId, sessionId, briefId });
}

/**
 * Validate an inbound payload on the `workstream` channel (client side).
 *
 * The FROZEN forward-tolerant reader rule (M4, the events §13.3 rule applied
 * verbatim): a payload whose `kind` is a non-empty string OUTSIDE the frozen
 * set decodes as an {@link OpaqueWorkstreamPayload} and MUST be ignored —
 * M5 adds lineage lenses without breaking M4 clients. Registered kinds
 * validate strictly; kindless payloads are malformed.
 */
export function validateWorkstreamServerPayload(
  value: unknown,
): ValidationResult<WorkstreamServerPayload | OpaqueWorkstreamPayload> {
  if (!isRecord(value)) return invalid('bad-request', 'workstream payload must be an object');
  const kind = value['kind'];
  if (!isNonEmptyString(kind)) {
    return invalid('bad-request', 'workstream payload kind must be a non-empty string');
  }
  switch (kind) {
    case 'workstream-list-snapshot':
      return validateWorkstreamListSnapshot(value);
    case 'workstream-detail-snapshot':
      return validateWorkstreamDetailSnapshot(value);
    case 'workstream-node': {
      const parsed = validateWorkstreamNodeRecord(value);
      return parsed.ok ? valid({ kind: 'workstream-node', ...parsed.value }) : parsed;
    }
    case 'workstream-edge': {
      const parsed = validateWorkstreamEdgeRecord(value);
      return parsed.ok ? valid({ kind: 'workstream-edge', ...parsed.value }) : parsed;
    }
    case 'workstream-brief':
      return validateWorkstreamBrief(value);
    case 'branch-advisory':
      return validateBranchAdvisory(value);
    case 'workstream-merge-resolved':
      return validateWorkstreamMergeResolved(value);
    default:
      // Forward-tolerant: unknown kinds are legal-and-ignored (sanitized to kind).
      return valid({ kind, opaque: true });
  }
}

function validateWorkstreamMergeParams(value: unknown): ValidationResult<WorkstreamMergeParams> {
  if (!isRecord(value)) return invalid('bad-request', 'merge params must be an object');
  const parents = value['parents'];
  if (!Array.isArray(parents)) {
    return invalid('bad-request', 'merge parents must be an array of harness session ids');
  }
  if (parents.length < MERGE_MIN_PARENTS || parents.length > MERGE_MAX_PARENTS) {
    return invalid(
      'bad-request',
      `merge requires ${MERGE_MIN_PARENTS}..${MERGE_MAX_PARENTS} parents, got ${parents.length}`,
    );
  }
  for (const parent of parents as unknown[]) {
    if (!isSessionIdSegment(parent)) {
      return invalid('bad-request', 'merge parent session id malformed');
    }
  }
  if (new Set(parents as string[]).size !== parents.length) {
    return invalid('bad-request', 'merge parents must be distinct (a node merges with another node, not itself)');
  }
  const accountLabel = value['accountLabel'];
  if (!isAccountLabel(accountLabel)) {
    return invalid('bad-request', `unknown account label ${JSON.stringify(accountLabel)}`);
  }
  const backend = value['backend'];
  if (!isBackend(backend) || LABEL_BACKENDS[accountLabel] !== backend) {
    return invalid('bad-request', 'merge params violate the label/backend pairing');
  }
  const cwd = value['cwd'];
  if (!isNonEmptyString(cwd) || !cwd.startsWith('/')) {
    return invalid('bad-request', 'merge cwd must be an absolute path (byte-stable string)');
  }
  const purpose = value['purpose'];
  if (!isNonEmptyString(purpose)) {
    return invalid('bad-request', 'merge purpose must be a non-empty string');
  }
  const briefBody = value['briefBody'];
  if (!isNonEmptyString(briefBody)) {
    return invalid('bad-request', 'merge briefBody must be a non-empty string (merge briefs are mandatory, blueprint §5)');
  }
  const workstreamId = value['workstreamId'];
  if (workstreamId !== undefined && !isLineageIdSegment(workstreamId)) {
    return invalid('bad-request', 'merge workstreamId malformed');
  }
  return valid({
    parents: parents as string[],
    accountLabel,
    backend,
    cwd,
    purpose,
    briefBody,
    ...(workstreamId !== undefined ? { workstreamId } : {}),
  });
}

/**
 * Validate an inbound `workstream` payload on the BROKER side. The only
 * registered client payload (besides the generic `replay-request`, which the
 * gateway routes FIRST) is the merge request; anything else answers
 * `bad-request` (the approvals-client precedent — clients send exactly one
 * verb-shaped payload on a fan-out channel).
 */
export function validateWorkstreamClientMessage(
  value: unknown,
): ValidationResult<WorkstreamClientPayload> {
  if (!isRecord(value)) return invalid('bad-request', 'workstream message must be an object');
  const kind = value['kind'];
  if (kind !== 'workstream-merge-request') {
    return invalid(
      'bad-request',
      `unknown workstream client kind ${JSON.stringify(kind)} (clients send workstream-merge-request)`,
    );
  }
  const mergeId = value['mergeId'];
  if (typeof mergeId !== 'string' || !MERGE_ID_RE.test(mergeId)) {
    return invalid('bad-request', `workstream-merge-request mergeId must match ${MERGE_ID_RE.source}`);
  }
  const params = validateWorkstreamMergeParams(value['params']);
  if (!params.ok) return params;
  return valid({ kind: 'workstream-merge-request', mergeId, params: params.value });
}

// ---------------------------------------------------------------------------
// Pipeline payloads (features 4/5 — the `pipelines` channel) — FROZEN-M5
// ---------------------------------------------------------------------------

function isPipelineId(value: unknown): value is string {
  return typeof value === 'string' && PIPELINE_ID_RE.test(value);
}

function isPipelineRequestId(value: unknown): value is string {
  return typeof value === 'string' && PIPELINE_REQUEST_ID_RE.test(value);
}

function isSha256Ref(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{8,64}$/.test(value);
}

function validateCatalogEntry(value: unknown): ValidationResult<CatalogEntry> {
  if (!isRecord(value)) return invalid('bad-request', 'catalog entry must be an object');
  const capId = value['capId'];
  if (!isSessionIdSegment(capId)) return invalid('bad-request', 'catalog entry capId malformed');
  const kind = value['kind'];
  if (!isCapabilityKind(kind)) return invalid('bad-request', `unknown capability kind ${JSON.stringify(kind)}`);
  const name = value['name'];
  if (!isNonEmptyString(name)) return invalid('bad-request', 'catalog entry name must be a non-empty string');
  const scope = value['scope'];
  if (!isCatalogScope(scope)) return invalid('bad-request', `unknown catalog scope ${JSON.stringify(scope)}`);
  const backendFamily = value['backendFamily'];
  if (!isCapabilityBackendFamily(backendFamily)) {
    return invalid('bad-request', `unknown catalog backendFamily ${JSON.stringify(backendFamily)}`);
  }
  const workspace = value['workspace'];
  if (workspace !== undefined && (!isNonEmptyString(workspace) || !workspace.startsWith('/'))) {
    return invalid('bad-request', 'catalog entry workspace, when present, must be an absolute path');
  }
  const sourcePath = value['sourcePath'];
  if (!isNonEmptyString(sourcePath) || !sourcePath.startsWith('/')) {
    return invalid('bad-request', 'catalog entry sourcePath must be an absolute path');
  }
  const contentHash = value['contentHash'];
  if (!isSha256Ref(contentHash)) {
    return invalid('bad-request', 'catalog entry contentHash must be sha256:<hex>');
  }
  const slash = value['slash'];
  if (slash !== undefined && (!isNonEmptyString(slash) || !slash.startsWith('/'))) {
    return invalid('bad-request', 'catalog entry slash, when present, must start with /');
  }
  const argumentHint = value['argumentHint'];
  if (argumentHint !== undefined && !isNonEmptyString(argumentHint)) {
    return invalid('bad-request', 'catalog entry argumentHint, when present, must be a non-empty string');
  }
  const disableModelInvocation = value['disableModelInvocation'];
  if (disableModelInvocation !== undefined && typeof disableModelInvocation !== 'boolean') {
    return invalid('bad-request', 'catalog entry disableModelInvocation must be a boolean');
  }
  const accounts = value['accounts'];
  let parsedAccounts: CatalogEntry['accounts'] | undefined;
  if (accounts !== undefined) {
    if (!Array.isArray(accounts) || accounts.length === 0 || !accounts.every(isAccountLabel)) {
      return invalid('bad-request', 'catalog entry accounts, when present, must be a non-empty array of account labels');
    }
    parsedAccounts = accounts as CatalogEntry['accounts'];
  }
  return valid({
    capId,
    kind,
    name,
    scope,
    backendFamily,
    ...(workspace !== undefined ? { workspace } : {}),
    sourcePath,
    contentHash,
    ...(slash !== undefined ? { slash } : {}),
    ...(argumentHint !== undefined ? { argumentHint } : {}),
    ...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}),
    ...(parsedAccounts !== undefined ? { accounts: parsedAccounts } : {}),
  });
}

function validateCatalogSnapshot(value: Record<string, unknown>): ValidationResult<CatalogSnapshot> {
  const capturedAt = value['capturedAt'];
  if (!isEpochMs(capturedAt)) return invalid('bad-request', 'catalog-snapshot capturedAt must be epoch ms');
  const workspace = value['workspace'];
  if (workspace !== undefined && (!isNonEmptyString(workspace) || !workspace.startsWith('/'))) {
    return invalid('bad-request', 'catalog-snapshot workspace, when present, must be an absolute path');
  }
  const entries = value['entries'];
  if (!Array.isArray(entries)) return invalid('bad-request', 'catalog-snapshot entries must be an array');
  const out: CatalogEntry[] = [];
  for (const entry of entries as unknown[]) {
    const parsed = validateCatalogEntry(entry);
    if (!parsed.ok) return parsed;
    out.push(parsed.value);
  }
  return valid({
    kind: 'catalog-snapshot',
    capturedAt,
    ...(workspace !== undefined ? { workspace } : {}),
    entries: out,
  });
}

function validatePipelineStepStatusRecord(
  value: Record<string, unknown>,
): ValidationResult<PipelineStepStatusRecord> {
  const runId = value['runId'];
  if (!isPipelineId(runId)) return invalid('bad-request', 'pipeline step runId malformed');
  const stepId = value['stepId'];
  if (!isNonEmptyString(stepId)) return invalid('bad-request', 'pipeline step stepId must be a non-empty string');
  const iteration = value['iteration'];
  if (!isNonNegativeSafeInteger(iteration)) return invalid('bad-request', 'pipeline step iteration must be a non-negative safe integer');
  const attempt = value['attempt'];
  if (!isNonNegativeSafeInteger(attempt)) return invalid('bad-request', 'pipeline step attempt must be a non-negative safe integer');
  const state = value['state'];
  if (!isPipelineStepState(state)) return invalid('bad-request', `unknown pipeline step state ${JSON.stringify(state)}`);
  const sessionId = value['sessionId'];
  if (sessionId !== undefined && !isSessionIdSegment(sessionId)) {
    return invalid('bad-request', 'pipeline step sessionId malformed');
  }
  const account = value['account'];
  if (account !== undefined && !isAccountLabel(account)) {
    return invalid('bad-request', `pipeline step account unknown ${JSON.stringify(account)}`);
  }
  const costEstimatedUsd = value['costEstimatedUsd'];
  if (costEstimatedUsd !== undefined && !isNonNegativeFinite(costEstimatedUsd)) {
    return invalid('bad-request', 'pipeline step costEstimatedUsd must be a non-negative finite number');
  }
  const tokensIn = value['tokensIn'];
  if (tokensIn !== undefined && !isNonNegativeSafeInteger(tokensIn)) {
    return invalid('bad-request', 'pipeline step tokensIn must be a non-negative safe integer');
  }
  const tokensOut = value['tokensOut'];
  if (tokensOut !== undefined && !isNonNegativeSafeInteger(tokensOut)) {
    return invalid('bad-request', 'pipeline step tokensOut must be a non-negative safe integer');
  }
  const startedAt = value['startedAt'];
  if (startedAt !== undefined && !isEpochMs(startedAt)) return invalid('bad-request', 'pipeline step startedAt must be epoch ms');
  const finishedAt = value['finishedAt'];
  if (finishedAt !== undefined && !isEpochMs(finishedAt)) return invalid('bad-request', 'pipeline step finishedAt must be epoch ms');
  const errorKind = value['errorKind'];
  if (errorKind !== undefined && !isNonEmptyString(errorKind)) {
    return invalid('bad-request', 'pipeline step errorKind, when present, must be a non-empty string');
  }
  return valid({
    runId,
    stepId,
    iteration,
    attempt,
    state,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(account !== undefined ? { account } : {}),
    ...(costEstimatedUsd !== undefined ? { costEstimatedUsd } : {}),
    ...(tokensIn !== undefined ? { tokensIn } : {}),
    ...(tokensOut !== undefined ? { tokensOut } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...(errorKind !== undefined ? { errorKind } : {}),
  });
}

function validatePipelineRunStatusRecord(
  value: Record<string, unknown>,
): ValidationResult<PipelineRunStatusRecord> {
  const runId = value['runId'];
  if (!isPipelineId(runId)) return invalid('bad-request', 'pipeline run runId malformed');
  const pipelineId = value['pipelineId'];
  if (!isPipelineId(pipelineId)) return invalid('bad-request', 'pipeline run pipelineId malformed');
  const state = value['state'];
  if (!isPipelineRunState(state)) return invalid('bad-request', `unknown pipeline run state ${JSON.stringify(state)}`);
  const schemaHash = value['schemaHash'];
  if (schemaHash !== undefined && !isSha256Ref(schemaHash)) {
    return invalid('bad-request', 'pipeline run schemaHash must be sha256:<hex>');
  }
  const costEstimatedUsd = value['costEstimatedUsd'];
  if (costEstimatedUsd !== undefined && !isNonNegativeFinite(costEstimatedUsd)) {
    return invalid('bad-request', 'pipeline run costEstimatedUsd must be a non-negative finite number');
  }
  const startedAt = value['startedAt'];
  if (startedAt !== undefined && !isEpochMs(startedAt)) return invalid('bad-request', 'pipeline run startedAt must be epoch ms');
  const finishedAt = value['finishedAt'];
  if (finishedAt !== undefined && !isEpochMs(finishedAt)) return invalid('bad-request', 'pipeline run finishedAt must be epoch ms');
  const resumable = value['resumable'];
  if (resumable !== undefined && typeof resumable !== 'boolean') {
    return invalid('bad-request', 'pipeline run resumable, when present, must be a boolean');
  }
  return valid({
    runId,
    pipelineId,
    state,
    ...(schemaHash !== undefined ? { schemaHash } : {}),
    ...(costEstimatedUsd !== undefined ? { costEstimatedUsd } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...(resumable !== undefined ? { resumable } : {}),
  });
}

function validatePipelineRunSnapshot(
  value: Record<string, unknown>,
): ValidationResult<PipelineRunSnapshot> {
  const capturedAt = value['capturedAt'];
  if (!isEpochMs(capturedAt)) return invalid('bad-request', 'pipeline-run-snapshot capturedAt must be epoch ms');
  const run = validatePipelineRunStatusRecord(isRecord(value['run']) ? value['run'] : {});
  if (!run.ok) return run;
  const steps = value['steps'];
  if (!Array.isArray(steps)) return invalid('bad-request', 'pipeline-run-snapshot steps must be an array');
  const out: PipelineStepStatusRecord[] = [];
  for (const step of steps as unknown[]) {
    if (!isRecord(step)) return invalid('bad-request', 'pipeline step must be an object');
    const parsed = validatePipelineStepStatusRecord(step);
    if (!parsed.ok) return parsed;
    out.push(parsed.value);
  }
  return valid({ kind: 'pipeline-run-snapshot', capturedAt, run: run.value, steps: out });
}

function validatePipelineValidationResult(
  value: Record<string, unknown>,
): ValidationResult<PipelineValidationResult> {
  const requestId = value['requestId'];
  if (!isPipelineRequestId(requestId)) return invalid('bad-request', 'pipeline-validation-result requestId malformed');
  const isValid = value['valid'];
  if (typeof isValid !== 'boolean') return invalid('bad-request', 'pipeline-validation-result valid must be a boolean');
  const issueCode = value['issueCode'];
  const issueMessage = value['issueMessage'];
  const issuePath = value['issuePath'];
  if (isValid) {
    if (issueCode !== undefined || issueMessage !== undefined || issuePath !== undefined) {
      return invalid('bad-request', 'pipeline-validation-result valid=true must not carry issue fields');
    }
    return valid({ kind: 'pipeline-validation-result', requestId, valid: true });
  }
  if (!isNonEmptyString(issueCode)) return invalid('bad-request', 'pipeline-validation-result valid=false requires issueCode');
  if (!isNonEmptyString(issueMessage)) return invalid('bad-request', 'pipeline-validation-result valid=false requires issueMessage');
  if (issuePath !== undefined && typeof issuePath !== 'string') {
    return invalid('bad-request', 'pipeline-validation-result issuePath, when present, must be a string');
  }
  return valid({
    kind: 'pipeline-validation-result',
    requestId,
    valid: false,
    issueCode,
    issueMessage,
    ...(issuePath !== undefined ? { issuePath } : {}),
  });
}

function validatePipelineSaved(value: Record<string, unknown>): ValidationResult<PipelineSaved> {
  const requestId = value['requestId'];
  if (!isPipelineRequestId(requestId)) return invalid('bad-request', 'pipeline-saved requestId malformed');
  const pipelineId = value['pipelineId'];
  if (!isPipelineId(pipelineId)) return invalid('bad-request', 'pipeline-saved pipelineId malformed');
  return valid({ kind: 'pipeline-saved', requestId, pipelineId });
}

/**
 * Validate an inbound payload on the `pipelines` channel (client side).
 *
 * The FROZEN forward-tolerant reader rule (M5, the events §13.3 rule applied
 * verbatim): a payload whose `kind` is a non-empty string OUTSIDE the frozen
 * set decodes as an {@link OpaquePipelinePayload} and MUST be ignored.
 * Registered kinds validate strictly; kindless payloads are malformed.
 */
export function validatePipelineServerPayload(
  value: unknown,
): ValidationResult<PipelineServerPayload | OpaquePipelinePayload> {
  if (!isRecord(value)) return invalid('bad-request', 'pipelines payload must be an object');
  const kind = value['kind'];
  if (!isNonEmptyString(kind)) return invalid('bad-request', 'pipelines payload kind must be a non-empty string');
  switch (kind) {
    case 'catalog-snapshot':
      return validateCatalogSnapshot(value);
    case 'pipeline-run-snapshot':
      return validatePipelineRunSnapshot(value);
    case 'pipeline-run-status': {
      const parsed = validatePipelineRunStatusRecord(value);
      return parsed.ok
        ? valid({ kind: 'pipeline-run-status', ...parsed.value } satisfies PipelineRunStatusEvent)
        : parsed;
    }
    case 'pipeline-step-status': {
      const parsed = validatePipelineStepStatusRecord(value);
      return parsed.ok
        ? valid({ kind: 'pipeline-step-status', ...parsed.value } satisfies PipelineStepStatusEvent)
        : parsed;
    }
    case 'pipeline-validation-result':
      return validatePipelineValidationResult(value);
    case 'pipeline-saved':
      return validatePipelineSaved(value);
    default:
      return valid({ kind, opaque: true });
  }
}

/**
 * Validate an inbound `pipelines` payload on the BROKER side — one of the six
 * pipeline verbs (besides the generic `replay-request`, which the gateway
 * routes FIRST). Anything else answers `bad-request` (the workstream-client
 * precedent). Note: a DAG document that fails static validation is NOT a
 * `bad-request` on the launch/save verbs — the verb is well-formed; the broker
 * answers `pipeline-invalid` at RUNTIME. So these validators check only that
 * `document` is an object here; the broker runs {@link validateDagDocument}.
 * BUT `pipeline-validate` DOES run the full DAG validation inline (its whole
 * job is validation) so a malformed document there is a legitimate answer.
 */
export function validatePipelineClientMessage(
  value: unknown,
): ValidationResult<PipelineClientPayload> {
  if (!isRecord(value)) return invalid('bad-request', 'pipelines message must be an object');
  const kind = value['kind'];
  const requestId = value['requestId'];
  if (!isPipelineRequestId(requestId)) {
    return invalid('bad-request', `pipelines verb requestId must match ${PIPELINE_REQUEST_ID_RE.source}`);
  }
  switch (kind) {
    case 'pipeline-validate':
    case 'pipeline-save': {
      const parsed = validateDagDocument(value['document']);
      if (!parsed.ok) {
        // A malformed document is a shape error on the verb: the client sent a
        // structurally-invalid DAG. (pipeline-validate's whole job is to
        // report this, but the wire verb must still carry a parseable doc.)
        return invalid('bad-request', `pipelines ${kind} document invalid: ${parsed.issue.message}`);
      }
      return valid({ kind, requestId, document: parsed.document });
    }
    case 'pipeline-launch': {
      const pipelineId = value['pipelineId'];
      const document = value['document'];
      const hasPipeline = pipelineId !== undefined;
      const hasDocument = document !== undefined;
      if (hasPipeline === hasDocument) {
        return invalid('bad-request', 'pipeline-launch requires exactly one of pipelineId | document');
      }
      let parsedDoc;
      if (hasDocument) {
        const parsed = validateDagDocument(document);
        if (!parsed.ok) return invalid('bad-request', `pipeline-launch document invalid: ${parsed.issue.message}`);
        parsedDoc = parsed.document;
      }
      if (hasPipeline && !isPipelineId(pipelineId)) {
        return invalid('bad-request', 'pipeline-launch pipelineId malformed');
      }
      const inputs = value['inputs'];
      if (inputs !== undefined && !isRecord(inputs)) {
        return invalid('bad-request', 'pipeline-launch inputs, when present, must be an object');
      }
      const workstreamId = value['workstreamId'];
      if (workstreamId !== undefined && !isLineageIdSegment(workstreamId)) {
        return invalid('bad-request', 'pipeline-launch workstreamId malformed');
      }
      return valid({
        kind: 'pipeline-launch',
        requestId,
        ...(hasPipeline ? { pipelineId: pipelineId as string } : {}),
        ...(parsedDoc !== undefined ? { document: parsedDoc } : {}),
        ...(inputs !== undefined ? { inputs: inputs as Record<string, unknown> } : {}),
        ...(workstreamId !== undefined ? { workstreamId } : {}),
      });
    }
    case 'pipeline-pause':
    case 'pipeline-resume':
    case 'pipeline-cancel': {
      const runId = value['runId'];
      if (!isPipelineId(runId)) return invalid('bad-request', `${kind} runId malformed`);
      return valid({ kind, requestId, runId });
    }
    default:
      return invalid('bad-request', `unknown pipelines client kind ${JSON.stringify(kind)}`);
  }
}
