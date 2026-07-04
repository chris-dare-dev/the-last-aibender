/**
 * BoundedAckRing — producer-side flow-control mechanics (plan §9.2 BE-2;
 * SPIKE-D vi semantics: bounded memory, zero loss, pause/resume watermarks;
 * ws-protocol.md §6 ack/replay rules).
 */

import { describe, expect, it } from 'vitest';

import { AckRingOverflowError, BoundedAckRing, DEFAULT_FLOW_CONTROL } from './flowControl.js';

const CFG = { capBytes: 64, highWaterBytes: 32, lowWaterBytes: 8 };

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from([...text].map((c) => c.charCodeAt(0)));
}

function asAscii(chunk: Uint8Array): string {
  return String.fromCharCode(...chunk);
}

describe('BoundedAckRing — positive', () => {
  it('delivers pushed bytes in order with absolute offsets', () => {
    const ring = new BoundedAckRing(CFG);
    ring.push(ascii('hello '));
    ring.push(ascii('world'));

    const first = ring.deliverNext(1024);
    expect(first).toBeDefined();
    expect(first?.offset).toBe(0);
    expect(asAscii(first!.bytes)).toBe('hello world');
    expect(ring.deliverNext(1024)).toBeUndefined();
    expect(ring.producedEnd).toBe(11);
    expect(ring.deliveredEnd).toBe(11);
  });

  it('splits delivery at maxBytes without loss or reorder (frame cap)', () => {
    const ring = new BoundedAckRing(CFG);
    ring.push(ascii('abcdefgh'));
    const a = ring.deliverNext(3);
    const b = ring.deliverNext(3);
    const c = ring.deliverNext(3);
    expect([a?.offset, asAscii(a!.bytes)]).toEqual([0, 'abc']);
    expect([b?.offset, asAscii(b!.bytes)]).toEqual([3, 'def']);
    expect([c?.offset, asAscii(c!.bytes)]).toEqual([6, 'gh']);
  });

  it('ack releases retained bytes and advances the floor', () => {
    const ring = new BoundedAckRing(CFG);
    ring.push(ascii('0123456789'));
    ring.deliverNext(1024);
    expect(ring.ack(10)).toBe(false); // nothing paused
    expect(ring.ackedFloor).toBe(10);
    expect(ring.occupancy).toBe(0);
  });

  it('signals pause at highWater and resume at lowWater (SPIKE-D watermarks)', () => {
    const ring = new BoundedAckRing(CFG);
    expect(ring.push(new Uint8Array(31))).toBe(false); // below highWater
    expect(ring.push(new Uint8Array(1))).toBe(true); // occupancy 32 >= high
    expect(ring.paused).toBe(true);

    ring.deliverNext(1024);
    // draining to lowWater or below flips resume exactly once
    expect(ring.ack(20)).toBe(false); // occupancy 12 > lowWater 8
    expect(ring.paused).toBe(true);
    expect(ring.ack(24)).toBe(true); // occupancy 8 <= lowWater
    expect(ring.paused).toBe(false);
    expect(ring.stats().pauseSignals).toBe(1);
    expect(ring.stats().resumeSignals).toBe(1);
  });

  it('replayFrom re-reads retained bytes at original offsets, then live delivery continues', () => {
    const ring = new BoundedAckRing(CFG);
    ring.push(ascii('abcdef'));
    ring.deliverNext(1024);
    ring.ack(2); // release 'ab'

    const replay = ring.replayFrom(3);
    expect(replay.map((c) => [c.offset, asAscii(c.bytes)])).toEqual([[3, 'def']]);

    ring.push(ascii('gh'));
    const next = ring.deliverNext(1024);
    expect([next?.offset, asAscii(next!.bytes)]).toEqual([6, 'gh']);
  });

  it('replay from the exact stream end is a legal empty replay', () => {
    const ring = new BoundedAckRing(CFG);
    ring.push(bytes(1, 2, 3));
    ring.deliverNext(1024);
    expect(ring.replayFrom(3)).toEqual([]);
  });
});

