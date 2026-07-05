/**
 * `pipelines` channel payloads — the wire half of features 4 (catalog scanner)
 * and 5 (pipeline engine) (blueprint §7, plan §4/BE-8, §5/FE-6, findings
 * pipeline-workflow-builder §R1/§R3). Bidirectional like `workstream` /
 * `approvals`; replayable (§8). Companion to the versioned JSON DAG document
 * (dag/, dag-schema.md) which is the SAVED/EDITED representation — this module
 * is the RUNTIME feed + the client verbs that drive it.
 *
 * WIRE (the `pipelines` channel, registered at this freeze — channels.ts):
 *   broker → client (fan-out, replayable §8):
 *     - `catalog-snapshot`          the builder palette: capability entries
 *                                   (kind/name/sourcePath/contentHash/scope) —
 *                                   PATHS + NAMES + LABELS only [X2]
 *     - `pipeline-run-snapshot`     one run's full monitor state (run + all
 *                                   step statuses), pushed on boot/subscribe
 *                                   and on change
 *     - `pipeline-run-status`       a run-level status transition (upsert)
 *     - `pipeline-step-status`      a per-step status/cost transition (upsert,
 *                                   keyed on runId+stepId+iteration+attempt)
 *     - `pipeline-validation-result` the answer to a `pipeline-validate` verb
 *     - `pipeline-saved`            the answer to a `pipeline-save` verb
 *     unknown kinds decode opaque (the frozen forward-tolerant reader rule)
 *   client → broker (the pipeline verbs — the §16.2 merge-request precedent:
 *   a feature-scoped verb rides its fan-out channel, not `control`):
 *     - `pipeline-validate`  static validation of a DAG document (no run)
 *     - `pipeline-save`      persist a pipeline definition
 *     - `pipeline-launch`    start a run from a saved (or inline) definition
 *     - `pipeline-pause`     pause a running walk
 *     - `pipeline-resume`    resume a paused/interrupted run FROM THE JOURNAL
 *     - `pipeline-cancel`    abort a run (process-group reaping, findings §R3)
 *
 *   Approval GATES do NOT ride this channel — they ride the EXISTING
 *   `approvals` channel via the frozen `workflow-gate` source (§10.1:
 *   runId/stepId REQUIRED, toolName/toolUseId forbidden). This is the M2
 *   precedent: ONE approval inbox for every escalation source, no new wire.
 *
 *   Frozen error codes for the verbs (pushed errors §7, correlated by the
 *   verb's `requestId`): `bad-request` (shape), `pipeline-invalid` (the DAG
 *   failed validation — carries no detail on the wire; the validation-result
 *   payload carries the issue), `pipeline-not-found` (unknown pipeline id),
 *   `pipeline-run-not-found` (unknown run id), `step-not-found` (unknown step
 *   in a run), `internal`.
 *
 * FORWARD-TOLERANT READER (same frozen rule as `events` §13.3 / `workstream`
 * §16.1): a broker push whose `kind` is a non-empty string OUTSIDE the frozen
 * set is legal and MUST be ignored (decoded as {@link OpaquePipelinePayload}).
 * Registered kinds validate STRICTLY.
 *
 * [X2] identity discipline: catalog entries and run payloads carry file paths,
 * content hashes, harness ids, capability NAMES, and placeholder account
 * labels ONLY. Never real emails / account ids / tokens — the same discipline
 * as briefs and DAG documents (enforced by the validator's naming screen and
 * the fixture policy). Per-step cost is an ESTIMATE unless labeled actual.
 *
 * ============================================================================
 * FROZEN-M5 (2026-07-04) — owner BE-ORCH, FE-ORCH co-signs. Amendments only
 * via ICR (docs/contracts/icr/). Prose of record: docs/contracts/ws-protocol.md.
 * ============================================================================
 */

import type { AccountLabel } from './vocab.js';
import type { DagDocument } from './dag/index.js';

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** Pipeline definition id (`wf_…`) / run id (`run_…`) — the DAG id charset. */
export const PIPELINE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** Client-generated verb correlation id (the control-request-id shape). */
export const PIPELINE_REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// ---------------------------------------------------------------------------
// Catalog (feature 4 — the builder palette)
// ---------------------------------------------------------------------------

