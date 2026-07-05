/**
 * FE-4 LayoutBridge — stage two of the normative contract: the main-thread
 * port over the d3-force MODULE WORKER (layout.worker.ts).
 *
 *  - store commits cross as typed arrays (spawn positions Float32Array +
 *    edge-index Uint32Array, both TRANSFERRED — never structured-cloned
 *    object graphs);
 *  - every batch triggers ONE gentle reheat (alphaTarget clamped to
 *    [0, {@link GENTLE_ALPHA_TARGET}] — the plan §9.2 FE-4 edge row bound),
 *    then an automatic cooldown after {@link DEFAULT_COOLDOWN_MS};
 *  - position epochs arrive as transferable Float32Arrays and fan out to
 *    {@link LayoutBridge.onEpoch} listeners (the renderer interpolates);
 *  - WORKER CRASH → `degraded`: the last epoch stays authoritative, later
 *    nodes rest at their spawn coordinates via SYNTHETIC settled epochs —
 *    the renderer keeps painting a settled layout, never a white screen
 *    (plan §9.2 FE-4 negative row).
 *
 * The worker factory is injectable so unit suites drive a fake; the real
 * island uses the Vite module-worker path.
 */

import { GENTLE_ALPHA_TARGET } from './layoutEngine.ts';
import {
  isLayoutWorkerResponse,
  type LayoutWorkerRequest,
  type LayoutWorkerResponse,
} from './workerProtocol.ts';
import type { GraphMutationBatch, LayoutBridge, LayoutBridgeState, PositionEpoch } from './types.ts';

export { GENTLE_ALPHA_TARGET };

export const DEFAULT_COOLDOWN_MS = 1500;
export const DEFAULT_EPOCH_INTERVAL_MS = 33;

/** Structural worker slice (a real `Worker` satisfies it). */
export interface LayoutWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface LayoutBridgeTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface LayoutBridgeOptions {
  /** Worker factory (tests inject fakes; may throw → immediate degrade). */
  createWorker?: () => LayoutWorkerLike;
  epochIntervalMs?: number;
  cooldownMs?: number;
  timers?: LayoutBridgeTimers;
}

const realTimers: LayoutBridgeTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

