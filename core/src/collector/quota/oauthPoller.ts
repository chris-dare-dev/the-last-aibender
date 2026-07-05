/**
 * Idle-account OAuth usage poller — SCAFFOLD (BE-5 source 2 fallback;
 * blueprint §6.1 quota row: "undocumented OAuth usage endpoint polled
 * ≤1/10–15 min ONLY for idle accounts, with backoff"; findings
 * observability.md §3: `GET api.anthropic.com/api/oauth/usage`, beta header,
 * aggressive 429s → fallback only).
 *
 * SCAFFOLD means: the polling ENGINE (idleness gate, per-account
 * rate-limit floor, exponential 429 backoff, snapshot normalization into
 * `quota_snapshots` with source `oauth-poll`) is fully built and FAKE-TESTED;
 * the LIVE client is hard-gated:
 *
 *   - {@link createLiveOauthUsageClient} throws {@link LiveOauthDisabledError}
 *     unless constructed with `enableLiveOauth: true` AND an injected
 *     `tokenProvider` (the OAuth token lives in the macOS Keychain — fetched
 *     at call time by owner-run composition, NEVER serialized [X2]).
 *   - No test constructs a live client with the flag on. Wiring + first live
 *     poll is a T3 pending-owner item.
 *
 * The endpoint returns `five_hour` / `seven_day` / `seven_day_sonnet`
 * objects with `utilization` (0–1) and `resets_at` — note the 0–1 scale
 * (statusline uses 0–100); the normalizer converts.
 */

import type { AccountLabel, QuotaWindow } from '@aibender/protocol';
import { backendForLabel, isAccountLabel } from '@aibender/protocol';
import type { QuotaSnapshotsStore } from '@aibender/schema';

import { CollectorError, LiveOauthDisabledError } from '../errors.js';

// ---------------------------------------------------------------------------
// Client interface (fakes implement this; the live client is gated)
// ---------------------------------------------------------------------------

export interface OauthUsageWindow {
  readonly window: QuotaWindow;
  /** 0–100 (the client normalizes the endpoint's 0–1 `utilization`). */
  readonly usedPct: number;
  readonly resetsAtMs: number;
}

export type OauthUsageFetchResult =
  | { readonly status: 'ok'; readonly windows: readonly OauthUsageWindow[] }
  /** HTTP 429 — the poller backs off exponentially. */
  | { readonly status: 'rate-limited' }
  | { readonly status: 'error'; readonly message: string };

export interface OauthUsageClient {
  fetchUsage(account: AccountLabel): Promise<OauthUsageFetchResult>;
}

// ---------------------------------------------------------------------------
// Backoff policy
// ---------------------------------------------------------------------------

export interface OauthBackoffPolicy {
  /** Minimum spacing between polls per account. Default 10 min. */
  readonly minIntervalMs: number;
  /** First backoff step after a 429. Default = minIntervalMs. */
  readonly backoffInitialMs: number;
  /** Backoff ceiling. Default 60 min. */
  readonly backoffMaxMs: number;
}

export const DEFAULT_OAUTH_BACKOFF: OauthBackoffPolicy = Object.freeze({
  minIntervalMs: 10 * 60 * 1000,
  backoffInitialMs: 10 * 60 * 1000,
  backoffMaxMs: 60 * 60 * 1000,
});

// ---------------------------------------------------------------------------
// The poller engine (fake-tested; the live client never enters tests)
// ---------------------------------------------------------------------------

export interface OauthPollerStats {
  readonly polls: number;
  readonly skippedNotIdle: number;
  readonly skippedNotDue: number;
  readonly rateLimited: number;
  readonly errors: number;
  readonly snapshotsInserted: number;
}

export interface IdleAccountOauthPoller {
  /**
   * One scheduling pass: for each account that is IDLE (no live session
   * emitting statusline ticks) and DUE (rate-limit floor + backoff), fetch
   * and ingest. Returns snapshots inserted this pass.
   */
  tick(): Promise<number>;
  /** Next epoch-ms an account may poll (backoff observability). */
  nextEligibleAtMs(account: AccountLabel): number;
  stats(): OauthPollerStats;
}

export interface IdleAccountOauthPollerOptions {
  readonly client: OauthUsageClient;
  readonly store: QuotaSnapshotsStore;
  /** Claude accounts to poll (claude_code labels only). */
  readonly accounts: readonly AccountLabel[];
  /** TRUE when the account has no live session (statusline is silent). */
  readonly isIdle: (account: AccountLabel) => boolean;
  readonly policy?: Partial<OauthBackoffPolicy>;
  /** Injectable clock (epoch ms). */
  readonly nowMs?: () => number;
}

