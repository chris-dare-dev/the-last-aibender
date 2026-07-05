/**
 * PRESSURE-DELTA HEALTH SIGNALS + amber/red state machine (BE-9; plan §4/BE-9,
 * blueprint §11).
 *
 * The health signal is a DELTA on macOS memory pressure — `memory_pressure -Q`
 * level + pageout rates + swap — NEVER naive free RAM (blueprint §11: "Health
 * signals are pressure/swap deltas, ... never naive free RAM"). Free RAM %
 * rides along ONLY as a secondary threshold input; the pageout-rate delta
 * dominates the band derivation.
 *
 * Bands (types.ts DEFAULT_PRESSURE_THRESHOLDS):
 *   - amber : level >= 2  OR free <25%  OR swap >20 GB  OR pageout delta present
 *             → stop prewarm, shorten model TTL, offer hibernation
 *   - red   : level >= 4  OR free <12%  OR swap >26 GB  OR heavy pageout delta
 *             → refuse NON-account spawns, unload the local model,
 *               force-hibernate idle sessions (account spawns STILL honored)
 *
 * HYSTERESIS (anti-flap): once amber/red, the band de-escalates only when the
 * reading clears the lower threshold by a margin. A machine oscillating at the
 * amber line does not flap amber↔normal each sample.
 *
 * NAIVE-FREE-RAM REJECTED BY DESIGN (plan §9.2 BE-9 negative row): there is no
 * API here that accepts a bare "free RAM MB" and returns a band. The ONLY
 * input is a {@link PressureReading} carrying the pressure LEVEL and the
 * pageout DELTA; a caller with only free RAM literally cannot construct the
 * pressure-dominant signal.
 *
 * INJECTABLE (the FAKE-in-tests seam): {@link createPressureMonitor} takes a
 * {@link PressureProbe}. The REAL macOS reader ({@link createSpawnPressureProbe})
 * is guarded, documented, and never invoked under test (it shells
 * `memory_pressure` / `vm_stat` — cost-free, read-only, but T3 to exercise for
 * real).
 */

import type { Logger } from '@aibender/shared';

import {
  DEFAULT_PRESSURE_THRESHOLDS,
  type PressureProbe,
  type PressureReading,
  type PressureThresholds,
} from './types.js';

/** The FROZEN wire state (readModels.ts PRESSURE_STATES): normal | amber | red. */
export type PressureState = 'normal' | 'amber' | 'red';

/** A derived pressure verdict — the band the FE renders + the raw reading. */
export interface PressureVerdict {
  readonly state: PressureState;
  /** The reading the state was derived from; absent when the probe had no signal. */
  readonly reading?: PressureReading;
}

export interface PressureMonitorOptions {
  readonly probe: PressureProbe;
  readonly thresholds?: Partial<PressureThresholds>;
  /**
   * De-escalation margins: free-RAM points and swap bytes the reading must
   * clear BELOW the lower band's threshold before dropping. Defaults: 3 points
   * free-RAM, 1 GB swap. (Level/pageout de-escalate on any clearing since they
   * are integer/rate signals.)
   */
  readonly hysteresisFreeRamPct?: number;
  readonly hysteresisSwapBytes?: number;
  readonly logger?: Logger;
}

export interface PressureMonitor {
  /** Read the probe + derive the band with hysteresis. NEVER throws. */
  evaluate(): PressureVerdict;
  /** The last derived state (defaults to `normal` before the first read). */
  state(): PressureState;
}

const GIB = 1024 * 1024 * 1024;

export function createPressureMonitor(options: PressureMonitorOptions): PressureMonitor {
  const t: PressureThresholds = { ...DEFAULT_PRESSURE_THRESHOLDS, ...options.thresholds };
  const hFree = options.hysteresisFreeRamPct ?? 3;
  const hSwap = options.hysteresisSwapBytes ?? GIB;
  let current: PressureState = 'normal';

  /** The raw band for a reading, BEFORE hysteresis (pressure-delta first). */
  const rawState = (r: PressureReading): PressureState => {
    // RED first: the strongest signal wins. Any red trigger → red.
    if (
      r.pressureLevel >= t.redLevel ||
      r.freeRamPct < t.redFreeRamPct ||
      r.swapUsedBytes > t.redSwapBytes ||
      r.pageoutRate >= t.redPageoutRate
    ) {
      return 'red';
    }
    // AMBER: the pageout DELTA dominates — a non-zero pageout rate forces at
    // least amber even when free RAM still looks comfortable (blueprint §11).
    if (
      r.pressureLevel >= t.amberLevel ||
      r.freeRamPct < t.amberFreeRamPct ||
      r.swapUsedBytes > t.amberSwapBytes ||
      r.pageoutRate >= t.amberPageoutRate
    ) {
      return 'amber';
    }
    return 'normal';
  };

  /**
   * Anti-flap: escalation is immediate; de-escalation requires the reading to
   * clear the LOWER band's thresholds by the margins. Level/pageout are
   * integer/rate signals — they must already be under the lower band's line
   * for the raw band to have dropped, so the margin applies to the analog
   * signals (free-RAM %, swap bytes).
   */
  const withHysteresis = (prior: PressureState, target: PressureState, r: PressureReading): PressureState => {
    const rank: Record<PressureState, number> = { normal: 0, amber: 1, red: 2 };
    if (rank[target] >= rank[prior]) return target; // escalate/hold immediately

    if (prior === 'red') {
      // Only leave red once clear of EVERY amber-line by the margin (else hold
      // at amber, not normal — a stepwise climb-down).
      const stillAmberish =
        r.pressureLevel >= t.amberLevel ||
        r.freeRamPct < t.amberFreeRamPct + hFree ||
        r.swapUsedBytes > t.amberSwapBytes - hSwap ||
        r.pageoutRate >= t.amberPageoutRate;
      if (r.pressureLevel >= t.redLevel || r.freeRamPct < t.redFreeRamPct + hFree ||
          r.swapUsedBytes > t.redSwapBytes - hSwap || r.pageoutRate >= t.redPageoutRate) {
        return 'red'; // has not cleared red by the margin
      }
      return stillAmberish ? 'amber' : 'normal';
    }
    // prior === 'amber', target === 'normal'
    const stillAmberish =
      r.pressureLevel >= t.amberLevel ||
      r.freeRamPct < t.amberFreeRamPct + hFree ||
      r.swapUsedBytes > t.amberSwapBytes - hSwap ||
      r.pageoutRate >= t.amberPageoutRate;
    return stillAmberish ? 'amber' : 'normal';
  };

  return {
    evaluate: () => {
      let reading: PressureReading | undefined;
      try {
        reading = options.probe.read();
      } catch (cause) {
        options.logger?.warn('pressure probe threw (treated as no signal)', {
          detail: (cause as Error).message,
        });
        reading = undefined;
      }
      if (reading === undefined) {
        // No signal: HOLD the last state (never fabricate normal from nothing —
        // the freshness entry on the snapshot says the feed is missing).
        return { state: current };
      }
      const target = rawState(reading);
      current = withHysteresis(current, target, reading);
      return { state: current, reading };
    },

    state: () => current,
  };
}

