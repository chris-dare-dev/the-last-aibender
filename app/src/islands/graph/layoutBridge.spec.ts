/**
 * FE-4 LayoutBridge — main-thread port over the layout worker (plan §9.2
 * FE-4: positive "typed arrays cross, ONE gentle reheat per commit";
 * negative "worker crash → renderer degrades to settled layout, no white
 * screen"; edge "alphaTarget bound asserted").
 *
 * The worker factory is injected: `FakeWorker` records every request +
 * transfer list and lets the suite drive responses/errors deterministically.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EPOCH_INTERVAL_MS,
  GENTLE_ALPHA_TARGET,
  createLayoutBridge,
  type LayoutBridgeTimers,
  type LayoutWorkerLike,
} from './layoutBridge.ts';
import type { LayoutWorkerRequest, LayoutWorkerResponse } from './workerProtocol.ts';
import type { GraphMutationBatch, GraphNodeRecord, PositionEpoch } from './types.ts';

class FakeWorker implements LayoutWorkerLike {
  readonly sent: Array<{ message: LayoutWorkerRequest; transfer: Transferable[] | undefined }> =
    [];
  terminated = 0;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  throwOnPost = false;

  postMessage(message: unknown, transfer?: Transferable[]): void {
    if (this.throwOnPost) throw new Error('post failed');
    this.sent.push({ message: message as LayoutWorkerRequest, transfer });
  }

  terminate(): void {
    this.terminated += 1;
  }

  respond(message: LayoutWorkerResponse): void {
    this.onmessage?.({ data: message });
  }

  fail(): void {
    this.onerror?.(new Error('worker crashed'));
  }

  kinds(): string[] {
    return this.sent.map((s) => s.message.type);
  }
}

/** Manual timers — the cooldown decay is asserted, not awaited. */
function manualTimers(): LayoutBridgeTimers & { fire: () => void; pending: number } {
  const queue: Array<{ fn: () => void }> = [];
  return {
    setTimeout(fn: () => void): unknown {
      const h = { fn };
      queue.push(h);
      return h;
    },
    clearTimeout(handle: unknown): void {
      const i = queue.indexOf(handle as { fn: () => void });
      if (i !== -1) queue.splice(i, 1);
    },
    fire(): void {
      const h = queue.shift();
      h?.fn();
    },
    get pending(): number {
      return queue.length;
    },
  };
}

const node = (index: number, x: number, y: number): GraphNodeRecord => ({
  index,
  id: `n${index}`,
  kind: 'reference',
  label: `n${index}`,
  cluster: 'ses-a',
  spawnX: x,
  spawnY: y,
});

const batchOf = (
  nodes: GraphNodeRecord[],
  edges: Array<[number, number]> = [],
  totals?: { nodes: number; edges: number; index?: number; removed?: number[] },
): GraphMutationBatch => ({
  addedNodes: nodes,
  addedEdges: edges.map(([s, t], i) => ({ index: i, sourceIndex: s, targetIndex: t })),
  pulses: [],
  retagged: [],
  removedNodes: totals?.removed ?? [],
  nodeCount: totals?.nodes ?? nodes.length,
  edgeCount: totals?.edges ?? edges.length,
  indexCount: totals?.index ?? totals?.nodes ?? nodes.length,
});

function boot(options: { epochIntervalMs?: number } = {}) {
  const worker = new FakeWorker();
  const timers = manualTimers();
  const bridge = createLayoutBridge({
    createWorker: () => worker,
    timers,
    ...(options.epochIntervalMs !== undefined
      ? { epochIntervalMs: options.epochIntervalMs }
      : {}),
  });
  return { worker, timers, bridge };
}

describe('layout bridge — boot + protocol', () => {
  it('inits the worker with the epoch interval and runs on ready', () => {
    const { worker, bridge } = boot({ epochIntervalMs: 20 });
    expect(bridge.state).toBe('starting');
    expect(worker.sent[0]?.message).toEqual({ type: 'init', epochIntervalMs: 20 });
    worker.respond({ type: 'ready' });
    expect(bridge.state).toBe('running');
  });

  it('defaults the epoch interval to 33 ms (~30 Hz — spike-B lock #5)', () => {
    const { worker } = boot();
    expect(worker.sent[0]?.message).toEqual({
      type: 'init',
      epochIntervalMs: DEFAULT_EPOCH_INTERVAL_MS,
    });
  });
});

