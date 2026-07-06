/**
 * aibender-core — the LIVE-BOOT slice (the "later slice" main()'s doc deferred).
 *
 * {@link composeBroker} (index.ts) wires the full broker but performs no
 * machine-local I/O by itself; running the daemon directly still just printed a
 * stub. This module is the operator-CONFIG boot: it opens the REAL on-disk
 * stores under `$AIBENDER_HOME/db`, discovers the REAL account registry from
 * `$AIBENDER_HOME`, composes the broker, writes the discovery bootstrap, starts
 * the BE-6 read-model publisher on a timer, and runs as a long-lived daemon with
 * clean SIGINT/SIGTERM shutdown. The `boot` subcommand in index.ts's
 * direct-execution guard is the entry (`… index.ts boot`, what the SI-3 launchd
 * plist invokes).
 *
 * SAFE BY CONSTRUCTION — nothing spends quota or spawns a real child unless the
 * operator explicitly opts in:
 *   - the Claude SDK spawn path is gated by `liveSpawn` (default OFF → the
 *     composed runner refuses every spawn with a typed error; the gateway still
 *     serves, the cockpit still connects, read-models still tick honestly-empty);
 *   - the node-pty backend is gated by `livePty` (default OFF → no attended PTY);
 *   - every port is injectable via {@link BootDeps} so tests drive the WHOLE
 *     boot with fakes (FakeQueryRunner / FakePtyBackend / `:memory:` stores /
 *     a controllable publisher interval) — no live system is ever touched.
 *
 * SCOPE. Composes: kernel + approvals + gated PTY + gateway(bootstrap) +
 * [X4] workstream lineage + the hooks accepting endpoint (presence of
 * `$AIBENDER_HOME/hook-token` is the SEC-3 opt-in) + the read-model publisher
 * lane on a cadence timer + (v2) the BE-5 COLLECTOR FLEET that feeds the events
 * store the publisher reads (JSONL watchers / statusline quota tee / loopback
 * OTLP receiver — see collectors.ts; `AIBENDER_COLLECTORS=0` disables it). Until
 * a source has input the leads it feeds render honest NO-SIGNAL, never fabricated.
 * STILL DEFERRED (each needs a live external system, not just a wire): the
 * supervision governor (real macOS phys_footprint sampler + pressure probe →
 * resource-health stays NO SIGNAL), the pipeline executor fan-out (→ the
 * gateway's documented `pipeline-not-found` degrade), and the collector sources
 * that require a running external process (OpenCode SSE, LM Studio, AWS pollers).
 * These are additive when their adapters land; the boot surface exposes injection
 * points for them.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EventSummary, ReadModelSnapshot } from '@aibender/protocol';
import { openEventsStore, type EventsStore } from '@aibender/schema';
import { createLogger, type Logger } from '@aibender/shared';

import {
  aibenderHomePath,
  createNodePtySpawner,
  type AccountRegistry,
  type PtyBackend,
  type QueryRunner,
} from '../kernel/index.js';
import { createFreshnessTracker, createReadModelPublisher } from '../readmodels/index.js';

import {
  resolveCollectorConfig,
  startCollectorFleet,
  type CollectorFleet,
  type CollectorFleetConfig,
  type CollectorFleetDeps,
} from './collectors.js';
import {
  DAEMON_NAME,
  composeBroker,
  type BrokerPublisherHandle,
  type BrokerPublisherStarter,
  type ComposedBroker,
} from './index.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface BootConfig {
  /** Machine-local home ($AIBENDER_HOME, else ~/.aibender). Bootstrap + db + hook-token live under it. */
  readonly aibenderHome: string;
  /**
   * The `infra/profiles/*.profile.json` manifest dir the account registry
   * discovers Claude accounts from. MUST be resolved CWD-independently — the
   * daemon runs from wherever launchd / `pnpm -F` sets CWD, not the repo root,
   * and the registry yields an EMPTY set (→ no accounts) if it can't find this.
   * Default: repo-anchored (relative to this module); `AIBENDER_PROFILES_DIR` overrides.
   */
  readonly profilesDir: string;
  /** Opt in to the REAL Claude SDK spawn path. Default false → composed runner refuses spawns. */
  readonly liveSpawn: boolean;
  /** Opt in to the REAL node-pty attended-PTY backend. Default false → no PTY sessions. */
  readonly livePty: boolean;
  /** Read-model publish cadence (ms). Default 5000. The OS-2 publish-cadence timer. */
  readonly publishIntervalMs: number;
  /** Start the hooks accepting endpoint. Default true (SEC-3 token PRESENCE is the real gate). */
  readonly hooks: boolean;
  /** Hooks listen port (default: the endpoint's own AIBENDER_HOOKS_PORT / 4319). */
  readonly hooksPort?: number;
  /** Write the discovery bootstrap file. Default true (a daemon must advertise itself). */
  readonly writeBootstrap: boolean;
  /** The v2 collector fleet (BE-5 sources → events store). `AIBENDER_COLLECTORS=0` disables it. */
  readonly collectors: CollectorFleetConfig;
}

