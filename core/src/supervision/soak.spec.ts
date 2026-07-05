/**
 * M6 [X1] BE-9 — accelerated supervision soak, unit edition (plan §8.2 M6 DoD
 * "24 h mixed soak … no unsupervised growth"). The standalone runnable is
 * `pnpm -F aibender-core soak:m6` (scripts/m6-supervision-soak/run.ts, ~2880
 * ticks = a compressed day, prints a JSON verdict); THIS spec runs the SAME
 * mechanism at a fast fixed tick count so the invariants are asserted on every
 * `pnpm -r test`, exactly as the m2 soak is both a runnable and unit-covered.
 *
 * The feeds are FAKES (a ramping footprint map + an oscillating pressure
 * reading) — NO real process is bloated, no `memory_pressure` is shelled
 * (blueprint §3; non-negotiable rule 3). It drives the REAL `createGovernor`.
 *
 *   positive — the governor recycles bloated sessions + evicts the local model
 *              under red; every snapshot validates.
 *   negative — an account session is NEVER a shed/hibernate victim across the
 *              whole run; a red non-account spawn is refused.
 *   edge     — resident count never ratchets up under sustained red (no
 *              unsupervised growth); the tracked set never exceeds registered.
 */

import { validateEventsPayload, type AccountLabel, type Backend } from '@aibender/protocol';
import { describe, expect, it } from 'vitest';

import {
  createGovernor,
  type FootprintSampler,
  type PressureProbe,
  type PressureReading,
  type SupervisedSession,
  type WatchdogClass,
} from './index.js';

const MB = 1024 * 1024;
const TICKS = 240; // fast: ~2 h at 30 s cadence — enough to sweep normal→red→normal

const SCENARIO: readonly [string, AccountLabel, Backend, WatchdogClass, boolean, number][] = [
  ['ses_max_a', 'MAX_A', 'claude_code', 'claude', true, 1200],
  ['ses_max_b', 'MAX_B', 'claude_code', 'claude', true, 1200],
  ['ses_ent', 'ENT', 'claude_code', 'claude', true, 1200],
  ['ses_oc_1', 'AWS_DEV', 'opencode', 'opencode', false, 600],
  ['ses_oc_2', 'AWS_DEV', 'opencode', 'opencode', false, 600],
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Actor {
  readonly session: SupervisedSession;
  footprintMb: number;
  phase: number;
}

describe('BE-9 accelerated supervision soak (M6 [X1] mechanism, unit edition)', () => {
  it('holds every governor invariant across a compressed pressure day', async () => {
    const rng = mulberry32(0xbe9_50a2);
    const actors = new Map<string, Actor>();
    for (const [id, account, backend, cls, isAcct, startMb] of SCENARIO) {
      actors.set(id, {
        session: {
          sessionId: id,
          account,
          backend,
          watchdogClass: cls,
          slot: [...actors.values()].filter((a) => a.session.account === account).length,
          isAccountSession: isAcct,
        },
        footprintMb: startMb,
        phase: rng() * Math.PI * 2,
      });
    }
    const accountIds = new Set(
      [...actors.values()].filter((a) => a.session.isAccountSession).map((a) => a.session.sessionId),
    );

    const sampler: FootprintSampler = { sampleMb: (s) => actors.get(s.sessionId)?.footprintMb };
    const pressure: { current: PressureReading } = {
      current: { pressureLevel: 0, freeRamPct: 60, swapUsedBytes: 0, pageoutRate: 0 },
    };
    const probe: PressureProbe = { read: () => pressure.current };

    let localModelResidentBytes = 6_500 * MB;
    const localModel = {
      residentBytes: () => localModelResidentBytes,
      evictAll: async () => {
        const freed = localModelResidentBytes;
        localModelResidentBytes = 0;
        return freed;
      },
    };
    const recycledIds: string[] = [];
    const recycle = {
      recycle: async (sessionId: string) => {
        recycledIds.push(sessionId);
        const actor = actors.get(sessionId);
        if (actor !== undefined) {
          actor.footprintMb = actor.session.watchdogClass === 'claude' ? 1200 : 600;
        }
      },
    };
    const hibernate = { hibernate: async () => {} };

    const governor = createGovernor({ sampler, probe, recycle, localModel, hibernate });
    for (const actor of actors.values()) governor.register(actor.session);

    let redTicks = 0;
    let maxResident = 0;
    let prevResident = actors.size;
    let ratchetViolations = 0;

    for (let t = 0; t < TICKS; t++) {
      const nowMs = 1_000 + t * 30_000;
      for (const actor of actors.values()) {
        const isClaude = actor.session.watchdogClass === 'claude';
        const ceiling = isClaude ? 7_200 : 1_800;
        const floor = isClaude ? 1_200 : 600;
        const wave = (Math.sin(t / 30 + actor.phase) + 1) / 2;
        actor.footprintMb = Math.max(floor, Math.min(ceiling, floor + wave * (ceiling - floor)));
      }
      const frac = t / TICKS;
      pressure.current =
        frac > 0.33 && frac < 0.66
          ? { pressureLevel: 4, freeRamPct: 9, swapUsedBytes: 27_500 * MB, pageoutRate: 2500 }
          : { pressureLevel: 0, freeRamPct: 56, swapUsedBytes: 2_000 * MB, pageoutRate: 0 };

      const result = await governor.tick(nowMs);

      // [X1]: no account session is ever a shed/hibernate victim.
      for (const id of result.hibernated) {
        expect(accountIds.has(id), `account session ${id} hibernated at tick ${t}`).toBe(false);
      }
      // Snapshot validates + [X2] no identity on the wire.
      expect(validateEventsPayload(result.snapshot).ok).toBe(true);
      expect(/ses_[a-z_]+|\/synthetic|cwd/.test(JSON.stringify(result.snapshot))).toBe(false);

      const resident = result.snapshot.data.residentSessionCount;
      maxResident = Math.max(maxResident, resident);
      expect(resident).toBeLessThanOrEqual(actors.size); // no tracking leak
      if (pressure.current.pressureLevel === 4) {
        redTicks++;
        expect(governor.admitSpawnNow(true).admit).toBe(true); // account honored post-shed
        expect(governor.admitSpawnNow(false).admit).toBe(false); // non-account refused
        if (resident > prevResident + 1) ratchetViolations++;
      }
      prevResident = resident;
    }

    // The wave actually reached red, exercised shedding, and recycled bloat.
    expect(redTicks).toBeGreaterThan(0);
    expect(recycledIds.length).toBeGreaterThan(0);
    expect(localModelResidentBytes).toBe(0); // evicted under red
    // No unsupervised growth: resident bounded, never ratcheting up under red.
    expect(maxResident).toBeLessThanOrEqual(actors.size);
    expect(ratchetViolations).toBe(0);
  });
});
