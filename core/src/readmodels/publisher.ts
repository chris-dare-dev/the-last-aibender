/**
 * Read-model snapshot publication (BE-6; plan §4/BE-6 item 3): compute the
 * ten §6.3 dashboard leads over the events store, attach per-source
 * freshness, and publish onto the gateway — `read-model-snapshot` payloads
 * on the EVENTS channel and `quota-snapshot` payloads on the QUOTA channel,
 * exactly per the FROZEN payload unions (ws-protocol.md §11/§13).
 *
 * Seam discipline: {@link ReadModelSink} is a structural subset of the BE-3
 * GatewayHandle (`publishEvent` + `publishQuota`) — the composition root
 * (core/src/main/, BE-ORCH) passes the live handle straight in.
 *
 * SELF-VALIDATION: every snapshot is passed through the frozen
 * `validateEventsPayload` (and every quota push through
 * `validateQuotaSnapshot`, gateway-side) BEFORE publication. An invalid
 * snapshot here is a programmer error, so it THROWS (RangeError) — the same
 * discipline as the gateway's own publish guards; it is never a wire
 * condition and never a fabricated frame.
 *
 * FRESHNESS, NEVER ERRORS: a missing feed publishes honest empties (no
 * gauges, no entries) with `no-signal` freshness entries. publishQuota
 * publishes NOTHING when no quota rows exist — the broker never fabricates
 * a snapshot (plan §9.2 BE-6 negative row).
 */

import {
  validateEventsPayload,
  type EventSource,
  type QuotaSnapshot,
  type ReadModelId,
  type ReadModelSnapshot,
  type SourceFreshness,
} from '@aibender/protocol';

import type { FreshnessTracker } from './freshness.js';
import {
  apiEquivalentUsdData,
  bedrockCostData,
  burnRateData,
  cacheHitRateData,
  healthData,
  latencyData,
  localOffloadData,
  quotaGaugesData,
  sessionOutcomesData,
  skillLeaderboardData,
  type ReadModelStores,
} from './projections.js';

// ---------------------------------------------------------------------------
// Ports / options
// ---------------------------------------------------------------------------

/** Structural subset of the BE-3 GatewayHandle. */
export interface ReadModelSink {
  publishEvent(payload: Readonly<Record<string, unknown>>): void;
  publishQuota(snapshot: QuotaSnapshot): void;
}

/**
 * Which §6.1 feeds each read model reports freshness for. Publisher config
 * (not frozen wire vocabulary — the frozen part is that `sources` is
 * REQUIRED and non-empty); overridable per deployment via
 * {@link ReadModelPublisherOptions.sourcesByModel}.
 */
export const DEFAULT_READ_MODEL_SOURCES: Readonly<Record<ReadModelId, readonly EventSource[]>> =
  Object.freeze({
    'quota-gauges': ['claude-quota'],
    'burn-rate': ['claude-jsonl', 'claude-quota'],
    'bedrock-cost': ['bedrock-cost-explorer', 'opencode-sse'],
    'api-equivalent-usd': ['claude-jsonl', 'opencode-sse', 'lmstudio'],
    'cache-hit-rate': ['claude-jsonl'],
    latency: ['claude-otel', 'opencode-sse', 'lmstudio'],
    health: ['claude-jsonl', 'claude-otel', 'opencode-sse', 'lmstudio'],
    'skill-leaderboard': ['claude-jsonl', 'lmstudio'],
    'session-outcomes': ['claude-jsonl'],
    'local-offload': ['lmstudio', 'claude-jsonl', 'opencode-sse'],
  });

export interface ReadModelPublisherOptions {
  readonly stores: ReadModelStores;
  readonly sink: ReadModelSink;
  readonly freshness: FreshnessTracker;
  /** Epoch-ms clock, injectable for tests. Default Date.now. */
  readonly clock?: () => number;
  /** Aggregation window for the windowed leads. Default 7 days. */
  readonly windowDays?: number;
  /** Health lead rolling window. Default 60 minutes. */
  readonly healthWindowMinutes?: number;
  /** Correction rates from ./classification.ts (absent until wired). */
  readonly correctionRatePctBySkill?: () => ReadonlyMap<string, number>;
  /** Per-model freshness source sets; merged over the defaults. */
  readonly sourcesByModel?: Partial<Record<ReadModelId, readonly EventSource[]>>;
}

export interface ReadModelPublisher {
  /** Compute all ten snapshots (validated, in blueprint §6.3 order). */
  snapshotAll(): readonly ReadModelSnapshot[];
  /** Compute + publish all ten onto the events channel. */
  publishAll(): readonly ReadModelSnapshot[];
  /**
   * Publish the latest per-(account, window) quota rows onto the QUOTA
   * channel (frozen §11 shape). Returns how many were published — zero when
   * the store is empty (never a fabricated snapshot).
   */
  publishQuotaSnapshots(): number;
}

// ---------------------------------------------------------------------------
// createReadModelPublisher
// ---------------------------------------------------------------------------

