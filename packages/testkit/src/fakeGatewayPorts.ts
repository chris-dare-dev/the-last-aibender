/**
 * TEST DOUBLES for the gateway's M2 ports — promoted from
 * `core/src/gateway/fakePorts.ts` via ICR-0007, mirroring ICR-0002's
 * FakeKernel promotion, so FE-2 contract suites drive the SAME doubles the
 * BE-3 gateway suites see.
 *
 * The port types below are testkit's STRUCTURAL MIRROR of
 * `core/src/gateway/ports.ts` (the port of record) — ICR-0001 option (a)
 * posture, same DRIFT RULE: if core's ports change shape, this mirror MUST
 * change in the same ICR. Payload shapes (`ApprovalRequest` etc.) are the
 * FROZEN wire types from @aibender/protocol — no mirror needed there.
 *
 * [X2]: all fixture values are synthesized.
 */

import type { ApprovalDecision, ApprovalRequest, ApprovalResolved } from '@aibender/protocol';

// ---------------------------------------------------------------------------
// Port types — structural mirror of core/src/gateway/ports.ts
// ---------------------------------------------------------------------------

/** Return value of every `on*` subscription: call to unsubscribe. */
export type Unsubscribe = () => void;

/**
 * One live attended PTY session as the gateway consumes it. Byte-oriented
 * and deliberately parser-free; pause/resume never cross the wire
 * (ws-protocol.md §6 — they are the broker-internal backpressure levers).
 */
export interface GatewayPtySession {
  onOutput(listener: (chunk: Uint8Array) => void): Unsubscribe;
  onExit(listener: () => void): Unsubscribe;
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
}

/**
 * The BE-2 ptyHost as the gateway sees it. `onSession` MUST replay
 * already-live sessions to a new subscriber (synchronously, in spawn order)
 * and then announce future spawns; announcements precede first output.
 */
export interface GatewayPtyHost {
  onSession(listener: (sessionId: string, session: GatewayPtySession) => void): Unsubscribe;
}

/**
 * Outcome of delivering one client decision: `applied` (was pending, exactly
 * one matching onResolved follows) or `not-pending` (the NORMAL
 * multi-window/expiry race — ws-protocol.md §7 `approval-not-pending`).
 */
export type ApprovalDecisionOutcome = 'applied' | 'not-pending';

/** BE-2's ApprovalBroker as the gateway sees it (blueprint §4.1 relay). */
export interface ApprovalBrokerPort {
  onRequest(listener: (request: ApprovalRequest) => void): Unsubscribe;
  onResolved(listener: (resolved: ApprovalResolved) => void): Unsubscribe;
  decide(decision: ApprovalDecision): Promise<ApprovalDecisionOutcome>;
}

/**
 * A tap on the kernel's per-session SDK message stream. `message` is the RAW
 * SDK message object (RunnerOtherMessage.raw wrappers are also accepted and
 * unwrapped gateway-side).
 */
