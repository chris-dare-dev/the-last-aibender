/**
 * 5-hour billing-block reconstruction + burn rate + projected exhaustion
 * (BE-6; blueprint §6.3 lead 2 "current 5h-block burn rate and projected
 * exhaustion (ccusage block math)").
 *
 * THE ALGORITHM (cited): ccusage `blocks` — https://github.com/ryoppippi/ccusage,
 * `src/_session-blocks.ts` (see also docs/research/findings/observability.md
 * §8: "`blocks` reconstructs 5-hour billing windows with live burn-rate and
 * projected exhaustion"). Reconstruction from usage-entry timestamps:
 *
 *   1. sort entries by timestamp ascending;
 *   2. the first entry opens a block whose START is the entry's timestamp
 *      FLOORED TO THE UTC HOUR; the block END is start + 5 h;
 *   3. an entry joins the current block iff its timestamp is before the
 *      block end AND the gap since the previous entry is < 5 h (a ≥ 5 h
 *      silence closes the block even inside its window);
 *   4. otherwise the entry opens a new block (floored to its own hour).
 *
 *   Burn rate  = tokens-in-block / elapsed-time-in-block (tokens/hour);
 *   Projection = linear extrapolation of the current rate. ccusage projects
 *   token exhaustion against a token limit; the harness's quota feed speaks
 *   used-PERCENT (statusline `rate_limits`), so the projection here
 *   extrapolates the percent-rate: pctPerHour = usedPct / elapsed-hours,
 *   exhaustion when the extrapolated pct reaches 100.
 *
 * IMPORTANT HONESTY PIN (findings §7.4): block math estimates burn from
 * transcripts but "cannot know Anthropic's actual window accounting; good
 * for PROJECTION, not for truth" — consumers label it a projection, and the
 * quota gauge (lead 1) stays the authoritative percent.
 *
 * Clock-skew edge (plan §9.2 BE-6): entries timestamped ahead of `nowMs`
 * clamp elapsed time at {@link MIN_ELAPSED_MS} — burn is never negative or
 * divide-by-zero.
 */

export const BLOCK_DURATION_MS = 5 * 3_600_000;

/** Elapsed-time floor for rate math (one minute, the ccusage practice). */
export const MIN_ELAPSED_MS = 60_000;

const HOUR_MS = 3_600_000;

/** Epoch ms floored to the UTC hour (timezone-free on epoch ms). */
export function floorToUtcHour(tsMs: number): number {
  return tsMs - (tsMs % HOUR_MS);
}

export interface BlockEntry {
  /** Entry timestamp, epoch ms. */
  readonly tsMs: number;
  /** Tokens attributed to the entry (all four classes summed). */
  readonly tokens: number;
}

export interface UsageBlock {
  /** Block start (first entry's timestamp floored to the UTC hour). */
  readonly startMs: number;
  /** startMs + 5 h. */
  readonly endMs: number;
  readonly tokens: number;
  readonly entryCount: number;
  readonly firstEntryMs: number;
  readonly lastEntryMs: number;
}

/** Reconstruct the block sequence from usage entries (steps 1–4 above). */
export function assembleBlocks(entries: readonly BlockEntry[]): readonly UsageBlock[] {
  const sorted = [...entries].sort((a, b) => a.tsMs - b.tsMs);
  const blocks: UsageBlock[] = [];
  let current:
    | { startMs: number; endMs: number; tokens: number; entryCount: number; firstEntryMs: number; lastEntryMs: number }
    | undefined;

  for (const entry of sorted) {
    const joins =
      current !== undefined &&
      entry.tsMs < current.endMs &&
      entry.tsMs - current.lastEntryMs < BLOCK_DURATION_MS;
    if (joins && current !== undefined) {
      current.tokens += entry.tokens;
      current.entryCount += 1;
      current.lastEntryMs = entry.tsMs;
      continue;
    }
    if (current !== undefined) blocks.push({ ...current });
    const startMs = floorToUtcHour(entry.tsMs);
    current = {
      startMs,
      endMs: startMs + BLOCK_DURATION_MS,
      tokens: entry.tokens,
      entryCount: 1,
      firstEntryMs: entry.tsMs,
      lastEntryMs: entry.tsMs,
    };
  }
  if (current !== undefined) blocks.push({ ...current });
  return blocks;
}

/**
 * The ACTIVE block at `nowMs`, if any: the last block, provided `nowMs` is
 * inside its window and the silence since its last entry is < 5 h (the same
 * gap rule that would have closed it).
 */
export function activeBlock(
  blocks: readonly UsageBlock[],
  nowMs: number,
): UsageBlock | undefined {
  const last = blocks[blocks.length - 1];
  if (last === undefined) return undefined;
  if (nowMs < last.startMs) return undefined;
  if (nowMs >= last.endMs) return undefined;
  if (nowMs - last.lastEntryMs >= BLOCK_DURATION_MS) return undefined;
  return last;
}

/** Burn rate over the block: tokens / elapsed (clamped) in tokens/hour. */
export function burnRateTokensPerHour(block: UsageBlock, nowMs: number): number {
  const elapsedMs = Math.max(MIN_ELAPSED_MS, nowMs - block.startMs);
  return (block.tokens / elapsedMs) * HOUR_MS;
}

export interface ExhaustionInput {
  /** Active block start, epoch ms. */
  readonly blockStartMs: number;
  readonly nowMs: number;
  /** Authoritative used percent from the quota feed (0–100). */
  readonly usedPct: number;
}

/**
 * Projected exhaustion instant (epoch ms) by linear percent-rate
 * extrapolation, or undefined when the burn projects no exhaustion
 * (usedPct 0, or no elapsed signal). usedPct >= 100 projects `nowMs`
 * (already exhausted — reset countdown territory, not an error).
 */
export function projectExhaustionAt(input: ExhaustionInput): number | undefined {
  if (input.usedPct >= 100) return input.nowMs;
  if (input.usedPct <= 0) return undefined;
  const elapsedMs = Math.max(MIN_ELAPSED_MS, input.nowMs - input.blockStartMs);
  const pctPerMs = input.usedPct / elapsedMs;
  if (pctPerMs <= 0) return undefined;
  const remainingMs = (100 - input.usedPct) / pctPerMs;
  const at = Math.round(input.nowMs + remainingMs);
  return Number.isSafeInteger(at) ? at : undefined;
}
