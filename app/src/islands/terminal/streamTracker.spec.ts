/**
 * OutputStreamTracker — offset axis discipline (ws-protocol.md §5/§6), unit
 * coverage per plan §9.2 FE-3 (positive: in-order echo path; negative:
 * gap/duplicate handling; edge: overlap trim, ack monotonicity), replayed
 * against the EXISTING golden binary corpus (packages/testkit — never a
 * parallel one).
 */

import { describe, expect, it } from 'vitest';
import { decodePtyFrame } from '@aibender/protocol';
import {
  GOLDEN_WS_FIXTURES,
  goldenFrameBytes,
  type GoldenWsBinaryFixture,
} from '@aibender/testkit';
import { OutputStreamTracker } from './streamTracker.ts';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const utf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('OutputStreamTracker', () => {
  it('writes in-order chunks and acks consumption monotonically', () => {
    const t = new OutputStreamTracker();
    const a = t.accept(0, text('hello '));
    expect(a.action).toBe('write');
    expect(utf8(a.data as Uint8Array)).toBe('hello ');
    const b = t.accept(6, text('world'));
    expect(b.action).toBe('write');
    expect(t.expectedOffset).toBe(11);

    expect(t.takeAckWatermark()).toBeNull(); // nothing consumed yet
    t.markConsumed(6);
    expect(t.takeAckWatermark()).toBe(6);
    expect(t.takeAckWatermark()).toBeNull(); // monotonic — no re-ack
    t.markConsumed(11);
    expect(t.takeAckWatermark()).toBe(11);
  });

  it('drops full duplicates (replay overshoot) silently', () => {
    const t = new OutputStreamTracker();
    t.accept(0, text('abcdef'));
    expect(t.accept(0, text('abcdef')).action).toBe('duplicate');
    expect(t.accept(2, text('cd')).action).toBe('duplicate');
    expect(t.expectedOffset).toBe(6);
  });

  it('trims overlapping prefixes and writes only new bytes', () => {
    const t = new OutputStreamTracker();
    t.accept(0, text('abcdef'));
    const out = t.accept(4, text('efGHI'));
    expect(out.action).toBe('write');
    expect(utf8(out.data as Uint8Array)).toBe('GHI');
    expect(t.expectedOffset).toBe(9);
  });

  it('classifies future bytes as a gap and requests replay ONCE per gap position', () => {
    const t = new OutputStreamTracker();
    t.accept(0, text('abc'));
    const gap1 = t.accept(10, text('xyz'));
    expect(gap1.action).toBe('gap');
    expect(gap1.replayFrom).toBe(3);
    const gap2 = t.accept(13, text('qrs'));
    expect(gap2.action).toBe('gap');
    expect(gap2.replayFrom).toBeUndefined(); // one outstanding request per gap

    // replay fills the hole → stream advances → a NEW gap re-requests
    expect(t.accept(3, text('defghij')).action).toBe('write');
    expect(t.expectedOffset).toBe(10);
    const gap3 = t.accept(20, text('!!'));
    expect(gap3.replayFrom).toBe(10);
  });

  it('treats an empty chunk at the expected offset as a no-op', () => {
    const t = new OutputStreamTracker();
    t.accept(0, text('ab'));
    expect(t.accept(2, new Uint8Array(0)).action).toBe('duplicate');
    expect(t.expectedOffset).toBe(2);
  });

  it('clamps markConsumed to received bytes (acks never run ahead of the wire)', () => {
    const t = new OutputStreamTracker();
    t.accept(0, text('abc'));
    t.markConsumed(999);
    expect(t.takeAckWatermark()).toBe(3);
  });

  it('honors a non-zero start offset (reattach path)', () => {
    const t = new OutputStreamTracker(4096);
    expect(t.accept(0, text('old')).action).toBe('duplicate');
    const out = t.accept(4096, text('new'));
    expect(out.action).toBe('write');
    t.markConsumed(4099);
    expect(t.takeAckWatermark()).toBe(4099);
  });

  it('rejects an invalid start offset', () => {
    expect(() => new OutputStreamTracker(-1)).toThrow(RangeError);
    expect(() => new OutputStreamTracker(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
  });

  describe('golden binary corpus replay (packages/testkit — the BE↔FE device)', () => {
    const binaryFixtures = GOLDEN_WS_FIXTURES.filter(
      (f): f is GoldenWsBinaryFixture => f.kind === 'binary',
    );

    it('has the frozen corpus available', () => {
      expect(binaryFixtures.length).toBeGreaterThan(0);
    });

    it('feeds every VALID OUTPUT frame through decode → tracker → ack', () => {
      const outputs = binaryFixtures.filter(
        (f) => f.expect.valid && f.decoded?.type === 'output',
      );
      expect(outputs.length).toBeGreaterThan(0);
      for (const fixture of outputs) {
        const decoded = decodePtyFrame(goldenFrameBytes(fixture));
        expect(decoded.ok, fixture.name).toBe(true);
        if (!decoded.ok || !fixture.decoded) continue;
        const t = new OutputStreamTracker(fixture.decoded.streamOffset);
        const out = t.accept(decoded.value.streamOffset, decoded.value.payload);
        expect(out.action, fixture.name).toBe('write');
        expect(utf8(out.data as Uint8Array), fixture.name).toBe(fixture.decoded.payloadUtf8);
        t.markConsumed(decoded.value.streamOffset + decoded.value.payload.byteLength);
        expect(t.takeAckWatermark(), fixture.name).toBe(
          fixture.decoded.streamOffset + fixture.decoded.payloadUtf8.length,
        );
      }
    });

    it('every INVALID binary fixture is rejected at decode with the pinned code (never reaches the tracker)', () => {
      const invalid = binaryFixtures.filter((f) => !f.expect.valid);
      expect(invalid.length).toBeGreaterThan(0);
      for (const fixture of invalid) {
        const decoded = decodePtyFrame(goldenFrameBytes(fixture));
        expect(decoded.ok, fixture.name).toBe(false);
        if (decoded.ok || fixture.expect.valid) continue;
        expect(decoded.code, fixture.name).toBe(fixture.expect.code);
      }
    });
  });
});
