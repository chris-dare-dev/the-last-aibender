/**
 * FE-4 GraphStore — the incremental-insertion protocol (plan §9.2 FE-4
 * positive row: "node/edge mutations coalesce per rAF/150 ms; new node
 * spawns at referrer").
 *
 * Scheduler is manual throughout: `flushes[i]()` IS the rAF/150 ms window
 * boundary, so coalescing is asserted deterministically.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ContextGraphTouch } from '@aibender/protocol';
import { livePopulationWaves, soakTouchScript } from './fixtures.ts';
import { GraphStore, artifactNodeId, sessionNodeId, type CommitScheduler } from './store.ts';
import type { GraphMutationBatch } from './types.ts';

const touch = (
  sessionId: string,
  path: string,
  relation: ContextGraphTouch['relation'] = 'read',
  ts = 1,
): ContextGraphTouch => ({ kind: 'context-touch', sessionId, path, relation, ts });

/** Manual scheduler capturing pending flushes. */
function manualScheduler(): { schedule: CommitScheduler; flush: () => void; pending: number } {
  const queue: Array<() => void> = [];
  const api = {
    schedule: ((cb: () => void) => {
      queue.push(cb);
      return () => {
        const i = queue.indexOf(cb);
        if (i !== -1) queue.splice(i, 1);
      };
    }) as CommitScheduler,
    flush: () => {
      const cb = queue.shift();
      cb?.();
    },
    get pending() {
      return queue.length;
    },
  };
  return api;
}

describe('GraphStore — coalescing', () => {
  it('coalesces many touches into ONE commit per window (never per-event)', () => {
    const s = manualScheduler();
    const store = new GraphStore({ schedule: s.schedule, seed: 7 });
    const batches: GraphMutationBatch[] = [];
    store.onBatch((b) => batches.push(b));

    store.applyTouches([touch('ses-a', '/synthetic/p/a.md')]);
    store.applyTouches([touch('ses-a', '/synthetic/p/b.md'), touch('ses-b', '/synthetic/p/a.md')]);
    expect(store.pending).toBe(3);
    expect(s.pending).toBe(1); // exactly one scheduled window, not three

    s.flush();
    expect(batches).toHaveLength(1);
    expect(store.commitCount).toBe(1);
    // ses-a, a.md, b.md, ses-b — one commit carries all four adds.
    expect(batches[0]?.addedNodes.map((n) => n.id)).toEqual([
      sessionNodeId('ses-a'),
      artifactNodeId('/synthetic/p/a.md'),
      artifactNodeId('/synthetic/p/b.md'),
      sessionNodeId('ses-b'),
    ]);
    expect(batches[0]?.addedEdges).toHaveLength(3);
    expect(store.nodeCount).toBe(4);
    expect(store.edgeCount).toBe(3);
  });

  it('empty windows emit nothing', () => {
    const s = manualScheduler();
    const store = new GraphStore({ schedule: s.schedule });
    const batches: GraphMutationBatch[] = [];
    store.onBatch((b) => batches.push(b));
    store.commitNow();
    expect(batches).toHaveLength(0);
    expect(store.commitCount).toBe(0);
  });
});

