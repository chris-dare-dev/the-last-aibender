import { describe, expect, it } from 'vitest';

import {
  assertNoForbiddenArgs,
  buildOtelEnvBlock,
  buildSessionEnv,
  isScrubbedEnvVar,
  SCRUBBED_ENV_VARS,
} from './env.js';
import { BareModeRefusedError, TokenMixingError } from './errors.js';
import type { ClaudeProfile } from './profiles.js';

const PROFILE: ClaudeProfile = Object.freeze({
  label: 'MAX_A' as const,
  backend: 'claude_code' as const,
  configDir: '/synthetic/aibender/accounts/max-a',
  securestorageDir: '/synthetic/aibender/accounts/max-a',
});

describe('buildSessionEnv — the single spawn layer (BE-1; blueprint §3 rules 1–3)', () => {
  // -- positive ---------------------------------------------------------------

  it("injects the account's config + securestorage dirs as byte-stable strings", () => {
    const env = buildSessionEnv(PROFILE, { baseEnv: { PATH: '/usr/bin' } });
    expect(env['CLAUDE_CONFIG_DIR']).toBe(PROFILE.configDir);
    expect(env['CLAUDE_SECURESTORAGE_CONFIG_DIR']).toBe(PROFILE.securestorageDir);
    // Identical references, not merely equal — the keychain hash is byte-wise.
    expect(env['CLAUDE_CONFIG_DIR']).toBe(
      buildSessionEnv(PROFILE, { baseEnv: {} })['CLAUDE_CONFIG_DIR'],
    );
  });

  it('scrubs ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_PROFILE and every CLAUDE_CODE_USE_*', () => {
    const env = buildSessionEnv(PROFILE, {
      baseEnv: {
        PATH: '/usr/bin',
        HOME: '/synthetic/home',
        ANTHROPIC_API_KEY: 'fake-precedence-hijacker',
        ANTHROPIC_AUTH_TOKEN: 'fake-auth-value',
        ANTHROPIC_PROFILE: 'fake-profile-name',
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CODE_USE_VERTEX: 'true',
        CLAUDE_CODE_USE_FOUNDRY: 'yes',
      },
    });
    for (const name of SCRUBBED_ENV_VARS) expect(env).not.toHaveProperty(name);
    expect(Object.keys(env).filter((k) => k.startsWith('CLAUDE_CODE_USE_'))).toEqual([]);
    // Untainted vars pass through untouched.
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['HOME']).toBe('/synthetic/home');
  });

  it('lays down the OTel placeholder block with account=<LABEL> attribution', () => {
    const env = buildSessionEnv(PROFILE, { baseEnv: {} });
    expect(env['CLAUDE_CODE_ENABLE_TELEMETRY']).toBe('1');
    expect(env['OTEL_LOG_TOOL_DETAILS']).toBe('1');
    expect(env['OTEL_RESOURCE_ATTRIBUTES']).toBe('account=MAX_A');
    expect(buildOtelEnvBlock('ENT')['OTEL_RESOURCE_ATTRIBUTES']).toBe('account=ENT');
  });

  it('never mutates the base env (snapshot semantics)', () => {
    const base = { ANTHROPIC_API_KEY: 'fake-value', PATH: '/usr/bin' };
    buildSessionEnv(PROFILE, { baseEnv: base });
    expect(base.ANTHROPIC_API_KEY).toBe('fake-value');
  });

  // -- negative ---------------------------------------------------------------

  it('REFUSES CLAUDE_CODE_OAUTH_TOKEN in the base env with a typed error (never a silent scrub)', () => {
    expect(() =>
      buildSessionEnv(PROFILE, {
        baseEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'obviously-fake-not-a-real-token' },
      }),
    ).toThrow(TokenMixingError);
    // Empty string is still presence — still refused.
    expect(() =>
      buildSessionEnv(PROFILE, { baseEnv: { CLAUDE_CODE_OAUTH_TOKEN: '' } }),
    ).toThrow(TokenMixingError);
  });

  it('refuses --bare in any spelling with a typed error', () => {
    expect(() => assertNoForbiddenArgs(['--bare'])).toThrow(BareModeRefusedError);
    expect(() => assertNoForbiddenArgs(['--verbose', '--bare=true'])).toThrow(
      BareModeRefusedError,
    );
    expect(() => assertNoForbiddenArgs(['--verbose'])).not.toThrow();
    expect(() => assertNoForbiddenArgs(undefined)).not.toThrow();
  });

  // -- edge -------------------------------------------------------------------

  it('drops undefined base-env values instead of stringifying them', () => {
    const env = buildSessionEnv(PROFILE, {
      baseEnv: { DEFINED: 'yes', UNDEFINED: undefined },
    });
    expect(env['DEFINED']).toBe('yes');
    expect(env).not.toHaveProperty('UNDEFINED');
  });

  it('an undefined-valued CLAUDE_CODE_OAUTH_TOKEN key is treated as absent', () => {
    // e.g. `delete env.X` semantics from a sanitizing parent — not a mixing signal.
    const env = buildSessionEnv(PROFILE, {
      baseEnv: { CLAUDE_CODE_OAUTH_TOKEN: undefined, PATH: '/usr/bin' },
    });
    expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('a caller-supplied CLAUDE_CONFIG_DIR in the base env cannot survive (profile wins)', () => {
    const env = buildSessionEnv(PROFILE, {
      baseEnv: {
        CLAUDE_CONFIG_DIR: '/synthetic/wrong/dir',
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '/synthetic/wrong/store',
      },
    });
    expect(env['CLAUDE_CONFIG_DIR']).toBe(PROFILE.configDir);
    expect(env['CLAUDE_SECURESTORAGE_CONFIG_DIR']).toBe(PROFILE.securestorageDir);
  });

  it('the result is frozen (no post-hoc contamination between sessions)', () => {
    const env = buildSessionEnv(PROFILE, { baseEnv: {} });
    expect(Object.isFrozen(env)).toBe(true);
    expect(() => {
      (env as Record<string, string>)['INJECTED'] = 'nope';
    }).toThrow(TypeError);
  });

  it('isScrubbedEnvVar matches exactly and by prefix, not by substring', () => {
    expect(isScrubbedEnvVar('ANTHROPIC_API_KEY')).toBe(true);
    expect(isScrubbedEnvVar('CLAUDE_CODE_USE_ANYTHING')).toBe(true);
    expect(isScrubbedEnvVar('MY_ANTHROPIC_API_KEY')).toBe(false);
    expect(isScrubbedEnvVar('CLAUDE_CODE_USEFUL')).toBe(false);
    expect(isScrubbedEnvVar('CLAUDE_CONFIG_DIR')).toBe(false);
  });
});
