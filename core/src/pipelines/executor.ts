/**
 * The StepExecutor port (BE-8; findings pipeline-workflow-builder §R3
 * "Step execution") — the ONE seam through which the DAG runner routes an
 * executable step to its account's backend WITHOUT the runner knowing any
 * backend's wire shape. This is the [X1] differentiator's mechanism: the
 * runner hands the executor a step + a resolved account label; the composition
 * root's executor fans out to:
 *   - MAX_A / MAX_B / ENT → the kernel QueryRunner (SDK `query()`, per-account
 *     `CLAUDE_CONFIG_DIR` env — the existing kernel seam);
 *   - AWS_DEV            → the BE-4 OpenCode session client (→ Bedrock);
 *   - LOCAL              → the BE-4 LM Studio client (/v1 chat).
 *
 * IN TESTS (rule 3): EVERY step runs against a FAKE executor
 * ({@link FakeStepExecutor}) — no real spawn, no real inference, no cost. The
 * runner is proven end-to-end against fakes; the real bindings are wired in
 * core/src/main/ and exercised only by T3 live runs.
 *
 * CANCELLATION + BUDGET (findings §R3): the runner owns an AbortController per
 * step attempt and passes its signal here. On budget breach or run cancel the
 * runner aborts the signal; the executor MUST honor it (SDK AbortController /
 * OpenCode `POST /session/:id/abort`) AND reap any child process GROUP it
 * spawned (no orphan children — the native #69856 lesson). The runner also
 * exposes a `reap` hook the executor can register so the runner can force-kill
 * the process group on breach even if the executor's own abort is slow.
 */

import type { AccountLabel } from '@aibender/protocol';
import type { StepBackend } from '@aibender/protocol';

/** The retryable error classes the runner's retry policy keys on. */
export type StepErrorKind = 'rate_limit' | 'overloaded' | 'timeout' | 'network' | 'error';

/** One executable-step invocation the executor must run on a resolved account. */
export interface StepExecutionRequest {
  readonly runId: string;
  readonly stepId: string;
  readonly iteration: number;
  readonly attempt: number;
  /** The resolved account label — THE per-step routing key ([X1]). */
  readonly account: AccountLabel;
  /** The resolved backend (validated consistent with the account). */
  readonly backend: StepBackend;
  /** Absolute working directory (templates already resolved). */
  readonly cwd: string;
  /**
   * The fully-rendered invocation:
   *   - prompt step        → `{ prompt }`
   *   - skill step         → `{ prompt: '/name args\n<extra>' }` (composed)
   *   - agent step         → `{ prompt, agentName }`
   *   - workflow-script    → `{ scriptPath }` (run via the SDK on ONE account)
   */
  readonly prompt?: string;
  readonly skillName?: string;
  readonly agentName?: string;
  readonly scriptPath?: string;
  /** SDK maxTurns from the step budget, when set. */
  readonly maxTurns?: number;
  /** The step's outputSchema (structured_output enforcement), when set. */
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  /**
   * Abort surface owned by the RUNNER: aborted on budget breach / run cancel.
   * The executor honors it and reaps its child process group.
   */
  readonly signal: AbortSignal;
}

/** The terminal result of one step attempt (fake-produced in tests). */
export interface StepExecutionResult {
  readonly ok: boolean;
  /**
   * The step's structured output (outputSchema-validated by the executor), a
   * JSON-serializable value. Templated into successors via `${steps.<id>…}`.
   * Absent on failure.
   */
  readonly output?: unknown;
  /** Harness session id of the spawned node (the `workflow` lineage target). */
  readonly sessionId?: string;
  /** Per-attempt cost estimate (USD) for the events-store attribution. */
  readonly costEstimatedUsd?: number;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  /** Identifier-free failure class [X2] — drives the retry policy on !ok. */
  readonly errorKind?: StepErrorKind;
  /**
   * True when the executor detected `output` failed the step's `outputSchema`.
   * The runner treats a schema failure as a retryable step failure per policy
   * (plan §9.2 negative: "output failing outputSchema handled per retry
   * policy").
   */
  readonly outputSchemaFailed?: boolean;
}

/**
 * The executor the runner drives. `execute` MUST settle (resolve, never
 * reject) — a thrown/rejected executor is a programmer error the runner wraps
 * into an `error`-kind failure. An aborted signal SHOULD settle promptly with
 * `ok: false, errorKind: 'timeout'` (or the executor's cancellation class).
 */
export interface StepExecutor {
  execute(request: StepExecutionRequest): Promise<StepExecutionResult>;
}
