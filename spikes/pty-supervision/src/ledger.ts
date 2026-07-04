/**
 * SPIKE-D (vii) — resume ledger with row-before-spawn discipline.
 *
 * Prototypes blueprint §4.1: "a SQLite row is written BEFORE every spawn".
 * The spike uses fsync'd JSONL instead of SQLite (the discipline under test
 * is ordering + crash-window recovery, not the storage engine — prod uses
 * packages/schema). State transitions per session:
 *
 *   spawning            row exists, child not yet spawned (the crash window)
 *   running             pid backfilled after successful spawn
 *   orphan-detected     restart found the pid still alive without a broker
 *   orphan-killed       restart killed the live orphan before resuming
 *   resumed             a new segment continues from the journal
 *   exited              child completed (or was declared dead)
 */

import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';

export type LedgerState =
  | 'spawning'
  | 'running'
  | 'orphan-detected'
  | 'orphan-killed'
  | 'resumed'
  | 'exited';

export interface LedgerRow {
  readonly sessionId: string;
  readonly state: LedgerState;
  readonly nonce: string;
  readonly journalPath: string;
  readonly purpose: string;
  readonly pid?: number;
  readonly detail?: string;
  readonly ts: string;
}

export function appendLedgerRow(path: string, row: LedgerRow): void {
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, `${JSON.stringify(row)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface LedgerReadResult {
  readonly rows: ReadonlyArray<LedgerRow>;
  /** Latest row per sessionId, in first-seen order. */
  readonly latest: ReadonlyMap<string, LedgerRow>;
  readonly tornTail: boolean;
}

export function readLedger(path: string): LedgerReadResult {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { rows: [], latest: new Map(), tornTail: false };
  }
  const lines = raw.split('\n');
  const endedWithNewline = raw.endsWith('\n');
  const rows: LedgerRow[] = [];
  let tornTail = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line === '') continue;
    try {
      rows.push(JSON.parse(line) as LedgerRow);
    } catch {
      if (i === lines.length - 1 && !endedWithNewline) tornTail = true;
    }
  }
  const latest = new Map<string, LedgerRow>();
  for (const row of rows) latest.set(row.sessionId, row);
  return { rows, latest, tornTail };
}

/**
 * Sessions a restarting broker must reconcile: latest state is one that a
 * clean shutdown would have progressed past.
 */
export function unreconciledSessions(ledger: LedgerReadResult): LedgerRow[] {
  const open: LedgerState[] = ['spawning', 'running', 'orphan-detected', 'orphan-killed', 'resumed'];
  return [...ledger.latest.values()].filter((r) => open.includes(r.state));
}
