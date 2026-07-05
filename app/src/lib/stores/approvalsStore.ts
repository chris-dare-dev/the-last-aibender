/**
 * THE single approval inbox read model (blueprint §4.1 two-layer permission
 * relay; plan FE-2 "the single approval inbox"). One store for every
 * escalation source — `can-use-tool`, `hook-floor`, `workflow-gate` — so
 * M3–M5 sources land without new UI surfaces.
 *
 * Approvals are attention-bearing and low-volume: they are applied
 * IMMEDIATELY (no rAF batching) so the inbox and the tray react within the
 * interaction latency budget.
 */

import { createStore } from 'zustand/vanilla';
import type { ApprovalOutcome, ApprovalRequest, ApprovalsServerPayload } from '@aibender/protocol';

export const MAX_RESOLVED_RETAINED = 50;

export interface PendingApproval {
  readonly request: ApprovalRequest;
  readonly receivedAtMs: number;
}

export interface ResolvedApproval {
  readonly approvalId: string;
  readonly outcome: ApprovalOutcome;
  readonly resolvedAtMs: number;
  /** The original request when it was still known to this window. */
  readonly request: ApprovalRequest | undefined;
}

export interface ApprovalsStoreState {
  readonly pending: Readonly<Record<string, PendingApproval>>;
  /** Stable arrival order (fixed positions — rows never reorder). */
  readonly order: readonly string[];
  readonly recentResolved: readonly ResolvedApproval[];
  /**
   * FE-2: approval ids whose decision has been SENT but whose broker-pushed
   * `approval-resolved` has not yet arrived (fire-and-forget on the approvals
   * channel — ws-protocol.md §10.2, no ack). While an id is in this set the
   * inbox hides/disables its row so a second click cannot double-send and the
   * row cannot stutter against the incoming resolve. Cleared when the resolve
   * lands (or on reset). Idempotent: marking an already-deciding id is a no-op.
   */
  readonly deciding: Readonly<Record<string, true>>;
  applyServer(message: ApprovalsServerPayload, nowMs: number): void;
  /** FE-2: mark an approval as decision-in-flight (before the fire-and-forget send). */
  markDeciding(approvalId: string): void;
  reset(): void;
}

export const approvalsStore = createStore<ApprovalsStoreState>()((set) => ({
  pending: {},
  order: [],
  recentResolved: [],
  deciding: {},

  applyServer: (message, nowMs) =>
    set((s) => {
      if (message.kind === 'approval-request') {
        if (message.approvalId in s.pending) return s; // replay overlap
        return {
          pending: {
            ...s.pending,
            [message.approvalId]: { request: message, receivedAtMs: nowMs },
          },
          order: [...s.order, message.approvalId],
        };
      }
      // approval-resolved — fan-out reaches every window incl. the decider.
      const entry = s.pending[message.approvalId];
      const pending = { ...s.pending };
      delete pending[message.approvalId];
      const resolved: ResolvedApproval = {
        approvalId: message.approvalId,
        outcome: message.outcome,
        resolvedAtMs: nowMs,
        request: entry?.request,
      };
      // FE-2: the in-flight decision (if any) is now settled — clear it.
      let deciding = s.deciding;
      if (message.approvalId in deciding) {
        const next = { ...deciding };
        delete next[message.approvalId];
        deciding = next;
      }
      return {
        pending,
        order: s.order.filter((id) => id !== message.approvalId),
        recentResolved: [...s.recentResolved, resolved].slice(-MAX_RESOLVED_RETAINED),
        deciding,
      };
    }),

  markDeciding: (approvalId) =>
    set((s) => {
      // Only pending, not-already-deciding approvals can enter the set.
      if (approvalId in s.deciding || !(approvalId in s.pending)) return s;
      return { deciding: { ...s.deciding, [approvalId]: true } };
    }),

  reset: () => set({ pending: {}, order: [], recentResolved: [], deciding: {} }),
}));

export type ApprovalsStore = typeof approvalsStore;

/**
 * Pending approvals in arrival order (the inbox row list). FE-2: an approval
 * whose decision is IN FLIGHT (`deciding`) is filtered out so its row cannot be
 * clicked again (no double-send) and cannot stutter between the send and the
 * broker's `approval-resolved` fan-out. The row reappears only via the resolve
 * path (as a `recentResolved` entry) — it never bounces back into pending.
 */
export function pendingApprovals(state: ApprovalsStoreState): readonly PendingApproval[] {
  const out: PendingApproval[] = [];
  for (const id of state.order) {
    if (id in state.deciding) continue; // FE-2: hide in-flight decisions
    const entry = state.pending[id];
    if (entry !== undefined) out.push(entry);
  }
  return out;
}
