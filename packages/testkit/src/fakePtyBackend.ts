/**
 * FakePtyBackend — deterministic scripted PtyBackend for pty-facing tests
 * (the pty analogue of {@link FakeQueryRunner}; promoted from
 * `core/src/kernel/pty/testing/fakePtyBackend.ts` via ICR-0006, following
 * the ICR-0001 promotion path the kernel doubles took).
 *
 * The seam types below are testkit's STRUCTURAL MIRROR of
 * `core/src/kernel/pty/ptyBackend.ts` (the seam of record) — same posture as
 * ./queryRunner.ts, same DRIFT RULE: if core's seam changes shape, this
 * mirror MUST change in the same ICR.
 *
 * FIXTURE POLICY [X2]: every byte the synthetic TUI emits is SYNTHESIZED —
 * placeholder labels, obviously-fake banners, no identity-shaped text.
 *
 * The synthetic login TUI stub (plan §4/BE-2 "synthetic TUI stub for tests")
 * emits an ANSI-decorated banner, echoes input opaquely, and exits 0 when it
 * receives a line ending in `\r` — enough to exercise the WHOLE login
 * bootstrap flow (spawn env, argv, byte streaming, exit settlement) without
 * a real binary. The bytes are treated as pixels end-to-end: no test may
 * assert semantics FROM them beyond fixture identity. FE-3/BE-9 suites use
 * the same byte source for synthetic-TUI rendering.
 */

// ---------------------------------------------------------------------------
// Seam types — structural mirror of core/src/kernel/pty/ptyBackend.ts
// ---------------------------------------------------------------------------

export interface PtySpawnSpec {
  /** Argv AFTER the executable (validated upstream: never `--bare`). */
  readonly argv: readonly string[];
  /** Absolute working directory (validated upstream, byte-stable). */
  readonly cwd: string;
  /**
   * COMPLETE spawn environment from buildSessionEnv — passed as the entire
   * child env, never merged over process.env (same contract as QuerySpec).
   */
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
}

export interface PtyExitEvent {
  readonly exitCode: number;
  readonly signal?: number | undefined;
}

/** One live PTY child. Pixels in, pixels out — semantics never. */
export interface PtyProcess {
  /** Pid of the ACTUAL child — never a launcher shim's (SPIKE-D finding 2). */
  readonly pid: number;
  /** Raw output bytes. One subscriber (the host). */
  onData(listener: (bytes: Uint8Array) => void): void;
  onExit(listener: (event: PtyExitEvent) => void): void;
  /** Client INPUT bytes (UTF-8 keystrokes/paste per the INPUT frame contract). */
  write(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** Producer-side flow control (SPIKE-D §6 mechanism). Never crosses the wire. */
  pause(): void;
  resume(): void;
  /** Deliver a signal. Graceful default is the backend's hangup semantics. */
  kill(signal?: 'SIGHUP' | 'SIGTERM' | 'SIGKILL'): void;
}

export interface PtyBackend {
  spawn(spec: PtySpawnSpec): PtyProcess;
  /**
   * Stable string describing the executable this backend forks — recorded as
   * the ledger spawn-nonce FALLBACK when no per-session argv token exists.
   */
  describeExecutable(): string;
}

// ---------------------------------------------------------------------------
// FakePtyProcess
// ---------------------------------------------------------------------------

export class FakePtyProcess implements PtyProcess {
  readonly pid: number;
  readonly spec: PtySpawnSpec;

  /** Every INPUT byte run the host wrote (client keystrokes). */
  readonly writes: Uint8Array[] = [];
  readonly resizes: { cols: number; rows: number }[] = [];
  readonly signals: string[] = [];
  paused = false;
  /** Signals (other than SIGKILL) the fake ignores — grace-escalation tests. */
  ignoreGracefulSignals = false;

  #dataListener: ((bytes: Uint8Array) => void) | undefined;
  #exitListener: ((event: PtyExitEvent) => void) | undefined;
  #alive = true;

  constructor(pid: number, spec: PtySpawnSpec) {
    this.pid = pid;
    this.spec = spec;
  }

  get alive(): boolean {
    return this.#alive;
  }

  onData(listener: (bytes: Uint8Array) => void): void {
    this.#dataListener = listener;
  }

  onExit(listener: (event: PtyExitEvent) => void): void {
    this.#exitListener = listener;
  }