describe('GraphStore — spawn at referrer', () => {
  it('spawns a new artifact AT its session referrer (+ bounded jitter)', () => {
    const s = manualScheduler();
    const store = new GraphStore({ schedule: s.schedule, seed: 3 });
    store.applyTouches([touch('ses-a', '/synthetic/p/a.md')]);
    s.flush();
    const ses = store.nodeById(sessionNodeId('ses-a'));
    const file = store.nodeById(artifactNodeId('/synthetic/p/a.md'));
    expect(ses).toBeDefined();
    expect(file).toBeDefined();
    // Jitter radius is 12 per axis — never an origin fling from a distant referrer.
    expect(Math.abs((file?.spawnX ?? 0) - (ses?.spawnX ?? 0))).toBeLessThanOrEqual(12);
    expect(Math.abs((file?.spawnY ?? 0) - (ses?.spawnY ?? 0))).toBeLessThanOrEqual(12);
  });

  it('prefers the LIVE layout position of the referrer when available', () => {
    const s = manualScheduler();
    const live = { x: 500, y: -250 };
    const store = new GraphStore({
      schedule: s.schedule,
      seed: 3,
      positionOf: (index) => (index === 0 ? live : undefined),
    });
    store.applyTouches([touch('ses-a', '/synthetic/p/a.md')]);
    s.flush();
    // Second file spawns near the session's LIVE position, not its old spawn.
    store.applyTouches([touch('ses-a', '/synthetic/p/b.md')]);
    s.flush();
    const b = store.nodeById(artifactNodeId('/synthetic/p/b.md'));
    expect(Math.abs((b?.spawnX ?? 0) - live.x)).toBeLessThanOrEqual(12);
    expect(Math.abs((b?.spawnY ?? 0) - live.y)).toBeLessThanOrEqual(12);
  });

  it('a NEW session touching an EXISTING artifact spawns at that artifact', () => {
    const s = manualScheduler();
    const store = new GraphStore({ schedule: s.schedule, seed: 3 });
    store.applyTouches([touch('ses-a', '/synthetic/p/a.md')]);
    s.flush();
    const file = store.nodeById(artifactNodeId('/synthetic/p/a.md'));
    store.applyTouches([touch('ses-b', '/synthetic/p/a.md')]);
    s.flush();
    const sesB = store.nodeById(sessionNodeId('ses-b'));
    expect(Math.abs((sesB?.spawnX ?? 0) - (file?.spawnX ?? 0))).toBeLessThanOrEqual(12);
    expect(Math.abs((sesB?.spawnY ?? 0) - (file?.spawnY ?? 0))).toBeLessThanOrEqual(12);
  });
});

describe('GraphStore — pulses (amber = actively-touched artifact ONLY)', () => {
  it('pulses re-touched artifacts, never new nodes, never sessions', () => {
    const s = manualScheduler();
    const store = new GraphStore({ schedule: s.schedule });
    const batches: GraphMutationBatch[] = [];
    store.onBatch((b) => batches.push(b));

    store.applyTouches([touch('ses-a', '/synthetic/p/a.md')]);
    s.flush();
    expect(batches[0]?.pulses).toEqual([]); // first touch = enter, not pulse

    store.applyTouches([
      touch('ses-a', '/synthetic/p/a.md'), // re-touch → pulse
      touch('ses-a', '/synthetic/p/b.md'), // new artifact → NO pulse
    ]);
    s.flush();
    const aIndex = store.nodeById(artifactNodeId('/synthetic/p/a.md'))?.index;
    expect(batches[1]?.pulses).toEqual([aIndex]);
  });

  it('deduplicates pulses within one window', () => {
    const s = manualScheduler();
    const store = new GraphStore({ schedule: s.schedule });
    const batches: GraphMutationBatch[] = [];
    store.onBatch((b) => batches.push(b));
    store.applyTouches([touch('ses-a', '/synthetic/p/a.md')]);
    s.flush();
    store.applyTouches([
      touch('ses-a', '/synthetic/p/a.md', 'read', 2),
      touch('ses-b', '/synthetic/p/a.md', 'read', 3),
      touch('ses-a', '/synthetic/p/a.md', 'watched', 4),
    ]);
    s.flush();
    expect(batches[1]?.pulses).toHaveLength(1);
  });
});

describe('GraphStore — retag + edge accumulation', () => {
  it('write on an existing reference retags to agent-artifact (once)', () => {
    const s = manualScheduler();
    const store = new GraphStore({ schedule: s.schedule });
    const batches: GraphMutationBatch[] = [];
    store.onBatch((b) => batches.push(b));
    store.applyTouches([touch('ses-a', '/synthetic/p/a.md', 'read')]);
    s.flush();
    store.applyTouches([touch('ses-a', '/synthetic/p/a.md', 'write', 2)]);
    s.flush();
    const idx = store.nodeById(artifactNodeId('/synthetic/p/a.md'))?.index;
    expect(batches[1]?.retagged).toEqual([{ index: idx, kind: 'agent-artifact' }]);
    // Second write: kind already upgraded — no retag row.
    store.applyTouches([touch('ses-a', '/synthetic/p/a.md', 'write', 3)]);
    s.flush();
    expect(batches[2]?.retagged).toEqual([]);
  });

  it('repeat touches accumulate on the SAME edge (no multi-edges)', () => {
    const s = manualScheduler();
    const store = new GraphStore({ schedule: s.schedule });
    store.applyTouches([touch('ses-a', '/synthetic/p/a.md', 'read', 1)]);
    s.flush();
    store.applyTouches([
      touch('ses-a', '/synthetic/p/a.md', 'write', 5),
      touch('ses-a', '/synthetic/p/a.md', 'read', 3),
    ]);
    s.flush();
    expect(store.edgeCount).toBe(1);
    const attrs = store.graph.getEdgeAttributes(
      sessionNodeId('ses-a'),
      artifactNodeId('/synthetic/p/a.md'),
    );
    expect(attrs.count).toBe(3);
    expect(attrs.relations.sort()).toEqual(['read', 'write']);
    expect(attrs.lastTs).toBe(5); // max, not last-seen
  });
});

