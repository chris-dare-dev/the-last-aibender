/**
 * Live-boot slice tests (boot.ts). The WHOLE boot is exercised with FAKES — the
 * testkit FakeQueryRunner/FakePtyBackend, a synthetic account registry, and
 * `:memory:` stores — so nothing spawns a real child, spends quota, or touches a
 * live system. Proves: config resolution; the real compose (on-disk bootstrap
 * written, gated PTY, [X4] workstream slice, publisher lane on a cadence timer);
 * a real WS round-trip (the read-model publisher → gateway → a connecting
 * client); and idempotent clean shutdown. [X2]: synthesized labels/paths only.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CHANNEL, streamForChannel, type ChannelName } from '@aibender/protocol';
import { FakePtyBackend, FakeQueryRunner } from '@aibender/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';

import type { AccountRegistry, DiscoveredAccount } from '../kernel/index.js';

import { bootBroker, resolveBootConfig, type BootConfig, type BootIntervalHandle } from './boot.js';

const QUIET = { debug() {}, info() {}, warn() {}, error() {} };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function synthRegistry(home: string): AccountRegistry {
  const dir = (label: string): string => join(home, 'accounts', label.toLowerCase());
  const accounts: DiscoveredAccount[] = (['MAX_A', 'MAX_B'] as const).map((label) => ({
    label: label as DiscoveredAccount['label'],
    backend: 'claude_code' as const,
    configDir: dir(label),
    securestorageDir: dir(label),
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

interface Booted {
  handle: Awaited<ReturnType<typeof bootBroker>>;
  tick: () => void;
  intervalMs: number;
  intervalClosed: () => number;
}

async function bootWithFakes(config: Partial<BootConfig> = {}, opts: { pty?: boolean } = {}): Promise<Booted> {
  const home = mkdtempSync(join(tmpdir(), 'aibender-boot-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  let capturedTick: (() => void) | undefined;
  let capturedMs = 0;
  let closed = 0;
  const setPublisherInterval = (tick: () => void, ms: number): BootIntervalHandle => {
    capturedTick = tick;
    capturedMs = ms;
    return { close: () => { closed += 1; } };
  };
  const handle = await bootBroker(
    {
      aibenderHome: home,
      liveSpawn: false,
      livePty: false,
      publishIntervalMs: 5_000,
      hooks: false,
      writeBootstrap: true,
      ...config,
    },
    {
      runner: new FakeQueryRunner({ mode: 'manual' }),
      ...(opts.pty === true ? { ptyBackend: new FakePtyBackend() } : {}),
      accountRegistry: synthRegistry(home),
      kernelStorePath: ':memory:',
      eventsStorePath: ':memory:',
      logger: QUIET,
      setPublisherInterval,
    },
  );
  cleanups.push(() => handle.stop());
  return { handle, tick: () => capturedTick?.(), intervalMs: capturedMs, intervalClosed: () => closed };
}

// ---------------------------------------------------------------------------
// A minimal frozen-wire client (mirrors composedBroker.spec's WireClient).
// ---------------------------------------------------------------------------

class WireClient {
  readonly payloads: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  private readonly seqByChannel = new Map<ChannelName, number>();
  private constructor(private readonly ws: WsClient) {
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        const env = JSON.parse(String(data)) as { channel: string; payload: unknown };
        if (env.payload !== null && typeof env.payload === 'object') {
          this.payloads.push({ channel: env.channel, payload: env.payload as Record<string, unknown> });
        }
      } catch {
        /* ignore non-JSON */
      }
    });
    ws.on('error', () => {
      /* teardown races expected */
    });
  }
  static async connect(url: string, token: string): Promise<WireClient> {
    const ws = new WsClient(`${url}/?token=${token}`);
    const client = new WireClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return client;
  }
  send(channel: ChannelName, payload: unknown): void {
    const seq = this.seqByChannel.get(channel) ?? 0;
    this.seqByChannel.set(channel, seq + 1);
    this.ws.send(JSON.stringify({ stream: streamForChannel(channel), channel, seq, payload }));
  }
  kind(channel: ChannelName, kind: string): Record<string, unknown>[] {
    return this.payloads.filter((p) => p.channel === channel && p.payload['kind'] === kind).map((p) => p.payload);
  }
  close(): void {
    this.ws.close();
  }
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------------------
// resolveBootConfig
// ---------------------------------------------------------------------------

