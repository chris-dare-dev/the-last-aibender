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
import { opendir, stat as statAsync } from 'node:fs/promises';
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
  /**
   * OS-3: the async, off-event-loop, mtime-scoped pass the production pump
   * uses. `full: true` forces a whole-subtree reconcile (else only mtime-changed
   * dirs are descended). Returns rows inserted this pass. Tailer correctness is
   * identical to {@link scan}.
   */
  scanAsync(opts?: { readonly full?: boolean }): Promise<number>;
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

/**
 * OS-3: an mtime-scoped ASYNC recursive walk for the production interval pump.
 *
 * The old production path re-walked the WHOLE `projects/**` subtree with a
 * SYNCHRONOUS `readdirSync({recursive:true})` every 2 s, per account — 12
 * accounts meant 12 full synchronous subtree walks + per-file stat on the
 * broker's main event loop every tick, blocking the latency-critical
 * row-before-spawn path. This walk instead:
 *   - runs OFF the event loop via async `opendir` (yields between entries);
 *   - SKIPS descending into a directory whose mtime is unchanged since the last
 *     walk (a dir's mtime bumps when a child file is added/removed/renamed), so
 *     a steady tree costs O(top-level dirs) stats, not O(all files);
 *   - on a `full` reconcile pass (periodic, every ~30-60 s) descends
 *     everything regardless of mtime, so an in-place APPEND that did not bump a
 *     dir mtime is still eventually rediscovered (defense against fs quirks).
 *
 * The per-directory mtime cache is passed in and mutated in place. Returns the
 * matching files (absolute paths, sorted) discovered this pass — the caller
 * tails them; the tailer's own byte offset means an unchanged file it already
 * knows is a cheap `stat` (size === offset → no read).
 */
async function listJsonlFilesAsyncScoped(
  root: string,
  suffix: string,
  dirMtimes: Map<string, number>,
  options: { readonly full: boolean; readonly known: ReadonlySet<string> },
): Promise<readonly string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let dirMtime: number;
    try {
      dirMtime = Math.round((await statAsync(dir)).mtimeMs);
    } catch {
      dirMtimes.delete(dir);
      return; // vanished mid-walk — the next reconcile drops any stale tailers
    }
    const seenMtime = dirMtimes.get(dir);
    const dirUnchanged = !options.full && seenMtime === dirMtime;
    dirMtimes.set(dir, dirMtime);

    // Even when a dir's mtime is unchanged, its KNOWN matching files must still
    // be re-offered so an in-place append (which does NOT bump the dir mtime)
    // is tailed. So: unchanged dir → re-yield only its already-known files and
    // still recurse into subdirs (their own mtime gates them); changed dir (or
    // full pass) → opendir to discover new entries.
    if (dirUnchanged) {
      for (const path of options.known) {
        if (path.endsWith(suffix) && dirnameOf(path) === dir) found.push(path);
      }
      // Still descend known subdirs so a change deeper down is not missed.
      for (const sub of childDirsFromMtimeCache(dir, dirMtimes)) await walk(sub);
      return;
    }

    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      return;
    }
    try {
      for await (const entry of handle) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && entry.name.endsWith(suffix)) {
          found.push(full);
        }
      }
    } catch {
      // A mid-iteration error (dir removed) is benign — reconcile recovers.
    }
  };
  if (existsSync(root)) await walk(root);
  found.sort();
  return found;
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

/** Sub-directories of `dir` currently in the mtime cache (for unchanged-dir descent). */
function childDirsFromMtimeCache(dir: string, dirMtimes: ReadonlyMap<string, number>): string[] {
  const prefix = dir.endsWith('/') ? dir : `${dir}/`;
  const out: string[] = [];
  for (const cached of dirMtimes.keys()) {
    if (cached === dir) continue;
    if (cached.startsWith(prefix) && !cached.slice(prefix.length).includes('/')) out.push(cached);
  }
  return out;
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
  /** OS-3: per-directory mtime cache for the mtime-scoped async walk. */
  const dirMtimes = new Map<string, number>();
  /** OS-3: `.jsonl` transcript files discovered so far (for unchanged-dir re-offer). */
  const knownJsonlFiles = new Set<string>();
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
  /** OS-3: guards against overlapping async ticks (a slow walk never re-enters). */
  let scanInFlight = false;
  /** OS-3: tick counter to schedule the periodic FULL reconcile. */
  let tickCount = 0;

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

  /**
   * The DETERMINISTIC synchronous pass (tests call this directly). Full walk —
   * simple and total. The production interval uses {@link scanAsync} instead
   * (off the event loop, mtime-scoped). Both share the tailer/dedupe machinery,
   * so a caller that mixes them is still correct (offsets/dedupe absorb it).
   */
  const scan = (): number => {
    const before = stats.rowsInserted + stats.outcomesInserted;
    for (const path of listFilesRecursive(join(configDir, 'projects'), '.jsonl')) {
      knownJsonlFiles.add(path);
      pollTranscript(path);
    }
    const historyPath = join(configDir, 'history.jsonl');
    if (existsSync(historyPath)) pollHistory(historyPath);
    pollUsageData();
    return stats.rowsInserted + stats.outcomesInserted - before;
  };

  /**
   * OS-3: the async, mtime-scoped pass used by the production pump. Off the
   * event loop (async opendir), descends only mtime-changed dirs unless `full`.
   * Returns rows inserted this pass. Preserves tailer correctness exactly —
   * every discovered transcript is polled through the SAME {@link FileTailer}
   * (byte-offset, rotation/truncation-safe), and history + usage-data are
   * polled every pass (they are single known paths, cheap to stat).
   */
  const scanAsync = async (opts: { readonly full?: boolean } = {}): Promise<number> => {
    const before = stats.rowsInserted + stats.outcomesInserted;
    const files = await listJsonlFilesAsyncScoped(join(configDir, 'projects'), '.jsonl', dirMtimes, {
      full: opts.full ?? false,
      known: knownJsonlFiles,
    });
    for (const path of files) {
      knownJsonlFiles.add(path);
      pollTranscript(path);
    }
    // A tailer whose file was dropped (rotation) removed itself; prune the
    // known-file set so an unchanged-dir re-offer does not resurrect it.
    for (const path of knownJsonlFiles) {
      if (!tailers.has(path) && !files.includes(path)) knownJsonlFiles.delete(path);
    }
    const historyPath = join(configDir, 'history.jsonl');
    if (existsSync(historyPath)) pollHistory(historyPath);
    pollUsageData();
    return stats.rowsInserted + stats.outcomesInserted - before;
  };

  /** OS-3: full reconcile every ~30 s regardless of poll cadence. */
  const FULL_RECONCILE_MS = 30_000;

  return {
    account,
    configDir,
    scan,
    scanAsync,

    start: (pollMs = 2000) => {
      if (interval !== undefined) return;
      // Reconcile every Nth tick (>= FULL_RECONCILE_MS), min 1.
      const reconcileEvery = Math.max(1, Math.round(FULL_RECONCILE_MS / pollMs));
      interval = setInterval(() => {
        // OS-3: never let a slow walk re-enter; skip this tick if one is live.
        if (scanInFlight) return;
        scanInFlight = true;
        const full = tickCount % reconcileEvery === 0; // first tick is a full pass
        tickCount += 1;
        void scanAsync({ full }).then(
          () => {
            scanInFlight = false;
          },
          () => {
            // A bad pass must never kill the pump; the next tick re-scans.
            scanInFlight = false;
          },
        );
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
