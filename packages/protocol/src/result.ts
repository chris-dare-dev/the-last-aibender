/**
 * Validation result type shared by every inbound-message validator.
 *
 * Wire data NEVER throws: validators return a discriminated result whose
 * failure branch carries an {@link ErrorCode} the gateway/client can answer
 * with verbatim. Exceptions are reserved for programmer errors (e.g. encoding
 * a malformed frame on the producing side).
 *
 * ============================================================================
 * FROZEN-M1-CORE (2026-07-04). Amendments only via ICR (docs/contracts/icr/);
 * BE-ORCH lands, FE-ORCH co-signs. Prose of record: docs/contracts/ws-protocol.md.
 * ============================================================================
 */

import type { ErrorCode } from './errors.js';

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

export function valid<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

export function invalid<T = never>(code: ErrorCode, message: string): ValidationResult<T> {
  return { ok: false, code, message };
}
