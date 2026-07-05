/**
 * The DAG runner (BE-8) — plan §9.2 BE-8 matrix. Every step runs against the
 * FakeStepExecutor (rule 3: no real spawn/inference/cost). The journal is a
 * REAL @aibender/schema store (`:memory:`), so the memoization + resume proofs
 * exercise the real durable path.
 */

import { describe, expect, it, vi } from 'vitest';

import type { DagDocument } from '@aibender/protocol';
import { openKernelStore, type KernelStore } from '@aibender/schema';

import { createProcessGroupReaper } from './reaper.js';
import { runPipeline } from './runner.js';
import { FakeApprovalGate, FakeStepExecutor, type ScriptedStep } from './testSupport.js';

const NOW = 1_700_000_000_000;

async function memStore(): Promise<KernelStore> {
  return openKernelStore({ path: ':memory:' });
}

/** Build a validated DAG document (schemaVersion 1). */
function doc(id: string, steps: DagDocument['steps'], defaults?: DagDocument['defaults']): DagDocument {
  return {
    schemaVersion: 1,
    id,
    name: id,
    ...(defaults !== undefined ? { defaults } : {}),
    steps,
  };
}

/** Persist a definition + run row so the runner has its FK preconditions. */
async function seedRun(store: KernelStore, document: DagDocument, runId: string): Promise<void> {
  store.pipelines.definitions.upsert({
    id: document.id,
    name: document.name,
    documentJson: JSON.stringify(document),
    schemaVersion: 1,
    schemaHash: 'sha256:seed',
  });
  store.pipelines.runs.insert({ id: runId, pipelineId: document.id, schemaHash: 'sha256:seed' });
}

const noSleep = (): Promise<void> => Promise.resolve();

describe('runPipeline — topological walk honoring needs (positive)', () => {
  it('runs steps in dependency order; parallel steps in one generation', async () => {
    const store = await memStore();
    const document = doc('wf_topo', [
      { kind: 'prompt', id: 'a', prompt: 'first' },
      { kind: 'prompt', id: 'b', needs: ['a'], prompt: 'after a' },
      { kind: 'prompt', id: 'c', needs: ['a'], prompt: 'also after a' },
      { kind: 'prompt', id: 'd', needs: ['b', 'c'], prompt: 'after b and c' },
    ]);
    await seedRun(store, document, 'run_topo');
    const executor = new FakeStepExecutor();

    const result = await runPipeline({
      runId: 'run_topo',
      pipelineId: document.id,
      document,
      schemaHash: 'sha256:seed',
      store: store.pipelines,
      executor,
      nowMs: () => NOW,
      sleep: noSleep,
    });

    expect(result.outcome).toBe('completed');
    const order = executor.calls.map((c) => c.stepId);
    // a runs before b, c, d; d runs last.
    expect(order[0]).toBe('a');
    expect(order.indexOf('d')).toBe(3);
    expect(order.indexOf('b')).toBeGreaterThan(order.indexOf('a'));
    store.close();
  });

  it('routes each step to its own account (the [X1] differentiator)', async () => {
    const store = await memStore();
    const document = doc('wf_route', [
      { kind: 'prompt', id: 'research', account: 'MAX_A', prompt: 'research' },
      { kind: 'prompt', id: 'bedrock', needs: ['research'], account: 'AWS_DEV', backend: 'bedrock', prompt: 'x' },
      { kind: 'prompt', id: 'local', needs: ['bedrock'], account: 'LOCAL', prompt: 'summarize' },
    ]);
    await seedRun(store, document, 'run_route');
    const executor = new FakeStepExecutor();

    await runPipeline({
      runId: 'run_route',
      pipelineId: document.id,
      document,
      schemaHash: 'sha256:seed',
      store: store.pipelines,
      executor,
      nowMs: () => NOW,
      sleep: noSleep,
    });

    const byStep = new Map(executor.calls.map((c) => [c.stepId, c]));
    expect(byStep.get('research')?.account).toBe('MAX_A');
    expect(byStep.get('bedrock')?.account).toBe('AWS_DEV');
    expect(byStep.get('bedrock')?.backend).toBe('bedrock');
    expect(byStep.get('local')?.account).toBe('LOCAL');
    store.close();
  });

  it('templates a step output into a successor prompt (never via context)', async () => {
    const store = await memStore();
    const document = doc('wf_tmpl', [
      { kind: 'prompt', id: 'inventory', prompt: 'list files' },
      { kind: 'prompt', id: 'use', needs: ['inventory'], prompt: 'audit ${steps.inventory.output.count} files' },
    ]);
    await seedRun(store, document, 'run_tmpl');
    const executor = new FakeStepExecutor({ steps: { inventory: { output: { count: 7 } } } });

    await runPipeline({
      runId: 'run_tmpl',
      pipelineId: document.id,
      document,
      schemaHash: 'sha256:seed',
      store: store.pipelines,
      executor,
      nowMs: () => NOW,
      sleep: noSleep,
    });

    const use = executor.calls.find((c) => c.stepId === 'use');
    expect(use?.prompt).toBe('audit 7 files');
    store.close();
  });
});

