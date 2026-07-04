/**
 * aibender-core — composition root (core/src/main/, owner BE-ORCH; M1 kernel
 * wiring contributed by BE-1, broker wiring by the M1 fix wave).
 *
 * M1 state: {@link composeKernel} wires config → schema migrations → session
 * kernel in startup order (plan §2), and {@link composeBroker} completes the
 * M1 deliverable "BE-3 skeleton (control channel only) sufficient to drive a
 * scripted demo" (plan §8.2): it adapts the BE-1 SessionKernel onto the
 * gateway's kernel port ({@link adaptSessionKernel}) and starts the BE-3 WS
 * gateway over it. The adapters (BE-4) and the rest of the §2 chain join at
 * their milestones. Running the daemon directly still just prints and exits —
 * nothing touches the machine-local ~/.aibender without an explicit compose
 * call (operator config wiring into main() lands at M2).
 *
 * LIVE-SPAWN GATE: composeKernel/composeBroker default to a runner that
 * REFUSES to spawn (typed LiveSpawnDisabledError). The real SDK spawn path
 * requires `liveSpawn: { enabled: true }` — explicit operator opt-in config;
 * running it against real accounts is T3 owner-gated (docs/runbooks/
 * kernel-live-spawn.md).
 */

import { pathToFileURL } from 'node:url';

import type { SessionState } from '@aibender/protocol';
import { openKernelStore, type KernelStore, type ResumeLedgerStore } from '@aibender/schema';
import type { Logger } from '@aibender/shared';

import {
  KernelVerbError,
  startGateway,
  type GatewayHandle,
  type GatewayKernel,
} from '../gateway/index.js';
import {
  createProfileRegistry,
  createSdkQueryRunner,
  createSessionKernel,
  KernelError,
  LiveSpawnDisabledError,
  type ProfileRegistryOptions,
  type QueryRunner,
  type SessionKernel,
} from '../kernel/index.js';

export const DAEMON_NAME = 'aibender-core' as const;

// ---------------------------------------------------------------------------
// Kernel composition (BE-1 slice of the §2 startup chain)
// ---------------------------------------------------------------------------

export interface ComposeKernelOptions {
  /** `:memory:` (tests) or an absolute file path (e.g. ~/.aibender/db/kernel.db). */
  readonly storePath: string;
  /** Profile registry inputs (aibenderHome, SI-2 manifest, overrides). */
  readonly profiles?: ProfileRegistryOptions;
  /**
   * The REAL claude spawn path. Absent or `enabled: false` → the composed
   * runner refuses every spawn with a typed error. Enabling it is explicit
   * operator opt-in; real-account runs remain T3 owner-gated.
   */
  readonly liveSpawn?: { readonly enabled: boolean };
  /** Inject a runner directly (tests; future adapters). Wins over liveSpawn. */
  readonly runner?: QueryRunner;
  /** Base env snapshot for the spawn layer. Default: process.env per spawn. */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
}

export interface ComposedKernel {
  readonly kernel: SessionKernel;
  readonly store: KernelStore;
  /** Shutdown ordering: kernel drains first, then the store closes. */
  close(): Promise<void>;
}

/** A QueryRunner that refuses every spawn — the safe default composition. */
function createRefusingQueryRunner(): QueryRunner {
  return {
    start: async () => {
      throw new LiveSpawnDisabledError();
    },
  };
}

/**
 * Wire the M1 kernel: open the ledger store (migrations apply on open),
 * build the profile registry, pick the runner per the live-spawn gate, and
 * hand back the composed kernel with ordered shutdown.
 */
export async function composeKernel(options: ComposeKernelOptions): Promise<ComposedKernel> {
  const store = await openKernelStore({ path: options.storePath });
  const profiles = createProfileRegistry(options.profiles ?? {});
  const runner =
    options.runner ??
    (options.liveSpawn?.enabled === true
      ? createSdkQueryRunner({ liveSpawnOptIn: true })
      : createRefusingQueryRunner());
  const kernel = createSessionKernel({
    ledger: store.resumeLedger,
    profiles,
    runner,
    ...(options.baseEnv !== undefined ? { baseEnv: options.baseEnv } : {}),
  });
  return {
    kernel,
    store,
    close: async () => {
      await kernel.shutdown();
      store.close();
    },
  };
}

