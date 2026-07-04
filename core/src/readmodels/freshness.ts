/**
 * Per-source freshness state machine (BE-6; blueprint §6.3, plan §4/BE-6
 * item 2): LM-Studio-down, cluster-absent, SSO-expired, account-logged-out,
 * estimate-only are FRESHNESS STATES, never errors. Every read-model
 * snapshot carries its sources' freshness (the FROZEN-M3
 * `SourceFreshness` entries of readModels.ts); a degraded source renders
 * NO SIGNAL from its entry — producers never fabricate zeros.
 *
 * The machine per source:
 *
 *              recordSignal                    age > window
 *   no-signal ──────────────▶ fresh ─────────────────────────▶ stale
 *       ▲                        ▲          recordSignal          │
 *       │                        └─────────────────────────────────┘
 *       │  setCondition(c)                       setCondition(c)
 *       └─────────────▶ ⟨condition c⟩ ◀──────────────────────────┘
 *                          │  clearCondition
 *                          ▼
 *              (back to the signal-derived state above)
 *
 * Conditions are the externally-observed degradations (the BE-4 health
 * probe's `down` value, an SSO poller's 403, SI-4 gating). They OVERRIDE the
 * signal-derived state while set, and setting/clearing them is idempotent.
 *
 * CLOCK SKEW (plan §9.2 BE-6 edge): a signal timestamped AHEAD of `nowMs`
 * (source clock drift, week-boundary math on another host) is treated as
 * fresh — age clamps at 0, never negative-into-stale.
 */

import {
  SOURCE_FRESHNESS_STATES,
  type EventSource,
  type SourceFreshness,
  type SourceFreshnessState,
} from '@aibender/protocol';

/**
 * The five condition states (the frozen registry minus the signal-derived
 * trio fresh/stale/no-signal).
 */
export const FRESHNESS_CONDITIONS = Object.freeze(
  SOURCE_FRESHNESS_STATES.filter(
    (state): state is FreshnessCondition =>
      state !== 'fresh' && state !== 'stale' && state !== 'no-signal',
  ),
);

export type FreshnessCondition = Exclude<SourceFreshnessState, 'fresh' | 'stale' | 'no-signal'>;

export function isFreshnessCondition(value: unknown): value is FreshnessCondition {
  return (
    typeof value === 'string' && (FRESHNESS_CONDITIONS as readonly string[]).includes(value)
  );
}

/**
 * Default fresh→stale windows per source, from the §6.1 collection cadences:
 * live feeds (JSONL fs-watch, SSE, hooks, OTLP) go stale after 15 min of
 * silence; the quota tee pushes per active session (15 min); CloudWatch
 * polls every 5–15 min while active (30 min); Cost Explorer runs 1–2×/day
 * with ~24 h lag (48 h); the LM Studio health poll is short-cycle (15 min).
 */
export const DEFAULT_FRESH_WINDOW_MS = 15 * 60_000;

export const DEFAULT_SOURCE_WINDOWS_MS: Readonly<Partial<Record<EventSource, number>>> =
  Object.freeze({
    'bedrock-cost-explorer': 48 * 3_600_000,
    'bedrock-cloudwatch': 30 * 60_000,
  });

export interface FreshnessTrackerOptions {
  /** Fresh→stale window applied where no per-source override exists. */
  readonly freshWindowMs?: number;
  /** Per-source overrides; merged over {@link DEFAULT_SOURCE_WINDOWS_MS}. */
  readonly sourceWindowsMs?: Partial<Record<EventSource, number>>;
}

export interface FreshnessTracker {
  /** A signal from the source was ingested at `atMs` (epoch ms). */
  recordSignal(source: EventSource, atMs: number): void;
  /** Impose a condition state (down-as-state). Idempotent. */
  setCondition(source: EventSource, condition: FreshnessCondition): void;
  /** Lift the condition; the state falls back to signal-derived. Idempotent. */
  clearCondition(source: EventSource): void;
  /** Current condition, if any (observability/tests). */
  conditionOf(source: EventSource): FreshnessCondition | undefined;
  /** The frozen wire entry for one source at `nowMs`. */
  stateOf(source: EventSource, nowMs: number): SourceFreshness;
  /** The frozen wire entries for a snapshot's source set, in input order. */
  snapshotFor(sources: readonly EventSource[], nowMs: number): readonly SourceFreshness[];
}

export function createFreshnessTracker(options: FreshnessTrackerOptions = {}): FreshnessTracker {
  const defaultWindow = options.freshWindowMs ?? DEFAULT_FRESH_WINDOW_MS;
  const windows: Partial<Record<EventSource, number>> = {
    ...DEFAULT_SOURCE_WINDOWS_MS,
    ...options.sourceWindowsMs,
  };

  const lastIngestAt = new Map<EventSource, number>();
  const conditions = new Map<EventSource, FreshnessCondition>();

  const stateOf = (source: EventSource, nowMs: number): SourceFreshness => {
    const ingestAt = lastIngestAt.get(source);
    const condition = conditions.get(source);
    if (condition !== undefined) {
      return {
        source,
        state: condition,
        ...(ingestAt !== undefined ? { lastIngestAt: ingestAt } : {}),
      };
    }
    if (ingestAt === undefined) return { source, state: 'no-signal' };
    // Clock-skew clamp: a future-stamped signal has age 0 (fresh), never
    // a negative age that arithmetic could misread as stale.
    const age = Math.max(0, nowMs - ingestAt);
    const window = windows[source] ?? defaultWindow;
    return { source, state: age <= window ? 'fresh' : 'stale', lastIngestAt: ingestAt };
  };

  return {
    recordSignal: (source, atMs) => {
      const previous = lastIngestAt.get(source);
      // Monotonic: a late-arriving older signal never rewinds freshness.
      if (previous === undefined || atMs > previous) lastIngestAt.set(source, atMs);
    },
    setCondition: (source, condition) => {
      conditions.set(source, condition);
    },
    clearCondition: (source) => {
      conditions.delete(source);
    },
    conditionOf: (source) => conditions.get(source),
    stateOf,
    snapshotFor: (sources, nowMs) => sources.map((source) => stateOf(source, nowMs)),
  };
}
