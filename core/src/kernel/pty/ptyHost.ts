/**
 * ptyHost — attended Claude sessions in daemon-owned node-pty (BE-2;
 * plan §4/BE-2, blueprint §4.1 "Interactive attended" row).
 *
 * Responsibilities (each proven by a test in ptyHost.spec.ts):
 *
 *   - ONE SPAWN LAYER: every attended child gets its process environment from
 *     buildSessionEnv (BE-1's single spawn layer — asserted byte-for-byte by
 *     test) and the pinned SDK-bundled `claude` binary via the PtyBackend
 *     seam. `--bare` is refused (assertNoForbiddenArgs) on every argv.
 *   - ROW BEFORE SPAWN: the resume-ledger row (substrate `pty`) is inserted
 *     before the backend forks anything — the same recoverable-crash-window
 *     discipline as the SDK kernel (SPIKE-D vii).
 *   - PIXELS, NEVER SEMANTICS: output bytes flow into a per-session
 *     BoundedAckRing and out as sequence-offset OUTPUT frames
 *     (ws-protocol.md §5/§6). Nothing in this module decodes or inspects
 *     them (architecture.spec.ts enforces the absence of parser imports).
 *   - PRODUCER-SIDE FLOW CONTROL (SPIKE-D vi): ring occupancy >= highWater →
 *     pty.pause() (child's TTY write blocks); consumer ack drains to
 *     lowWater → resume(). Bytes are never dropped; pause/resume never
 *     crosses the wire.
 *   - DETACH/REATTACH: detaching stops delivery but RETAINS the ring —
 *     offsets are absolute and stable, so a reattaching client replays from
 *     its watermark (`replayFrom`) or re-baselines via its serialize-addon
 *     snapshot when its watermark fell below the ack floor (§6).
 *   - RECYCLE LOOP v0: checkpoint → graceful kill (force after a deadline) →
 *     resume the SAME native session through the M1 FSM (`running →
 *     resumed`), or fork a continuation CHILD row. The [X4] continuation
 *     edge is emitted through {@link ContinuationEdgeEmitter} — a stub
 *     interface BE-7 implements at M4.
 *   - LOGIN BOOTSTRAP: fresh profile → attended PTY running `claude /login`
 *     (argv strategy below). Real spawns ride the same live-spawn opt-in
 *     gate as the SDK runner (the gate lives in createNodePtySpawner);
 *     tests run the synthetic TUI backend. T3 procedure:
 *     docs/runbooks/pty-attended-live.md.
 *
 * NONCE + NATIVE-ID DISCIPLINE (SPIKE-D finding 2, sqlite-ddl §4): the ledger
 * records the pid of the ACTUAL child (node-pty forks the target directly)
 * plus an argv-visible spawn nonce for the pid-reuse guard:
 *   - attended launches pass `--session-id <uuid>` (a real claude CLI flag):
 *     the uuid is argv-visible (nonce) AND pins the native session id, which
 *     an attended session cannot surface any other way without parsing bytes.
 *     Backfilled write-once; drift here is a version-gate matter — the argv
 *     strategy is injectable (`argv` option) so SI-2's gate can pivot it.
 *   - recycle-resumes pass `--resume <native-id>` — the native id is the
 *     argv-visible nonce.
 *   - login bootstraps have no unique argv token: the executable path is
 *     recorded as a CONSERVATIVE nonce (argv-visible via ps; a false "alive"
 *     merely refuses a resume, which is the safe direction — pidLiveness.ts).
 */

import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

import type { LaunchParams, PtyFrame } from '@aibender/protocol';
import {
  LABEL_BACKENDS,
  PTY_FRAME_MAX_PAYLOAD_BYTES,
  PTY_MAX_COLS,
  PTY_MAX_ROWS,
} from '@aibender/protocol';
import type { ResumeLedgerStore } from '@aibender/schema';
import type { Logger } from '@aibender/shared';
import { newId } from '@aibender/shared';

