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
  applyServer(message: ApprovalsServerPayload, nowMs: number): void;
  reset(): void;
}

export const approvalsStore = createStore<ApprovalsStoreState>()((set) => ({
  pending: {},
  order: [],
  recentResolved: [],

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
      return {
        pending,
        order: s.order.filter((id) => id !== message.approvalId),
        recentResolved: [...s.recentResolved, resolved].slice(-MAX_RESOLVED_RETAINED),
      };
    }),

  reset: () => set({ pending: {}, order: [], recentResolved: [] }),
}));

export type ApprovalsStore = typeof approvalsStore;

/** Pending approvals in arrival order (the inbox row list). */
export function pendingApprovals(state: ApprovalsStoreState): readonly PendingApproval[] {
  const out: PendingApproval[] = [];
  for (const id of state.order) {
    const entry = state.pending[id];
    if (entry !== undefined) out.push(entry);
  }
  return out;
}
