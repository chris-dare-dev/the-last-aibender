/**
 * JSONL↔OTel join engine (ingest.ts) — blueprint §6.2 "JSONL wins for token
 * truth, OTel wins for attribution, joined on request/session ids", plus the
 * canonical-raw_ref dedupe safety net (plan §9.2 BE-5 edge rows).
 */

import { describe, expect, it, vi } from 'vitest';

import { openEventsStore, type EventsStore } from '@aibender/schema';

import { apiRequestRawRef, createApiRequestJoiner } from './ingest.js';

async function memStore(): Promise<EventsStore> {
  return openEventsStore({ path: ':memory:' });
}

const JSONL_HALF = {
  requestId: 'req_synth_0001',
  account: 'MAX_A' as const,
  tsMs: 1_000,
  nativeSessionId: 'synth-native-1',
  model: 'claude-synth-4',
  usage: {
    inputTokens: 6,
    outputTokens: 244,
    cacheReadTokens: 17_643,
    cacheCreationTokens: 20_144,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 20_144,
  },
};

const OTEL_HALF = {
  requestId: 'req_synth_0001',
  account: 'MAX_A' as const,
  tsMs: 1_050,
  usage: { inputTokens: 5, outputTokens: 240 }, // deliberately WRONG counts
  costEstimatedUsd: 0.42,
  latencyMs: 1234,
  promptId: 'prompt-synth-1',
  skillName: 'synth-skill',
  agentName: 'synth-agent',
  mcpServer: 'synth-mcp',
  toolName: 'Read',
};