// ---------------------------------------------------------------------------
// SessionKernel → GatewayKernel adapter (BE-ORCH; plan §4/BE-3 "the
// composition root adapts the real BE-1 kernel to this interface")
// ---------------------------------------------------------------------------

/**
 * Adapt the BE-1 {@link SessionKernel} onto the gateway's verb port.
 *
 * Decisions of record (M1, ws-protocol.md §4 as amended by ICR-0004):
 *
 *  - STATE PROJECTION: verb results carry the LEDGER state at response time.
 *    `launch` awaits the kernel's spawn (the M1 kernel resolves launch after
 *    QueryRunner.start), so it typically answers `running` — the async
 *    `spawning` answer arrives with the M2 broker loop (§4.1 M1 note).
 *  - RESUME PROMPT (ICR-0004): optional on the wire, REQUIRED here — every
 *    M1 ledger row is an sdk-substrate session and SDK resume needs the next
 *    user prompt. Absent prompt → `bad-request`.
 *  - KILL MAPPING: `kill` maps onto SessionKernel.abort for sessions live in
 *    this broker (M1: `graceful` and `force` both abort+interrupt; the
 *    process-group SIGKILL distinction lands with BE-2). A kill of an
 *    already-`exited` session answers idempotently with `exited`. A kill of
 *    a dead-but-unsettled row (previous broker life) is REFUSED with
 *    `bad-request` — this broker cannot assert that child's fate at M1;
 *    restart reconciliation (BE-2/BE-9, M2) owns those rows.
 *  - ERRORS: every typed KernelError is re-thrown as a KernelVerbError with
 *    the same frozen code/message/retryable, so the gateway answers it
 *    verbatim (kernel messages are identifier-free by construction [X2]).
 *    Anything else propagates and the gateway answers a GENERIC `internal`.
 */
export function adaptSessionKernel(
  kernel: SessionKernel,
  ledger: ResumeLedgerStore,
): GatewayKernel {
  const run = async <T>(verb: () => Promise<T> | T): Promise<T> => {
    try {
      return await verb();
    } catch (cause) {
      if (cause instanceof KernelError) {
        throw new KernelVerbError(cause.code, cause.message, { retryable: cause.retryable });
      }
      throw cause;
    }
  };

  const projectState = (sessionId: string): SessionState => {
    const row = ledger.get(sessionId);
    if (row === undefined) {
      // A verb just acted on this id; a vanished row is a broker bug.
      throw new KernelVerbError('internal', 'ledger row vanished while answering a control verb');
    }
    return row.state;
  };

  return {
    launch: async (params) => {
      const session = await run(() => kernel.launch(params));
      return { sessionId: session.sessionId, state: projectState(session.sessionId) };
    },

    resume: async (params) => {
      const prompt = params.prompt;
      if (prompt === undefined || prompt.length === 0) {
        throw new KernelVerbError(
          'bad-request',
          'a prompt is required to resume an sdk session (ICR-0004: resume params carry it)',
        );
      }
      const outcome = await run(() =>
        kernel.resume(params.sessionId, { prompt, fork: params.fork }),
      );
      return {
        sessionId: outcome.sessionId,
        state: projectState(outcome.sessionId),
        ...(outcome.forkedFrom !== undefined ? { forkedFrom: outcome.forkedFrom } : {}),
      };
    },

    kill: async (params) => {
      const row = ledger.get(params.sessionId);
      if (row === undefined) {
        throw new KernelVerbError(
          'session-not-found',
          `no resume_ledger row for session ${params.sessionId}`,
        );
      }
      if (kernel.isLive(params.sessionId)) {
        // M1: graceful and force both map to abort (AbortController + SDK
        // interrupt); the process-GROUP SIGKILL for `force` lands with BE-2.
        await run(() => kernel.abort(params.sessionId));
        return { sessionId: params.sessionId, state: projectState(params.sessionId) };
      }
      if (row.state === 'exited') {
        // Idempotent: killing an already-settled session re-answers its state.
        return { sessionId: params.sessionId, state: 'exited' };
      }
      // Dead-but-unsettled row from a previous broker life: refusing beats
      // fabricating an `exited` transition for a child whose fate this
      // broker cannot verify at M1.
      throw new KernelVerbError(
        'bad-request',
        `session ${params.sessionId} is not live in this broker; its ledger row awaits ` +
          'restart reconciliation (M2) — resume it (fork remains available) instead of killing it',
      );
    },

    status: async (sessionId) => run(() => kernel.status(sessionId)),
  };
}

