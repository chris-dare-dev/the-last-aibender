/**
 * SPIKE-A in-page harness (QUARANTINED — plan spikes i + iv).
 *
 * Runs inside Playwright WebKit (WKWebView proxy). Exposes `window.__spike`
 * with phase functions the runner drives via page.evaluate():
 *
 *   boot()        -> renderer selection result (WebGL addon try -> DOM fallback)
 *   writeBulk()   -> 100k-line bulk write throughput + rAF frame stats
 *   writePaced()  -> paced streaming write (per-frame chunks) fps proxy
 *   probeWebGPU() -> navigator.gpu presence + requestAdapter() result
 *   webglInfo()   -> raw WebGL2 context availability + (un)masked strings
 *   snapshot()    -> current renderer/context-loss state
 *
 * All terminal content is SYNTHESIZED (lorem-style + ANSI SGR noise).
 * Nothing here may be imported by prod code; FE-3 reimplements the
 * detection contract described in docs/spikes/spike-a-webview-render.md.
 */

import { Terminal } from '/node_modules/@xterm/xterm/lib/xterm.mjs';
import { WebglAddon } from '/node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs';
import { FitAddon } from '/node_modules/@xterm/addon-fit/lib/addon-fit.mjs';

const state = {
  term: null,
  webgl: null,
  fit: null,
  rendererMode: 'none', // 'webgl' | 'dom' | 'none'
  webglLoadError: null,
  contextLossCount: 0,
  contextLossEvents: [],
  errors: [],
};

window.addEventListener('error', (e) => {
  state.errors.push(String(e.message));
});
window.addEventListener('unhandledrejection', (e) => {
  state.errors.push(`unhandledrejection: ${String(e.reason)}`);
});

/** Count canvas elements inside the terminal element (WebGL renderer signal). */
function canvasCount() {
  return state.term?.element ? state.term.element.querySelectorAll('canvas').length : -1;
}

/** DOM renderer signal: populated .xterm-rows children. */
function domRowsCount() {
  const rows = state.term?.element?.querySelector('.xterm-rows');
  return rows ? rows.childElementCount : -1;
}

function boot(opts = {}) {
  const { cols = 160, rows = 45, scrollback = 10_000, forceDom = false } = opts;
  const term = new Terminal({
    cols,
    rows,
    scrollback,
    allowTransparency: false,
    fontFamily: 'Menlo, monospace',
    fontSize: 13,
    theme: { background: '#111110', foreground: '#e8e6e1' },
  });
  state.term = term;
  term.open(document.getElementById('terminal'));
  state.fit = new FitAddon();
  term.loadAddon(state.fit);

  if (forceDom) {
    state.rendererMode = 'dom';
  } else {
    // The renderer-detection contract FE-3 must implement: try the WebGL
    // addon; any throw -> DOM renderer (xterm 6 default); context loss at
    // runtime -> dispose addon -> xterm falls back to DOM automatically.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss((ev) => {
        state.contextLossCount += 1;
        state.contextLossEvents.push({ t: performance.now(), type: String(ev?.type ?? 'unknown') });
        // Contract step: dispose on loss; xterm reverts to the DOM renderer.
        try {
          webgl.dispose();
        } catch (err) {
          state.errors.push(`webgl.dispose after loss: ${String(err)}`);
        }
        state.rendererMode = 'dom';
      });
      term.loadAddon(webgl);
      state.webgl = webgl;
      state.rendererMode = 'webgl';
    } catch (err) {
      state.webglLoadError = String(err && err.stack ? err.message : err);
      state.rendererMode = 'dom';
    }
  }

  // One synchronous smoke line so the renderer has painted something.
  term.write('spike-a boot \x1b[33mSYNTHETIC\x1b[0m data only [X2]\r\n');

  return snapshot();
}

function snapshot() {
  return {
    rendererMode: state.rendererMode,
    webglLoadError: state.webglLoadError,
    webglAddonLoaded: state.webgl != null,
    textureAtlasPresent: !!(state.webgl && state.webgl.textureAtlas),
    canvasCount: canvasCount(),
    domRowsCount: domRowsCount(),
    contextLossCount: state.contextLossCount,
    contextLossEvents: state.contextLossEvents,
    bufferLines: state.term ? state.term.buffer.active.length : -1,
    errors: state.errors,
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
  };
}

