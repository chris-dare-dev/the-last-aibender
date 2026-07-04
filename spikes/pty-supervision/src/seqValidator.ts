/**
 * SPIKE-D (vi) — sequence-continuity validator for the flood stream.
 *
 * The synthetic TUI (flood.ts) embeds ASCII markers `<<S{producer}:{seq}>>`
 * in its ANSI output. This validator ingests the byte stream chunk-by-chunk
 * (markers may be split across chunk boundaries) and proves zero byte loss:
 * per producer, seq must increment by exactly 1 with no gaps, duplicates,
 * or reordering. ASCII-only markers by design — no multibyte split concerns.
 */

const MARKER_RE = /<<S(\d+):(\d+)>>/g;
/** Longest possible marker prefix we might have to carry across a chunk boundary. */
const MAX_CARRY = 40;

export interface ProducerReport {
  readonly producerId: number;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly markersSeen: number;
  readonly gaps: ReadonlyArray<{ expected: number; got: number }>;
  readonly duplicatesOrReorders: number;
}

export interface ValidatorReport {
  readonly totalBytes: number;
  readonly producers: ReadonlyArray<ProducerReport>;
  readonly clean: boolean;
}

interface ProducerState {
  firstSeq: number;
  lastSeq: number;
  markersSeen: number;
  gaps: Array<{ expected: number; got: number }>;
  duplicatesOrReorders: number;
}

export class SeqValidator {
  #carry = '';
  #totalBytes = 0;
  readonly #producers = new Map<number, ProducerState>();

  feed(chunk: string): void {
    if (chunk.length === 0) return;
    this.#totalBytes += chunk.length;
    const text = this.#carry + chunk;
    MARKER_RE.lastIndex = 0;
    let lastEnd = 0;
    let m: RegExpExecArray | null;
    while ((m = MARKER_RE.exec(text)) !== null) {
      const producerId = Number(m[1]);
      const seq = Number(m[2]);
      lastEnd = m.index + m[0].length;
      this.#record(producerId, seq);
    }
    // Carry the unmatched tail — it may hold a split marker prefix. Bound it:
    // anything further back than MAX_CARRY cannot be part of a future marker.
    const tail = text.slice(lastEnd);
    this.#carry = tail.length > MAX_CARRY ? tail.slice(tail.length - MAX_CARRY) : tail;
  }

  #record(producerId: number, seq: number): void {
    const state = this.#producers.get(producerId);
    if (state === undefined) {
      this.#producers.set(producerId, {
        firstSeq: seq,
        lastSeq: seq,
        markersSeen: 1,
        gaps: [],
        duplicatesOrReorders: 0,
      });
      return;
    }
    state.markersSeen += 1;
    const expected = state.lastSeq + 1;
    if (seq === expected) {
      state.lastSeq = seq;
    } else if (seq > expected) {
      state.gaps.push({ expected, got: seq });
      state.lastSeq = seq;
    } else {
      state.duplicatesOrReorders += 1;
    }
  }

  report(): ValidatorReport {
    const producers: ProducerReport[] = [...this.#producers.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([producerId, s]) => ({
        producerId,
        firstSeq: s.firstSeq,
        lastSeq: s.lastSeq,
        markersSeen: s.markersSeen,
        gaps: s.gaps,
        duplicatesOrReorders: s.duplicatesOrReorders,
      }));
    const clean = producers.every((p) => p.gaps.length === 0 && p.duplicatesOrReorders === 0);
    return { totalBytes: this.#totalBytes, producers, clean };
  }
}
