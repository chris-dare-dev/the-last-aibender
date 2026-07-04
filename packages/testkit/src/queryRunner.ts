/**
 * QueryRunner seam types — testkit's STRUCTURAL MIRROR of
 * `core/src/kernel/queryRunner.ts` (the seam of record).
 *
 * ICR-0001 landed with option (a) of its proposal: rather than moving the
 * seam type into a shared package, testkit declares structurally-identical
 * types so it keeps its zero-dependency-on-core posture (core devDepends on
 * testkit; a reverse import would be a cycle). TypeScript's structural typing
 * makes {@link FakeQueryRunner} assignable wherever core's `QueryRunner` is
 * expected — the kernel suites prove it on every run.
 *
 * DRIFT RULE: if core's seam changes shape, this mirror MUST change in the
 * same ICR — a silent divergence here breaks every consumer of the fake at
 * typecheck time (which is exactly the loud failure we want).
 */

// ---------------------------------------------------------------------------
// Spawn spec
// ---------------------------------------------------------------------------

export interface QuerySpec {
  /** Harness session id (resume-ledger key) — for runner bookkeeping only. */
  readonly sessionId: string;
  /** The user prompt this query processes (launch AND resume both carry one). */
  readonly prompt: string;
  /** Absolute working directory (validated upstream). */
  readonly cwd: string;
  /**
   * COMPLETE spawn environment from buildSessionEnv — the runner must pass it
   * as the entire subprocess env, never merge it over process.env.
   */
  readonly env: Readonly<Record<string, string>>;
  /** Abort surface: the kernel owns the controller, the runner honors it. */
  readonly abortController: AbortController;
  /** Native (SDK) session id to resume, when resuming. */
  readonly resumeNativeSessionId?: string;
  /** Fork to a new native session instead of continuing (X4 child edge). */
  readonly forkSession?: boolean;
  /**
   * Resume only up to (and including) this message uuid — the transcript-tail
   * validator's repair anchor ("fork from last coherent message").
   */
  readonly resumeSessionAt?: string;
  /**
   * Extra argv for the underlying binary. Validated by the kernel
   * (assertNoForbiddenArgs — `--bare` is refused with a typed error).
   */
  readonly extraArgs?: readonly string[];
}

// ---------------------------------------------------------------------------
// Messages (narrow union)
// ---------------------------------------------------------------------------

/** First message of every session: carries the NATIVE session id. */
export interface RunnerInitMessage {
  readonly type: 'init';
  readonly nativeSessionId: string;
}

/** Terminal message: the query finished (successfully or not). */
export interface RunnerResultMessage {
  readonly type: 'result';
  readonly ok: boolean;
  /** SDK result subtype (e.g. `success`, `error_during_execution`). */
  readonly detail: string;
}

/** Anything else the SDK streams — opaque to the kernel. */
export interface RunnerOtherMessage {
  readonly type: 'other';
  readonly raw: unknown;
}

export type RunnerMessage = RunnerInitMessage | RunnerResultMessage | RunnerOtherMessage;

// ---------------------------------------------------------------------------
// Handle + runner
// ---------------------------------------------------------------------------

export interface QueryHandle {
  /**
   * Pid of the ACTUAL session process when the implementation can know it
   * (SPIKE-D finding 2: never a launcher shim's pid). The SDK path cannot
   * surface it at M1 — undefined there; the fake provides one so the
   * ledger's backfillPid path is exercised.
   */
  readonly pid?: number;
  /** Argv spawn nonce paired with pid (SPIKE-D pid-reuse guard). */
  readonly spawnNonce?: string;
  /** The session's message stream. Single consumer: the kernel's pump. */
  messages(): AsyncIterable<RunnerMessage>;
  /** Graceful stop (SDK interrupt). Abort via the spec's AbortController. */
  interrupt(): Promise<void>;
}

export interface QueryRunner {
  /**
   * Spawn/resume one session. MUST be called only after the resume-ledger row
   * exists (row-before-spawn discipline — the kernel enforces and tests it).
   */
  start(spec: QuerySpec): Promise<QueryHandle>;
}
