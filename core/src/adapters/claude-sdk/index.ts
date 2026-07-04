/**
 * core/src/adapters/claude-sdk — thin re-export wrapper around the M1
 * QueryRunner surface (BE-4; plan §4/BE-4 "claude-sdk/ — thin re-export
 * wrapper around the M1 QueryRunner surface for adapter symmetry").
 *
 * The kernel seam (core/src/kernel/queryRunner.ts + sdkQueryRunner.ts)
 * REMAINS the seam of record — this module adds NO behavior. It exists so
 * every backend a session can run on is reachable under core/src/adapters/*
 * (opencode/, lmstudio/, claude-sdk/), which is what the pipeline engine's
 * per-step account routing (BE-8, M5) composes against.
 *
 * `createClaudeSdkAdapter` is an alias of the kernel's live-spawn-gated
 * factory: identical options, identical typed refusal
 * (LiveSpawnDisabledError without `liveSpawnOptIn: true`).
 */

export {
  createSdkQueryRunner as createClaudeSdkAdapter,
  createSdkQueryRunner,
  resolveBundledClaudeExecutable,
  type QueryFn,
  type SdkQueryLike,
  type SdkQueryRunnerOptions,
} from '../../kernel/sdkQueryRunner.js';

export {
  type QueryHandle,
  type QueryRunner,
  type QuerySpec,
  type RunnerInitMessage,
  type RunnerMessage,
  type RunnerOtherMessage,
  type RunnerResultMessage,
} from '../../kernel/queryRunner.js';
