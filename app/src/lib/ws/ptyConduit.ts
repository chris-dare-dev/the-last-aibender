/**
 * Per-session PTY byte conduit — the client half of the ack-watermark flow
 * control frozen in ws-protocol.md §5/§6 and proven by SPIKE-D (vi).
 *
 * Discipline:
 *  - OUTPUT bytes arrive as binary frames on the `streamOffset` axis; the
 *    conduit queues them (bounded — never unbounded, plan BE-3/FE-2) until
 *    the terminal island consumes them;
 *  - the island calls {@link PtyConduit.consume} as it writes bytes to
 *    xterm; consumption advances the ack watermark, which is sent to the
 *    broker (coalesced per microtask) so the broker can release its bounded
 *    buffer — pause/resume NEVER crosses the wire;
 *  - on reconnect the conduit asks for replay from the CONSUMED watermark
 *    (`pty-replay-request`); duplicate/overlapping replay bytes are trimmed
 *    on the streamOffset axis so the island never sees a byte twice;
 *  - a broker restart invalidates the byte axis entirely: the conduit resets
 *    and the island re-attaches via its serialize-addon snapshot (FE-3).
 */

import { encodePtyFrame, type PtyClientMessage, type PtyFrame } from '@aibender/protocol';
import { BoundedByteQueue } from '../buffers/ringBuffer.ts';
import { nullLogger, type Logger } from '../log.ts';

/** Broker-side cap is 4 MiB (SPIKE-D); client queue = cap + frame headroom. */
export const PTY_CLIENT_QUEUE_CAP_BYTES = 8 * 1024 * 1024;

export interface PtyConduitIo {
  /** Send a JSON flow-control message on this session's pty channel. */
  sendJson(payload: PtyClientMessage): boolean;
  /** Send raw binary frame bytes on the socket. */
  sendBinary(frame: Uint8Array): boolean;
}

/**
 * OUTPUT byte subscriber. `streamOffset` is the absolute offset of
 * `chunk[0]` on the session's OUTPUT watermark axis (ws-protocol.md §5) —
 * the terminal island's stream tracker consumes exactly this pair.
 */
export type PtyBytesListener = (chunk: Uint8Array, streamOffset: number) => void;

export class PtyConduit {
  /** End of the byte range delivered to the subscriber (exclusive offset). */
  private deliveredEnd = 0;
  /** Ack watermark: every OUTPUT byte with offset < consumed is consumed. */
  private consumed = 0;
  /** Outbound INPUT byte offset axis (client → broker). */
  private inputOffset = 0;
  private queue: BoundedByteQueue;
  private listener: PtyBytesListener | undefined;
  private ackScheduled = false;
  private closed = false;

  constructor(
    readonly sessionId: string,
    private readonly io: PtyConduitIo,
    private readonly logger: Logger = nullLogger,
    capacityBytes: number = PTY_CLIENT_QUEUE_CAP_BYTES,
  ) {
    this.queue = new BoundedByteQueue(capacityBytes);
  }

  /** Bytes delivered but not yet consumed by the island. */
  get bufferedBytes(): number {
    return this.queue.byteLength;
  }

  get consumedWatermark(): number {
    return this.consumed;
  }

  get deliveredWatermark(): number {
    return this.deliveredEnd;
  }

