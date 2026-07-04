/**
 * Context-graph activity read model at FE-2 depth: a bounded recent-touch
 * window + counters for the instrument surfaces. The real graph island
 * (FE-4, M3–M4) consumes the same wire feed through its own GraphStore —
 * this store deliberately stays tiny.
 *
 * Touches arrive rAF-batched from the binder (one `set()` per frame).
 */

import { createStore } from 'zustand/vanilla';
import type { ContextGraphTouch } from '@aibender/protocol';

export const MAX_RECENT_TOUCHES = 100;

export interface ContextGraphStoreState {
  readonly recent: readonly ContextGraphTouch[];
  readonly totalTouches: number;
  applyBatch(touches: readonly ContextGraphTouch[]): void;
  reset(): void;
}

export const contextGraphStore = createStore<ContextGraphStoreState>()((set) => ({
  recent: [],
  totalTouches: 0,

  applyBatch: (touches) => {
    if (touches.length === 0) return;
    set((s) => ({
      recent: [...s.recent, ...touches].slice(-MAX_RECENT_TOUCHES),
      totalTouches: s.totalTouches + touches.length,
    }));
  },

  reset: () => set({ recent: [], totalTouches: 0 }),
}));

export type ContextGraphStore = typeof contextGraphStore;
