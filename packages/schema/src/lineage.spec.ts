/**
 * M4 lineage store (migration 0003 + lineage.ts accessors). Positive /
 * negative / edge per plan §9.2 — the storage half of the BE-7 rows:
 * continue edge = child (self-edge legal for in-place resume), merge = one
 * new node with N merge_parent edges (atomic), edge to a missing node
 * rejected, native stores untouched by construction (this is a HARNESS db).
 */

import { describe, expect, it } from 'vitest';

import {
  LineageStoreError,
  openKernelStore,
  type KernelStore,
  type NewSessionNodeRow,
} from './index.js';

async function memoryStore(): Promise<KernelStore> {
  return openKernelStore({ path: ':memory:' });
}

const node = (id: string, patch: Partial<NewSessionNodeRow> = {}): NewSessionNodeRow => ({
  id,
  backend: 'claude_code',
  account: 'MAX_A',
  cwd: '/synthetic/workspace',
  state: 'running',
  origin: 'harness',
  confidence: 'recorded',
  ...patch,
});

describe('lineage store (migration 0003, FROZEN-M4)', () => {
  // -- positive ------------------------------------------------------------

  it('records the lineage DDL slice in schema_meta WITHOUT touching the M1 seeds', async () => {
    const store = await memoryStore();
    expect(store.schemaMeta.get('frozen_milestone')).toBe('M1'); // untouched
    expect(store.schemaMeta.get('lineage_ddl_version')).toBe('1');
    expect(store.schemaMeta.get('lineage_frozen_milestone')).toBe('M4');
    store.close();
  });

  it('inserts workstreams, nodes, briefs, and edges with harness ids primary', async () => {
    const store = await memoryStore();
    const ws = store.lineage.workstreams.insert({
      id: 'ws_fake_1',
      title: 'golden workstream',
      tags: ['golden'],
    });
    expect(ws.status).toBe('active');

    const parent = store.lineage.nodes.insert(
      node('ses_fake_1', { workstreamId: 'ws_fake_1', nativeSessionId: 'fake-native-0' }),
    );
    expect(parent.workstreamId).toBe('ws_fake_1');
    const child = store.lineage.nodes.insert(node('ses_fake_2', { workstreamId: 'ws_fake_1' }));
    expect(child.nativeSessionId).toBeNull(); // native id is a NULLABLE attribute

    const brief = store.lineage.briefs.insert({
      id: 'br_fake_1',
      kind: 'session-end',
      bodyMd: 'continuation brief for /synthetic/workspace',
      sourceNodes: ['ses_fake_1'],
      provenance: 'native-summary',
    });
    expect(brief.sourceNodes).toEqual(['ses_fake_1']);

    const edge = store.lineage.edges.insert({
      id: 'edg_fake_1',
      fromNode: 'ses_fake_1',
      toNode: 'ses_fake_2',
      edgeType: 'continue',
      briefId: 'br_fake_1',
    });
    expect(edge.confidence).toBe('recorded'); // the action-time default
    expect(store.lineage.edges.listByNode('ses_fake_2')).toHaveLength(1);
    store.close();
  });

  it('a continuation may continue the SAME node (self continue edge, in-place resume)', async () => {
    const store = await memoryStore();
    store.lineage.nodes.insert(node('ses_fake_1'));
    const edge = store.lineage.edges.insert({
      id: 'edg_fake_self',
      fromNode: 'ses_fake_1',
      toNode: 'ses_fake_1',
      edgeType: 'continue',
    });
    expect(edge.fromNode).toBe(edge.toNode);
    store.close();
  });

  it('recordMerge writes ONE node + N merge_parent edges atomically', async () => {
    const store = await memoryStore();
    store.lineage.nodes.insert(node('ses_fake_1'));
    store.lineage.nodes.insert(node('ses_fake_2', { account: 'MAX_B' }));
    store.lineage.briefs.insert({
      id: 'br_merge_1',
      kind: 'merge',
      bodyMd: '## merge brief\n\nconflicts surfaced explicitly.',
      sourceNodes: ['ses_fake_1', 'ses_fake_2'],
      provenance: 'refined',
    });
    const result = store.lineage.recordMerge({
      node: node('ses_fake_3', { account: 'ENT' }),
      parents: ['ses_fake_1', 'ses_fake_2'],
      briefId: 'br_merge_1',
      edgeIds: ['edg_m_1', 'edg_m_2'],
    });
    expect(result.node.id).toBe('ses_fake_3');
    expect(result.edges.map((e) => e.edgeType)).toEqual(['merge_parent', 'merge_parent']);
    expect(result.edges.map((e) => e.fromNode)).toEqual(['ses_fake_1', 'ses_fake_2']);
    expect(result.edges.every((e) => e.toNode === 'ses_fake_3')).toBe(true);
    expect(result.edges.every((e) => e.briefId === 'br_merge_1')).toBe(true);
    store.close();
  });

  it('resolver query: byNativeSessionId maps native → node', async () => {
    const store = await memoryStore();
    store.lineage.nodes.insert(node('ses_fake_1', { nativeSessionId: 'fake-native-0' }));
    expect(store.lineage.nodes.byNativeSessionId('fake-native-0')?.id).toBe('ses_fake_1');
    expect(store.lineage.nodes.byNativeSessionId('fake-native-9')).toBeUndefined();
    store.close();
  });

  it('the detached-HEAD bucket lists reconciled unassigned nodes', async () => {
    const store = await memoryStore();
    store.lineage.workstreams.insert({ id: 'ws_fake_1', title: 't' });
    store.lineage.nodes.insert(node('ses_fake_1', { workstreamId: 'ws_fake_1' }));
    store.lineage.nodes.insert(
      node('ses_fake_ext', { origin: 'reconciled', confidence: 'inferred', state: 'external' }),
    );
    const detached = store.lineage.nodes.list({ detached: true });
    expect(detached.map((n) => n.id)).toEqual(['ses_fake_ext']);
    expect(detached[0]?.confidence).toBe('inferred');
    // attach it — the orphan leaves the bucket:
    store.lineage.nodes.assignWorkstream('ses_fake_ext', 'ws_fake_1');
    expect(store.lineage.nodes.list({ detached: true })).toEqual([]);
    store.close();
  });

  // -- negative ------------------------------------------------------------

  it('rejects edges to/from missing nodes (typed error, nothing written)', async () => {
    const store = await memoryStore();
    store.lineage.nodes.insert(node('ses_fake_1'));
    expect(() =>
      store.lineage.edges.insert({
        id: 'edg_bad',
        fromNode: 'ses_fake_1',
        toNode: 'ses_missing',
        edgeType: 'continue',
      }),
    ).toThrow(LineageStoreError);
    expect(store.lineage.edges.list()).toEqual([]);
    store.close();
  });

  it('rejects unknown edge types and the from/import matrix violations', async () => {
    const store = await memoryStore();
    store.lineage.nodes.insert(node('ses_fake_1'));
    store.lineage.nodes.insert(node('ses_fake_2'));
    expect(() =>
      store.lineage.edges.insert({
        id: 'e1',
        fromNode: 'ses_fake_1',
        toNode: 'ses_fake_2',
        edgeType: 'rebase' as never,
      }),
    ).toThrow(LineageStoreError);
    // non-import without from:
    expect(() =>
      store.lineage.edges.insert({ id: 'e2', toNode: 'ses_fake_2', edgeType: 'continue' }),
    ).toThrow(LineageStoreError);
    // import WITH from:
    expect(() =>
      store.lineage.edges.insert({
        id: 'e3',
        fromNode: 'ses_fake_1',
        toNode: 'ses_fake_2',
        edgeType: 'import',
      }),
    ).toThrow(LineageStoreError);
    // import without from is legal:
    expect(store.lineage.edges.insert({ id: 'e4', toNode: 'ses_fake_2', edgeType: 'import' }).id).toBe('e4');
    store.close();
  });

  it('rejects handoff edges without a brief and non-continue self-edges', async () => {
    const store = await memoryStore();
    store.lineage.nodes.insert(node('ses_fake_1'));
    store.lineage.nodes.insert(node('ses_fake_2', { account: 'MAX_B' }));
    expect(() =>
      store.lineage.edges.insert({
        id: 'e1',
        fromNode: 'ses_fake_1',
        toNode: 'ses_fake_2',
        edgeType: 'handoff',
      }),
    ).toThrow(LineageStoreError);
    expect(() =>
      store.lineage.edges.insert({
        id: 'e2',
        fromNode: 'ses_fake_1',
        toNode: 'ses_fake_1',
        edgeType: 'fork',
      }),
    ).toThrow(LineageStoreError);
    store.close();
  });

  it('rejects label/backend pairing violations and relative cwd on nodes (CHECK + accessor)', async () => {
    const store = await memoryStore();
    expect(() =>
      store.lineage.nodes.insert(node('ses_bad', { account: 'AWS_DEV' })), // claude_code backend
    ).toThrow(LineageStoreError);
    expect(() => store.lineage.nodes.insert(node('ses_bad2', { cwd: 'rel/path' }))).toThrow(
      LineageStoreError,
    );
    store.close();
  });

  it('screens identity-shaped content out of naming columns [X2]', async () => {
    const store = await memoryStore();
    expect(() =>
      store.lineage.workstreams.insert({ id: 'ws_bad', title: 'ping owner@example.com' }),
    ).toThrow(LineageStoreError);
    expect(() =>
      store.lineage.nodes.insert(node('ses_bad', { displayName: 'acct 123456789012 run' })),
    ).toThrow(LineageStoreError);
    store.close();
  });

  it('recordMerge refuses bad parent sets and non-merge briefs, atomically', async () => {
    const store = await memoryStore();
    store.lineage.nodes.insert(node('ses_fake_1'));
    store.lineage.nodes.insert(node('ses_fake_2'));
    store.lineage.briefs.insert({
      id: 'br_cont',
      kind: 'session-end',
      bodyMd: 'not a merge brief',
      sourceNodes: ['ses_fake_1'],
      provenance: 'local-draft',
    });
    // one parent:
    expect(() =>
      store.lineage.recordMerge({
        node: node('ses_m'),
        parents: ['ses_fake_1'],
        briefId: 'br_cont',
        edgeIds: ['e1'],
      }),
    ).toThrow(LineageStoreError);
    // duplicate parents:
    expect(() =>
      store.lineage.recordMerge({
        node: node('ses_m'),
        parents: ['ses_fake_1', 'ses_fake_1'],
        briefId: 'br_cont',
        edgeIds: ['e1', 'e2'],
      }),
    ).toThrow(LineageStoreError);
    // wrong brief kind:
    expect(() =>
      store.lineage.recordMerge({
        node: node('ses_m'),
        parents: ['ses_fake_1', 'ses_fake_2'],
        briefId: 'br_cont',
        edgeIds: ['e1', 'e2'],
      }),
    ).toThrow(LineageStoreError);
    // nothing was written by any refused merge:
    expect(store.lineage.nodes.get('ses_m')).toBeUndefined();
    expect(store.lineage.edges.list()).toEqual([]);
    store.close();
  });

  it('bypassing writers cannot land illegal rows (DDL CHECKs hold without the accessor)', async () => {
    const store = await memoryStore();
    expect(() =>
      store.driver
        .prepare(
          `INSERT INTO session_node (id, backend, account, state, origin, confidence, created_at_ms)
           VALUES ('ses_raw', 'opencode', 'MAX_A', 'running', 'harness', 'recorded', 0)`,
        )
        .run(),
    ).toThrow(); // label/backend pairing CHECK
    expect(() =>
      store.driver
        .prepare(
          `INSERT INTO session_edge (id, to_node, edge_type, confidence, created_at_ms)
           VALUES ('edg_raw', 'ses_missing', 'continue', 'recorded', 0)`,
        )
        .run(),
    ).toThrow(); // from_node NULL only for import
    store.close();
  });

  // -- edge ----------------------------------------------------------------

  it('native-id backfill is write-once (same value no-op, different value throws)', async () => {
    const store = await memoryStore();
    store.lineage.nodes.insert(node('ses_fake_1'));
    store.lineage.nodes.backfillNativeSessionId('ses_fake_1', 'fake-native-0');
    expect(
      store.lineage.nodes.backfillNativeSessionId('ses_fake_1', 'fake-native-0').nativeSessionId,
    ).toBe('fake-native-0');
    expect(() =>
      store.lineage.nodes.backfillNativeSessionId('ses_fake_1', 'fake-native-9'),
    ).toThrow(LineageStoreError);
    store.close();
  });

  it('the /cd move mutates native_scope without breaking lineage', async () => {
    const store = await memoryStore();
    store.lineage.nodes.insert(node('ses_fake_1', { nativeScope: '-synthetic-workspace' }));
    store.lineage.nodes.insert(node('ses_fake_2'));
    store.lineage.edges.insert({
      id: 'e1',
      fromNode: 'ses_fake_1',
      toNode: 'ses_fake_2',
      edgeType: 'fork',
    });
    const moved = store.lineage.nodes.updateNativeScope('ses_fake_1', '-synthetic-elsewhere');
    expect(moved.nativeScope).toBe('-synthetic-elsewhere');
    expect(store.lineage.edges.listByNode('ses_fake_1')).toHaveLength(1); // lineage intact
    store.close();
  });

  it('the 30-day-cleanup guardrail is a state flip to unresumable', async () => {
    const store = await memoryStore();
    store.lineage.nodes.insert(node('ses_fake_1'));
    expect(store.lineage.nodes.setState('ses_fake_1', 'unresumable').state).toBe('unresumable');
    expect(() => store.lineage.nodes.setState('ses_fake_1', 'spawning' as never)).toThrow(
      LineageStoreError,
    );
    store.close();
  });

  it('snapshot updates are partial and validated', async () => {
    const store = await memoryStore();
    store.lineage.nodes.insert(node('ses_fake_1'));
    const updated = store.lineage.nodes.updateSnapshots('ses_fake_1', {
      tokensIn: 100,
      lastActiveAtMs: 90_000_000,
    });
    expect(updated.tokensIn).toBe(100);
    expect(updated.tokensOut).toBeNull();
    const again = store.lineage.nodes.updateSnapshots('ses_fake_1', { tokensOut: 40 });
    expect(again.tokensIn).toBe(100); // partial update preserves earlier snapshots
    expect(again.tokensOut).toBe(40);
    expect(() =>
      store.lineage.nodes.updateSnapshots('ses_fake_1', { costEstimatedUsd: -1 }),
    ).toThrow(LineageStoreError);
    store.close();
  });
});
