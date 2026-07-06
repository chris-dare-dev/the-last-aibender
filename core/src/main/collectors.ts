/**
 * aibender-core — the v2 COLLECTOR FLEET (the "later slice" boot.ts v1 deferred).
 *
 * boot.ts v1 composes the broker + gateway + read-model publisher lane, but wires
 * NO source into the events store — so the §6.3 dashboards render honest NO-SIGNAL
 * (never fabricated). This module is the additive wire the v1 doc promised: it
 * starts the BE-5 collector sources that FEED `$AIBENDER_HOME/db/events.db`, which
 * the already-ticking read-model publisher then projects to the cockpit.
 *
 * SOURCES WIRED (v2):
 *   - jsonl/  per-account JSONL config-dir watcher — the token-truth source of
 *     record. One watcher per discovered claude_code account, tailing that
 *     account's OWN config dir (projects/**, history.jsonl, usage-data/**). THE
 *     LABEL COMES FROM THE WATCH ROOT [X2] — nothing in a file can re-attribute.
 *     Populates the token / burn-rate / cache-hit / api-equivalent leads.
 *   - quota/  statusline tee-file ingestor — reads `$AIBENDER_HOME/quota/<LABEL>.json`
 *     (SI-3's aibender-statusline.sh tees the CLI statusline JSON there). Populates
 *     the quota gauges. Empty dir → NO-SIGNAL until the SI-3 statusline hook is
 *     installed and each account's Claude Code has emitted a statusline.
 *   - otlp/   in-process OTLP receiver on 127.0.0.1:4318 (loopback-only) — the
 *     attribution/latency source. Idle unless Claude Code's OTel export is enabled
 *     and pointed here. `port-in-use` degrades to a logged warning, never a throw.
 *
 * The JSONL↔OTel join (ingest.ts) is the single cross-source seam: JSONL wins for
 * tokens, OTel wins for attribution, matched on request id. Both watcher and
 * receiver offer api_request halves to ONE shared joiner; the fleet tick flushes
 * stale (twin-less) halves so JSONL-only rows still land within the join window.
 *
 * DEFERRED (need a live external system, not just a wire): OpenCode SSE + db
 * scrape (needs `opencode serve`), LM Studio inline capture (needs LM Studio),
 * AWS Cost Explorer / CloudWatch pollers (SI-4-gated; estimate-only until), and
 * the graphfeed context-graph sink (BE-6; a separate publisher wire).
 *
 * SAFE BY CONSTRUCTION — every source READS machine-local files/loopback only;
 * none spends quota or spawns a child. Deterministic pump: the fleet exposes a
 * single async `tick()` (scan every watcher → poll the tee → flush the joiner) so
 * tests drive it without real timers, and production runs it on an unref'd
 * interval. Missing inputs (no projects/ dir, no quota/ dir, OTel not exporting)
 * are honest zeroes, never errors.
 */

import { join } from 'node:path';

import { backendForLabel, isAccountLabel } from '@aibender/protocol';
import type { EventsStore } from '@aibender/schema';
import type { Logger } from '@aibender/shared';

import {
  createAccountConfigWatcher,
  createApiRequestJoiner,
  createQuotaTeeIngestor,
  startOtlpReceiver,
  type AccountConfigWatcher,
  type ApiRequestJoiner,
  type OtlpReceiver,
  type QuotaTeeIngestor,
} from '../collector/index.js';
import type { AccountRegistry } from '../kernel/index.js';

import type { BootIntervalHandle } from './boot.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CollectorFleetConfig {
  /** Master switch. Default true; `AIBENDER_COLLECTORS=0` disables the whole fleet. */
  readonly enabled: boolean;
  /** Per-account JSONL config-dir watchers. Default true. */
  readonly jsonl: boolean;
  /** Statusline quota tee-file ingestor. Default true. */
  readonly quota: boolean;
  /** In-process OTLP receiver (loopback). Default true. */
  readonly otlp: boolean;
  /** Scan/poll cadence (ms). Default 2000. `AIBENDER_COLLECTOR_POLL_MS`. */
  readonly pollMs: number;
  /**
   * JSONL↔OTel join window (ms): an api_request half waits this long for its
   * twin before the fleet tick flushes it as a single-source row. Default 15000
   * — long enough for an OTel twin from the same request, short enough that
   * JSONL-only rows (OTLP off — the common local case) appear promptly.
   * `AIBENDER_COLLECTOR_JOIN_WINDOW_MS`.
   */
  readonly joinWindowMs: number;
  /**
   * Force a full whole-subtree watcher reconcile at least this often (ms), so an
   * in-place append that did not bump a dir mtime is still rediscovered. Default
   * 30000. Between full passes the watcher does the cheap mtime-scoped walk (OS-3).
   */
  readonly fullReconcileMs: number;
  /** OTLP receiver port. Default 4318. `AIBENDER_OTLP_PORT`. */
  readonly otlpPort: number;
  /** `$AIBENDER_HOME/quota` — where SI-3's statusline hook tees per-account JSON. */
  readonly quotaDir: string;
}

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_JOIN_WINDOW_MS = 15_000;
const DEFAULT_FULL_RECONCILE_MS = 30_000;
const DEFAULT_OTLP_PORT = 4318;

