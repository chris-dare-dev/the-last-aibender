/**
 * The pipeline ENGINE (BE-8) — the frozen `pipelines` verb handling (§18.2)
 * + the §18.4 error contract, plan-time capability resolution / drift, and
 * the run lifecycle (launch/pause/resume/cancel). Plan §9.2: cycle at plan
 * time, unresolved capability fails plan, budget breach aborts, contentHash
 * drift detected and surfaced.
 */

import { describe, expect, it } from 'vitest';

import type { DagDocument } from '@aibender/protocol';
import { openKernelStore, type KernelStore } from '@aibender/schema';

import type { CatalogRecord } from './catalog/index.js';
import { createPipelineEngine, PipelineEngineError } from './engine.js';
import { resolverFromRecords } from './planner.js';
import { FakeStepExecutor } from './testSupport.js';

const NOW = 1_700_000_000_000;
const noSleep = (): Promise<void> => Promise.resolve();

async function memStore(): Promise<KernelStore> {
  return openKernelStore({ path: ':memory:' });
}

function promptDoc(id: string): DagDocument {
  return { schemaVersion: 1, id, name: id, steps: [{ kind: 'prompt', id: 'a', prompt: 'x' }] };
}

function catalogRecord(over: Partial<CatalogRecord>): CatalogRecord {
  return {
    capId: 'cap_x',
    kind: 'skill',
    name: 'reviewer',
    scope: 'project',
    backendFamily: 'claude',
    sourcePath: '/ws/.claude/skills/reviewer/SKILL.md',
    contentHash: 'sha256:aaa',
    ...over,
  };
}

describe('engine — validate/save (positive + §18.4)', () => {
  it('validate answers valid for a well-formed document', async () => {
    const store = await memStore();
    const engine = createPipelineEngine({ store: store.pipelines, executor: new FakeStepExecutor() });
    expect(engine.validate(promptDoc('wf_v')).valid).toBe(true);
    store.close();
  });

  it('validate answers invalid with the frozen issue class (not an error)', async () => {
    const store = await memStore();
    const engine = createPipelineEngine({ store: store.pipelines, executor: new FakeStepExecutor() });
    const outcome = engine.validate({ schemaVersion: 2, id: 'x', name: 'x', steps: [] });
    expect(outcome.valid).toBe(false);
    expect(outcome.issueCode).toBe('unsupported-version');
    store.close();
  });

  it('save persists a definition and returns its id', async () => {
    const store = await memStore();
    const engine = createPipelineEngine({ store: store.pipelines, executor: new FakeStepExecutor() });
    const { pipelineId } = engine.save(promptDoc('wf_save'));
    expect(pipelineId).toBe('wf_save');
    expect(store.pipelines.definitions.get('wf_save')).toBeDefined();
    store.close();
  });
});

describe('engine — launch error contract (§18.4)', () => {
  it('pipeline-not-found for an unknown pipelineId', async () => {
    const store = await memStore();
    const engine = createPipelineEngine({ store: store.pipelines, executor: new FakeStepExecutor() });
    expect(() => engine.launch({ pipelineId: 'wf_missing' })).toThrowError(PipelineEngineError);
    try {
      engine.launch({ pipelineId: 'wf_missing' });
    } catch (e) {
      expect((e as PipelineEngineError).code).toBe('pipeline-not-found');
    }
    store.close();
  });

  it('pipeline-run-not-found for pause/resume/cancel of an unknown run', async () => {
    const store = await memStore();
    const engine = createPipelineEngine({ store: store.pipelines, executor: new FakeStepExecutor() });
    for (const op of [() => engine.pause('run_x'), () => engine.resume('run_x'), () => engine.cancel('run_x')]) {
      try {
        op();
        expect.unreachable('should throw');
      } catch (e) {
        expect((e as PipelineEngineError).code).toBe('pipeline-run-not-found');
      }
    }
    store.close();
  });
});

describe('engine — plan-time capability resolution (negative)', () => {
  it('unresolved capability ref fails the plan (pipeline-invalid, run never starts)', async () => {
    const store = await memStore();
    const document: DagDocument = {
      schemaVersion: 1,
      id: 'wf_cap',
      name: 'wf_cap',
      steps: [{ kind: 'agent', id: 'a', agent: { name: 'ghost' }, prompt: 'do' }],
    };
    // A resolver that knows nothing.
    const engine = createPipelineEngine({
      store: store.pipelines,
      executor: new FakeStepExecutor(),
      resolver: resolverFromRecords([]),
    });
    try {
      engine.launch({ document });
      expect.unreachable('should throw');
    } catch (e) {
      expect((e as PipelineEngineError).code).toBe('pipeline-invalid');
      expect((e as PipelineEngineError).validation?.issueCode).toBe('unresolved-capability');
    }
    // No run row was created.
    expect(store.pipelines.runs.list()).toHaveLength(0);
    store.close();
  });

  it('resolves a skill against the catalog and runs (positive)', async () => {
    const store = await memStore();
    const document: DagDocument = {
      schemaVersion: 1,
      id: 'wf_ok',
      name: 'wf_ok',
      steps: [{ kind: 'skill', id: 'a', skill: { name: 'reviewer' } }],
    };
    const engine = createPipelineEngine({
      store: store.pipelines,
      executor: new FakeStepExecutor(),
      resolver: resolverFromRecords([catalogRecord({})]),
      nowMs: () => NOW,
      sleep: noSleep,
    });
    const { done } = engine.launch({ document });
    const result = await done;
    expect(result.outcome).toBe('completed');
    store.close();
  });
});

