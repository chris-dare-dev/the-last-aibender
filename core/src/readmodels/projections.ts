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
  LABEL_BACKENDS,
  type AccountLabel,
  type ReadModelSnapshot,
} from '@aibender/protocol';
import type {
  EventRow,
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
 * Client-side USD estimate for one row: the ingest-time estimate when the
 * collector landed one, else token counts × the pinned prices table
 * (blueprint §6.2 `prices`: LiteLLM-seeded, pinned, overridable). Rows with
 * no price row contribute 0 — an unknown model is never guessed at.
 */
export function estimateUsdForRow(row: EventRow, prices: PricesStore): number {
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
  const rows = stores.events.list({ sinceTsMs: Math.max(0, inputs.nowMs - scanWindowMs) });
  const entries: Data<'burn-rate'>['entries'][number][] = [];
  for (const [account, accountRows] of groupBy(rows, (row) => row.account)) {
    const blocks = assembleBlocks(
      accountRows.map((row) => ({ tsMs: row.tsMs, tokens: tokensOfRow(row) })),
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

  // AWS_DEV rides OpenCode→Bedrock (vocab.ts LABEL_BACKENDS).
  const rows = stores.events.list({ backend: 'opencode', sinceTsMs: mtdStartMs });
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
  const rows = stores.events.list({ sinceTsMs: Math.max(0, nowMs - windowDays * DAY_MS) });
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
      backend: LABEL_BACKENDS[account],
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
  const rows = stores.events.list({ sinceTsMs: Math.max(0, nowMs - windowDays * DAY_MS) });
  const entries: Data<'cache-hit-rate'>['entries'][number][] = [];
  for (const [account, accountRows] of groupBy(rows, (row) => row.account)) {
    let input = 0;
    let read = 0;
    let creation5m = 0;
    let creation1h = 0;
    for (const row of accountRows) {
      input += row.inputTokens ?? 0;
      read += row.cacheReadTokens ?? 0;
      creation5m += row.cacheCreation5mTokens ?? 0;
      creation1h += row.cacheCreation1hTokens ?? 0;
    }
    const denominator = input + read;
    if (denominator === 0) continue; // no cache-bearing traffic → no entry
    entries.push({
      account,
      hitRatePct: clampPct((read / denominator) * 100),
      readTokens: read,
      creation5mTokens: creation5m,
      creation1hTokens: creation1h,
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
  const rows = stores.events.list({ sinceTsMs: Math.max(0, nowMs - windowDays * DAY_MS) });
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
  const rows = stores.events.list({ sinceTsMs: Math.max(0, nowMs - windowMinutes * 60_000) });
  const entries: Data<'health'>['entries'][number][] = [];
  for (const [source, sourceRows] of groupBy(rows, (row) => row.source)) {
    let errorCount = 0;
    let retryCount = 0;
    let throttleCount = 0;
    let timeoutCount = 0;
    for (const row of sourceRows) {
      switch (row.errorKind) {
        case 'error':
          errorCount += 1;
          break;
        case 'retry':
          retryCount += 1;
          break;
        case 'throttle':
          throttleCount += 1;
          break;
        case 'timeout':
          timeoutCount += 1;
          break;
        default:
          // An explicit failure with no classified kind still counts as error.
          if (row.ok === false) errorCount += 1;
      }
    }
    entries.push({ source, errorCount, retryCount, throttleCount, timeoutCount, windowMinutes });
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
  const rows = stores.events.list({
    sinceTsMs: Math.max(0, inputs.nowMs - inputs.windowDays * DAY_MS),
  });
  const bySkill = groupBy(
    rows.filter((row) => row.skillName !== undefined),
    (row) => row.skillName as string,
  );

  interface Draft {
    skillName: string;
    invocations: number;
    successRatePct?: number;
    correctionRatePct?: number;
    tokensPerOutcome?: number;
  }
  const drafts: Draft[] = [];
  for (const [skillName, skillRows] of bySkill) {
    const outcomes = skillRows.filter((row) => row.ok !== undefined);
    const okCount = outcomes.filter((row) => row.ok === true).length;
    const successRatePct =
      outcomes.length >= MIN_OUTCOMES_FOR_RATE
        ? clampPct((okCount / outcomes.length) * 100)
        : undefined;
    const totalTokens = skillRows.reduce((sum, row) => sum + tokensOfRow(row), 0);
    const tokensPerOutcome = outcomes.length > 0 ? totalTokens / outcomes.length : undefined;
    const correctionRatePct = inputs.correctionRatePctBySkill?.get(skillName);
    drafts.push({
      skillName,
      invocations: skillRows.length,
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
  const since = Math.max(0, nowMs - windowDays * DAY_MS);
  const counts = new Map<string, number>();
  for (const row of stores.sessionOutcomes.list()) {
    if (row.capturedAtMs < since) continue;
    counts.set(row.outcome, (counts.get(row.outcome) ?? 0) + 1);
  }
  return {
    entries: [...counts.entries()].map(([outcome, count]) => ({ outcome, count })),
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
  const rows = stores.events.list({ sinceTsMs: Math.max(0, nowMs - windowDays * DAY_MS) });
  let localTokens = 0;
  let totalTokens = 0;
  for (const row of rows) {
    const tokens = tokensOfRow(row);
    totalTokens += tokens;
    if (row.backend === 'lmstudio') localTokens += tokens;
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
