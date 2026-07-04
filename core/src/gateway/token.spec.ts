import { describe, expect, it } from 'vitest';

import { GATEWAY_TOKEN_BYTES, isTokenShaped, newBootToken, tokensMatch } from './token.js';

describe('gateway per-boot token', () => {
  // -- positive ---------------------------------------------------------------

  it('generates a base64url token of 32 bytes entropy (43 chars, no padding)', () => {
    const token = newBootToken();
    expect(isTokenShaped(token)).toBe(true);
    expect(token).toHaveLength(43);
    expect(token).not.toContain('=');
    expect(Buffer.from(token, 'base64url')).toHaveLength(GATEWAY_TOKEN_BYTES);
  });

  it('matches a token against itself', () => {
    const token = newBootToken();
    expect(tokensMatch(token, token)).toBe(true);
  });

  // -- negative ---------------------------------------------------------------

  it('two boots never share a token', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64; i += 1) seen.add(newBootToken());
    expect(seen.size).toBe(64);
  });

  it('rejects a same-length wrong token', () => {
    const token = newBootToken();
    let other = newBootToken();
    while (other === token) other = newBootToken();
    expect(tokensMatch(token, other)).toBe(false);
  });

  it('rejects non-string and empty presentations', () => {
    const token = newBootToken();
    expect(tokensMatch(token, undefined)).toBe(false);
    expect(tokensMatch(token, null)).toBe(false);
    expect(tokensMatch(token, 42)).toBe(false);
    expect(tokensMatch(token, '')).toBe(false);
  });

  // -- edge ---------------------------------------------------------------------

  it('rejects prefix/suffix/length variants without throwing', () => {
    const token = newBootToken();
    expect(tokensMatch(token, token.slice(0, -1))).toBe(false);
    expect(tokensMatch(token, `${token}A`)).toBe(false);
    expect(tokensMatch(token, ` ${token}`)).toBe(false);
  });

  it('isTokenShaped refuses non-base64url shapes', () => {
    expect(isTokenShaped('short')).toBe(false);
    expect(isTokenShaped(`${'a'.repeat(42)}+`)).toBe(false); // '+' is base64, not base64url
    expect(isTokenShaped(undefined)).toBe(false);
  });
});
