/**
 * Error envelope + error-code registry.
 *
 * Two error surfaces exist, both using {@link ErrorDetail}:
 *  1. A failed control request answers as `ControlResponse { ok:false, error }`
 *     correlated by request id (see control.ts).
 *  2. Connection-level failures with no request to answer (bad envelope, bad
 *     auth, unknown channel, oversized frame) are pushed as an
 *     {@link ErrorPayload} on the `control` channel.
 *
 * ============================================================================
 * FROZEN-M1-CORE (2026-07-04). Amendments only via ICR (docs/contracts/icr/);
 * BE-ORCH lands, FE-ORCH co-signs. Prose of record: docs/contracts/ws-protocol.md.
 * ============================================================================
 */

import type { ChannelName } from './channels.js';

/**
 * Closed error-code registry. Adding a code is an ICR after freeze.
 * Codes cover the plan §9.2 BE-3 negative matrix (bad auth token rejected;
 * unknown channel rejected; oversized frame rejected) plus the blueprint §5
 * guardrail (un-forked double-resume of a running session is blocked).
 */
export const ERROR_CODES = Object.freeze([
  /** Envelope failed structural validation (shape, seq, stream/channel mismatch). */
  'bad-envelope',
  /** Missing/incorrect per-boot auth token. Connection will be closed. */
  'bad-auth',
  /** Channel name unregistered or malformed. */
  'unknown-channel',
  /** Control payload kind is not a registered verb. */
  'unknown-verb',
  /** Verb is registered but reserved (unfrozen) — e.g. `approve` until M2. */
  'verb-reserved',
  /** Payload failed field-level validation. */
  'bad-request',
  /** No resume-ledger row for the referenced harness session id. */
  'session-not-found',
  /** Session exists but cannot be resumed (state/validator refusal). */
  'session-not-resumable',
  /** Un-forked double-resume of a running session (blueprint §5 guardrail). */
  'double-resume-blocked',
  /** Binary PTY frame exceeds PTY_FRAME_MAX_PAYLOAD_BYTES or is malformed. */
  'oversized-frame',
  /** Ack/replay watermark outside the retained range (see flow control). */
  'watermark-out-of-range',
  /** Broker-side failure not attributable to the request. */
  'internal',
] as const);

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/** The error body shared by control responses and pushed error payloads. */
export interface ErrorDetail {
  readonly code: ErrorCode;
  /** Human-readable, identifier-free (redaction filters apply upstream) [X2]. */
  readonly message: string;
  /** True when the same request may legitimately be retried. */
  readonly retryable: boolean;
}

/** Connection-level pushed error (payload on the `control` channel). */
export interface ErrorPayload extends ErrorDetail {
  readonly kind: 'error';
  /** Request id this error correlates to, when one could be parsed. */
  readonly correlatesTo?: string;
  /** Channel the offending message targeted, when known. */
  readonly channel?: ChannelName;
}