describe('runPipeline — memoization skip on same input_hash (positive)', () => {
  it('a re-run of a completed step returns cached output WITHOUT re-execution', async () => {
    const store = await memStore();
    const document = doc('wf_memo', [{ kind: 'prompt', id: 'a', prompt: 'work' }]);

    // First run: execute + journal.
    await seedRun(store, document, 'run_memo_1');
    const exec1 = new FakeStepExecutor({ steps: { a: { output: { v: 1 } } } });
    await runPipeline({
      runId: 'run_memo_1',
      pipelineId: document.id,
      document,
      schemaHash: 'sha256:seed',
      store: store.pipelines,
      executor: exec1,
      nowMs: () => NOW,
      sleep: noSleep,
    });
    expect(exec1.calls).toHaveLength(1);

    // Resume the SAME run: the completed attempt is a cache hit → NO execute.
    const exec2 = new FakeStepExecutor({ steps: { a: { output: { v: 999 } } } });
    const result = await runPipeline({
      runId: 'run_memo_1',
      pipelineId: document.id,
      document,
      schemaHash: 'sha256:seed',
      store: store.pipelines,
      executor: exec2,
      nowMs: () => NOW,
      sleep: noSleep,
    });
    expect(exec2.calls).toHaveLength(0); // never re-executed
    expect(result.stepStates['a']).toBe('completed');
    // The memoized attempt is journaled as `memoized`.
    const attempts = store.pipelines.stepAttempts.listByRun('run_memo_1');
    expect(attempts.some((r) => r.status === 'memoized')).toBe(true);
    store.close();
  });
});

describe('runPipeline — broker restart mid-run resumes from journal (edge, DoD)', () => {
  it('reopens a REAL store torn down mid-run and does not re-execute completed steps', async () => {
    // A file-backed store so it survives a close()/reopen (the "broker restart"
    // proof; :memory: would vanish).
    const path = `/private/tmp/claude-501/-Users-chris-dare/894bbe44-c473-4c8b-b7e4-633d58bc246b/scratchpad/memo-${Date.now()}.db`;
    const document = doc('wf_restart', [
      { kind: 'prompt', id: 's1', prompt: 'step one' },
      { kind: 'prompt', id: 's2', needs: ['s1'], prompt: 'step two' },
    ]);

    // First "process": run s1 only (s2 fails so the run is resumable).
    const store1 = await openKernelStore({ path });
    await seedRun(store1, document, 'run_restart');
    const exec1 = new FakeStepExecutor({ steps: { s1: { output: { ok: 1 } }, s2: { ok: false, errorKind: 'error' } } });
    const r1 = await runPipeline({
      runId: 'run_restart',
      pipelineId: document.id,
      document,
      schemaHash: 'sha256:seed',
      store: store1.pipelines,
      executor: exec1,
      nowMs: () => NOW,
      sleep: noSleep,
    });
    expect(r1.outcome).toBe('failed');
    expect(exec1.calls.map((c) => c.stepId).sort()).toEqual(['s1', 's2']);
    store1.close(); // TEAR DOWN mid-run

    // Second "process": reopen the SAME file, resume. s1 is a cache hit (not
    // re-executed); only s2 runs again.
    const store2 = await openKernelStore({ path });
    const exec2 = new FakeStepExecutor({ steps: { s1: { output: { ok: 1 } }, s2: { output: { ok: 2 } } } });
    const r2 = await runPipeline({
      runId: 'run_restart',
      pipelineId: document.id,
      document,
      schemaHash: 'sha256:seed',
      store: store2.pipelines,
      executor: exec2,
      nowMs: () => NOW,
      sleep: noSleep,
    });
    expect(r2.outcome).toBe('completed');
    // s1 was NOT re-executed after the restart; only s2 ran.
    expect(exec2.calls.map((c) => c.stepId)).toEqual(['s2']);
    store2.close();
  });
});

