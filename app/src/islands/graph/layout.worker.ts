/**
 * FE-4 layout module worker — the thin message shell around
 * {@link createLayoutEngine} (spike-B lock #1: layout NEVER runs on the main
 * thread; an ~11 ms 5k tick would eat ~67% of the frame budget).
 *
 * Epoch loop: while the simulation is hot, tick + post one transferable
 * Float32Array epoch every `epochIntervalMs` (default 33 ms ≈ 30 Hz — the
 * renderer interpolates between epochs, so sim rate floats freely below the
 * frame rate; spike-B lock #5). When alpha settles below the floor with
 * alphaTarget 0, one final settled epoch is emitted and the loop parks until
 * the next add/reheat/settle.
 *
 * Loaded with `new Worker(new URL('./layout.worker.ts', import.meta.url),
 * { type: 'module' })` — the Vite module-worker path (Safari 15+).
 */

import { createLayoutEngine } from './layoutEngine.ts';
import { isLayoutWorkerResponse, type LayoutWorkerRequest, type LayoutWorkerResponse } from './workerProtocol.ts';

interface WorkerScope {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  close(): void;
}

const scope = globalThis as unknown as WorkerScope;

const engine = createLayoutEngine();
let epochIntervalMs = 33;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;

function post(message: LayoutWorkerResponse, transfer?: Transferable[]): void {
  // Guard-rail: only protocol shapes leave the worker.
  if (!isLayoutWorkerResponse(message)) return;
  if (transfer !== undefined) scope.postMessage(message, transfer);
  else scope.postMessage(message);
}

function emitEpoch(alphaAfterTick: number): void {
  const n = engine.nodeCount;
  // Fresh buffer per epoch — measured at ~40 KB/epoch for 5k nodes and
  // included in the spike-B throughput numbers (87 epochs/s at 5k).
  const out = engine.fillEpoch(new ArrayBuffer(8 * n));
  seq += 1;
  post(
    { type: 'epoch', buf: out.buffer as ArrayBuffer, n, seq, alpha: alphaAfterTick, alphaTarget: engine.alphaTarget() },
    [out.buffer as ArrayBuffer],
  );
}

function pump(): void {
  timer = undefined;
  if (stopped || engine.nodeCount === 0) return;
  if (!engine.isHot()) {
    // Park: one settled epoch already went out when we cooled (below).
    return;
  }
  const alpha = engine.tick();
  emitEpoch(alpha);
  if (engine.isHot()) {
    timer = setTimeout(pump, epochIntervalMs);
  } else {
    // Crossed the settle floor on this tick — the epoch above IS the
    // settled frame; park until the next message.
    timer = undefined;
  }
}

function ensurePumping(): void {
  if (stopped || timer !== undefined) return;
  if (engine.nodeCount === 0 || !engine.isHot()) return;
  timer = setTimeout(pump, 0);
}

scope.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as LayoutWorkerRequest;
  try {
    switch (msg.type) {
      case 'init': {
        if (msg.epochIntervalMs !== undefined && msg.epochIntervalMs > 0) {
          epochIntervalMs = msg.epochIntervalMs;
        }
        post({ type: 'ready' });
        break;
      }
      case 'add': {
        engine.add(msg.count, new Float32Array(msg.positions), new Uint32Array(msg.edges));
        ensurePumping();
        break;
      }
      case 'reheat': {
        engine.reheat(msg.alphaTarget); // engine clamps to [0, 0.3]
        ensurePumping();
        break;
      }
      case 'cooldown': {
        engine.cooldown();
        break;
      }
      case 'settle': {
        // Reduced-motion path: converge off-screen, emit ONE settled epoch.
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        engine.settle();
        if (engine.nodeCount > 0) emitEpoch(engine.alpha());
        break;
      }
      case 'pin': {
        engine.pin(msg.index, msg.x, msg.y);
        break;
      }
      case 'unpin': {
        engine.unpin(msg.index);
        break;
      }
      case 'crash': {
        // Deterministic failure for the degrade-path suites (plan §9.2 FE-4
        // negative row). Throwing synchronously inside onmessage surfaces as
        // a worker `error` event on the main thread.
        throw new Error('layout-worker: induced crash (test hook)');
      }
      case 'stop': {
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        scope.close();
        break;
      }
      default:
        break;
    }
  } catch (err) {
    if ((msg as { type?: unknown }).type === 'crash') throw err;
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
