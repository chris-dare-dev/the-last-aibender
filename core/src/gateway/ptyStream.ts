/**
 * PtySessionStream — the gateway's CONSUMER side of the SPIKE-D ack-watermark
 * flow-control discipline (ws-protocol.md §5/§6, FROZEN-M1-CORE; mechanics
 * proven by docs/spikes/spike-d-pty-supervision.md (vi) and prototyped in
 * spikes/pty-supervision/src/ackBuffer.ts — conclusions copied, code
 * re-implemented for the multi-consumer gateway).
 *
 * One instance per live PTY session. Responsibilities:
 *
 *  - assign absolute `streamOffset`s to the host's OUTPUT bytes (the frozen
 *    watermark axis) by counting from session byte 0;
 *  - retain bytes in a BOUNDED buffer until every attached consumer has
 *    acked past them (release floor = min ack watermark — the slowest
 *    consumer gates release, exactly the SPIKE-D soak posture);
 *  - deliver to each consumer independently, capped at
 *    `deliveryWindowBytes` of unacked in-flight bytes per consumer so one
 *    slow WebSocket cannot balloon its socket buffer — delivery resumes as
 *    its acks advance;
 *  - pull the producer's pause()/resume() levers when occupancy crosses
 *    highWater/lowWater. PAUSE/RESUME NEVER CROSS THE WIRE (§6); a cap
 *    breach means the producer ignored pause — a broker bug (assertion,
 *    {@link PtyBufferOverflowError}), never a wire condition. Bytes are
 *    NEVER dropped;
 *  - serve reconnect replays from the retained window: a `fromWatermark`
 *    below the release floor is unrecoverable BY DESIGN (those bytes were
 *    released; the client re-attaches via the serialize-addon snapshot —
 *    SPIKE-C) and answers `watermark-out-of-range`.
 *
 * The class is transport-agnostic: consumers are sinks receiving
 * (streamOffset, bytes) slices already split to the frame payload cap; the
 * server encodes them as binary OUTPUT frames. All wire-facing refusals are
 * returned as values (never thrown) so the server can push the frozen error
 * envelope verbatim.
 */

import { PTY_FRAME_MAX_PAYLOAD_BYTES, type ErrorCode } from '@aibender/protocol';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PtyFlowControlOptions {
  /** Hard cap on retained (unreleased) bytes. Breach = broker bug (throw). */
  readonly capBytes: number;
  /** Occupancy at/above which the producer is paused. Must be <= capBytes. */
  readonly highWater: number;
  /** Occupancy at/below which a paused producer resumes. Must be < highWater. */
  readonly lowWater: number;
  /**
   * Max bytes delivered to one consumer beyond its ack watermark. Bounds the
   * per-connection socket buffer for slow consumers; must be >= 1.
   */
  readonly deliveryWindowBytes: number;
  /** Max bytes per delivered slice (== the binary frame payload cap, §5). */
  readonly maxFramePayloadBytes: number;
}

/**
 * SPIKE-D soak values (cap 4 MiB · high 2 MiB · low 512 KiB). Production
 * tuning is BE-3 configuration — the MECHANISM is the frozen contract, not
 * these numbers (ws-protocol.md §6).
 */
export const DEFAULT_PTY_FLOW_CONTROL: PtyFlowControlOptions = Object.freeze({
  capBytes: 4 * 1024 * 1024,
  highWater: 2 * 1024 * 1024,
  lowWater: 512 * 1024,
  deliveryWindowBytes: 1024 * 1024,
  maxFramePayloadBytes: PTY_FRAME_MAX_PAYLOAD_BYTES,
});

// ---------------------------------------------------------------------------
// Results / errors
// ---------------------------------------------------------------------------

export type PtyStreamResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

const OK: PtyStreamResult = { ok: true };

function outOfRange(message: string): PtyStreamResult {
  return { ok: false, code: 'watermark-out-of-range', message };
}

/** The producer ignored pause() and pushed past capBytes — a broker bug. */
export class PtyBufferOverflowError extends Error {
  override readonly name = 'PtyBufferOverflowError';
  constructor(occupancy: number, capBytes: number) {
    super(
      `pty ack buffer overflow: occupancy ${occupancy} > capBytes ${capBytes} — ` +
        'the producer pause was not honored (broker bug, never a wire condition)',
    );
  }
}

// ---------------------------------------------------------------------------
// Consumer surface
// ---------------------------------------------------------------------------

/** Receives ordered (streamOffset, bytes) slices, pre-split to the frame cap. */
export interface PtyDeliverySink {
  deliver(streamOffset: number, data: Uint8Array): void;
}

