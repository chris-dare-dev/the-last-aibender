/**
 * SPIKE-D (vii) — stub broker (supervisor) with resume-ledger discipline.
 *
 * HONEST PROXY: stands in for aibender-core's kernel. Supervises one stub
 * worker (worker.ts ≈ SDK child). The disciplines under test:
 *
 *   1. ROW-BEFORE-SPAWN — a fsync'd ledger row exists before fork/exec, so a
 *      broker crash in the spawn window can never produce an untracked child.
 *   2. ORPHAN DETECTION on restart — pid liveness + argv-nonce identity check
 *      (pid-reuse guard) decides alive-orphan vs dead-session.
 *   3. RESUME-FROM-JOURNAL — the journal's last coherent step (torn tails
 *      skipped) is the only truth a resume trusts; completed steps are never
 *      re-executed, missing steps never skipped.
 *
 * CLI:
 *   tsx src/broker.ts --dir <stateDir> --total 40 --interval 50
 *       [--crash-after-ledger]   # exit(42) between ledger row and spawn
 *
 * Files under --dir: ledger.jsonl · journal.jsonl · status.json
 */

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJournal, verifyExactlyOnce } from './journal.js';
import {
  appendLedgerRow,
  readLedger,
  unreconciledSessions,
  type LedgerRow,
} from './ledger.js';

const SPIKE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKER_SRC = join(SPIKE_ROOT, 'src', 'worker.ts');

// ---------------------------------------------------------------------------
// Pure decision logic (unit-testable without processes)
// ---------------------------------------------------------------------------

export type SessionClass =
  | { kind: 'fresh' }
  | { kind: 'orphan-alive'; pid: number }
  | { kind: 'dead-resume' }
  | { kind: 'crash-window-respawn' };

export interface LivenessProbe {
  pidAlive(pid: number): boolean;
  nonceMatches(pid: number, nonce: string): boolean;
}

/** Classify an unreconciled ledger row on broker restart. */
export function classifySession(row: LedgerRow | undefined, probe: LivenessProbe): SessionClass {
  if (row === undefined) return { kind: 'fresh' };
  if (row.state === 'spawning' || row.pid === undefined) {
    // Crash window: row written, spawn never confirmed. Journal decides how
    // far the child actually got (it may have died pre-header → step 0).
    return { kind: 'crash-window-respawn' };
  }
  if (probe.pidAlive(row.pid) && probe.nonceMatches(row.pid, row.nonce)) {
    return { kind: 'orphan-alive', pid: row.pid };
  }
  // Dead, or the pid was reused by an unrelated process (nonce mismatch):
  // either way the session process is gone — resume from the journal.
  return { kind: 'dead-resume' };
}

// ---------------------------------------------------------------------------
// Host-facing probe implementation (macOS/BSD ps)
// ---------------------------------------------------------------------------

export const hostProbe: LivenessProbe = {
  pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      // ESRCH = gone. EPERM = alive but other-uid — cannot be our worker
      // (we spawn same-uid), so it is equally "not our live session".
      return false;
    }
  },
  nonceMatches(pid: number, nonce: string): boolean {
    try {
      const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return cmd.includes(`--nonce ${nonce}`);
    } catch {
      return false;
    }
  },
};

// ---------------------------------------------------------------------------
// Broker process
// ---------------------------------------------------------------------------

interface BrokerArgs {
  dir: string;
  total: number;
  intervalMs: number;
  crashAfterLedger: boolean;
}

function parseArgs(argv: string[]): BrokerArgs {
  const str = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const dir = str('--dir');
  if (dir === undefined) throw new Error('required: --dir');
  return {
    dir,
    total: Number(str('--total') ?? 40),
    intervalMs: Number(str('--interval') ?? 50),
    crashAfterLedger: argv.includes('--crash-after-ledger'),
  };
}

