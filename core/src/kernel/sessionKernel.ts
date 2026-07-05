/**
 * SessionKernel — the SDK session lifecycle FSM over the resume ledger
 * (BE-1; blueprint §4.1, §5 guardrails; plan §4/BE-1).
 *
 * Verbs: launch · resume (± fork) · abort · status · shutdown.
 *
 * Discipline encoded here (each proven by a test in sessionKernel.spec.ts):
 *   - ROW BEFORE SPAWN: the resume-ledger row is inserted before
 *     QueryRunner.start is invoked — a crash in the window leaves a
 *     recoverable `spawning` row, never an untracked child (SPIKE-D vii).
 *   - NATIVE ID BACKFILL: the ledger's native_session_id is backfilled from
 *     the runner's init message (write-once; the schema enforces it — on
 *     resume, a drifting native id is logged, never overwritten).
 *   - UN-FORKED DOUBLE-RESUME BLOCK: resuming a session that is live in this
 *     broker without fork throws `double-resume-blocked` (blueprint §5).
 *   - TRANSCRIPT-TAIL VALIDATION: before any dead resume, the tail validator
 *     runs; an unsafe tail is REPAIRED by forking from the last coherent
 *     message (`forkSession` + `resumeSessionAt`), never by mutating the
 *     native transcript (X4 guardrail).
 *   - PER-SESSION ENV ISOLATION: every spawn builds its env through the one
 *     spawn layer (buildSessionEnv); three concurrent sessions on three
 *     profiles get three distinct, non-cross-contaminating environments.
 *   - PID-LIVENESS GUARD ON DEAD RESUME (SPIKE-D finding 2, sqlite-ddl §4):
 *     an un-forked resume of a `running`-state row from a previous broker
 *     life probes the recorded pid + argv spawn nonce first and refuses with
 *     `double-resume-blocked` while the verified child is still alive —
 *     `running → resumed` is legal only after broker AND child death.
 *
 * States and transition legality live in @aibender/schema (LEGAL_TRANSITIONS,
 * frozen M1); this kernel owns the spawn path and the pid-liveness guard
 * above (pidLiveness.ts). FULL orphan reconciliation on broker restart
 * (`orphan_detected`/`orphan_killed` driving over `unreconciled()`) is
 * BE-2/BE-9 territory — the ledger states exist and dead-resume from
 * `orphan_killed` is supported here.
 */

import { isAbsolute, join } from 'node:path';

import type { LaunchParams, LineageRecorder, SessionStatus } from '@aibender/protocol';
import { LABEL_BACKENDS, noopLineageRecorder } from '@aibender/protocol';
import type { ResumeLedgerRow, ResumeLedgerStore } from '@aibender/schema';
import type { Logger } from '@aibender/shared';
import { newId } from '@aibender/shared';

import type { KernelApprovalRelay } from './approvals.js';
import { buildSessionEnv } from './env.js';
import {
  DoubleResumeError,
  KernelError,
  KernelShutdownError,
  SessionNotFoundKernelError,
  SessionNotResumableError,
} from './errors.js';
import { defaultPidLivenessProbe, type PidLivenessProbe } from './pidLiveness.js';
import type { ClaudeProfile, ProfileRegistry } from './profiles.js';
import type {
  QueryHandle,
  QueryRunner,
  QuerySpec,
  RunnerMessageTap,
  RunnerResultMessage,
} from './queryRunner.js';
import { validateTranscriptTailFile, type TranscriptTailVerdict } from './transcriptTail.js';

// ---------------------------------------------------------------------------
// Transcript location (injectable; default mirrors Claude Code's layout)
// ---------------------------------------------------------------------------

export interface TranscriptRef {
  readonly profile: ClaudeProfile;
  readonly cwd: string;
  readonly nativeSessionId: string;
}

