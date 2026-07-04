/**
 * PtyBackend — the seam between the ptyHost and node-pty (BE-2; the exact
 * analogue of BE-1's QueryRunner seam, plan §4/BE-2, blueprint §4.1).
 *
 * The host never imports node-pty directly; it talks to this interface.
 * Implementations:
 *   - {@link createNodePtySpawner} — the REAL attended spawn path: node-pty
 *     (pinned 1.1.0) forking the pinned SDK-BUNDLED `claude` binary (resolved
 *     through the SDK's own module graph — the same binary the SDK substrate
 *     runs, blueprint §2 "one spawner, one pinned binary"). LIVE-SPAWN
 *     OPT-IN GATED exactly like the SDK runner: constructing it without the
 *     explicit flag throws LiveSpawnDisabledError. Real-account/real-TUI runs
 *     are T3 owner-gated (docs/runbooks/pty-attended-live.md).
 *   - FakePtyBackend (@aibender/testkit) — deterministic scripted backend
 *     (synthetic TUI byte streams) for every unit test (promoted from
 *     ./testing/ via ICR-0006; testkit keeps a structural mirror of these
 *     seam types — drift rule documented there).
 *
 * BYTES ONLY: the backend surfaces raw Uint8Array output. Nothing here (or
 * anywhere in pty/) parses semantics out of those bytes (blueprint §4.1;
 * architecture.spec.ts enforces it). The only string conversion on this
 * surface is INPUT-side transport decoding — client keystrokes arrive as
 * UTF-8 bytes in INPUT frames and node-pty's write() accepts strings only.
 *
 * SPIKE-D finding 1 (docs/spikes/spike-d-pty-supervision.md): the node-pty
 * darwin prebuilds lose the exec bit on `spawn-helper` under pnpm — every
 * spawn then fails with the opaque `posix_spawnp failed.`. The guard runs
 * twice: core/scripts/fix-spawn-helper.mjs at install time, and
 * {@link ensureSpawnHelperExecutable} at spawner construction (belt AND
 * suspenders — a packaged app may re-materialize node_modules).
 */

import { chmodSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { KernelError, LiveSpawnDisabledError } from '../errors.js';
import { resolveBundledClaudeExecutable } from '../sdkQueryRunner.js';

// ---------------------------------------------------------------------------
// Seam types
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
  /** Pid of the ACTUAL child (node-pty forks the target directly — never a shim; SPIKE-D finding 2). */
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
  /**
   * Deliver a signal. Graceful default is the backend's hangup semantics
   * (node-pty: SIGHUP — what a closing terminal sends a TUI). `SIGKILL` is
   * process-GROUP targeted in the real backend (SPIKE-D finding 2: orphan
   * reaping targets the group, single-pid fallback) — the host never signals
   * raw pids itself, so fake backends' pids never reach the process table.
   */
  kill(signal?: 'SIGHUP' | 'SIGTERM' | 'SIGKILL'): void;
}

export interface PtyBackend {
  spawn(spec: PtySpawnSpec): PtyProcess;
  /**
   * Stable string describing the executable this backend forks — recorded as
   * the ledger spawn-nonce FALLBACK when no per-session argv token exists
   * (see ptyHost.ts nonce discipline).
   */
  describeExecutable(): string;
}

// ---------------------------------------------------------------------------
// SPIKE-D finding 1 guard
// ---------------------------------------------------------------------------

/**
 * Restore the exec bit on node-pty's darwin `spawn-helper` prebuilds when a
 * package manager dropped it. Idempotent; silent when node-pty (or the arch
 * dir) is absent. Mirrors core/scripts/fix-spawn-helper.mjs.
 */
export function ensureSpawnHelperExecutable(): void {
  const requireFromHere = createRequire(import.meta.url);
  let packageDir: string;
  try {
    packageDir = dirname(requireFromHere.resolve('node-pty/package.json'));
  } catch {
    return; // node-pty not installed — the spawner will fail loudly later
  }
  for (const arch of ['darwin-arm64', 'darwin-x64']) {
    const helper = join(packageDir, 'prebuilds', arch, 'spawn-helper');
    try {
      const mode = statSync(helper).mode;
      if ((mode & 0o111) === 0) chmodSync(helper, mode | 0o755);
    } catch {
      // arch not present — fine
    }
  }
}

// ---------------------------------------------------------------------------
// Real node-pty spawner (live-spawn opt-in gated)
// ---------------------------------------------------------------------------

