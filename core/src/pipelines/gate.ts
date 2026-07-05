/**
 * The approval-gate port the pipeline runner drives (BE-8; ws-protocol.md
 * §18.3, dag-schema.md §2 `approval` step). A first-class `approval` step
 * PAUSES the walk; the pending gate rides the EXISTING M2 approvals channel as
 * an `approval-request` with `source: 'workflow-gate'` (§10.1: runId/stepId
 * REQUIRED, toolName/toolUseId forbidden) — the M2 one-inbox precedent, NO new
 * gate wire. The FE answers `approval-decision`; the broker resolves.
 *
 * This is a NARROW view of BE-2's ApprovalBroker (`request` only) so the runner
 * stays broker-agnostic. The composition root adapts the real broker; tests
 * inject a fake that resolves gates on command (pause → decision → resume).
 *
 * IDEMPOTENT DOUBLE-DECISION (frozen contract): the broker's `decide` is the
 * idempotent surface (first decision wins, later ones answer
 * `approval-not-pending`); the runner just awaits the ONE resolution the broker
 * hands back, so a double-click never resumes/aborts a run twice.
 */

import type { AccountLabel } from '@aibender/protocol';

/** The terminal outcome of a gate wait (the M2 ApprovalOutcome subset). */
export type GateOutcome = 'allowed' | 'denied' | 'expired' | 'superseded';

export interface GateRequestInput {
  readonly runId: string;
  readonly stepId: string;
  /** Identifier-free inbox one-liner [X2]. */
  readonly summary: string;
  /** The account label the run is attributed to (the inbox needs one). */
  readonly accountLabel: AccountLabel;
  /**
   * Time-to-decision: a number (ms), or `null` for NO expiry (a gate may
   * legitimately wait forever — the broker honors `null`). Absent → broker
   * default. `timeoutSec` on the step maps to `ttlMs`.
   */
  readonly ttlMs?: number | null;
}

export interface GateHandle {
  /** Resolves on decide / expiry / supersede — never rejects (broker contract). */
  readonly resolution: Promise<{ readonly outcome: GateOutcome }>;
}

/**
 * The gate surface the runner needs. `request` fans out the `approval-request`
 * (workflow-gate source) and returns a handle whose `resolution` settles once
 * the owner decides (or the gate expires/supersedes).
 */
export interface PipelineApprovalGate {
  request(input: GateRequestInput): GateHandle;
}
