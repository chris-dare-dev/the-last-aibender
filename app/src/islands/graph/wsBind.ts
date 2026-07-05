/**
 * FE-4 wire binding — the graph island's ONLY intake from the FE-2 WS seam.
 *
 * The lib binder (lib/stores/bind.ts) projects `context-graph` payloads into
 * the FE-2-depth activity read model (`contextGraphStore`, bounded window);
 * the ISLAND consumes the same validated wire feed through the documented
 * `GatewayClient.subscribe` surface — exactly the FE-5 pattern
 * (features/observability/bind.ts). Payloads reaching `onMessage` are already
 * validated + replay-deduped upstream (per-(boot, channel) watermarks), so
 * this binding forwards every touch exactly once.
 *
 * No rAF projector here: the {@link GraphStore} owns the batching discipline
 * (one coalesced commit per rAF/150 ms window) — a second batching layer
 * would only add latency.
 *
 * BROKER RESTART: boot identity changed ⇒ the whole graph projection is
 * stale (same rule as every lib store). The binding surfaces the signal via
 * `onBrokerRestart`; the register seam answers by REBUILDING the island
 * (store + worker + renderer) rather than mutating a half-stale scene.
 */

import type { ContextGraphTouch } from '@aibender/protocol';
import type { ClientEvents } from '../../lib/index.ts';

/** Structural slice of GatewayClient this binding needs (test seam). */
export interface ContextGraphFeed {
  subscribe(listener: ClientEvents): () => void;
}

/** Where touches land (the island handle satisfies it). */
export interface GraphTouchSink {
  applyTouches(touches: readonly ContextGraphTouch[]): void;
}

export interface BindGraphFeedOptions {
  /** Boot identity changed — every projection derived so far is stale. */
  onBrokerRestart?: () => void;
}

/** Wire a client's context-graph channel to a touch sink. Returns dispose. */
export function bindGraphFeed(
  client: ContextGraphFeed,
  sink: GraphTouchSink,
  options: BindGraphFeedOptions = {},
): () => void {
  return client.subscribe({
    onMessage(message) {
      if (message.kind !== 'context-graph') return;
      sink.applyTouches([message.payload]);
    },
    ...(options.onBrokerRestart !== undefined
      ? { onBrokerRestart: options.onBrokerRestart }
      : {}),
  });
}