/** Deterministic synthetic line generator (~90 visible chars + SGR noise). */
function makeLine(i) {
  const colors = [31, 32, 33, 34, 35, 36, 37, 90, 92, 94];
  const c = colors[i % colors.length];
  const payload =
    `tok=${(i * 2654435761 % 0xffffffff).toString(16).padStart(8, '0')} ` +
    'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor';
  return `\x1b[${c}m[${String(i).padStart(6, '0')}]\x1b[0m \x1b[1mstream\x1b[22m ${payload}\r\n`;
}

/** rAF sampler: collects frame gaps while a workload runs. */
function startFrameSampler() {
  const gaps = [];
  let last = performance.now();
  let running = true;
  function tick(now) {
    gaps.push(now - last);
    last = now;
    if (running) requestAnimationFrame(tick);
  }
  requestAnimationFrame((now) => {
    last = now;
    requestAnimationFrame(tick);
  });
  return {
    stop() {
      running = false;
      const sorted = [...gaps].sort((a, b) => a - b);
      const sum = gaps.reduce((a, b) => a + b, 0);
      return {
        frames: gaps.length,
        meanGapMs: gaps.length ? sum / gaps.length : null,
        p95GapMs: sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : null,
        maxGapMs: sorted.length ? sorted[sorted.length - 1] : null,
      };
    },
  };
}

/**
 * Bulk throughput: write `totalLines` in `chunkLines` chunks back-to-back
 * (each chunk queued via term.write callback), then wait one rAF to let the
 * renderer settle. Measures parse+render throughput end to end.
 */
async function writeBulk(opts = {}) {
  const { totalLines = 100_000, chunkLines = 1_000 } = opts;
  const term = state.term;
  if (!term) throw new Error('boot() first');

  let bytes = 0;
  const sampler = startFrameSampler();
  const t0 = performance.now();
  let lineNo = 0;
  while (lineNo < totalLines) {
    const n = Math.min(chunkLines, totalLines - lineNo);
    let chunk = '';
    for (let i = 0; i < n; i++) chunk += makeLine(lineNo + i);
    bytes += chunk.length;
    const isLast = lineNo + n >= totalLines;
    if (isLast) {
      await new Promise((resolve) => term.write(chunk, resolve));
    } else {
      term.write(chunk);
    }
    lineNo += n;
  }
  const tParsed = performance.now();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const tSettled = performance.now();
  const frameStats = sampler.stop();

  const wallMs = tSettled - t0;
  return {
    totalLines,
    chunkLines,
    bytes,
    parseMs: tParsed - t0,
    settleMs: tSettled - tParsed,
    wallMs,
    linesPerSec: totalLines / (wallMs / 1000),
    mbPerSec: bytes / 1e6 / (wallMs / 1000),
    frameStats,
    post: snapshot(),
  };
}

/**
 * Paced streaming proxy: one chunk per animation frame for `frames` frames —
 * approximates a hot token stream feeding the terminal island. Reports the
 * achieved frame rate while the terminal keeps up.
 */
