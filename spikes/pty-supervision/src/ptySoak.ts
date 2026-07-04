/**
 * SPIKE-D (vi) — 6-PTY ack-watermark flow-control soak harness.
 *
 * Spawns N synthetic flooder TUIs (flood.ts) under node-pty, each targeting
 * ~5 MB/s of ANSI output. Every session gets a BoundedAckBuffer; one consumer
 * is deliberately slow. Flow control: buffer signals pause → pty.pause()
 * (kernel PTY buffer fills → flooder blocks on write). Consumer acks advance
 * the watermark; buffer signals resume → pty.resume().
 *
 * Measures: memory boundedness (supervisor RSS/heap + per-session buffer
 * occupancy vs cap), zero byte loss (sequence continuity per producer),
 * pause/resume engagement, achieved producer rates (proves backpressure
 * reaches the producer, not just the buffer).
 *
 * HONEST PROXY: flooder ≈ real claude TUI (real-TUI confirmation is T3).
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nodePty from 'node-pty';
import { BoundedAckBuffer } from './ackBuffer.js';
import { SeqValidator } from './seqValidator.js';

const SPIKE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FLOOD_SRC = join(SPIKE_ROOT, 'src', 'flood.ts');

export interface SoakConfig {
  readonly sessions: number;
  readonly ratePerSessionBytesPerSec: number;
  readonly durationMs: number;
  /** Index of the deliberately slow consumer (-1 = none). */
  readonly slowConsumerIndex: number;
  readonly slowDrainBytesPerSec: number;
  readonly capBytes: number;
  readonly highWater: number;
  readonly lowWater: number;
  readonly sampleIntervalMs: number;
}

export const DEFAULT_SOAK: SoakConfig = {
  sessions: 6,
  ratePerSessionBytesPerSec: 5 * 1024 * 1024,
  durationMs: 60_000,
  slowConsumerIndex: 0,
  slowDrainBytesPerSec: 512 * 1024,
  capBytes: 4 * 1024 * 1024,
  highWater: 2 * 1024 * 1024,
  lowWater: 512 * 1024,
  sampleIntervalMs: 500,
};

export interface SessionResult {
  readonly sessionIndex: number;
  readonly slowConsumer: boolean;
  readonly bytesReceived: number;
  readonly bytesConsumed: number;
  readonly markersSeen: number;
  readonly gaps: number;
  readonly duplicatesOrReorders: number;
  readonly peakOccupancyBytes: number;
  readonly pauseSignals: number;
  readonly resumeSignals: number;
  readonly producerRateBytesPerSec: number;
  readonly ptyExitCode: number | undefined;
}

export interface SoakResult {
  readonly config: SoakConfig;
  readonly elapsedMs: number;
  readonly sessions: ReadonlyArray<SessionResult>;
  readonly totalBytes: number;
  readonly aggregateThroughputBytesPerSec: number;
  readonly supervisorPeakRssBytes: number;
  readonly supervisorPeakHeapUsedBytes: number;
  readonly childrenPeakAggregateRssBytes: number;
  readonly zeroByteLoss: boolean;
  readonly memoryBounded: boolean;
}

interface Session {
  readonly index: number;
  readonly pty: nodePty.IPty;
  readonly buffer: BoundedAckBuffer;
  readonly validator: SeqValidator;
  readonly slow: boolean;
  consumed: number;
  exitCode: number | undefined;
}

