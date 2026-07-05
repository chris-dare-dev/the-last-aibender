/**
 * WorkstreamEngine — the frozen merge verb (ws-protocol.md §16.3/§16.4,
 * ICR-0011) + the draft flow (§16.2). Plan §9.2 BE-7 positive row: "merge
 * node with N parents"; negative rows: unknown parent / unknown workstream /
 * engine-side bad-request.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  validateWorkstreamServerPayload,
  type WorkstreamMergeRequest,
  type WorkstreamServerPayload,
} from '@aibender/protocol';
import { openKernelStore, type KernelStore } from '@aibender/schema';

import { KernelVerbError } from '../gateway/kernel.js';
import { createWorkstreamEngine } from './engine.js';

const stores: KernelStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function harness() {
  const store = await openKernelStore({ path: ':memory:' });
  stores.push(store);
  const published: WorkstreamServerPayload[] = [];
  let ses = 0;
  let br = 0;
  let edg = 0;
  const engine = createWorkstreamEngine({
    store: store.lineage,
    publish: (payload) => published.push(payload),
    nowMs: () => 90_100_000,
    newSessionId: () => `ses_merge${String(ses++).padStart(2, '0')}`,
    newBriefId: () => `br_${String(br++).padStart(2, '0')}`,
    newEdgeId: () => `edg_${String(edg++).padStart(2, '0')}`,
  });
  const insertNode = (id: string): void => {
    store.lineage.nodes.insert({
      id,
      backend: 'claude_code',
      account: 'MAX_A',
      cwd: '/synthetic/workspace',
      state: 'idle',
      origin: 'harness',
      confidence: 'recorded',
    });
  };
  return { store, engine, published, insertNode };
}

function mergeRequest(
  parents: readonly string[],
  overrides: Partial<WorkstreamMergeRequest['params']> = {},
): WorkstreamMergeRequest {
  return {
    kind: 'workstream-merge-request',
    mergeId: 'mrg_01',
    params: {
      parents,
      accountLabel: 'MAX_A',
      backend: 'claude_code',
      cwd: '/synthetic/workspace',
      purpose: 'merge the parallel branches',
      briefBody: '## Merge brief\n\napproach: fused\n\n## Conflicts\n- none surfaced',
      ...overrides,
    },
  };
}

describe('WorkstreamEngine.merge (positive)', () => {
  it('records ONE new node with N merge_parent edges + the mandatory brief, atomically', async () => {
    const { store, engine, published, insertNode } = await harness();
    insertNode('ses_a');
    insertNode('ses_b');
    insertNode('ses_c');

    const resolved = await engine.merge(mergeRequest(['ses_a', 'ses_b', 'ses_c']));
    expect(resolved).toMatchObject({
      kind: 'workstream-merge-resolved',
      mergeId: 'mrg_01',
      sessionId: 'ses_merge00',
      briefId: 'br_00',
    });

    const node = store.lineage.nodes.get('ses_merge00');
    expect(node).toMatchObject({ state: 'idle', origin: 'harness', confidence: 'recorded' });
    const edges = store.lineage.edges.list({ edgeTypes: ['merge_parent'] });
    expect(edges.map((edge) => edge.fromNode).sort()).toEqual(['ses_a', 'ses_b', 'ses_c']);
    expect(new Set(edges.map((edge) => edge.toNode))).toEqual(new Set(['ses_merge00']));
    expect(new Set(edges.map((edge) => edge.briefId))).toEqual(new Set(['br_00']));
    expect(store.lineage.briefs.get('br_00')?.kind).toBe('merge');

    // Fan-out: brief + node + N edges + rail — every payload frozen-valid.
    expect(published.map((payload) => payload.kind)).toEqual([
      'workstream-brief',
      'workstream-node',
      'workstream-edge',
      'workstream-edge',
      'workstream-edge',
      'workstream-list-snapshot',
    ]);
    for (const payload of published) {
      expect(validateWorkstreamServerPayload(payload).ok).toBe(true);
    }
  });

  it('assigns the merge node to a known workstream when named', async () => {
    const { store, engine, insertNode } = await harness();
    store.lineage.workstreams.insert({ id: 'ws_target', title: 'merge target' });
    insertNode('ses_a');
    insertNode('ses_b');
    await engine.merge(mergeRequest(['ses_a', 'ses_b'], { workstreamId: 'ws_target' }));
    expect(store.lineage.nodes.get('ses_merge00')?.workstreamId).toBe('ws_target');
  });
});

describe('WorkstreamEngine.merge (negative — the frozen §16.4 codes)', () => {
  it('unknown parent → session-not-found, nothing written', async () => {
    const { store, engine, insertNode } = await harness();
    insertNode('ses_a');
    await expect(engine.merge(mergeRequest(['ses_a', 'ses_ghost']))).rejects.toMatchObject({
      code: 'session-not-found',
    });
    expect(store.lineage.briefs.list()).toHaveLength(0);
    expect(store.lineage.edges.list()).toHaveLength(0);
  });

  it('unknown workstreamId → workstream-not-found, nothing written', async () => {
    const { store, engine, insertNode } = await harness();
    insertNode('ses_a');
    insertNode('ses_b');
    await expect(
      engine.merge(mergeRequest(['ses_a', 'ses_b'], { workstreamId: 'ws_ghost' })),
    ).rejects.toMatchObject({ code: 'workstream-not-found' });
    expect(store.lineage.briefs.list()).toHaveLength(0);
  });

  it('[X2] identity-bearing purpose → bad-request BEFORE any write', async () => {
    const { store, engine, insertNode } = await harness();
    insertNode('ses_a');
    insertNode('ses_b');
    const bad = mergeRequest(['ses_a', 'ses_b'], { purpose: 'ping someone@example.com' });
    await expect(engine.merge(bad)).rejects.toMatchObject({ code: 'bad-request' });
    expect(store.lineage.briefs.list()).toHaveLength(0);
    expect(store.lineage.nodes.list()).toHaveLength(2);
  });

  it('errors are KernelVerbError instances (the gateway mapping contract)', async () => {
    const { engine } = await harness();
    await expect(engine.merge(mergeRequest(['ses_x', 'ses_y']))).rejects.toBeInstanceOf(
      KernelVerbError,
    );
  });
});

describe('WorkstreamEngine.draftMergeBrief (§16.2 draft flow)', () => {
  it('publishes a conflict-surfacing draft, never persists it', async () => {
    const { store, published, insertNode } = await harness();
    insertNode('ses_a');
    insertNode('ses_b');
    // Branch distillates disagree via the deterministic fallback path: give
    // the nodes conflicting claim lines through injected transcripts.
    const engineWithTranscripts = createWorkstreamEngine({
      store: store.lineage,
      publish: (payload) => published.push(payload),
      readTranscript: () => undefined,
      newBriefId: () => 'br_draft',
    });
    const draft = await engineWithTranscripts.draftMergeBrief(['ses_a', 'ses_b']);
    expect(draft.body.length).toBeGreaterThan(0);
    expect(draft.provenance).toBe('local-draft'); // no drafter composed → fallback
    // Published for the editor…
    const briefPayloads = published.filter((payload) => payload.kind === 'workstream-brief');
    expect(briefPayloads).toHaveLength(1);
    // …but NEVER persisted (§16.2: the wire carries the FINAL text back).
    expect(store.lineage.briefs.list()).toHaveLength(0);
  });

  it('unknown parent → session-not-found', async () => {
    const { engine } = await harness();
    await expect(engine.draftMergeBrief(['ses_ghost', 'ses_gone'])).rejects.toMatchObject({
      code: 'session-not-found',
    });
  });
});
