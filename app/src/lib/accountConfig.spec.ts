/**
 * FE-1 / FE-4 — account-registry sync + re-sync on broker restart.
 *
 * FE-1 (HIGH): the configured accounts must re-sync on `onBrokerRestart`, so a
 * broker that restarts with a newly-provisioned account (MAX_C) makes it
 * visible cockpit-wide without a reload — the regression the closure had.
 * FE-4 (LOW): a fallback to the seed set is LOGGED with its reason.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  installAccountRegistrySync,
  syncAccountRegistry,
  type AccountSyncResult,
  type RestartTrigger,
} from './accountConfig.ts';
import {
  SEED_CLAUDE_ACCOUNTS,
  currentAccountConfigSource,
  currentConfiguredClaudeAccounts,
  setConfiguredClaudeAccounts,
} from './accountRegistry.ts';
import type { BootstrapProvider } from './bootstrap.ts';
import type { Logger } from './log.ts';

const emailish = ['owner.real', 'example.com'].join('@');

afterEach(() => {
  setConfiguredClaudeAccounts(SEED_CLAUDE_ACCOUNTS);
});

/** A bootstrap provider returning a scripted sequence of parsed bodies. */
function scriptedProvider(bodies: unknown[]): { provider: BootstrapProvider; calls: () => number } {
  let i = 0;
  return {
    provider: () => Promise.resolve(bodies[Math.min(i++, bodies.length - 1)]),
    calls: () => i,
  };
}

function bootstrapBody(claudeAccounts?: string[]): Record<string, unknown> {
  return {
    port: 8137,
    token: 'per-boot-secret-not-logged',
    pid: 4242,
    startedAt: '2026-07-05T00:00:00.000Z',
    ...(claudeAccounts !== undefined ? { claudeAccounts } : {}),
  };
}

function recordingLogger(): { logger: Logger; warns: { msg: string; detail?: unknown }[]; debugs: { msg: string; detail?: unknown }[] } {
  const warns: { msg: string; detail?: unknown }[] = [];
  const debugs: { msg: string; detail?: unknown }[] = [];
  return {
    warns,
    debugs,
    logger: {
      debug: (msg, detail) => debugs.push({ msg, detail }),
      warn: (msg, detail) => warns.push({ msg, detail }),
      error: () => {},
    },
  };
}

/** A restart trigger that lets a test fire onBrokerRestart on demand. */
function fakeClient(): RestartTrigger & { fireRestart: () => void; subscribers: number } {
  const listeners = new Set<{ onBrokerRestart?(): void }>();
  return {
    subscribers: 0,
    subscribe(listener) {
      listeners.add(listener);
      this.subscribers = listeners.size;
      return () => {
        listeners.delete(listener);
        this.subscribers = listeners.size;
      };
    },
    fireRestart() {
      for (const l of [...listeners]) l.onBrokerRestart?.();
    },
  };
}

describe('syncAccountRegistry — provenance + fallback logging (FE-4)', () => {
  it('applies the advertised bootstrap set (source=bootstrap, no warn)', async () => {
    const { provider } = scriptedProvider([bootstrapBody(['MAX_A', 'MAX_B', 'ENT', 'MAX_C'])]);
    const { logger, warns } = recordingLogger();
    const result = await syncAccountRegistry(provider, { logger, readShim: () => undefined });
    expect(result).toEqual({ reason: 'bootstrap', count: 4 });
    expect(currentConfiguredClaudeAccounts()).toEqual(['MAX_A', 'MAX_B', 'ENT', 'MAX_C']);
    expect(currentAccountConfigSource()).toBe('bootstrap');
    expect(warns).toHaveLength(0); // a real set never warns
  });

  it('falls back to the shim when the carrier advertises nothing', async () => {
    const { provider } = scriptedProvider([bootstrapBody(undefined)]);
    const { logger } = recordingLogger();
    const result = await syncAccountRegistry(provider, {
      logger,
      readShim: () => ['MAX_A', 'MAX_C'],
    });
    expect(result.reason).toBe('shim');
    expect(currentConfiguredClaudeAccounts()).toEqual(['MAX_A', 'MAX_C']);
    expect(currentAccountConfigSource()).toBe('shim');
  });

  it('LOGS the fallback reason when the carrier is absent (FE-4 observability)', async () => {
    const { provider } = scriptedProvider([bootstrapBody(undefined)]);
    const { logger, warns } = recordingLogger();
    const result = await syncAccountRegistry(provider, { logger, readShim: () => undefined });
    expect(result).toEqual({ reason: 'absent', count: 0 });
    expect(currentConfiguredClaudeAccounts()).toEqual([...SEED_CLAUDE_ACCOUNTS]);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toMatch(/fell back to seed/i);
    expect(warns[0]?.detail).toEqual({ reason: 'absent' });
  });

  it('LOGS reason=empty when the carrier advertises an all-dropped list', async () => {
    // A torn/foreign body: claudeAccounts present but every element non-form →
    // configuredClaudeAccountsFromBootstrap drops them → advertised = [].
    const { provider } = scriptedProvider([bootstrapBody([emailish, 'HACKER'])]);
    const { logger, warns } = recordingLogger();
    const result = await syncAccountRegistry(provider, { logger, readShim: () => undefined });
    expect(result.reason).toBe('empty');
    expect(warns[0]?.detail).toEqual({ reason: 'empty' });
    expect(currentConfiguredClaudeAccounts()).toEqual([...SEED_CLAUDE_ACCOUNTS]);
  });

  it('[X2] never logs an identifier — only the reason token', async () => {
    const { provider } = scriptedProvider([bootstrapBody([emailish])]);
    const { logger, warns, debugs } = recordingLogger();
    await syncAccountRegistry(provider, { logger, readShim: () => undefined });
    const all = JSON.stringify([...warns, ...debugs]);
    expect(all).not.toContain('@');
    expect(all).not.toContain('per-boot-secret');
  });
});

