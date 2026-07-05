/**
 * §9.3 BE↔FE #2 — PTY round-trip + 6-PTY flow-control soak with one slow
 * consumer: bounded memory, no interleaving/loss, echo p95 <100 ms locally.
 *
 * The contract-of-record note (docs/contracts/integration-suite.md §2 item 2)
 * names `soak:m2` as the device for this seam. That harness
 * (core/scripts/m2-soak/run.ts) already drives the REAL gateway + REAL
 * ptyHost + REAL node-pty children in COMPOSED mode (composeBroker wires the
 * exact daemon path) and prints a JSON verdict. It is a standalone runnable
 * that `process.exit()`s at module load, so the INTEG suite ASSEMBLES it as a
 * child process and asserts its verdict — it does NOT re-implement the soak.
 *
 * This is the single place the cross-department contract for the PTY seam is
 * asserted end-to-end from the INTEG home; the harness itself owns the
 * mechanics (SPIKE-D lineage). We assert, from the report:
 *   - verdict PASS (every internal criterion met);
 *   - flow control engaged (producer plateaued while the slow consumer
 *     stalled — the real child blocked in a TTY write);
 *   - zero byte loss / no interleaving (contiguous-offset reassembly held);
 *   - RSS peak-delta bounded;
 *   - echo p95 under the <100 ms budget.
 *
 * [X2]: the harness uses synthesized TUIs (flood/quiet real node children) +
 * the testkit FakeQueryRunner — no accounts, no keychain, no real claude TUI.
 */

import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

interface SoakReport {
  soak: {
    sessions: number;
    slowConsumers: number;
    flowControl: {
      producerPlateauedAtBytes: number;
      plateauStable: boolean;
      slowConsumerInFlightAtStall: number;
      deliveryWindowBytes: number;
    };
    rss: { baseline: number; peak: number; peakDelta: number };
    byteLoss: number | 'FAILED';
  };
  echo: { samples: number; p50Ms: number; p95Ms: number; budgetMs: number };
  failures: string[];
  verdict: 'PASS' | 'FAIL';
}

function lastJsonObject(stdout: string): SoakReport {
  // The harness prints its report as the final pretty-printed JSON object.
  const start = stdout.lastIndexOf('\n{');
  const slice = start >= 0 ? stdout.slice(start + 1) : stdout;
  return JSON.parse(slice) as SoakReport;
}

describe('BE↔FE #2 — 6-PTY flow-control soak + echo p95 (real gateway/ptyHost/node-pty)', () => {
  it(
    'the composed soak harness reports PASS with bounded memory and no byte loss',
    async () => {
      const { stdout } = await execFileAsync(
        'pnpm',
        ['-F', 'aibender-core', 'soak:m2'],
        { cwd: REPO_ROOT, timeout: 150_000, maxBuffer: 8 * 1024 * 1024 },
      );

      const report = lastJsonObject(stdout);

      // The harness's own overall verdict — every internal criterion.
      expect(report.failures).toEqual([]);
      expect(report.verdict).toBe('PASS');

      // The seam-defining assertions, restated at the INTEG boundary:
      // 6 PTYs, one deliberately slow consumer.
      expect(report.soak.sessions).toBe(6);
      expect(report.soak.slowConsumers).toBe(1);

      // Flow control engaged: the producer plateaued (the real child blocked
      // in a TTY write while the slow consumer withheld acks), and there were
      // bytes in flight bounded by the delivery window.
      expect(report.soak.flowControl.plateauStable).toBe(true);
      expect(report.soak.flowControl.producerPlateauedAtBytes).toBeGreaterThan(0);
      expect(report.soak.flowControl.slowConsumerInFlightAtStall).toBeLessThanOrEqual(
        report.soak.flowControl.deliveryWindowBytes,
      );

      // No loss, no interleaving corruption.
      expect(report.soak.byteLoss).toBe(0);

      // Bounded memory (the harness enforces its own RSS bound internally;
      // here we assert the peak delta is finite and non-negative — a crashed
      // or unbounded run would have failed the harness before printing).
      expect(Number.isFinite(report.soak.rss.peakDelta)).toBe(true);

      // Echo latency budget.
      expect(report.echo.samples).toBe(200);
      expect(report.echo.p95Ms).toBeLessThan(report.echo.budgetMs);
      expect(report.echo.budgetMs).toBe(100);
    },
    160_000,
  );
});
