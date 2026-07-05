/**
 * The versioned JSON DAG document format — the harness-owned pipeline schema
 * (Option E engine of findings pipeline-workflow-builder §R2, blueprint §7,
 * plan §4/BE-8). This is the SAVED/EDITED representation the builder UI
 * composes, the validator checks, and the runner walks. It is DECLARATIVE
 * (GitHub-Actions-shaped `needs:` edges) — never imperative JS; native
 * dynamic-workflow scripts are an INTEROP target (a `workflow-script` step
 * kind), never the execution foundation.
 *
 * ============================================================================
 * FROZEN-M5 (dag-schema.md v1) — owner BE-ORCH, FE-ORCH co-signs. This is the
 * TYPES half; validators live in validate.ts; the machine-checkable schema and
 * validation semantics are in dag-schema.md (the prose of record). Amendments
 * ONLY via ICR (docs/contracts/icr/).
 *
 * FORWARD-COMPAT RULE (frozen): the document's `schemaVersion` is `1` at this
 * freeze. A validator MUST refuse a document whose `schemaVersion` is unknown
 * (> the highest it understands) with `unsupported-version` — pipelines are
 * STATICALLY parsed and (in tests) NEVER executed, so a silently-misparsed
 * newer document is a correctness hazard, not a tolerable unknown. This is the
 * OPPOSITE of the wire channels' forward-tolerant unknown-KIND rule: a wire
 * push is fire-and-forget fan-out, a DAG document is load-bearing execution
 * state. Unknown STEP KINDS are likewise refused (`unknown-step-kind`) — the
 * runner cannot execute what it cannot compile.
 * ============================================================================
 */

import { isClaudeAccountLabel, type AccountLabel } from '../vocab.js';

/** The one schema version this freeze understands. */
export const DAG_SCHEMA_VERSION = 1 as const;

/** Document id charset (harness-minted `wf_…`) — the session-id charset. */
export const DAG_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Step id charset. Referenced by `needs`, by `${steps.<id>.…}` templating, and
 * as part of the memoization-journal key — kept conservative and template-safe
 * (`[A-Za-z0-9_-]`, 1–64 chars), the session-id-segment shape.
 */
export const STEP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Input/binding name charset (`inputs.<name>`), same conservative shape. */
export const DAG_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ---------------------------------------------------------------------------
// Step kinds (blueprint §7, findings §R2)
// ---------------------------------------------------------------------------

/**
 * The four EXECUTABLE step kinds plus the first-class `approval` gate:
 *   - `prompt`          one free-text prompt → one SDK/OpenCode/LM-Studio call
 *   - `skill`           a catalog skill/command invoked by name (`/name args`)
 *   - `agent`           a catalog subagent invoked by name
 *   - `workflow-script` INTEROP: delegate the whole step to a native
 *                       dynamic-workflow script on ONE account (statically
 *                       referenced, never inlined; the harness runs it via the
 *                       SDK, never composes it)
 *   - `approval`        a human gate — the engine PAUSES and the frontend
 *                       prompts the owner (the harness differentiator; native
 *                       runtimes explicitly cannot do mid-run gates)
 */
export const STEP_KINDS = Object.freeze([
  'prompt',
  'skill',
  'agent',
  'workflow-script',
  'approval',
] as const);

export type StepKind = (typeof STEP_KINDS)[number];

export function isStepKind(value: unknown): value is StepKind {
  return typeof value === 'string' && (STEP_KINDS as readonly string[]).includes(value);
}

/** Executable (non-gate) step kinds — the kinds that spawn a session_node. */
export const EXECUTABLE_STEP_KINDS = Object.freeze([
  'prompt',
  'skill',
  'agent',
  'workflow-script',
] as const);

export type ExecutableStepKind = (typeof EXECUTABLE_STEP_KINDS)[number];

// ---------------------------------------------------------------------------
// Step backends (which substrate runs an executable step)
// ---------------------------------------------------------------------------

/**
 * The execution backend for an executable step. Distinct from the wire
 * {@link import('../vocab.js').Backend} enum in ONE way: `bedrock` names the
 * OpenCode→Bedrock path explicitly (findings §R2 sketch), so a step can pin
 * "run this on AWS_DEV via OpenCode against Bedrock". The account label already
 * implies the backend family ({@link accountStepBackendsFor}); `backend` is an
 * OPTIONAL override the validator checks for consistency with the account.
 */
export const STEP_BACKENDS = Object.freeze([
  'claude',
  'opencode',
  'bedrock',
  'lmstudio',
] as const);

export type StepBackend = (typeof STEP_BACKENDS)[number];

export function isStepBackend(value: unknown): value is StepBackend {
  return typeof value === 'string' && (STEP_BACKENDS as readonly string[]).includes(value);
}

