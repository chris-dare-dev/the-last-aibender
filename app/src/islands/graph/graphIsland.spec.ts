// @vitest-environment jsdom
/**
 * FE-4 island controller — GraphStore → LayoutBridge → GraphRenderer wiring
 * with injected fakes (the renderer/bridge PORTS are the seam; plan §9.2
 * FE-4 positive + reduced-motion edge rows).
 */

import { describe, expect, it } from 'vitest';
import type { ContextGraphTouch } from '@aibender/protocol';
import { createGraphIsland, type GraphIslandHandle } from './graphIsland.ts';
import type { CommitScheduler } from './store.ts';
import type { GraphTokenTheme } from './theme.ts';
import type {
  CameraPose,
  GraphMutationBatch,
  GraphRenderStats,
  GraphRenderer,
  GraphViewFilters,
  LayoutBridge,
  LayoutBridgeState,
  PositionEpoch,
} from './types.ts';

const touch = (
  sessionId: string,
  path: string,
  relation: ContextGraphTouch['relation'] = 'read',
): ContextGraphTouch => ({ kind: 'context-touch', sessionId, path, relation, ts: 1 });

function manualScheduler(): { schedule: CommitScheduler; flush: () => void } {
  const queue: Array<() => void> = [];
  return {
    schedule: ((cb: () => void) => {
      queue.push(cb);
      return () => {
        const i = queue.indexOf(cb);
        if (i !== -1) queue.splice(i, 1);
      };
    }) as CommitScheduler,
    flush: () => queue.shift()?.(),
  };
}

interface FakeRenderer extends GraphRenderer {
  batches: GraphMutationBatch[];
  epochs: PositionEpoch[];
  filters: GraphViewFilters[];
  cameras: CameraPose[];
  reduced: boolean[];
  disposed: number;
  positions: Map<number, { x: number; y: number }>;
}

function fakeRenderer(): FakeRenderer {
  let pose: CameraPose = { x: 0, y: 0, scale: 1 };
  const r: FakeRenderer = {
    batches: [],
    epochs: [],
    filters: [],
    cameras: [],
    reduced: [],
    disposed: 0,
    positions: new Map(),
    init: async () => undefined,
    applyBatch(batch) {
      r.batches.push(batch);
    },
    applyPositions(epoch) {
      r.epochs.push(epoch);
    },
    applyFilters(filters) {
      r.filters.push(filters);
    },
    setCamera(next) {
      pose = next;
      r.cameras.push(next);
    },
    get camera() {
      return pose;
    },
    setReducedMotion(reduced) {
      r.reduced.push(reduced);
    },
    positionOf(index) {
      return r.positions.get(index);
    },
    beginStats: () => undefined,
    readStats: (): GraphRenderStats => ({
      frames: 0,
      seconds: 0,
      fps: 0,
      frameMsMean: 0,
      frameMsP95: 0,
      pctOver16_7: 0,
      pctOver33_3: 0,
      epochsApplied: 0,
    }),
    resize: () => undefined,
    dispose() {
      r.disposed += 1;
    },
  };
  return r;
}

interface FakeBridge extends LayoutBridge {
  batches: GraphMutationBatch[];
  settles: number;
  disposed: number;
  emit(epoch: PositionEpoch): void;
}