/**
 * Capability KINDS the scanner produces (findings §R1 normalized record). One
 * scanner, three consumers; these are the palette entry kinds. `command` is
 * merged-into-skills but kept as a distinct kind for lower precedence
 * (findings §1.2); `workflow` is a saved native dynamic-workflow script
 * (static `meta` parse only, never executed [X2/rule 3]).
 */
export const CAPABILITY_KINDS = Object.freeze([
  'skill',
  'command',
  'agent',
  'workflow',
  'oc-agent',
  'oc-command',
  'plugin',
] as const);

export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

export function isCapabilityKind(value: unknown): value is CapabilityKind {
  return typeof value === 'string' && (CAPABILITY_KINDS as readonly string[]).includes(value);
}

/** The backend family a capability belongs to (findings §R1 `backendFamily`). */
export const CAPABILITY_BACKEND_FAMILIES = Object.freeze(['claude', 'opencode'] as const);

export type CapabilityBackendFamily = (typeof CAPABILITY_BACKEND_FAMILIES)[number];

export function isCapabilityBackendFamily(value: unknown): value is CapabilityBackendFamily {
  return (
    typeof value === 'string' && (CAPABILITY_BACKEND_FAMILIES as readonly string[]).includes(value)
  );
}

/**
 * Precedence scope (findings §R1 `scope` — the resolution dimension). The DAG
 * schema shares CAPABILITY_SCOPES; kept aligned here so a catalog entry's
 * scope can be referenced by a step's {@link import('./dag/index.js').CapabilityRef}.
 */
export const CATALOG_SCOPES = Object.freeze([
  'enterprise',
  'user',
  'project',
  'plugin',
  'opencode-global',
  'opencode-project',
] as const);

export type CatalogScope = (typeof CATALOG_SCOPES)[number];

export function isCatalogScope(value: unknown): value is CatalogScope {
  return typeof value === 'string' && (CATALOG_SCOPES as readonly string[]).includes(value);
}

/**
 * One normalized catalog entry for the builder palette (findings §R1). [X2]:
 * `sourcePath` is a machine-local absolute path (legal on this wire, the
 * context-touch precedent); `contentHash` pins the source for run-time drift
 * detection; the parsed frontmatter is DELIBERATELY NOT on the wire (it can
 * carry arbitrary user keys — the palette needs only the invocation surface).
 */
export interface CatalogEntry {
  /** Harness-minted catalog id (`cap_…`). */
  readonly capId: string;
  readonly kind: CapabilityKind;
  /** Invocation name (post-namespacing, e.g. `my-plugin:review`). */
  readonly name: string;
  readonly scope: CatalogScope;
  readonly backendFamily: CapabilityBackendFamily;
  /** Absolute workspace path this entry resolves for; absent = user/global. */
  readonly workspace?: string;
  /** Absolute source path (SKILL.md / agent md / script). */
  readonly sourcePath: string;
  /** `sha256:…` content hash for reproducibility pinning. */
  readonly contentHash: string;
  /** Slash invocation, when one exists (`/argocd-debug`). */
  readonly slash?: string;
  /** Autocomplete hint (`[issue-number]`). */
  readonly argumentHint?: string;
  /** True when the capability is user-only (`disable-model-invocation`). */
  readonly disableModelInvocation?: boolean;
  /** Which account config dirs this entry resolves for (user/plugin scope). */
  readonly accounts?: readonly AccountLabel[];
}

/** The full palette for one (workspace, account) resolution, pushed on change. */
export interface CatalogSnapshot {
  readonly kind: 'catalog-snapshot';
  /** Epoch ms. */
  readonly capturedAt: number;
  /** Absolute workspace this palette resolves for; absent = user/global only. */
  readonly workspace?: string;
  readonly entries: readonly CatalogEntry[];
}

// ---------------------------------------------------------------------------
// Run monitor (feature 5)
// ---------------------------------------------------------------------------