const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};

/**
 * Resolve fleet config from the environment. `aibenderHome` fixes the quota tee
 * dir (machine-local, resolved by boot before this is called).
 */
export function resolveCollectorConfig(
  env: Readonly<Record<string, string | undefined>>,
  aibenderHome: string,
): CollectorFleetConfig {
  const on = (name: string): boolean => env[name] !== '0';
  return {
    enabled: on('AIBENDER_COLLECTORS'),
    jsonl: on('AIBENDER_COLLECTOR_JSONL'),
    quota: on('AIBENDER_COLLECTOR_QUOTA'),
    otlp: on('AIBENDER_COLLECTOR_OTLP'),
    pollMs: parsePositiveInt(env['AIBENDER_COLLECTOR_POLL_MS'], DEFAULT_POLL_MS),
    joinWindowMs: parsePositiveInt(env['AIBENDER_COLLECTOR_JOIN_WINDOW_MS'], DEFAULT_JOIN_WINDOW_MS),
    fullReconcileMs: parsePositiveInt(env['AIBENDER_COLLECTOR_FULL_RECONCILE_MS'], DEFAULT_FULL_RECONCILE_MS),
    otlpPort: parsePositiveInt(env['AIBENDER_OTLP_PORT'], DEFAULT_OTLP_PORT),
    quotaDir: join(aibenderHome, 'quota'),
  };
}

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------

export interface CollectorFleetStats {
  /** Discovered claude_code accounts a JSONL watcher was started for. */
  readonly watchers: number;
  /** OTLP receiver state (undefined when the receiver is disabled). */
  readonly otlp?: OtlpReceiver['state'];
  /** OTLP bound port (0 when disabled / not listening). */
  readonly otlpPort: number;
  /** Rows the last completed tick inserted across all sources. */
  readonly lastTickRows: number;
  /** Total ticks run (initial + timer). */
  readonly ticks: number;
}

export interface CollectorFleet {
  /**
   * One deterministic pass: scan every JSONL watcher, poll the tee, then flush
   * stale join halves. Returns rows inserted this pass. Tests await it directly;
   * production runs it on the interval. Never throws — a failing source is logged
   * and the others still run.
   */
  tick(): Promise<number>;
  stats(): CollectorFleetStats;
  /** Idempotent: stop the timer, drain the joiner, close the OTLP receiver. Never closes the store (boot owns it). */
  stop(): Promise<void>;
}

export interface CollectorFleetDeps {
  /** The events store boot opened; every source writes here, the publisher reads it. */
  readonly eventsStore: EventsStore;
  /** The registry the broker discovered — the fleet watches each claude_code account's config dir. */
  readonly accountRegistry: AccountRegistry;
  readonly logger: Logger;
  /** Injectable clock (tests); drives the joiner window + full-reconcile cadence. Default Date.now. */
  readonly clock?: () => number;
  /** Periodic-timer factory (tests capture the tick / avoid real timers). Default an unref'd setInterval. */
  readonly setInterval?: (tick: () => void, ms: number) => BootIntervalHandle;
  /** OTLP receiver starter (tests inject a fake to avoid binding a port). Default the real loopback receiver. */
  readonly startOtlpReceiver?: typeof startOtlpReceiver;
}

const defaultFleetInterval = (tick: () => void, ms: number): BootIntervalHandle => {
  const timer = setInterval(tick, ms);
  timer.unref?.();
  return { close: () => clearInterval(timer) };
};

/**
 * Start the collector fleet: build one shared JSONL↔OTel joiner, a JSONL watcher
 * per discovered claude_code account, the quota tee ingestor, and (best-effort)
 * the loopback OTLP receiver — then run an initial tick and arm the interval pump.
 */
