/**
 * Statusline quota tee-file ingestion (BE-5 source 2 primary; blueprint §6.1
 * "Claude quota" row; SI-3's aibender-statusline.sh tees the statusline
 * stdin JSON VERBATIM to `$AIBENDER_HOME/quota/<LABEL>.json`).
 *
 * The teed payload is the CLI's own statusline input object:
 *   `rate_limits.five_hour` / `rate_limits.seven_day`, each with
 *   `used_percentage` + `resets_at` (ISO-8601 or epoch) — findings
 *   observability.md §3, statusline v1.2.80+.
 *
 * Attribution [X2]: the label comes from the FILE NAME (`<LABEL>.json`,
 * installed per account config dir by SI-3) — never from payload content.
 * An unrecognized file name is skipped, never guessed.
 *
 * capturedAt: the broker stamps it (ws-protocol.md §11) — this ingestor uses
 * the tee file's mtime, so an unchanged file re-polled is the SAME capture
 * and the store's (account, window, captured_at_ms, source) dedupe absorbs
 * the re-emit silently (sqlite-ddl.md §7.3 "tee re-emits — identical
 * captures dedupe silently").
 *
 * used_pct is clamped to 0..100 — the collector clamps upstream noise
 * (the store refuses out-of-range values by contract).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { AccountLabel, QuotaWindow } from '@aibender/protocol';
import { isAccountLabel } from '@aibender/protocol';
import type { NewQuotaSnapshotRow, QuotaSnapshotsStore } from '@aibender/schema';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseResetsAt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function clampPct(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

const WINDOW_KEYS: readonly (readonly [string, QuotaWindow])[] = [
  ['five_hour', '5h'],
  ['seven_day', '7d'],
  ['seven_day_sonnet', '7d_sonnet'],
];

/**
 * Parse one teed statusline payload into snapshot rows (both windows when
 * present). Returns [] for unparseable/blank payloads — the tee must never
 * be able to break ingestion.
 */
export function parseStatuslinePayload(
  json: string,
  base: { readonly account: AccountLabel; readonly capturedAtMs: number },
): readonly NewQuotaSnapshotRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const record = asRecord(parsed);
  const rateLimits = asRecord(record?.['rate_limits']);
  if (rateLimits === undefined) return [];

  const rows: NewQuotaSnapshotRow[] = [];
  for (const [key, window] of WINDOW_KEYS) {
    const entry = asRecord(rateLimits[key]);
    if (entry === undefined) continue;
    const usedPct = entry['used_percentage'];
    const resetsAtMs = parseResetsAt(entry['resets_at']);
    if (typeof usedPct !== 'number' || !Number.isFinite(usedPct)) continue;
    if (resetsAtMs === undefined) continue;
    rows.push({
      account: base.account,
      window,
      usedPct: clampPct(usedPct),
      resetsAtMs,
      capturedAtMs: base.capturedAtMs,
      source: 'statusline',
    });
  }
  return rows;
}

export interface QuotaTeeIngestorStats {
  readonly snapshotsInserted: number;
  readonly snapshotsDeduped: number;
  readonly filesSkipped: number;
}

export interface QuotaTeeIngestor {
  /** One deterministic pass over `<quotaDir>/<LABEL>.json`. */
  poll(): number;
  stats(): QuotaTeeIngestorStats;
}

export interface QuotaTeeIngestorOptions {
  /** `$AIBENDER_HOME/quota` (machine-local). */
  readonly quotaDir: string;
  readonly store: QuotaSnapshotsStore;
}

export function createQuotaTeeIngestor(options: QuotaTeeIngestorOptions): QuotaTeeIngestor {
  const stats = { snapshotsInserted: 0, snapshotsDeduped: 0, filesSkipped: 0 };

  return {
    poll: () => {
      if (!existsSync(options.quotaDir)) return 0;
      let inserted = 0;
      let names: readonly string[];
      try {
        names = readdirSync(options.quotaDir).filter((name) => name.endsWith('.json'));
      } catch {
        return 0;
      }
      for (const name of names) {
        const label = basename(name, '.json');
        if (!isAccountLabel(label)) {
          // Label from the FILE NAME only — unknown names are never guessed.
          stats.filesSkipped += 1;
          continue;
        }
        const path = join(options.quotaDir, name);
        let json: string;
        let capturedAtMs: number;
        try {
          capturedAtMs = Math.round(statSync(path).mtimeMs);
          json = readFileSync(path, 'utf8');
        } catch {
          stats.filesSkipped += 1;
          continue;
        }
        for (const row of parseStatuslinePayload(json, { account: label, capturedAtMs })) {
          const outcome = options.store.insert(row);
          if (outcome.inserted) {
            stats.snapshotsInserted += 1;
            inserted += 1;
          } else {
            stats.snapshotsDeduped += 1;
          }
        }
      }
      return inserted;
    },

    stats: () => ({ ...stats }),
  };
}
