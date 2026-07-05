/**
 * The compose-ready pipeline slice (BE-8) — proves the wire fan-out
 * (ws-protocol.md §18.1): every payload the slice publishes (run/step status,
 * catalog snapshot) passes the FROZEN `validatePipelineServerPayload`. This is
 * the broker-producer discipline (the workstream publisher precedent): a
 * producer emits only registered, valid kinds.
 */

import { describe, expect, it } from 'vitest';

import type { DagDocument, PipelineServerPayload } from '@aibender/protocol';
import { validatePipelineServerPayload } from '@aibender/protocol';
import { openKernelStore } from '@aibender/schema';

import { createMemoryCatalogFs, scanCatalog } from './catalog/index.js';
import { createPipelineSlice } from './slice.js';
import { FakeStepExecutor } from './testSupport.js';

const NOW = 1_700_000_000_000;
const noSleep = (): Promise<void> => Promise.resolve();

describe('createPipelineSlice — wire fan-out is all-valid', () => {
  it('every published run/step status payload passes the frozen validator', async () => {
    const store = await openKernelStore({ path: ':memory:' });
    const published: PipelineServerPayload[] = [];
    const slice = createPipelineSlice({
      store: store.pipelines,
      executor: new FakeStepExecutor({ steps: { a: { costEstimatedUsd: 0.1, tokensIn: 10, tokensOut: 5 } } }),
      publish: (p) => published.push(p),
      nowMs: () => NOW,
      sleep: noSleep,
    });

    const document: DagDocument = {
      schemaVersion: 1,
      id: 'wf_wire',
      name: 'wf_wire',
      defaults: { account: 'MAX_A' },
      steps: [{ kind: 'prompt', id: 'a', prompt: 'x' }],
    };
    const { done } = slice.engine.launch({ document });
    await done;

    expect(published.length).toBeGreaterThan(0);
    // Every payload is a registered, valid pipelines-server payload [X2].
    for (const payload of published) {
      const result = validatePipelineServerPayload(payload);
      expect(result.ok, `invalid payload: ${JSON.stringify(payload)}`).toBe(true);
    }
    // The run reached a terminal run-status, and the step a step-status.
    expect(published.some((p) => p.kind === 'pipeline-run-status')).toBe(true);
    expect(published.some((p) => p.kind === 'pipeline-step-status')).toBe(true);
    store.close();
  });

  it('publishCatalogSnapshot fans out a valid catalog-snapshot', async () => {
    const store = await openKernelStore({ path: ':memory:' });
    const published: PipelineServerPayload[] = [];
    const slice = createPipelineSlice({
      store: store.pipelines,
      executor: new FakeStepExecutor(),
      publish: (p) => published.push(p),
      nowMs: () => NOW,
    });

    const fs = createMemoryCatalogFs({
      '/cfg/max_a/skills/deploy/SKILL.md': ['---', 'name: deploy', 'description: d', '---', 'b'].join('\n'),
    });
    const scan = await scanCatalog({
      fs,
      accounts: [{ account: 'MAX_A', configDir: '/cfg/max_a' }],
      nowMs: () => NOW,
    });
    slice.publishCatalogSnapshot(scan);

    const snapshot = published.find((p) => p.kind === 'catalog-snapshot');
    expect(snapshot).toBeDefined();
    expect(validatePipelineServerPayload(snapshot!).ok).toBe(true);
    store.close();
  });

  it('a memoized resume publishes the `memoized` step state (the resume affordance)', async () => {
    const store = await openKernelStore({ path: ':memory:' });
    const published: PipelineServerPayload[] = [];
    const slice = createPipelineSlice({
      store: store.pipelines,
      executor: new FakeStepExecutor({ steps: { a: { output: { v: 1 } } } }),
      publish: (p) => published.push(p),
      nowMs: () => NOW,
      sleep: noSleep,
    });
    const document: DagDocument = {
      schemaVersion: 1,
      id: 'wf_memo_wire',
      name: 'wf_memo_wire',
      defaults: { account: 'MAX_A' },
      steps: [{ kind: 'prompt', id: 'a', prompt: 'x' }],
    };
    const first = slice.engine.launch({ document });
    await first.done;
    published.length = 0; // clear
    // Resume → the completed step is a cache hit → published `memoized`.
    await slice.engine.resume(first.runId).done;
    const stepStates = published.filter(
      (p): p is Extract<PipelineServerPayload, { kind: 'pipeline-step-status' }> =>
        p.kind === 'pipeline-step-status',
    );
    expect(stepStates.some((p) => p.state === 'memoized')).toBe(true);
    store.close();
  });
});
