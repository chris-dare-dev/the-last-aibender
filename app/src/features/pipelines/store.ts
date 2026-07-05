/**
 * FE-6 pipelines store — the client-side read model of the FROZEN `pipelines`
 * channel (ws-protocol.md §18): the builder palette (catalog snapshot), the
 * run monitor (per-run status + per-step-attempt status/cost), the answers to
 * the validate/save verbs (correlated by requestId), and the local
 * verb-dispatch correlation table (a verb the FE sent → pending / unsendable /
 * blocked / answered / failed with a frozen §18.4 code).
 *
 * Discipline (plan §5 FE iron rules — the workstreams/observability store
 * precedent):
 *   - wire writes land ONLY through {@link PipelinesStoreState.applyBatch} —
 *     one store write per rAF frame batch (bind.ts owns the projector); React
 *     render counts are bounded by frames, never by wire messages;
 *   - the catalog snapshot is MONOTONE on `capturedAt` per (workspace) scope:
 *     a replayed older snapshot never regresses the palette (§18.5 posture);
 *   - run/step status are UPSERTS keyed on their frozen key axes
 *     (runId / runId+stepId+iteration+attempt); a run-snapshot re-baselines a
 *     run's step set; run/step status transitions upsert in place;
 *   - NO ceremony is armed here. The ONE ceremonial animation (DESIGN.md §3.3)
 *     belongs to WORKSTREAM lineage edges only; pipelines get NO new ceremony
 *     (plan §5/FE-6: "the one ceremonial animation fires on lineage events
 *     only"). A resumed run's memoized steps render SETTLED, never re-animated.
 *
 * Replay dedupe is upstream: the client drops already-processed seqs per
 * (boot, channel) watermark, so this store never sees duplicate frames.
 */

import { createStore } from 'zustand/vanilla';
import type {
  CatalogEntry,
  CatalogSnapshot,
  ErrorCode,
  PipelineRunStatusRecord,
  PipelineServerPayload,
  PipelineStepStatusRecord,
} from '@aibender/protocol';

/** Catalog snapshot scope key (absolute workspace, or the user/global bucket). */
export const GLOBAL_CATALOG_SCOPE = 'global';

/** Composite step key axis (the memoization-journal key, ws-protocol.md §18.1). */
export function stepKey(
  runId: string,
  stepId: string,
  iteration: number,
  attempt: number,
): string {
  return [runId, stepId, iteration, attempt].join(':');
}

/**
 * A verb the FE dispatched, as the deck instruments it:
 *   blocked    — refused CLIENT-side by the frozen validator (never sent; the
 *                server stays the authority for everything actually sent);
 *   unsendable — valid but the wire was down / the sender seam is absent;
 *   pending    — sent, awaiting the correlated answer or a pushed §18.4 error;
 *   answered   — a `pipeline-validation-result` / `pipeline-saved` landed
 *                (for validate/save); run verbs settle via run status;
 *   failed     — a pushed §18.4 error correlated by requestId.
 */
export type VerbPhase = 'blocked' | 'unsendable' | 'pending' | 'answered' | 'failed';

export interface VerbState {
  readonly requestId: string;
  readonly verb: PipelineClientVerbLabel;
  readonly phase: VerbPhase;
  /** The frozen error code (blocked / failed). */
  readonly code?: ErrorCode;
  /** validate answer detail — the dag/ issue class + identifier-free message. */
  readonly valid?: boolean;
  readonly issueCode?: string;
  readonly issueMessage?: string;
  readonly issuePath?: string;
  /** save answer: the persisted definition id. */
  readonly pipelineId?: string;
}

/** The verb labels the deck tracks (the frozen client-verb kinds). */
export type PipelineClientVerbLabel =
  | 'pipeline-validate'
  | 'pipeline-save'
  | 'pipeline-launch'
  | 'pipeline-pause'
  | 'pipeline-resume'
  | 'pipeline-cancel';

