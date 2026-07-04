/**
 * SPIKE-D (vii) — stub long-running child (SDK-session proxy).
 *
 * HONEST PROXY: stands in for a long-running SDK `query()` child. It performs
 * numbered steps on an interval and fsyncs one journal record per completed
 * step. It deliberately IGNORES parent death — when the broker is SIGKILLed
 * this process keeps running as an orphan (reparented to launchd), which is
 * exactly the scenario under test.
 *
 * Usage:
 *   tsx src/worker.ts --journal <path> --session <id> --nonce <nonce> \
 *       --total 40 --interval 50 [--resume-from <k>]
 *
 * The nonce appears in argv so a restarting broker can verify pid identity
 * via `ps` (guards against pid reuse) — prototyping the identity check the
 * real resume ledger needs before trusting a "live" pid.
 */

import {
  appendRecord,
  checksumThrough,
  ensureLineBoundary,
  readJournal,
  type JournalRecord,
} from './journal.js';

interface WorkerArgs {
  journal: string;
  session: string;
  nonce: string;
  total: number;
  intervalMs: number;
  resumeFrom: number | undefined;
}

function parseArgs(argv: string[]): WorkerArgs {
  const str = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const num = (flag: string, fallback: number): number => {
    const v = str(flag);
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`bad value for ${flag}`);
    return n;
  };
  const journal = str('--journal');
  const session = str('--session');
  const nonce = str('--nonce');
  if (journal === undefined || session === undefined || nonce === undefined) {
    throw new Error('required: --journal --session --nonce');
  }
  const resumeRaw = str('--resume-from');
  return {
    journal,
    session,
    nonce,
    total: num('--total', 40),
    intervalMs: num('--interval', 50),
    resumeFrom: resumeRaw === undefined ? undefined : Number(resumeRaw),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let startStep: number;
  if (args.resumeFrom === undefined) {
    startStep = 1;
  } else {
    // Defensive: never trust the caller blindly — re-derive from the journal
    // (the transcript-tail-validator discipline) and refuse to skip ahead.
    const j = readJournal(args.journal);
    if (args.resumeFrom !== j.lastCoherentStep) {
      process.stderr.write(
        `worker: refusing resume-from ${args.resumeFrom}; journal lastCoherentStep=${j.lastCoherentStep}\n`,
      );
      process.exit(3);
    }
    startStep = j.lastCoherentStep + 1;
  }

  // A previous segment may have been SIGKILLed mid-write: start clean.
  ensureLineBoundary(args.journal);

  const header: JournalRecord = {
    type: 'header',
    sessionId: args.session,
    nonce: args.nonce,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    ...(args.resumeFrom !== undefined ? { resumedFromStep: args.resumeFrom } : {}),
  };
  appendRecord(args.journal, header);

  for (let n = startStep; n <= args.total; n += 1) {
    await sleep(args.intervalMs);
    // "Work", then the durable commit — the record IS the step boundary.
    appendRecord(args.journal, {
      type: 'step',
      n,
      sum: checksumThrough(n),
      ts: new Date().toISOString(),
    });
  }
  appendRecord(args.journal, {
    type: 'done',
    lastStep: args.total,
    sum: checksumThrough(args.total),
    ts: new Date().toISOString(),
  });
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`worker fatal: ${String(err)}\n`);
  process.exit(1);
});
