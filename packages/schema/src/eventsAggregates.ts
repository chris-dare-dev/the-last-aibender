/**
 * SQL-side aggregation accessors for the M3 events store (finding OS-2:
 * "Dashboard projections full-scan + JS-aggregate the entire window on every
 * publish"). These replace the BE-6 read-model projections' old
 * `stores.events.list({ sinceTsMs })` path — a `SELECT *` window scan whose
 * every row was decoded by `eventFromSql` into a 30-field `EventRow` (with
 * `JSON.parse(file_refs)`) and then aggregated in JS — with NARROW-COLUMN scans
 * (only the handful of columns each lead reads) plus, where safe, `GROUP BY` /
 * `COUNT` in SQLite. The dominant cost the finding cited (full `EventRow`
 * materialization on every `publishAll()`) is gone regardless of which leads
 * stay row-wise.
 *
 * ADDITIVE, NOT AN AMENDMENT. The FROZEN-M3 insert/dedupe path (events.ts) is
 * untouched; this is a NEW read-only accessor surface (ICR-0017) over the SAME
 * frozen tables. `createEventsTableStore` remains the write path of record.
 *
 * BYTE-IDENTICAL OUTPUT — the discipline that lets this replace the JS loops
 * without moving a single dashboard number:
 *
 *   1. ORDERING. The old projections iterated `list()` (`ORDER BY ts_ms, id`)
 *      and grouped into a Map, so their entry arrays are in FIRST-APPEARANCE
 *      order. Row-wise leads here scan in the SAME `ORDER BY ts_ms, id` and
 *      group into a Map identically; the COUNT-in-SQL leads reproduce that order
 *      with `ROW_NUMBER() OVER (ORDER BY ts_ms, id)` + `MIN(rn)` + `ORDER BY MIN(rn)`.
 *
 *   2. TOKEN ARITHMETIC STAYS IN JS — NOT SQL. Token columns are each a
 *      non-negative SAFE integer at insert (< 2^53), but a per-row 4-class sum,
 *      or a per-group `SUM`, can EXCEED 2^53 — and node:sqlite (opened in
 *      default non-BigInt mode, driver.ts) THROWS `ERR_OUT_OF_RANGE` when it has
 *      to marshal a SQL-computed integer past 2^53. The old JS path never threw:
 *      it `Number()`d each (safe) column, then left-folded in float (lossy past
 *      2^53, but finite). So every token sum/fold is done HERE in JS, in the
 *      same (ts_ms, id) row order, over raw per-column values that marshal
 *      safely — byte-identical to the old fold, INCLUDING its past-2^53 float
 *      behavior, and it never throws. Only COUNTs (bounded by the row count,
 *      which cannot approach 2^53) are aggregated in SQL.
 *
 *   3. FLOAT MONEY is never touched by SQL arithmetic either (SQLite `SUM` is
 *      Kahan-compensated → last-ULP divergence from a JS fold); the USD leads
 *      take a narrow raw-column scan and keep their exact per-row JS arithmetic.
 *
 *   4. NULLs → undefined. Narrow rows decode SQL NULL to `undefined`/0 exactly
 *      as `eventFromSql` + the projections' `?? 0` did.
 *
 * [X2]: read-only aggregation; writes nothing, decodes no identity-bearing
 * column (only labels, backends, sources, numeric counts).
 */

import { isAccountLabel, isBackend, isEventSource } from '@aibender/protocol';
import type { AccountLabel, Backend, EventSource } from '@aibender/protocol';

import type { SqlRow, SqlValue, SqliteDriver } from './driver.js';

// ---------------------------------------------------------------------------
// Decode helpers — mirror `eventFromSql`
// ---------------------------------------------------------------------------

