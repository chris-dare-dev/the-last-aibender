/**
 * Read-model snapshot payloads — the §6.3 dashboard leads as wire types
 * (blueprint §6.3, in order; plan §4/BE-6 "dashboard read models"; FE-5
 * renders exactly these). They ride the `events` channel as the
 * `read-model-snapshot` kind (events.ts).
 *
 * Design rules frozen here:
 *   - Every snapshot carries an EXPLICIT `sources` array of per-source
 *     freshness ({@link SourceFreshness}) — LM-Studio-down, cluster-absent,
 *     SSO-expired, account-logged-out, estimate-only are STATES, never
 *     errors. A missing feed is `no-signal`; producers NEVER fabricate zeros
 *     for it (plan §9.2 BE-6 negative row).
 *   - Aggregates only. No raw identifiers, no file paths, no native ids —
 *     account is the placeholder label enum [X2].
 *   - Absent optional fields mean "not computable yet" (e.g. Bedrock actuals
 *     before SI-4 / while Cost Explorer is gated; correction rates before the
 *     local-model classification job ran) — the freshness entry says why.
 *
 * ============================================================================
 * FROZEN-M3 (2026-07-04). Amendments only via ICR (docs/contracts/icr/);
 * BE-ORCH lands, FE-ORCH co-signs. Prose of record: docs/contracts/ws-protocol.md.
 * ============================================================================
 */

import type { SourceFreshness } from './events.js';
import type { EventSource } from './events.js';
import type { QuotaWindow } from './quota.js';
import type { AccountLabel, Backend } from './vocab.js';

/** The ten §6.3 dashboard leads, in the blueprint's order. */
export const READ_MODEL_IDS = Object.freeze([
  'quota-gauges',
  'burn-rate',
  'bedrock-cost',
  'api-equivalent-usd',
  'cache-hit-rate',
  'latency',
  'health',
  'skill-leaderboard',
  'session-outcomes',
  'local-offload',
] as const);

export type ReadModelId = (typeof READ_MODEL_IDS)[number];

export function isReadModelId(value: unknown): value is ReadModelId {
  return typeof value === 'string' && (READ_MODEL_IDS as readonly string[]).includes(value);
}

/** Fields shared by every read-model snapshot. */
export interface ReadModelSnapshotBase {
  readonly kind: 'read-model-snapshot';
  readonly readModel: ReadModelId;
  /** Epoch ms the read model was computed. */
  readonly capturedAt: number;
  /** Per-source freshness — at least one entry (every model has a feed). */
  readonly sources: readonly SourceFreshness[];
}

// ---------------------------------------------------------------------------
// 1. Per-account 5h + weekly quota gauges with reset countdowns
// ---------------------------------------------------------------------------

export interface QuotaGauge {
  readonly account: AccountLabel;
  readonly window: QuotaWindow;
  /** 0–100 inclusive. */
  readonly usedPct: number;
  /** Epoch ms; a past value is legal (FE renders "reset due"). */
  readonly resetsAt: number;
}

export interface QuotaGaugesSnapshot extends ReadModelSnapshotBase {
  readonly readModel: 'quota-gauges';
  readonly data: { readonly gauges: readonly QuotaGauge[] };
}

// ---------------------------------------------------------------------------
// 2. Current 5h-block burn rate + projected exhaustion (ccusage block math)
// ---------------------------------------------------------------------------

export interface BurnRateEntry {
  readonly account: AccountLabel;
  /** Current 5 h block boundaries, epoch ms. */
  readonly blockStartAt: number;
  readonly blockEndAt: number;
  /** Burn rate across the four token classes, tokens/hour. */
  readonly tokensPerHour: number;
  /** Quota-joined percentage when the quota feed is fresh. */
  readonly usedPct?: number;
  /** Epoch ms; absent when the burn rate projects no exhaustion. */
  readonly projectedExhaustionAt?: number;
}

export interface BurnRateSnapshot extends ReadModelSnapshotBase {
  readonly readModel: 'burn-rate';
  readonly data: { readonly entries: readonly BurnRateEntry[] };
}

// ---------------------------------------------------------------------------
// 3. Bedrock real USD (MTD + yesterday) with client-side estimate overlay
// ---------------------------------------------------------------------------

export interface BedrockCostSnapshot extends ReadModelSnapshotBase {
  readonly readModel: 'bedrock-cost';
  readonly data: {
    /** Cost Explorer actuals; absent while gated (freshness: estimate-only). */
    readonly actualMtdUsd?: number;
    readonly actualYesterdayUsd?: number;
    /** The client-side estimate overlay — always present, always an estimate. */
    readonly estimateMtdUsd: number;
    /** Cost Explorer lag when actuals are present (~24 h). */
    readonly actualLagHours?: number;
  };
}

// ---------------------------------------------------------------------------
// 4. API-equivalent USD by backend — labeled equivalence, never spend
// ---------------------------------------------------------------------------

