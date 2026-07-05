/**
 * FE-4 graph island controller — wires the three contract stages together
 * (GraphStore → LayoutBridge → GraphRenderer) and owns the VIEW state:
 * layer toggles, cluster focus, reduced motion, and the camera controller
 * (Motion `animate()` through the renderer contract).
 *
 * Composition shape mirrors FE-3: `createGraphIsland` takes injectable
 * stages (unit suites drive fakes); `mountGraphIsland` (index.ts re-export)
 * is the real-environment entry building the Pixi renderer + module-worker
 * bridge + token theme from the container.
 *
 * Data flow per commit:
 *   store.applyTouches → (rAF/150 ms coalesce) → GraphMutationBatch
 *     → renderer.applyBatch  (spawn-at-referrer sprites, pulses)
 *     → bridge.applyBatch    (typed arrays → worker; ONE gentle reheat)
 *   bridge epochs → renderer.applyPositions (interpolated)
 *
 * REDUCED MOTION (day one): every commit settles off-screen (one converged
 * epoch — no live jiggle), entries render settled, pulses are discrete, and
 * the camera jump-cuts instead of flying (DESIGN.md §3.5).
 *
 * WORKER CRASH: the bridge degrades to settled synthetic epochs; this
 * controller keeps feeding the renderer — the island never white-screens
 * (plan §9.2 FE-4 negative row).
 */

import type { ContextGraphTouch } from '@aibender/protocol';
import { createCameraController, type CameraController } from './camera.ts';
import { createLayoutBridge, type LayoutBridgeOptions } from './layoutBridge.ts';
import { GraphStore, type CommitScheduler } from './store.ts';
import { createPixiGraphRenderer } from './pixiRenderer.ts';
import { readGraphTokenTheme, type GraphTokenTheme } from './theme.ts';
import { GRAPH_NODE_KINDS } from './types.ts';
import type {
  GraphNodeKind,
  GraphRenderStats,
  GraphRenderer,
  LayoutBridge,
  LayoutBridgeState,
  PositionEpoch,
} from './types.ts';

export interface GraphIslandOptions {
  container: HTMLElement;
  /** Injectable stages (defaults: Pixi renderer, module-worker bridge). */
  renderer?: GraphRenderer;
  bridge?: LayoutBridge;
  bridgeOptions?: LayoutBridgeOptions;
  theme?: GraphTokenTheme;
  schedule?: CommitScheduler;
  /** Explicit override; defaults to the token/media reduced-motion signal. */
  reducedMotion?: boolean;
  /** Spawn-jitter seed (tests pin it). */
  seed?: number;
}

export interface GraphIslandSnapshot {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly commitCount: number;
  readonly bridgeState: LayoutBridgeState;
  readonly lastEpochSeq: number;
  readonly reducedMotion: boolean;
  readonly visibleKinds: readonly GraphNodeKind[];
  readonly focusedCluster: string | undefined;
}

export interface GraphIslandHandle {
  /** The live feed intake (validated `context-touch` payloads). */
  applyTouches(touches: readonly ContextGraphTouch[]): void;
  /** Force the pending window to commit (tests, unmount). */
  commitNow(): void;
  /** Layer toggles — day-one hairball lever. */
  setLayerVisible(kind: GraphNodeKind, visible: boolean): void;
  /** Cluster-dim — day-one hairball lever (undefined clears). */
  focusCluster(cluster: string | undefined): void;
  /** Camera fly-to a node (Motion-eased; jump cut under reduced motion). */
  focusNode(nodeId: string, scale?: number): void;
  setReducedMotion(reduced: boolean): void;
  snapshot(): GraphIslandSnapshot;
  beginStats(): void;
  readStats(): GraphRenderStats;
  /** Camera moves that animated vs jump-cut (reduced-motion assertions). */
  cameraCounters(): { animated: number; jumpCuts: number };
  readonly store: GraphStore;
  readonly bridge: LayoutBridge;
  readonly renderer: GraphRenderer;
  /** Resolves when the renderer finished mounting. */
  readonly ready: Promise<void>;
  dispose(): void;
}

