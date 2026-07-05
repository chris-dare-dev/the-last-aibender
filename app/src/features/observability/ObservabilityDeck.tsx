/**
 * The observability deck — the ten §6.3 instrument dashboards in the
 * blueprint's FIXED order (quota gauges lead; DESIGN.md §2.5 flight-deck
 * principle: slots never reflow or reorder in response to data).
 *
 * Doctrine:
 *   - every degraded source is a dimmed engraved state with a COPY-command
 *     remediation affordance — never an error toast (§2.4 NO SIGNAL);
 *   - honest labeling: "ACTUAL" renders only for un-gated Cost Explorer
 *     actuals; API-equivalent USD is engraved as EQUIVALENCE · NOT SPEND;
 *   - streaming discipline: this tree renders from the rAF-projected
 *     observability store + the low-volume quota store — render counts are
 *     bounded by frames, never by wire messages (bind.ts);
 *   - a disconnected gateway dims EVERY instrument to NO SIGNAL (the FE-2
 *     channel-instrument doctrine) — slots retained.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { READ_MODEL_IDS, type QuotaWindow, type ReadModelId } from '@aibender/protocol';

/**
 * The §6.3 dashboard leads this deck renders, in blueprint order. This is the
 * ten-lead PREFIX of the frozen `READ_MODEL_IDS` registry: the eleventh entry,
 * `resource-health` (M6), is the supervision/governor instrument and is
 * produced + rendered SEPARATELY (ResourceHealthInstrument.tsx) — it rides the
 * same wire union but is not a §6.3 dashboard. Slicing the frozen registry
 * keeps this list in lock-step: if a future §6.3 lead is appended BEFORE
 * resource-health the slice widens automatically; the trailing supervision
 * kind is excluded by name so the deck's fixed geometry stays the ten leads.
 */
export const DASHBOARD_READ_MODEL_IDS: readonly ReadModelId[] = Object.freeze(
  READ_MODEL_IDS.filter((id) => id !== 'resource-health'),
);
import { backendLabel, connectionStore, quotaStore, useAccountRegistry } from '../../lib/index.ts';
import { Phosphor } from '../../chrome/phosphor.tsx';
import './observability.css';
import { fmtCountdown, fmtMs, fmtPct, fmtTokens, fmtTokensPerHour, fmtUsd } from './format.ts';
import { absentHealth, type InstrumentHealth, type Remediation } from './freshness.ts';
import {
  apiEquivalentVM,
  bedrockCostVM,
  burnRateVM,
  cacheHitVM,
  healthLeadVM,
  latencyVM,
  localOffloadVM,
  quotaGaugesVM,
  sessionOutcomesVM,
  skillLeaderboardVM,
} from './instruments.ts';
import { latestSnapshot, observabilityStore } from './store.ts';

/**
 * Engraved instrument labels for the ten §6.3 dashboard leads. Excludes the
 * M6 `resource-health` kind (rendered by ResourceHealthInstrument.tsx) — this
 * deck owns only the §6.3 leads. Keyed by every DASHBOARD_READ_MODEL_ID.
 */
export const INSTRUMENT_LABELS: Readonly<Record<Exclude<ReadModelId, 'resource-health'>, string>> =
  Object.freeze({
    'quota-gauges': 'QUOTA',
    'burn-rate': 'BURN RATE',
    'bedrock-cost': 'BEDROCK USD',
    'api-equivalent-usd': 'API-EQUIV USD',
    'cache-hit-rate': 'CACHE HIT',
    latency: 'LATENCY',
    health: 'ERR/THROTTLE',
    'skill-leaderboard': 'SKILLS',
    'session-outcomes': 'OUTCOMES',
    'local-offload': 'LOCAL OFFLOAD',
  });

const WINDOW_LABELS: Readonly<Record<QuotaWindow, string>> = Object.freeze({
  '5h': '5H',
  '7d': '7D',
  '7d_sonnet': '7D SON',
});

