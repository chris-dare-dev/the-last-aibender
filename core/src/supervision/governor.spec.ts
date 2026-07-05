/**
 * BE-9 governor — the tick loop that fuses every signal (plan §9.2 BE-9 + the
 * M6 DoD "one real recycle with lineage continuity"):
 *   - induced-bloat FAKE-PROCESS harness driving the recycle band → recycle
 *     through the REAL ptyHost, proving the [X4] `continue` edge lands on the
 *     lineage store (recycle IS the account continuation mechanism);
 *   - amber/red transitions produce the sacrifice-order notices;
 *   - the account-never-shed + account-spawn-post-shed invariants at the
 *     governor level;
 *   - idle hibernation exclusions;
 *   - the snapshot is labels + numbers only [X2] and validates as the frozen
 *     resource-health read model.
 *
 * NO real process is ever bloated: the "bloat" is a fake sampler returning a
 * big MB number for a session that runs the testkit FakePtyBackend (a cheap
 * in-process sleeper analogue). NO cost-incurring call anywhere.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { validateEventsPayload } from '@aibender/protocol';
import { openKernelStore, type KernelStore } from '@aibender/schema';
import { FakePtyBackend } from '@aibender/testkit';

import { createProfileRegistry, createPtyHost, type PtyHost } from '../kernel/index.js';
import {
  continuationEdgesFromRecorder,
  createLineageRecorder,
} from '../workstreams/index.js';
import { createGovernor, type LocalModelPort, type RecyclePort } from './governor.js';
import type { FootprintSampler, PressureProbe, PressureReading, SupervisedSession } from './types.js';

const HOME = '/tmp/aibender-supervision-home';
const CWD = '/tmp/aibender-supervision-cwd';

const stores: KernelStore[] = [];
const hosts: PtyHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.shutdown();
  for (const store of stores.splice(0)) await store.close();
});

function fakeSampler(byId: Map<string, number>): FootprintSampler {
  return { sampleMb: (s) => byId.get(s.sessionId) };
}
const calm: PressureReading = { pressureLevel: 0, freeRamPct: 60, swapUsedBytes: 0, pageoutRate: 0 };
function fakeProbe(reading: PressureReading | undefined): PressureProbe {
  return { read: () => reading };
}

const opencodeSession = (id: string, slot: number): SupervisedSession => ({
  sessionId: id,
  account: 'AWS_DEV',
  backend: 'opencode',
  watchdogClass: 'opencode',
  slot,
  isAccountSession: false,
});
const claudeSession = (id: string, slot: number): SupervisedSession => ({
  sessionId: id,
  account: 'MAX_A',
  backend: 'claude_code',
  watchdogClass: 'claude',
  slot,
  isAccountSession: true,
});
const localModelSession = (id: string): SupervisedSession => ({
  sessionId: id,
  account: 'LOCAL',
  backend: 'lmstudio',
  watchdogClass: 'lmstudio',
  slot: 0,
  isAccountSession: false,
});

// ===========================================================================
// THE RECYCLE PATH → continue-edge lineage continuity (the M6 DoD proof)
// ===========================================================================

describe('BE-9 recycle path: induced bloat → recycle through the REAL ptyHost → [X4] continue edge', () => {
  it('a recycle-band claude session is recycled and records a continue edge (lineage continuity across recycle)', async () => {
    const store = await openKernelStore({ path: ':memory:' });
    stores.push(store);
    // The BE-7 recorder over the SAME kernel store — the recycle path records
    // its continue edge here (recycle = the [X4] continuation mechanism).
    const recorder = createLineageRecorder({ store: store.lineage, resumeLedger: store.resumeLedger });

    let n = 0;
    const host = createPtyHost({
      ledger: store.resumeLedger,
      profiles: createProfileRegistry({ aibenderHome: HOME }),
      backend: new FakePtyBackend(),
      baseEnv: { PATH: '/usr/bin', HOME },
      // The ptyHost recycle emits the continuation edge through this adapter.
      edges: continuationEdgesFromRecorder(recorder),
      newSessionUuid: () => `f0000000-0000-4000-8000-00000000000${(n++ % 10).toString()}`,
      forceKillAfterMs: 200,
    });
    hosts.push(host);

    // Launch an attended claude session (the resume-ledger row + lineage node).
    const session = await host.launchAttended({
      accountLabel: 'MAX_A',
      backend: 'claude_code',
      substrate: 'pty',
      cwd: CWD,
      purpose: 'supervision recycle exercise',
    });
    expect(store.lineage.edges.list()).toHaveLength(0); // launch = node, no edge yet

    // The governor's recycle port is the ptyHost recycle (the [X4] path).
    const recyclePort: RecyclePort = { recycle: (id) => host.recycle(id).then(() => undefined) };

    // Induce "bloat": the fake sampler reports 6.5 GB for this session (over
    // the claude 6 GB recycle line) — NO real process is bloated.
    const byId = new Map<string, number>([[session.sessionId, 6656]]);
    const governor = createGovernor({
      sampler: fakeSampler(byId),
      probe: fakeProbe(calm),
      recycle: recyclePort,
    });
    const supervised = claudeSession(session.sessionId, 0);
    governor.register(supervised);

    // One tick: the watchdog bands `recycle`, the governor drives the ptyHost
    // recycle, and the continue edge lands on the lineage store.
    const result = await governor.tick(90_100_480);
    expect(result.recycled).toEqual([session.sessionId]);

    const edges = store.lineage.edges.list();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      fromNode: session.sessionId,
      toNode: session.sessionId, // same-node recycle = the continue SELF-edge
      edgeType: 'continue',
      confidence: 'recorded',
    });
    expect(JSON.parse(edges[0]?.metadataJson ?? '{}')).toMatchObject({ reason: 'recycle' });

    // The snapshot records the recycle as a STATE notice (labels + numbers).
    const recycleNotice = result.snapshot.data.notices.find((notice) => notice.action === 'recycle-session');
    expect(recycleNotice).toMatchObject({ account: 'MAX_A', backend: 'claude_code' });

    // And the lineage node still exists — continuity across the recycle.
    expect(store.lineage.nodes.get(session.sessionId)).toBeDefined();
  });

  it('a session below the recycle line is NOT recycled (no edge)', async () => {
    const store = await openKernelStore({ path: ':memory:' });
    stores.push(store);
    const recorder = createLineageRecorder({ store: store.lineage, resumeLedger: store.resumeLedger });
    let n = 0;
    const host = createPtyHost({
      ledger: store.resumeLedger,
      profiles: createProfileRegistry({ aibenderHome: HOME }),
      backend: new FakePtyBackend(),
      baseEnv: { PATH: '/usr/bin', HOME },
      edges: continuationEdgesFromRecorder(recorder),
      newSessionUuid: () => `f0000000-0000-4000-8000-00000000000${(n++ % 10).toString()}`,
      forceKillAfterMs: 200,
    });
    hosts.push(host);
    const session = await host.launchAttended({
      accountLabel: 'MAX_A',
      backend: 'claude_code',
      substrate: 'pty',
      cwd: CWD,
      purpose: 'no-recycle',
    });
    const byId = new Map<string, number>([[session.sessionId, 4000]]); // warn, not recycle
    const governor = createGovernor({
      sampler: fakeSampler(byId),
      probe: fakeProbe(calm),
      recycle: { recycle: (id) => host.recycle(id).then(() => undefined) },
    });
    governor.register(claudeSession(session.sessionId, 0));
    const result = await governor.tick(1);
    expect(result.recycled).toEqual([]);
    expect(store.lineage.edges.list()).toHaveLength(0);
  });
});

// ===========================================================================
// amber/red governor flow + sacrifice notices + [X1] invariants
// ===========================================================================

describe('BE-9 governor pressure flow + [X1] invariants', () => {
  it('red pressure sheds the local model + hibernates a NON-account session; snapshot validates', async () => {
    const byId = new Map<string, number>([
      ['ses_acct', 2000],
      ['ses_oc', 800],
      ['ses_lm', 6000],
    ]);
    const evictAll = vi.fn(async () => 6_500_000_000);
    const localModel: LocalModelPort = {
      residentBytes: () => 6_500_000_000,
      evictAll,
    };
    const hibernated: string[] = [];
    const governor = createGovernor({
      sampler: fakeSampler(byId),
      probe: fakeProbe({ pressureLevel: 4, freeRamPct: 9, swapUsedBytes: 28e9, pageoutRate: 2000 }),
      localModel,
      hibernate: {
        hibernate: async (id) => {
          hibernated.push(id);
        },
      },
    });
    governor.register(claudeSession('ses_acct', 0));
    governor.register(opencodeSession('ses_oc', 0));
    governor.register(localModelSession('ses_lm'));

    const result = await governor.tick(90_100_500);

    // The local model was evicted (sacrifice-order step 1).
    expect(evictAll).toHaveBeenCalledTimes(1);
    expect(result.shedActions).toContain('shed-local-model');
    // A non-account session was hibernated; the ACCOUNT session was NOT.
    expect(hibernated).toContain('ses_oc');
    expect(hibernated).not.toContain('ses_acct');
    // The snapshot is a valid frozen resource-health read model [X2].
    const validated = validateEventsPayload(result.snapshot);
    expect(validated.ok).toBe(true);
    expect(result.snapshot.data.pressureState).toBe('red');
    // No shed/hibernate notice ever targets the claude account line.
    for (const notice of result.snapshot.data.notices) {
      if (notice.action === 'hibernate-non-account') {
        expect(notice.account).not.toBe('MAX_A');
      }
    }
  });

  it('a RED-pressure account spawn is still honored after shedding; a non-account spawn is refused ([X1])', async () => {
    const governor = createGovernor({
      sampler: fakeSampler(new Map()),
      probe: fakeProbe({ pressureLevel: 4, freeRamPct: 9, swapUsedBytes: 28e9, pageoutRate: 2000 }),
    });
    await governor.tick(1); // establish red pressure
    expect(governor.pressureState()).toBe('red');
    expect(governor.admitSpawnNow(true)).toEqual({ admit: true }); // account: honored
    expect(governor.admitSpawnNow(false)).toEqual({
      admit: false,
      reason: 'red-pressure-non-account',
    });
  });

  it('amber pressure sheds no session and hibernates nothing (light levers only)', async () => {
    const governor = createGovernor({
      sampler: fakeSampler(new Map([['ses_oc', 500]])),
      probe: fakeProbe({ ...calm, pressureLevel: 2 }),
      localModel: { residentBytes: () => 6e9, evictAll: async () => 0, shedContext: vi.fn() },
      hibernate: { hibernate: vi.fn() },
    });
    governor.register(opencodeSession('ses_oc', 0));
    const result = await governor.tick(1);
    expect(result.hibernated).toEqual([]);
    expect(result.shedActions).not.toContain('shed-local-model');
    expect(result.shedActions).toContain('shed-model-context');
    expect(result.snapshot.data.pressureState).toBe('amber');
  });

  it('idle hibernation never touches an account session (edge [X1])', async () => {
    const hibernated: string[] = [];
    const governor = createGovernor({
      sampler: fakeSampler(new Map()),
      probe: fakeProbe(calm),
      hibernate: {
        hibernate: async (id) => {
          hibernated.push(id);
        },
      },
      idleWindowMs: 1000,
    });
    governor.register(claudeSession('ses_acct', 0));
    governor.register(opencodeSession('ses_oc', 0));
    // Both idle for 2 s (past the 1 s window).
    governor.noteActivity('ses_acct', 0);
    governor.noteActivity('ses_oc', 0);
    const result = await governor.tick(2000);
    expect(hibernated).toEqual(['ses_oc']); // account excluded [X1]
    const ocFootprint = result.snapshot.data.sessions.find((s) => s.backend === 'opencode');
    expect(ocFootprint?.hibernated).toBe(true);
  });

  it('the snapshot carries labels + numbers only — no session id, cwd, or title [X2]', async () => {
    const governor = createGovernor({
      sampler: fakeSampler(new Map([['ses_acct', 2100]])),
      probe: fakeProbe(calm),
    });
    governor.register(claudeSession('ses_acct', 0));
    const result = await governor.tick(1);
    const json = JSON.stringify(result.snapshot);
    expect(json).not.toContain('ses_acct'); // the harness id never rides the wire
    expect(json).not.toContain(CWD);
    // The session footprint carries only account label + backend + slot ordinal.
    expect(result.snapshot.data.sessions[0]).toEqual({
      account: 'MAX_A',
      backend: 'claude_code',
      slot: 0,
      footprintMb: 2100,
      band: 'ok',
    });
  });

  it('a no-signal pressure probe surfaces no-signal freshness, never a fabricated normal', async () => {
    const governor = createGovernor({
      sampler: fakeSampler(new Map()),
      probe: fakeProbe(undefined),
    });
    const result = await governor.tick(1);
    // No reading → default source freshness is no-signal.
    expect(result.snapshot.sources[0]?.state).toBe('no-signal');
    // pressureState defaults to normal (the last known state) but the freshness
    // entry tells the FE the feed is absent — never a fabricated healthy zero.
    expect(validateEventsPayload(result.snapshot).ok).toBe(true);
  });

  it('activity un-hibernates a session (deregister/noteActivity bookkeeping)', async () => {
    const governor = createGovernor({
      sampler: fakeSampler(new Map()),
      probe: fakeProbe(calm),
      hibernate: { hibernate: async () => undefined },
      idleWindowMs: 1000,
    });
    governor.register(opencodeSession('ses_oc', 0));
    governor.noteActivity('ses_oc', 0);
    await governor.tick(2000);
    expect(governor.hibernatedIds()).toContain('ses_oc');
    governor.noteActivity('ses_oc', 2000); // the FE woke it
    expect(governor.hibernatedIds()).not.toContain('ses_oc');
  });
});
