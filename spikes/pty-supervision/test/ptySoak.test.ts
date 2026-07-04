/**
 * SPIKE-D (vi) integration — short 6-PTY flow-control soak.
 *
 * This is the CI-friendly slice (8 s); the full 60 s measurement run is
 * `pnpm soak` and its numbers live in docs/spikes/spike-d-pty-supervision.md.
 * Flooder processes are synthetic (never the real claude TUI — that stays T3).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SOAK, runSoak } from '../src/ptySoak.js';

describe('6-PTY ack-watermark flow-control soak (spike vi, short)', () => {
  it(
    '6 flooders @5MB/s, one slow consumer: zero byte loss, bounded memory, backpressure engaged',
    { timeout: 90_000 },
    async () => {
      const res = await runSoak({ ...DEFAULT_SOAK, durationMs: 8_000 });

      // Zero byte loss: every session's marker stream is gap- and dupe-free.
      for (const s of res.sessions) {
        expect(s.gaps, `session ${s.sessionIndex} gaps`).toBe(0);
        expect(s.duplicatesOrReorders, `session ${s.sessionIndex} dupes`).toBe(0);
        expect(s.markersSeen, `session ${s.sessionIndex} markers`).toBeGreaterThan(0);
      }
      expect(res.zeroByteLoss).toBe(true);

      // Boundedness: no session's unacked buffer ever exceeded the cap.
      expect(res.memoryBounded).toBe(true);
      for (const s of res.sessions) {
        expect(s.peakOccupancyBytes).toBeLessThanOrEqual(res.config.capBytes);
      }

      // The slow consumer actually forced flow control (pause + resume cycles),
      // and backpressure reached its PRODUCER: its intake rate collapsed to a
      // fraction of the 5 MB/s target while fast sessions kept streaming.
      const slow = res.sessions.find((s) => s.slowConsumer);
      const fast = res.sessions.filter((s) => !s.slowConsumer);
      expect(slow).toBeDefined();
      expect(slow?.pauseSignals ?? 0).toBeGreaterThan(0);
      expect(slow?.resumeSignals ?? 0).toBeGreaterThan(0);
      expect(slow?.producerRateBytesPerSec ?? 0).toBeLessThan(1.5 * 1024 * 1024);
      for (const s of fast) {
        expect(
          s.producerRateBytesPerSec,
          `fast session ${s.sessionIndex} throughput`,
        ).toBeGreaterThan(2 * 1024 * 1024);
      }

      // Supervisor memory stays sane (6 caps = 24 MB retained worst-case;
      // generous bound to absorb node/tsx overhead, not a perf claim).
      expect(res.supervisorPeakRssBytes).toBeLessThan(1024 * 1024 * 1024);
    },
  );

  it(
    'no slow consumer: all sessions stream near target with flow control idle',
    { timeout: 60_000 },
    async () => {
      const res = await runSoak({
        ...DEFAULT_SOAK,
        sessions: 2,
        durationMs: 3_000,
        slowConsumerIndex: -1,
      });
      expect(res.zeroByteLoss).toBe(true);
      expect(res.memoryBounded).toBe(true);
      for (const s of res.sessions) {
        // Fast consumers drain immediately → producers should never pause.
        expect(s.pauseSignals, `session ${s.sessionIndex} pauses`).toBe(0);
      }
    },
  );
});
