/**
 * core/src/adapters — BE-4 backend adapters (plan §4/BE-4; blueprint
 * §4.1–§4.3). Three backends, one directory, symmetric factories:
 *
 *   - opencode/    supervised `opencode serve` + SSE transport + SDK client
 *                  + guarded read-only opencode.db access ([X2])
 *   - lmstudio/    /v1 inference routing, /api/v0 (gated), lms lifecycle,
 *                  JIT+TTL residency engine, down-as-first-class-state
 *   - claude-sdk/  thin wrapper over the M1 kernel QueryRunner seam
 *
 * Every live side effect (serve spawn, Keychain read, lms CLI) sits behind
 * an explicit opt-in flag with a typed refusal — nothing real happens by
 * accident in tests or by default composition.
 */

export {
  AdapterError,
  ForbiddenDbStatementError,
  KeychainItemUnavailableError,
  LiveKeychainDisabledError,
  LiveLmsCliDisabledError,
  LiveServeDisabledError,
  ResidencyDeniedError,
  ServeExitedError,
  ServeStartTimeoutError,
} from './errors.js';

export * from './opencode/index.js';
export * from './lmstudio/index.js';
