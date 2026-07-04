import { describe, expect, it } from 'vitest';
import { AckBufferOverflowError, BoundedAckBuffer } from '../src/ackBuffer.js';

const mk = (cap = 100, high = 60, low = 20): BoundedAckBuffer =>
  new BoundedAckBuffer({ capBytes: cap, highWater: high, lowWater: low });

describe('BoundedAckBuffer — positive', () => {
  it('accepts pushes below highWater without pause and delivers in order', () => {
    const b = mk();
    expect(b.push('aaaa')).toBe(false);
    expect(b.push('bbbb')).toBe(false);
    expect(b.deliver(6)).toBe('aaaabb');
    expect(b.deliver(100)).toBe('bb');
    expect(b.occupancy).toBe(8);
  });

  it('ack advances the watermark, frees space, and signals resume at lowWater', () => {
    const b = mk(100, 60, 20);
    b.push('x'.repeat(60)); // hits highWater → pause
    expect(b.paused).toBe(true);
    b.deliver(60);
    expect(b.ack(30)).toBe(false); // occupancy 30 > lowWater 20 → still paused
    expect(b.ack(45)).toBe(true); // occupancy 15 <= 20 → resume
    expect(b.paused).toBe(false);
    const s = b.stats();
    expect(s.pauseSignals).toBe(1);
    expect(s.resumeSignals).toBe(1);
  });

  it('replayFrom returns exactly the retained bytes from a watermark (reconnect path)', () => {
    const b = mk();
    b.push('abcdefghij');
    b.deliver(10);
    b.ack(4);
    expect(b.replayFrom(4)).toBe('efghij');
    // Delivery cursor is reset to the end after replay; new data still flows.
    b.push('KL');
    expect(b.deliver(10)).toBe('KL');
  });
});

describe('BoundedAckBuffer — negative', () => {
  it('throws on cap breach when a pause signal was ignored (never silently drops)', () => {
    const b = mk(100, 60, 20);
    expect(b.push('x'.repeat(60))).toBe(true); // pause demanded
    expect(() => b.push('y'.repeat(50))).toThrow(AckBufferOverflowError);
  });

  it('rejects acks beyond the delivered offset', () => {
    const b = mk();
    b.push('abc');
    b.deliver(2);
    expect(() => b.ack(3)).toThrow(RangeError);
  });

  it('rejects replay from before the acked watermark (data is gone by design)', () => {
    const b = mk();
    b.push('abcdef');
    b.deliver(6);
    b.ack(6);
    expect(() => b.replayFrom(2)).toThrow(RangeError);
  });

  it('rejects invalid watermark configuration', () => {
    expect(() => mk(100, 120, 20)).toThrow(RangeError); // high > cap
    expect(() => mk(100, 60, 60)).toThrow(RangeError); // low not < high
  });
});

describe('BoundedAckBuffer — edge', () => {
  it('stale (backwards) acks are ignored, watermark stays monotonic', () => {
    const b = mk();
    b.push('abcdef');
    b.deliver(6);
    b.ack(5);
    expect(b.ack(3)).toBe(false);
    expect(b.stats().bytesAcked).toBe(5);
  });

  it('hysteresis: no resume signal until occupancy reaches lowWater exactly', () => {
    const b = mk(100, 60, 20);
    b.push('x'.repeat(70));
    b.deliver(70);
    expect(b.ack(49)).toBe(false); // occ 21
    expect(b.ack(50)).toBe(true); // occ 20 == lowWater
  });

  it('splits chunks on partial delivery without loss or reorder', () => {
    const b = mk();
    b.push('abc');
    b.push('def');
    expect(b.deliver(2)).toBe('ab');
    expect(b.deliver(2)).toBe('cd');
    expect(b.deliver(9)).toBe('ef');
  });

  it('empty push is a no-op that reports current pause state', () => {
    const b = mk(100, 60, 20);
    expect(b.push('')).toBe(false);
    b.push('x'.repeat(60));
    expect(b.push('')).toBe(true);
  });

  it('pause/resume cycles under a slow-drain pattern keep occupancy <= cap forever', () => {
    const b = mk(1000, 600, 200);
    let produced = 0;
    let ackedTo = 0;
    for (let round = 0; round < 200; round += 1) {
      if (!b.paused) {
        b.push('z'.repeat(150));
        produced += 150;
      }
      // slow consumer drains 100/round
      const got = b.deliver(100);
      if (got.length > 0) {
        ackedTo += got.length;
        b.ack(ackedTo);
      }
      expect(b.occupancy).toBeLessThanOrEqual(1000);
    }
    expect(produced).toBeGreaterThan(0);
    expect(b.stats().pauseSignals).toBeGreaterThan(0);
    expect(b.stats().resumeSignals).toBeGreaterThan(0);
  });
});