async function writePaced(opts = {}) {
  const { frames = 300, linesPerFrame = 40 } = opts;
  const term = state.term;
  if (!term) throw new Error('boot() first');

  const sampler = startFrameSampler();
  const t0 = performance.now();
  let lineNo = 0;
  for (let f = 0; f < frames; f++) {
    let chunk = '';
    for (let i = 0; i < linesPerFrame; i++) chunk += makeLine(lineNo + i);
    lineNo += linesPerFrame;
    term.write(chunk);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  await new Promise((resolve) => term.write('', resolve));
  const wallMs = performance.now() - t0;
  const frameStats = sampler.stop();
  return {
    frames,
    linesPerFrame,
    totalLines: lineNo,
    wallMs,
    achievedFps: frames / (wallMs / 1000),
    frameStats,
    post: snapshot(),
  };
}

/** Spike iv: navigator.gpu presence + adapter request (WKWebView proxy). */
async function probeWebGPU() {
  const result = {
    hasNavigatorGpu: 'gpu' in navigator,
    gpuObjectType: typeof navigator.gpu,
    adapterRequested: false,
    adapterPresent: false,
    adapterInfo: null,
    features: null,
    limitsSample: null,
    preferredCanvasFormat: null,
    deviceRequested: false,
    devicePresent: false,
    error: null,
  };
  if (!('gpu' in navigator) || !navigator.gpu) return result;
  try {
    result.preferredCanvasFormat = navigator.gpu.getPreferredCanvasFormat?.() ?? null;
    result.adapterRequested = true;
    const adapter = await navigator.gpu.requestAdapter();
    result.adapterPresent = adapter != null;
    if (adapter) {
      const info = adapter.info ?? {};
      result.adapterInfo = {
        vendor: info.vendor ?? null,
        architecture: info.architecture ?? null,
        device: info.device ?? null,
        description: info.description ?? null,
      };
      result.features = [...(adapter.features ?? [])].slice(0, 32);
      result.limitsSample = {
        maxTextureDimension2D: adapter.limits?.maxTextureDimension2D ?? null,
        maxBufferSize: Number(adapter.limits?.maxBufferSize ?? -1),
      };
      result.deviceRequested = true;
      const device = await adapter.requestDevice();
      result.devicePresent = device != null;
      device?.destroy?.();
    }
  } catch (err) {
    result.error = String(err);
  }
  return result;
}

/** Raw WebGL2 capability probe, independent of xterm. */
function webglInfo() {
  const out = { webgl2: false, webgl1: false, vendor: null, renderer: null, unmaskedVendor: null, unmaskedRenderer: null, contextAttributes: null };
  const canvas = document.createElement('canvas');
  const gl2 = canvas.getContext('webgl2');
  if (gl2) {
    out.webgl2 = true;
    out.vendor = gl2.getParameter(gl2.VENDOR);
    out.renderer = gl2.getParameter(gl2.RENDERER);
    const dbg = gl2.getExtension('WEBGL_debug_renderer_info');
    if (dbg) {
      out.unmaskedVendor = gl2.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
      out.unmaskedRenderer = gl2.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
    }
    out.contextAttributes = gl2.getContextAttributes();
  } else {
    out.webgl1 = !!document.createElement('canvas').getContext('webgl');
  }
  return out;
}

/**
 * Simulated context loss via WEBGL_lose_context.
 *
 * getContext('webgl2') on a canvas that already holds a webgl2 context
 * returns that EXISTING context (and null on a canvas holding a 2d context),
 * so losing on every canvas inside the terminal element guarantees the WebGL
 * addon's own context is hit — the addon's webglcontextlost listener then
 * fires onContextLoss, and our boot() handler disposes the addon (xterm
 * reverts to the DOM renderer).
 */
function simulateContextLoss() {
  const el = state.term?.element;
  if (!el) return { attempted: false, reason: 'no terminal' };
  const canvases = [...el.querySelectorAll('canvas')];
  const perCanvas = [];
  for (const c of canvases) {
    const gl = c.getContext('webgl2') ?? c.getContext('webgl');
    const ext = gl?.getExtension('WEBGL_lose_context');
    if (ext) {
      ext.loseContext();
      perCanvas.push({ class: c.className || '(none)', lost: true });
    } else {
      perCanvas.push({ class: c.className || '(none)', lost: false, reason: gl ? 'no WEBGL_lose_context' : 'no gl context' });
    }
  }
  return { attempted: perCanvas.some((p) => p.lost), perCanvas };
}

/** Read the text of the last non-empty buffer line (data-retention marker check). */
function readTail() {
  const buf = state.term?.buffer.active;
  if (!buf) return null;
  for (let i = buf.length - 1; i >= 0; i--) {
    const text = buf.getLine(i)?.translateToString(true).trim();
    if (text) return text;
  }
  return null;
}

/** Plain write with completion callback (used by the post-loss marker check). */
function writeText(text) {
  return new Promise((resolve) => state.term.write(text, resolve));
}

window.__spike = {
  ready: true,
  boot,
  snapshot,
  writeBulk,
  writePaced,
  probeWebGPU,
  webglInfo,
  simulateContextLoss,
  readTail,
  writeText,
};
