/**
 * The resource-health instrument — the M6 supervision/governor surface
 * (ws-protocol.md §13.4, blueprint §11). A SIBLING to the ten §6.3 leads on
 * the ObservabilityDeck: same engraved instrument shell, same NO SIGNAL
 * doctrine, but its own producer (the governor) and its own read model.
 *
 * Doctrine (identical to the deck, restated because this instrument is
 * standalone):
 *   - a shed/recycle renders as an instrument STATE row, NEVER a toast or an
 *     alarm (§13.4 / M3 freshness doctrine) — the [X1] sacrifice order is a
 *     readout, not an error;
 *   - pressure is the STATE the wire carries; the gauge fill uses the shared
 *     status vocabulary (amber → degraded, red → fault);
 *   - a disconnected gateway dims the instrument to NO SIGNAL, slot retained
 *     (the FE-2 channel-instrument doctrine);
 *   - streaming discipline: renders from the rAF-projected observability store
 *     (bind.ts) — commits are bounded by frames, never by wire messages;
 *   - [X2] labels + numbers only: accounts are frozen placeholder labels,
 *     backends are re-labelled through the shared map, `slot` is a display
 *     ordinal — no native id, cwd or title exists on the wire to leak.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { backendLabel, connectionStore } from '../../lib/index.ts';
import './resourceHealth.css';
import { fmtAge, fmtBytes, fmtMb, fmtPct } from './format.ts';
import { absentHealth, type InstrumentHealth, type Remediation } from './freshness.ts';
import {
  MAX_NOTICE_ROWS,
  resourceHealthVM,
  type PressureVM,
  type ResourceHealthVM,
} from './resourceHealth.ts';
import { latestSnapshot, observabilityStore } from './store.ts';

/**
 * Engraved backend labels ([X1] ICR-0016): resolved through the frozen backend
 * REGISTRY via `backendLabel` (app/src/lib/backendLabels.ts) — the deck shares
 * the same seam. Byte-identical for the built-in three; a REGISTERED fourth
 * backend surfaces its derived label on the session / notice rows with NO edit
 * here (labels only [X2]).
 */

/** The instrument's engraved header label. */
export const RESOURCE_HEALTH_LABEL = 'RESOURCE HEALTH';

/** Countdown/age re-render cadence — low-frequency by design (not a stream). */
export const RESOURCE_TICK_MS = 30_000;

export interface ResourceHealthInstrumentProps {
  /** Injectable clock for notice ages (tests pin it; default Date.now). */
  readonly now?: () => number;
  /**
   * Copy sink for remediation commands (owner-run — the app only copies).
   * Defaults to the async clipboard API when present.
   */
  readonly copyText?: (text: string) => void;
}

function defaultCopyText(text: string): void {
  const nav = globalThis.navigator as Navigator | undefined;
  void nav?.clipboard?.writeText(text).catch(() => undefined);
}

function statusClass(status: InstrumentHealth['status']): string {
  return `ig-status-${status}`;
}

/** Pressure gauge fill status maps directly from the instrument status. */
function pressureFillStatus(health: InstrumentHealth['status']): string {
  return health === 'fault' ? 'fault' : health === 'degraded' ? 'degraded' : 'ok';
}

function PressureBlock({
  pressure,
  fillStatus,
}: {
  readonly pressure: PressureVM;
  readonly fillStatus: string;
}): ReactNode {
  return (
    <>
      <div className="ig-gauge-row" data-testid="pressure-gauge">
        <span className="ig-engraved ig-obs-key">PRESSURE {pressure.state.toUpperCase()}</span>
        <span className="ig-gauge-track">
          <span
            className="ig-gauge-fill"
            data-status={fillStatus}
            // Level 0..4 → 0..100% of the track. Layout width only; not a color.
            style={{ width: `${Math.min(100, Math.max(0, pressure.level * 25))}%` }}
          />
        </span>
        <span className="ig-obs-num" data-testid="pressure-level">
          L{pressure.level}
        </span>
      </div>
      <div className="ig-obs-row ig-engraved ig-obs-unit" data-testid="pressure-detail">
        FREE {fmtPct(pressure.freeRamPct)} · SWAP {fmtBytes(pressure.swapUsedBytes)} · RES{' '}
        {pressure.residentSessionCount}
        {pressure.localModelResidentBytes !== undefined
          ? ` · LMR ${fmtBytes(pressure.localModelResidentBytes)}`
          : ' · LMR —'}
      </div>
    </>
  );
}

