/**
 * FakeKernel — gateway-facing kernel double (ICR-0002).
 *
 * Implements the gateway's kernel port (structural mirror of
 * `core/src/gateway/kernel.ts`, the port of record) ON TOP of the canonical
 * {@link FakeQueryRunner}, unifying the two doubles that grew during the M1
 * build (BE-1's kernel/testing runner and BE-3's private gateway fake). One
 * double now drives both departments' contract tests: FE-2 replays golden WS
 * fixtures (wsGolden.ts) against the same behavior BE-3's gateway suites see.
 *
 * Discipline mirrored from the real kernel (blueprint §4.1/§5, SPIKE-D):
 *   - row-before-spawn: the session record exists (and `status` answers)
 *     BEFORE the spawn proceeds; `launch` returns `spawning` immediately;
 *   - async spawn: `running` + pid arrive when the runner start settles; the
 *     init message backfills nativeSessionId; a runner `result`/stream end
 *     settles the session to `exited`;
 *   - un-forked resume of a running-family session → `double-resume-blocked`;
 *   - fork = continuation CHILD carrying `forkedFrom` (X4 edge), spawned with
 *     `forkSession: true` + the parent's native id;
 *   - kill awaits the in-flight spawn first (never orphan a process between
 *     row and spawn), then interrupts (`graceful`) or aborts (`force`).
 *
 * ERRORS: verbs reject with {@link FakeKernelVerbError} — structurally
 * identical to core's `KernelVerbError` (name/code/retryable). Core's
 * `isKernelVerbError` is an `instanceof` check, so suites that drive the REAL
 * gateway server should inject core's class via {@link FakeKernelOptions}
 * `verbError`; everyone else (FE-2 included) can match on
 * {@link isKernelVerbErrorLike}, which accepts both classes.
 *
 * [X2]: all values synthesized — placeholder labels only, fake pids,
 * deterministic `ses_fake_<n>` ids. Error messages are identifier-free.
 */

import type {
  ErrorCode,
  LaunchParams,
  SessionState,
  SessionStatus,
} from '@aibender/protocol';
import { isErrorCode } from '@aibender/protocol';

import { FakeQueryRunner } from './fakeQueryRunner.js';
import type { QueryHandle, QuerySpec } from './queryRunner.js';

// ---------------------------------------------------------------------------
// Gateway kernel port — structural mirror of core/src/gateway/kernel.ts
// ---------------------------------------------------------------------------

export interface KernelLaunchResult {
  readonly sessionId: string;
  /** `spawning` per the row-before-spawn discipline (blueprint §4.1). */
  readonly state: SessionState;
}

export interface KernelResumeResult {
  /** The resumed session, or the fork CHILD when `fork: true` (X4 edge). */
  readonly sessionId: string;
  readonly state: SessionState;
  /** Present iff the resume forked: the parent session id. */
  readonly forkedFrom?: string;
}

export interface KernelKillResult {
  readonly sessionId: string;
  readonly state: SessionState;
}

export interface KernelResumeParams {
  readonly sessionId: string;
  readonly fork: boolean;
  /**
   * Next user prompt for the resumed session (ICR-0004). Optional on the
   * wire; the sdk substrate REQUIRES it at M1 (broker answers `bad-request`
   * when absent for an sdk session — the fake stays permissive and
   * synthesizes one, matching its launch behavior).
   */
  readonly prompt?: string;
}

export interface KernelKillParams {
  readonly sessionId: string;
  /** `graceful` checkpoints then terminates; `force` is SIGKILL-class. */
  readonly mode: 'graceful' | 'force';
}

/**
 * The four frozen M1 control verbs as the gateway consumes them. Structural
 * mirror of core's `GatewayKernel` (same drift rule as queryRunner.ts: a
 * seam change lands in both files in the same ICR).
 */
