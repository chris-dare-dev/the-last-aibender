/**
 * Channel instrument readings — pure selectors deriving the channel panels'
 * state (DESIGN.md §2.5) from the connection/quota/session stores.
 *
 * [X1] scalability (ICR-0013 / ADR-0001): one reading per CONFIGURED account
 * (the FE-2 `accountRegistry()` seam — N Claude accounts + the two fixed
 * backend labels), NOT a hardcoded five. A newly provisioned Max account
 * (MAX_C, MAX_D, …) gets a channel panel with the same Claude quota-gauge
 * treatment, driven by DATA — no code change, no new token.
 *
 * Status semantics are the NORMATIVE meanings of DESIGN.md §2.4:
 *   ok        healthy / connected / within budget
 *   degraded  soft-threshold breach (quota ≥75%, stale, feature-detect open)
 *   fault     hard failure (quota 100%, auth lost)
 *   nosignal  source absent or off — a dimmed instrument, NEVER an error
 *
 * A down gateway means every instrument reads NO SIGNAL: instruments don't
 * disappear, they dim (slots are always retained).
 *
 * [X2]: the only account text a reading can carry is `channel`/`label` — a
 * sanctioned placeholder from the registry (every registry entry passed the
 * `isClaudeAccountLabel`/fixed-backend gate). No raw identity can flow here.
 */

import type { AccountLabel, QuotaSnapshot, SessionStatus } from '@aibender/protocol';
import { accountRegistry, type AccountRegistryEntry } from '../accountRegistry.ts';
import { detectEntCapabilities, entDegradedCapabilities } from '../entCapabilities.ts';
import type { ClientPhase } from '../ws/wsClient.ts';
import type { QuotaStoreState } from './quotaStore.ts';
import { quotaKey } from './quotaStore.ts';

export type ChannelStatus = 'ok' | 'degraded' | 'fault' | 'nosignal';

/** Soft-threshold per DESIGN.md §2.4 ("quota ≥75%, memory amber"). */
export const QUOTA_DEGRADED_PCT = 75;

export interface ChannelReading {
  /**
   * The stable panel identity: the account label (open form). This REPLACES
   * the old closed `ChannelId` — a `MAX_<X>`/`ENT` Claude label or a fixed
   * backend label, all sanctioned placeholders.
   */
  readonly channel: AccountLabel;
  /** Engraved panel label text (identical to `channel` — the placeholder). */
  readonly label: string;
  /** Whether this is a Claude subscription account or a fixed backend. */
  readonly kind: AccountRegistryEntry['kind'];
  /** Channel index-hue custom property (DESIGN.md §2.5 identity tick only). */
  readonly hueVar: string;
  readonly status: ChannelStatus;
  /** Engraved readout text: OK / DEGRADED / FAULT / NO SIGNAL. */
  readonly readout: string;
  /** Terse instrument detail line (identifier-free [X2]). */
  readonly detail: string;
  readonly fiveHour: QuotaSnapshot | undefined;
  readonly sevenDay: QuotaSnapshot | undefined;
  /** One-click remediation label, when the NO SIGNAL doctrine offers one. */
  readonly remediation: string | undefined;
}

export interface ChannelHealthInputs {
  readonly phase: ClientPhase;
  readonly quota: QuotaStoreState['snapshots'];
  readonly sessions: Readonly<Record<string, SessionStatus>>;
}

const READOUT: Record<ChannelStatus, string> = {
  ok: 'OK',
  degraded: 'DEGRADED',
  fault: 'FAULT',
  nosignal: 'NO SIGNAL',
};

function quotaStatus(pct: number | undefined): ChannelStatus {
  if (pct === undefined) return 'nosignal';
  if (pct >= 100) return 'fault';
  if (pct >= QUOTA_DEGRADED_PCT) return 'degraded';
  return 'ok';
}

function hasRunningBackend(
  sessions: Readonly<Record<string, SessionStatus>>,
  backend: SessionStatus['backend'],
): boolean {
  return Object.values(sessions).some(
    (s) => s.backend === backend && (s.state === 'running' || s.state === 'resumed' || s.state === 'spawning'),
  );
}

function readingFor(entry: AccountRegistryEntry, inputs: ChannelHealthInputs): ChannelReading {
  const base = {
    channel: entry.label,
    label: entry.label,
    kind: entry.kind,
    hueVar: entry.channelTokenVar,
    fiveHour: undefined,
    sevenDay: undefined,
    remediation: undefined,
  } as const;

  if (inputs.phase !== 'connected') {
    return {
      ...base,
      status: 'nosignal',
      readout: READOUT.nosignal,
      detail: inputs.phase === 'auth-rejected' ? 'GATEWAY AUTH FAULT' : 'NO GATEWAY',
      remediation: 'RECONNECT',
    };
  }

  // A Claude subscription account (any MAX_<X> / ENT) is a quota-gauge channel.
  if (entry.kind === 'claude') {
    const fiveHour = inputs.quota[quotaKey(entry.label, '5h')];
    const sevenDay = inputs.quota[quotaKey(entry.label, '7d')];
    const status = quotaStatus(fiveHour?.usedPct ?? sevenDay?.usedPct);
    let detail =
      status === 'nosignal'
        ? 'NO QUOTA FEED'
        : status === 'fault'
          ? 'QUOTA EXHAUSTED'
          : status === 'degraded'
            ? 'QUOTA HIGH'
            : 'WITHIN BUDGET';
    if (entry.label === 'ENT') {
      const degraded = entDegradedCapabilities(detectEntCapabilities());
      if (degraded.length > 0) detail = `${detail} · FEATURE-DETECT PENDING`;
    }
    return { ...base, status, readout: READOUT[status], detail, fiveHour, sevenDay };
  }

  // Fixed backend channels, keyed off the derived backend (never a label
  // literal) so the two backend panels stay stable regardless of Claude count.
  if (entry.backend === 'opencode') {
    // Cost/telemetry feeds land at M3 (BE-5/SI-4); presence of a live opencode
    // session is the only M2 signal.
    const up = hasRunningBackend(inputs.sessions, 'opencode');
    return up
      ? { ...base, status: 'ok', readout: READOUT.ok, detail: 'OPENCODE SESSION LIVE' }
      : { ...base, status: 'nosignal', readout: READOUT.nosignal, detail: 'NO COST FEED (M3)' };
  }
  if (entry.backend === 'lmstudio') {
    const up = hasRunningBackend(inputs.sessions, 'lmstudio');
    return up
      ? { ...base, status: 'ok', readout: READOUT.ok, detail: 'LOCAL SESSION LIVE' }
      : {
          ...base,
          status: 'nosignal',
          readout: READOUT.nosignal,
          detail: 'SERVER OFF',
          remediation: 'LMS SERVER START',
        };
  }

  return { ...base, status: 'nosignal', readout: READOUT.nosignal, detail: 'NO SIGNAL' };
}

/**
 * The readings in FIXED registry order (DESIGN.md §2.5 / ADR-0001 — never
 * reordered in response to DATA; the set changes only with the configured
 * accounts). Defaults to the currently-configured registry; a caller may pass
 * a specific registry (tests exercise 3/4/5-Claude registries).
 */
export function deriveChannelReadings(
  inputs: ChannelHealthInputs,
  registry = accountRegistry(),
): readonly ChannelReading[] {
  return registry.entries.map((entry) => readingFor(entry, inputs));
}