/**
 * The legal backend family per account label for pipeline steps (mirrors the
 * wire {@link import('../vocab.js').backendForLabel}, expanded so AWS_DEV admits
 * both the generic `opencode` and the explicit `bedrock` route it fronts).
 *
 * A FUNCTION, not a Record (ICR-0013): the Claude-account label form is OPEN
 * (`MAX_C`, `MAX_D`, …), so a fixed 5-key Record would silently return
 * `undefined` for a newly provisioned Max account. Any `MAX_<X>`/`ENT` maps to
 * the single `claude` step backend; `AWS_DEV`→`opencode|bedrock`;
 * `LOCAL`→`lmstudio`. Returns `[]` for a label outside the sanctioned form —
 * callers pass a validated {@link AccountLabel}, so an empty list means "no
 * legal backend", which the validator surfaces as `invalid-account`.
 */
export function accountStepBackendsFor(label: AccountLabel): readonly StepBackend[] {
  if (isClaudeAccountLabel(label)) return ['claude'];
  if (label === 'AWS_DEV') return ['opencode', 'bedrock'];
  if (label === 'LOCAL') return ['lmstudio'];
  return [];
}

// ---------------------------------------------------------------------------
// Permission modes (findings §1.3 subagent frontmatter — the SDK set)
// ---------------------------------------------------------------------------

export const PERMISSION_MODES = Object.freeze([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
] as const);

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Error policy + retry (findings §R2 sketch)
// ---------------------------------------------------------------------------

/**
 * What a failed step does to the walk: `fail` aborts the run (default),
 * `continue` marks it failed and proceeds to independent successors,
 * `goto:<stepId>` jumps (bounded by the loop guard). `goto` targets are
 * validated to reference an existing step.
 */
export const ON_ERROR_POLICIES = Object.freeze(['fail', 'continue'] as const);

export type OnErrorLiteral = (typeof ON_ERROR_POLICIES)[number];

/** `fail` | `continue` | `goto:<stepId>`. */
export type OnErrorPolicy = OnErrorLiteral | `goto:${string}`;

/** Retryable error classes (the SDK/OpenCode transient set). */
export const RETRY_ON_CLASSES = Object.freeze([
  'rate_limit',
  'overloaded',
  'timeout',
  'network',
] as const);

export type RetryOnClass = (typeof RETRY_ON_CLASSES)[number];

export function isRetryOnClass(value: unknown): value is RetryOnClass {
  return typeof value === 'string' && (RETRY_ON_CLASSES as readonly string[]).includes(value);
}

export interface RetryPolicy {
  /** Max additional attempts after the first (0..10). */
  readonly max: number;
  /** Base backoff seconds between attempts (>= 0). */
  readonly backoffSec?: number;
  /** Only retry on these classes; absent = retry on any retryable class. */
  readonly retryOn?: readonly RetryOnClass[];
}

// ---------------------------------------------------------------------------
// Per-step budget (blueprint §7; findings §R3)
// ---------------------------------------------------------------------------

/**
 * Belt-and-suspenders budget. At least one field must be present when a
 * `budget` block is given. The engine enforces cumulative step cost/turns/wall
 * clock and aborts on breach (with process-group reaping — findings §R3).
 */
export interface StepBudget {
  /** USD ceiling (> 0). */
  readonly usd?: number;
  /** SDK maxTurns (positive integer). */
  readonly turns?: number;
  /** Wall-clock ceiling in seconds (positive integer). */
  readonly wallClockSec?: number;
}

// ---------------------------------------------------------------------------
// Capability references (resolved against the catalog at plan time)
// ---------------------------------------------------------------------------

/**
 * A catalog reference for a `skill` or `agent` step. Resolved against the
 * scanner catalog FOR THE STEP'S cwd + account at plan time; the resolved
 * `sourcePath` + `contentHash` are pinned into the run record so a rerun
 * months later detects drift (findings §R2). `scope` is the precedence
 * dimension the scanner records.
 */
export const CAPABILITY_SCOPES = Object.freeze([
  'enterprise',
  'user',
  'project',
  'plugin',
  'opencode-global',
  'opencode-project',
] as const);

export type CapabilityScope = (typeof CAPABILITY_SCOPES)[number];

export function isCapabilityScope(value: unknown): value is CapabilityScope {
  return typeof value === 'string' && (CAPABILITY_SCOPES as readonly string[]).includes(value);
}

export interface CapabilityRef {
  /** Invocation name (post-namespacing, e.g. `my-plugin:review`). */
  readonly name: string;
  /** Precedence scope; absent = resolve by the scanner's default precedence. */
  readonly scope?: CapabilityScope;
  /**
   * Space/comma argument string rendered into the invocation (`/name args`).
   * Templating (`${…}`) is legal here and resolved at run time.
   */
  readonly args?: string;
}

// ---------------------------------------------------------------------------
// Fan-out / loop (findings §R2/§R3)
// ---------------------------------------------------------------------------

/**
 * A `loop` step kind's control (findings §R3 "fix until the check passes"):
 * repeat the step body until `until` evaluates truthy, capped at
 * `maxIterations` (the imperative-loop-as-explicit-step-type discipline —
 * NEVER free-form JS).
 */