import { assertNoForbiddenArgs, buildSessionEnv } from '../env.js';
import {
  KernelError,
  KernelShutdownError,
  SessionNotFoundKernelError,
  SessionNotResumableError,
} from '../errors.js';
import { isClaudeProfileLabel, type ClaudeProfileLabel, type ProfileRegistry } from '../profiles.js';
import { BoundedAckRing, DEFAULT_FLOW_CONTROL, type FlowControlConfig } from './flowControl.js';
import type { PtyBackend, PtyExitEvent, PtyProcess } from './ptyBackend.js';

// ---------------------------------------------------------------------------
// [X4] continuation-edge emitter — BE-7 interface stub (M4)
// ---------------------------------------------------------------------------

/**
 * Recycle continuations are `continue` edges (x4-workstreams edge vocabulary).
 * Same-node recycles carry fromSessionId === toSessionId (blueprint §4.1
 * "recycle = resume (same node)"); fork recycles point at the child row.
 */
export interface ContinuationEdgeEvent {
  readonly edge: 'continue';
  readonly fromSessionId: string;
  readonly toSessionId: string;
  readonly reason: 'recycle';
  readonly atEpochMs: number;
}

/**
 * BE-7 (workstream ledger, M4) implements this to record edges
 * deterministically at action time. Until then the no-op stub stands —
 * the CALL SITES are the deliverable here, not the persistence.
 */
export interface ContinuationEdgeEmitter {
  emitContinuationEdge(event: ContinuationEdgeEvent): void;
}

export const noopContinuationEdgeEmitter: ContinuationEdgeEmitter = Object.freeze({
  emitContinuationEdge: () => undefined,
});

// ---------------------------------------------------------------------------
// Argv strategy (injectable — version-gate pivot point, see header)
// ---------------------------------------------------------------------------

export interface PtyArgvContext {
  readonly kind: 'attended' | 'login-bootstrap' | 'recycle-resume';
  /** Minted per attended launch; pins the native session id via --session-id. */
  readonly sessionUuid: string;
  /** The native session being recycle-resumed. */
  readonly nativeSessionId?: string;
  /** Fork a continuation child instead of continuing in place. */
  readonly fork?: boolean;
}

export type PtyArgvBuilder = (context: PtyArgvContext) => readonly string[];

/** T3-verified against the pinned binary before real-account use (runbook). */
export const defaultPtyArgv: PtyArgvBuilder = (context) => {
  switch (context.kind) {
    case 'attended':
      return ['--session-id', context.sessionUuid];
    case 'login-bootstrap':
      // The positional arg is the initial TUI input: `/login` starts the
      // OAuth hop exactly like typing it (docs/runbooks/login-bootstrap.md).
      return ['/login'];
    case 'recycle-resume': {
      const native = context.nativeSessionId;
      if (native === undefined) {
        throw new KernelError('internal', 'recycle-resume argv requires a native session id');
      }
      return context.fork === true ? ['--resume', native, '--fork-session'] : ['--resume', native];
    }
  }
};

// ---------------------------------------------------------------------------
// Host surface
// ---------------------------------------------------------------------------

/** Terminal settlement of an attended session (ledger row → `exited`). */
export interface PtyHostExit {
  readonly sessionId: string;
  readonly finalState: 'exited';
  readonly exitCode?: number;
}

export type PtyOutputConsumer = (frame: PtyFrame) => void;

