/**
 * Dashboard read-model projections (BE-6; blueprint §6.3, in order) — pure
 * query+math over the M3 events store (@aibender/schema migration 0002)
 * producing the FROZEN `data` bodies of readModels.ts. The publisher
 * (./publisher.ts) wraps them with capturedAt + per-source freshness and
 * validates against the frozen wire validators before anything is published.
 *
 * HONESTY RULES (validated, not advisory — ws-protocol.md §13.2):
 *   - aggregates over an EMPTY set are absent entries / empty arrays, never
 *     fabricated gauges ("missing source → NO SIGNAL, never fabricated
 *     zeros" — plan §9.2 BE-6 negative row);
 *   - `api-equivalent-usd` carries the frozen literal basis
 *     `api-equivalent` (equivalence, never spend);
 *   - burn projection is percent-rate extrapolation, labeled projection
 *     (./blocks.ts — the ccusage-math citation lives there);
 *   - correction rates are ABSENT until the local-model classification job
 *     ran (./classification.ts); sparse leaderboards flag nothing.
 */

import {
  backendById,
  backendForLabel,
  type AccountLabel,
  type ReadModelSnapshot,
} from '@aibender/protocol';
import type {
  EventRow,
  EventsAggregatesStore,
  EventsTableStore,
  PricesStore,
  QuotaSnapshotsStore,
  SessionOutcomesStore,
} from '@aibender/schema';

import {
  activeBlock,
  assembleBlocks,
  burnRateTokensPerHour,
  projectExhaustionAt,
} from './blocks.js';

// ---------------------------------------------------------------------------
// Store surface (structurally satisfied by @aibender/schema EventsStore)
// ---------------------------------------------------------------------------

export interface ReadModelStores {
  readonly events: EventsTableStore;
  /**
   * SQL-side aggregation (finding OS-2). The window-scanning leads group/sum/
   * count through this instead of materializing the whole window as `EventRow`s.
   * See the per-lead notes below for the byte-identical-output argument.
   */
  readonly eventsAggregates: EventsAggregatesStore;
  readonly quotaSnapshots: QuotaSnapshotsStore;
  readonly sessionOutcomes: SessionOutcomesStore;
  readonly prices: PricesStore;
}

type Data<M extends ReadModelSnapshot['readModel']> = Extract<
  ReadModelSnapshot,
  { readModel: M }
>['data'];

// ---------------------------------------------------------------------------
// Shared math helpers
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** The four ground-truth token classes summed (blueprint §6.2). */
export function tokensOfRow(row: EventRow): number {
  return (
    (row.inputTokens ?? 0) +
    (row.outputTokens ?? 0) +
    (row.cacheReadTokens ?? 0) +
    (row.cacheCreationTokens ?? 0)
  );
}

/** Nearest-rank percentile over a non-empty ascending-sorted sample. */
export function percentile(sortedAscending: readonly number[], pct: number): number {
  const rank = Math.max(1, Math.ceil((pct / 100) * sortedAscending.length));
  const value = sortedAscending[rank - 1];
  if (value === undefined) throw new RangeError('percentile over an empty sample');
  return value;
}

/**
 * The columns {@link estimateUsdForRow} reads — a structural subset of
 * {@link EventRow} that the OS-2 narrow-column cost scans (schema
 * `EstimateRow`/`CostRow`) also satisfy, so the exact per-row USD arithmetic is
 * shared between the full-row path (tests) and the narrow-scan path (publisher).
 */
export type EstimatableRow = Pick<
  EventRow,
  | 'costEstimatedUsd'
  | 'provider'
  | 'model'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'cacheCreationTokens'
>;

/**
 * Client-side USD estimate for one row: the ingest-time estimate when the
 * collector landed one, else token counts × the pinned prices table
 * (blueprint §6.2 `prices`: LiteLLM-seeded, pinned, overridable). Rows with
 * no price row contribute 0 — an unknown model is never guessed at.
 */
export function estimateUsdForRow(row: EstimatableRow, prices: PricesStore): number {
  if (row.costEstimatedUsd !== undefined) return row.costEstimatedUsd;
  if (row.provider === undefined || row.model === undefined) return 0;
  const price = prices.get(row.provider, row.model);
  if (price === undefined) return 0;
  const perMtok =
    (row.inputTokens ?? 0) * price.inputUsdPerMtok +
    (row.outputTokens ?? 0) * price.outputUsdPerMtok +
    (row.cacheReadTokens ?? 0) * (price.cacheReadUsdPerMtok ?? 0) +
    (row.cacheCreationTokens ?? 0) * (price.cacheWriteUsdPerMtok ?? 0);
  return perMtok / 1_000_000;
}

