/**
 * QueryRunner — the seam between the session kernel FSM and the Agent SDK
 * (plan §4/BE-1: "the SDK client wrapped behind a QueryRunner interface so
 * tests inject a FakeQueryRunner").
 *
 * The kernel never imports @anthropic-ai/claude-agent-sdk directly; it talks
 * to this interface. Implementations:
 *   - createSdkQueryRunner (sdkQueryRunner.ts) — the REAL spawn path,
 *     live-spawn opt-in gated, T3 for real accounts;
 *   - FakeQueryRunner (@aibender/testkit) — deterministic scripted runner for
 *     every unit test (promoted from ./testing/ via ICR-0001; testkit keeps a
 *     structural mirror of these types — drift rule documented there).
 *
 * The message surface is deliberately NARROW: the kernel needs exactly the
 * init message (native session id backfill), the terminal result, and an
 * opaque passthrough for everything else (semantics never come from here —
 * events flow through hooks/OTel/JSONL per blueprint §4.1).
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
