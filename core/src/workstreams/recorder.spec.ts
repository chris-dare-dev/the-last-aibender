/**
 * LedgerLineageRecorder unit surface (the §15.1 port contract beyond what
 * kernelLineage.spec.ts proves through the real kernel): never-throws,
 * endpoint healing, drop-on-unattributable [X2], merge edges, backfill,
 * activity snapshots.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { openKernelStore, type KernelStore } from '@aibender/schema';
import type { WorkstreamServerPayload } from '@aibender/protocol';

import { createLineageRecorder } from './recorder.js';

const stores: KernelStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function harness() {
  const store = await openKernelStore({ path: ':memory:' });
  stores.push(store);
  const published: WorkstreamServerPayload[] = [];
  let n = 0;
  const recorder = createLineageRecorder({
    store: store.lineage,
    resumeLedger: store.resumeLedger,
    publish: (payload) => published.push(payload),
    newEdgeId: () => `edg_r${String(n++).padStart(2, '0')}`,
  });
  const insertNode = (id: string): void => {
    store.lineage.nodes.insert({
      id,
      backend: 'claude_code',
      account: 'MAX_A',
      cwd: '/synthetic/workspace',
      state: 'running',
      origin: 'harness',
      confidence: 'recorded',
    });
  };
  return { store, recorder, published, insertNode };
}

describe('record — never throws, drops the unattributable', () => {
  it('an edge whose endpoint has NO node and NO ledger row is dropped, counted, and logged — never thrown, never guessed [X2]', async () => {
    const { store, recorder } = await harness();
    expect(() =>
      recorder.record({
        kind: 'resume',
        fromSessionId: 'ses_ghost',
        toSessionId: 'ses_ghost',
        atEpochMs: 1,
      }),
    ).not.toThrow();
    expect(store.lineage.edges.list()).toHaveLength(0);
    expect(store.lineage.nodes.list()).toHaveLength(0);
    expect(recorder.stats()).toEqual({ recorded: 0, dropped: 1 });
  });

  it('duplicate launch actions are idempotent (one node)', async () => {
    const { store, recorder } = await harness();
    const action = {
      kind: 'launch',
      sessionId: 'ses_dup',
      accountLabel: 'MAX_A',
      backend: 'claude_code',
      cwd: '/synthetic/workspace',
      atEpochMs: 1,
    } as const;
    recorder.record(action);
    recorder.record(action);
    expect(store.lineage.nodes.list()).toHaveLength(1);
    expect(recorder.stats().recorded).toBe(2); // both calls succeed; one row
  });
});

describe('record — endpoint healing from the resume ledger', () => {
  it('heals a missing endpoint from its ledger row (attribution from the row, native id backfilled)', async () => {
    const { store, recorder } = await harness();
    store.resumeLedger.insertBeforeSpawn({
      id: 'ses_heal',
      accountLabel: 'ENT',
      backend: 'claude_code',
      cwd: '/synthetic/elsewhere',
      substrate: 'pty',
      purpose: 'healing fixture',
    });
    store.resumeLedger.backfillNativeSessionId('ses_heal', 'native-heal-01');

    recorder.record({
      kind: 'recycle',
      fromSessionId: 'ses_heal',
      toSessionId: 'ses_heal',
      checkpointRef: '/synthetic/checkpoints/heal',
      atEpochMs: 5,
    });

    const node = store.lineage.nodes.get('ses_heal');
    expect(node).toMatchObject({
      account: 'ENT',
      backend: 'claude_code',
      cwd: '/synthetic/elsewhere',
      nativeSessionId: 'native-heal-01',
      origin: 'harness',
      confidence: 'recorded',
    });
    const edges = store.lineage.edges.list();
    expect(edges).toHaveLength(1);
    expect(JSON.parse(edges[0]?.metadataJson ?? '{}')).toMatchObject({
      reason: 'recycle',
      checkpointRef: '/synthetic/checkpoints/heal',
    });
  });
});

describe('record — merge action (the already-materialized-node path)', () => {
  it('writes N merge_parent edges into the merge node; refuses (drops) on a missing parent', async () => {
    const { store, recorder, insertNode } = await harness();
    insertNode('ses_p1');
    insertNode('ses_p2');
    insertNode('ses_mnode');

    recorder.record({
      kind: 'merge',
      parentSessionIds: ['ses_p1', 'ses_p2'],
      toSessionId: 'ses_mnode',
      atEpochMs: 9,
    });
    const edges = store.lineage.edges.list({ edgeTypes: ['merge_parent'] });
    expect(edges.map((edge) => edge.fromNode).sort()).toEqual(['ses_p1', 'ses_p2']);

    // Missing parent → the WHOLE action drops (validated up front).
    recorder.record({
      kind: 'merge',
      parentSessionIds: ['ses_p1', 'ses_ghost'],
      toSessionId: 'ses_mnode',
      atEpochMs: 10,
    });
    expect(store.lineage.edges.list({ edgeTypes: ['merge_parent'] })).toHaveLength(2);
    expect(recorder.stats().dropped).toBe(1);
  });
});

describe('non-port surfaces (composition tap duties)', () => {
  it('backfillNativeSessionId is write-once and never throws', async () => {
    const { store, recorder, insertNode } = await harness();
    insertNode('ses_bf');
    recorder.backfillNativeSessionId('ses_bf', 'native-A');
    expect(store.lineage.nodes.get('ses_bf')?.nativeSessionId).toBe('native-A');
    // Conflicting second backfill: swallowed (logged), value stands.
    expect(() => recorder.backfillNativeSessionId('ses_bf', 'native-B')).not.toThrow();
    expect(store.lineage.nodes.get('ses_bf')?.nativeSessionId).toBe('native-A');
    // Unknown node: silent no-op.
    expect(() => recorder.backfillNativeSessionId('ses_none', 'native-C')).not.toThrow();
  });

  it('noteActivity stamps lastActiveAtMs and never throws', async () => {
    const { store, recorder, insertNode } = await harness();
    insertNode('ses_act');
    recorder.noteActivity('ses_act', 4242);
    expect(store.lineage.nodes.get('ses_act')?.lastActiveAtMs).toBe(4242);
    expect(() => recorder.noteActivity('ses_none', 1)).not.toThrow();
  });

  it('a refusing publisher never blocks recording (row stands, refusal logged)', async () => {
    const store = await openKernelStore({ path: ':memory:' });
    stores.push(store);
    const recorder = createLineageRecorder({
      store: store.lineage,
      publish: () => {
        throw new RangeError('synthetic publish refusal');
      },
    });
    recorder.record({
      kind: 'launch',
      sessionId: 'ses_pub',
      accountLabel: 'MAX_A',
      backend: 'claude_code',
      cwd: '/synthetic/workspace',
      atEpochMs: 1,
    });
    expect(store.lineage.nodes.get('ses_pub')).toBeDefined();
    expect(recorder.stats().recorded).toBe(1);
  });
});
