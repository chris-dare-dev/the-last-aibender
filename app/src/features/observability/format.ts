/**
 * Instrument formatting — pure, deterministic, character-grid friendly
 * (DESIGN.md §4.3/§4.4: tabular numerals, mono voice, terse engraved units).
 *
 * Durations render as compact countdowns (1H23M), never wall-clock times —
 * countdown text is timezone-independent and therefore test-stable. A reset
 * instant in the past is LEGAL wire data and renders as "DUE" (plan §9.2
 * FE-5 edge row: quota at 100% with resets_at in the past).
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** 41.5 → "41.5%" (one decimal, stable width on the ch grid). */
export function fmtPct(pct: number): string {
  return `${pct.toFixed(1)}%`;
}

/** 12.5 → "$12.50" (USD always two decimals — money never jitters). */
export function fmtUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** Compact token counts: 900 → "900", 120000 → "120.0K", 3400000 → "3.4M". */
export function fmtTokens(tokens: number): string {
  if (!Number.isFinite(tokens)) return '—';
  const abs = Math.abs(tokens);
  if (abs >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(Math.round(tokens));
}

/** Tokens/hour burn readout: 120000 → "120.0K/H". */
export function fmtTokensPerHour(tokensPerHour: number): string {
  return `${fmtTokens(tokensPerHour)}/H`;
}

/**
 * Countdown to an instant: future → "1H23M" / "23M" / "4D02H"; past or now →
 * "DUE". Sub-minute future rounds up to "1M" (a countdown never reads 0M
 * while still in the future).
 */
export function fmtCountdown(now: number, at: number): string {
  const delta = at - now;
  if (delta <= 0) return 'DUE';
  if (delta >= DAY_MS) {
    const days = Math.floor(delta / DAY_MS);
    const hours = Math.floor((delta % DAY_MS) / HOUR_MS);
    return `${days}D${String(hours).padStart(2, '0')}H`;
  }
  if (delta >= HOUR_MS) {
    const hours = Math.floor(delta / HOUR_MS);
    const minutes = Math.floor((delta % HOUR_MS) / MINUTE_MS);
    return `${hours}H${String(minutes).padStart(2, '0')}M`;
  }
  return `${Math.max(1, Math.ceil(delta / MINUTE_MS))}M`;
}

/** Age of a sample: "0M" (fresh-frame) … "5M" … "3H" … "2D". */
export function fmtAge(now: number, at: number): string {
  const delta = Math.max(0, now - at);
  if (delta >= DAY_MS) return `${Math.floor(delta / DAY_MS)}D`;
  if (delta >= HOUR_MS) return `${Math.floor(delta / HOUR_MS)}H`;
  return `${Math.floor(delta / MINUTE_MS)}M`;
}

/** Milliseconds readout: 300 → "300MS", 12500 → "12.5S". */
export function fmtMs(ms: number): string {
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)}S`;
  return `${Math.round(ms)}MS`;
}

/**
 * Memory footprint from MB (blueprint §11 phys_footprint is reported in MB):
 * 512 → "512MB"; 3200 → "3.1GB". GB uses the binary 1024 divisor to match the
 * watchdog thresholds (claude warn 3 GB / recycle 6 GB) which are physical.
 */
export function fmtMb(mb: number): string {
  if (!Number.isFinite(mb)) return '—';
  if (Math.abs(mb) >= 1024) return `${(mb / 1024).toFixed(1)}GB`;
  return `${Math.round(mb)}MB`;
}

/**
 * Memory from bytes (swap, local-model residency): 0 → "0B"; 27917287424 →
 * "26.0GB". Binary divisors so "26 GB swap" matches the §11 red threshold.
 */
export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  const abs = Math.abs(bytes);
  if (abs >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)}GB`;
  if (abs >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)}MB`;
  if (abs >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${Math.round(bytes)}B`;
}