export interface PipelinesStoreState {
  /** Latest catalog snapshot per (workspace) scope — the builder palette. */
  readonly catalog: Readonly<Record<string, CatalogSnapshot>>;
  /** Per-scope catalog capturedAt watermark (monotone). */
  readonly catalogCapturedAt: Readonly<Record<string, number>>;
  /** Run-level monitor rows keyed on runId (UPSERT semantics). */
  readonly runs: Readonly<Record<string, PipelineRunStatusRecord>>;
  /** Run arrival order, oldest first (stable fleet-list render). */
  readonly runOrder: readonly string[];
  /** Per-step-attempt rows keyed on {@link stepKey} (UPSERT semantics). */
  readonly steps: Readonly<Record<string, PipelineStepStatusRecord>>;
  /** Step insertion order per run (stable monitor render, snapshot order). */
  readonly stepOrder: Readonly<Record<string, readonly string[]>>;
  /** Verb-dispatch correlation table keyed on requestId. */
  readonly verbs: Readonly<Record<string, VerbState>>;

  /** Apply one frame batch of validated server payloads (ONE store write). */
  applyBatch(batch: readonly PipelineServerPayload[]): void;
  /** Local dispatch bookkeeping (verbs.ts controller). */
  trackVerb(state: VerbState): void;
  /** A pushed §18.4 error correlated to a verb requestId (bind.ts routes it). */
  applyVerbError(requestId: string, code: ErrorCode): void;
  reset(): void;
}

/** Strip the decode-side `kind` discriminant off a run-status event record. */
function asRunRecord(
  run: PipelineRunStatusRecord & { kind?: string },
): PipelineRunStatusRecord {
  const { kind: _kind, ...record } = run;
  return record;
}

function asStepRecord(
  step: PipelineStepStatusRecord & { kind?: string },
): PipelineStepStatusRecord {
  const { kind: _kind, ...record } = step;
  return record;
}

function scopeKeyOf(snapshot: CatalogSnapshot): string {
  return snapshot.workspace ?? GLOBAL_CATALOG_SCOPE;
}

export const pipelinesStore = createStore<PipelinesStoreState>()((set) => ({
  catalog: {},
  catalogCapturedAt: {},
  runs: {},
  runOrder: [],
  steps: {},
  stepOrder: {},
  verbs: {},

  applyBatch: (batch) => {
    if (batch.length === 0) return;
    set((s) => {
      let changed = false;
      const catalog: Record<string, CatalogSnapshot> = { ...s.catalog };
      const catalogCapturedAt: Record<string, number> = { ...s.catalogCapturedAt };
      const runs: Record<string, PipelineRunStatusRecord> = { ...s.runs };
      let runOrder = s.runOrder;
      const steps: Record<string, PipelineStepStatusRecord> = { ...s.steps };
      const stepOrder: Record<string, readonly string[]> = { ...s.stepOrder };
      const verbs: Record<string, VerbState> = { ...s.verbs };

      const touchRun = (runId: string): void => {
        if (runs[runId] === undefined && !runOrder.includes(runId)) {
          runOrder = [...runOrder, runId];
        }
      };
      const appendStep = (runId: string, key: string): void => {
        const order = stepOrder[runId];
        if (order === undefined) {
          stepOrder[runId] = [key];
        } else if (!order.includes(key)) {
          stepOrder[runId] = [...order, key];
        }
      };

      for (const payload of batch) {
        switch (payload.kind) {
          case 'catalog-snapshot': {
            const scope = scopeKeyOf(payload);
            const watermark = catalogCapturedAt[scope];
            // Monotone on capturedAt: replays never regress the palette.
            if (watermark !== undefined && watermark > payload.capturedAt) break;
            catalogCapturedAt[scope] = payload.capturedAt;
            catalog[scope] = payload;
            changed = true;
            break;
          }
          case 'pipeline-run-snapshot': {
            const runId = payload.run.runId;
            touchRun(runId);
            runs[runId] = asRunRecord(payload.run);
            // Re-baseline a run's step set from the snapshot (§18.5).
            const order: string[] = [];
            for (const step of payload.steps) {
              const key = stepKey(step.runId, step.stepId, step.iteration, step.attempt);
              steps[key] = asStepRecord(step);
              if (!order.includes(key)) order.push(key);
            }
            // Preserve any keys already ordered for this run that the snapshot
            // also carries; the snapshot's order wins as the settled baseline.
            stepOrder[runId] = order;
            changed = true;
            break;
          }
          case 'pipeline-run-status': {
            touchRun(payload.runId);
            runs[payload.runId] = asRunRecord(payload);
            changed = true;
            break;
          }
          case 'pipeline-step-status': {
            const key = stepKey(payload.runId, payload.stepId, payload.iteration, payload.attempt);
            touchRun(payload.runId);
            steps[key] = asStepRecord(payload);
            appendStep(payload.runId, key);
            changed = true;
            break;
          }
          case 'pipeline-validation-result': {
            const previous = verbs[payload.requestId];
            verbs[payload.requestId] = {
              requestId: payload.requestId,
              verb: previous?.verb ?? 'pipeline-validate',
              phase: 'answered',
              valid: payload.valid,
              ...(payload.issueCode !== undefined ? { issueCode: payload.issueCode } : {}),
              ...(payload.issueMessage !== undefined
                ? { issueMessage: payload.issueMessage }
                : {}),
              ...(payload.issuePath !== undefined ? { issuePath: payload.issuePath } : {}),
            };
            changed = true;
            break;
          }
          case 'pipeline-saved': {
            const previous = verbs[payload.requestId];
            verbs[payload.requestId] = {
              requestId: payload.requestId,
              verb: previous?.verb ?? 'pipeline-save',
              phase: 'answered',
              pipelineId: payload.pipelineId,
            };
            changed = true;
            break;
          }
          default:
            // Exhaustive over the frozen server union; opaque payloads are
            // filtered upstream (bind.ts) per the forward-tolerant reader rule.
            break;
        }
      }

      if (!changed) return s;
      return { catalog, catalogCapturedAt, runs, runOrder, steps, stepOrder, verbs };
    });
  },

  trackVerb: (state) => {
    set((s) => ({ verbs: { ...s.verbs, [state.requestId]: state } }));
  },

  applyVerbError: (requestId, code) => {
    set((s) => {
      const previous = s.verbs[requestId];
      // An answer already landed — the error is stale replay noise.
      if (previous?.phase === 'answered') return s;
      return {
        verbs: {
          ...s.verbs,
          [requestId]: {
            requestId,
            verb: previous?.verb ?? 'pipeline-validate',
            phase: 'failed',
            code,
          },
        },
      };
    });
  },

  reset: () =>
    set({
      catalog: {},
      catalogCapturedAt: {},
      runs: {},
      runOrder: [],
      steps: {},
      stepOrder: {},
      verbs: {},
    }),
}));