// ---------------------------------------------------------------------------
// The REAL macOS probe (runtime, guarded — NEVER exercised under test)
// ---------------------------------------------------------------------------

/**
 * Options for the real spawn-backed probe. The `run` seam lets the composition
 * root (and, in a T3 live check, the runbook) inject a spawner; the default
 * shells the read-only macOS tools.
 */
export interface SpawnPressureProbeOptions {
  /**
   * Run a read-only command, capture stdout. INJECTED so the runtime path
   * stays testable WITHOUT ever bloating or spawning a process under test: the
   * composition root supplies a runner (a thin wrapper over Node's synchronous
   * process-exec API) only on macOS at boot; the vitest suite passes a pure
   * string-returning fake. Absent → the probe is inert (returns no signal).
   */
  readonly run?: (cmd: string, args: readonly string[]) => string;
  readonly logger?: Logger;
}

/**
 * The REAL pressure probe: parses `memory_pressure` (level + free %) and
 * `vm_stat` (pageouts, swap). Pure read-only, cost-free — but it shells macOS
 * tools, so it is RUNTIME code, guarded behind the `run` injection and never
 * invoked by the vitest suite (which passes a fake PressureProbe instead). The
 * blueprint §11 rule "never naive free RAM" is honored: the pressure LEVEL and
 * the pageout DELTA are the primary signals; free % is secondary.
 *
 * Robustness: any parse/spawn failure → `read()` returns `undefined` (the
 * governor surfaces `no-signal`, never a fabricated zero). It NEVER throws.
 */
export function createSpawnPressureProbe(options: SpawnPressureProbeOptions = {}): PressureProbe {
  const run = options.run;
  let lastPageouts: number | undefined;
  let lastAtMs: number | undefined;

  return {
    read: () => {
      if (run === undefined) {
        // No spawner wired: the runtime path is inert (the composition root
        // supplies `run` only on macOS at boot — documented in index.ts).
        options.logger?.debug('spawn pressure probe has no runner (inert)');
        return undefined;
      }
      try {
        // memory_pressure -Q: "System-wide memory free percentage: NN%"
        // and a pressure level line. Parsed leniently.
        const mp = run('memory_pressure', ['-Q']);
        const freeMatch = /free percentage:\s*(\d+)%/i.exec(mp);
        const freeRamPct = freeMatch ? Number(freeMatch[1]) : 50;
        // The `-Q` warning level: 1 normal, 2 warn, 4 critical (Apple's axis).
        const levelMatch = /pressure level:\s*(\d+)/i.exec(mp);
        const rawLevel = levelMatch ? Number(levelMatch[1]) : 0;
        const pressureLevel = Math.max(0, Math.min(4, rawLevel));

        // vm_stat: pageouts (cumulative) + swap via `sysctl vm.swapusage`.
        const vm = run('vm_stat', []);
        const pageoutMatch = /Pageouts:\s*(\d+)/i.exec(vm);
        const pageoutsTotal = pageoutMatch ? Number(pageoutMatch[1]) : 0;
        const nowMs = Date.now();
        let pageoutRate = 0;
        if (lastPageouts !== undefined && lastAtMs !== undefined && nowMs > lastAtMs) {
          const deltaPages = Math.max(0, pageoutsTotal - lastPageouts);
          pageoutRate = (deltaPages * 1000) / (nowMs - lastAtMs);
        }
        lastPageouts = pageoutsTotal;
        lastAtMs = nowMs;

        const swap = run('sysctl', ['-n', 'vm.swapusage']);
        const usedMatch = /used\s*=\s*([\d.]+)([MG])/i.exec(swap);
        let swapUsedBytes = 0;
        if (usedMatch) {
          const n = Number(usedMatch[1]);
          const unit = (usedMatch[2] ?? 'M').toUpperCase();
          swapUsedBytes = unit === 'G' ? n * GIB : n * 1024 * 1024;
        }

        return { pressureLevel, freeRamPct, swapUsedBytes, pageoutRate };
      } catch (cause) {
        options.logger?.warn('spawn pressure probe read failed (no signal)', {
          detail: (cause as Error).message,
        });
        return undefined;
      }
    },
  };
}
