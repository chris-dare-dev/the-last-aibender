/**
 * Island mount seam. The three imperative islands (terminal/transcript —
 * FE-3; graph — FE-4) register themselves here, as does the FE-5
 * observability deck (`observability` slot, M3); chrome mounts whatever is
 * registered WITHOUT importing island/feature modules (directory-ownership
 * rule: chrome never reaches into app/src/islands or app/src/features).
 */

export type IslandSlot = 'terminal' | 'transcript' | 'graph' | 'observability';

export interface IslandMount {
  /**
   * Mount into the host element; returns an unmount function. The island
   * owns everything inside the element (imperative, framework-free).
   */
  mount(host: HTMLElement, context: { sessionId: string | undefined }): () => void;
}

const islands = new Map<IslandSlot, IslandMount>();
const listeners = new Set<() => void>();
let version = 0;

export function registerIsland(slot: IslandSlot, island: IslandMount): () => void {
  islands.set(slot, island);
  version += 1;
  listeners.forEach((fn) => fn());
  return () => {
    if (islands.get(slot) === island) {
      islands.delete(slot);
      version += 1;
      listeners.forEach((fn) => fn());
    }
  };
}

export function getIsland(slot: IslandSlot): IslandMount | undefined {
  return islands.get(slot);
}

/** useSyncExternalStore-compatible subscription. */
export function subscribeIslands(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function islandsVersion(): number {
  return version;
}

/** Test hook. */
export function resetIslandsForTest(): void {
  islands.clear();
  version += 1;
  listeners.forEach((fn) => fn());
}