describe('GraphStore — lifecycle', () => {
  it('reset clears every projection; indexes restart dense from 0', () => {
    const s = manualScheduler();
    const store = new GraphStore({ schedule: s.schedule });
    store.applyTouches([touch('ses-a', '/synthetic/p/a.md')]);
    s.flush();
    store.applyTouches([touch('ses-a', '/synthetic/p/b.md')]);
    store.reset();
    expect(store.nodeCount).toBe(0);
    expect(store.pending).toBe(0);
    store.applyTouches([touch('ses-z', '/synthetic/p/z.md')]);
    s.flush();
    expect(store.nodeById(sessionNodeId('ses-z'))?.index).toBe(0);
  });

  it('dispose commits the pending window once, then ignores touches', () => {
    const s = manualScheduler();
    const store = new GraphStore({ schedule: s.schedule });
    const batches: GraphMutationBatch[] = [];
    store.onBatch((b) => batches.push(b));
    store.applyTouches([touch('ses-a', '/synthetic/p/a.md')]);
    store.dispose();
    expect(batches).toHaveLength(1); // final flush on dispose
    store.applyTouches([touch('ses-a', '/synthetic/p/b.md')]);
    s.flush();
    expect(store.nodeCount).toBe(2); // unchanged — post-dispose touches dropped
  });

  it('listener errors do not corrupt the queue (listeners are snapshotted)', () => {
    const s = manualScheduler();
    const store = new GraphStore({ schedule: s.schedule });
    const seen: number[] = [];
    const off = store.onBatch(() => {
      off(); // unsubscribe DURING emit
      seen.push(1);
    });
    store.onBatch(() => seen.push(2));
    store.applyTouches([touch('ses-a', '/synthetic/p/a.md')]);
    s.flush();
    expect(seen).toEqual([1, 2]);
  });
});

describe('GraphStore — fixture invariants', () => {
  it('live-population waves land on the documented cumulative counts', () => {
    const s = manualScheduler();
    const store = new GraphStore({ schedule: s.schedule, seed: 11 });
    const waves = livePopulationWaves();
    const expected = [
      { nodes: 4, edges: 3 },
      { nodes: 7, edges: 6 },
      { nodes: 10, edges: 8 },
    ];
    waves.forEach((wave, i) => {
      store.applyTouches(wave);
      s.flush();
      expect({ nodes: store.nodeCount, edges: store.edgeCount }).toEqual({
        nodes: expected[i]?.nodes,
        edges: expected[i]?.edges,
      });
    });
  });

  it('the 5k/8k soak script lands on EXACTLY 5000 nodes / 8000 edges', () => {
    const script = soakTouchScript(); // defaults = the spike-B ceiling
    const store = new GraphStore({ schedule: manualScheduler().schedule, seed: 1 });
    store.applyTouches(script.touches);
    store.commitNow();
    expect(store.nodeCount).toBe(5000);
    expect(store.edgeCount).toBe(8000);
    expect(script.nodeCount).toBe(5000);
    expect(script.edgeCount).toBe(8000);
  });
});

