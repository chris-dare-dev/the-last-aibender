/**
 * THE M4 DoD assertion (plan §8.2 M4; §9.2 BE-7 positive rows): driving the
 * REAL kernel (BE-1 sessionKernel over the real schema store + FakeQueryRunner)
 * and the REAL ptyHost (BE-2 over FakePtyBackend) through
 * launch → resume → fork → recycle produces EXACTLY the expected typed
 * nodes/edges, recorded AT ACTION TIME — the same tick as the ledger write,
 * not reconciled later.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { validateWorkstreamServerPayload } from '@aibender/protocol';
import type { WorkstreamServerPayload } from '@aibender/protocol';
import { openKernelStore, type KernelStore } from '@aibender/schema';
import { FakePtyBackend, FakeQueryRunner } from '@aibender/testkit';

import { createProfileRegistry } from '../kernel/profiles.js';
import { createPtyHost } from '../kernel/pty/ptyHost.js';
import { createSessionKernel } from '../kernel/sessionKernel.js';
import { continuationEdgesFromRecorder, createLineageRecorder } from './index.js';

const HOME = '/synthetic/aibender-home';
const CWD = '/synthetic/workspace';

const stores: KernelStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function harness(runnerMode: 'auto' | 'manual' = 'auto') {
  const store = await openKernelStore({ path: ':memory:' });
  stores.push(store);
  const published: WorkstreamServerPayload[] = [];
  const recorder = createLineageRecorder({
    store: store.lineage,
    resumeLedger: store.resumeLedger,
    publish: (payload) => published.push(payload),
  });
  const runner = new FakeQueryRunner({ mode: runnerMode });
  const profiles = createProfileRegistry({ aibenderHome: HOME });
  const kernel = createSessionKernel({
    ledger: store.resumeLedger,
    profiles,
    runner,
    baseEnv: { PATH: '/usr/bin' },
    lineage: recorder,
  });
  return { store, runner, kernel, recorder, published, profiles };
}

const launchParams = {
  accountLabel: 'MAX_A',
  backend: 'claude_code',
  substrate: 'sdk',
  cwd: CWD,
  purpose: 'synthesized lineage exercise',
  prompt: 'synthesized prompt',
} as const;

describe('lineage through the REAL kernel (ws-protocol.md §15.1)', () => {
  it('launch records the node AT ACTION TIME — before the spawn is awaited', async () => {
    const store = await openKernelStore({ path: ':memory:' });
    stores.push(store);
    const recorder = createLineageRecorder({
      store: store.lineage,
      resumeLedger: store.resumeLedger,
    });
    let nodeExistedAtSpawnTime = false;
    const runner = new FakeQueryRunner({
      onStart: (spec) => {
        // The runner has NOT spawned yet — the node must already exist.
        nodeExistedAtSpawnTime = store.lineage.nodes.get(spec.sessionId) !== undefined;
      },
    });
    const kernel = createSessionKernel({
      ledger: store.resumeLedger,
      profiles: createProfileRegistry({ aibenderHome: HOME }),
      runner,
      baseEnv: { PATH: '/usr/bin' },
      lineage: recorder,
    });
    const session = await kernel.launch(launchParams);
    await session.waitForExit();

    expect(nodeExistedAtSpawnTime).toBe(true);
    const node = store.lineage.nodes.get(session.sessionId);
    expect(node).toMatchObject({
      id: session.sessionId,
      backend: 'claude_code',
      account: 'MAX_A',
      cwd: CWD,
      origin: 'harness',
      confidence: 'recorded',
      workstreamId: null, // no hint → detached until assigned
    });
    // Launch creates a NODE, never an edge.
    expect(store.lineage.edges.list()).toHaveLength(0);
  });

  it('launch → resume → fork produces exactly the expected typed edge set', async () => {
    const { store, kernel } = await harness();

    // LAUNCH.
    const session = await kernel.launch(launchParams);
    await session.waitForExit();

    // RESUME (exited is terminal → the kernel forces fork; the un-forked
    // in-place continue self-edge is covered below with a live→dead row).
    // First: un-forked dead resume of a running-family row.
    // Re-drive the SAME node: fabricate the dead-resume path by resuming the
    // exited session as a FORK (continuation child) — the kernel's rule.
    const fork = await kernel.resume(session.sessionId, { prompt: 'branch', fork: true });
    expect(fork.forkedFrom).toBe(session.sessionId);
    await fork.waitForExit();

    const edges = store.lineage.edges.list();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      fromNode: session.sessionId,
      toNode: fork.sessionId,
      edgeType: 'fork',
      confidence: 'recorded',
    });
    // Both endpoints exist as harness-recorded nodes.
    expect(store.lineage.nodes.get(fork.sessionId)?.origin).toBe('harness');
  });

  /**
   * A dead running-family row from a PREVIOUS broker life — the un-forked
   * dead-resume precondition (exited is terminal; the sessionKernel.spec
   * fabrication pattern). pid stays NULL → the SDK stdio-pipe reasoning
   * admits the un-forked re-drive.
   */
  function fabricateDeadRow(store: KernelStore, id: string): void {
    store.resumeLedger.insertBeforeSpawn({
      id,
      accountLabel: 'MAX_A',
      backend: 'claude_code',
      cwd: CWD,
      substrate: 'sdk',
      purpose: 'synthesized previous-life session',
    });
    store.resumeLedger.transition(id, 'running');
    store.resumeLedger.backfillNativeSessionId(id, `synth-native-${id}`);
  }

  it('un-forked dead resume records the continue SELF-edge (continuation = child, in-place)', async () => {
    const { store, runner, kernel } = await harness('manual');
    fabricateDeadRow(store, 'ses_prevlife01');

    const resumed = await kernel.resume('ses_prevlife01', { prompt: 'continue' });
    expect(resumed.sessionId).toBe('ses_prevlife01');
    runner.session('ses_prevlife01').complete();
    await resumed.waitForExit();

    const edges = store.lineage.edges.list();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      fromNode: 'ses_prevlife01',
      toNode: 'ses_prevlife01', // the legal continue SELF-edge
      edgeType: 'continue',
      confidence: 'recorded',
    });
    // The endpoint node was HEALED from the resume-ledger row — attribution
    // from the row, never guessed [X2].
    expect(store.lineage.nodes.get('ses_prevlife01')).toMatchObject({
      backend: 'claude_code',
      account: 'MAX_A',
      origin: 'harness',
      confidence: 'recorded',
    });
  });

  it('full resume→fork drive over one node yields exactly [continue self, fork] — nothing else', async () => {
    const { store, runner, kernel } = await harness('manual');
    fabricateDeadRow(store, 'ses_prevlife02');

    const resumed = await kernel.resume('ses_prevlife02', { prompt: 'continue' });
    runner.session('ses_prevlife02').complete();
    await resumed.waitForExit();

    const fork = await kernel.resume('ses_prevlife02', { prompt: 'branch', fork: true });
    runner.session(fork.sessionId).complete();
    await fork.waitForExit();

    // Same-ms writes tie-break on the random edge id — sort by type for a
    // deterministic exact-set comparison (the SET is the assertion).
    const edges = [...store.lineage.edges.list()].sort((a, b) =>
      a.edgeType.localeCompare(b.edgeType),
    );
    expect(edges.map((edge) => [edge.edgeType, edge.fromNode, edge.toNode])).toEqual([
      ['continue', 'ses_prevlife02', 'ses_prevlife02'],
      ['fork', 'ses_prevlife02', fork.sessionId],
    ]);
    // Exactly two nodes: the original and the fork child.
    expect(store.lineage.nodes.list().map((node) => node.id).sort()).toEqual(
      ['ses_prevlife02', fork.sessionId].sort(),
    );
  });

  it('workstreamHint resolves to a workstream id (exact id, then exact title)', async () => {
    const { store, kernel } = await harness();
    const ws = store.lineage.workstreams.insert({ id: 'ws_hint01', title: 'auth refactor' });

    const byId = await kernel.launch({ ...launchParams, workstreamHint: ws.id });
    await byId.waitForExit();
    expect(store.lineage.nodes.get(byId.sessionId)?.workstreamId).toBe(ws.id);

    const byTitle = await kernel.launch({ ...launchParams, workstreamHint: 'auth refactor' });
    await byTitle.waitForExit();
    expect(store.lineage.nodes.get(byTitle.sessionId)?.workstreamId).toBe(ws.id);

    const miss = await kernel.launch({ ...launchParams, workstreamHint: 'no such stream' });
    await miss.waitForExit();
    expect(store.lineage.nodes.get(miss.sessionId)?.workstreamId).toBeNull();
  });

  it('every recorded node/edge fans out a VALID frozen wire payload', async () => {
    const { kernel, published } = await harness();
    const session = await kernel.launch(launchParams);
    await session.waitForExit();
    const fork = await kernel.resume(session.sessionId, { prompt: 'b', fork: true });
    await fork.waitForExit();

    expect(published.length).toBeGreaterThanOrEqual(3); // node, node, edge
    for (const payload of published) {
      const checked = validateWorkstreamServerPayload(payload);
      expect(checked.ok).toBe(true);
    }
    // [X2]: no payload carries a native id key.
    for (const payload of published) {
      expect(JSON.stringify(payload)).not.toContain('nativeSessionId');
    }
  });
});

