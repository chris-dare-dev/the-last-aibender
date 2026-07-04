/**
 * `quota` channel payload — per-account rate-limit snapshots (blueprint §6.1
 * quota row: statusline hook tee is the primary feed, the undocumented OAuth
 * usage endpoint is the idle-account fallback poll).
 *
 * Broker → client only; the only client→broker payload the quota channel
 * accepts is the generic `replay-request` (replay.ts).
 *
 * The wire shape mirrors the `quota_snapshots` DDL row (sqlite-ddl.md /
 * blueprint §6.2): window vocabulary `5h | 7d | 7d_sonnet`, percentage +
 * reset instant, and an honest `source` so dashboards can render freshness
 * (NO SIGNAL is a read-model state, never a fabricated snapshot — plan §9.2
 * BE-6 negative row).
 *
 * ============================================================================
 * FROZEN-M2 (2026-07-04). Amendments only via ICR (docs/contracts/icr/);
 * BE-ORCH lands, FE-ORCH co-signs. Prose of record: docs/contracts/ws-protocol.md.
 * ============================================================================
 */

import type { AccountLabel } from './vocab.js';

/** Rate-limit windows, matching `quota_snapshots.window` (sqlite-ddl.md). */
export const QUOTA_WINDOWS = Object.freeze(['5h', '7d', '7d_sonnet'] as const);

export type QuotaWindow = (typeof QUOTA_WINDOWS)[number];

export const QUOTA_SOURCES = Object.freeze([
  /** Statusline hook stdin JSON teed to the per-account file (primary). */
  'statusline',
  /** Undocumented OAuth usage endpoint, idle-account fallback (≤1/10–15 min). */
  'oauth-poll',
] as const);

export type QuotaSource = (typeof QUOTA_SOURCES)[number];

export interface QuotaSnapshot {
  readonly kind: 'quota-snapshot';
  /** Account label placeholder only [X2]. */
  readonly account: AccountLabel;
  readonly window: QuotaWindow;
  /** Used percentage, 0–100 inclusive (collector clamps upstream noise). */
  readonly usedPct: number;
  /**
   * Epoch ms when the window resets. Authoritative from the feed — a value
   * in the past is legal (FE renders "reset due", plan §9.2 FE-5 edge).
   */
  readonly resetsAt: number;
  /** Epoch ms the snapshot was captured broker-side. */
  readonly capturedAt: number;
  readonly source: QuotaSource;
}