describe('engine — resume + contentHash drift (edge, DoD)', () => {
  it('drift between plan and run discards the memoized output and re-executes', async () => {
    const store = await memStore();
    const document: DagDocument = {
      schemaVersion: 1,
      id: 'wf_drift',
      name: 'wf_drift',
      steps: [{ kind: 'skill', id: 'a', skill: { name: 'reviewer' } }],
    };

    // First run: resolve reviewer@sha256:aaa, execute, journal.
    const resolverV1 = resolverFromRecords([catalogRecord({ contentHash: 'sha256:aaa' })]);
    const engine1 = createPipelineEngine({
      store: store.pipelines,
      executor: new FakeStepExecutor({ steps: { a: { output: { v: 1 } } } }),
      resolver: resolverV1,
      nowMs: () => NOW,
      sleep: noSleep,
    });
    const { runId, done } = engine1.launch({ document });
    await done;

    // The reviewer source CHANGED (new contentHash) — a resume must detect
    // drift and re-execute step `a` (its journal is stale).
    const resolverV2 = resolverFromRecords([catalogRecord({ contentHash: 'sha256:bbb' })]);
    const exec2 = new FakeStepExecutor({ steps: { a: { output: { v: 2 } } } });
    const engine2 = createPipelineEngine({
      store: store.pipelines,
      executor: exec2,
      resolver: resolverV2,
      nowMs: () => NOW,
      sleep: noSleep,
    });
    const resumed = engine2.resume(runId);
    await resumed.done;
    // Drift → NOT a cache hit → the step re-executed.
    expect(exec2.calls.filter((c) => c.stepId === 'a')).toHaveLength(1);
    store.close();
  });

  it('NO drift → the resume is a cache hit (no re-execution)', async () => {
    const store = await memStore();
    const document: DagDocument = {
      schemaVersion: 1,
      id: 'wf_nodrift',
      name: 'wf_nodrift',
      steps: [{ kind: 'skill', id: 'a', skill: { name: 'reviewer' } }],
    };
    const resolver = resolverFromRecords([catalogRecord({ contentHash: 'sha256:same' })]);
    const engine1 = createPipelineEngine({
      store: store.pipelines,
      executor: new FakeStepExecutor({ steps: { a: { output: { v: 1 } } } }),
      resolver,
      nowMs: () => NOW,
      sleep: noSleep,
    });
    const { runId, done } = engine1.launch({ document });
    await done;

    const exec2 = new FakeStepExecutor({ steps: { a: { output: { v: 2 } } } });
    const engine2 = createPipelineEngine({
      store: store.pipelines,
      executor: exec2,
      resolver, // same hash → no drift
      nowMs: () => NOW,
      sleep: noSleep,
    });
    await engine2.resume(runId).done;
    expect(exec2.calls).toHaveLength(0); // cache hit, never re-executed
    store.close();
  });
});

describe('engine — cycle rejected at plan time (negative)', () => {
  it('a launch of a cyclic inline document is pipeline-invalid before any run', async () => {
    const store = await memStore();
    const engine = createPipelineEngine({ store: store.pipelines, executor: new FakeStepExecutor() });
    // The gateway would already reject this shape, but the engine defends too.
    const cyclic = {
      schemaVersion: 1,
      id: 'wf_cycle',
      name: 'wf_cycle',
      steps: [
        { kind: 'prompt', id: 'a', needs: ['b'], prompt: 'x' },
        { kind: 'prompt', id: 'b', needs: ['a'], prompt: 'y' },
      ],
    } as unknown as DagDocument;
    try {
      engine.launch({ document: cyclic });
      expect.unreachable('should throw');
    } catch (e) {
      expect((e as PipelineEngineError).code).toBe('pipeline-invalid');
      expect((e as PipelineEngineError).validation?.issueCode).toBe('cycle');
    }
    expect(store.pipelines.runs.list()).toHaveLength(0);
    store.close();
  });
});
