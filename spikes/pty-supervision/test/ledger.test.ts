import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifySession, type LivenessProbe } from '../src/broker.js';
import {
  appendLedgerRow,
  readLedger,
  unreconciledSessions,
  type LedgerRow,
} from '../src/ledger.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spike-d-ledger-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const row = (overrides: Partial<LedgerRow>): LedgerRow => ({
  sessionId: 's1',
  state: 'running',
  nonce: 'aabbccdd',
  journalPath: '/dev/null',
  purpose: 'test',
  ts: new Date().toISOString(),
  ...overrides,
});

const probe = (alive: boolean, match: boolean): LivenessProbe => ({
  pidAlive: () => alive,
  nonceMatches: () => match,
});

describe('ledger — positive', () => {
  it('round-trips rows and resolves the latest state per session', () => {
    const p = join(dir, 'ledger.jsonl');
    appendLedgerRow(p, row({ state: 'spawning' }));
    appendLedgerRow(p, row({ state: 'running', pid: 111 }));
    appendLedgerRow(p, row({ sessionId: 's2', state: 'spawning' }));
    const l = readLedger(p);
    expect(l.rows).toHaveLength(3);
    expect(l.latest.get('s1')?.state).toBe('running');
    expect(l.latest.get('s2')?.state).toBe('spawning');
  });

  it('exited sessions are not offered for reconciliation', () => {
    const p = join(dir, 'ledger.jsonl');
    appendLedgerRow(p, row({ state: 'running', pid: 111 }));
    appendLedgerRow(p, row({ state: 'exited', pid: 111 }));
    expect(unreconciledSessions(readLedger(p))).toHaveLength(0);
  });

  it('running/spawning sessions ARE offered for reconciliation', () => {
    const p = join(dir, 'ledger.jsonl');
    appendLedgerRow(p, row({ state: 'running', pid: 111 }));
    const open = unreconciledSessions(readLedger(p));
    expect(open).toHaveLength(1);
    expect(open[0]?.sessionId).toBe('s1');
  });
});

describe('ledger — negative (classification of unreconciled rows)', () => {
  it('no row at all → fresh session', () => {
    expect(classifySession(undefined, probe(false, false)).kind).toBe('fresh');
  });

  it('pid alive but nonce mismatch (pid reuse) → dead-resume, never adopt', () => {
    const k = classifySession(row({ state: 'running', pid: 999 }), probe(true, false));
    expect(k.kind).toBe('dead-resume');
  });

  it('pid dead → dead-resume', () => {
    const k = classifySession(row({ state: 'running', pid: 999 }), probe(false, false));
    expect(k.kind).toBe('dead-resume');
  });
});

describe('ledger — edge', () => {
  it('crash window: spawning row without pid → crash-window-respawn (row-before-spawn pays off)', () => {
    const k = classifySession(row({ state: 'spawning' }), probe(true, true));
    expect(k.kind).toBe('crash-window-respawn');
  });

  it('running row missing its pid field is treated as the crash window, not trusted', () => {
    const k = classifySession(row({ state: 'running' }), probe(true, true));
    expect(k.kind).toBe('crash-window-respawn');
  });

  it('pid alive AND nonce matches → orphan-alive with that pid', () => {
    const k = classifySession(row({ state: 'running', pid: 4242 }), probe(true, true));
    expect(k).toEqual({ kind: 'orphan-alive', pid: 4242 });
  });

  it('torn ledger tail (broker SIGKILLed mid-append) is skipped, earlier rows survive', () => {
    const p = join(dir, 'ledger.jsonl');
    appendLedgerRow(p, row({ state: 'spawning' }));
    appendFileSync(p, '{"sessionId":"s1","state":"runn', 'utf8'); // torn
    const l = readLedger(p);
    expect(l.tornTail).toBe(true);
    expect(l.rows).toHaveLength(1);
    expect(l.latest.get('s1')?.state).toBe('spawning');
  });
});
