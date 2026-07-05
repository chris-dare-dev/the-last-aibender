/**
 * FE-4 GraphRenderer implementation — PixiJS v8 on WebGL2, `antialias: false`
 * (normative — blueprint §8, pixi #10413, spike-B lock #3).
 *
 * Scene shape matches the spike-B soak exactly (its numbers transfer):
 * one shared generated texture per node KIND, tinted sprites, and ONE
 * `Graphics` for the whole edge set, fully cleared and re-stroked every
 * frame with HAIRLINE strokes (`pixelLine: true` — spike-B lock #4).
 *
 * Motion grammar (DESIGN.md §3.2, §3.5 — colors/durations token-fed via
 * {@link GraphTokenTheme}, hex never enters this file):
 *  - node ENTER = phosphor routine update: snap to bright ink, hold 80 ms,
 *    decay to the resting kind ink (color/opacity only, never size);
 *  - PULSE (re-touch) = attention: amber + halo on the actively-touched
 *    artifact ONLY, same phosphor envelope;
 *  - edge enter = parametric draw 0→1 (the stroke-dashoffset equivalent);
 *  - REDUCED MOTION: entries render settled, the pulse is a discrete static
 *    amber tick removed in one step, nothing tweens.
 *
 * The renderer INTERPOLATES between layout epochs (spike-B lock #5): the sim
 * tick rate floats freely; frame rate never couples to it. Labels are
 * deliberately deferred (findings open question 6 — label LOD strategy needs
 * its own spike; the store already carries them).
 */

import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import type { GraphTokenTheme } from './theme.ts';
import { percentile } from './types.ts';
import type {
  CameraPose,
  GraphMutationBatch,
  GraphNodeKind,
  GraphRenderStats,
  GraphRenderer,
  GraphViewFilters,
  PositionEpoch,
} from './types.ts';

/** §3.2 hold phase (attack 0 ms → hold 80 ms → token-fed decay). */
export const PHOSPHOR_HOLD_MS = 80;
/** Reduced-motion pulse: static amber tick lifetime, removed in one step. */
export const REDUCED_PULSE_HOLD_MS = 2000;
/** Edge parametric draw window (mechanical band). */
export const EDGE_DRAW_MS = 150;
/** Cluster-dim floor for out-of-focus content (opacity only). */
export const DIM_ALPHA = 0.15;

const KIND_RADIUS: Record<GraphNodeKind, number> = {
  session: 5,
  'claude-md': 4,
  memory: 3.5,
  'agent-artifact': 3.5,
  reference: 3,
};

interface NodeVisual {
  sprite: Sprite;
  halo: Sprite;
  kind: GraphNodeKind;
  cluster: string;
  restingTint: number | undefined;
}

interface PhosphorEntry {
  index: number;
  startedAt: number;
  /** Bright phase color (amber for pulses, primary ink for enters). */
  bright: number | undefined;
  withHalo: boolean;
}

interface EdgeEntry {
  sourceIndex: number;
  targetIndex: number;
  /** performance.now() at arrival — drives the parametric draw. */
  enteredAt: number;
}

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

export interface PixiGraphRendererOptions {
  theme: GraphTokenTheme;
  /** Fixed canvas size (defaults to the host element's box). */
  width?: number;
  height?: number;
  /** Clock (tests pin it). */
  now?: () => number;
}

/**
 * Test-only visibility into the Pixi scene (the Playwright suite asserts
 * layer-toggle/cluster-dim/pulse EFFECTS, not just store state). NOT part of
 * the {@link GraphRenderer} port — swappable renderers never implement it.
 */
export interface PixiRendererDebugProbe {
  nodeAlpha(index: number): number | undefined;
  nodeVisible(index: number): boolean | undefined;
  nodeTint(index: number): number | undefined;
  haloAlpha(index: number): number | undefined;
  restingTint(index: number): number | undefined;
  /** Live sprite count in the node layer (halo culling assertable). */
  renderedNodeChildren(): number;
  /** Total frames the render loop has run (ticker liveness assertable). */
  framesSeen(): number;
}

export type PixiGraphRenderer = GraphRenderer & { readonly debug: PixiRendererDebugProbe };