// ---------------------------------------------------------------------------
// Broker composition (M1 deliverable: control-channel gateway over the kernel)
// ---------------------------------------------------------------------------

export interface ComposeBrokerOptions extends ComposeKernelOptions {
  /** Gateway seams: bootstrap placement + injectables (tests). */
  readonly gateway?: {
    /** Bootstrap dir root (default ~/.aibender; tests pass a tmp dir). */
    readonly aibenderHome?: string;
    /** Env consulted for AIBENDER_HOME resolution (default process.env). */
    readonly env?: Readonly<Record<string, string | undefined>>;
    /** Skip writing the discovery file (tests). */
    readonly writeBootstrap?: boolean;
    readonly logger?: Logger;
    readonly clock?: () => Date;
  };
}

export interface ComposedBroker extends ComposedKernel {
  /** The BE-3 WS gateway handle (port, url, per-boot token, bootstrap path). */
  readonly gateway: GatewayHandle;
}

/**
 * Wire the full M1 broker: composeKernel → adaptSessionKernel → startGateway.
 * Shutdown ordering: gateway first (stop accepting verbs), then the kernel
 * drains, then the store closes.
 */
export async function composeBroker(options: ComposeBrokerOptions): Promise<ComposedBroker> {
  const composed = await composeKernel(options);
  const port = adaptSessionKernel(composed.kernel, composed.store.resumeLedger);
  let gateway: GatewayHandle;
  try {
    gateway = await startGateway({
      kernel: port,
      ...(options.gateway?.aibenderHome !== undefined
        ? { aibenderHome: options.gateway.aibenderHome }
        : {}),
      ...(options.gateway?.env !== undefined ? { env: options.gateway.env } : {}),
      ...(options.gateway?.writeBootstrap !== undefined
        ? { writeBootstrap: options.gateway.writeBootstrap }
        : {}),
      ...(options.gateway?.logger !== undefined ? { logger: options.gateway.logger } : {}),
      ...(options.gateway?.clock !== undefined ? { clock: options.gateway.clock } : {}),
    });
  } catch (cause) {
    // A gateway that failed to boot must not leak the composed kernel/store.
    await composed.close();
    throw cause;
  }
  return {
    kernel: composed.kernel,
    store: composed.store,
    gateway,
    close: async () => {
      await gateway.close();
      await composed.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Direct-execution entry point
// ---------------------------------------------------------------------------

/**
 * Entry point. Writes one line naming the daemon and returns the process
 * exit code (0). Output goes through `out` so tests can capture it. The M1
 * broker is composed via composeBroker() (kernel + control-channel gateway);
 * wiring operator CONFIG into this entry point (so direct execution actually
 * boots a broker against ~/.aibender) is the M2 slice — until then, direct
 * execution deliberately performs no implicit machine-local writes.
 */
export function main(out: (line: string) => void = console.log): number {
  out(
    `${DAEMON_NAME}: M1 broker available via composeBroker() (kernel + control-channel ` +
      'gateway); direct execution wires operator config at M2 — exiting 0.',
  );
  return 0;
}

// Executed directly (`pnpm --filter aibender-core start`)? Run and exit.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = main();
}