describe('resolveBootConfig', () => {
  it('defaults: no live spawn/pty, 5s publish cadence, hooks on, bootstrap on', () => {
    const c = resolveBootConfig({ HOME: '/synthetic/home' });
    expect(c.liveSpawn).toBe(false);
    expect(c.livePty).toBe(false);
    expect(c.publishIntervalMs).toBe(5_000);
    expect(c.hooks).toBe(true);
    expect(c.writeBootstrap).toBe(true);
    expect(c.aibenderHome).toContain('.aibender');
  });

  it('env overrides: AIBENDER_HOME, live gates, cadence, hooks-off, port', () => {
    const c = resolveBootConfig({
      AIBENDER_HOME: '/tmp/synthetic-aibender',
      AIBENDER_LIVE_SPAWN: '1',
      AIBENDER_LIVE_PTY: 'true',
      AIBENDER_PUBLISH_INTERVAL_MS: '2500',
      AIBENDER_HOOKS: '0',
      AIBENDER_HOOKS_PORT: '4321',
    });
    expect(c.aibenderHome).toBe('/tmp/synthetic-aibender');
    expect(c.liveSpawn).toBe(true);
    expect(c.livePty).toBe(true);
    expect(c.publishIntervalMs).toBe(2500);
    expect(c.hooks).toBe(false);
    expect(c.hooksPort).toBe(4321);
  });

  it('ignores a non-positive / garbage publish interval (falls back to 5s)', () => {
    expect(resolveBootConfig({ AIBENDER_PUBLISH_INTERVAL_MS: '0' }).publishIntervalMs).toBe(5_000);
    expect(resolveBootConfig({ AIBENDER_PUBLISH_INTERVAL_MS: 'nope' }).publishIntervalMs).toBe(5_000);
  });
});

// ---------------------------------------------------------------------------
// bootBroker — compose + lifecycle
// ---------------------------------------------------------------------------

describe('bootBroker (fakes)', () => {
  it('composes the broker, writes the discovery bootstrap, registers the publisher timer', async () => {
    const { handle, intervalMs } = await bootWithFakes({ publishIntervalMs: 3210 });
    const g = handle.broker.gateway;
    expect(g.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+/);
    expect(g.token.length).toBeGreaterThan(0);

    // The bootstrap file is really on disk and carries the port + token.
    const bootstrap = JSON.parse(readFileSync(g.bootstrapPath, 'utf8')) as Record<string, unknown>;
    expect(bootstrap['port']).toBe(g.port);
    expect(bootstrap['token']).toBe(g.token);
    // ICR-0014 carrier: the discovered Claude accounts are advertised.
    expect(bootstrap['claudeAccounts']).toEqual(['MAX_A', 'MAX_B']);

    // The read-model publisher lane is on the configured cadence.
    expect(intervalMs).toBe(3210);
    // The [X4] workstream slice is composed.
    expect(handle.broker.workstreams).toBeDefined();
  });

  it('gates the PTY: no backend → no ptyHost; injected backend → ptyHost present', async () => {
    const without = await bootWithFakes();
    expect(without.handle.broker.ptyHost).toBeUndefined();
    const withPty = await bootWithFakes({}, { pty: true });
    expect(withPty.handle.broker.ptyHost).toBeDefined();
  });

  it('stop() is idempotent and closes the publisher timer', async () => {
    const { handle, intervalClosed } = await bootWithFakes();
    await handle.stop();
    await handle.stop(); // idempotent — no throw, no double-close side effects
    expect(intervalClosed()).toBeGreaterThanOrEqual(1);
  });

  it('round-trip: a quota row published by the timed lane reaches a connecting client', async () => {
    const { handle, tick } = await bootWithFakes();
    // Land a quota snapshot in the events store, then run the publisher tick.
    handle.eventsStore.quotaSnapshots.insert({
      account: 'MAX_A',
      window: '5h',
      usedPct: 42,
      resetsAtMs: 1_000_000,
      capturedAtMs: 900_000,
      source: 'statusline',
    });
    tick(); // the cadence tick the daemon runs on its interval

    const client = await WireClient.connect(handle.broker.gateway.url, handle.broker.gateway.token);
    cleanups.push(() => client.close());
    // The frame was journaled before this client connected → recover it via the
    // frozen §8 replay path (the same pattern composedBroker.spec proves).
    client.send(CHANNEL.QUOTA, { kind: 'replay-request', channel: CHANNEL.QUOTA, fromSeq: 0 });
    await waitFor(
      () => client.kind(CHANNEL.QUOTA, 'quota-snapshot').length >= 1,
      'quota-snapshot replay from the publisher lane',
    );
    expect(client.kind(CHANNEL.QUOTA, 'quota-snapshot')[0]).toMatchObject({
      account: 'MAX_A',
      window: '5h',
      usedPct: 42,
    });
  });
});