/** One attached consumer (a connection's view of the session stream). */
export interface PtyConsumerHandle {
  /**
   * §6 `pty-ack`: every OUTPUT byte with offset < watermark is consumed.
   * Monotonic — a stale (lower) watermark is ignored (ok); a watermark
   * beyond this consumer's delivered offset answers `watermark-out-of-range`.
   */
  ack(watermark: number): PtyStreamResult;
  /**
   * §6 `pty-replay-request` for an ALREADY-attached consumer: re-deliver
   * retained bytes from `fromWatermark`. Below the release floor or beyond
   * the stream head answers `watermark-out-of-range`.
   */
  replayFrom(fromWatermark: number): PtyStreamResult;
  /** Detach (connection closed). Recomputes the release floor. */
  detach(): void;
  /** This consumer's delivered/acked offsets (tests/observability). */
  offsets(): { readonly deliveredTo: number; readonly acked: number };
}

export type PtyAttachResult =
  | { readonly ok: true; readonly consumer: PtyConsumerHandle }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

// ---------------------------------------------------------------------------
// Stats (tests/observability)
// ---------------------------------------------------------------------------

export interface PtyStreamStats {
  /** Total OUTPUT bytes ever pushed (== next streamOffset). */
  readonly head: number;
  /** First retained offset (bytes below it were released). */
  readonly floor: number;
  /** head - floor: the bounded quantity. */
  readonly occupancy: number;
  readonly peakOccupancy: number;
  readonly paused: boolean;
  readonly consumerCount: number;
  readonly exited: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface RetainedChunk {
  /** Absolute stream offset of data[0]. */
  readonly offset: number;
  readonly data: Uint8Array;
}

interface ConsumerState {
  readonly sink: PtyDeliverySink;
  /** Next offset to deliver to this consumer. */
  deliveredTo: number;
  /** This consumer's monotonic ack watermark. */
  acked: number;
  detached: boolean;
}

export interface PtyStreamProducer {
  pause(): void;
  resume(): void;
}

export class PtySessionStream {
  readonly #producer: PtyStreamProducer;
  readonly #opts: PtyFlowControlOptions;
  #chunks: RetainedChunk[] = [];
  #head = 0;
  #floor = 0;
  #peakOccupancy = 0;
  #paused = false;
  #exited = false;
  readonly #consumers = new Set<ConsumerState>();

  constructor(producer: PtyStreamProducer, options: Partial<PtyFlowControlOptions> = {}) {
    const opts: PtyFlowControlOptions = { ...DEFAULT_PTY_FLOW_CONTROL, ...options };
    if (!(opts.lowWater >= 0 && opts.lowWater < opts.highWater && opts.highWater <= opts.capBytes)) {
      throw new RangeError(
        'invalid pty flow-control watermarks: require 0 <= lowWater < highWater <= capBytes, got ' +
          `low=${opts.lowWater} high=${opts.highWater} cap=${opts.capBytes}`,
      );
    }
    if (!Number.isSafeInteger(opts.deliveryWindowBytes) || opts.deliveryWindowBytes < 1) {
      throw new RangeError('deliveryWindowBytes must be a positive integer');
    }
    if (
      !Number.isSafeInteger(opts.maxFramePayloadBytes) ||
      opts.maxFramePayloadBytes < 1 ||
      opts.maxFramePayloadBytes > PTY_FRAME_MAX_PAYLOAD_BYTES
    ) {
      throw new RangeError(
        `maxFramePayloadBytes must be 1..${PTY_FRAME_MAX_PAYLOAD_BYTES} (the frozen frame cap)`,
      );
    }
    this.#producer = producer;
    this.#opts = opts;
  }

  /** Bytes retained and not yet released (the bounded quantity). */
  get occupancy(): number {
    return this.#head - this.#floor;
  }

  stats(): PtyStreamStats {
    return {
      head: this.#head,
      floor: this.#floor,
      occupancy: this.occupancy,
      peakOccupancy: this.#peakOccupancy,
      paused: this.#paused,
      consumerCount: this.#consumers.size,
      exited: this.#exited,
    };
  }

