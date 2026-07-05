/**
 * BE-8-local test doubles for the pipeline engine (rule 3: every step runs
 * against a FAKE — no real spawn, no real inference, no cost). Kept in
 * core/src/pipelines/ (not @aibender/testkit) because they are engine-internal
 * scaffolding; if a downstream lane needs them, promote via an ICR (the
 * ICR-0001 path). NOT exported from the package barrel.
 */

import type { StepExecutor, StepExecutionRequest, StepExecutionResult } from './executor.js';
import type { GateHandle, GateOutcome, GateRequestInput, PipelineApprovalGate } from './gate.js';
import type {
  PipelineRunStatusUpdate,
  PipelineStatusPublisher,
  PipelineStepStatusUpdate,
} from './runner.js';

// ---------------------------------------------------------------------------
// FakeStepExecutor — scripted per stepId
// ---------------------------------------------------------------------------

export interface ScriptedStep {
  /** Output for this step (JSON value). */
  readonly output?: unknown;
  readonly ok?: boolean;
  readonly errorKind?: StepExecutionResult['errorKind'];
  readonly costEstimatedUsd?: number;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly outputSchemaFailed?: boolean;
  /** Provide a session id (the lineage node target). Default: synthesized. */
  readonly sessionId?: string;
  /**
   * Fail the FIRST N attempts with `errorKind`, then succeed (retry tests).
   */
  readonly failFirstAttempts?: number;
  /**
   * Hang until the signal aborts (budget/cancel tests) — then settle with
   * `ok:false, errorKind:'timeout'`.
   */
  readonly hangUntilAborted?: boolean;
  /** Called synchronously at the top of execute() (ordering assertions). */
  readonly onExecute?: (request: StepExecutionRequest) => void;
}

export interface FakeStepExecutorOptions {
  /** Per-step scripts (by stepId). Absent step → a trivial success. */
  readonly steps?: Readonly<Record<string, ScriptedStep>>;
}

export class FakeStepExecutor implements StepExecutor {
  readonly calls: StepExecutionRequest[] = [];
  private readonly attemptCounts = new Map<string, number>();

  constructor(private readonly options: FakeStepExecutorOptions = {}) {}

  execute(request: StepExecutionRequest): Promise<StepExecutionResult> {
    this.calls.push(request);
    const script = this.options.steps?.[request.stepId] ?? {};
    script.onExecute?.(request);

    if (script.hangUntilAborted === true) {
      return new Promise<StepExecutionResult>((resolve) => {
        if (request.signal.aborted) {
          resolve({ ok: false, errorKind: 'timeout' });
          return;
        }
        request.signal.addEventListener(
          'abort',
          () => resolve({ ok: false, errorKind: 'timeout' }),
          { once: true },
        );
      });
    }

    const key = `${request.stepId}:${request.iteration}`;
    const count = (this.attemptCounts.get(key) ?? 0) + 1;
    this.attemptCounts.set(key, count);
    if (script.failFirstAttempts !== undefined && count <= script.failFirstAttempts) {
      return Promise.resolve({ ok: false, errorKind: script.errorKind ?? 'rate_limit' });
    }

    const ok = script.ok ?? true;
    const result: StepExecutionResult = {
      ok,
      ...(script.output !== undefined ? { output: script.output } : ok ? { output: {} } : {}),
      sessionId: script.sessionId ?? `sn-fake-${request.stepId}-${request.iteration}-${request.attempt}`,
      ...(script.costEstimatedUsd !== undefined ? { costEstimatedUsd: script.costEstimatedUsd } : {}),
      ...(script.tokensIn !== undefined ? { tokensIn: script.tokensIn } : {}),
      ...(script.tokensOut !== undefined ? { tokensOut: script.tokensOut } : {}),
      ...(script.errorKind !== undefined ? { errorKind: script.errorKind } : {}),
      ...(script.outputSchemaFailed !== undefined
        ? { outputSchemaFailed: script.outputSchemaFailed }
        : {}),
    };
    return Promise.resolve(result);
  }
}

// ---------------------------------------------------------------------------
// FakeApprovalGate — pause then resolve on command
// ---------------------------------------------------------------------------

export interface FakeGateEntry {
  readonly input: GateRequestInput;
  resolve(outcome: GateOutcome): void;
}

export class FakeApprovalGate implements PipelineApprovalGate {
  readonly pending: FakeGateEntry[] = [];

  request(input: GateRequestInput): GateHandle {
    let resolveFn!: (value: { outcome: GateOutcome }) => void;
    const resolution = new Promise<{ outcome: GateOutcome }>((r) => {
      resolveFn = r;
    });
    this.pending.push({
      input,
      resolve: (outcome) => resolveFn({ outcome }),
    });
    return { resolution };
  }

  /** Resolve the gate for a step (the FE decision). */
  decide(stepId: string, outcome: GateOutcome): void {
    const entry = this.pending.find((e) => e.input.stepId === stepId);
    if (entry === undefined) throw new Error(`FakeApprovalGate: no pending gate for ${stepId}`);
    entry.resolve(outcome);
  }
}

// ---------------------------------------------------------------------------
// CapturingStatusPublisher — records the wire fan-out
// ---------------------------------------------------------------------------

export class CapturingStatusPublisher implements PipelineStatusPublisher {
  readonly runs: PipelineRunStatusUpdate[] = [];
  readonly steps: PipelineStepStatusUpdate[] = [];

  runStatus(update: PipelineRunStatusUpdate): void {
    this.runs.push(update);
  }

  stepStatus(update: PipelineStepStatusUpdate): void {
    this.steps.push(update);
  }
}
