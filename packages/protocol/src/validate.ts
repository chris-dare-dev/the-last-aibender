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
 *     messages, 1 error payload, 1 envelope, 1 binary codec). Hand-rolled
 *     checks under `strict` + `exactOptionalPropertyTypes` are shorter than
 *     the equivalent zod schemas and produce exactly the ErrorCode taxonomy
 *     the gateway answers with (zod errors would need mapping anyway).
 *  3. Golden-fixture protocol tests (plan §9.3 BE↔FE #1) pin behavior; a
 *     validation-library swap later is an internal change, not an ICR.
 *
 * All validators are total over `unknown`, never throw on wire data, and
 * return sanitized values containing ONLY contract keys (unknown keys are
 * dropped, never echoed — [X2]-friendly).
 *
 * ============================================================================
 * FROZEN-M1-CORE (2026-07-04). Amendments only via ICR (docs/contracts/icr/);
 * BE-ORCH lands, FE-ORCH co-signs. Prose of record: docs/contracts/ws-protocol.md.
 * ============================================================================
 */

import { isSessionIdSegment } from './channels.js';
import { isChannelName } from './channels.js';
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
import type { ValidationResult } from './result.js';
import { invalid, valid } from './result.js';
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