export function createGraphIsland(options: GraphIslandOptions): GraphIslandHandle {
  const theme = options.theme ?? readGraphTokenTheme(options.container);
  let reducedMotion = options.reducedMotion ?? theme.reducedMotion;

  const renderer = options.renderer ?? createPixiGraphRenderer({ theme });
  const bridge = options.bridge ?? createLayoutBridge(options.bridgeOptions ?? {});
  let lastEpoch: PositionEpoch | undefined;

  const store = new GraphStore({
    ...(options.schedule !== undefined ? { schedule: options.schedule } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    positionOf: (index) => {
      const live = renderer.positionOf(index);
      if (live !== undefined) return live;
      if (lastEpoch !== undefined && index < lastEpoch.nodeCount) {
        return {
          x: lastEpoch.positions[2 * index] ?? 0,
          y: lastEpoch.positions[2 * index + 1] ?? 0,
        };
      }
      return undefined;
    },
  });

  const visibleKinds = new Set<GraphNodeKind>(GRAPH_NODE_KINDS);
  let focusedCluster: string | undefined;

  const pushFilters = (): void => {
    renderer.applyFilters({ visibleKinds: new Set(visibleKinds), focusedCluster });
  };

  const camera: CameraController = createCameraController(renderer, {
    durationMs: theme.cameraEaseMs,
    ...(theme.cameraEase !== undefined ? { ease: theme.cameraEase } : {}),
    reducedMotion,
  });

  renderer.setReducedMotion(reducedMotion);

  const offBatch = store.onBatch((batch) => {
    renderer.applyBatch(batch);
    bridge.applyBatch(batch);
    // Reduced motion = settled layout: converge off-screen, one epoch,
    // no live jiggle (blueprint §8 / DESIGN.md §3.5).
    if (reducedMotion) bridge.settle();
  });

  const offEpoch = bridge.onEpoch((epoch) => {
    lastEpoch = epoch;
    renderer.applyPositions(epoch);
  });

  const ready = renderer.init(options.container);
  pushFilters();

  let disposed = false;

  return {
    store,
    bridge,
    renderer,
    ready,

    applyTouches(touches: readonly ContextGraphTouch[]): void {
      store.applyTouches(touches);
    },

    commitNow(): void {
      store.commitNow();
    },

    setLayerVisible(kind: GraphNodeKind, visible: boolean): void {
      if (visible) visibleKinds.add(kind);
      else visibleKinds.delete(kind);
      pushFilters();
    },

    focusCluster(cluster: string | undefined): void {
      focusedCluster = cluster;
      pushFilters();
    },

    focusNode(nodeId: string, scale = renderer.camera.scale): void {
      const node = store.nodeById(nodeId);
      if (node === undefined) return;
      const live = renderer.positionOf(node.index);
      const x = live?.x ?? node.spawnX;
      const y = live?.y ?? node.spawnY;
      camera.flyTo({ x, y, scale });
    },

    setReducedMotion(reduced: boolean): void {
      reducedMotion = reduced;
      renderer.setReducedMotion(reduced);
      camera.setReducedMotion(reduced);
      if (reduced) bridge.settle();
    },

    snapshot(): GraphIslandSnapshot {
      return {
        nodeCount: store.nodeCount,
        edgeCount: store.edgeCount,
        commitCount: store.commitCount,
        bridgeState: bridge.state,
        lastEpochSeq: bridge.lastEpochSeq,
        reducedMotion,
        visibleKinds: [...visibleKinds],
        focusedCluster,
      };
    },

    beginStats(): void {
      renderer.beginStats();
    },

    readStats(): GraphRenderStats {
      return renderer.readStats();
    },

    cameraCounters(): { animated: number; jumpCuts: number } {
      return { animated: camera.animatedMoves, jumpCuts: camera.jumpCuts };
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      camera.stop();
      offBatch();
      offEpoch();
      store.dispose();
      bridge.dispose();
      renderer.dispose();
    },
  };
}

/**
 * Real-environment entry: Pixi renderer + module-worker bridge + token theme
 * read from the container (DESIGN.md §8.5).
 */
export function mountGraphIsland(
  options: Pick<GraphIslandOptions, 'container' | 'reducedMotion' | 'seed'>,
): GraphIslandHandle {
  return createGraphIsland(options);
}