const DEFAULT_PUBLISH_INTERVAL_MS = 5_000;

/**
 * Repo-anchored `infra/profiles/` — resolved from THIS module's location, not
 * the process CWD (the daemon runs from `core/` under `pnpm -F`, or an
 * arbitrary dir under launchd). `core/src/main/boot.ts` → three levels up is the
 * repo root. `AIBENDER_PROFILES_DIR` overrides for installs where the manifests
 * live elsewhere.
 */
const REPO_PROFILES_DIR = fileURLToPath(new URL('../../../infra/profiles', import.meta.url));

/** Resolve boot config from the environment (the launchd plist / shell exports it). */
export function resolveBootConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): BootConfig {
  const truthy = (v: string | undefined): boolean =>
    v === '1' || v === 'true' || v === 'TRUE' || v === 'yes';
  const parsedInterval = Number.parseInt(env['AIBENDER_PUBLISH_INTERVAL_MS'] ?? '', 10);
  const parsedPort = Number.parseInt(env['AIBENDER_HOOKS_PORT'] ?? '', 10);
  const profilesOverride = env['AIBENDER_PROFILES_DIR'];
  const aibenderHome = aibenderHomePath({ env });
  return {
    aibenderHome,
    profilesDir:
      typeof profilesOverride === 'string' && profilesOverride.length > 0
        ? profilesOverride
        : REPO_PROFILES_DIR,
    liveSpawn: truthy(env['AIBENDER_LIVE_SPAWN']),
    livePty: truthy(env['AIBENDER_LIVE_PTY']),
    publishIntervalMs:
      Number.isSafeInteger(parsedInterval) && parsedInterval > 0
        ? parsedInterval
        : DEFAULT_PUBLISH_INTERVAL_MS,
    // Default ON; the endpoint no-ops the token gate unless $AIBENDER_HOME/hook-token exists.
    hooks: env['AIBENDER_HOOKS'] !== '0',
    ...(Number.isSafeInteger(parsedPort) ? { hooksPort: parsedPort } : {}),
    writeBootstrap: true,
    collectors: resolveCollectorConfig(env, aibenderHome),
  };
}

// ---------------------------------------------------------------------------
// Dependency-injection seam (tests pass fakes; production leaves them undefined)
// ---------------------------------------------------------------------------

/** A cleared-on-shutdown periodic timer. Injectable so tests avoid real timers. */
export interface BootIntervalHandle {
  close(): void;
}

