/**
 * Per-account config-dir watcher (BE-5 source 1; blueprint §6.1 row 2): one
 * watcher per account config dir, tailing
 *
 *   projects/** /*.jsonl        → transcript lines (tokens + tool rows)
 *   history.jsonl               → user_prompt rows
 *   usage-data/facets/*.json    → session_outcomes rows
 *   usage-data/session-meta/*.json → session_meta events rows
 *
 * THE LABEL COMES FROM THE WATCH ROOT [X2]: the account is fixed at
 * construction (SI-2 provisioned one config dir per label); nothing in any
 * file can re-attribute an event. Malformed lines/files are skipped and
 * counted — the tail always continues (plan §9.2 BE-5 negative row).
 *
 * Scan-driven (deterministic for tests); `start(pollMs)` wires an interval
 * for production composition. Rotation/truncation live in tailer.ts.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AccountLabel } from '@aibender/protocol';
import { backendForLabel, isAccountLabel } from '@aibender/protocol';
import type { EventsTableStore, SessionOutcomesStore } from '@aibender/schema';

import { CollectorError } from '../errors.js';
import type { ApiRequestJoiner } from '../ingest.js';
import { normalizeHistoryLine } from './history.js';
import { FileTailer } from './tailer.js';
import { normalizeTranscriptLine } from './transcripts.js';
import { normalizeFacetsFile, normalizeSessionMetaFile } from './usageData.js';

export interface AccountWatcherStats {
  readonly transcriptLines: number;
  readonly malformedLines: number;
  readonly rowsInserted: number;
  readonly rowsDeduped: number;
  readonly outcomesInserted: number;
  readonly truncationsSeen: number;
  readonly filesDropped: number;
}

export interface AccountConfigWatcher {
  readonly account: AccountLabel;
  readonly configDir: string;
  /** One deterministic pass over every feed. Returns rows inserted this pass. */
  scan(): number;
  /** Convenience interval pump (unref'd); tests drive scan() directly. */
  start(pollMs?: number): void;
  stop(): void;
  stats(): AccountWatcherStats;
}

export interface AccountConfigWatcherOptions {
  /** The label this watch root belongs to — claude_code accounts only. */
  readonly account: AccountLabel;
  /** SI-2 provisioned per-account config dir (machine-local absolute path). */
  readonly configDir: string;
  readonly events: EventsTableStore;
  readonly sessionOutcomes: SessionOutcomesStore;
  /** The JSONL↔OTel join engine (api_request halves route through it). */
  readonly joiner: ApiRequestJoiner;
}

function listFilesRecursive(root: string, suffix: string): readonly string[] {
  if (!existsSync(root)) return [];
  try {
    return (readdirSync(root, { recursive: true, encoding: 'utf8' }) as string[])
      .filter((rel) => rel.endsWith(suffix))
      .map((rel) => join(root, rel))
      .sort();
  } catch {
    return [];
  }
}

function listFilesFlat(dir: string, suffix: string): readonly string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(suffix))
      .map((name) => join(dir, name))
      .sort();
  } catch {
    return [];
  }
}

