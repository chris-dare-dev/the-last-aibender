/**
 * BE-5 source 2 suite (plan §9.2 BE-5 rows):
 *   positive — statusline JSON → quota snapshot (both windows)
 *   negative — unknown tee file name skipped (label never guessed);
 *              live OAuth client refused without the opt-in
 *   edge     — tee re-emit dedupe on mtime; used_pct clamping;
 *              429 backoff doubling and cap; idle gate
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openEventsStore, type EventsStore } from '@aibender/schema';
import { synthesizedStatuslinePayload, writeStatuslineTee } from '@aibender/testkit';

import { LiveOauthDisabledError } from '../errors.js';
import {
  createIdleAccountOauthPoller,
  createLiveOauthUsageClient,
  decodeOauthUsageBody,
  type OauthUsageClient,
  type OauthUsageFetchResult,
} from './oauthPoller.js';
import { createQuotaTeeIngestor, parseStatuslinePayload } from './teeFile.js';

// The SI-3 bats fixture shape (infra/hooks/tests/hooks.bats) — the promoted
// testkit generator (ICR-0010) defaults to it exactly.
const STATUSLINE_PAYLOAD = synthesizedStatuslinePayload();

describe('parseStatuslinePayload', () => {
  it('maps five_hour/seven_day into 5h/7d snapshots (positive)', () => {
    const rows = parseStatuslinePayload(STATUSLINE_PAYLOAD, {
      account: 'MAX_A',
      capturedAtMs: 1_000,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      account: 'MAX_A',
      window: '5h',
      usedPct: 41.5,
      resetsAtMs: Date.parse('2026-07-04T12:00:00Z'),
      capturedAtMs: 1_000,
      source: 'statusline',
    });
    expect(rows[1]?.window).toBe('7d');
  });

  it('clamps out-of-range percentages (collector clamps upstream noise)', () => {
    const rows = parseStatuslinePayload(
      synthesizedStatuslinePayload({
        rateLimits: { fiveHour: { usedPercentage: 130.2, resetsAt: 1_800_000_000 } },
      }),
      { account: 'MAX_B', capturedAtMs: 0 },
    );
    expect(rows[0]?.usedPct).toBe(100);
    expect(rows[0]?.resetsAtMs).toBe(1_800_000_000_000); // seconds → ms
  });

  it('returns [] for unparseable payloads and payloads without rate_limits', () => {
    expect(parseStatuslinePayload('{torn', { account: 'MAX_A', capturedAtMs: 0 })).toEqual([]);
    expect(
      parseStatuslinePayload(synthesizedStatuslinePayload({ rateLimits: {} }), {
        account: 'MAX_A',
        capturedAtMs: 0,
      }),
    ).toEqual([]);
  });
});

describe('createQuotaTeeIngestor', () => {
  let dir: string;
  let store: EventsStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aibender-quota-'));
    store = await openEventsStore({ path: ':memory:' });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ingests <LABEL>.json tee files; label from the FILE NAME only', () => {
    writeStatuslineTee({ quotaDir: dir, label: 'MAX_A', payload: STATUSLINE_PAYLOAD });
    const ingestor = createQuotaTeeIngestor({ quotaDir: dir, store: store.quotaSnapshots });
    expect(ingestor.poll()).toBe(2);
    const latest = store.quotaSnapshots.latest();
    expect(latest.map((row) => [row.account, row.window])).toEqual([
      ['MAX_A', '5h'],
      ['MAX_A', '7d'],
    ]);
    expect(latest[0]?.source).toBe('statusline');
  });

  it('skips unrecognized file names — a label is never guessed [X2]', () => {
    writeStatuslineTee({ quotaDir: dir, label: 'personal-account', payload: STATUSLINE_PAYLOAD });
    const ingestor = createQuotaTeeIngestor({ quotaDir: dir, store: store.quotaSnapshots });
    expect(ingestor.poll()).toBe(0);
    expect(ingestor.stats().filesSkipped).toBe(1);
    expect(store.quotaSnapshots.list()).toHaveLength(0);
  });

  it('re-polling an unchanged tee is a silent dedupe (mtime = capturedAt)', () => {
    writeStatuslineTee({
      quotaDir: dir,
      label: 'ENT',
      payload: STATUSLINE_PAYLOAD,
      mtimeMs: 1_700_000_000_000,
    });
    const ingestor = createQuotaTeeIngestor({ quotaDir: dir, store: store.quotaSnapshots });
    expect(ingestor.poll()).toBe(2);
    expect(ingestor.poll()).toBe(0); // identical capture → dedupe
    expect(ingestor.stats().snapshotsDeduped).toBe(2);
    // A NEW tick (new mtime) is a new capture.
    writeStatuslineTee({
      quotaDir: dir,
      label: 'ENT',
      payload: STATUSLINE_PAYLOAD,
      mtimeMs: 1_700_000_060_000,
    });
    expect(ingestor.poll()).toBe(2);
  });
});

describe('createIdleAccountOauthPoller (scaffold, fake client)', () => {
  const windows = [
    { window: '5h' as const, usedPct: 55, resetsAtMs: 2_000_000 },
    { window: '7d' as const, usedPct: 21, resetsAtMs: 3_000_000 },
    { window: '7d_sonnet' as const, usedPct: 8, resetsAtMs: 3_000_000 },
  ];

  function fakeClient(script: readonly OauthUsageFetchResult[]): {
    client: OauthUsageClient;
    calls: () => number;
  } {
    let index = 0;
    return {
      client: {
        fetchUsage: async () => script[Math.min(index++, script.length - 1)] as OauthUsageFetchResult,
      },
      calls: () => index,
    };
  }

  it('polls only idle accounts and inserts oauth-poll snapshots (incl. 7d_sonnet)', async () => {
    const store = await openEventsStore({ path: ':memory:' });
    const { client, calls } = fakeClient([{ status: 'ok', windows }]);
    let now = 0;
    const idle = new Set(['MAX_B']);
    const poller = createIdleAccountOauthPoller({
      client,
      store: store.quotaSnapshots,
      accounts: ['MAX_A', 'MAX_B'],
      isIdle: (label) => idle.has(label),
      nowMs: () => now,
    });
    expect(await poller.tick()).toBe(3);
    expect(calls()).toBe(1); // MAX_A active → never polled
    expect(poller.stats().skippedNotIdle).toBe(1);
    const rows = store.quotaSnapshots.list({ account: 'MAX_B' });
    expect(rows.map((row) => row.window).sort()).toEqual(['5h', '7d', '7d_sonnet']);
    expect(rows[0]?.source).toBe('oauth-poll');
    store.close();
  });

  it('enforces the rate-limit floor between polls (≤1 per 10–15 min)', async () => {
    const store = await openEventsStore({ path: ':memory:' });
    const { client, calls } = fakeClient([{ status: 'ok', windows }]);
    let now = 0;
    const poller = createIdleAccountOauthPoller({
      client,
      store: store.quotaSnapshots,
      accounts: ['MAX_A'],
      isIdle: () => true,
      nowMs: () => now,
    });
    await poller.tick();
    now = 5 * 60 * 1000; // 5 min later — under the 10 min floor
    await poller.tick();
    expect(calls()).toBe(1);
    expect(poller.stats().skippedNotDue).toBe(1);
    now = 11 * 60 * 1000;
    await poller.tick();
    expect(calls()).toBe(2);
    store.close();
  });

  it('backs off exponentially on 429 and caps at the ceiling (edge)', async () => {
    const store = await openEventsStore({ path: ':memory:' });
    const { client } = fakeClient([{ status: 'rate-limited' }]);
    let now = 0;
    const poller = createIdleAccountOauthPoller({
      client,
      store: store.quotaSnapshots,
      accounts: ['ENT'],
      isIdle: () => true,
      policy: { minIntervalMs: 100, backoffInitialMs: 100, backoffMaxMs: 400 },
      nowMs: () => now,
    });
    await poller.tick();
    expect(poller.nextEligibleAtMs('ENT')).toBe(100); // first backoff step
    now = 100;
    await poller.tick();
    expect(poller.nextEligibleAtMs('ENT')).toBe(300); // doubled (200)
    now = 300;
    await poller.tick();
    expect(poller.nextEligibleAtMs('ENT')).toBe(700); // capped at 400
    expect(poller.stats().rateLimited).toBe(3);
    store.close();
  });

  it('refuses non-claude labels (programmer error)', async () => {
    const store = await openEventsStore({ path: ':memory:' });
    expect(() =>
      createIdleAccountOauthPoller({
        client: { fetchUsage: async () => ({ status: 'error', message: 'x' }) },
        store: store.quotaSnapshots,
        accounts: ['AWS_DEV'],
        isIdle: () => true,
      }),
    ).toThrowError(/claude_code/);
    store.close();
  });
});

describe('the live OAuth client gate', () => {
  it('is REFUSED without the explicit enableLiveOauth opt-in (negative)', () => {
    expect(() =>
      createLiveOauthUsageClient({
        enableLiveOauth: false,
        tokenProvider: async () => 'never-used',
      }),
    ).toThrowError(LiveOauthDisabledError);
  });

  it('decodes the endpoint body shape (0–1 utilization → 0–100 pct)', () => {
    const windows = decodeOauthUsageBody({
      five_hour: { utilization: 0.415, resets_at: '2026-07-04T12:00:00Z' },
      seven_day: { utilization: 0.12, resets_at: '2026-07-08T00:00:00Z' },
      seven_day_sonnet: { utilization: 1.4, resets_at: '2026-07-08T00:00:00Z' }, // noisy
    });
    expect(windows.map((w) => [w.window, w.usedPct])).toEqual([
      ['5h', 41.5],
      ['7d', 12],
      ['7d_sonnet', 100], // clamped
    ]);
  });
});
