import { describe, expect, it } from 'vitest';
import { SeqValidator } from '../src/seqValidator.js';

const rec = (id: number, seq: number, pad = 8): string =>
  `\x1b[2K\x1b[36m<<S${id}:${seq}>>\x1b[0m${'x'.repeat(pad)}\r\n`;

describe('SeqValidator — positive', () => {
  it('accepts a contiguous single-producer stream as clean', () => {
    const v = new SeqValidator();
    for (let s = 1; s <= 500; s += 1) v.feed(rec(3, s));
    const r = v.report();
    expect(r.clean).toBe(true);
    expect(r.producers).toHaveLength(1);
    expect(r.producers[0]?.lastSeq).toBe(500);
    expect(r.producers[0]?.markersSeen).toBe(500);
  });

  it('tracks multiple interleaved producers independently', () => {
    const v = new SeqValidator();
    for (let s = 1; s <= 100; s += 1) {
      v.feed(rec(0, s));
      v.feed(rec(1, s));
    }
    const r = v.report();
    expect(r.clean).toBe(true);
    expect(r.producers.map((p) => p.producerId)).toEqual([0, 1]);
  });
});

describe('SeqValidator — negative', () => {
  it('detects an induced gap (dropped chunk = byte loss)', () => {
    const v = new SeqValidator();
    v.feed(rec(0, 1));
    v.feed(rec(0, 2));
    // rec(0, 3) deliberately dropped
    v.feed(rec(0, 4));
    const r = v.report();
    expect(r.clean).toBe(false);
    expect(r.producers[0]?.gaps).toEqual([{ expected: 3, got: 4 }]);
  });

  it('detects duplicates/reordering', () => {
    const v = new SeqValidator();
    v.feed(rec(0, 1) + rec(0, 2) + rec(0, 2));
    const r = v.report();
    expect(r.clean).toBe(false);
    expect(r.producers[0]?.duplicatesOrReorders).toBe(1);
  });
});

describe('SeqValidator — edge', () => {
  it('parses markers split across arbitrary chunk boundaries', () => {
    const stream = Array.from({ length: 50 }, (_, i) => rec(7, i + 1)).join('');
    // Slice the exact same stream at pathological boundaries (1..17 bytes).
    for (const size of [1, 2, 3, 5, 7, 11, 13, 17]) {
      const v = new SeqValidator();
      for (let off = 0; off < stream.length; off += size) v.feed(stream.slice(off, off + size));
      const r = v.report();
      expect(r.clean, `chunk size ${size}`).toBe(true);
      expect(r.producers[0]?.markersSeen, `chunk size ${size}`).toBe(50);
      expect(r.totalBytes, `chunk size ${size}`).toBe(stream.length);
    }
  });

  it('does not lose markers when long marker-free payload precedes one (carry bounding)', () => {
    const v = new SeqValidator();
    v.feed(`${'y'.repeat(100_000)}`);
    v.feed('<<S1:1');
    v.feed('>>');
    v.feed(rec(1, 2));
    const r = v.report();
    expect(r.clean).toBe(true);
    expect(r.producers[0]?.markersSeen).toBe(2);
  });

  it('empty feeds are no-ops', () => {
    const v = new SeqValidator();
    v.feed('');
    expect(v.report().totalBytes).toBe(0);
    expect(v.report().clean).toBe(true);
  });
});
