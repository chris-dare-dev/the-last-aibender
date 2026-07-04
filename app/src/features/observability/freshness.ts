/**
 * Per-source freshness → instrument health (pure).
 *
 * Doctrine (blueprint §6.3, DESIGN.md §2.4, plan FE-5): degraded sources are
 * STATES, never errors. A source that is down renders as a dimmed engraved
 * NO SIGNAL element with a one-click remediation affordance (a COPY action —
 * logins/server starts are owner-run; the harness never mutates external
 * systems from a dashboard button). An instrument whose every source is down
 * dims whole; the slot is always retained.
 *
 * State classes over the frozen SOURCE_FRESHNESS_STATES vocabulary:
 *   live  fresh
 *   soft  stale · estimate-only        (signal renders, honestly labeled)
 *   down  no-signal · lmstudio-down · cluster-absent · sso-expired ·
 *         account-logged-out           (per-source NO SIGNAL treatment)
 */

import type { EventSource, SourceFreshness, SourceFreshnessState } from '@aibender/protocol';

export type InstrumentStatus = 'ok' | 'degraded' | 'fault' | 'nosignal';

/** Engraved readout vocabulary — semantic text, never color-only (§2.4/§9). */
export type InstrumentReadout = 'OK' | 'DEGRADED' | 'ESTIMATE' | 'FAULT' | 'NO SIGNAL';

export type FreshnessClass = 'live' | 'soft' | 'down';

const STATE_CLASS: Readonly<Record<SourceFreshnessState, FreshnessClass>> = Object.freeze({
  fresh: 'live',
  stale: 'soft',
  'estimate-only': 'soft',
  'no-signal': 'down',
  'lmstudio-down': 'down',
  'cluster-absent': 'down',
  'sso-expired': 'down',
  'account-logged-out': 'down',
});

export function freshnessClass(state: SourceFreshnessState): FreshnessClass {
  return STATE_CLASS[state];
}

/** One-click remediation: a command the OWNER runs — surfaced as a copy action. */
export interface Remediation {
  /** Engraved affordance label. */
  readonly label: string;
  /** The exact command copied to the clipboard (never executed by the app). */
  readonly command: string;
}

const REMEDIATIONS: Readonly<Partial<Record<SourceFreshnessState, Remediation>>> = Object.freeze({
  'lmstudio-down': Object.freeze({ label: 'LMS SERVER START', command: 'lms server start' }),
  'sso-expired': Object.freeze({ label: 'AWS SSO LOGIN', command: 'aws sso login' }),
  'account-logged-out': Object.freeze({ label: 'CLAUDE /LOGIN', command: 'claude /login' }),
});

export function remediationFor(state: SourceFreshnessState): Remediation | undefined {
  return REMEDIATIONS[state];
}

/** Engraved per-source strip entry (only non-fresh sources render — quiet cockpit). */
export interface SourceStripEntry {
  readonly source: EventSource;
  readonly state: SourceFreshnessState;
  readonly cls: FreshnessClass;
  readonly remediation: Remediation | undefined;
}

export interface InstrumentHealth {
  readonly status: InstrumentStatus;
  readonly readout: InstrumentReadout;
  /** Non-fresh sources, wire order preserved (fresh sources stay silent). */
  readonly strip: readonly SourceStripEntry[];
}

/**
 * Fold a snapshot's REQUIRED sources array into instrument health.
 *
 * Precedence (deterministic):
 *   1. no sources at all → NO SIGNAL (an absent snapshot is the caller's
 *      NO SIGNAL — see {@link absentHealth});
 *   2. every source down  → NO SIGNAL (whole instrument dims, slot retained);
 *   3. any down or stale  → DEGRADED (partial signal renders, dimmed strip);
 *   4. remaining soft all estimate-only → ESTIMATE (honest labeling state);
 *   5. all live           → OK.
 */
export function deriveInstrumentHealth(sources: readonly SourceFreshness[]): InstrumentHealth {
  const strip: SourceStripEntry[] = [];
  let live = 0;
  let stale = 0;
  let estimateOnly = 0;
  let down = 0;
  for (const entry of sources) {
    const cls = freshnessClass(entry.state);
    if (cls === 'live') {
      live += 1;
      continue; // fresh sources stay off the strip
    }
    if (entry.state === 'stale') stale += 1;
    else if (entry.state === 'estimate-only') estimateOnly += 1;
    else down += 1;
    strip.push({
      source: entry.source,
      state: entry.state,
      cls,
      remediation: remediationFor(entry.state),
    });
  }

  if (sources.length === 0 || (down > 0 && live === 0 && stale === 0 && estimateOnly === 0)) {
    return { status: 'nosignal', readout: 'NO SIGNAL', strip };
  }
  if (down > 0 || stale > 0) return { status: 'degraded', readout: 'DEGRADED', strip };
  if (estimateOnly > 0) return { status: 'degraded', readout: 'ESTIMATE', strip };
  return { status: 'ok', readout: 'OK', strip };
}

/** The health of an instrument whose read model has never arrived. */
export function absentHealth(): InstrumentHealth {
  return { status: 'nosignal', readout: 'NO SIGNAL', strip: [] };
}

/** True when actuals may be labeled ACTUAL: the actuals feed is NOT estimate-gated. */
export function actualsAreHonest(sources: readonly SourceFreshness[]): boolean {
  return !sources.some((s) => s.state === 'estimate-only');
}

/**
 * Escalate freshness-derived health with data-driven status (e.g. a quota
 * gauge at 100% is a FAULT even on a fresh feed). NO SIGNAL always wins —
 * fabricated data never escalates a dead instrument.
 */
export function escalate(health: InstrumentHealth, dataStatus: InstrumentStatus): InstrumentHealth {
  if (health.status === 'nosignal' || dataStatus === 'ok') return health;
  const rank: Record<InstrumentStatus, number> = { nosignal: 0, ok: 1, degraded: 2, fault: 3 };
  if (rank[dataStatus] <= rank[health.status]) return health;
  const readout: InstrumentReadout = dataStatus === 'fault' ? 'FAULT' : 'DEGRADED';
  return { status: dataStatus, readout, strip: health.strip };
}