export interface LoopControl {
  /** Template expression evaluated after each iteration; truthy = stop. */
  readonly until: string;
  /** Hard cap on iterations (1..100). */
  readonly maxIterations: number;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** Fields common to every step. */
interface StepCommon {
  /** Unique within the document ({@link STEP_ID_RE}). */
  readonly id: string;
  /** DAG edges: this step runs after every listed step (GitHub-Actions `needs:`). */
  readonly needs?: readonly string[];
  /** Conditional edge: template expression; step is SKIPPED when falsy. */
  readonly when?: string;
  /**
   * Matrix fan-out: a template expression resolving to an array; the step runs
   * once per element (`${item}` in the body), capped by `maxParallel`.
   */
  readonly forEach?: string;
  /** Concurrency cap for a `forEach` fan-out (1..16 — the native cap). */
  readonly maxParallel?: number;
  /** Loop-until control ({@link LoopControl}); mutually exclusive with forEach. */
  readonly loop?: LoopControl;
}

/** Fields common to every EXECUTABLE (non-gate) step. */
interface ExecutableStepCommon extends StepCommon {
  /** Account routing — THE [X1] differentiator. Placeholder label only [X2]. */
  readonly account?: AccountLabel;
  /** Backend override; must be consistent with `account` (validated). */
  readonly backend?: StepBackend;
  /** Absolute working directory; templating legal (`${workspace}`). */
  readonly cwd?: string;
  readonly permissionMode?: PermissionMode;
  readonly budget?: StepBudget;
  readonly retry?: RetryPolicy;
  /**
   * JSON-schema for the step's structured result, enforced via SDK
   * `structured_output` (findings §R3 data passing). Stored as an opaque
   * object — the validator checks it is an object with a `type`, not the full
   * JSON-Schema meta-schema (that is the runner's `ajv`-class job).
   */
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  /** Error policy (default `fail`). */
  readonly onError?: OnErrorPolicy;
}

export interface PromptStep extends ExecutableStepCommon {
  readonly kind: 'prompt';
  /** The prompt body; templating legal. Non-empty. */
  readonly prompt: string;
}

export interface SkillStep extends ExecutableStepCommon {
  readonly kind: 'skill';
  readonly skill: CapabilityRef;
  /** Optional extra prompt appended after the `/skill args` invocation. */
  readonly prompt?: string;
}

export interface AgentStep extends ExecutableStepCommon {
  readonly kind: 'agent';
  readonly agent: CapabilityRef;
  /** The task prompt handed to the agent; non-empty. */
  readonly prompt: string;
}

export interface WorkflowScriptStep extends ExecutableStepCommon {
  readonly kind: 'workflow-script';
  /**
   * A STATICALLY-referenced native dynamic-workflow script (findings §1.5 /
   * Option E interop). The harness parses its `meta` only and runs it via the
   * SDK on ONE account — it is never inlined or composed. Absolute path.
   */
  readonly scriptPath: string;
}

export interface ApprovalStep extends StepCommon {
  readonly kind: 'approval';
  /** Identifier-free prompt shown in the approval inbox [X2]. */
  readonly summary?: string;
  /** Auto-resolve timeout in seconds (positive integer). */
  readonly timeoutSec?: number;
  /** What a timeout does: `fail` (default) or `continue`. */
  readonly onTimeout?: 'fail' | 'continue';
}

export type PipelineStep =
  | PromptStep
  | SkillStep
  | AgentStep
  | WorkflowScriptStep
  | ApprovalStep;

// ---------------------------------------------------------------------------
// Document-level defaults + inputs
// ---------------------------------------------------------------------------

/** Document-level defaults applied to every executable step that omits them. */
export interface DagDefaults {
  readonly account?: AccountLabel;
  readonly backend?: StepBackend;
  readonly permissionMode?: PermissionMode;
  readonly cwd?: string;
}

/** One declared input parameter (a JSON-schema fragment, stored opaque). */
export type DagInputSchema = Readonly<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/**
 * A pipeline DAG document. [X2]: carries paths + step ids + placeholder
 * account labels + prompt/skill/agent NAMES only — never real emails / account
 * ids / tokens (the same discipline as briefs and catalog entries; enforced by
 * the validator's identity screen on naming fields and by the fixture policy).
 */
export interface DagDocument {
  /** Frozen at {@link DAG_SCHEMA_VERSION}; unknown versions are refused. */
  readonly schemaVersion: number;
  /** Harness-minted document id (`wf_…`); {@link DAG_ID_RE}. */
  readonly id: string;
  /** Identifier-free display name [X2]. Non-empty. */
  readonly name: string;
  readonly description?: string;
  readonly defaults?: DagDefaults;
  /** Declared inputs (name → JSON-schema fragment). */
  readonly inputs?: Readonly<Record<string, DagInputSchema>>;
  /** The steps — non-empty; a valid DAG (no cycles, no dangling needs). */
  readonly steps: readonly PipelineStep[];
}