describe('GraphStore — OS-5 recency eviction', () => {
  // Each touch names a unique session + a unique file → 2 nodes, 1 edge per
  // touch, so `n` distinct touches build 2n nodes deterministically.
  const distinct = (n: number, startTs = 1): ContextGraphTouch[] =>
    Array.from({ length: n }, (_, i) => touch(`ses-${i}`, `/synthetic/f-${i}.md`, 'read', startTs + i));

  it('is UNBOUNDED by default — the 5k soak keeps its exact count', () => {
    const store = new GraphStore({ schedule: manualScheduler().schedule });
    expect(store.maxNodeCount).toBe(Infinity);
  });

  it('never exceeds the ceiling after a commit, and reports removedNodes', () => {
    const s = manualScheduler();
    const store = new GraphStore({ schedule: s.schedule, maxNodes: 6 });
    const batches: GraphMutationBatch[] = [];
    store.onBatch((b) => batches.push(b));

    // 5 distinct touches = 10 nodes → 4 over the ceiling of 6.
    store.applyTouches(distinct(5));
    s.flush();

    expect(store.nodeCount).toBe(6);
    expect(store.nodeCount).toBeLessThanOrEqual(store.maxNodeCount);
    expect(batches[0]?.removedNodes).toHaveLength(4);
    // The commit reported at most `ceiling` live nodes as net-added.
    expect(batches[0]?.nodeCount).toBe(6);
  });

  it('evicts the LEAST-recently-touched nodes first (ascending ts)', () => {
    const s = manualScheduler();
    const store = new GraphStore({ schedule: s.schedule, maxNodes: 4 });

    // Window 1: two sessions each touching one file at ascending ts.
    //   ses-old @1 → f-old   (oldest)
    //   ses-new @9 → f-new   (newest)
    store.applyTouches([
      touch('ses-old', '/synthetic/old.md', 'read', 1),
      touch('ses-new', '/synthetic/new.md', 'read', 9),
    ]);
    s.flush();
    expect(store.nodeCount).toBe(4); // exactly the ceiling, no eviction yet

    // Window 2: one more session+file at the NEWEST ts → 6 nodes, 2 over.
    // The two OLDEST-touched (ses-old @1, old.md @1) must be the victims.
    const batches: GraphMutationBatch[] = [];
    store.onBatch((b) => batches.push(b));
    store.applyTouches([touch('ses-z', '/synthetic/z.md', 'read', 20)]);
    s.flush();

    expect(store.nodeCount).toBe(4);
    expect(store.nodeById(sessionNodeId('ses-old'))).toBeUndefined();
    expect(store.nodeById(artifactNodeId('/synthetic/old.md'))).toBeUndefined();
    // The newer set survives.
    expect(store.nodeById(sessionNodeId('ses-new'))).toBeDefined();
    expect(store.nodeById(artifactNodeId('/synthetic/new.md'))).toBeDefined();
    expect(store.nodeById(sessionNodeId('ses-z'))).toBeDefined();
    expect(batches[0]?.removedNodes).toHaveLength(2);
  });

  it('a re-touched node is protected from eviction (recency refresh)', () => {
    const s = manualScheduler();
    const store = new GraphStore({ schedule: s.schedule, maxNodes: 4 });
    // Build the oldest artifact first.
    store.applyTouches([touch('ses-a', '/synthetic/keep.md', 'read', 1)]);
    s.flush();
    // A second, newer session+file.
    store.applyTouches([touch('ses-b', '/synthetic/other.md', 'read', 5)]);
    s.flush();
    expect(store.nodeCount).toBe(4);

    // Re-touch the OLDEST artifact at the newest ts — it must now outrank the
    // ses-a session (ts 1) as the eviction candidate.
    store.applyTouches([
      touch('ses-c', '/synthetic/keep.md', 'read', 30), // re-touch keep.md (+ new session ses-c)
    ]);
    s.flush();

    expect(store.nodeCount).toBe(4);
    // keep.md was re-touched at ts 30 → survives.
    expect(store.nodeById(artifactNodeId('/synthetic/keep.md'))).toBeDefined();
    // ses-a (ts 1) was the least-recent → evicted.
    expect(store.nodeById(sessionNodeId('ses-a'))).toBeUndefined();
  });

  it('drops incident edges of an evicted node (live edgeCount shrinks)', () => {
    const s = manualScheduler();
    const store = new GraphStore({ schedule: s.schedule, maxNodes: 4 });
    // Two independent session↔file pairs = 4 nodes / 2 edges.
    store.applyTouches([
      touch('ses-old', '/synthetic/old.md', 'read', 1),
      touch('ses-new', '/synthetic/new.md', 'read', 9),
    ]);
    s.flush();
    expect(store.edgeCount).toBe(2);

    // Push over: the ses-old pair (+ its 1 edge) is evicted.
    store.applyTouches([touch('ses-z', '/synthetic/z.md', 'read', 20)]);
    s.flush();
    expect(store.nodeCount).toBe(4);
    expect(store.edgeCount).toBe(2); // old edge gone, z edge added
  });

  it('keeps the dense index axis stable (indexCount grows, nodeCount bounded)', () => {
    const s = manualScheduler();
    const store = new GraphStore({ schedule: s.schedule, maxNodes: 4 });
    const batches: GraphMutationBatch[] = [];
    store.onBatch((b) => batches.push(b));

    // 6 distinct touches over several windows = 12 nodes total assigned.
    for (let i = 0; i < 6; i++) {
      store.applyTouches([touch(`ses-${i}`, `/synthetic/f-${i}.md`, 'read', i + 1)]);
      s.flush();
    }
    // Live count is pinned at the ceiling…
    expect(store.nodeCount).toBe(4);
    // …but the dense high-water keeps climbing (12 total indices assigned):
    // a survivor's layout offset never shifts.
    const last = batches[batches.length - 1];
    expect(last?.indexCount).toBe(12);
    expect(last?.indexCount).toBeGreaterThan(last?.nodeCount ?? 0);
    // nodeByIndex tolerates tombstoned slots (returns undefined, never throws).
    expect(store.nodeByIndex(0)).toBeUndefined(); // ses-0 was evicted long ago
  });

  it('reconciles a single over-ceiling batch: never adds AND removes a node', () => {
    const s = manualScheduler();
    const store = new GraphStore({ schedule: s.schedule, maxNodes: 3 });
    const batches: GraphMutationBatch[] = [];
    store.onBatch((b) => batches.push(b));

    // One window with 5 distinct touches = 10 nodes, ceiling 3.
    store.applyTouches(distinct(5));
    s.flush();

    expect(store.nodeCount).toBe(3);
    const b = batches[0];
    expect(b).toBeDefined();
    // No index appears in both addedNodes and removedNodes.
    const added = new Set(b?.addedNodes.map((n) => n.index));
    for (const idx of b?.removedNodes ?? []) expect(added.has(idx)).toBe(false);
    // Every reported added edge references only surviving (net-added or extant) indices.
    const removed = new Set(b?.removedNodes ?? []);
    for (const e of b?.addedEdges ?? []) {
      expect(removed.has(e.sourceIndex)).toBe(false);
      expect(removed.has(e.targetIndex)).toBe(false);
    }
  });

  it('rejects a ceiling below 1', () => {
    expect(() => new GraphStore({ maxNodes: 0 })).toThrow(/maxNodes/);
  });

  it('reset restores an unevicted dense axis from 0', () => {
    const s = manualScheduler();
    const store = new GraphStore({ schedule: s.schedule, maxNodes: 4 });
    store.applyTouches(distinct(5));
    s.flush();
    expect(store.nodeCount).toBe(4);
    store.reset();
    store.applyTouches([touch('ses-fresh', '/synthetic/fresh.md', 'read', 1)]);
    s.flush();
    // Index restarts dense from 0 after reset.
    expect(store.nodeById(sessionNodeId('ses-fresh'))?.index).toBe(0);
    expect(store.nodeCount).toBe(2);
  });
});

describe('GraphStore — default scheduler shape', () => {
  it('falls back to the 150 ms window where rAF is absent', async () => {
    vi.useFakeTimers();
    try {
      const store = new GraphStore(); // node env: no requestAnimationFrame
      const batches: GraphMutationBatch[] = [];
      store.onBatch((b) => batches.push(b));
      store.applyTouches([touch('ses-a', '/synthetic/p/a.md')]);
      expect(batches).toHaveLength(0);
      vi.advanceTimersByTime(149);
      expect(batches).toHaveLength(0);
      vi.advanceTimersByTime(1);
      expect(batches).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