/**
 * The engraved backend label ([X1] ICR-0016): resolved through the frozen
 * backend REGISTRY via `backendLabel` (app/src/lib/backendLabels.ts), NOT a
 * closed `Record<Backend, string>`. Byte-identical for the built-in three
 * (`claude_code` → `CLAUDE`, etc.); a REGISTERED fourth backend surfaces its
 * derived label on the latency / api-equiv rows with NO edit here.
 */

/** Leaderboard display cap — fixed geometry; overflow reads "+N". */
export const MAX_LEADERBOARD_ROWS = 8;

export interface ObservabilityDeckProps {
  /** Injectable clock for countdowns (tests pin it; default Date.now). */
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

// ---------------------------------------------------------------------------
// Instrument shell — engraved header, per-source strip, remediation row
// ---------------------------------------------------------------------------

interface InstrumentProps {
  readonly id: Exclude<ReadModelId, 'resource-health'>;
  readonly health: InstrumentHealth;
  readonly detail?: string;
  readonly copyText: (text: string) => void;
  readonly children?: ReactNode;
}

function Instrument({ id, health, detail, copyText, children }: InstrumentProps): ReactNode {
  const [copied, setCopied] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (copied === undefined) return undefined;
    const handle = setTimeout(() => setCopied(undefined), 2000);
    return () => clearTimeout(handle);
  }, [copied]);

  const remediations = new Map<string, Remediation>();
  for (const entry of health.strip) {
    if (entry.remediation !== undefined) {
      remediations.set(entry.remediation.command, entry.remediation);
    }
  }

  return (
    <section
      className="ig-panel"
      data-status={health.status}
      data-instrument={id}
      data-testid={`instrument-${id}`}
      aria-label={`instrument ${INSTRUMENT_LABELS[id]}`}
    >
      <header className="ig-panel-header">
        <span className="ig-engraved">{INSTRUMENT_LABELS[id]}</span>
        <span
          className={`ig-panel-readout ${statusClass(health.status)}`}
          data-testid={`readout-${id}`}
        >
          {health.readout}
        </span>
      </header>
      <div className="ig-panel-body">
        {detail !== undefined ? <div className="ig-panel-detail">{detail}</div> : null}
        {children}
        {health.strip.length > 0 ? (
          <div data-testid={`sources-${id}`}>
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
                  copyText(remediation.command);
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

// ---------------------------------------------------------------------------
// Shared row primitives
// ---------------------------------------------------------------------------

function GaugeTrack({ pct }: { pct: number }): ReactNode {
  const fillStatus = pct >= 100 ? 'fault' : pct >= 75 ? 'degraded' : 'ok';
  return (
    <span className="ig-gauge-track">
      <span
        className="ig-gauge-fill"
        data-status={fillStatus}
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </span>
  );
}

// ---------------------------------------------------------------------------
// The deck
// ---------------------------------------------------------------------------

/** Countdown re-render cadence — low-frequency by design (not a stream). */
export const DECK_TICK_MS = 30_000;

export function ObservabilityDeck({ now, copyText }: ObservabilityDeckProps): ReactNode {
  const clock = now ?? Date.now;
  const copy = copyText ?? defaultCopyText;
  const phase = useStore(connectionStore, (s) => s.phase);
  const slots = useStore(observabilityStore, (s) => s.snapshots);
  const quota = useStore(quotaStore, (s) => s.snapshots);
  // FE-1: subscribe to the reactive registry so a broker-restart re-sync (a
  // newly-provisioned Claude account gaining its quota gauges / chips)
  // re-renders the deck immediately; the quota/offload VMs read the fresh
  // configured set on this render, not on the next DECK_TICK.
  const registry = useAccountRegistry();
  const claudeAccounts = registry.claudeAccounts.map((e) => e.label);
  const [, setTick] = useState(0);
  useEffect(() => {
    const handle = setInterval(() => setTick((t) => t + 1), DECK_TICK_MS);
    return () => clearInterval(handle);
  }, []);

  const at = clock();
  const connected = phase === 'connected';

  // A down gateway dims every instrument — NO SIGNAL, slots retained.
  if (!connected) {
    return (
      <div className="ig-obs-deck" data-testid="observability-deck">
        {DASHBOARD_READ_MODEL_IDS.map((id) => (
          <Instrument
            key={id}
            id={id as Exclude<ReadModelId, 'resource-health'>}
            health={absentHealth()}
            detail={phase === 'auth-rejected' ? 'GATEWAY AUTH FAULT' : 'NO GATEWAY'}
            copyText={copy}
          />
        ))}
      </div>
    );
  }

  const quotaVm = quotaGaugesVM(latestSnapshot(slots, 'quota-gauges'), quota, claudeAccounts);
  const burnVm = burnRateVM(latestSnapshot(slots, 'burn-rate'));
  const bedrockVm = bedrockCostVM(latestSnapshot(slots, 'bedrock-cost'));
  const equivVm = apiEquivalentVM(latestSnapshot(slots, 'api-equivalent-usd'));
  const cacheVm = cacheHitVM(latestSnapshot(slots, 'cache-hit-rate'));
  const latencyVmv = latencyVM(latestSnapshot(slots, 'latency'));
  const healthVm = healthLeadVM(latestSnapshot(slots, 'health'));
  const skillsVm = skillLeaderboardVM(latestSnapshot(slots, 'skill-leaderboard'));
  const outcomesVm = sessionOutcomesVM(latestSnapshot(slots, 'session-outcomes'));
  const offloadVm = localOffloadVM(latestSnapshot(slots, 'local-offload'));

  const skillRows = skillsVm.rows.slice(0, MAX_LEADERBOARD_ROWS);
  const skillOverflow = skillsVm.rows.length - skillRows.length;

  return (
    <div className="ig-obs-deck" data-testid="observability-deck">
      {/* 1 · QUOTA */}
      <Instrument id="quota-gauges" health={quotaVm.health} copyText={copy}>
        {quotaVm.rows.map((row) => (
          <div
            key={`${row.account}/${row.window}`}
            className="ig-gauge-row"
            data-testid={`quota-${row.account}-${row.window}`}
          >
            <span className="ig-engraved ig-obs-key">
              {row.account} {WINDOW_LABELS[row.window]}
            </span>
            {row.usedPct === undefined ? (
              <>
                <span className="ig-gauge-track" />
                <span className="ig-gauge-value ig-status-nosignal">—</span>
              </>
            ) : (
              <>
                <GaugeTrack pct={row.usedPct} />
                <Phosphor signal={row.capturedAt}>
                  <span className="ig-gauge-value">{fmtPct(row.usedPct)}</span>
                </Phosphor>
                <span className="ig-engraved">
                  R {row.resetsAt === undefined ? '—' : fmtCountdown(at, row.resetsAt)}
                </span>
              </>
            )}
          </div>
        ))}
      </Instrument>

      {/* 2 · BURN RATE */}
      <Instrument id="burn-rate" health={burnVm.health} copyText={copy}>
        {burnVm.rows.map((row) => (
          <div key={row.account} className="ig-obs-row" data-testid={`burn-${row.account}`}>
            <span className="ig-engraved ig-obs-key">{row.account}</span>
            <Phosphor signal={row.tokensPerHour}>
              <span className="ig-obs-num">{fmtTokensPerHour(row.tokensPerHour)}</span>
            </Phosphor>
            <span className="ig-engraved">
              {row.projectedExhaustionAt === undefined
                ? 'NO EXHAUSTION'
                : `EXH ${fmtCountdown(at, row.projectedExhaustionAt)}`}
            </span>
            <span className="ig-engraved ig-obs-unit">BLK {fmtCountdown(at, row.blockEndAt)}</span>
          </div>
        ))}
      </Instrument>

      {/* 3 · BEDROCK USD */}
      <Instrument id="bedrock-cost" health={bedrockVm.health} copyText={copy}>
        {bedrockVm.estimateMtdUsd !== undefined ? (
          <div className="ig-obs-row" data-testid="bedrock-estimate">
            <span className="ig-engraved ig-obs-key">EST MTD</span>
            <Phosphor signal={bedrockVm.estimateMtdUsd}>
              <span className="ig-obs-num">{fmtUsd(bedrockVm.estimateMtdUsd)}</span>
            </Phosphor>
            <span className="ig-engraved ig-obs-unit">ESTIMATE</span>
          </div>
        ) : null}
        {bedrockVm.actual !== undefined ? (
          <>
            <div className="ig-obs-row" data-testid="bedrock-actual">
              <span className="ig-engraved ig-obs-key">ACTUAL MTD</span>
              <Phosphor signal={bedrockVm.actual.mtdUsd}>
                <span className="ig-obs-num">{fmtUsd(bedrockVm.actual.mtdUsd)}</span>
              </Phosphor>
              {bedrockVm.actual.lagHours !== undefined ? (
                <span className="ig-engraved ig-obs-unit">LAG {bedrockVm.actual.lagHours}H</span>
              ) : null}
            </div>
            {bedrockVm.actual.yesterdayUsd !== undefined ? (
              <div className="ig-obs-row" data-testid="bedrock-actual-yday">
                <span className="ig-engraved ig-obs-key">ACTUAL YDAY</span>
                <span className="ig-obs-num">{fmtUsd(bedrockVm.actual.yesterdayUsd)}</span>
              </div>
            ) : null}
          </>
        ) : null}
      </Instrument>

      {/* 4 · API-EQUIV USD */}
      <Instrument
        id="api-equivalent-usd"
        health={equivVm.health}
        copyText={copy}
        {...(equivVm.windowDays !== undefined
          ? { detail: `EQUIVALENCE · NOT SPEND · ${equivVm.windowDays}D` }
          : {})}
      >
        {equivVm.rows.map((row) => (
          <div
            key={`${row.account}/${row.backend}`}
            className="ig-obs-row"
            data-testid={`equiv-${row.account}`}
          >
            <span className="ig-engraved ig-obs-key">
              {row.account} {backendLabel(row.backend)}
            </span>
            <Phosphor signal={row.equivalentUsd}>
              <span className="ig-obs-num">{fmtUsd(row.equivalentUsd)}</span>
            </Phosphor>
            <span className="ig-engraved ig-obs-unit">EQUIV</span>
          </div>
        ))}
      </Instrument>

      {/* 5 · CACHE HIT */}
      <Instrument id="cache-hit-rate" health={cacheVm.health} copyText={copy}>
        {cacheVm.rows.map((row) => (
          <div key={row.account} className="ig-obs-row" data-testid={`cache-${row.account}`}>
            <span className="ig-engraved ig-obs-key">{row.account}</span>
            <Phosphor signal={row.hitRatePct}>
              <span className="ig-obs-num">{fmtPct(row.hitRatePct)}</span>
            </Phosphor>
            <span className="ig-engraved ig-obs-unit">
              RD {fmtTokens(row.readTokens)} · 5M {fmtTokens(row.creation5mTokens)} · 1H{' '}
              {fmtTokens(row.creation1hTokens)}
            </span>
          </div>
        ))}
      </Instrument>

      {/* 6 · LATENCY */}
      <Instrument id="latency" health={latencyVmv.health} copyText={copy}>
        {latencyVmv.rows.map((row) => (
          <div key={row.backend} className="ig-obs-row" data-testid={`latency-${row.backend}`}>
            <span className="ig-engraved ig-obs-key">{backendLabel(row.backend)}</span>
            <span className="ig-obs-num">{fmtMs(row.p50Ms)}</span>
            <span className="ig-obs-num">{fmtMs(row.p95Ms)}</span>
            <span className="ig-engraved ig-obs-unit">
              {row.ttftP50Ms !== undefined && row.ttftP95Ms !== undefined
                ? `TTFT ${fmtMs(row.ttftP50Ms)}/${fmtMs(row.ttftP95Ms)} · `
                : ''}
              N{row.sampleCount}
            </span>
          </div>
        ))}
      </Instrument>

      {/* 7 · ERR/THROTTLE */}
      <Instrument id="health" health={healthVm.health} copyText={copy}>
        {healthVm.rows.map((row) => (
          <div key={row.source} className="ig-obs-row" data-testid={`health-${row.source}`}>
            <span className="ig-engraved ig-obs-key">{row.source}</span>
            <span className="ig-engraved">
              ERR {row.errorCount} · RTY {row.retryCount} · THR {row.throttleCount} · TMO{' '}
              {row.timeoutCount}
            </span>
            <span className="ig-engraved ig-obs-unit">{row.windowMinutes}M</span>
          </div>
        ))}
      </Instrument>

      {/* 8 · SKILLS */}
      <Instrument id="skill-leaderboard" health={skillsVm.health} copyText={copy}>
        {skillRows.map((row) => (
          <div
            key={row.skillName}
            className="ig-obs-row"
            data-testid={`skill-${row.skillName}`}
            data-worst-quartile={row.worstQuartile ? 'true' : 'false'}
          >
            <span className="ig-obs-key">{row.skillName}</span>
            <span className="ig-obs-num">×{row.invocations}</span>
            <span className="ig-obs-num">
              {row.successRatePct === undefined ? '—' : fmtPct(row.successRatePct)}
            </span>
            <span className="ig-engraved ig-obs-unit">
              {row.correctionRatePct === undefined ? 'CORR —' : `CORR ${fmtPct(row.correctionRatePct)}`}
              {row.tokensPerOutcome === undefined ? '' : ` · ${fmtTokens(row.tokensPerOutcome)}/OUT`}
            </span>
            {row.worstQuartile ? (
              <span className="ig-engraved ig-status-degraded" data-testid="worst-quartile-flag">
                Q4
              </span>
            ) : null}
          </div>
        ))}
        {skillOverflow > 0 ? (
          <div className="ig-obs-row ig-engraved ig-obs-unit">+{skillOverflow} MORE</div>
        ) : null}
      </Instrument>

      {/* 9 · OUTCOMES */}
      <Instrument
        id="session-outcomes"
        health={outcomesVm.health}
        copyText={copy}
        {...(outcomesVm.windowDays !== undefined ? { detail: `${outcomesVm.windowDays}D WINDOW` } : {})}
      >
        {outcomesVm.rows.map((row) => (
          <div key={row.outcome} className="ig-obs-row" data-testid={`outcome-${row.outcome}`}>
            <span className="ig-engraved ig-obs-key">{row.outcome}</span>
            <span className="ig-obs-num">{row.count}</span>
          </div>
        ))}
      </Instrument>

      {/* 10 · LOCAL OFFLOAD */}
      <Instrument id="local-offload" health={offloadVm.health} copyText={copy}>
        {offloadVm.data !== undefined ? (
          <>
            <div className="ig-obs-row" data-testid="offload-ratio">
              <Phosphor signal={offloadVm.data.offloadRatioPct}>
                <span className="ig-obs-numeral">{fmtPct(offloadVm.data.offloadRatioPct)}</span>
              </Phosphor>
              <GaugeTrack pct={offloadVm.data.offloadRatioPct} />
            </div>
            <div className="ig-obs-row ig-engraved ig-obs-unit">
              LOC {fmtTokens(offloadVm.data.localTokens)} · TOT{' '}
              {fmtTokens(offloadVm.data.totalTokens)} · {offloadVm.data.windowDays}D
            </div>
          </>
        ) : null}
      </Instrument>
    </div>
  );
}
