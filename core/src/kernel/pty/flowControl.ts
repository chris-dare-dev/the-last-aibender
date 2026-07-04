/**
 * BoundedAckRing — the PRODUCER side of the frozen ack-watermark flow-control
 * mechanism (BE-2; ws-protocol.md §6, FROZEN-M1-CORE; SPIKE-D vi verdict:
 * bounded memory, zero byte loss, backpressure to the producer —
 * docs/spikes/spike-d-pty-supervision.md).
 *
 * Port of the spike's BoundedAckBuffer (spikes/pty-supervision/src/ackBuffer.ts
 * — conclusions copied, semantics preserved) onto binary PTY output:
 *
 *   - chunks are Uint8Array PTY bytes at ABSOLUTE stream offsets — the
 *     `streamOffset` watermark axis of the binary frame format (§5). Offsets
 *     are stable for the lifetime of the session: detach/reattach and recycle
 *     never rebase them (serialize-addon-friendly, plan §4/BE-2);
 *   - occupancy (bytes produced but not yet acked) is HARD-bounded: at/above
 *     `highWaterBytes` the owner must pause the producer (pty.pause() — the
 *     kernel PTY buffer then fills and the child's TTY write blocks); an ack
 *     draining to `lowWaterBytes` allows resume;
 *   - bytes are NEVER dropped. A cap breach means a pause signal was ignored —
 *     that is a broker bug (assertion error), not a wire condition (§6);
 *   - acks are monotonic: stale watermarks are ignored; a watermark beyond the
 *     delivered offset is the caller's `watermark-out-of-range`;
 *   - replay-from-watermark re-reads every RETAINED byte at its original
 *     offset. Below the ack floor is unrecoverable BY DESIGN (those bytes were
 *     released) — the client re-attaches via its serialize-addon snapshot.
 *
 * The ring holds raw bytes only. It never inspects them — PTY semantics are
 * never parsed from bytes (blueprint §4.1; architectural test in
 * architecture.spec.ts).
 */

// ---------------------------------------------------------------------------
// Configuration (SPIKE-D-proven defaults; production tuning is composition
// configuration — the MECHANISM is the contract, ws-protocol.md §6)
// ---------------------------------------------------------------------------

export interface FlowControlConfig {
  /** Hard cap on unacked bytes retained per session. Breach = broker bug. */
  readonly capBytes: number;
  /** Occupancy at/above which the producer must pause. <= capBytes. */
  readonly highWaterBytes: number;
  /** Occupancy at/below which a paused producer may resume. < highWater. */
  readonly lowWaterBytes: number;
}

/** SPIKE-D soak values: cap 4 MiB, highWater 2 MiB, lowWater 512 KiB. */
export const DEFAULT_FLOW_CONTROL: FlowControlConfig = Object.freeze({
  capBytes: 4 * 1024 * 1024,
  highWaterBytes: 2 * 1024 * 1024,
  lowWaterBytes: 512 * 1024,
});

export interface AckRingStats {
  readonly bytesIn: number;
  readonly bytesDelivered: number;
  readonly bytesAcked: number;
  readonly occupancy: number;
  readonly peakOccupancy: number;
  readonly pauseSignals: number;
  readonly resumeSignals: number;
}

/** A retained byte run at its absolute stream offset (frame-ready). */
export interface OffsetChunk {
  /** Absolute offset of bytes[0] in the session's OUTPUT stream. */
  readonly offset: number;
  readonly bytes: Uint8Array;
}

/** Occupancy exceeded capBytes: a pause signal was ignored. Broker bug. */
export class AckRingOverflowError extends Error {
  override readonly name = 'AckRingOverflowError';
  constructor(occupancy: number, capBytes: number) {
    super(
      `BoundedAckRing overflow: occupancy ${occupancy} > capBytes ${capBytes} — ` +
        'a producer pause signal was not honored (broker bug, never a wire condition)',
    );
  }
}

// ---------------------------------------------------------------------------
// BoundedAckRing
// ---------------------------------------------------------------------------

export class BoundedAckRing {
  readonly #config: FlowControlConfig;
  #chunks: OffsetChunk[] = [];
  #bytesIn = 0;
  #bytesDelivered = 0;
  #bytesAcked = 0;
  #peakOccupancy = 0;
  #paused = false;
  #pauseSignals = 0;
  #resumeSignals = 0;

  constructor(config: FlowControlConfig = DEFAULT_FLOW_CONTROL) {
    const { capBytes, highWaterBytes, lowWaterBytes } = config;
    if (
      !Number.isSafeInteger(capBytes) ||
      !Number.isSafeInteger(highWaterBytes) ||
      !Number.isSafeInteger(lowWaterBytes) ||
      lowWaterBytes < 0 ||
      !(lowWaterBytes < highWaterBytes && highWaterBytes <= capBytes)
    ) {
      throw new RangeError(
        'invalid flow-control watermarks: require 0 <= lowWater < highWater <= cap, got ' +
          `low=${lowWaterBytes} high=${highWaterBytes} cap=${capBytes}`,
      );
    }
    this.#config = config;
  }

  /** Bytes produced but not yet acked — the hard-bounded quantity. */
  get occupancy(): number {
    return this.#bytesIn - this.#bytesAcked;
  }

  /** True while the producer must stay paused (set by push, cleared by ack). */
  get paused(): boolean {
    return this.#paused;
  }

  /** Absolute end of the produced stream (offset of the NEXT byte). */
  get producedEnd(): number {
    return this.#bytesIn;
  }

  /** Absolute end of the delivered stream (bytes handed to the consumer). */
  get deliveredEnd(): number {
    return this.#bytesDelivered;
  }

  /** The ack floor: bytes below this offset were released (unrecoverable). */
  get ackedFloor(): number {
    return this.#bytesAcked;
  }

