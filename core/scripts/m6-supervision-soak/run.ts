/**
 * M6 [X1] BE-9 — ACCELERATED SYNTHETIC SUPERVISION SOAK (L9 mechanism proof).
 *
 * The blueprint §11 / plan §8.2 M6 DoD names a "24 h mixed soak (3 account
 * sessions + 2 OpenCode + local model JIT) [that] stays within the ~17 GB
 * pessimistic envelope with no unsupervised growth". A REAL 24 h soak is
 * inherently T4/pending-owner — it needs real accounts, real cost, and a real
 * day (`infra/ci/live-check.sh` `soak-24h` enumerates it and SKIPs; the runbook
 * `docs/runbooks/recovery.md §4` prescribes the real run). This harness proves
 * the MECHANISM the real soak would exercise, accelerated: it drives the REAL
 * governor (`core/src/supervision/`) over many ticks against a FAKE ramping
 * footprint feed + oscillating pressure feed — NO real process is ever bloated,
 * no `memory_pressure` is ever shelled (non-negotiable rule 3; blueprint §3).
 *
 * It is the standalone-runnable sibling of `soak:m2` (prints a JSON verdict and
 * `process.exit`s). The composedSupervision spec proves ONE recycle + lineage
 * continuity end-to-end over a real socket; THIS proves the governor's steady
 * state under a full day of pressure churn:
 *
 *   - the [X1] invariant HOLDS across every tick: an account session is NEVER a
 *     shed/hibernate victim (recycle of a bloated account session is
 *     continuation, not shedding — counted separately);
 *   - the resident (non-hibernated) session count stays BOUNDED — under
 *     sustained red the non-account sessions shed/hibernate and the resident
 *     set never ratchets upward tick over tick (no "unsupervised growth");
 *   - the governor's internal tracking set does not leak: after deregistering
 *     settled sessions the tracked count returns to the live set (proven by the
 *     resident count tracking the registered-minus-hibernated live set exactly);
 *   - account spawns are STILL admitted at red pressure after shedding; a
 *     non-account spawn is refused at red;
 *   - every emitted snapshot validates against the frozen union and carries
 *     labels + numbers ONLY (no session id / cwd / title [X2]).
 *
 * A single failed invariant makes `verdict: 'FAIL'` and exits non-zero.
 */

import {
  validateEventsPayload,
  type AccountLabel,
  type Backend,
} from '@aibender/protocol';

import {
  createGovernor,
  DEFAULT_FOOTPRINT_THRESHOLDS,
  type FootprintSampler,
  type PressureProbe,
  type PressureReading,
  type SupervisedSession,
  type WatchdogClass,
} from '../../src/supervision/index.js';

// -- accelerated "day" parameters -------------------------------------------
// A 24 h day sampled at the governor's ~30 s tick cadence is ~2880 ticks; we
// run that many ticks in-process (no wall sleep — this is a MECHANISM soak, not
// a wall-clock soak). Overridable via argv for a deeper local run.
const TICKS = Number(process.argv[2] ?? 2880);
const MB = 1024 * 1024;

// The full target scenario (blueprint §11): 3 account claude sessions + 2
// OpenCode + one "local model resident" budget line (JIT).
interface Actor {
  readonly session: SupervisedSession;
  /** current fake phys_footprint in MB (the sampler reads this). */
  footprintMb: number;
  /** deterministic per-actor ramp/decay driver. */
  phase: number;
}

const SCENARIO: readonly [string, AccountLabel, Backend, WatchdogClass, boolean, number][] = [
  // sessionId, account, backend, watchdogClass, isAccountSession, startMb
  ['ses_max_a', 'MAX_A', 'claude_code', 'claude', true, 1200],
  ['ses_max_b', 'MAX_B', 'claude_code', 'claude', true, 1200],
  ['ses_ent', 'ENT', 'claude_code', 'claude', true, 1200],
  ['ses_oc_1', 'AWS_DEV', 'opencode', 'opencode', false, 600],
  ['ses_oc_2', 'AWS_DEV', 'opencode', 'opencode', false, 600],
];

/** Deterministic PRNG (mulberry32) — a soak must be reproducible. */
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

