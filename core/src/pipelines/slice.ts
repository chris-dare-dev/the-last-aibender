/**
 * The compose-ready pipeline slice (BE-8; mirrors the M4
 * `createWorkstreamSlice`). core/src/main/ injects it exactly like the
 * workstream slice: one journal store, one executor, one publisher — the
 * narrow composeBroker wiring recorded there (BE-ORCH reviews).
 *
 * The slice assembles:
 *   - the lineage/cost recorder over the SAME kernel lineage store + collector
 *     events store the run's `session_node`s / cost rows live in;
 *   - the process-group reaper (budget breach / cancel);
 *   - the wire STATUS PUBLISHER adapter — the runner's structural
 *     `PipelineStatusPublisher` → the frozen `pipeline-run-status` /
 *     `pipeline-step-status` payloads through the gateway's `publishPipeline`;
 *   - the ENGINE (the gateway-facing verb handler = the PipelineEnginePort).
 *
 * It also exposes `publishCatalogSnapshot` so the composition root can push the
 * builder palette on boot / on FSEvents change (§18.1 `catalog-snapshot`).
 */

import type { PipelineServerPayload } from '@aibender/protocol';
import type { EventsTableStore, LineageStore, PipelinesStore } from '@aibender/schema';
import type { Logger } from '@aibender/shared';

import { scanResultToSnapshot, type CatalogScanResult } from './catalog/index.js';
import { createPipelineEngine, type PipelineEnginePort } from './engine.js';
import type { StepExecutor } from './executor.js';
import type { PipelineApprovalGate } from './gate.js';
import { createPipelineLineageCost } from './lineageCost.js';
import type { CatalogResolver } from './planner.js';
import { createProcessGroupReaper, type ProcessGroupReaper } from './reaper.js';
import type { WorkstreamPublisher } from '../workstreams/index.js';
import type {
  PipelineRunStatusUpdate,
  PipelineStatusPublisher,
  PipelineStepStatusUpdate,
} from './runner.js';

/** The gateway `publishPipeline` binding (the ICR-0012 seam). */
export type PipelinePublisher = (payload: PipelineServerPayload) => void;

export interface PipelineSliceOptions {
  /** THE durable memoization journal + defs/runs (migration 0004, KERNEL db). */
  readonly store: PipelinesStore;
  /** Per-step account routing seam — composed over the real adapters at runtime. */
  readonly executor: StepExecutor;
  /** Plan-time capability resolver (from a catalog scan). Absent → prompt-only. */
  readonly resolver?: CatalogResolver;
  /** The approval-gate port (BE-2 broker `request` adapter). */
  readonly gate?: PipelineApprovalGate;
  /** The KERNEL lineage store — step-attempt `workflow` edges (dag-schema §6). */
  readonly lineage?: LineageStore;
  /** The collector events store — per-step cost (`(backend, raw_ref)` §18.5). */
  readonly events?: EventsTableStore;
  /** The gateway `publishPipeline` binding (run/step status fan-out). */
  readonly publish?: PipelinePublisher;
  /** The shared workstream publisher (the `workflow` node/edge fan-out §16.1). */
  readonly publishWorkstream?: WorkstreamPublisher;
  /** The run's workspace (`${workspace}` + project-scope resolution). */
  readonly workspace?: string;
  readonly logger?: Logger;
  readonly nowMs?: () => number;
  /** Retry backoff sleeper (tests inject a no-op). */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface PipelineSlice {
  /** The gateway `pipelines`-verb handler (the PipelineEnginePort). */
  readonly engine: PipelineEnginePort;
  /** The child-process-group reaper (shared with the composed executor). */
  readonly reaper: ProcessGroupReaper;
  /** Push a catalog snapshot onto the wire (§18.1). */
  publishCatalogSnapshot(scan: CatalogScanResult): void;
}

export function createPipelineSlice(options: PipelineSliceOptions): PipelineSlice {
  const reaper = createProcessGroupReaper({
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });

  const lineageCost = createPipelineLineageCost({
    ...(options.lineage !== undefined ? { lineage: options.lineage } : {}),
    ...(options.events !== undefined ? { events: options.events } : {}),
    ...(options.publishWorkstream !== undefined ? { publish: options.publishWorkstream } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
  });

  // Adapt the runner's structural status publisher onto the frozen wire
  // payloads through the gateway `publishPipeline`. Undefined optional members
  // are dropped so the frozen validators (which refuse null members) accept it.
  const publisher: PipelineStatusPublisher | undefined =
    options.publish !== undefined
      ? {
          runStatus: (update: PipelineRunStatusUpdate) => {
            options.publish?.({
              kind: 'pipeline-run-status',
              runId: update.runId,
              pipelineId: update.pipelineId,
              state: update.state,
              ...(update.schemaHash !== undefined ? { schemaHash: update.schemaHash } : {}),
              ...(update.costEstimatedUsd !== undefined
                ? { costEstimatedUsd: update.costEstimatedUsd }
                : {}),
              ...(update.startedAt !== undefined ? { startedAt: update.startedAt } : {}),
              ...(update.finishedAt !== undefined ? { finishedAt: update.finishedAt } : {}),
              ...(update.resumable !== undefined ? { resumable: update.resumable } : {}),
            });
          },
          stepStatus: (update: PipelineStepStatusUpdate) => {
            options.publish?.({
              kind: 'pipeline-step-status',
              runId: update.runId,
              stepId: update.stepId,
              iteration: update.iteration,
              attempt: update.attempt,
              state: update.state,
              ...(update.sessionId !== undefined ? { sessionId: update.sessionId } : {}),
              ...(update.account !== undefined ? { account: update.account } : {}),
              ...(update.costEstimatedUsd !== undefined
                ? { costEstimatedUsd: update.costEstimatedUsd }
                : {}),
              ...(update.tokensIn !== undefined ? { tokensIn: update.tokensIn } : {}),
              ...(update.tokensOut !== undefined ? { tokensOut: update.tokensOut } : {}),
              ...(update.startedAt !== undefined ? { startedAt: update.startedAt } : {}),
              ...(update.finishedAt !== undefined ? { finishedAt: update.finishedAt } : {}),
              ...(update.errorKind !== undefined ? { errorKind: update.errorKind } : {}),
            });
          },
        }
      : undefined;

  const engine = createPipelineEngine({
    store: options.store,
    executor: options.executor,
    ...(options.resolver !== undefined ? { resolver: options.resolver } : {}),
    ...(options.gate !== undefined ? { gate: options.gate } : {}),
    lineageCost,
    reaper,
    ...(publisher !== undefined ? { publisher } : {}),
    ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
  });

  return {
    engine,
    reaper,
    publishCatalogSnapshot: (scan) => {
      options.publish?.(scanResultToSnapshot(scan));
    },
  };
}
