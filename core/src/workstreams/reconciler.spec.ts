/**
 * THE RECONCILER (plan §9.2 BE-7 edge rows: external orphan within one
 * cycle; `/cd` moves native scope without breaking lineage; kernel-driven
 * dedupe) + the [X4] HARD-RULE FS-AUDIT: a full ledger+reconciler exercise
 * mutates NOTHING under the watched trees or the opencode.db file.
 *
 * All watched paths are FIXTURE/TEMP dirs synthesized here — never real
 * account dirs [X2/X4].
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { validateHookPost, type WorkstreamServerPayload } from '@aibender/protocol';
import { openKernelStore, type KernelStore } from '@aibender/schema';
import { buildFakeOpencodeDb } from '@aibender/testkit';

import { openOpencodeDbReadOnly } from '../adapters/opencode/dbAccess.js';
import { createWorkstreamHookAutomation } from './automation.js';
import { createWorkstreamLedger } from './ledger.js';
import { createLineageRecorder } from './recorder.js';
import { createWorkstreamReconciler } from './reconciler.js';

const stores: KernelStore[] = [];
const scratch: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const store of stores.splice(0)) store.close();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeProjectsTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aibender-reconciler-'));
  scratch.push(dir);
  return dir;
}

function writeTranscript(projectsDir: string, scope: string, nativeId: string): string {
  const scopeDir = join(projectsDir, scope);
  mkdirSync(scopeDir, { recursive: true });
  const path = join(scopeDir, `${nativeId}.jsonl`);
  writeFileSync(
    path,
    `${JSON.stringify({ type: 'user', message: { content: 'synthesized external prompt' } })}\n`,
  );
  return path;
}

async function harness() {
  const store = await openKernelStore({ path: ':memory:' });
  stores.push(store);
  const published: WorkstreamServerPayload[] = [];
  let n = 0;
  const make = (options: Partial<Parameters<typeof createWorkstreamReconciler>[0]> = {}) =>
    createWorkstreamReconciler({
      store: store.lineage,
      resumeLedger: store.resumeLedger,
      publish: (payload) => published.push(payload),
      newNodeId: () => `ses_rec${String(n++).padStart(2, '0')}`,
      ...options,
    });
  return { store, published, make };
}

describe('reconciler — claude projects trees', () => {
  it('registers an external session as an inferred-confidence orphan within ONE cycle', async () => {
    const { store, published, make } = await harness();
    const tree = makeProjectsTree();
    const transcriptPath = writeTranscript(tree, '-synthetic-workspace', 'native-ext-01');

    const reconciler = make({ roots: [{ accountLabel: 'MAX_A', projectsDir: tree }] });
    const result = reconciler.runCycle();
    expect(result).toMatchObject({ observed: 1, registered: 1, deduped: 0 });

    const node = store.lineage.nodes.byNativeSessionId('native-ext-01');
    expect(node).toMatchObject({
      backend: 'claude_code',
      account: 'MAX_A',
      workstreamId: null, // the detached-HEAD bucket
      state: 'external',
      origin: 'reconciled',
      confidence: 'inferred',
      nativeScope: '-synthetic-workspace',
      transcriptRef: transcriptPath,
    });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ kind: 'workstream-node', origin: 'reconciled' });
  });

  it('NEVER creates nodes or edges for kernel-driven sessions (native-id dedupe)', async () => {
    const { store, make } = await harness();
    const tree = makeProjectsTree();
    writeTranscript(tree, '-synthetic-workspace', 'native-kernel-01');

    // The harness spawned this session itself: resume-ledger row owns it.
    store.resumeLedger.insertBeforeSpawn({
      id: 'ses_kernel',
      accountLabel: 'MAX_A',
      backend: 'claude_code',
      cwd: '/synthetic/workspace',
      substrate: 'sdk',
      purpose: 'kernel-driven',
    });
    store.resumeLedger.backfillNativeSessionId('ses_kernel', 'native-kernel-01');

    const reconciler = make({ roots: [{ accountLabel: 'MAX_A', projectsDir: tree }] });
    const result = reconciler.runCycle();
    expect(result).toMatchObject({ registered: 0, deduped: 1 });
    expect(store.lineage.nodes.list()).toHaveLength(0);
    expect(store.lineage.edges.list()).toHaveLength(0);
  });

  it('a second cycle dedupes already-registered orphans (idempotent cycles)', async () => {
    const { store, make } = await harness();
    const tree = makeProjectsTree();
    writeTranscript(tree, '-synthetic-workspace', 'native-ext-02');
    const reconciler = make({ roots: [{ accountLabel: 'MAX_B', projectsDir: tree }] });
    reconciler.runCycle();
    const second = reconciler.runCycle();
    expect(second).toMatchObject({ registered: 0, deduped: 1 });
    expect(store.lineage.nodes.list()).toHaveLength(1);
  });

  it('/cd moves native scope WITHOUT breaking lineage (identity + edges keep)', async () => {
    const { store, make } = await harness();
    const tree = makeProjectsTree();
    writeTranscript(tree, '-old-scope', 'native-cd-01');
    const reconciler = make({ roots: [{ accountLabel: 'MAX_A', projectsDir: tree }] });
    reconciler.runCycle();
    const before = store.lineage.nodes.byNativeSessionId('native-cd-01');
    expect(before?.nativeScope).toBe('-old-scope');

    // Give the node an edge so lineage breakage would be visible.
    store.lineage.nodes.insert({
      id: 'ses_peer',
      backend: 'claude_code',
      account: 'MAX_A',
      state: 'idle',
      origin: 'harness',
      confidence: 'recorded',
    });
    store.lineage.edges.insert({
      id: 'edg_keep',
      fromNode: before?.id ?? '',
      toNode: 'ses_peer',
      edgeType: 'sidechain',
    });

    // The /cd: the same native session now lives under a NEW encoded cwd.
    rmSync(join(tree, '-old-scope'), { recursive: true, force: true });
    writeTranscript(tree, '-new-scope', 'native-cd-01');
    const moved = reconciler.runCycle();
    expect(moved).toMatchObject({ registered: 0, scopeMoves: 1 });

    const after = store.lineage.nodes.byNativeSessionId('native-cd-01');
    expect(after?.id).toBe(before?.id); // SAME node — lineage unbroken
    expect(after?.nativeScope).toBe('-new-scope');
    expect(store.lineage.edges.listByNode(after?.id ?? '')).toHaveLength(1);
  });

  it('a missing projects tree is a skipped root, never a throw', async () => {
    const { make } = await harness();
    const reconciler = make({
      roots: [{ accountLabel: 'MAX_A', projectsDir: '/synthetic/never-exists' }],
    });
    expect(reconciler.runCycle()).toMatchObject({ observed: 0, registered: 0 });
    expect(reconciler.stats().rootErrors).toBe(1);
  });

  it('refuses non-claude root labels and non-AWS_DEV opencode targets at construction', async () => {
    const { make } = await harness();
    expect(() =>
      make({ roots: [{ accountLabel: 'AWS_DEV', projectsDir: '/synthetic/x' }] }),
    ).toThrowError(/claude_code accounts/);
    expect(() =>
      make({ opencode: { db: { select: () => [] }, accountLabel: 'MAX_A' } }),
    ).toThrowError(/AWS_DEV/);
  });
});

describe('reconciler — opencode.db polling (read-only, guarded)', () => {
  it('registers opencode sessions as AWS_DEV inferred orphans through the BE-4 guard', async () => {
    const { store, make } = await harness();
    const dir = makeProjectsTree();
    const dbPath = join(dir, 'opencode.db');
    buildFakeOpencodeDb({
      path: dbPath,
      sessions: [
        { sessionId: 'oc_session_01', eventTypes: ['session.created', 'session.updated'] },
        { sessionId: 'oc_session_02', eventTypes: ['session.created'] },
      ],
    });
    const db = openOpencodeDbReadOnly({ path: dbPath });
    closers.push(() => db.close());

    const reconciler = make({ opencode: { db, accountLabel: 'AWS_DEV' } });
    const result = reconciler.runCycle();
    expect(result).toMatchObject({ observed: 2, registered: 2 });
    expect(store.lineage.nodes.byNativeSessionId('oc_session_01')).toMatchObject({
      backend: 'opencode',
      account: 'AWS_DEV',
      origin: 'reconciled',
      confidence: 'inferred',
      workstreamId: null,
    });
    expect(store.lineage.edges.list()).toHaveLength(0); // NEVER edges
  });
});

describe('reconciler — start()/watch smoke', () => {
  it('start() runs the first cycle immediately and close() releases everything', async () => {
    const { store, make } = await harness();
    const tree = makeProjectsTree();
    writeTranscript(tree, '-synthetic-workspace', 'native-watch-01');
    const reconciler = make({ roots: [{ accountLabel: 'ENT', projectsDir: tree }] });
    const handle = reconciler.start({ intervalMs: 60_000, debounceMs: 5 });
    try {
      expect(store.lineage.nodes.byNativeSessionId('native-watch-01')).toBeDefined();
    } finally {
      handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// [X4] HARD RULE — the fs-audit proof
// ---------------------------------------------------------------------------

interface FileSnapshot {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string;
}

function snapshotTree(root: string): FileSnapshot[] {
  const out: FileSnapshot[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      out.push({
        path,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      });
    }
  };
  walk(root);
  return out;
}

describe('[X4] fs-audit — zero writes to native stores under a full exercise', () => {
  it('ledger + recorder + automation + reconciler leave the watched tree and opencode.db byte-identical', async () => {
    const store = await openKernelStore({ path: ':memory:' });
    stores.push(store);

    // The native surfaces under audit (fixture/temp only).
    const tree = makeProjectsTree();
    writeTranscript(tree, '-synthetic-workspace', 'native-audit-01');
    writeTranscript(tree, '-synthetic-workspace', 'native-audit-02');
    const dbPath = join(tree, 'opencode.db');
    buildFakeOpencodeDb({
      path: dbPath,
      sessions: [{ sessionId: 'oc_audit_01', eventTypes: ['session.created'] }],
    });
    const db = openOpencodeDbReadOnly({ path: dbPath });
    closers.push(() => db.close());

    const before = snapshotTree(tree);

    // FULL exercise: reconcile, CRUD, record edges, run brief automation
    // over a transcript READ, publish everything.
    const reconciler = createWorkstreamReconciler({
      store: store.lineage,
      resumeLedger: store.resumeLedger,
      roots: [{ accountLabel: 'MAX_A', projectsDir: tree }],
      opencode: { db, accountLabel: 'AWS_DEV' },
    });
    reconciler.runCycle();
    reconciler.runCycle();

    const ledger = createWorkstreamLedger({ store: store.lineage });
    const ws = ledger.createWorkstream({ title: 'audit stream' });
    const orphan = store.lineage.nodes.byNativeSessionId('native-audit-01');
    ledger.assignNode(orphan?.id ?? '', ws.id);

    const recorder = createLineageRecorder({
      store: store.lineage,
      resumeLedger: store.resumeLedger,
    });
    recorder.record({
      kind: 'launch',
      sessionId: 'ses_audit_launch',
      accountLabel: 'MAX_A',
      backend: 'claude_code',
      cwd: '/synthetic/workspace',
      atEpochMs: 1,
    });
    recorder.record({
      kind: 'resume',
      fromSessionId: 'ses_audit_launch',
      toSessionId: 'ses_audit_launch',
      atEpochMs: 2,
    });

    const automation = createWorkstreamHookAutomation({ store: store.lineage });
    const outcome = validateHookPost('MAX_A', {
      hook_event_name: 'SessionEnd',
      session_id: 'native-audit-02',
      transcript_path: join(tree, '-synthetic-workspace', 'native-audit-02.jsonl'),
    });
    if (!outcome.ok) throw new Error('audit fixture must validate');
    automation.onSessionEnd(outcome.accepted);
    await automation.settle();

    // Lineage landed…
    expect(store.lineage.nodes.list().length).toBeGreaterThanOrEqual(4);
    expect(store.lineage.edges.list().length).toBeGreaterThanOrEqual(1);
    // …and the native stores are BYTE-IDENTICAL: zero writes [X4].
    const after = snapshotTree(tree);
    expect(after).toEqual(before);
  });
});
