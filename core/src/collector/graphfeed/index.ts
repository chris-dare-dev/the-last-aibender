/**
 * core/src/collector/graphfeed — the live context-graph feed (BE-6; plan
 * §4/BE-6, blueprint §8). Projects watcher events (hooks via the FROZEN
 * AcceptedHookPost surface, JSONL/SSE via {@link WatcherTouch}) into the
 * FROZEN §12 `context-touch` payloads and publishes them onto the gateway's
 * context-graph channel. Payloads are file paths + session ids ONLY [X2].
 */

export {
  READ_SHAPED_TOOLS,
  WRITE_SHAPED_TOOLS,
  absolutePathsFrom,
  relationForTool,
} from './relations.js';

export { touchesFromHookPost, type HookTouchOptions } from './hookTouches.js';

export {
  createGraphFeed,
  type ContextGraphSink,
  type GraphFeed,
  type GraphFeedOptions,
  type GraphFeedStats,
  type WatcherTouch,
} from './feed.js';
