// @vitest-environment jsdom
/**
 * FE-4 registration — the chrome integration seam (islandRegistry slot
 * `graph`), the live feed per mount, the warm-start window, and the
 * broker-restart REBUILD (stale projection → fresh scene, never a
 * half-stale mutation).
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { ContextGraphTouch } from '@aibender/protocol';
import { allCommands } from '../../chrome/commands.ts';
import { getIsland, resetIslandsForTest } from '../../chrome/islandRegistry.ts';
import type { ClientEvents } from '../../lib/index.ts';
import { GraphStore } from './store.ts';
import type { GraphIslandHandle } from './graphIsland.ts';
import { FOCUS_GRAPH_COMMAND_ID, registerGraphIsland } from './register.ts';

function fakeClient() {
  const listeners = new Set<ClientEvents>();
  return {
    subscribe(listener: ClientEvents): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    touch(payload: ContextGraphTouch): void {
      for (const l of listeners) {
        l.onMessage?.({ kind: 'context-graph', channel: 'context-graph', seq: 1, payload } as never);
      }
    },
    restart(): void {
      for (const l of listeners) l.onBrokerRestart?.();
    },
    get subscriberCount(): number {
      return listeners.size;
    },
  };
}

const touch = (path: string): ContextGraphTouch => ({
  kind: 'context-touch',
  sessionId: 'ses-a',
  path,
  relation: 'read',
  ts: 1,
});

/** Island fake with a REAL store (commit synchronously) — no Pixi, no worker. */
function fakeIslandFactory() {
  const created: Array<{ handle: GraphIslandHandle; disposed: () => boolean }> = [];
  const create = (host: HTMLElement): GraphIslandHandle => {
    const store = new GraphStore({
      schedule: (flush) => {
        flush();
        return () => undefined;
      },
    });
    let disposed = false;
    const canvas = host.ownerDocument.createElement('canvas');
    host.appendChild(canvas);
    const handle = {
      store,
      applyTouches: (t: readonly ContextGraphTouch[]) => store.applyTouches(t),
      commitNow: () => store.commitNow(),
      setLayerVisible: () => undefined,
      focusCluster: () => undefined,
      focusNode: () => undefined,
      setReducedMotion: () => undefined,
      snapshot: () => ({
        nodeCount: store.nodeCount,
        edgeCount: store.edgeCount,
        commitCount: store.commitCount,
        bridgeState: 'running' as const,
        lastEpochSeq: -1,
        reducedMotion: false,
        visibleKinds: [],
        focusedCluster: undefined,
      }),
      beginStats: () => undefined,
      readStats: () => ({
        frames: 0,
        seconds: 0,
        fps: 0,
        frameMsMean: 0,
        frameMsP95: 0,
        pctOver16_7: 0,
        pctOver33_3: 0,
        epochsApplied: 0,
      }),
      cameraCounters: () => ({ animated: 0, jumpCuts: 0 }),
      bridge: undefined as never,
      renderer: undefined as never,
      ready: Promise.resolve(),
      dispose: () => {
        disposed = true;
        store.dispose();
      },
    } as unknown as GraphIslandHandle;
    created.push({ handle, disposed: () => disposed });
    return handle;
  };
  return { create, created };
}

afterEach(() => {
  resetIslandsForTest();
});

describe('registerGraphIsland', () => {
  it('occupies the graph slot and registers the palette verb; dispose reverses both', () => {
    const client = fakeClient();
    const factory = fakeIslandFactory();
    const dispose = registerGraphIsland(client, {
      createIsland: factory.create,
      seedTouches: () => [],
    });
    expect(getIsland('graph')).toBeDefined();
    expect(allCommands().some((c) => c.id === FOCUS_GRAPH_COMMAND_ID)).toBe(true);
    dispose();
    expect(getIsland('graph')).toBeUndefined();
    expect(allCommands().some((c) => c.id === FOCUS_GRAPH_COMMAND_ID)).toBe(false);
  });

  it('mount: warm-starts from the seed window, then goes live on the wire', () => {
    const client = fakeClient();
    const factory = fakeIslandFactory();
    registerGraphIsland(client, {
      createIsland: factory.create,
      seedTouches: () => [touch('/synthetic/p/seeded.md')],
    });
    const host = document.createElement('div');
    const unmount = getIsland('graph')?.mount(host, { sessionId: undefined });
    const island = factory.created[0]?.handle;
    expect(island?.store.nodeCount).toBe(2); // seeded ses-a + file
    client.touch(touch('/synthetic/p/live.md'));
    expect(island?.store.nodeCount).toBe(3); // live touch landed
    // The island rendered INSIDE the host (canvas) + the control strip.
    expect(host.querySelector('canvas')).not.toBeNull();
    expect(host.querySelector('[data-testid="graph-controls"]')).not.toBeNull();
    unmount?.();
  });

  it('broker restart REBUILDS the island in place (fresh scene, feed keeps flowing)', () => {
    const client = fakeClient();
    const factory = fakeIslandFactory();
    registerGraphIsland(client, { createIsland: factory.create, seedTouches: () => [] });
    const host = document.createElement('div');
    const unmount = getIsland('graph')?.mount(host, { sessionId: undefined });
    client.touch(touch('/synthetic/p/old-boot.md'));
    expect(factory.created[0]?.handle.store.nodeCount).toBe(2);

    client.restart();
    expect(factory.created).toHaveLength(2); // rebuilt
    expect(factory.created[0]?.disposed()).toBe(true); // old scene torn down
    expect(factory.created[1]?.handle.store.nodeCount).toBe(0); // fresh
    // Feed continues into the NEW island without re-subscribing.
    client.touch(touch('/synthetic/p/new-boot.md'));
    expect(factory.created[1]?.handle.store.nodeCount).toBe(2);
    // Exactly one control strip in the host (no strip leak across rebuilds).
    expect(host.querySelectorAll('[data-testid="graph-controls"]')).toHaveLength(1);
    unmount?.();
  });

  it('unmount disposes the island and unbinds the feed', () => {
    const client = fakeClient();
    const factory = fakeIslandFactory();
    registerGraphIsland(client, { createIsland: factory.create, seedTouches: () => [] });
    const host = document.createElement('div');
    const unmount = getIsland('graph')?.mount(host, { sessionId: undefined });
    expect(client.subscriberCount).toBe(1);
    unmount?.();
    expect(client.subscriberCount).toBe(0);
    expect(factory.created[0]?.disposed()).toBe(true);
    expect(host.childElementCount).toBe(0);
    // A restart after unmount must not resurrect anything.
    client.restart();
    expect(factory.created).toHaveLength(1);
  });

  it('the control strip drives the island layers and readout', () => {
    const client = fakeClient();
    const factory = fakeIslandFactory();
    registerGraphIsland(client, { createIsland: factory.create, seedTouches: () => [] });
    const host = document.createElement('div');
    getIsland('graph')?.mount(host, { sessionId: undefined });
    client.touch(touch('/synthetic/p/a.md'));
    const readout = host.querySelector('[data-testid="graph-readout"]');
    expect(readout?.textContent).toBe('N 2 · E 1'); // refreshed per commit
  });
});