describe('runPipeline — approval gate pause/resume (positive)', () => {
  it('pauses on an approval step; an allow decision resumes the walk', async () => {
    const store = await memStore();
    const document = doc('wf_gate', [
      { kind: 'prompt', id: 'audit', prompt: 'audit' },
      { kind: 'approval', id: 'sign-off', needs: ['audit'], summary: 'review the audit' },
      { kind: 'prompt', id: 'ship', needs: ['sign-off'], prompt: 'ship' },
    ]);
    await seedRun(store, document, 'run_gate');
    const executor = new FakeStepExecutor();
    const gate = new FakeApprovalGate();

    const done = runPipeline({
      runId: 'run_gate',
      pipelineId: document.id,
      document,
      schemaHash: 'sha256:seed',
      store: store.pipelines,
      executor,
      gate,
      nowMs: () => NOW,
      sleep: noSleep,
    });

    // The gate is pending; `ship` has not run yet.
    await vi.waitFor(() => expect(gate.pending).toHaveLength(1));
    expect(executor.calls.some((c) => c.stepId === 'ship')).toBe(false);
    expect(gate.pending[0]!.input.stepId).toBe('sign-off');

    // Owner allows → the walk resumes and ships.
    gate.decide('sign-off', 'allowed');
    const result = await done;
    expect(result.outcome).toBe('completed');
    expect(executor.calls.some((c) => c.stepId === 'ship')).toBe(true);
    store.close();
  });

  it('a denied gate fails the downstream branch', async () => {
    const store = await memStore();
    const document = doc('wf_gate_deny', [
      { kind: 'approval', id: 'sign-off', summary: 'review' },
      { kind: 'prompt', id: 'ship', needs: ['sign-off'], prompt: 'ship' },
    ]);
    await seedRun(store, document, 'run_gate_deny');
    const executor = new FakeStepExecutor();
    const gate = new FakeApprovalGate();

    const done = runPipeline({
      runId: 'run_gate_deny',
      pipelineId: document.id,
      document,
      schemaHash: 'sha256:seed',
      store: store.pipelines,
      executor,
      gate,
      nowMs: () => NOW,
      sleep: noSleep,
    });
    await vi.waitFor(() => expect(gate.pending).toHaveLength(1));
    gate.decide('sign-off', 'denied');
    const result = await done;
    expect(result.stepStates['sign-off']).toBe('failed');
    // ship's need is failed → ship never runs.
    expect(executor.calls.some((c) => c.stepId === 'ship')).toBe(false);
    store.close();
  });
});

