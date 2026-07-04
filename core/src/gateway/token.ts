/**
 * Per-boot gateway auth token (BE-3 M1 slice).
 *
 * One token is generated per broker boot, held in memory, and written ONLY to
 * the 0600 bootstrap file (see ./bootstrap.ts). It never appears in logs —
 * the gateway wires it into a @aibender/shared line scrubber as a known
 * secret value [X2].
 *
 * The M2 auth-handshake MESSAGE is still DRAFT (ws-protocol.md §8); the
 * frozen requirement implemented here is only that an unauthenticated
 * connection answers `bad-auth` and is closed.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

/** 256 bits of entropy per boot. */
export const GATEWAY_TOKEN_BYTES = 32;

/** base64url alphabet only — safe inside a URL query and a JSON file. */
const TOKEN_SHAPE_RE = /^[A-Za-z0-9_-]{43}$/;

/** Generate the per-boot token: 32 random bytes, base64url (43 chars, no padding). */
export function newBootToken(): string {
  return randomBytes(GATEWAY_TOKEN_BYTES).toString('base64url');
}

/** Shape check (NOT authentication — see {@link tokensMatch}). */
export function isTokenShaped(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_SHAPE_RE.test(value);
}

/**
 * Constant-time token comparison. Length mismatch still performs a dummy
 * comparison so the reject path's timing does not reveal the token length
 * class. Non-string presented values are always false.
 */
export function tokensMatch(expected: string, presented: unknown): boolean {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) {
    // Dummy self-comparison keeps the code path's work roughly constant.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}