/** Raw SQL numeric cell → number|undefined (NULL → undefined), like eventFromSql. */
function optNum(value: SqlValue | undefined): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}
function optStr(value: SqlValue | undefined): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}
/** Raw SQL numeric cell → number, NULL → 0 (the projections' `?? 0`). Each token
 * column is < 2^53 at insert, so `Number()` is exact and never overflows. */
function numOr0(value: SqlValue | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}
/** The four ground-truth token classes summed in JS — the exact twin of
 * `tokensOfRow` (projections.ts), folded over safe per-column values. */
function tokensOf(row: SqlRow): number {
  return (
    numOr0(row['input_tokens']) +
    numOr0(row['output_tokens']) +
    numOr0(row['cache_read_tokens']) +
    numOr0(row['cache_creation_tokens'])
  );
}

// ---------------------------------------------------------------------------
// Row shapes returned to the projections (unchanged by the OS-2 overflow fix)
// ---------------------------------------------------------------------------

/** Per-account token-class sums — feeds `cache-hit-rate`. */
export interface AccountCacheTokens {
  readonly account: AccountLabel;
  readonly inputTokens: number;
  readonly readTokens: number;
  readonly creation5mTokens: number;
  readonly creation1hTokens: number;
}

/** Per-source error/retry/throttle/timeout counts (integer-exact) — feeds `health`. */
export interface SourceHealthCounts {
  readonly source: EventSource;
  readonly errorCount: number;
  readonly retryCount: number;
  readonly throttleCount: number;
  readonly timeoutCount: number;
}

/** Per-backend total-token sum — feeds `local-offload`. */
export interface BackendTokenSum {
  readonly backend: Backend;
  readonly tokens: number;
}

/** Per-skill counts + token sum — feeds `skill-leaderboard`. */
export interface SkillAggregate {
  readonly skillName: string;
  readonly invocations: number;
  /** Rows with `ok = 1`. */
  readonly okCount: number;
  /** Rows with `ok` NOT NULL (the outcome cohort). */
  readonly outcomeCount: number;
  readonly totalTokens: number;
}

/** Per-outcome count over `session_outcomes` — feeds `session-outcomes`. */
export interface OutcomeCount {
  readonly outcome: string;
  readonly count: number;
}

/** Narrow (account, ts, tokens) row for the burn-rate block reconstruction. */
export interface BurnRow {
  readonly account: AccountLabel;
  readonly tsMs: number;
  readonly tokens: number;
}

/** Narrow row carrying exactly what `estimateUsdForRow` reads (+ account). */
export interface EstimateRow {
  readonly account: AccountLabel;
  readonly provider?: string;
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly costEstimatedUsd?: number;
}

/** Narrow cost row for the bedrock overlay (adds ts + actual). */
export interface CostRow extends Omit<EstimateRow, 'account'> {
  readonly tsMs: number;
  readonly costActualUsd?: number;
}

/** Narrow (backend, latency, ttft) sample — feeds the latency percentiles. */
export interface LatencySample {
  readonly backend: Backend;
  readonly latencyMs?: number;
  readonly ttftMs?: number;
}

// ---------------------------------------------------------------------------
// Accessor surface
// ---------------------------------------------------------------------------

export interface EventsAggregatesStore {
  /** Per-account cache token sums over `ts_ms >= sinceTsMs`, first-appearance order. */
  cacheTokensByAccount(sinceTsMs: number): readonly AccountCacheTokens[];
  /** Per-source health counts over the window, first-appearance order. */
  healthCountsBySource(sinceTsMs: number): readonly SourceHealthCounts[];
  /** Per-backend total-token sums over the window (order-independent). */
  tokenSumsByBackend(sinceTsMs: number): readonly BackendTokenSum[];
  /** Per-skill counts + token sums over the window, first-appearance order. */
  skillAggregates(sinceTsMs: number): readonly SkillAggregate[];
  /** Per-outcome counts over `session_outcomes.captured_at_ms >= since`, first-appearance order. */
  outcomeCounts(sinceCapturedMs: number): readonly OutcomeCount[];

