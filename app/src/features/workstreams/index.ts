/**
 * FE-6 workstream feature — public surface (plan §5/FE-6, M4 slice: the
 * workstream lineage view; the pipeline builder is the M5 slice in
 * app/src/features/pipelines/).
 *
 * Composition (one line in the FE-2 composition root):
 *
 *   const dispose = registerWorkstreams(client);
 *
 * Data path: broker `workstream` channel → GatewayClient (frozen validators,
 * ws-protocol.md §16) → bindWorkstreams (rAF projector, one store write per
 * frame; pushed §16.4 errors correlate by mergeId) → workstreamsStore (rail /
 * node UPSERTs / immutable edge appends / brief shelf / advisory instrument
 * states / merge correlation) → WorkstreamsDeck (git-metaphor lineage: a
 * continuation is a CHILD, the detached-HEAD orphan bucket renders in the
 * inferred-confidence register, the merge flow dispatches THE one lineage
 * verb, and DESIGN.md §3.3's ONE ceremony fires on lineage events only).
 */

export {
  activeAdvisories,
  workstreamsStore,
  DETACHED_SCOPE,
  MAX_BRIEFS,
  type CeremonyMarker,
  type MergePhase,
  type MergeState,
  type WorkstreamsStore,
  type WorkstreamsStoreState,
} from './store.ts';

export { bindWorkstreams, type WorkstreamsBindOptions } from './bind.ts';

export type { Clock, WorkstreamFeed, WorkstreamMergeSender } from './ports.ts';

export {
  buildLineageLayout,
  edgesInOrder,
  nodesInScope,
  type LineageEdgeVM,
  type LineageLayout,
  type LineageRowVM,
} from './lineage.ts';

export {
  assembleMergePreview,
  buildMergeRequest,
  dispatchMerge,
  validateMergeDraft,
  type DispatchMergeOptions,
  type DispatchOutcome,
  type MergeDraft,
  type MergeDraftVerdict,
  type MergePreview,
  type MergePreviewParent,
} from './merge.ts';

export {
  CEREMONY_BUDGET_MS,
  CHANNEL_HUE,
  RAIL_LANE_PX,
  RAIL_ROW_PX,
  useCeremony,
  WorkstreamsDeck,
  type WorkstreamsDeckProps,
} from './WorkstreamsDeck.tsx';

export {
  FOCUS_WORKSTREAMS_COMMAND_ID,
  registerWorkstreams,
  workstreamsIsland,
  type RegisterWorkstreamsOptions,
} from './register.tsx';
