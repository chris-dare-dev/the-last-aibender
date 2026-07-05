/**
 * FE-4 context-graph island — public surface (plan §5/FE-4, blueprint §8,
 * spike-B verdict).
 *
 * The normative three-stage contract is exported as PORTS so the renderer is
 * swappable (cosmos.gl / 3d-force-graph plug in behind {@link GraphRenderer}
 * without touching the store or the worker):
 *
 *   GraphStore ─ batches ─▶ LayoutBridge (d3-force module worker,
 *   transferable Float32Array epochs) ─ epochs ─▶ GraphRenderer (Pixi v8,
 *   WebGL2, antialias OFF)
 *
 * Composition entry: {@link registerGraphIsland} (chrome islandRegistry
 * seam + wire binding + palette verb).
 */

export {
  GRAPH_NODE_KINDS,
  percentile,
  type CameraPose,
  type GraphEdgeRecord,
  type GraphMutationBatch,
  type GraphNodeKind,
  type GraphNodeRecord,
  type GraphRenderStats,
  type GraphRenderer,
  type GraphViewFilters,
  type LayoutBridge,
  type LayoutBridgeState,
  type PositionEpoch,
} from './types.ts';

export { basenameOf, classifyArtifact, upgradeKind } from './classify.ts';

export {
  DEFAULT_MAX_NODES,
  FALLBACK_COMMIT_WINDOW_MS,
  GRAPH_NODE_CEILING,
  GraphStore,
  artifactNodeId,
  defaultCommitScheduler,
  sessionNodeId,
  type CommitScheduler,
  type GraphStoreOptions,
} from './store.ts';

export {
  ALPHA_MIN,
  GENTLE_ALPHA_TARGET,
  createLayoutEngine,
  type LayoutEngine,
} from './layoutEngine.ts';

export {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_EPOCH_INTERVAL_MS,
  createLayoutBridge,
  createLayoutWorker,
  type LayoutBridgeOptions,
  type LayoutBridgeTimers,
  type LayoutWorkerLike,
} from './layoutBridge.ts';

export {
  isLayoutWorkerResponse,
  type LayoutWorkerRequest,
  type LayoutWorkerResponse,
} from './workerProtocol.ts';

export {
  DIM_ALPHA,
  EDGE_DRAW_MS,
  PHOSPHOR_HOLD_MS,
  REDUCED_PULSE_HOLD_MS,
  createPixiGraphRenderer,
  type PixiGraphRenderer,
  type PixiGraphRendererOptions,
  type PixiRendererDebugProbe,
} from './pixiRenderer.ts';

export {
  parseColorWithAlpha,
  parseCubicBezier,
  parseDurationMs,
  parseHexColor,
  parseRgba,
  readGraphTokenTheme,
  type GraphTokenTheme,
} from './theme.ts';

export { createCameraController, type CameraController, type CameraControllerOptions } from './camera.ts';

export {
  createGraphIsland,
  mountGraphIsland,
  type GraphIslandHandle,
  type GraphIslandOptions,
  type GraphIslandSnapshot,
} from './graphIsland.ts';

export { attachGraphControls, type GraphControlsHandle, type GraphControlsIsland } from './controls.ts';

export {
  bindGraphFeed,
  type BindGraphFeedOptions,
  type ContextGraphFeed,
  type GraphTouchSink,
} from './wsBind.ts';

export {
  FOCUS_GRAPH_COMMAND_ID,
  graphIslandMount,
  registerGraphIsland,
  type RegisterGraphIslandOptions,
} from './register.ts';

export {
  chunked,
  livePopulationWaves,
  soakTouchScript,
  type SoakScript,
  type SoakScriptOptions,
} from './fixtures.ts';
