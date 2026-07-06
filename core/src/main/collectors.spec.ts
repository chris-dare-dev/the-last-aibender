/**
 * Collector-fleet tests (collectors.ts). The fleet is exercised over a REAL
 * `:memory:` events store with a synthetic account registry and synthesized
 * machine-local files — nothing binds :4318 (the OTLP receiver is either disabled
 * or an injected fake) and nothing spends quota. Proves: config resolution; that
 * a teed statusline payload lands in quota_snapshots through a deterministic
 * tick(); that only claude_code accounts get a watcher; that a missing quota dir
 * / empty account dirs are honest zeroes (no throw); OTLP disabled vs injected
 * `listening` vs `port-in-use` degrade; and idempotent shutdown that closes the
 * timer + the receiver. [X2]: synthesized labels/paths/payloads only.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openEventsStore, type EventsStore } from '@aibender/schema';
import { createLogger } from '@aibender/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AccountRegistry, DiscoveredAccount } from '../kernel/index.js';

import type { BootIntervalHandle } from './boot.js';
import { resolveCollectorConfig, startCollectorFleet, type CollectorFleetConfig } from './collectors.js';

const QUIET = createLogger({ sink: () => {} });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function synthRegistry(home: string, labels: readonly string[]): AccountRegistry {
  const accounts: DiscoveredAccount[] = labels.map((label) => ({
    label: label as DiscoveredAccount['label'],
    backend: 'claude_code' as const,
    configDir: join(home, 'accounts', label.toLowerCase()),
    securestorageDir: join(home, 'accounts', label.toLowerCase()),
    source: `<synthetic:${label}>`,
  }));
  const byLabel = new Map(accounts.map((a) => [a.label as string, a]));
  return {
    labels: () => accounts.map((a) => a.label),
    has: (label: string) => byLabel.has(label),
    get: (label: string) => byLabel.get(label),
    all: () => accounts,
  };
}

async function memStore(): Promise<EventsStore> {
  const store = await openEventsStore({ path: ':memory:' });
  cleanups.push(() => store.close());
  return store;
}

function tmpHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'aibender-collectors-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

/** A capturing timer factory: records the tick + close count, never fires on its own. */
function capturingInterval(): {
  factory: (tick: () => void, ms: number) => BootIntervalHandle;
  ms: () => number;
  closed: () => number;
} {
  let capturedMs = 0;
  let closed = 0;
  return {
    factory: (_tick, ms) => {
      capturedMs = ms;
      return { close: () => { closed += 1; } };
    },
    ms: () => capturedMs,
    closed: () => closed,
  };
}