describe('lineage through the REAL ptyHost recycle (the M2 stub, adapted)', () => {
  it('same-node recycle records the continue self-edge with recycle metadata; fork-recycle records the child edge', async () => {
    const store = await openKernelStore({ path: ':memory:' });
    stores.push(store);
    const recorder = createLineageRecorder({
      store: store.lineage,
      resumeLedger: store.resumeLedger,
    });
    const backend = new FakePtyBackend();
    let n = 0;
    const host = createPtyHost({
      ledger: store.resumeLedger,
      profiles: createProfileRegistry({ aibenderHome: HOME }),
      backend,
      baseEnv: { PATH: '/usr/bin', HOME },
      edges: continuationEdgesFromRecorder(recorder),
      newSessionUuid: () => `f0000000-0000-4000-8000-00000000000${(n++ % 10).toString()}`,
      forceKillAfterMs: 200,
    });

    const session = await host.launchAttended({
      accountLabel: 'MAX_A',
      backend: 'claude_code',
      substrate: 'pty',
      cwd: CWD,
      purpose: 'attended lineage exercise',
    });

    // Same-node recycle → continue SELF-edge (endpoints healed from the
    // resume ledger row the ptyHost wrote — the recorder's healing path).
    await host.recycle(session.sessionId);
    let edges = store.lineage.edges.list();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      fromNode: session.sessionId,
      toNode: session.sessionId,
      edgeType: 'continue',
      confidence: 'recorded',
    });
    expect(JSON.parse(edges[0]?.metadataJson ?? '{}')).toMatchObject({ reason: 'recycle' });

    // Fork-recycle → continue edge to the CHILD row. (Same-ms writes
    // tie-break on the random edge id — select by endpoint, not position.)
    const outcome = await host.recycle(session.sessionId, { fork: true });
    expect(outcome.forkedFrom).toBe(session.sessionId);
    edges = store.lineage.edges.list();
    expect(edges).toHaveLength(2);
    const childEdge = edges.find((edge) => edge.toNode === outcome.session.sessionId);
    expect(childEdge).toMatchObject({
      fromNode: session.sessionId,
      toNode: outcome.session.sessionId,
      edgeType: 'continue',
    });

    await host.shutdown();
  });
});
