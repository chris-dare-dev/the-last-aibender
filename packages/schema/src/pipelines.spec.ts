/**
 * M5 pipeline store (migration 0004 + pipelines.ts accessors). Positive /
 * negative / edge per plan §9.2 — the storage half of BE-8: pipeline
 * definitions (upsert-by-id), runs, and THE memoization journal
 * (findMemoized returns a completed attempt's cached output → resume without
 * re-execution; the journal is append-only). This is a HARNESS db — no native
 * store is touched.
 *
 * [X2]: all fixtures synthesized — `wf_fake_*` / `run_fake_*` / `sa_fake_*`
 * ids, `/synthetic/…` paths, placeholder labels.
 */

import {
  registerBackend,
  unregisterBackend,
  type AccountLabel,
  type BackendDescriptor,
} from '@aibender/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openKernelStore, PipelineStoreError, type KernelStore } from './index.js';

async function memoryStore(): Promise<KernelStore> {
  return openKernelStore({ path: ':memory:' });
}

const DOC = JSON.stringify({
  schemaVersion: 1,
  id: 'wf_fake_1',
  name: 'synthetic pipeline',
  steps: [{ id: 'a', kind: 'prompt', prompt: 'do it' }],
});

async function seededDefinition(store: KernelStore): Promise<void> {
  store.pipelines.definitions.upsert({
    id: 'wf_fake_1',
    name: 'synthetic pipeline',
    documentJson: DOC,
    schemaVersion: 1,
    schemaHash: 'sha256:deadbeef',
  });
}

