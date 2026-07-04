import { describe, expect, it } from 'vitest';

import {
  PTY_FRAME_HEADER_BYTES,
  PTY_FRAME_MAGIC,
  PTY_FRAME_MAX_PAYLOAD_BYTES,
  PTY_FRAME_VERSION,
  decodePtyFrame,
  encodePtyFrame,
  validatePtyClientMessage,
  type PtyFrame,
} from './index.js';

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

const frame = (overrides: Partial<PtyFrame> = {}): PtyFrame => ({
  type: 'output',
  sessionId: 'ses_01',
  streamOffset: 0,
  payload: bytesOf('hello [31mworld[0m'),
  ...overrides,
});

describe('binary PTY frame codec', () => {
  // -- positive --------------------------------------------------------------

  it('round-trips output and input frames byte-exactly', () => {
    for (const type of ['output', 'input'] as const) {
      const original = frame({ type, streamOffset: 123_456_789 });
      const encoded = encodePtyFrame(original);
      const decoded = decodePtyFrame(encoded);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.value.type).toBe(type);
        expect(decoded.value.sessionId).toBe('ses_01');
        expect(decoded.value.streamOffset).toBe(123_456_789);
        expect([...decoded.value.payload]).toEqual([...original.payload]);
      }
    }
  });

  it('writes the documented header layout', () => {
    const encoded = encodePtyFrame(frame({ streamOffset: 258 })); // 0x0102
    expect(encoded[0]).toBe(PTY_FRAME_MAGIC);
    expect(encoded[1]).toBe(PTY_FRAME_VERSION);
    expect(encoded[2]).toBe(0x01); // OUTPUT
    expect(encoded[3]).toBe('ses_01'.length);
    // u64 big-endian streamOffset at offset 4:
    expect([...encoded.slice(4, 12)]).toEqual([0, 0, 0, 0, 0, 0, 0x01, 0x02]);
    expect(encoded.length).toBe(PTY_FRAME_HEADER_BYTES + 'ses_01'.length + frame().payload.byteLength);
  });

  it('round-trips an empty payload (keepalive-sized frame)', () => {
    const decoded = decodePtyFrame(encodePtyFrame(frame({ payload: new Uint8Array(0) })));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.payload.byteLength).toBe(0);
  });

  // -- negative --------------------------------------------------------------

  it('encode throws on bad session ids, negative offsets, oversized payloads', () => {
    expect(() => encodePtyFrame(frame({ sessionId: 'dot.ted' }))).toThrow(RangeError);
    expect(() => encodePtyFrame(frame({ sessionId: '' }))).toThrow(RangeError);
    expect(() => encodePtyFrame(frame({ streamOffset: -1 }))).toThrow(RangeError);
    expect(() => encodePtyFrame(frame({ streamOffset: 1.5 }))).toThrow(RangeError);
    expect(() =>
      encodePtyFrame(frame({ payload: new Uint8Array(PTY_FRAME_MAX_PAYLOAD_BYTES + 1) })),
    ).toThrow(RangeError);
  });

  it('decode rejects bad magic, version, frame type, and truncated frames without throwing', () => {
    const good = encodePtyFrame(frame());

    const badMagic = good.slice();
    badMagic[0] = 0x00;
    expect(decodePtyFrame(badMagic).ok).toBe(false);

    const badVersion = good.slice();
    badVersion[1] = 0x7f;
    expect(decodePtyFrame(badVersion).ok).toBe(false);

    const badType = good.slice();
    badType[2] = 0x09;
    expect(decodePtyFrame(badType).ok).toBe(false);

    expect(decodePtyFrame(good.slice(0, PTY_FRAME_HEADER_BYTES)).ok).toBe(false);
    expect(decodePtyFrame(new Uint8Array(0)).ok).toBe(false);
  });

  it('decode rejects header/body length disagreement with oversized-frame', () => {
    const good = encodePtyFrame(frame());
    const truncated = good.slice(0, good.length - 3);
    const result = decodePtyFrame(truncated);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('oversized-frame');
  });

  it('decode rejects a header-declared payload above the cap', () => {
    const good = encodePtyFrame(frame());
    const lied = good.slice();
    const view = new DataView(lied.buffer, lied.byteOffset, lied.byteLength);
    view.setUint32(12, PTY_FRAME_MAX_PAYLOAD_BYTES + 1);
    const result = decodePtyFrame(lied);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('oversized-frame');
  });

  // -- edge ------------------------------------------------------------------

  it('decode works on a subarray view with a non-zero byteOffset', () => {
    const good = encodePtyFrame(frame({ streamOffset: 42 }));
    const padded = new Uint8Array(good.length + 8);
    padded.set(good, 8);
    const view = padded.subarray(8);
    const decoded = decodePtyFrame(view);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.streamOffset).toBe(42);
  });

  it('round-trips the maximum safe streamOffset and rejects beyond it', () => {
    const max = Number.MAX_SAFE_INTEGER;
    const decoded = decodePtyFrame(encodePtyFrame(frame({ streamOffset: max })));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.streamOffset).toBe(max);

    // Forge an offset beyond 2^53-1 directly in the header.
    const forged = encodePtyFrame(frame());
    const view = new DataView(forged.buffer, forged.byteOffset, forged.byteLength);
    view.setBigUint64(4, BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    expect(decodePtyFrame(forged).ok).toBe(false);
  });
});