/** The production worker factory (Vite module-worker build path). */
export function createLayoutWorker(): LayoutWorkerLike {
  return new Worker(new URL('./layout.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as LayoutWorkerLike;
}

export function createLayoutBridge(options: LayoutBridgeOptions = {}): LayoutBridge {
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const timers = options.timers ?? realTimers;

  const epochListeners = new Set<(epoch: PositionEpoch) => void>();
  const stateListeners = new Set<(state: LayoutBridgeState) => void>();

  let state: LayoutBridgeState = 'starting';
  let worker: LayoutWorkerLike | undefined;
  let lastEpochSeq = -1;
  let syntheticSeq = 0;
  /**
   * Last known positions (epoch or synthetic) — the degrade baseline.
   * Explicitly `Float32Array<ArrayBufferLike>` (the bare-name default):
   * epoch views arrive over transferred buffers and the inferred
   * `Float32Array<ArrayBuffer>` of the initializer would reject them.
   */
  let lastPositions: Float32Array = new Float32Array(0);
  let knownNodes = 0;
  let cooldownHandle: unknown;

  const setState = (next: LayoutBridgeState): void => {
    if (state === next || state === 'disposed') return;
    state = next;
    for (const listener of [...stateListeners]) listener(next);
  };

  const emit = (epoch: PositionEpoch): void => {
    lastEpochSeq = epoch.seq;
    if (epoch.positions.length >= lastPositions.length) {
      lastPositions = epoch.positions;
      knownNodes = epoch.nodeCount;
    }
    for (const listener of [...epochListeners]) listener(epoch);
  };

  const degrade = (): void => {
    if (state === 'disposed' || state === 'degraded') return;
    try {
      worker?.terminate();
    } catch {
      /* already dead */
    }
    worker = undefined;
    setState('degraded');
    // Freeze the field where it stands: one settled synthetic epoch so any
    // consumer arming after the crash still receives a layout.
    if (knownNodes > 0) {
      syntheticSeq += 1;
      emit({
        positions: lastPositions,
        nodeCount: knownNodes,
        seq: lastEpochSeq + syntheticSeq,
        alpha: 0,
      });
    }
  };

  const send = (message: LayoutWorkerRequest, transfer?: Transferable[]): void => {
    if (worker === undefined) return;
    try {
      worker.postMessage(message, transfer);
    } catch {
      degrade();
    }
  };

  // --- boot ------------------------------------------------------------------
  try {
    const factory = options.createWorker ?? createLayoutWorker;
    worker = factory();
    worker.onmessage = (ev) => {
      const msg = ev.data;
      if (!isLayoutWorkerResponse(msg)) return;
      handleResponse(msg);
    };
    worker.onerror = (ev) => {
      // The degrade posture IS the handler for a worker crash — mark the
      // event handled so an already-managed failure does not also surface
      // as an uncaught global error.
      (ev as { preventDefault?: () => void }).preventDefault?.();
      degrade();
    };
    send({
      type: 'init',
      epochIntervalMs: options.epochIntervalMs ?? DEFAULT_EPOCH_INTERVAL_MS,
    });
  } catch {
    worker = undefined;
    // Construction failed (no module-worker support, CSP, …) — settled-layout
    // posture from the first commit onward.
    setState('degraded');
  }

  function handleResponse(msg: LayoutWorkerResponse): void {
    if (state === 'disposed') return;
    switch (msg.type) {
      case 'ready':
        if (state === 'starting') setState('running');
        break;
      case 'epoch': {
        const positions = new Float32Array(msg.buf);
        emit({ positions, nodeCount: msg.n, seq: msg.seq, alpha: msg.alpha });
        setState(msg.alpha < 0.001 && msg.alphaTarget === 0 ? 'idle' : 'running');
        break;
      }
      case 'error':
        degrade();
        break;
      default:
        break;
    }
  }

  const armCooldown = (): void => {
    if (cooldownHandle !== undefined) timers.clearTimeout(cooldownHandle);
    cooldownHandle = timers.setTimeout(() => {
      cooldownHandle = undefined;
      send({ type: 'cooldown' });
    }, cooldownMs);
  };

  const clampTarget = (target: number): number =>
    Math.min(GENTLE_ALPHA_TARGET, Math.max(0, target));

  /** Fresh read — `send()` may degrade mid-call and TS keeps stale narrowing. */
  const degradedNow = (): boolean => state === 'degraded';

  return {
    get state(): LayoutBridgeState {
      return state;
    },
    get lastEpochSeq(): number {
      return lastEpochSeq;
    },

    applyBatch(batch: GraphMutationBatch): void {
      if (state === 'disposed' || batch.addedNodes.length + batch.addedEdges.length === 0) {
        return;
      }
      if (state === 'degraded' || worker === undefined) {
        // Settled-layout degrade: new nodes rest at their spawn coordinates.
        if (batch.nodeCount > knownNodes) {
          const grown = new Float32Array(2 * batch.nodeCount);
          grown.set(lastPositions.subarray(0, Math.min(lastPositions.length, 2 * batch.nodeCount)));
          for (const node of batch.addedNodes) {
            grown[2 * node.index] = node.spawnX;
            grown[2 * node.index + 1] = node.spawnY;
          }
          lastPositions = grown;
          knownNodes = batch.nodeCount;
          syntheticSeq += 1;
          emit({
            positions: grown,
            nodeCount: batch.nodeCount,
            seq: lastEpochSeq + syntheticSeq,
            alpha: 0,
          });
        }
        return;
      }

      const positions = new Float32Array(2 * batch.addedNodes.length);
      for (let i = 0; i < batch.addedNodes.length; i++) {
        const node = batch.addedNodes[i];
        if (node === undefined) continue;
        positions[2 * i] = node.spawnX;
        positions[2 * i + 1] = node.spawnY;
      }
      const edges = new Uint32Array(2 * batch.addedEdges.length);
      for (let i = 0; i < batch.addedEdges.length; i++) {
        const edge = batch.addedEdges[i];
        if (edge === undefined) continue;
        edges[2 * i] = edge.sourceIndex;
        edges[2 * i + 1] = edge.targetIndex;
      }
      send(
        {
          type: 'add',
          count: batch.addedNodes.length,
          positions: positions.buffer as ArrayBuffer,
          edges: edges.buffer as ArrayBuffer,
        },
        [positions.buffer as ArrayBuffer, edges.buffer as ArrayBuffer],
      );
      // One GENTLE reheat per commit — never per event, never alpha(1).
      send({ type: 'reheat', alphaTarget: GENTLE_ALPHA_TARGET });
      // A throwing postMessage degrades INSIDE send() — never resurrect the
      // state to running after a mid-commit crash.
      if (degradedNow()) return;
      setState('running');
      armCooldown();
    },

    reheat(alphaTarget = GENTLE_ALPHA_TARGET): void {
      if (state === 'disposed' || state === 'degraded') return;
      send({ type: 'reheat', alphaTarget: clampTarget(alphaTarget) });
      if (degradedNow()) return;
      setState('running');
      armCooldown();
    },

    cooldown(): void {
      if (state === 'disposed' || state === 'degraded') return;
      if (cooldownHandle !== undefined) {
        timers.clearTimeout(cooldownHandle);
        cooldownHandle = undefined;
      }
      send({ type: 'cooldown' });
    },

    settle(): void {
      if (state === 'disposed') return;
      if (state === 'degraded') {
        // Already settled by construction; re-emit for late subscribers.
        if (knownNodes > 0) {
          syntheticSeq += 1;
          emit({
            positions: lastPositions,
            nodeCount: knownNodes,
            seq: lastEpochSeq + syntheticSeq,
            alpha: 0,
          });
        }
        return;
      }
      send({ type: 'settle' });
    },

    onEpoch(listener: (epoch: PositionEpoch) => void): () => void {
      epochListeners.add(listener);
      return () => epochListeners.delete(listener);
    },

    onStateChange(listener: (next: LayoutBridgeState) => void): () => void {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },

    dispose(): void {
      if (state === 'disposed') return;
      if (cooldownHandle !== undefined) timers.clearTimeout(cooldownHandle);
      cooldownHandle = undefined;
      send({ type: 'stop' });
      try {
        worker?.terminate();
      } catch {
        /* already dead */
      }
      worker = undefined;
      state = 'disposed';
      epochListeners.clear();
      stateListeners.clear();
    },
  };
}