function writeStatus(dir: string, status: Record<string, unknown>): void {
  const tmp = join(dir, 'status.json.tmp');
  writeFileSync(tmp, JSON.stringify({ ...status, brokerPid: process.pid }, null, 2));
  renameSync(tmp, join(dir, 'status.json'));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * SPIKE FINDING (feeds BE-1/BE-8 reaping): orphan kills must target the
 * PROCESS GROUP (the worker is spawned detached → pgid == pid), with a
 * single-pid fallback. Killing only a wrapper/leader pid leaks grandchildren
 * as untracked orphans — observed live in this spike when workers were
 * spawned through the `.bin/tsx` wrapper (wrapper died, real worker lived).
 */
async function killAndWait(pid: number, timeoutMs: number): Promise<boolean> {
  try {
    process.kill(-pid, 'SIGKILL'); // whole group
  } catch {
    try {
      process.kill(pid, 'SIGKILL'); // not a group leader (or group gone)
    } catch {
      return true; // already gone entirely
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!hostProbe.pidAlive(pid)) return true;
    await sleep(25);
  }
  return false;
}

function spawnWorker(args: BrokerArgs, sessionId: string, nonce: string, resumeFrom?: number): number {
  const journalPath = join(args.dir, 'journal.jsonl');
  const argv = [
    WORKER_SRC,
    '--journal', journalPath,
    '--session', sessionId,
    '--nonce', nonce,
    '--total', String(args.total),
    '--interval', String(args.intervalMs),
    ...(resumeFrom !== undefined ? ['--resume-from', String(resumeFrom)] : []),
  ];
  // SPIKE FINDING: spawn the worker as a SINGLE process (`node --import tsx`),
  // never through the `.bin/tsx` wrapper — the wrapper re-spawns node as a
  // child, so the ledger would record the wrapper's pid and every liveness /
  // kill decision would hit the wrong process (observed: SIGKILL of the
  // wrapper leaked the real worker as an untracked, still-journaling orphan).
  // Prod rule: the resume ledger must record the pid of the actual session
  // process the kernel spawned, not any launcher shim.
  //
  // detached → own process group: broker death never takes the worker down
  // with it (the SDK-child reality we are prototyping), and group-targeted
  // reaping (-pid) catches any grandchildren the worker itself spawns.
  const child = spawn(process.execPath, ['--import', 'tsx', ...argv], {
    detached: true,
    stdio: 'ignore',
    cwd: SPIKE_ROOT,
  });
  child.unref();
  if (child.pid === undefined) throw new Error('spawn failed: no pid');
  return child.pid;
}

async function monitorUntilDone(args: BrokerArgs, sessionId: string, workerPid: number): Promise<void> {
  const journalPath = join(args.dir, 'journal.jsonl');
  const ledgerPath = join(args.dir, 'ledger.jsonl');
  // Poll the journal (not the child handle — the child may predate us).
  for (;;) {
    await sleep(100);
    const j = readJournal(journalPath);
    if (j.done !== undefined) {
      appendLedgerRow(ledgerPath, {
        sessionId,
        state: 'exited',
        nonce: 'n/a',
        journalPath,
        purpose: 'spike-vii',
        pid: workerPid,
        detail: `done at step ${j.done.lastStep}`,
        ts: new Date().toISOString(),
      });
      const verdict = verifyExactlyOnce(journalPath, args.total);
      writeStatus(args.dir, {
        phase: 'done',
        sessionId,
        workerPid,
        exactlyOnce: verdict.ok,
        reasons: verdict.reasons,
      });
      process.exit(verdict.ok ? 0 : 1);
    }
    if (!hostProbe.pidAlive(workerPid)) {
      // Worker died without a done record — leave the ledger open ('running'/
      // 'resumed' stands) so the NEXT broker run resumes it. Honest exit.
      writeStatus(args.dir, { phase: 'worker-died-incomplete', sessionId, workerPid });
      process.exit(4);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.dir, { recursive: true });
  const ledgerPath = join(args.dir, 'ledger.jsonl');
  const journalPath = join(args.dir, 'journal.jsonl');

  const ledger = readLedger(ledgerPath);
  const open = unreconciledSessions(ledger);
  const row = open[0];
  const klass = classifySession(row, hostProbe);
  writeStatus(args.dir, { phase: 'reconciling', classification: klass.kind });

  let sessionId: string;
  let resumeFrom: number | undefined;

  switch (klass.kind) {
    case 'fresh': {
      sessionId = `sess-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
      resumeFrom = undefined;
      break;
    }
    case 'orphan-alive': {
      if (row === undefined) throw new Error('unreachable');
      appendLedgerRow(ledgerPath, { ...row, state: 'orphan-detected', ts: new Date().toISOString() });
      writeStatus(args.dir, { phase: 'orphan-detected', orphanPid: klass.pid });
      const gone = await killAndWait(klass.pid, 3000);
      if (!gone) throw new Error(`orphan pid ${klass.pid} refused to die`);
      appendLedgerRow(ledgerPath, { ...row, state: 'orphan-killed', ts: new Date().toISOString() });
      sessionId = row.sessionId;
      resumeFrom = readJournal(journalPath).lastCoherentStep;
      break;
    }
    case 'dead-resume':
    case 'crash-window-respawn': {
      if (row === undefined) throw new Error('unreachable');
      sessionId = row.sessionId;
      resumeFrom = readJournal(journalPath).lastCoherentStep;
      break;
    }
  }

  const nonce = randomBytes(8).toString('hex');

  // THE DISCIPLINE: ledger row hits disk (fsync) BEFORE any fork/exec.
  appendLedgerRow(ledgerPath, {
    sessionId,
    state: 'spawning',
    nonce,
    journalPath,
    purpose: 'spike-vii',
    ...(resumeFrom !== undefined ? { detail: `resume-from ${resumeFrom}` } : {}),
    ts: new Date().toISOString(),
  });

  if (args.crashAfterLedger) {
    // Simulated crash inside the spawn window (deterministic stand-in for a
    // SIGKILL landing between the ledger fsync and the fork).
    writeStatus(args.dir, { phase: 'crashed-after-ledger', sessionId });
    process.exit(42);
  }

  const workerPid = spawnWorker(args, sessionId, nonce, resumeFrom);
  appendLedgerRow(ledgerPath, {
    sessionId,
    state: resumeFrom !== undefined ? 'resumed' : 'running',
    nonce,
    journalPath,
    purpose: 'spike-vii',
    pid: workerPid,
    ...(resumeFrom !== undefined ? { detail: `resume-from ${resumeFrom}` } : {}),
    ts: new Date().toISOString(),
  });
  writeStatus(args.dir, { phase: 'supervising', sessionId, workerPid, resumeFrom: resumeFrom ?? null });

  await monitorUntilDone(args, sessionId, workerPid);
}

// Only run the CLI when executed directly (the module is also imported by
// unit tests for classifySession/hostProbe).
const isMain = (process.argv[1] ?? '').endsWith('broker.ts');
if (isMain) {
  main().catch((err: unknown) => {
    console.error(`broker fatal: ${String(err)}`);
    process.exit(2);
  });
}
