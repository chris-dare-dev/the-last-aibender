/**
 * Typed adapter errors (BE-4). Mirrors the kernel's discipline
 * (core/src/kernel/errors.ts): every refusal an adapter makes is a TYPED
 * error carrying a protocol {@link ErrorCode}, so BE-3's control channel can
 * answer `{ ok:false, error }` without string-matching messages.
 *
 * Messages are identifier-free by construction [X2]: they name Keychain item
 * NAMES, env-var NAMES, table NAMES and placeholder labels — never secret
 * values, real emails, account ids, or machine-local paths.
 */

import type { ErrorCode } from '@aibender/protocol';

/** Base class: every adapter refusal maps to a protocol {@link ErrorCode}. */
export class AdapterError extends Error {
  override readonly name: string = 'AdapterError';
  readonly code: ErrorCode;
  /** True when the same request may legitimately be retried. */
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

/**
 * A real `opencode serve` child would have been spawned without the explicit
 * live opt-in flag. Mirrors the kernel's LiveSpawnDisabledError: no code path
 * may construct the real supervisor by accident (plan §4/BE-4; rule: real
 * spawns are deliberate, opt-in composition-root decisions).
 */
export class LiveServeDisabledError extends AdapterError {
  override readonly name = 'LiveServeDisabledError';
  constructor() {
    super(
      'bad-request',
      'live opencode serve spawn is disabled — construct the supervisor with ' +
        '{ liveServeOptIn: true } from explicit operator config to enable it',
    );
  }
}

/**
 * The real Keychain secret fetcher would have been constructed without the
 * explicit live opt-in. `security find-generic-password -w` runs ONLY at
 * spawn time in live mode (plan §4/BE-4; External System Write Policy keeps
 * even reads deliberate in this build).
 */
export class LiveKeychainDisabledError extends AdapterError {
  override readonly name = 'LiveKeychainDisabledError';
  constructor() {
    super(
      'bad-request',
      'live Keychain secret fetching is disabled — construct the fetcher with ' +
        '{ liveKeychainOptIn: true } from explicit operator config to enable it',
    );
  }
}

/** A Keychain item could not be fetched. Names the ITEM, never a value [X2]. */
export class KeychainItemUnavailableError extends AdapterError {
  override readonly name = 'KeychainItemUnavailableError';
  readonly itemName: string;
  constructor(itemName: string) {
    super('internal', `keychain item ${JSON.stringify(itemName)} could not be fetched`, {
      retryable: true,
    });
    this.itemName = itemName;
  }
}

/** The supervised serve child did not report a listening URL in time. */
export class ServeStartTimeoutError extends AdapterError {
  override readonly name = 'ServeStartTimeoutError';
  constructor(timeoutMs: number) {
    super('internal', `opencode serve did not report a listening URL within ${timeoutMs} ms`, {
      retryable: true,
    });
  }
}

/** The supervised serve child exited before (or instead of) becoming ready. */
export class ServeExitedError extends AdapterError {
  override readonly name = 'ServeExitedError';
  constructor(detail: string) {
    super('internal', `opencode serve exited: ${detail}`, { retryable: true });
  }
}

/**
 * [X2] hard guard: a statement against `opencode.db` referenced a forbidden
 * table (`account`/`credential`) — or was not a plain read. Fail-closed;
 * see dbAccess.ts for the exact rule.
 */
export class ForbiddenDbStatementError extends AdapterError {
  override readonly name = 'ForbiddenDbStatementError';
  constructor(reason: string) {
    super('bad-request', `opencode.db statement refused: ${reason}`);
  }
}

/**
 * The real `lms` CLI would have been shelled without the explicit live
 * opt-in. Lifecycle verbs are behind an interface; the CLI-backed
 * implementation is a deliberate composition-root decision.
 */
export class LiveLmsCliDisabledError extends AdapterError {
  override readonly name = 'LiveLmsCliDisabledError';
  constructor() {
    super(
      'bad-request',
      'live lms CLI lifecycle is disabled — construct with { liveCliOptIn: true } ' +
        'from explicit operator config to enable it',
    );
  }
}

/**
 * A local-model load request was refused by the residency policy (over the
 * default cap without opt-in, over the global resident budget, …). Carries a
 * machine-readable reason so callers can present a precise decision.
 */
export class ResidencyDeniedError extends AdapterError {
  override readonly name = 'ResidencyDeniedError';
  readonly reason: string;
  constructor(reason: string, message: string) {
    super('bad-request', message);
    this.reason = reason;
  }
}