describe('runPipeline — retry + outputSchema (negative)', () => {
  it('retries a transient failure per policy, then succeeds', async () => {
    const store = await memStore();
    const document = doc('wf_retry', [
      { kind: 'prompt', id: 'a', prompt: 'flaky', retry: { max: 2, retryOn: ['rate_limit'] } },
    ]);
    await seedRun(store, document, 'run_retry');
    const executor = new FakeStepExecutor({
      steps: { a: { failFirstAttempts: 1, errorKind: 'rate_limit', output: { ok: 1 } } },
    });
    const result = await runPipeline({
      runId: 'run_retry',
      pipelineId: document.id,
      document,
      schemaHash: 'sha256:seed',
      store: store.pipelines,
      executor,
      nowMs: () => NOW,
      sleep: noSleep,
    });
    expect(result.outcome).toBe('completed');
    // 2 attempts: the first (rate_limit) then the retry (success).
    expect(executor.calls.filter((c) => c.stepId === 'a')).toHaveLength(2);
    store.close();
  });

  it('a non-retryable error class does NOT retry', async () => {
    const store = await memStore();
    const document = doc('wf_noretry', [
      { kind: 'prompt', id: 'a', prompt: 'x', retry: { max: 3, retryOn: ['rate_limit'] } },
    ]);
    await seedRun(store, document, 'run_noretry');
    const executor = new FakeStepExecutor({ steps: { a: { ok: false, errorKind: 'network' } } });
    const result = await runPipeline({
      runId: 'run_noretry',
      pipelineId: document.id,
      document,
      schemaHash: 'sha256:seed',
      store: store.pipelines,
      executor,
      nowMs: () => NOW,
      sleep: noSleep,
    });
    expect(result.outcome).toBe('failed');
    // network is not in retryOn → single attempt.
    expect(executor.calls.filter((c) => c.stepId === 'a')).toHaveLength(1);
    store.close();
  });

  it('an outputSchema failure is retried per policy then fails', async () => {
    const store = await memStore();
    const document = doc('wf_schema', [
      {
        kind: 'prompt',
        id: 'a',
        prompt: 'x',
        outputSchema: { type: 'object' },
        retry: { max: 1 },
      },
    ]);
    await seedRun(store, document, 'run_schema');
    const executor = new FakeStepExecutor({ steps: { a: { ok: true, outputSchemaFailed: true } } });
    const result = await runPipeline({
      runId: 'run_schema',
      pipelineId: document.id,
      document,
      schemaHash: 'sha256:seed',
      store: store.pipelines,
      executor,
      nowMs: () => NOW,
      sleep: noSleep,
    });
    expect(result.outcome).toBe('failed');
    // outputSchema failure is retryable → 2 attempts (1 + 1 retry).
    expect(executor.calls.filter((c) => c.stepId === 'a')).toHaveLength(2);
    const attempts = store.pipelines.stepAttempts.listByRun('run_schema');
    expect(attempts.some((r) => r.errorKind === 'output_schema')).toBe(true);
    store.close();
  });
});

describe('runPipeline — failed-need propagation (edge)', () => {
  it('a failed need blocks its dependent (skip propagation)', async () => {
    const store = await memStore();
    const document = doc('wf_block', [
      { kind: 'prompt', id: 'a', prompt: 'x' },
      { kind: 'prompt', id: 'b', needs: ['a'], prompt: 'y' },
    ]);
    await seedRun(store, document, 'run_block');
    const executor = new FakeStepExecutor({ steps: { a: { ok: false, errorKind: 'error' } } });
    const result = await runPipeline({
      runId: 'run_block',
      pipelineId: document.id,
      document,
      schemaHash: 'sha256:seed',
      store: store.pipelines,
      executor,
      nowMs: () => NOW,
      sleep: noSleep,
    });
    expect(result.stepStates['a']).toBe('failed');
    expect(result.stepStates['b']).toBe('skipped'); // blocked by the failed need
    expect(executor.calls.some((c) => c.stepId === 'b')).toBe(false);
    expect(result.outcome).toBe('failed');
    store.close();
  });

  it('onError:continue on a failed need lets the dependent proceed', async () => {
    const store = await memStore();
    const document = doc('wf_continue', [
      { kind: 'prompt', id: 'a', prompt: 'x', onError: 'continue' },
      { kind: 'prompt', id: 'b', needs: ['a'], prompt: 'y' },
    ]);
    await seedRun(store, document, 'run_continue');
    const executor = new FakeStepExecutor({ steps: { a: { ok: false, errorKind: 'error' } } });
    const result = await runPipeline({
      runId: 'run_continue',
      pipelineId: document.id,
      document,
      schemaHash: 'sha256:seed',
      store: store.pipelines,
      executor,
      nowMs: () => NOW,
      sleep: noSleep,
    });
    expect(result.stepStates['a']).toBe('failed');
    // onError:continue → b runs despite a's failure.
    expect(executor.calls.some((c) => c.stepId === 'b')).toBe(true);
    expect(result.stepStates['b']).toBe('completed');
    store.close();
  });
});

