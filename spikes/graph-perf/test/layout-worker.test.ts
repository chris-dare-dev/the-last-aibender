import { Worker } from 'node:worker_threads';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildContextGraph } from '../src/synth-graph.ts';
import { bundleLayoutWorker, request } from '../src/worker-rpc.ts';

let workerPath: string;
let worker: Worker | null = null;

beforeAll(() => {
  workerPath = bundleLayoutWorker();
});

afterEach(async () => {
  if (worker) {
    await worker.terminate();
    worker = null;
  }
});

function spawn(): Worker {
  worker = new Worker(workerPath);
  return worker;
}

async function init(w: Worker, n: number, e: number, id = 0) {
  const { data } = buildContextGraph(n, e, 42);
  const initialPositions = Float32Array.from(data.positions);
  await request(
    w,
    { type: 'init', id, n, edges: data.edges.buffer, positions: data.positions.buffer },
    [data.edges.buffer as ArrayBuffer, data.positions.buffer as ArrayBuffer],
    'ready',
  );
  return initialPositions;
}

describe('layout worker protocol', () => {
  // positive
  it('init -> tick round-trip returns 2n moved positions in a transferred buffer', async () => {
    const w = spawn();
    const initial = await init(w, 200, 320);

    const buf = new ArrayBuffer(8 * 200);
    const m = await request<any>(w, { type: 'tick', id: 1, buf }, [buf], 'positions');

    // sender-side buffer was genuinely transferred (zero-copy), not cloned
    expect(buf.byteLength).toBe(0);
    expect(m.tickMs).toBeGreaterThan(0);

    const out = new Float32Array(m.buf);
    expect(out.length).toBe(400);
    let moved = 0;
    for (let i = 0; i < 400; i++) {
      expect(Number.isFinite(out[i])).toBe(true);
      if (out[i] !== initial[i]) moved++;
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('successive ticks keep advancing the simulation (alphaTarget 0.3 never settles)', async () => {
    const w = spawn();
    await init(w, 100, 160);
    let prev: Float32Array | null = null;
    let buf = new ArrayBuffer(8 * 100);
    for (let i = 0; i < 3; i++) {
      const m = await request<any>(w, { type: 'tick', id: 10 + i, buf }, [buf], 'positions');
      const cur = new Float32Array(m.buf);
      if (prev) expect([...cur]).not.toEqual([...prev]);
      prev = Float32Array.from(cur);
      buf = m.buf;
    }
  });

  it('echo round-trips a buffer without compute', async () => {
    const w = spawn();
    const buf = new ArrayBuffer(64);
    const m = await request<any>(w, { type: 'echo', id: 2, buf }, [buf], 'echoed');
    expect(buf.byteLength).toBe(0);
    expect(m.buf.byteLength).toBe(64);
  });

  it('free-run posts exactly `count` epochs then done', async () => {
    const w = spawn();
    await init(w, 50, 80);
    const epochs: number[] = [];
    await new Promise<void>((resolve, reject) => {
      w.on('message', (m: any) => {
        if (m.id !== 3) return;
        if (m.type === 'epoch') epochs.push(m.seq);
        else if (m.type === 'done') resolve();
        else if (m.type === 'error') reject(new Error(m.message));
      });
      w.postMessage({ type: 'run', id: 3, count: 5 });
    });
    expect(epochs).toEqual([0, 1, 2, 3, 4]);
  });

  // negative
  it('rejects tick before init with an error reply (worker survives)', async () => {
    const w = spawn();
    const buf = new ArrayBuffer(8);
    await expect(request(w, { type: 'tick', id: 4, buf }, [buf], 'positions')).rejects.toThrow(
      /tick before init/,
    );
    // worker still alive and usable
    await init(w, 10, 16, 5);
  });

  it('rejects init with an out-of-range edge index', async () => {
    const w = spawn();
    const edges = new Uint32Array([0, 99]); // node 99 does not exist in n=2
    const positions = new Float32Array(4);
    await expect(
      request(
        w,
        { type: 'init', id: 6, n: 2, edges: edges.buffer, positions: positions.buffer },
        [edges.buffer as ArrayBuffer, positions.buffer as ArrayBuffer],
        'ready',
      ),
    ).rejects.toThrow(/out of range/);
  });

  it('rejects unknown message types', async () => {
    const w = spawn();
    await expect(request(w, { type: 'flarp', id: 7 }, [], 'never')).rejects.toThrow(
      /unknown message type/,
    );
  });

  // edge
  it('rejects init when positions length disagrees with n', async () => {
    const w = spawn();
    const edges = new Uint32Array([0, 1]);
    const positions = new Float32Array(2); // should be 2n = 4
    await expect(
      request(
        w,
        { type: 'init', id: 8, n: 2, edges: edges.buffer, positions: positions.buffer },
        [edges.buffer as ArrayBuffer, positions.buffer as ArrayBuffer],
        'ready',
      ),
    ).rejects.toThrow(/positions length/);
  });

  it('handles the minimal 2-node graph', async () => {
    const w = spawn();
    await init(w, 2, 1);
    const buf = new ArrayBuffer(16);
    const m = await request<any>(w, { type: 'tick', id: 9, buf }, [buf], 'positions');
    expect(new Float32Array(m.buf).length).toBe(4);
  });
});
