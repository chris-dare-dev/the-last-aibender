/**
 * BE-5 sources 4+5 — OpenCode (blueprint §6.1 OpenCode row): /global/event
 * consumption via BE-4's SSE transport (strict evt_ dedupe, watermarks,
 * unknown-event tolerance, after=<seq> gap repair) + the guarded read-only
 * opencode.db scrape reconciling to identical evt_ ids.
 */

export {
  OPENCODE_INGESTED_TYPES,
  isIngestedOpencodeType,
  messageMetrics,
  normalizeDurableOpencodeEvent,
  normalizeLiveOpencodeEvent,
  type LiveEventOutcome,
  type MessageMetrics,
  type NormalizeDurableEventInput,
  type NormalizeLiveEventInput,
} from './normalize.js';

export {
  createOpencodeSseCollector,
  type OpencodeSseCollector,
  type OpencodeSseCollectorOptions,
  type OpencodeSseCollectorStats,
} from './sseSource.js';

export {
  OPENCODE_EVENT_SCRAPE_SQL,
  createOpencodeDbScraper,
  type OpencodeDbScrapeStats,
  type OpencodeDbScraper,
  type OpencodeDbScraperOptions,
} from './dbScrape.js';
