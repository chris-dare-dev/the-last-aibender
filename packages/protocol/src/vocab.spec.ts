/**
 * vocab.ts — the account-label FORM gate + backend pairing (ICR-0013, M7).
 *
 * Proves the OPEN, validated form is a REAL gate (not anything-goes): the
 * seed labels + newly provisioned MAX_C/MAX_D are accepted; a non-sanctioned
 * label (HACKER, email-shaped, MAX_AB, lowercase, MAX_ prefix-only) is
 * REJECTED; and every account label maps to the one legal backend.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  ACCOUNT_LABELS,
  BACKENDS,
  BUILTIN_BACKEND_DESCRIPTORS,
  BackendRegistrationError,
  CLAUDE_ACCOUNT_LABEL_RE,
  ENTERPRISE_ACCOUNT_LABEL,
  FIXED_BACKEND_LABELS,
  UnknownAccountLabelError,
  UnknownBackendError,
  allBackendIds,
  allBackends,
  backendById,
  backendForLabel,
  backendForLabelOrUndefined,
  isAccountLabel,
  isBackend,
  isClaudeAccountLabel,
  isFixedBackendLabel,
  registerBackend,
  sourceForBackend,
  substrateLegalFor,
  unregisterBackend,
  type BackendDescriptor,
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

describe('backend registry (ICR-0016) — the built-in three, byte-identical', () => {
  it('pre-registers exactly the three built-in descriptors in seed order', () => {
    const builtins = allBackends().filter((d) => d.builtin);
    expect(builtins.map((d) => d.id)).toEqual(['claude_code', 'opencode', 'lmstudio']);
    // The seed BACKENDS list and the built-in descriptor ids agree.
    expect([...BACKENDS]).toEqual(BUILTIN_BACKEND_DESCRIPTORS.map((d) => d.id));
    expect(allBackendIds()).toEqual(['claude_code', 'opencode', 'lmstudio']);
  });

  it('isBackend accepts the built-in three and rejects garbage (registry is a gate)', () => {
    for (const id of BACKENDS) expect(isBackend(id)).toBe(true);
    for (const bad of ['CLAUDE_CODE', 'openrouter', 'ollama', '', ' claude_code', 42, null, undefined]) {
      expect(isBackend(bad)).toBe(false);
    }
  });

  it('sourceForBackend resolves the former hardcoded if-chain verbatim', () => {
    expect(sourceForBackend('claude_code')).toBe('claude-otel');
    expect(sourceForBackend('opencode')).toBe('opencode-sse');
    expect(sourceForBackend('lmstudio')).toBe('lmstudio');
    expect(() => sourceForBackend('nope')).toThrow(UnknownBackendError);
  });

  it('substrateLegalFor encodes pty-is-claude-only (blueprint §4.1)', () => {
    expect(substrateLegalFor('sdk', 'claude_code')).toBe(true);
    expect(substrateLegalFor('pty', 'claude_code')).toBe(true);
    expect(substrateLegalFor('sdk', 'opencode')).toBe(true);
    expect(substrateLegalFor('pty', 'opencode')).toBe(false);
    expect(substrateLegalFor('sdk', 'lmstudio')).toBe(true);
    expect(substrateLegalFor('pty', 'lmstudio')).toBe(false);
    // Fail-closed for an unregistered backend.
    expect(substrateLegalFor('sdk', 'nope')).toBe(false);
  });

  it('backendById returns descriptors for built-ins and undefined otherwise', () => {
    expect(backendById('claude_code')?.id).toBe('claude_code');
    expect(backendById('opencode')?.builtin).toBe(true);
    expect(backendById('nope')).toBeUndefined();
  });
});

describe('backend registry (ICR-0016) — a synthetic 4th backend routes end-to-end', () => {
  const SYNTH: BackendDescriptor = {
    id: 'synthbackend',
    // Serves its own label form that CANNOT collide with a built-in one.
    servesLabel: (label) => label === 'SYNTH_LOCAL',
    sourceName: 'lmstudio',
    substrates: ['sdk'],
    builtin: false,
  };

  afterEach(() => {
    unregisterBackend('synthbackend');
    unregisterBackend('other');
  });

  it('registers, validates, routes its label, and enumerates — with NO built-in edit', () => {
    // Before registration the id + label are unknown.
    expect(isBackend('synthbackend')).toBe(false);
    expect(isAccountLabel('SYNTH_LOCAL')).toBe(false);
    expect(backendForLabelOrUndefined('SYNTH_LOCAL')).toBeUndefined();

    registerBackend(SYNTH);

    // After registration: id is a valid backend, its label validates + pairs.
    // A registered label is outside the compile-time AccountLabel union (the
    // seed forms), so backendForLabel takes a cast here — registry-driven
    // callers use the total backendForLabelOrUndefined (accepts `unknown`).
    expect(isBackend('synthbackend')).toBe(true);
    expect(isAccountLabel('SYNTH_LOCAL')).toBe(true);
    expect(backendForLabel('SYNTH_LOCAL' as never)).toBe('synthbackend');
    expect(backendForLabelOrUndefined('SYNTH_LOCAL')).toBe('synthbackend');
    expect(sourceForBackend('synthbackend')).toBe('lmstudio');
    expect(substrateLegalFor('sdk', 'synthbackend')).toBe(true);
    expect(substrateLegalFor('pty', 'synthbackend')).toBe(false);
    expect(backendById('synthbackend')?.id).toBe('synthbackend');

    // Enumeration: built-ins first, then the addition.
    expect(allBackendIds()).toEqual(['claude_code', 'opencode', 'lmstudio', 'synthbackend']);
  });

  it('the three built-ins are unchanged while a 4th is registered', () => {
    registerBackend(SYNTH);
    expect(backendForLabel('MAX_A')).toBe('claude_code');
    expect(backendForLabel('ENT')).toBe('claude_code');
    expect(backendForLabel('AWS_DEV')).toBe('opencode');
    expect(backendForLabel('LOCAL')).toBe('lmstudio');
    expect(sourceForBackend('claude_code')).toBe('claude-otel');
  });

  it('idempotent re-registration of the same descriptor is a no-op', () => {
    registerBackend(SYNTH);
    expect(() => registerBackend(SYNTH)).not.toThrow();
    expect(allBackendIds().filter((id) => id === 'synthbackend')).toHaveLength(1);
  });

  it('unregisterBackend removes the addition and returns false when absent', () => {
    registerBackend(SYNTH);
    expect(unregisterBackend('synthbackend')).toBe(true);
    expect(isBackend('synthbackend')).toBe(false);
    expect(isAccountLabel('SYNTH_LOCAL')).toBe(false);
    expect(unregisterBackend('synthbackend')).toBe(false);
  });
});

describe('backend registry (ICR-0016) — registration is a REAL gate', () => {
  afterEach(() => {
    unregisterBackend('collider');
    unregisterBackend('dup');
    unregisterBackend('ptyclaimer');
  });

  it('refuses re-registering a built-in id', () => {
    for (const id of ['claude_code', 'opencode', 'lmstudio']) {
      expect(() =>
        registerBackend({
          id,
          servesLabel: () => false,
          sourceName: 'lmstudio',
          substrates: ['sdk'],
          builtin: false,
        }),
      ).toThrow(BackendRegistrationError);
    }
  });

  it('refuses a descriptor flagged builtin', () => {
    expect(() =>
      registerBackend({
        id: 'sneaky',
        servesLabel: () => false,
        sourceName: 'lmstudio',
        substrates: ['sdk'],
        builtin: true,
      }),
    ).toThrow(BackendRegistrationError);
  });

  it('refuses a servesLabel that overlaps ANY built-in label form', () => {
    // Overlaps the open Claude MAX form.
    expect(() =>
      registerBackend({
        id: 'collider',
        servesLabel: (label) => /^MAX_[A-Z]$/.test(label),
        sourceName: 'lmstudio',
        substrates: ['sdk'],
        builtin: false,
      }),
    ).toThrow(BackendRegistrationError);
    // Overlaps a fixed backend label.
    expect(() =>
      registerBackend({
        id: 'collider',
        servesLabel: (label) => label === 'AWS_DEV',
        sourceName: 'lmstudio',
        substrates: ['sdk'],
        builtin: false,
      }),
    ).toThrow(BackendRegistrationError);
    // Overlaps ENT.
    expect(() =>
      registerBackend({
        id: 'collider',
        servesLabel: (label) => label === 'ENT',
        sourceName: 'lmstudio',
        substrates: ['sdk'],
        builtin: false,
      }),
    ).toThrow(BackendRegistrationError);
    // The built-in labels still resolve to the built-ins (never hijacked).
    expect(backendForLabel('MAX_A')).toBe('claude_code');
    expect(backendForLabel('AWS_DEV')).toBe('opencode');
  });

  it('refuses a malformed descriptor and an unknown substrate', () => {
    expect(() =>
      registerBackend({
        id: '',
        servesLabel: () => false,
        sourceName: 'lmstudio',
        substrates: ['sdk'],
        builtin: false,
      } as BackendDescriptor),
    ).toThrow(BackendRegistrationError);
    expect(() =>
      registerBackend({
        id: 'ptyclaimer',
        servesLabel: () => false,
        sourceName: 'lmstudio',
        substrates: ['warp'],
        builtin: false,
      } as unknown as BackendDescriptor),
    ).toThrow(BackendRegistrationError);
  });

  it('refuses re-registering a DIFFERENT descriptor under an existing id', () => {
    registerBackend({
      id: 'dup',
      servesLabel: (label) => label === 'DUP_A',
      sourceName: 'lmstudio',
      substrates: ['sdk'],
      builtin: false,
    });
    expect(() =>
      registerBackend({
        id: 'dup',
        servesLabel: (label) => label === 'DUP_B',
        sourceName: 'lmstudio',
        substrates: ['sdk'],
        builtin: false,
      }),
    ).toThrow(BackendRegistrationError);
  });
});
