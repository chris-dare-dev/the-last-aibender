/**
 * Gateway-facing kernel port (BE-3 M1 slice, plan §4/BE-3, blueprint §2).
 *
 * The gateway never talks to the SDK, node-pty, or SQLite directly — it
 * drives the BE-1 session kernel through this narrow port, one method per
 * frozen control verb (launch · resume · kill · status). The composition
 * root (core/src/main/, owner BE-ORCH) adapts the real BE-1 kernel to this
 * interface at startup; tests drive it with the FakeKernel double in
 * ./fakeKernel.ts (backed by a FakeQueryRunner).
 *
 * CONTRACT NOTES (docs/contracts/ws-protocol.md §4, FROZEN-M1-CORE,
 * amended by ICR-0004):
 *  - `launch` answers with the ledger state at response time. The M2 broker
 *    loop answers `spawning` (row exists, spawn proceeds asynchronously);
 *    the M1 composition awaits the spawn, so `running`/`exited` are equally
 *    legal answers (ws-protocol.md §4.1 note, ICR-0004).
 *  - `resume` without fork MUST reject a running-family session with
 *    `double-resume-blocked` (blueprint §5 guardrail).
 *  - `status` with a session id that has no ledger row rejects with
 *    `session-not-found`; with no id it reports every ledger session.
 *  - Rejections use {@link KernelVerbError} so the gateway can answer the
 *    exact ErrorCode; any other thrown value maps to `internal` with a
 *    GENERIC message (the original is logged broker-side only).
 *  - [X2]: KernelVerbError messages MUST be identifier-free — they go on the
 *    wire verbatim (the gateway additionally scrubs its per-boot token).
 */

import type {
  ErrorCode,
  LaunchParams,
  SessionState,
  SessionStatus,
} from '@aibender/protocol';
import { isErrorCode } from '@aibender/protocol';

// ---------------------------------------------------------------------------
// Verb results (wire projections come from @aibender/protocol)
// ---------------------------------------------------------------------------

export interface KernelLaunchResult {
  readonly sessionId: string;
  /** `spawning` per the row-before-spawn discipline (blueprint §4.1). */
  readonly state: SessionState;
}

export interface KernelResumeResult {
  /** The resumed session, or the fork CHILD when `fork: true` (X4 edge). */
  readonly sessionId: string;
  readonly state: SessionState;
  /** Present iff the resume forked: the parent session id. */
  readonly forkedFrom?: string;
}

export interface KernelKillResult {
  readonly sessionId: string;
  readonly state: SessionState;
}

export interface KernelResumeParams {
  readonly sessionId: string;
  readonly fork: boolean;
  /**
   * Next user prompt for the resumed session (ICR-0004). Optional on the
   * wire; the sdk substrate REQUIRES it at M1 — the kernel adapter answers
   * `bad-request` when it is absent for an sdk session.
   */
  readonly prompt?: string;
}

export interface KernelKillParams {
  readonly sessionId: string;
  /** `graceful` checkpoints then terminates; `force` is SIGKILL-class, process-GROUP targeted (SPIKE-D finding 2). */
  readonly mode: 'graceful' | 'force';
}

/**
 * The four frozen M1 control verbs as the gateway consumes them. BE-1's
 * kernel (core/src/kernel/) is adapted onto this port by BE-ORCH in
 * core/src/main/ — the gateway compiles and tests without the kernel lane.
 */
export interface GatewayKernel {
  launch(params: LaunchParams): Promise<KernelLaunchResult>;
  resume(params: KernelResumeParams): Promise<KernelResumeResult>;
  kill(params: KernelKillParams): Promise<KernelKillResult>;
  /** Absent sessionId = every ledger session. Unknown id → `session-not-found`. */
  status(sessionId?: string): Promise<readonly SessionStatus[]>;
}

// ---------------------------------------------------------------------------
// Typed verb rejection
// ---------------------------------------------------------------------------

/**
 * A kernel verb rejection the gateway answers verbatim as
 * `{ kind:'result', id, ok:false, error:{ code, message, retryable } }`.
 * The message goes on the wire: keep it identifier-free [X2].
 */
export class KernelVerbError extends Error {
  override readonly name = 'KernelVerbError';
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: { retryable?: boolean } = {}) {
    super(message);
    if (!isErrorCode(code)) {
      // Programmer error, not a wire condition: fail loudly at construction.
      throw new RangeError(`KernelVerbError requires a registered ErrorCode, got ${JSON.stringify(code)}`);
    }
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export function isKernelVerbError(value: unknown): value is KernelVerbError {
  return value instanceof KernelVerbError;
}
