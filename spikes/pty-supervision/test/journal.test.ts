import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendRecord,
  appendTornTail,
  checksumThrough,
  ensureLineBoundary,
  readJournal,
  verifyExactlyOnce,
} from '../src/journal.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spike-d-journal-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const writeSteps = (path: string, from: number, to: number): void => {
  for (let n = from; n <= to; n += 1) {
    appendRecord(path, { type: 'step', n, sum: checksumThrough(n), ts: new Date().toISOString() });
  }
};

describe('journal — positive', () => {
  it('round-trips header + steps + done and reports full coherence', () => {
    const p = join(dir, 'j.jsonl');
    appendRecord(p, {
      type: 'header',
      sessionId: 's1',
      nonce: 'abc',
      pid: 123,
      startedAt: new Date().toISOString(),
    });
    writeSteps(p, 1, 5);
    appendRecord(p, { type: 'done', lastStep: 5, sum: checksumThrough(5), ts: new Date().toISOString() });
    const j = readJournal(p);
    expect(j.headers).toHaveLength(1);
    expect(j.steps).toHaveLength(5);
    expect(j.lastCoherentStep).toBe(5);
    expect(j.done?.lastStep).toBe(5);
    expect(j.tornTail).toBe(false);
    expect(verifyExactlyOnce(p, 5).ok).toBe(true);
  });

  it('missing journal file reads as empty (step 0) — fresh-start resume', () => {
    const j = readJournal(join(dir, 'nope.jsonl'));
    expect(j.lastCoherentStep).toBe(0);
    expect(j.records).toHaveLength(0);
  });
});

describe('journal — negative', () => {
  it('torn tail (mid-write SIGKILL) is skipped; last coherent step survives', () => {
    const p = join(dir, 'j.jsonl');
    writeSteps(p, 1, 8);
    appendTornTail(p); // '{"type":"step","n":9' — no closing brace, no newline
    const j = readJournal(p);
    expect(j.tornTail).toBe(true);
    expect(j.lastCoherentStep).toBe(8);
    expect(j.steps).toHaveLength(8);
  });

  it('a wrong checksum breaks the coherence chain at that point', () => {
    const p = join(dir, 'j.jsonl');
    writeSteps(p, 1, 3);
    appendRecord(p, { type: 'step', n: 4, sum: 42, ts: new Date().toISOString() }); // bad sum
    writeSteps(p, 5, 6);
    expect(readJournal(p).lastCoherentStep).toBe(3);
  });

  it('verifyExactlyOnce flags duplicates, gaps, and a missing done record', () => {
    const p = join(dir, 'j.jsonl');
    writeSteps(p, 1, 2);
    writeSteps(p, 2, 2); // duplicate step 2
    writeSteps(p, 4, 4); // gap: step 3 missing
    const v = verifyExactlyOnce(p, 4);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/step 3 missing/);
    expect(v.reasons.join(' ')).toMatch(/step 2 executed 2 times/);
    expect(v.reasons.join(' ')).toMatch(/no done record/);
  });
});

describe('journal — edge', () => {
  it('garbage line in the middle counts as corrupt but does not abort the read', () => {
    const p = join(dir, 'j.jsonl');
    writeSteps(p, 1, 2);
    writeFileSync(p, `${'not json at all'}\n`, { flag: 'a' });
    writeSteps(p, 3, 3);
    const j = readJournal(p);
    expect(j.corruptLines).toBe(1);
    expect(j.lastCoherentStep).toBe(3);
  });

  it('resume segment appended after a torn tail yields an exactly-once history', () => {
    const p = join(dir, 'j.jsonl');
    writeSteps(p, 1, 8);
    appendTornTail(p);
    // SPIKE FINDING: without this boundary repair, the resume header would
    // concatenate onto the torn fragment and corrupt BOTH records. worker.ts
    // calls ensureLineBoundary at startup for exactly this reason.
    ensureLineBoundary(p);
    appendRecord(p, {
      type: 'header',
      sessionId: 's1',
      nonce: 'def',
      pid: 456,
      startedAt: new Date().toISOString(),
      resumedFromStep: 8,
    });
    writeSteps(p, 9, 10);
    appendRecord(p, { type: 'done', lastStep: 10, sum: checksumThrough(10), ts: new Date().toISOString() });
    const v = verifyExactlyOnce(p, 10);
    expect(v.ok, v.reasons.join('; ')).toBe(true);
  });

  it('empty journal file (0 bytes) is step 0, not an error', () => {
    const p = join(dir, 'j.jsonl');
    writeFileSync(p, '');
    expect(readJournal(p).lastCoherentStep).toBe(0);
  });
});
