/**
 * PER-SESSION FOOTPRINT WATCHDOG (BE-9; plan §4/BE-9, blueprint §11).
 *
 * Classifies each supervised session's phys_footprint against its per-class
 * warn/recycle thresholds (types.ts DEFAULT_FOOTPRINT_THRESHOLDS):
 *   - claude          warn 3 GB / recycle 6 GB  (instantaneous)
 *   - opencode agent  warn 1 GB / recycle 1.5 GB (instantaneous)
 *   - opencode serve  SUSTAINED >500 MB for 5 min (debounce window)
 *   - lmstudio        warn only (the model budget is the real lever)
 *
 * SUSTAINED-WINDOW DEBOUNCE (the GC-sawtooth-proof rule, blueprint §4.2): a
 * class with `sustainedSeconds > 0` (the `opencode serve` Bun sawtooth) flips
 * to `warn` only when the footprint has stayed AT/OVER `warnMb` continuously
 * for the whole window. A single reading that dips back below `warnMb` RESETS
 * the window (so a 160→650→200 MB sawtooth never trips). Instantaneous classes
 * (`sustainedSeconds === 0`) band immediately.
 *
 * HYSTERESIS (the anti-flapping rule, plan §9.2 BE-9 edge): once a session is
 * in `warn`/`recycle`, it de-escalates only when the footprint drops BELOW the
 * threshold minus a margin (`hysteresisMb`). A session hovering at exactly the
 * warn line never flaps warn↔ok on GC noise.
 *
 * PURE decision logic — the sampler is injected (types.ts FootprintSampler),
 * so this module never reads a real process. `evaluate` takes the sample time
 * so tests drive the sustained window deterministically.
 */

import type { Logger } from '@aibender/shared';

import {
  DEFAULT_FOOTPRINT_THRESHOLDS,
  type FootprintSampler,
  type FootprintThresholds,
  type SupervisedSession,
  type WatchdogClass,
} from './types.js';

/** The FROZEN wire band (readModels.ts WATCHDOG_BANDS): ok | warn | recycle. */
export type WatchdogBand = 'ok' | 'warn' | 'recycle';

/** One session's watchdog verdict at a sample. */
export interface WatchdogVerdict {
  readonly sessionId: string;
  readonly band: WatchdogBand;
  /** phys_footprint MB the verdict was computed from; absent when unsampled. */
  readonly footprintMb?: number;
}

export interface FootprintWatchdogOptions {
  readonly sampler: FootprintSampler;
  /** Per-class thresholds; merged over the blueprint §11 defaults. */
  readonly thresholds?: Partial<Record<WatchdogClass, FootprintThresholds>>;
  /**
   * De-escalation margin, MB (hysteresis). A `warn`/`recycle` session drops a
   * band only once its footprint falls below `(threshold - hysteresisMb)`.
   * Default 128 MB.
   */
  readonly hysteresisMb?: number;
  readonly logger?: Logger;
}

export interface FootprintWatchdog {
  /**
   * Sample + band every registered session at `nowMs`. Pure over the injected
   * sampler; returns one verdict per session (unsampled → `ok` + no footprint,
   * and the sustained window is left untouched so a transient sampler gap does
   * not reset a legitimate window).
   */
  evaluate(sessions: readonly SupervisedSession[], nowMs: number): readonly WatchdogVerdict[];
  /** The last band for a session (undefined until first evaluated). */
  bandOf(sessionId: string): WatchdogBand | undefined;
  /** Drop per-session state (session settled/recycled). */
  forget(sessionId: string): void;
}

interface SessionState {
  band: WatchdogBand;
  /** Epoch ms the footprint first reached/exceeded `warnMb` in the current run. */
  sustainedSinceMs: number | undefined;
}