export interface GatewayKernel {
  launch(params: LaunchParams): Promise<KernelLaunchResult>;
  resume(params: KernelResumeParams): Promise<KernelResumeResult>;
  kill(params: KernelKillParams): Promise<KernelKillResult>;
  /** Absent sessionId = every ledger session. Unknown id → `session-not-found`. */
  status(sessionId?: string): Promise<readonly SessionStatus[]>;
}

// ---------------------------------------------------------------------------
// Typed verb rejection (structural twin of core's KernelVerbError)
// ---------------------------------------------------------------------------

export class FakeKernelVerbError extends Error {
  /** Deliberately the same name as core's class so structural guards match. */
  override readonly name = 'KernelVerbError';
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: { retryable?: boolean } = {}) {
    super(message);
    if (!isErrorCode(code)) {
      throw new RangeError(
        `FakeKernelVerbError requires a registered ErrorCode, got ${JSON.stringify(code)}`,
      );
    }
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

/** The shape both core's KernelVerbError and the fake's twin satisfy. */
export interface KernelVerbErrorLike {
  readonly name: string;
  readonly message: string;
  readonly code: ErrorCode;
  readonly retryable: boolean;
}

/**
 * STRUCTURAL guard: true for {@link FakeKernelVerbError} AND for core's real
 * `KernelVerbError` (which testkit cannot import without a dep cycle).
 */
export function isKernelVerbErrorLike(value: unknown): value is KernelVerbErrorLike {
  if (!(value instanceof Error) || value.name !== 'KernelVerbError') return false;
  const candidate = value as Partial<KernelVerbErrorLike>;
  return isErrorCode(candidate.code) && typeof candidate.retryable === 'boolean';
}

// ---------------------------------------------------------------------------
// FakeKernel
// ---------------------------------------------------------------------------

const RUNNING_FAMILY: readonly SessionState[] = ['spawning', 'running', 'resumed'];

interface SpawnGate {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

interface FakeKernelSession {
  readonly sessionId: string;
  readonly params: LaunchParams;
  state: SessionState;
  abort: AbortController;
  pid?: number;
  nativeSessionId?: string;
  forkedFrom?: string;
  /** In-flight spawn — awaited by kill (settle-before-kill discipline). */
  spawn?: Promise<void>;
  handle?: QueryHandle;
}

export interface FakeKernelOptions {
  /**
   * true (default): spawns proceed on the next microtask.
   * false: each spawn (launch, resume, fork) holds in its pre-spawn state
   * until releaseSpawn()/failSpawn() — the kill-while-launching lever.
   */
  readonly autoSpawn?: boolean;
  /** Session id factory. Default deterministic `ses_fake_<n>` (1-based). */
  readonly sessionIdFor?: (params: LaunchParams, index: number) => string;
  /**
   * Verb-rejection factory. Default {@link FakeKernelVerbError}. Suites that
   * route errors through core's real gateway (`instanceof` detection) inject
   * core's `KernelVerbError` constructor here.
   */
  readonly verbError?: (
    code: ErrorCode,
    message: string,
    options: { readonly retryable: boolean },
  ) => Error;
}

export class FakeKernel implements GatewayKernel {
  /** The runner underneath — drive sessions via `runner.session(id)`. */
  readonly runner: FakeQueryRunner;
  /** Kill verbs that reached a live session, in order (assertions). */
  readonly kills: { readonly sessionId: string; readonly mode: 'graceful' | 'force' }[] = [];

  private readonly sessions = new Map<string, FakeKernelSession>();
  private readonly gates = new Map<string, SpawnGate>();
  private readonly options: FakeKernelOptions;
  private counter = 0;

  /**
   * Default runner: `manual` mode (sessions stay live until the test drives
   * them — the double-resume block needs a provably-live session) with fake
   * pids. Pass an `auto`-mode runner for launch-and-complete flows.
   */
  constructor(runner?: FakeQueryRunner, options: FakeKernelOptions = {}) {
    this.runner = runner ?? new FakeQueryRunner({ mode: 'manual', providePids: true });
    this.options = options;
  }

  // ---- verbs ----------------------------------------------------------------

  async launch(params: LaunchParams): Promise<KernelLaunchResult> {
    const session = this.register(params, 'spawning');
    session.spawn = this.spawn(session, this.specFor(session, {}));
    return { sessionId: session.sessionId, state: session.state };
  }

  async resume(params: KernelResumeParams): Promise<KernelResumeResult> {
    const session = this.sessions.get(params.sessionId);
    if (session === undefined) {
      throw this.verbError('session-not-found', 'no ledger row for the requested session');
    }
    if (!params.fork) {
      if (RUNNING_FAMILY.includes(session.state)) {
        // Blueprint §5 guardrail: un-forked double-resume is the
        // transcript-corruption mode.
        throw this.verbError(
          'double-resume-blocked',
          'session is in a running-family state; resume with fork:true instead',
        );
      }
      if (session.state !== 'exited') {
        throw this.verbError(
          'session-not-resumable',
          `session state ${session.state} cannot be resumed in place`,
        );
      }
      session.state = 'resumed';
      session.abort = new AbortController();
      session.spawn = this.spawn(
        session,
        this.specFor(session, {
          ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
          ...(session.nativeSessionId !== undefined
            ? { resumeNativeSessionId: session.nativeSessionId }
            : {}),
        }),
      );
      return { sessionId: session.sessionId, state: session.state };
    }
    // fork: continuation = CHILD, never sibling (X4).
    const child = this.register(session.params, 'resumed');
    child.forkedFrom = session.sessionId;
    child.spawn = this.spawn(
      child,
      this.specFor(child, {
        forkSession: true,
        ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
        ...(session.nativeSessionId !== undefined
          ? { resumeNativeSessionId: session.nativeSessionId }
          : {}),
      }),
    );
    return { sessionId: child.sessionId, state: child.state, forkedFrom: session.sessionId };
  }

  async kill(params: KernelKillParams): Promise<KernelKillResult> {
    const session = this.sessions.get(params.sessionId);
    if (session === undefined) {
      throw this.verbError('session-not-found', 'no ledger row for the requested session');
    }
    // Kill-while-launching: let the in-flight spawn settle first so the
    // process is never orphaned between row and spawn (SPIKE-D discipline).
    // NOTE: with autoSpawn:false this awaits the gate — release or fail the
    // spawn before awaiting the kill, exactly like the real spawn settling.
    if (session.spawn !== undefined) {
      await session.spawn;
    }
    if (session.state !== 'exited') {
      this.kills.push({ sessionId: session.sessionId, mode: params.mode });
      if (params.mode === 'force') {
        session.abort.abort(); // SIGKILL-class: no goodbye, stream just ends.
      } else if (session.handle !== undefined) {
        await session.handle.interrupt();
      }
      session.state = 'exited';
      delete session.pid;
    }
    return { sessionId: session.sessionId, state: session.state };
  }

  async status(sessionId?: string): Promise<readonly SessionStatus[]> {
    if (sessionId !== undefined) {
      const session = this.sessions.get(sessionId);
      if (session === undefined) {
        throw this.verbError('session-not-found', 'no ledger row for the requested session');
      }
      return [toStatus(session)];
    }
    return [...this.sessions.values()].map(toStatus);
  }

  // ---- test control surface ---------------------------------------------------

  /** Direct state inspection. */
  stateOf(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId)?.state;
  }

  /** Resolves when the session's in-flight spawn has settled (or immediately). */
  async spawnSettled(sessionId: string): Promise<void> {
    await this.sessions.get(sessionId)?.spawn;
  }

  /** Release a gated spawn (autoSpawn:false). */
  releaseSpawn(sessionId: string): void {
    this.takeGate(sessionId).resolve();
  }

  /** Fail a gated spawn (autoSpawn:false) — the session settles to exited. */
  failSpawn(sessionId: string, message = 'synthesized spawn failure'): void {
    this.takeGate(sessionId).reject(new Error(message));
  }

  pendingSpawnCount(): number {
    return this.gates.size;
  }

  // ---- internals ----------------------------------------------------------------

  private verbError(code: ErrorCode, message: string): Error {
    const make = this.options.verbError;
    return make !== undefined
      ? make(code, message, { retryable: false })
      : new FakeKernelVerbError(code, message);
  }

  /** Row-before-spawn: the record is queryable before any spawn proceeds. */
  private register(params: LaunchParams, state: SessionState): FakeKernelSession {
    this.counter += 1;
    const sessionId =
      this.options.sessionIdFor?.(params, this.counter) ?? `ses_fake_${this.counter}`;
    if (this.sessions.has(sessionId)) {
      throw new RangeError(`FakeKernel: duplicate session id ${sessionId} from sessionIdFor`);
    }
    const session: FakeKernelSession = {
      sessionId,
      params,
      state,
      abort: new AbortController(),
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  private specFor(
    session: FakeKernelSession,
    extras: Partial<Pick<QuerySpec, 'prompt' | 'resumeNativeSessionId' | 'forkSession'>>,
  ): QuerySpec {
    return {
      sessionId: session.sessionId,
      // Resume prompts (ICR-0004) arrive via `extras.prompt` and win below.
      prompt: session.params.prompt ?? `synthesized session for ${session.params.accountLabel}`,
      cwd: session.params.cwd,
      // Synthesized spawn env [X2] — enough for env-snapshot assertions.
      env: {
        AIBENDER_FAKE_KERNEL: '1',
        AIBENDER_FAKE_ACCOUNT: session.params.accountLabel,
      },
      abortController: session.abort,
      ...extras,
    };
  }

  private async spawn(session: FakeKernelSession, spec: QuerySpec): Promise<void> {
    try {
      if (this.options.autoSpawn === false) {
        await this.makeGate(session.sessionId).promise;
      }
      const handle = await this.runner.start(spec);
      session.handle = handle;
      if (session.state === 'spawning') session.state = 'running';
      if (handle.pid !== undefined) session.pid = handle.pid;
      void this.pump(session, handle);
    } catch {
      session.state = 'exited';
      delete session.pid;
    }
  }

  /** Single consumer of the runner's message stream (the kernel's pump role). */
  private async pump(session: FakeKernelSession, handle: QueryHandle): Promise<void> {
    try {
      for await (const message of handle.messages()) {
        if (message.type === 'init') {
          session.nativeSessionId = message.nativeSessionId;
        }
        // `result` settles below at stream end; `other` is opaque passthrough.
      }
    } catch {
      // A crashing fake stream settles the session like a process death.
    }
    // Stream end = the underlying process is gone. Guard against an OLD pump
    // clobbering a session that has since been resumed onto a new handle.
    if (session.handle === handle && session.state !== 'exited') {
      session.state = 'exited';
      delete session.pid;
    }
  }

  private makeGate(sessionId: string): SpawnGate {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const gate: SpawnGate = { promise, resolve, reject };
    this.gates.set(sessionId, gate);
    return gate;
  }

  private takeGate(sessionId: string): SpawnGate {
    const gate = this.gates.get(sessionId);
    if (gate === undefined) {
      throw new RangeError(`FakeKernel: no pending spawn for ${sessionId}`);
    }
    this.gates.delete(sessionId);
    return gate;
  }
}

function toStatus(session: FakeKernelSession): SessionStatus {
  return {
    sessionId: session.sessionId,
    accountLabel: session.params.accountLabel,
    backend: session.params.backend,
    substrate: session.params.substrate,
    state: session.state,
    cwd: session.params.cwd,
    purpose: session.params.purpose,
    ...(session.params.workstreamHint !== undefined
      ? { workstreamHint: session.params.workstreamHint }
      : {}),
    ...(session.nativeSessionId !== undefined
      ? { nativeSessionId: session.nativeSessionId }
      : {}),
    ...(session.pid !== undefined ? { pid: session.pid } : {}),
  };
}
