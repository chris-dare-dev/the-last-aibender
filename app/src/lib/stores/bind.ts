/**
 * Client → store binding: the ONLY place broker messages become reactive
 * state. Streaming channels (transcript, context-graph) go through
 * rAF-batched projectors (one store write per frame — never per token);
 * attention channels (approvals) and low-volume channels (quota, control
 * results) apply immediately.
 */

import type { ContextGraphTouch } from '@aibender/protocol';
import { transcriptFeeds } from '../islands/transcriptFeeds.ts';
import { createRafProjector, type FrameScheduler } from '../projection/rafBatch.ts';
import { consoleLogger, type Logger } from '../log.ts';
import type { GatewayClient } from '../ws/wsClient.ts';
import { approvalsStore } from './approvalsStore.ts';
import { connectionStore } from './connectionStore.ts';
import { contextGraphStore } from './contextGraphStore.ts';
import { quotaStore } from './quotaStore.ts';
import { sessionsStore } from './sessionsStore.ts';
import { transcriptStore, type TranscriptBatchItem } from './transcriptStore.ts';

export interface BindOptions {
  schedule?: FrameScheduler;
  now?: () => number;
  logger?: Logger;
}

/** Wire a client to the app stores. Returns a dispose function. */
export function bindClientToStores(client: GatewayClient, options: BindOptions = {}): () => void {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? consoleLogger;

  const transcriptProjector = createRafProjector<TranscriptBatchItem>({
    onFlush: (batch) => {
      transcriptStore.getState().applyBatch(batch);
      // Same frame batch hydrates the per-session island feeds — the
      // transcript island renders from these (composition adapter).
      transcriptFeeds.applyBatch(batch);
    },
    ...(options.schedule !== undefined ? { schedule: options.schedule } : {}),
  });
  const graphProjector = createRafProjector<ContextGraphTouch>({
    onFlush: (batch) => contextGraphStore.getState().applyBatch(batch),
    ...(options.schedule !== undefined ? { schedule: options.schedule } : {}),
  });

  const unsubscribe = client.subscribe({
    onPhase(phase) {
      connectionStore.getState().setPhase(phase);
      connectionStore.getState().setBroker(client.broker);
      if (phase === 'connected') {
        // Hydrate the fleet on every (re)connect — read-model rebuild.
        client.request({ kind: 'status' }).catch((err: unknown) => {
          logger.warn('status hydration failed', { err: String(err) });
        });
      }
    },
    onBrokerRestart() {
      // Boot identity changed: every watermark AND projection is stale.
      transcriptProjector.flushNow();
      graphProjector.flushNow();
      transcriptStore.getState().reset();
      transcriptFeeds.reset();
      approvalsStore.getState().reset();
      quotaStore.getState().reset();
      contextGraphStore.getState().reset();
      sessionsStore.getState().reset();
      connectionStore.getState().recordBrokerRestart();
    },
    onViolation(violation) {
      connectionStore.getState().recordViolation(violation);
    },
    onDuplicateDropped() {
      connectionStore.getState().recordDuplicateDrop();
    },
    onMessage(message) {
      switch (message.kind) {
        case 'transcript':
          transcriptProjector.push({ sessionId: message.sessionId, payload: message.payload });
          break;
        case 'context-graph':
          graphProjector.push(message.payload);
          break;
        case 'approvals':
          approvalsStore.getState().applyServer(message.payload, now());
          break;
        case 'quota':
          quotaStore.getState().apply(message.payload);
          break;
        case 'control-response':
          if (message.response.ok) {
            sessionsStore.getState().applyControlResult(message.response.result);
          }
          break;
        case 'pushed-error':
          connectionStore.getState().recordPushedError(message.error.code, message.error.message);
          break;
        case 'events':
          // Frozen at M3 (ws-protocol.md §13). FE-2's chrome has no events
          // consumer — the FE-5 dashboards bind their own projections when
          // they land; unknown kinds are ignored by the tolerant-reader rule.
          break;
        default:
          break;
      }
    },
  });

  return () => {
    unsubscribe();
    transcriptProjector.dispose();
    graphProjector.dispose();
  };
}