/**
 * Resolve the on-disk transcript path for a session, or undefined when none
 * can be located (validation is then skipped — the SDK itself is the next
 * line of defense). Injectable for tests and for version-gate drift fixes.
 */
export type TranscriptLocator = (ref: TranscriptRef) => string | undefined;

/**
 * Claude Code project-dir slug: the absolute cwd with every `/` and `.`
 * replaced by `-` (best-effort mirror of the shipping binary's layout;
 * override via the locator if a version gate detects drift).
 */
export function projectDirSlug(cwd: string): string {
  return cwd.replaceAll(/[/.]/g, '-');
}

export const defaultTranscriptLocator: TranscriptLocator = (ref) =>
  join(ref.profile.configDir, 'projects', projectDirSlug(ref.cwd), `${ref.nativeSessionId}.jsonl`);

// ---------------------------------------------------------------------------
// Kernel surface
// ---------------------------------------------------------------------------

export interface SessionExit {
  readonly sessionId: string;
  readonly finalState: 'exited';
  /** Terminal result message, when the stream produced one before ending. */
  readonly result?: RunnerResultMessage;
}

export interface KernelSession {
  readonly sessionId: string;
  /** Resolves when the session's message stream ends and the ledger settles. */
  waitForExit(): Promise<SessionExit>;
}

export interface ResumeOptions {
  /** The next user prompt the resumed session processes. */
  readonly prompt: string;
  /** Fork a continuation child instead of continuing the same session (X4). */
  readonly fork?: boolean;
}

export interface ResumeOutcome extends KernelSession {
  /** Parent session id when the resume forked (explicitly or via repair). */
  readonly forkedFrom?: string;
  /** True when an unsafe transcript tail forced a repair fork. */
  readonly repaired?: boolean;
}

export interface SessionKernelOptions {
  readonly ledger: ResumeLedgerStore;
  readonly profiles: ProfileRegistry;
  readonly runner: QueryRunner;
  /**
   * Base env snapshot for buildSessionEnv. Defaults to process.env captured
   * per spawn. Tests pass explicit fixtures.
   */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly transcriptLocator?: TranscriptLocator;
  /**
   * Pid-liveness + argv-nonce probe for the un-forked dead-resume guard
   * (SPIKE-D finding 2). Defaults to the real process-table probe; tests
   * inject deterministic fakes.
   */
  readonly pidProbe?: PidLivenessProbe;
  /**
   * BE-2 canUseTool wiring (M2): the approval relay. When present, every SDK
   * spawn's QuerySpec carries a per-session canUseTool handler and session
   * end supersedes that session's pending approvals (approvals.ts;
   * blueprint §4.1 in-loop permission relay). Absent → M1 behavior exactly.
   */
  readonly approvals?: KernelApprovalRelay;
  /**
   * THE TRANSCRIPT-TEE SEAM (ICR-0009, M3): observes every RunnerMessage the
   * pump consumes, per session, in stream order — the composition root
   * adapts it onto the gateway's TranscriptSource port (rawOfRunnerMessage).
   * A tap that throws is logged and ignored: it can never stall or kill the
   * pump, and FSM settlement (native-id backfill, ledger transitions,
   * approval supersession) is unaffected. Absent → M1/M2 behavior exactly.
   */
  readonly messageTap?: RunnerMessageTap;
  /**
   * [X4] LINEAGE RECORDER (ws-protocol.md §15.1, M4 — BE-7's narrow wiring
   * into the kernel, the BE-2 `edges` precedent; BE-ORCH reviews): the
   * frozen edge-recording port, called AT ACTION TIME — the same tick as the
   * ledger write, before any spawn await — on every launch (new node), fork
   * (fork edge to the child) and un-forked dead resume (`continue`
   * self-edge). `record` never throws by its frozen contract and is never
   * awaited. Absent → {@link noopLineageRecorder} (M1–M3 behavior exactly).
   */
  readonly lineage?: LineageRecorder;
  readonly logger?: Logger;
  /**
   * Test seams for race proofs (SPIKE-D `--crash-after-ledger` analogue).
   * Production wiring never sets these.
   */
  readonly testHooks?: {
    readonly afterLedgerInsert?: (sessionId: string) => void | Promise<void>;
  };
}