describe('layout bridge — commits cross as typed arrays + ONE gentle reheat', () => {
  it('transfers spawn positions (f32) and edge pairs (u32), then reheats once', () => {
    const { worker, bridge } = boot();
    worker.respond({ type: 'ready' });
    bridge.applyBatch(batchOf([node(0, 1, 2), node(1, 3, 4)], [[0, 1]]));

    const add = worker.sent[1];
    expect(add?.message.type).toBe('add');
    const msg = add?.message as Extract<LayoutWorkerRequest, { type: 'add' }>;
    expect(msg.count).toBe(2);
    expect([...new Float32Array(msg.positions)]).toEqual([1, 2, 3, 4]);
    expect([...new Uint32Array(msg.edges)]).toEqual([0, 1]);
    // Both buffers on the transfer list — zero-copy, never structured-clone.
    expect(add?.transfer).toEqual([msg.positions, msg.edges]);

    // Exactly ONE reheat per commit, at the gentle bound.
    expect(worker.kinds()).toEqual(['init', 'add', 'reheat']);
    const reheat = worker.sent[2]?.message as Extract<LayoutWorkerRequest, { type: 'reheat' }>;
    expect(reheat.alphaTarget).toBe(GENTLE_ALPHA_TARGET);
  });

  it('arms an automatic cooldown after the batch (decay to rest)', () => {
    const { worker, timers, bridge } = boot();
    worker.respond({ type: 'ready' });
    bridge.applyBatch(batchOf([node(0, 0, 0)]));
    expect(timers.pending).toBe(1);
    timers.fire();
    expect(worker.kinds().at(-1)).toBe('cooldown');
  });

  it('re-arms (not stacks) the cooldown across rapid commits', () => {
    const { worker, timers, bridge } = boot();
    worker.respond({ type: 'ready' });
    bridge.applyBatch(batchOf([node(0, 0, 0)]));
    bridge.applyBatch(batchOf([node(1, 0, 0)], [], { nodes: 2, edges: 0 }));
    expect(timers.pending).toBe(1); // one armed window, not two
    timers.fire();
    expect(worker.kinds().filter((k) => k === 'cooldown')).toHaveLength(1);
  });

  it('clamps explicit reheat targets to the frozen [0, 0.3] bound', () => {
    const { worker, bridge } = boot();
    worker.respond({ type: 'ready' });
    bridge.reheat(0.9);
    bridge.reheat(-4);
    const targets = worker.sent
      .filter((s) => s.message.type === 'reheat')
      .map((s) => (s.message as Extract<LayoutWorkerRequest, { type: 'reheat' }>).alphaTarget);
    expect(targets).toEqual([GENTLE_ALPHA_TARGET, 0]);
  });

  it('ignores empty batches (no wire traffic, no reheat)', () => {
    const { worker, bridge } = boot();
    worker.respond({ type: 'ready' });
    bridge.applyBatch(batchOf([]));
    expect(worker.kinds()).toEqual(['init']);
  });
});

describe('layout bridge — epochs', () => {
  it('fans out epochs and tracks the seq watermark', () => {
    const { worker, bridge } = boot();
    worker.respond({ type: 'ready' });
    const epochs: PositionEpoch[] = [];
    bridge.onEpoch((e) => epochs.push(e));
    const buf = new Float32Array([5, 6]).buffer as ArrayBuffer;
    worker.respond({ type: 'epoch', buf, n: 1, seq: 7, alpha: 0.2, alphaTarget: 0.3 });
    expect(bridge.lastEpochSeq).toBe(7);
    expect(epochs[0]?.nodeCount).toBe(1);
    expect([...(epochs[0]?.positions ?? [])]).toEqual([5, 6]);
    expect(bridge.state).toBe('running');
  });

  it('a converged epoch with target 0 parks the bridge at idle', () => {
    const { worker, bridge } = boot();
    worker.respond({ type: 'ready' });
    worker.respond({
      type: 'epoch',
      buf: new Float32Array([0, 0]).buffer as ArrayBuffer,
      n: 1,
      seq: 1,
      alpha: 0.0005,
      alphaTarget: 0,
    });
    expect(bridge.state).toBe('idle');
  });

  it('ignores non-protocol messages (tolerant reader)', () => {
    const { worker, bridge } = boot();
    worker.onmessage?.({ data: { garbage: true } });
    worker.onmessage?.({ data: 42 });
    expect(bridge.state).toBe('starting');
  });
});

