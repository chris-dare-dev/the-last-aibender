/**
 * aibender-core — composition root (core/src/main/, owner BE-ORCH; M1 kernel
 * wiring contributed by BE-1, broker wiring by the M1 fix wave, full M2/M3
 * port wiring by BE-MAIN — resolving M2 deviation D3, docs/runbooks/m2-dod.md
 * §4, and deferred watch item 1, docs/contracts/icr/README.md).
 *
 * {@link composeKernel} wires config → schema migrations → session kernel in
 * startup order (plan §2). {@link composeBroker} composes the FULL broker on
 * top of it — every gateway port through ONE composition:
 *
 *   - kernel verbs        — {@link adaptSessionKernel} (M1);
 *   - approvals           — an ApprovalBroker composed here: the kernel side
 *                           rides `approvalRelayFromBroker` (canUseTool +
 *                           session-death supersession), the gateway side
 *                           rides `toApprovalBrokerGatewayPort` (M2);
 *   - attended PTY        — a BE-2 ptyHost created over the SAME resume
 *                           ledger/profiles, adapted via
 *                           `toGatewayPtyHostPort`; the PtyBackend is the
 *                           injection seam (testkit FakePtyBackend in tests,
 *                           `createNodePtySpawner` behind its own live-spawn
 *                           opt-in for real children) (M2);
 *   - transcript tee      — the ICR-0009 kernel message tap fanned onto the
 *                           gateway's TranscriptSource port with
 *                           `rawOfRunnerMessage` (M2/M3);
 *   - M3 fan-out sources  — {@link BrokerPublisherStarter} injection: each
 *                           publisher lane (BE-5 collector, BE-6 read models)
 *                           receives the frozen-typed {@link
 *                           BrokerPublishSinks} over the gateway's
 *                           publishQuota/publishContextTouch/publishEvent
 *                           pass-throughs (M3).
 *
 * Running the daemon directly still just prints and exits — nothing touches
 * the machine-local ~/.aibender without an explicit compose call (operator
 * config wiring into main() lands with the launchd slice).
 *
 * LIVE-SPAWN GATE: composeKernel/composeBroker default to a runner that
 * REFUSES to spawn (typed LiveSpawnDisabledError). The real SDK spawn path
 * requires `liveSpawn: { enabled: true }` — explicit operator opt-in config;
 * running it against real accounts is T3 owner-gated (docs/runbooks/
 * kernel-live-spawn.md). The PTY analogue lives in createNodePtySpawner's own
 * `liveSpawnOptIn` (the backend refuses to construct without it).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  validateEventsPayload,
  type ContextGraphTouch,
  type EventSummary,
  type LineageRecorder,
  type PipelineServerPayload,
  type QuotaSnapshot,
  type ReadModelSnapshot,
  type SessionIdResolver,
  type SessionState,
  type WorkstreamHookRouting,
  type WorkstreamServerPayload,
} from '@aibender/protocol';
import { openKernelStore, type EventsTableStore, type KernelStore, type ResumeLedgerStore } from '@aibender/schema';
import type { Logger } from '@aibender/shared';

import {
  createWorkstreamSlice,
  type BriefSynthesizer,
  type WorkstreamPublisher,
  type WorkstreamSlice,
} from '../workstreams/index.js';
import {
  createPipelineSlice,
  type CatalogResolver,
  type PipelineApprovalGate,
  type PipelineSlice,
  type StepExecutor,
} from '../pipelines/index.js';
import {
  createSupervisionSlice,
  type FootprintSampler,
  type FootprintThresholds,
  type FrontendWeightPort,
  type HibernatePort,
  type LocalModelPort,
  type PressureProbe,
  type PressureThresholds,
  type SupervisionSlice,
  type WatchdogClass,
} from '../supervision/index.js';

import {
  KernelVerbError,
  startGateway,
  type GatewayHandle,
  type GatewayKernel,
  type PtyFlowControlOptions,
  type TranscriptSource,
} from '../gateway/index.js';
import { startHooksServer, type HooksServer } from '../collector/hooks/index.js';
import {
  aibenderHomePath,
  approvalRelayFromBroker,
  createAccountRegistry,
  createApprovalBroker,
  createProfileRegistry,
  createPtyHost,
  createSdkQueryRunner,
  createSessionKernel,
  KernelError,
  LiveSpawnDisabledError,
  rawOfRunnerMessage,
  toApprovalBrokerGatewayPort,
  toGatewayPtyHostPort,
  type AccountRegistry,
  type ApprovalBroker,
  type FlowControlConfig,
  type KernelApprovalRelay,
  type ProfileRegistry,
  type ProfileRegistryOptions,
  type PtyArgvBuilder,
  type PtyBackend,
  type PtyHost,
  type QueryRunner,
  type RunnerMessageTap,
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
  /**
   * BE-2 canUseTool relay (kernel half of the M2 approvals chain). NOTE:
   * composeBroker OWNS this seam — it builds the relay from the ApprovalBroker
   * it composes and REFUSES a caller-supplied one (both halves must share one
   * broker). Set it only when composing a kernel without a gateway.
   */
  readonly approvalRelay?: KernelApprovalRelay;
  /**
   * ICR-0009 message tap (per-session, in-pump, stream-ordered observer).
   * composeBroker COMPOSES with this rather than replacing it: its transcript
   * tee runs first, then this tap — both observe every message.
   */
  readonly messageTap?: RunnerMessageTap;
  /**
   * [X4] lineage recorder for the kernel spawn paths (ws-protocol.md §15.1,
   * M4 — BE-7 wiring). A factory form receives the freshly opened store so
   * a recorder over the SAME kernel database (migration 0003) can be built
   * before the kernel exists; composeBroker uses it. Absent → no recording
   * (the frozen noop default inside the kernel).
   */
  readonly lineage?: LineageRecorder | ((store: KernelStore) => LineageRecorder);
  /** Kernel logger (tap-throw warnings, native-id drift, …). */
  readonly logger?: Logger;
}

