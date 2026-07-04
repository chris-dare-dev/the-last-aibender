/**
 * FakeQueryRunner — deterministic, scriptable QueryRunner for kernel-facing
 * tests. Promoted from `core/src/kernel/testing/fakeQueryRunner.ts` via
 * ICR-0001 (docs/contracts/icr/icr-0001-kernel-test-doubles.md); this is now
 * the ONE canonical query-runner double for the workspace — the gateway-side
 * variant was unified into {@link FakeKernel} on top of this class (ICR-0002).
 *
 * Capabilities the kernel tests need:
 *   - records every start() call with its full QuerySpec (env snapshots →
 *     the per-session isolation/concurrency assertions);
 *   - onStart hook fires BEFORE the handle exists (→ the row-before-spawn
 *     ordering proof: the hook observes the ledger at spawn time);
 *   - auto mode: emits init → result → end, with configurable native ids;
 *   - manual mode: the test holds sessions open (double-resume block needs a
 *     provably-live session) and completes/fails them explicitly;
 *   - failStart: refuse the spawn (spawn-failure settlement tests);
 *   - abort integration: the spec's AbortController ends the stream.
 */

import type {
  QueryHandle,
  QueryRunner,
  QuerySpec,
  RunnerMessage,
} from './queryRunner.js';

// ---------------------------------------------------------------------------
// Async message queue (single consumer)
// ---------------------------------------------------------------------------

class MessageQueue {
  private readonly buffered: RunnerMessage[] = [];
  private waiter: ((value: IteratorResult<RunnerMessage>) => void) | null = null;
  private ended = false;

  push(message: RunnerMessage): void {
    if (this.ended) throw new Error('FakeQueryRunner: push after end');
    if (this.waiter !== null) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: message, done: false });
      return;
    }
    this.buffered.push(message);
  }

  end(): void {
    this.ended = true;
    if (this.waiter !== null) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: undefined, done: true });
    }
  }

  async *stream(): AsyncGenerator<RunnerMessage> {
    for (;;) {
      const next = this.buffered.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.ended) return;
      const result = await new Promise<IteratorResult<RunnerMessage>>((resolve) => {
        this.waiter = resolve;
      });
      if (result.done === true) return;
      yield result.value;
    }
  }
}

// ---------------------------------------------------------------------------
// Fake sessions
// ---------------------------------------------------------------------------

/** Test-side control surface for one started fake session. */
export interface FakeSession {
  readonly spec: QuerySpec;
  readonly nativeSessionId: string;
  /** Push an arbitrary extra message (rarely needed). */
  emit(message: RunnerMessage): void;
  /** Emit the terminal result and end the stream. */
  complete(options?: { readonly ok?: boolean; readonly detail?: string }): void;
  /** End the stream without any result message (process death). */
  die(): void;
}

export interface FakeQueryRunnerOptions {
  /**
   * `auto` (default): every session immediately emits init → success result
   * → end. `manual`: sessions stay open until the test drives them.
   */
  readonly mode?: 'auto' | 'manual';
  /** Native session id factory. Default: `fake-native-<n>` (fork-aware). */
  readonly nativeIdFor?: (spec: QuerySpec, startIndex: number) => string;
  /** Provide fake pids so the ledger's backfillPid path is exercised. */
  readonly providePids?: boolean;
  /** Called synchronously at the top of start() — ordering assertions. */
  readonly onStart?: (spec: QuerySpec) => void | Promise<void>;
  /** Return an Error to make start() reject for that spec. */
  readonly failStart?: (spec: QuerySpec) => Error | undefined;
}

export class FakeQueryRunner implements QueryRunner {
  readonly starts: QuerySpec[] = [];
  private readonly sessions = new Map<string, FakeSession>();
  private readonly options: FakeQueryRunnerOptions;
  private counter = 0;

  constructor(options: FakeQueryRunnerOptions = {}) {
    this.options = options;
  }

  /** The live control surface for a started session (by harness id). */
  session(sessionId: string): FakeSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`FakeQueryRunner: no started session ${sessionId}`);
    }
    return session;
  }

  async start(spec: QuerySpec): Promise<QueryHandle> {
    await this.options.onStart?.(spec);
    const failure = this.options.failStart?.(spec);
    if (failure !== undefined) throw failure;

    const startIndex = this.counter++;
    this.starts.push(spec);

    const nativeSessionId =
      this.options.nativeIdFor?.(spec, startIndex) ??
      (spec.forkSession === true || spec.resumeNativeSessionId === undefined
        ? `fake-native-${startIndex}`
        : spec.resumeNativeSessionId);

    const queue = new MessageQueue();
    let open = true;
    const endOnce = (): void => {
      if (!open) return;
      open = false;
      queue.end();
    };

    spec.abortController.signal.addEventListener('abort', endOnce, { once: true });

    const session: FakeSession = {
      spec,
      nativeSessionId,
      emit: (message) => queue.push(message),
      complete: (opts = {}) => {
        if (!open) return;
        queue.push({
          type: 'result',
          ok: opts.ok ?? true,
          detail: opts.detail ?? (opts.ok === false ? 'error_during_execution' : 'success'),
        });
        endOnce();
      },
      die: () => endOnce(),
    };
    this.sessions.set(spec.sessionId, session);

    queue.push({ type: 'init', nativeSessionId });
    if ((this.options.mode ?? 'auto') === 'auto') {
      session.complete();
    }

    const pid = this.options.providePids === true ? 40_000 + startIndex : undefined;
    return {
      ...(pid !== undefined ? { pid, spawnNonce: `fake-nonce-${startIndex}` } : {}),
      messages: () => queue.stream(),
      interrupt: async () => {
        endOnce();
      },
    };
  }
}
