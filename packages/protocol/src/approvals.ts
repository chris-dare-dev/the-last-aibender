/**
 * `approvals` channel payloads — ONE approval inbox for every escalation
 * source (blueprint §4.1 two-layer permission relay; plan BE-3/FE-2, §9.3
 * BE↔FE #4).
 *
 * The union covers all three sources NOW (designed at the M2 freeze so later
 * milestones slot in without wire changes):
 *   - `can-use-tool`   the SDK's in-loop canUseTool relay for SDK sessions
 *   - `hook-floor`     account-wide `PermissionRequest`/`PreToolUse` http
 *                      hooks — the policy floor for ALL sessions, including
 *                      external ones (docs/contracts/hooks-contract.md)
 *   - `workflow-gate`  pipeline `approval` gates (plan BE-8, M5)
 *
 * Message flow (the channel is bidirectional, as frozen at M1):
 *   broker → client   `approval-request`  (a decision is wanted)
 *   client → broker   `approval-decision` (the human decided)
 *   broker → client   `approval-resolved` (terminal fan-out: every connected
 *                     client converges, including the one that decided)
 *
 * A decision for an approval that is not pending (unknown id, already
 * resolved, expired) answers the pushed error `approval-not-pending` — that
 * race is NORMAL (two windows, expiry vs. click) and must not be conflated
 * with malformed traffic.
 *
 * The reserved `approve` CONTROL verb was retired-as-reserved at this freeze:
 * decisions ride this channel instead (session-scoped fan-out beats a
 * point-to-point verb for a multi-window inbox). The verb name stays
 * registered-and-rejected (`verb-reserved`) forever so nothing can squat on
 * it; promoting it later is an ICR.
 *
 * ============================================================================
 * FROZEN-M2 (2026-07-04). Amendments only via ICR (docs/contracts/icr/);
 * BE-ORCH lands, FE-ORCH co-signs. Prose of record: docs/contracts/ws-protocol.md.
 * ============================================================================
 */

import type { AccountLabel } from './vocab.js';

/** Broker-generated approval id: 1–128 chars of [A-Za-z0-9_-]. */
export const APPROVAL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export const APPROVAL_SOURCES = Object.freeze([
  'can-use-tool',
  'hook-floor',
  'workflow-gate',
] as const);

export type ApprovalSource = (typeof APPROVAL_SOURCES)[number];

export const APPROVAL_VERDICTS = Object.freeze(['allow', 'deny'] as const);

export type ApprovalVerdict = (typeof APPROVAL_VERDICTS)[number];

export const APPROVAL_OUTCOMES = Object.freeze([
  /** A client allowed it (or the broker's policy auto-allowed). */
  'allowed',
  /** A client denied it (or the broker's policy auto-denied). */
  'denied',
  /** `expiresAt` passed with no decision; the broker resolved it. */
  'expired',
  /** The underlying wait vanished (session died, workflow run aborted). */
  'superseded',
] as const);

export type ApprovalOutcome = (typeof APPROVAL_OUTCOMES)[number];

/**
 * Broker → client: a decision is wanted. Field presence is per-source
 * (validated — see the matrix in ws-protocol.md):
 *   - can-use-tool:  sessionId + toolName REQUIRED (toolUseId when the SDK
 *                    surfaces one); runId/stepId absent.
 *   - hook-floor:    sessionId + toolName REQUIRED; runId/stepId absent.
 *   - workflow-gate: runId + stepId REQUIRED; sessionId optional (a gate may
 *                    pause between sessions); toolName/toolUseId absent.
 */
export interface ApprovalRequest {
  readonly kind: 'approval-request';
  readonly approvalId: string;
  readonly source: ApprovalSource;
  /**
   * Human-readable one-liner for the inbox row. Identifier-free [X2] —
   * redaction filters apply broker-side before the payload is built.
   */
  readonly summary: string;
  /** Account label placeholder only (MAX_A/MAX_B/ENT/AWS_DEV/LOCAL) [X2]. */
  readonly accountLabel: AccountLabel;
  /** Harness session id — see the per-source matrix above. */
  readonly sessionId?: string;
  readonly toolName?: string;
  readonly toolUseId?: string;
  /** Workflow run/step refs (workflow-gate only). */
  readonly runId?: string;
  readonly stepId?: string;
  /** Epoch ms after which the broker resolves the approval as `expired`. */
  readonly expiresAt?: number;
}

/** Client → broker: the human decided. */
export interface ApprovalDecision {
  readonly kind: 'approval-decision';
  readonly approvalId: string;
  readonly verdict: ApprovalVerdict;
  /**
   * canUseTool relay only, verdict `allow` only: replacement tool input the
   * SDK applies (`updatedInput` in the canUseTool result). Opaque to the
   * protocol; forbidden with `deny` (validated).
   */
  readonly updatedInput?: Readonly<Record<string, unknown>>;
  /**
   * Optional note relayed to the waiting session (the deny message on the
   * canUseTool path). Identifier-free [X2].
   */
  readonly note?: string;
}

/** Broker → client: terminal state fan-out; also replayed on reconnect. */
export interface ApprovalResolved {
  readonly kind: 'approval-resolved';
  readonly approvalId: string;
  readonly outcome: ApprovalOutcome;
}

/** What a CLIENT may send on `approvals` (plus the generic replay-request). */
export type ApprovalsClientPayload = ApprovalDecision;

/** What the BROKER pushes on `approvals`. */
export type ApprovalsServerPayload = ApprovalRequest | ApprovalResolved;

export type ApprovalsPayload = ApprovalsClientPayload | ApprovalsServerPayload;
