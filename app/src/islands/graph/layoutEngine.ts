/**
 * FE-4 layout engine — the pure d3-force core the module worker wraps
 * (layout.worker.ts is a thin message shell so THIS logic stays unit-testable
 * in Node; the worker round-trip itself is covered by the Playwright suite).
 *
 * Force set = the spike-B-measured FE-4-representative configuration
 * (docs/spikes/spike-b-graph-perf.md): forceLink distance 30 · manyBody
 * strength −30 with Barnes-Hut θ 0.9 · weak x/y centering. The simulation is
 * driven MANUALLY (`.stop()` + explicit ticks) so epoch pacing is owned by
 * the caller.
 *
 * Frozen behaviors:
 *   - `reheat` CLAMPS alphaTarget to [0, {@link GENTLE_ALPHA_TARGET}] — the
 *     "gentle, not alpha(1)" rule; plan §9.2 FE-4 edge row asserts the bound.
 *   - incremental adds preserve node object identity (positions survive;
 *     d3's documented `simulation.nodes()` re-init contract).
 *   - `fillEpoch` writes `[x0, y0, …]` on the dense node-index axis.
 */

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

/** The gentle-reheat ceiling (blueprint §8; spike-B steady state). */
export const GENTLE_ALPHA_TARGET = 0.3;

/** Convergence floor (d3 default) — below this with target 0, we are settled. */
export const ALPHA_MIN = 0.001;

interface EngineNode extends SimulationNodeDatum {
  index: number;
}

type EngineLink = SimulationLinkDatum<EngineNode>;

export interface LayoutEngine {
  readonly nodeCount: number;
  /** Current simulation alpha. */
  alpha(): number;
  /** Current alphaTarget (post-clamp). */
  alphaTarget(): number;
  /** True while ticking still moves the layout (hot or reheated). */
  isHot(): boolean;
  /**
   * Append nodes/edges. `positions` is `[x0, y0, …]` (2 × count floats —
   * spawn-at-referrer coordinates); `edges` is `[s0, t0, …]` GLOBAL indexes.
   */
  add(count: number, positions: Float32Array, edges: Uint32Array): void;
  /** Clamped gentle reheat; returns the applied (clamped) target. */
  reheat(target?: number): number;
  /** alphaTarget back to 0 — the post-batch decay. */
  cooldown(): void;
  /** One simulation step. Returns alpha after the tick. */
  tick(): number;
  /** Run to convergence (reduced-motion path), bounded by `maxTicks`. */
  settle(maxTicks?: number): void;
  pin(index: number, x: number, y: number): void;
  unpin(index: number): void;
  /** Fill (and return) a Float32Array epoch over `buf`. */
  fillEpoch(buf: ArrayBuffer): Float32Array;
}

export function createLayoutEngine(): LayoutEngine {
  const nodes: EngineNode[] = [];
  const links: EngineLink[] = [];

  const linkForce = forceLink<EngineNode, EngineLink>(links).distance(30).iterations(1);
  const sim: Simulation<EngineNode, EngineLink> = forceSimulation<EngineNode>(nodes)
    .force('link', linkForce)
    .force('charge', forceManyBody<EngineNode>().strength(-30).theta(0.9))
    .force('x', forceX<EngineNode>(0).strength(0.05))
    .force('y', forceY<EngineNode>(0).strength(0.05))
    .alphaMin(ALPHA_MIN)
    .stop(); // ticks are driven manually

  const clamp = (target: number): number =>
    Math.min(GENTLE_ALPHA_TARGET, Math.max(0, target));

  return {
    get nodeCount(): number {
      return nodes.length;
    },

    alpha: () => sim.alpha(),
    alphaTarget: () => sim.alphaTarget(),

    isHot(): boolean {
      return sim.alpha() >= ALPHA_MIN || sim.alphaTarget() > 0;
    },

    add(count: number, positions: Float32Array, edges: Uint32Array): void {
      if (positions.length < 2 * count) {
        throw new Error(`add: positions length ${positions.length} < 2×${count}`);
      }
      const base = nodes.length;
      for (let i = 0; i < count; i++) {
        nodes.push({
          index: base + i,
          x: positions[2 * i] ?? 0,
          y: positions[2 * i + 1] ?? 0,
        });
      }
      for (let k = 0; k + 1 < edges.length; k += 2) {
        const s = edges[k] as number;
        const t = edges[k + 1] as number;
        if (s >= nodes.length || t >= nodes.length) {
          throw new Error(`add: edge index out of range (${s},${t}) for n=${nodes.length}`);
        }
        links.push({ source: s, target: t });
      }
      // The documented d3 re-init contract: object identity preserved,
      // existing positions survive, new nodes initialize where we spawned
      // them (never phyllotaxis-flung — x/y are pre-set).
      sim.nodes(nodes);
      linkForce.links(links);
    },

    reheat(target = GENTLE_ALPHA_TARGET): number {
      const applied = clamp(target);
      sim.alphaTarget(applied);
      // Alpha may have decayed to ~0; nudge it up to the target so ticking
      // resumes motion without the explosive alpha(1) restart.
      if (sim.alpha() < applied) sim.alpha(applied);
      return applied;
    },

    cooldown(): void {
      sim.alphaTarget(0);
    },

    tick(): number {
      sim.tick();
      return sim.alpha();
    },

    settle(maxTicks = 300): void {
      sim.alphaTarget(0);
      let ticks = 0;
      while (sim.alpha() >= ALPHA_MIN && ticks < maxTicks) {
        sim.tick();
        ticks += 1;
      }
    },

    pin(index: number, x: number, y: number): void {
      const node = nodes[index];
      if (node === undefined) return;
      node.fx = x;
      node.fy = y;
    },

    unpin(index: number): void {
      const node = nodes[index];
      if (node === undefined) return;
      delete node.fx;
      delete node.fy;
    },

    fillEpoch(buf: ArrayBuffer): Float32Array {
      const out = new Float32Array(buf);
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i] as EngineNode;
        out[2 * i] = node.x ?? 0;
        out[2 * i + 1] = node.y ?? 0;
      }
      return out;
    },
  };
}
