/**
 * Per-session TranscriptFeed registry (M2 composition fix; plan §9.2 FE-2):
 * Positive: batches route per session with one notification per touched
 *           feed; interleaving/order is the island model's.
 * Negative: payloads never leak across sessions.
 * Edge:     reset clears every feed (broker restart); the session bound
 *           drops oldest with a counter.
 */

import { describe, expect, it } from 'vitest';
import type { TranscriptPayload } from '@aibender/protocol';
import type { TranscriptBatchItem } from '../stores/transcriptStore.ts';
import { MAX_FEED_SESSIONS, TranscriptFeedRegistry } from './transcriptFeeds.ts';

function delta(sessionId: string, messageUuid: string, text: string): TranscriptBatchItem {
  const payload: TranscriptPayload = { kind: 'transcript-delta', sessionId, messageUuid, text };
  return { sessionId, payload };
}

describe('TranscriptFeedRegistry', () => {
  it('routes batches to per-session feeds with ONE notification per feed (positive)', () => {
    const reg = new TranscriptFeedRegistry();
    const feedA = reg.feedFor('ses_fake_a');
    let notifiedA = 0;
    feedA.subscribe(() => {
      notifiedA += 1;
    });
    reg.applyBatch([
      delta('ses_fake_a', 'synthmsg-1', 'hello'),
      delta('ses_fake_a', 'synthmsg-1', ' world'),
      delta('ses_fake_b', 'synthmsg-2', 'other session'),
    ]);
    expect(notifiedA).toBe(1); // applyMany — one notification per frame batch
    const itemsA = feedA.getSnapshot().items;
    expect(itemsA).toHaveLength(1);
    expect(itemsA[0]).toMatchObject({ kind: 'text', text: 'hello world' });
    expect(reg.feedFor('ses_fake_b').getSnapshot().items).toHaveLength(1);
  });

  it('returns the same feed instance for a session (positive)', () => {
    const reg = new TranscriptFeedRegistry();
    expect(reg.feedFor('ses_fake_a')).toBe(reg.feedFor('ses_fake_a'));
  });

  it('never leaks payloads across sessions (negative)', () => {
    const reg = new TranscriptFeedRegistry();
    reg.applyBatch([delta('ses_fake_a', 'synthmsg-1', 'A only')]);
    expect(reg.feedFor('ses_fake_b').getSnapshot().items).toHaveLength(0);
    expect(reg.feedFor('ses_fake_a').getSnapshot().items).toHaveLength(1);
  });

  it('reset clears every feed — broker restart discipline (edge)', () => {
    const reg = new TranscriptFeedRegistry();
    reg.applyBatch([delta('ses_fake_a', 'synthmsg-1', 'old boot')]);
    reg.reset();
    expect(reg.size).toBe(0);
    expect(reg.feedFor('ses_fake_a').getSnapshot().items).toHaveLength(0);
  });

  it('bounds retained sessions with drop-oldest + counter (edge)', () => {
    const reg = new TranscriptFeedRegistry();
    for (let i = 0; i < MAX_FEED_SESSIONS + 3; i += 1) {
      reg.applyBatch([delta(`ses_fake_${i}`, 'synthmsg-1', 'x')]);
    }
    expect(reg.size).toBe(MAX_FEED_SESSIONS);
    expect(reg.droppedSessions).toBe(3);
    // The oldest sessions were evicted; a re-request starts a fresh feed.
    expect(reg.feedFor('ses_fake_0').getSnapshot().items).toHaveLength(0);
    // The newest survived.
    expect(
      reg.feedFor(`ses_fake_${MAX_FEED_SESSIONS + 2}`).getSnapshot().items,
    ).toHaveLength(1);
  });
});