/** Structural view of the node-pty surface we consume (typed seam for tests). */
export interface NodePtyModuleLike {
  spawn(
    file: string,
    args: readonly string[],
    options: {
      readonly name: string;
      readonly cols: number;
      readonly rows: number;
      readonly cwd: string;
      readonly env: Record<string, string>;
      readonly encoding: null;
    },
  ): {
    readonly pid: number;
    onData(listener: (data: string | Uint8Array) => void): unknown;
    onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    pause(): void;
    resume(): void;
    kill(signal?: string): void;
  };
}

export interface NodePtySpawnerOptions {
  /**
   * MUST be `true` — same gate as the SDK runner (BE-1): no code path may
   * construct a real child-forking backend by accident. Composition roots set
   * it only from explicit operator config; real-TUI runs are T3 owner-gated.
   */
  readonly liveSpawnOptIn: boolean;
  /** Override the pinned executable (tests; version-gate experiments). */
  readonly pathToClaudeCodeExecutable?: string;
  /** Inject the node-pty module (tests exercise the adapter without forking). */
  readonly nodePtyModule?: NodePtyModuleLike;
}

/**
 * The real attended spawn path. Resolves the pinned SDK-bundled binary
 * EAGERLY (composition-time failure beats first-spawn failure — same
 * discipline as createSdkQueryRunner) and applies the SPIKE-D exec-bit guard.
 * node-pty itself is imported lazily on first spawn so composing a broker on
 * a machine without the native prebuild only fails when a PTY is requested.
 */
export function createNodePtySpawner(options: NodePtySpawnerOptions): PtyBackend {
  if (options.liveSpawnOptIn !== true) throw new LiveSpawnDisabledError();

  const executable = options.pathToClaudeCodeExecutable ?? resolveBundledClaudeExecutable();
  ensureSpawnHelperExecutable();

  let nodePty: NodePtyModuleLike | undefined = options.nodePtyModule;

  const loadNodePty = (): NodePtyModuleLike => {
    if (nodePty !== undefined) return nodePty;
    const requireFromHere = createRequire(import.meta.url);
    try {
      // node-pty is CommonJS; createRequire keeps the load synchronous so
      // spawn() stays synchronous (the host settles the ledger on throw).
      nodePty = requireFromHere('node-pty') as NodePtyModuleLike;
    } catch (cause) {
      throw new KernelError(
        'internal',
        `node-pty native module is not loadable: ${(cause as Error).message} — ` +
          'reinstall dependencies (pnpm install) and re-run the spawn-helper guard',
      );
    }
    return nodePty;
  };

  return {
    describeExecutable: () => executable,
    spawn: (spec) => {
      const pty = loadNodePty().spawn(executable, [...spec.argv], {
        name: 'xterm-256color',
        cols: spec.cols,
        rows: spec.rows,
        cwd: spec.cwd,
        // The COMPLETE buildSessionEnv environment — never merged (env.ts).
        env: { ...spec.env },
        // Raw bytes out: PTY carries pixels only; decoding is the frontend's.
        encoding: null,
      });
      return {
        pid: pty.pid,
        onData: (listener) => {
          pty.onData((data) => {
            listener(typeof data === 'string' ? new TextEncoder().encode(data) : toUint8(data));
          });
        },
        onExit: (listener) => {
          pty.onExit((event) => {
            listener({
              exitCode: event.exitCode,
              ...(event.signal !== undefined ? { signal: event.signal } : {}),
            });
          });
        },
        // INPUT transport decode (UTF-8 keystrokes) — node-pty writes strings.
        write: (bytes) => pty.write(Buffer.from(bytes).toString('utf8')),
        resize: (cols, rows) => pty.resize(cols, rows),
        pause: () => pty.pause(),
        resume: () => pty.resume(),
        kill: (signal) => {
          if (signal === 'SIGKILL') {
            // SPIKE-D finding 2: force-kill targets the process GROUP
            // (kill(-pid)) with a single-pid fallback — a TUI that spawned
            // grandchildren must not leak them as journaling orphans.
            try {
              process.kill(-pty.pid, 'SIGKILL');
              return;
            } catch {
              // group gone or not a group leader — fall through
            }
          }
          pty.kill(signal);
        },
      };
    },
  };
}

function toUint8(data: Uint8Array): Uint8Array {
  // node-pty hands Buffers; copy so retained chunks never alias pool memory.
  return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}
