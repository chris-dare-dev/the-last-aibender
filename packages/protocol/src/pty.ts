/**
 * Binary PTY frame format + ack-watermark flow-control message types.
 *
 * PTY BYTES travel as binary WebSocket frames (this codec); FLOW CONTROL and
 * resize travel as JSON envelopes on the same `pty.<sid>` channel. Pause and
 * resume of the producer NEVER cross the wire — backpressure is broker-internal
 * (pty.pause()/resume() against the bounded ack buffer), exactly as proven by
 * SPIKE-D (vi): bounded memory, zero byte loss, producer throttled to the
 * slowest consumer (docs/spikes/spike-d-pty-supervision.md).
 *
 * Binary frame layout (big-endian, header = 16 fixed bytes + sid):
 *
 *   offset 0   u8   magic          0xAB
 *   offset 1   u8   version        0x01
 *   offset 2   u8   frameType      0x01 OUTPUT (broker→client) | 0x02 INPUT (client→broker)
 *   offset 3   u8   sidLength      1..MAX_SESSION_ID_BYTES
 *   offset 4   u64  streamOffset   absolute byte offset of payload[0] within the
 *                                  session's PTY byte stream (the watermark axis)
 *   offset 12  u32  payloadLength  0..PTY_FRAME_MAX_PAYLOAD_BYTES
 *   offset 16  ...  sessionId      ASCII, charset = SESSION_ID_SEGMENT_RE
 *   offset 16+sidLength  payload   raw PTY bytes
 *
 * The codec uses Uint8Array + DataView only (no Buffer) so it runs unchanged
 * in the WKWebView frontend and the Node broker.
 *
 * ============================================================================
 * FROZEN-M1-CORE (2026-07-04). Amendments only via ICR (docs/contracts/icr/);
 * BE-ORCH lands, FE-ORCH co-signs. Prose of record: docs/contracts/ws-protocol.md.
 * ============================================================================
 */

import { MAX_SESSION_ID_BYTES, SESSION_ID_SEGMENT_RE, isSessionIdSegment } from './channels.js';
import type { ValidationResult } from './result.js';
import { invalid, valid } from './result.js';

// ---------------------------------------------------------------------------
// Binary frame constants + codec
// ---------------------------------------------------------------------------

export const PTY_FRAME_MAGIC = 0xab;
export const PTY_FRAME_VERSION = 0x01;
/** Fixed header bytes before the session-id segment. */
export const PTY_FRAME_HEADER_BYTES = 16;
/** Hard cap per frame; larger output is split by the sender. Oversized inbound frames are rejected. */
export const PTY_FRAME_MAX_PAYLOAD_BYTES = 1 * 1024 * 1024; // 1 MiB

export const PTY_FRAME_TYPE = Object.freeze({
  /** Broker → client: PTY output bytes. */
  OUTPUT: 0x01,
  /** Client → broker: keystrokes/paste for the attended session. */
  INPUT: 0x02,
} as const);

export type PtyFrameKind = 'output' | 'input';

export interface PtyFrame {
  readonly type: PtyFrameKind;
  readonly sessionId: string;
  /**
   * Absolute byte offset of payload[0] in this session's directional byte
   * stream. OUTPUT offsets are the axis acks/replays reference. Must stay a
   * safe integer (2^53-1 bytes ≈ 8 PiB per session — unreachable in practice).
   */
  readonly streamOffset: number;
  readonly payload: Uint8Array;
}

const FRAME_TYPE_BY_CODE: Readonly<Record<number, PtyFrameKind>> = Object.freeze({
  [PTY_FRAME_TYPE.OUTPUT]: 'output',
  [PTY_FRAME_TYPE.INPUT]: 'input',
});

const CODE_BY_FRAME_TYPE: Readonly<Record<PtyFrameKind, number>> = Object.freeze({
  output: PTY_FRAME_TYPE.OUTPUT,
  input: PTY_FRAME_TYPE.INPUT,
});

/** Session ids are ASCII by construction (SESSION_ID_SEGMENT_RE); encode 1 byte/char. */
function encodeAsciiInto(target: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    target[offset + i] = text.charCodeAt(i);
  }
}

function decodeAscii(bytes: Uint8Array, start: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(bytes[start + i] as number);
  }
  return out;
}

/**
 * Encode a PTY frame. Throws RangeError on invalid input — encoding errors are
 * programmer errors on the producing side, never wire conditions.
 */
