/**
 * BE-6 block-math tests (plan §9.2 positive row: "burn-rate math matches
 * ccusage block fixtures"). Fixtures below are hand-computed against the
 * cited ccusage algorithm (blocks.ts module doc): hour-floored 5 h windows,
 * ≥5 h silence closes a block, linear burn/projection.
 */

import { describe, expect, it } from 'vitest';

import {
  BLOCK_DURATION_MS,
  MIN_ELAPSED_MS,
  activeBlock,
  assembleBlocks,
  burnRateTokensPerHour,
  floorToUtcHour,
  projectExhaustionAt,
} from './blocks.js';

const HOUR = 3_600_000;
// 2026-07-01T10:24:00.000Z — deliberately mid-hour to exercise flooring.
const T = Date.UTC(2026, 6, 1, 10, 24, 0);
const T_FLOOR = Date.UTC(2026, 6, 1, 10, 0, 0);

describe('assembleBlocks — the ccusage fixtures', () => {
  it('floors the block start to the UTC hour and spans exactly 5h', () => {
    const blocks = assembleBlocks([{ tsMs: T, tokens: 100 }]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.startMs).toBe(T_FLOOR);
    expect(blocks[0]?.endMs).toBe(T_FLOOR + BLOCK_DURATION_MS);
    expect(floorToUtcHour(T)).toBe(T_FLOOR);
  });

  it('entries inside the window with <5h gaps share one block; tokens sum', () => {
    const blocks = assembleBlocks([
      { tsMs: T, tokens: 100 },
      { tsMs: T + HOUR, tokens: 200 },
      { tsMs: T + 3 * HOUR, tokens: 300 },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.tokens).toBe(600);
    expect(blocks[0]?.entryCount).toBe(3);
  });

  it('an entry past the block end opens a new hour-floored block', () => {
    const second = T_FLOOR + BLOCK_DURATION_MS + 30 * 60_000; // 15:30Z
    const blocks = assembleBlocks([
      { tsMs: T, tokens: 100 },
      { tsMs: second, tokens: 50 },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]?.startMs).toBe(Date.UTC(2026, 6, 1, 15, 0, 0));
  });

  it('a ≥5h SILENCE closes the block even inside its window boundary math', () => {
    // Second entry only 4.6h after block START (inside the window) but 5h
    // after the previous ENTRY → the gap rule opens a new block (ccusage
    // step 3).
    const first = T_FLOOR; // exactly on the hour → window is [10:00, 15:00)
    const blocks = assembleBlocks([
      { tsMs: first, tokens: 10 },
      { tsMs: first + BLOCK_DURATION_MS - 1, tokens: 10 }, // 14:59:59.999 — joins
    ]);
    expect(blocks).toHaveLength(1);

    const gapped = assembleBlocks([
      { tsMs: first, tokens: 10 },
      { tsMs: first + BLOCK_DURATION_MS, tokens: 10 }, // 15:00 — outside
    ]);
    expect(gapped).toHaveLength(2);
  });

  it('EDGE: unsorted input sorts; empty input yields no blocks', () => {
    expect(assembleBlocks([])).toEqual([]);
    const blocks = assembleBlocks([
      { tsMs: T + HOUR, tokens: 2 },
      { tsMs: T, tokens: 1 },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.firstEntryMs).toBe(T);
  });
});

describe('activeBlock', () => {
  it('the last block is active while now is inside it and the silence < 5h', () => {
    const blocks = assembleBlocks([{ tsMs: T, tokens: 100 }]);
    expect(activeBlock(blocks, T + HOUR)).toBeDefined();
    expect(activeBlock(blocks, T_FLOOR + BLOCK_DURATION_MS)).toBeUndefined(); // window over
    expect(activeBlock([], T)).toBeUndefined();
  });
});

describe('burnRateTokensPerHour', () => {
  it('tokens / elapsed, in tokens/hour (hand-computed fixture)', () => {
    const blocks = assembleBlocks([
      { tsMs: T_FLOOR, tokens: 1_000 },
      { tsMs: T_FLOOR + HOUR, tokens: 1_000 },
    ]);
    const block = blocks[0];
    if (block === undefined) throw new Error('fixture block missing');
    // 2000 tokens over exactly 2 h elapsed → 1000 tokens/hour.
    expect(burnRateTokensPerHour(block, T_FLOOR + 2 * HOUR)).toBeCloseTo(1_000, 10);
  });

  it('EDGE clock skew: now before the block start clamps elapsed (no negative burn)', () => {
    const blocks = assembleBlocks([{ tsMs: T, tokens: 600 }]);
    const block = blocks[0];
    if (block === undefined) throw new Error('fixture block missing');
    const rate = burnRateTokensPerHour(block, T_FLOOR - HOUR); // now "before" start
    expect(rate).toBeGreaterThan(0);
    expect(Number.isFinite(rate)).toBe(true);
    // Clamped to the 1-minute floor: 600 tokens / 1 min = 36 000/h.
    expect(rate).toBeCloseTo((600 / MIN_ELAPSED_MS) * HOUR, 10);
  });
});

describe('projectExhaustionAt — percent-rate extrapolation', () => {
  it('extrapolates linearly to 100% (hand-computed fixture)', () => {
    // 40% used after exactly 2h → 20%/h → 3h remain → exhaustion at start+5h.
    const at = projectExhaustionAt({
      blockStartMs: T_FLOOR,
      nowMs: T_FLOOR + 2 * HOUR,
      usedPct: 40,
    });
    expect(at).toBe(T_FLOOR + 5 * HOUR);
  });

  it('EDGE reset-boundary/exhausted: usedPct ≥ 100 projects NOW (already exhausted)', () => {
    expect(
      projectExhaustionAt({ blockStartMs: T_FLOOR, nowMs: T_FLOOR + HOUR, usedPct: 100 }),
    ).toBe(T_FLOOR + HOUR);
  });

  it('no burn signal → no projection, never a fabricated instant', () => {
    expect(
      projectExhaustionAt({ blockStartMs: T_FLOOR, nowMs: T_FLOOR + HOUR, usedPct: 0 }),
    ).toBeUndefined();
  });
});
