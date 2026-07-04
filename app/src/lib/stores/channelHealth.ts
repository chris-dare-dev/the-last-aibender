/**
 * Channel instrument readings — pure selectors deriving the five fixed
 * panels' state (DESIGN.md §2.5) from the connection/quota/session stores.
 *
 * Status semantics are the NORMATIVE meanings of DESIGN.md §2.4:
 *   ok        healthy / connected / within budget
 *   degraded  soft-threshold breach (quota ≥75%, stale, feature-detect open)
 *   fault     hard failure (quota 100%, auth lost)
 *   nosignal  source absent or off — a dimmed instrument, NEVER an error
 *
 * A down gateway means every instrument reads NO SIGNAL: instruments don't
 * disappear, they dim (slots are always retained).
 */

import type { QuotaSnapshot, SessionStatus } from '@aibender/protocol';
import type { ChannelId } from '../../chrome/theme/tokens.ts';
import { channelOrder } from '../../chrome/theme/tokens.ts';
import { detectEntCapabilities, entDegradedCapabilities } from '../entCapabilities.ts';
import type { ClientPhase } from '../ws/wsClient.ts';
import type { QuotaStoreState } from './quotaStore.ts';
import { quotaKey } from './quotaStore.ts';

export type ChannelStatus = 'ok' | 'degraded' | 'fault' | 'nosignal';

/** Soft-threshold per DESIGN.md §2.4 ("quota ≥75%, memory amber"). */
export const QUOTA_DEGRADED_PCT = 75;

export interface ChannelReading {
  readonly channel: ChannelId;
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

function readingFor(channel: ChannelId, inputs: ChannelHealthInputs): ChannelReading {
  const base = {
    channel,
    fiveHour: undefined,
    sevenDay: undefined,
    remediation: undefined,
  };

  if (inputs.phase !== 'connected') {
    return {
      ...base,
      status: 'nosignal',
      readout: READOUT.nosignal,
      detail: inputs.phase === 'auth-rejected' ? 'GATEWAY AUTH FAULT' : 'NO GATEWAY',
      remediation: 'RECONNECT',
    };
  }

  switch (channel) {
    case 'MAX_A':
    case 'MAX_B':
    case 'ENT': {
      const account = channel;
      const fiveHour = inputs.quota[quotaKey(account, '5h')];
      const sevenDay = inputs.quota[quotaKey(account, '7d')];
      const status = quotaStatus(fiveHour?.usedPct ?? sevenDay?.usedPct);
      let detail =
        status === 'nosignal'
          ? 'NO QUOTA FEED'
          : status === 'fault'
            ? 'QUOTA EXHAUSTED'
            : status === 'degraded'
              ? 'QUOTA HIGH'
              : 'WITHIN BUDGET';
      if (channel === 'ENT') {
        const degraded = entDegradedCapabilities(detectEntCapabilities());
        if (degraded.length > 0) detail = `${detail} · FEATURE-DETECT PENDING`;
      }
      return {
        ...base,
        status,
        readout: READOUT[status],
        detail,
        fiveHour,
        sevenDay,
      };
    }
    case 'BEDROCK': {
      // Cost/telemetry feeds land at M3 (BE-5/SI-4); presence of a live
      // opencode session is the only M2 signal.
      const up = hasRunningBackend(inputs.sessions, 'opencode');
      return up
        ? { ...base, status: 'ok', readout: READOUT.ok, detail: 'OPENCODE SESSION LIVE' }
        : {
            ...base,
            status: 'nosignal',
            readout: READOUT.nosignal,
            detail: 'NO COST FEED (M3)',
          };
    }
    case 'LMSTUDIO': {
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
    default:
      return { ...base, status: 'nosignal', readout: READOUT.nosignal, detail: 'NO SIGNAL' };
  }
}

/** The five readings in FIXED slot order (DESIGN.md §2.5 — never reordered). */
export function deriveChannelReadings(inputs: ChannelHealthInputs): readonly ChannelReading[] {
  return channelOrder.map((channel) => readingFor(channel, inputs));
}