describe('layout bridge — degrade posture (worker crash → settled layout)', () => {
  it('worker error → degraded; the LAST epoch stays authoritative', () => {
    const { worker, bridge } = boot();
    worker.respond({ type: 'ready' });
    const epochs: PositionEpoch[] = [];
    bridge.onEpoch((e) => epochs.push(e));
    worker.respond({
      type: 'epoch',
      buf: new Float32Array([9, 9]).buffer as ArrayBuffer,
      n: 1,
      seq: 3,
      alpha: 0.2,
      alphaTarget: 0.3,
    });
    const states: string[] = [];
    bridge.onStateChange((s) => states.push(s));
    worker.fail();
    expect(bridge.state).toBe('degraded');
    expect(worker.terminated).toBe(1);
    // One settled synthetic epoch re-freezes the field where it stood.
    const last = epochs.at(-1);
    expect(last?.alpha).toBe(0);
    expect([...(last?.positions ?? [])]).toEqual([9, 9]);
    expect(states).toContain('degraded');
  });

  it('degraded batches grow the field at SPAWN coordinates (settled epochs)', () => {
    const { worker, bridge } = boot();
    worker.respond({ type: 'ready' });
    const epochs: PositionEpoch[] = [];
    bridge.onEpoch((e) => epochs.push(e));
    worker.fail();
    bridge.applyBatch(batchOf([node(0, 11, 12), node(1, 13, 14)]));
    const last = epochs.at(-1);
    expect(last?.nodeCount).toBe(2);
    expect(last?.alpha).toBe(0);
    expect([...(last?.positions ?? [])]).toEqual([11, 12, 13, 14]);
    // Epoch seqs stay monotonic across the synthetic axis.
    const seqs = epochs.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it('a worker error RESPONSE degrades identically', () => {
    const { worker, bridge } = boot();
    worker.respond({ type: 'ready' });
    worker.respond({ type: 'error', message: 'induced' });
    expect(bridge.state).toBe('degraded');
  });

  it('a throwing factory degrades at construction (no white screen ever)', () => {
    const bridge = createLayoutBridge({
      createWorker: () => {
        throw new Error('no module worker support');
      },
      timers: manualTimers(),
    });
    expect(bridge.state).toBe('degraded');
    const epochs: PositionEpoch[] = [];
    bridge.onEpoch((e) => epochs.push(e));
    bridge.applyBatch(batchOf([node(0, 1, 1)]));
    expect(epochs).toHaveLength(1);
    expect(epochs[0]?.alpha).toBe(0);
  });

  it('a throwing postMessage degrades mid-flight', () => {
    const { worker, bridge } = boot();
    worker.respond({ type: 'ready' });
    worker.throwOnPost = true;
    bridge.applyBatch(batchOf([node(0, 1, 1)]));
    expect(bridge.state).toBe('degraded');
  });

  it('reheat/cooldown are inert while degraded (no zombie traffic)', () => {
    const { worker, bridge } = boot();
    worker.respond({ type: 'ready' });
    worker.fail();
    const before = worker.sent.length;
    bridge.reheat();
    bridge.cooldown();
    expect(worker.sent.length).toBe(before);
  });
});

describe('layout bridge — settle (reduced-motion path)', () => {
  it('forwards settle to the worker while running', () => {
    const { worker, bridge } = boot();
    worker.respond({ type: 'ready' });
    bridge.settle();
    expect(worker.kinds().at(-1)).toBe('settle');
  });

  it('re-emits the settled field for late subscribers while degraded', () => {
    const { worker, bridge } = boot();
    worker.respond({ type: 'ready' });
    worker.respond({
      type: 'epoch',
      buf: new Float32Array([1, 2]).buffer as ArrayBuffer,
      n: 1,
      seq: 1,
      alpha: 0.2,
      alphaTarget: 0.3,
    });
    worker.fail();
    const epochs: PositionEpoch[] = [];
    bridge.onEpoch((e) => epochs.push(e)); // subscribed AFTER the crash
    bridge.settle();
    expect(epochs).toHaveLength(1);
    expect([...(epochs[0]?.positions ?? [])]).toEqual([1, 2]);
  });
});

describe('layout bridge — dispose', () => {
  it('stops the worker, terminates, and goes inert', () => {
    const { worker, timers, bridge } = boot();
    worker.respond({ type: 'ready' });
    bridge.applyBatch(batchOf([node(0, 0, 0)]));
    bridge.dispose();
    expect(worker.kinds().at(-1)).toBe('stop');
    expect(worker.terminated).toBe(1);
    expect(bridge.state).toBe('disposed');
    expect(timers.pending).toBe(0); // cooldown cancelled
    const before = worker.sent.length;
    bridge.applyBatch(batchOf([node(1, 0, 0)]));
    bridge.reheat();
    expect(worker.sent.length).toBe(before);
  });
});