export function createPixiGraphRenderer(options: PixiGraphRendererOptions): PixiGraphRenderer {
  const theme = options.theme;
  const now = options.now ?? (() => performance.now());

  const app = new Application();
  let ready = false;
  let disposed = false;
  const backlog: Array<() => void> = [];

  const world = new Container();
  const edgeGfx = new Graphics();
  const nodeLayer = new Container();
  world.addChild(edgeGfx);
  world.addChild(nodeLayer);

  const textures = new Map<GraphNodeKind, Texture>();
  let haloTexture: Texture | undefined;

  const visuals: NodeVisual[] = [];
  const edges: EdgeEntry[] = [];
  const phosphor: PhosphorEntry[] = [];

  /**
   * §3.2 attack semantics: a re-trigger RESTARTS the envelope — the newest
   * entry for a node supersedes any active one (at most one entry per node,
   * so an in-flight enter decay can never overwrite a fresh amber pulse).
   */
  const pushPhosphor = (entry: PhosphorEntry): void => {
    for (let k = phosphor.length - 1; k >= 0; k--) {
      const old = phosphor[k] as PhosphorEntry;
      if (old.index !== entry.index) continue;
      if (old.withHalo) {
        const v = visuals[old.index];
        if (v !== undefined) v.halo.alpha = 0; // new entry re-raises if pulsing
      }
      phosphor.splice(k, 1);
    }
    phosphor.push(entry);
  };

  let reducedMotion = theme.reducedMotion;
  let filters: GraphViewFilters = {
    visibleKinds: new Set<GraphNodeKind>(['session', 'claude-md', 'memory', 'agent-artifact', 'reference']),
    focusedCluster: undefined,
  };

  // --- position interpolation (between epochs) -------------------------------
  // Explicit `Float32Array` (= `<ArrayBufferLike>`) annotations: epoch views
  // arrive over transferred buffers, so the initializer's inferred
  // `Float32Array<ArrayBuffer>` would reject `epoch.positions` assignments.
  let shown: Float32Array = new Float32Array(0);
  let prev: Float32Array = new Float32Array(0);
  let curr: Float32Array = new Float32Array(0);
  let currAt = 0;
  let epochIntervalMs = 33;
  let epochsApplied = 0;

  // --- camera ----------------------------------------------------------------
  let pose: CameraPose = { x: 0, y: 0, scale: 1 };
  let viewW = options.width ?? 0;
  let viewH = options.height ?? 0;

  const applyCameraTransform = (): void => {
    world.scale.set(pose.scale);
    world.position.set(viewW / 2 - pose.x * pose.scale, viewH / 2 - pose.y * pose.scale);
  };

  // --- stats -----------------------------------------------------------------
  let measuring = false;
  let statsStart = 0;
  let lastFrameAt = 0;
  let frameSamples: number[] = [];
  let framesSeen = 0;

  // --- per-frame work ---------------------------------------------------------
  const restingAlphaOf = (visual: NodeVisual): number => {
    if (!filters.visibleKinds.has(visual.kind)) return 0;
    if (filters.focusedCluster !== undefined && visual.cluster !== filters.focusedCluster) {
      return DIM_ALPHA;
    }
    return 1;
  };

  const nodeVisibleAt = (index: number): boolean => {
    const v = visuals[index];
    if (v === undefined) return false;
    return filters.visibleKinds.has(v.kind);
  };

  const edgeAlphaOf = (edge: EdgeEntry): number => {
    const s = visuals[edge.sourceIndex];
    const t = visuals[edge.targetIndex];
    if (s === undefined || t === undefined) return 0;
    if (!filters.visibleKinds.has(s.kind) || !filters.visibleKinds.has(t.kind)) return 0;
    const dimmed =
      filters.focusedCluster !== undefined &&
      s.cluster !== filters.focusedCluster &&
      t.cluster !== filters.focusedCluster;
    return dimmed ? DIM_ALPHA * 0.55 : 0.55;
  };

  const positionAt = (index: number): { x: number; y: number } | undefined => {
    const v = visuals[index];
    if (v === undefined) return undefined;
    return { x: v.sprite.x, y: v.sprite.y };
  };

  const frame = (): void => {
    const t = now();
    framesSeen += 1;

    // 1. interpolate positions between epochs (never wait for the sim).
    if (curr.length > 0) {
      const progress = Math.min(1, (t - currAt) / epochIntervalMs);
      const n = Math.min(visuals.length, curr.length >> 1);
      for (let i = 0; i < n; i++) {
        const cx = curr[2 * i] ?? 0;
        const cy = curr[2 * i + 1] ?? 0;
        const hasPrev = 2 * i + 1 < prev.length;
        const px = hasPrev ? (prev[2 * i] ?? cx) : cx;
        const py = hasPrev ? (prev[2 * i + 1] ?? cy) : cy;
        const x = px + (cx - px) * progress;
        const y = py + (cy - py) * progress;
        shown[2 * i] = x;
        shown[2 * i + 1] = y;
        const v = visuals[i];
        if (v !== undefined) {
          v.sprite.x = x;
          v.sprite.y = y;
          v.halo.x = x;
          v.halo.y = y;
        }
      }
    }

    // 2. phosphor decay (color/opacity only — §3.2).
    for (let k = phosphor.length - 1; k >= 0; k--) {
      const entry = phosphor[k] as PhosphorEntry;
      const v = visuals[entry.index];
      if (v === undefined) {
        phosphor.splice(k, 1);
        continue;
      }
      const age = t - entry.startedAt;
      if (reducedMotion) {
        // Discrete: static amber tick, removed in ONE step (§3.5).
        if (age >= REDUCED_PULSE_HOLD_MS) {
          if (v.restingTint !== undefined) v.sprite.tint = v.restingTint;
          v.halo.alpha = 0;
          phosphor.splice(k, 1);
        } else if (entry.bright !== undefined) {
          v.sprite.tint = entry.bright;
          if (entry.withHalo && haloTexture !== undefined) {
            v.halo.alpha = theme.accentHalo?.alpha ?? 0;
          }
        }
        continue;
      }
      const decayMs = Math.max(1, theme.phosphorDecayMs);
      if (age <= PHOSPHOR_HOLD_MS) {
        if (entry.bright !== undefined) v.sprite.tint = entry.bright;
        if (entry.withHalo) v.halo.alpha = theme.accentHalo?.alpha ?? 0;
      } else if (age <= PHOSPHOR_HOLD_MS + decayMs) {
        const dt = (age - PHOSPHOR_HOLD_MS) / decayMs;
        // Steep initial luminance drop, long faint tail (ease-decay shape).
        const eased = 1 - Math.pow(1 - dt, 3);
        if (entry.bright !== undefined && v.restingTint !== undefined) {
          v.sprite.tint = lerpColor(entry.bright, v.restingTint, eased);
        }
        if (entry.withHalo) v.halo.alpha = (theme.accentHalo?.alpha ?? 0) * (1 - eased);
      } else {
        if (v.restingTint !== undefined) v.sprite.tint = v.restingTint;
        v.halo.alpha = 0;
        phosphor.splice(k, 1);
      }
    }

    // 3. filters → resting alpha (visibility snaps; dim is opacity-only).
    for (let i = 0; i < visuals.length; i++) {
      const v = visuals[i] as NodeVisual;
      const alpha = restingAlphaOf(v);
      v.sprite.visible = alpha > 0;
      v.sprite.alpha = alpha;
      // Halos leave the render set whenever they carry no pulse — at the 5k
      // ceiling an always-visible alpha-0 halo per node would double the
      // sprite set for nothing.
      v.halo.visible = v.halo.alpha > 0 && v.sprite.visible;
    }

    // 4. rebuild the edge set (hairline pixelLine — the spike-B regime).
    edgeGfx.clear();
    const hairline = theme.hairline;
    let strokeAlphaAccum: number | undefined;
    // Group by alpha class to respect per-edge dim without per-edge strokes:
    // two passes — normal then dimmed — keeps stroke() calls at 2/frame.
    for (const pass of [0, 1] as const) {
      let any = false;
      for (const edge of edges) {
        const alpha = edgeAlphaOf(edge);
        if (alpha <= 0) continue;
        const dimmedPass = alpha < 0.5 ? 1 : 0;
        if (dimmedPass !== pass) continue;
        if (!nodeVisibleAt(edge.sourceIndex) || !nodeVisibleAt(edge.targetIndex)) continue;
        const sx = shown[2 * edge.sourceIndex] ?? 0;
        const sy = shown[2 * edge.sourceIndex + 1] ?? 0;
        const tx = shown[2 * edge.targetIndex] ?? 0;
        const ty = shown[2 * edge.targetIndex + 1] ?? 0;
        let ex = tx;
        let ey = ty;
        if (!reducedMotion) {
          const drawAge = t - edge.enteredAt;
          if (drawAge < EDGE_DRAW_MS) {
            const p = drawAge / EDGE_DRAW_MS;
            ex = sx + (tx - sx) * p;
            ey = sy + (ty - sy) * p;
          }
        }
        edgeGfx.moveTo(sx, sy).lineTo(ex, ey);
        any = true;
        strokeAlphaAccum = pass === 0 ? 0.55 : DIM_ALPHA * 0.55;
      }
      if (any) {
        edgeGfx.stroke({
          width: 1,
          ...(hairline !== undefined ? { color: hairline } : {}),
          alpha: strokeAlphaAccum ?? 0.55,
          pixelLine: true,
        });
      }
    }

    // 5. stats.
    if (measuring) {
      if (lastFrameAt > 0) frameSamples.push(t - lastFrameAt);
      lastFrameAt = t;
    }
  };

  // --- contract --------------------------------------------------------------
  const runOrQueue = (fn: () => void): void => {
    if (disposed) return;
    if (ready) fn();
    else backlog.push(fn);
  };

  const makeTexture = (kind: GraphNodeKind): Texture => {
    const r = KIND_RADIUS[kind];
    const gfx = new Graphics();
    switch (kind) {
      case 'session':
        gfx.circle(0, 0, r).fill(0xffffff);
        break;
      case 'claude-md':
        // Diamond — instructions read as a distinct machined glyph.
        gfx.poly([0, -r, r, 0, 0, r, -r, 0]).fill(0xffffff);
        break;
      case 'memory':
        // Ring (annulus) — retained context.
        gfx.circle(0, 0, r).stroke({ width: 1.5, color: 0xffffff });
        break;
      case 'agent-artifact':
        gfx.rect(-r * 0.9, -r * 0.9, r * 1.8, r * 1.8).fill(0xffffff);
        break;
      case 'reference':
        gfx.circle(0, 0, r).fill(0xffffff);
        break;
      default:
        gfx.circle(0, 0, r).fill(0xffffff);
        break;
    }
    return app.renderer.generateTexture({ target: gfx, resolution: 2 });
  };

  const restingTintOf = (kind: GraphNodeKind): number | undefined => {
    // Sessions carry primary ink (the anchors); artifacts carry secondary;
    // references sit at muted. Kind identity is SHAPE-first (glyphs above) —
    // color stays in the ink scale, amber stays signal-only (§2.3).
    switch (kind) {
      case 'session':
        return theme.inkPrimary;
      case 'claude-md':
      case 'memory':
      case 'agent-artifact':
        return theme.inkSecondary;
      case 'reference':
        return theme.inkMuted;
      default:
        return theme.inkMuted;
    }
  };

  const debug: PixiRendererDebugProbe = {
    nodeAlpha: (index) => visuals[index]?.sprite.alpha,
    nodeVisible: (index) => visuals[index]?.sprite.visible,
    nodeTint: (index) => visuals[index]?.sprite.tint,
    haloAlpha: (index) => visuals[index]?.halo.alpha,
    restingTint: (index) => visuals[index]?.restingTint,
    renderedNodeChildren: () =>
      nodeLayer.children.reduce((acc, child) => acc + (child.visible ? 1 : 0), 0),
    framesSeen: () => framesSeen,
  };

  return {
    debug,

    async init(host: HTMLElement): Promise<void> {
      if (ready || disposed) return;
      viewW = options.width ?? Math.max(1, host.clientWidth);
      viewH = options.height ?? Math.max(1, host.clientHeight);
      const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
      await app.init({
        width: viewW,
        height: viewH,
        antialias: false, // normative OFF (blueprint §8; spike-B lock #3)
        preference: 'webgl',
        resolution: dpr,
        autoDensity: true,
        ...(theme.background !== undefined ? { background: theme.background } : {}),
      });
      if (disposed) {
        app.destroy(true);
        return;
      }
      host.appendChild(app.canvas);
      app.stage.addChild(world);
      for (const kind of Object.keys(KIND_RADIUS) as GraphNodeKind[]) {
        textures.set(kind, makeTexture(kind));
      }
      const haloGfx = new Graphics().circle(0, 0, 10).fill(0xffffff);
      haloTexture = app.renderer.generateTexture({ target: haloGfx, resolution: 2 });
      applyCameraTransform();
      app.ticker.add(frame);
      ready = true;
      const queued = backlog.splice(0, backlog.length);
      for (const fn of queued) fn();
    },

    applyBatch(batch: GraphMutationBatch): void {
      runOrQueue(() => {
        if (2 * batch.nodeCount > shown.length) {
          const grown = new Float32Array(2 * Math.max(batch.nodeCount, 16));
          grown.set(shown);
          shown = grown;
        }
        const t = now();
        for (const node of batch.addedNodes) {
          const texture = textures.get(node.kind);
          const sprite = new Sprite(texture ?? Texture.WHITE);
          sprite.anchor.set(0.5);
          const resting = restingTintOf(node.kind);
          if (resting !== undefined) sprite.tint = resting;
          sprite.x = node.spawnX;
          sprite.y = node.spawnY;
          shown[2 * node.index] = node.spawnX;
          shown[2 * node.index + 1] = node.spawnY;

          const halo = new Sprite(haloTexture ?? Texture.WHITE);
          halo.anchor.set(0.5);
          if (theme.accent !== undefined) halo.tint = theme.accent;
          halo.alpha = 0;
          halo.visible = false; // enters the render set only while pulsing
          halo.x = node.spawnX;
          halo.y = node.spawnY;

          nodeLayer.addChild(halo);
          nodeLayer.addChild(sprite);
          visuals[node.index] = {
            sprite,
            halo,
            kind: node.kind,
            cluster: node.cluster,
            restingTint: resting,
          };
          if (!reducedMotion) {
            // Enter = routine phosphor: bright primary ink → resting.
            pushPhosphor({
              index: node.index,
              startedAt: t,
              bright: theme.inkPrimary,
              withHalo: false,
            });
          }
        }
        for (const record of batch.retagged) {
          const v = visuals[record.index];
          if (v === undefined) continue;
          v.kind = record.kind;
          const texture = textures.get(record.kind);
          if (texture !== undefined) v.sprite.texture = texture;
          v.restingTint = restingTintOf(record.kind);
          if (v.restingTint !== undefined) v.sprite.tint = v.restingTint;
        }
        for (const edge of batch.addedEdges) {
          edges.push({
            sourceIndex: edge.sourceIndex,
            targetIndex: edge.targetIndex,
            enteredAt: t,
          });
        }
        // AMBER on the actively-touched artifact ONLY (§2.3: the halo's one
        // sanctioned graph use).
        for (const index of batch.pulses) {
          if (visuals[index] === undefined) continue;
          pushPhosphor({ index, startedAt: t, bright: theme.accent, withHalo: true });
        }
      });
    },

    applyPositions(epoch: PositionEpoch): void {
      runOrQueue(() => {
        const t = now();
        if (currAt > 0) {
          epochIntervalMs = Math.min(250, Math.max(16, t - currAt));
        }
        // Interpolate FROM what is on screen TO the new epoch.
        if (shown.length < curr.length) {
          const grown = new Float32Array(curr.length);
          grown.set(shown);
          shown = grown;
        }
        prev = shown.slice(0, epoch.positions.length);
        curr = epoch.positions;
        currAt = t;
        epochsApplied += 1;
        if (2 * epoch.nodeCount > shown.length) {
          const grown = new Float32Array(2 * epoch.nodeCount);
          grown.set(shown);
          shown = grown;
        }
      });
    },

    applyFilters(next: GraphViewFilters): void {
      filters = {
        visibleKinds: new Set(next.visibleKinds),
        focusedCluster: next.focusedCluster,
      };
    },

    setCamera(next: CameraPose): void {
      pose = next;
      if (ready) applyCameraTransform();
    },

    get camera(): CameraPose {
      return pose;
    },

    setReducedMotion(reduced: boolean): void {
      reducedMotion = reduced;
    },

    positionOf(index: number): { x: number; y: number } | undefined {
      return positionAt(index);
    },

    beginStats(): void {
      measuring = true;
      statsStart = now();
      lastFrameAt = 0;
      frameSamples = [];
    },

    readStats(): GraphRenderStats {
      const seconds = Math.max(1e-6, (now() - statsStart) / 1000);
      const sorted = [...frameSamples].sort((a, b) => a - b);
      const mean =
        frameSamples.length === 0
          ? 0
          : frameSamples.reduce((acc, v) => acc + v, 0) / frameSamples.length;
      return {
        frames: frameSamples.length,
        seconds,
        fps: frameSamples.length / seconds,
        frameMsMean: mean,
        frameMsP95: percentile(sorted, 95),
        pctOver16_7:
          frameSamples.length === 0
            ? 0
            : (frameSamples.filter((v) => v > 16.7).length / frameSamples.length) * 100,
        pctOver33_3:
          frameSamples.length === 0
            ? 0
            : (frameSamples.filter((v) => v > 33.4).length / frameSamples.length) * 100,
        epochsApplied,
      };
    },

    resize(width: number, height: number): void {
      viewW = width;
      viewH = height;
      if (ready) {
        app.renderer.resize(width, height);
        applyCameraTransform();
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      backlog.length = 0;
      if (ready) {
        app.ticker.remove(frame);
        app.destroy(true);
      }
      ready = false;
    },
  };
}
