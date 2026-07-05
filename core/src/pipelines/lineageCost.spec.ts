/**
 * Lineage + cost integration (BE-8; dag-schema.md §6, ws-protocol.md §18.5,
 * plan §8.2 M5 DoD "every step visible as a session_node with workflow edges;
 * per-step cost visible in the run monitor from the events store").
 *
 * Real @aibender/schema stores (KERNEL lineage + collector events). Proves:
 *   - each step attempt = a `session_node` (origin harness, recorded);
 *   - `workflow` `session_edge`s connect a step's node to its successors';
 *   - per-step cost lands in the events store via the (backend, raw_ref) key
 *     `pipeline:<runId>:<stepId>:<iteration>` (retry-safe dedupe);
 *   - node/edge upserts fan out through the shared workstream publisher.
 */

import { describe, expect, it } from 'vitest';

import type { DagDocument } from '@aibender/protocol';
import { openEventsStore, openKernelStore } from '@aibender/schema';
import type { WorkstreamServerPayload } from '@aibender/protocol';

import { createPipelineEngine } from './engine.js';
import { createPipelineLineageCost } from './lineageCost.js';
import { FakeStepExecutor } from './testSupport.js';

const NOW = 1_700_000_000_000;
const noSleep = (): Promise<void> => Promise.resolve();

describe('lineage + cost — a two-step run records nodes, edges, and cost', () => {
  it('registers a session_node per step and a workflow edge between them', async () => {
    const kernel = await openKernelStore({ path: ':memory:' });
    const events = await openEventsStore({ path: ':memory:' });
    const published: WorkstreamServerPayload[] = [];

    const lineageCost = createPipelineLineageCost({
      lineage: kernel.lineage,
      events: events.events,
      publish: (p) => published.push(p),
      nowMs: () => NOW,
    });

    const document: DagDocument = {
      schemaVersion: 1,
      id: 'wf_lc',
      name: 'wf_lc',
      defaults: { account: 'MAX_A' },
      steps: [
        { kind: 'prompt', id: 'research', prompt: 'research' },
        { kind: 'prompt', id: 'synth', needs: ['research'], prompt: 'synthesize' },
      ],
    };

    const engine = createPipelineEngine({
      store: kernel.pipelines,
      executor: new FakeStepExecutor({
        steps: {
          research: { costEstimatedUsd: 0.12, tokensIn: 100, tokensOut: 50 },
          synth: { costEstimatedUsd: 0.34, tokensIn: 200, tokensOut: 80 },
        },
      }),
      lineageCost,
      nowMs: () => NOW,
      sleep: noSleep,
    });

    const { done } = engine.launch({ document });
    const result = await done;
    expect(result.outcome).toBe('completed');

    // -- lineage: one node per step, a workflow edge research → synth ----------
    const nodes = kernel.lineage.nodes.list();
    expect(nodes.length).toBe(2);
    expect(nodes.every((n) => n.origin === 'harness' && n.confidence === 'recorded')).toBe(true);
    const workflowEdges = kernel.lineage.edges.list({ edgeTypes: ['workflow'] });
    expect(workflowEdges.length).toBe(1);
    const edge = workflowEdges[0]!;
    // The edge metadata carries the run + step provenance (harness ids only).
    expect(edge.metadataJson).toContain('"fromStep":"research"');
    expect(edge.metadataJson).toContain('"toStep":"synth"');
    expect(edge.metadataJson).toContain('"runId"');

    // -- wire: node upserts + the edge append fanned out -----------------------
    expect(published.filter((p) => p.kind === 'workstream-node').length).toBe(2);
    expect(published.filter((p) => p.kind === 'workstream-edge').length).toBe(1);

    // -- cost: one events row per step, keyed pipeline:runId:stepId:iteration --
    const costRows = events.events.list();
    const pipelineRows = costRows.filter((r) => r.eventType === 'pipeline_step');
    expect(pipelineRows.length).toBe(2);
    for (const row of pipelineRows) {
      expect(row.rawRef).toMatch(/^pipeline:run_/);
      expect(row.backend).toBe('claude_code'); // MAX_A → claude_code
    }
    const total = pipelineRows.reduce((s, r) => s + (r.costEstimatedUsd ?? 0), 0);
    expect(total).toBeCloseTo(0.46, 5);

    kernel.close();
    events.close();
  });

  it('a retry re-ingest of the same iteration DEDUPES on (backend, raw_ref)', async () => {
    const events = await openEventsStore({ path: ':memory:' });
    const lineageCost = createPipelineLineageCost({ events: events.events, nowMs: () => NOW });

    const input = {
      runId: 'run_dedupe',
      stepId: 's',
      iteration: 0,
      account: 'MAX_A' as const,
      costEstimatedUsd: 0.1,
      ok: true,
    };
    lineageCost.landCost(input);
    lineageCost.landCost(input); // retry re-ingest of the SAME iteration
    const rows = events.events.list().filter((r) => r.eventType === 'pipeline_step');
    expect(rows.length).toBe(1); // deduped
    events.close();
  });

  it('a distinct iteration is a distinct cost key (forEach fan-out)', async () => {
    const events = await openEventsStore({ path: ':memory:' });
    const lineageCost = createPipelineLineageCost({ events: events.events, nowMs: () => NOW });
    lineageCost.landCost({ runId: 'run_fe', stepId: 's', iteration: 0, account: 'MAX_A', costEstimatedUsd: 0.1, ok: true });
    lineageCost.landCost({ runId: 'run_fe', stepId: 's', iteration: 1, account: 'MAX_A', costEstimatedUsd: 0.2, ok: true });
    const rows = events.events.list().filter((r) => r.eventType === 'pipeline_step');
    expect(rows.length).toBe(2); // distinct iterations → distinct keys
    events.close();
  });

  it('AWS_DEV cost lands on the opencode backend (pairing satisfied)', async () => {
    const events = await openEventsStore({ path: ':memory:' });
    const lineageCost = createPipelineLineageCost({ events: events.events, nowMs: () => NOW });
    lineageCost.landCost({ runId: 'run_aws', stepId: 's', iteration: 0, account: 'AWS_DEV', costEstimatedUsd: 0.5, ok: true });
    const row = events.events.list().find((r) => r.eventType === 'pipeline_step');
    expect(row?.backend).toBe('opencode'); // AWS_DEV → opencode (backendForLabel)
    events.close();
  });

  it('lineage/cost are fire-and-forget: a store failure never throws', async () => {
    // No lineage store, no events store → the methods are safe no-ops.
    const lineageCost = createPipelineLineageCost({ nowMs: () => NOW });
    expect(() =>
      lineageCost.landCost({ runId: 'r', stepId: 's', iteration: 0, account: 'MAX_A', costEstimatedUsd: 1, ok: true }),
    ).not.toThrow();
    expect(lineageCost.registerStepNode({ runId: 'r', stepId: 's', iteration: 0, account: 'MAX_A', ok: true })).toBeUndefined();
    expect(() =>
      lineageCost.recordWorkflowEdge({ runId: 'r', fromStep: 'a', fromNode: 'n1', toStep: 'b', toNode: 'n2' }),
    ).not.toThrow();
  });
});
