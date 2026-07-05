/**
 * Resource-health instrument view model — pure `frozen wire payload →
 * display data` selector for the M6 supervision/governor instrument
 * (ws-protocol.md §13.4, blueprint §11). This is the ELEVENTH read model and
 * a SIBLING to the ten §6.3 dashboard leads: its producer is the governor
 * (plan BE-9), not the §6.3 observability publisher, so it renders as its own
 * instrument rather than a row on the M3 deck.
 *
 * Doctrine enforced here, before anything can render:
 *   - a shed/recycle is a STATE, never an error — {@link ShedNoticeRow} is a
 *     first-class instrument row (M3 freshness doctrine, §13.4); nothing here
 *     ever produces a toast or an alarm class;
 *   - pressure is the STATE the wire carries (`PRESSURE_STATES`
 *     normal|amber|red) mapped to the shared instrument status vocabulary so
 *     the sibling reuses the deck's engraved readout + gauge primitives;
 *   - freshness → health via freshness.ts (a missing governor feed is
 *     NO SIGNAL, never fabricated zeros — the same absence rule as the leads);
 *   - [X2] labels + numbers only: `account`/`backend` are frozen placeholder
 *     labels, `slot` is the per-account DISPLAY ordinal (never a native id),
 *     and there is no cwd/title on the wire to leak — the VM re-labels
 *     backends through the shared BACKEND label map and carries nothing else.
 */

import {
  PRESSURE_STATES,
  SHED_ACTIONS,
  type PressureState,
  type ResourceHealthSnapshot,
  type SessionFootprint,
  type ShedAction,
  type ShedNotice,
} from '@aibender/protocol';

/**
 * The frozen watchdog band. The `WatchdogBand` *type* is not on the protocol
 * barrel (only the `WATCHDOG_BANDS` value + `isWatchdogBand` guard are), so we
 * derive it structurally from the frozen `SessionFootprint.band` field — this
 * stays pinned to the contract without an extra protocol export.
 */
export type WatchdogBand = SessionFootprint['band'];
import {
  absentHealth,
  deriveInstrumentHealth,
  escalate,
  type InstrumentHealth,
  type InstrumentStatus,
} from './freshness.ts';

/**
 * Pressure STATE → instrument status. `normal` is OK; `amber` degrades;
 * `red` is a FAULT (the governor is actively shedding). This never resurrects
 * a NO SIGNAL instrument — escalate() keeps a dead feed dead (§13.2 honesty
 * pin: the freshness truth wins over data).
 */
export const PRESSURE_STATUS: Readonly<Record<PressureState, InstrumentStatus>> = Object.freeze({
  normal: 'ok',
  amber: 'degraded',
  red: 'fault',
});

/** Per-session watchdog band → instrument status (ok|warn|recycle). */
export const BAND_STATUS: Readonly<Record<WatchdogBand, InstrumentStatus>> = Object.freeze({
  ok: 'ok',
  warn: 'degraded',
  recycle: 'fault',
});

/**
 * Engraved shed/recycle action labels (the [X1] sacrifice order + recycle,
 * §13.4). Terse, uppercase, character-grid friendly — display strings only,
 * never re-deriving the closed `SHED_ACTIONS` registry.
 */
export const SHED_ACTION_LABELS: Readonly<Record<ShedAction, string>> = Object.freeze({
  'shed-local-model': 'SHED LOCAL MODEL',
  'shed-model-context': 'SHED MODEL CTX',
  'shed-frontend-weight': 'SHED FE WEIGHT',
  'hibernate-non-account': 'HIBERNATE NON-ACCT',
  'trim-scrollback': 'TRIM SCROLLBACK',
  'recycle-session': 'RECYCLE SESSION',
});

/** One per-session footprint row — labels + numbers only [X2]. */
export interface SessionFootprintRow {
  readonly account: SessionFootprint['account'];
  readonly backend: SessionFootprint['backend'];
  /** Per-account display ordinal (≥0) — never a native id [X2]. */
  readonly slot: number;
  readonly footprintMb: number;
  readonly band: WatchdogBand;
  readonly bandStatus: InstrumentStatus;
  readonly hibernated: boolean;
}

