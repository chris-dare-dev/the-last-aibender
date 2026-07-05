/**
 * The pipeline ENGINE (BE-8) — the gateway-facing handler for the frozen
 * `pipelines` client verbs (ws-protocol.md §18.2) plus the run lifecycle
 * (launch/pause/resume/cancel) over the durable journal. It ties the planner
 * (capability resolution + drift), the runner (the DAG walk), the memoization
 * journal (migration 0004), lineage/cost, and the status publisher together.
 *
 * VERB HANDLING (§18.2 / §18.4 error contract):
 *   pipeline-validate → pure static validation (the gateway answers this
 *     itself when no engine is composed; the engine also supports it);
 *   pipeline-save     → validate + persist; answered `pipeline-saved`;
 *   pipeline-launch   → validate (inline doc) or load (pipelineId) + plan +
 *     run; typed refusals `pipeline-not-found`/`pipeline-invalid`/`internal`;
 *   pipeline-pause    → pause a running walk (in-flight steps finish);
 *   pipeline-resume   → resume FROM THE JOURNAL (completed steps cached);
 *   pipeline-cancel   → abort + process-group reaping.
 *
 * The engine is the {@link PipelineEnginePort} the composeBroker wires onto the
 * gateway (the ICR-0012 seam — mirrors the M4 WorkstreamEnginePort). Verb
 * refusals throw {@link PipelineEngineError} with the frozen §18.4 codes; the
 * gateway maps them onto pushed errors correlated by `requestId`.
 */

import {
  validateDagDocument,
  type DagDocument,
} from '@aibender/protocol';
import type { PipelinesStore } from '@aibender/schema';
import type { Logger } from '@aibender/shared';
import { newId } from '@aibender/shared';
import { createHash } from 'node:crypto';

import type { StepExecutor } from './executor.js';
import type { PipelineApprovalGate } from './gate.js';
import type { PipelineLineageCost } from './lineageCost.js';
import {
  accountScopedResolver,
  detectDrift,
  planCapabilities,
  type CatalogResolver,
  type ResolvedCapability,
} from './planner.js';
import type { ProcessGroupReaper } from './reaper.js';
import {
  runPipeline,
  type PipelineStatusPublisher,
  type RunPipelineResult,
} from './runner.js';

// ---------------------------------------------------------------------------
// Errors (the frozen §18.4 codes)
// ---------------------------------------------------------------------------

export type PipelineEngineErrorCode =
  | 'bad-request'
  | 'pipeline-not-found'
  | 'pipeline-run-not-found'
  | 'pipeline-invalid'
  | 'step-not-found'
  | 'internal';