export function ResourceHealthInstrument({
  now,
  copyText,
}: ResourceHealthInstrumentProps): ReactNode {
  const clock = now ?? Date.now;
  const copy = copyText ?? defaultCopyText;
  const phase = useStore(connectionStore, (s) => s.phase);
  const slots = useStore(observabilityStore, (s) => s.snapshots);
  const [, setTick] = useState(0);
  const [copied, setCopied] = useState<string | undefined>(undefined);

  useEffect(() => {
    const handle = setInterval(() => setTick((t) => t + 1), RESOURCE_TICK_MS);
    return () => clearInterval(handle);
  }, []);
  useEffect(() => {
    if (copied === undefined) return undefined;
    const handle = setTimeout(() => setCopied(undefined), 2000);
    return () => clearTimeout(handle);
  }, [copied]);

  const connected = phase === 'connected';
  // A down gateway dims the instrument to NO SIGNAL, slot retained.
  const vm: ResourceHealthVM = connected
    ? resourceHealthVM(latestSnapshot(slots, 'resource-health'))
    : { health: absentHealth(), pressure: undefined, sessions: [], notices: [] };
  const { health } = vm;
  const at = clock();

  const remediations = new Map<string, Remediation>();
  for (const entry of health.strip) {
    if (entry.remediation !== undefined) remediations.set(entry.remediation.command, entry.remediation);
  }

  const noticeRows = vm.notices.slice(0, MAX_NOTICE_ROWS);
  const noticeOverflow = vm.notices.length - noticeRows.length;
  const detail = !connected
    ? phase === 'auth-rejected'
      ? 'GATEWAY AUTH FAULT'
      : 'NO GATEWAY'
    : undefined;

  return (
    <section
      className="ig-panel ig-rh"
      data-status={health.status}
      data-instrument="resource-health"
      data-testid="instrument-resource-health"
      aria-label={`instrument ${RESOURCE_HEALTH_LABEL}`}
    >
      <header className="ig-panel-header">
        <span className="ig-engraved">{RESOURCE_HEALTH_LABEL}</span>
        <span
          className={`ig-panel-readout ${statusClass(health.status)}`}
          data-testid="readout-resource-health"
        >
          {health.readout}
        </span>
      </header>
      <div className="ig-panel-body">
        {detail !== undefined ? <div className="ig-panel-detail">{detail}</div> : null}

        {vm.pressure !== undefined ? (
          <PressureBlock pressure={vm.pressure} fillStatus={pressureFillStatus(health.status)} />
        ) : null}

        {/* Per-session footprints — labels + numbers only [X2]. */}
        {vm.sessions.length > 0 ? (
          <div data-testid="rh-sessions">
            {vm.sessions.map((row) => (
              <div
                key={`${row.account}/${row.backend}/${row.slot}`}
                className="ig-obs-row"
                data-testid={`rh-session-${row.account}-${row.slot}`}
                data-band={row.band}
                data-hibernated={row.hibernated ? 'true' : 'false'}
              >
                <span className="ig-engraved ig-obs-key">
                  {row.account} {backendLabel(row.backend)} #{row.slot}
                </span>
                <span className="ig-obs-num">{fmtMb(row.footprintMb)}</span>
                <span className={`ig-engraved ${statusClass(row.bandStatus)}`}>
                  {row.band.toUpperCase()}
                </span>
                {row.hibernated ? (
                  <span className="ig-engraved ig-obs-unit" data-testid="rh-hibernated">
                    HIBERNATED
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : vm.pressure !== undefined ? (
          <div className="ig-obs-row ig-engraved ig-obs-unit" data-testid="rh-no-sessions">
            NO RESIDENT SESSIONS
          </div>
        ) : null}

        {/* Shed/recycle notices as STATE rows — never an error/toast (§13.4). */}
        {noticeRows.length > 0 ? (
          <div data-testid="rh-notices">
            {noticeRows.map((row) => (
              <div
                key={`${row.action}:${row.at}:${row.account ?? ''}:${row.backend ?? ''}`}
                className="ig-obs-row ig-rh-notice"
                data-testid={`rh-notice-${row.action}`}
                data-recycle={row.isRecycle ? 'true' : 'false'}
              >
                <span className="ig-engraved ig-obs-key">{row.label}</span>
                {row.account !== undefined && row.backend !== undefined ? (
                  <span className="ig-engraved">
                    {row.account} {backendLabel(row.backend)}
                  </span>
                ) : (
                  <span className="ig-engraved ig-obs-unit">MACHINE</span>
                )}
                <span className="ig-engraved ig-obs-unit">{fmtAge(at, row.at)} AGO</span>
              </div>
            ))}
            {noticeOverflow > 0 ? (
              <div className="ig-obs-row ig-engraved ig-obs-unit">+{noticeOverflow} MORE</div>
            ) : null}
          </div>
        ) : null}

        {/* Per-source freshness strip: degraded governor feeds render as
            dimmed STATE entries — never an error (identical to the deck). */}
        {health.strip.length > 0 ? (
          <div data-testid="rh-sources">
            {health.strip.map((entry) => (
              <div
                key={`${entry.source}:${entry.state}`}
                className="ig-obs-source"
                data-state={entry.state}
              >
                <span
                  className={`ig-engraved ${entry.cls === 'down' ? 'ig-status-nosignal' : 'ig-status-degraded'}`}
                >
                  {entry.source} · {entry.state === 'no-signal' ? 'NO SIGNAL' : entry.state}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {remediations.size > 0 ? (
          <div className="ig-obs-remediations">
            {[...remediations.values()].map((remediation) => (
              <button
                key={remediation.command}
                type="button"
                className="ig-btn"
                data-remediation={remediation.command}
                onClick={() => {
                  copy(remediation.command);
                  setCopied(remediation.command);
                }}
              >
                {copied === remediation.command ? 'COPIED' : remediation.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
