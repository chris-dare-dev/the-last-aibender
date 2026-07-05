/**
 * Cost Explorer poller — interface + normalizer + FAKES ONLY (BE-5 source 6;
 * blueprint §6.1 "Bedrock real USD" row: "Cost Explorer 1–2×/day
 * (authoritative, ~24 h lag)"; findings observability.md §5: each paginated
 * request costs $0.01 — poll once or twice a day, never continuously).
 *
 * HARD RULES (task rule 3): NO live AWS call happens anywhere in tests or by
 * default composition. The poller codes against {@link CostExplorerClient};
 * the live implementation is a construction-gated shell
 * ({@link createLiveCostExplorerClient}) that throws
 * {@link LiveAwsDisabledError} unless the OWNER passes `enableLiveAws: true`
 * AND injects the actual AWS caller. Until SI-4's plan is applied, BE-5 runs
 * ESTIMATE-ONLY with an honest freshness state (plan §7 "[X4]…estimate-only
 * mode with an honest freshness state"; the state itself renders via BE-6).
 *
 * Backfill semantics (plan §9.2 BE-5 edge "Cost Explorer backfill overwrites
 * estimate not raw"): each polled day upserts ONE daily actuals row
 * (raw_ref `bedrock-ce:<YYYY-MM-DD>`); a re-poll of an existing day routes
 * through the store's `backfillCostActual`, which writes `cost_actual_usd`
 * ONLY — estimates and raw fields are untouchable by construction
 * (@aibender/schema, FROZEN-M3).
 */

import type { AccountLabel } from '@aibender/protocol';
import { backendForLabel, isAccountLabel } from '@aibender/protocol';
import type { EventsTableStore } from '@aibender/schema';

import { CollectorError, LiveAwsDisabledError } from '../errors.js';

// ---------------------------------------------------------------------------
// Client interface (AWS-shaped subset; fakes implement this)
// ---------------------------------------------------------------------------

/** Minimal GetCostAndUsage response slice the normalizer consumes. */
export interface CostAndUsageResponse {
  readonly resultsByTime: readonly {
    readonly timePeriod: { readonly start: string; readonly end: string };
    readonly total?: {
      readonly unblendedCost?: { readonly amount?: string; readonly unit?: string };
    };
  }[];
}

export interface CostExplorerClient {
  /**
   * DAILY granularity, SERVICE = Amazon Bedrock filter — the query shape is
   * the client's contract; the poller only supplies the date range.
   */
  getBedrockDailyCost(range: { readonly startDate: string; readonly endDate: string }): Promise<
    CostAndUsageResponse
  >;
}

/** Normalize a response into (day, usd) pairs; malformed entries skipped. */
export function normalizeCostAndUsage(
  response: CostAndUsageResponse,
): readonly { readonly date: string; readonly usd: number }[] {
  const out: { date: string; usd: number }[] = [];
  for (const entry of response.resultsByTime) {
    const amount = entry.total?.unblendedCost?.amount;
    const usd = amount !== undefined ? Number(amount) : Number.NaN;
    const date = entry.timePeriod.start;
    if (!Number.isFinite(usd) || usd < 0) continue;
    if (!/^\d{4}-\d{2}-\d{2}/.test(date)) continue;
    out.push({ date: date.slice(0, 10), usd });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Poller
// ---------------------------------------------------------------------------

export interface CostExplorerPollerStats {
  readonly polls: number;
  readonly skippedNotDue: number;
  readonly daysInserted: number;
  readonly daysBackfilled: number;
}

export interface CostExplorerPoller {
  /**
   * One scheduling pass. Fetches the trailing window at most every
   * `minIntervalMs` (default 12 h — "1–2×/day"). Returns days touched.
   */
  poll(): Promise<number>;
  /** `actuals` once a poll succeeded; `estimate-only` until then. */
  freshness(): 'estimate-only' | 'actuals';
  stats(): CostExplorerPollerStats;
}

export interface CostExplorerPollerOptions {
  readonly client: CostExplorerClient;
  readonly events: EventsTableStore;
  /** The Bedrock label (AWS_DEV). */
  readonly account: AccountLabel;
  /** Poll floor. Default 12 h. */
  readonly minIntervalMs?: number;
  /** Trailing window to (re)fetch, days. Default 3 (covers the ~24 h lag). */
  readonly windowDays?: number;
  readonly nowMs?: () => number;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function createCostExplorerPoller(options: CostExplorerPollerOptions): CostExplorerPoller {
  if (!isAccountLabel(options.account) || backendForLabel(options.account) !== 'opencode') {
    throw new CollectorError(
      `Cost Explorer backfill targets the Bedrock/opencode label — got ${String(options.account)}`,
    );
  }
  const nowMs = options.nowMs ?? Date.now;
  const minIntervalMs = options.minIntervalMs ?? 12 * 60 * 60 * 1000;
  const windowDays = options.windowDays ?? 3;

  let lastPollMs = -Infinity;
  let everSucceeded = false;
  const stats = { polls: 0, skippedNotDue: 0, daysInserted: 0, daysBackfilled: 0 };

  return {
    poll: async () => {
      const now = nowMs();
      if (now - lastPollMs < minIntervalMs) {
        stats.skippedNotDue += 1;
        return 0;
      }
      lastPollMs = now;
      stats.polls += 1;
      const response = await options.client.getBedrockDailyCost({
        startDate: isoDay(now - windowDays * 24 * 60 * 60 * 1000),
        endDate: isoDay(now),
      });
      const days = normalizeCostAndUsage(response);
      let touched = 0;
      for (const { date, usd } of days) {
        const rawRef = `bedrock-ce:${date}`;
        const outcome = options.events.insert({
          tsMs: Date.parse(`${date}T00:00:00.000Z`),
          backend: 'opencode',
          account: options.account,
          source: 'bedrock-cost-explorer',
          eventType: 'cost_actual_daily',
          rawRef,
          costActualUsd: usd,
        });
        if (outcome.inserted) {
          stats.daysInserted += 1;
        } else {
          // Existing day: authoritative re-backfill — writes cost_actual_usd
          // ONLY (estimate and raw fields untouched, accessor-enforced).
          options.events.backfillCostActual('opencode', rawRef, usd);
          stats.daysBackfilled += 1;
        }
        touched += 1;
      }
      everSucceeded = everSucceeded || days.length > 0 || response.resultsByTime.length > 0;
      return touched;
    },

    freshness: () => (everSucceeded ? 'actuals' : 'estimate-only'),
    stats: () => ({ ...stats }),
  };
}

// ---------------------------------------------------------------------------
// The LIVE client — construction-gated shell (SI-4 pending-owner)
// ---------------------------------------------------------------------------

export interface LiveCostExplorerClientOptions {
  /** MUST be literally true — owner's call after SI-4 applies. */
  readonly enableLiveAws: boolean;
  /**
   * The actual AWS invocation, injected by owner-run composition (an AWS SDK
   * GetCostAndUsage call under the SSO profile). Never provided in tests.
   */
  readonly callGetCostAndUsage: (range: {
    readonly startDate: string;
    readonly endDate: string;
  }) => Promise<CostAndUsageResponse>;
}

export function createLiveCostExplorerClient(
  options: LiveCostExplorerClientOptions,
): CostExplorerClient {
  if (options.enableLiveAws !== true) {
    throw new LiveAwsDisabledError('Cost Explorer');
  }
  return { getBedrockDailyCost: (range) => options.callGetCostAndUsage(range) };
}