export function createFootprintWatchdog(options: FootprintWatchdogOptions): FootprintWatchdog {
  const thresholds: Record<WatchdogClass, FootprintThresholds> = {
    ...DEFAULT_FOOTPRINT_THRESHOLDS,
    ...options.thresholds,
  };
  const hysteresisMb = options.hysteresisMb ?? 128;
  const state = new Map<string, SessionState>();

  /**
   * The raw band for a footprint against the class thresholds, BEFORE
   * hysteresis and the sustained window. `recycle` only when a recycle line
   * exists (serve/lmstudio have none).
   */
  const rawBand = (footprintMb: number, t: FootprintThresholds): WatchdogBand => {
    if (t.recycleMb !== undefined && footprintMb >= t.recycleMb) return 'recycle';
    if (footprintMb >= t.warnMb) return 'warn';
    return 'ok';
  };

  return {
    evaluate: (sessions, nowMs) => {
      const verdicts: WatchdogVerdict[] = [];
      for (const session of sessions) {
        const t = thresholds[session.watchdogClass];
        const prior = state.get(session.sessionId) ?? { band: 'ok', sustainedSinceMs: undefined };

        let footprintMb: number | undefined;
        try {
          footprintMb = options.sampler.sampleMb(session);
        } catch (cause) {
          // A sampler throw is a sampler bug — never take the governor down.
          options.logger?.warn('footprint sampler threw (treated as no reading)', {
            slot: session.slot,
            detail: (cause as Error).message,
          });
          footprintMb = undefined;
        }

        if (footprintMb === undefined || !Number.isFinite(footprintMb) || footprintMb < 0) {
          // No reading: hold the last band and the sustained window untouched
          // (a transient gap must not reset a legitimate sustained run).
          state.set(session.sessionId, prior);
          verdicts.push({ sessionId: session.sessionId, band: prior.band });
          continue;
        }

        // --- sustained window bookkeeping (GC-sawtooth debounce) -------------
        let sustainedSinceMs = prior.sustainedSinceMs;
        if (footprintMb >= t.warnMb) {
          sustainedSinceMs ??= nowMs; // first reading at/over the line starts the clock
        } else {
          sustainedSinceMs = undefined; // dipped below → the window RESETS
        }

        // --- raw band, gated by the sustained window ------------------------
        let target = rawBand(footprintMb, t);
        if (t.sustainedSeconds > 0 && target !== 'ok') {
          // A debounced class only escalates once the window has fully elapsed.
          const elapsedMs = sustainedSinceMs === undefined ? 0 : nowMs - sustainedSinceMs;
          if (elapsedMs < t.sustainedSeconds * 1000) target = 'ok';
        }

        // --- hysteresis: de-escalation needs the margin ---------------------
        const band = applyHysteresis(prior.band, target, footprintMb, t, hysteresisMb);

        state.set(session.sessionId, { band, sustainedSinceMs });
        verdicts.push({ sessionId: session.sessionId, band, footprintMb });
      }
      return verdicts;
    },

    bandOf: (sessionId) => state.get(sessionId)?.band,

    forget: (sessionId) => {
      state.delete(sessionId);
    },
  };
}

/**
 * Anti-flap: escalation is immediate; de-escalation from `warn`/`recycle`
 * requires the footprint to fall below the relevant threshold minus the
 * margin. Escalation UP always honors the (already sustained-gated) target.
 */
function applyHysteresis(
  prior: WatchdogBand,
  target: WatchdogBand,
  footprintMb: number,
  t: FootprintThresholds,
  hysteresisMb: number,
): WatchdogBand {
  const rank: Record<WatchdogBand, number> = { ok: 0, warn: 1, recycle: 2 };
  if (rank[target] >= rank[prior]) return target; // escalate (or hold) immediately

  // De-escalating: only drop a level once clear of the threshold by the margin.
  if (prior === 'recycle') {
    if (t.recycleMb !== undefined && footprintMb >= t.recycleMb - hysteresisMb) return 'recycle';
    // Cleared recycle → fall to warn (or lower, re-checked below).
    if (footprintMb >= t.warnMb - hysteresisMb) return 'warn';
    return target === 'ok' ? 'ok' : target;
  }
  // prior === 'warn', target === 'ok'
  if (footprintMb >= t.warnMb - hysteresisMb) return 'warn';
  return 'ok';
}
