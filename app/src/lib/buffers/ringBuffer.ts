/**
 * Bounded buffers for the streaming discipline (plan §5 iron rule: tokens
 * land in NON-REACTIVE ring buffers; rAF-batched projections move them into
 * stores). Nothing in the frontend buffers unboundedly — the SPIKE-D posture
 * (bounded memory, explicit drop/assert policy) applied client-side.
 */

/**
 * Fixed-capacity FIFO ring. Overflow policy: DROP-OLDEST with an explicit
 * drop counter (appropriate for projections where the store is a bounded
 * read model anyway). For byte streams that must NEVER drop, use
 * {@link BoundedByteQueue} instead.
 */
export class RingBuffer<T> {
  private readonly items: (T | undefined)[];
  private head = 0; // index of oldest
  private count = 0;
  private drops = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.items = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  /** Total items evicted by overflow since construction. */
  get droppedCount(): number {
    return this.drops;
  }

  /** Append. Returns the evicted oldest item when the ring was full. */
  push(item: T): T | undefined {
    if (this.count === this.capacity) {
      const evicted = this.items[this.head] as T;
      this.items[this.head] = item;
      this.head = (this.head + 1) % this.capacity;
      this.drops += 1;
      return evicted;
    }
    this.items[(this.head + this.count) % this.capacity] = item;
    this.count += 1;
    return undefined;
  }

  /** Remove and return every buffered item, oldest first. */
  drain(): T[] {
    const out = new Array<T>(this.count);
    for (let i = 0; i < this.count; i += 1) {
      const idx = (this.head + i) % this.capacity;
      out[i] = this.items[idx] as T;
      this.items[idx] = undefined;
    }
    this.head = 0;
    this.count = 0;
    return out;
  }

  /** Non-destructive snapshot, oldest first. */
  toArray(): T[] {
    const out = new Array<T>(this.count);
    for (let i = 0; i < this.count; i += 1) {
      out[i] = this.items[(this.head + i) % this.capacity] as T;
    }
    return out;
  }

  clear(): void {
    this.items.fill(undefined);
    this.head = 0;
    this.count = 0;
  }
}

/**
 * Bounded byte FIFO for PTY output awaiting island consumption. Bytes are
 * NEVER dropped: the ack-watermark protocol guarantees the broker retains at
 * most its own cap (4 MiB, SPIKE-D) beyond our last ack, so with a client cap
 * ≥ broker cap + one max frame the queue cannot legitimately overflow — a cap
 * breach here is a client BUG and throws (assertion, mirroring the broker's
 * "a cap breach is a broker bug" contract stance, ws-protocol.md §6).
 */
export class BoundedByteQueue {
  private chunks: Uint8Array[] = [];
  private bytes = 0;

  constructor(readonly capacityBytes: number) {
    if (!Number.isInteger(capacityBytes) || capacityBytes < 1) {
      throw new RangeError(`capacityBytes must be a positive integer, got ${capacityBytes}`);
    }
  }

  get byteLength(): number {
    return this.bytes;
  }

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    if (this.bytes + chunk.byteLength > this.capacityBytes) {
      throw new RangeError(
        `BoundedByteQueue cap breached (${this.bytes} + ${chunk.byteLength} > ${this.capacityBytes}) — ack discipline bug`,
      );
    }
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
  }

  /** Remove and return all queued chunks, oldest first. */
  drain(): Uint8Array[] {
    const out = this.chunks;
    this.chunks = [];
    this.bytes = 0;
    return out;
  }

  clear(): void {
    this.chunks = [];
    this.bytes = 0;
  }
}