export type PipelinesStore = typeof pipelinesStore;

// ---------------------------------------------------------------------------
// Selectors (pure derivations over the store state)
// ---------------------------------------------------------------------------

/**
 * Catalog entries for the resolved scope. Resolution order: the explicitly
 * requested scope, else the global bucket, else — when exactly one snapshot
 * exists — that sole snapshot (a single-workspace resolution the builder
 * shows without forcing a scope pick). Empty when no catalog has arrived.
 */
export function catalogEntriesFor(
  state: Pick<PipelinesStoreState, 'catalog'>,
  scope: string | undefined,
): readonly CatalogEntry[] {
  const key = scope ?? GLOBAL_CATALOG_SCOPE;
  const direct = state.catalog[key] ?? state.catalog[GLOBAL_CATALOG_SCOPE];
  if (direct !== undefined) return direct.entries;
  // Sole-snapshot fallback only when the caller did not name a specific scope.
  if (scope === undefined) {
    const keys = Object.keys(state.catalog);
    if (keys.length === 1) {
      const only = state.catalog[keys[0] as string];
      if (only !== undefined) return only.entries;
    }
  }
  return [];
}

/** Runs in stable arrival order (the left-zone fleet list). */
export function runsInOrder(
  state: Pick<PipelinesStoreState, 'runs' | 'runOrder'>,
): readonly PipelineRunStatusRecord[] {
  const out: PipelineRunStatusRecord[] = [];
  for (const runId of state.runOrder) {
    const run = state.runs[runId];
    if (run !== undefined) out.push(run);
  }
  return out;
}

/** Step-attempt rows for one run in stable order (the run monitor rows). */
export function stepsForRun(
  state: Pick<PipelinesStoreState, 'steps' | 'stepOrder'>,
  runId: string,
): readonly PipelineStepStatusRecord[] {
  const order = state.stepOrder[runId] ?? [];
  const out: PipelineStepStatusRecord[] = [];
  for (const key of order) {
    const step = state.steps[key];
    if (step !== undefined) out.push(step);
  }
  return out;
}
