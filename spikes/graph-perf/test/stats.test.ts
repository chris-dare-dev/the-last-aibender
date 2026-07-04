import { describe, expect, it } from 'vitest';
import { percentile, summarize } from '../src/stats.ts';

describe('percentile', () => {
  // positive
  it('computes nearest-rank percentiles on 1..100', () => {
    const s = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(s, 50)).toBe(50);
    expect(percentile(s, 95)).toBe(95);
    expect(percentile(s, 99)).toBe(99);
  });

  it('does not mutate the input order', () => {
    const s = [3, 1, 2];
    percentile(s, 50);
    expect(s).toEqual([3, 1, 2]);
  });

  // negative
  it('throws on an empty sample set', () => {
    expect(() => percentile([], 50)).toThrow(/empty/);
    expect(() => summarize([])).toThrow(/empty/);
  });

  it('throws on out-of-range q', () => {
    expect(() => percentile([1], -1)).toThrow(/out of range/);
    expect(() => percentile([1], 101)).toThrow(/out of range/);
  });

  // edge
  it('handles a single-element sample and the 0/100 extremes', () => {
    expect(percentile([7], 0)).toBe(7);
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 100)).toBe(7);
    const s = [10, 20, 30];
    expect(percentile(s, 0)).toBe(10);
    expect(percentile(s, 100)).toBe(30);
  });
});

describe('summarize', () => {
  it('reports mean/min/max consistently', () => {
    const r = summarize([1, 2, 3, 4]);
    expect(r.count).toBe(4);
    expect(r.mean).toBeCloseTo(2.5);
    expect(r.min).toBe(1);
    expect(r.max).toBe(4);
    expect(r.p50).toBe(2);
  });
});