export interface AttendedPtySession {
  readonly sessionId: string;
  /**
   * Attach THE consumer (the gateway; it fans out to windows itself).
   * `replayFrom` re-delivers retained bytes from that absolute offset first
   * (reconnect path, §6); attaching replaces any previous consumer
   * (reconnect supersedes the dead socket).
   */
  attach(consumer: PtyOutputConsumer, options?: { readonly replayFrom?: number }): void;
  /** Stop delivery. The ring is RETAINED; offsets stay stable. */
  detach(): void;
  /** Client INPUT bytes (UTF-8 keystrokes/paste). */
  write(bytes: Uint8Array): void;
  /** Terminal geometry (1..4096 each — ws-protocol.md §6 pty-resize). */
  resize(cols: number, rows: number): void;
  /** Ack-watermark release (§6 pty-ack). Stale acks are ignored. */
  ack(watermark: number): void;
  /** Pull-style replay of retained OUTPUT frames (§6 pty-replay-request). */
  replay(fromWatermark: number): readonly PtyFrame[];
  /**
   * Consumer-driven backpressure levers (SPIKE-D §6 — never on the wire).
   * The gateway's ptyStream pulls these when ITS bounded buffer crosses its
   * watermarks (gateway/ports.ts GatewayPtySession); the host-side ring pulls
   * the same underlying levers for standalone consumers. No-ops when dead.
   */
  pause(): void;
  resume(): void;
  /** `graceful` = hangup (checkpoint path); `force` = process-group SIGKILL. */
  kill(mode?: 'graceful' | 'force'): Promise<PtyHostExit>;
  waitForExit(): Promise<PtyHostExit>;
  /** Absolute end of the produced OUTPUT stream (next byte's offset). */
  producedOffset(): number;
  /** True while a child process is alive for this session. */
  isLive(): boolean;
}

export interface LoginBootstrapOptions {
  readonly accountLabel: ClaudeProfileLabel | string;
  /**
   * Working directory for the attended login TUI. Defaults to the account's
   * config dir (always absolute, always present on a provisioned machine).
   */
  readonly cwd?: string;
  readonly cols?: number;
  readonly rows?: number;
}

export interface RecycleOptions {
  /** Fork a continuation CHILD row instead of resuming the same node. */
  readonly fork?: boolean;
}

export interface RecycleOutcome {
  readonly session: AttendedPtySession;
  /** Present iff the recycle forked: the parent (settled) session id. */
  readonly forkedFrom?: string;
}

export interface PtyHost {
  /** Launch an attended TUI session. `substrate` MUST be `pty`. */
  launchAttended(params: LaunchParams): Promise<AttendedPtySession>;
  /** Fresh profile → attended `claude /login` (blueprint §4.1; SI-2 runbook). */
  launchLoginBootstrap(options: LoginBootstrapOptions): Promise<AttendedPtySession>;
  /** Recycle loop v0: checkpoint → kill → resume via the M1 FSM. */
  recycle(sessionId: string, options?: RecycleOptions): Promise<RecycleOutcome>;
  get(sessionId: string): AttendedPtySession | undefined;
  /** Session ids with a live child in this host. */
  live(): readonly string[];
  /**
   * Session announcements (the gateway port contract, gateway/ports.ts):
   * already-live sessions replay to a new subscriber synchronously in spawn
   * order, then future spawns announce as they happen — always BEFORE any of
   * their output is delivered. Recycles do NOT re-announce (same session,
   * same byte axis); fork-recycles announce the child.
   */
  onSession(listener: (session: AttendedPtySession) => void): () => void;
  shutdown(): Promise<void>;
}

