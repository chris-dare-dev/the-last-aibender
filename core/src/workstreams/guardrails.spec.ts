/**
 * Guardrails — the 30-day `unresumable` flag (plan §9.2 BE-7 edge row) and
 * retention monitoring counters.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { WorkstreamServerPayload } from '@aibender/protocol';
import { openKernelStore, type KernelStore } from '@aibender/schema';

import { createWorkstreamGuardrails } from './guardrails.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY_MS;

const stores: KernelStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function harness() {
  const store = await openKernelStore({ path: ':memory:' });
  stores.push(store);
  const published: WorkstreamServerPayload[] = [];
  const guardrails = createWorkstreamGuardrails({
    store: store.lineage,
    publish: (payload) => published.push(payload),
    nowMs: () => NOW,
  });
  return { store, guardrails, published };
}

describe('sweepRetention', () => {
  it('flags nodes past the retention horizon unresumable; keeps fresh nodes; publishes upserts', async () => {
    const store = await openKernelStore({ path: ':memory:' });
    stores.push(store);
    const published: WorkstreamServerPayload[] = [];
    const guardrails = createWorkstreamGuardrails({
      store: store.lineage,
      publish: (payload) => published.push(payload),
      nowMs: () => NOW,
    });

    const insert = (id: string): void => {
      store.lineage.nodes.insert({
        id,
        backend: 'claude_code',
        account: 'MAX_A',
        state: 'idle',
        origin: 'harness',
        confidence: 'recorded',
      });
    };
    insert('ses_old');
    insert('ses_warn');
    insert('ses_fresh');
    // Age via the activity snapshot (lastActiveAtMs drives the sweep).
    store.lineage.nodes.updateSnapshots('ses_old', { lastActiveAtMs: NOW - 31 * DAY_MS });
    store.lineage.nodes.updateSnapshots('ses_warn', { lastActiveAtMs: NOW - 27 * DAY_MS });
    store.lineage.nodes.updateSnapshots('ses_fresh', { lastActiveAtMs: NOW - 1 * DAY_MS });

    const result = guardrails.sweepRetention();
    expect(result).toMatchObject({ flaggedUnresumable: 1, approachingRetention: 1 });
    expect(store.lineage.nodes.get('ses_old')?.state).toBe('unresumable');
    expect(store.lineage.nodes.get('ses_warn')?.state).toBe('idle');
    expect(store.lineage.nodes.get('ses_fresh')?.state).toBe('idle');
    expect(
      published.filter(
        (payload) => payload.kind === 'workstream-node' && payload.state === 'unresumable',
      ),
    ).toHaveLength(1);

    // Idempotent: the second sweep flags nothing new.
    expect(guardrails.sweepRetention().flaggedUnresumable).toBe(0);
  });

  it('terminal/flagged states are never re-flagged', async () => {
    const { store, guardrails } = await harness();
    store.lineage.nodes.insert({
      id: 'ses_abandoned',
      backend: 'claude_code',
      account: 'MAX_A',
      state: 'abandoned',
      origin: 'harness',
      confidence: 'recorded',
    });
    store.lineage.nodes.updateSnapshots('ses_abandoned', { lastActiveAtMs: NOW - 90 * DAY_MS });
    expect(guardrails.sweepRetention().flaggedUnresumable).toBe(0);
    expect(store.lineage.nodes.get('ses_abandoned')?.state).toBe('abandoned');
  });
});

describe('retentionCounters', () => {
  it('counts totals, unresumable, approaching, and the detached bucket', async () => {
    const { store, guardrails } = await harness();
    const insert = (id: string, workstreamId?: string): void => {
      if (workstreamId !== undefined && store.lineage.workstreams.get(workstreamId) === undefined) {
        store.lineage.workstreams.insert({ id: workstreamId, title: 'counters' });
      }
      store.lineage.nodes.insert({
        id,
        ...(workstreamId !== undefined ? { workstreamId } : {}),
        backend: 'claude_code',
        account: 'MAX_A',
        state: 'idle',
        origin: 'harness',
        confidence: 'recorded',
      });
    };
    insert('ses_a', 'ws_c');
    insert('ses_b');
    insert('ses_c');
    store.lineage.nodes.updateSnapshots('ses_a', { lastActiveAtMs: NOW - 27 * DAY_MS });
    store.lineage.nodes.updateSnapshots('ses_b', { lastActiveAtMs: NOW - 40 * DAY_MS });
    store.lineage.nodes.updateSnapshots('ses_c', { lastActiveAtMs: NOW - 1 * DAY_MS });
    store.lineage.nodes.setState('ses_b', 'unresumable');

    expect(guardrails.retentionCounters()).toEqual({
      totalNodes: 3,
      unresumable: 1,
      approachingRetention: 1,
      detached: 2,
    });
  });
});

describe('configuration', () => {
  it('refuses a warn window at or beyond the retention horizon', async () => {
    const store = await openKernelStore({ path: ':memory:' });
    stores.push(store);
    expect(() =>
      createWorkstreamGuardrails({ store: store.lineage, retentionDays: 5, warnWindowDays: 5 }),
    ).toThrowError(RangeError);
  });
});