describe('BoundedAckRing — negative', () => {
  it('rejects an ack beyond the delivered offset (watermark-out-of-range axis)', () => {
    const ring = new BoundedAckRing(CFG);
    ring.push(bytes(1, 2, 3));
    ring.deliverNext(2);
    expect(() => ring.ack(3)).toThrow(RangeError);
  });

  it('ignores stale acks (monotonic watermarks, §6)', () => {
    const ring = new BoundedAckRing(CFG);
    ring.push(ascii('abcdef'));
    ring.deliverNext(1024);
    ring.ack(4);
    expect(ring.ack(2)).toBe(false);
    expect(ring.ackedFloor).toBe(4);
  });

  it('rejects replay below the ack floor (released bytes are gone BY DESIGN)', () => {
    const ring = new BoundedAckRing(CFG);
    ring.push(ascii('abcdef'));
    ring.deliverNext(1024);
    ring.ack(4);
    expect(() => ring.replayFrom(3)).toThrow(/precedes ack floor/);
  });

  it('rejects replay beyond the produced end', () => {
    const ring = new BoundedAckRing(CFG);
    ring.push(bytes(1));
    expect(() => ring.replayFrom(2)).toThrow(/beyond stream end/);
  });

  it('throws AckRingOverflowError on cap breach (ignored pause = broker bug)', () => {
    const ring = new BoundedAckRing(CFG);
    ring.push(new Uint8Array(60));
    expect(() => ring.push(new Uint8Array(5))).toThrow(AckRingOverflowError);
  });

  it('rejects malformed watermark inputs', () => {
    const ring = new BoundedAckRing(CFG);
    expect(() => ring.ack(-1)).toThrow(RangeError);
    expect(() => ring.ack(1.5)).toThrow(RangeError);
    expect(() => ring.replayFrom(Number.NaN)).toThrow(RangeError);
  });

  it('rejects invalid watermark configuration', () => {
    expect(() => new BoundedAckRing({ capBytes: 10, highWaterBytes: 20, lowWaterBytes: 1 })).toThrow(
      RangeError,
    );
    expect(() => new BoundedAckRing({ capBytes: 10, highWaterBytes: 5, lowWaterBytes: 5 })).toThrow(
      RangeError,
    );
    expect(
      () => new BoundedAckRing({ capBytes: 10, highWaterBytes: 5, lowWaterBytes: -1 }),
    ).toThrow(RangeError);
  });
});

describe('BoundedAckRing — edge', () => {
  it('offsets stay stable across detach-shaped gaps (no rebasing, ever)', () => {
    const ring = new BoundedAckRing(CFG);
    ring.push(ascii('abc'));
    ring.deliverNext(1024); // consumer read abc, then "detached"
    ring.push(ascii('def')); // output continues while detached
    // reattach replays everything retained from the client's watermark
    const replay = ring.replayFrom(1);
    expect(replay.map((c) => [c.offset, asAscii(c.bytes)])).toEqual([
      [1, 'bc'],
      [3, 'def'],
    ]);
  });

  it('does not alias caller buffers (push copies)', () => {
    const ring = new BoundedAckRing(CFG);
    const source = bytes(9, 9, 9);
    ring.push(source);
    source.fill(0);
    const out = ring.deliverNext(1024);
    expect([...out!.bytes]).toEqual([9, 9, 9]);
  });

  it('empty pushes are no-ops that preserve pause state', () => {
    const ring = new BoundedAckRing(CFG);
    ring.push(new Uint8Array(32));
    expect(ring.paused).toBe(true);
    expect(ring.push(new Uint8Array(0))).toBe(true);
    expect(ring.stats().pauseSignals).toBe(1);
  });

  it('default config matches the SPIKE-D soak values', () => {
    expect(DEFAULT_FLOW_CONTROL).toEqual({
      capBytes: 4 * 1024 * 1024,
      highWaterBytes: 2 * 1024 * 1024,
      lowWaterBytes: 512 * 1024,
    });
  });

  it('sustains a slow-consumer cycle with zero loss (miniature SPIKE-D soak)', () => {
    const ring = new BoundedAckRing({ capBytes: 256, highWaterBytes: 128, lowWaterBytes: 32 });
    const produced: number[] = [];
    const consumed: number[] = [];
    let paused = false;
    let next = 0;
    for (let round = 0; round < 200; round += 1) {
      if (!paused) {
        const chunk = Uint8Array.from({ length: 16 }, () => next++ % 251);
        for (const value of chunk) produced.push(value);
        paused = ring.push(chunk);
      }
      // slow consumer: drains 8 bytes per round
      const slice = ring.deliverNext(8);
      if (slice !== undefined) {
        for (const value of slice.bytes) consumed.push(value);
        const resumed = ring.ack(slice.offset + slice.bytes.byteLength);
        if (resumed) paused = false;
      }
    }
    // final drain
    for (;;) {
      const slice = ring.deliverNext(64);
      if (slice === undefined) break;
      for (const value of slice.bytes) consumed.push(value);
      ring.ack(slice.offset + slice.bytes.byteLength);
    }
    expect(consumed).toEqual(produced); // zero gaps, zero dup/reorder
    expect(ring.stats().peakOccupancy).toBeLessThanOrEqual(256);
    expect(ring.stats().pauseSignals).toBeGreaterThan(0);
    expect(ring.stats().resumeSignals).toBeGreaterThan(0);
  });
});