export interface BootDeps {
  /** Inject a runner (tests: FakeQueryRunner). Wins over `liveSpawn`. */
  readonly runner?: QueryRunner;
  /** Inject a PTY backend (tests: FakePtyBackend). Wins over `livePty`. */
  readonly ptyBackend?: PtyBackend;
  /** Inject the account registry (tests). Else discovered from `aibenderHome`. */
  readonly accountRegistry?: AccountRegistry;
  /** Kernel store path override (tests: `:memory:`). Else `$AIBENDER_HOME/db/kernel.db`. */
  readonly kernelStorePath?: string;
  /** Events store path override (tests: `:memory:`). Else `$AIBENDER_HOME/db/events.db`. */
  readonly eventsStorePath?: string;
  readonly logger?: Logger;
  /** Publisher + collector clock (tests). */
  readonly clock?: () => number;
  /** Publisher periodic-timer factory (tests capture the tick / avoid real timers). */
  readonly setPublisherInterval?: (tick: () => void, ms: number) => BootIntervalHandle;
  /** Collector-fleet periodic-timer factory (tests capture the tick / avoid real timers). */
  readonly setCollectorInterval?: (tick: () => void, ms: number) => BootIntervalHandle;
  /** OTLP receiver starter (tests inject a fake to avoid binding :4318). */
  readonly startOtlpReceiver?: CollectorFleetDeps['startOtlpReceiver'];
}

// ---------------------------------------------------------------------------
// bootBroker — compose the real daemon (or a fully-faked one under tests)
// ---------------------------------------------------------------------------

export interface BootHandle {
  readonly broker: ComposedBroker;
  /** The collector-owned events store this boot opened (the publisher/hooks read it). */
  readonly eventsStore: EventsStore;
  /** The v2 collector fleet, when enabled (`config.collectors.enabled`); else undefined. */
  readonly collectors?: CollectorFleet;
  /** Idempotent: stop the collectors + publisher timer, close the broker, then the events store. */
  stop(): Promise<void>;
}

const defaultInterval = (tick: () => void, ms: number): BootIntervalHandle => {
  const timer = setInterval(tick, ms);
  timer.unref?.();
  return { close: () => clearInterval(timer) };
};

export async function bootBroker(config: BootConfig, deps: BootDeps = {}): Promise<BootHandle> {
  const logger =
    deps.logger ??
    createLogger({ sink: (record) => process.stderr.write(`${JSON.stringify(record)}\n`) });

  const kernelStorePath = deps.kernelStorePath ?? join(config.aibenderHome, 'db', 'kernel.db');
  const eventsStorePath = deps.eventsStorePath ?? join(config.aibenderHome, 'db', 'events.db');
  // File-backed stores need their directory (0700 — machine-local, owner-only).
  for (const p of [kernelStorePath, eventsStorePath]) {
    if (p !== ':memory:') await mkdir(dirname(p), { recursive: true, mode: 0o700 });
  }

  const eventsStore = await openEventsStore({ path: eventsStorePath });

  // The BE-6 read-model publisher lane, ticked on a cadence timer (OS-2). It
  // reads the events store and publishes the ten §6.3 leads + quota snapshots
  // through the frozen sinks — honest-empty (NO SIGNAL) until collectors feed
  // the store, never fabricated. Registered as a BrokerPublisherStarter so
  // composeBroker closes it FIRST on shutdown (stops the timer before the wire).
  const setPublisherInterval = deps.setPublisherInterval ?? defaultInterval;
  const publisherLane: BrokerPublisherStarter = (sinks): BrokerPublisherHandle => {
    const publisher = createReadModelPublisher({
      stores: eventsStore,
      sink: {
        publishEvent: (payload) =>
          sinks.publishEvent(payload as unknown as EventSummary | ReadModelSnapshot),
        publishQuota: (snapshot) => sinks.publishQuota(snapshot),
      },
      // The tracker takes nowMs per-call; the publisher's own `clock` drives it.
      freshness: createFreshnessTracker(),
      ...(deps.clock ? { clock: deps.clock } : {}),
    });
    const tick = (): void => {
      publisher.publishQuotaSnapshots();
      publisher.publishAll();
    };
    const handle = setPublisherInterval(tick, config.publishIntervalMs);
    tick(); // initial publish so a freshly-connected cockpit paints immediately
    return { close: () => handle.close() };
  };

  // Gated real ports: an injected fake wins; else the real adapter only when the
  // operator opted in (else the port is omitted / the composed runner refuses).
  const ptyBackend =
    deps.ptyBackend ?? (config.livePty ? createNodePtySpawner({ liveSpawnOptIn: true }) : undefined);

  const broker = await composeBroker({
    storePath: kernelStorePath,
    profiles: {
      aibenderHome: config.aibenderHome,
      // Injected registry wins (tests); else discover from the resolved profiles
      // dir (the account registry is EMPTY without an explicit dir — its default
      // is undefined unless AIBENDER_PROFILES_DIR is set).
      ...(deps.accountRegistry !== undefined
        ? { accountRegistry: deps.accountRegistry }
        : { accountRegistryOptions: { profilesDir: config.profilesDir } }),
    },
    // Injected runner wins (tests); else the SDK spawn path gated by liveSpawn.
    ...(deps.runner !== undefined
      ? { runner: deps.runner }
      : { liveSpawn: { enabled: config.liveSpawn } }),
    baseEnv: process.env,
    logger,
    gateway: {
      aibenderHome: config.aibenderHome,
      writeBootstrap: config.writeBootstrap,
      logger,
    },
    ...(ptyBackend !== undefined ? { pty: { backend: ptyBackend, logger } } : {}),
    approvals: { logger },
    workstreams: { logger },
    ...(config.hooks
      ? {
          hooks: {
            events: eventsStore.events,
            ...(config.hooksPort !== undefined ? { port: config.hooksPort } : {}),
          },
        }
      : {}),
    publishers: [publisherLane],
  });

  // v2 collector fleet: the BE-5 sources that FEED the events store the publisher
  // reads. Started AFTER compose so it watches the SAME registry the broker
  // discovered (broker.accountRegistry). Reads machine-local files / loopback
  // only — never spends quota. Disabled by `AIBENDER_COLLECTORS=0`.
  let collectors: CollectorFleet | undefined;
  if (config.collectors.enabled) {
    collectors = await startCollectorFleet(config.collectors, {
      eventsStore,
      accountRegistry: broker.accountRegistry,
      logger,
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.setCollectorInterval ? { setInterval: deps.setCollectorInterval } : {}),
      ...(deps.startOtlpReceiver ? { startOtlpReceiver: deps.startOtlpReceiver } : {}),
    });
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    // Stop the collectors FIRST (halt writes into the store), then close the
    // broker — composeBroker.close() stops publisher lanes (clears our timer) →
    // gateway → ptyHost → kernel → store; then we close the events store we own.
    await collectors?.stop().catch(() => undefined);
    await broker.close().catch(() => undefined);
    eventsStore.close();
  };

  return { broker, eventsStore, ...(collectors !== undefined ? { collectors } : {}), stop };
}

