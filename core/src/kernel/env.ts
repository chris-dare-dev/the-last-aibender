/**
 * buildSessionEnv — THE single spawn-env layer (BE-1; blueprint §2 "one
 * spawner", §3 rules 1–3). Every Claude session of every substrate (SDK now,
 * node-pty via BE-2 at M2) gets its process environment from this one
 * function; nothing else in the harness assembles Claude spawn env.
 *
 * Per spawn it:
 *   1. starts from an explicit base env (a snapshot — never mutated);
 *   2. REFUSES CLAUDE_CODE_OAUTH_TOKEN presence (typed TokenMixingError —
 *      mixing token-env auth with an OAuth-file-mode config dir is the
 *      issue-#37512 hazard; rung 2 is a separate SI-2-gated path);
 *   3. scrubs the provider-precedence hijack list: ANTHROPIC_API_KEY,
 *      ANTHROPIC_AUTH_TOKEN, ANTHROPIC_PROFILE, and every CLAUDE_CODE_USE_*;
 *   4. injects the account's byte-stable CLAUDE_CONFIG_DIR and
 *      CLAUDE_SECURESTORAGE_CONFIG_DIR (NFC-normalized once at profile load);
 *   5. lays down the OTel env block placeholder with the `account=<LABEL>`
 *      resource attribute (full block is SI-3's, M2 — see below).
 *
 * The result is a COMPLETE environment: the SDK runner passes it as
 * `options.env`, which REPLACES the subprocess environment entirely (verified
 * against @anthropic-ai/claude-agent-sdk 0.3.201 — it is not merged with
 * process.env), so a scrubbed variable cannot leak back in.
 */

import type { ClaudeProfile } from './profiles.js';
import { BareModeRefusedError, TokenMixingError } from './errors.js';

// ---------------------------------------------------------------------------
// Scrub list (blueprint §3 rule 3, x1 findings §"operating rules")
// ---------------------------------------------------------------------------

/** Exact env-var names removed from every spawn env. */
export const SCRUBBED_ENV_VARS = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_PROFILE',
] as const);

/** Env-var name PREFIXES removed from every spawn env (cloud-provider mode). */
export const SCRUBBED_ENV_PREFIXES = Object.freeze(['CLAUDE_CODE_USE_'] as const);

/** Presence of this var in the base env is REFUSED, not scrubbed. */
export const OAUTH_TOKEN_ENV_VAR = 'CLAUDE_CODE_OAUTH_TOKEN' as const;

/** True when `name` is on the scrub list (exact or prefix match). */
export function isScrubbedEnvVar(name: string): boolean {
  if ((SCRUBBED_ENV_VARS as readonly string[]).includes(name)) return true;
  return SCRUBBED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// OTel env block — PLACEHOLDER until SI-3 (M2)
// ---------------------------------------------------------------------------

/**
 * OTel env block placeholder (plan §4/BE-1 "OTel env block placeholder
 * (account=<LABEL> resource attr)"). SI-3 owns the full wiring at M2
 * (exporter endpoints, account-UUID attributes off — plan §6/SI-3); the
 * frozen part is the shape BE-5 attribution depends on: telemetry enabled,
 * tool details on, and `account=<LABEL>` as the resource attribute.
 */
export function buildOtelEnvBlock(label: ClaudeProfile['label']): Readonly<Record<string, string>> {
  return Object.freeze({
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOG_TOOL_DETAILS: '1',
    OTEL_RESOURCE_ATTRIBUTES: `account=${label}`,
  });
}

// ---------------------------------------------------------------------------
// Forbidden argv (blueprint §4.1 "never --bare")
// ---------------------------------------------------------------------------

/**
 * Refuse `--bare` (and any `--bare=...` spelling) anywhere in extra argv.
 * `--bare` reads ONLY ANTHROPIC_API_KEY/apiKeyHelper — on a subscription
 * profile it silently disables OAuth. Typed refusal, never a silent drop.
 */
export function assertNoForbiddenArgs(args: readonly string[] | undefined): void {
  if (args === undefined) return;
  for (const arg of args) {
    if (arg === '--bare' || arg.startsWith('--bare=')) {
      throw new BareModeRefusedError();
    }
  }
}

// ---------------------------------------------------------------------------
// buildSessionEnv
// ---------------------------------------------------------------------------

export interface BuildSessionEnvOptions {
  /**
   * Base environment snapshot. The kernel passes its composition-time env;
   * tests pass explicit fixtures. Undefined values are dropped (never the
   * string "undefined").
   */
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
}

/**
 * Build the complete per-account spawn environment. Pure with respect to its
 * inputs; the returned object is frozen. Throws {@link TokenMixingError} when
 * the base env carries CLAUDE_CODE_OAUTH_TOKEN (even empty — presence is the
 * hazard, blueprint §4.1).
 */
export function buildSessionEnv(
  profile: ClaudeProfile,
  options: BuildSessionEnvOptions,
): Readonly<Record<string, string>> {
  const base = options.baseEnv;

  if (Object.prototype.hasOwnProperty.call(base, OAUTH_TOKEN_ENV_VAR)) {
    // Deliberately checks presence, not truthiness: an empty-string token is
    // still a mixing signal from the operator's environment.
    if (base[OAUTH_TOKEN_ENV_VAR] !== undefined) throw new TokenMixingError();
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (isScrubbedEnvVar(key)) continue;
    env[key] = value;
  }

  // Byte-stable, NFC-normalized-at-load absolute strings (blueprint §3 rule 2).
  env['CLAUDE_CONFIG_DIR'] = profile.configDir;
  env['CLAUDE_SECURESTORAGE_CONFIG_DIR'] = profile.securestorageDir;

  Object.assign(env, buildOtelEnvBlock(profile.label));

  return Object.freeze(env);
}
