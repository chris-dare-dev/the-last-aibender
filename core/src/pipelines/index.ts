/**
 * core/src/pipelines — BE-8 catalog scanner & pipeline engine (features 4/5;
 * plan §4/BE-8, blueprint §7, findings pipeline-workflow-builder). Barrel.
 *
 *   catalog/        THE ONE capability-catalog scanner, three consumers
 *   executor.ts     the StepExecutor port ([X1] per-step account routing)
 *   template.ts     the `${…}` templating + when/loop condition grammar
 *   inputHash.ts    the memoization-journal key (resolved-input sha256)
 *   planner.ts      plan-time capability resolution + contentHash drift
 *   reaper.ts       child-process-GROUP reaping on budget breach (#69856)
 *   gate.ts         the approval-gate port (rides the M2 approvals channel)
 *   lineageCost.ts  `workflow` edges (dag-schema §6) + events-store cost
 *   runner.ts       THE DAG walk (needs/when/forEach/loop, budget, retry,
 *                   outputSchema, memoization journal)
 *   engine.ts       the gateway-facing verb handler + run lifecycle
 *   slice.ts        the compose-ready slice (core/src/main/ injects it)
 */

export {
  parseFrontmatter,
  parseWorkflowMeta,
  scanCatalog,
  scanResultToSnapshot,
  recordToCatalogEntry,
  createMemoryCatalogFs,
  createNodeCatalogFs,
  contentHashOf,
  catalogIdOf,
  type AccountConfigDir,
  type CatalogFs,
  type CatalogRecord,
  type CatalogScanResult,
  type OpencodeCapability,
  type OpencodeCatalogSource,
  type ScanCatalogOptions,
} from './catalog/index.js';

export type {
  StepExecutor,
  StepExecutionRequest,
  StepExecutionResult,
  StepErrorKind,
} from './executor.js';

export {
  renderTemplate,
  resolveArray,
  evaluateCondition,
  type TemplateScope,
} from './template.js';

export { computeInputHash, type StepInputIdentity } from './inputHash.js';

export {
  planCapabilities,
  detectDrift,
  resolverFromRecords,
  accountScopedResolver,
  type CatalogResolver,
  type PlanResult,
  type PlanIssue,
  type ResolvedCapability,
} from './planner.js';

export {
  createProcessGroupReaper,
  type KillGroup,
  type ProcessGroupReaper,
  type ProcessGroupReaperOptions,
} from './reaper.js';

export type {
  GateOutcome,
  GateRequestInput,
  GateHandle,
  PipelineApprovalGate,
} from './gate.js';

export {
  createPipelineLineageCost,
  type PipelineLineageCost,
  type PipelineLineageCostOptions,
  type StepAttemptLineage,
} from './lineageCost.js';

export {
  runPipeline,
  type PipelineStatusPublisher,
  type PipelineRunStatusUpdate,
  type PipelineStepStatusUpdate,
  type RunPipelineOptions,
  type RunPipelineResult,
  type RunOutcome,
} from './runner.js';

export {
  createPipelineEngine,
  PipelineEngineError,
  type PipelineEnginePort,
  type PipelineEngineErrorCode,
  type PipelineEngineOptions,
  type LaunchInput,
  type LaunchOutcome,
  type ValidateOutcome,
} from './engine.js';

export {
  createPipelineSlice,
  type PipelineSlice,
  type PipelineSliceOptions,
} from './slice.js';
