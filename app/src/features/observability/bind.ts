/**
 * FE-5 events-channel binding — the dashboards' ONLY wire intake.
 *
 * The FE-2 lib deliberately leaves the `events` channel unbound (lib
 * stores/bind.ts routes it as a no-op: "the FE-5 dashboards bind their own
 * projections when they land" — this is that binding). It consumes the
 * frozen payload union (ws-protocol.md §13) through the documented
 * GatewayClient.subscribe surface:
 *
 *   - `read-model-snapshot` → rAF-batched projection into
 *     {@link observabilityStore} (one store write per frame — the mandatory
 *     streaming discipline, plan §5 / §9.2 render-count row);
 *   - `event-summary`       → ignored here (the summaries feed M4+ lenses;
 *     every §6.3 dashboard renders from its read model);
 *   - unknown kinds         → decoded opaque upstream and MUST be ignored
 *     (the frozen forward-tolerant reader rule, §13.3) — the `opaque`
 *     discriminant never reaches the store;
 *   - broker restart        → boot identity changed, every projection is
 *     stale: flush, then reset (mirrors lib bind.ts).
 *
 * Replay dedupe is upstream: the client drops already-processed seqs per
 * (boot, channel) watermark, so this binding never sees duplicate rows.
 */

import type { ReadModelSnapshot } from '@aibender/protocol';
import {
  createRafProjector,
  type ClientEvents,
  type FrameScheduler,
} from '../../lib/index.ts';
import { observabilityStore } from './store.ts';

/** The structural slice of GatewayClient this binding needs (test seam). */
export interface EventsFeed {
  subscribe(listener: ClientEvents): () => void;
}

export interface ObservabilityBindOptions {
  /** Injectable frame scheduler (tests drive flushes deterministically). */
  schedule?: FrameScheduler;
}

/** Wire a client's events channel to the observability store. Returns dispose. */
export function bindObservability(
  client: EventsFeed,
  options: ObservabilityBindOptions = {},
): () => void {
  const projector = createRafProjector<ReadModelSnapshot>({
    onFlush: (batch) => observabilityStore.getState().applyBatch(batch),
    ...(options.schedule !== undefined ? { schedule: options.schedule } : {}),
  });

  const unsubscribe = client.subscribe({
    onMessage(message) {
      if (message.kind !== 'events') return;
      const payload = message.payload;
      // Forward-tolerant reader rule: opaque payloads are legal and ignored.
      if ('opaque' in payload) return;
      if (payload.kind === 'read-model-snapshot') projector.push(payload);
      // 'event-summary' is deliberately not projected (see module doc).
    },
    onBrokerRestart() {
      projector.flushNow();
      observabilityStore.getState().reset();
    },
  });

  return () => {
    unsubscribe();
    projector.dispose();
  };
}