function groupBy<K, V>(items: readonly V[], key: (item: V) => K): Map<K, V[]> {
  const groups = new Map<K, V[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = groups.get(k);
    if (bucket === undefined) groups.set(k, [item]);
    else bucket.push(item);
  }
  return groups;
}

/**
 * The events `source` the LOCAL-model substrate feeds — resolved through the
 * registry (ICR-0016 / finding OS-1) rather than hardcoding the `'lmstudio'`
 * literal. The built-in `lmstudio` backend is the canonical local one; its
 * descriptor's `sourceName` is the local source of record, and any registered
 * backend that declares the SAME source (e.g. a 2nd OpenAI-compatible local
 * server whose descriptor reuses `sourceName: 'lmstudio'`) is local too. `??`
 * falls back to the literal ONLY if the built-in is somehow absent, which never
 * happens (the three built-ins are pre-seeded and cannot be unregistered).
 */
const LOCAL_EVENT_SOURCE = backendById('lmstudio')?.sourceName ?? 'lmstudio';

/**
 * True iff `backend` is a LOCAL-model backend — its registered descriptor feeds
 * the {@link LOCAL_EVENT_SOURCE}. Byte-identical for the built-in three (only
 * `lmstudio` is local); a registered 4th local backend counts with NO edit
 * here. An unregistered id is never local (fail-closed → not counted).
 */
function isLocalBackend(backend: string): boolean {
  return backendById(backend)?.sourceName === LOCAL_EVENT_SOURCE;
}

const clampPct = (value: number): number => Math.min(100, Math.max(0, value));

// ---------------------------------------------------------------------------
// 1. Quota gauges — latest snapshot per (account, window), NEVER fabricated
// ---------------------------------------------------------------------------

export function quotaGaugesData(stores: ReadModelStores): Data<'quota-gauges'> {
  return {
    gauges: stores.quotaSnapshots.latest().map((row) => ({
      account: row.account,
      window: row.window,
      usedPct: clampPct(row.usedPct),
      // resetsAt in the past is LEGAL (reset due) — the boundary-crossing
      // edge of plan §9.2; the feed's value is authoritative.
      resetsAt: row.resetsAtMs,
    })),
  };
}

// ---------------------------------------------------------------------------
// 2. Burn rate — ccusage block math (./blocks.ts), quota-joined projection
// ---------------------------------------------------------------------------

export interface BurnRateInputs {
  readonly nowMs: number;
  /**
   * Authoritative 5h used-percent per account, provided ONLY when the quota
   * feed is fresh (publisher decides via the freshness tracker). Absent
   * entries get burn rate without pct/projection — never a fabricated join.
   */
  readonly usedPctByAccount?: ReadonlyMap<AccountLabel, number>;
  /** How far back to scan for block reconstruction. Default 7 days. */
  readonly scanWindowMs?: number;
}

export function burnRateData(stores: ReadModelStores, inputs: BurnRateInputs): Data<'burn-rate'> {
  const scanWindowMs = inputs.scanWindowMs ?? 7 * DAY_MS;
  // OS-2: narrow (account, tsMs, tokens) scan — tokens summed in SQL (the exact
  // integer twin of tokensOfRow), same (ts_ms, id) order, so groupBy yields the
  // identical first-appearance account order and block reconstruction the full
  // events.list() scan produced, without materializing every EventRow.
  const rows = stores.eventsAggregates.burnRows(Math.max(0, inputs.nowMs - scanWindowMs));
  const entries: Data<'burn-rate'>['entries'][number][] = [];
  for (const [account, accountRows] of groupBy(rows, (row) => row.account)) {
    const blocks = assembleBlocks(
      accountRows.map((row) => ({ tsMs: row.tsMs, tokens: row.tokens })),
    );
    const block = activeBlock(blocks, inputs.nowMs);
    if (block === undefined) continue; // no active block → no entry, never a zero
    const usedPct = inputs.usedPctByAccount?.get(account);
    const projectedExhaustionAt =
      usedPct !== undefined
        ? projectExhaustionAt({
            blockStartMs: block.startMs,
            nowMs: inputs.nowMs,
            usedPct: clampPct(usedPct),
          })
        : undefined;
    entries.push({
      account,
      blockStartAt: block.startMs,
      blockEndAt: block.endMs,
      tokensPerHour: burnRateTokensPerHour(block, inputs.nowMs),
      ...(usedPct !== undefined ? { usedPct: clampPct(usedPct) } : {}),
      ...(projectedExhaustionAt !== undefined ? { projectedExhaustionAt } : {}),
    });
  }
  return { entries };
}

