/**
 * M3 events store suite (migration 0002 + accessors) — positive / negative /
 * edge per plan §9.2 BE-5 rows the SCHEMA layer owns: validated insert path,
 * (backend, raw_ref) dedupe, identity-shape refusal [X2], Cost Explorer
 * backfill semantics, quota/outcome dedupe, override-wins price pinning.
 * All fixtures synthesized.
 */

import { afterAll, describe, expect, it } from 'vitest';

import {
  EVENTS_FIELD_TAGS,
  EVENTS_STORE_MIGRATIONS,
  EventNotFoundError,
  EventsStoreError,
  MIGRATION_0002_EVENTS,
  assertMigrationOrder,
  openEventsStore,
  type EventsStore,
  type NewEventRow,
} from './index.js';

const stores: EventsStore[] = [];
afterAll(() => {
  for (const store of stores) store.close();
});

async function openStore(): Promise<EventsStore> {
  const store = await openEventsStore({ path: ':memory:' });
  stores.push(store);
  return store;
}

function newEvent(overrides: Partial<NewEventRow> = {}): NewEventRow {
  return {
    tsMs: 90_100_000,
    backend: 'claude_code',
    account: 'MAX_A',
    source: 'claude-jsonl',
    eventType: 'assistant-turn',
    rawRef: 'jsonl:/synthetic/transcript.jsonl:1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Positive
// ---------------------------------------------------------------------------

describe('events store — positive', () => {
  it('opens :memory:, applies the events migrations, and reports its journal mode', async () => {
    const store = await openStore();
    expect(store.journalMode).toBe('memory');
    const meta = store.driver
      .prepare("SELECT value FROM schema_meta WHERE key = 'frozen_milestone'")
      .get();
    // 0006 (M7 account-registry relaxation) bumps the events-store milestone.
    expect(meta?.['value']).toBe('M7');
    const ddl = store.driver
      .prepare("SELECT value FROM schema_meta WHERE key = 'events_ddl_version'")
      .get();
    expect(ddl?.['value']).toBe('2');
  });

  it('the sibling migration list is well-ordered and repo-wide unique vs 0001', () => {
    expect(() => assertMigrationOrder(EVENTS_STORE_MIGRATIONS)).not.toThrow();
    expect(MIGRATION_0002_EVENTS.id).toBe(2);
    expect(MIGRATION_0002_EVENTS.name).toBe('events-store-init');
  });

  it('round-trips a fully-loaded event row (four token classes + TTL split)', async () => {
    const store = await openStore();
    const { row, inserted } = store.events.insert(
      newEvent({
        account: 'AWS_DEV',
        backend: 'opencode',
        source: 'opencode-sse',
        eventType: 'message.part.updated',
        sessionId: 'ses_fake_1',
        nativeSessionId: 'synth-native-1',
        workstreamId: 'ws_fake_1',
        promptId: 'prm_fake_1',
        model: 'synthetic-model',
        provider: 'bedrock',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 30,
        cacheCreationTokens: 20,
        cacheCreation5mTokens: 8,
        cacheCreation1hTokens: 12,
        reasoningTokens: 5,
        costEstimatedUsd: 0.012,
        latencyMs: 900,
        ttftMs: 120,
        toolName: 'Read',
        skillName: 'synthetic-skill',
        agentName: 'synthetic-agent',
        mcpServer: 'synthetic-mcp',
        ok: true,
        errorKind: 'retry',
        fileRefs: ['/synthetic/a.ts', '/synthetic/b.ts'],
        rawRef: 'sse:evt_synth_1',
      }),
    );
    expect(inserted).toBe(true);
    expect(row.id).toBeGreaterThan(0);
    expect(row.cacheCreation5mTokens).toBe(8);
    expect(row.cacheCreation1hTokens).toBe(12);
    expect(row.fileRefs).toEqual(['/synthetic/a.ts', '/synthetic/b.ts']);
    expect(row.ok).toBe(true);
    expect(row.errorKind).toBe('retry');
    expect(store.events.getByRawRef('opencode', 'sse:evt_synth_1')?.id).toBe(row.id);
  });

  it('filters by account/eventType/time window with a limit', async () => {
    const store = await openStore();
    store.events.insert(newEvent({ tsMs: 1000, rawRef: 'r1' }));
    store.events.insert(newEvent({ tsMs: 2000, rawRef: 'r2' }));
    store.events.insert(newEvent({ tsMs: 3000, rawRef: 'r3', eventType: 'tool-use' }));
    store.events.insert(
      newEvent({ tsMs: 2500, rawRef: 'r4', account: 'LOCAL', backend: 'lmstudio', source: 'lmstudio' }),
    );
    expect(store.events.list({ account: 'MAX_A' })).toHaveLength(3);
    expect(store.events.list({ eventType: 'tool-use' })).toHaveLength(1);
    expect(store.events.list({ sinceTsMs: 2000, untilTsMs: 2600 })).toHaveLength(2);
    expect(store.events.list({ limit: 2 })).toHaveLength(2);
  });

  it('quota snapshots: latest() returns one row per (account, window)', async () => {
    const store = await openStore();
    const base = { account: 'MAX_A', window: '5h', usedPct: 10, resetsAtMs: 5000, source: 'statusline' } as const;
    store.quotaSnapshots.insert({ ...base, capturedAtMs: 1000 });
    store.quotaSnapshots.insert({ ...base, capturedAtMs: 2000, usedPct: 20 });
    store.quotaSnapshots.insert({ ...base, window: '7d', capturedAtMs: 1500, usedPct: 33 });
    store.quotaSnapshots.insert({
      account: 'MAX_B',
      window: '5h',
      usedPct: 77,
      resetsAtMs: 9000,
      capturedAtMs: 500,
      source: 'oauth-poll',
    });
    const latest = store.quotaSnapshots.latest();
    expect(latest).toHaveLength(3);
    const maxA5h = latest.find((r) => r.account === 'MAX_A' && r.window === '5h');
    expect(maxA5h?.usedPct).toBe(20);
    expect(maxA5h?.capturedAtMs).toBe(2000);
  });

  it('session outcomes round-trip with facets JSON', async () => {
    const store = await openStore();
    const { row, inserted } = store.sessionOutcomes.insert({
      account: 'ENT',
      nativeSessionId: 'synth-native-2',
      outcome: 'completed',
      friction: 'low',
      facetsJson: JSON.stringify({ synthesized: true, capturedAtMs: 1_767_225_600_000 }),
      capturedAtMs: 90_000_000,
      rawRef: 'facets:/synthetic/usage-data/facets:1',
    });
    expect(inserted).toBe(true);
    expect(row.outcome).toBe('completed');
    expect(store.sessionOutcomes.list({ account: 'ENT' })).toHaveLength(1);
  });

  it('prices: seed, read, and list', async () => {
    const store = await openStore();
    const row = store.prices.upsert({
      provider: 'anthropic',
      model: 'synthetic-model',
      inputUsdPerMtok: 3,
      outputUsdPerMtok: 15,
      cacheReadUsdPerMtok: 0.3,
      cacheWriteUsdPerMtok: 3.75,
      source: 'litellm-pinned',
    });
    expect(row.source).toBe('litellm-pinned');
    expect(store.prices.get('anthropic', 'synthetic-model')?.outputUsdPerMtok).toBe(15);
    expect(store.prices.list()).toHaveLength(1);
  });

  it('declares redaction tags for the machine-local columns [X2]', () => {
    expect(EVENTS_FIELD_TAGS['raw_ref']).toEqual(['identifier']);
    expect(EVENTS_FIELD_TAGS['file_refs']).toEqual(['identifier']);
    expect(EVENTS_FIELD_TAGS['facets_json']).toEqual(['identifier']);
  });
});

// ---------------------------------------------------------------------------
// Negative
// ---------------------------------------------------------------------------

describe('events store — negative', () => {
  it('refuses unknown labels, pairing violations, and unknown enums at the accessor', async () => {
    const store = await openStore();
    expect(() =>
      store.events.insert(newEvent({ account: 'PERSONAL' as never })),
    ).toThrow(EventsStoreError);
    expect(() =>
      store.events.insert(newEvent({ backend: 'opencode' })),
    ).toThrow(/pairing violation/);
    expect(() => store.events.insert(newEvent({ source: 'mystery' as never }))).toThrow(
      EventsStoreError,
    );
    expect(() =>
      store.events.insert(newEvent({ errorKind: 'catastrophe' as never })),
    ).toThrow(EventsStoreError);
    expect(() => store.events.insert(newEvent({ eventType: '  ' }))).toThrow(EventsStoreError);
    expect(() => store.events.insert(newEvent({ rawRef: '' }))).toThrow(EventsStoreError);
    expect(() => store.events.insert(newEvent({ inputTokens: -1 }))).toThrow(EventsStoreError);
    expect(() =>
      store.events.insert(newEvent({ costEstimatedUsd: Number.NaN })),
    ).toThrow(EventsStoreError);
    expect(() =>
      store.events.insert(newEvent({ fileRefs: ['relative/path.ts'] })),
    ).toThrow(EventsStoreError);
  });

  it('refuses identity-shaped content in semantic columns [X2]', async () => {
    const store = await openStore();
    expect(() =>
      store.events.insert(newEvent({ skillName: 'someone@example.com' })),
    ).toThrow(/email address/);
    expect(() =>
      store.events.insert(newEvent({ model: 'model-123456789012' })),
    ).toThrow(/12-digit run/);
    expect(() =>
      store.events.insert(newEvent({ toolName: 'sk-synthfaketoken99' })),
    ).toThrow(/token-shaped/);
    expect(() =>
      store.sessionOutcomes.insert({
        account: 'MAX_A',
        nativeSessionId: 'synth-native-3',
        outcome: 'mailed someone@example.com',
        capturedAtMs: 1,
        rawRef: 'facets:x',
      }),
    ).toThrow(/email address/);
  });

  it('the DDL CHECKs stop even a BYPASSING writer (no accessor)', async () => {
    const store = await openStore();
    // Identity-bearing account value — refused by the label-enum CHECK.
    expect(() =>
      store.driver
        .prepare(
          `INSERT INTO events (ts_ms, backend, account, source, event_type, raw_ref, ingested_at_iso)
           VALUES (1, 'claude_code', 'someone@example.com', 'claude-jsonl', 'x', 'r', 't')`,
        )
        .run(),
    ).toThrow();
    // Pairing violation — refused by the pairing CHECK.
    expect(() =>
      store.driver
        .prepare(
          `INSERT INTO events (ts_ms, backend, account, source, event_type, raw_ref, ingested_at_iso)
           VALUES (1, 'opencode', 'MAX_A', 'opencode-sse', 'x', 'r', 't')`,
        )
        .run(),
    ).toThrow();
  });

  it('quota inserts refuse out-of-range percentages and unknown vocab', async () => {
    const store = await openStore();
    const base = {
      account: 'MAX_A',
      window: '5h',
      usedPct: 50,
      resetsAtMs: 1,
      capturedAtMs: 1,
      source: 'statusline',
    } as const;
    expect(() => store.quotaSnapshots.insert({ ...base, usedPct: 101 })).toThrow(EventsStoreError);
    expect(() => store.quotaSnapshots.insert({ ...base, usedPct: -1 })).toThrow(EventsStoreError);
    expect(() =>
      store.quotaSnapshots.insert({ ...base, window: '1h' as never }),
    ).toThrow(EventsStoreError);
    expect(() =>
      store.quotaSnapshots.insert({ ...base, source: 'guesswork' as never }),
    ).toThrow(EventsStoreError);
  });

  it('price upserts refuse blanks, negatives, and unknown sources', async () => {
    const store = await openStore();
    const base = {
      provider: 'anthropic',
      model: 'synthetic-model',
      inputUsdPerMtok: 1,
      outputUsdPerMtok: 2,
      source: 'litellm-pinned',
    } as const;
    expect(() => store.prices.upsert({ ...base, provider: ' ' })).toThrow(EventsStoreError);
    expect(() => store.prices.upsert({ ...base, inputUsdPerMtok: -1 })).toThrow(EventsStoreError);
    expect(() => store.prices.upsert({ ...base, source: 'vibes' as never })).toThrow(
      EventsStoreError,
    );
  });

  it('backfill against a missing (backend, raw_ref) throws EventNotFoundError', async () => {
    const store = await openStore();
    expect(() => store.events.backfillCostActual('opencode', 'nope', 1)).toThrow(
      EventNotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// Edge
// ---------------------------------------------------------------------------

describe('events store — edge', () => {
  it('duplicate (backend, raw_ref) is a silent dedupe no-op returning the FIRST row', async () => {
    const store = await openStore();
    const first = store.events.insert(newEvent({ inputTokens: 10 }));
    const second = store.events.insert(newEvent({ inputTokens: 999 }));
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(second.row.inputTokens).toBe(10); // first write wins; no overwrite
    expect(store.events.list()).toHaveLength(1);
  });

  it('Cost Explorer backfill overwrites the ACTUAL only — estimate and raw stay', async () => {
    const store = await openStore();
    store.events.insert(
      newEvent({
        account: 'AWS_DEV',
        backend: 'opencode',
        source: 'bedrock-cloudwatch',
        costEstimatedUsd: 0.5,
        inputTokens: 42,
        rawRef: 'cw:metric:1',
      }),
    );
    const backfilled = store.events.backfillCostActual('opencode', 'cw:metric:1', 0.47);
    expect(backfilled.costActualUsd).toBe(0.47);
    expect(backfilled.costEstimatedUsd).toBe(0.5);
    expect(backfilled.inputTokens).toBe(42);
    // Re-backfill (a later CE day-refresh) updates the actual.
    expect(store.events.backfillCostActual('opencode', 'cw:metric:1', 0.48).costActualUsd).toBe(
      0.48,
    );
  });

  it('quota dedupe: an identical capture is a no-op; same instant from the other source is kept', async () => {
    const store = await openStore();
    const base = {
      account: 'MAX_A',
      window: '5h',
      usedPct: 10,
      resetsAtMs: 1,
      capturedAtMs: 777,
      source: 'statusline',
    } as const;
    expect(store.quotaSnapshots.insert(base).inserted).toBe(true);
    expect(store.quotaSnapshots.insert(base).inserted).toBe(false);
    expect(store.quotaSnapshots.insert({ ...base, source: 'oauth-poll' }).inserted).toBe(true);
    expect(store.quotaSnapshots.list({ account: 'MAX_A' })).toHaveLength(2);
  });

  it('outcome dedupe on (account, raw_ref)', async () => {
    const store = await openStore();
    const base = {
      account: 'MAX_B',
      nativeSessionId: 'synth-native-4',
      outcome: 'abandoned',
      capturedAtMs: 1,
      rawRef: 'facets:line:9',
    } as const;
    expect(store.sessionOutcomes.insert(base).inserted).toBe(true);
    expect(store.sessionOutcomes.insert({ ...base, outcome: 'completed' }).inserted).toBe(false);
    expect(store.sessionOutcomes.list()[0]?.outcome).toBe('abandoned');
  });

  it('price override wins and SURVIVES re-seeding (the ccusage lesson)', async () => {
    const store = await openStore();
    const seed = {
      provider: 'anthropic',
      model: 'synthetic-model',
      inputUsdPerMtok: 3,
      outputUsdPerMtok: 15,
      source: 'litellm-pinned',
    } as const;
    store.prices.upsert(seed);
    const overridden = store.prices.upsert({
      ...seed,
      inputUsdPerMtok: 2.5,
      source: 'override',
    });
    expect(overridden.source).toBe('override');
    // Re-seed: the pinned upsert must NOT clobber the operator override.
    const surviving = store.prices.upsert({ ...seed, inputUsdPerMtok: 3.1 });
    expect(surviving.source).toBe('override');
    expect(surviving.inputUsdPerMtok).toBe(2.5);
    // A new override always wins.
    expect(
      store.prices.upsert({ ...seed, inputUsdPerMtok: 2.6, source: 'override' }).inputUsdPerMtok,
    ).toBe(2.6);
  });

  it('ts 0 is a legal event time; facets_json epoch values are exempt from the digit screen', async () => {
    const store = await openStore();
    expect(store.events.insert(newEvent({ tsMs: 0, rawRef: 'epoch:0' })).inserted).toBe(true);
    // 13-digit epoch-ms inside facets JSON contains a 12-digit run — exempt
    // by design (identifier-tagged for redaction instead).
    expect(
      store.sessionOutcomes.insert({
        account: 'MAX_A',
        nativeSessionId: 'synth-native-5',
        outcome: 'completed',
        facetsJson: '{"ts":1767225600000}',
        capturedAtMs: 1,
        rawRef: 'facets:line:10',
      }).inserted,
    ).toBe(true);
  });

  it('re-running openEventsStore against the same file is a no-op (idempotent migrations)', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'aibender-events-'));
    try {
      const path = join(dir, 'events.db');
      const first = await openEventsStore({ path });
      expect(first.journalMode).toBe('wal');
      first.events.insert(newEvent());
      first.close();
      const second = await openEventsStore({ path });
      expect(second.events.list()).toHaveLength(1);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
