/**
 * FE-4 graph island — in-page Playwright harness (built by pw/vite.config.ts,
 * driven by pw/run-pw.ts on Chromium + WebKit).
 *
 * Exposes `window.__fe4graph`: create/dispose the REAL island (Pixi v8
 * renderer + d3-force MODULE worker + token theme from the real generated
 * tokens.css), stream fixture touches, read snapshots/probes, crash the
 * worker on demand, and run the 5k-node soak with honest fps stats.
 */

import '../../../chrome/theme/tokens.css';
import type { ContextGraphTouch } from '@aibender/protocol';
import { chunked, livePopulationWaves, soakTouchScript } from '../fixtures.ts';
import { createGraphIsland, type GraphIslandHandle } from '../graphIsland.ts';
import { createLayoutWorker, type LayoutWorkerLike } from '../layoutBridge.ts';
import type { PixiGraphRenderer } from '../pixiRenderer.ts';
import { readGraphTokenTheme } from '../theme.ts';
import type { GraphNodeKind, GraphRenderStats, PositionEpoch } from '../types.ts';

interface EpochRow {
  seq: number;
  n: number;
  alpha: number;
  len: number;
  isFloat32: boolean;
}

interface BatchRow {
  addedNodes: number;
  addedEdges: number;
  pulses: number[];
  retagged: Array<{ index: number; kind: GraphNodeKind }>;
}

interface HarnessSnapshot {
  nodeCount: number;
  edgeCount: number;
  commitCount: number;
  bridgeState: string;
  lastEpochSeq: number;
  reducedMotion: boolean;
  visibleKinds: GraphNodeKind[];
  focusedCluster: string | undefined;
  canvasCount: number;
  epochRows: EpochRow[];
  batchRows: BatchRow[];
  cameraCounters: { animated: number; jumpCuts: number };
  camera: { x: number; y: number; scale: number };
  errors: string[];
}

interface RendererIdentity {
  glVersion: string;
  vendor: string;
  renderer: string;
  devicePixelRatio: number;
  antialiasAttr: boolean | undefined;
}

const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

let island: GraphIslandHandle | undefined;
let liveWorker: LayoutWorkerLike | undefined;
let epochRows: EpochRow[] = [];
let batchRows: BatchRow[] = [];
let offEpoch: (() => void) | undefined;
let offBatch: (() => void) | undefined;
let heatTimer: ReturnType<typeof setInterval> | undefined;

const stage = (): HTMLElement => {
  const el = document.getElementById('stage');
  if (el === null) throw new Error('missing #stage');
  return el;
};

const pixi = (): PixiGraphRenderer => {
  if (island === undefined) throw new Error('no island');
  return island.renderer as PixiGraphRenderer;
};

function recordEpoch(epoch: PositionEpoch): void {
  epochRows.push({
    seq: epoch.seq,
    n: epoch.nodeCount,
    alpha: epoch.alpha,
    len: epoch.positions.length,
    isFloat32: epoch.positions instanceof Float32Array,
  });
  if (epochRows.length > 400) epochRows.splice(0, epochRows.length - 400);
}

async function create(options: {
  reducedMotion?: boolean;
  seed?: number;
  width?: number;
  height?: number;
  epochIntervalMs?: number;
} = {}): Promise<void> {
  dispose();
  const host = stage();
  if (options.width !== undefined) host.style.width = `${options.width}px`;
  if (options.height !== undefined) host.style.height = `${options.height}px`;
  epochRows = [];
  batchRows = [];
  island = createGraphIsland({
    container: host,
    seed: options.seed ?? 7,
    ...(options.reducedMotion !== undefined ? { reducedMotion: options.reducedMotion } : {}),
    bridgeOptions: {
      createWorker: () => {
        liveWorker = createLayoutWorker();
        return liveWorker;
      },
      ...(options.epochIntervalMs !== undefined
        ? { epochIntervalMs: options.epochIntervalMs }
        : {}),
    },
  });
  offEpoch = island.bridge.onEpoch(recordEpoch);
  offBatch = island.store.onBatch((batch) => {
    batchRows.push({
      addedNodes: batch.addedNodes.length,
      addedEdges: batch.addedEdges.length,
      pulses: [...batch.pulses],
      retagged: batch.retagged.map((r) => ({ index: r.index, kind: r.kind })),
    });
  });
  await island.ready;
}

function dispose(): void {
  if (heatTimer !== undefined) {
    clearInterval(heatTimer);
    heatTimer = undefined;
  }
  offEpoch?.();
  offBatch?.();
  offEpoch = undefined;
  offBatch = undefined;
  island?.dispose();
  island = undefined;
  liveWorker = undefined;
  stage().replaceChildren();
}

function snapshot(): HarnessSnapshot {
  if (island === undefined) throw new Error('no island');
  const snap = island.snapshot();
  return {
    nodeCount: snap.nodeCount,
    edgeCount: snap.edgeCount,
    commitCount: snap.commitCount,
    bridgeState: snap.bridgeState,
    lastEpochSeq: snap.lastEpochSeq,
    reducedMotion: snap.reducedMotion,
    visibleKinds: [...snap.visibleKinds],
    focusedCluster: snap.focusedCluster,
    canvasCount: stage().querySelectorAll('canvas').length,
    epochRows: [...epochRows],
    batchRows: [...batchRows],
    cameraCounters: island.cameraCounters(),
    camera: { ...island.renderer.camera },
    errors: [...errors],
  };
}

