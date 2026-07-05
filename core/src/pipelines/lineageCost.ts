/**
 * Lineage + cost integration for pipeline step attempts (BE-8; dag-schema.md
 * §6, ws-protocol.md §18.5, findings pipeline-workflow-builder §R3).
 *
 * LINEAGE (dag-schema.md §6 — the pin, NOT the LineageRecorder port): the
 * pipeline runner records step-attempt `session_node`s + `workflow`
 * `session_edge`s DIRECTLY on the lineage store (the `LineageRecorder` union
 * has no `workflow` variant by design — it is for KERNEL session actions). A
 * step's node gets a `workflow` edge to each successor's node once both exist,
 * carrying `metadataJson: {runId, fromStep, toStep}`. Published through the
 * SHARED WorkstreamPublisher (the same wire the recorder uses — no new port).
 *
 * COST (ws-protocol.md §18.5): per-step cost lands in the events store via the
 * `(backend, raw_ref)` dedupe key, `raw_ref` keyed
 * `pipeline:<runId>:<stepId>:<iteration>` (distinct iterations are distinct
 * keys; retry-safe re-ingest dedupes). The events backend is the account's
 * `LABEL_BACKENDS[account]` (the wire `Backend` enum — the step's `bedrock`
 * DAG-backend collapses to `opencode` for AWS_DEV, satisfying the store's
 * label/backend pairing CHECK).
 *
 * Both paths are FIRE-AND-FORGET and WRAPPED: a lineage/cost failure is logged
 * and swallowed — it must never take a running pipeline down (the recorder's
 * never-throw discipline). All ids are HARNESS ids; native ids never appear.
 */

import { LABEL_BACKENDS, type AccountLabel } from '@aibender/protocol';
import type { EventsTableStore, LineageStore } from '@aibender/schema';
import type { Logger } from '@aibender/shared';
import { newId } from '@aibender/shared';

import { edgeToWire, nodeToWire, type WorkstreamPublisher } from '../workstreams/index.js';

export interface PipelineLineageCostOptions {
  /** The KERNEL lineage store (migration 0003) — same db as step_attempt. */
  readonly lineage?: LineageStore;
  /** The collector events store (migration 0002) — per-step cost attribution. */
  readonly events?: EventsTableStore;
  /** The shared workstream publisher (fan-out); absent → store-only. */
  readonly publish?: WorkstreamPublisher;
  readonly logger?: Logger;
  /** Node/edge id factories (tests pin ids). */
  readonly newNodeId?: () => string;
  readonly newEdgeId?: () => string;
  /** Epoch-ms clock. */
  readonly nowMs?: () => number;
}

/** One step attempt's lineage/cost inputs (all harness ids [X2]). */
export interface StepAttemptLineage {
  readonly runId: string;
  readonly stepId: string;
  readonly iteration: number;
  readonly account: AccountLabel;
  /**
   * Optional workstream the run's nodes belong to (the run's subgraph). When
   * present, the step node is created inside it.
   */
  readonly workstreamId?: string;
  /** Cost attribution (estimate) for the events store. */
  readonly costEstimatedUsd?: number;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly ok: boolean;
  readonly errorKind?: string;
}

export interface StepNodeRegistration {
  /** The harness session-node id minted for this step attempt (the edge target). */
  readonly sessionId: string;
}

/**
 * The lineage/cost recorder the runner drives. Every method is fire-and-forget
 * (never throws). `registerStepNode` mints + inserts the node and returns its
 * id; `recordWorkflowEdge` appends a `workflow` edge between two step nodes;
 * `landCost` inserts the events-store cost row.
 */
export interface PipelineLineageCost {
  /** Insert a `session_node` for a step attempt; returns its harness id (or undefined). */
  registerStepNode(input: StepAttemptLineage): StepNodeRegistration | undefined;
  /** Append a `workflow` edge from one step node to a successor step node. */
  recordWorkflowEdge(input: {
    readonly runId: string;
    readonly fromStep: string;
    readonly fromNode: string;
    readonly toStep: string;
    readonly toNode: string;
  }): void;
  /** Land per-step cost in the events store (dedupe key pipeline:runId:stepId:iteration). */
  landCost(input: StepAttemptLineage): void;
}

