/**
 * ApprovalBroker — the kernel-side pending-approval queue behind the ONE
 * approval inbox (BE-2; blueprint §4.1 two-layer permission relay;
 * ws-protocol.md §10, FROZEN-M2; plan §9.3 BE↔FE #4).
 *
 * The broker is the escalation surface the GATEWAY consumes:
 *
 *   escalation source ──► broker.request() ──► `approval-request` fan-out
 *   client decision   ──► broker.decide()  ──► resolve + `approval-resolved`
 *   timeout policy    ──► expiresAt timer  ──► outcome `expired`
 *   session death     ──► supersedeSession ──► outcome `superseded`
 *
 * Wire discipline (each pinned by a test in approvals.spec.ts, replaying the
 * FROZEN golden corpus semantics):
 *   - every emitted payload is a valid ApprovalsServerPayload — the emit path
 *     runs the frozen per-source field matrix at REQUEST time, so an invalid
 *     request is a programmer error (RangeError), never a wire condition;
 *   - a decision for a non-pending approval throws the typed
 *     `approval-not-pending` KernelError — that race is NORMAL (two windows;
 *     expiry vs. click) and the gateway answers it as the pushed §7 error;
 *   - `updatedInput` is only legal with `allow` (typed `bad-request`);
 *   - summaries and notes go on the wire verbatim: callers keep them
 *     identifier-free [X2] (the canUseTool bridge builds summaries from the
 *     tool name alone — never from tool INPUT, which routinely carries paths).
 *
 * The M2 slice covers `can-use-tool` (the bridge below) and accepts
 * `hook-floor` / `workflow-gate` requests through the same queue so BE-5/BE-8
 * slot in at M3/M5 without wire or broker changes (the union was frozen wide
 * deliberately).
 *
 * canUseTool WIRING (BE-2; edits marked in queryRunner.ts, sdkQueryRunner.ts,
 * sessionKernel.ts — BE-ORCH reviews): SessionKernel takes an optional
 * {@link KernelApprovalRelay}; every SDK spawn gets a per-session
 * CanUseToolHandler built here, and session end supersedes that session's
 * pending approvals.
 */

import type {
  AccountLabel,
  ApprovalDecision,
  ApprovalOutcome,
  ApprovalRequest,
  ApprovalResolved,
  ApprovalSource,
  ApprovalsServerPayload,
} from '@aibender/protocol';
import { APPROVAL_ID_RE, isAccountLabel } from '@aibender/protocol';
import type { Logger } from '@aibender/shared';
import { newId } from '@aibender/shared';

import { KernelError } from './errors.js';
import type { CanUseToolHandler } from './queryRunner.js';

// ---------------------------------------------------------------------------
// Surface types
// ---------------------------------------------------------------------------

export interface ApprovalRequestInput {
  readonly source: ApprovalSource;
  /** Inbox one-liner. Identifier-free [X2] — the caller's obligation. */
  readonly summary: string;
  readonly accountLabel: AccountLabel;
  readonly sessionId?: string;
  readonly toolName?: string;
  readonly toolUseId?: string;
  readonly runId?: string;
  readonly stepId?: string;
  /**
   * Time-to-decision override in ms. `undefined` → the broker default;
   * `null` → NO expiry (a workflow gate may legitimately wait forever).
   */
  readonly ttlMs?: number | null;
}

/** Terminal resolution handed back to the escalating caller. */
export interface ApprovalResolution {
  readonly outcome: ApprovalOutcome;
  /** canUseTool replacement input (allow-with-updatedInput decisions). */
  readonly updatedInput?: Readonly<Record<string, unknown>>;
  /** Deny note relayed to the waiting session (identifier-free [X2]). */
  readonly note?: string;
}

export interface PendingApprovalHandle {
  readonly approvalId: string;
  /** The exact wire payload that was fanned out. */
  readonly request: ApprovalRequest;
  /** Resolves on decide / expiry / supersede — never rejects. */
  readonly resolution: Promise<ApprovalResolution>;
}

export interface ApprovalBroker {
  /** Queue an escalation; fan out `approval-request`; await the resolution. */
  request(input: ApprovalRequestInput): PendingApprovalHandle;
  /**
   * Apply a client decision (gateway-validated ApprovalDecision). Returns the
   * `approval-resolved` payload that was fanned out. Throws typed
   * `approval-not-pending` / `bad-request` KernelErrors for the wire.
   */
  decide(decision: ApprovalDecision): ApprovalResolved;
  /** Pending requests in arrival order (inbox rehydration). */
  pending(): readonly ApprovalRequest[];
  /** Resolve one pending approval as `superseded`. False when not pending. */
  supersede(approvalId: string): boolean;
  /** The underlying wait vanished (session died): supersede all of its
   *  pending approvals. Returns how many were resolved. */
  supersedeSession(sessionId: string): number;
  /** Broker → gateway fan-out (`approval-request` / `approval-resolved`). */
  subscribe(listener: (message: ApprovalsServerPayload) => void): () => void;
  /** Supersede everything and stop timers (broker shutdown). */
  close(): void;
}

