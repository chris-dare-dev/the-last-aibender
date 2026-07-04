/**
 * BE-5 source 1 — per-account JSONL fs-watch tailer (blueprint §6.1 row 2):
 * rotation/truncation-safe tailing, ground-truth token extraction with the
 * 5m/1h cache-TTL split, usage-data/{facets,session-meta} + history.jsonl
 * parsing. The account label comes from the WATCH ROOT, never from file
 * contents [X2].
 */

export { FileTailer, type TailPollResult } from './tailer.js';
export {
  normalizeTranscriptLine,
  usageFromTranscript,
  type NormalizeTranscriptLineInput,
  type TranscriptLineOutcome,
} from './transcripts.js';
export {
  normalizeFacetsFile,
  normalizeSessionMetaFile,
  type NormalizeUsageDataInput,
} from './usageData.js';
export {
  normalizeHistoryLine,
  type HistoryLineOutcome,
  type NormalizeHistoryLineInput,
} from './history.js';
export {
  createAccountConfigWatcher,
  type AccountConfigWatcher,
  type AccountConfigWatcherOptions,
  type AccountWatcherStats,
} from './accountWatcher.js';
