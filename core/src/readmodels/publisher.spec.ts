/**
 * BE-6 publisher tests — the fixture-driven end-to-end of plan §9.2:
 * synthesized events → read models → FROZEN payload validation → publication.
 * Includes one true wire proof through the REAL BE-3 gateway (M3 DoD:
 * read-model snapshots on the events channel, quota snapshots on the quota
 * channel, `{stream:'context-graph'}` envelopes observable on the wire).
 *
 * FIXTURE POLICY [X2]: synthesized rows only — placeholder labels, synthetic
 * models/paths/raw_refs.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  READ_MODEL_IDS,
  validateEventsPayload,
  validateQuotaSnapshot,
  type QuotaSnapshot,
  type ReadModelSnapshot,
} from '@aibender/protocol';
import { openEventsStore, type EventsStore, type NewEventRow } from '@aibender/schema';
import { FakeKernel, FakeQueryRunner } from '@aibender/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createGraphFeed } from '../collector/graphfeed/index.js';
import { startGateway } from '../gateway/server.js';

import { createFreshnessTracker } from './freshness.js';
import { createReadModelPublisher, type ReadModelSink } from './publisher.js';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 6, 1, 12, 0, 0);

const stores: EventsStore[] = [];
afterAll(() => {
  for (const store of stores) store.close();
});

async function openStore(): Promise<EventsStore> {
  const store = await openEventsStore({ path: ':memory:' });
  stores.push(store);
  return store;
}

let rawSeq = 0;
function claudeEvent(overrides: Partial<NewEventRow> = {}): NewEventRow {
  rawSeq += 1;
  return {
    tsMs: NOW - HOUR,
    backend: 'claude_code',
    account: 'MAX_A',
    source: 'claude-jsonl',
    eventType: 'assistant-turn',
    rawRef: `jsonl:/synthetic/publisher.jsonl:${String(rawSeq)}`,
    ...overrides,
  };
}

function capturingSink(): ReadModelSink & {
  readonly events: Record<string, unknown>[];
  readonly quota: QuotaSnapshot[];
} {
  const events: Record<string, unknown>[] = [];
  const quota: QuotaSnapshot[] = [];
  return {
    events,
    quota,
    publishEvent: (payload) => {
      events.push({ ...payload });
    },
    publishQuota: (snapshot) => {
      quota.push(snapshot);
    },
  };
}

async function seededStore(): Promise<EventsStore> {
  const store = await openStore();
  const blockStart = Date.UTC(2026, 6, 1, 10, 0, 0);
  store.events.insert(
    claudeEvent({
      tsMs: blockStart,
      inputTokens: 600,
      outputTokens: 400,
      cacheReadTokens: 3_000,
      cacheCreation5mTokens: 200,
      cacheCreation1hTokens: 100,
      latencyMs: 900,
      ttftMs: 120,
      skillName: 'skill-a',
      ok: true,
      costEstimatedUsd: 0.12,
    }),
  );
  store.events.insert(
    claudeEvent({
      backend: 'lmstudio',
      account: 'LOCAL',
      source: 'lmstudio',
      inputTokens: 500,
      outputTokens: 500,
      latencyMs: 2_000,
      rawRef: 'lmstudio:/synthetic/call:1',
    }),
  );
  store.quotaSnapshots.insert({
    account: 'MAX_A',
    window: '5h',
    usedPct: 40,
    resetsAtMs: NOW + 3 * HOUR,
    capturedAtMs: NOW - 1_000,
    source: 'statusline',
  });
  store.quotaSnapshots.insert({
    account: 'MAX_A',
    window: '7d',
    usedPct: 12,
    resetsAtMs: NOW + 100 * HOUR,
    capturedAtMs: NOW - 1_000,
    source: 'statusline',
  });
  store.sessionOutcomes.insert({
    account: 'MAX_A',
    nativeSessionId: 'nat-ses-01',
    outcome: 'completed',
    capturedAtMs: NOW - HOUR,
    rawRef: 'facets:/synthetic/meta.json:1',
  });
  return store;
}

describe('publisher — fixture-driven end-to-end (capturing sink)', () => {
  it('publishes all ten §6.3 leads, in blueprint order, every one frozen-valid', async () => {
    const store = await seededStore();
    const freshness = createFreshnessTracker();
    freshness.recordSignal('claude-jsonl', NOW - 1_000);
    freshness.recordSignal('claude-quota', NOW - 1_000);
    freshness.recordSignal('lmstudio', NOW - 1_000);

    const sink = capturingSink();
    const publisher = createReadModelPublisher({
      stores: store,
      sink,
      freshness,
      clock: () => NOW,
    });

    const snapshots = publisher.publishAll();
    // M6 freeze forced this: `resource-health` joined READ_MODEL_IDS (the 11th,
    // owned by the BE-9 supervision governor, NOT this BE-6 publisher). The
    // BE-6 publisher still emits exactly the TEN §6.3 observability leads —
    // assert against that ten-lead slice, not the whole (now-11) registry.
    // Cross-package freeze-forced test fix flagged to BE-ORCH via icr_request.
    expect(snapshots.map((s) => s.readModel)).toEqual([...READ_MODEL_IDS].slice(0, 10));
    expect(sink.events).toHaveLength(10);
    for (const payload of sink.events) {
      // The JSON round-trip proves wire-serializability; the frozen
      // validator is the same one FE clients decode with.
      const decoded = validateEventsPayload(JSON.parse(JSON.stringify(payload)));
      expect(decoded.ok).toBe(true);
    }

    const byModel = new Map(snapshots.map((s) => [s.readModel, s]));
    // Quota gauge carries the seeded rows.
    const gauges = byModel.get('quota-gauges');
    expect(gauges?.readModel === 'quota-gauges' && gauges.data.gauges).toHaveLength(2);
    // Burn rate joined the FRESH quota feed and projected exhaustion.
    const burn = byModel.get('burn-rate');
    if (burn?.readModel !== 'burn-rate') throw new Error('burn-rate snapshot missing');
    expect(burn.data.entries[0]?.usedPct).toBe(40);
    expect(burn.data.entries[0]?.projectedExhaustionAt).toBeDefined();
    // Freshness rode every snapshot.
    for (const snapshot of snapshots) {
      expect(snapshot.sources.length).toBeGreaterThan(0);
      expect(snapshot.capturedAt).toBe(NOW);
    }
  });

  it('carries degraded sources as STATES: lmstudio-down shows on the leaderboard snapshot', async () => {
    const store = await seededStore();
    const freshness = createFreshnessTracker();
    freshness.recordSignal('claude-jsonl', NOW - 1_000);
    freshness.setCondition('lmstudio', 'lmstudio-down');

    const publisher = createReadModelPublisher({
      stores: store,
      sink: capturingSink(),
      freshness,
      clock: () => NOW,
    });
    const leaderboard = publisher
      .snapshotAll()
      .find((s): s is Extract<ReadModelSnapshot, { readModel: 'skill-leaderboard' }> => s.readModel === 'skill-leaderboard');
    const lmstudioEntry = leaderboard?.sources.find((s) => s.source === 'lmstudio');
    expect(lmstudioEntry?.state).toBe('lmstudio-down');
    // Correction rates stay ABSENT while the classifier cannot run.
    expect(leaderboard?.data.entries[0]?.correctionRatePct).toBeUndefined();
  });

  it('NEGATIVE: stale quota feed → burn rate publishes WITHOUT the pct join (no stale projection)', async () => {
    const store = await seededStore();
    const freshness = createFreshnessTracker();
    freshness.recordSignal('claude-jsonl', NOW - 1_000);
    freshness.recordSignal('claude-quota', NOW - 20 * 60_000); // stale (>15 min)

    const publisher = createReadModelPublisher({
      stores: store,
      sink: capturingSink(),
      freshness,
      clock: () => NOW,
    });
    const burn = publisher
      .snapshotAll()
      .find((s): s is Extract<ReadModelSnapshot, { readModel: 'burn-rate' }> => s.readModel === 'burn-rate');
    expect(burn?.data.entries.length).toBeGreaterThan(0);
    expect(burn?.data.entries[0]?.usedPct).toBeUndefined();
    expect(burn?.data.entries[0]?.projectedExhaustionAt).toBeUndefined();
    expect(burn?.sources.find((s) => s.source === 'claude-quota')?.state).toBe('stale');
  });

  it('NEGATIVE: empty store → honest empties with no-signal freshness, all ten still frozen-valid', async () => {
    const store = await openStore();
    const sink = capturingSink();
    const publisher = createReadModelPublisher({
      stores: store,
      sink,
      freshness: createFreshnessTracker(),
      clock: () => NOW,
    });

    const snapshots = publisher.publishAll();
    expect(snapshots).toHaveLength(10);
    for (const payload of sink.events) {
      expect(validateEventsPayload(JSON.parse(JSON.stringify(payload))).ok).toBe(true);
    }
    const gauges = snapshots.find((s) => s.readModel === 'quota-gauges');
    if (gauges?.readModel !== 'quota-gauges') throw new Error('missing quota-gauges');
    expect(gauges.data.gauges).toEqual([]); // never a fabricated gauge
    expect(gauges.sources[0]).toEqual({ source: 'claude-quota', state: 'no-signal' });

    // And the quota CHANNEL publishes NOTHING (never a fabricated snapshot).
    expect(publisher.publishQuotaSnapshots()).toBe(0);
    expect(sink.quota).toEqual([]);
  });

  it('bedrock overlay renders estimate-only BY STATE while Cost Explorer never signaled', async () => {
    const store = await openStore();
    store.events.insert(
      claudeEvent({
        backend: 'opencode',
        account: 'AWS_DEV',
        source: 'opencode-sse',
        rawRef: 'evt_synth_101',
        costEstimatedUsd: 0.3,
      }),
    );
    const freshness = createFreshnessTracker();
    freshness.recordSignal('opencode-sse', NOW - 1_000);

    const publisher = createReadModelPublisher({
      stores: store,
      sink: capturingSink(),
      freshness,
      clock: () => NOW,
    });
    const bedrock = publisher
      .snapshotAll()
      .find((s): s is Extract<ReadModelSnapshot, { readModel: 'bedrock-cost' }> => s.readModel === 'bedrock-cost');
    expect(bedrock?.data.estimateMtdUsd).toBeCloseTo(0.3, 10);
    expect(bedrock?.data.actualMtdUsd).toBeUndefined();
    expect(bedrock?.sources.find((s) => s.source === 'bedrock-cost-explorer')?.state).toBe(
      'estimate-only',
    );
  });

  it('publishQuotaSnapshots mirrors the latest rows into frozen §11 payloads', async () => {
    const store = await seededStore();
    const sink = capturingSink();
    const publisher = createReadModelPublisher({
      stores: store,
      sink,
      freshness: createFreshnessTracker(),
      clock: () => NOW,
    });
    expect(publisher.publishQuotaSnapshots()).toBe(2);
    for (const snapshot of sink.quota) {
      expect(validateQuotaSnapshot(JSON.parse(JSON.stringify(snapshot))).ok).toBe(true);
    }
    expect(sink.quota[0]).toEqual({
      kind: 'quota-snapshot',
      account: 'MAX_A',
      window: '5h',
      usedPct: 40,
      resetsAt: NOW + 3 * HOUR,
      capturedAt: NOW - 1_000,
      source: 'statusline',
    });
  });
});

// ---------------------------------------------------------------------------
// True wire proof through the REAL BE-3 gateway
// ---------------------------------------------------------------------------

interface Envelope {
  readonly stream: string;
  readonly channel: string;
  readonly seq: number;
  readonly payload: unknown;
}

describe('publisher + graphfeed — over the real gateway wire', () => {
  it('read models ride events, quota rides quota, touches ride context-graph', async () => {
    const home = await mkdtemp(join(tmpdir(), 'aibender-be6-'));
    const handle = await startGateway({
      kernel: new FakeKernel(new FakeQueryRunner()),
      aibenderHome: home,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    const ws = new WebSocket(`${handle.url}/?token=${handle.token}`);
    const received: Envelope[] = [];
    ws.on('message', (data) => received.push(JSON.parse(String(data)) as Envelope));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    try {
      const store = await seededStore();
      const freshness = createFreshnessTracker();
      freshness.recordSignal('claude-jsonl', NOW - 1_000);
      freshness.recordSignal('claude-quota', NOW - 1_000);

      // The gateway handle IS the sink — the composition-root wiring.
      const publisher = createReadModelPublisher({
        stores: store,
        sink: handle,
        freshness,
        clock: () => NOW,
      });
      publisher.publishAll();
      expect(publisher.publishQuotaSnapshots()).toBe(2);

      const feed = createGraphFeed({ sink: handle, clock: () => NOW });
      expect(
        feed.ingestWatcherTouch({
          sessionId: 'ses_wire_01',
          path: '/synthetic/wire.ts',
          relation: 'read',
        }),
      ).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 150));

      const events = received.filter((e) => e.channel === 'events');
      expect(events).toHaveLength(10);
      for (const envelope of events) {
        expect(envelope.stream).toBe('events');
        expect(validateEventsPayload(envelope.payload).ok).toBe(true);
      }

      const quota = received.filter((e) => e.channel === 'quota');
      expect(quota).toHaveLength(2);
      for (const envelope of quota) {
        expect(validateQuotaSnapshot(envelope.payload).ok).toBe(true);
      }

      // M3 DoD: `{stream:'context-graph'}` envelopes observable on the wire.
      const touches = received.filter((e) => e.channel === 'context-graph');
      expect(touches).toHaveLength(1);
      expect(touches[0]?.stream).toBe('context-graph');
      expect(touches[0]?.payload).toEqual({
        kind: 'context-touch',
        sessionId: 'ses_wire_01',
        path: '/synthetic/wire.ts',
        relation: 'read',
        ts: NOW,
      });
    } finally {
      ws.close();
      await handle.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
