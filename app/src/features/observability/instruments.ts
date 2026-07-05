/**
 * Instrument view models — pure `frozen wire payloads → display data`
 * selectors for the ten §6.3 dashboard leads (blueprint order; the deck
 * renders them 1→10 in FIXED slots, DESIGN.md §2.5 flight-deck principle).
 *
 * Rules enforced here, before anything can render:
 *   - [X2] every open-vocabulary wire string (skill names, outcome facets)
 *     is shape-masked via the launch feature's maskIdentityShapedText —
 *     account references exist only as the frozen placeholder labels;
 *   - honest labeling: Bedrock actuals surface ONLY when the actuals feed is
 *     not estimate-gated ({@link actualsAreHonest}); estimates and actuals
 *     are separate rows (an OVERLAY — never summed); API-equivalent USD is
 *     an equivalence, never spend (the frozen `basis` literal is checked);
 *   - freshness → health via freshness.ts; data-driven escalation (quota
 *     100% = FAULT) never resurrects a NO SIGNAL instrument.
 */

import {
  ACCOUNT_LABELS,
  QUOTA_WINDOWS,
  type AccountLabel,
  type ApiEquivalentUsdSnapshot,
  type Backend,
  type BedrockCostSnapshot,
  type BurnRateSnapshot,
  type CacheHitRateSnapshot,
  type HealthSnapshot,
  type LatencySnapshot,
  type LocalOffloadSnapshot,
  type QuotaGaugesSnapshot,
  type QuotaSnapshot,
  type QuotaWindow,
  type SessionOutcomesSnapshot,
  type SkillLeaderboardSnapshot,
} from '@aibender/protocol';
import { accountRegistry, QUOTA_DEGRADED_PCT, quotaKey, type QuotaStoreState } from '../../lib/index.ts';
import { maskIdentityShapedText } from '../launch/index.ts';
import {
  absentHealth,
  actualsAreHonest,
  deriveInstrumentHealth,
  escalate,
  type InstrumentHealth,
  type InstrumentStatus,
} from './freshness.ts';

// ---------------------------------------------------------------------------
// 1 · QUOTA — per-account 5h + weekly gauges with reset countdowns
// ---------------------------------------------------------------------------

export interface GaugeSlot {
  readonly account: AccountLabel;
  readonly window: QuotaWindow;
}

/**
 * The primary gauge slots (Claude accounts × the two primary windows).
 * [X1] scalability (ICR-0013): derived from the CONFIGURED registry's Claude
 * accounts, not a hardcoded three — a 4th/5th Max account gets its 5h+7d
 * gauges with no code change. Defaults to the currently-configured registry.
 */
export function gaugeSlots(
  claudeAccounts: readonly AccountLabel[] = accountRegistry().claudeAccounts.map((e) => e.label),
): readonly GaugeSlot[] {
  return claudeAccounts.flatMap((account) =>
    (['5h', '7d'] as const).map((window) => ({ account, window })),
  );
}

/**
 * Back-compat constant: the six gauge slots for the SEED three placeholders.
 * Live rendering uses {@link gaugeSlots} (registry-driven); this stays for
 * tests/tools that pin the seed baseline.
 */
export const FIXED_GAUGE_SLOTS: readonly GaugeSlot[] = Object.freeze(
  gaugeSlots(['MAX_A', 'MAX_B', 'ENT']),
);

export interface QuotaGaugeRow {
  readonly account: AccountLabel;
  readonly window: QuotaWindow;
  /** undefined → this slot has NO SIGNAL (renders '—', never a zero). */
  readonly usedPct: number | undefined;
  readonly resetsAt: number | undefined;
  /** Freshness key for phosphor decay; undefined when the slot is silent. */
  readonly capturedAt: number | undefined;
}

export interface QuotaGaugesVM {
  readonly health: InstrumentHealth;
  readonly rows: readonly QuotaGaugeRow[];
}

interface GaugeValue {
  readonly usedPct: number;
  readonly resetsAt: number;
  readonly capturedAt: number;
}

/**
 * Merge the quota-gauges read model with the live `quota` channel store:
 * per (account, window) the NEWER capture wins — the read model carries the
 * per-source freshness truth, the quota channel streams between recomputes.
 */