  /** Narrow (account, tsMs, tokens) rows, `ts_ms >= since`, `ORDER BY ts_ms, id`. */
  burnRows(sinceTsMs: number): readonly BurnRow[];
  /** Narrow cost/estimate rows for one backend (bedrock overlay), `ORDER BY ts_ms, id`. */
  costRows(sinceTsMs: number, backend: Backend): readonly CostRow[];
  /** Narrow estimate rows across all backends (api-equivalent), `ORDER BY ts_ms, id`. */
  estimateRows(sinceTsMs: number): readonly EstimateRow[];
  /** Narrow (backend, latency, ttft) samples, `ORDER BY ts_ms, id`. */
  latencySamples(sinceTsMs: number): readonly LatencySample[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEventsAggregatesStore(driver: SqliteDriver): EventsAggregatesStore {
  const decodeAccount = (value: SqlValue | undefined): AccountLabel => {
    if (!isAccountLabel(value)) throw new Error('events aggregate: bad account decode');
    return value;
  };
  const decodeBackend = (value: SqlValue | undefined): Backend => {
    if (!isBackend(value)) throw new Error('events aggregate: bad backend decode');
    return value;
  };
  const decodeSource = (value: SqlValue | undefined): EventSource => {
    if (!isEventSource(value)) throw new Error('events aggregate: bad source decode');
    return value;
  };

  return {
    // Narrow (account + cache-token columns) scan in (ts_ms, id) order, grouped
    // + folded in JS (Map = first-appearance order; token folds stay in JS to
    // avoid the >2^53 SQL-marshaling throw and to match the old float fold).
    cacheTokensByAccount: (sinceTsMs) => {
      const acc = new Map<AccountLabel, { input: number; read: number; c5m: number; c1h: number }>();
      const rows = driver
        .prepare(
          `SELECT account, input_tokens, cache_read_tokens,
                  cache_creation_5m_tokens, cache_creation_1h_tokens
             FROM events WHERE ts_ms >= ? ORDER BY ts_ms, id`,
        )
        .all(sinceTsMs);
      for (const row of rows) {
        const account = decodeAccount(row['account']);
        const g = acc.get(account) ?? { input: 0, read: 0, c5m: 0, c1h: 0 };
        g.input += numOr0(row['input_tokens']);
        g.read += numOr0(row['cache_read_tokens']);
        g.c5m += numOr0(row['cache_creation_5m_tokens']);
        g.c1h += numOr0(row['cache_creation_1h_tokens']);
        acc.set(account, g);
      }
      return [...acc.entries()].map(([account, g]) => ({
        account,
        inputTokens: g.input,
        readTokens: g.read,
        creation5mTokens: g.c5m,
        creation1hTokens: g.c1h,
      }));
    },

    // COUNT-only aggregation (each count is bounded by the row count → can never
    // approach 2^53, so it's safe from the marshaling throw; token SUMS are never
    // done in SQL — module doc, point 2). First-appearance source order is
    // preserved via ROW_NUMBER() OVER (ORDER BY ts_ms, id) + MIN(__rn). The inner
    // subquery selects ONLY the columns the CASE-counts need (not `SELECT *`) —
    // the window ORDER BY still references ts_ms/id directly.
    healthCountsBySource: (sinceTsMs) =>
      driver
        .prepare(
          `SELECT source,
                  SUM(CASE WHEN error_kind='error' OR (error_kind IS NULL AND ok=0) THEN 1 ELSE 0 END) AS errs,
                  SUM(CASE WHEN error_kind='retry' THEN 1 ELSE 0 END) AS retries,
                  SUM(CASE WHEN error_kind='throttle' THEN 1 ELSE 0 END) AS throttles,
                  SUM(CASE WHEN error_kind='timeout' THEN 1 ELSE 0 END) AS timeouts
             FROM (
               SELECT source, error_kind, ok, ROW_NUMBER() OVER (ORDER BY ts_ms, id) AS __rn
               FROM events WHERE ts_ms >= ?
             )
            GROUP BY source
            ORDER BY MIN(__rn)`,
        )
        .all(sinceTsMs)
        .map(
          (row: SqlRow): SourceHealthCounts => ({
            source: decodeSource(row['source']),
            errorCount: Number(row['errs']),
            retryCount: Number(row['retries']),
            throttleCount: Number(row['throttles']),
            timeoutCount: Number(row['timeouts']),
          }),
        ),

    // Narrow (backend + token columns) scan, folded per backend in JS.
    tokenSumsByBackend: (sinceTsMs) => {
      const byBackend = new Map<Backend, number>();
      const rows = driver
        .prepare(
          `SELECT backend, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
             FROM events WHERE ts_ms >= ? ORDER BY ts_ms, id`,
        )
        .all(sinceTsMs);
      for (const row of rows) {
        const backend = decodeBackend(row['backend']);
        byBackend.set(backend, (byBackend.get(backend) ?? 0) + tokensOf(row));
      }
      return [...byBackend.entries()].map(([backend, tokens]) => ({ backend, tokens }));
    },

    // Narrow (skill + ok + token columns) scan, grouped + folded per skill in JS
    // (first-appearance order). COUNTs and the token fold all stay in JS.
    skillAggregates: (sinceTsMs) => {
      const bySkill = new Map<
        string,
        { invocations: number; okCount: number; outcomeCount: number; totalTokens: number }
      >();
      const rows = driver
        .prepare(
          `SELECT skill_name, ok, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
             FROM events WHERE ts_ms >= ? AND skill_name IS NOT NULL ORDER BY ts_ms, id`,
        )
        .all(sinceTsMs);
      for (const row of rows) {
        const skillName = String(row['skill_name']);
        const g = bySkill.get(skillName) ?? { invocations: 0, okCount: 0, outcomeCount: 0, totalTokens: 0 };
        g.invocations += 1;
        const ok = row['ok'];
        if (ok !== null && ok !== undefined) {
          g.outcomeCount += 1;
          if (Number(ok) === 1) g.okCount += 1;
        }
        g.totalTokens += tokensOf(row);
        bySkill.set(skillName, g);
      }
      return [...bySkill.entries()].map(([skillName, g]) => ({
        skillName,
        invocations: g.invocations,
        okCount: g.okCount,
        outcomeCount: g.outcomeCount,
        totalTokens: g.totalTokens,
      }));
    },

    outcomeCounts: (sinceCapturedMs) =>
      driver
        .prepare(
          `SELECT outcome, COUNT(*) AS cnt, MIN(rn) AS firstRn
             FROM (
               SELECT outcome, ROW_NUMBER() OVER (ORDER BY captured_at_ms, id) AS rn
               FROM session_outcomes WHERE captured_at_ms >= ?
             )
            GROUP BY outcome
            ORDER BY firstRn`,
        )
        .all(sinceCapturedMs)
        .map((row: SqlRow): OutcomeCount => ({ outcome: String(row['outcome']), count: Number(row['cnt']) })),

    // Narrow scan; `tokens` is folded in the JS map (never in SQL) so a single
    // row's 4-class sum crossing 2^53 cannot trip the node:sqlite marshaling throw.
    burnRows: (sinceTsMs) =>
      driver
        .prepare(
          `SELECT account, ts_ms AS ts, input_tokens, output_tokens,
                  cache_read_tokens, cache_creation_tokens
             FROM events WHERE ts_ms >= ? ORDER BY ts_ms, id`,
        )
        .all(sinceTsMs)
        .map(
          (row: SqlRow): BurnRow => ({
            account: decodeAccount(row['account']),
            tsMs: Number(row['ts']),
            tokens: tokensOf(row),
          }),
        ),

    costRows: (sinceTsMs, backend) =>
      driver
        .prepare(
          `SELECT ts_ms AS ts, provider, model, input_tokens, output_tokens,
                  cache_read_tokens, cache_creation_tokens, cost_estimated_usd, cost_actual_usd
             FROM events WHERE ts_ms >= ? AND backend = ? ORDER BY ts_ms, id`,
        )
        .all(sinceTsMs, backend)
        .map((row: SqlRow): CostRow => {
          const out: {
            tsMs: number;
            provider?: string;
            model?: string;
            inputTokens?: number;
            outputTokens?: number;
            cacheReadTokens?: number;
            cacheCreationTokens?: number;
            costEstimatedUsd?: number;
            costActualUsd?: number;
          } = { tsMs: Number(row['ts']) };
          const provider = optStr(row['provider']);
          if (provider !== undefined) out.provider = provider;
          const model = optStr(row['model']);
          if (model !== undefined) out.model = model;
          const input = optNum(row['input_tokens']);
          if (input !== undefined) out.inputTokens = input;
          const output = optNum(row['output_tokens']);
          if (output !== undefined) out.outputTokens = output;
          const cacheRead = optNum(row['cache_read_tokens']);
          if (cacheRead !== undefined) out.cacheReadTokens = cacheRead;
          const cacheCreation = optNum(row['cache_creation_tokens']);
          if (cacheCreation !== undefined) out.cacheCreationTokens = cacheCreation;
          const estimated = optNum(row['cost_estimated_usd']);
          if (estimated !== undefined) out.costEstimatedUsd = estimated;
          const actual = optNum(row['cost_actual_usd']);
          if (actual !== undefined) out.costActualUsd = actual;
          return out;
        }),

    estimateRows: (sinceTsMs) =>
      driver
        .prepare(
          `SELECT account, provider, model, input_tokens, output_tokens,
                  cache_read_tokens, cache_creation_tokens, cost_estimated_usd
             FROM events WHERE ts_ms >= ? ORDER BY ts_ms, id`,
        )
        .all(sinceTsMs)
        .map((row: SqlRow): EstimateRow => {
          const out: {
            account: AccountLabel;
            provider?: string;
            model?: string;
            inputTokens?: number;
            outputTokens?: number;
            cacheReadTokens?: number;
            cacheCreationTokens?: number;
            costEstimatedUsd?: number;
          } = { account: decodeAccount(row['account']) };
          const provider = optStr(row['provider']);
          if (provider !== undefined) out.provider = provider;
          const model = optStr(row['model']);
          if (model !== undefined) out.model = model;
          const input = optNum(row['input_tokens']);
          if (input !== undefined) out.inputTokens = input;
          const output = optNum(row['output_tokens']);
          if (output !== undefined) out.outputTokens = output;
          const cacheRead = optNum(row['cache_read_tokens']);
          if (cacheRead !== undefined) out.cacheReadTokens = cacheRead;
          const cacheCreation = optNum(row['cache_creation_tokens']);
          if (cacheCreation !== undefined) out.cacheCreationTokens = cacheCreation;
          const estimated = optNum(row['cost_estimated_usd']);
          if (estimated !== undefined) out.costEstimatedUsd = estimated;
          return out;
        }),

    latencySamples: (sinceTsMs) =>
      driver
        .prepare(
          `SELECT backend, latency_ms, ttft_ms
             FROM events WHERE ts_ms >= ? ORDER BY ts_ms, id`,
        )
        .all(sinceTsMs)
        .map((row: SqlRow): LatencySample => {
          const out: { backend: Backend; latencyMs?: number; ttftMs?: number } = {
            backend: decodeBackend(row['backend']),
          };
          const latency = optNum(row['latency_ms']);
          if (latency !== undefined) out.latencyMs = latency;
          const ttft = optNum(row['ttft_ms']);
          if (ttft !== undefined) out.ttftMs = ttft;
          return out;
        }),
  };
}
