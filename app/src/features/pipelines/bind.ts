/**
 * FE-6 pipelines-channel binding — the pipeline surfaces' ONLY wire intake
 * (the FE-6 bindWorkstreams / FE-5 bindObservability precedent: the FE-2 lib
 * routes `pipelines` frames through the frozen validator and flows them to
 * onMessage generically; this binding is where they become reactive state).
 *
 *   - pipeline server payloads → rAF-batched projection into
 *     {@link pipelinesStore} (ONE store write per frame — the mandatory
 *     streaming discipline; render counts are bounded by frames, never by
 *     wire messages);
 *   - opaque payloads          → ignored (the frozen forward-tolerant reader
 *     rule, §18.1 — M6 pipeline lenses land without breaking this client);
 *   - pushed §18.4 errors       → applied IMMEDIATELY when they correlate to a
 *     verb requestId on the pipelines channel (attention path, the workstream
 *     merge precedent — a verb failure is an instrument state, not a stream);
 *   - broker restart           → boot identity changed, every projection is
 *     stale: flush, then reset (mirrors lib bind.ts).
 *
 * Replay dedupe is upstream: the client drops already-processed seqs per
 * (boot, channel) watermark, so this binding never sees duplicate frames.
 */

import type { PipelineServerPayload } from '@aibender/protocol';
import { createRafProjector, type FrameScheduler } from '../../lib/index.ts';
import type { PipelineFeed } from './ports.ts';
import { pipelinesStore } from './store.ts';

export interface PipelinesBindOptions {
  /** Injectable frame scheduler (tests drive flushes deterministically). */
  schedule?: FrameScheduler;
}

/** Wire a client's pipelines channel to the pipelines store. Returns dispose. */
export function bindPipelines(feed: PipelineFeed, options: PipelinesBindOptions = {}): () => void {
  const projector = createRafProjector<PipelineServerPayload>({
    onFlush: (batch) => pipelinesStore.getState().applyBatch(batch),
    ...(options.schedule !== undefined ? { schedule: options.schedule } : {}),
  });

  const unsubscribe = feed.subscribe({
    onMessage(message) {
      if (message.kind === 'pushed-error') {
        const error = message.error;
        if (error.channel === 'pipelines' && error.correlatesTo !== undefined) {
          // §18.4: verb failures answer pushed errors with correlatesTo =
          // requestId. Flush first so a verb tracked in this frame cannot be
          // outrun by its own error.
          projector.flushNow();
          pipelinesStore.getState().applyVerbError(error.correlatesTo, error.code);
        }
        return;
      }
      if (message.kind !== 'pipelines') return;
      const payload = message.payload;
      // Forward-tolerant reader rule: opaque payloads are legal and ignored.
      if ('opaque' in payload) return;
      projector.push(payload);
    },
    onBrokerRestart() {
      projector.flushNow();
      pipelinesStore.getState().reset();
    },
  });

  return () => {
    unsubscribe();
    projector.dispose();
  };
}
