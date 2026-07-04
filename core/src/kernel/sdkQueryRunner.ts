/**
 * SdkQueryRunner — the REAL claude spawn path (BE-1; blueprint §2 "one
 * spawner … the same pinned SDK-bundled darwin-arm64 binary").
 *
 * Wraps @anthropic-ai/claude-agent-sdk `query()` behind the QueryRunner
 * interface. Two hard properties:
 *
 *   1. PINNED BINARY: `pathToClaudeCodeExecutable` is resolved to the binary
 *      BUNDLED WITH THE PINNED SDK (the platform package
 *      `@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude`, resolved
 *      through the SDK's own module graph so a hoisted stranger can never be
 *      picked). Never a Homebrew/global `claude`. Upgrades happen only via a
 *      deliberate SDK bump behind SI-2's version gate.
 *   2. LIVE-SPAWN OPT-IN: constructing this runner without the explicit
 *      opt-in flag throws (typed LiveSpawnDisabledError). Real-account runs
 *      are T3 owner-gated — docs/runbooks/kernel-live-spawn.md.
 *
 * ENV CONTRACT (verified against SDK 0.3.201): `options.env` REPLACES the
 * subprocess environment entirely (not merged with process.env), so the
 * buildSessionEnv scrub is airtight on this path.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { LiveSpawnDisabledError, TokenMixingError, KernelError } from './errors.js';
import { assertNoForbiddenArgs, OAUTH_TOKEN_ENV_VAR } from './env.js';
import type { QueryHandle, QueryRunner, QuerySpec, RunnerMessage } from './queryRunner.js';

// ---------------------------------------------------------------------------
// Minimal structural view of the SDK surface (decouples from SDK type churn;
// runtime guards below do the real checking).
// ---------------------------------------------------------------------------

export interface SdkQueryLike extends AsyncIterable<unknown> {
  interrupt(): Promise<void>;
}

export type QueryFn = (params: {
  readonly prompt: string;
  readonly options?: Record<string, unknown>;
}) => SdkQueryLike;

// ---------------------------------------------------------------------------
// Bundled-binary resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the SDK-bundled claude binary for this platform/arch, walking the
 * SDK's OWN dependency graph (createRequire from the resolved SDK entry) so
 * the platform package version always matches the pinned SDK version.
 */
export function resolveBundledClaudeExecutable(): string {
  const requireFromHere = createRequire(import.meta.url);
  let sdkEntry: string;
  try {
    sdkEntry = requireFromHere.resolve('@anthropic-ai/claude-agent-sdk');
  } catch {
    throw new KernelError(
      'internal',
      '@anthropic-ai/claude-agent-sdk is not installed — run pnpm install',
    );
  }
  const platformPkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const requireFromSdk = createRequire(sdkEntry);
  let platformPkgJson: string;
  try {
    platformPkgJson = requireFromSdk.resolve(`${platformPkg}/package.json`);
  } catch {
    throw new KernelError(
      'internal',
      `native claude binary package ${platformPkg} is not installed — ` +
        'reinstall without --omit=optional (SDK optional dependency)',
    );
  }
  const executable = join(dirname(platformPkgJson), 'claude');
  if (!existsSync(executable)) {
    throw new KernelError('internal', `bundled claude binary missing at the ${platformPkg} root`);
  }
  return executable;
}

// ---------------------------------------------------------------------------
// SDK message mapping (narrow: init / result / other)
// ---------------------------------------------------------------------------

