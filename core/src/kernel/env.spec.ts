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

  it('isScrubbedEnvVar catches the known exact + prefix hijack vars', () => {
    expect(isScrubbedEnvVar('ANTHROPIC_API_KEY')).toBe(true);
    expect(isScrubbedEnvVar('CLAUDE_CODE_USE_ANYTHING')).toBe(true);
    // Permit-listed SDK-injected vars are NOT scrubbed (re-injected below).
    expect(isScrubbedEnvVar('CLAUDE_CONFIG_DIR')).toBe(false);
    expect(isScrubbedEnvVar('CLAUDE_SECURESTORAGE_CONFIG_DIR')).toBe(false);
    // A benign non-namespace var passes through.
    expect(isScrubbedEnvVar('PATH')).toBe(false);
    expect(isScrubbedEnvVar('HOME')).toBe(false);
  });

  // -- SEC-5: fail-closed against a NEW SDK credential var / secret-shaped name -

  it('SEC-5 scrubs the WHOLE unknown ANTHROPIC_*/CLAUDE_* SDK namespace', () => {
    // A future SDK credential var not on any known list is dropped, not passed.
    expect(isScrubbedEnvVar('ANTHROPIC_BEDROCK_SECRET')).toBe(true);
    expect(isScrubbedEnvVar('CLAUDE_CODE_OAUTH_PROVIDER_TOKEN')).toBe(true);
    expect(isScrubbedEnvVar('CLAUDE_CODE_USEFUL')).toBe(true); // whole namespace, permit-gated
    expect(isScrubbedEnvVar('ANTHROPIC_BASE_URL')).toBe(true);
    // Non-namespace vars are unaffected by the namespace rule.
    expect(isScrubbedEnvVar('MY_UNRELATED_VAR')).toBe(false);
  });

  it('SEC-5 scrubs secret-shaped NAMES even outside the SDK namespace', () => {
    expect(isScrubbedEnvVar('AWS_SECRET_ACCESS_KEY')).toBe(true);
    expect(isScrubbedEnvVar('AWS_ACCESS_KEY_ID')).toBe(true);
    expect(isScrubbedEnvVar('GITHUB_TOKEN')).toBe(true);
    expect(isScrubbedEnvVar('MY_ANTHROPIC_API_KEY')).toBe(true); // contains API_KEY
    expect(isScrubbedEnvVar('SSH_PRIVATE_KEY')).toBe(true);
    // A benign name that merely CONTAINS a namespace word but no secret token
    // and is not in the SDK namespace still passes.
    expect(isScrubbedEnvVar('EDITOR')).toBe(false);
  });

  it('SEC-5: buildSessionEnv drops a synthesized future SDK credential var', () => {
    const env = buildSessionEnv(PROFILE, {
      baseEnv: {
        PATH: '/usr/bin',
        // Simulates a future @anthropic-ai SDK bump adding a fresh credential
        // env the exact-name scrub does not know about.
        CLAUDE_CODE_NEW_SECRET_TOKEN: 'synthesized-not-real',
        ANTHROPIC_BASE_URL: 'https://synthetic.invalid',
        AWS_SECRET_ACCESS_KEY: 'synthesized-aws-not-real',
      },
    });
    expect(env).not.toHaveProperty('CLAUDE_CODE_NEW_SECRET_TOKEN');
    expect(env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(env['PATH']).toBe('/usr/bin'); // benign vars still flow
    // The injected account dirs are still present and correct.
    expect(env['CLAUDE_CONFIG_DIR']).toBe(PROFILE.configDir);
  });
});
