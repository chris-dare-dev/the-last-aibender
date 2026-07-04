/**
 * Bounded per-channel envelope journal — the broker half of JSON
 * reconnect-replay (ws-protocol.md §2/§8, FROZEN-M2; @aibender/protocol
 * replay.ts is the machine-checkable shape).
 *
 * Mechanism (mirrors the SPIKE-D PTY ack buffer, with `seq` as the axis):
 *   - every broadcast on a replayable channel is appended here FIRST; the
 *     journal assigns the envelope's `seq`, scoped to (broker boot, channel)
 *     and CONTINUING across connections — the reconnect watermark axis;
 *   - retention is a BOUNDED window (maxEntries per channel). Evicted history
 *     is unrecoverable from the wire BY DESIGN — clients below the floor
 *     rebuild from read models / the store, never from an unbounded buffer;
 *   - `replayFrom(fromSeq)` returns every retained entry with seq >= fromSeq
 *     in order with ORIGINAL seq values. `fromSeq === nextSeq` is the legal
 *     "I am current" no-op; beyond that, or below the retention floor,
 *     answers `watermark-out-of-range`.
 *
 * A broker restart discards every journal (they live in memory only) — that
 * is the frozen semantics: the client detects the new boot identity via the
 * bootstrap file and starts fresh.
 */

import type { ChannelName, ErrorCode } from '@aibender/protocol';

// ---------------------------------------------------------------------------
// One channel's journal
// ---------------------------------------------------------------------------

export interface JournalEntry {
  /** The (boot, channel)-scoped seq this payload was broadcast with. */
  readonly seq: number;
  readonly payload: unknown;
}

export type JournalReplayResult =
  | { readonly ok: true; readonly entries: readonly JournalEntry[] }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

/**
 * Default retained entries per channel. Production tuning is BE-3
 * configuration (the MECHANISM is the frozen contract, not the number) —
 * this default comfortably covers a reconnect window without letting one
 * chatty channel balloon broker memory.
 */
export const DEFAULT_JOURNAL_MAX_ENTRIES = 1024;

export class ChannelJournal {
  readonly #maxEntries: number;
  #entries: JournalEntry[] = [];
  /** Seq the NEXT append will receive (== lastSeq + 1). */
  #nextSeq = 0;
  /** Oldest seq still answerable — rises as the bounded window evicts. */
  #floorSeq = 0;

  constructor(maxEntries: number) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError(`journal maxEntries must be a positive integer, got ${String(maxEntries)}`);
    }
    this.#maxEntries = maxEntries;
  }

  /** Append a payload; returns the seq assigned to it. */
  append(payload: unknown): number {
    const seq = this.#nextSeq;
    this.#nextSeq += 1;
    this.#entries.push({ seq, payload });
    if (this.#entries.length > this.#maxEntries) {
      // Bounded window: evict the oldest entry and raise the floor.
      this.#entries.shift();
      this.#floorSeq = this.#entries[0]?.seq ?? this.#nextSeq;
    }
    return seq;
  }

  /** Seq the next append will receive (`lastSeq + 1`; 0 when never written). */
  get nextSeq(): number {
    return this.#nextSeq;
  }

  /** Oldest seq a replay can still answer (== nextSeq when nothing retained). */
  get floorSeq(): number {
    return this.#floorSeq;
  }

  /** Currently retained entry count (tests/observability). */
  get size(): number {
    return this.#entries.length;
  }

  /**
   * §8 semantics: `fromSeq` = the first seq the client has NOT processed.
   * Returns retained entries with seq >= fromSeq, in order, original seqs.
   */
  replayFrom(fromSeq: number): JournalReplayResult {
    if (fromSeq > this.#nextSeq) {
      return {
        ok: false,
        code: 'watermark-out-of-range',
        message: 'replay fromSeq is beyond the last broadcast seq',
      };
    }
    if (fromSeq < this.#floorSeq) {
      // Below-floor history is unrecoverable from the wire by design
      // (bounded memory) — the client rebuilds from read models instead.
      return {
        ok: false,
        code: 'watermark-out-of-range',
        message: 'replay fromSeq is below the journal retention floor',
      };
    }
    // fromSeq === nextSeq is the legal "I am current" no-op (empty replay).
    return { ok: true, entries: this.#entries.filter((entry) => entry.seq >= fromSeq) };
  }
}

// ---------------------------------------------------------------------------
// The per-channel set
// ---------------------------------------------------------------------------

/**
 * Lazy map of channel → journal. A channel that never broadcast has an empty
 * journal (nextSeq 0): `replay-request { fromSeq: 0 }` on it is a legal
 * no-op, anything higher answers `watermark-out-of-range` — no special case
 * for "unknown" transcript sessions is needed or wanted (the wire cannot
 * distinguish "no such session" from "session that never spoke").
 */
export class JournalSet {
  readonly #maxEntriesPerChannel: number;
  readonly #journals = new Map<ChannelName, ChannelJournal>();

  constructor(maxEntriesPerChannel: number = DEFAULT_JOURNAL_MAX_ENTRIES) {
    if (!Number.isSafeInteger(maxEntriesPerChannel) || maxEntriesPerChannel < 1) {
      throw new RangeError(
        `journal maxEntriesPerChannel must be a positive integer, got ${String(maxEntriesPerChannel)}`,
      );
    }
    this.#maxEntriesPerChannel = maxEntriesPerChannel;
  }

  journalFor(channel: ChannelName): ChannelJournal {
    let journal = this.#journals.get(channel);
    if (journal === undefined) {
      journal = new ChannelJournal(this.#maxEntriesPerChannel);
      this.#journals.set(channel, journal);
    }
    return journal;
  }
}
