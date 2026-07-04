/**
 * Synthetic context-graph generator (spike B). Quarantined spike code.
 *
 * Shape mimics the FE-4 context graph: clustered workstreams (sessions +
 * the files/skills they touch) with a spanning backbone per cluster, most
 * extra edges intra-cluster, and a minority of cross-cluster "shared file"
 * edges. All data is SYNTHESIZED from a seeded PRNG — no real transcript
 * material anywhere ([X2]).
 */

import Graph from 'graphology';

export interface SynthGraphData {
  n: number;
  e: number;
  /** Edge list as flat index pairs: [s0, t0, s1, t1, ...] length 2e. */
  edges: Uint32Array;
  /** Initial positions [x0, y0, x1, y1, ...] length 2n. */
  positions: Float32Array;
  /** Cluster id per node (for cluster-dim realism in the render soak). */
  cluster: Uint16Array;
}

export interface SynthGraphResult {
  graph: Graph;
  data: SynthGraphData;
}

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a clustered synthetic graph with exactly `n` nodes and `targetE`
 * undirected edges (no self-loops, no multi-edges).
 */
export function buildContextGraph(n: number, targetE: number, seed = 42): SynthGraphResult {
  if (n < 2) throw new Error(`buildContextGraph: need n >= 2, got ${n}`);
  const clusters = Math.max(2, Math.min(Math.round(n / 200), n));
  const backbone = n - clusters; // spanning tree per cluster
  if (targetE < backbone) {
    throw new Error(
      `buildContextGraph: targetE ${targetE} below cluster backbone ${backbone}`,
    );
  }
  const maxE = (n * (n - 1)) / 2;
  if (targetE > maxE) {
    throw new Error(`buildContextGraph: targetE ${targetE} exceeds simple-graph max ${maxE}`);
  }

  const rng = mulberry32(seed);
  const graph = new Graph({ type: 'undirected', multi: false, allowSelfLoops: false });
  const cluster = new Uint16Array(n);
  const members: number[][] = Array.from({ length: clusters }, () => []);

  for (let i = 0; i < n; i++) {
    const c = i < clusters ? i : Math.floor(rng() * clusters);
    cluster[i] = c;
    graph.addNode(String(i));
    members[c].push(i);
  }

  const addEdge = (a: number, b: number): boolean => {
    if (a === b) return false;
    const sa = String(a);
    const sb = String(b);
    if (graph.hasEdge(sa, sb)) return false;
    graph.addEdge(sa, sb);
    return true;
  };

  // 1. Spanning backbone inside each cluster (preferential to earlier
  //    members — sessions accrete files over time).
  for (const m of members) {
    for (let k = 1; k < m.length; k++) {
      const parent = m[Math.floor(rng() * k)];
      addEdge(m[k], parent);
    }
  }

  // 2. Fill to targetE: 85% intra-cluster, 15% cross-cluster.
  let guard = 0;
  const guardMax = targetE * 200;
  while (graph.size < targetE) {
    if (++guard > guardMax) {
      throw new Error(`buildContextGraph: gave up after ${guardMax} attempts at e=${graph.size}`);
    }
    let a: number;
    let b: number;
    if (rng() < 0.85) {
      const m = members[Math.floor(rng() * clusters)];
      if (m.length < 2) continue;
      a = m[Math.floor(rng() * m.length)];
      b = m[Math.floor(rng() * m.length)];
    } else {
      a = Math.floor(rng() * n);
      b = Math.floor(rng() * n);
    }
    addEdge(a, b);
  }

  // Extract flat typed arrays.
  const edges = new Uint32Array(targetE * 2);
  let w = 0;
  graph.forEachEdge((_edge: string, _attrs: unknown, source: string, target: string) => {
    edges[w++] = Number(source);
    edges[w++] = Number(target);
  });

  const spread = Math.sqrt(n) * 24; // density-neutral initial box
  const positions = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    positions[2 * i] = (rng() - 0.5) * spread;
    positions[2 * i + 1] = (rng() - 0.5) * spread;
  }

  return { graph, data: { n, e: targetE, edges, positions, cluster } };
}

/** The spike's standard sizes: edges ~1.6x nodes (5k -> 8k per the plan). */
export function edgesForNodes(n: number): number {
  return Math.round(n * 1.6);
}
