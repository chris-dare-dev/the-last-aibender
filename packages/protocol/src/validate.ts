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
 * FROZEN-M1-CORE (2026-07-04) → FROZEN-M2 (2026-07-04). Amendments only via
 * ICR (docs/contracts/icr/); BE-ORCH lands, FE-ORCH co-signs. Prose of
 * record: docs/contracts/ws-protocol.md.
 * M2 additions: transcript / approvals / quota / context-graph payload
 * validators + the JSON replay-request validator.
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
import type { PtyAck, PtyClientMessage, PtyReplayRequest, PtyResize } from './pty.js';
import { PTY_MAX_COLS, PTY_MAX_ROWS } from './pty.js';
import type { QuotaSnapshot } from './quota.js';
import { QUOTA_SOURCES, QUOTA_WINDOWS } from './quota.js';
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
