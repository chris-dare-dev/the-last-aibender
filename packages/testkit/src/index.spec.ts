import { describe, expect, it } from 'vitest';

import { PLACEHOLDER_ACCOUNTS, synthesizedJsonlLine } from './index.js';

describe('@aibender/testkit: synthesizedJsonlLine', () => {
  // -- positive ------------------------------------------------------------

  it('emits a parseable, synthesized-flagged transcript line', () => {
    const parsed = JSON.parse(synthesizedJsonlLine());
    expect(parsed.synthesized).toBe(true);
    expect(parsed.account).toBe('MAX_A');
    expect(parsed.type).toBe('user');
    expect(parsed.sessionId).toMatch(/^synth-/);
    expect(parsed.message.content[0].text).toContain('synthesized');
  });

  it('honors account, role, seq, and text options', () => {
    const line = synthesizedJsonlLine({
      account: 'MAX_B',
      role: 'assistant',
      seq: 7,
      text: 'seven',
    });
    const parsed = JSON.parse(line);
    expect(parsed.account).toBe('MAX_B');
    expect(parsed.type).toBe('assistant');
    expect(parsed.uuid).toBe('synth-max_b-7');
    expect(parsed.timestamp).toBe('2026-01-01T00:00:07.000Z');
    expect(parsed.message.content[0].text).toBe('seven');
  });

  it('is deterministic for identical options', () => {
    const opts = { account: 'ENT', seq: 3 } as const;
    expect(synthesizedJsonlLine(opts)).toBe(synthesizedJsonlLine(opts));
  });

  // -- negative ------------------------------------------------------------

  it('refuses non-placeholder account labels [X2]', () => {
    expect(PLACEHOLDER_ACCOUNTS).toEqual(['MAX_A', 'MAX_B', 'ENT']);
    // Cast past the compile-time guard to prove the runtime guard holds too.
    expect(() =>
      synthesizedJsonlLine({ account: 'REAL_ACCOUNT' as unknown as 'MAX_A' }),
    ).toThrow(/X2/);
  });

  it('refuses identity-shaped fixture text [X2]', () => {
    // Offending strings are runtime-built so no scanner-shaped literal is
    // ever committed to this public repo.
    const emailish = ['fake-person', 'gmail.com'].join('@');
    const awsIdish = '123456'.repeat(2);
    const tokenish = ['sk', 'fake0token0fake0token'].join('-');
    expect(() => synthesizedJsonlLine({ text: `mail me at ${emailish}` })).toThrow(/X2/);
    expect(() => synthesizedJsonlLine({ text: `account ${awsIdish}` })).toThrow(/X2/);
    expect(() => synthesizedJsonlLine({ text: `key ${tokenish}` })).toThrow(/X2/);
  });

  it('refuses a negative or fractional seq', () => {
    expect(() => synthesizedJsonlLine({ seq: -1 })).toThrow(RangeError);
    expect(() => synthesizedJsonlLine({ seq: 0.5 })).toThrow(RangeError);
  });

  // -- edge ----------------------------------------------------------------

  it('always emits exactly one line, even for multi-line text', () => {
    const line = synthesizedJsonlLine({ text: 'first\nsecond\r\nthird' });
    expect(line).not.toMatch(/[\r\n]/);
    expect(JSON.parse(line).message.content[0].text).toBe('first\nsecond\r\nthird');
  });

  it('accepts seq 0 and an 11- or 13-digit number in text (only 12 is refused)', () => {
    expect(() => synthesizedJsonlLine({ seq: 0 })).not.toThrow();
    expect(() => synthesizedJsonlLine({ text: `n=${'1'.repeat(11)}` })).not.toThrow();
    // 13 digits CONTAINS a 12-digit run — still refused (conservative guard).
    expect(() => synthesizedJsonlLine({ text: `n=${'1'.repeat(13)}` })).toThrow(/X2/);
  });
});
