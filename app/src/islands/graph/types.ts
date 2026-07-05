/**
 * FE-4 context-graph island — the normative GraphStore → LayoutBridge →
 * GraphRenderer contract (plan §5/FE-4, blueprint §8, spike-B verdict).
 *
 * The three stages are ports so the renderer is SWAPPABLE: cosmos.gl
 * (corpus mode) or 3d-force-graph (3D showcase) can plug in later without
 * touching the store or the worker — only a new {@link GraphRenderer}
 * implementation. Everything here is data + function signatures; no Pixi,
 * no DOM, no worker types leak across the seams.
 *
 * Shared axis: the NODE INDEX. The store assigns each node a dense
 * insertion-order index; the layout worker's position epochs are
 * `Float32Array` of `[x0, y0, x1, y1, …]` on that axis; the renderer maps
 * index → display object. Ids never cross the layout boundary — typed
 * arrays only (spike-B lock #2).
 *
 * [X2]: node payloads carry file paths, session ids and derived labels
 * ONLY — the wire validator upstream already rejects identity-bearing keys.
 */

/**
 * Node kinds (blueprint §8 / findings doc): the four artifact classes the
 * feed describes, plus the sessions that touch them. Kinds double as the
 * LAYER axis for the day-one layer toggles.
 */
export const GRAPH_NODE_KINDS = Object.freeze([
  'session',
  'claude-md',
  'memory',
  'agent-artifact',
  'reference',
] as const);

export type GraphNodeKind = (typeof GRAPH_NODE_KINDS)[number];

export interface GraphNodeRecord {
  /** Dense insertion-order index — the layout/render position axis. */
  readonly index: number;
  /** Store id: `session:<sid>` or `file:<abs path>`. */
  readonly id: string;
  readonly kind: GraphNodeKind;
  /** Render label: basename for files, the session id for sessions. */
  readonly label: string;
  /**
   * Cluster key — the session that introduced the node (its own id for
   * session nodes). The cluster-dim lever operates on this axis.
   */
  readonly cluster: string;
  /** Spawn position (AT the referrer + jitter — never the origin fling). */
  readonly spawnX: number;
  readonly spawnY: number;
}

export interface GraphEdgeRecord {
  /** Dense insertion-order edge index. */
  readonly index: number;
  readonly sourceIndex: number;
  readonly targetIndex: number;
}

/**
 * One coalesced mutation commit (batched per rAF / 150 ms window — never
 * per-event). `pulses` carries the indexes of ALREADY-EXISTING artifacts
 * that were touched again in the window: the amber pulse fires for these
 * and for nothing else.
 */
export interface GraphMutationBatch {
  readonly addedNodes: readonly GraphNodeRecord[];
  readonly addedEdges: readonly GraphEdgeRecord[];
  readonly pulses: readonly number[];
  /** Kind upgrades on existing nodes (reference → agent-artifact). */
  readonly retagged: readonly { readonly index: number; readonly kind: GraphNodeKind }[];
  /** Node counts after this commit (the renderer/layout array sizes). */
  readonly nodeCount: number;
  readonly edgeCount: number;
}

/** A position epoch as delivered by the layout bridge. */
export interface PositionEpoch {
  /** `[x0, y0, …]` — length 2 × nodeCount at emit time. */
  readonly positions: Float32Array;
  /** Nodes covered by this epoch. */
  readonly nodeCount: number;
  /** Monotonic epoch sequence (per bridge instance). */
  readonly seq: number;
  /** Simulation alpha at emit time (0 = settled). */
  readonly alpha: number;
}

/**
 * Layout bridge states. `degraded` is the worker-crash posture: the last
 * epoch stays authoritative, new nodes rest at their spawn position, the
 * renderer keeps painting — settled layout, never a white screen
 * (plan §9.2 FE-4 negative row).
 */
export type LayoutBridgeState = 'starting' | 'running' | 'idle' | 'degraded' | 'disposed';

export interface LayoutBridge {
  readonly state: LayoutBridgeState;
  /** Highest epoch received; -1 before the first. */
  readonly lastEpochSeq: number;
  /** Feed one commit into the simulation (typed arrays cross the boundary). */
  applyBatch(batch: GraphMutationBatch): void;
  /**
   * Gentle reheat. Values are CLAMPED to `[0, 0.3]` — the alphaTarget bound
   * is a frozen behavior (plan §9.2 FE-4 edge row asserts it).
   */
  reheat(alphaTarget?: number): void;
  /** Return the simulation to rest (alphaTarget 0). */
  cooldown(): void;
  /** Reduced-motion path: settle off-screen, emit ONE converged epoch. */
  settle(): void;
  onEpoch(listener: (epoch: PositionEpoch) => void): () => void;
  onStateChange(listener: (state: LayoutBridgeState) => void): () => void;
  dispose(): void;
}

/** Camera pose in world coordinates (renderer-agnostic). */
export interface CameraPose {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

/** Layer visibility + cluster focus, applied atomically by the renderer. */
export interface GraphViewFilters {
  /** Kinds currently visible (layer toggles). */
  readonly visibleKinds: ReadonlySet<GraphNodeKind>;
  /** When set, nodes outside this cluster dim to faint (cluster-dim). */
  readonly focusedCluster: string | undefined;
}

/**
 * Renderer statistics for the perf soak (spike-B fps floor). Sampling is
 * armed with {@link GraphRenderer.beginStats} and read with `readStats`.
 */
export interface GraphRenderStats {
  readonly frames: number;
  readonly seconds: number;
  readonly fps: number;
  readonly frameMsMean: number;
  readonly frameMsP95: number;
  readonly pctOver16_7: number;
  readonly pctOver33_3: number;
  readonly epochsApplied: number;
}

/**
 * The swappable renderer port. Implementations own every pixel inside the
 * host element; colors/durations come from the Instrument Grade tokens via
 * the injected {@link GraphTokenTheme} (DESIGN.md §8.5 — hex never enters
 * renderer code).
 */
export interface GraphRenderer {
  /** Mount into the host element. Idempotent per instance. */
  init(host: HTMLElement): Promise<void>;
  /** Apply one mutation commit (adds + the amber pulses). */
  applyBatch(batch: GraphMutationBatch): void;
  /** Apply a position epoch (the renderer interpolates between epochs). */
  applyPositions(epoch: PositionEpoch): void;
  /** Layer toggles + cluster-dim (day one — the hairball levers). */
  applyFilters(filters: GraphViewFilters): void;
  /**
   * Camera pose setter — the camera CONTROLLER (Motion `animate()` easing,
   * camera.ts) drives this per frame; the renderer only applies transforms.
   */
  setCamera(pose: CameraPose): void;
  readonly camera: CameraPose;
  /** Reduced-motion: opacity-only fades, no pulse loop, settled entries. */
  setReducedMotion(reduced: boolean): void;
  /** World position of a node (camera targeting), if known. */
  positionOf(index: number): { x: number; y: number } | undefined;
  beginStats(): void;
  readStats(): GraphRenderStats;
  resize(width: number, height: number): void;
  dispose(): void;
}

/** Percentile helper shared by stats implementations (nearest-rank). */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? 0;
}
