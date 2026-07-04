/**
 * Spike B / plan spike (iii): d3-force worker layout round-trip benchmark.
 *
 * Measures, at 1k / 3k / 5k nodes (edges = 1.6x):
 *   1. echo round-trip      — transferable Float32Array main->worker->main,
 *                             zero compute (pure messaging overhead)
 *   2. tick round-trip      — ping-pong: main sends buffer, worker runs one
 *                             d3-force tick, fills + transfers back
 *   3. worker-side tick cost — measured inside the worker
 *   4. free-run throughput  — worker ticks continuously posting an epoch per
 *                             tick; main measures epochs/sec + inter-arrival
 *
 * Proxy honesty: Node worker_threads approximates a browser module worker.
 * Same V8, same structured-clone transfer-list semantics; browser adds
 * compositor contention on the main thread, which this cannot see (T3 item).
 *
 * Run: pnpm bench:layout   (from spikes/graph-perf/)
 */

import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContextGraph, edgesForNodes } from './synth-graph.ts';
import { fmtSummary, round, summarize, type Summary } from './stats.ts';
import { bundleLayoutWorker, request } from './worker-rpc.ts';

const here = dirname(fileURLToPath(import.meta.url));
const spikeRoot = join(here, '..');

const SIZES = [1000, 3000, 5000];
const WARMUP_TICKS = 30;
const MEASURE_TICKS = 300;
const ECHO_ITERS = 200;

interface SizeResult {
  n: number;
  e: number;
  buildMs: number;
  echoRoundTripMs: Summary;
  tickRoundTripMs: Summary;
  workerTickMs: Summary;
  transferOverheadMs: Summary; // tick round-trip minus worker tick
  freeRun: {
    epochs: number;
    totalMs: number;
    epochsPerSec: number;
    interArrivalMs: Summary;
  };
}

async function benchSize(workerPath: string, nNodes: number): Promise<SizeResult> {
  const e = edgesForNodes(nNodes);
  const { data } = buildContextGraph(nNodes, e, 42);
  const worker = new Worker(workerPath);
  let nextId = 0;

  try {
    const ready = await request(
      worker,
      {
        type: 'init',
        id: nextId++,
        n: nNodes,
        edges: data.edges.buffer,
        positions: data.positions.buffer,
      },
      [data.edges.buffer as ArrayBuffer, data.positions.buffer as ArrayBuffer],
      'ready',
    );

    // --- echo (pure messaging) ---
    const echoSamples: number[] = [];
    for (let i = 0; i < ECHO_ITERS; i++) {
      let buf: ArrayBuffer = new ArrayBuffer(8 * nNodes);
      const t0 = performance.now();
      const m = await request<any>(worker, { type: 'echo', id: nextId++, buf }, [buf], 'echoed');
      echoSamples.push(performance.now() - t0);
      buf = m.buf; // returned; dropped, next iteration allocates fresh
    }

    // --- ping-pong tick round trips ---
    let buf: ArrayBuffer = new ArrayBuffer(8 * nNodes);
    const rtSamples: number[] = [];
    const tickSamples: number[] = [];
    for (let i = 0; i < WARMUP_TICKS + MEASURE_TICKS; i++) {
      const t0 = performance.now();
      const m = await request<any>(worker, { type: 'tick', id: nextId++, buf }, [buf], 'positions');
      const rt = performance.now() - t0;
      buf = m.buf;
      if (i >= WARMUP_TICKS) {
        rtSamples.push(rt);
        tickSamples.push(m.tickMs);
      }
    }

    // --- free-run throughput ---
    const interArrival: number[] = [];
    const runId = nextId++;
    const freeRun = await new Promise<SizeResult['freeRun']>((resolve, reject) => {
      let last = 0;
      let epochs = 0;
      let start = 0;
      const onMessage = (m: any) => {
        if (m.id !== runId) return;
        if (m.type === 'error') {
          worker.off('message', onMessage);
          reject(new Error(m.message));
          return;
        }
        const now = performance.now();
        if (m.type === 'epoch') {
          if (epochs === 0) start = now;
          else interArrival.push(now - last);
          last = now;
          epochs++;
        } else if (m.type === 'done') {
          worker.off('message', onMessage);
          const totalMs = last - start;
          resolve({
            epochs,
            totalMs,
            epochsPerSec: ((epochs - 1) / totalMs) * 1000,
            interArrivalMs: summarize(interArrival),
          });
        }
      };
      worker.on('message', onMessage);
      worker.postMessage({ type: 'run', id: runId, count: MEASURE_TICKS });
    });

    const overhead = rtSamples.map((rt, i) => Math.max(0, rt - tickSamples[i]));

    return {
      n: nNodes,
      e,
      buildMs: round(ready.buildMs),
      echoRoundTripMs: summarize(echoSamples),
      tickRoundTripMs: summarize(rtSamples),
      workerTickMs: summarize(tickSamples),
      transferOverheadMs: summarize(overhead),
      freeRun,
    };
  } finally {
    await worker.terminate();
  }
}

async function main() {
  const workerPath = bundleLayoutWorker();
  const results: SizeResult[] = [];
  for (const n of SIZES) {
    process.stdout.write(`\n=== ${n} nodes / ${edgesForNodes(n)} edges ===\n`);
    const r = await benchSize(workerPath, n);
    results.push(r);
    process.stdout.write(`  sim build            ${r.buildMs} ms\n`);
    process.stdout.write(`  echo round-trip      ${fmtSummary(r.echoRoundTripMs)}\n`);
    process.stdout.write(`  tick round-trip      ${fmtSummary(r.tickRoundTripMs)}\n`);
    process.stdout.write(`  worker tick          ${fmtSummary(r.workerTickMs)}\n`);
    process.stdout.write(`  transfer overhead    ${fmtSummary(r.transferOverheadMs)}\n`);
    process.stdout.write(
      `  free-run             ${round(r.freeRun.epochsPerSec, 1)} epochs/s  ` +
        `inter-arrival ${fmtSummary(r.freeRun.interArrivalMs)}\n`,
    );
  }

  // Evidence captures are append-only (mirrors spikes/webview-render's
  // run-<ts>.json + latest.json pattern): every run writes a timestamped file
  // plus a `layout-latest.json` pointer, so a re-run can never silently
  // clobber a committed capture that the verdict doc cites.
  const outDir = join(spikeRoot, 'results');
  mkdirSync(outDir, { recursive: true });
  const capturedAt = new Date().toISOString();
  const payload = JSON.stringify(
    {
      spike: 'B-iii worker layout round-trip',
      host: `${process.platform}/${process.arch} node ${process.version} (worker_threads proxy for browser module worker)`,
      capturedAt,
      config: { WARMUP_TICKS, MEASURE_TICKS, ECHO_ITERS, alphaTarget: 0.3 },
      results,
    },
    null,
    2,
  );
  const stamp = capturedAt.replace(/[:.]/g, '-');
  const runPath = join(outDir, `layout-run-${stamp}.json`);
  writeFileSync(runPath, payload);
  writeFileSync(join(outDir, 'layout-latest.json'), payload);
  process.stdout.write(`\nwrote ${runPath} (+ layout-latest.json)\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