  /**
   * Append producer bytes at the current stream end. Returns true when the
   * caller MUST pause the producer (occupancy >= highWater). Throws
   * {@link AckRingOverflowError} on cap breach (an ignored pause signal).
   * The input is copied — callers may reuse their buffers.
   */
  push(bytes: Uint8Array): boolean {
    if (bytes.byteLength === 0) return this.#paused;
    const next = this.occupancy + bytes.byteLength;
    if (next > this.#config.capBytes) {
      throw new AckRingOverflowError(next, this.#config.capBytes);
    }
    this.#chunks.push({ offset: this.#bytesIn, bytes: bytes.slice() });
    this.#bytesIn += bytes.byteLength;
    if (next > this.#peakOccupancy) this.#peakOccupancy = next;
    if (!this.#paused && next >= this.#config.highWaterBytes) {
      this.#paused = true;
      this.#pauseSignals += 1;
    }
    return this.#paused;
  }

  /**
   * Hand the next run of not-yet-delivered bytes to the consumer, at most
   * `maxBytes` long, WITH its absolute offset. Bytes are never dropped,
   * never reordered; a chunk may be split. Undefined when fully delivered.
   */
  deliverNext(maxBytes: number): OffsetChunk | undefined {
    if (maxBytes <= 0 || this.#bytesDelivered >= this.#bytesIn) return undefined;
    const startOffset = this.#bytesDelivered;
    let budget = maxBytes;
    const parts: Uint8Array[] = [];
    let cursor = startOffset;
    for (const chunk of this.#chunks) {
      const chunkEnd = chunk.offset + chunk.bytes.byteLength;
      if (chunkEnd <= cursor) continue; // fully delivered already
      const start = Math.max(0, cursor - chunk.offset);
      const take = Math.min(chunk.bytes.byteLength - start, budget);
      if (take <= 0) break;
      parts.push(chunk.bytes.subarray(start, start + take));
      cursor += take;
      budget -= take;
      if (budget === 0) break;
    }
    if (parts.length === 0) return undefined;
    this.#bytesDelivered = cursor;
    return { offset: startOffset, bytes: concat(parts) };
  }

  /**
   * Consumer acknowledges every byte with absolute offset < `watermark`
   * (ws-protocol.md §6 semantics). Frees retained chunks. Returns true when a
   * paused producer may resume (occupancy fell to lowWater or below).
   *
   *   - stale watermark (<= current floor): ignored, returns false
   *     (watermarks are monotonic — §6);
   *   - watermark beyond the delivered offset: RangeError — the caller
   *     answers `watermark-out-of-range` on the wire.
   */
  ack(watermark: number): boolean {
    if (!Number.isSafeInteger(watermark) || watermark < 0) {
      throw new RangeError(`ack watermark must be a non-negative safe integer, got ${String(watermark)}`);
    }
    if (watermark > this.#bytesDelivered) {
      throw new RangeError(
        `ack watermark ${watermark} beyond delivered offset ${this.#bytesDelivered}`,
      );
    }
    if (watermark <= this.#bytesAcked) return false; // stale/duplicate — ignore
    this.#bytesAcked = watermark;
    let drop = 0;
    for (const chunk of this.#chunks) {
      if (chunk.offset + chunk.bytes.byteLength <= watermark) drop += 1;
      else break;
    }
    if (drop > 0) this.#chunks = this.#chunks.slice(drop);
    if (this.#paused && this.occupancy <= this.#config.lowWaterBytes) {
      this.#paused = false;
      this.#resumeSignals += 1;
      return true;
    }
    return false;
  }

  /**
   * Reconnect path (§6 `pty-replay-request`): every RETAINED byte from
   * `fromWatermark` onward, as offset-stable chunks. Advances the delivered
   * cursor to the stream end so live delivery continues after the replay.
   *
   *   - below the ack floor: RangeError — unrecoverable BY DESIGN (bounded
   *     memory); the caller answers `watermark-out-of-range`;
   *   - beyond the produced end: RangeError likewise (`fromWatermark ===
   *     producedEnd` is a legal empty replay — "I have everything").
   */
  replayFrom(fromWatermark: number): readonly OffsetChunk[] {
    if (!Number.isSafeInteger(fromWatermark) || fromWatermark < 0) {
      throw new RangeError(
        `replay watermark must be a non-negative safe integer, got ${String(fromWatermark)}`,
      );
    }
    if (fromWatermark < this.#bytesAcked) {
      throw new RangeError(
        `replay watermark ${fromWatermark} precedes ack floor ${this.#bytesAcked} — ` +
          'released bytes are unrecoverable by design (re-attach via serialize snapshot)',
      );
    }
    if (fromWatermark > this.#bytesIn) {
      throw new RangeError(`replay watermark ${fromWatermark} beyond stream end ${this.#bytesIn}`);
    }
    const out: OffsetChunk[] = [];
    for (const chunk of this.#chunks) {
      const chunkEnd = chunk.offset + chunk.bytes.byteLength;
      if (chunkEnd <= fromWatermark) continue;
      const start = Math.max(0, fromWatermark - chunk.offset);
      out.push({
        offset: chunk.offset + start,
        bytes: chunk.bytes.slice(start),
      });
    }
    this.#bytesDelivered = this.#bytesIn;
    return out;
  }

  stats(): AckRingStats {
    return {
      bytesIn: this.#bytesIn,
      bytesDelivered: this.#bytesDelivered,
      bytesAcked: this.#bytesAcked,
      occupancy: this.occupancy,
      peakOccupancy: this.#peakOccupancy,
      pauseSignals: this.#pauseSignals,
      resumeSignals: this.#resumeSignals,
    };
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return (parts[0] as Uint8Array).slice();
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  return out;
}
