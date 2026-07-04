import { describe, expect, it } from 'vitest';

import {
  OPENCODE_BASIC_USERNAME,
  isServePasswordShaped,
  newServePassword,
  serveBasicAuthHeader,
} from './password.js';

describe('per-boot OPENCODE_SERVER_PASSWORD (BE-4; blueprint §4.2)', () => {
  // -- positive -------------------------------------------------------------

  it('generates 43-char base64url passwords (256 bits)', () => {
    const password = newServePassword();
    expect(isServePasswordShaped(password)).toBe(true);
    expect(password).toHaveLength(43);
  });

  it('generates a DIFFERENT password per boot', () => {
    const seen = new Set(Array.from({ length: 32 }, () => newServePassword()));
    expect(seen.size).toBe(32);
  });

  it('builds the HTTP Basic header the serve child expects (opencode:<pw>)', () => {
    const header = serveBasicAuthHeader('synthetic-password');
    expect(header).toBe(
      `Basic ${Buffer.from('opencode:synthetic-password').toString('base64')}`,
    );
    expect(OPENCODE_BASIC_USERNAME).toBe('opencode');
  });

  // -- negative ---------------------------------------------------------------

  it('rejects non-password shapes', () => {
    expect(isServePasswordShaped(undefined)).toBe(false);
    expect(isServePasswordShaped('short')).toBe(false);
    expect(isServePasswordShaped('x'.repeat(44))).toBe(false);
    expect(isServePasswordShaped(`${'y'.repeat(42)}+`)).toBe(false); // not base64url
  });
});
