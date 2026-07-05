/**
 * THE versioned JSON DAG runner (BE-8; findings pipeline-workflow-builder
 * §R2/§R3, blueprint §7, dag-schema.md v1). Walks a validated DAG document:
 *
 *   - TOPOLOGICAL WALK honoring `needs` (parallel = same generation);
 *   - `when` conditional skip (skip propagates to dependents whose needs are
 *     all skipped/failed);
 *   - `forEach` + `maxParallel` matrix fan-out (empty forEach → the step is
 *     `skipped`, zero iterations);
 *   - `loop {until, maxIterations}` "fix until the check passes";
 *   - PER-STEP account routing through the {@link StepExecutor} seam ([X1]);
 *   - PER-STEP budget (usd/turns/wallClockSec) → AbortController + child
 *     process-GROUP reaping on breach (no orphan children);
 *   - retry policy (max/backoffSec/retryOn) — outputSchema failure is a
 *     retryable step failure;
 *   - first-class `approval` GATES (pause → inbox → decision resumes/aborts);
 *   - THE durable MEMOIZATION JOURNAL over migration 0004: a completed
 *     (runId, stepId, iteration, inputHash) returns its cached output WITHOUT
 *     re-execution — cross-restart resume (the M5 DoD);
 *   - lineage `workflow` edges + per-step cost (lineageCost.ts);
 *   - `pipeline-run-status` / `pipeline-step-status` wire fan-out.
 *
 * The DAG document is validated by the frozen `validateDagDocument` BEFORE the
 * runner sees it (the engine/gateway run it); the runner assumes a sanitized
 * document and adds the catalog-resolution + execution layers.
 *
 * NEVER makes a real model call in tests: every step runs against a fake
 * StepExecutor (rule 3). The journal is a real @aibender/schema store (proving
 * durable resume with a real store torn down + reopened mid-run).
 */

import type {
  AccountLabel,
  DagDefaults,
  DagDocument,
  PipelineStep,
  PipelineStepState,
  StepBackend,
} from '@aibender/protocol';
import { accountStepBackendsFor, backendForLabel } from '@aibender/protocol';
import type { PipelinesStore, StepAttemptRow } from '@aibender/schema';
import type { Logger } from '@aibender/shared';
import { newId } from '@aibender/shared';

import type { StepExecutor, StepExecutionRequest } from './executor.js';
import type { PipelineApprovalGate } from './gate.js';
import { computeInputHash } from './inputHash.js';
import type { PipelineLineageCost, StepAttemptLineage } from './lineageCost.js';
import type { ResolvedCapability } from './planner.js';
import type { ProcessGroupReaper } from './reaper.js';
import {
  evaluateCondition,
  renderTemplate,
  resolveArray,
  type TemplateScope,
} from './template.js';

// ---------------------------------------------------------------------------
// Status publisher port (the wire fan-out, ws-protocol.md §18.1)
// ---------------------------------------------------------------------------

export interface PipelineRunStatusUpdate {
  readonly runId: string;
  readonly pipelineId: string;
  readonly state: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  readonly schemaHash?: string;
  readonly costEstimatedUsd?: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly resumable?: boolean;
}

export interface PipelineStepStatusUpdate {
  readonly runId: string;
  readonly stepId: string;
  readonly iteration: number;
  readonly attempt: number;
  readonly state: PipelineStepState;
  readonly sessionId?: string;
  readonly account?: AccountLabel;
  readonly costEstimatedUsd?: number;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly errorKind?: string;
}

/** The runner's wire sink — the composition root adapts it to publishPipeline. */
export interface PipelineStatusPublisher {
  runStatus(update: PipelineRunStatusUpdate): void;
  stepStatus(update: PipelineStepStatusUpdate): void;
}

// ---------------------------------------------------------------------------
// Runner options + result
// ---------------------------------------------------------------------------