export async function startCollectorFleet(
  config: CollectorFleetConfig,
  deps: CollectorFleetDeps,
): Promise<CollectorFleet> {
  const { eventsStore, accountRegistry, logger } = deps;
  const clock = deps.clock ?? Date.now;
  const armInterval = deps.setInterval ?? defaultFleetInterval;
  const otlpStarter = deps.startOtlpReceiver ?? startOtlpReceiver;

  // One shared joiner over the events table. No internal flush timer — the fleet
  // tick drives flush() so the pump stays a single deterministic pass.
  const joiner: ApiRequestJoiner = createApiRequestJoiner(eventsStore.events, {
    windowMs: config.joinWindowMs,
    nowMs: clock,
  });

  // One watcher per discovered claude_code account, rooted at that account's OWN
  // config dir. Non-claude backends (opencode/lmstudio) have no JSONL config dir.
  const watchers: AccountConfigWatcher[] = [];
  if (config.jsonl) {
    for (const account of accountRegistry.all()) {
      if (!isAccountLabel(account.label) || backendForLabel(account.label) !== 'claude_code') continue;
      watchers.push(
        createAccountConfigWatcher({
          account: account.label,
          configDir: account.configDir,
          events: eventsStore.events,
          sessionOutcomes: eventsStore.sessionOutcomes,
          joiner,
        }),
      );
    }
  }

  const teeIngestor: QuotaTeeIngestor | undefined = config.quota
    ? createQuotaTeeIngestor({ quotaDir: config.quotaDir, store: eventsStore.quotaSnapshots })
    : undefined;

  let receiver: OtlpReceiver | undefined;
  if (config.otlp) {
    try {
      receiver = await otlpStarter({ events: eventsStore.events, joiner, port: config.otlpPort, nowMs: clock });
      if (receiver.state === 'port-in-use') {
        logger.warn('otlp receiver port in use — attribution source idle', {
          port: config.otlpPort,
        });
      } else {
        logger.info('otlp receiver listening', { url: receiver.url });
      }
    } catch (err) {
      // A receiver bind failure must never abort the fleet; the other sources run.
      logger.warn('otlp receiver failed to start — attribution source idle', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let ticks = 0;
  let lastTickRows = 0;
  let lastFullMs = 0;

  const tick = async (): Promise<number> => {
    const now = clock();
    const full = now - lastFullMs >= config.fullReconcileMs;
    if (full) lastFullMs = now;
    let rows = 0;
    for (const watcher of watchers) {
      try {
        rows += await watcher.scanAsync({ full });
      } catch (err) {
        logger.warn('jsonl watcher scan failed', {
          account: watcher.account,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (teeIngestor !== undefined) {
      try {
        rows += teeIngestor.poll();
      } catch (err) {
        logger.warn('quota tee poll failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Flush api_request halves older than the join window (twin-less → single-source rows).
    try {
      rows += joiner.flush(config.joinWindowMs);
    } catch (err) {
      logger.warn('api_request joiner flush failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    ticks += 1;
    lastTickRows = rows;
    return rows;
  };

  // Initial pass so a freshly-connected cockpit paints real data promptly, then arm the pump.
  await tick();
  const timerHandle = armInterval(() => {
    void tick().catch((err: unknown) => {
      logger.error('collector tick threw', { error: err instanceof Error ? err.message : String(err) });
    });
  }, config.pollMs);

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    timerHandle.close();
    for (const watcher of watchers) {
      try {
        watcher.stop();
      } catch {
        /* watcher stop is best-effort on teardown */
      }
    }
    if (receiver !== undefined) await receiver.close().catch(() => undefined);
    // Drain any still-pending halves (age 0 = flush all) before dropping the joiner's timer.
    try {
      joiner.flush(0);
    } catch {
      /* store may already be closing */
    }
    joiner.close();
  };

  logger.info('collector fleet started', {
    watchers: watchers.length,
    quota: teeIngestor !== undefined,
    otlp: receiver?.state ?? 'off',
    pollMs: config.pollMs,
  });

  return {
    tick,
    stats: (): CollectorFleetStats => ({
      watchers: watchers.length,
      ...(receiver !== undefined ? { otlp: receiver.state } : {}),
      otlpPort: receiver?.port ?? 0,
      lastTickRows,
      ticks,
    }),
    stop,
  };
}
