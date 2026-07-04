/**
 * OUTPUT stream-offset bookkeeping for one attached `pty.<sid>` channel.
 *
 * The wire axis is ws-protocol.md §5/§6 (FROZEN-M2): every OUTPUT byte has an
 * absolute `streamOffset`; the client acks a monotonic watermark ("every byte
 * with offset < watermark is consumed"); reconnect replay re-delivers
 * retained bytes from a requested watermark. This tracker turns that axis
 * into three island-side decisions, with no wire or DOM dependencies (pure —
 * unit-tested against the golden binary corpus):
 *
 *  - WRITE     new bytes (overlap-trimmed) to feed `term.write`;
 *  - DUPLICATE already-seen bytes (replay overshoot) to drop silently;
 *  - GAP       bytes from the future — never write (order corruption);
 *              request replay from the first missing byte instead.
 *
 * Consumption is decoupled from receipt: `markConsumed` is driven by xterm's
 * write-completion callback, so acks never run ahead of what the renderer
 * actually absorbed (the broker releases buffer below the ack watermark —
 * over-acking would make reconnect replay unrecoverable by design, §6).
 */

export type AcceptAction = 'write' | 'duplicate' | 'gap';

export interface AcceptOutcome {
  readonly action: AcceptAction;
  /** Present when action === 'write': overlap-trimmed bytes to render. */
  readonly data?: Uint8Array;
  /**
   * Present when action === 'gap' AND this gap has not been reported yet:
   * the watermark to pass to `pty-replay-request` (first missing byte).
   * Repeated gap chunks at the same expected offset stay silent — one
   * outstanding replay request per gap position.
   */
  readonly replayFrom?: number;
}

export class OutputStreamTracker {
  /** Next OUTPUT byte offset we have NOT yet received. */
  private expected: number;
  /** Highest offset the terminal has finished writing (ack candidate). */
  private consumed: number;
  /** Last watermark handed out via takeAckWatermark. */
  private acked: number;
  /** Gap position a replay was already requested for (-1 = none). */
  private replayRequestedAt = -1;

  constructor(startOffset = 0) {
    if (!Number.isSafeInteger(startOffset) || startOffset < 0) {
      throw new RangeError(`invalid startOffset ${String(startOffset)}`);
    }
    this.expected = startOffset;
    this.consumed = startOffset;
    this.acked = startOffset;
  }

  get expectedOffset(): number {
    return this.expected;
  }

  get consumedOffset(): number {
    return this.consumed;
  }

  get ackedOffset(): number {
    return this.acked;
  }

  /** Classify one delivered chunk on the OUTPUT offset axis. */
  accept(streamOffset: number, payload: Uint8Array): AcceptOutcome {
    if (!Number.isSafeInteger(streamOffset) || streamOffset < 0) {
      // Defensive: decodePtyFrame already rejects these at the wire.
      return { action: 'duplicate' };
    }
    const end = streamOffset + payload.byteLength;

    if (streamOffset > this.expected) {
      // Future bytes — writing them would corrupt terminal order.
      if (this.replayRequestedAt === this.expected) {
        return { action: 'gap' }; // replay already outstanding for this gap
      }
      this.replayRequestedAt = this.expected;
      return { action: 'gap', replayFrom: this.expected };
    }

    if (end <= this.expected) {
      // Entirely already-seen (replay overshoot / duplicate) — or empty.
      return { action: 'duplicate' };
    }

    // Overlapping or exactly contiguous: trim the already-seen prefix.
    const data = payload.subarray(this.expected - streamOffset);
    this.expected = end;
    this.replayRequestedAt = -1; // stream advanced; a new gap may re-request
    return { action: 'write', data };
  }

  /**
   * Record that the terminal finished writing bytes up to `upToOffset`
   * (exclusive). Monotonic; clamped to what was actually received.
   */
  markConsumed(upToOffset: number): void {
    if (!Number.isSafeInteger(upToOffset)) return;
    const clamped = Math.min(upToOffset, this.expected);
    if (clamped > this.consumed) this.consumed = clamped;
  }

  /**
   * The ack watermark to send now, or null when nothing new was consumed
   * since the last take. Monotonic by construction — callers can forward the
   * value verbatim as `pty-ack.watermark`.
   */
  takeAckWatermark(): number | null {
    if (this.consumed <= this.acked) return null;
    this.acked = this.consumed;
    return this.acked;
  }
}
