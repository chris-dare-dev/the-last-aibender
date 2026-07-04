/**
 * Read-only opencode.db scrape (BE-5 source 5; blueprint §6.1 OpenCode row:
 * "read-only opencode.db — durable `event` table for replayable per-step
 * cost"; probe findings §4 schema).
 *
 * THE [X2] GUARD IS CONSUMED, NEVER FORKED: every statement goes through
 * BE-4's {@link GuardedOpencodeDb} (core/src/adapters/opencode/dbAccess.ts)
 * — read-only open, single-SELECT screen, `account`/`credential` identifiers
 * refused fail-closed. This module contains ONLY plain SELECTs over the
 * event-sourcing tables.
 *
 * RECONCILIATION (M3 DoD: "opencode.db scrape reconciles to identical
 * ids"): the db `event.id` column stores the SAME monotonic `evt_` ids the
 * SSE stream delivers, so scrape rows use raw_ref = that id verbatim — a row
 * already ingested live is a silent (backend, raw_ref) dedupe no-op, and a
 * row the stream missed lands here on its ORIGINAL id. The periodic scrape
 * is therefore the steady-state gap-backfill; SSE `after=<seq>` replay is
 * the immediate one (sseSource.ts).
 */

import type { AccountLabel } from '@aibender/protocol';
import type { EventsTableStore } from '@aibender/schema';

import type { GuardedOpencodeDb } from '../../adapters/opencode/dbAccess.js';
import { assertOpencodeLabel, messageMetrics } from './normalize.js';
import { scrubIdentityText } from '../identity.js';

export interface OpencodeDbScrapeStats {
  readonly rowsScanned: number;
  readonly rowsInserted: number;
  /** Rows that reconciled to an existing (usually SSE-ingested) id. */
  readonly rowsReconciled: number;
  readonly rowsSkipped: number;
}

export interface OpencodeDbScraper {
  /** One scrape pass over the durable event table. Returns rows inserted. */
  scrape(): number;
  stats(): OpencodeDbScrapeStats;
}

export interface OpencodeDbScraperOptions {
  /** BE-4's guarded read-only handle — the ONLY db access path [X2]. */
  readonly db: GuardedOpencodeDb;
  readonly events: EventsTableStore;
  readonly account: AccountLabel;
  readonly nowMs?: () => number;
}

/** The one SELECT this scraper issues (screened by the BE-4 guard anyway). */
export const OPENCODE_EVENT_SCRAPE_SQL =
  'SELECT id, aggregate_id, seq, type, data FROM event ORDER BY aggregate_id, seq';

export function createOpencodeDbScraper(options: OpencodeDbScraperOptions): OpencodeDbScraper {
  assertOpencodeLabel(options.account);
  const nowMs = options.nowMs ?? Date.now;
  const stats = { rowsScanned: 0, rowsInserted: 0, rowsReconciled: 0, rowsSkipped: 0 };

  return {
    scrape: () => {
      const rows = options.db.select(OPENCODE_EVENT_SCRAPE_SQL);
      let inserted = 0;
      for (const row of rows) {
        stats.rowsScanned += 1;
        const id = row['id'];
        const aggregateId = row['aggregate_id'];
        const type = row['type'];
        if (typeof id !== 'string' || id.length === 0 || typeof type !== 'string') {
          stats.rowsSkipped += 1;
          continue;
        }
        let data: unknown;
        try {
          data = typeof row['data'] === 'string' ? JSON.parse(row['data']) : undefined;
        } catch {
          data = undefined; // metric block optional; the row still lands
        }
        const metrics = messageMetrics(data);
        const outcome = options.events.insert({
          tsMs: metrics.tsMs ?? nowMs(),
          backend: 'opencode',
          account: options.account,
          source: 'opencode-db',
          eventType: scrubIdentityText(type),
          rawRef: id, // identical to the SSE evt_ id — THE reconcile axis
          ...(typeof aggregateId === 'string' && aggregateId.length > 0
            ? { nativeSessionId: aggregateId }
            : {}),
          ...(metrics.model !== undefined ? { model: metrics.model } : {}),
          ...(metrics.provider !== undefined ? { provider: metrics.provider } : {}),
          ...(metrics.costEstimatedUsd !== undefined
            ? { costEstimatedUsd: metrics.costEstimatedUsd }
            : {}),
          ...(metrics.inputTokens !== undefined ? { inputTokens: metrics.inputTokens } : {}),
          ...(metrics.outputTokens !== undefined ? { outputTokens: metrics.outputTokens } : {}),
          ...(metrics.reasoningTokens !== undefined
            ? { reasoningTokens: metrics.reasoningTokens }
            : {}),
          ...(metrics.cacheReadTokens !== undefined
            ? { cacheReadTokens: metrics.cacheReadTokens }
            : {}),
          ...(metrics.cacheCreationTokens !== undefined
            ? { cacheCreationTokens: metrics.cacheCreationTokens }
            : {}),
          ...(metrics.latencyMs !== undefined ? { latencyMs: metrics.latencyMs } : {}),
        });
        if (outcome.inserted) {
          stats.rowsInserted += 1;
          inserted += 1;
        } else {
          stats.rowsReconciled += 1;
        }
      }
      return inserted;
    },

    stats: () => ({ ...stats }),
  };
}