export function createReadModelPublisher(options: ReadModelPublisherOptions): ReadModelPublisher {
  const clock = options.clock ?? Date.now;
  const windowDays = options.windowDays ?? 7;
  const healthWindowMinutes = options.healthWindowMinutes ?? 60;
  const stores = options.stores;
  const sourcesByModel: Record<ReadModelId, readonly EventSource[]> = {
    ...DEFAULT_READ_MODEL_SOURCES,
    ...options.sourcesByModel,
  };

  const sourcesFor = (readModel: ReadModelId, nowMs: number): readonly SourceFreshness[] =>
    options.freshness.snapshotFor(sourcesByModel[readModel], nowMs);

  /** The frozen validator is the last gate before the sink (see module doc). */
  const checked = (snapshot: ReadModelSnapshot): ReadModelSnapshot => {
    const result = validateEventsPayload(snapshot);
    if (!result.ok) {
      throw new RangeError(
        `refusing to publish an invalid ${snapshot.readModel} snapshot: ${result.message}`,
      );
    }
    return result.value as ReadModelSnapshot;
  };

  const snapshotAll = (): readonly ReadModelSnapshot[] => {
    const nowMs = clock();
    const base = (readModel: ReadModelId): {
      kind: 'read-model-snapshot';
      capturedAt: number;
      sources: readonly SourceFreshness[];
    } => ({
      kind: 'read-model-snapshot',
      capturedAt: nowMs,
      sources: sourcesFor(readModel, nowMs),
    });

    // Quota join for the burn-rate projection: authoritative 5h percents,
    // ONLY while the quota feed is fresh (never a stale-percent projection).
    const quotaFresh = options.freshness.stateOf('claude-quota', nowMs).state === 'fresh';
    const usedPctByAccount = new Map<QuotaSnapshot['account'], number>();
    if (quotaFresh) {
      for (const row of stores.quotaSnapshots.latest()) {
        if (row.window === '5h') usedPctByAccount.set(row.account, row.usedPct);
      }
    }

    const bedrock = bedrockCostData(stores, nowMs);
    // Actuals absent while the Cost Explorer feed never signaled → the
    // overlay is estimate-only BY STATE, not by error (SI-4 gated, §6.3).
    const bedrockSources = sourcesFor('bedrock-cost', nowMs).map((entry) =>
      entry.source === 'bedrock-cost-explorer' && entry.state === 'no-signal' && !bedrock.hasActuals
        ? { ...entry, state: 'estimate-only' as const }
        : entry,
    );

    const correctionRates = options.correctionRatePctBySkill?.();

    return [
      checked({ ...base('quota-gauges'), readModel: 'quota-gauges', data: quotaGaugesData(stores) }),
      checked({
        ...base('burn-rate'),
        readModel: 'burn-rate',
        data: burnRateData(stores, { nowMs, usedPctByAccount }),
      }),
      checked({
        kind: 'read-model-snapshot',
        capturedAt: nowMs,
        sources: bedrockSources,
        readModel: 'bedrock-cost',
        data: bedrock.data,
      }),
      checked({
        ...base('api-equivalent-usd'),
        readModel: 'api-equivalent-usd',
        data: apiEquivalentUsdData(stores, nowMs, windowDays),
      }),
      checked({
        ...base('cache-hit-rate'),
        readModel: 'cache-hit-rate',
        data: cacheHitRateData(stores, nowMs, windowDays),
      }),
      checked({ ...base('latency'), readModel: 'latency', data: latencyData(stores, nowMs, windowDays) }),
      checked({
        ...base('health'),
        readModel: 'health',
        data: healthData(stores, nowMs, healthWindowMinutes),
      }),
      checked({
        ...base('skill-leaderboard'),
        readModel: 'skill-leaderboard',
        data: skillLeaderboardData(stores, {
          nowMs,
          windowDays,
          ...(correctionRates !== undefined ? { correctionRatePctBySkill: correctionRates } : {}),
        }),
      }),
      checked({
        ...base('session-outcomes'),
        readModel: 'session-outcomes',
        data: sessionOutcomesData(stores, nowMs, windowDays),
      }),
      checked({
        ...base('local-offload'),
        readModel: 'local-offload',
        data: localOffloadData(stores, nowMs, windowDays),
      }),
    ];
  };

  return {
    snapshotAll,

    publishAll: () => {
      const snapshots = snapshotAll();
      for (const snapshot of snapshots) {
        options.sink.publishEvent(snapshot as unknown as Readonly<Record<string, unknown>>);
      }
      return snapshots;
    },

    publishQuotaSnapshots: () => {
      let published = 0;
      for (const row of stores.quotaSnapshots.latest()) {
        // Mirrors the quota_snapshots DDL row exactly (frozen §11); the
        // gateway re-validates and would throw on anything malformed.
        options.sink.publishQuota({
          kind: 'quota-snapshot',
          account: row.account,
          window: row.window,
          usedPct: Math.min(100, Math.max(0, row.usedPct)),
          resetsAt: row.resetsAtMs,
          capturedAt: row.capturedAtMs,
          source: row.source,
        });
        published += 1;
      }
      return published;
    },
  };
}