export interface ApiEquivalentUsdEntry {
  readonly account: AccountLabel;
  readonly backend: Backend;
  readonly equivalentUsd: number;
}

export interface ApiEquivalentUsdSnapshot extends ReadModelSnapshotBase {
  readonly readModel: 'api-equivalent-usd';
  readonly data: {
    /** Frozen literal: this number is an EQUIVALENCE, not spend (§6.3). */
    readonly basis: 'api-equivalent';
    readonly entries: readonly ApiEquivalentUsdEntry[];
    readonly windowDays: number;
  };
}

// ---------------------------------------------------------------------------
// 5. Cache hit rate with the 5m/1h TTL split
// ---------------------------------------------------------------------------

export interface CacheHitRateEntry {
  readonly account: AccountLabel;
  /** cacheRead / (input + cacheRead), 0–100. */
  readonly hitRatePct: number;
  readonly readTokens: number;
  /** Cache-creation TTL split (blueprint §6.2 ground truth from JSONL). */
  readonly creation5mTokens: number;
  readonly creation1hTokens: number;
}

export interface CacheHitRateSnapshot extends ReadModelSnapshotBase {
  readonly readModel: 'cache-hit-rate';
  readonly data: { readonly entries: readonly CacheHitRateEntry[] };
}

// ---------------------------------------------------------------------------
// 6. Latency p50/p95 + TTFT
// ---------------------------------------------------------------------------

export interface LatencyEntry {
  readonly backend: Backend;
  readonly p50Ms: number;
  readonly p95Ms: number;
  /** TTFT percentiles when the source surfaces them. */
  readonly ttftP50Ms?: number;
  readonly ttftP95Ms?: number;
  readonly sampleCount: number;
}

export interface LatencySnapshot extends ReadModelSnapshotBase {
  readonly readModel: 'latency';
  readonly data: { readonly entries: readonly LatencyEntry[] };
}

// ---------------------------------------------------------------------------
// 7. Error/retry/throttle health
// ---------------------------------------------------------------------------

export interface HealthEntry {
  readonly source: EventSource;
  readonly errorCount: number;
  readonly retryCount: number;
  readonly throttleCount: number;
  readonly timeoutCount: number;
  /** The rolling window the counts cover. */
  readonly windowMinutes: number;
}

export interface HealthSnapshot extends ReadModelSnapshotBase {
  readonly readModel: 'health';
  readonly data: { readonly entries: readonly HealthEntry[] };
}

// ---------------------------------------------------------------------------
// 8. Skill leaderboard (frequency × success × correction × tokens-per-outcome)
// ---------------------------------------------------------------------------

export interface SkillLeaderboardEntry {
  readonly skillName: string;
  readonly invocations: number;
  /** 0–100; absent while outcomes are too sparse to rate. */
  readonly successRatePct?: number;
  /**
   * 0–100; correction-intent classification is a LOCAL-MODEL job dispatched
   * through the BE-4 LM Studio adapter — absent until classified (§6.3).
   */
  readonly correctionRatePct?: number;
  readonly tokensPerOutcome?: number;
  /** Worst-quartile flag (never flags on sparse data — plan §9.2 BE-6 edge). */
  readonly worstQuartile: boolean;
}

export interface SkillLeaderboardSnapshot extends ReadModelSnapshotBase {
  readonly readModel: 'skill-leaderboard';
  readonly data: { readonly entries: readonly SkillLeaderboardEntry[] };
}

// ---------------------------------------------------------------------------
// 9. Session outcome / friction mix (insights facets)
// ---------------------------------------------------------------------------

export interface SessionOutcomeEntry {
  /** Facet value from the insights feed — open vocabulary, non-empty. */
  readonly outcome: string;
  readonly count: number;
}

export interface SessionOutcomesSnapshot extends ReadModelSnapshotBase {
  readonly readModel: 'session-outcomes';
  readonly data: {
    readonly entries: readonly SessionOutcomeEntry[];
    readonly windowDays: number;
  };
}

// ---------------------------------------------------------------------------
// 10. Local-offload ratio
// ---------------------------------------------------------------------------

export interface LocalOffloadSnapshot extends ReadModelSnapshotBase {
  readonly readModel: 'local-offload';
  readonly data: {
    /** localTokens / totalTokens, 0–100. */
    readonly offloadRatioPct: number;
    readonly localTokens: number;
    readonly totalTokens: number;
    readonly windowDays: number;
  };
}

// ---------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------

export type ReadModelSnapshot =
  | QuotaGaugesSnapshot
  | BurnRateSnapshot
  | BedrockCostSnapshot
  | ApiEquivalentUsdSnapshot
  | CacheHitRateSnapshot
  | LatencySnapshot
  | HealthSnapshot
  | SkillLeaderboardSnapshot
  | SessionOutcomesSnapshot
  | LocalOffloadSnapshot;
