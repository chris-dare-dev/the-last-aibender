/**
 * d3-force layout worker (spike B, plan spike iii). Quarantined spike code.
 *
 * Runs the FE-4-representative force simulation inside a Node
 * `worker_threads` worker and exchanges positions as TRANSFERABLE
 * Float32Array buffers — the same zero-copy pattern the browser module
 * worker will use (worker_threads postMessage implements the same
 * structured-clone + transfer-list semantics as DOM postMessage).
 *
 * Protocol (all messages carry `id` for request/response matching):
 *   -> { type: 'init', id, n, edges: ArrayBuffer, positions: ArrayBuffer }
 *   <- { type: 'ready', id, buildMs }
 *   -> { type: 'tick', id, buf: ArrayBuffer }        // ping-pong mode
 *   <- { type: 'positions', id, buf, tickMs }        // buf transferred back
 *   -> { type: 'echo', id, buf: ArrayBuffer }        // zero-compute round trip
 *   <- { type: 'echoed', id, buf }
 *   -> { type: 'run', id, count }                    // free-run mode
 *   <- { type: 'epoch', id, seq, buf, tickMs } * count (fresh buffer each epoch)
 *   <- { type: 'done', id }
 *   <- { type: 'error', id, message }                // any failure
 */

import { parentPort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import {
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';

interface Node extends SimulationNodeDatum {
  index: number;
}
type Link = SimulationLinkDatum<Node>;

if (!parentPort) throw new Error('layout-worker must run inside a worker_thread');
const port = parentPort;

let sim: Simulation<Node, Link> | null = null;
let nodes: Node[] = [];
let n = 0;

function fill(buf: ArrayBuffer): Float32Array {
  const out = new Float32Array(buf);
  for (let i = 0; i < n; i++) {
    out[2 * i] = nodes[i].x!;
    out[2 * i + 1] = nodes[i].y!;
  }
  return out;
}

port.on('message', (msg: any) => {
  const id = msg?.id;
  try {
    switch (msg.type) {
      case 'init': {
        const t0 = performance.now();
        n = msg.n;
        const edges = new Uint32Array(msg.edges);
        const pos = new Float32Array(msg.positions);
        if (pos.length !== 2 * n) {
          throw new Error(`init: positions length ${pos.length} != 2n (${2 * n})`);
        }
        nodes = Array.from({ length: n }, (_, i) => ({
          index: i,
          x: pos[2 * i],
          y: pos[2 * i + 1],
        }));
        const links: Link[] = [];
        for (let k = 0; k < edges.length; k += 2) {
          const s = edges[k];
          const t = edges[k + 1];
          if (s >= n || t >= n) throw new Error(`init: edge index out of range (${s},${t})`);
          links.push({ source: s, target: t });
        }
        // FE-4-representative force set (blueprint §8 / findings ui-motion doc):
        // link + manyBody(Barnes-Hut) + weak x/y centering; gentle
        // alphaTarget(0.3) — the steady "live graph" reheat state, i.e. the
        // simulation never settles during the benchmark window.
        sim = forceSimulation<Node>(nodes)
          .force('link', forceLink<Node, Link>(links).distance(30).iterations(1))
          .force('charge', forceManyBody<Node>().strength(-30).theta(0.9))
          .force('x', forceX<Node>(0).strength(0.05))
          .force('y', forceY<Node>(0).strength(0.05))
          .alphaTarget(0.3)
          .stop(); // we drive ticks manually
        port.postMessage({ type: 'ready', id, buildMs: performance.now() - t0 });
        break;
      }
      case 'tick': {
        if (!sim) throw new Error('tick before init');
        const t0 = performance.now();
        sim.tick();
        const tickMs = performance.now() - t0;
        const out = fill(msg.buf);
        port.postMessage({ type: 'positions', id, buf: out.buffer, tickMs }, [
          out.buffer as ArrayBuffer,
        ]);
        break;
      }
      case 'echo': {
        port.postMessage({ type: 'echoed', id, buf: msg.buf }, [msg.buf]);
        break;
      }
      case 'run': {
        if (!sim) throw new Error('run before init');
        for (let seq = 0; seq < msg.count; seq++) {
          const t0 = performance.now();
          sim.tick();
          const tickMs = performance.now() - t0;
          // Fresh buffer per epoch (browser impl would double-buffer; the
          // ~40 KB/epoch allocation is included in the measured cost and
          // called out in the verdict doc).
          const out = fill(new ArrayBuffer(8 * n));
          port.postMessage({ type: 'epoch', id, seq, buf: out.buffer, tickMs }, [
            out.buffer as ArrayBuffer,
          ]);
        }
        port.postMessage({ type: 'done', id });
        break;
      }
      default:
        throw new Error(`unknown message type: ${String(msg.type)}`);
    }
  } catch (err) {
    port.postMessage({ type: 'error', id, message: (err as Error).message });
  }
});
