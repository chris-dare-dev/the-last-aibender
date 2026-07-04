/**
 * Sustained-RSS watchdog logic (BE-4; blueprint §4.2 "threshold on SUSTAINED
 * RSS (>~500 MB for 5 min), not instantaneous peaks — the serve process is a
 * Bun GC sawtooth (measured 160–650 MB)").
 *
 * Pure decision logic: callers feed `(rssBytes, atMs)` samples from whatever
 * sampler they own (BE-9's supervisor at M6; tests feed synthetic series).
 * The tracker trips only when EVERY sample across a full sustain window was
 * above threshold — one settle below resets the clock, so the sawtooth's
 * transient 650 MB spikes never trip it (plan §9.2 edge case).
 */

export interface SustainedRssTrackerOptions {
  /** Trip threshold in bytes. Default 500 MiB (blueprint §4.2). */
  readonly thresholdBytes?: number;
  /** How long RSS must stay above threshold, ms. Default 5 minutes. */
  readonly sustainMs?: number;
}

export const DEFAULT_RSS_THRESHOLD_BYTES = 500 * 1024 * 1024;
export const DEFAULT_RSS_SUSTAIN_MS = 5 * 60 * 1000;

export interface RssSampleVerdict {
  /** True once RSS has been above threshold for the whole sustain window. */
  readonly tripped: boolean;
  /** ms the current above-threshold streak has lasted (0 when below). */
  readonly aboveForMs: number;
}

export interface SustainedRssTracker {
  /** Feed one sample. Samples must arrive in non-decreasing time order. */
  sample(rssBytes: number, atMs: number): RssSampleVerdict;
  /** Forget any streak (e.g. after a recycle). */
  reset(): void;
}

export function createSustainedRssTracker(
  options: SustainedRssTrackerOptions = {},
): SustainedRssTracker {
  const threshold = options.thresholdBytes ?? DEFAULT_RSS_THRESHOLD_BYTES;
  const sustainMs = options.sustainMs ?? DEFAULT_RSS_SUSTAIN_MS;
  /** Start of the current above-threshold streak, or undefined when below. */
  let aboveSinceMs: number | undefined;

  return {
    sample(rssBytes: number, atMs: number): RssSampleVerdict {
      if (rssBytes <= threshold) {
        aboveSinceMs = undefined;
        return { tripped: false, aboveForMs: 0 };
      }
      if (aboveSinceMs === undefined) aboveSinceMs = atMs;
      const aboveForMs = atMs - aboveSinceMs;
      return { tripped: aboveForMs >= sustainMs, aboveForMs };
    },
    reset(): void {
      aboveSinceMs = undefined;
    },
  };
}
