/**
 * rAF projection discipline. Positive: items coalesce into ONE flush per
 * frame. Negative: no flush without a frame; nothing after dispose. Edge:
 * re-arming across frames, cap eviction between frames.
 */

import { describe, expect, it } from 'vitest';
import { manualFrames } from '../testing/fakes.ts';
import { createRafProjector } from './rafBatch.ts';

describe('createRafProjector', () => {
  it('batches every push into one flush per frame', () => {
    const frames = manualFrames();
    const flushes: number[][] = [];
    const projector = createRafProjector<number>({
      schedule: frames.schedule,
      onFlush: (batch) => flushes.push([...batch]),
    });

    for (let i = 0; i < 100; i += 1) projector.push(i);
    expect(flushes).toEqual([]); // NOTHING is reactive before the frame
    expect(projector.pending).toBe(100);

    frames.frame();
    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toHaveLength(100);
    expect(projector.flushCount).toBe(1);
  });

  it('re-arms across frames (one flush per frame, not per item)', () => {
    const frames = manualFrames();
    const flushes: number[][] = [];
    const projector = createRafProjector<number>({
      schedule: frames.schedule,
      onFlush: (batch) => flushes.push([...batch]),
    });

    projector.push(1);
    frames.frame();
    projector.push(2);
    projector.push(3);
    frames.frame();
    expect(flushes).toEqual([[1], [2, 3]]);
    // exactly one scheduler arm per burst
    expect(frames.scheduledCount()).toBe(2);
  });

  it('flushNow drains synchronously and cancels the armed frame', () => {
    const frames = manualFrames();
    const flushes: number[][] = [];
    const projector = createRafProjector<number>({
      schedule: frames.schedule,
      onFlush: (batch) => flushes.push([...batch]),
    });
    projector.push(7);
    projector.flushNow();
    expect(flushes).toEqual([[7]]);
    frames.frame(); // canceled — must not double-flush
    expect(flushes).toEqual([[7]]);
  });

  it('drops-oldest beyond capacity between frames (bounded, counted)', () => {
    const frames = manualFrames();
    const flushes: number[][] = [];
    const projector = createRafProjector<number>({
      schedule: frames.schedule,
      capacity: 3,
      onFlush: (batch) => flushes.push([...batch]),
    });
    [1, 2, 3, 4, 5].forEach((n) => projector.push(n));
    frames.frame();
    expect(flushes).toEqual([[3, 4, 5]]);
    expect(projector.droppedCount).toBe(2);
  });

  it('ignores pushes after dispose (negative)', () => {
    const frames = manualFrames();
    const flushes: number[][] = [];
    const projector = createRafProjector<number>({
      schedule: frames.schedule,
      onFlush: (batch) => flushes.push([...batch]),
    });
    projector.push(1);
    projector.dispose(); // final flush
    expect(flushes).toEqual([[1]]);
    projector.push(2);
    frames.frame();
    expect(flushes).toEqual([[1]]);
  });
});