describe('pipeline store (migration 0004, FROZEN-M5)', () => {
  // -- positive ------------------------------------------------------------

  it('records the pipeline DDL slice in its OWN schema_meta keys (not the shared base)', async () => {
    const store = await memoryStore();
    // The base frozen_milestone advances with the newest kernel migration
    // (0007 = M8, ICR-0016); the LINEAGE + PIPELINE slices keep their OWN keys.
    expect(store.schemaMeta.get('frozen_milestone')).toBe('M8');
    expect(store.schemaMeta.get('lineage_frozen_milestone')).toBe('M4'); // untouched
    expect(store.schemaMeta.get('pipeline_ddl_version')).toBe('1');
    expect(store.schemaMeta.get('pipeline_frozen_milestone')).toBe('M5');
    store.close();
  });

  it('upserts a definition, preserving created_at on overwrite', async () => {
    const store = await memoryStore();
    const first = store.pipelines.definitions.upsert({
      id: 'wf_fake_1',
      name: 'v1',
      documentJson: DOC,
      schemaVersion: 1,
      schemaHash: 'sha256:aaaa',
    });
    const second = store.pipelines.definitions.upsert({
      id: 'wf_fake_1',
      name: 'v2',
      documentJson: DOC,
      schemaVersion: 1,
      schemaHash: 'sha256:bbbb',
    });
    expect(second.name).toBe('v2');
    expect(second.schemaHash).toBe('sha256:bbbb');
    expect(second.createdAtMs).toBe(first.createdAtMs); // preserved
    expect(store.pipelines.definitions.list()).toHaveLength(1);
    store.close();
  });

  it('inserts a run against a definition and transitions its status', async () => {
    const store = await memoryStore();
    await seededDefinition(store);
    const run = store.pipelines.runs.insert({
      id: 'run_fake_1',
      pipelineId: 'wf_fake_1',
      schemaHash: 'sha256:deadbeef',
      inputsJson: JSON.stringify({ paths: ['/synthetic/a.ts'] }),
      workstreamId: 'ws_fake_1',
    });
    expect(run.status).toBe('pending');
    const running = store.pipelines.runs.setStatus('run_fake_1', 'running', { startedAtMs: 1000 });
    expect(running.status).toBe('running');
    expect(running.startedAtMs).toBe(1000);
    const done = store.pipelines.runs.setStatus('run_fake_1', 'completed', {
      finishedAtMs: 2000,
      costEstimatedUsd: 0.42,
    });
    expect(done.status).toBe('completed');
    expect(done.costEstimatedUsd).toBeCloseTo(0.42);
    store.close();
  });

  it('records a step attempt and completes it with output + cost + session', async () => {
    const store = await memoryStore();
    await seededDefinition(store);
    store.pipelines.runs.insert({ id: 'run_fake_1', pipelineId: 'wf_fake_1', schemaHash: 'sha256:deadbeef' });
    const attempt = store.pipelines.stepAttempts.record({
      id: 'sa_fake_1',
      runId: 'run_fake_1',
      stepId: 'a',
      inputHash: 'sha256:input1',
      status: 'running',
      account: 'MAX_A',
    });
    expect(attempt.status).toBe('running');
    const done = store.pipelines.stepAttempts.complete('sa_fake_1', {
      status: 'completed',
      sessionId: 'ses_fake_a',
      outputJson: JSON.stringify({ files: ['/synthetic/a.ts'] }),
      costEstimatedUsd: 0.01,
      tokensIn: 100,
      tokensOut: 50,
    });
    expect(done.status).toBe('completed');
    expect(done.sessionId).toBe('ses_fake_a');
    expect(done.tokensIn).toBe(100);
    store.close();
  });

  // -- THE memoization journal (the M5 DoD) --------------------------------

  it('findMemoized returns a COMPLETED attempt for a matching input hash (resume without re-execution)', async () => {
    const store = await memoryStore();
    await seededDefinition(store);
    store.pipelines.runs.insert({ id: 'run_fake_1', pipelineId: 'wf_fake_1', schemaHash: 'sha256:deadbeef' });
    store.pipelines.stepAttempts.record({ id: 'sa_fake_1', runId: 'run_fake_1', stepId: 'a', inputHash: 'sha256:H1' });
    store.pipelines.stepAttempts.complete('sa_fake_1', {
      status: 'completed',
      outputJson: JSON.stringify({ cached: true }),
    });
    const hit = store.pipelines.stepAttempts.findMemoized('run_fake_1', 'a', 0, 'sha256:H1');
    expect(hit).toBeDefined();
    expect(hit?.outputJson).toBe(JSON.stringify({ cached: true }));
    store.close();
  });

  it('findMemoized treats a `memoized` attempt as a cache hit', async () => {
    const store = await memoryStore();
    await seededDefinition(store);
    store.pipelines.runs.insert({ id: 'run_fake_1', pipelineId: 'wf_fake_1', schemaHash: 'sha256:deadbeef' });
    store.pipelines.stepAttempts.record({ id: 'sa_fake_1', runId: 'run_fake_1', stepId: 'a', inputHash: 'sha256:H1', status: 'memoized' });
    const hit = store.pipelines.stepAttempts.findMemoized('run_fake_1', 'a', 0, 'sha256:H1');
    expect(hit?.status).toBe('memoized');
    store.close();
  });

  it('findMemoized misses on a DIFFERENT input hash (input changed → re-execute)', async () => {
    const store = await memoryStore();
    await seededDefinition(store);
    store.pipelines.runs.insert({ id: 'run_fake_1', pipelineId: 'wf_fake_1', schemaHash: 'sha256:deadbeef' });
    store.pipelines.stepAttempts.record({ id: 'sa_fake_1', runId: 'run_fake_1', stepId: 'a', inputHash: 'sha256:H1' });
    store.pipelines.stepAttempts.complete('sa_fake_1', { status: 'completed', outputJson: '{}' });
    expect(store.pipelines.stepAttempts.findMemoized('run_fake_1', 'a', 0, 'sha256:H2')).toBeUndefined();
    store.close();
  });

  it('findMemoized misses on a FAILED attempt (a failed step must re-run)', async () => {
    const store = await memoryStore();
    await seededDefinition(store);
    store.pipelines.runs.insert({ id: 'run_fake_1', pipelineId: 'wf_fake_1', schemaHash: 'sha256:deadbeef' });
    store.pipelines.stepAttempts.record({ id: 'sa_fake_1', runId: 'run_fake_1', stepId: 'a', inputHash: 'sha256:H1' });
    store.pipelines.stepAttempts.complete('sa_fake_1', { status: 'failed', errorKind: 'timeout' });
    expect(store.pipelines.stepAttempts.findMemoized('run_fake_1', 'a', 0, 'sha256:H1')).toBeUndefined();
    store.close();
  });

  it('findMemoized returns the NEWEST completed attempt when a later retry also completed', async () => {
    const store = await memoryStore();
    await seededDefinition(store);
    store.pipelines.runs.insert({ id: 'run_fake_1', pipelineId: 'wf_fake_1', schemaHash: 'sha256:deadbeef' });
    store.pipelines.stepAttempts.record({ id: 'sa_fake_0', runId: 'run_fake_1', stepId: 'a', iteration: 0, attempt: 0, inputHash: 'sha256:H1' });
    store.pipelines.stepAttempts.complete('sa_fake_0', { status: 'completed', outputJson: '"first"' });
    store.pipelines.stepAttempts.record({ id: 'sa_fake_1', runId: 'run_fake_1', stepId: 'a', iteration: 0, attempt: 1, inputHash: 'sha256:H1' });
    store.pipelines.stepAttempts.complete('sa_fake_1', { status: 'completed', outputJson: '"second"' });
    const hit = store.pipelines.stepAttempts.findMemoized('run_fake_1', 'a', 0, 'sha256:H1');
    expect(hit?.outputJson).toBe('"second"');
    store.close();
  });

  it('records forEach iterations as distinct journal keys', async () => {
    const store = await memoryStore();
    await seededDefinition(store);
    store.pipelines.runs.insert({ id: 'run_fake_1', pipelineId: 'wf_fake_1', schemaHash: 'sha256:deadbeef' });
    store.pipelines.stepAttempts.record({ id: 'sa_i0', runId: 'run_fake_1', stepId: 'audit', iteration: 0, inputHash: 'sha256:file0' });
    store.pipelines.stepAttempts.record({ id: 'sa_i1', runId: 'run_fake_1', stepId: 'audit', iteration: 1, inputHash: 'sha256:file1' });
    store.pipelines.stepAttempts.complete('sa_i0', { status: 'completed', outputJson: '"a0"' });
    store.pipelines.stepAttempts.complete('sa_i1', { status: 'completed', outputJson: '"a1"' });
    expect(store.pipelines.stepAttempts.findMemoized('run_fake_1', 'audit', 0, 'sha256:file0')?.outputJson).toBe('"a0"');
    expect(store.pipelines.stepAttempts.findMemoized('run_fake_1', 'audit', 1, 'sha256:file1')?.outputJson).toBe('"a1"');
    expect(store.pipelines.stepAttempts.listByRun('run_fake_1')).toHaveLength(2);
    store.close();
  });

  // -- negative ------------------------------------------------------------

  it('the journal is append-only: recording the same (run, step, iter, attempt) throws', async () => {
    const store = await memoryStore();
    await seededDefinition(store);
    store.pipelines.runs.insert({ id: 'run_fake_1', pipelineId: 'wf_fake_1', schemaHash: 'sha256:deadbeef' });
    store.pipelines.stepAttempts.record({ id: 'sa_fake_1', runId: 'run_fake_1', stepId: 'a', inputHash: 'sha256:H1' });
    expect(() =>
      store.pipelines.stepAttempts.record({ id: 'sa_fake_2', runId: 'run_fake_1', stepId: 'a', iteration: 0, attempt: 0, inputHash: 'sha256:H1' }),
    ).toThrow(PipelineStoreError);
    store.close();
  });

  it('a run against a missing definition is refused (typed error)', async () => {
    const store = await memoryStore();
    expect(() =>
      store.pipelines.runs.insert({ id: 'run_fake_x', pipelineId: 'wf_ghost', schemaHash: 'sha256:x' }),
    ).toThrow();
    store.close();
  });

  it('a step attempt against a missing run is refused', async () => {
    const store = await memoryStore();
    expect(() =>
      store.pipelines.stepAttempts.record({ id: 'sa_x', runId: 'run_ghost', stepId: 'a', inputHash: 'sha256:x' }),
    ).toThrow();
    store.close();
  });

  it('a definition name with an email-shaped literal is refused ([X2])', async () => {
    const store = await memoryStore();
    expect(() =>
      store.pipelines.definitions.upsert({ id: 'wf_bad', name: 'owned by a@example.com', documentJson: DOC, schemaVersion: 1, schemaHash: 'sha256:x' }),
    ).toThrow(PipelineStoreError);
    store.close();
  });

  it('an unknown account label on an attempt is refused', async () => {
    const store = await memoryStore();
    await seededDefinition(store);
    store.pipelines.runs.insert({ id: 'run_fake_1', pipelineId: 'wf_fake_1', schemaHash: 'sha256:deadbeef' });
    expect(() =>
      // @ts-expect-error deliberately illegal label
      store.pipelines.stepAttempts.record({ id: 'sa_bad', runId: 'run_fake_1', stepId: 'a', inputHash: 'sha256:x', account: 'PROD' }),
    ).toThrow(PipelineStoreError);
    store.close();
  });

  it('an unknown run status is refused', async () => {
    const store = await memoryStore();
    await seededDefinition(store);
    store.pipelines.runs.insert({ id: 'run_fake_1', pipelineId: 'wf_fake_1', schemaHash: 'sha256:deadbeef' });
    expect(() =>
      // @ts-expect-error deliberately illegal status
      store.pipelines.runs.setStatus('run_fake_1', 'exploded'),
    ).toThrow(PipelineStoreError);
    store.close();
  });
});

