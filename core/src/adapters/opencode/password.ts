/**
 * Per-boot `OPENCODE_SERVER_PASSWORD` (BE-4; blueprint §4.2).
 *
 * One password is generated per serve boot, held in memory (closures only —
 * never a serializable field), injected into the child env, and offered to
 * the @aibender/shared line scrubber as a known secret value [X2]. It never
 * appears in logs or on disk. Same entropy/shape discipline as the gateway
 * boot token (core/src/gateway/token.ts).
 */

import { randomBytes } from 'node:crypto';

/** 256 bits of entropy per serve boot. */
export const SERVE_PASSWORD_BYTES = 32;

/** base64url alphabet only — env-safe, URL-safe, JSON-safe. */
const PASSWORD_SHAPE_RE = /^[A-Za-z0-9_-]{43}$/;

/** Generate a per-boot server password: 32 random bytes, base64url (43 chars). */
export function newServePassword(): string {
  return randomBytes(SERVE_PASSWORD_BYTES).toString('base64url');
}

/** Shape check (NOT authentication). */
export function isServePasswordShaped(value: unknown): value is string {
  return typeof value === 'string' && PASSWORD_SHAPE_RE.test(value);
}

/** The fixed HTTP Basic username `opencode serve` expects. */
export const OPENCODE_BASIC_USERNAME = 'opencode';

/**
 * HTTP Basic Authorization header value for a serve password. The password
 * enters only through the argument — callers hold it in a closure.
 */
export function serveBasicAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`${OPENCODE_BASIC_USERNAME}:${password}`, 'utf8').toString('base64')}`;
}
