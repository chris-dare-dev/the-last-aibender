/**
 * Control-channel verbs for M1: launch · resume · kill · status.
 * `approve` is RESERVED — the verb name is registered so no other meaning can
 * squat on it, but its request/response shape is deliberately unfrozen until
 * the M2 approvals slice; validators reject it with `verb-reserved`.
 *
 * Requests are client → broker on the `control` channel; each carries a
 * client-generated request id and is answered by exactly one
 * {@link ControlResponse} correlated on that id.
 *
 * ============================================================================
 * FROZEN-M1-CORE (2026-07-04). Amendments only via ICR (docs/contracts/icr/);
 * BE-ORCH lands, FE-ORCH co-signs. Prose of record: docs/contracts/ws-protocol.md.
 * Amendments: ICR-0004 (2026-07-04) — optional `prompt` on resume params.
 * ============================================================================
 */

import type { AccountLabel, Backend, SessionState, Substrate } from './vocab.js';
import type { ErrorDetail } from './errors.js';

/** Frozen M1 control verbs. */
export const CONTROL_VERBS = Object.freeze(['launch', 'resume', 'kill', 'status'] as const);

export type ControlVerb = (typeof CONTROL_VERBS)[number];

/** Registered-but-unfrozen verbs. Shape lands at M2 via ICR. */
export const RESERVED_CONTROL_VERBS = Object.freeze(['approve'] as const);

/** Client-generated request id: 1–128 chars of [A-Za-z0-9_-]. */
export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// ---------------------------------------------------------------------------
// Requests (inbound to the broker)
// ---------------------------------------------------------------------------

export interface LaunchParams {
  /** Placeholder label only — MAX_A/MAX_B/ENT/AWS_DEV/LOCAL [X2]. */
  readonly accountLabel: AccountLabel;
  /** Must satisfy LABEL_BACKENDS pairing (validated). */
  readonly backend: Backend;
  /** `pty` (attended TUI) is claude_code-only (validated; blueprint §4.1). */
  readonly substrate: Substrate;
  /** Absolute working directory (byte-stable string; blueprint §3 rule 2). */
  readonly cwd: string;
  /** Free-text purpose, lands in the resume ledger row-before-spawn. */
  readonly purpose: string;
  /** Optional workstream hint for the X4 ledger (harness id or slug). */
  readonly workstreamHint?: string;
  /** One-off prompt for headless SDK launches (feature 2). */
  readonly prompt?: string;
}

export interface LaunchRequest {
  readonly kind: 'launch';
  readonly id: string;
  readonly params: LaunchParams;
}

export interface ResumeRequest {
  readonly kind: 'resume';
  readonly id: string;
  readonly params: {
    /** Harness session id (resume-ledger key) — never a native id. */
    readonly sessionId: string;
    /**
     * When true, resume as forkSession (continuation CHILD, X4 edge).
     * Resuming a RUNNING session without fork is refused with
     * `double-resume-blocked` (blueprint §5 guardrail).
     */
    readonly fork?: boolean;
    /**
     * The next user prompt the resumed session processes (ICR-0004).
     * Optional on the wire; the `sdk` substrate REQUIRES it at M1 — an SDK
     * resume without a new user prompt is not meaningful at SDK 0.3.201, so
     * the broker answers `bad-request` when it is absent for an sdk session.
     */
    readonly prompt?: string;
  };
}

export interface KillRequest {
  readonly kind: 'kill';
  readonly id: string;
  readonly params: {
    readonly sessionId: string;
    /** `graceful` (default) checkpoints then terminates; `force` is SIGKILL-class. */
    readonly mode?: 'graceful' | 'force';
  };
}

export interface StatusRequest {
  readonly kind: 'status';
  readonly id: string;
  /** Absent params (or absent sessionId) = status of every ledger session. */
  readonly params?: {
    readonly sessionId?: string;
  };
}

export type ControlRequest = LaunchRequest | ResumeRequest | KillRequest | StatusRequest;

// ---------------------------------------------------------------------------
// Responses (broker → client, correlated by request id)
// ---------------------------------------------------------------------------

/** Wire projection of a resume-ledger row (states per vocab.ts / schema DDL). */
export interface SessionStatus {
  readonly sessionId: string;
  readonly accountLabel: AccountLabel;
  readonly backend: Backend;
  readonly substrate: Substrate;
  readonly state: SessionState;
  readonly cwd: string;
  readonly purpose: string;
  readonly workstreamHint?: string;
  /** Native session id once backfilled from the init message (nullable-late). */
  readonly nativeSessionId?: string;
  /** Pid of the actual session process (SPIKE-D finding 2), when alive. */
  readonly pid?: number;
}

export type ControlResult =
  | { readonly verb: 'launch'; readonly sessionId: string; readonly state: SessionState }
  | {
      readonly verb: 'resume';
      /** The resumed session, or the fork child when `fork: true`. */
      readonly sessionId: string;
      readonly state: SessionState;
      /** Present iff the resume forked: the parent session id. */
      readonly forkedFrom?: string;
    }
  | { readonly verb: 'kill'; readonly sessionId: string; readonly state: SessionState }
  | { readonly verb: 'status'; readonly sessions: readonly SessionStatus[] };

export type ControlResponse =
  | { readonly kind: 'result'; readonly id: string; readonly ok: true; readonly result: ControlResult }
  | { readonly kind: 'result'; readonly id: string; readonly ok: false; readonly error: ErrorDetail };
