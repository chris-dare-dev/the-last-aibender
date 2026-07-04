/**
 * Rotation- and truncation-safe line tailer (BE-5 source 1 substrate;
 * blueprint §6.1 "fs-watch `projects/** /*.jsonl`"; plan §9.2 BE-5 edge "file
 * rotation/truncation mid-tail").
 *
 * One {@link FileTailer} per file, byte-offset based:
 *   - `poll()` reads from the remembered offset to EOF and yields COMPLETE
 *     lines only; a partial trailing line stays buffered until its newline
 *     arrives (a torn mid-write read never yields a half JSON object);
 *   - TRUNCATION (size < offset — e.g. the CLI rewrote the file) resets the
 *     offset to zero and re-reads from the top; the events store's
 *     (backend, raw_ref) dedupe absorbs the re-delivery (re-tailing never
 *     duplicates, sqlite-ddl.md §7.2);
 *   - ROTATION (path vanished) reports `removed: true`; the directory
 *     scanner drops the tailer and discovers the successor file on its next
 *     scan, which starts from offset 0 — dedupe again absorbs the overlap.
 *
 * Deliberately POLL-driven with an injectable trigger: tests call
 * `poll()`/`scan()` explicitly (deterministic); production composition wires
 * an interval (and may layer fs.watch as a wake-up, never as the source of
 * truth — macOS FSEvents coalesces and drops).
 */

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';

export interface TailPollResult {
  /** Complete lines appended since the last poll (newline-stripped). */
  readonly lines: readonly string[];
  /** File shrank beneath the remembered offset (rewrite/truncate). */
  readonly truncated: boolean;
  /** File vanished (rotation/unlink) — caller should drop this tailer. */
  readonly removed: boolean;
}

export class FileTailer {
  readonly path: string;
  #offset = 0;
  #partial = '';

  constructor(path: string, options: { readonly fromStart?: boolean } = {}) {
    this.path = path;
    // Default: tail FROM THE START — history is wanted (ground-truth
    // backfill) and the store dedupe makes re-reads free. `fromStart: false`
    // starts at the current end (live-only feeds).
    if (options.fromStart === false) {
      try {
        this.#offset = statSync(path).size;
      } catch {
        this.#offset = 0;
      }
    }
  }

  get offset(): number {
    return this.#offset;
  }

  poll(): TailPollResult {
    if (!existsSync(this.path)) {
      return { lines: [], truncated: false, removed: true };
    }
    let truncated = false;
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return { lines: [], truncated: false, removed: true };
    }
    if (size < this.#offset) {
      // Truncation mid-tail: restart from the top; dedupe absorbs re-reads.
      this.#offset = 0;
      this.#partial = '';
      truncated = true;
    }
    if (size === this.#offset) {
      return { lines: [], truncated, removed: false };
    }

    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch {
      return { lines: [], truncated, removed: true };
    }
    let chunk: Buffer;
    try {
      const toRead = size - this.#offset;
      chunk = Buffer.alloc(toRead);
      const read = readSync(fd, chunk, 0, toRead, this.#offset);
      chunk = chunk.subarray(0, read);
      this.#offset += read;
    } finally {
      closeSync(fd);
    }

    const text = this.#partial + chunk.toString('utf8');
    const pieces = text.split('\n');
    // Everything before the last separator is complete; the tail is partial.
    this.#partial = pieces.pop() ?? '';
    const lines = pieces
      .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
      .filter((line) => line.length > 0);
    return { lines, truncated, removed: false };
  }
}
