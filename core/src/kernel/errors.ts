/**
 * Typed kernel errors (BE-1). Every refusal the spawn layer makes is a TYPED
 * error carrying a protocol error code, so BE-3's control channel can answer
 * `{ ok:false, error }` without string-matching messages (plan §4/BE-1:
 * "refusal of --bare and of CLAUDE_CODE_OAUTH_TOKEN-mixing (throw typed
 * errors)"; blueprint §3 rules 1–3, §4.1, §5 guardrails).
 *
 * Messages are identifier-free by construction [X2]: they name labels and
 * env-var NAMES, never values or machine-local paths.
 */

import type { ErrorCode } from '@aibender/protocol';

/** Base class: every kernel refusal maps to a protocol {@link ErrorCode}. */
export class KernelError extends Error {
  override readonly name: string = 'KernelError';
  readonly code: ErrorCode;
  /** True when the same request may legitimately be retried. */
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

/** Unknown or non-Claude account label handed to the profile registry. */
export class UnknownProfileError extends KernelError {
  override readonly name = 'UnknownProfileError';
  constructor(label: string, hint?: string) {
    super(
      'bad-request',
      `unknown account profile label ${JSON.stringify(label)}${hint ? ` — ${hint}` : ''}`,
    );
  }
}

/** Structural problem in a profile manifest or machine-local override file. */
export class ProfileConfigError extends KernelError {
  override readonly name = 'ProfileConfigError';
  constructor(message: string) {
    super('bad-request', message);
  }
}

/**
 * `CLAUDE_CODE_OAUTH_TOKEN` present while spawning an OAuth-file-mode (rung 1)
 * session. Mixing token-env auth with keychain/file OAuth in one config dir is
 * the issue-#37512 hazard class — refused, never silently scrubbed
 * (blueprint §4.1; x1 findings). Rung 2 (deliberate setup-token injection) is
 * a separate, SI-2-canary-gated path that does not exist at M1.
 */
export class TokenMixingError extends KernelError {
  override readonly name = 'TokenMixingError';
  constructor() {
    super(
      'bad-request',
      'CLAUDE_CODE_OAUTH_TOKEN is set in the spawn environment; mixing token-env auth ' +
        'with an OAuth-file-mode config dir is refused (blueprint §4.1, issue-#37512 class). ' +
        'Unset it, or wait for the rung-2 setup-token path (SI-2 canary-gated).',
    );
  }
}

/** `--bare` requested on a subscription profile — disables OAuth; refused. */
export class BareModeRefusedError extends KernelError {
  override readonly name = 'BareModeRefusedError';
  constructor() {
    super(
      'bad-request',
      '--bare is refused on subscription profiles: it reads only ANTHROPIC_API_KEY/apiKeyHelper ' +
        'and disables subscription OAuth entirely (blueprint §4.1; x1 findings).',
    );
  }
}

/**
 * Un-forked resume of a session whose child is (or must be presumed) alive:
 * live in this broker, or a `running` ledger row whose recorded pid+nonce
 * probe verified the child still running (blueprint §5 guardrail).
 */
export class DoubleResumeError extends KernelError {
  override readonly name = 'DoubleResumeError';
  constructor(sessionId: string, reason?: string) {
    super(
      'double-resume-blocked',
      reason ??
        `session ${sessionId} is running in this broker; un-forked double-resume is blocked — ` +
          'resume with fork:true to branch a continuation child (blueprint §5 guardrail)',
    );
  }
}

/** No resume-ledger row for the referenced harness session id. */
export class SessionNotFoundKernelError extends KernelError {
  override readonly name = 'SessionNotFoundKernelError';
  constructor(sessionId: string) {
    super('session-not-found', `no resume_ledger row for session ${sessionId}`);
  }
}

/** Session exists but cannot be resumed (state/validator refusal). */
export class SessionNotResumableError extends KernelError {
  override readonly name = 'SessionNotResumableError';
  constructor(sessionId: string, reason: string) {
    super('session-not-resumable', `session ${sessionId} is not resumable: ${reason}`);
  }
}

/** Kernel is shutting down; no new spawns are accepted. */
export class KernelShutdownError extends KernelError {
  override readonly name = 'KernelShutdownError';
  constructor() {
    super('internal', 'kernel is shutting down; spawn refused', { retryable: true });
  }
}

/**
 * The REAL claude spawn path was invoked without the explicit live-spawn
 * opt-in. Real-account runs are T3 pending-owner (docs/runbooks/
 * kernel-live-spawn.md); tests and default composition use the fake runner.
 */
export class LiveSpawnDisabledError extends KernelError {
  override readonly name = 'LiveSpawnDisabledError';
  constructor() {
    super(
      'bad-request',
      'live claude spawn is disabled: pass liveSpawn.enabled=true (explicit opt-in config) ' +
        'to compose the SDK query runner. Real-account runs are T3 owner-gated.',
    );
  }
}
