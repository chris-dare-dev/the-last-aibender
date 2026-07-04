/**
 * TEST DOUBLES for the gateway control round-trip — never wired by
 * production code (the composition root injects the real BE-1 kernel).
 *
 * FakeQueryRunner stands in for the SDK `query()` substrate the BE-1 kernel
 * drives: launches are gateable so tests can hold a session in `spawning`
 * and exercise the kill-while-launching edge. FakeKernel implements the
 * gateway's kernel port with the same externally-visible discipline the real
 * kernel commits to (row-before-spawn, async spawn, double-resume block,
 * fork = continuation CHILD).
 *
 * ICR filed in the BE-3 return: promote FakeQueryRunner/FakeKernel into
 * @aibender/testkit once BE-1's real kernel shape lands, so FE-2 contract
 * tests can drive the same double.
 *
 * [X2]: all fixture values here are synthesized (labels only, fake pids).
 */

import type { LaunchParams, SessionState, SessionStatus } from '@aibender/protocol';
import { newId } from '@aibender/shared';

import {
  KernelVerbError,
  type GatewayKernel,
  type KernelKillParams,
  type KernelKillResult,
  type KernelLaunchResult,
  type KernelResumeParams,
  type KernelResumeResult,
} from './kernel.js';

// ---------------------------------------------------------------------------
// FakeQueryRunner — the SDK query() stand-in
// ---------------------------------------------------------------------------

export interface FakeQueryRunnerOptions {
  /**
   * true (default): starts complete on the next microtask.
   * false: each start blocks until releaseStart()/failStart() is called —
   * the kill-while-launching lever.
   */
  readonly autoStart?: boolean;
}

interface PendingStart {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

export class FakeQueryRunner {
  readonly startedSessionIds: string[] = [];
  readonly stoppedSessionIds: string[] = [];
  private readonly autoStart: boolean;
  private readonly pending = new Map<string, PendingStart>();
  private nextFakePid = 40001;

  constructor(options: FakeQueryRunnerOptions = {}) {
    this.autoStart = options.autoStart ?? true;
  }

  /** Begin a fake session process; resolves to a synthesized pid when "running". */
  async start(sessionId: string): Promise<number> {
    this.startedSessionIds.push(sessionId);
    if (!this.autoStart) {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      this.pending.set(sessionId, { promise, resolve, reject });
      await promise;
    } else {
      await Promise.resolve();
    }
    return this.nextFakePid++;
  }

  async stop(sessionId: string, _mode: 'graceful' | 'force'): Promise<void> {
    this.stoppedSessionIds.push(sessionId);
    await Promise.resolve();
  }

  /** Release a gated start (autoStart:false). */
  releaseStart(sessionId: string): void {
    const gate = this.pending.get(sessionId);
    if (gate === undefined) throw new RangeError(`no pending start for ${sessionId}`);
    this.pending.delete(sessionId);
    gate.resolve();
  }

  /** Fail a gated start (autoStart:false) — the session never reaches running. */
  failStart(sessionId: string, message = 'synthesized spawn failure'): void {
    const gate = this.pending.get(sessionId);
    if (gate === undefined) throw new RangeError(`no pending start for ${sessionId}`);
    this.pending.delete(sessionId);
    gate.reject(new Error(message));
  }

  pendingStartCount(): number {
    return this.pending.size;
  }
}

// ---------------------------------------------------------------------------
// FakeKernel — the BE-1 kernel port stand-in
// ---------------------------------------------------------------------------

interface FakeSession {
  sessionId: string;
  params: LaunchParams;
  state: SessionState;
  pid?: number;
  forkedFrom?: string;
  /** In-flight spawn, awaited by kill-while-launching. */
  spawn?: Promise<void>;
}

const RUNNING_FAMILY: readonly SessionState[] = ['spawning', 'running', 'resumed'];

export class FakeKernel implements GatewayKernel {
  private readonly sessions = new Map<string, FakeSession>();

  constructor(private readonly runner: FakeQueryRunner) {}

  async launch(params: LaunchParams): Promise<KernelLaunchResult> {
    const sessionId = newId('ses');
    // Row-before-spawn: the record exists BEFORE the spawn proceeds, and the
    // launch answer returns `spawning` while the start continues async.
    const session: FakeSession = { sessionId, params, state: 'spawning' };
    this.sessions.set(sessionId, session);
    session.spawn = this.runner
      .start(sessionId)
      .then((pid) => {
        if (session.state === 'spawning') {
          session.state = 'running';
          session.pid = pid;
        }
      })
      .catch(() => {
        session.state = 'exited';
        delete session.pid;
      });
    return { sessionId, state: session.state };
  }

  async resume(params: KernelResumeParams): Promise<KernelResumeResult> {
    const session = this.sessions.get(params.sessionId);
    if (session === undefined) {
      throw new KernelVerbError('session-not-found', 'no ledger row for the requested session');
    }
    if (!params.fork) {
      if (RUNNING_FAMILY.includes(session.state)) {
        // Blueprint §5 guardrail: un-forked double-resume is the
        // transcript-corruption mode.
        throw new KernelVerbError(
          'double-resume-blocked',
          'session is in a running-family state; resume with fork:true instead',
        );
      }
      if (session.state !== 'exited') {
        throw new KernelVerbError(
          'session-not-resumable',
          `session state ${session.state} cannot be resumed in place`,
        );
      }
      session.state = 'resumed';
      return { sessionId: session.sessionId, state: session.state };
    }
    // fork: continuation = CHILD, never sibling (X4).
    const childId = newId('ses');
    const child: FakeSession = {
      sessionId: childId,
      params: session.params,
      state: 'resumed',
      forkedFrom: session.sessionId,
    };
    this.sessions.set(childId, child);
    return { sessionId: childId, state: child.state, forkedFrom: session.sessionId };
  }

  async kill(params: KernelKillParams): Promise<KernelKillResult> {
    const session = this.sessions.get(params.sessionId);
    if (session === undefined) {
      throw new KernelVerbError('session-not-found', 'no ledger row for the requested session');
    }
    // Kill-while-launching: let the in-flight spawn settle first so the
    // process is never orphaned between row and spawn (SPIKE-D discipline).
    if (session.spawn !== undefined) {
      await session.spawn;
    }
    if (session.state !== 'exited') {
      await this.runner.stop(session.sessionId, params.mode);
      session.state = 'exited';
      delete session.pid;
    }
    return { sessionId: session.sessionId, state: session.state };
  }

  async status(sessionId?: string): Promise<readonly SessionStatus[]> {
    if (sessionId !== undefined) {
      const session = this.sessions.get(sessionId);
      if (session === undefined) {
        throw new KernelVerbError('session-not-found', 'no ledger row for the requested session');
      }
      return [toStatus(session)];
    }
    return [...this.sessions.values()].map(toStatus);
  }

  /** Test hook: direct state inspection. */
  stateOf(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId)?.state;
  }
}

function toStatus(session: FakeSession): SessionStatus {
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
    ...(session.pid !== undefined ? { pid: session.pid } : {}),
  };
}