describe('createApiRequestJoiner', () => {
  // -- positive ---------------------------------------------------------------

  it('merges both halves into ONE row: JSONL tokens (incl. TTL split), OTel attribution', async () => {
    const store = await memStore();
    const joiner = createApiRequestJoiner(store.events, { nowMs: () => 0 });

    joiner.offerJsonl(JSONL_HALF);
    expect(joiner.pendingCount()).toBe(1);
    joiner.offerOtel(OTEL_HALF);
    expect(joiner.pendingCount()).toBe(0);

    const rows = store.events.list();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.rawRef).toBe(apiRequestRawRef('req_synth_0001'));
    expect(row?.source).toBe('claude-jsonl'); // token truth names the source
    // JSONL wins for tokens — the OTel counts must NOT appear.
    expect(row?.inputTokens).toBe(6);
    expect(row?.outputTokens).toBe(244);
    expect(row?.cacheReadTokens).toBe(17_643);
    expect(row?.cacheCreation5mTokens).toBe(0);
    expect(row?.cacheCreation1hTokens).toBe(20_144);
    // OTel wins for attribution.
    expect(row?.skillName).toBe('synth-skill');
    expect(row?.agentName).toBe('synth-agent');
    expect(row?.mcpServer).toBe('synth-mcp');
    expect(row?.promptId).toBe('prompt-synth-1');
    expect(row?.costEstimatedUsd).toBe(0.42);
    expect(row?.latencyMs).toBe(1234);
    expect(row?.tsMs).toBe(1_000); // JSONL timestamp wins
    expect(joiner.stats().merged).toBe(1);
    store.close();
  });

  it('merges in the other arrival order too (OTel first)', async () => {
    const store = await memStore();
    const joiner = createApiRequestJoiner(store.events, { nowMs: () => 0 });
    joiner.offerOtel(OTEL_HALF);
    joiner.offerJsonl(JSONL_HALF);
    const rows = store.events.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.inputTokens).toBe(6);
    expect(rows[0]?.skillName).toBe('synth-skill');
    store.close();
  });

  // -- negative ---------------------------------------------------------------

  it('refuses non-claude labels and blank request ids (programmer errors)', async () => {
    const store = await memStore();
    const joiner = createApiRequestJoiner(store.events);
    expect(() =>
      joiner.offerJsonl({ ...JSONL_HALF, account: 'AWS_DEV' as never }),
    ).toThrowError(/claude_code/);
    expect(() => joiner.offerJsonl({ ...JSONL_HALF, requestId: '  ' })).toThrowError(
      /requestId/,
    );
    store.close();
  });

  it('a label mismatch is counted and the JSONL (watch-root) label wins', async () => {
    const store = await memStore();
    const joiner = createApiRequestJoiner(store.events, { nowMs: () => 0 });
    joiner.offerJsonl(JSONL_HALF);
    joiner.offerOtel({ ...OTEL_HALF, account: 'MAX_B' });
    const rows = store.events.list();
    expect(rows[0]?.account).toBe('MAX_A');
    expect(joiner.stats().labelMismatches).toBe(1);
    store.close();
  });

  // -- edge -------------------------------------------------------------------

  it('unmatched halves flush after the window as honest single-source rows', async () => {
    const store = await memStore();
    let now = 0;
    const joiner = createApiRequestJoiner(store.events, { nowMs: () => now, windowMs: 100 });

    joiner.offerJsonl(JSONL_HALF);
    joiner.offerOtel({ ...OTEL_HALF, requestId: 'req_synth_0002' });
    expect(joiner.flush()).toBe(0); // window not elapsed
    now = 200;
    expect(joiner.flush()).toBe(2);

    const rows = store.events.list();
    expect(rows).toHaveLength(2);
    const sources = rows.map((row) => row.source).sort();
    expect(sources).toEqual(['claude-jsonl', 'claude-otel']);
    expect(joiner.stats().jsonlOnly).toBe(1);
    expect(joiner.stats().otelOnly).toBe(1);
    store.close();
  });

  it('a late twin after a flush can never double-count (canonical raw_ref dedupe)', async () => {
    const store = await memStore();
    let now = 0;
    const joiner = createApiRequestJoiner(store.events, { nowMs: () => now, windowMs: 100 });

    joiner.offerJsonl(JSONL_HALF);
    now = 500;
    joiner.flush(); // JSONL-only row landed
    joiner.offerOtel(OTEL_HALF); // the twin arrives too late, buffers again
    now = 1_000;
    joiner.flush();

    const rows = store.events.list();
    expect(rows).toHaveLength(1); // ONE row — tokens never doubled
    expect(rows[0]?.inputTokens).toBe(6);
    expect(joiner.stats().lateTwinsDropped).toBe(1);
    store.close();
  });

  it('re-offering the same halves after a restart is a dedupe no-op (re-tail safety)', async () => {
    const store = await memStore();
    const joiner = createApiRequestJoiner(store.events, { nowMs: () => 0 });
    joiner.offerJsonl(JSONL_HALF);
    joiner.offerOtel(OTEL_HALF);
    // "Restart": a fresh joiner re-tails the same transcript + OTel replay.
    const rejoiner = createApiRequestJoiner(store.events, { nowMs: () => 0 });
    rejoiner.offerJsonl(JSONL_HALF);
    rejoiner.offerOtel(OTEL_HALF);
    expect(store.events.list()).toHaveLength(1);
    expect(rejoiner.stats().lateTwinsDropped).toBe(1);
    store.close();
  });

  // -- OS-6: bounded pending map + independent flush timer --------------------

  it('caps the pending map, evicting the OLDEST half as a single-source row', async () => {
    const store = await memStore();
    let now = 0;
    const joiner = createApiRequestJoiner(store.events, { nowMs: () => now, maxPending: 2 });

    // Three distinct request_ids, JSONL-only (their OTel twins never arrive).
    joiner.offerJsonl({ ...JSONL_HALF, requestId: 'req_a' });
    now = 10;
    joiner.offerJsonl({ ...JSONL_HALF, requestId: 'req_b' });
    now = 20;
    joiner.offerJsonl({ ...JSONL_HALF, requestId: 'req_c' }); // evicts req_a (oldest)

    expect(joiner.pendingCount()).toBe(2); // bounded, NOT 3
    expect(joiner.stats().evicted).toBe(1);
    expect(joiner.stats().jsonlOnly).toBe(1); // the evicted half landed as single-source
    const rows = store.events.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rawRef).toBe(apiRequestRawRef('req_a'));
    store.close();
  });

  it('a cap-evicted half still dedupes a late twin (canonical raw_ref, no double-count)', async () => {
    const store = await memStore();
    let now = 0;
    const joiner = createApiRequestJoiner(store.events, { nowMs: () => now, maxPending: 1, windowMs: 100 });

    joiner.offerJsonl({ ...JSONL_HALF, requestId: 'req_a' });
    now = 10;
    joiner.offerJsonl({ ...JSONL_HALF, requestId: 'req_b' }); // evicts req_a as jsonl-only
    expect(joiner.stats().evicted).toBe(1);

    // req_a's OTel twin arrives late; it buffers then flushes, deduping onto the row.
    joiner.offerOtel({ ...OTEL_HALF, requestId: 'req_a' });
    now = 1_000;
    joiner.flush();

    const aRows = store.events.list().filter((r) => r.rawRef === apiRequestRawRef('req_a'));
    expect(aRows).toHaveLength(1); // ONE row for req_a — tokens never doubled
    expect(joiner.stats().lateTwinsDropped).toBe(1);
    store.close();
  });

  it('an independent flush timer flushes without ingest, and close() stops it', async () => {
    vi.useFakeTimers();
    try {
      const store = await memStore();
      let now = 0;
      const joiner = createApiRequestJoiner(store.events, {
        nowMs: () => now,
        windowMs: 100,
        flushIntervalMs: 50,
      });
      joiner.offerJsonl(JSONL_HALF); // buffered at t=0
      now = 500; // past the window
      vi.advanceTimersByTime(50); // the timer fires flush() with NO further ingest
      expect(store.events.list()).toHaveLength(1);
      expect(joiner.stats().jsonlOnly).toBe(1);

      joiner.close();
      joiner.offerJsonl({ ...JSONL_HALF, requestId: 'req_after_close' });
      now = 2_000;
      vi.advanceTimersByTime(500); // timer is cleared → no auto-flush
      expect(joiner.pendingCount()).toBe(1); // still buffered; close() stopped the timer
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('close() is a safe no-op when no flush timer was started', async () => {
    const store = await memStore();
    const joiner = createApiRequestJoiner(store.events, { nowMs: () => 0 });
    expect(() => {
      joiner.close();
      joiner.close();
    }).not.toThrow();
    store.close();
  });
});
