/**
 * SPIKE-D (vii) integration — real SIGKILL of the broker process.
 *
 * Uses REAL processes (tsx children), REAL SIGKILL, and the real filesystem:
 * only the workload is synthetic (worker.ts ≈ SDK child; broker.ts ≈
 * aibender-core kernel). Real-SDK-session confirmation remains T3.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readJournal, verifyExactlyOnce } from '../src/journal.js';
import { readLedger } from '../src/ledger.js';

const SPIKE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BROKER_SRC = join(SPIKE_ROOT, 'src', 'broker.ts');

let dir: string;
let procs: ChildProcess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spike-d-broker-'));
  procs = [];
});

const killHard = (pid: number): void => {
  // Group first (workers are detached group leaders), then the pid itself.
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* not a live group */
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* gone */
  }
};

afterEach(() => {
  // Best-effort reaping: brokers we spawned + every pid the ledger knows.
  for (const p of procs) {
    if (p.pid !== undefined) killHard(p.pid);
  }
  try {
    for (const row of readLedger(join(dir, 'ledger.jsonl')).rows) {
      if (row.pid !== undefined) killHard(row.pid);
    }
  } catch {
    /* no ledger */
  }
  rmSync(dir, { recursive: true, force: true });
});

interface BrokerHandle {
  child: ChildProcess;
  pid: number;
  stderr: () => string;
  exited: Promise<number | null>;
}

function startBroker(extra: string[] = [], total = 60, intervalMs = 100): BrokerHandle {
  // Single-process spawn — SIGKILLing the pid must kill the ACTUAL broker
  // (the `.bin/tsx` wrapper would absorb the kill and leak the real one).
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      BROKER_SRC,
      '--dir',
      dir,
      '--total',
      String(total),
      '--interval',
      String(intervalMs),
      ...extra,
    ],
    { cwd: SPIKE_ROOT, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  procs.push(child);
  let err = '';
  child.stderr?.on('data', (d: Buffer) => {
    err += d.toString();
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
  });
  if (child.pid === undefined) throw new Error('broker spawn failed');
  return { child, pid: child.pid, stderr: () => err, exited };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error(`timeout waiting for: ${what}`);
}

const journalPath = (): string => join(dir, 'journal.jsonl');
const ledgerPath = (): string => join(dir, 'ledger.jsonl');
const lastStep = (): number => readJournal(journalPath()).lastCoherentStep;
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('broker SIGKILL — orphan/resume fidelity (spike vii)', () => {
  it(
    'live orphan: SIGKILL broker mid-run → orphan keeps journaling → restart detects, kills, resumes exactly-once',
    { timeout: 40_000 },
    async () => {
      const total = 60;
      const a = startBroker([], total, 100);
      await waitFor(() => lastStep() >= 3, 15_000, 'worker to reach step 3');

      // The kill: nothing graceful about it.
      process.kill(a.pid, 'SIGKILL');
      expect(await a.exited).toBe(null); // signal death, no exit code

      // Ledger knows the worker pid; the worker must have survived (orphan).
      const running = readLedger(ledgerPath())
        .rows.filter((r) => r.state === 'running' && r.pid !== undefined)
        .at(-1);
      expect(running?.pid).toBeDefined();
      const orphanPid = running?.pid as number;
      expect(pidAlive(orphanPid)).toBe(true);

      // Orphan keeps making progress with no supervisor at all.
      const before = lastStep();
      await sleep(600);
      const after = lastStep();
      expect(after).toBeGreaterThan(before);

      // Restart: broker B must reconcile, kill the orphan, resume, finish.
      const b = startBroker([], total, 100);
      const codeB = await b.exited;
      expect(codeB, b.stderr()).toBe(0);
      expect(pidAlive(orphanPid)).toBe(false);

      // Fidelity: steps 1..total exactly once, coherent checksum chain, done.
      const verdict = verifyExactlyOnce(journalPath(), total);
      expect(verdict.ok, verdict.reasons.join('; ')).toBe(true);

      // Ledger tells the whole story in order.
      const states = readLedger(ledgerPath()).rows.map((r) => r.state);
      expect(states).toContain('orphan-detected');
      expect(states).toContain('orphan-killed');
      expect(states).toContain('resumed');
      expect(states.at(-1)).toBe('exited');
      // Row-before-spawn: every running/resumed row is preceded by a spawning row.
      const spawnIdx = states.indexOf('spawning');
      const runIdx = states.indexOf('running');
      expect(spawnIdx).toBeGreaterThanOrEqual(0);
      expect(spawnIdx).toBeLessThan(runIdx);

      // Status file agrees.
      const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as {
        phase: string;
        exactlyOnce: boolean;
      };
      expect(status.phase).toBe('done');
      expect(status.exactlyOnce).toBe(true);
    },
  );

  it(
    'dead orphan: broker AND worker both SIGKILLed → restart resumes from journal exactly-once',
    { timeout: 40_000 },
    async () => {
      const total = 30;
      const a = startBroker([], total, 80);
      await waitFor(() => lastStep() >= 3, 15_000, 'worker to reach step 3');
      process.kill(a.pid, 'SIGKILL');
      const running = readLedger(ledgerPath())
        .rows.filter((r) => r.pid !== undefined)
        .at(-1);
      const workerPid = running?.pid as number;
      process.kill(workerPid, 'SIGKILL'); // may land mid-journal-write: torn tail
      await waitFor(() => !pidAlive(workerPid), 3_000, 'worker to die');

      const resumePoint = lastStep(); // whatever survived coherently
      const b = startBroker([], total, 80);
      const codeB = await b.exited;
      expect(codeB, b.stderr()).toBe(0);

      const verdict = verifyExactlyOnce(journalPath(), total);
      expect(verdict.ok, verdict.reasons.join('; ')).toBe(true);
      expect(lastStep()).toBe(total);
      expect(resumePoint).toBeLessThanOrEqual(total);

      const rows = readLedger(ledgerPath()).rows;
      // No orphan-kill needed on this path — it was already dead.
      expect(rows.map((r) => r.state)).not.toContain('orphan-detected');
      expect(rows.map((r) => r.state)).toContain('resumed');
    },
  );

  it(
    'crash window: broker dies between ledger row and spawn → restart respawns the SAME session fresh',
    { timeout: 40_000 },
    async () => {
      const total = 10;
      const a = startBroker(['--crash-after-ledger'], total, 40);
      expect(await a.exited).toBe(42);

      // The discipline's payoff: the row exists, no process was ever spawned.
      const l1 = readLedger(ledgerPath());
      const spawning = l1.latest.values().next().value;
      expect(spawning?.state).toBe('spawning');
      expect(spawning?.pid).toBeUndefined();
      expect(readJournal(journalPath()).records).toHaveLength(0);

      const b = startBroker([], total, 40);
      const codeB = await b.exited;
      expect(codeB, b.stderr()).toBe(0);

      const verdict = verifyExactlyOnce(journalPath(), total);
      expect(verdict.ok, verdict.reasons.join('; ')).toBe(true);
      // Same sessionId carried through — the crash-window row was reconciled,
      // not abandoned.
      const l2 = readLedger(ledgerPath());
      const ids = new Set(l2.rows.map((r) => r.sessionId));
      expect(ids.size).toBe(1);
      expect(l2.rows.at(-1)?.state).toBe('exited');
    },
  );
});