export function encodePtyFrame(frame: PtyFrame): Uint8Array {
  if (!isSessionIdSegment(frame.sessionId)) {
    throw new RangeError(
      `invalid PTY frame session id ${JSON.stringify(frame.sessionId)} ` +
        `(want ${SESSION_ID_SEGMENT_RE.source}, <= ${MAX_SESSION_ID_BYTES} chars)`,
    );
  }
  if (!Number.isSafeInteger(frame.streamOffset) || frame.streamOffset < 0) {
    throw new RangeError(`invalid streamOffset ${String(frame.streamOffset)} (want non-negative safe integer)`);
  }
  if (frame.payload.byteLength > PTY_FRAME_MAX_PAYLOAD_BYTES) {
    throw new RangeError(
      `payload ${frame.payload.byteLength} bytes exceeds PTY_FRAME_MAX_PAYLOAD_BYTES ${PTY_FRAME_MAX_PAYLOAD_BYTES}`,
    );
  }
  const sidLength = frame.sessionId.length;
  const bytes = new Uint8Array(PTY_FRAME_HEADER_BYTES + sidLength + frame.payload.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, PTY_FRAME_MAGIC);
  view.setUint8(1, PTY_FRAME_VERSION);
  view.setUint8(2, CODE_BY_FRAME_TYPE[frame.type]);
  view.setUint8(3, sidLength);
  view.setBigUint64(4, BigInt(frame.streamOffset));
  view.setUint32(12, frame.payload.byteLength);
  encodeAsciiInto(bytes, PTY_FRAME_HEADER_BYTES, frame.sessionId);
  bytes.set(frame.payload, PTY_FRAME_HEADER_BYTES + sidLength);
  return bytes;
}

/**
 * Decode a binary frame received from the wire. Never throws on wire data:
 * malformed input yields `{ ok: false }` with an error code the gateway can
 * push back verbatim.
 */
export function decodePtyFrame(bytes: Uint8Array): ValidationResult<PtyFrame> {
  if (bytes.byteLength < PTY_FRAME_HEADER_BYTES + 1) {
    return invalid('oversized-frame', `frame too short: ${bytes.byteLength} bytes (min header ${PTY_FRAME_HEADER_BYTES} + 1-byte sid)`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== PTY_FRAME_MAGIC) {
    return invalid('oversized-frame', `bad magic 0x${view.getUint8(0).toString(16)} (want 0x${PTY_FRAME_MAGIC.toString(16)})`);
  }
  if (view.getUint8(1) !== PTY_FRAME_VERSION) {
    return invalid('oversized-frame', `unsupported frame version ${view.getUint8(1)} (want ${PTY_FRAME_VERSION})`);
  }
  const type = FRAME_TYPE_BY_CODE[view.getUint8(2)];
  if (type === undefined) {
    return invalid('oversized-frame', `unknown frame type 0x${view.getUint8(2).toString(16)}`);
  }
  const sidLength = view.getUint8(3);
  if (sidLength < 1 || sidLength > MAX_SESSION_ID_BYTES) {
    return invalid('oversized-frame', `sid length ${sidLength} out of range 1..${MAX_SESSION_ID_BYTES}`);
  }
  const streamOffsetBig = view.getBigUint64(4);
  if (streamOffsetBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    return invalid('oversized-frame', `streamOffset ${streamOffsetBig} beyond safe-integer range`);
  }
  const payloadLength = view.getUint32(12);
  if (payloadLength > PTY_FRAME_MAX_PAYLOAD_BYTES) {
    return invalid('oversized-frame', `payload ${payloadLength} bytes exceeds cap ${PTY_FRAME_MAX_PAYLOAD_BYTES}`);
  }
  const expected = PTY_FRAME_HEADER_BYTES + sidLength + payloadLength;
  if (bytes.byteLength !== expected) {
    return invalid('oversized-frame', `frame length ${bytes.byteLength} != header-declared ${expected}`);
  }
  const sessionId = decodeAscii(bytes, PTY_FRAME_HEADER_BYTES, sidLength);
  if (!isSessionIdSegment(sessionId)) {
    return invalid('oversized-frame', `frame session id fails charset ${SESSION_ID_SEGMENT_RE.source}`);
  }
  const payload = bytes.slice(PTY_FRAME_HEADER_BYTES + sidLength);
  return valid({ type, sessionId, streamOffset: Number(streamOffsetBig), payload });
}

// ---------------------------------------------------------------------------
// Ack-watermark flow-control messages (JSON, on the `pty.<sid>` channel)
// ---------------------------------------------------------------------------

/**
 * Client → broker: every OUTPUT byte with absolute offset < `watermark` has
 * been consumed and may be released from the bounded ack buffer. Watermarks
 * are monotonic; a stale (lower) watermark is ignored by the gateway, and a
 * watermark beyond the delivered offset is answered with
 * `watermark-out-of-range`.
 */
export interface PtyAck {
  readonly kind: 'pty-ack';
  readonly sessionId: string;
  readonly watermark: number;
}

/**
 * Client → broker on reconnect: replay every retained OUTPUT byte from
 * `fromWatermark` onward. A watermark below the last ack is unrecoverable by
 * design (those bytes were released) → `watermark-out-of-range`.
 */
export interface PtyReplayRequest {
  readonly kind: 'pty-replay-request';
  readonly sessionId: string;
  readonly fromWatermark: number;
}

/** Client → broker: terminal geometry change for the attended session. */
export interface PtyResize {
  readonly kind: 'pty-resize';
  readonly sessionId: string;
  readonly cols: number;
  readonly rows: number;
}

/** Sanity bounds for resize (xterm.js practical limits, generous). */
export const PTY_MAX_COLS = 4096;
export const PTY_MAX_ROWS = 4096;

export type PtyClientMessage = PtyAck | PtyReplayRequest | PtyResize;

export const PTY_CLIENT_MESSAGE_KINDS = Object.freeze([
  'pty-ack',
  'pty-replay-request',
  'pty-resize',
] as const);