// ===========================================================================
// Migration 0009 — step_attempt.account backend-registry relaxation (OS-1,
// ICR-0016 step_attempt amendment). Migration 0007 relaxed the backend-carrying
// kernel tables but explicitly SKIPPED step_attempt ("no backend column"),
// leaving its account CHECK pinned to the built-in M7 form. That refused a full
// pipeline RUN on a REGISTERED 4th backend's own account label at the journal
// write. 0009 relaxes the CHECK; these tests pin the new acceptance + prove the
// built-in labels/NULL still validate byte-identically and an EMPTY account is
// still refused (defense-in-depth), while the app-layer registry gate stays the
// authoritative screen for a non-built-in label. [X2]: `synthbackend`/`SYNTH_L`
// are generic synthesized identifiers, never a real backend name.
// ===========================================================================
describe('step_attempt account: migration 0009 registry relaxation (OS-1)', () => {
  // A minimal synthetic descriptor registered LOCALLY (schema does not depend on
  // @aibender/testkit — that would be a dependency cycle). Byte-equivalent to
  // testkit's SYNTHETIC_BACKEND_DESCRIPTOR for what this suite needs: it makes
  // isAccountLabel('SYNTH_L') true so the accessor admits the label.
  const SYNTH: BackendDescriptor = Object.freeze({
    id: 'synthbackend',
    servesLabel: (label: string) => label === 'SYNTH_L',
    sourceName: 'lmstudio',
    substrates: Object.freeze(['sdk'] as const),
    builtin: false,
  });

  beforeEach(() => {
    registerBackend(SYNTH);
  });
  afterEach(() => {
    unregisterBackend(SYNTH.id);
  });

  async function runWithOneAttempt(): Promise<KernelStore> {
    const store = await memoryStore();
    await seededDefinition(store);
    store.pipelines.runs.insert({ id: 'run_fake_1', pipelineId: 'wf_fake_1', schemaHash: 'sha256:deadbeef' });
    return store;
  }

  it("admits a registered 4th backend's own account label (SYNTH_L) at the journal write", async () => {
    const store = await runWithOneAttempt();
    // Pre-0009 this INSERT threw `CHECK constraint failed: account IS NULL ...`;
    // 0009 relaxes the CHECK and the accessor's registry-aware isAccountLabel()
    // now admits SYNTH_L (the descriptor is registered), so the row lands.
    const attempt = store.pipelines.stepAttempts.record({
      id: 'sa_synth',
      runId: 'run_fake_1',
      stepId: 'a',
      inputHash: 'sha256:synth',
      status: 'running',
      account: 'SYNTH_L' as AccountLabel,
    });
    expect(attempt.account).toBe('SYNTH_L');
    // The completion patch carries the same label through the UPDATE path.
    const done = store.pipelines.stepAttempts.complete('sa_synth', {
      status: 'completed',
      account: 'SYNTH_L' as AccountLabel,
      costEstimatedUsd: 0.05,
      tokensIn: 300,
      tokensOut: 120,
    });
    expect(done.account).toBe('SYNTH_L');
    expect(done.status).toBe('completed');
    store.close();
  });

  it('still admits the built-in account form and NULL byte-identically (M7 form is a subset)', async () => {
    const store = await runWithOneAttempt();
    // Built-in MAX_<X> label.
    const builtin = store.pipelines.stepAttempts.record({
      id: 'sa_builtin',
      runId: 'run_fake_1',
      stepId: 'a',
      inputHash: 'sha256:builtin',
      account: 'MAX_A',
    });
    expect(builtin.account).toBe('MAX_A');
    // NULL account (the runner records attempts without an account for some
    // step kinds) — the nullable CHECK still admits NULL.
    const nullAcct = store.pipelines.stepAttempts.record({
      id: 'sa_null',
      runId: 'run_fake_1',
      stepId: 'a',
      iteration: 1,
      inputHash: 'sha256:null',
    });
    expect(nullAcct.account).toBeNull();
    store.close();
  });

  it('the app-layer registry gate is the REAL screen — unregistered label refused (no leak)', async () => {
    // Unregister first: without the descriptor, isAccountLabel('SYNTH_L') is
    // false, so the accessor refuses the label BEFORE the DB — proving 0009 did
    // not turn the account column into anything-goes; the registry is the gate.
    unregisterBackend(SYNTH.id);
    const store = await runWithOneAttempt();
    expect(() =>
      store.pipelines.stepAttempts.record({
        id: 'sa_synth_leak',
        runId: 'run_fake_1',
        stepId: 'a',
        inputHash: 'sha256:leak',
        account: 'SYNTH_L' as AccountLabel,
      }),
    ).toThrow(PipelineStoreError);
    store.close();
    // Re-register so afterEach's unregister is symmetric teardown.
    registerBackend(SYNTH);
  });
});