  write(bytes: Uint8Array): void {
    if (!this.#alive) throw new Error('FakePtyProcess: write after exit');
    this.writes.push(bytes.slice());
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  kill(signal?: 'SIGHUP' | 'SIGTERM' | 'SIGKILL'): void {
    this.signals.push(signal ?? 'SIGHUP');
    if (!this.#alive) return;
    if (signal !== 'SIGKILL' && this.ignoreGracefulSignals) return;
    this.exit(signal === 'SIGKILL' ? 137 : 0);
  }

  /** Test-side: emit synthetic TUI output bytes. */
  emitData(bytes: Uint8Array): void {
    if (!this.#alive) throw new Error('FakePtyProcess: emitData after exit');
    this.#dataListener?.(bytes);
  }

  /** Test-side: emit ASCII output (latin1 → bytes, still just pixels). */
  emitText(text: string): void {
    this.emitData(asciiBytes(text));
  }

  /** Test-side: terminate the child. */
  exit(exitCode: number, signal?: number): void {
    if (!this.#alive) return;
    this.#alive = false;
    this.#exitListener?.({ exitCode, ...(signal !== undefined ? { signal } : {}) });
  }
}

// ---------------------------------------------------------------------------
// FakePtyBackend
// ---------------------------------------------------------------------------

export interface FakePtyBackendOptions {
  /** Called with each freshly spawned process (wire up a synthetic TUI). */
  readonly script?: (proc: FakePtyProcess) => void;
  /** Throw from spawn() for these argv shapes (spawn-failure settlement). */
  readonly failSpawn?: (spec: PtySpawnSpec) => Error | undefined;
  readonly firstPid?: number;
}

export const FAKE_PTY_EXECUTABLE = '/synthetic/sdk-bundled/claude' as const;

export class FakePtyBackend implements PtyBackend {
  readonly spawns: PtySpawnSpec[] = [];
  readonly processes: FakePtyProcess[] = [];
  #nextPid: number;
  readonly #options: FakePtyBackendOptions;

  constructor(options: FakePtyBackendOptions = {}) {
    this.#options = options;
    this.#nextPid = options.firstPid ?? 54_001;
  }

  describeExecutable(): string {
    return FAKE_PTY_EXECUTABLE;
  }

  spawn(spec: PtySpawnSpec): PtyProcess {
    const failure = this.#options.failSpawn?.(spec);
    if (failure !== undefined) throw failure;
    this.spawns.push(spec);
    const proc = new FakePtyProcess(this.#nextPid++, spec);
    this.processes.push(proc);
    // Scripts run on the NEXT microtask so the host wires listeners first
    // (mirrors real node-pty: output never precedes spawn() returning).
    if (this.#options.script !== undefined) {
      const script = this.#options.script;
      queueMicrotask(() => {
        if (proc.alive) script(proc);
      });
    }
    return proc;
  }

  /** The most recent live process (convenience for single-session tests). */
  latest(): FakePtyProcess {
    const proc = this.processes.at(-1);
    if (proc === undefined) throw new Error('FakePtyBackend: nothing spawned yet');
    return proc;
  }
}

// ---------------------------------------------------------------------------
// Synthetic login TUI stub (plan §4/BE-2)
// ---------------------------------------------------------------------------

/** ASCII → bytes without any encoding layer (test-side pixel synthesis). */
export function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0x7f;
  return out;
}

export const SYNTHETIC_LOGIN_BANNER =
  '[1mSYNTHETIC-CLAUDE[0m fake login TUI [X2 synthesized]\r\n' +
  'paste the fake code and press enter\r\n';

export const SYNTHETIC_LOGIN_SUCCESS = 'synthetic login recorded; exiting\r\n';

/**
 * Script for {@link FakePtyBackendOptions.script}: banner on spawn, then exit
 * 0 after the first `\r`-terminated input line (the "pasted OAuth code").
 */
export function syntheticLoginTui(proc: FakePtyProcess): void {
  proc.emitData(asciiBytes(SYNTHETIC_LOGIN_BANNER));
  const originalWrite = proc.write.bind(proc);
  proc.write = (bytes: Uint8Array): void => {
    originalWrite(bytes);
    if (bytes.includes(0x0d)) {
      proc.emitData(asciiBytes(SYNTHETIC_LOGIN_SUCCESS));
      proc.exit(0);
    }
  };
}