export function createPipelineLineageCost(
  options: PipelineLineageCostOptions,
): PipelineLineageCost {
  const logger = options.logger;
  const nowMs = options.nowMs ?? Date.now;
  const mintNodeId = options.newNodeId ?? (() => newId('sn'));
  const mintEdgeId = options.newEdgeId ?? (() => newId('edg'));

  const publish: WorkstreamPublisher = (payload) => {
    if (options.publish === undefined) return;
    try {
      options.publish(payload);
    } catch (cause) {
      logger?.error('pipeline lineage publish refused', {
        kind: payload.kind,
        detail: (cause as Error).message,
      });
    }
  };

  return {
    registerStepNode: (input) => {
      const store = options.lineage;
      if (store === undefined) return undefined;
      try {
        const id = mintNodeId();
        const backend = LABEL_BACKENDS[input.account];
        const row = store.nodes.insert({
          id,
          ...(input.workstreamId !== undefined ? { workstreamId: input.workstreamId } : {}),
          backend,
          account: input.account,
          // A step attempt's node is `harness`-origin, `recorded` confidence
          // (it is a kernel-mediated action, the recorder's discipline). A
          // completed attempt is `completed`; a failed one is `abandoned`.
          state: input.ok ? 'completed' : 'abandoned',
          origin: 'harness',
          confidence: 'recorded',
          displayName: `pipeline ${input.stepId}`,
        });
        publish({ kind: 'workstream-node', ...nodeToWire(row) });
        return { sessionId: row.id };
      } catch (cause) {
        logger?.error('pipeline step-node registration failed (non-fatal)', {
          detail: (cause as Error).message,
        });
        return undefined;
      }
    },

    recordWorkflowEdge: (input) => {
      const store = options.lineage;
      if (store === undefined) return;
      try {
        const row = store.edges.insert({
          id: mintEdgeId(),
          fromNode: input.fromNode,
          toNode: input.toNode,
          edgeType: 'workflow',
          metadataJson: JSON.stringify({
            runId: input.runId,
            fromStep: input.fromStep,
            toStep: input.toStep,
          }),
        });
        publish({ kind: 'workstream-edge', ...edgeToWire(row) });
      } catch (cause) {
        logger?.error('pipeline workflow-edge record failed (non-fatal)', {
          detail: (cause as Error).message,
        });
      }
    },

    landCost: (input) => {
      const store = options.events;
      if (store === undefined) return;
      // Only land a row when there is something to attribute.
      if (
        input.costEstimatedUsd === undefined &&
        input.tokensIn === undefined &&
        input.tokensOut === undefined
      ) {
        return;
      }
      try {
        const backend = LABEL_BACKENDS[input.account];
        store.insert({
          tsMs: nowMs(),
          backend,
          account: input.account,
          // The events `source` must pair with the backend (the store's
          // pairing CHECK): claude → the OTel attribution-truth source,
          // opencode → its SSE source, lmstudio → its inline source.
          source: sourceForBackend(backend),
          eventType: 'pipeline_step',
          // raw_ref is the (backend, raw_ref) dedupe key: distinct iterations
          // are distinct keys; a retry re-ingest of the SAME iteration dedupes.
          rawRef: `pipeline:${input.runId}:${input.stepId}:${input.iteration}`,
          ...(input.costEstimatedUsd !== undefined
            ? { costEstimatedUsd: input.costEstimatedUsd }
            : {}),
          ...(input.tokensIn !== undefined ? { inputTokens: input.tokensIn } : {}),
          ...(input.tokensOut !== undefined ? { outputTokens: input.tokensOut } : {}),
          ok: input.ok,
          ...(input.errorKind !== undefined ? { errorKind: coerceErrorKind(input.errorKind) } : {}),
        });
      } catch (cause) {
        logger?.error('pipeline cost attribution failed (non-fatal)', {
          detail: (cause as Error).message,
        });
      }
    },
  };
}

/** Map a step error class onto the events-store `EventErrorKind` vocabulary
 *  (`error | retry | throttle | timeout`). */
function coerceErrorKind(kind: string): 'error' | 'retry' | 'throttle' | 'timeout' {
  if (kind === 'timeout') return 'timeout';
  if (kind === 'rate_limit' || kind === 'overloaded') return 'throttle';
  return 'error';
}

/** Pick an `EventSource` consistent with the wire backend (no source↔backend
 *  CHECK exists, but a coherent source keeps the events pane truthful). */
function sourceForBackend(
  backend: 'claude_code' | 'opencode' | 'lmstudio',
): 'claude-otel' | 'opencode-sse' | 'lmstudio' {
  if (backend === 'claude_code') return 'claude-otel';
  if (backend === 'opencode') return 'opencode-sse';
  return 'lmstudio';
}