export interface SessionKernel {
  /**
   * Launch a fresh SDK session for a Claude account label. M1 scope: backend
   * `claude_code`, substrate `sdk` (pty lands with BE-2 at M2; AWS_DEV/LOCAL
   * ride the BE-4 adapters). `params.prompt` is required on this substrate.
   */
  launch(params: LaunchParams): Promise<KernelSession>;
  /** Resume (or fork) an existing ledger session. See ResumeOptions. */
  resume(sessionId: string, options: ResumeOptions): Promise<ResumeOutcome>;
  /** Abort a session that is live in this broker. */
  abort(sessionId: string): Promise<SessionExit>;
  /** Wire-shaped status projection (protocol SessionStatus). */
  status(sessionId?: string): readonly SessionStatus[];
  /** True while the session has an active handle in this broker. */
  isLive(sessionId: string): boolean;
  /** Refuse new spawns, abort live sessions, await their pumps. */
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface LiveSession {
  readonly handle: QueryHandle;
  readonly abortController: AbortController;
  readonly exit: Promise<SessionExit>;
}

export function createSessionKernel(options: SessionKernelOptions): SessionKernel {
  const { ledger, profiles, runner } = options;
  const lineage = options.lineage ?? noopLineageRecorder;
  const locateTranscript = options.transcriptLocator ?? defaultTranscriptLocator;
  const pidProbe = options.pidProbe ?? defaultPidLivenessProbe;
  const logger = options.logger;
  const live = new Map<string, LiveSession>();
  let shuttingDown = false;

  const assertNotShuttingDown = (): void => {
    if (shuttingDown) throw new KernelShutdownError();
  };

  const buildEnvFor = (profile: ClaudeProfile): Readonly<Record<string, string>> =>
    buildSessionEnv(profile, { baseEnv: options.baseEnv ?? { ...process.env } });

  // BE-2 canUseTool wiring (M2): per-session in-loop permission relay spread
  // into every QuerySpec this kernel builds (launch, fork, dead resume).
  const canUseToolSpread = (
    sessionId: string,
    accountLabel: ClaudeProfile['label'],
  ): Pick<QuerySpec, 'canUseTool'> =>
    options.approvals !== undefined
      ? { canUseTool: options.approvals.canUseToolFor({ sessionId, accountLabel }) }
      : {};

  /**
   * Start the runner for an EXISTING ledger row, register the live handle,
   * and pump its message stream until exit. Shared by launch, fork, and
   * un-forked dead resume — the one place FSM settlement happens.
   */
  const startAndPump = async (
    row: { readonly id: string },
    spec: Omit<QuerySpec, 'abortController'>,
  ): Promise<KernelSession> => {
    const abortController = new AbortController();
    let handle: QueryHandle;
    try {
      handle = await runner.start({ ...spec, abortController });
    } catch (cause) {
      // Spawn failed: settle the row (spawning|resumed → exited is legal).
      ledger.transition(row.id, 'exited');
      throw cause;
    }

    // Spawned: fresh rows advance spawning → running; un-forked dead resumes
    // are already in `resumed` (transitioned by the caller) and stay there.
    if (ledger.get(row.id)?.state === 'spawning') {
      ledger.transition(row.id, 'running');
    }
    if (handle.pid !== undefined && handle.spawnNonce !== undefined) {
      // SPIKE-D finding 2: pid of the ACTUAL session process, nonce-paired.
      ledger.backfillPid(row.id, handle.pid, handle.spawnNonce);
    }

    const exit = (async (): Promise<SessionExit> => {
      let result: RunnerResultMessage | undefined;
      try {
        for await (const message of handle.messages()) {
          // ICR-0009 transcript tee: observe BEFORE the kernel's own
          // handling, inside the single pump (messages() stays
          // single-consumer). A throwing tap is logged, never propagated.
          if (options.messageTap !== undefined) {
            try {
              options.messageTap(row.id, message);
            } catch (cause) {
              logger?.warn('message tap threw; ignoring (taps must not throw)', {
                sessionId: row.id,
                error: (cause as Error).message,
              });
            }
          }
          if (message.type === 'init') {
            const current = ledger.get(row.id);
            if (current?.nativeSessionId == null) {
              ledger.backfillNativeSessionId(row.id, message.nativeSessionId);
            } else if (current.nativeSessionId !== message.nativeSessionId) {
              // Write-once ledger column (frozen M1): a resume that minted a
              // new native id is drift worth logging, never an overwrite.
              logger?.warn('native session id drift on resume', {
                sessionId: row.id,
                expected: current.nativeSessionId,
                received: message.nativeSessionId,
              });
            }
          } else if (message.type === 'result') {
            result = message;
          }
        }
      } catch (cause) {
        logger?.error('session message pump failed', {
          sessionId: row.id,
          error: (cause as Error).message,
        });
      } finally {
        live.delete(row.id);
        // BE-2 canUseTool wiring (M2): the session's wait vanished — resolve
        // its pending approvals as `superseded` (ws-protocol.md §10.3).
        options.approvals?.sessionEnded(row.id);
        const state = ledger.get(row.id)?.state;
        if (state === 'spawning' || state === 'running' || state === 'resumed') {
          ledger.transition(row.id, 'exited');
        }
      }
      return {
        sessionId: row.id,
        finalState: 'exited',
        ...(result !== undefined ? { result } : {}),
      };
    })();

    live.set(row.id, { handle, abortController, exit });
    return { sessionId: row.id, waitForExit: () => exit };
  };

  /** Insert row → (hook) → spawn. THE row-before-spawn ordering. */
  const insertRowAndSpawn = async (args: {
    readonly id: string;
    readonly accountLabel: ClaudeProfile['label'];
    readonly cwd: string;
    readonly purpose: string;
    readonly workstreamHint?: string;
    readonly prompt: string;
    readonly resumeNativeSessionId?: string;
    readonly forkSession?: boolean;
    readonly resumeSessionAt?: string;
    /** [X4]: when set, this spawn is a fork CHILD of the named session. */
    readonly lineageForkFrom?: string;
  }): Promise<KernelSession> => {
    const profile = profiles.resolve(args.accountLabel);
    const env = buildEnvFor(profile);

    // 1. Row BEFORE spawn (state `spawning`) — the recoverable crash window.
    ledger.insertBeforeSpawn({
      id: args.id,
      accountLabel: args.accountLabel,
      backend: 'claude_code',
      cwd: args.cwd,
      substrate: 'sdk',
      purpose: args.purpose,
      ...(args.workstreamHint !== undefined ? { workstreamHint: args.workstreamHint } : {}),
    });

    // [X4] action-time recording (ws-protocol.md §15.1): the node — and the
    // fork edge, when this spawn is a fork child — land in the SAME tick as
    // the row-before-spawn write, before the spawn is awaited. Deterministic
    // by construction: every kernel-mediated action records exactly once.
    lineage.record({
      kind: 'launch',
      sessionId: args.id,
      accountLabel: args.accountLabel,
      backend: 'claude_code',
      cwd: args.cwd,
      ...(args.workstreamHint !== undefined ? { workstreamHint: args.workstreamHint } : {}),
      atEpochMs: Date.now(),
    });
    if (args.lineageForkFrom !== undefined) {
      lineage.record({
        kind: 'fork',
        fromSessionId: args.lineageForkFrom,
        toSessionId: args.id,
        atEpochMs: Date.now(),
      });
    }

    await options.testHooks?.afterLedgerInsert?.(args.id);

    if (shuttingDown) {
      // Shutdown raced the spawn window: the row is recoverable, the child
      // was never forked. Settle the row and refuse.
      ledger.transition(args.id, 'exited');
      throw new KernelShutdownError();
    }

    // 2. Spawn + pump.
    return startAndPump(
      { id: args.id },
      {
        sessionId: args.id,
        prompt: args.prompt,
        cwd: args.cwd,
        env,
        ...(args.resumeNativeSessionId !== undefined
          ? { resumeNativeSessionId: args.resumeNativeSessionId }
          : {}),
        ...(args.forkSession !== undefined ? { forkSession: args.forkSession } : {}),
        ...(args.resumeSessionAt !== undefined ? { resumeSessionAt: args.resumeSessionAt } : {}),
        // BE-2 canUseTool wiring (M2).
        ...canUseToolSpread(args.id, args.accountLabel),
      },
    );
  };

  const validateForDeadResume = (row: ResumeLedgerRow): TranscriptTailVerdict | undefined => {
    if (row.nativeSessionId === null) return undefined;
    const profile = profiles.resolve(row.accountLabel);
    const path = locateTranscript({
      profile,
      cwd: row.cwd,
      nativeSessionId: row.nativeSessionId,
    });
    if (path === undefined) return undefined;
    try {
      return validateTranscriptTailFile(path);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw cause;
    }
  };

  const forkFrom = async (
    parent: ResumeLedgerRow,
    prompt: string,
    resumeSessionAt: string | undefined,
    repaired: boolean,
  ): Promise<ResumeOutcome> => {
    if (parent.nativeSessionId === null) {
      throw new SessionNotResumableError(
        parent.id,
        'no native session id was ever backfilled — nothing to fork from',
      );
    }
    if (!isClaudeLabel(parent.accountLabel)) {
      throw new SessionNotResumableError(parent.id, 'not a claude_code session (BE-4 adapters)');
    }
    const session = await insertRowAndSpawn({
      id: newId('ses'),
      accountLabel: parent.accountLabel,
      cwd: parent.cwd,
      purpose: parent.purpose,
      ...(parent.workstreamHint !== null ? { workstreamHint: parent.workstreamHint } : {}),
      prompt,
      resumeNativeSessionId: parent.nativeSessionId,
      forkSession: true,
      ...(resumeSessionAt !== undefined ? { resumeSessionAt } : {}),
      // [X4]: sibling-creating CHILD from the fork point (§15.1 `fork`).
      lineageForkFrom: parent.id,
    });
    return {
      ...session,
      forkedFrom: parent.id,
      ...(repaired ? { repaired: true } : {}),
    };
  };

  function isClaudeLabel(label: string): label is ClaudeProfile['label'] {
    return label === 'MAX_A' || label === 'MAX_B' || label === 'ENT';
  }

  return {
    launch: async (params) => {
      assertNotShuttingDown();

      // Validation order matters for typed refusals (plan §9.2 negative row).
      profiles.resolve(params.accountLabel); // unknown label → typed throw
      if (params.backend !== LABEL_BACKENDS[params.accountLabel]) {
        throw new KernelError(
          'bad-request',
          `label/backend pairing violation: ${params.accountLabel} requires ` +
            `${LABEL_BACKENDS[params.accountLabel]}`,
        );
      }
      if (params.substrate !== 'sdk') {
        throw new KernelError(
          'bad-request',
          'substrate pty is the attended surface (BE-2, M2) — this kernel spawns SDK sessions',
        );
      }
      if (!isAbsolute(params.cwd)) {
        throw new KernelError(
          'bad-request',
          'cwd must be an absolute, byte-stable path (blueprint §3 rule 2)',
        );
      }
      if (params.prompt === undefined || params.prompt.length === 0) {
        throw new KernelError('bad-request', 'a prompt is required on the sdk substrate');
      }
      if (!isClaudeLabel(params.accountLabel)) {
        // profiles.resolve above already refuses AWS_DEV/LOCAL; this narrows
        // the type and guards future label additions.
        throw new KernelError('bad-request', 'kernel launches claude_code sessions only at M1');
      }

      return insertRowAndSpawn({
        id: newId('ses'),
        accountLabel: params.accountLabel,
        // cwd is normalized ONCE here; ledger + spawn see the same bytes.
        cwd: params.cwd.normalize('NFC'),
        purpose: params.purpose,
        ...(params.workstreamHint !== undefined ? { workstreamHint: params.workstreamHint } : {}),
        prompt: params.prompt,
      });
    },

    resume: async (sessionId, resumeOptions) => {
      assertNotShuttingDown();
      const row = ledger.get(sessionId);
      if (row === undefined) throw new SessionNotFoundKernelError(sessionId);
      if (resumeOptions.prompt === undefined || resumeOptions.prompt.length === 0) {
        throw new KernelError('bad-request', 'a prompt is required to resume an sdk session');
      }

      const fork = resumeOptions.fork === true;

      if (live.has(sessionId)) {
        // Blueprint §5 guardrail: un-forked double-resume of a running
        // session is blocked; forking a live session is a legitimate branch.
        if (!fork) throw new DoubleResumeError(sessionId);
        return forkFrom(row, resumeOptions.prompt, undefined, false);
      }

      switch (row.state) {
        case 'spawning':
          throw new SessionNotResumableError(
            sessionId,
            'still in the spawn window — restart reconciliation owns this row, not resume',
          );
        case 'orphan_detected':
          throw new SessionNotResumableError(
            sessionId,
            'orphan not yet reaped — orphan_killed must precede resume (SPIKE-D order)',
          );
        case 'exited':
          if (!fork) {
            throw new SessionNotResumableError(
              sessionId,
              'exited is terminal — continue it as a fork (continuation child, X4)',
            );
          }
          return forkFrom(row, resumeOptions.prompt, undefined, false);
        case 'running':
        case 'resumed':
        case 'orphan_killed': {
          // PID-LIVENESS GUARD (SPIKE-D finding 2; sqlite-ddl §4): a
          // `running` row from a previous broker life means "a broker
          // believed this child alive and never settled it". Before an
          // UN-FORKED re-drive of the same native session, prove the child
          // is dead — `running → resumed` is legal only after broker AND
          // child death; a live child is the blueprint §5 un-forked
          // double-resume transcript-corruption mode.
          //
          //  - pid recorded → probe kill(pid, 0) + argv spawn nonce
          //    (pid-reuse guard). Verified-alive → double-resume-blocked;
          //    driving `running → orphan_detected → orphan_killed` for it
          //    is restart reconciliation (BE-2/BE-9, M2). Forking remains
          //    available, exactly like forking a live in-broker session.
          //  - pid NULL (the SDK path cannot surface the child pid at
          //    0.3.201): un-forked resume stays available because SDK
          //    children share the broker's stdio-pipe lifetime — query()
          //    spawns the bundled claude attached via pipes (never
          //    detached/setsid, same process group), and a stream-json
          //    child exits on stdin EOF when the dead broker's pipe end
          //    closes. Defense in depth: an SDK child only outlives its
          //    turn mid-work, and a child killed mid-turn leaves a
          //    dangling/torn transcript tail, which the validator below
          //    routes to a repair FORK — never an un-forked re-drive. This
          //    reasoning is encoded as tests in sessionKernel.spec.ts
          //    ("pid-liveness guard" suite).
          if (row.state === 'running' && !fork && row.pid !== null) {
            if (pidProbe.isSameProcessAlive(row.pid, row.spawnNonce)) {
              throw new DoubleResumeError(
                sessionId,
                `session ${sessionId} still has a live, nonce-verified child process; ` +
                  'un-forked double-resume is blocked (blueprint §5) — resume with ' +
                  'fork:true to branch, or let restart reconciliation reap the orphan',
              );
            }
          }
          // Dead session (no live handle in this broker). Validate the
          // transcript tail before ANY resume (blueprint §4.1).
          const verdict = validateForDeadResume(row);
          if (verdict !== undefined && !verdict.safeToResume) {
            if (verdict.lastCoherentUuid === null) {
              throw new SessionNotResumableError(
                sessionId,
                'transcript tail has no coherent anchor to repair from',
              );
            }
            // REPAIR: fork from the last coherent message. The parent row is
            // superseded — settle it (running|resumed|orphan_killed → exited
            // are all legal transitions).
            const outcome = await forkFrom(
              row,
              resumeOptions.prompt,
              verdict.lastCoherentUuid,
              true,
            );
            ledger.transition(sessionId, 'exited');
            return outcome;
          }
          if (fork) return forkFrom(row, resumeOptions.prompt, undefined, false);
          if (row.nativeSessionId === null) {
            throw new SessionNotResumableError(
              sessionId,
              'no native session id was ever backfilled — nothing to resume',
            );
          }
          if (!isClaudeLabel(row.accountLabel)) {
            throw new SessionNotResumableError(sessionId, 'not a claude_code session');
          }
          // Un-forked dead resume: same row, state → resumed, then spawn.
          ledger.transition(sessionId, 'resumed');
          // [X4] action-time recording (§15.1 `resume`): a continuation is a
          // CHILD — the in-place re-drive of the SAME node is the legal
          // `continue` SELF-edge (from === to), same tick as the transition.
          lineage.record({
            kind: 'resume',
            fromSessionId: sessionId,
            toSessionId: sessionId,
            atEpochMs: Date.now(),
          });
          const profile = profiles.resolve(row.accountLabel);
          return startAndPump(row, {
            sessionId: row.id,
            prompt: resumeOptions.prompt,
            cwd: row.cwd,
            env: buildEnvFor(profile),
            resumeNativeSessionId: row.nativeSessionId,
            // BE-2 canUseTool wiring (M2).
            ...canUseToolSpread(row.id, profile.label),
          });
        }
      }
    },

    abort: async (sessionId) => {
      const entry = live.get(sessionId);
      if (entry === undefined) {
        if (ledger.get(sessionId) === undefined) throw new SessionNotFoundKernelError(sessionId);
        throw new KernelError('bad-request', `session ${sessionId} is not live in this broker`);
      }
      entry.abortController.abort();
      try {
        await entry.handle.interrupt();
      } catch {
        // interrupt is best-effort; the abort signal is authoritative
      }
      return entry.exit;
    },

    status: (sessionId) => {
      const rows =
        sessionId === undefined
          ? ledger.list()
          : ((): readonly ResumeLedgerRow[] => {
              const row = ledger.get(sessionId);
              if (row === undefined) throw new SessionNotFoundKernelError(sessionId);
              return [row];
            })();
      return rows.map(
        (row): SessionStatus => ({
          sessionId: row.id,
          accountLabel: row.accountLabel,
          backend: row.backend,
          substrate: row.substrate,
          state: row.state,
          cwd: row.cwd,
          purpose: row.purpose,
          ...(row.workstreamHint !== null ? { workstreamHint: row.workstreamHint } : {}),
          ...(row.nativeSessionId !== null ? { nativeSessionId: row.nativeSessionId } : {}),
          ...(row.pid !== null ? { pid: row.pid } : {}),
        }),
      );
    },

    isLive: (sessionId) => live.has(sessionId),

    shutdown: async () => {
      shuttingDown = true;
      const exits: Promise<SessionExit>[] = [];
      for (const entry of live.values()) {
        entry.abortController.abort();
        exits.push(entry.exit);
      }
      await Promise.allSettled(exits);
    },
  };
}