export function quotaGaugesVM(
  snapshot: QuotaGaugesSnapshot | undefined,
  live: QuotaStoreState['snapshots'],
  // FE-1: the configured Claude accounts to lay out primary gauge rows for.
  // Defaults to the currently-configured registry; the deck passes the
  // reactive set so a broker-restart re-sync re-lays the gauges immediately.
  claudeAccounts: readonly AccountLabel[] = accountRegistry().claudeAccounts.map((e) => e.label),
): QuotaGaugesVM {
  const merged = new Map<string, GaugeValue>();
  if (snapshot !== undefined) {
    for (const gauge of snapshot.data.gauges) {
      merged.set(quotaKey(gauge.account, gauge.window), {
        usedPct: gauge.usedPct,
        resetsAt: gauge.resetsAt,
        capturedAt: snapshot.capturedAt,
      });
    }
  }
  for (const snap of Object.values<QuotaSnapshot | undefined>(live)) {
    if (snap === undefined) continue;
    const key = quotaKey(snap.account, snap.window);
    const existing = merged.get(key);
    if (existing === undefined || snap.capturedAt > existing.capturedAt) {
      merged.set(key, {
        usedPct: snap.usedPct,
        resetsAt: snap.resetsAt,
        capturedAt: snap.capturedAt,
      });
    }
  }

  if (snapshot === undefined && merged.size === 0) {
    return { health: absentHealth(), rows: fixedRows(merged, claudeAccounts) };
  }

  const rows = [...fixedRows(merged, claudeAccounts), ...extraRows(merged, claudeAccounts)];
  let worst: InstrumentStatus = 'ok';
  for (const row of rows) {
    if (row.usedPct === undefined) continue;
    if (row.usedPct >= 100) worst = 'fault';
    else if (row.usedPct >= QUOTA_DEGRADED_PCT && worst !== 'fault') worst = 'degraded';
  }
  const base =
    snapshot !== undefined
      ? deriveInstrumentHealth(snapshot.sources)
      : // Live-channel-only (read model not yet published): the feed that
        // just delivered is the signal; no per-source strip is fabricated.
        ({ status: 'ok', readout: 'OK', strip: [] } as InstrumentHealth);
  return { health: escalate(base, worst), rows };
}

function fixedRows(
  merged: ReadonlyMap<string, GaugeValue>,
  claudeAccounts?: readonly AccountLabel[],
): QuotaGaugeRow[] {
  return gaugeSlots(claudeAccounts).map((slot) => {
    const value = merged.get(quotaKey(slot.account, slot.window));
    return {
      account: slot.account,
      window: slot.window,
      usedPct: value?.usedPct,
      resetsAt: value?.resetsAt,
      capturedAt: value?.capturedAt,
    };
  });
}

/**
 * Gauges beyond the primary slots (e.g. 7d_sonnet) append in stable label
 * order. Scans the CONFIGURED registry's Claude accounts (registry order),
 * with the KNOWN seed set as a fallback superset so a snapshot for a not-yet-
 * configured account still surfaces rather than vanishing.
 */