/**
 * An `onSynced` sink that hands back a promise resolving on the NEXT sync — the
 * observable seam for the async restart re-sync (no arbitrary microtask waits).
 */
function syncWatcher(): {
  onSynced: (r: AccountSyncResult) => void;
  next: () => Promise<AccountSyncResult>;
  drain: () => void;
} {
  let pending: ((r: AccountSyncResult) => void) | undefined;
  const queue: AccountSyncResult[] = [];
  return {
    onSynced(r) {
      if (pending !== undefined) {
        const p = pending;
        pending = undefined;
        p(r);
      } else {
        queue.push(r);
      }
    },
    // Discard buffered results (e.g. the boot sync) so `next()` observes the
    // NEXT sync — the restart re-sync under test.
    drain() {
      queue.length = 0;
    },
    next() {
      const buffered = queue.shift();
      if (buffered !== undefined) return Promise.resolve(buffered);
      return new Promise<AccountSyncResult>((resolve) => {
        pending = resolve;
      });
    },
  };
}

describe('installAccountRegistrySync — FE-1 re-sync on broker restart', () => {
  it('syncs at boot AND re-syncs on onBrokerRestart (new account becomes visible)', async () => {
    // Boot: broker advertises the seed three. Restart: it re-advertises WITH
    // MAX_C provisioned — the exact FE-1 scenario.
    const { provider } = scriptedProvider([
      bootstrapBody(['MAX_A', 'MAX_B', 'ENT']),
      bootstrapBody(['MAX_A', 'MAX_B', 'ENT', 'MAX_C']),
    ]);
    const { logger } = recordingLogger();
    const watcher = syncWatcher();
    const client = fakeClient();

    const { boot, dispose } = installAccountRegistrySync(client, provider, {
      logger,
      readShim: () => undefined,
      onSynced: watcher.onSynced,
    });
    await boot;
    watcher.drain(); // discard the boot sync; observe the restart re-sync
    expect(currentConfiguredClaudeAccounts()).toEqual(['MAX_A', 'MAX_B', 'ENT']);
    expect(client.subscribers).toBe(1); // the restart listener is wired

    // Broker restarts with MAX_C now provisioned.
    client.fireRestart();
    const result = await watcher.next();
    expect(result).toEqual({ reason: 'bootstrap', count: 4 });
    expect(currentConfiguredClaudeAccounts()).toEqual(['MAX_A', 'MAX_B', 'ENT', 'MAX_C']);

    dispose();
    expect(client.subscribers).toBe(0);
  });

  it('re-sync SHRINKS the set when an account is deprovisioned', async () => {
    const { provider } = scriptedProvider([
      bootstrapBody(['MAX_A', 'MAX_B', 'ENT', 'MAX_C']),
      bootstrapBody(['MAX_A', 'MAX_B', 'ENT']),
    ]);
    const watcher = syncWatcher();
    const client = fakeClient();
    const { boot, dispose } = installAccountRegistrySync(client, provider, {
      readShim: () => undefined,
      logger: recordingLogger().logger,
      onSynced: watcher.onSynced,
    });
    await boot;
    watcher.drain();
    expect(currentConfiguredClaudeAccounts()).toEqual(['MAX_A', 'MAX_B', 'ENT', 'MAX_C']);
    client.fireRestart();
    await watcher.next();
    expect(currentConfiguredClaudeAccounts()).toEqual(['MAX_A', 'MAX_B', 'ENT']);
    dispose();
  });

  it('a re-sync whose provider rejects never destabilizes — falls back to seed', async () => {
    let call = 0;
    const provider: BootstrapProvider = () => {
      call += 1;
      if (call === 1) return Promise.resolve(bootstrapBody(['MAX_A', 'MAX_B', 'ENT', 'MAX_C']));
      return Promise.reject(new Error('disk gone'));
    };
    const watcher = syncWatcher();
    const client = fakeClient();
    const { logger, warns } = recordingLogger();
    const { boot, dispose } = installAccountRegistrySync(client, provider, {
      logger,
      readShim: () => undefined,
      onSynced: watcher.onSynced,
    });
    await boot;
    watcher.drain();
    expect(currentConfiguredClaudeAccounts()).toEqual(['MAX_A', 'MAX_B', 'ENT', 'MAX_C']);
    client.fireRestart();
    const result = await watcher.next();
    // discoverGateway swallows the rejection → 'no broker advertised' → the
    // registry fail-closes to the seed (never a crash, never a stale set).
    expect(result.reason).toBe('absent');
    expect(currentConfiguredClaudeAccounts()).toEqual([...SEED_CLAUDE_ACCOUNTS]);
    expect(warns.some((w) => (w.detail as { reason?: string })?.reason === 'absent')).toBe(true);
    dispose();
  });
});
