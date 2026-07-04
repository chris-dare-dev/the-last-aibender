/**
 * Tiny stats helpers for the spike benchmarks. Quarantined spike code —
 * never imported by prod (spikes/README.md).
 */

export interface Summary {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  min: number;
}

/** Nearest-rank percentile on a pre-sorted copy. q in [0, 100]. */
export function percentile(samples: readonly number[], q: number): number {
  if (samples.length === 0) throw new Error('percentile: empty sample set');
  if (q < 0 || q > 100) throw new Error(`percentile: q out of range: ${q}`);
  const sorted = [...samples].sort((a, b) => a - b);
  if (q === 0) return sorted[0];
  const rank = Math.ceil((q / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function summarize(samples: readonly number[]): Summary {
  if (samples.length === 0) throw new Error('summarize: empty sample set');
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    count: samples.length,
    mean: sum / samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    max: Math.max(...samples),
    min: Math.min(...samples),
  };
}

export function round(v: number, places = 3): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

export function fmtSummary(s: Summary, unit = 'ms'): string {
  return (
    `mean ${round(s.mean)}${unit}  p50 ${round(s.p50)}${unit}  ` +
    `p95 ${round(s.p95)}${unit}  p99 ${round(s.p99)}${unit}  max ${round(s.max)}${unit}`
  );
}
