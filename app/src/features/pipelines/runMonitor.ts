/**
 * FE-6 run-monitor derivations — pure read-model transforms over the FROZEN
 * run/step payloads (ws-protocol.md §18.1) for the run monitor:
 *
 *   - per-run status readout + the resume-from-journal affordance
 *     (`resumable` drives a visible "resume" verb — the M5 DoD affordance:
 *     "resumes from the memoization journal without re-executing completed
 *     steps"); a replayed run renders SETTLED, never re-animated (pipelines
 *     carry NO ceremony, DESIGN.md §3.3);
 *   - per-step status + cost (`memoized` = resumed from the journal WITHOUT
 *     re-execution — the row reads MEMOIZED, distinct from COMPLETED, never a
 *     spinner; `awaiting-approval` = paused on a first-class gate);
 *   - the approval-gate DEEP-LINK: an `awaiting-approval` step is matched to
 *     the pending `workflow-gate` approval in the SHARED approvals store (the
 *     M2 one-inbox precedent — we do NOT build a second inbox) by (runId,
 *     stepId); the monitor surfaces "decide in the inbox", never its own
 *     decision UI.
 *
 * Cost is an ESTIMATE unless a payload marks it actual (§18 — Bedrock only);
 * the monitor labels it EST. Σ is derived from the run record's
 * `costEstimatedUsd` when present, else summed from the step rows.
 *
 * [X2]: rows carry harness ids + placeholder labels + identifier-free error
 * classes only. `errorKind` is a class string, not a message.
 */

import type {
  PipelineRunState,
  PipelineRunStatusRecord,
  PipelineStepState,
  PipelineStepStatusRecord,
} from '@aibender/protocol';
import type { PendingApproval } from '../../lib/index.ts';

// ---------------------------------------------------------------------------
// Status → instrument register (never color-only — every state has a readout)
// ---------------------------------------------------------------------------

export type InstrumentStatus = 'ok' | 'degraded' | 'fault' | 'nosignal';

/** Run state → the panel's status register (DESIGN.md §2.4 semantic status). */
export function runStatusRegister(state: PipelineRunState): InstrumentStatus {
  switch (state) {
    case 'completed':
      return 'ok';
    case 'running':
    case 'paused':
    case 'pending':
      return 'degraded';
    case 'failed':
      return 'fault';
    case 'cancelled':
      return 'nosignal';
  }
}

/** Step state → the row's status register. */
export function stepStatusRegister(state: PipelineStepState): InstrumentStatus {
  switch (state) {
    case 'completed':
    case 'memoized':
      return 'ok';
    case 'running':
    case 'awaiting-approval':
    case 'pending':
    case 'blocked':
      return 'degraded';
    case 'failed':
      return 'fault';
    case 'skipped':
    case 'cancelled':
      return 'nosignal';
  }
}

/** Uppercase engraved readout for a step state (the row's text marker). */
export const STEP_STATE_READOUT: Readonly<Record<PipelineStepState, string>> = Object.freeze({
  pending: 'PENDING',
  blocked: 'BLOCKED',
  running: 'RUNNING',
  'awaiting-approval': 'GATE',
  completed: 'DONE',
  memoized: 'MEMOIZED',
  failed: 'FAILED',
  skipped: 'SKIPPED',
  cancelled: 'CANCELLED',
});

export const RUN_STATE_READOUT: Readonly<Record<PipelineRunState, string>> = Object.freeze({
  pending: 'PENDING',
  running: 'RUNNING',
  paused: 'PAUSED',
  completed: 'COMPLETED',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
});

// ---------------------------------------------------------------------------
// Run-level derivations
// ---------------------------------------------------------------------------

/** The verbs currently legal on a run (drives which control buttons enable). */
export interface RunControls {
  readonly pausable: boolean;
  readonly resumable: boolean;
  readonly cancellable: boolean;
}

/**
 * Which controls a run offers. `pause` only while running; `cancel` while the
 * run is live (running/paused/pending); `resume` when the run advertises
 * journaled progress (`resumable`) AND is not currently running (paused, or
 * interrupted-then-restarted where the broker left it non-terminal). The
 * resume affordance is the M5 DoD's "resume from the memoization journal".
 */
export function runControlsFor(run: PipelineRunStatusRecord): RunControls {
  const live = run.state === 'running' || run.state === 'paused' || run.state === 'pending';
  return {
    pausable: run.state === 'running',
    resumable: run.resumable === true && run.state !== 'running' && run.state !== 'completed',
    cancellable: live,
  };
}

/**
 * Σ cost estimate for a run: the run record's own value when present (the
 * broker's authoritative rollup), else summed from the step rows. Always an
 * ESTIMATE (§18) — the readout is labeled EST by the view.
 */
export function runCostEstimate(
  run: PipelineRunStatusRecord,
  steps: readonly PipelineStepStatusRecord[],
): number {
  if (run.costEstimatedUsd !== undefined) return run.costEstimatedUsd;
  let sum = 0;
  for (const step of steps) sum += step.costEstimatedUsd ?? 0;
  return sum;
}

/** Distinct account labels the run's steps ran on (the [X1] routing summary). */
export function runAccountsUsed(steps: readonly PipelineStepStatusRecord[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const step of steps) {
    if (step.account !== undefined && !seen.has(step.account)) {
      seen.add(step.account);
      out.push(step.account);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Approval-gate deep-link (the M2 one-inbox precedent — no second inbox)
// ---------------------------------------------------------------------------

/**
 * The pending `workflow-gate` approval matching an `awaiting-approval` step,
 * by (runId, stepId). Returns the approvalId so the monitor can deep-link into
 * THE single approval inbox (M2). The approvals store is the source of truth
 * for the pending gate; the pipeline step's `awaiting-approval` state is the
 * monitor-side mirror.
 */
export function gateApprovalFor(
  runId: string,
  stepId: string,
  pending: readonly PendingApproval[],
): string | undefined {
  for (const entry of pending) {
    const req = entry.request;
    if (req.source === 'workflow-gate' && req.runId === runId && req.stepId === stepId) {
      return req.approvalId;
    }
  }
  return undefined;
}

/** True when a step is a gate the FE should deep-link (awaiting a decision). */
export function isAwaitingApproval(step: PipelineStepStatusRecord): boolean {
  return step.state === 'awaiting-approval';
}
