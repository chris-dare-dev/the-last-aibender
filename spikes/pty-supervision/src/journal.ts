/**
 * SPIKE-D (vii) — append-only progress journal with torn-tail recovery.
 *
 * Prototypes the resume-ledger/transcript-tail discipline (blueprint §4.1):
 * the worker fsyncs one JSONL record per completed step; a SIGKILL at any
 * moment may leave a torn (partial) final line. The reader must recover the
 * last COHERENT record and treat everything after it as never-happened —
 * exactly what the transcript-tail validator will do before any real resume.
 */

import { appendFileSync, closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';

export interface JournalHeader {
  readonly type: 'header';
  readonly sessionId: string;
  readonly nonce: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly resumedFromStep?: number;
}

export interface JournalStep {
  readonly type: 'step';
  readonly n: number;
  /** Running checksum: proves order and detects re-execution or skips. */
  readonly sum: number;
  readonly ts: string;
}

export interface JournalDone {
  readonly type: 'done';
  readonly lastStep: number;
  readonly sum: number;
  readonly ts: string;
}

export type JournalRecord = JournalHeader | JournalStep | JournalDone;

/** Deterministic step payload — both worker and verifier compute it. */
export function stepValue(n: number): number {
  return (n * 2654435761) % 4294967296;
}

export function checksumThrough(n: number): number {
  let sum = 0;
  for (let i = 1; i <= n; i += 1) sum = (sum + stepValue(i)) % 4294967296;
  return sum;
}

/** Durable append: write + fsync — a torn line means the fsync never returned. */
export function appendRecord(path: string, record: JournalRecord): void {
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface JournalReadResult {
  readonly records: ReadonlyArray<JournalRecord>;
  readonly headers: ReadonlyArray<JournalHeader>;
  readonly steps: ReadonlyArray<JournalStep>;
  readonly done: JournalDone | undefined;
  /** Highest step whose record parsed cleanly AND whose checksum chain holds. */
  readonly lastCoherentStep: number;
  readonly tornTail: boolean;
  readonly corruptLines: number;
}

export function readJournal(path: string): JournalReadResult {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {
      records: [],
      headers: [],
      steps: [],
      done: undefined,
      lastCoherentStep: 0,
      tornTail: false,
      corruptLines: 0,
    };
  }
  const lines = raw.split('\n');
  const endedWithNewline = raw.endsWith('\n');
  const records: JournalRecord[] = [];
  let tornTail = false;
  let corruptLines = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line === '') continue;
    const isLast = i === lines.length - 1;
    try {
      const rec = JSON.parse(line) as JournalRecord;
      if (rec.type !== 'header' && rec.type !== 'step' && rec.type !== 'done') {
        corruptLines += 1;
        continue;
      }
      records.push(rec);
    } catch {
      if (isLast && !endedWithNewline) {
        // Torn tail from a mid-write kill — expected, skip silently.
        tornTail = true;
      } else {
        corruptLines += 1;
      }
    }
  }
  const headers = records.filter((r): r is JournalHeader => r.type === 'header');
  const steps = records.filter((r): r is JournalStep => r.type === 'step');
  const done = records.find((r): r is JournalDone => r.type === 'done');

  // Coherence: walk steps in file order; each must be lastStep+1 with the
  // right running checksum. The last coherent step is where a resume starts.
  let lastCoherentStep = 0;
  for (const s of steps) {
    if (s.n === lastCoherentStep + 1 && s.sum === checksumThrough(s.n)) {
      lastCoherentStep = s.n;
    } else {
      break; // incoherent continuation — never trust anything past it
    }
  }
  return { records, headers, steps, done, lastCoherentStep, tornTail, corruptLines };
}

export interface ExactlyOnceVerdict {
  readonly ok: boolean;
  readonly reasons: ReadonlyArray<string>;
  readonly stepsSeen: number;
  readonly expectedTotal: number;
}

/**
 * Resume fidelity: across all segments (initial run + resumes), steps
 * 1..total must each appear EXACTLY once, in order, with an intact checksum
 * chain, and a `done` record must close the run.
 */
export function verifyExactlyOnce(path: string, expectedTotal: number): ExactlyOnceVerdict {
  const j = readJournal(path);
  const reasons: string[] = [];
  const seen = new Map<number, number>();
  for (const s of j.steps) seen.set(s.n, (seen.get(s.n) ?? 0) + 1);
  for (let n = 1; n <= expectedTotal; n += 1) {
    const count = seen.get(n) ?? 0;
    if (count === 0) reasons.push(`step ${n} missing`);
    if (count > 1) reasons.push(`step ${n} executed ${count} times (duplicate)`);
  }
  for (const [n, count] of seen) {
    if (n > expectedTotal) reasons.push(`unexpected step ${n} (x${count}) beyond total ${expectedTotal}`);
  }
  if (j.lastCoherentStep !== expectedTotal) {
    reasons.push(`checksum chain coherent only through ${j.lastCoherentStep}, want ${expectedTotal}`);
  }
  if (j.done === undefined) reasons.push('no done record');
  else if (j.done.lastStep !== expectedTotal || j.done.sum !== checksumThrough(expectedTotal)) {
    reasons.push('done record does not match expected total/checksum');
  }
  return { ok: reasons.length === 0, reasons, stepsSeen: j.steps.length, expectedTotal };
}

/** Test helper: simulate a mid-write SIGKILL by appending a torn partial line. */
export function appendTornTail(path: string): void {
  appendFileSync(path, '{"type":"step","n":9', 'utf8');
}

/**
 * SPIKE FINDING (feeds BE-1/BE-2 resume discipline): before a resumed segment
 * appends its first record, the writer MUST ensure the file ends on a line
 * boundary — otherwise the previous kill's torn fragment concatenates into
 * the new segment's header and corrupts BOTH lines. Called by worker.ts at
 * startup; the prod transcript/ledger writers need the same guard.
 */
export function ensureLineBoundary(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return; // no file yet — nothing to repair
  }
  if (raw.length > 0 && !raw.endsWith('\n')) {
    appendFileSync(path, '\n', 'utf8');
  }
}