  /**
   * Producer OUTPUT bytes. Assigns offsets [head, head+len), retains them,
   * delivers to every attached consumer within its window, and pulls the
   * pause lever when occupancy crosses highWater. Throws
   * {@link PtyBufferOverflowError} on a cap breach (pause was ignored).
   */
  push(chunk: Uint8Array): void {
    if (this.#exited || chunk.byteLength === 0) return;
    const next = this.occupancy + chunk.byteLength;
    if (next > this.#opts.capBytes) {
      throw new PtyBufferOverflowError(next, this.#opts.capBytes);
    }
    // Defensive copy: the host may reuse its read buffer across emits.
    this.#chunks.push({ offset: this.#head, data: chunk.slice() });
    this.#head += chunk.byteLength;
    if (next > this.#peakOccupancy) this.#peakOccupancy = next;
    if (!this.#paused && next >= this.#opts.highWater) {
      this.#paused = true;
      this.#producer.pause();
    }
    for (const consumer of this.#consumers) this.#deliverMore(consumer);
  }

  /**
   * Session ended: no more producer bytes; the retained window stays
   * replayable (trailing output survives until the gateway closes) and the
   * backpressure levers become no-ops.
   */
  markExited(): void {
    this.#exited = true;
  }

  /**
   * Attach a consumer at `fromWatermark` (§6 `pty-replay-request` from a
   * connection not yet attached — the attach verb). Everything retained from
   * `fromWatermark` replays immediately (window-capped), then live flow
   * continues.
   */
  attach(sink: PtyDeliverySink, fromWatermark: number): PtyAttachResult {
    const bounds = this.#checkWatermarkBounds(fromWatermark);
    if (bounds !== undefined) return { ok: false, code: bounds.code, message: bounds.message };

    const state: ConsumerState = {
      sink,
      deliveredTo: fromWatermark,
      acked: fromWatermark,
      detached: false,
    };
    this.#consumers.add(state);
    // A consumer attaching above the previous floor may raise it (bytes below
    // every consumer's ack are releasable).
    this.#recomputeFloor();
    this.#deliverMore(state);

    const stream = this;
    const consumer: PtyConsumerHandle = {
      ack(watermark: number): PtyStreamResult {
        if (state.detached) return outOfRange('consumer is detached');
        if (watermark > state.deliveredTo) {
          return outOfRange('ack watermark is beyond the delivered offset');
        }
        if (watermark <= state.acked) return OK; // stale/duplicate: monotonic, ignored
        state.acked = watermark;
        stream.#recomputeFloor();
        stream.#deliverMore(state); // the ack opened delivery window
        return OK;
      },
      replayFrom(fromOffset: number): PtyStreamResult {
        if (state.detached) return outOfRange('consumer is detached');
        const check = stream.#checkWatermarkBounds(fromOffset);
        if (check !== undefined) return check;
        state.deliveredTo = fromOffset;
        // acked never regresses (monotonic §6); the delivery window below is
        // therefore at least [fromOffset, acked + window).
        stream.#deliverMore(state);
        return OK;
      },
      detach(): void {
        if (state.detached) return;
        state.detached = true;
        stream.#consumers.delete(state);
        stream.#recomputeFloor();
      },
      offsets: () => ({ deliveredTo: state.deliveredTo, acked: state.acked }),
    };
    return { ok: true, consumer };
  }

  // ---- internals -----------------------------------------------------------

  #checkWatermarkBounds(
    watermark: number,
  ): { readonly ok: false; readonly code: ErrorCode; readonly message: string } | undefined {
    if (watermark < this.#floor) {
      // §6: below the release floor is unrecoverable BY DESIGN — those bytes
      // were released; the client re-attaches via the serialize snapshot.
      return {
        ok: false,
        code: 'watermark-out-of-range',
        message: 'watermark precedes the released offset — bytes are no longer retained',
      };
    }
    if (watermark > this.#head) {
      return {
        ok: false,
        code: 'watermark-out-of-range',
        message: 'watermark is beyond the session stream head',
      };
    }
    return undefined;
  }

  /** Deliver retained bytes to one consumer up to min(head, acked + window). */
  #deliverMore(consumer: ConsumerState): void {
    const limit = Math.min(this.#head, consumer.acked + this.#opts.deliveryWindowBytes);
    while (consumer.deliveredTo < limit) {
      const slice = this.#sliceAt(consumer.deliveredTo, limit);
      if (slice === undefined) break; // nothing retained at the cursor (broker bug guard)
      consumer.sink.deliver(consumer.deliveredTo, slice);
      consumer.deliveredTo += slice.byteLength;
    }
  }

  /** One frame-capped slice starting at `offset`, bounded by `limit`. */
  #sliceAt(offset: number, limit: number): Uint8Array | undefined {
    for (const chunk of this.#chunks) {
      const chunkEnd = chunk.offset + chunk.data.byteLength;
      if (chunkEnd <= offset) continue;
      if (chunk.offset > offset) return undefined; // gap: released bytes (guarded upstream)
      const start = offset - chunk.offset;
      const take = Math.min(chunkEnd, limit) - offset;
      const capped = Math.min(take, this.#opts.maxFramePayloadBytes);
      if (capped <= 0) return undefined;
      return chunk.data.subarray(start, start + capped);
    }
    return undefined;
  }

  /**
   * Release floor = min ack across attached consumers (the slowest consumer
   * gates release — SPIKE-D). With zero consumers the floor FREEZES so a
   * reconnecting client can replay everything since its last ack; memory
   * stays bounded because the producer pauses at highWater.
   */
  #recomputeFloor(): void {
    if (this.#consumers.size === 0) return;
    let min = Number.MAX_SAFE_INTEGER;
    for (const consumer of this.#consumers) {
      if (consumer.acked < min) min = consumer.acked;
    }
    if (min <= this.#floor) return;
    this.#floor = min;
    // Garbage-collect fully released chunks.
    let drop = 0;
    for (const chunk of this.#chunks) {
      if (chunk.offset + chunk.data.byteLength <= min) drop += 1;
      else break;
    }
    if (drop > 0) this.#chunks = this.#chunks.slice(drop);
    if (this.#paused && this.occupancy <= this.#opts.lowWater) {
      this.#paused = false;
      if (!this.#exited) this.#producer.resume();
    }
  }
}