export interface RunPipelineOptions {
  readonly runId: string;
  readonly pipelineId: string;
  readonly document: DagDocument;
  /** sha256 of the document JSON, pinned into the run (drift detection). */
  readonly schemaHash: string;
  /** Bound inputs (name → value). */
  readonly inputs?: Readonly<Record<string, unknown>>;
  /** The run's workspace (`${workspace}`). */
  readonly workspace?: string;
  /** Optional workstream the run's step nodes belong to. */
  readonly workstreamId?: string;
  /** Plan-time pinned capabilities (skill/agent steps) — planner.ts. */
  readonly pins?: Readonly<Record<string, ResolvedCapability>>;
  /** Step ids whose journal was invalidated by drift (memoized output discarded). */
  readonly driftedSteps?: readonly string[];
  /** THE durable memoization journal (migration 0004). */
  readonly store: PipelinesStore;
  readonly executor: StepExecutor;
  readonly gate?: PipelineApprovalGate;
  readonly lineageCost?: PipelineLineageCost;
  readonly reaper?: ProcessGroupReaper;
  readonly publisher?: PipelineStatusPublisher;
  readonly logger?: Logger;
  readonly nowMs?: () => number;
  /**
   * A run-level abort surface (pause/cancel). When `signal.aborted`, no NEW
   * steps start; in-flight steps run to completion on PAUSE (the frozen
   * pause semantics) or are aborted+reaped on CANCEL (see `cancelSignal`).
   */
  readonly pauseSignal?: AbortSignal;
  readonly cancelSignal?: AbortSignal;
  /** Retry backoff sleeper (tests inject a no-op). */
  readonly sleep?: (ms: number) => Promise<void>;
}

export type RunOutcome = 'completed' | 'failed' | 'cancelled' | 'paused';

export interface RunPipelineResult {
  readonly outcome: RunOutcome;
  /** Terminal step states by step id (last iteration/attempt per step). */
  readonly stepStates: Readonly<Record<string, PipelineStepState>>;
  /** Σ per-step cost estimate. */
  readonly costEstimatedUsd: number;
}

// ---------------------------------------------------------------------------
// Internal per-run bookkeeping
// ---------------------------------------------------------------------------

/** A step's terminal outcome across all iterations (for needs-gating). */
type StepDisposition = 'completed' | 'failed' | 'skipped' | 'cancelled';

const DEFAULT_MAX_PARALLEL = 1;