function fakeBridge(): FakeBridge {
  const listeners = new Set<(epoch: PositionEpoch) => void>();
  const b: FakeBridge = {
    state: 'running' as LayoutBridgeState,
    lastEpochSeq: -1,
    batches: [],
    settles: 0,
    disposed: 0,
    applyBatch(batch) {
      b.batches.push(batch);
    },
    reheat: () => undefined,
    cooldown: () => undefined,
    settle() {
      b.settles += 1;
    },
    onEpoch(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onStateChange: () => () => undefined,
    dispose() {
      b.disposed += 1;
    },
    emit(epoch) {
      for (const l of listeners) l(epoch);
    },
  };
  return b;
}

const theme: GraphTokenTheme = {
  cameraEaseMs: 0, // jump-cut camera: assertions stay synchronous
  phosphorDecayMs: 640,
  reducedMotion: false,
};

function build(options: { reducedMotion?: boolean } = {}) {
  const renderer = fakeRenderer();
  const bridge = fakeBridge();
  const s = manualScheduler();
  const island: GraphIslandHandle = createGraphIsland({
    container: document.createElement('div'),
    renderer,
    bridge,
    theme,
    schedule: s.schedule,
    seed: 5,
    ...(options.reducedMotion !== undefined ? { reducedMotion: options.reducedMotion } : {}),
  });
  return { renderer, bridge, island, flush: s.flush };
}

describe('graph island — contract wiring', () => {
  it('one commit fans out to BOTH renderer and bridge (same batch object)', () => {
    const { renderer, bridge, island, flush } = build();
    island.applyTouches([touch('ses-a', '/synthetic/p/a.md')]);
    flush();
    expect(renderer.batches).toHaveLength(1);
    expect(bridge.batches).toHaveLength(1);
    expect(renderer.batches[0]).toBe(bridge.batches[0]);
    expect(island.snapshot().nodeCount).toBe(2);
    expect(bridge.settles).toBe(0); // full-motion path: no forced settle
  });

  it('bridge epochs flow to the renderer (interpolation input)', () => {
    const { renderer, bridge } = build();
    const epoch: PositionEpoch = {
      positions: new Float32Array([1, 2]),
      nodeCount: 1,
      seq: 4,
      alpha: 0.1,
    };
    bridge.emit(epoch);
    expect(renderer.epochs).toEqual([epoch]);
  });

  it('spawn positions prefer the RENDERER-shown referrer position', () => {
    const { renderer, island, flush } = build();
    island.applyTouches([touch('ses-a', '/synthetic/p/a.md')]);
    flush();
    renderer.positions.set(0, { x: 300, y: 400 }); // session drifted on screen
    island.applyTouches([touch('ses-a', '/synthetic/p/b.md')]);
    flush();
    const b = island.store.nodeById('file:/synthetic/p/b.md');
    expect(Math.abs((b?.spawnX ?? 0) - 300)).toBeLessThanOrEqual(12);
    expect(Math.abs((b?.spawnY ?? 0) - 400)).toBeLessThanOrEqual(12);
  });

  it('falls back to the last epoch position when the renderer has none', () => {
    const { bridge, island, flush } = build();
    island.applyTouches([touch('ses-a', '/synthetic/p/a.md')]);
    flush();
    bridge.emit({ positions: new Float32Array([50, 60, 70, 80]), nodeCount: 2, seq: 1, alpha: 0 });
    island.applyTouches([touch('ses-a', '/synthetic/p/c.md')]);
    flush();
    const c = island.store.nodeById('file:/synthetic/p/c.md');
    expect(Math.abs((c?.spawnX ?? 0) - 50)).toBeLessThanOrEqual(12);
    expect(Math.abs((c?.spawnY ?? 0) - 60)).toBeLessThanOrEqual(12);
  });
});

describe('graph island — view state (day-one hairball levers)', () => {
  it('layer toggles push atomic filter sets to the renderer', () => {
    const { renderer, island } = build();
    island.setLayerVisible('reference', false);
    const last = renderer.filters.at(-1);
    expect(last?.visibleKinds.has('reference')).toBe(false);
    expect(last?.visibleKinds.has('session')).toBe(true);
    island.setLayerVisible('reference', true);
    expect(renderer.filters.at(-1)?.visibleKinds.has('reference')).toBe(true);
    expect(island.snapshot().visibleKinds).toContain('reference');
  });

  it('cluster focus travels with the filters and clears with undefined', () => {
    const { renderer, island } = build();
    island.focusCluster('ses-a');
    expect(renderer.filters.at(-1)?.focusedCluster).toBe('ses-a');
    expect(island.snapshot().focusedCluster).toBe('ses-a');
    island.focusCluster(undefined);
    expect(renderer.filters.at(-1)?.focusedCluster).toBeUndefined();
  });

  it('focusNode drives the camera through the renderer contract', () => {
    const { renderer, island, flush } = build();
    island.applyTouches([touch('ses-a', '/synthetic/p/a.md')]);
    flush();
    renderer.positions.set(1, { x: 42, y: -7 });
    island.focusNode('file:/synthetic/p/a.md', 2);
    expect(renderer.cameras.at(-1)).toEqual({ x: 42, y: -7, scale: 2 });
    // Unknown nodes are a no-op — the camera NEVER moves on data noise.
    const moves = renderer.cameras.length;
    island.focusNode('file:/synthetic/p/nope.md');
    expect(renderer.cameras.length).toBe(moves);
  });
});

describe('graph island — reduced motion (day-one path)', () => {
  it('settles the layout per commit instead of live jiggle', () => {
    const { bridge, island, flush } = build({ reducedMotion: true });
    island.applyTouches([touch('ses-a', '/synthetic/p/a.md')]);
    flush();
    expect(bridge.settles).toBe(1);
    expect(island.snapshot().reducedMotion).toBe(true);
  });

  it('propagates the toggle to renderer + camera and settles immediately', () => {
    const { renderer, bridge, island } = build();
    expect(renderer.reduced.at(-1)).toBe(false);
    island.setReducedMotion(true);
    expect(renderer.reduced.at(-1)).toBe(true);
    expect(bridge.settles).toBe(1);
    // Camera jump-cuts from now on (duration already 0 in this theme, but
    // the flag alone must force the cut).
    island.applyTouches([touch('ses-a', '/synthetic/p/a.md')]);
    island.commitNow();
    island.focusNode('session:ses-a');
    expect(island.cameraCounters().jumpCuts).toBe(1);
    expect(island.cameraCounters().animated).toBe(0);
  });
});

describe('graph island — lifecycle', () => {
  it('dispose tears down store, bridge and renderer exactly once', () => {
    const { renderer, bridge, island } = build();
    island.dispose();
    island.dispose();
    expect(renderer.disposed).toBe(1);
    expect(bridge.disposed).toBe(1);
    // Post-dispose feeds are inert.
    island.applyTouches([touch('ses-a', '/synthetic/p/a.md')]);
    expect(island.snapshot().nodeCount).toBe(0);
  });

  it('snapshot mirrors the wired state', () => {
    const { bridge, island, flush } = build();
    island.applyTouches([touch('ses-a', '/synthetic/p/a.md')]);
    flush();
    bridge.emit({ positions: new Float32Array([0, 0, 0, 0]), nodeCount: 2, seq: 9, alpha: 0 });
    const snap = island.snapshot();
    expect(snap.nodeCount).toBe(2);
    expect(snap.edgeCount).toBe(1);
    expect(snap.commitCount).toBe(1);
    expect(snap.bridgeState).toBe('running');
    expect(snap.lastEpochSeq).toBe(-1); // fake bridge does not track seq
  });
});