export function createAccountConfigWatcher(
  options: AccountConfigWatcherOptions,
): AccountConfigWatcher {
  if (!isAccountLabel(options.account) || backendForLabel(options.account) !== 'claude_code') {
    throw new CollectorError(
      `account config watcher is a claude_code feed — got ${String(options.account)}`,
    );
  }

  const { account, configDir, events, sessionOutcomes, joiner } = options;
  const tailers = new Map<string, FileTailer>();
  /** usage-data files ingested at a given mtime (re-ingest only on change). */
  const usageDataSeen = new Map<string, number>();
  const stats = {
    transcriptLines: 0,
    malformedLines: 0,
    rowsInserted: 0,
    rowsDeduped: 0,
    outcomesInserted: 0,
    truncationsSeen: 0,
    filesDropped: 0,
  };
  let interval: ReturnType<typeof setInterval> | undefined;

  const insertRow = (row: Parameters<EventsTableStore['insert']>[0]): void => {
    const outcome = events.insert(row);
    if (outcome.inserted) stats.rowsInserted += 1;
    else stats.rowsDeduped += 1;
  };

  const pollTranscript = (path: string): void => {
    let tailer = tailers.get(path);
    if (tailer === undefined) {
      tailer = new FileTailer(path);
      tailers.set(path, tailer);
    }
    const result = tailer.poll();
    if (result.truncated) stats.truncationsSeen += 1;
    if (result.removed) {
      tailers.delete(path);
      stats.filesDropped += 1;
      return;
    }
    for (const line of result.lines) {
      stats.transcriptLines += 1;
      const outcome = normalizeTranscriptLine({ account, line });
      if (outcome.kind === 'malformed') {
        stats.malformedLines += 1; // skipped; the tail continues
        continue;
      }
      if (outcome.kind === 'ignored') continue;
      if (outcome.apiRequest !== undefined) joiner.offerJsonl(outcome.apiRequest);
      for (const row of outcome.rows) insertRow(row);
    }
  };

  const pollHistory = (path: string): void => {
    let tailer = tailers.get(path);
    if (tailer === undefined) {
      tailer = new FileTailer(path);
      tailers.set(path, tailer);
    }
    const result = tailer.poll();
    if (result.truncated) stats.truncationsSeen += 1;
    if (result.removed) {
      tailers.delete(path);
      return;
    }
    for (const line of result.lines) {
      const outcome = normalizeHistoryLine({ account, line });
      if (outcome.kind === 'malformed') {
        stats.malformedLines += 1;
        continue;
      }
      insertRow(outcome.row);
    }
  };

  const pollUsageData = (): void => {
    const facetsDir = join(configDir, 'usage-data', 'facets');
    const metaDir = join(configDir, 'usage-data', 'session-meta');
    for (const path of listFilesFlat(facetsDir, '.json')) {
      const handled = ingestUsageFile(path, 'facets');
      if (handled === 'malformed') stats.malformedLines += 1;
    }
    for (const path of listFilesFlat(metaDir, '.json')) {
      const handled = ingestUsageFile(path, 'session-meta');
      if (handled === 'malformed') stats.malformedLines += 1;
    }
  };

  const ingestUsageFile = (
    path: string,
    kind: 'facets' | 'session-meta',
  ): 'ok' | 'skipped' | 'malformed' => {
    let mtimeMs: number;
    let json: string;
    try {
      mtimeMs = Math.round(statSync(path).mtimeMs);
      if (usageDataSeen.get(path) === mtimeMs) return 'skipped';
      json = readFileSync(path, 'utf8');
    } catch {
      return 'skipped'; // vanished mid-scan; next scan reconciles
    }
    usageDataSeen.set(path, mtimeMs);
    const fileName = path.split('/').pop() ?? '';
    const sessionUuid = fileName.replace(/\.json$/, '');
    if (sessionUuid.length === 0) return 'malformed';
    const input = { account, sessionUuid, json, capturedAtMs: mtimeMs };
    if (kind === 'facets') {
      const row = normalizeFacetsFile(input);
      if (row === undefined) return 'malformed';
      const outcome = sessionOutcomes.insert(row);
      if (outcome.inserted) stats.outcomesInserted += 1;
      return 'ok';
    }
    const row = normalizeSessionMetaFile(input);
    if (row === undefined) return 'malformed';
    insertRow(row);
    return 'ok';
  };

  const scan = (): number => {
    const before = stats.rowsInserted + stats.outcomesInserted;
    for (const path of listFilesRecursive(join(configDir, 'projects'), '.jsonl')) {
      pollTranscript(path);
    }
    const historyPath = join(configDir, 'history.jsonl');
    if (existsSync(historyPath)) pollHistory(historyPath);
    pollUsageData();
    return stats.rowsInserted + stats.outcomesInserted - before;
  };

  return {
    account,
    configDir,
    scan,

    start: (pollMs = 2000) => {
      if (interval !== undefined) return;
      interval = setInterval(() => {
        try {
          scan();
        } catch {
          /* a bad pass must never kill the pump; the next tick re-scans */
        }
      }, pollMs);
      interval.unref?.();
    },

    stop: () => {
      if (interval !== undefined) clearInterval(interval);
      interval = undefined;
    },

    stats: () => ({ ...stats }),
  };
}
