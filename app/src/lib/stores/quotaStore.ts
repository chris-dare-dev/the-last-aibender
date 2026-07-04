/**
 * Quota gauge read model — latest snapshot per (account, window), mirroring
 * the `quota-snapshot` payload (ws-protocol.md §11). Absence of a snapshot
 * is a NO SIGNAL freshness state, never a fabricated zero (plan §9.2 BE-6
 * negative row applies to the render side too).
 */

import { createStore } from 'zustand/vanilla';
import type { AccountLabel, QuotaSnapshot, QuotaWindow } from '@aibender/protocol';

export type QuotaKey = `${AccountLabel}/${QuotaWindow}`;

export function quotaKey(account: AccountLabel, window: QuotaWindow): QuotaKey {
  return `${account}/${window}`;
}

export interface QuotaStoreState {
  readonly snapshots: Readonly<Partial<Record<QuotaKey, QuotaSnapshot>>>;
  apply(snapshot: QuotaSnapshot): void;
  reset(): void;
}

export const quotaStore = createStore<QuotaStoreState>()((set) => ({
  snapshots: {},

  apply: (snapshot) =>
    set((s) => {
      const key = quotaKey(snapshot.account, snapshot.window);
      const previous = s.snapshots[key];
      // Snapshots are monotone on capturedAt; a replayed older capture never
      // regresses the gauge.
      if (previous !== undefined && previous.capturedAt > snapshot.capturedAt) return s;
      return { snapshots: { ...s.snapshots, [key]: snapshot } };
    }),

  reset: () => set({ snapshots: {} }),
}));

export type QuotaStore = typeof quotaStore;
