/**
 * The context-graph feed (BE-6; plan §4/BE-6 item 1, blueprint §8 "Feed"):
 * publishes `{stream:'context-graph'}` envelopes — the FROZEN §12
 * `context-touch` payload — onto the gateway's context-graph channel from
 * the hook/JSONL/SSE watcher event surfaces.
 *
 * Seam discipline (the ./ports.ts pattern from BE-3): the feed consumes
 *   - {@link ContextGraphSink}   — a structural subset of the BE-3
 *     GatewayHandle (`publishContextTouch`), so the composition root passes
 *     the live gateway handle straight in;
 *   - {@link WatcherTouch}       — the narrow watcher input the BE-5
 *     JSONL/SSE tailers feed (file path + session id + relation + ts, nothing
 *     else representable); hook posts enter through the FROZEN
 *     AcceptedHookPost type instead (./hookTouches.ts).
 *
 * BLESSED SEAM (BE-ORCH, M3 stewarding — docs/contracts/icr/README.md): this
 * IS the BE-5→BE-6 watcher event surface. BE-5 watchers call
 * {@link GraphFeed.ingestWatcherTouch}; the hooks endpoint calls
 * {@link GraphFeed.ingestHookPost}. The port type stays HERE (relocating it
 * into core/src/main/ would invert the dependency for no gain — the
 * composition root already composes both lanes).
 *
 * [X2] — identity-free by construction AND by defense:
 *   - the input type has no account field;
 *   - a watcher touch that even CARRIES an `account`/`accountLabel` key is
 *     REJECTED here (mirroring the frozen §12 validator);
 *   - every outbound payload passes validateContextGraphTouch before it
 *     reaches the sink — the gateway's own publish guard (which THROWS on
 *     invalid payloads) can therefore never fire on watcher data.
 *
 * Wire-derived garbage (relative path, malformed session id, unknown
 * relation) is DROPPED and counted, never thrown — watchers tail untrusted
 * native surfaces and one bad line must not kill the feed.
 */

import {
  validateContextGraphTouch,
  type AcceptedHookPost,
  type ContextGraphRelation,
  type ContextGraphTouch,
} from '@aibender/protocol';

import { touchesFromHookPost, type HookTouchOptions } from './hookTouches.js';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** Structural subset of the BE-3 GatewayHandle — the publication target. */
export interface ContextGraphSink {
  publishContextTouch(touch: ContextGraphTouch): void;
}

/**
 * One file touch as a BE-5 watcher (JSONL tailer, OpenCode SSE consumer)
 * reports it. Payload-minimal on purpose: paths + session ids only [X2].
 */
export interface WatcherTouch {
  /** Harness session id where known; native id relay is the documented fallback. */
  readonly sessionId: string;
  /** Absolute file path of the touched artifact. */
  readonly path: string;
  readonly relation: ContextGraphRelation;
  /** Epoch ms; defaults to the feed clock when absent. */
  readonly ts?: number;
}

export interface GraphFeedStats {
  readonly published: number;
  readonly dropped: number;
  /** Drop counts by reason (`account-key` · `invalid-payload`). */
  readonly droppedByReason: Readonly<Record<string, number>>;
}

export interface GraphFeed {
  /** Hook watcher input (FROZEN AcceptedHookPost). Returns touches published. */
  ingestHookPost(accepted: AcceptedHookPost): number;
  /** JSONL/SSE watcher input. Returns true when the touch was published. */
  ingestWatcherTouch(touch: WatcherTouch): boolean;
  stats(): GraphFeedStats;
}

export interface GraphFeedOptions extends HookTouchOptions {
  readonly sink: ContextGraphSink;
}

// ---------------------------------------------------------------------------
// createGraphFeed
// ---------------------------------------------------------------------------

export function createGraphFeed(options: GraphFeedOptions): GraphFeed {
  const clock = options.clock ?? Date.now;
  const hookOptions: HookTouchOptions = {
    clock,
    ...(options.resolveSessionId !== undefined
      ? { resolveSessionId: options.resolveSessionId }
      : {}),
  };

  let published = 0;
  const droppedByReason = new Map<string, number>();
  const drop = (reason: string): false => {
    droppedByReason.set(reason, (droppedByReason.get(reason) ?? 0) + 1);
    return false;
  };

  /** Validate against the FROZEN §12 shape; publish only what passes. */
  const publish = (candidate: ContextGraphTouch): boolean => {
    const checked = validateContextGraphTouch(candidate);
    if (!checked.ok) return drop('invalid-payload');
    options.sink.publishContextTouch(checked.value);
    published += 1;
    return true;
  };

  return {
    ingestHookPost: (accepted) => {
      let count = 0;
      for (const touch of touchesFromHookPost(accepted, hookOptions)) {
        if (publish(touch)) count += 1;
      }
      return count;
    },

    ingestWatcherTouch: (touch) => {
      // [X2] defense in depth: reject inputs that even carry an account key,
      // exactly like the frozen validator does on the wire shape.
      if ('account' in touch || 'accountLabel' in touch) return drop('account-key');
      return publish({
        kind: 'context-touch',
        sessionId: touch.sessionId,
        path: touch.path,
        relation: touch.relation,
        ts: touch.ts ?? clock(),
      });
    },

    stats: () => ({
      published,
      dropped: [...droppedByReason.values()].reduce((a, b) => a + b, 0),
      droppedByReason: Object.fromEntries(droppedByReason),
    }),
  };
}
