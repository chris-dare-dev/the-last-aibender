/**
 * Spike B / plan spike (ii): Pixi v8 node-graph render soak (browser side).
 *
 * Renders n sprites (shared circle texture, per-node tint/scale) + e line
 * edges (single Graphics, fully re-stroked every frame) with
 * `antialias: false` on WebGL — the FE-4 renderer shape. Every node moves
 * every frame (deterministic sin/cos drift), so the sprite transforms AND
 * the whole edge path re-tessellate each frame: the worst-case "layout
 * still hot" regime.
 *
 * Two measurement phases:
 *   1. rAF ticker (vsync-paced where the host has vsync)
 *   2. unthrottled back-to-back app.render() calls — CPU-side ceiling;
 *      on a software rasterizer (SwiftShader) this includes raster cost,
 *      on real hardware GPU-side cost is NOT captured (disclosed).
 *
 * Query params: ?n=5000&e=8000&seed=42
 * Results land on window.__RESULT__ (or window.__ERROR__).
 */

import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { buildContextGraph } from '../src/synth-graph.ts';
import { summarize, type Summary } from '../src/stats.ts';

interface PhaseResult {
  frames: number;
  seconds: number;
  fps: number;
  frameMs: Summary;
  pctOver16_7: number;
  pctOver33_3: number;
}

declare global {
  interface Window {
    __RESULT__?: unknown;
    __ERROR__?: string;
  }
}

const CLUSTER_TINTS = [
  0x7aa2f7, 0x9ece6a, 0xe0af68, 0xf7768e, 0xbb9af7, 0x7dcfff, 0x73daca, 0xff9e64,
];

function phase(samples: number[], seconds: number): PhaseResult {
  const s = summarize(samples);
  return {
    frames: samples.length,
    seconds,
    fps: samples.length / seconds,
    frameMs: s,
    pctOver16_7: (samples.filter((v) => v > 16.7).length / samples.length) * 100,
    pctOver33_3: (samples.filter((v) => v > 33.4).length / samples.length) * 100,
  };
}

async function main() {
  const params = new URLSearchParams(location.search);
  const n = Number(params.get('n') ?? 5000);
  const e = Number(params.get('e') ?? Math.round(n * 1.6));
  const seed = Number(params.get('seed') ?? 42);
  // pixelLine=1 -> native GL 1px lines (the Obsidian-style hairline edge);
  // pixelLine=0 -> default tessellated stroke (worst case).
  const pixelLine = (params.get('pixelLine') ?? '1') !== '0';
  const warmupMs = Number(params.get('warmupMs') ?? 1500);
  const measureMs = Number(params.get('measureMs') ?? 8000);
  const unthrottledFrames = Number(params.get('unthrottledFrames') ?? 300);

  const app = new Application();
  await app.init({
    width: 1600,
    height: 1000,
    antialias: false, // pixi #10413 footgun — normative OFF per blueprint §8
    preference: 'webgl',
    autoDensity: false,
    resolution: 1,
    background: 0x0b0e14,
  });
  document.body.appendChild(app.canvas);

  // Renderer identity — critical for proxy honesty (SwiftShader vs Metal).
  const gl = (app.renderer as any).gl as WebGL2RenderingContext | undefined;
  let vendor = 'n/a';
  let rendererStr = 'n/a';
  let glVersion = 'n/a';
  if (gl) {
    glVersion = String(gl.getParameter(gl.VERSION));
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) {
      vendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL));
      rendererStr = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
    }
  }

  // --- scene ---
  const { data } = buildContextGraph(n, e, seed);
  const world = new Container();
  app.stage.addChild(world);
  world.position.set(800, 500);

  const edgeGfx = new Graphics();
  world.addChild(edgeGfx);

  const circle = new Graphics().circle(0, 0, 4).fill(0xffffff);
  const circleTex: Texture = app.renderer.generateTexture({
    target: circle,
    resolution: 2,
  });

  const sprites: Sprite[] = new Array(n);
  const nodeLayer = new Container();
  world.addChild(nodeLayer);
  for (let i = 0; i < n; i++) {
    const s = new Sprite(circleTex);
    s.anchor.set(0.5);
    s.tint = CLUSTER_TINTS[data.cluster[i] % CLUSTER_TINTS.length];
    s.scale.set(0.75 + (i % 5) * 0.125);
    sprites[i] = s;
    nodeLayer.addChild(s);
  }

  // Deterministic per-node drift (cheap, but every position changes every
  // frame so edge path + sprite transforms fully refresh).
  const phaseArr = new Float32Array(n);
  for (let i = 0; i < n; i++) phaseArr[i] = (i * 2399) % 6283 / 1000;
  const px = new Float32Array(n);
  const py = new Float32Array(n);

  function updatePositions(tMs: number) {
    const t = tMs / 1000;
    for (let i = 0; i < n; i++) {
      const bx = data.positions[2 * i];
      const by = data.positions[2 * i + 1];
      px[i] = bx + Math.sin(t * 1.7 + phaseArr[i]) * 6;
      py[i] = by + Math.cos(t * 1.3 + phaseArr[i]) * 6;
      const s = sprites[i];
      s.x = px[i];
      s.y = py[i];
    }
    edgeGfx.clear();
    for (let k = 0; k < e; k++) {
      const a = data.edges[2 * k];
      const b = data.edges[2 * k + 1];
      edgeGfx.moveTo(px[a], py[a]).lineTo(px[b], py[b]);
    }
    edgeGfx.stroke({ width: 1, color: 0x334155, alpha: 0.55, pixelLine });
  }

  // --- phase 1: rAF ticker ---
  const rafSamples: number[] = [];
  const rafResult = await new Promise<PhaseResult>((resolve) => {
    let last = performance.now();
    const start = last;
    let measuring = false;
    let measureStart = 0;
    const onTick = () => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      updatePositions(now);
      if (!measuring && now - start >= warmupMs) {
        measuring = true;
        measureStart = now;
        return;
      }
      if (measuring) {
        rafSamples.push(dt);
        if (now - measureStart >= measureMs) {
          app.ticker.remove(onTick);
          resolve(phase(rafSamples, (now - measureStart) / 1000));
        }
      }
    };
    app.ticker.add(onTick);
  });

  // --- phase 2: unthrottled manual render ---
  app.ticker.stop();
  const unSamples: number[] = [];
  let t = performance.now();
  const unStart = t;
  for (let f = 0; f < unthrottledFrames; f++) {
    updatePositions(t);
    app.render();
    const now = performance.now();
    unSamples.push(now - t);
    t = now;
  }
  if (gl) gl.finish(); // drain the GL queue so the last frames aren't unpaid
  const unSeconds = (performance.now() - unStart) / 1000;
  const unResult = phase(unSamples, unSeconds);

  window.__RESULT__ = {
    n,
    e,
    pixelLine,
    renderer: {
      pixi: app.renderer.name,
      glVersion,
      vendor,
      renderer: rendererStr,
      devicePixelRatio: window.devicePixelRatio,
      canvas: { width: 1600, height: 1000 },
      antialias: false,
    },
    raf: rafResult,
    unthrottled: unResult,
  };
}

main().catch((err) => {
  window.__ERROR__ = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
});
