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
 * FROZEN-M3 (2026-07-04); AMENDED-M6 (2026-07-05 — the eleventh read model,
 * `resource-health`, added additively: the supervision/governor instrument
 * per blueprint §11, pressure level + per-session footprints + shed/recycle
 * notices as STATES, labels + numbers only [X2]). Amendments only via ICR
 * (docs/contracts/icr/); BE-ORCH lands, FE-ORCH co-signs. Prose of record:
 * docs/contracts/ws-protocol.md.
 * ============================================================================
 */

import type { SourceFreshness } from './events.js';
import type { EventSource } from './events.js';
import type { QuotaWindow } from './quota.js';
import type { AccountLabel, Backend } from './vocab.js';

/**
 * The dashboard leads carried as `read-model-snapshot` kinds. The first ten
 * are the §6.3 observability leads, in the blueprint's order; `resource-health`
 * (the eleventh, M6) is the supervision/governor instrument of blueprint §11.
 *
 * ADDITIVITY NOTE (M6): appending `resource-health` to this CLOSED registry is
 * a deliberate wire ADDITION — the §13.3 forward-tolerant reader rule tolerates
 * unknown `kind`s but NOT unknown `readModel`s (a `read-model-snapshot` with an
 * unregistered `readModel` answers `bad-request`). A client built against the
 * ten-lead M3 set will REJECT a `resource-health` snapshot rather than ignore
 * it, so this is versioned (`1.3.0` → `1.4.0`, `FROZEN-M5` → `FROZEN-M6`), not
 * an in-band unknown-kind push. Producers gate emission on the negotiated freeze.
 */
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
  'resource-health',
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
// 11. Resource health — the supervision/governor instrument (blueprint §11, M6)
// ---------------------------------------------------------------------------

/**
 * Memory-pressure band (blueprint §11 thresholds). `normal` below amber;
 * `amber` at pressure level 2 / free <25% / swap >20 GB (stop prewarm, shorten
 * model TTL, offer hibernation); `red` at level 4 / free <12% / swap >26 GB
 * (refuse non-account spawns, unload the local model, force-hibernate idle
 * sessions). These are the STATES the FE renders — never raw free-RAM
 * fabrications (§11: health signals are pressure/swap deltas, never naive free
 * RAM). The band is derived by the broker; the wire carries the STATE.
 */
export const PRESSURE_STATES = Object.freeze(['normal', 'amber', 'red'] as const);

export type PressureState = (typeof PRESSURE_STATES)[number];

export function isPressureState(value: unknown): value is PressureState {
  return typeof value === 'string' && (PRESSURE_STATES as readonly string[]).includes(value);
}

/**
 * Per-session watchdog band (blueprint §11 / plan BE-9 phys_footprint
 * thresholds): `ok` below the warn line, `warn` at the warn threshold (claude
 * 3 GB / opencode 1 GB / serve sustained >500 MB), `recycle` at the recycle
 * threshold (claude 6 GB / opencode 1.5 GB) — the checkpoint→kill→resume line
 * that doubles as the [X4] continuation mechanism.
 */
export const WATCHDOG_BANDS = Object.freeze(['ok', 'warn', 'recycle'] as const);

export type WatchdogBand = (typeof WATCHDOG_BANDS)[number];

export function isWatchdogBand(value: unknown): value is WatchdogBand {
  return typeof value === 'string' && (WATCHDOG_BANDS as readonly string[]).includes(value);
}

/**
 * Shed/recycle actions the governor took, as STATES (M3 freshness doctrine:
 * a notice is a STATE the FE renders, never an error). The first five are the
 * [X1] SACRIFICE ORDER encoded in the scheduler (blueprint §11), in order:
 * local model size → model KV/context → frontend shell weight → non-Claude
 * session hibernation → scrollback/buffers. `recycle-session` is the
 * per-session checkpoint→kill→resume. Account sessions are NEVER the victim of
 * a shed action — the FE surfaces this order as an instrument, not an alarm.
 */
export const SHED_ACTIONS = Object.freeze([
  'shed-local-model',
  'shed-model-context',
  'shed-frontend-weight',
  'hibernate-non-account',
  'trim-scrollback',
  'recycle-session',
] as const);

export type ShedAction = (typeof SHED_ACTIONS)[number];

export function isShedAction(value: unknown): value is ShedAction {
  return typeof value === 'string' && (SHED_ACTIONS as readonly string[]).includes(value);
}

/**
 * One live session's resource footprint — labels + numbers ONLY [X2]. No
 * native session id, no cwd, no title: the `slot` is a per-account DISPLAY
 * ordinal (0-based), not a native id — it lets the FE place multiple sessions
 * of one account without ever carrying an identity-bearing key.
 */
export interface SessionFootprint {
  readonly account: AccountLabel;
  readonly backend: Backend;
  /** Per-account display ordinal (0-based) — never a native id [X2]. */
  readonly slot: number;
  /** phys_footprint in MB (blueprint §11: phys_footprint, not ps rss). */
  readonly footprintMb: number;
  readonly band: WatchdogBand;
  /** True while the session is hibernated (idle >30 min; never account sessions). */
  readonly hibernated?: boolean;
}

/**
 * A shed/recycle notice — a STATE, with the action, when it happened, and the
 * affected line by LABEL only when one applies (a whole-machine action like
 * `shed-local-model` may carry no account). NEVER an account session for a
 * shed action (§11: account sessions are never the victim); `recycle-session`
 * MAY carry an account because recycle IS the account continuation mechanism.
 */
export interface ShedNotice {
  readonly action: ShedAction;
  /** Epoch ms the action was taken. */
  readonly at: number;
  readonly account?: AccountLabel;
  readonly backend?: Backend;
}

/**
 * The supervision/governor instrument (blueprint §11). Pressure STATE +
 * per-session footprints + shed/recycle notices, all labels + numbers only
 * [X2]. Rides the `events` channel as a `read-model-snapshot` exactly like the
 * §6.3 leads; its `sources` array carries the freshness of the feed the
 * governor reads (the harness's own supervision telemetry surfaces as the
 * generic freshness envelope — a missing feed is `no-signal`, never fabricated
 * zeros). Absent optional numbers mean "not computable yet".
 */
export interface ResourceHealthSnapshot extends ReadModelSnapshotBase {
  readonly readModel: 'resource-health';
  readonly data: {
    /** macOS memory-pressure level 0..4 (blueprint §11: amber@2, red@4). */
    readonly pressureLevel: number;
    /** The derived band the FE renders. */
    readonly pressureState: PressureState;
    /** Free physical RAM percentage, 0..100. */
    readonly freeRamPct: number;
    /** Swap in use, bytes (blueprint §11: amber >20 GB, red >26 GB). */
    readonly swapUsedBytes: number;
    /** Resident (non-hibernated) session count. */
    readonly residentSessionCount: number;
    /**
     * The one GLOBAL "local model resident" budget line (blueprint §4.3/§11),
     * bytes — 0 when nothing is loaded; absent when the LM Studio/Ollama feed
     * is not readable (the freshness entry says why).
     */
    readonly localModelResidentBytes?: number;
    /** Per-session footprints — labels + numbers only [X2]. */
    readonly sessions: readonly SessionFootprint[];
    /** Shed/recycle notices as STATES, most-recent-first is NOT required. */
    readonly notices: readonly ShedNotice[];
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
  | LocalOffloadSnapshot
  | ResourceHealthSnapshot;
