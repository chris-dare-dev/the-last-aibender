/**
 * One channel instrument panel (DESIGN.md §2.5): engraved mono label with
 * the 2×16px index-hue tick, semantic status readout (never color-only —
 * OK/DEGRADED/FAULT/NO SIGNAL text always present), quota gauges on the
 * character grid, NO SIGNAL doctrine with a one-click remediation
 * affordance. Panels hold FIXED slots; a down channel dims, never vanishes.
 */

import type { ReactNode } from 'react';
import type { AccountLabel, QuotaSnapshot } from '@aibender/protocol';
import type { ChannelReading } from '../lib/stores/channelHealth.ts';
import { Phosphor } from './phosphor.tsx';

/**
 * Index-hue custom property for a channel label (identity tick use ONLY).
 * [X1]: retained for a closed-set label (max-a/max-b/ent/aws-dev→bedrock etc.);
 * the panel itself now takes the hue from the account-registry entry
 * (`reading.hueVar`) so a MAX_<X> account with no fixed hue still ticks a token.
 */
export function channelHueVar(label: AccountLabel): string {
  const suffix = label.toLowerCase().replace(/_/g, '-');
  return `var(--ig-channel-${suffix})`;
}

function statusClass(status: ChannelReading['status']): string {
  return `ig-status-${status}`;
}

function fmtResetTime(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function GaugeRow({ label, snapshot }: { label: string; snapshot: QuotaSnapshot | undefined }): ReactNode {
  if (snapshot === undefined) {
    return (
      <div className="ig-gauge-row">
        <span className="ig-engraved">{label}</span>
        <span className="ig-gauge-track" />
        <span className="ig-gauge-value ig-status-nosignal">—</span>
      </div>
    );
  }
  const pct = snapshot.usedPct;
  const fillStatus = pct >= 100 ? 'fault' : pct >= 75 ? 'degraded' : 'ok';
  return (
    <div className="ig-gauge-row">
      <span className="ig-engraved">{label}</span>
      <span className="ig-gauge-track">
        <span
          className="ig-gauge-fill"
          data-status={fillStatus}
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </span>
      <Phosphor signal={snapshot.capturedAt}>
        <span className="ig-gauge-value" data-testid={`gauge-${label}`}>
          {pct.toFixed(1)}%
        </span>
      </Phosphor>
      <span className="ig-engraved">R{fmtResetTime(snapshot.resetsAt)}</span>
    </div>
  );
}

export interface ChannelPanelProps {
  readonly reading: ChannelReading;
  readonly focused?: boolean;
  readonly onRemediate?: (channel: AccountLabel, remediation: string) => void;
}

export function ChannelPanel({ reading, focused, onRemediate }: ChannelPanelProps): ReactNode {
  // [X1]: identity + hue come from the registry-derived reading (open form),
  // not a closed ChannelId lookup — a MAX_<X> account panels correctly.
  const showGauges = reading.kind === 'claude';
  return (
    <section
      className="ig-panel"
      data-status={reading.status}
      data-channel={reading.channel}
      data-testid={`channel-${reading.channel}`}
      aria-label={`channel ${reading.label}`}
      style={focused === true ? { outline: 'var(--ig-focus-outline)', outlineOffset: 'calc(0px - var(--ig-focus-offset))' } : undefined}
    >
      <header className="ig-panel-header">
        <span>
          <span className="ig-engraved">{reading.label}</span>
          <span className="ig-channel-tick" style={{ background: reading.hueVar }} />
        </span>
        <span className={`ig-panel-readout ${statusClass(reading.status)}`} data-testid={`readout-${reading.channel}`}>
          {reading.readout}
        </span>
      </header>
      <div className="ig-panel-body">
        {showGauges ? (
          <>
            <GaugeRow label="5H" snapshot={reading.fiveHour} />
            <GaugeRow label="7D" snapshot={reading.sevenDay} />
          </>
        ) : null}
        <div className="ig-panel-detail">{reading.detail}</div>
        {reading.remediation !== undefined && onRemediate !== undefined ? (
          <button
            type="button"
            className="ig-btn"
            onClick={() => onRemediate(reading.channel, reading.remediation as string)}
          >
            {reading.remediation}
          </button>
        ) : null}
      </div>
    </section>
  );
}