function baseConfig(quotaDir: string, over: Partial<CollectorFleetConfig> = {}): CollectorFleetConfig {
  return {
    enabled: true,
    jsonl: true,
    quota: true,
    otlp: false, // default OFF in tests → never binds :4318
    pollMs: 2_000,
    joinWindowMs: 15_000,
    fullReconcileMs: 30_000,
    otlpPort: 4318,
    quotaDir,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// resolveCollectorConfig
// ---------------------------------------------------------------------------

describe('resolveCollectorConfig', () => {
  it('defaults: everything on, 2s poll, 4318, quotaDir under home', () => {
    const c = resolveCollectorConfig({}, '/synthetic/home');
    expect(c.enabled).toBe(true);
    expect(c.jsonl).toBe(true);
    expect(c.quota).toBe(true);
    expect(c.otlp).toBe(true);
    expect(c.pollMs).toBe(2_000);
    expect(c.joinWindowMs).toBe(15_000);
    expect(c.otlpPort).toBe(4318);
    expect(c.quotaDir).toBe('/synthetic/home/quota');
  });

  it('env overrides: master off, per-source off, cadence + port', () => {
    const off = resolveCollectorConfig({ AIBENDER_COLLECTORS: '0' }, '/h');
    expect(off.enabled).toBe(false);
    const c = resolveCollectorConfig(
      {
        AIBENDER_COLLECTOR_OTLP: '0',
        AIBENDER_COLLECTOR_POLL_MS: '500',
        AIBENDER_OTLP_PORT: '9999',
        AIBENDER_COLLECTOR_JOIN_WINDOW_MS: '3000',
      },
      '/h',
    );
    expect(c.otlp).toBe(false);
    expect(c.pollMs).toBe(500);
    expect(c.otlpPort).toBe(9999);
    expect(c.joinWindowMs).toBe(3_000);
  });

  it('ignores non-positive / garbage numerics (falls back to defaults)', () => {
    const c = resolveCollectorConfig({ AIBENDER_COLLECTOR_POLL_MS: '0', AIBENDER_OTLP_PORT: 'nope' }, '/h');
    expect(c.pollMs).toBe(2_000);
    expect(c.otlpPort).toBe(4318);
  });
});

// ---------------------------------------------------------------------------
// startCollectorFleet
// ---------------------------------------------------------------------------

describe('startCollectorFleet', () => {
  it('ingests a teed statusline payload into quota_snapshots on the tick', async () => {
    const home = tmpHome();
    const quotaDir = join(home, 'quota');
    mkdirSync(quotaDir, { recursive: true });
    // SI-3's statusline hook tees the CLI statusline JSON to <LABEL>.json.
    writeFileSync(
      join(quotaDir, 'MAX_A.json'),
      JSON.stringify({
        rate_limits: {
          five_hour: { used_percentage: 37, resets_at: '2026-07-05T18:00:00.000Z' },
          seven_day: { used_percentage: 12, resets_at: '2026-07-11T00:00:00.000Z' },
        },
      }),
    );
    const store = await memStore();
    const fleet = await startCollectorFleet(baseConfig(quotaDir), {
      eventsStore: store,
      accountRegistry: synthRegistry(home, ['MAX_A', 'MAX_B']),
      logger: QUIET,
    });
    cleanups.push(() => fleet.stop());

    // The initial tick (run inside start) already polled the tee.
    const rows = store.quotaSnapshots.list({ account: 'MAX_A' });
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r.window === '5h')?.usedPct).toBe(37);
    expect(fleet.stats().watchers).toBe(2); // both claude accounts watched
  });

  it('is an honest zero when the quota dir and account dirs are absent (no throw)', async () => {
    const home = tmpHome();
    const store = await memStore();
    const fleet = await startCollectorFleet(baseConfig(join(home, 'quota')), {
      eventsStore: store,
      accountRegistry: synthRegistry(home, ['MAX_A']),
      logger: QUIET,
    });
    cleanups.push(() => fleet.stop());
    // Nothing on disk → zero rows, zero throws.
    expect(await fleet.tick()).toBe(0);
    expect(store.quotaSnapshots.latest().length).toBe(0);
  });

  it('OTLP disabled → no receiver in stats', async () => {
    const home = tmpHome();
    const store = await memStore();
    const fleet = await startCollectorFleet(baseConfig(join(home, 'quota'), { otlp: false }), {
      eventsStore: store,
      accountRegistry: synthRegistry(home, ['MAX_A']),
      logger: QUIET,
    });
    cleanups.push(() => fleet.stop());
    expect(fleet.stats().otlp).toBeUndefined();
    expect(fleet.stats().otlpPort).toBe(0);
  });

  it('OTLP injected `listening` → reflected in stats and closed on stop', async () => {
    const home = tmpHome();
    const store = await memStore();
    const close = vi.fn(async () => undefined);
    const fakeReceiver = vi.fn(async () => ({
      state: 'listening' as const,
      port: 4318,
      url: 'http://127.0.0.1:4318',
      stats: () => ({
        logBatches: 0, logRecordsIngested: 0, logRecordsSkipped: 0, batchesDroppedNoLabel: 0,
        metricsAcked: 0, tracesAcked: 0, protobufRejected: 0, malformedBodies: 0,
      }),
      close,
    }));
    const fleet = await startCollectorFleet(baseConfig(join(home, 'quota'), { otlp: true }), {
      eventsStore: store,
      accountRegistry: synthRegistry(home, ['MAX_A']),
      logger: QUIET,
      startOtlpReceiver: fakeReceiver,
    });
    expect(fakeReceiver).toHaveBeenCalledOnce();
    expect(fleet.stats().otlp).toBe('listening');
    await fleet.stop();
    expect(close).toHaveBeenCalledOnce();
  });

  it('OTLP `port-in-use` degrades to a warning, fleet still runs', async () => {
    const home = tmpHome();
    const store = await memStore();
    const warn = vi.fn();
    const logger = { ...QUIET, warn };
    const fakeReceiver = vi.fn(async () => ({
      state: 'port-in-use' as const,
      port: 0,
      url: 'http://127.0.0.1:4318',
      stats: () => ({
        logBatches: 0, logRecordsIngested: 0, logRecordsSkipped: 0, batchesDroppedNoLabel: 0,
        metricsAcked: 0, tracesAcked: 0, protobufRejected: 0, malformedBodies: 0,
      }),
      close: async () => undefined,
    }));
    const fleet = await startCollectorFleet(baseConfig(join(home, 'quota'), { otlp: true }), {
      eventsStore: store,
      accountRegistry: synthRegistry(home, ['MAX_A']),
      logger,
      startOtlpReceiver: fakeReceiver,
    });
    cleanups.push(() => fleet.stop());
    expect(warn).toHaveBeenCalled();
    expect(fleet.stats().otlp).toBe('port-in-use');
    expect(await fleet.tick()).toBe(0); // still ticks without throwing
  });

  it('stop() is idempotent and closes the timer', async () => {
    const home = tmpHome();
    const store = await memStore();
    const timer = capturingInterval();
    const fleet = await startCollectorFleet(baseConfig(join(home, 'quota')), {
      eventsStore: store,
      accountRegistry: synthRegistry(home, ['MAX_A']),
      logger: QUIET,
      setInterval: timer.factory,
    });
    expect(timer.ms()).toBe(2_000);
    await fleet.stop();
    await fleet.stop(); // idempotent — no throw, no double close
    expect(timer.closed()).toBe(1);
  });

  it('starts no watchers when jsonl is disabled', async () => {
    const home = tmpHome();
    const store = await memStore();
    const fleet = await startCollectorFleet(baseConfig(join(home, 'quota'), { jsonl: false }), {
      eventsStore: store,
      accountRegistry: synthRegistry(home, ['MAX_A', 'MAX_B']),
      logger: QUIET,
    });
    cleanups.push(() => fleet.stop());
    expect(fleet.stats().watchers).toBe(0);
  });
});