export interface ComposedKernel {
  readonly kernel: SessionKernel;
  readonly store: KernelStore;
  /** The ONE profile registry (shared with the ptyHost by composeBroker). */
  readonly profiles: ProfileRegistry;
  /**
   * The discovered account registry ([X1]/ICR-0013): the machine's actually
   * provisioned Claude accounts, read from `infra/profiles/*.profile.json`.
   * This is the single source of "which accounts exist" — the ptyHost and every
   * account-enumerating publisher key off THIS, never a hardcoded 3/5. Adding a
   * new Max account is dropping in its manifest; no code change reaches here.
   */
  readonly accountRegistry: AccountRegistry;
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
  // [X1]/ICR-0013: discover the machine's Claude accounts ONCE, from the
  // committed profile manifests, and drive the profile registry from it. Every
  // downstream account enumeration reads this registry, so a newly provisioned
  // Max account (MAX_C/MAX_D/…) is visible the moment its manifest lands — no
  // code change. Discovery is built here (unless the caller injected a registry
  // directly) and shared into createProfileRegistry so it is not done twice.
  const accountRegistry =
    options.profiles?.accountRegistry ??
    createAccountRegistry({
      ...(options.profiles?.accountRegistryOptions ?? {}),
      ...(options.profiles?.accountRegistryOptions?.aibenderHome === undefined &&
      options.profiles?.aibenderHome !== undefined
        ? { aibenderHome: options.profiles.aibenderHome }
        : {}),
      ...(options.profiles?.accountRegistryOptions?.env === undefined &&
      options.profiles?.env !== undefined
        ? { env: options.profiles.env }
        : {}),
    });
  const profiles = createProfileRegistry({ ...(options.profiles ?? {}), accountRegistry });
  const runner =
    options.runner ??
    (options.liveSpawn?.enabled === true
      ? createSdkQueryRunner({ liveSpawnOptIn: true })
      : createRefusingQueryRunner());
  // [X4] M4: resolve the lineage recorder (factory form gets the store).
  const lineage =
    typeof options.lineage === 'function' ? options.lineage(store) : options.lineage;
  const kernel = createSessionKernel({
    ledger: store.resumeLedger,
    profiles,
    runner,
    ...(options.baseEnv !== undefined ? { baseEnv: options.baseEnv } : {}),
    ...(options.approvalRelay !== undefined ? { approvals: options.approvalRelay } : {}),
    ...(options.messageTap !== undefined ? { messageTap: options.messageTap } : {}),
    ...(lineage !== undefined ? { lineage } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
  return {
    kernel,
    store,
    profiles,
    accountRegistry,
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
// M3 fan-out publisher seam (BE-5 collector / BE-6 read models → gateway)
// ---------------------------------------------------------------------------

/**
 * The frozen-typed publish surface a publisher lane receives: the gateway's
 * M3-source pass-throughs, re-exposed with the FROZEN payload types
 * (@aibender/protocol) instead of the gateway handle's opaque events record.
 * Invalid payloads THROW (RangeError) — the composition root never forwards a
 * frame that fails the frozen validators (matching the gateway's own
 * publishQuota/publishContextTouch discipline; events are validated HERE
 * because the handle's pass-through still accepts the pre-M3 opaque record).
 */
export interface BrokerPublishSinks {
  publishQuota(snapshot: QuotaSnapshot): void;
  publishContextTouch(touch: ContextGraphTouch): void;
  /** The FROZEN-M3 events union (ws-protocol.md §13): summaries + read models. */
  publishEvent(payload: EventSummary | ReadModelSnapshot): void;
  /**
   * M4 [X4] (BE-7 injection, additive — present only when the workstream
   * slice is composed): the frozen native→harness resolver (ws-protocol.md
   * §15.2). Publisher lanes constructing the graphfeed MUST pass it as
   * `resolveSessionId`, and lanes starting the hooks endpoint as
   * `sessionIdOfNative` — this is the composition seam that flips the
   * frozen §12 relay pin.
   */
  readonly resolveSessionId?: SessionIdResolver;
  /**
   * M4 [X4] (BE-7 injection, additive): the automation routing handlers
   * (hooks-contract.md §7.1). A lane starting the hooks endpoint passes
   * this as its `workstreams` option so SessionEnd/PreCompact/SessionStart
   * reach the brief automation.
   */
  readonly workstreamHooks?: WorkstreamHookRouting;
}

/** Returned by a starter that owns resources (watchers, pollers, timers). */
export interface BrokerPublisherHandle {
  close(): void | Promise<void>;
}

/**
 * One M3 publisher lane, started by composeBroker AFTER the gateway is up and
 * closed FIRST on shutdown (publishers stop before the wire does).
 *
 * SEAM STATUS (BE-ORCH stewarding, post-M3 build): BE-5/BE-6 landed and their
 * surfaces are importable, but both are PULL-shaped, not starters — the
 * collector exports per-source constructors (core/src/collector/: tailers,
 * ingestors, receivers, SSE/db sources, hooks endpoint) and BE-6 exports
 * `createReadModelPublisher` (publishAll/publishQuotaSnapshots over an events
 * store; its ReadModelSink and the graphfeed's ContextGraphSink adapt onto
 * {@link BrokerPublishSinks} structurally). Composing them into the DEFAULT
 * publisher set needs the operator CONFIG surface (store paths, watch roots,
 * ports, poll cadences) that lands with the launchd/config slice — BE-MAIN,
 * M4. Until then this injection seam remains the composition contract,
 * proven against a stub starter in composedBroker.spec.ts.
 */
export type BrokerPublisherStarter = (
  sinks: BrokerPublishSinks,
) => BrokerPublisherHandle | undefined | void;

// ---------------------------------------------------------------------------
// SEC-3 hooks-endpoint token (hooks-contract.md §4.2, ICR-0015): READ, never
// mint. Distinct from the per-boot WS gateway token (gateway/token.ts).
// ---------------------------------------------------------------------------

/**
 * The basename of the STABLE per-install hooks-endpoint token file under
 * `$AIBENDER_HOME` — matches infra's `AIB_HOOK_TOKEN_NAME` (infra/hooks/lib.sh)
 * so the broker READS the exact file SI-3 mints (`--hook-token`, 0600).
 */
export const HOOK_TOKEN_FILE_NAME = 'hook-token' as const;

/**
 * Resolve `$AIBENDER_HOME/hook-token` using the SAME home resolution
 * composeBroker uses for the gateway bootstrap + profiles: an explicit
 * gateway/profiles `aibenderHome`, else the `AIBENDER_HOME` env override, else
 * `~/.aibender` (via {@link aibenderHomePath}). The gateway home wins when both
 * are set — it is where the sibling gateway bootstrap already lands.
 */
function hookTokenFile(options: ComposeBrokerOptions): string {
  const aibenderHome = options.gateway?.aibenderHome ?? options.profiles?.aibenderHome;
  const env = options.gateway?.env ?? options.profiles?.env;
  const home = aibenderHomePath({
    ...(aibenderHome !== undefined ? { aibenderHome } : {}),
    ...(env !== undefined ? { env } : {}),
  });
  return join(home, HOOK_TOKEN_FILE_NAME);
}

/**
 * SEC-3 (hooks-contract.md §4.2, ICR-0015): READ the STABLE per-install hooks
 * token SI-3 minted to `$AIBENDER_HOME/hook-token`. PRESENCE is the opt-in —
 * SI-3 only writes the file under `--hook-token`, so a present, non-empty file
 * means the operator turned the gate on and the broker must enforce it. The
 * value is READ, never minted here: a per-boot value could never match the
 * header SI-3 baked into on-disk settings.json. Trailing whitespace is trimmed
 * (SI-3 writes `printf '%s\n'`); an absent / unreadable / empty / whitespace-only
 * file → `undefined` → the open posture (NEVER an empty-string token, which
 * would 401 every POST). Kept DISTINCT from the per-boot WS gateway token
 * (gateway/token.ts `newBootToken()` — a separate secret in a separate file).
 */
function readHookToken(tokenFile: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(tokenFile, 'utf8');
  } catch {
    return undefined; // absent/unreadable → open posture (presence is the opt-in)
  }
  const token = raw.trim();
  return token.length > 0 ? token : undefined;
}

// ---------------------------------------------------------------------------
// Broker composition — the FULL broker: every gateway port through ONE call
// (M1 control verbs; M2 pty/approvals/transcripts; M3 publisher lanes)
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
    /** Wire-side PTY flow-control tuning (mechanism frozen, values config). */
    readonly flowControl?: Partial<PtyFlowControlOptions>;
    /** Reconnect-replay journal bound (per channel, ws-protocol §8). */
    readonly replayJournal?: { readonly maxEntriesPerChannel?: number };
    readonly logger?: Logger;
    readonly clock?: () => Date;
  };
  /**
   * BE-2 attended-PTY slice. Present → composeBroker creates the ptyHost over
   * the SAME resume ledger + profile registry as the kernel (the two-store
   * drift a caller-built host could introduce is structurally impossible) and
   * adapts it onto the gateway's pty port. The BACKEND is the injection seam:
   * testkit's FakePtyBackend in tests, `createNodePtySpawner({ liveSpawnOptIn:
   * true, … })` for real children (its own explicit opt-in gate). Absent → no
   * pty sessions (the gateway's documented empty-stub degradation).
   */
  readonly pty?: {
    readonly backend: PtyBackend;
    /** Host-side ring tuning (SPIKE-D producer discipline). */
    readonly flowControl?: FlowControlConfig;
    /** Argv strategy override (version-gate pivots; soak scripts). */
    readonly argv?: PtyArgvBuilder;
    readonly forceKillAfterMs?: number;
    readonly defaultCols?: number;
    readonly defaultRows?: number;
    /** Harness/native id factories (tests pin ids for fixture replay). */
    readonly newSessionId?: () => string;
    readonly newSessionUuid?: () => string;
    readonly logger?: Logger;
  };
  /**
   * Approvals tuning. The ApprovalBroker itself is ALWAYS composed here (both
   * halves of the M2 chain must share one broker): kernel side via
   * approvalRelayFromBroker, gateway side via toApprovalBrokerGatewayPort.
   */
  readonly approvals?: {
    /** Default time-to-decision; `null` → no expiry. Default: 10 min. */
    readonly defaultTtlMs?: number | null;
    /** TTL override for canUseTool escalations specifically. */
    readonly canUseToolTtlMs?: number | null;
    readonly clock?: () => number;
    readonly newApprovalId?: () => string;
    readonly logger?: Logger;
  };
  /** M3 publisher lanes (see {@link BrokerPublisherStarter}). */
  readonly publishers?: readonly BrokerPublisherStarter[];
  /**
   * M4 [X4]: the BE-7 workstream slice. Present → composeBroker builds the
   * lineage recorder/ledger/engine/automation/resolver over the SAME kernel
   * store (migration 0003 lives in the kernel database, sqlite-ddl.md §8.1),
   * injects the recorder into the kernel spawn paths and the ptyHost
   * continuation-edge stub, wires the engine into the gateway's frozen merge
   * verb, feeds the context-pressure watch from the ICR-0009 tap, exposes
   * the resolver + hook routing on {@link BrokerPublishSinks}, and pushes
   * the §16.5 boot list snapshot once the gateway is up. Absent → M1–M3
   * behavior exactly (no lineage anywhere).
   */
  readonly workstreams?: {
    /** Brief synthesis ports (fakes in tests; LM Studio drafter at runtime). */
    readonly synthesizer?: BriefSynthesizer;
    /** READ-ONLY transcript reader override (tests inject fixtures). */
    readonly readTranscript?: (path: string) => string | undefined;
    /** Context-pressure tuning (~70% default; the EVENT is the contract). */
    readonly pressure?: {
      readonly thresholdPct?: number;
      readonly rearmBelowPct?: number;
      readonly contextWindowTokens?: number;
    };
    readonly logger?: Logger;
    readonly nowMs?: () => number;
  };
  /**
   * M5 [features 4/5]: the BE-8 pipeline slice. Present → composeBroker builds
   * the pipeline engine + memoization journal over the SAME kernel store
   * (migration 0004 lives in the kernel database, sqlite-ddl.md §10.1), wires
   * step-attempt `workflow` edges onto the workstream lineage store + cost onto
   * the events store, feeds gates through the shared ApprovalBroker (the M2
   * one-inbox precedent), and injects the engine into the gateway's frozen
   * pipeline verbs (ICR-0012). Absent → M1–M4 behavior exactly (the gateway's
   * documented empty-broker `pipeline-not-found` degrade). The `executor` is
   * the injection seam ([X1] per-step account routing): a fake in tests; the
   * real adapter fan-out (kernel QueryRunner / OpenCode / LM Studio) is bound
   * at the operator-config slice (the BrokerPublisherStarter seam-status
   * posture — the executor needs the same adapter+config surface).
   */
  readonly pipelines?: {
    /** THE per-step account-routing seam. Required to run steps. */
    readonly executor: StepExecutor;
    /** Plan-time capability resolver (from a catalog scan). Absent → prompt-only. */
    readonly resolver?: CatalogResolver;
    /** Approval-gate port (defaults to the composed ApprovalBroker — see below). */
    readonly gate?: PipelineApprovalGate;
    /** The collector events store for per-step cost (§18.5). Absent → no cost rows. */
    readonly events?: EventsTableStore;
    /** The run's workspace (`${workspace}` + project-scope resolution). */
    readonly workspace?: string;
    readonly logger?: Logger;
    readonly nowMs?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
  };
  /**
   * M6 [X1] BE-9: the supervision & resource-governor slice (blueprint §11).
   * Present → composeBroker builds the governor over the injected telemetry
   * ports and wires the resource-health publisher onto the gateway's events
   * channel (the eleventh read model, frozen M6). The recycle port is bound to
   * the BE-2 ptyHost (recycle = checkpoint→kill→resume, the [X4] continuation
   * mechanism), so a watchdog-triggered recycle records its `continue` edge on
   * the workstream lineage store exactly like an operator recycle.
   *
   * THE TELEMETRY PORTS ARE THE FAKE-IN-TESTS SEAM: `sampler`/`probe` are the
   * two injected interfaces. Tests pass FAKES (no real process is ever bloated,
   * no `memory_pressure` is ever shelled). At RUNTIME the composition-config
   * slice (SI-3/launchd, a later wire) supplies the real macOS phys_footprint
   * sampler + `createSpawnPressureProbe` with a spawn runner — GUARDED behind
   * this opt-in exactly like the kernel's live-spawn gate. Absent → no
   * supervision (M1–M5 behavior exactly; the resource-health instrument simply
   * has no producer and the FE renders its NO SIGNAL freshness state).
   */
  readonly supervision?: {
    /** phys_footprint sampler — the FAKE-in-tests / guarded-real seam. */
    readonly sampler: FootprintSampler;
    /** pressure-delta probe — the FAKE-in-tests / guarded-real seam. */
    readonly probe: PressureProbe;
    /** BE-4 residency ledger evict/budget port (localModelResidentBytes). */
    readonly localModel?: LocalModelPort;
    readonly frontend?: FrontendWeightPort;
    /** Hibernate port; defaults to the ptyHost recycle-less suspend at runtime. */
    readonly hibernate?: HibernatePort;
    readonly footprintThresholds?: Partial<Record<WatchdogClass, FootprintThresholds>>;
    readonly pressureThresholds?: Partial<PressureThresholds>;
    readonly hysteresisMb?: number;
    readonly idleWindowMs?: number;
    readonly logger?: Logger;
  };
  /**
   * SEC-3 / [X4]: the BE-5 hooks-contract.md ACCEPTING ENDPOINT lane
   * (core/src/collector/hooks). Present → composeBroker starts the loopback
   * HTTP endpoint AFTER the gateway is up, over the collector events store the
   * operator supplies here, and wires: the shared ApprovalBroker
   * (PermissionRequest → hook-floor slot), the frozen native→harness resolver
   * ({@link BrokerPublishSinks.resolveSessionId} → `sessionIdOfNative`), and the
   * [X4] automation routing ({@link BrokerPublishSinks.workstreamHooks} →
   * `workstreams`). The endpoint is registered as a publisher handle so it is
   * closed FIRST on shutdown (publisher-lane ordering — before the gateway).
   * Absent → NO hooks endpoint (default composition unchanged) — this is the
   * operator CONFIG surface the M3 publisher-seam doc comment defers to (the
   * collector events store is the SEPARATE §6.2 database, not the kernel store,
   * so the operator must open + hand it in).
   *
   * SEC-3 TOKEN (hooks-contract.md §4.2, ICR-0015): the endpoint's `authToken`
   * is NOT configured here — composeBroker READS the STABLE per-install secret
   * SI-3 minted to `$AIBENDER_HOME/hook-token` (basename = infra's
   * AIB_HOOK_TOKEN_NAME) and passes it. PRESENCE of that file is the operator
   * opt-in: a present, non-empty file → the gate enforces (token-less POSTs
   * 401); absent / empty / whitespace-only → the open loopback posture
   * (byte-compatible with M2–M6). The broker never MINTS the token (a per-boot
   * value could never match the header SI-3 baked into on-disk settings.json)
   * and keeps it DISTINCT from the per-boot WS gateway token.
   */
  readonly hooks?: {
    /**
     * The collector-owned events store (openEventsStore — the SEPARATE §6.2
     * database, NEVER the kernel store). REQUIRED: every accepted post
     * normalizes into it (source `hooks`).
     */
    readonly events: EventsTableStore;
    /** Listen port. Default: AIBENDER_HOOKS_PORT env, else 4319. Tests pass 0. */
    readonly port?: number;
    /** `observe` (default, T3-safe) or `escalate` (answers a gating 200 in time). */
    readonly floorPosture?: 'observe' | 'escalate';
    /** Escalate-mode decision window, ms. */
    readonly floorTimeoutMs?: number;
    /** SessionStart injection deadline, ms. */
    readonly sessionStartTimeoutMs?: number;
    readonly nowMs?: () => number;
  };
}

export interface ComposedBroker extends ComposedKernel {
  /** The BE-3 WS gateway handle (port, url, per-boot token, bootstrap path). */
  readonly gateway: GatewayHandle;
  /** The ONE approval inbox broker (kernel + gateway halves share it). */
  readonly approvals: ApprovalBroker;
  /**
   * The BE-2 ptyHost (present iff `options.pty` was given). Attended launches
   * are driven HERE (host.launchAttended / launchLoginBootstrap / recycle) —
   * they have no control-channel verb; the wire carries their byte streams.
   * The composed broker OWNS its shutdown (before the store closes).
   */
  readonly ptyHost?: PtyHost;
  /**
   * M4 [X4]: the composed BE-7 slice (present iff `options.workstreams` was
   * given) — recorder, ledger, engine, automation, pressure watch, resolver,
   * guardrails. Operator wiring (reconciler roots, hooks-endpoint start)
   * builds on these; tests drive them directly.
   */
  readonly workstreams?: WorkstreamSlice;
  /**
   * M5 [features 4/5]: the composed BE-8 pipeline slice (present iff
   * `options.pipelines` was given) — the engine (gateway verb handler), the
   * reaper, and `publishCatalogSnapshot`. Operator wiring (catalog scan +
   * FSEvents publish, the real executor) builds on this; tests drive it
   * directly.
   */
  readonly pipelines?: PipelineSlice;
  /**
   * M6 [X1] BE-9: the composed supervision slice (present iff
   * `options.supervision` was given) — the governor + resource-health
   * publisher. The operator drives `supervision.tickAndPublish` on a timer
   * (the launchd/config slice) and calls `governor.register` /
   * `governor.admitSpawnNow` from the spawn paths; tests drive it directly.
   */
  readonly supervision?: SupervisionSlice;
  /**
   * SEC-3 / [X4]: the composed hooks accepting endpoint (present iff
   * `options.hooks` was given) — its `url`/`port` reach the loopback endpoint
   * (tests POST against them; `port-in-use` degrades to `state:'port-in-use'`
   * exactly like the gateway). The broker OWNS its shutdown (closed FIRST,
   * before the gateway). The SEC-3 `authToken` gate is active iff
   * `$AIBENDER_HOME/hook-token` was present + non-empty at boot.
   */
  readonly hooks?: HooksServer;
}

/**
 * Wire the FULL broker: approvals → kernel (+ tee tap) → ptyHost → gateway →
 * publisher lanes, all over one composition (M2 deviation D3 resolved).
 *
 * Shutdown ordering (close()): publisher lanes stop first, then the gateway
 * (stop accepting verbs / close clients), then the ptyHost reaps its
 * children, then the kernel drains (session-death supersession still lands —
 * the approval broker is closed LAST), then the store closes.
 */
export async function composeBroker(options: ComposeBrokerOptions): Promise<ComposedBroker> {
  if (options.approvalRelay !== undefined) {
    throw new Error(
      'composeBroker owns the approval relay (both halves must share its broker); ' +
        'tune it via options.approvals instead of injecting approvalRelay',
    );
  }

  // -- approvals (created before the kernel: the relay rides every spawn) ----
  const approvals = createApprovalBroker({
    ...(options.approvals?.defaultTtlMs !== undefined
      ? { defaultTtlMs: options.approvals.defaultTtlMs }
      : {}),
    ...(options.approvals?.clock !== undefined ? { clock: options.approvals.clock } : {}),
    ...(options.approvals?.newApprovalId !== undefined
      ? { newApprovalId: options.approvals.newApprovalId }
      : {}),
    ...(options.approvals?.logger !== undefined ? { logger: options.approvals.logger } : {}),
  });
  const approvalRelay = approvalRelayFromBroker(approvals, {
    ...(options.approvals?.canUseToolTtlMs !== undefined
      ? { ttlMs: options.approvals.canUseToolTtlMs }
      : {}),
  });

  // -- [X4] workstream slice publisher (M4, BE-7): LATE-BOUND — the slice ----
  // -- must exist before the kernel (the recorder rides every spawn) but the
  // -- gateway boots after it; payloads published before the bind (none in
  // -- practice: nothing spawns during composition) drop silently. -----------
  let workstreamSink: ((payload: WorkstreamServerPayload) => void) | undefined;
  const publishWorkstream: WorkstreamPublisher = (payload) => {
    workstreamSink?.(payload);
  };

  // -- [M5] pipeline slice publisher (BE-8): LATE-BOUND — same posture as the
  // -- workstream sink; payloads published before the gateway is up drop. -----
  let pipelineSink: ((payload: PipelineServerPayload) => void) | undefined;
  const publishPipeline = (payload: PipelineServerPayload): void => {
    pipelineSink?.(payload);
  };

  // -- [M6] supervision slice publisher (BE-9): LATE-BOUND — the governor's
  // -- resource-health snapshot rides the EVENTS channel; before the gateway
  // -- is up (nothing ticks during composition) publishes drop. --------------
  let supervisionSink: ((payload: Readonly<Record<string, unknown>>) => void) | undefined;

  // -- transcript tee (ICR-0009): ONE kernel tap fans raw messages out to ----
  // -- however many TranscriptSource listeners subscribe (the gateway: one);
  // -- the [X4] context-pressure watch consumes the SAME tap (M4). -----------
  const transcriptListeners = new Set<(sessionId: string, message: unknown) => void>();
  const userTap = options.messageTap;
  let workstreamSlice: WorkstreamSlice | undefined;
  const teeTap: RunnerMessageTap = (sessionId, message) => {
    const raw = rawOfRunnerMessage(message);
    if (transcriptListeners.size > 0) {
      for (const listener of transcriptListeners) listener(sessionId, raw);
    }
    // [X4]: pressure watch on the same axis (observe never throws).
    workstreamSlice?.pressure.observe(sessionId, raw);
    userTap?.(sessionId, message); // composed, never replaced
  };
  const transcripts: TranscriptSource = {
    onMessage: (listener) => {
      transcriptListeners.add(listener);
      return () => transcriptListeners.delete(listener);
    },
  };

  // -- kernel over the shared store (+ [X4] recorder over the SAME store) ----
  const composed = await composeKernel({
    ...options,
    approvalRelay,
    messageTap: teeTap,
    ...(options.workstreams !== undefined
      ? {
          lineage: (store: KernelStore): LineageRecorder => {
            workstreamSlice = createWorkstreamSlice({
              store: store.lineage,
              resumeLedger: store.resumeLedger,
              publish: publishWorkstream,
              ...(options.workstreams?.synthesizer !== undefined
                ? { synthesizer: options.workstreams.synthesizer }
                : {}),
              ...(options.workstreams?.readTranscript !== undefined
                ? { readTranscript: options.workstreams.readTranscript }
                : {}),
              ...(options.workstreams?.pressure !== undefined
                ? { pressure: options.workstreams.pressure }
                : {}),
              ...(options.workstreams?.logger !== undefined
                ? { logger: options.workstreams.logger }
                : {}),
              ...(options.workstreams?.nowMs !== undefined
                ? { nowMs: options.workstreams.nowMs }
                : {}),
            });
            return workstreamSlice.recorder;
          },
        }
      : {}),
  });

  // -- ptyHost over the SAME ledger + profiles (optional slice) --------------
  let ptyHost: PtyHost | undefined;
  try {
    if (options.pty !== undefined) {
      ptyHost = createPtyHost({
        ledger: composed.store.resumeLedger,
        profiles: composed.profiles,
        backend: options.pty.backend,
        // [X4] M4: the ptyHost's M2 ContinuationEdgeEmitter stub adapted onto
        // the frozen LineageRecorder port (ws-protocol.md §15.1) — recycle
        // continuations record at action time.
        ...(workstreamSlice !== undefined ? { edges: workstreamSlice.continuationEdges } : {}),
        ...(options.baseEnv !== undefined ? { baseEnv: options.baseEnv } : {}),
        ...(options.pty.flowControl !== undefined
          ? { flowControl: options.pty.flowControl }
          : {}),
        ...(options.pty.argv !== undefined ? { argv: options.pty.argv } : {}),
        ...(options.pty.forceKillAfterMs !== undefined
          ? { forceKillAfterMs: options.pty.forceKillAfterMs }
          : {}),
        ...(options.pty.defaultCols !== undefined ? { defaultCols: options.pty.defaultCols } : {}),
        ...(options.pty.defaultRows !== undefined ? { defaultRows: options.pty.defaultRows } : {}),
        ...(options.pty.newSessionId !== undefined
          ? { newSessionId: options.pty.newSessionId }
          : {}),
        ...(options.pty.newSessionUuid !== undefined
          ? { newSessionUuid: options.pty.newSessionUuid }
          : {}),
        ...(options.pty.logger !== undefined ? { logger: options.pty.logger } : {}),
      });
    }
  } catch (cause) {
    await composed.close();
    approvals.close();
    throw cause;
  }

  // -- [X4] attended-pty launches record their lineage node at announce time --
  // (the ptyHost writes the resume-ledger row before announcing; the recorder
  // reads attribution from that row's twin fields — never guessed [X2]).
  if (ptyHost !== undefined && workstreamSlice !== undefined) {
    const slice = workstreamSlice;
    ptyHost.onSession((session) => {
      const row = composed.store.resumeLedger.get(session.sessionId);
      if (row === undefined) return;
      slice.recorder.record({
        kind: 'launch',
        sessionId: row.id,
        accountLabel: row.accountLabel,
        backend: row.backend,
        cwd: row.cwd,
        ...(row.workstreamHint !== null ? { workstreamHint: row.workstreamHint } : {}),
        atEpochMs: Date.now(),
      });
    });
  }

  // -- [M5] pipeline slice (BE-8): built over the SAME kernel store (migration
  // -- 0004 journal), the workstream lineage store (`workflow` edges), and the
  // -- shared ApprovalBroker (gates ride the M2 one-inbox). The executor is the
  // -- injected [X1] account-routing seam. -----------------------------------
  let pipelineSlice: PipelineSlice | undefined;
  if (options.pipelines !== undefined) {
    const gate: PipelineApprovalGate =
      options.pipelines.gate ?? approvalGateFromBroker(approvals);
    pipelineSlice = createPipelineSlice({
      store: composed.store.pipelines,
      executor: options.pipelines.executor,
      gate,
      // Step-attempt `workflow` edges land on the SAME kernel lineage store
      // (dag-schema.md §6) and fan out through the shared workstream publisher.
      lineage: composed.store.lineage,
      publish: publishPipeline,
      publishWorkstream,
      ...(options.pipelines.resolver !== undefined ? { resolver: options.pipelines.resolver } : {}),
      ...(options.pipelines.events !== undefined ? { events: options.pipelines.events } : {}),
      ...(options.pipelines.workspace !== undefined ? { workspace: options.pipelines.workspace } : {}),
      ...(options.pipelines.logger !== undefined ? { logger: options.pipelines.logger } : {}),
      ...(options.pipelines.nowMs !== undefined ? { nowMs: options.pipelines.nowMs } : {}),
      ...(options.pipelines.sleep !== undefined ? { sleep: options.pipelines.sleep } : {}),
    });
  }

  // -- [M6] supervision slice (BE-9): the governor over the injected telemetry
  // -- ports (fake in tests, guarded-real at runtime). The recycle port is the
  // -- ptyHost's recycle (checkpoint→kill→resume, the [X4] continuation
  // -- mechanism — a watchdog recycle records its `continue` edge on the same
  // -- lineage store as an operator recycle). The resource-health publisher
  // -- rides the events channel (late-bound sink, below). ---------------------
  let supervisionSlice: SupervisionSlice | undefined;
  if (options.supervision !== undefined) {
    const sup = options.supervision;
    supervisionSlice = createSupervisionSlice({
      sampler: sup.sampler,
      probe: sup.probe,
      // The resource-health snapshot rides the EVENTS channel through the
      // late-bound sink (bound after the gateway is up, below).
      sink: { publishEvent: (payload) => supervisionSink?.(payload) },
      // Recycle = the ptyHost path (present iff the pty slice is composed); a
      // watchdog recycle then records the [X4] continue edge downstream.
      ...(ptyHost !== undefined
        ? {
            recycle: {
              recycle: async (sessionId) => {
                await ptyHost.recycle(sessionId);
              },
            },
          }
        : {}),
      ...(sup.localModel !== undefined ? { localModel: sup.localModel } : {}),
      ...(sup.frontend !== undefined ? { frontend: sup.frontend } : {}),
      ...(sup.hibernate !== undefined ? { hibernate: sup.hibernate } : {}),
      ...(sup.footprintThresholds !== undefined
        ? { footprintThresholds: sup.footprintThresholds }
        : {}),
      ...(sup.pressureThresholds !== undefined
        ? { pressureThresholds: sup.pressureThresholds }
        : {}),
      ...(sup.hysteresisMb !== undefined ? { hysteresisMb: sup.hysteresisMb } : {}),
      ...(sup.idleWindowMs !== undefined ? { idleWindowMs: sup.idleWindowMs } : {}),
      ...(sup.logger !== undefined ? { logger: sup.logger } : {}),
    });
  }

  // -- gateway over every port ------------------------------------------------
  const port = adaptSessionKernel(composed.kernel, composed.store.resumeLedger);
  let gateway: GatewayHandle;
  try {
    gateway = await startGateway({
      kernel: port,
      approvals: toApprovalBrokerGatewayPort(approvals),
      transcripts,
      // ICR-0014 ([X1]): advertise the configured Claude-account placeholder
      // labels the account registry discovered from infra/profiles/*.profile.json
      // so the FE cockpit enumerates the accounts ACTUALLY provisioned on this
      // machine (N, never a hardcoded five). Sanitized fail-closed on write [X2];
      // an empty registry omits the field (FE falls back to its seed set).
      claudeAccounts: composed.accountRegistry.labels(),
      // [X4] M4 (ICR-0011): the frozen merge verb goes live when the BE-7
      // engine is composed; absent → the documented empty-broker degrade.
      ...(workstreamSlice !== undefined ? { workstreams: workstreamSlice.engine } : {}),
      // [M5] ICR-0012: the pipeline verbs go live when the BE-8 engine is
      // composed; absent → the documented empty-broker `pipeline-not-found`.
      ...(pipelineSlice !== undefined ? { pipelines: pipelineSlice.engine } : {}),
      ...(ptyHost !== undefined ? { ptyHost: toGatewayPtyHostPort(ptyHost) } : {}),
      ...(options.gateway?.aibenderHome !== undefined
        ? { aibenderHome: options.gateway.aibenderHome }
        : {}),
      ...(options.gateway?.env !== undefined ? { env: options.gateway.env } : {}),
      ...(options.gateway?.writeBootstrap !== undefined
        ? { writeBootstrap: options.gateway.writeBootstrap }
        : {}),
      ...(options.gateway?.flowControl !== undefined
        ? { flowControl: options.gateway.flowControl }
        : {}),
      ...(options.gateway?.replayJournal !== undefined
        ? { replayJournal: options.gateway.replayJournal }
        : {}),
      ...(options.gateway?.logger !== undefined ? { logger: options.gateway.logger } : {}),
      ...(options.gateway?.clock !== undefined ? { clock: options.gateway.clock } : {}),
    });
  } catch (cause) {
    // A gateway that failed to boot must not leak the composed kernel/store.
    await ptyHost?.shutdown();
    await composed.close();
    approvals.close();
    throw cause;
  }

  // -- [X4] bind the late publisher + push the §16.5 boot list snapshot ------
  if (workstreamSlice !== undefined) {
    workstreamSink = (payload) => gateway.publishWorkstream(payload);
    try {
      workstreamSlice.ledger.publishListSnapshot();
    } catch (cause) {
      options.workstreams?.logger?.warn('boot workstream snapshot failed (non-fatal)', {
        detail: (cause as Error).message,
      });
    }
  }

  // -- [M5] bind the late pipeline publisher (run/step status + catalog) -----
  if (pipelineSlice !== undefined) {
    pipelineSink = (payload) => gateway.publishPipeline(payload);
  }

  // -- [M6] bind the late supervision publisher (resource-health snapshots) --
  // (the governor validates every snapshot before publish; the gateway's
  // publishEvent re-validates — a malformed frame can never reach the wire.)
  if (supervisionSlice !== undefined) {
    supervisionSink = (payload) => gateway.publishEvent(payload);
  }

  // -- M3 publisher lanes over the frozen-typed sinks -------------------------
  const sinks: BrokerPublishSinks = {
    publishQuota: (snapshot) => gateway.publishQuota(snapshot),
    publishContextTouch: (touch) => gateway.publishContextTouch(touch),
    publishEvent: (payload) => {
      const checked = validateEventsPayload(payload);
      if (!checked.ok) {
        throw new RangeError(`refusing to publish an invalid events payload: ${checked.message}`);
      }
      // The handle's pass-through still takes the pre-M3 opaque record shape;
      // the union was validated above, so the widening is sound.
      gateway.publishEvent(payload as unknown as Readonly<Record<string, unknown>>);
    },
    // [X4] M4 injection (BE-7): the frozen resolver + automation routing —
    // publisher lanes wiring the graphfeed / hooks endpoint consume these.
    ...(workstreamSlice !== undefined
      ? {
          resolveSessionId: workstreamSlice.resolveSessionId,
          workstreamHooks: workstreamSlice.automation,
        }
      : {}),
  };
  const publisherHandles: BrokerPublisherHandle[] = [];
  const closePublishers = async (): Promise<void> => {
    for (const handle of publisherHandles.splice(0).reverse()) {
      await handle.close();
    }
  };
  let hooksServer: HooksServer | undefined;
  try {
    for (const start of options.publishers ?? []) {
      const handle = start(sinks);
      if (handle !== undefined) publisherHandles.push(handle);
    }
    // -- SEC-3 / [X4] hooks accepting endpoint lane (operator-config gated) ---
    // Composed only when options.hooks supplies the collector events store, so
    // the default composition + the M2/M3 test surface stay byte-identical. It
    // READS the STABLE per-install token from $AIBENDER_HOME/hook-token (SI-3
    // mints it; PRESENCE is the opt-in) and enforces it as authToken — an
    // absent/empty file keeps the open loopback posture. It rides the SAME
    // sinks the publisher lanes do (the frozen resolver + [X4] automation
    // routing) and registers as a publisher handle so it closes FIRST on
    // shutdown (before the gateway).
    if (options.hooks !== undefined) {
      const authToken = readHookToken(hookTokenFile(options));
      const started = await startHooksServer({
        events: options.hooks.events,
        approvals,
        ...(sinks.resolveSessionId !== undefined
          ? { sessionIdOfNative: sinks.resolveSessionId }
          : {}),
        ...(sinks.workstreamHooks !== undefined ? { workstreams: sinks.workstreamHooks } : {}),
        ...(authToken !== undefined ? { authToken } : {}),
        ...(options.hooks.port !== undefined ? { port: options.hooks.port } : {}),
        ...(options.hooks.floorPosture !== undefined
          ? { floorPosture: options.hooks.floorPosture }
          : {}),
        ...(options.hooks.floorTimeoutMs !== undefined
          ? { floorTimeoutMs: options.hooks.floorTimeoutMs }
          : {}),
        ...(options.hooks.sessionStartTimeoutMs !== undefined
          ? { sessionStartTimeoutMs: options.hooks.sessionStartTimeoutMs }
          : {}),
        ...(options.hooks.nowMs !== undefined ? { nowMs: options.hooks.nowMs } : {}),
      });
      hooksServer = started;
      publisherHandles.push({ close: () => started.close() });
    }
  } catch (cause) {
    // A publisher lane / the hooks endpoint that failed to start must not leak
    // the broker.
    await closePublishers();
    await gateway.close();
    await ptyHost?.shutdown();
    await composed.close();
    approvals.close();
    throw cause;
  }

  return {
    kernel: composed.kernel,
    store: composed.store,
    profiles: composed.profiles,
    accountRegistry: composed.accountRegistry,
    gateway,
    approvals,
    ...(ptyHost !== undefined ? { ptyHost } : {}),
    ...(workstreamSlice !== undefined ? { workstreams: workstreamSlice } : {}),
    ...(pipelineSlice !== undefined ? { pipelines: pipelineSlice } : {}),
    ...(supervisionSlice !== undefined ? { supervision: supervisionSlice } : {}),
    ...(hooksServer !== undefined ? { hooks: hooksServer } : {}),
    close: async () => {
      await closePublishers();
      // [X4]: drain in-flight brief automation before the wire goes down
      // (fire-and-forget work settles; late publishes still fan out).
      await workstreamSlice?.automation.settle();
      // [M5]: cancel any in-flight runs + reap their process groups before the
      // wire goes down (no orphan children survive a broker shutdown).
      pipelineSlice?.reaper.reapAll();
      await gateway.close();
      workstreamSink = undefined; // the wire is gone; late publishes drop
      pipelineSink = undefined;
      supervisionSink = undefined; // [M6]: the governor's late publishes drop
      await ptyHost?.shutdown();
      await composed.close();
      approvals.close();
    },
  };
}

// ---------------------------------------------------------------------------
// [M5] approval-gate adapter: the ApprovalBroker → PipelineApprovalGate
// ---------------------------------------------------------------------------

/**
 * Adapt the composed ApprovalBroker onto the pipeline runner's gate port. A
 * pipeline `approval` step rides the M2 approvals channel as a
 * `workflow-gate`-source request (§18.3 / §10.1: runId/stepId REQUIRED,
 * toolName/toolUseId forbidden — the broker's per-source matrix enforces it).
 * The one-inbox precedent: no new gate wire.
 */
function approvalGateFromBroker(broker: ApprovalBroker): PipelineApprovalGate {
  return {
    request: (input) => {
      const handle = broker.request({
        source: 'workflow-gate',
        summary: input.summary,
        accountLabel: input.accountLabel,
        runId: input.runId,
        stepId: input.stepId,
        ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
      });
      return {
        resolution: handle.resolution.then((r) => ({ outcome: r.outcome })),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Direct-execution entry point
// ---------------------------------------------------------------------------

/**
 * Entry point. Writes one line naming the daemon and returns the process
 * exit code (0). Output goes through `out` so tests can capture it. The FULL
 * broker (kernel + approvals + pty + transcripts + M3 publisher lanes over
 * the WS gateway) is composed via composeBroker(); wiring operator CONFIG
 * into this entry point (so direct execution actually boots a broker against
 * ~/.aibender under launchd, SI-3) is a later slice — until then, direct
 * execution deliberately performs no implicit machine-local writes.
 */
export function main(out: (line: string) => void = console.log): number {
  out(
    `${DAEMON_NAME}: full broker available via composeBroker() (kernel + approvals + pty + ` +
      'transcripts + publisher lanes over the WS gateway); direct execution wires operator ' +
      'config with the launchd slice — exiting 0.',
  );
  return 0;
}

// Executed directly (`pnpm --filter aibender-core start`)? The `boot` subcommand
// runs the live daemon (the operator/launchd path — boot.ts); anything else keeps
// the side-effect-free stub (no implicit machine-local writes).
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  if (process.argv[2] === 'boot') {
    // Dynamic import so index.ts carries no static dependency on the boot slice
    // (boot.ts imports composeBroker from here — one direction only).
    void (async (): Promise<void> => {
      const { resolveBootConfig, runDaemon } = await import('./boot.js');
      await runDaemon(resolveBootConfig());
    })();
  } else {
    process.exitCode = main();
  }
}