function cleanEnv(): { [key: string]: string } {
  const out: { [key: string]: string } = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function childAggregateRss(pids: number[]): number {
  if (pids.length === 0) return 0;
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\n')
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
      .reduce((a, b) => a + b * 1024, 0);
  } catch {
    return 0; // some/all children already exited between sample and ps
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runSoak(cfg: SoakConfig): Promise<SoakResult> {
  const sessions: Session[] = [];
  const env = cleanEnv();
  const startedAt = Date.now();

  for (let i = 0; i < cfg.sessions; i += 1) {
    const buffer = new BoundedAckBuffer({
      capBytes: cfg.capBytes,
      highWater: cfg.highWater,
      lowWater: cfg.lowWater,
    });
    // Single-process spawn (`node --import tsx`), NOT the `.bin/tsx` wrapper:
    // the wrapper re-spawns node as a grandchild, so pty.kill() would hit the
    // wrapper and leak the real flooder (same finding as broker.ts).
    const pty = nodePty.spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        FLOOD_SRC,
        '--id',
        String(i),
        '--rate',
        String(cfg.ratePerSessionBytesPerSec),
        '--duration',
        '0',
      ],
      { name: 'xterm-256color', cols: 200, rows: 50, cwd: SPIKE_ROOT, env },
    );
    const session: Session = {
      index: i,
      pty,
      buffer,
      validator: new SeqValidator(),
      slow: i === cfg.slowConsumerIndex,
      consumed: 0,
      exitCode: undefined,
    };
    pty.onData((data) => {
      const mustPause = buffer.push(data);
      if (mustPause) pty.pause();
    });
    pty.onExit(({ exitCode }) => {
      session.exitCode = exitCode;
    });
    sessions.push(session);
  }

  // Consumer pumps. Fast consumers drain everything each tick; the slow one
  // drains at cfg.slowDrainBytesPerSec. Both ack what they consumed, and
  // resume a paused PTY when the buffer says so.
  const CONSUMER_TICK_MS = 20;
  const consume = (s: Session, budget: number): void => {
    const wasPaused = s.buffer.paused;
    const data = s.buffer.deliver(budget);
    if (data.length > 0) {
      s.validator.feed(data);
      s.consumed += data.length;
      const mayResume = s.buffer.ack(s.buffer.stats().bytesDelivered);
      if (mayResume || (wasPaused && !s.buffer.paused)) s.pty.resume();
    }
  };
  const slowBudget = Math.max(1, Math.round((cfg.slowDrainBytesPerSec * CONSUMER_TICK_MS) / 1000));
  const consumerTimer = setInterval(() => {
    for (const s of sessions) {
      consume(s, s.slow ? slowBudget : Number.MAX_SAFE_INTEGER);
    }
  }, CONSUMER_TICK_MS);

  // Metrics sampling.
  let peakRss = 0;
  let peakHeap = 0;
  let peakChildRss = 0;
  const samplerTimer = setInterval(() => {
    const mu = process.memoryUsage();
    if (mu.rss > peakRss) peakRss = mu.rss;
    if (mu.heapUsed > peakHeap) peakHeap = mu.heapUsed;
    const agg = childAggregateRss(sessions.map((s) => s.pty.pid));
    if (agg > peakChildRss) peakChildRss = agg;
  }, cfg.sampleIntervalMs);

  await sleep(cfg.durationMs);

  // Stop producers, then drain every buffer to the end so the validator sees
  // the full retained stream (nothing may be lost between buffer and check).
  for (const s of sessions) {
    try {
      s.pty.kill('SIGKILL');
    } catch {
      /* already exited */
    }
  }
  clearInterval(consumerTimer);
  clearInterval(samplerTimer);
  await sleep(150); // let final onData callbacks land
  for (const s of sessions) {
    // Final full drain (also for the slow consumer — bounded by capBytes).
    consume(s, Number.MAX_SAFE_INTEGER);
  }
  const elapsedMs = Date.now() - startedAt;

  const sessionResults: SessionResult[] = sessions.map((s) => {
    const rep = s.validator.report();
    const stats = s.buffer.stats();
    const producer = rep.producers.find((p) => p.producerId === s.index);
    return {
      sessionIndex: s.index,
      slowConsumer: s.slow,
      bytesReceived: stats.bytesIn,
      bytesConsumed: s.consumed,
      markersSeen: producer?.markersSeen ?? 0,
      gaps: producer?.gaps.length ?? 0,
      duplicatesOrReorders: producer?.duplicatesOrReorders ?? 0,
      peakOccupancyBytes: stats.peakOccupancy,
      pauseSignals: stats.pauseSignals,
      resumeSignals: stats.resumeSignals,
      producerRateBytesPerSec: Math.round(stats.bytesIn / (elapsedMs / 1000)),
      ptyExitCode: s.exitCode,
    };
  });

  const totalBytes = sessionResults.reduce((a, s) => a + s.bytesReceived, 0);
  return {
    config: cfg,
    elapsedMs,
    sessions: sessionResults,
    totalBytes,
    aggregateThroughputBytesPerSec: Math.round(totalBytes / (elapsedMs / 1000)),
    supervisorPeakRssBytes: peakRss,
    supervisorPeakHeapUsedBytes: peakHeap,
    childrenPeakAggregateRssBytes: peakChildRss,
    zeroByteLoss: sessionResults.every((s) => s.gaps === 0 && s.duplicatesOrReorders === 0),
    memoryBounded: sessionResults.every((s) => s.peakOccupancyBytes <= cfg.capBytes),
  };
}