/** Run-level status (findings §R3 journal `workflow_run.status`). */
export const PIPELINE_RUN_STATES = Object.freeze([
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const);

export type PipelineRunState = (typeof PIPELINE_RUN_STATES)[number];

export function isPipelineRunState(value: unknown): value is PipelineRunState {
  return typeof value === 'string' && (PIPELINE_RUN_STATES as readonly string[]).includes(value);
}

/**
 * Per-step-attempt status (findings §R3 `step_attempt.status`). `blocked` = a
 * step whose `needs` are unmet; `awaiting-approval` = paused on a first-class
 * `approval` gate (the approval itself rides the approvals channel);
 * `memoized` = resumed from the journal without re-execution (the M5 DoD:
 * "resumes from the memoization journal without re-executing completed steps").
 */
export const PIPELINE_STEP_STATES = Object.freeze([
  'pending',
  'blocked',
  'running',
  'awaiting-approval',
  'completed',
  'memoized',
  'failed',
  'skipped',
  'cancelled',
] as const);

export type PipelineStepState = (typeof PIPELINE_STEP_STATES)[number];

export function isPipelineStepState(value: unknown): value is PipelineStepState {
  return typeof value === 'string' && (PIPELINE_STEP_STATES as readonly string[]).includes(value);
}

/**
 * One step attempt's monitor row. Keyed on (runId, stepId, iteration,
 * attempt) — the memoization-journal key axis (findings §R3). `cost`/`tokens`
 * are the events-store attribution for this attempt; `sessionId` is the
 * harness session id of the `session_node` the attempt spawned (the `workflow`
 * lineage edge target) — native ids NEVER ride this channel [X2].
 */
export interface PipelineStepStatusRecord {
  readonly runId: string;
  readonly stepId: string;
  /** forEach/loop iteration index (0 for a scalar step). */
  readonly iteration: number;
  /** retry attempt (0 = first). */
  readonly attempt: number;
  readonly state: PipelineStepState;
  /** Harness session id of the spawned node, when the attempt spawned one. */
  readonly sessionId?: string;
  /** Placeholder account label the attempt ran on [X2]. */
  readonly account?: AccountLabel;
  /** Always an ESTIMATE unless the run monitor marks it actual (Bedrock). */
  readonly costEstimatedUsd?: number;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  /** Epoch ms. */
  readonly startedAt?: number;
  readonly finishedAt?: number;
  /** Identifier-free failure class [X2], when failed. */
  readonly errorKind?: string;
}

export interface PipelineStepStatusEvent extends PipelineStepStatusRecord {
  readonly kind: 'pipeline-step-status';
}

/** Run-level monitor record. */
export interface PipelineRunStatusRecord {
  readonly runId: string;
  /** The pipeline definition this run instantiates. */
  readonly pipelineId: string;
  readonly state: PipelineRunState;
  /** Content hash of the DAG document the run pinned (drift detection). */
  readonly schemaHash?: string;
  /** Σ step cost (estimate) so far. */
  readonly costEstimatedUsd?: number;
  /** Epoch ms. */
  readonly startedAt?: number;
  readonly finishedAt?: number;
  /**
   * True when the run has journaled progress a `pipeline-resume` can pick up
   * (the resume-from-journal affordance — the FE shows a "resume" button).
   */
  readonly resumable?: boolean;
}

export interface PipelineRunStatusEvent extends PipelineRunStatusRecord {
  readonly kind: 'pipeline-run-status';
}

/** One run's full monitor state, pushed on boot/subscribe and on rebuild. */
export interface PipelineRunSnapshot {
  readonly kind: 'pipeline-run-snapshot';
  /** Epoch ms. */
  readonly capturedAt: number;
  readonly run: PipelineRunStatusRecord;
  readonly steps: readonly PipelineStepStatusRecord[];
}

/**
 * The answer to a `pipeline-validate` verb. `valid` mirrors the DAG
 * validator's verdict; on failure the frozen issue class + identifier-free
 * message + path ride here (NOT in an error envelope — validation failure is a
 * normal answer, not a transport error).
 */
export interface PipelineValidationResult {
  readonly kind: 'pipeline-validation-result';
  /** Correlates to the client's `pipeline-validate` requestId. */
  readonly requestId: string;
  readonly valid: boolean;
  /** Present iff !valid. The dag/ validator issue class. */
  readonly issueCode?: string;
  /** Identifier-free [X2]. */
  readonly issueMessage?: string;
  /** Dotted path to the offending node. */
  readonly issuePath?: string;
}

/** The answer to a `pipeline-save` verb: the persisted definition id. */
export interface PipelineSaved {
  readonly kind: 'pipeline-saved';
  readonly requestId: string;
  readonly pipelineId: string;
}

export type PipelineServerPayload =
  | CatalogSnapshot
  | PipelineRunSnapshot
  | PipelineRunStatusEvent
  | PipelineStepStatusEvent
  | PipelineValidationResult
  | PipelineSaved;

/** Registered broker→client kinds (unknown kinds decode opaque — see below). */
export const PIPELINE_SERVER_PAYLOAD_KINDS = Object.freeze([
  'catalog-snapshot',
  'pipeline-run-snapshot',
  'pipeline-run-status',
  'pipeline-step-status',
  'pipeline-validation-result',
  'pipeline-saved',
] as const);

/**
 * Decoded form of a `pipelines` payload whose `kind` is outside the frozen
 * set: legal by the forward-tolerant reader rule; clients MUST ignore it. The
 * `opaque` marker is decode-side only — it never rides the wire.
 */
export interface OpaquePipelinePayload {
  readonly kind: string;
  readonly opaque: true;
}

// ---------------------------------------------------------------------------
// Client → broker: the pipeline verbs
// ---------------------------------------------------------------------------

/** Static validation of a DAG document (no run). */
export interface PipelineValidateRequest {
  readonly kind: 'pipeline-validate';
  readonly requestId: string;
  /** The DAG document to validate (the dag/ schema). */
  readonly document: DagDocument;
}

/** Persist a pipeline definition (validated first). */
export interface PipelineSaveRequest {
  readonly kind: 'pipeline-save';
  readonly requestId: string;
  readonly document: DagDocument;
}

/**
 * Start a run. Either an inline `document` (validated at launch) or a saved
 * `pipelineId` (exactly one — the validator enforces). `inputs` binds the
 * document's declared inputs.
 */
export interface PipelineLaunchRequest {
  readonly kind: 'pipeline-launch';
  readonly requestId: string;
  readonly pipelineId?: string;
  readonly document?: DagDocument;
  /** Binds declared inputs (name → value). Values are opaque JSON. */
  readonly inputs?: Readonly<Record<string, unknown>>;
  /** Assign the run's nodes to a workstream (X4 lineage). */
  readonly workstreamId?: string;
}

/** Pause a running walk (no new steps start; in-flight steps run to completion). */
export interface PipelinePauseRequest {
  readonly kind: 'pipeline-pause';
  readonly requestId: string;
  readonly runId: string;
}

/**
 * Resume a paused/interrupted run FROM THE JOURNAL — completed steps return
 * their cached output, never re-executing (the M5 DoD affordance).
 */
export interface PipelineResumeRequest {
  readonly kind: 'pipeline-resume';
  readonly requestId: string;
  readonly runId: string;
}

/** Abort a run (all in-flight steps aborted, child process groups reaped). */
export interface PipelineCancelRequest {
  readonly kind: 'pipeline-cancel';
  readonly requestId: string;
  readonly runId: string;
}

export type PipelineClientPayload =
  | PipelineValidateRequest
  | PipelineSaveRequest
  | PipelineLaunchRequest
  | PipelinePauseRequest
  | PipelineResumeRequest
  | PipelineCancelRequest;

/** The frozen client verb kinds. */
export const PIPELINE_CLIENT_VERBS = Object.freeze([
  'pipeline-validate',
  'pipeline-save',
  'pipeline-launch',
  'pipeline-pause',
  'pipeline-resume',
  'pipeline-cancel',
] as const);

export type PipelineClientVerb = (typeof PIPELINE_CLIENT_VERBS)[number];

/** Verbs that name an existing run (validated for a well-formed runId). */
export const PIPELINE_RUN_VERBS = Object.freeze([
  'pipeline-pause',
  'pipeline-resume',
  'pipeline-cancel',
] as const);
