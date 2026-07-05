/**
 * Pipelines store (plan §9.2 FE-6): applyBatch upserts runs/steps, re-baselines
 * a run's step set from a snapshot, keeps the catalog monotone on capturedAt,
 * correlates validate/save answers by requestId, and applies a pushed §18.4
 * error immediately. Edge: a run-snapshot after a resume boundary shows the
 * memoized steps as cached (the M5 DoD — settled, not re-animated).
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  catalogEntriesFor,
  pipelinesStore,
  runsInOrder,
  stepKey,
  stepsForRun,
} from './store.ts';
import {
  catalogEntry,
  catalogSnapshot,
  runSnapshot,
  runStatus,
  runStatusEvent,
  stepStatus,
  stepStatusEvent,
} from './specHelpers.ts';

const store = () => pipelinesStore.getState();

afterEach(() => {
  pipelinesStore.getState().reset();
});

describe('catalog snapshot (monotone on capturedAt per scope)', () => {
  it('upserts a snapshot and resolves entries by workspace scope', () => {
    store().applyBatch([
      catalogSnapshot([catalogEntry('cap_1')], { workspace: '/ws/a', capturedAt: 10 }),
    ]);
    expect(catalogEntriesFor(store(), '/ws/a')).toHaveLength(1);
    // Unknown scope falls back to the global bucket (undefined here → empty).
    expect(catalogEntriesFor(store(), '/ws/z')).toHaveLength(0);
  });

  it('a replayed older snapshot never regresses the palette', () => {
    store().applyBatch([catalogSnapshot([catalogEntry('a'), catalogEntry('b')], { capturedAt: 20 })]);
    store().applyBatch([catalogSnapshot([catalogEntry('a')], { capturedAt: 10 })]); // older
    expect(catalogEntriesFor(store(), undefined)).toHaveLength(2);
  });
});

describe('run + step upserts', () => {
  it('run-status upserts keyed on runId, in stable arrival order', () => {
    store().applyBatch([
      runStatusEvent('run_1', 'running'),
      runStatusEvent('run_2', 'pending'),
      runStatusEvent('run_1', 'paused'),
    ]);
    const runs = runsInOrder(store());
    expect(runs.map((r) => r.runId)).toEqual(['run_1', 'run_2']);
    expect(store().runs['run_1']?.state).toBe('paused');
  });

  it('step-status upserts keyed on runId+stepId+iteration+attempt', () => {
    store().applyBatch([
      stepStatusEvent('run_1', 'a', 'running'),
      stepStatusEvent('run_1', 'a', 'completed', { costEstimatedUsd: 0.02 }),
      stepStatusEvent('run_1', 'a', 'completed', { iteration: 1 }), // distinct key
    ]);
    const steps = stepsForRun(store(), 'run_1');
    expect(steps).toHaveLength(2);
    expect(store().steps[stepKey('run_1', 'a', 0, 0)]?.state).toBe('completed');
    expect(store().steps[stepKey('run_1', 'a', 0, 0)]?.costEstimatedUsd).toBe(0.02);
  });
});

describe('run snapshot re-baseline (§18.5) — the resume boundary (edge)', () => {
  it('a snapshot re-baselines the run step set; memoized steps read as cached', () => {
    // Pre-resume: a live run with two running steps.
    store().applyBatch([
      runStatusEvent('run_1', 'running'),
      stepStatusEvent('run_1', 'a', 'running'),
      stepStatusEvent('run_1', 'b', 'pending'),
    ]);
    // After broker restart + resume: the snapshot replays settled journal
    // state — a is MEMOIZED (returned from the journal, NOT re-executed).
    store().applyBatch([
      runSnapshot(runStatus('run_1', 'running', { resumable: true }), [
        stepStatus('run_1', 'a', 'memoized', { costEstimatedUsd: 0.01 }),
        stepStatus('run_1', 'b', 'running'),
      ]),
    ]);
    const steps = stepsForRun(store(), 'run_1');
    expect(steps.map((s) => s.state)).toEqual(['memoized', 'running']);
    expect(store().runs['run_1']?.resumable).toBe(true);
  });
});

describe('verb correlation', () => {
  it('a validation-result correlates by requestId', () => {
    store().trackVerb({ requestId: 'req_v', verb: 'pipeline-validate', phase: 'pending' });
    store().applyBatch([
      {
        kind: 'pipeline-validation-result',
        requestId: 'req_v',
        valid: false,
        issueCode: 'cycle',
        issueMessage: 'not a DAG',
        issuePath: 'steps',
      },
    ]);
    const v = store().verbs['req_v'];
    expect(v?.phase).toBe('answered');
    expect(v?.valid).toBe(false);
    expect(v?.issueCode).toBe('cycle');
  });

  it('a saved ack correlates by requestId', () => {
    store().trackVerb({ requestId: 'req_s', verb: 'pipeline-save', phase: 'pending' });
    store().applyBatch([{ kind: 'pipeline-saved', requestId: 'req_s', pipelineId: 'wf_new' }]);
    expect(store().verbs['req_s']?.pipelineId).toBe('wf_new');
  });

  it('a pushed §18.4 error flips a pending verb to failed', () => {
    store().trackVerb({ requestId: 'req_l', verb: 'pipeline-launch', phase: 'pending' });
    store().applyVerbError('req_l', 'pipeline-not-found');
    expect(store().verbs['req_l']?.phase).toBe('failed');
    expect(store().verbs['req_l']?.code).toBe('pipeline-not-found');
  });

  it('a stale error after an answer is ignored', () => {
    store().applyBatch([{ kind: 'pipeline-saved', requestId: 'req_a', pipelineId: 'wf_a' }]);
    store().applyVerbError('req_a', 'internal');
    expect(store().verbs['req_a']?.phase).toBe('answered');
  });
});

describe('applyBatch discipline', () => {
  it('an empty batch is a no-op (no store notification)', () => {
    let notified = 0;
    const unsub = pipelinesStore.subscribe(() => {
      notified += 1;
    });
    store().applyBatch([]);
    unsub();
    expect(notified).toBe(0);
  });
});
