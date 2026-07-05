/**
 * WorkstreamLedger — CRUD + the §16.5 snapshot builders (plan §9.2 BE-7).
 */

import { afterEach, describe, expect, it } from 'vitest';

import { validateWorkstreamServerPayload, type WorkstreamServerPayload } from '@aibender/protocol';
import { openKernelStore, type KernelStore } from '@aibender/schema';

import { createWorkstreamLedger } from './ledger.js';

const stores: KernelStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function harness() {
  const store = await openKernelStore({ path: ':memory:' });
  stores.push(store);
  const published: WorkstreamServerPayload[] = [];
  let n = 0;
  const ledger = createWorkstreamLedger({
    store: store.lineage,
    publish: (payload) => published.push(payload),
    nowMs: () => 42_000,
    newWorkstreamId: () => `ws_${String(n++).padStart(2, '0')}`,
  });
  return { store, ledger, published };
}

function insertNode(store: KernelStore, id: string, workstreamId?: string): void {
  store.lineage.nodes.insert({
    id,
    ...(workstreamId !== undefined ? { workstreamId } : {}),
    backend: 'claude_code',
    account: 'MAX_A',
    cwd: '/synthetic/workspace',
    state: 'idle',
    origin: 'harness',
    confidence: 'recorded',
  });
}

describe('WorkstreamLedger (positive)', () => {
  it('create/list/detail round-trips and publishes a fresh rail snapshot', async () => {
    const { store, ledger, published } = await harness();
    const row = ledger.createWorkstream({ title: 'auth refactor', tags: ['backend'] });
    expect(row.id).toBe('ws_00');
    expect(ledger.listWorkstreams().map((ws) => ws.id)).toEqual(['ws_00']);

    insertNode(store, 'ses_a', row.id);
    insertNode(store, 'ses_b', row.id);
    insertNode(store, 'ses_detached');

    const list = ledger.listSnapshot();
    expect(list.workstreams[0]).toMatchObject({ workstreamId: 'ws_00', nodeCount: 2 });
    expect(list.detachedNodeCount).toBe(1);
    expect(validateWorkstreamServerPayload(list).ok).toBe(true);

    const detail = ledger.detailSnapshot(row.id);
    expect(detail.scope).toBe('workstream');
    expect(detail.workstream?.workstreamId).toBe(row.id);
    expect(detail.nodes.map((node) => node.sessionId).sort()).toEqual(['ses_a', 'ses_b']);
    expect(validateWorkstreamServerPayload(detail).ok).toBe(true);

    // §16.5 scope matrix: detached FORBIDS the summary member.
    const detached = ledger.detachedSnapshot();
    expect(detached.scope).toBe('detached');
    expect('workstream' in detached && detached.workstream !== undefined).toBe(false);
    expect(detached.nodes.map((node) => node.sessionId)).toEqual(['ses_detached']);
    expect(validateWorkstreamServerPayload(detached).ok).toBe(true);

    expect(published.length).toBeGreaterThanOrEqual(1); // createWorkstream pushed the rail
  });

  it('detail edges are the ones touching the workstream nodes', async () => {
    const { store, ledger } = await harness();
    const ws = ledger.createWorkstream({ title: 'edges scope' });
    insertNode(store, 'ses_in', ws.id);
    insertNode(store, 'ses_out');
    store.lineage.edges.insert({
      id: 'edg_touching',
      fromNode: 'ses_out',
      toNode: 'ses_in',
      edgeType: 'handoff',
      briefId: store.lineage.briefs.insert({
        id: 'br_h',
        kind: 'session-end',
        bodyMd: 'handoff brief for /synthetic/workspace',
        sourceNodes: ['ses_out'],
        provenance: 'native-summary',
      }).id,
    });
    const detail = ledger.detailSnapshot(ws.id);
    expect(detail.edges.map((edge) => edge.edgeId)).toEqual(['edg_touching']);
  });

  it('assignNode publishes the node upsert and refreshes the rail', async () => {
    const { store, ledger, published } = await harness();
    const ws = ledger.createWorkstream({ title: 'assignment' });
    insertNode(store, 'ses_x');
    published.length = 0;

    ledger.assignNode('ses_x', ws.id);
    expect(published[0]).toMatchObject({ kind: 'workstream-node', sessionId: 'ses_x', workstreamId: ws.id });
    expect(published[1]).toMatchObject({ kind: 'workstream-list-snapshot' });

    ledger.assignNode('ses_x', null); // detach
    expect(store.lineage.nodes.get('ses_x')?.workstreamId).toBeNull();
  });

  it('setStatus / rename / setTags mutate and publish', async () => {
    const { ledger, published } = await harness();
    const ws = ledger.createWorkstream({ title: 'lifecycle' });
    published.length = 0;
    expect(ledger.setStatus(ws.id, 'paused').status).toBe('paused');
    expect(ledger.rename(ws.id, 'renamed lifecycle').title).toBe('renamed lifecycle');
    expect(ledger.setTags(ws.id, ['a', 'b']).tags).toEqual(['a', 'b']);
    expect(published).toHaveLength(3); // one rail snapshot per mutation
  });
});

describe('WorkstreamLedger (negative/edge)', () => {
  it('unknown workstream detail throws; unknown status refused by the store', async () => {
    const { ledger } = await harness();
    expect(() => ledger.detailSnapshot('ws_missing')).toThrowError(/no workstream row/);
    expect(() =>
      ledger.setStatus(ledger.createWorkstream({ title: 't' }).id, 'bogus' as never),
    ).toThrowError(/unknown workstream status/);
  });

  it('a refusing publisher never corrupts CRUD (best-effort fan-out)', async () => {
    const store = await openKernelStore({ path: ':memory:' });
    stores.push(store);
    const ledger = createWorkstreamLedger({
      store: store.lineage,
      publish: () => {
        throw new RangeError('synthetic publisher refusal');
      },
    });
    const row = ledger.createWorkstream({ title: 'still lands' });
    expect(ledger.getWorkstream(row.id)?.title).toBe('still lands');
  });

  it('[X2]: an identity-bearing title is refused before any write', async () => {
    const { ledger } = await harness();
    expect(() =>
      ledger.createWorkstream({ title: 'contact someone@example.com about auth' }),
    ).toThrowError();
    expect(ledger.listWorkstreams()).toHaveLength(0);
  });
});