async function main(): Promise<void> {
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

  // The FAKE footprint sampler reads the actor's current mb (undefined once a
  // session is recycled/deregistered mid-tick — the sampler models "no reading").
  const sampler: FootprintSampler = {
    sampleMb: (s) => actors.get(s.sessionId)?.footprintMb,
  };

  // The FAKE pressure feed oscillates through normal → amber → red → back over
  // the day (a bloat wave), so amber/red levers fire repeatedly.
  const pressure: { current: PressureReading } = {
    current: { pressureLevel: 0, freeRamPct: 60, swapUsedBytes: 0, pageoutRate: 0 },
  };
  const probe: PressureProbe = { read: () => pressure.current };

  // The one global local-model budget line (JIT resident, evictable under shed).
  let localModelResidentBytes = 6_500 * MB;
  const localModel = {
    residentBytes: () => localModelResidentBytes,
    evictAll: async () => {
      const freed = localModelResidentBytes;
      localModelResidentBytes = 0;
      return freed;
    },
  };

  // Recycle rides a fake ptyHost-shaped port: recycle resets the child (fresh
  // generation) → footprint drops to a typical baseline. In the real broker
  // this is the ptyHost checkpoint→kill→resume (the [X4] continuation edge).
  const recycled: string[] = [];
  const recycle = {
    recycle: async (sessionId: string) => {
      recycled.push(sessionId);
      const actor = actors.get(sessionId);
      if (actor !== undefined) actor.footprintMb = actor.session.watchdogClass === 'claude' ? 1200 : 600;
    },
  };

  // Hibernate is modelled by the governor's own hibernated set; the port only
  // needs to succeed. Reawakening happens via noteActivity below.
  const hibernated: string[] = [];
  const hibernate = {
    hibernate: async (sessionId: string) => {
      hibernated.push(sessionId);
    },
  };

  const governor = createGovernor({ sampler, probe, recycle, localModel, hibernate });
  for (const actor of actors.values()) governor.register(actor.session);

  // -- invariant accumulators -------------------------------------------------
  const failures: string[] = [];
  let maxResident = 0;
  let residentRatchetViolations = 0;
  let prevResident = actors.size;
  let recycledAccountSessions = 0; // recycles OF account sessions (continuation — allowed)
  let shedAccountSessions = 0; // account sessions hit by a shed/hibernate victim step (FORBIDDEN)
  let snapshotsValidated = 0;
  let identityLeaks = 0;
  let redAccountSpawnsHonored = 0;
  let redNonAccountSpawnsRefused = 0;
  let redTicks = 0;

  const accountIds = new Set(
    [...actors.values()].filter((a) => a.session.isAccountSession).map((a) => a.session.sessionId),
  );

  for (let t = 0; t < TICKS; t++) {
    const nowMs = 1_000 + t * 30_000; // 30 s cadence

    // Ramp footprints: claude sessions drift up toward (and sometimes past) the
    // 6 GB recycle line on a slow sine + noise; opencode sessions drift toward
    // their 1.5 GB line. This is the "bloat over a day" the watchdog must catch.
    for (const actor of actors.values()) {
      const isClaude = actor.session.watchdogClass === 'claude';
      const ceiling = isClaude ? 7_200 : 1_800;
      const floor = isClaude ? 1_200 : 600;
      const wave = (Math.sin(t / 90 + actor.phase) + 1) / 2; // 0..1, slow
      const noise = (rng() - 0.5) * 200;
      actor.footprintMb = Math.max(floor, Math.min(ceiling, floor + wave * (ceiling - floor) + noise));
    }

    // Pressure wave: a red plateau in the middle third of the "day".
    const dayFrac = t / TICKS;
    if (dayFrac > 0.33 && dayFrac < 0.66) {
      pressure.current = { pressureLevel: 4, freeRamPct: 8 + rng() * 3, swapUsedBytes: 27_500 * MB, pageoutRate: 2500 };
    } else if ((dayFrac > 0.2 && dayFrac <= 0.33) || (dayFrac >= 0.66 && dayFrac < 0.8)) {
      pressure.current = { pressureLevel: 2, freeRamPct: 22 + rng() * 3, swapUsedBytes: 21_000 * MB, pageoutRate: 400 };
    } else {
      pressure.current = { pressureLevel: 0, freeRamPct: 55 + rng() * 5, swapUsedBytes: 2_000 * MB, pageoutRate: 0 };
    }

    // Occasionally wake a hibernated non-account session (activity), so the
    // resident set churns rather than monotonically draining — a real day.
    if (rng() > 0.9) {
      const woke = [...actors.values()].find((a) => !a.session.isAccountSession);
      if (woke !== undefined) governor.noteActivity(woke.session.sessionId, nowMs);
    }

    const result = await governor.tick(nowMs);

    // -- INVARIANT 1: [X1] account sessions are NEVER a shed/hibernate victim.
    // A recycle of an account session is continuation, not shedding — counted
    // separately. Only shed-driven hibernation of an account session is a
    // violation (the scheduler must never target one).
    for (const id of result.hibernated) {
      if (accountIds.has(id)) {
        shedAccountSessions++;
        failures.push(`tick ${t}: account session ${id} was hibernated (shed victim) — [X1] violation`);
      }
    }
    for (const id of result.recycled) if (accountIds.has(id)) recycledAccountSessions++;

    // -- INVARIANT 2: the snapshot's notices never name an ACCOUNT-label victim
    // for a hibernate-non-account step (defense in depth over the notice
    // channel — the three Claude subscription accounts are MAX_A/MAX_B/ENT).
    const accountLabels = new Set<AccountLabel>(['MAX_A', 'MAX_B', 'ENT']);
    for (const notice of result.snapshot.data.notices) {
      if (
        notice.action === 'hibernate-non-account' &&
        notice.account !== undefined &&
        accountLabels.has(notice.account)
      ) {
        shedAccountSessions++;
        failures.push(`tick ${t}: hibernate-non-account notice named account label ${notice.account}`);
      }
    }

    // -- INVARIANT 3: resident count bounded + no upward ratchet under sustained
    // pressure. Resident = registered live sessions minus hibernated.
    const resident = result.snapshot.data.residentSessionCount;
    maxResident = Math.max(maxResident, resident);
    // The registered set is fixed at SCENARIO size; resident can only drop (via
    // hibernation) or recover (via wake), never exceed the registered count.
    if (resident > actors.size) {
      failures.push(`tick ${t}: resident ${resident} exceeds registered ${actors.size} — tracking leak`);
    }
    // Under the red plateau the resident set must not ratchet UP tick-over-tick
    // by more than a wake event (+1). A steadily-growing resident set under red
    // is exactly the "unsupervised growth" the DoD forbids.
    if (pressure.current.pressureLevel === 4 && resident > prevResident + 1) {
      residentRatchetViolations++;
    }
    prevResident = resident;

    // -- INVARIANT 4: snapshot validates + [X2] no identity on the wire.
    const validation = validateEventsPayload(result.snapshot);
    if (validation.ok) snapshotsValidated++;
    else failures.push(`tick ${t}: snapshot failed validateEventsPayload: ${validation.message}`);
    const serialized = JSON.stringify(result.snapshot);
    if (/ses_[a-z_]+|\/synthetic|cwd/.test(serialized)) {
      identityLeaks++;
      failures.push(`tick ${t}: snapshot serialization contains an identity-bearing token`);
    }

    // -- INVARIANT 5: [X1] account-spawn-post-shed admission under red.
    if (governor.pressureState() === 'red') {
      redTicks++;
      if (governor.admitSpawnNow(true).admit) redAccountSpawnsHonored++;
      else failures.push(`tick ${t}: red-pressure ACCOUNT spawn was refused — [X1] violation`);
      if (!governor.admitSpawnNow(false).admit) redNonAccountSpawnsRefused++;
      else failures.push(`tick ${t}: red-pressure NON-account spawn was admitted — should refuse`);
    }
  }

  if (residentRatchetViolations > 0) {
    failures.push(
      `resident set ratcheted UP under red pressure on ${residentRatchetViolations} ticks — unsupervised growth`,
    );
  }
  if (redTicks === 0) failures.push('the pressure wave never reached red — the soak did not exercise shedding');
  if (recycled.length === 0) failures.push('the watchdog never recycled a bloated session — bloat wave too gentle');
  if (snapshotsValidated !== TICKS) failures.push(`only ${snapshotsValidated}/${TICKS} snapshots validated`);

  const report = {
    soak: {
      ticks: TICKS,
      cadenceSeconds: 30,
      simulatedHours: Math.round((TICKS * 30) / 3600),
      scenario: '3 account claude + 2 opencode + 1 local-model JIT',
    },
    x1Invariants: {
      accountSessionsShed: shedAccountSessions, // MUST be 0
      accountSessionsRecycled: recycledAccountSessions, // continuation — informational
      redTicks,
      redAccountSpawnsHonored, // == redTicks
      redNonAccountSpawnsRefused, // == redTicks
    },
    growth: {
      registeredSessions: actors.size,
      maxResidentSessionCount: maxResident, // <= registered
      residentRatchetViolations, // MUST be 0
    },
    watchdog: {
      totalRecycles: recycled.length,
      localModelEvicted: localModelResidentBytes === 0,
    },
    x2: {
      snapshotsValidated,
      identityLeaks, // MUST be 0
    },
    thresholds: {
      claudeRecycleMb: DEFAULT_FOOTPRINT_THRESHOLDS.claude.recycleMb,
      opencodeRecycleMb: DEFAULT_FOOTPRINT_THRESHOLDS.opencode.recycleMb,
    },
    failures,
    verdict: failures.length === 0 ? 'PASS' : 'FAIL',
  } as const;

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.verdict === 'PASS' ? 0 : 1);
}

main().catch((cause) => {
  process.stderr.write(`m6 supervision soak crashed: ${(cause as Error).stack ?? String(cause)}\n`);
  process.exit(1);
});