  /**
   * Subscribe the terminal island. Buffered chunks (arrived before attach)
   * are flushed synchronously — bytes are never dropped between frames.
   * Queued chunks are the contiguous trailing range
   * [deliveredEnd − queuedBytes, deliveredEnd), so their offsets are
   * reconstructed cumulatively from that start.
   */
  onBytes(listener: PtyBytesListener): () => void {
    this.listener = listener;
    let offset = this.deliveredEnd - this.queue.byteLength;
    for (const chunk of this.queue.drain()) {
      listener(chunk, offset);
      offset += chunk.byteLength;
    }
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  /** Inbound OUTPUT frame from the router (wsClient calls this). */
  handleFrame(frame: PtyFrame): void {
    if (this.closed || frame.type !== 'output' || frame.sessionId !== this.sessionId) return;
    const start = frame.streamOffset;
    const end = start + frame.payload.byteLength;

    if (end <= this.deliveredEnd) {
      // Whole frame already delivered (replay overlap) — drop silently.
      return;
    }
    if (start > this.deliveredEnd) {
      // Gap on the byte axis: ask for replay from what we actually consumed.
      this.logger.warn('pty byte gap detected — requesting replay', {
        expected: this.deliveredEnd,
        got: start,
      });
      this.requestReplay();
      return;
    }
    // Trim the already-delivered prefix (partial replay overlap).
    const chunk = start < this.deliveredEnd ? frame.payload.subarray(this.deliveredEnd - start) : frame.payload;
    const chunkOffset = this.deliveredEnd; // chunk[0] continues the delivered axis
    this.deliveredEnd = end;
    if (this.listener !== undefined) {
      this.listener(chunk, chunkOffset);
    } else {
      this.queue.push(chunk);
    }
  }

  /**
   * The island reports consumption of `byteCount` more OUTPUT bytes (i.e.
   * written into xterm). Advances the ack watermark; ack sends are coalesced
   * per microtask so a burst of writes produces one wire message.
   */
  consume(byteCount: number): void {
    if (this.closed || byteCount <= 0) return;
    this.consumed = Math.min(this.deliveredEnd, this.consumed + byteCount);
    if (this.ackScheduled) return;
    this.ackScheduled = true;
    queueMicrotask(() => {
      this.ackScheduled = false;
      if (this.closed) return;
      this.io.sendJson({ kind: 'pty-ack', sessionId: this.sessionId, watermark: this.consumed });
    });
  }

  /** Keystrokes / paste from the island → INPUT binary frame. */
  write(data: Uint8Array | string): void {
    if (this.closed) return;
    const payload = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    if (payload.byteLength === 0) return;
    const frame = encodePtyFrame({
      type: 'input',
      sessionId: this.sessionId,
      streamOffset: this.inputOffset,
      payload,
    });
    this.inputOffset += payload.byteLength;
    this.io.sendBinary(frame);
  }

  /** Terminal geometry change (fit addon → broker → kernel PTY). */
  resize(cols: number, rows: number): void {
    if (this.closed) return;
    this.io.sendJson({ kind: 'pty-resize', sessionId: this.sessionId, cols, rows });
  }

  /**
   * New connection, SAME broker boot: replay retained OUTPUT from the
   * consumed watermark. Un-consumed delivered bytes will be re-delivered by
   * the broker, so the delivered axis rewinds to the consumed axis and the
   * pending queue clears (the island only ever consumed up to `consumed`).
   */
  handleReconnected(): void {
    if (this.closed) return;
    this.queue.clear();
    this.deliveredEnd = this.consumed;
    this.requestReplay();
  }

  /**
   * ISLAND-driven replay (TerminalPtyPort.requestReplay): the island holds
   * everything below `fromWatermark` (its serialize-addon snapshot / already
   * written bytes) and wants the wire stream to resume from there. The
   * delivered axis is repositioned so the replayed bytes are NOT dropped as
   * overlap by {@link handleFrame} — without this a reattached island would
   * receive zero bytes (the conduit's own dedupe would eat the replay).
   *
   * Never rewinds below the acked watermark: bytes below the last ack are
   * released broker-side and unrecoverable BY DESIGN (ws-protocol.md §6) —
   * requesting them buys only a `watermark-out-of-range` answer. In every
   * legal island flow `fromWatermark >= consumed` anyway (islands only
   * replay from their own consumed offset, which is ≥ every ack they sent).
   */
  replayFrom(fromWatermark: number): void {
    if (this.closed) return;
    const from = Math.max(fromWatermark, this.consumed);
    this.queue.clear();
    this.consumed = from;
    this.deliveredEnd = from;
    this.io.sendJson({
      kind: 'pty-replay-request',
      sessionId: this.sessionId,
      fromWatermark: from,
    });
  }

  /**
   * Broker RESTART: the byte axis died with the old boot. Reset all
   * watermarks; the island must re-attach from its serialize snapshot.
   */
  handleBrokerRestart(): void {
    this.queue.clear();
    this.deliveredEnd = 0;
    this.consumed = 0;
    this.inputOffset = 0;
  }

  private requestReplay(): void {
    this.io.sendJson({
      kind: 'pty-replay-request',
      sessionId: this.sessionId,
      fromWatermark: this.consumed,
    });
  }

  close(): void {
    this.closed = true;
    this.queue.clear();
    this.listener = undefined;
  }
}