export interface ApprovalBrokerOptions {
  /** Epoch-ms clock (tests pin it; expiry timers use setTimeout). */
  readonly clock?: () => number;
  /**
   * Default time-to-decision. `null` → no default expiry. Default: 10 min —
   * long enough for a human, short enough that an abandoned prompt cannot
   * park a session forever (timeout POLICY, plan §4/BE-2).
   */
  readonly defaultTtlMs?: number | null;
  readonly logger?: Logger;
  readonly newApprovalId?: () => string;
}

export const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Broker
// ---------------------------------------------------------------------------

interface PendingEntry {
  readonly request: ApprovalRequest;
  readonly resolve: (resolution: ApprovalResolution) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function createApprovalBroker(options: ApprovalBrokerOptions = {}): ApprovalBroker {
  const clock = options.clock ?? Date.now;
  const defaultTtlMs = options.defaultTtlMs === undefined ? DEFAULT_APPROVAL_TTL_MS : options.defaultTtlMs;
  const logger = options.logger;
  const newApprovalId = options.newApprovalId ?? (() => newId('apr'));

  const pending = new Map<string, PendingEntry>();
  const listeners = new Set<(message: ApprovalsServerPayload) => void>();
  let closed = false;

  const fanOut = (message: ApprovalsServerPayload): void => {
    for (const listener of listeners) {
      try {
        listener(message);
      } catch (cause) {
        // A broken subscriber must never wedge the approval queue.
        logger?.error('approvals subscriber threw', {
          detail: (cause as Error).message,
        });
      }
    }
  };

  const resolveEntry = (
    entry: PendingEntry,
    outcome: ApprovalOutcome,
    extras: { updatedInput?: Readonly<Record<string, unknown>>; note?: string } = {},
  ): ApprovalResolved => {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    pending.delete(entry.request.approvalId);
    entry.resolve({
      outcome,
      ...(extras.updatedInput !== undefined ? { updatedInput: extras.updatedInput } : {}),
      ...(extras.note !== undefined ? { note: extras.note } : {}),
    });
    const resolved: ApprovalResolved = {
      kind: 'approval-resolved',
      approvalId: entry.request.approvalId,
      outcome,
    };
    fanOut(resolved);
    return resolved;
  };

  /** The frozen §10.1 per-source field matrix, enforced at request time. */
  const assertMatrix = (input: ApprovalRequestInput): void => {
    const fail = (message: string): never => {
      // Programmer error on the ESCALATING side — never a wire condition.
      throw new RangeError(`invalid approval request (${input.source}): ${message}`);
    };
    if (typeof input.summary !== 'string' || input.summary.length === 0) {
      fail('a non-empty identifier-free summary is required');
    }
    if (!isAccountLabel(input.accountLabel)) fail('unknown account label');
    switch (input.source) {
      case 'can-use-tool':
      case 'hook-floor':
        if (input.sessionId === undefined) fail('sessionId is REQUIRED');
        if (input.toolName === undefined) fail('toolName is REQUIRED');
        if (input.runId !== undefined || input.stepId !== undefined) {
          fail('runId/stepId are workflow-gate-only');
        }
        break;
      case 'workflow-gate':
        if (input.runId === undefined || input.stepId === undefined) {
          fail('runId and stepId are REQUIRED');
        }
        if (input.toolName !== undefined || input.toolUseId !== undefined) {
          fail('toolName/toolUseId are forbidden on workflow gates');
        }
        break;
    }
  };

  return {
    request: (input) => {
      if (closed) {
        throw new KernelError('internal', 'approval broker is closed; escalation refused', {
          retryable: true,
        });
      }
      assertMatrix(input);

      const approvalId = newApprovalId();
      if (!APPROVAL_ID_RE.test(approvalId)) {
        throw new RangeError(`approval id factory produced an invalid id`);
      }
      const ttlMs = input.ttlMs === undefined ? defaultTtlMs : input.ttlMs;
      const expiresAt = ttlMs === null ? undefined : clock() + ttlMs;

      const request: ApprovalRequest = {
        kind: 'approval-request',
        approvalId,
        source: input.source,
        summary: input.summary,
        accountLabel: input.accountLabel,
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
        ...(input.toolUseId !== undefined ? { toolUseId: input.toolUseId } : {}),
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        ...(input.stepId !== undefined ? { stepId: input.stepId } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      };

      let resolve!: (resolution: ApprovalResolution) => void;
      const resolution = new Promise<ApprovalResolution>((res) => {
        resolve = res;
      });
      const entry: PendingEntry = { request, resolve, timer: undefined };
      pending.set(approvalId, entry);

      if (expiresAt !== undefined) {
        // Timeout POLICY: on expiry the broker resolves `expired` (§10.1).
        const timer = setTimeout(
          () => {
            if (pending.has(approvalId)) resolveEntry(entry, 'expired');
          },
          Math.max(0, expiresAt - clock()),
        );
        (timer as { unref?: () => void }).unref?.();
        entry.timer = timer;
      }

      fanOut(request);
      return { approvalId, request, resolution };
    },

    decide: (decision) => {
      if (decision.verdict !== 'allow' && decision.updatedInput !== undefined) {
        // Mirrors the frozen validator (golden fixture
        // `approval-decision-updated-input-on-deny`) — defense in depth for
        // in-process callers that bypass the gateway validators.
        throw new KernelError(
          'bad-request',
          'updatedInput relays a canUseTool replacement and is only legal with allow (§10.2)',
        );
      }
      const entry = pending.get(decision.approvalId);
      if (entry === undefined) {
        // NORMAL race (two windows; expiry vs. click) — deliberately distinct
        // from bad-request (ws-protocol.md §7).
        throw new KernelError(
          'approval-not-pending',
          `approval ${decision.approvalId} is not pending (unknown, already resolved, or expired)`,
        );
      }
      return resolveEntry(entry, decision.verdict === 'allow' ? 'allowed' : 'denied', {
        ...(decision.updatedInput !== undefined ? { updatedInput: decision.updatedInput } : {}),
        ...(decision.note !== undefined ? { note: decision.note } : {}),
      });
    },

    pending: () => [...pending.values()].map((entry) => entry.request),

    supersede: (approvalId) => {
      const entry = pending.get(approvalId);
      if (entry === undefined) return false;
      resolveEntry(entry, 'superseded');
      return true;
    },

    supersedeSession: (sessionId) => {
      let count = 0;
      for (const entry of [...pending.values()]) {
        if (entry.request.sessionId === sessionId) {
          resolveEntry(entry, 'superseded');
          count += 1;
        }
      }
      return count;
    },

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    close: () => {
      if (closed) return;
      closed = true;
      for (const entry of [...pending.values()]) {
        resolveEntry(entry, 'superseded');
      }
      listeners.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// canUseTool bridge (the SDK in-loop relay, wired by SessionKernel)
// ---------------------------------------------------------------------------

export interface CanUseToolBridgeContext {
  readonly sessionId: string;
  readonly accountLabel: AccountLabel;
  /** Per-session TTL override (see ApprovalRequestInput.ttlMs). */
  readonly ttlMs?: number | null;
}

/**
 * Build the per-session CanUseToolHandler: SDK escalation → broker request →
 * inbox decision → SDK PermissionResult. Deny is the fail-safe mapping for
 * every non-allowed outcome (expired/superseded prompts must never park a
 * session forever — CanUseTool contract, SDK 0.3.201).
 *
 * [X2]: the summary is built from the TOOL NAME only. Tool input routinely
 * carries absolute paths and command lines — it never reaches the wire here
 * (the inbox renders rich detail from hook-floor context at M3 instead).
 */
export function createCanUseToolBridge(
  broker: ApprovalBroker,
  context: CanUseToolBridgeContext,
): CanUseToolHandler {
  return async (toolName, input, callContext) => {
    const handle = broker.request({
      source: 'can-use-tool',
      summary: `tool escalation: ${toolName}`,
      accountLabel: context.accountLabel,
      sessionId: context.sessionId,
      toolName,
      ...(callContext.toolUseId !== undefined ? { toolUseId: callContext.toolUseId } : {}),
      ...(context.ttlMs !== undefined ? { ttlMs: context.ttlMs } : {}),
    });

    // The SDK aborts the wait when the operation is cancelled: the pending
    // approval's wait vanished → superseded (never left dangling in inboxes).
    const signal = callContext.signal;
    const onAbort = (): void => {
      broker.supersede(handle.approvalId);
    };
    if (signal !== undefined) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const resolution = await handle.resolution;
      switch (resolution.outcome) {
        case 'allowed':
          return {
            behavior: 'allow',
            updatedInput: { ...(resolution.updatedInput ?? input) },
          };
        case 'denied':
          return {
            behavior: 'deny',
            message: resolution.note ?? 'denied from the approval inbox',
          };
        case 'expired':
          return { behavior: 'deny', message: 'approval expired with no decision' };
        case 'superseded':
          return { behavior: 'deny', message: 'approval superseded (session or run ended)' };
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  };
}

// ---------------------------------------------------------------------------
// Kernel relay (the seam SessionKernel consumes — see sessionKernel.ts)
// ---------------------------------------------------------------------------

/**
 * The narrow surface the session kernel needs: a per-session handler factory
 * plus the session-death supersede hook. Kernel stays broker-agnostic; the
 * composition root builds this from the real broker.
 */
export interface KernelApprovalRelay {
  canUseToolFor(context: {
    readonly sessionId: string;
    readonly accountLabel: AccountLabel;
  }): CanUseToolHandler;
  sessionEnded(sessionId: string): void;
}

export function approvalRelayFromBroker(
  broker: ApprovalBroker,
  options: { readonly ttlMs?: number | null } = {},
): KernelApprovalRelay {
  return {
    canUseToolFor: (context) =>
      createCanUseToolBridge(broker, {
        sessionId: context.sessionId,
        accountLabel: context.accountLabel,
        ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
      }),
    sessionEnded: (sessionId) => {
      broker.supersedeSession(sessionId);
    },
  };
}
