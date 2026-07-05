/**
 * FE-6 pipelines feature — public surface (plan §5/FE-6, M5 slice: the
 * builder + run monitor; the workstream lineage view is the M4 slice in
 * app/src/features/workstreams/).
 *
 * Composition (one line in the FE-2 composition root):
 *
 *   const dispose = registerPipelines(client);
 *
 * Data path: broker `pipelines` channel → GatewayClient (frozen validators,
 * ws-protocol.md §18) → bindPipelines (rAF projector, one store write per
 * frame; pushed §18.4 errors correlate by requestId) → pipelinesStore (catalog
 * palette / run + step monitor rows / verb correlation) → PipelinesDeck (the
 * BUILDER — palette + DAG canvas with per-step account routing first-class
 * [X1], approval-gate node kind, validate/save via the frozen verbs; the RUN
 * MONITOR — per-step status + cost, the approval-gate deep-link into THE
 * single approval inbox (M2), the resume-from-journal affordance). NO ceremony
 * lives here — the one ceremonial animation is workstream lineage only
 * (DESIGN.md §3.3).
 */

export {
  GLOBAL_CATALOG_SCOPE,
  catalogEntriesFor,
  pipelinesStore,
  runsInOrder,
  stepKey,
  stepsForRun,
  type PipelineClientVerbLabel,
  type PipelinesStore,
  type PipelinesStoreState,
  type VerbPhase,
  type VerbState,
} from './store.ts';

export { bindPipelines, type PipelinesBindOptions } from './bind.ts';

export type { Clock, PipelineFeed, PipelineVerbSender, RequestIdSource } from './ports.ts';

export {
  PALETTE_KIND_ORDER,
  buildPalette,
  classifyCatalogEntry,
  paletteHealth,
  soleAccountOf,
  type CatalogGroup,
  type CatalogHealthFlag,
  type CatalogRow,
  type CatalogRowStatus,
  type PaletteHealth,
} from './catalog.ts';

export {
  DAG_SCHEMA_VERSION,
  addEdge,
  addNode,
  canonicalDocument,
  emptyBuilderDoc,
  isExecutableKind,
  removeNode,
  serializeBuilderDoc,
  serializeNode,
  updateNode,
  validateBuilderDoc,
  type BuilderDoc,
  type BuilderNode,
} from './dagModel.ts';

export {
  buildCancelRequest,
  buildLaunchRequest,
  buildPauseRequest,
  buildResumeRequest,
  buildSaveRequest,
  buildValidateRequest,
  dispatchVerb,
  validateVerb,
  type DispatchOptions,
  type DispatchOutcome,
  type LaunchArgs,
  type VerbVerdict,
} from './verbs.ts';

export {
  RUN_STATE_READOUT,
  STEP_STATE_READOUT,
  gateApprovalFor,
  isAwaitingApproval,
  runAccountsUsed,
  runControlsFor,
  runCostEstimate,
  runStatusRegister,
  stepStatusRegister,
  type InstrumentStatus,
  type RunControls,
} from './runMonitor.ts';

export { CHANNEL_HUE, PipelinesDeck, type PipelinesDeckProps } from './PipelinesDeck.tsx';

export {
  FOCUS_PIPELINES_COMMAND_ID,
  PIPELINES_SLOT,
  pipelinesIsland,
  registerPipelines,
  type RegisterPipelinesOptions,
} from './register.tsx';