// ---------------------------------------------------------------------------
// 3. Bedrock actual-vs-estimate overlay
// ---------------------------------------------------------------------------

export interface BedrockCostResult {
  readonly data: Data<'bedrock-cost'>;
  /** True when Cost Explorer actuals landed for the month-to-date window. */
  readonly hasActuals: boolean;
}

/** Cost Explorer's authoritative lag, ~24 h (blueprint §6.1). */
export const COST_EXPLORER_LAG_HOURS = 24;

export function bedrockCostData(stores: ReadModelStores, nowMs: number): BedrockCostResult {
  const now = new Date(nowMs);
  const mtdStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const dayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const yesterdayStartMs = dayStartMs - DAY_MS;

  // AWS_DEV rides OpenCode→Bedrock (vocab.ts backendForLabel).
  // OS-2: narrow cost-column scan (same backend filter, same (ts_ms, id) order)
  // — float USD is NEVER summed in SQL (Kahan-vs-fold divergence); the exact
  // per-row `estimateUsdForRow` fold is preserved bit-for-bit over narrow rows.
  const rows = stores.eventsAggregates.costRows(mtdStartMs, 'opencode');
  let estimateMtdUsd = 0;
  let actualMtdUsd: number | undefined;
  let actualYesterdayUsd: number | undefined;
  for (const row of rows) {
    if (row.tsMs > nowMs) continue; // future-stamped rows never count into MTD
    estimateMtdUsd += estimateUsdForRow(row, stores.prices);
    if (row.costActualUsd !== undefined) {
      actualMtdUsd = (actualMtdUsd ?? 0) + row.costActualUsd;
      if (row.tsMs >= yesterdayStartMs && row.tsMs < dayStartMs) {
        actualYesterdayUsd = (actualYesterdayUsd ?? 0) + row.costActualUsd;
      }
    }
  }
  const hasActuals = actualMtdUsd !== undefined;
  return {
    hasActuals,
    data: {
      estimateMtdUsd,
      ...(actualMtdUsd !== undefined ? { actualMtdUsd } : {}),
      ...(actualYesterdayUsd !== undefined ? { actualYesterdayUsd } : {}),
      ...(hasActuals ? { actualLagHours: COST_EXPLORER_LAG_HOURS } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// 4. API-equivalent USD — basis is the frozen literal, per (account, backend)
// ---------------------------------------------------------------------------

export function apiEquivalentUsdData(
  stores: ReadModelStores,
  nowMs: number,
  windowDays: number,
): Data<'api-equivalent-usd'> {
  // OS-2: narrow (account + cost columns) scan, same (ts_ms, id) order, so the
  // Map's first-appearance account order and the exact per-row USD fold are
  // preserved (float USD never summed in SQL).
  const rows = stores.eventsAggregates.estimateRows(Math.max(0, nowMs - windowDays * DAY_MS));
  const byAccount = new Map<AccountLabel, number>();
  for (const row of rows) {
    byAccount.set(row.account, (byAccount.get(row.account) ?? 0) + estimateUsdForRow(row, stores.prices));
  }
  const entries = [...byAccount.entries()]
    .filter(([, usd]) => usd > 0)
    .map(([account, equivalentUsd]) => ({
      account,
      // The events store enforces the pairing at insert; deriving it here
      // keeps the entry valid by construction.
      backend: backendForLabel(account),
      equivalentUsd,
    }));
  return { basis: 'api-equivalent', entries, windowDays };
}

// ---------------------------------------------------------------------------
// 5. Cache hit rate with the 5m/1h TTL split
// ---------------------------------------------------------------------------

export function cacheHitRateData(
  stores: ReadModelStores,
  nowMs: number,
  windowDays: number,
): Data<'cache-hit-rate'> {
  // OS-2: per-account integer token sums computed in SQL (exact; the single
  // hit-rate division uses the identical integer operands), rows in the same
  // first-appearance account order the JS groupBy produced.
  const entries: Data<'cache-hit-rate'>['entries'][number][] = [];
  for (const sums of stores.eventsAggregates.cacheTokensByAccount(Math.max(0, nowMs - windowDays * DAY_MS))) {
    const denominator = sums.inputTokens + sums.readTokens;
    if (denominator === 0) continue; // no cache-bearing traffic → no entry
    entries.push({
      account: sums.account,
      hitRatePct: clampPct((sums.readTokens / denominator) * 100),
      readTokens: sums.readTokens,
      creation5mTokens: sums.creation5mTokens,
      creation1hTokens: sums.creation1hTokens,
    });
  }
  return { entries };
}

// ---------------------------------------------------------------------------
// 6. Latency p50/p95 + TTFT per backend
// ---------------------------------------------------------------------------

export function latencyData(
  stores: ReadModelStores,
  nowMs: number,
  windowDays: number,
): Data<'latency'> {
  // OS-2: narrow (backend, latency, ttft) scan, same (ts_ms, id) order, so the
  // backend first-appearance order and the exact nearest-rank percentiles over
  // the sorted integer samples are preserved.
  const rows = stores.eventsAggregates.latencySamples(Math.max(0, nowMs - windowDays * DAY_MS));
  const entries: Data<'latency'>['entries'][number][] = [];
  for (const [backend, backendRows] of groupBy(rows, (row) => row.backend)) {
    const latencies = backendRows
      .map((row) => row.latencyMs)
      .filter((value): value is number => value !== undefined)
      .sort((a, b) => a - b);
    if (latencies.length === 0) continue;
    const ttfts = backendRows
      .map((row) => row.ttftMs)
      .filter((value): value is number => value !== undefined)
      .sort((a, b) => a - b);
    entries.push({
      backend,
      p50Ms: percentile(latencies, 50),
      p95Ms: percentile(latencies, 95),
      ...(ttfts.length > 0
        ? { ttftP50Ms: percentile(ttfts, 50), ttftP95Ms: percentile(ttfts, 95) }
        : {}),
      sampleCount: latencies.length,
    });
  }
  return { entries };
}

// ---------------------------------------------------------------------------
// 7. Error/retry/throttle health per source
// ---------------------------------------------------------------------------

export function healthData(
  stores: ReadModelStores,
  nowMs: number,
  windowMinutes: number,
): Data<'health'> {
  // OS-2: per-source integer counts computed in SQL, first-appearance source
  // order preserved. The SQL CASE reproduces the switch exactly: a row counts as
  // an error when error_kind='error' OR (error_kind IS NULL AND ok=0) — the
  // "explicit failure with no classified kind" default arm; retry/throttle/
  // timeout are counted by their kind. (error_kind is validated to the enum at
  // insert, so the JS `default` arm only ever fired for an undefined kind.)
  const entries: Data<'health'>['entries'][number][] = [];
  for (const c of stores.eventsAggregates.healthCountsBySource(Math.max(0, nowMs - windowMinutes * 60_000))) {
    entries.push({
      source: c.source,
      errorCount: c.errorCount,
      retryCount: c.retryCount,
      throttleCount: c.throttleCount,
      timeoutCount: c.timeoutCount,
      windowMinutes,
    });
  }
  return { entries };
}

// ---------------------------------------------------------------------------
// 8. Skill leaderboard — sparse data NEVER flags (plan §9.2 BE-6 edge)
// ---------------------------------------------------------------------------

/** Outcomes needed before a success rate is even quoted. */
export const MIN_OUTCOMES_FOR_RATE = 3;
/** Invocations needed before a skill can be flag-eligible. */
export const MIN_INVOCATIONS_FOR_FLAG = 5;
/** Flag-eligible cohort size needed before ANY worst-quartile flag renders. */
export const MIN_COHORT_FOR_FLAGS = 4;

export interface SkillLeaderboardInputs {
  readonly nowMs: number;
  readonly windowDays: number;
  /**
   * skillName → correction rate percent, produced by the local-model
   * classification job (./classification.ts). Absent skills stay unrated —
   * the freshness entry (lmstudio) says why.
   */
  readonly correctionRatePctBySkill?: ReadonlyMap<string, number>;
}

export function skillLeaderboardData(
  stores: ReadModelStores,
  inputs: SkillLeaderboardInputs,
): Data<'skill-leaderboard'> {
  // OS-2: per-skill invocations / ok-count / outcome-cohort / token-sum computed
  // in SQL (integer-exact; the rate + tokens-per-outcome divisions use identical
  // operands), skills in the same first-appearance order the JS groupBy produced.
  const aggregates = stores.eventsAggregates.skillAggregates(
    Math.max(0, inputs.nowMs - inputs.windowDays * DAY_MS),
  );

  interface Draft {
    skillName: string;
    invocations: number;
    successRatePct?: number;
    correctionRatePct?: number;
    tokensPerOutcome?: number;
  }
  const drafts: Draft[] = [];
  for (const agg of aggregates) {
    const successRatePct =
      agg.outcomeCount >= MIN_OUTCOMES_FOR_RATE
        ? clampPct((agg.okCount / agg.outcomeCount) * 100)
        : undefined;
    const tokensPerOutcome = agg.outcomeCount > 0 ? agg.totalTokens / agg.outcomeCount : undefined;
    const correctionRatePct = inputs.correctionRatePctBySkill?.get(agg.skillName);
    drafts.push({
      skillName: agg.skillName,
      invocations: agg.invocations,
      ...(successRatePct !== undefined ? { successRatePct } : {}),
      ...(correctionRatePct !== undefined ? { correctionRatePct: clampPct(correctionRatePct) } : {}),
      ...(tokensPerOutcome !== undefined ? { tokensPerOutcome } : {}),
    });
  }

  // Worst-quartile flags: only when a rateable, non-sparse cohort exists.
  const eligible = drafts.filter(
    (draft) =>
      draft.successRatePct !== undefined && draft.invocations >= MIN_INVOCATIONS_FOR_FLAG,
  );
  let q25: number | undefined;
  if (eligible.length >= MIN_COHORT_FOR_FLAGS) {
    q25 = percentile(
      eligible.map((draft) => draft.successRatePct as number).sort((a, b) => a - b),
      25,
    );
  }

  return {
    entries: drafts.map((draft) => ({
      ...draft,
      worstQuartile:
        q25 !== undefined &&
        draft.successRatePct !== undefined &&
        draft.invocations >= MIN_INVOCATIONS_FOR_FLAG &&
        draft.successRatePct <= q25,
    })),
  };
}

// ---------------------------------------------------------------------------
// 9. Session outcome / friction mix
// ---------------------------------------------------------------------------

export function sessionOutcomesData(
  stores: ReadModelStores,
  nowMs: number,
  windowDays: number,
): Data<'session-outcomes'> {
  // OS-2: per-outcome counts computed in SQL over captured_at_ms >= since, in
  // the same first-appearance order the JS Map produced (session_outcomes.list()
  // is ordered by captured_at_ms, id; the counts are exact integers).
  const since = Math.max(0, nowMs - windowDays * DAY_MS);
  return {
    entries: stores.eventsAggregates.outcomeCounts(since).map((row) => ({
      outcome: row.outcome,
      count: row.count,
    })),
    windowDays,
  };
}

// ---------------------------------------------------------------------------
// 10. Local-offload ratio
// ---------------------------------------------------------------------------

export function localOffloadData(
  stores: ReadModelStores,
  nowMs: number,
  windowDays: number,
): Data<'local-offload'> {
  // OS-2: per-backend integer token sums computed in SQL; the local/total fold
  // stays in JS so the registry-resolved `isLocalBackend` (ICR-0016 / OS-1)
  // still decides locality with no hardcoded literal. Integer addition is exact
  // and associative, so the order-independent fold matches the old per-row sum.
  let localTokens = 0;
  let totalTokens = 0;
  for (const bucket of stores.eventsAggregates.tokenSumsByBackend(Math.max(0, nowMs - windowDays * DAY_MS))) {
    totalTokens += bucket.tokens;
    if (isLocalBackend(bucket.backend)) localTokens += bucket.tokens;
  }
  return {
    // 0/0 renders honestly as 0 WITH a no-signal freshness entry explaining
    // why — a true count over an empty window, not a fabricated gauge.
    offloadRatioPct: totalTokens > 0 ? clampPct((localTokens / totalTokens) * 100) : 0,
    localTokens,
    totalTokens,
    windowDays,
  };
}
