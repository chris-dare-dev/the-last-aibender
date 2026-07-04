/**
 * FE-2 composition adapter: the per-session {@link TranscriptFeed} registry
 * the transcript island renders from.
 *
 * The island's reference read model (app/src/islands/transcript/model.ts —
 * pure logic, no React/CSS) folds the FROZEN `transcript.<sid>` payload
 * union into render items with stable keys and arrival-order interleaving of
 * text/tool/result blocks. This registry hydrates ONE such store per session
 * from the SAME rAF-projected batches that feed the zustand transcriptStore
 * (bind.ts) — one notification per frame, never per token, exactly the shape
 * SPIKE-C streamed through react-virtual with zero jank.
 *
 * Bounded: at most {@link MAX_FEED_SESSIONS} per-session feeds are retained
 * (drop-oldest, counted). Per-session item depth was proven memory-flat at
 * 10k items by the FE-3 Playwright suite; the transcript of record lives in
 * the per-account JSONL files, not in this projection.
 */

import {
  createTranscriptStore,
  type TranscriptFeed,
  type TranscriptStore,
} from '../../islands/transcript/model.ts';
import type { TranscriptBatchItem } from '../stores/transcriptStore.ts';

export const MAX_FEED_SESSIONS = 64;

export class TranscriptFeedRegistry {
  private stores = new Map<string, TranscriptStore>();
  private dropped = 0;

  /** Sessions evicted by the drop-oldest bound since construction. */
  get droppedSessions(): number {
    return this.dropped;
  }

  get size(): number {
    return this.stores.size;
  }

  /**
   * The feed for `sessionId` (created empty on first request). The island
   * subscribes through this seam; payloads arrive via {@link applyBatch}.
   */
  feedFor(sessionId: string): TranscriptFeed {
    return this.storeFor(sessionId);
  }

  private storeFor(sessionId: string): TranscriptStore {
    const existing = this.stores.get(sessionId);
    if (existing !== undefined) return existing;
    const store = createTranscriptStore(sessionId);
    this.stores.set(sessionId, store);
    // Drop-oldest session bound (Map preserves insertion order).
    while (this.stores.size > MAX_FEED_SESSIONS) {
      const oldest = this.stores.keys().next().value as string;
      this.stores.delete(oldest);
      this.dropped += 1;
    }
    return store;
  }

  /**
   * One rAF projection batch (bind.ts). Payloads are grouped per session and
   * applied with ONE notification per touched feed.
   */
  applyBatch(items: readonly TranscriptBatchItem[]): void {
    if (items.length === 0) return;
    const grouped = new Map<string, TranscriptBatchItem['payload'][]>();
    for (const item of items) {
      const bucket = grouped.get(item.sessionId);
      if (bucket === undefined) grouped.set(item.sessionId, [item.payload]);
      else bucket.push(item.payload);
    }
    for (const [sessionId, payloads] of grouped) {
      this.storeFor(sessionId).applyMany(payloads);
    }
  }

  /** Broker restart / test isolation: every projection is stale. */
  reset(): void {
    this.stores.clear();
    this.dropped = 0;
  }
}

/** The app-wide registry (module singleton, like the zustand stores). */
export const transcriptFeeds = new TranscriptFeedRegistry();
