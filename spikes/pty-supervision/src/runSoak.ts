/**
 * SPIKE-D (vi) — CLI entry for the flow-control soak.
 *
 *   pnpm soak                        # full 60 s, 6 sessions, 5 MB/s each
 *   pnpm soak -- --duration 10000    # shorter run
 *
 * Prints a human summary + machine-readable JSON (for the verdict doc).
 */

import { DEFAULT_SOAK, runSoak, type SoakConfig } from './ptySoak.js';

function numFlag(argv: string[], flag: string, fallback: number): number {
  const i = argv.indexOf(flag);
  if (i === -1 || i + 1 >= argv.length) return fallback;
  const v = Number(argv[i + 1]);
  if (!Number.isFinite(v)) throw new Error(`bad value for ${flag}`);
  return v;
}

const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(2)} MB`;
const mbps = (n: number): string => `${(n / (1024 * 1024)).toFixed(2)} MB/s`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cfg: SoakConfig = {
    ...DEFAULT_SOAK,
    durationMs: numFlag(argv, '--duration', DEFAULT_SOAK.durationMs),
    sessions: numFlag(argv, '--sessions', DEFAULT_SOAK.sessions),
    ratePerSessionBytesPerSec: numFlag(argv, '--rate', DEFAULT_SOAK.ratePerSessionBytesPerSec),
  };
  process.stderr.write(
    `soak: ${cfg.sessions} PTYs @ ${mbps(cfg.ratePerSessionBytesPerSec)} for ${cfg.durationMs} ms ` +
      `(cap ${mb(cfg.capBytes)}, high ${mb(cfg.highWater)}, low ${mb(cfg.lowWater)}, ` +
      `slow consumer #${cfg.slowConsumerIndex} @ ${mbps(cfg.slowDrainBytesPerSec)})\n`,
  );
  const res = await runSoak(cfg);

  process.stderr.write(`\n— result after ${res.elapsedMs} ms —\n`);
  for (const s of res.sessions) {
    process.stderr.write(
      `  session ${s.sessionIndex}${s.slowConsumer ? ' (SLOW)' : '       '}: ` +
        `recv ${mb(s.bytesReceived)} @ ${mbps(s.producerRateBytesPerSec)} · ` +
        `markers ${s.markersSeen} · gaps ${s.gaps} · dup/reorder ${s.duplicatesOrReorders} · ` +
        `peakOcc ${mb(s.peakOccupancyBytes)} · pauses ${s.pauseSignals}/resumes ${s.resumeSignals}\n`,
    );
  }
  process.stderr.write(
    `  total ${mb(res.totalBytes)} @ ${mbps(res.aggregateThroughputBytesPerSec)} aggregate\n` +
      `  supervisor peak RSS ${mb(res.supervisorPeakRssBytes)} · peak heap ${mb(res.supervisorPeakHeapUsedBytes)}\n` +
      `  children peak aggregate RSS ${mb(res.childrenPeakAggregateRssBytes)}\n` +
      `  zeroByteLoss=${res.zeroByteLoss} memoryBounded=${res.memoryBounded}\n\n`,
  );
  process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  process.exit(res.zeroByteLoss && res.memoryBounded ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(2);
});