export interface PtyHostOptions {
  readonly ledger: ResumeLedgerStore;
  readonly profiles: ProfileRegistry;
  readonly backend: PtyBackend;
  /** Base env snapshot for buildSessionEnv (tests pass fixtures). */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly flowControl?: FlowControlConfig;
  /** [X4] continuation edges (BE-7 at M4); defaults to the no-op stub. */
  readonly edges?: ContinuationEdgeEmitter;
  readonly logger?: Logger;
  /** Harness session-id factory (tests pin ids for golden-fixture replay). */
  readonly newSessionId?: () => string;
  /** Native-session uuid factory (tests pin the --session-id value). */
  readonly newSessionUuid?: () => string;
  readonly argv?: PtyArgvBuilder;
  readonly clock?: () => number;
  /** Grace period before a recycle/kill escalates to force (default 5000). */
  readonly forceKillAfterMs?: number;
  readonly defaultCols?: number;
  readonly defaultRows?: number;
  /** Race-proof seams (SPIKE-D `--crash-after-ledger` analogue). Tests only. */
  readonly testHooks?: {
    readonly afterLedgerInsert?: (sessionId: string) => void | Promise<void>;
    readonly onCheckpoint?: (sessionId: string) => void;
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface SessionRecord {
  readonly id: string;
  readonly label: ClaudeProfileLabel;
  readonly cwd: string;
  readonly ring: BoundedAckRing;
  readonly facade: AttendedPtySession;
  proc: PtyProcess | undefined;
  /** Resolves when the CURRENT child generation exits (recycle waits here). */
  generationExit: Promise<PtyExitEvent> | undefined;
  consumer: PtyOutputConsumer | undefined;
  recycling: boolean;
  settled: boolean;
  lastExit: PtyExitEvent | undefined;
  cols: number;
  rows: number;
  exitResolve: (exit: PtyHostExit) => void;
  readonly exitPromise: Promise<PtyHostExit>;
}

export function createPtyHost(options: PtyHostOptions): PtyHost {
  const { ledger, profiles, backend } = options;
  const flowControl = options.flowControl ?? DEFAULT_FLOW_CONTROL;
  const edges = options.edges ?? noopContinuationEdgeEmitter;
  const logger = options.logger;
  const newSessionId = options.newSessionId ?? (() => newId('ses'));
  const newSessionUuid = options.newSessionUuid ?? (() => randomUUID());
  const buildArgv = options.argv ?? defaultPtyArgv;
  const clock = options.clock ?? Date.now;
  const forceKillAfterMs = options.forceKillAfterMs ?? 5000;
  const defaultCols = options.defaultCols ?? 120;
  const defaultRows = options.defaultRows ?? 40;

  const records = new Map<string, SessionRecord>();
  /** Spawn-ordered announcement log + live subscribers (gateway port). */
  const announced: SessionRecord[] = [];
  const sessionListeners = new Set<(session: AttendedPtySession) => void>();
  let shuttingDown = false;

  const announce = (record: SessionRecord): void => {
    announced.push(record);
    for (const listener of sessionListeners) {
      try {
        listener(record.facade);
      } catch (cause) {
        logger?.error('pty session subscriber threw', {
          sessionId: record.id,
          detail: (cause as Error).message,
        });
      }
    }
  };

  const assertNotShuttingDown = (): void => {
    if (shuttingDown) throw new KernelShutdownError();
  };

  // ---- delivery ------------------------------------------------------------

  const outputFrame = (record: SessionRecord, offset: number, bytes: Uint8Array): PtyFrame => ({
    type: 'output',
    sessionId: record.id,
    streamOffset: offset,
    payload: bytes,
  });

  /** Drain not-yet-delivered ring bytes to the attached consumer as frames. */
  const pump = (record: SessionRecord): void => {
    const consumer = record.consumer;
    if (consumer === undefined) return;
    for (;;) {
      const chunk = record.ring.deliverNext(PTY_FRAME_MAX_PAYLOAD_BYTES);
      if (chunk === undefined) return;
      consumer(outputFrame(record, chunk.offset, chunk.bytes));
    }
  };

  // ---- settlement ----------------------------------------------------------

  const settleExited = (record: SessionRecord, exit: PtyExitEvent | undefined): void => {
    if (record.settled) return;
    record.settled = true;
    const state = ledger.get(record.id)?.state;
    if (state === 'spawning' || state === 'running' || state === 'resumed') {
      ledger.transition(record.id, 'exited');
    }
    record.exitResolve({
      sessionId: record.id,
      finalState: 'exited',
      ...(exit?.exitCode !== undefined ? { exitCode: exit.exitCode } : {}),
    });
  };

  const forceKill = (record: SessionRecord): void => {
    const proc = record.proc;
    if (proc === undefined) return;
    // Process-GROUP targeted (SPIKE-D finding 2): the backend owns group
    // semantics; the host never signals raw pids (a fake backend's pids
    // must never reach the real process table).
    proc.kill('SIGKILL');
  };

  // ---- spawn (shared by launch, login bootstrap, recycle) -------------------

  const spawnGeneration = (
    record: SessionRecord,
    context: PtyArgvContext,
    env: Readonly<Record<string, string>>,
  ): void => {
    const argv = buildArgv(context);
    assertNoForbiddenArgs(argv); // never --bare (blueprint §4.1)

    const proc = backend.spawn({
      argv,
      cwd: record.cwd,
      env,
      cols: record.cols,
      rows: record.rows,
    });
    record.proc = proc;
    record.lastExit = undefined;

    // SPIKE-D finding 2: the ledger records the pid of the ACTUAL child with
    // an argv-visible nonce (see the header's nonce discipline).
    const nonceCandidate =
      context.kind === 'attended'
        ? context.sessionUuid
        : context.kind === 'recycle-resume'
          ? context.nativeSessionId
          : undefined;
    const spawnNonce =
      nonceCandidate !== undefined && argv.includes(nonceCandidate)
        ? nonceCandidate
        : backend.describeExecutable();
    ledger.backfillPid(record.id, proc.pid, spawnNonce);

    if (context.kind === 'attended' && argv.includes(context.sessionUuid)) {
      // --session-id pins the native id; an attended session has no other
      // identity channel that does not parse PTY bytes.
      ledger.backfillNativeSessionId(record.id, context.sessionUuid);
    }

    let exitResolve: (event: PtyExitEvent) => void;
    record.generationExit = new Promise<PtyExitEvent>((resolve) => {
      exitResolve = resolve;
    });

    proc.onData((bytes) => {
      const mustPause = record.ring.push(bytes);
      if (mustPause) record.proc?.pause();
      pump(record);
    });

    proc.onExit((event) => {
      record.proc = undefined;
      record.lastExit = event;
      exitResolve(event);
      if (!record.recycling) settleExited(record, event);
    });
  };

  /** Insert row → (hook) → spawn: THE row-before-spawn ordering (SPIKE-D vii). */
  const insertRowAndSpawn = async (args: {
    readonly id: string;
    readonly label: ClaudeProfileLabel;
    readonly cwd: string;
    readonly purpose: string;
    readonly workstreamHint?: string;
    readonly context: PtyArgvContext;
    readonly cols: number;
    readonly rows: number;
  }): Promise<SessionRecord> => {
    const profile = profiles.resolve(args.label);
    const env = buildSessionEnv(profile, {
      baseEnv: options.baseEnv ?? { ...process.env },
    });

    ledger.insertBeforeSpawn({
      id: args.id,
      accountLabel: args.label,
      backend: 'claude_code',
      cwd: args.cwd,
      substrate: 'pty',
      purpose: args.purpose,
      ...(args.workstreamHint !== undefined ? { workstreamHint: args.workstreamHint } : {}),
    });

    await options.testHooks?.afterLedgerInsert?.(args.id);

    const record = newRecord(args.id, args.label, args.cwd, args.cols, args.rows);

    if (shuttingDown) {
      // Shutdown raced the spawn window: recoverable row, no child forked.
      ledger.transition(args.id, 'exited');
      record.settled = true;
      record.exitResolve({ sessionId: args.id, finalState: 'exited' });
      throw new KernelShutdownError();
    }

    try {
      spawnGeneration(record, args.context, env);
    } catch (cause) {
      ledger.transition(args.id, 'exited'); // spawning → exited (settle)
      record.settled = true;
      record.exitResolve({ sessionId: args.id, finalState: 'exited' });
      throw cause;
    }
    if (ledger.get(args.id)?.state === 'spawning') {
      ledger.transition(args.id, 'running');
    }
    records.set(args.id, record);
    // Announce SYNCHRONOUSLY with the spawn: PTY output arrives on later
    // ticks (node-pty socket IO; the fake's microtask script), so every
    // subscriber sees the session before its first byte (gateway contract).
    announce(record);
    return record;
  };

  // ---- record + facade -------------------------------------------------------

  const newRecord = (
    id: string,
    label: ClaudeProfileLabel,
    cwd: string,
    cols: number,
    rows: number,
  ): SessionRecord => {
    let exitResolve!: (exit: PtyHostExit) => void;
    const exitPromise = new Promise<PtyHostExit>((resolve) => {
      exitResolve = resolve;
    });
    const record: SessionRecord = {
      id,
      label,
      cwd,
      ring: new BoundedAckRing(flowControl),
      facade: undefined as unknown as AttendedPtySession, // assigned below
      proc: undefined,
      generationExit: undefined,
      consumer: undefined,
      recycling: false,
      settled: false,
      lastExit: undefined,
      cols,
      rows,
      exitResolve,
      exitPromise,
    };
    (record as { facade: AttendedPtySession }).facade = makeFacade(record);
    return record;
  };

  const rangeToWireError = (cause: unknown): never => {
    if (cause instanceof RangeError) {
      // Identifier-free by construction: ring messages carry offsets only.
      throw new KernelError('watermark-out-of-range', cause.message);
    }
    throw cause;
  };

  const makeFacade = (record: SessionRecord): AttendedPtySession => ({
    sessionId: record.id,

    attach: (consumer, attachOptions) => {
      const replayFrom = attachOptions?.replayFrom;
      if (replayFrom !== undefined) {
        try {
          for (const chunk of record.ring.replayFrom(replayFrom)) {
            consumer(outputFrame(record, chunk.offset, chunk.bytes));
          }
        } catch (cause) {
          rangeToWireError(cause);
        }
      }
      record.consumer = consumer;
      pump(record);
    },

    detach: () => {
      // Ring retained, offsets stable — the serialize-addon contract.
      record.consumer = undefined;
    },

    write: (bytes) => {
      const proc = record.proc;
      if (proc === undefined) {
        throw new KernelError('bad-request', `session ${record.id} has no live pty child`);
      }
      proc.write(bytes);
    },

    resize: (cols, rows) => {
      if (
        !Number.isInteger(cols) ||
        !Number.isInteger(rows) ||
        cols < 1 ||
        rows < 1 ||
        cols > PTY_MAX_COLS ||
        rows > PTY_MAX_ROWS
      ) {
        throw new KernelError(
          'bad-request',
          `pty resize out of bounds: ${String(cols)}x${String(rows)} ` +
            `(want 1..${PTY_MAX_COLS} x 1..${PTY_MAX_ROWS})`,
        );
      }
      const proc = record.proc;
      if (proc === undefined) {
        throw new KernelError('bad-request', `session ${record.id} has no live pty child`);
      }
      record.cols = cols;
      record.rows = rows;
      proc.resize(cols, rows);
    },

    ack: (watermark) => {
      try {
        const mayResume = record.ring.ack(watermark);
        if (mayResume) record.proc?.resume();
      } catch (cause) {
        rangeToWireError(cause);
      }
    },

    replay: (fromWatermark) => {
      try {
        return record.ring
          .replayFrom(fromWatermark)
          .map((chunk) => outputFrame(record, chunk.offset, chunk.bytes));
      } catch (cause) {
        return rangeToWireError(cause);
      }
    },

    kill: async (mode = 'graceful') => {
      const proc = record.proc;
      if (proc === undefined) return record.exitPromise; // idempotent
      if (mode === 'force') {
        forceKill(record);
      } else {
        proc.kill(); // hangup semantics — the TUI checkpoints its own state
        escalateAfterGrace(record);
      }
      return record.exitPromise;
    },

    waitForExit: () => record.exitPromise,
    producedOffset: () => record.ring.producedEnd,
    isLive: () => record.proc !== undefined,
    pause: () => record.proc?.pause(),
    resume: () => record.proc?.resume(),
  });

  /** Escalate a graceful kill to force when the child ignores the hangup. */
  const escalateAfterGrace = (record: SessionRecord): void => {
    const generation = record.generationExit;
    const timer = setTimeout(() => {
      if (record.proc !== undefined && record.generationExit === generation) {
        logger?.warn('pty child ignored graceful kill; escalating to force', {
          sessionId: record.id,
        });
        forceKill(record);
      }
    }, forceKillAfterMs);
    (timer as { unref?: () => void }).unref?.();
    void generation?.then(() => clearTimeout(timer));
  };

  // ---- verbs -----------------------------------------------------------------

  const validateAttendedParams = (params: LaunchParams): ClaudeProfileLabel => {
    profiles.resolve(params.accountLabel); // unknown label → typed throw
    if (params.backend !== LABEL_BACKENDS[params.accountLabel]) {
      throw new KernelError(
        'bad-request',
        `label/backend pairing violation: ${params.accountLabel} requires ` +
          `${LABEL_BACKENDS[params.accountLabel]}`,
      );
    }
    if (params.substrate !== 'pty') {
      throw new KernelError(
        'bad-request',
        'substrate sdk rides the session kernel (BE-1) — this host spawns attended pty sessions',
      );
    }
    if (!isAbsolute(params.cwd)) {
      throw new KernelError(
        'bad-request',
        'cwd must be an absolute, byte-stable path (blueprint §3 rule 2)',
      );
    }
    if (params.prompt !== undefined) {
      throw new KernelError(
        'bad-request',
        'attended pty sessions take input through the terminal — a launch prompt is sdk-substrate-only',
      );
    }
    if (!isClaudeProfileLabel(params.accountLabel)) {
      throw new KernelError('bad-request', 'pty substrate is claude_code-only (blueprint §4.1)');
    }
    return params.accountLabel;
  };

  return {
    launchAttended: async (params) => {
      assertNotShuttingDown();
      const label = validateAttendedParams(params);
      const record = await insertRowAndSpawn({
        id: newSessionId(),
        label,
        cwd: params.cwd.normalize('NFC'),
        purpose: params.purpose,
        ...(params.workstreamHint !== undefined ? { workstreamHint: params.workstreamHint } : {}),
        context: { kind: 'attended', sessionUuid: newSessionUuid() },
        cols: defaultCols,
        rows: defaultRows,
      });
      return record.facade;
    },

    launchLoginBootstrap: async (bootstrapOptions) => {
      assertNotShuttingDown();
      const profile = profiles.resolve(bootstrapOptions.accountLabel); // typed refusal
      const cwd = bootstrapOptions.cwd ?? profile.configDir;
      if (!isAbsolute(cwd)) {
        throw new KernelError('bad-request', 'login bootstrap cwd must be absolute');
      }
      const record = await insertRowAndSpawn({
        id: newSessionId(),
        label: profile.label,
        cwd: cwd.normalize('NFC'),
        purpose: 'login-bootstrap',
        context: { kind: 'login-bootstrap', sessionUuid: newSessionUuid() },
        cols: bootstrapOptions.cols ?? defaultCols,
        rows: bootstrapOptions.rows ?? defaultRows,
      });
      return record.facade;
    },

    recycle: async (sessionId, recycleOptions = {}) => {
      assertNotShuttingDown();
      const record = records.get(sessionId);
      if (record === undefined) throw new SessionNotFoundKernelError(sessionId);
      if (record.proc === undefined) {
        throw new KernelError(
          'bad-request',
          `session ${sessionId} has no live pty child — recycle targets live sessions; ` +
            'dead rows ride the resume path',
        );
      }
      const row = ledger.get(sessionId);
      if (row === undefined) throw new SessionNotFoundKernelError(sessionId);
      if (row.nativeSessionId === null) {
        // Refuse WITHOUT killing: the session keeps running untouched.
        throw new SessionNotResumableError(
          sessionId,
          'no native session id was ever backfilled — nothing to recycle-resume onto',
        );
      }
      const nativeSessionId = row.nativeSessionId;
      const fork = recycleOptions.fork === true;

      // 1. CHECKPOINT (v0): the native transcript on disk IS the checkpoint —
      //    the TUI persists every turn; the hangup below flushes the child.
      //    The hook pins the checkpoint→kill ordering for tests (plan §9.2
      //    BE-2 edge row); richer checkpointing lands with BE-9's recycle
      //    hardening at M6.
      options.testHooks?.onCheckpoint?.(sessionId);
      logger?.info('recycle checkpoint', { sessionId });

      // 2. KILL (graceful, force after the grace period).
      record.recycling = true;
      const generation = record.generationExit;
      try {
        record.proc.kill();
        escalateAfterGrace(record);
        await generation;

        // 3. RESUME via the M1 FSM.
        if (!fork) {
          ledger.transition(sessionId, 'resumed'); // running → resumed (legal)
          const profile = profiles.resolve(record.label);
          const env = buildSessionEnv(profile, {
            baseEnv: options.baseEnv ?? { ...process.env },
          });
          try {
            spawnGeneration(
              record,
              { kind: 'recycle-resume', sessionUuid: newSessionUuid(), nativeSessionId },
              env,
            );
          } catch (cause) {
            settleExited(record, record.lastExit);
            throw cause;
          } finally {
            record.recycling = false;
          }
          // 4. [X4] continuation edge — same node (continuation of itself).
          edges.emitContinuationEdge({
            edge: 'continue',
            fromSessionId: sessionId,
            toSessionId: sessionId,
            reason: 'recycle',
            atEpochMs: clock(),
          });
          return { session: record.facade };
        }

        // Fork path: parent settles, a continuation CHILD row spawns.
        record.recycling = false;
        settleExited(record, record.lastExit);
        const child = await insertRowAndSpawn({
          id: newSessionId(),
          label: record.label,
          cwd: record.cwd,
          purpose: row.purpose,
          ...(row.workstreamHint !== null ? { workstreamHint: row.workstreamHint } : {}),
          context: {
            kind: 'recycle-resume',
            sessionUuid: newSessionUuid(),
            nativeSessionId,
            fork: true,
          },
          cols: record.cols,
          rows: record.rows,
        });
        edges.emitContinuationEdge({
          edge: 'continue',
          fromSessionId: sessionId,
          toSessionId: child.id,
          reason: 'recycle',
          atEpochMs: clock(),
        });
        return { session: child.facade, forkedFrom: sessionId };
      } finally {
        record.recycling = false;
      }
    },

    get: (sessionId) => records.get(sessionId)?.facade,

    live: () =>
      [...records.values()].filter((record) => record.proc !== undefined).map((r) => r.id),

    onSession: (listener) => {
      // Replay already-live sessions in spawn order, synchronously.
      for (const record of announced) {
        if (record.proc !== undefined) listener(record.facade);
      }
      sessionListeners.add(listener);
      return () => {
        sessionListeners.delete(listener);
      };
    },

    shutdown: async () => {
      shuttingDown = true;
      const exits: Promise<PtyHostExit>[] = [];
      for (const record of records.values()) {
        if (record.proc !== undefined) {
          record.recycling = false;
          forceKill(record);
        }
        exits.push(record.exitPromise);
        if (record.proc === undefined && !record.settled) {
          settleExited(record, record.lastExit);
        }
      }
      await Promise.allSettled(exits);
    },
  };
}