export async function runPipeline(options: RunPipelineOptions): Promise<RunPipelineResult> {
  const {
    runId,
    pipelineId,
    document,
    schemaHash,
    store,
    executor,
    logger,
  } = options;
  const nowMs = options.nowMs ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const inputs = options.inputs ?? {};
  const drifted = new Set(options.driftedSteps ?? []);

  const stepsById = new Map(document.steps.map((s) => [s.id, s]));
  const disposition = new Map<string, StepDisposition>();
  const stepOutputs: Record<string, unknown> = {};
  // The spawned node id per (stepId, iteration) — the workflow-edge source.
  const stepNodeByKey = new Map<string, string>();
  const stepNodesByStep = new Map<string, string[]>();
  let totalCost = 0;

  const publishRun = (
    state: PipelineRunStatusUpdate['state'],
    extra: Partial<PipelineRunStatusUpdate> = {},
  ): void => {
    options.publisher?.runStatus({
      runId,
      pipelineId,
      state,
      schemaHash,
      costEstimatedUsd: totalCost,
      ...extra,
    });
  };

  const publishStep = (update: PipelineStepStatusUpdate): void => {
    options.publisher?.stepStatus(update);
  };

  const runStartedAt = nowMs();
  store.runs.setStatus(runId, 'running', { startedAtMs: runStartedAt });
  publishRun('running', { startedAt: runStartedAt });

  // A run is a DAG; walk it by GENERATION (Kahn layers). Within a generation,
  // independent steps run concurrently (bounded per-step by forEach maxParallel;
  // the generation itself runs all-ready-steps concurrently).
  const remaining = new Set(stepsById.keys());
  let cancelled = false;
  let paused = false;

  const runReady = async (): Promise<void> => {
    for (;;) {
      if (cancelled || paused) return;
      const ready = [...remaining].filter((id) => needsSatisfied(id));
      if (ready.length === 0) return;
      // Run this generation's ready steps concurrently.
      await Promise.all(ready.map((id) => runStep(id)));
    }
  };

  const needsSatisfied = (stepId: string): boolean => {
    const step = stepsById.get(stepId);
    if (step === undefined) return false;
    for (const need of step.needs ?? []) {
      const d = disposition.get(need);
      if (d === undefined) return false; // upstream not settled yet
    }
    return true;
  };

  const markStepDone = (stepId: string, d: StepDisposition): void => {
    disposition.set(stepId, d);
    remaining.delete(stepId);
  };

  const runStep = async (stepId: string): Promise<void> => {
    remaining.delete(stepId); // claim it so concurrent generations don't double-run
    const step = stepsById.get(stepId);
    if (step === undefined) return;

    // -- when: conditional skip (also skip if any upstream skipped/failed AND
    //    this step gains nothing — but the DAG contract is: needs are hard
    //    edges; a step with a failed `needs` under onError:continue still runs
    //    if the failed dep's output isn't required. We use: skip when `when`
    //    is falsy, OR when EVERY need is skipped/cancelled). ------------------
    const scope = baseScope();
    if (skipByUpstream(step)) {
      recordSkip(step, 'skipped-upstream');
      markStepDone(stepId, 'skipped');
      return;
    }
    if (step.when !== undefined && !evaluateCondition(renderTemplate(step.when, scope), scope)) {
      recordSkip(step, 'when-false');
      markStepDone(stepId, 'skipped');
      return;
    }

    if (step.kind === 'approval') {
      const outcome = await runGate(step);
      markStepDone(stepId, outcome);
      return;
    }

    // -- forEach fan-out -------------------------------------------------------
    if (step.forEach !== undefined) {
      // Pass the RAW forEach expression (a `${…}` reference) to resolveArray so
      // it resolves to the actual array — rendering it to a string first would
      // JSON-stringify the array and lose its type.
      const items = resolveArray(step.forEach, scope);
      if (items.length === 0) {
        recordSkip(step, 'foreach-empty');
        markStepDone(stepId, 'skipped');
        return;
      }
      const maxParallel = Math.max(1, Math.min(16, step.maxParallel ?? DEFAULT_MAX_PARALLEL));
      const results = await runBounded(items, maxParallel, (item, iteration) =>
        runIterations(step, iteration, item),
      );
      markStepDone(stepId, results.every((ok) => ok) ? 'completed' : 'failed');
      return;
    }

    // -- scalar (iteration 0), possibly with loop-until -----------------------
    const ok = await runIterations(step, 0, undefined);
    markStepDone(stepId, ok ? 'completed' : 'failed');
  };

  /**
   * Run one iteration slot of a step, honoring `loop {until, maxIterations}`:
   * repeat the body until `until` is truthy or the cap is hit. Without a loop,
   * runs the body once. Returns whether the (last) attempt succeeded.
   */
  const runIterations = async (
    step: Exclude<PipelineStep, { kind: 'approval' }>,
    iteration: number,
    item: unknown,
  ): Promise<boolean> => {
    const loop = step.loop;
    const maxLoops = loop !== undefined ? loop.maxIterations : 1;
    let lastOk = false;
    for (let loopIdx = 0; loopIdx < maxLoops; loopIdx += 1) {
      if (cancelled || paused) return lastOk;
      // Loop iterations reuse the SAME journal iteration index but a distinct
      // effective slot via the loop counter folded into the iteration number
      // so each loop pass journals independently.
      const effectiveIteration = loop !== undefined ? iteration * 1000 + loopIdx : iteration;
      lastOk = await runOneAttempt(step, effectiveIteration, item);
      if (!lastOk) return false;
      if (loop === undefined) return true;
      // Evaluate the loop-until against the FRESH scope (this step's output is
      // now journaled) — truthy = stop.
      const scope = baseScope(item);
      if (evaluateCondition(renderTemplate(loop.until, scope), scope)) return true;
    }
    return lastOk;
  };

  /**
   * Run ONE step attempt with the memoization journal + retry policy.
   * Returns whether the step ultimately succeeded (across retries).
   */
  const runOneAttempt = async (
    step: Exclude<PipelineStep, { kind: 'approval' }>,
    iteration: number,
    item: unknown,
  ): Promise<boolean> => {
    const account = resolveAccount(step, document.defaults);
    const backend = resolveBackend(step, document.defaults, account);
    const cwd = resolveCwd(step, document.defaults, item);
    const pin = options.pins?.[step.id];
    const scope = baseScope(item);

    const invocation = renderInvocation(step, scope, pin);
    const inputHash = computeInputHash({
      kind: step.kind,
      account,
      backend,
      cwd,
      ...(invocation.prompt !== undefined ? { prompt: invocation.prompt } : {}),
      ...(invocation.skillName !== undefined ? { skillName: invocation.skillName } : {}),
      ...(invocation.agentName !== undefined ? { agentName: invocation.agentName } : {}),
      ...(invocation.scriptPath !== undefined ? { scriptPath: invocation.scriptPath } : {}),
      ...(pin !== undefined ? { capabilityContentHash: pin.contentHash } : {}),
      ...(item !== undefined ? { item } : {}),
    });

    // -- THE MEMOIZATION JOURNAL LOOKUP (cross-restart resume) ----------------
    // A completed attempt for (runId, stepId, iteration, inputHash) returns its
    // cached output WITHOUT re-execution — UNLESS this step drifted (its
    // capability source changed since planning), in which case the journal is
    // invalid and we re-execute (journal invalidation on contentHash drift).
    if (!drifted.has(step.id)) {
      const memo = store.stepAttempts.findMemoized(runId, step.id, iteration, inputHash);
      if (memo !== undefined) {
        applyMemoHit(step, iteration, memo);
        return true;
      }
    }

    // -- attempt loop with retry policy ---------------------------------------
    const maxAttempts = 1 + (step.retry?.max ?? 0);
    const retryOn = new Set(step.retry?.retryOn ?? ['rate_limit', 'overloaded', 'timeout', 'network']);
    // Continue the append-only journal: on a resume the (stepId, iteration) may
    // already carry FAILED attempts, so start at latest+1 (the UNIQUE index
    // rejects a re-used attempt number). The retry cap counts NEW attempts.
    const firstAttempt = latestAttemptNumber(runId, step.id, iteration) + 1;
    let attempt = firstAttempt;
    for (;;) {
      if (cancelled) {
        recordStepAttempt(step, iteration, attempt, inputHash, account, {
          status: 'cancelled',
        });
        return false;
      }
      const row = store.stepAttempts.record({
        id: newId('sa'),
        runId,
        stepId: step.id,
        iteration,
        attempt,
        inputHash,
        status: 'running',
        account,
      });
      publishStep({
        runId,
        stepId: step.id,
        iteration,
        attempt,
        state: 'running',
        account,
        startedAt: nowMs(),
      });

      const result = await executeWithBudget(step, iteration, attempt, {
        runId,
        stepId: step.id,
        iteration,
        attempt,
        account,
        backend,
        cwd,
        ...(invocation.prompt !== undefined ? { prompt: invocation.prompt } : {}),
        ...(invocation.skillName !== undefined ? { skillName: invocation.skillName } : {}),
        ...(invocation.agentName !== undefined ? { agentName: invocation.agentName } : {}),
        ...(invocation.scriptPath !== undefined ? { scriptPath: invocation.scriptPath } : {}),
        ...(step.budget?.turns !== undefined ? { maxTurns: step.budget.turns } : {}),
        ...(step.outputSchema !== undefined ? { outputSchema: step.outputSchema } : {}),
        signal: new AbortController().signal, // replaced inside executeWithBudget
      });

      const finishedAt = nowMs();
      const succeeded = result.ok && result.outputSchemaFailed !== true;
      const cost = result.costEstimatedUsd;
      if (cost !== undefined) totalCost += cost;

      // Journal the terminal attempt state.
      const terminalState: PipelineStepState = succeeded ? 'completed' : 'failed';
      store.stepAttempts.complete(row.id, {
        status: terminalState,
        ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
        account,
        ...(result.output !== undefined ? { outputJson: JSON.stringify(result.output) } : {}),
        ...(cost !== undefined ? { costEstimatedUsd: cost } : {}),
        ...(result.tokensIn !== undefined ? { tokensIn: result.tokensIn } : {}),
        ...(result.tokensOut !== undefined ? { tokensOut: result.tokensOut } : {}),
        ...(succeeded ? {} : { errorKind: errorKindOf(result) }),
        finishedAtMs: finishedAt,
      });

      // Lineage: register the step-attempt node + workflow edges from its
      // upstreams' nodes. Cost lands in the events store.
      recordLineageAndCost(step, iteration, account, result, succeeded);

      publishStep({
        runId,
        stepId: step.id,
        iteration,
        attempt,
        state: terminalState,
        ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
        account,
        ...(cost !== undefined ? { costEstimatedUsd: cost } : {}),
        ...(result.tokensIn !== undefined ? { tokensIn: result.tokensIn } : {}),
        ...(result.tokensOut !== undefined ? { tokensOut: result.tokensOut } : {}),
        finishedAt,
        ...(succeeded ? {} : { errorKind: errorKindOf(result) }),
      });

      if (succeeded) {
        if (result.output !== undefined) stepOutputs[step.id] = result.output;
        return true;
      }

      // -- failure: retry per policy ------------------------------------------
      const kind = result.outputSchemaFailed === true ? 'error' : (result.errorKind ?? 'error');
      const retryable = result.outputSchemaFailed === true || retryOn.has(kind as never);
      const attemptsThisRun = attempt - firstAttempt + 1;
      attempt += 1;
      if (attemptsThisRun >= maxAttempts || !retryable || cancelled) {
        return false;
      }
      const backoff = step.retry?.backoffSec;
      if (backoff !== undefined && backoff > 0) await sleep(backoff * 1000);
    }
  };

  /**
   * Execute a step with its budget: an AbortController the runner aborts on
   * wall-clock breach or run cancel, plus process-group reaping. The executor
   * MAY register its child's pgid with the reaper (via the reaper the
   * composition root shares); on breach the runner reaps it.
   */
  const executeWithBudget = async (
    step: Exclude<PipelineStep, { kind: 'approval' }>,
    iteration: number,
    attempt: number,
    request: StepExecutionRequest,
  ): ReturnType<StepExecutor['execute']> => {
    const controller = new AbortController();
    const reapKey = `${request.runId}:${request.stepId}:${iteration}:${attempt}`;
    let breached = false;

    // Wall-clock budget → abort + reap on timeout.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wallClockSec = step.budget?.wallClockSec;
    if (wallClockSec !== undefined) {
      timer = setTimeout(() => {
        breached = true;
        controller.abort();
        options.reaper?.reapStep(reapKey);
      }, wallClockSec * 1000);
      (timer as { unref?: () => void }).unref?.();
    }

    // Run cancel → abort + reap the in-flight step immediately.
    const onCancel = (): void => {
      controller.abort();
      options.reaper?.reapStep(reapKey);
    };
    options.cancelSignal?.addEventListener('abort', onCancel, { once: true });

    try {
      const result = await executor.execute({ ...request, signal: controller.signal });
      options.reaper?.clear(reapKey);
      if (breached) {
        // A breach that raced a late success is still a breach (budget wins).
        return { ok: false, errorKind: 'timeout' };
      }
      return result;
    } catch (cause) {
      // A throwing executor is a programmer error → generic error-kind failure.
      logger?.error('pipeline step executor threw (treated as failure)', {
        stepId: step.id,
        detail: (cause as Error).message,
      });
      options.reaper?.reapStep(reapKey);
      return { ok: false, errorKind: 'error' };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.cancelSignal?.removeEventListener('abort', onCancel);
    }
  };

  // -- gate (approval step) ---------------------------------------------------
  const runGate = async (step: Extract<PipelineStep, { kind: 'approval' }>): Promise<StepDisposition> => {
    const account = document.defaults?.account ?? 'MAX_A';
    publishStep({
      runId,
      stepId: step.id,
      iteration: 0,
      attempt: 0,
      state: 'awaiting-approval',
      account,
      startedAt: nowMs(),
    });
    // Journal the gate as a step_attempt so a resume knows it was reached.
    const row = store.stepAttempts.record({
      id: newId('sa'),
      runId,
      stepId: step.id,
      iteration: 0,
      attempt: 0,
      inputHash: `gate:${step.id}`,
      status: 'awaiting-approval',
      account,
    });

    if (options.gate === undefined) {
      // No gate wired → a gate cannot resolve; treat per onTimeout (fail-safe).
      const settle: StepDisposition = step.onTimeout === 'continue' ? 'completed' : 'failed';
      store.stepAttempts.complete(row.id, { status: settle === 'completed' ? 'completed' : 'failed' });
      publishStep({
        runId,
        stepId: step.id,
        iteration: 0,
        attempt: 0,
        state: settle === 'completed' ? 'completed' : 'failed',
        account,
        finishedAt: nowMs(),
      });
      return settle;
    }

    const handle = options.gate.request({
      runId,
      stepId: step.id,
      summary: step.summary ?? `pipeline gate: ${step.id}`,
      accountLabel: account,
      ...(step.timeoutSec !== undefined ? { ttlMs: step.timeoutSec * 1000 } : {}),
    });
    const { outcome } = await handle.resolution;
    // allowed → the walk continues; anything else → the gate fails the branch,
    // EXCEPT an expiry under onTimeout:continue.
    let disp: StepDisposition;
    if (outcome === 'allowed') disp = 'completed';
    else if (outcome === 'expired' && step.onTimeout === 'continue') disp = 'completed';
    else if (outcome === 'superseded') disp = 'cancelled';
    else disp = 'failed';

    const finalState: PipelineStepState =
      disp === 'completed' ? 'completed' : disp === 'cancelled' ? 'cancelled' : 'failed';
    store.stepAttempts.complete(row.id, { status: finalState });
    publishStep({
      runId,
      stepId: step.id,
      iteration: 0,
      attempt: 0,
      state: finalState,
      account,
      finishedAt: nowMs(),
    });
    return disp;
  };

  // -- helpers ----------------------------------------------------------------

  const baseScope = (item?: unknown): TemplateScope => ({
    ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
    inputs,
    steps: stepOutputs,
    ...(item !== undefined ? { item } : {}),
  });

  const applyMemoHit = (
    step: PipelineStep,
    iteration: number,
    memo: StepAttemptRow,
  ): void => {
    // A cache hit is journaled as a fresh `memoized` attempt so the run monitor
    // shows the resume-from-journal state (the M5 DoD) — append-only.
    const nextAttempt = latestAttemptNumber(runId, step.id, iteration) + 1;
    store.stepAttempts.record({
      id: newId('sa'),
      runId,
      stepId: step.id,
      iteration,
      attempt: nextAttempt,
      inputHash: memo.inputHash,
      status: 'memoized',
      ...(memo.account !== null ? { account: memo.account } : {}),
    });
    if (memo.outputJson !== null) {
      try {
        stepOutputs[step.id] = JSON.parse(memo.outputJson);
      } catch {
        stepOutputs[step.id] = undefined;
      }
    }
    publishStep({
      runId,
      stepId: step.id,
      iteration,
      attempt: nextAttempt,
      state: 'memoized',
      ...(memo.account !== null ? { account: memo.account } : {}),
      ...(memo.costEstimatedUsd !== null ? { costEstimatedUsd: memo.costEstimatedUsd } : {}),
      finishedAt: nowMs(),
    });
  };

  const latestAttemptNumber = (rid: string, stepId: string, iteration: number): number => {
    const rows = store.stepAttempts
      .listByRun(rid)
      .filter((r) => r.stepId === stepId && r.iteration === iteration);
    return rows.reduce((max, r) => Math.max(max, r.attempt), -1);
  };

  const recordStepAttempt = (
    step: PipelineStep,
    iteration: number,
    attempt: number,
    inputHash: string,
    account: AccountLabel,
    patch: { status: PipelineStepState },
  ): void => {
    const row = store.stepAttempts.record({
      id: newId('sa'),
      runId,
      stepId: step.id,
      iteration,
      attempt,
      inputHash,
      status: patch.status,
      account,
    });
    void row;
    publishStep({
      runId,
      stepId: step.id,
      iteration,
      attempt,
      state: patch.status,
      account,
      finishedAt: nowMs(),
    });
  };

  const recordSkip = (step: PipelineStep, _reason: string): void => {
    const account = step.kind === 'approval' ? (document.defaults?.account ?? 'MAX_A') : resolveAccount(step, document.defaults);
    publishStep({
      runId,
      stepId: step.id,
      iteration: 0,
      attempt: 0,
      state: 'skipped',
      account,
      finishedAt: nowMs(),
    });
  };

  const skipByUpstream = (step: PipelineStep): boolean => {
    const needs = step.needs ?? [];
    if (needs.length === 0) return false;
    // A dependent runs only when EVERY need COMPLETED. Any need that failed,
    // was cancelled, or was skipped blocks this step (skip propagation) —
    // UNLESS that failed need declared `onError: continue`, which permits
    // independent successors to proceed (dag-schema.md §2). A cancelled need
    // always blocks. This is the frozen `needs`-are-hard-edges semantics.
    return needs.some((n) => {
      const d = disposition.get(n);
      if (d === 'completed') return false;
      if (d === 'failed') {
        const need = stepsById.get(n);
        // `onError: continue` on the failed need lets successors proceed.
        return !(need !== undefined && need.kind !== 'approval' && need.onError === 'continue');
      }
      // skipped / cancelled → block.
      return true;
    });
  };

  const recordLineageAndCost = (
    step: PipelineStep,
    iteration: number,
    account: AccountLabel,
    result: { sessionId?: string; costEstimatedUsd?: number; tokensIn?: number; tokensOut?: number },
    succeeded: boolean,
  ): void => {
    const lc = options.lineageCost;
    if (lc === undefined) return;
    const lineageInput: StepAttemptLineage = {
      runId,
      stepId: step.id,
      iteration,
      account,
      ...(options.workstreamId !== undefined ? { workstreamId: options.workstreamId } : {}),
      ...(result.costEstimatedUsd !== undefined ? { costEstimatedUsd: result.costEstimatedUsd } : {}),
      ...(result.tokensIn !== undefined ? { tokensIn: result.tokensIn } : {}),
      ...(result.tokensOut !== undefined ? { tokensOut: result.tokensOut } : {}),
      ok: succeeded,
    };
    const registration = lc.registerStepNode(lineageInput);
    if (registration !== undefined) {
      const key = `${step.id}:${iteration}`;
      stepNodeByKey.set(key, registration.sessionId);
      const perStep = stepNodesByStep.get(step.id) ?? [];
      perStep.push(registration.sessionId);
      stepNodesByStep.set(step.id, perStep);
      // Record workflow edges from each upstream step's nodes to this node.
      for (const need of step.needs ?? []) {
        for (const fromNode of stepNodesByStep.get(need) ?? []) {
          lc.recordWorkflowEdge({
            runId,
            fromStep: need,
            fromNode,
            toStep: step.id,
            toNode: registration.sessionId,
          });
        }
      }
    }
    lc.landCost(lineageInput);
  };

  // -- the walk ---------------------------------------------------------------
  // Watch pause/cancel signals.
  const onPause = (): void => {
    paused = true;
  };
  const onCancelRun = (): void => {
    cancelled = true;
    options.reaper?.reapAll();
  };
  if (options.pauseSignal?.aborted) paused = true;
  else options.pauseSignal?.addEventListener('abort', onPause, { once: true });
  if (options.cancelSignal?.aborted) cancelled = true;
  else options.cancelSignal?.addEventListener('abort', onCancelRun, { once: true });

  try {
    await runReady();
  } finally {
    options.pauseSignal?.removeEventListener('abort', onPause);
    options.cancelSignal?.removeEventListener('abort', onCancelRun);
  }

  // -- terminal run state -----------------------------------------------------
  const stepStates: Record<string, PipelineStepState> = {};
  for (const [id, d] of disposition) stepStates[id] = d;

  let outcome: RunOutcome;
  if (cancelled) outcome = 'cancelled';
  else if (paused) outcome = 'paused';
  else if ([...disposition.values()].some((d) => d === 'failed')) outcome = 'failed';
  else outcome = 'completed';

  const finishedAt = nowMs();
  const runState =
    outcome === 'completed'
      ? 'completed'
      : outcome === 'cancelled'
        ? 'cancelled'
        : outcome === 'paused'
          ? 'paused'
          : 'failed';
  store.runs.setStatus(runId, runState, {
    costEstimatedUsd: totalCost,
    ...(outcome === 'paused' ? {} : { finishedAtMs: finishedAt }),
  });
  publishRun(runState, {
    costEstimatedUsd: totalCost,
    ...(outcome === 'paused' ? { resumable: true } : { finishedAt }),
    // paused/failed runs are resumable from the journal.
    ...(outcome === 'paused' || outcome === 'failed' ? { resumable: true } : {}),
  });

  return { outcome, stepStates, costEstimatedUsd: totalCost };
}