export interface TranscriptSource {
  onMessage(listener: (sessionId: string, message: unknown) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Listener bag
// ---------------------------------------------------------------------------

class ListenerSet<T extends (...args: never[]) => void> {
  readonly #listeners = new Set<T>();

  add(listener: T): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(...args: Parameters<T>): void {
    for (const listener of [...this.#listeners]) listener(...args);
  }

  get size(): number {
    return this.#listeners.size;
  }
}

// ---------------------------------------------------------------------------
// FakePtySession / FakePtyHost
// ---------------------------------------------------------------------------

export class FakePtySession implements GatewayPtySession {
  readonly #output = new ListenerSet<(chunk: Uint8Array) => void>();
  readonly #exit = new ListenerSet<() => void>();

  /** Everything write() received, in order. */
  readonly written: Uint8Array[] = [];
  /** Every resize() received, in order. */
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  pauseCount = 0;
  resumeCount = 0;
  paused = false;
  exited = false;

  onOutput(listener: (chunk: Uint8Array) => void): Unsubscribe {
    return this.#output.add(listener);
  }

  onExit(listener: () => void): Unsubscribe {
    return this.#exit.add(listener);
  }

  write(data: Uint8Array): void {
    this.written.push(data.slice());
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  pause(): void {
    this.paused = true;
    this.pauseCount += 1;
  }

  resume(): void {
    this.paused = false;
    this.resumeCount += 1;
  }

  /** Test lever: emit OUTPUT bytes (string → UTF-8). */
  emitOutput(data: Uint8Array | string): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.#output.emit(bytes);
  }

  /** Test lever: end the session. */
  emitExit(): void {
    this.exited = true;
    this.#exit.emit();
  }

  writtenUtf8(): string[] {
    return this.written.map((bytes) => new TextDecoder().decode(bytes));
  }
}

export class FakePtyHost implements GatewayPtyHost {
  readonly #listeners = new ListenerSet<(sessionId: string, session: GatewayPtySession) => void>();
  readonly #sessions = new Map<string, FakePtySession>();

  onSession(listener: (sessionId: string, session: GatewayPtySession) => void): Unsubscribe {
    // Port contract: replay already-live sessions synchronously, then stream.
    for (const [sessionId, session] of this.#sessions) listener(sessionId, session);
    return this.#listeners.add(listener);
  }

  /** Test lever: announce a live pty session (before any of its output). */
  announce(sessionId: string, session: FakePtySession = new FakePtySession()): FakePtySession {
    this.#sessions.set(sessionId, session);
    this.#listeners.emit(sessionId, session);
    return session;
  }

  session(sessionId: string): FakePtySession | undefined {
    return this.#sessions.get(sessionId);
  }
}

// ---------------------------------------------------------------------------
// FakeApprovalBroker
// ---------------------------------------------------------------------------

/**
 * In-memory pending-approval table with the exact idempotence discipline the
 * real BE-2 broker commits to: the FIRST decision for a pending id applies
 * and emits exactly one resolution; every later decision (double-click,
 * second window, decide-after-expiry) answers `not-pending`.
 */
export class FakeApprovalBroker implements ApprovalBrokerPort {
  readonly #requests = new ListenerSet<(request: ApprovalRequest) => void>();
  readonly #resolutions = new ListenerSet<(resolved: ApprovalResolved) => void>();
  readonly #pending = new Map<string, ApprovalRequest>();

  /** Every decision that APPLIED, in order (test assertions). */
  readonly appliedDecisions: ApprovalDecision[] = [];

  onRequest(listener: (request: ApprovalRequest) => void): Unsubscribe {
    return this.#requests.add(listener);
  }

  onResolved(listener: (resolved: ApprovalResolved) => void): Unsubscribe {
    return this.#resolutions.add(listener);
  }

  async decide(decision: ApprovalDecision): Promise<ApprovalDecisionOutcome> {
    await Promise.resolve(); // the real broker settles async — model that
    if (!this.#pending.has(decision.approvalId)) return 'not-pending';
    this.#pending.delete(decision.approvalId);
    this.appliedDecisions.push(decision);
    this.#resolutions.emit({
      kind: 'approval-resolved',
      approvalId: decision.approvalId,
      outcome: decision.verdict === 'allow' ? 'allowed' : 'denied',
    });
    return 'applied';
  }

  /** Test lever: a new approval wants a decision. */
  emitRequest(request: ApprovalRequest): void {
    this.#pending.set(request.approvalId, request);
    this.#requests.emit(request);
  }

  /** Test lever: expire (or supersede) a pending approval broker-side. */
  resolveWithout(approvalId: string, outcome: ApprovalResolved['outcome']): void {
    if (!this.#pending.delete(approvalId)) return;
    this.#resolutions.emit({ kind: 'approval-resolved', approvalId, outcome });
  }

  isPending(approvalId: string): boolean {
    return this.#pending.has(approvalId);
  }
}

// ---------------------------------------------------------------------------
// FakeTranscriptSource
// ---------------------------------------------------------------------------

export class FakeTranscriptSource implements TranscriptSource {
  readonly #listeners = new ListenerSet<(sessionId: string, message: unknown) => void>();

  onMessage(listener: (sessionId: string, message: unknown) => void): Unsubscribe {
    return this.#listeners.add(listener);
  }

  /** Test lever: emit one raw SDK-shaped message for a session. */
  emit(sessionId: string, message: unknown): void {
    this.#listeners.emit(sessionId, message);
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }
}