/** One shed/recycle notice, as a STATE row (never an error). */
export interface ShedNoticeRow {
  readonly action: ShedAction;
  readonly label: string;
  /** Epoch ms the action was taken (freshness-doctrine timestamp). */
  readonly at: number;
  /** Present only when the action targets a specific labeled line. */
  readonly account: ShedNotice['account'];
  readonly backend: ShedNotice['backend'];
  /** True for `recycle-session` — recycle IS the account continuation [X4]. */
  readonly isRecycle: boolean;
}

export interface PressureVM {
  /** The STATE the wire carries (normal|amber|red). */
  readonly state: PressureState;
  /** macOS pressure level 0..4. */
  readonly level: number;
  /** Free physical RAM percentage, 0..100. */
  readonly freeRamPct: number;
  readonly swapUsedBytes: number;
  readonly residentSessionCount: number;
  /** The ONE global local-model resident budget line; undefined = not readable. */
  readonly localModelResidentBytes: number | undefined;
}

export interface ResourceHealthVM {
  /** NO SIGNAL / DEGRADED / OK / FAULT — pressure escalates the freshness base. */
  readonly health: InstrumentHealth;
  /** undefined ONLY when the snapshot has never arrived (absent = NO SIGNAL). */
  readonly pressure: PressureVM | undefined;
  /** Per-session footprints, wire order preserved (the producer owns the order). */
  readonly sessions: readonly SessionFootprintRow[];
  /**
   * Shed/recycle notices as STATE rows, newest first (§13.4 does NOT require
   * wire order, so the VM sorts by `at` descending for a stable timeline).
   */
  readonly notices: readonly ShedNoticeRow[];
}

/**
 * The number of most-recent notices the instrument shows before collapsing to
 * a "+N" overflow line (fixed geometry — the flight-deck slot never reflows).
 */
export const MAX_NOTICE_ROWS = 6;

function footprintRow(session: SessionFootprint): SessionFootprintRow {
  return {
    account: session.account,
    backend: session.backend,
    slot: session.slot,
    footprintMb: session.footprintMb,
    band: session.band,
    bandStatus: BAND_STATUS[session.band],
    hibernated: session.hibernated === true,
  };
}

function noticeRow(notice: ShedNotice): ShedNoticeRow {
  return {
    action: notice.action,
    label: SHED_ACTION_LABELS[notice.action],
    at: notice.at,
    account: notice.account,
    backend: notice.backend,
    isRecycle: notice.action === 'recycle-session',
  };
}

/**
 * Derive the supervision instrument's display data from the frozen snapshot.
 *
 * An absent snapshot is NO SIGNAL (never a fabricated healthy state). A
 * present snapshot's pressure STATE escalates the freshness-derived health so
 * a red-pressure feed reads FAULT while a down feed still reads NO SIGNAL.
 */
export function resourceHealthVM(snapshot: ResourceHealthSnapshot | undefined): ResourceHealthVM {
  if (snapshot === undefined) {
    return { health: absentHealth(), pressure: undefined, sessions: [], notices: [] };
  }
  const { data } = snapshot;
  const health = escalate(
    deriveInstrumentHealth(snapshot.sources),
    PRESSURE_STATUS[data.pressureState],
  );
  const pressure: PressureVM = {
    state: data.pressureState,
    level: data.pressureLevel,
    freeRamPct: data.freeRamPct,
    swapUsedBytes: data.swapUsedBytes,
    residentSessionCount: data.residentSessionCount,
    localModelResidentBytes: data.localModelResidentBytes,
  };
  const sessions = data.sessions.map(footprintRow);
  const notices = [...data.notices].sort((a, b) => b.at - a.at).map(noticeRow);
  return { health, pressure, sessions, notices };
}

// Re-exported registry references so the component + specs pin the frozen
// vocabularies without re-importing the protocol directly (single seam).
export { PRESSURE_STATES, SHED_ACTIONS };