// ---------------------------------------------------------------------------
// runDaemon — the long-lived process
// ---------------------------------------------------------------------------

/**
 * Boot the broker and run forever until SIGINT/SIGTERM, then shut down cleanly.
 * Injectable I/O + a non-installing `signals` seam keep it testable.
 */
export async function runDaemon(
  config: BootConfig,
  out: (line: string) => void = console.log,
  signals: (on: (signal: string) => void) => void = (on) => {
    process.on('SIGINT', () => on('SIGINT'));
    process.on('SIGTERM', () => on('SIGTERM'));
  },
): Promise<BootHandle> {
  const handle = await bootBroker(config);
  const g = handle.broker.gateway;
  const c = handle.collectors?.stats();
  const collectorsLine =
    c !== undefined
      ? `collectors=on (${String(c.watchers)} jsonl watchers, quota tee, otlp ${c.otlp ?? 'off'})`
      : 'collectors=off';
  out(
    `${DAEMON_NAME}: broker up — gateway ${g.url}, bootstrap ${g.bootstrapPath}; ` +
      `read-models every ${String(config.publishIntervalMs)}ms; liveSpawn=${String(config.liveSpawn)} ` +
      `livePty=${String(config.livePty)} hooks=${String(config.hooks)}; ${collectorsLine}. Signal to stop.`,
  );
  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    out(`${DAEMON_NAME}: ${signal} — shutting down…`);
    void handle.stop().then(() => {
      out(`${DAEMON_NAME}: stopped.`);
      process.exit(0);
    });
  };
  signals(shutdown);
  // Park (the gateway's listening socket keeps the loop alive; this keeper is
  // unref'd so it never itself holds the process open).
  setInterval(() => {}, 1 << 30).unref();
  return handle;
}
