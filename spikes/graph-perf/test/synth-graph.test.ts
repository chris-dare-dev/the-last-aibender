import { describe, expect, it } from 'vitest';
import { buildContextGraph, edgesForNodes, mulberry32 } from '../src/synth-graph.ts';

describe('buildContextGraph', () => {
  // positive
  it('builds exactly n nodes and targetE edges at the 5k/8k spike shape', () => {
    const { graph, data } = buildContextGraph(5000, 8000, 42);
    expect(graph.order).toBe(5000);
    expect(graph.size).toBe(8000);
    expect(data.edges.length).toBe(16000);
    expect(data.positions.length).toBe(10000);
    expect(data.cluster.length).toBe(5000);
  });

  it('is deterministic for the same seed and diverges for another', () => {
    const a = buildContextGraph(500, 800, 7).data;
    const b = buildContextGraph(500, 800, 7).data;
    const c = buildContextGraph(500, 800, 8).data;
    expect([...a.edges]).toEqual([...b.edges]);
    expect([...a.positions]).toEqual([...b.positions]);
    expect([...a.edges]).not.toEqual([...c.edges]);
  });

  it('edgesForNodes matches the plan ratio (5k -> 8k)', () => {
    expect(edgesForNodes(5000)).toBe(8000);
    expect(edgesForNodes(1000)).toBe(1600);
  });

  // negative
  it('rejects n < 2', () => {
    expect(() => buildContextGraph(1, 5)).toThrow(/n >= 2/);
  });

  it('rejects targetE below the cluster backbone', () => {
    expect(() => buildContextGraph(1000, 3)).toThrow(/backbone/);
  });

  it('rejects targetE above the simple-graph maximum', () => {
    expect(() => buildContextGraph(4, 7)).toThrow(/exceeds/);
  });

  // edge
  it('handles the minimal graph (n=2, e=1)', () => {
    const { data } = buildContextGraph(2, 1, 1);
    expect(data.edges.length).toBe(2);
    expect(data.edges[0]).not.toBe(data.edges[1]);
  });

  it('produces no self-loops, no duplicate edges, all indices in range', () => {
    const { data } = buildContextGraph(1200, 1920, 3);
    const seen = new Set<string>();
    for (let k = 0; k < data.e; k++) {
      const a = data.edges[2 * k];
      const b = data.edges[2 * k + 1];
      expect(a).not.toBe(b);
      expect(a).toBeLessThan(1200);
      expect(b).toBeLessThan(1200);
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe('mulberry32', () => {
  it('is deterministic and in [0, 1)', () => {
    const r1 = mulberry32(99);
    const r2 = mulberry32(99);
    for (let i = 0; i < 100; i++) {
      const v = r1();
      expect(v).toBe(r2());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
