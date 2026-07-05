/**
 * FE-4 layout engine — the pure d3-force core (plan §9.2 FE-4 edge row:
 * "reheat stays gentle (alphaTarget bound asserted)").
 */

import { describe, expect, it } from 'vitest';
import { ALPHA_MIN, GENTLE_ALPHA_TARGET, createLayoutEngine } from './layoutEngine.ts';

function addPair(engine = createLayoutEngine()) {
  const positions = new Float32Array([10, 20, 40, 20]);
  const edges = new Uint32Array([0, 1]);
  engine.add(2, positions, edges);
  return engine;
}

describe('layout engine — gentle reheat bound (FROZEN behavior)', () => {
  it('clamps alphaTarget to [0, 0.3] — never the explosive alpha(1) restart', () => {
    const engine = addPair();
    expect(engine.reheat(1)).toBe(GENTLE_ALPHA_TARGET);
    expect(engine.alphaTarget()).toBe(GENTLE_ALPHA_TARGET);
    expect(engine.reheat(0.05)).toBe(0.05);
    expect(engine.reheat(-3)).toBe(0);
    expect(engine.reheat()).toBe(GENTLE_ALPHA_TARGET);
  });

  it('reheat from REST raises alpha to the clamped target only (never 1)', () => {
    const engine = addPair();
    engine.settle(); // decay the d3 initial-layout energy to convergence
    expect(engine.alpha()).toBeLessThan(0.001);
    engine.reheat(1);
    // The nudge stops AT the clamped target — the gentle restart, not alpha(1).
    expect(engine.alpha()).toBeLessThanOrEqual(GENTLE_ALPHA_TARGET + 1e-9);
    expect(engine.alpha()).toBeGreaterThan(0.29);
  });

  it('cooldown returns the target to 0 and settle converges below the floor', () => {
    const engine = addPair();
    engine.reheat();
    engine.cooldown();
    expect(engine.alphaTarget()).toBe(0);
    engine.settle();
    expect(engine.alpha()).toBeLessThan(ALPHA_MIN);
    expect(engine.isHot()).toBe(false);
  });
});

describe('layout engine — incremental adds', () => {
  it('spawn positions are honored (no phyllotaxis fling)', () => {
    const engine = createLayoutEngine();
    engine.add(2, new Float32Array([100, -50, 102, -48]), new Uint32Array([]));
    const epoch = engine.fillEpoch(new ArrayBuffer(8 * 2));
    expect(epoch[0]).toBe(100);
    expect(epoch[1]).toBe(-50);
    expect(epoch[2]).toBe(102);
    expect(epoch[3]).toBe(-48);
  });

  it('appending preserves EXISTING node positions (d3 re-init contract)', () => {
    const engine = addPair();
    engine.reheat();
    for (let i = 0; i < 20; i++) engine.tick();
    const before = engine.fillEpoch(new ArrayBuffer(8 * engine.nodeCount));
    const b0 = [before[0], before[1], before[2], before[3]];
    engine.add(1, new Float32Array([0, 0]), new Uint32Array([0, 2]));
    const after = engine.fillEpoch(new ArrayBuffer(8 * engine.nodeCount));
    // Positions of nodes 0/1 survive the re-init untouched (no tick between).
    expect([after[0], after[1], after[2], after[3]]).toEqual(b0);
    expect(engine.nodeCount).toBe(3);
  });

  it('rejects malformed inputs (short positions, out-of-range edges)', () => {
    const engine = createLayoutEngine();
    expect(() => engine.add(2, new Float32Array([1, 2]), new Uint32Array([]))).toThrow(
      /positions length/,
    );
    expect(() =>
      engine.add(1, new Float32Array([0, 0]), new Uint32Array([0, 9])),
    ).toThrow(/out of range/);
  });

  it('pin freezes a node under ticks; unpin releases it', () => {
    const engine = addPair();
    engine.pin(0, -77, 33);
    engine.reheat();
    for (let i = 0; i < 10; i++) engine.tick();
    const epoch = engine.fillEpoch(new ArrayBuffer(8 * 2));
    expect(epoch[0]).toBe(-77);
    expect(epoch[1]).toBe(33);
    engine.unpin(0);
    for (let i = 0; i < 10; i++) engine.tick();
    const freed = engine.fillEpoch(new ArrayBuffer(8 * 2));
    expect(Math.abs((freed[0] ?? 0) - -77) + Math.abs((freed[1] ?? 0) - 33)).toBeGreaterThan(0);
  });

  it('held at the gentle target the sim stays hot (the live steady state)', () => {
    const engine = addPair();
    engine.reheat();
    for (let i = 0; i < 300; i++) engine.tick();
    expect(engine.isHot()).toBe(true);
    expect(engine.alpha()).toBeGreaterThanOrEqual(GENTLE_ALPHA_TARGET - 0.05);
  });
});
