/**
 * SPIKE-D (vi) — bounded ack-watermark buffer.
 *
 * Prototypes the gateway flow-control discipline from blueprint §2 / plan BE-3:
 * binary PTY frames buffered per session, consumer acks a byte watermark,
 * occupancy (bytes produced but not yet acked) is HARD-bounded. When occupancy
 * crosses `highWater` the owner must pause the producer (pty.pause()); when an
 * ack drains it to `lowWater` or below, the producer may resume. Bytes are
 * NEVER dropped — backpressure propagates to the producer instead.
 *
 * Also carries a minimal replay surface (`replayFrom`) to prototype
 * reconnect-with-replay-watermark semantics: everything not yet acked is
 * replayable.
 *
 * Quarantined spike code — conclusions may be copied to core/, code may not.
 */

export interface AckBufferOptions {
  /** Hard cap on unacked bytes retained. Exceeding it is a programming error (pause was ignored). */
  readonly capBytes: number;
  /** Occupancy at/above which `shouldPause` flips true. Must be <= capBytes. */
  readonly highWater: number;
  /** Occupancy at/below which a paused stream may resume. Must be < highWater. */
  readonly lowWater: number;
}

export interface AckBufferStats {
  readonly bytesIn: number;
  readonly bytesDelivered: number;
  readonly bytesAcked: number;
  readonly occupancy: number;
  readonly peakOccupancy: number;
  readonly pauseSignals: number;
  readonly resumeSignals: number;
}

interface Chunk {
  /** Absolute stream offset of data[0]. */
  readonly offset: number;
  readonly data: string;
}

export class AckBufferOverflowError extends Error {
  constructor(occupancy: number, cap: number) {
    super(
      `BoundedAckBuffer overflow: occupancy ${occupancy} > capBytes ${cap} — producer pause was not honored`,
    );
    this.name = 'AckBufferOverflowError';
  }
}

export class BoundedAckBuffer {
  readonly #opts: AckBufferOptions;
  #chunks: Chunk[] = [];
  #bytesIn = 0;
  #bytesDelivered = 0;
  #bytesAcked = 0;
  #peakOccupancy = 0;
  #paused = false;
  #pauseSignals = 0;
  #resumeSignals = 0;

  constructor(opts: AckBufferOptions) {
    if (!(opts.lowWater < opts.highWater && opts.highWater <= opts.capBytes)) {
      throw new RangeError(
        `invalid watermarks: require lowWater < highWater <= capBytes, got ` +
          `low=${opts.lowWater} high=${opts.highWater} cap=${opts.capBytes}`,
      );
    }
    if (opts.lowWater < 0) throw new RangeError('lowWater must be >= 0');
    this.#opts = opts;
  }

  /** Bytes produced but not yet acked (the bounded quantity). */
  get occupancy(): number {
    return this.#bytesIn - this.#bytesAcked;
  }

  get paused(): boolean {
    return this.#paused;
  }

  /**
   * Append producer bytes. Returns true when the caller must pause the
   * producer (occupancy >= highWater). Throws if the cap is breached —
   * that means a previous pause signal was ignored.
   */
  push(data: string): boolean {
    if (data.length === 0) return this.#paused;
    const next = this.occupancy + data.length;
    if (next > this.#opts.capBytes) {
      throw new AckBufferOverflowError(next, this.#opts.capBytes);
    }
    this.#chunks.push({ offset: this.#bytesIn, data });
    this.#bytesIn += data.length;
    if (next > this.#peakOccupancy) this.#peakOccupancy = next;
    if (!this.#paused && next >= this.#opts.highWater) {
      this.#paused = true;
      this.#pauseSignals += 1;
    }
    return this.#paused;
  }

  /**
   * Hand up to `maxBytes` of not-yet-delivered data to the consumer.
   * Chunks are never dropped and never reordered; a chunk may be split.
   */
  deliver(maxBytes: number): string {
    if (maxBytes <= 0) return '';
    let budget = maxBytes;
    let out = '';
    let cursor = this.#bytesDelivered;
    for (const chunk of this.#chunks) {
      const chunkEnd = chunk.offset + chunk.data.length;
      if (chunkEnd <= cursor) continue; // fully delivered already
      const start = Math.max(0, cursor - chunk.offset);
      const take = Math.min(chunk.data.length - start, budget);
      if (take <= 0) break;
      out += chunk.data.slice(start, start + take);
      cursor += take;
      budget -= take;
      if (budget === 0) break;
    }
    this.#bytesDelivered = cursor;
    return out;
  }

  /**
   * Consumer acknowledges everything up to absolute offset `watermark`.
   * Frees retained chunks. Returns true when a paused producer may resume
   * (occupancy fell to lowWater or below).
   */
  ack(watermark: number): boolean {
    if (watermark > this.#bytesDelivered) {
      throw new RangeError(
        `ack watermark ${watermark} beyond delivered offset ${this.#bytesDelivered}`,
      );
    }
    if (watermark < this.#bytesAcked) {
      // Stale/duplicate ack — ignore, watermarks are monotonic.
      return false;
    }
    this.#bytesAcked = watermark;
    // Garbage-collect fully acked chunks.
    let drop = 0;
    for (const chunk of this.#chunks) {
      if (chunk.offset + chunk.data.length <= watermark) drop += 1;
      else break;
    }
    if (drop > 0) this.#chunks = this.#chunks.slice(drop);
    if (this.#paused && this.occupancy <= this.#opts.lowWater) {
      this.#paused = false;
      this.#resumeSignals += 1;
      return true;
    }
    return false;
  }

  /**
   * Reconnect path: replay every retained byte from `watermark` onward
   * (must be >= last ack — earlier bytes are gone by design).
   * Resets the delivered cursor so normal delivery continues after replay.
   */
  replayFrom(watermark: number): string {
    if (watermark < this.#bytesAcked) {
      throw new RangeError(
        `replay watermark ${watermark} precedes acked offset ${this.#bytesAcked} — data no longer retained`,
      );
    }
    if (watermark > this.#bytesIn) {
      throw new RangeError(`replay watermark ${watermark} beyond stream end ${this.#bytesIn}`);
    }
    let out = '';
    for (const chunk of this.#chunks) {
      const chunkEnd = chunk.offset + chunk.data.length;
      if (chunkEnd <= watermark) continue;
      const start = Math.max(0, watermark - chunk.offset);
      out += chunk.data.slice(start);
    }
    this.#bytesDelivered = this.#bytesIn;
    return out;
  }

  stats(): AckBufferStats {
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