function rendererIdentity(): RendererIdentity {
  const canvas = stage().querySelector('canvas');
  if (canvas === null) throw new Error('no canvas');
  const gl =
    (canvas.getContext('webgl2') as WebGL2RenderingContext | null) ??
    (canvas.getContext('webgl') as WebGLRenderingContext | null);
  let vendor = 'n/a';
  let rendererStr = 'n/a';
  let glVersion = 'n/a';
  let antialiasAttr: boolean | undefined;
  if (gl !== null) {
    glVersion = String(gl.getParameter(gl.VERSION));
    antialiasAttr = gl.getContextAttributes()?.antialias;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg !== null) {
      vendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL));
      rendererStr = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
    }
  }
  return {
    glVersion,
    vendor,
    renderer: rendererStr,
    devicePixelRatio: window.devicePixelRatio,
    antialiasAttr,
  };
}

const api = {
  ready: true,
  errors,

  create,
  dispose,
  snapshot,
  rendererIdentity,

  theme(): ReturnType<typeof readGraphTokenTheme> {
    return readGraphTokenTheme(stage());
  },

  feedWave(index: number): number {
    const wave = livePopulationWaves()[index];
    if (wave === undefined || island === undefined) throw new Error(`no wave ${index}`);
    island.applyTouches(wave);
    return wave.length;
  },

  feedTouches(touches: ContextGraphTouch[]): void {
    island?.applyTouches(touches);
  },

  commitNow(): void {
    island?.commitNow();
  },

  indexOf(id: string): number | undefined {
    return island?.store.nodeById(id)?.index;
  },

  nodeRecord(id: string): { index: number; kind: string; cluster: string; spawnX: number; spawnY: number } | undefined {
    const record = island?.store.nodeById(id);
    if (record === undefined) return undefined;
    return {
      index: record.index,
      kind: record.kind,
      cluster: record.cluster,
      spawnX: record.spawnX,
      spawnY: record.spawnY,
    };
  },

  positionOf(id: string): { x: number; y: number } | undefined {
    const index = island?.store.nodeById(id)?.index;
    if (index === undefined) return undefined;
    return island?.renderer.positionOf(index);
  },

  probe(id: string): {
    alpha: number | undefined;
    visible: boolean | undefined;
    tint: number | undefined;
    haloAlpha: number | undefined;
    resting: number | undefined;
  } {
    const index = island?.store.nodeById(id)?.index;
    if (index === undefined) throw new Error(`unknown node ${id}`);
    const debug = pixi().debug;
    return {
      alpha: debug.nodeAlpha(index),
      visible: debug.nodeVisible(index),
      tint: debug.nodeTint(index),
      haloAlpha: debug.haloAlpha(index),
      resting: debug.restingTint(index),
    };
  },

  renderedNodeChildren(): number {
    return pixi().debug.renderedNodeChildren();
  },

  framesSeen(): number {
    return pixi().debug.framesSeen();
  },

  setLayer(kind: GraphNodeKind, visible: boolean): void {
    island?.setLayerVisible(kind, visible);
  },

  focusCluster(cluster: string | undefined): void {
    island?.focusCluster(cluster);
  },

  focusNode(id: string, scale?: number): void {
    if (scale !== undefined) island?.focusNode(id, scale);
    else island?.focusNode(id);
  },

  setReducedMotion(reduced: boolean): void {
    island?.setReducedMotion(reduced);
  },

  crashWorker(): boolean {
    if (liveWorker === undefined) return false;
    liveWorker.postMessage({ type: 'crash' });
    return true;
  },

  /** Bulk-load the soak script in streaming chunks (one commit per chunk). */
  soakLoad(options: { nodes?: number; edges?: number; chunk?: number } = {}): {
    nodeCount: number;
    edgeCount: number;
  } {
    if (island === undefined) throw new Error('no island');
    const script = soakTouchScript({
      ...(options.nodes !== undefined ? { nodes: options.nodes } : {}),
      ...(options.edges !== undefined ? { edges: options.edges } : {}),
    });
    for (const chunk of chunked(script.touches, options.chunk ?? 400)) {
      island.applyTouches(chunk);
      island.commitNow();
    }
    return { nodeCount: script.nodeCount, edgeCount: script.edgeCount };
  },

  /** Hold the layout HOT (gentle reheat every 500 ms — clamped upstream). */
  holdHeat(on: boolean): void {
    if (heatTimer !== undefined) {
      clearInterval(heatTimer);
      heatTimer = undefined;
    }
    if (on) {
      heatTimer = setInterval(() => island?.bridge.reheat(), 500);
    }
  },

  beginStats(): void {
    island?.beginStats();
  },

  readStats(): GraphRenderStats {
    if (island === undefined) throw new Error('no island');
    return island.readStats();
  },
};

declare global {
  interface Window {
    __fe4graph: typeof api;
  }
}

window.__fe4graph = api;