// ---------------------------------------------------------------------------
// Resolution helpers (account / backend / cwd / invocation)
// ---------------------------------------------------------------------------

function resolveAccount(
  step: Exclude<PipelineStep, { kind: 'approval' }>,
  defaults: DagDefaults | undefined,
): AccountLabel {
  return step.account ?? defaults?.account ?? 'MAX_A';
}

function resolveBackend(
  step: Exclude<PipelineStep, { kind: 'approval' }>,
  defaults: DagDefaults | undefined,
  account: AccountLabel,
): StepBackend {
  const explicit = step.backend ?? defaults?.backend;
  if (explicit !== undefined) return explicit;
  // Default to the account's canonical backend family. AWS_DEV → opencode
  // (the generic route); MAX_*/ENT → claude; LOCAL → lmstudio. For a REGISTERED
  // 4th backend (ICR-0016 / OS-1) whose label is not one of the built-in forms,
  // accountStepBackendsFor returns [] (its STEP_BACKENDS vocabulary is a
  // protocol-package concern), and mapWireBackend carries the wire id through.
  const legal = accountStepBackendsFor(account);
  return legal[0] ?? mapWireBackend(account);
}

/**
 * Fallback wire→step-backend map for accounts outside the built-in step-backend
 * families (a registered 4th backend, ICR-0016 / finding OS-1). Resolves through
 * the frozen `backendForLabel` (registry-backed) instead of a closed if-chain:
 * the built-in three keep their canonical step-backend name (byte-identical —
 * but this path is DEAD for them, since accountStepBackendsFor always returns a
 * non-empty family for a built-in label), and a registered id is carried through
 * as its own StepBackend (the honest `as StepBackend` widening mirrors
 * `backendForLabel`'s `as Backend`: STEP_BACKENDS is the built-in union, a
 * registered id is a runtime string the executor seam treats opaquely). This
 * REPLACES the former `if (wire === 'claude_code') … return 'lmstudio'` chain,
 * which silently mis-mapped every unregistered/4th backend to `lmstudio`.
 */
