/**
 * vocab.ts — the account-label FORM gate + backend pairing (ICR-0013, M7).
 *
 * Proves the OPEN, validated form is a REAL gate (not anything-goes): the
 * seed labels + newly provisioned MAX_C/MAX_D are accepted; a non-sanctioned
 * label (HACKER, email-shaped, MAX_AB, lowercase, MAX_ prefix-only) is
 * REJECTED; and every account label maps to the one legal backend.
 */

import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_LABELS,
  CLAUDE_ACCOUNT_LABEL_RE,
  ENTERPRISE_ACCOUNT_LABEL,
  FIXED_BACKEND_LABELS,
  UnknownAccountLabelError,
  backendForLabel,
  backendForLabelOrUndefined,
  isAccountLabel,
  isClaudeAccountLabel,
  isFixedBackendLabel,
} from './vocab.js';

describe('account-label FORM (ICR-0013)', () => {
  // -- positive: the seed labels stay valid --------------------------------
  it('accepts every seed label (back-compat)', () => {
    for (const label of ACCOUNT_LABELS) {
      expect(isAccountLabel(label)).toBe(true);
    }
  });

  // -- positive: the OPEN Max form admits new accounts without a code change
  it('accepts every MAX_<A-Z> Max account by form', () => {
    for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      expect(isAccountLabel(`MAX_${c}`)).toBe(true);
      expect(isClaudeAccountLabel(`MAX_${c}`)).toBe(true);
    }
    // The [X2] sanctioned placeholders the owner actually provisioned.
    expect(isAccountLabel('MAX_C')).toBe(true);
    expect(isAccountLabel('MAX_D')).toBe(true);
  });

  it('classifies ENT as a Claude account and AWS_DEV/LOCAL as fixed backends', () => {
    expect(isClaudeAccountLabel(ENTERPRISE_ACCOUNT_LABEL)).toBe(true);
    expect(isClaudeAccountLabel('AWS_DEV')).toBe(false);
    expect(isClaudeAccountLabel('LOCAL')).toBe(false);
    for (const fixed of FIXED_BACKEND_LABELS) {
      expect(isFixedBackendLabel(fixed)).toBe(true);
      expect(isAccountLabel(fixed)).toBe(true);
    }
    expect(isFixedBackendLabel('MAX_A')).toBe(false);
    expect(isFixedBackendLabel('ENT')).toBe(false);
  });

  // -- negative: the form is a REAL gate -----------------------------------
  it('rejects non-sanctioned labels (the form is a gate, not anything-goes)', () => {
    for (const bad of [
      'HACKER',
      'hacker@example.com',
      'MAX_AB', // two letters
      'MAX_1', // digit
      'MAX_', // prefix only
      'max_a', // lowercase
      'MAX_a', // lowercase suffix
      'MAXA', // missing separator
      'ENT_X', // ENT is exact, no suffix form
      'ent', // lowercase enterprise
      '',
      'MAX_AA',
      ' MAX_A', // leading space (RE is anchored)
      'MAX_A ', // trailing space
    ]) {
      expect(isAccountLabel(bad)).toBe(false);
      expect(isClaudeAccountLabel(bad)).toBe(false);
    }
    expect(isAccountLabel(undefined)).toBe(false);
    expect(isAccountLabel(null)).toBe(false);
    expect(isAccountLabel(42)).toBe(false);
    expect(isAccountLabel({ label: 'MAX_A' })).toBe(false);
  });

  it('CLAUDE_ACCOUNT_LABEL_RE is anchored to a single uppercase letter', () => {
    expect(CLAUDE_ACCOUNT_LABEL_RE.source).toBe('^MAX_[A-Z]$');
    expect(CLAUDE_ACCOUNT_LABEL_RE.test('MAX_A')).toBe(true);
    expect(CLAUDE_ACCOUNT_LABEL_RE.test('MAX_Z')).toBe(true);
    expect(CLAUDE_ACCOUNT_LABEL_RE.test('MAX_AB')).toBe(false);
    // ENT is NOT matched by the RE — it is the separate exact literal.
    expect(CLAUDE_ACCOUNT_LABEL_RE.test('ENT')).toBe(false);
  });
});

describe('backendForLabel pairing (ICR-0013)', () => {
  it('maps every Claude account (MAX_<X> + ENT) to claude_code', () => {
    for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      expect(backendForLabel(`MAX_${c}`)).toBe('claude_code');
    }
    expect(backendForLabel('ENT')).toBe('claude_code');
  });

  it('maps the fixed backend labels to their substrates', () => {
    expect(backendForLabel('AWS_DEV')).toBe('opencode');
    expect(backendForLabel('LOCAL')).toBe('lmstudio');
  });

  it('throws UnknownAccountLabelError on a label outside the form', () => {
    // The typed-refusal convention: callers gate with isAccountLabel first, so
    // reaching here with a bad label is a programmer error, surfaced loudly.
    expect(() => backendForLabel('HACKER' as never)).toThrow(UnknownAccountLabelError);
    expect(() => backendForLabel('MAX_AB' as never)).toThrow(UnknownAccountLabelError);
  });

  it('backendForLabelOrUndefined is total (never throws) over unknown', () => {
    expect(backendForLabelOrUndefined('MAX_C')).toBe('claude_code');
    expect(backendForLabelOrUndefined('AWS_DEV')).toBe('opencode');
    expect(backendForLabelOrUndefined('HACKER')).toBeUndefined();
    expect(backendForLabelOrUndefined(undefined)).toBeUndefined();
    expect(backendForLabelOrUndefined(123)).toBeUndefined();
  });
});
