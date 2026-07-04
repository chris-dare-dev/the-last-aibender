/**
 * FE-5 observability read-model store — the LATEST `read-model-snapshot`
 * per §6.3 dashboard lead (ws-protocol.md §13.2, FROZEN-M3), keyed by the
 * closed READ_MODEL_IDS registry.
 *
 * Discipline (plan §5 FE iron rules):
 *   - written ONLY through {@link ObservabilityStoreState.applyBatch} — one
 *     store write per rAF frame batch (bind.ts owns the projector); React
 *     render counts are bounded by frames, never by wire messages;
 *   - monotone on `capturedAt` per read model: a replayed older snapshot
 *     never regresses an instrument (same rule as lib quotaStore);
 *   - absence of a snapshot IS the NO SIGNAL state — nothing here fabricates
 *     zeros for a missing feed (plan §9.2 BE-6 negative row, render side).
 */

import { createStore } from 'zustand/vanilla';
import type { ReadModelId, ReadModelSnapshot } from '@aibender/protocol';

/** Latest snapshot per read model, typed by its discriminant. */
export type ReadModelSlots = {
  readonly [K in ReadModelId]?: Extract<ReadModelSnapshot, { readModel: K }>;
};

export interface ObservabilityStoreState {
  readonly snapshots: ReadModelSlots;
  /** Apply one frame batch (ONE store write — never call per message). */
  applyBatch(batch: readonly ReadModelSnapshot[]): void;
  reset(): void;
}

export const observabilityStore = createStore<ObservabilityStoreState>()((set) => ({
  snapshots: {},

  applyBatch: (batch) => {
    if (batch.length === 0) return;
    set((s) => {
      let changed = false;
      const next: Record<string, ReadModelSnapshot> = { ...s.snapshots };
      for (const snapshot of batch) {
        const previous = next[snapshot.readModel];
        // Monotone on capturedAt: replays and out-of-order pushes never
        // regress an instrument (ties refresh — same capture, newer arrival).
        if (previous !== undefined && previous.capturedAt > snapshot.capturedAt) continue;
        next[snapshot.readModel] = snapshot;
        changed = true;
      }
      return changed ? { snapshots: next as ReadModelSlots } : s;
    });
  },

  reset: () => set({ snapshots: {} }),
}));

export type ObservabilityStore = typeof observabilityStore;

/** Typed accessor for one read model's latest snapshot. */
export function latestSnapshot<K extends ReadModelId>(
  slots: ReadModelSlots,
  id: K,
): Extract<ReadModelSnapshot, { readModel: K }> | undefined {
  return slots[id];
}