describe('validatePtyClientMessage (ack-watermark flow control)', () => {
  // -- positive --------------------------------------------------------------

  it('accepts ack, replay-request, and resize', () => {
    expect(
      validatePtyClientMessage({ kind: 'pty-ack', sessionId: 'ses_1', watermark: 0 }).ok,
    ).toBe(true);
    expect(
      validatePtyClientMessage({ kind: 'pty-replay-request', sessionId: 'ses_1', fromWatermark: 1024 }).ok,
    ).toBe(true);
    expect(
      validatePtyClientMessage({ kind: 'pty-resize', sessionId: 'ses_1', cols: 120, rows: 40 }).ok,
    ).toBe(true);
  });

  it('cross-checks the channel session id when provided', () => {
    expect(
      validatePtyClientMessage({ kind: 'pty-ack', sessionId: 'ses_1', watermark: 5 }, 'ses_1').ok,
    ).toBe(true);
  });

  // -- negative --------------------------------------------------------------

  it('rejects unknown kinds, malformed session ids, and channel mismatch', () => {
    expect(validatePtyClientMessage({ kind: 'pty-pause', sessionId: 'ses_1' }).ok).toBe(false);
    expect(validatePtyClientMessage({ kind: 'pty-ack', sessionId: 'no spaces', watermark: 1 }).ok).toBe(false);
    const mismatch = validatePtyClientMessage(
      { kind: 'pty-ack', sessionId: 'ses_2', watermark: 1 },
      'ses_1',
    );
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.message).toContain('does not match');
  });

  it('rejects negative, fractional, and unsafe watermarks', () => {
    expect(validatePtyClientMessage({ kind: 'pty-ack', sessionId: 's', watermark: -1 }).ok).toBe(false);
    expect(validatePtyClientMessage({ kind: 'pty-ack', sessionId: 's', watermark: 0.5 }).ok).toBe(false);
    expect(
      validatePtyClientMessage({ kind: 'pty-ack', sessionId: 's', watermark: Number.MAX_SAFE_INTEGER + 2 }).ok,
    ).toBe(false);
    expect(validatePtyClientMessage({ kind: 'pty-ack', sessionId: 's', watermark: '9' }).ok).toBe(false);
  });

  // -- edge ------------------------------------------------------------------

  it('bounds resize geometry: 1x1 ok, 0 and >max rejected', () => {
    expect(validatePtyClientMessage({ kind: 'pty-resize', sessionId: 's', cols: 1, rows: 1 }).ok).toBe(true);
    expect(validatePtyClientMessage({ kind: 'pty-resize', sessionId: 's', cols: 0, rows: 40 }).ok).toBe(false);
    expect(validatePtyClientMessage({ kind: 'pty-resize', sessionId: 's', cols: 120, rows: 4097 }).ok).toBe(false);
  });

  it('accepts watermark 0 (nothing consumed yet) — the reconnect-from-start case', () => {
    expect(
      validatePtyClientMessage({ kind: 'pty-replay-request', sessionId: 's', fromWatermark: 0 }).ok,
    ).toBe(true);
  });
});