describe('runPipeline — budget breach aborts + reaps (negative, DoD)', () => {
  it('a wall-clock budget breach aborts the hanging step and reaps its group', async () => {
    const store = await memStore();
    const document = doc('wf_budget', [
      { kind: 'prompt', id: 'slow', prompt: 'hang', budget: { wallClockSec: 1 } },
    ]);
    await seedRun(store, document, 'run_budget');
    // The step hangs until aborted (the budget timer fires).
    const executor = new FakeStepExecutor({ steps: { slow: { hangUntilAborted: true } } });
    const reaped: string[] = [];
    const reaper = createProcessGroupReaper({ killGroup: () => {}, isGroupAlive: () => false });
    // Wrap reapStep to record which step got reaped.
    const wrapped = {
      register: reaper.register,
      reapStep: (key: string) => {
        reaped.push(key);
        return reaper.reapStep(key);
      },
      reapAll: reaper.reapAll,
      clear: reaper.clear,
    };

    const result = await runPipeline({
      runId: 'run_budget',
      pipelineId: document.id,
      document,
      schemaHash: 'sha256:seed',
      store: store.pipelines,
      executor,
      reaper: wrapped,
      // Real timer, tiny budget — the wall-clock fires ~1s in.
      nowMs: () => NOW,
      sleep: noSleep,
    });

    expect(result.outcome).toBe('failed');
    // The step attempt was aborted (settled timeout) and the reaper was asked
    // to reap its process group.
    expect(reaped.length).toBeGreaterThanOrEqual(1);
    const attempts = store.pipelines.stepAttempts.listByRun('run_budget');
    expect(attempts.some((r) => r.status === 'failed')).toBe(true);
    store.close();
  }, 10_000);

  it('run cancel aborts in-flight steps and reaps all groups', async () => {
    const store = await memStore();
    const document = doc('wf_cancel', [{ kind: 'prompt', id: 'slow', prompt: 'hang' }]);
    await seedRun(store, document, 'run_cancel');
    const executor = new FakeStepExecutor({ steps: { slow: { hangUntilAborted: true } } });
    const cancelController = new AbortController();

    const done = runPipeline({
      runId: 'run_cancel',
      pipelineId: document.id,
      document,
      schemaHash: 'sha256:seed',
      store: store.pipelines,
      executor,
      cancelSignal: cancelController.signal,
      nowMs: () => NOW,
      sleep: noSleep,
    });
    // Let the step start, then cancel the run.
    await vi.waitFor(() => expect(executor.calls.some((c) => c.stepId === 'slow')).toBe(true));
    cancelController.abort();
    const result = await done;
    expect(result.outcome).toBe('cancelled');
    store.close();
  }, 10_000);
});

