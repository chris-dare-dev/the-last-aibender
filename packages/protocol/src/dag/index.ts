/**
 * @aibender/protocol/dag — the versioned JSON DAG document format + validator
 * (dag-schema.md v1, FROZEN-M5). Barrel for the pipeline schema surface.
 */

export {
  CAPABILITY_SCOPES,
  DAG_ID_RE,
  DAG_NAME_RE,
  DAG_SCHEMA_VERSION,
  EXECUTABLE_STEP_KINDS,
  ON_ERROR_POLICIES,
  PERMISSION_MODES,
  RETRY_ON_CLASSES,
  STEP_BACKENDS,
  STEP_ID_RE,
  STEP_KINDS,
  accountStepBackendsFor,
  isCapabilityScope,
  isPermissionMode,
  isRetryOnClass,
  isStepBackend,
  isStepKind,
  type AgentStep,
  type ApprovalStep,
  type CapabilityRef,
  type CapabilityScope,
  type DagDefaults,
  type DagDocument,
  type DagInputSchema,
  type ExecutableStepKind,
  type LoopControl,
  type OnErrorLiteral,
  type OnErrorPolicy,
  type PermissionMode,
  type PipelineStep,
  type PromptStep,
  type RetryOnClass,
  type RetryPolicy,
  type SkillStep,
  type StepBackend,
  type StepBudget,
  type StepKind,
  type WorkflowScriptStep,
} from './types.js';

export {
  DAG_ISSUE_CODES,
  validateDagDocument,
  type DagIssueCode,
  type DagValidationIssue,
  type DagValidationResult,
} from './validate.js';
