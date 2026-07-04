/**
 * Bounded buffers. Positive: FIFO push/drain. Negative: invalid capacity,
 * byte-cap breach throws (assertion semantics). Edge: overflow eviction
 * accounting, wraparound reuse.
 */

import { describe, expect, it } from 'vitest';
import { BoundedByteQueue, RingBuffer } from './ringBuffer.ts';

describe('RingBuffer', () => {
  it('drains in FIFO order', () => {
    const ring = new RingBuffer<number>(4);
    [1, 2, 3].forEach((n) => ring.push(n));
    expect(ring.drain()).toEqual([1, 2, 3]);
    expect(ring.size).toBe(0);
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);
    expect(() => new RingBuffer(1.5)).toThrow(RangeError);
  });

  it('drops oldest on overflow and counts the drops', () => {
    const ring = new RingBuffer<number>(3);
    [1, 2, 3].forEach((n) => ring.push(n));
    expect(ring.push(4)).toBe(1); // evicted oldest returned
    expect(ring.push(5)).toBe(2);
    expect(ring.droppedCount).toBe(2);
    expect(ring.toArray()).toEqual([3, 4, 5]);
  });

  it('stays consistent across repeated wraparound (edge)', () => {
    const ring = new RingBuffer<number>(2);
    for (let i = 0; i < 10; i += 1) ring.push(i);
    expect(ring.drain()).toEqual([8, 9]);
    ring.push(42);
    expect(ring.toArray()).toEqual([42]);
  });
});

describe('BoundedByteQueue', () => {
  it('accumulates and drains chunks', () => {
    const q = new BoundedByteQueue(16);
    q.push(new Uint8Array([1, 2]));
    q.push(new Uint8Array([3]));
    expect(q.byteLength).toBe(3);
    expect(q.drain().map((c) => [...c])).toEqual([[1, 2], [3]]);
    expect(q.byteLength).toBe(0);
  });

  it('THROWS on cap breach — bytes are never silently dropped', () => {
    const q = new BoundedByteQueue(4);
    q.push(new Uint8Array(4));
    expect(() => q.push(new Uint8Array(1))).toThrow(RangeError);
  });

  it('ignores empty chunks (edge)', () => {
    const q = new BoundedByteQueue(1);
    q.push(new Uint8Array(0));
    expect(q.byteLength).toBe(0);
  });
});