function toRunnerMessage(raw: unknown): RunnerMessage {
  if (typeof raw === 'object' && raw !== null) {
    const record = raw as Record<string, unknown>;
    if (
      record['type'] === 'system' &&
      record['subtype'] === 'init' &&
      typeof record['session_id'] === 'string'
    ) {
      return { type: 'init', nativeSessionId: record['session_id'] };
    }
    if (record['type'] === 'result') {
      const subtype = typeof record['subtype'] === 'string' ? record['subtype'] : 'unknown';
      return { type: 'result', ok: subtype === 'success', detail: subtype };
    }
  }
  return { type: 'other', raw };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface SdkQueryRunnerOptions {
  /**
   * MUST be `true`. The flag exists so no code path can construct the real
   * spawn runner by accident — composition roots set it only from explicit
   * operator config (see composeKernel in core/src/main/).
   */
  readonly liveSpawnOptIn: boolean;
  /** Override the pinned executable (tests; version-gate experiments). */
  readonly pathToClaudeCodeExecutable?: string;
  /** Injectable query() (tests exercise the mapping without spawning). */
  readonly queryFn?: QueryFn;
}

export function createSdkQueryRunner(options: SdkQueryRunnerOptions): QueryRunner {
  if (options.liveSpawnOptIn !== true) throw new LiveSpawnDisabledError();

  // Resolve the pinned binary eagerly: composing a live runner on a machine
  // without the bundled binary should fail at composition, not first spawn.
  const executable = options.pathToClaudeCodeExecutable ?? resolveBundledClaudeExecutable();

  let queryFn = options.queryFn;

  return {
    start: async (spec: QuerySpec): Promise<QueryHandle> => {
      // Defense in depth: the kernel validates these upstream, but the
      // runner is the last gate before a real process exists.
      assertNoForbiddenArgs(spec.extraArgs);
      if (spec.extraArgs !== undefined && spec.extraArgs.length > 0) {
        throw new KernelError(
          'bad-request',
          'extraArgs are not supported on the SDK spawn path at M1',
        );
      }
      if (Object.prototype.hasOwnProperty.call(spec.env, OAUTH_TOKEN_ENV_VAR)) {
        throw new TokenMixingError();
      }

      if (queryFn === undefined) {
        const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as {
          query: QueryFn;
        };
        queryFn = sdk.query;
      }

      // BE-2 canUseTool wiring (M2): adapt the kernel's narrow handler onto
      // the SDK's CanUseTool option. The SDK context is wider (suggestions,
      // titles, blockedPath) — deliberately dropped: approvals summaries are
      // built broker-side from the tool name alone [X2] (see approvals.ts).
      const canUseTool = spec.canUseTool;
      const sdkCanUseTool =
        canUseTool === undefined
          ? undefined
          : async (
              toolName: string,
              input: Record<string, unknown>,
              context: { signal?: AbortSignal; toolUseID?: string },
            ) =>
              canUseTool(toolName, input, {
                ...(context.signal !== undefined ? { signal: context.signal } : {}),
                ...(context.toolUseID !== undefined ? { toolUseId: context.toolUseID } : {}),
              });

      const q = queryFn({
        prompt: spec.prompt,
        options: {
          cwd: spec.cwd,
          // REPLACES the subprocess env entirely (SDK 0.3.201 contract).
          env: { ...spec.env },
          abortController: spec.abortController,
          pathToClaudeCodeExecutable: executable,
          ...(spec.resumeNativeSessionId !== undefined
            ? { resume: spec.resumeNativeSessionId }
            : {}),
          ...(spec.forkSession !== undefined ? { forkSession: spec.forkSession } : {}),
          ...(spec.resumeSessionAt !== undefined
            ? { resumeSessionAt: spec.resumeSessionAt }
            : {}),
          ...(sdkCanUseTool !== undefined ? { canUseTool: sdkCanUseTool } : {}),
        },
      });

      return {
        // The SDK does not surface the child pid at 0.3.201 — the ledger's
        // pid column stays NULL on this path until the SDK exposes it
        // (SPIKE-D finding 2 is fully exercised via the fake runner).
        messages: async function* (): AsyncGenerator<RunnerMessage> {
          for await (const raw of q) {
            yield toRunnerMessage(raw);
          }
        },
        interrupt: () => q.interrupt(),
      };
    },
  };
}
