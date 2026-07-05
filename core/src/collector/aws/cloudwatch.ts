/**
 * CloudWatch AWS/Bedrock poller — interface + normalizer + FAKES ONLY (BE-5
 * source 6b; blueprint §6.1 "Bedrock real USD" row: "CloudWatch AWS/Bedrock
 * every 5–15 min while active (tokens, TTFT, throttles)"; findings
 * observability.md §5.4 metric names).
 *
 * Same hard gate as costExplorer.ts: the poller codes against
 * {@link CloudWatchBedrockClient}; {@link createLiveCloudWatchClient} throws
 * {@link LiveAwsDisabledError} unless the owner opts in AND injects the AWS
 * caller. Live polls are SI-4-gated pending-owner; tests use fakes ONLY.
 *
 * ACTIVITY GATE: the poller only fetches while `isActive()` says Bedrock
 * traffic is plausible (an OpenCode session ran recently) — an idle harness
 * never accrues CloudWatch API charges.
 */

import type { AccountLabel } from '@aibender/protocol';
import { backendForLabel, isAccountLabel } from '@aibender/protocol';
import type { EventsTableStore, NewEventRow } from '@aibender/schema';

import { CollectorError, LiveAwsDisabledError } from '../errors.js';
import { scrubIdentityText } from '../identity.js';

// ---------------------------------------------------------------------------
// Client interface + sample shape
// ---------------------------------------------------------------------------

/** One per-model, per-period metric sample (already aggregated client-side). */
export interface BedrockMetricSample {
  readonly modelId: string;
  /** Period start, epoch ms. */
  readonly periodStartMs: number;
  readonly periodSeconds: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly invocations?: number;
  readonly throttles?: number;
  /** Average InvocationLatency over the period, ms. */
  readonly avgLatencyMs?: number;
  /** Average TimeToFirstToken over the period, ms. */
  readonly avgTtftMs?: number;
}

export interface CloudWatchBedrockClient {
  fetchBedrockSamples(range: {
    readonly sinceMs: number;
    readonly untilMs: number;
  }): Promise<readonly BedrockMetricSample[]>;
}

function count(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/** Normalize one sample into events rows (usage row + optional throttle row). */
export function normalizeBedrockSample(
  account: AccountLabel,
  sample: BedrockMetricSample,
): readonly NewEventRow[] {
  const model = scrubIdentityText(sample.modelId);
  const key = `${model}:${String(sample.periodStartMs)}`;
  const inputTokens = count(sample.inputTokens);
  const outputTokens = count(sample.outputTokens);
  const cacheReadTokens = count(sample.cacheReadTokens);
  const cacheCreationTokens = count(sample.cacheWriteTokens);
  const latencyMs = count(sample.avgLatencyMs);
  const ttftMs = count(sample.avgTtftMs);
  const throttles = count(sample.throttles) ?? 0;

  const rows: NewEventRow[] = [
    {
      tsMs: sample.periodStartMs,
      backend: 'opencode',
      account,
      source: 'bedrock-cloudwatch',
      eventType: 'bedrock_usage_period',
      rawRef: `bedrock-cw:${key}`,
      model,
      provider: 'amazon-bedrock',
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      ...(ttftMs !== undefined ? { ttftMs } : {}),
    },
  ];
  if (throttles > 0) {
    rows.push({
      tsMs: sample.periodStartMs,
      backend: 'opencode',
      account,
      source: 'bedrock-cloudwatch',
      eventType: 'bedrock_throttle_period',
      rawRef: `bedrock-cw-throttle:${key}`,
      model,
      provider: 'amazon-bedrock',
      ok: false,
      errorKind: 'throttle',
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Poller
// ---------------------------------------------------------------------------

export interface CloudWatchPollerStats {
  readonly polls: number;
  readonly skippedNotDue: number;
  readonly skippedInactive: number;
  readonly rowsInserted: number;
  readonly rowsDeduped: number;
}

export interface CloudWatchPoller {
  poll(): Promise<number>;
  stats(): CloudWatchPollerStats;
}

export interface CloudWatchPollerOptions {
  readonly client: CloudWatchBedrockClient;
  readonly events: EventsTableStore;
  readonly account: AccountLabel;
  /** TRUE while Bedrock traffic is plausible (recent OpenCode activity). */
  readonly isActive: () => boolean;
  /** Poll floor. Default 5 min (the "5–15 min while active" band). */
  readonly minIntervalMs?: number;
  /** Lookback per poll. Default 15 min. */
  readonly lookbackMs?: number;
  readonly nowMs?: () => number;
}

export function createCloudWatchPoller(options: CloudWatchPollerOptions): CloudWatchPoller {
  if (!isAccountLabel(options.account) || backendForLabel(options.account) !== 'opencode') {
    throw new CollectorError(
      `CloudWatch AWS/Bedrock polling targets the opencode label — got ${String(options.account)}`,
    );
  }
  const nowMs = options.nowMs ?? Date.now;
  const minIntervalMs = options.minIntervalMs ?? 5 * 60 * 1000;
  const lookbackMs = options.lookbackMs ?? 15 * 60 * 1000;

  let lastPollMs = -Infinity;
  const stats = {
    polls: 0,
    skippedNotDue: 0,
    skippedInactive: 0,
    rowsInserted: 0,
    rowsDeduped: 0,
  };

  return {
    poll: async () => {
      const now = nowMs();
      if (now - lastPollMs < minIntervalMs) {
        stats.skippedNotDue += 1;
        return 0;
      }
      if (!options.isActive()) {
        stats.skippedInactive += 1;
        return 0;
      }
      lastPollMs = now;
      stats.polls += 1;
      const samples = await options.client.fetchBedrockSamples({
        sinceMs: now - lookbackMs,
        untilMs: now,
      });
      let inserted = 0;
      for (const sample of samples) {
        for (const row of normalizeBedrockSample(options.account, sample)) {
          const outcome = options.events.insert(row);
          if (outcome.inserted) {
            stats.rowsInserted += 1;
            inserted += 1;
          } else {
            stats.rowsDeduped += 1; // overlapping lookbacks dedupe by period
          }
        }
      }
      return inserted;
    },

    stats: () => ({ ...stats }),
  };
}

// ---------------------------------------------------------------------------
// The LIVE client — construction-gated shell (SI-4 pending-owner)
// ---------------------------------------------------------------------------

export interface LiveCloudWatchClientOptions {
  readonly enableLiveAws: boolean;
  /** The actual AWS GetMetricData invocation, owner-injected. */
  readonly callGetMetricData: (range: {
    readonly sinceMs: number;
    readonly untilMs: number;
  }) => Promise<readonly BedrockMetricSample[]>;
}

export function createLiveCloudWatchClient(
  options: LiveCloudWatchClientOptions,
): CloudWatchBedrockClient {
  if (options.enableLiveAws !== true) {
    throw new LiveAwsDisabledError('CloudWatch');
  }
  return { fetchBedrockSamples: (range) => options.callGetMetricData(range) };
}