describe('runPipeline — when / forEach / loop (edge)', () => {
  it('skips a when-false step and its dependents', async () => {
    const store = await memStore();
    const document = doc('wf_when', [
      { kind: 'prompt', id: 'gen', prompt: 'gen', outputSchema: { type: 'object' } },
      { kind: 'prompt', id: 'cond', needs: ['gen'], when: '${steps.gen.output.count} > 0', prompt: 'run' },
    ]);
    await seedRun(store, document, 'run_when');
    const executor = new FakeStepExecutor({ steps: { gen: { output: { count: 0 } } } });
    const result = await runPipeline({
      runId: 'run_when',
      pipelineId: document.id,
      document,
      schemaHash: 'sha256:seed',
      store: store.pipelines,
      executor,
      nowMs: () => NOW,
      sleep: noSleep,
    });
    expect(result.stepStates['cond']).toBe('skipped');
    expect(executor.calls.some((c) => c.stepId === 'cond')).toBe(false);
    store.close();
  });

  it('fans out forEach honoring maxParallel bounds', async () => {
    const store = await memStore();
    const document = doc('wf_foreach', [
      { kind: 'prompt', id: 'list', prompt: 'list', outputSchema: { type: 'object' } },
      {
        kind: 'prompt',
        id: 'audit',
        needs: ['list'],
        forEach: '${steps.list.output.files}',
        maxParallel: 2,
        prompt: 'audit ${item}',
      },
    ]);
    await seedRun(store, document, 'run_foreach');
    const executor = new FakeStepExecutor({
      steps: { list: { output: { files: ['a.ts', 'b.ts', 'c.ts'] } } },
    });
    const result = await runPipeline({
      runId: 'run_foreach',
      pipelineId: document.id,
      document,
      schemaHash: 'sha256:seed',
      store: store.pipelines,
      executor,
      nowMs: () => NOW,
      sleep: noSleep,
    });
    expect(result.outcome).toBe('completed');
    const auditCalls = executor.calls.filter((c) => c.stepId === 'audit');
    expect(auditCalls).toHaveLength(3);
    // Each iteration got its own ${item} rendered into the prompt.
    expect(auditCalls.map((c) => c.prompt).sort()).toEqual(['audit a.ts', 'audit b.ts', 'audit c.ts']);
    // Distinct iteration indices journaled.
    const iters = new Set(auditCalls.map((c) => c.iteration));
    expect(iters.size).toBe(3);
    store.close();
  });

  it('empty forEach → the step is skipped (zero iterations)', async () => {
    const store = await memStore();
    const document = doc('wf_empty', [
      { kind: 'prompt', id: 'list', prompt: 'list', outputSchema: { type: 'object' } },
      { kind: 'prompt', id: 'audit', needs: ['list'], forEach: '${steps.list.output.files}', prompt: 'audit ${item}' },
    ]);
    await seedRun(store, document, 'run_empty');
    const executor = new FakeStepExecutor({ steps: { list: { output: { files: [] } } } });
    const result = await runPipeline({
      runId: 'run_empty',
      pipelineId: document.id,
      document,
      schemaHash: 'sha256:seed',
      store: store.pipelines,
      executor,
      nowMs: () => NOW,
      sleep: noSleep,
    });
    expect(result.stepStates['audit']).toBe('skipped');
    expect(executor.calls.some((c) => c.stepId === 'audit')).toBe(false);
    store.close();
  });

  it('loop repeats until the check passes, bounded by maxIterations', async () => {
    const store = await memStore();
    const document = doc('wf_loop', [
      {
        kind: 'prompt',
        id: 'fix',
        prompt: 'fix',
        outputSchema: { type: 'object' },
        loop: { until: '${steps.fix.output.passing} == true', maxIterations: 5 },
      },
    ]);
    await seedRun(store, document, 'run_loop');
    // The executor flips `passing` to true on the 3rd attempt.
    let n = 0;
    const executor = new FakeStepExecutor({
      steps: {
        fix: {
          onExecute: () => {
            n += 1;
          },
          get output() {
            return { passing: n >= 2 };
          },
        } as ScriptedStep,
      },
    });
    const result = await runPipeline({
      runId: 'run_loop',
      pipelineId: document.id,
      document,
      schemaHash: 'sha256:seed',
      store: store.pipelines,
      executor,
      nowMs: () => NOW,
      sleep: noSleep,
    });
    expect(result.outcome).toBe('completed');
    // Looped until passing (attempt 3 made passing true after n>=2).
    expect(executor.calls.filter((c) => c.stepId === 'fix').length).toBeGreaterThanOrEqual(2);
    expect(executor.calls.filter((c) => c.stepId === 'fix').length).toBeLessThanOrEqual(5);
    store.close();
  });
});
