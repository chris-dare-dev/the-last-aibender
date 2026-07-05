/**
 * THE SUPERVISION GOVERNOR (BE-9; plan §4/BE-9, blueprint §11) — the tick loop
 * that fuses every supervision signal into one action pass + the frozen
 * `resource-health` snapshot.
 *
 * On each `tick(nowMs)`:
 *   1. footprint watchdog bands every registered session (watchdog.ts);
 *   2. any session whose band is `recycle` is RECYCLED through the injected
 *      {@link RecyclePort} — BE-2's ptyHost checkpoint→kill→resume, which
 *      records a `continue` edge on the lineage store (the [X4] continuation
 *      mechanism; recycle IS the account continuation path, so a claude
 *      account session MAY be recycled — that is NOT a "shed", it is the
 *      hardening recycle);
 *   3. the pressure monitor derives the amber/red band (pressureProbe.ts);
 *   4. under amber/red the scheduler plans the [X1] sacrifice order
 *      (scheduler.ts) and the governor executes each step through its ports
 *      (evict the local model, shed frontend weight, hibernate NON-account
 *      sessions) — account sessions are NEVER a shed victim;
 *   5. idle sessions past the 30-min window are hibernated (hibernation.ts) —
 *      never account sessions;
 *   6. a {@link ResourceHealthSnapshot} is assembled (labels + numbers only
 *      [X2]) and returned for publication.
 *
 * SPAWN ADMISSION ([X1]): {@link admitSpawnNow} exposes the scheduler's
 * admission rule against the CURRENT pressure — an account spawn is always
 * honored, a non-account spawn is refused only at red. The composition root
 * calls this before every kernel spawn.
 *
 * The governor is PURE-ish: every side effect goes through an injected port
 * (recycle, evict-model, shed-frontend, hibernate) so tests drive it with
 * fakes and NOTHING here bloats a process or issues a cost-incurring call. The
 * telemetry ports (sampler, pressure probe) are the FAKE-in-tests seam.
 */

import type {
  AccountLabel,
  Backend,
  ResourceHealthSnapshot,
  ShedNotice,
  SourceFreshness,
} from '@aibender/protocol';
import type { Logger } from '@aibender/shared';

import { createFootprintWatchdog, type FootprintWatchdog } from './watchdog.js';
import { planIdleHibernation } from './hibernation.js';
import { createPressureMonitor, type PressureMonitor, type PressureState } from './pressureProbe.js';
import {
  admitSpawn,
  planShed,
  type ShedAction,
  type SpawnAdmission,
} from './scheduler.js';
import {
  DEFAULT_IDLE_HIBERNATION_MS,
  type FootprintSampler,
  type FootprintThresholds,
  type PressureProbe,
  type PressureThresholds,
  type SupervisedSession,
  type WatchdogClass,
} from './types.js';

// ---------------------------------------------------------------------------
// Side-effect ports (all injected — fakes in tests)
// ---------------------------------------------------------------------------

/**
 * The recycle port: BE-2's ptyHost checkpoint→kill→resume, which records the
 * [X4] `continue` edge (ptyHost.recycle → ContinuationEdgeEmitter →
 * LineageRecorder). The governor calls this when the watchdog bands a session
 * `recycle`; the continuation edge is recorded BY THAT PATH (the governor does
 * not touch the lineage store itself). NEVER throws to the governor.
 */
export interface RecyclePort {
  /** Recycle a live session; the [X4] continue edge is recorded downstream. */
  recycle(sessionId: string): Promise<void>;
}

/**
 * The local-model eviction port — the residency ledger's verified-unload path
 * (BE-4 lmstudio residency.ts). Shedding the local model is step 1 of the
 * [X1] sacrifice order (the biggest single line). Returns the freed bytes (0
 * when nothing was resident). NEVER throws.
 */
export interface LocalModelPort {
  /** Currently-resident local model bytes across LM Studio + Ollama (0 if none). */
  residentBytes(): number;
  /** Evict all idle residents (verified unload). Returns freed bytes. */
  evictAll(): Promise<number>;
  /** Drop the resident model's KV/context (shorten TTL / ctx) — amber step 2. */
  shedContext?(): void;
}

/** The frontend-weight shed port (step 3): ask the FE to cap scrollback etc. */
export interface FrontendWeightPort {
  shedWeight(): void;
}

