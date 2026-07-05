/**
 * FE-6 workstream-channel binding — the lineage view's ONLY wire intake
 * (the FE-5 bindObservability precedent: the FE-2 lib routes `workstream`
 * frames through the frozen validator and flows them to onMessage
 * generically; this binding is where they become reactive state).
 *
 *   - workstream payloads   → rAF-batched projection into
 *     {@link workstreamsStore} (ONE store write per frame — the mandatory
 *     streaming discipline; render counts are bounded by frames, never by
 *     wire messages);
 *   - opaque payloads       → ignored (the frozen forward-tolerant reader
 *     rule, §16.1 — M5 lineage lenses land without breaking this client);
 *   - pushed §16.4 errors   → applied IMMEDIATELY when they correlate to a
 *     mergeId on the workstream channel (attention path, the approvals
 *     precedent — a merge failure is an instrument state, not a stream);
 *   - broker restart        → boot identity changed, every projection is
 *     stale: flush, then reset (mirrors lib bind.ts).
 *
 * Replay dedupe is upstream: the client drops already-processed seqs per
 * (boot, channel) watermark, so this binding never sees duplicate frames.
 */

import type { WorkstreamServerPayload } from '@aibender/protocol';
import { createRafProjector, type FrameScheduler } from '../../lib/index.ts';
import type { WorkstreamFeed } from './ports.ts';
import { workstreamsStore } from './store.ts';

export interface WorkstreamsBindOptions {
  /** Injectable frame scheduler (tests drive flushes deterministically). */
  schedule?: FrameScheduler;
}

/** Wire a client's workstream channel to the lineage store. Returns dispose. */
export function bindWorkstreams(
  feed: WorkstreamFeed,
  options: WorkstreamsBindOptions = {},
): () => void {
  const projector = createRafProjector<WorkstreamServerPayload>({
    onFlush: (batch) => workstreamsStore.getState().applyBatch(batch),
    ...(options.schedule !== undefined ? { schedule: options.schedule } : {}),
  });

  const unsubscribe = feed.subscribe({
    onMessage(message) {
      if (message.kind === 'pushed-error') {
        const error = message.error;
        if (error.channel === 'workstream' && error.correlatesTo !== undefined) {
          // §16.4: failures answer pushed errors with correlatesTo = mergeId.
          // Flush first so a merge tracked in this frame cannot be outrun.
          projector.flushNow();
          workstreamsStore.getState().applyMergeError(error.correlatesTo, error.code);
        }
        return;
      }
      if (message.kind !== 'workstream') return;
      const payload = message.payload;
      // Forward-tolerant reader rule: opaque payloads are legal and ignored.
      if ('opaque' in payload) return;
      projector.push(payload);
    },
    onBrokerRestart() {
      projector.flushNow();
      workstreamsStore.getState().reset();
    },
  });

  return () => {
    unsubscribe();
    projector.dispose();
  };
}