export class PipelineEngineError extends Error {
  override readonly name = 'PipelineEngineError';
  constructor(
    readonly code: PipelineEngineErrorCode,
    message: string,
    /** For pipeline-invalid: the validation-result payload the gateway pushes. */
    readonly validation?: {
      readonly issueCode: string;
      readonly issueMessage: string;
      readonly issuePath: string;
    },
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Engine port + options
// ---------------------------------------------------------------------------

export interface ValidateOutcome {
  readonly valid: boolean;
  readonly issueCode?: string;
  readonly issueMessage?: string;
  readonly issuePath?: string;
}

export interface LaunchInput {
  readonly pipelineId?: string;
  readonly document?: DagDocument;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly workstreamId?: string;
}

export interface LaunchOutcome {
  readonly runId: string;
  /** The run settles asynchronously; callers await `done` for the terminal state. */
  readonly done: Promise<RunPipelineResult>;
}

/**
 * The gateway-facing engine port (the ICR-0012 seam; mirrors
 * WorkstreamEnginePort). The gateway calls these after validating the verb
 * shape; typed rejections use {@link PipelineEngineError} with the frozen
 * §18.4 codes.
 */
export interface PipelineEnginePort {
  validate(document: unknown): ValidateOutcome;
  save(document: DagDocument): { pipelineId: string };
  launch(input: LaunchInput): LaunchOutcome;
  pause(runId: string): void;
  resume(runId: string): LaunchOutcome;
  cancel(runId: string): void;
}

export interface PipelineEngineOptions {
  readonly store: PipelinesStore;
  readonly executor: StepExecutor;
  /** The catalog resolver for plan-time capability resolution (planner.ts). */
  readonly resolver?: CatalogResolver;
  readonly gate?: PipelineApprovalGate;
  readonly lineageCost?: PipelineLineageCost;
  readonly reaper?: ProcessGroupReaper;
  readonly publisher?: PipelineStatusPublisher;
  /** The run's workspace (for `${workspace}` + project-scope resolution). */
  readonly workspace?: string;
  readonly logger?: Logger;
  readonly nowMs?: () => number;
  /** Retry backoff sleeper (tests inject a no-op). */
  readonly sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Live-run bookkeeping (pause/cancel controllers per runId)
// ---------------------------------------------------------------------------

interface LiveRun {
  readonly pauseController: AbortController;
  readonly cancelController: AbortController;
  readonly pins: Readonly<Record<string, ResolvedCapability>>;
  readonly document: DagDocument;
}

export function createPipelineEngine(options: PipelineEngineOptions): PipelineEnginePort {
  const { store, executor } = options;
  const logger = options.logger;
  const live = new Map<string, LiveRun>();

  const schemaHashOf = (document: DagDocument): string =>
    `sha256:${createHash('sha256').update(JSON.stringify(document), 'utf8').digest('hex')}`;

  const validate = (document: unknown): ValidateOutcome => {
    const result = validateDagDocument(document);
    if (result.ok) return { valid: true };
    return {
      valid: false,
      issueCode: result.issue.code,
      issueMessage: result.issue.message,
      issuePath: result.issue.path,
    };
  };

  const save = (document: DagDocument): { pipelineId: string } => {
    // The gateway already validated the document shape (validatePipelineClient
    // ran validateDagDocument). Re-validate defensively — a bad doc is
    // `pipeline-invalid`, never persisted.
    const result = validateDagDocument(document);
    if (!result.ok) {
      throw new PipelineEngineError('pipeline-invalid', 'refusing to save an invalid pipeline', {
        issueCode: result.issue.code,
        issueMessage: result.issue.message,
        issuePath: result.issue.path,
      });
    }
    const doc = result.document;
    const row = store.definitions.upsert({
      id: doc.id,
      name: doc.name,
      documentJson: JSON.stringify(doc),
      schemaVersion: doc.schemaVersion,
      schemaHash: schemaHashOf(doc),
    });
    return { pipelineId: row.id };
  };

  /** Plan a document's capabilities (account-scoped when a default account is set). */
  const plan = (
    document: DagDocument,
  ): { ok: true; pins: Readonly<Record<string, ResolvedCapability>> } | { ok: false; error: PipelineEngineError } => {
    const baseResolver = options.resolver;
    if (baseResolver === undefined) {
      // No catalog composed: prompt/workflow-script pipelines still run; a
      // skill/agent step without a resolver is an unresolved-capability plan
      // failure only if such a step exists.
      const needsResolution = document.steps.some((s) => s.kind === 'skill' || s.kind === 'agent');
      if (!needsResolution) return { ok: true, pins: {} };
      return {
        ok: false,
        error: new PipelineEngineError(
          'pipeline-invalid',
          'pipeline references a skill/agent but no catalog is composed to resolve it',
        ),
      };
    }
    const defaultAccount = document.defaults?.account;
    const resolver =
      defaultAccount !== undefined ? accountScopedResolver(baseResolver, defaultAccount) : baseResolver;
    const result = planCapabilities(document, resolver);
    if (!result.ok) {
      return {
        ok: false,
        error: new PipelineEngineError('pipeline-invalid', result.issue.message, {
          issueCode: result.issue.code,
          issueMessage: result.issue.message,
          issuePath: `steps.${result.issue.stepId}`,
        }),
      };
    }
    return { ok: true, pins: result.pins };
  };

  const startRun = (
    runId: string,
    document: DagDocument,
    schemaHash: string,
    pins: Readonly<Record<string, ResolvedCapability>>,
    driftedSteps: readonly string[],
    inputs: Readonly<Record<string, unknown>> | undefined,
    workstreamId: string | undefined,
  ): LaunchOutcome => {
    const pauseController = new AbortController();
    const cancelController = new AbortController();
    live.set(runId, { pauseController, cancelController, pins, document });

    const done = runPipeline({
      runId,
      pipelineId: document.id,
      document,
      schemaHash,
      ...(inputs !== undefined ? { inputs } : {}),
      ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
      ...(workstreamId !== undefined ? { workstreamId } : {}),
      pins,
      driftedSteps,
      store,
      executor,
      ...(options.gate !== undefined ? { gate: options.gate } : {}),
      ...(options.lineageCost !== undefined ? { lineageCost: options.lineageCost } : {}),
      ...(options.reaper !== undefined ? { reaper: options.reaper } : {}),
      ...(options.publisher !== undefined ? { publisher: options.publisher } : {}),
      ...(logger !== undefined ? { logger } : {}),
      ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
      pauseSignal: pauseController.signal,
      cancelSignal: cancelController.signal,
    }).finally(() => {
      live.delete(runId);
    });

    return { runId, done };
  };

  const launch = (input: LaunchInput): LaunchOutcome => {
    let document: DagDocument;
    if (input.document !== undefined) {
      const result = validateDagDocument(input.document);
      if (!result.ok) {
        throw new PipelineEngineError('pipeline-invalid', 'inline pipeline is invalid', {
          issueCode: result.issue.code,
          issueMessage: result.issue.message,
          issuePath: result.issue.path,
        });
      }
      document = result.document;
    } else if (input.pipelineId !== undefined) {
      const saved = store.definitions.get(input.pipelineId);
      if (saved === undefined) {
        throw new PipelineEngineError('pipeline-not-found', `no saved pipeline ${input.pipelineId}`);
      }
      const parsed = safeParseDocument(saved.documentJson);
      if (parsed === undefined) {
        throw new PipelineEngineError('internal', 'saved pipeline document failed to parse');
      }
      document = parsed;
    } else {
      throw new PipelineEngineError('bad-request', 'launch requires exactly one of pipelineId|document');
    }

    const planned = plan(document);
    if (!planned.ok) throw planned.error;

    const schemaHash = schemaHashOf(document);
    const runId = newId('run');
    // Persist the run BEFORE the walk (row-before-work — the resume ledger
    // discipline). A launch of an inline doc persists the definition too so a
    // resume can re-load it.
    ensureDefinition(document, schemaHash);
    store.runs.insert({
      id: runId,
      pipelineId: document.id,
      schemaHash,
      ...(input.inputs !== undefined ? { inputsJson: JSON.stringify(input.inputs) } : {}),
      ...(input.workstreamId !== undefined ? { workstreamId: input.workstreamId } : {}),
      status: 'pending',
    });

    return startRun(runId, document, schemaHash, planned.pins, [], input.inputs, input.workstreamId);
  };

  const resume = (runId: string): LaunchOutcome => {
    const run = store.runs.get(runId);
    if (run === undefined) {
      throw new PipelineEngineError('pipeline-run-not-found', `no run ${runId}`);
    }
    const saved = store.definitions.get(run.pipelineId);
    if (saved === undefined) {
      throw new PipelineEngineError('pipeline-not-found', `run ${runId} references a missing pipeline`);
    }
    const document = safeParseDocument(saved.documentJson);
    if (document === undefined) {
      throw new PipelineEngineError('internal', 'saved pipeline document failed to parse');
    }

    // Re-plan + drift-detect: a capability whose source changed since the run
    // was planned invalidates that step's journal (the M5 DoD).
    const planned = plan(document);
    if (!planned.ok) throw planned.error;
    const drifted =
      options.resolver !== undefined
        ? detectDrift(planned.pins, resolverForDocument(document), document).map((i) => i.stepId)
        : [];

    const inputs = run.inputsJson !== null ? safeParseRecord(run.inputsJson) : undefined;
    return startRun(
      runId,
      document,
      run.schemaHash,
      planned.pins,
      drifted,
      inputs,
      run.workstreamId ?? undefined,
    );
  };

  const resolverForDocument = (document: DagDocument): CatalogResolver => {
    const base = options.resolver;
    if (base === undefined) return () => undefined;
    const defaultAccount = document.defaults?.account;
    return defaultAccount !== undefined ? accountScopedResolver(base, defaultAccount) : base;
  };

  const pause = (runId: string): void => {
    const run = live.get(runId);
    if (run === undefined) {
      // Not live: it may already have settled — pause is idempotent, but an
      // unknown run id is the frozen error.
      if (store.runs.get(runId) === undefined) {
        throw new PipelineEngineError('pipeline-run-not-found', `no run ${runId}`);
      }
      return;
    }
    run.pauseController.abort();
  };

  const cancel = (runId: string): void => {
    const run = live.get(runId);
    if (run === undefined) {
      if (store.runs.get(runId) === undefined) {
        throw new PipelineEngineError('pipeline-run-not-found', `no run ${runId}`);
      }
      // Settled already: mark cancelled if not terminal (idempotent).
      return;
    }
    run.cancelController.abort();
  };

  const ensureDefinition = (document: DagDocument, schemaHash: string): void => {
    if (store.definitions.get(document.id) !== undefined) return;
    try {
      store.definitions.upsert({
        id: document.id,
        name: document.name,
        documentJson: JSON.stringify(document),
        schemaVersion: document.schemaVersion,
        schemaHash,
      });
    } catch (cause) {
      logger?.warn('ensureDefinition failed (non-fatal)', { detail: (cause as Error).message });
    }
  };

  return { validate, save, launch, pause, resume, cancel };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function safeParseDocument(json: string): DagDocument | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  const result = validateDagDocument(parsed);
  return result.ok ? result.document : undefined;
}

function safeParseRecord(json: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