function mapWireBackend(account: AccountLabel): StepBackend {
  const wire = backendForLabel(account);
  if (wire === 'claude_code') return 'claude';
  return wire as StepBackend;
}

function resolveCwd(
  step: Exclude<PipelineStep, { kind: 'approval' }>,
  defaults: DagDefaults | undefined,
  _item: unknown,
): string {
  return step.cwd ?? defaults?.cwd ?? '${workspace}';
}

interface Invocation {
  readonly prompt?: string;
  readonly skillName?: string;
  readonly agentName?: string;
  readonly scriptPath?: string;
}

/** Render the executor invocation for a step (templating resolved). */
function renderInvocation(
  step: Exclude<PipelineStep, { kind: 'approval' }>,
  scope: TemplateScope,
  pin: ResolvedCapability | undefined,
): Invocation {
  switch (step.kind) {
    case 'prompt':
      return { prompt: renderTemplate(step.prompt, scope) };
    case 'skill': {
      // Compose `/name args` (documented headless behavior) + optional extra.
      const name = pin?.name ?? step.skill.name;
      const args = step.skill.args !== undefined ? renderTemplate(step.skill.args, scope) : '';
      const invocation = args.length > 0 ? `/${name} ${args}` : `/${name}`;
      const extra = step.prompt !== undefined ? `\n${renderTemplate(step.prompt, scope)}` : '';
      return { prompt: `${invocation}${extra}`, skillName: name };
    }
    case 'agent':
      return {
        prompt: renderTemplate(step.prompt, scope),
        agentName: pin?.name ?? step.agent.name,
      };
    case 'workflow-script':
      return { scriptPath: step.scriptPath };
  }
}

function errorKindOf(result: { errorKind?: string; outputSchemaFailed?: boolean }): string {
  if (result.outputSchemaFailed === true) return 'output_schema';
  return result.errorKind ?? 'error';
}

// ---------------------------------------------------------------------------
// Bounded concurrency (forEach maxParallel)
// ---------------------------------------------------------------------------

/** Run `fn` over `items` with at most `limit` in flight; preserve index order. */
async function runBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