function extraRows(
  merged: ReadonlyMap<string, GaugeValue>,
  claudeAccounts?: readonly AccountLabel[],
): QuotaGaugeRow[] {
  const primary = new Set(gaugeSlots(claudeAccounts).map((s) => quotaKey(s.account, s.window)));
  const claude = claudeAccounts ?? accountRegistry().claudeAccounts.map((e) => e.label);
  const scanAccounts: readonly AccountLabel[] = [...new Set([...claude, ...ACCOUNT_LABELS])];
  const rows: QuotaGaugeRow[] = [];
  for (const account of scanAccounts) {
    for (const window of QUOTA_WINDOWS) {
      const key = quotaKey(account, window);
      if (primary.has(key)) continue;
      const value = merged.get(key);
      if (value === undefined) continue;
      rows.push({
        account,
        window,
        usedPct: value.usedPct,
        resetsAt: value.resetsAt,
        capturedAt: value.capturedAt,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 2 · BURN RATE — current 5h block + projected exhaustion
// ---------------------------------------------------------------------------

export interface BurnRateRow {
  readonly account: AccountLabel;
  readonly tokensPerHour: number;
  readonly blockEndAt: number;
  readonly usedPct: number | undefined;
  /** undefined → the burn rate projects NO exhaustion this block. */
  readonly projectedExhaustionAt: number | undefined;
}

export interface BurnRateVM {
  readonly health: InstrumentHealth;
  readonly rows: readonly BurnRateRow[];
}

export function burnRateVM(snapshot: BurnRateSnapshot | undefined): BurnRateVM {
  if (snapshot === undefined) return { health: absentHealth(), rows: [] };
  const order = new Map<string, number>(ACCOUNT_LABELS.map((label, i) => [label, i]));
  const rows = [...snapshot.data.entries]
    .sort((a, b) => (order.get(a.account) ?? 99) - (order.get(b.account) ?? 99))
    .map((entry) => ({
      account: entry.account,
      tokensPerHour: entry.tokensPerHour,
      blockEndAt: entry.blockEndAt,
      usedPct: entry.usedPct,
      projectedExhaustionAt: entry.projectedExhaustionAt,
    }));
  const anyExhausting = rows.some((r) => r.projectedExhaustionAt !== undefined);
  return {
    health: escalate(deriveInstrumentHealth(snapshot.sources), anyExhausting ? 'degraded' : 'ok'),
    rows,
  };
}

// ---------------------------------------------------------------------------
// 3 · BEDROCK USD — real actuals with the client-side estimate OVERLAY
// ---------------------------------------------------------------------------

export interface BedrockCostVM {
  readonly health: InstrumentHealth;
  /** Always present, always labeled an estimate. */
  readonly estimateMtdUsd: number | undefined;
  /**
   * Rendered ONLY when actuals exist AND the actuals feed is not
   * estimate-gated — the string "ACTUAL" can never render otherwise
   * (the honest-labeling audit).
   */
  readonly actual:
    | { readonly mtdUsd: number; readonly yesterdayUsd?: number; readonly lagHours?: number }
    | undefined;
}

export function bedrockCostVM(snapshot: BedrockCostSnapshot | undefined): BedrockCostVM {
  if (snapshot === undefined) {
    return { health: absentHealth(), estimateMtdUsd: undefined, actual: undefined };
  }
  const honest = actualsAreHonest(snapshot.sources);
  const actual =
    honest && snapshot.data.actualMtdUsd !== undefined
      ? {
          mtdUsd: snapshot.data.actualMtdUsd,
          ...(snapshot.data.actualYesterdayUsd !== undefined
            ? { yesterdayUsd: snapshot.data.actualYesterdayUsd }
            : {}),
          ...(snapshot.data.actualLagHours !== undefined
            ? { lagHours: snapshot.data.actualLagHours }
            : {}),
        }
      : undefined;
  return {
    health: deriveInstrumentHealth(snapshot.sources),
    estimateMtdUsd: snapshot.data.estimateMtdUsd,
    actual,
  };
}

// ---------------------------------------------------------------------------
// 4 · API-EQUIV USD — equivalence, never spend
// ---------------------------------------------------------------------------

export interface ApiEquivalentRow {
  readonly account: AccountLabel;
  readonly backend: Backend;
  readonly equivalentUsd: number;
}

export interface ApiEquivalentVM {
  readonly health: InstrumentHealth;
  readonly rows: readonly ApiEquivalentRow[];
  readonly windowDays: number | undefined;
}

export function apiEquivalentVM(snapshot: ApiEquivalentUsdSnapshot | undefined): ApiEquivalentVM {
  // The frozen basis literal is validated on the wire; a snapshot that lost
  // it structurally cannot be labeled honestly → render nothing.
  if (snapshot === undefined || snapshot.data.basis !== 'api-equivalent') {
    return { health: absentHealth(), rows: [], windowDays: undefined };
  }
  const order = new Map<string, number>(ACCOUNT_LABELS.map((label, i) => [label, i]));
  const rows = [...snapshot.data.entries]
    .sort((a, b) => (order.get(a.account) ?? 99) - (order.get(b.account) ?? 99))
    .map((entry) => ({
      account: entry.account,
      backend: entry.backend,
      equivalentUsd: entry.equivalentUsd,
    }));
  return {
    health: deriveInstrumentHealth(snapshot.sources),
    rows,
    windowDays: snapshot.data.windowDays,
  };
}

// ---------------------------------------------------------------------------
// 5 · CACHE HIT — hit rate with the 5m/1h TTL split
// ---------------------------------------------------------------------------

export interface CacheHitRow {
  readonly account: AccountLabel;
  readonly hitRatePct: number;
  readonly readTokens: number;
  readonly creation5mTokens: number;
  readonly creation1hTokens: number;
}

export interface CacheHitVM {
  readonly health: InstrumentHealth;
  readonly rows: readonly CacheHitRow[];
}

export function cacheHitVM(snapshot: CacheHitRateSnapshot | undefined): CacheHitVM {
  if (snapshot === undefined) return { health: absentHealth(), rows: [] };
  const order = new Map<string, number>(ACCOUNT_LABELS.map((label, i) => [label, i]));
  const rows = [...snapshot.data.entries].sort(
    (a, b) => (order.get(a.account) ?? 99) - (order.get(b.account) ?? 99),
  );
  return { health: deriveInstrumentHealth(snapshot.sources), rows };
}

// ---------------------------------------------------------------------------
// 6 · LATENCY — p50/p95 + TTFT per backend
// ---------------------------------------------------------------------------

export interface LatencyVM {
  readonly health: InstrumentHealth;
  readonly rows: LatencySnapshot['data']['entries'];
}

export function latencyVM(snapshot: LatencySnapshot | undefined): LatencyVM {
  if (snapshot === undefined) return { health: absentHealth(), rows: [] };
  return { health: deriveInstrumentHealth(snapshot.sources), rows: snapshot.data.entries };
}

// ---------------------------------------------------------------------------
// 7 · ERR/THROTTLE — error/retry/throttle/timeout health
// ---------------------------------------------------------------------------

export interface HealthLeadVM {
  readonly health: InstrumentHealth;
  readonly rows: HealthSnapshot['data']['entries'];
}

export function healthLeadVM(snapshot: HealthSnapshot | undefined): HealthLeadVM {
  if (snapshot === undefined) return { health: absentHealth(), rows: [] };
  const anyTrouble = snapshot.data.entries.some(
    (e) => e.errorCount + e.retryCount + e.throttleCount + e.timeoutCount > 0,
  );
  return {
    health: escalate(deriveInstrumentHealth(snapshot.sources), anyTrouble ? 'degraded' : 'ok'),
    rows: snapshot.data.entries,
  };
}

// ---------------------------------------------------------------------------
// 8 · SKILLS — leaderboard with worst-quartile flags
// ---------------------------------------------------------------------------

export interface SkillRow {
  /** Shape-masked before render [X2]. */
  readonly skillName: string;
  readonly invocations: number;
  readonly successRatePct: number | undefined;
  /** Absent until the local-model correction classification ran (§6.3). */
  readonly correctionRatePct: number | undefined;
  readonly tokensPerOutcome: number | undefined;
  readonly worstQuartile: boolean;
}

export interface SkillLeaderboardVM {
  readonly health: InstrumentHealth;
  /** Wire order preserved — the producer owns the ranking. */
  readonly rows: readonly SkillRow[];
}

export function skillLeaderboardVM(
  snapshot: SkillLeaderboardSnapshot | undefined,
): SkillLeaderboardVM {
  if (snapshot === undefined) return { health: absentHealth(), rows: [] };
  const rows = snapshot.data.entries.map((entry) => ({
    skillName: maskIdentityShapedText(entry.skillName),
    invocations: entry.invocations,
    successRatePct: entry.successRatePct,
    correctionRatePct: entry.correctionRatePct,
    tokensPerOutcome: entry.tokensPerOutcome,
    worstQuartile: entry.worstQuartile,
  }));
  return { health: deriveInstrumentHealth(snapshot.sources), rows };
}

// ---------------------------------------------------------------------------
// 9 · OUTCOMES — session outcome / friction mix
// ---------------------------------------------------------------------------

export interface OutcomeRow {
  /** Shape-masked before render [X2] (open insights-facet vocabulary). */
  readonly outcome: string;
  readonly count: number;
}

export interface SessionOutcomesVM {
  readonly health: InstrumentHealth;
  readonly rows: readonly OutcomeRow[];
  readonly windowDays: number | undefined;
}

export function sessionOutcomesVM(
  snapshot: SessionOutcomesSnapshot | undefined,
): SessionOutcomesVM {
  if (snapshot === undefined) return { health: absentHealth(), rows: [], windowDays: undefined };
  const rows = snapshot.data.entries.map((entry) => ({
    outcome: maskIdentityShapedText(entry.outcome),
    count: entry.count,
  }));
  return {
    health: deriveInstrumentHealth(snapshot.sources),
    rows,
    windowDays: snapshot.data.windowDays,
  };
}

// ---------------------------------------------------------------------------
// 10 · LOCAL OFFLOAD — local/total token ratio
// ---------------------------------------------------------------------------

export interface LocalOffloadVM {
  readonly health: InstrumentHealth;
  readonly data: LocalOffloadSnapshot['data'] | undefined;
}

export function localOffloadVM(snapshot: LocalOffloadSnapshot | undefined): LocalOffloadVM {
  if (snapshot === undefined) return { health: absentHealth(), data: undefined };
  return { health: deriveInstrumentHealth(snapshot.sources), data: snapshot.data };
}