/** The hibernate port (step 4 + idle): suspend a NON-account session. */
export interface HibernatePort {
  hibernate(sessionId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Options + surface
// ---------------------------------------------------------------------------

export interface GovernorOptions {
  readonly sampler: FootprintSampler;
  readonly probe: PressureProbe;
  /** The recycle path (ptyHost). Absent → recycle bands are logged, not acted. */
  readonly recycle?: RecyclePort;
  /** The local-model budget port. Absent → localModelResidentBytes omitted. */
  readonly localModel?: LocalModelPort;
  readonly frontend?: FrontendWeightPort;
  readonly hibernate?: HibernatePort;
  /** Per-class footprint threshold overrides. */
  readonly footprintThresholds?: Partial<Record<WatchdogClass, FootprintThresholds>>;
  readonly pressureThresholds?: Partial<PressureThresholds>;
  /** Watchdog de-escalation margin, MB. */
  readonly hysteresisMb?: number;
  /** Idle-hibernation window ms. Default 30 min. */
  readonly idleWindowMs?: number;
  /**
   * OS-4: the resident-account SOFT ceiling (generalizes the blueprint §11
   * "3 account sessions" budget to N). At/above it, {@link Governor.admitSpawnNow}
   * still admits an account spawn ([X1] absolute) but flags an amber advisory.
   * Absent → no ceiling evaluated (the M6 3-account behavior exactly).
   */
  readonly residentAccountSoftCeiling?: number;
  /**
   * OS-4: consecutive RED ticks after which IDLE account sessions become
   * eligible for reversible CHECKPOINT hibernation (never a shed). Requires a
   * `hibernate` port. Default 0 = DISABLED (account sessions never
   * auto-hibernate — the M6 rule). A positive value enables the sustained-RED
   * relief; e.g. 3 ticks at a ~30 s cadence ≈ 90 s of sustained red.
   */
  readonly sustainedRedTicksForAccountHibernation?: number;
  /** Freshness of the supervision feed for the snapshot's `sources` array. */
  readonly sources?: readonly SourceFreshness[];
  readonly logger?: Logger;
}

/** The result of one governor tick — the snapshot + what it did. */
export interface GovernorTickResult {
  readonly snapshot: ResourceHealthSnapshot;
  readonly recycled: readonly string[];
  readonly hibernated: readonly string[];
  readonly shedActions: readonly ShedAction[];
}

export interface Governor {
  /** Register a live session (idempotent by session id). */
  register(session: SupervisedSession): void;
  /** Deregister a settled/recycled session (also forgets watchdog state). */
  deregister(sessionId: string): void;
  /** Record a session's activity (feeds idle hibernation). */
  noteActivity(sessionId: string, atEpochMs: number): void;
  /** Run one supervision pass; returns the snapshot + actions taken. */
  tick(nowMs: number): Promise<GovernorTickResult>;
  /** [X1] spawn admission against the current pressure. */
  admitSpawnNow(isAccountSpawn: boolean): SpawnAdmission;
  /** The current pressure state (last tick). */
  pressureState(): PressureState;
  /** Currently-hibernated session ids. */
  hibernatedIds(): readonly string[];
}

const MB = 1024 * 1024;

export function createGovernor(options: GovernorOptions): Governor {
  const watchdog: FootprintWatchdog = createFootprintWatchdog({
    sampler: options.sampler,
    ...(options.footprintThresholds !== undefined ? { thresholds: options.footprintThresholds } : {}),
    ...(options.hysteresisMb !== undefined ? { hysteresisMb: options.hysteresisMb } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
  const pressure: PressureMonitor = createPressureMonitor({
    probe: options.probe,
    ...(options.pressureThresholds !== undefined ? { thresholds: options.pressureThresholds } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
  const idleWindowMs = options.idleWindowMs ?? DEFAULT_IDLE_HIBERNATION_MS;

  const sessions = new Map<string, SupervisedSession>();
  const lastActivityMs = new Map<string, number>();
  const hibernated = new Set<string>();
  let lastPressure: PressureState = 'normal';
  /** OS-4: consecutive RED ticks (for the sustained-RED account-hibernation gate). */
  let consecutiveRedTicks = 0;
  const accountHibernationRedTicks = options.sustainedRedTicksForAccountHibernation ?? 0;

  /** Resolve a session's wire target fields (account/backend) for a notice. */
  const targetOf = (sessionId: string): { account?: AccountLabel; backend?: Backend } => {
    const s = sessions.get(sessionId);
    return s === undefined ? {} : { account: s.account, backend: s.backend };
  };

  const tick = async (nowMs: number): Promise<GovernorTickResult> => {
    const live = [...sessions.values()];
    const recycled: string[] = [];
    const hibernatedNow: string[] = [];
    const shedActions: ShedAction[] = [];
    const notices: ShedNotice[] = [];

    // 1. + 2. footprint watchdog + recycle band → recycle path (records the
    //    [X4] continue edge downstream).
    const verdicts = watchdog.evaluate(live, nowMs);
    const bandById = new Map(verdicts.map((v) => [v.sessionId, v]));
    for (const verdict of verdicts) {
      if (verdict.band !== 'recycle') continue;
      if (options.recycle === undefined) {
        options.logger?.warn('recycle band with no recycle port (not acted)', {
          slot: sessions.get(verdict.sessionId)?.slot,
        });
        continue;
      }
      try {
        await options.recycle.recycle(verdict.sessionId);
        recycled.push(verdict.sessionId);
        notices.push({ action: 'recycle-session', at: nowMs, ...targetOf(verdict.sessionId) });
        // A recycled session's watchdog window resets (fresh child generation).
        watchdog.forget(verdict.sessionId);
      } catch (cause) {
        options.logger?.error('recycle port failed (snapshot unaffected)', {
          slot: sessions.get(verdict.sessionId)?.slot,
          detail: (cause as Error).message,
        });
      }
    }

    // 3. pressure band.
    const pressureVerdict = pressure.evaluate();
    lastPressure = pressureVerdict.state;
    // OS-4: track sustained RED for the account-checkpoint-hibernation gate.
    consecutiveRedTicks = lastPressure === 'red' ? consecutiveRedTicks + 1 : 0;

    // 4. sacrifice order under amber/red.
    const localModelResident = (options.localModel?.residentBytes() ?? 0) > 0;
    const shedPlan = planShed({
      pressure: lastPressure,
      sessions: live,
      localModelResident,
      alreadyHibernated: hibernated,
    });
    for (const step of shedPlan) {
      shedActions.push(step.action);
      switch (step.action) {
        case 'shed-local-model': {
          try {
            const freed = (await options.localModel?.evictAll()) ?? 0;
            options.logger?.info('shed local model', { freedMb: Math.round(freed / MB) });
          } catch (cause) {
            options.logger?.error('local-model evict failed', { detail: (cause as Error).message });
          }
          notices.push({ action: 'shed-local-model', at: nowMs });
          break;
        }
        case 'shed-model-context':
          try {
            options.localModel?.shedContext?.();
          } catch (cause) {
            options.logger?.warn('shed model context failed', { detail: (cause as Error).message });
          }
          notices.push({ action: 'shed-model-context', at: nowMs });
          break;
        case 'shed-frontend-weight':
          try {
            options.frontend?.shedWeight();
          } catch (cause) {
            options.logger?.warn('shed frontend weight failed', { detail: (cause as Error).message });
          }
          notices.push({ action: 'shed-frontend-weight', at: nowMs });
          break;
        case 'hibernate-non-account': {
          // The scheduler already guaranteed a NON-account target; the port
          // call + notice carry the affected line.
          const id = step.sessionId;
          if (id === undefined) break;
          try {
            await options.hibernate?.hibernate(id);
            hibernated.add(id);
            hibernatedNow.push(id);
            notices.push({ action: 'hibernate-non-account', at: nowMs, ...targetOf(id) });
          } catch (cause) {
            options.logger?.error('hibernate failed (shed step)', {
              slot: sessions.get(id)?.slot,
              detail: (cause as Error).message,
            });
          }
          break;
        }
        case 'trim-scrollback':
          notices.push({ action: 'trim-scrollback', at: nowMs });
          break;
        case 'recycle-session':
          // never emitted by planShed
          break;
      }
    }

    // 5. idle hibernation (never account sessions — UNLESS OS-4 sustained-RED
    //    account CHECKPOINT hibernation is enabled and we are past the RED-tick
    //    threshold; even then it is a reversible checkpoint, never a shed, and
    //    it needs a hibernate port to be actionable).
    const allowAccountUnderRed =
      accountHibernationRedTicks > 0 &&
      lastPressure === 'red' &&
      consecutiveRedTicks >= accountHibernationRedTicks &&
      options.hibernate !== undefined;
    const idleCandidates = planIdleHibernation({
      sessions: live,
      lastActivityMs,
      nowMs,
      alreadyHibernated: hibernated,
      idleWindowMs,
      allowAccountUnderRed,
    });
    for (const candidate of idleCandidates) {
      try {
        await options.hibernate?.hibernate(candidate.sessionId);
        hibernated.add(candidate.sessionId);
        hibernatedNow.push(candidate.sessionId);
        // OS-4: a NON-account idle hibernation is a shed-vocabulary notice; an
        // account CHECKPOINT hibernation is NOT a shed (the SHED_ACTIONS wire
        // vocab is frozen and account sessions are never sheds), so it is
        // recorded in the return set + logged, with no shed notice on the wire.
        if (candidate.isAccount) {
          options.logger?.info('account session checkpoint-hibernated under sustained RED [X1]', {
            slot: sessions.get(candidate.sessionId)?.slot,
            consecutiveRedTicks,
          });
        } else {
          notices.push({
            action: 'hibernate-non-account',
            at: nowMs,
            ...targetOf(candidate.sessionId),
          });
        }
      } catch (cause) {
        options.logger?.error('idle hibernate failed', {
          slot: sessions.get(candidate.sessionId)?.slot,
          detail: (cause as Error).message,
        });
      }
    }

    // 6. assemble the frozen resource-health snapshot (labels + numbers [X2]).
    const reading = pressureVerdict.reading;
    const residentSessionCount = live.filter((s) => !hibernated.has(s.sessionId)).length;
    const footprints = live.map((s) => {
      const verdict = bandById.get(s.sessionId);
      return {
        account: s.account,
        backend: s.backend,
        slot: s.slot,
        footprintMb: Math.round(verdict?.footprintMb ?? 0),
        band: verdict?.band ?? 'ok',
        ...(hibernated.has(s.sessionId) ? { hibernated: true } : {}),
      };
    });
    const localModelBytes = options.localModel?.residentBytes();

    const snapshot: ResourceHealthSnapshot = {
      kind: 'read-model-snapshot',
      readModel: 'resource-health',
      capturedAt: nowMs,
      sources:
        options.sources ??
        ([{ source: 'lmstudio', state: reading === undefined ? 'no-signal' : 'fresh', lastIngestAt: nowMs }] as const),
      data: {
        pressureLevel: reading?.pressureLevel ?? 0,
        pressureState: lastPressure,
        freeRamPct: reading?.freeRamPct ?? 0,
        swapUsedBytes: reading?.swapUsedBytes ?? 0,
        residentSessionCount,
        ...(localModelBytes !== undefined ? { localModelResidentBytes: localModelBytes } : {}),
        sessions: footprints,
        notices,
      },
    };

    return { snapshot, recycled, hibernated: hibernatedNow, shedActions };
  };

  return {
    register: (session) => {
      sessions.set(session.sessionId, session);
    },
    deregister: (sessionId) => {
      sessions.delete(sessionId);
      lastActivityMs.delete(sessionId);
      hibernated.delete(sessionId);
      watchdog.forget(sessionId);
    },
    noteActivity: (sessionId, atEpochMs) => {
      lastActivityMs.set(sessionId, atEpochMs);
      // Activity un-hibernates a session (the FE woke it).
      hibernated.delete(sessionId);
    },
    tick,
    admitSpawnNow: (isAccountSpawn) =>
      admitSpawn({
        pressure: lastPressure,
        isAccountSpawn,
        // OS-4: resident (live, non-hibernated) account count vs the soft ceiling.
        residentAccountCount: [...sessions.values()].filter(
          (s) => s.isAccountSession && !hibernated.has(s.sessionId),
        ).length,
        ...(options.residentAccountSoftCeiling !== undefined
          ? { residentAccountSoftCeiling: options.residentAccountSoftCeiling }
          : {}),
      }),
    pressureState: () => lastPressure,
    hibernatedIds: () => [...hibernated],
  };
}