export function createIdleAccountOauthPoller(
  options: IdleAccountOauthPollerOptions,
): IdleAccountOauthPoller {
  for (const account of options.accounts) {
    if (!isAccountLabel(account) || backendForLabel(account) !== 'claude_code') {
      throw new CollectorError(
        `OAuth usage polling is a claude_code feed — got ${String(account)}`,
      );
    }
  }
  const policy: OauthBackoffPolicy = {
    minIntervalMs: options.policy?.minIntervalMs ?? DEFAULT_OAUTH_BACKOFF.minIntervalMs,
    backoffInitialMs: options.policy?.backoffInitialMs ?? DEFAULT_OAUTH_BACKOFF.backoffInitialMs,
    backoffMaxMs: options.policy?.backoffMaxMs ?? DEFAULT_OAUTH_BACKOFF.backoffMaxMs,
  };
  const nowMs = options.nowMs ?? Date.now;

  const nextEligible = new Map<AccountLabel, number>();
  const backoffMs = new Map<AccountLabel, number>();
  const stats = {
    polls: 0,
    skippedNotIdle: 0,
    skippedNotDue: 0,
    rateLimited: 0,
    errors: 0,
    snapshotsInserted: 0,
  };

  return {
    tick: async () => {
      let inserted = 0;
      for (const account of options.accounts) {
        const now = nowMs();
        if ((nextEligible.get(account) ?? 0) > now) {
          stats.skippedNotDue += 1;
          continue;
        }
        if (!options.isIdle(account)) {
          // A live session's statusline tee is fresher AND free — never
          // spend a 429-prone poll on an active account.
          stats.skippedNotIdle += 1;
          continue;
        }
        stats.polls += 1;
        const result = await options.client.fetchUsage(account);
        if (result.status === 'rate-limited') {
          // Exponential backoff, capped (findings: aggressive 429s).
          const step = backoffMs.get(account) ?? policy.backoffInitialMs;
          nextEligible.set(account, now + step);
          backoffMs.set(account, Math.min(step * 2, policy.backoffMaxMs));
          stats.rateLimited += 1;
          continue;
        }
        // Success and plain errors both reset to the rate-limit floor —
        // an erroring undocumented endpoint must not be hammered either.
        nextEligible.set(account, now + policy.minIntervalMs);
        backoffMs.delete(account);
        if (result.status === 'error') {
          stats.errors += 1;
          continue;
        }
        for (const window of result.windows) {
          const outcome = options.store.insert({
            account,
            window: window.window,
            usedPct: Math.min(100, Math.max(0, window.usedPct)),
            resetsAtMs: window.resetsAtMs,
            capturedAtMs: now,
            source: 'oauth-poll',
          });
          if (outcome.inserted) {
            stats.snapshotsInserted += 1;
            inserted += 1;
          }
        }
      }
      return inserted;
    },

    nextEligibleAtMs: (account) => nextEligible.get(account) ?? 0,
    stats: () => ({ ...stats }),
  };
}

// ---------------------------------------------------------------------------
// The LIVE client — hard-gated (T3 pending-owner; tests use fakes ONLY)
// ---------------------------------------------------------------------------

export interface LiveOauthUsageClientOptions {
  /** MUST be literally true, decided by the owner at composition time. */
  readonly enableLiveOauth: boolean;
  /**
   * Keychain-backed token fetch, injected by owner-run composition. Called
   * per request; the token is never cached or serialized [X2].
   */
  readonly tokenProvider: (account: AccountLabel) => Promise<string>;
  readonly fetchFn?: typeof fetch;
  /** Endpoint override for the eventual live-check harness. */
  readonly endpoint?: string;
}

export const OAUTH_USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
export const OAUTH_USAGE_BETA_HEADER = 'oauth-2025-04-20';

const OAUTH_WINDOW_KEYS: readonly (readonly [string, QuotaWindow])[] = [
  ['five_hour', '5h'],
  ['seven_day', '7d'],
  ['seven_day_sonnet', '7d_sonnet'],
];

/** Decode one usage-endpoint body into windows (exported for fake parity). */
export function decodeOauthUsageBody(body: unknown): readonly OauthUsageWindow[] {
  if (typeof body !== 'object' || body === null) return [];
  const record = body as Record<string, unknown>;
  const windows: OauthUsageWindow[] = [];
  for (const [key, window] of OAUTH_WINDOW_KEYS) {
    const entry = record[key];
    if (typeof entry !== 'object' || entry === null) continue;
    const fields = entry as Record<string, unknown>;
    const utilization = fields['utilization'];
    if (typeof utilization !== 'number' || !Number.isFinite(utilization)) continue;
    const resetsRaw = fields['resets_at'];
    let resetsAtMs: number | undefined;
    if (typeof resetsRaw === 'string') {
      const parsed = Date.parse(resetsRaw);
      if (Number.isFinite(parsed) && parsed >= 0) resetsAtMs = parsed;
    } else if (typeof resetsRaw === 'number' && Number.isFinite(resetsRaw) && resetsRaw >= 0) {
      resetsAtMs = resetsRaw < 1e12 ? Math.round(resetsRaw * 1000) : Math.round(resetsRaw);
    }
    if (resetsAtMs === undefined) continue;
    windows.push({
      window,
      usedPct: Math.min(100, Math.max(0, utilization * 100)),
      resetsAtMs,
    });
  }
  return windows;
}

/**
 * Construct the live client. THROWS {@link LiveOauthDisabledError} unless the
 * owner passed `enableLiveOauth: true` — the default composition, and every
 * test, stays on fakes. Real OAuth calls are a T3 pending-owner proof.
 */
export function createLiveOauthUsageClient(options: LiveOauthUsageClientOptions): OauthUsageClient {
  if (options.enableLiveOauth !== true) {
    throw new LiveOauthDisabledError();
  }
  const fetchFn = options.fetchFn ?? fetch;
  const endpoint = options.endpoint ?? OAUTH_USAGE_ENDPOINT;
  return {
    fetchUsage: async (account) => {
      let token: string;
      try {
        token = await options.tokenProvider(account);
      } catch (cause) {
        return { status: 'error', message: `token fetch failed: ${(cause as Error).message}` };
      }
      let response: Response;
      try {
        response = await fetchFn(endpoint, {
          headers: {
            authorization: `Bearer ${token}`,
            'anthropic-beta': OAUTH_USAGE_BETA_HEADER,
          },
        });
      } catch (cause) {
        return { status: 'error', message: (cause as Error).message };
      }
      if (response.status === 429) return { status: 'rate-limited' };
      if (!response.ok) {
        return { status: 'error', message: `usage endpoint answered ${String(response.status)}` };
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { status: 'error', message: 'usage endpoint answered non-JSON' };
      }
      return { status: 'ok', windows: decodeOauthUsageBody(body) };
    },
  };
}
