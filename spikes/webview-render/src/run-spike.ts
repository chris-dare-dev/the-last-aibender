/**
 * SPIKE-A runner (QUARANTINED — plan spikes i + iv, blueprint §13.5).
 *
 * Drives page/index.html in Playwright WebKit as the WKWebView proxy:
 *   run 1 (webgl):    boot -> 100k-line bulk write -> paced streaming ->
 *                     simulated context loss -> post-loss write (data kept?)
 *   run 2 (forceDom): boot DOM renderer -> same workloads (fallback floor)
 *   probes:           navigator.gpu / requestAdapter, raw WebGL2 info
 *
 * Honest-proxy note: Playwright WebKit is the same WebKit engine family that
 * backs WKWebView on this macOS, but it is NOT WKWebView-in-Tauri. The verdict
 * doc records what remains for T3 (live Tauri window) confirmation.
 *
 * Usage: pnpm spike [--headed] [--lines=100000]
 */

import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit, type Browser, type Page } from 'playwright';

const SPIKE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function startStaticServer(root: string): Promise<{ server: Server; port: number }> {
  const server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
      const rel = urlPath === '/' ? '/page/index.html' : urlPath;
      const abs = normalize(join(root, rel));
      if (!abs.startsWith(root)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const body = await readFile(abs);
      res.writeHead(200, { 'content-type': MIME[extname(abs)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolvePromise({ server, port });
    });
  });
}

interface PageLog {
  consoleErrors: string[];
  pageErrors: string[];
}

function attachLogs(page: Page): PageLog {
  const log: PageLog = { consoleErrors: [], pageErrors: [] };
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      log.consoleErrors.push(`[${msg.type()}] ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => log.pageErrors.push(String(err)));
  return log;
}

async function openHarness(browser: Browser, baseUrl: string): Promise<{ page: Page; log: PageLog }> {
  const page = await browser.newPage({ viewport: { width: 1366, height: 800 } });
  const log = attachLogs(page);
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => (window as any).__spike?.ready === true, undefined, { timeout: 15_000 });
  return { page, log };
}

async function runRendererWorkload(page: Page, opts: { forceDom: boolean; lines: number }) {
  const boot = await page.evaluate((forceDom) => (window as any).__spike.boot({ forceDom }), opts.forceDom);
  const bulk = await page.evaluate(
    (totalLines) => (window as any).__spike.writeBulk({ totalLines }),
    opts.lines,
  );
  const paced = await page.evaluate(() => (window as any).__spike.writePaced({ frames: 300, linesPerFrame: 40 }));
  return { boot, bulk, paced };
}

async function runContextLossProbe(page: Page) {
  const before = await page.evaluate(() => (window as any).__spike.snapshot());
  const trigger = await page.evaluate(() => (window as any).__spike.simulateContextLoss());
  // xterm 6's WebglAddon holds a 3000 ms restoration grace window after
  // `webglcontextlost` before firing onContextLoss (measured in the bundled
  // addon source: `setTimeout(..., 3e3)` + `preventDefault()`), so wait for
  // the handler rather than a fixed beat.
  let handlerFiredWithinGrace = true;
  await page
    .waitForFunction(() => (window as any).__spike.snapshot().contextLossCount > 0, undefined, { timeout: 6_000 })
    .catch(() => {
      handlerFiredWithinGrace = false;
    });
  const after = await page.evaluate(() => (window as any).__spike.snapshot());
  (after as any).handlerFiredWithinGrace = handlerFiredWithinGrace;
  // Post-loss write: does the terminal still accept, retain, and render data?
  const postLossWrite = await page.evaluate(async () => {
    const spike = (window as any).__spike;
    const beforeLines = spike.snapshot().bufferLines;
    const marker = `POSTLOSS-MARKER-${Date.now()}`;
    await spike.writeBulk({ totalLines: 200, chunkLines: 200 });
    await spike.writeText(`${marker}\r\n`);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const afterSnap = spike.snapshot();
    return {
      beforeLines,
      afterLines: afterSnap.bufferLines,
      marker,
      tail: spike.readTail(),
      rendererMode: afterSnap.rendererMode,
      canvasCount: afterSnap.canvasCount,
      domRowsCount: afterSnap.domRowsCount,
      errors: afterSnap.errors,
    };
  });
  return { before, trigger, after, postLossWrite };
}

function summarize(label: string, r: { boot: any; bulk: any; paced: any }): string {
  return [
    `--- ${label} ---`,
    `renderer: ${r.boot.rendererMode}` +
      (r.boot.webglLoadError ? ` (webgl load error: ${r.boot.webglLoadError})` : '') +
      ` | canvases=${r.boot.canvasCount} domRows=${r.boot.domRowsCount}`,
    `bulk: ${r.bulk.totalLines} lines, ${(r.bulk.bytes / 1e6).toFixed(1)} MB in ${r.bulk.wallMs.toFixed(0)} ms ` +
      `=> ${Math.round(r.bulk.linesPerSec).toLocaleString()} lines/s, ${r.bulk.mbPerSec.toFixed(1)} MB/s ` +
      `(parse ${r.bulk.parseMs.toFixed(0)} ms, settle ${r.bulk.settleMs.toFixed(0)} ms)`,
    `bulk frames: mean gap ${r.bulk.frameStats.meanGapMs?.toFixed(1)} ms, p95 ${r.bulk.frameStats.p95GapMs?.toFixed(1)} ms, max ${r.bulk.frameStats.maxGapMs?.toFixed(0)} ms`,
    `paced: ${r.paced.totalLines} lines over ${r.paced.frames} frames => ${r.paced.achievedFps.toFixed(1)} fps ` +
      `(mean gap ${r.paced.frameStats.meanGapMs?.toFixed(1)} ms, p95 ${r.paced.frameStats.p95GapMs?.toFixed(1)} ms)`,
    `context losses during run: ${r.bulk.post.contextLossCount}`,
  ].join('\n');
}

async function main() {
  const headed = process.argv.includes('--headed');
  const linesArg = process.argv.find((a) => a.startsWith('--lines='));
  const lines = linesArg ? Number(linesArg.split('=')[1]) : 100_000;

  const { server, port } = await startStaticServer(SPIKE_ROOT);
  const baseUrl = `http://127.0.0.1:${port}/page/index.html`;
  const results: Record<string, unknown> = {
    meta: {
      startedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      headed,
      lines,
      proxyNote:
        'Playwright WebKit (engine proxy for WKWebView). NOT a real Tauri WKWebView window; see verdict doc T3 section.',
    },
  };

  let browser: Browser | null = null;
  let exitCode = 0;
  try {
    browser = await webkit.launch({ headless: !headed });
    results.browserVersion = `WebKit ${browser.version()}`;
    console.log(`launched ${results.browserVersion} (headless=${!headed}) on ${baseUrl}`);

    // Run 1: WebGL-preferred path + probes + context-loss drill.
    {
      const { page, log } = await openHarness(browser, baseUrl);
      const workload = await runRendererWorkload(page, { forceDom: false, lines });
      const contextLoss = await runContextLossProbe(page);
      const webgpu = await page.evaluate(() => (window as any).__spike.probeWebGPU());
      const webglRaw = await page.evaluate(() => (window as any).__spike.webglInfo());
      results.webglRun = { ...workload, contextLoss, log };
      results.webgpuProbe = webgpu;
      results.webglRawInfo = webglRaw;
      console.log(summarize('run 1: webgl-preferred', workload));
      console.log(
        `context-loss drill: trigger=${JSON.stringify(contextLoss.trigger)} -> mode ${contextLoss.before.rendererMode} => ${contextLoss.after.rendererMode}, ` +
          `losses=${contextLoss.after.contextLossCount}, post-loss write ${contextLoss.postLossWrite.beforeLines} -> ${contextLoss.postLossWrite.afterLines} lines ` +
          `(renderer ${contextLoss.postLossWrite.rendererMode}, canvases ${contextLoss.postLossWrite.canvasCount}, domRows ${contextLoss.postLossWrite.domRowsCount}, ` +
          `marker ${contextLoss.postLossWrite.tail === contextLoss.postLossWrite.marker ? 'FOUND' : `MISSING (tail=${contextLoss.postLossWrite.tail})`})`,
      );
      console.log(
        `webgpu: navigator.gpu=${webgpu.hasNavigatorGpu} adapter=${webgpu.adapterPresent} device=${webgpu.devicePresent}` +
          (webgpu.error ? ` error=${webgpu.error}` : '') +
          (webgpu.adapterInfo ? ` info=${JSON.stringify(webgpu.adapterInfo)}` : ''),
      );
      console.log(`webgl2 raw: ${JSON.stringify(webglRaw)}`);
      await page.close();
    }

    // Run 2: forced DOM renderer — the fallback throughput floor.
    {
      const { page, log } = await openHarness(browser, baseUrl);
      const workload = await runRendererWorkload(page, { forceDom: true, lines });
      results.domRun = { ...workload, log };
      console.log(summarize('run 2: forced DOM renderer', workload));
      await page.close();
    }

    // Assessment (the runner's own pass/fail; mirrored into the verdict doc).
    const w = results.webglRun as any;
    const d = results.domRun as any;
    const assessment = {
      webglAddonLoaded: w.boot.rendererMode === 'webgl' && w.boot.webglLoadError == null,
      webglCanvasPresent: w.boot.canvasCount > 0,
      bulk100kCompleted: w.bulk.totalLines === lines && w.bulk.post.bufferLines > 0,
      noUnexpectedContextLossDuringWrite: w.bulk.post.contextLossCount === 0,
      contextLossHandlerFired: w.contextLoss.after.contextLossCount > 0,
      contextLossFellBackToDom: w.contextLoss.after.rendererMode === 'dom',
      contextLossFallbackKeptData:
        w.contextLoss.postLossWrite.tail === w.contextLoss.postLossWrite.marker &&
        w.contextLoss.postLossWrite.errors.length === 0,
      domFallbackCompleted100k: d.bulk.totalLines === lines && d.bulk.post.bufferLines > 0,
      noPageErrors:
        w.log.pageErrors.length === 0 && d.log.pageErrors.length === 0,
    };
    results.assessment = assessment;
    // Informational, not pass/fail: bulk throughput is parser-bound, so the
    // renderer choice barely moves it — the interesting deltas are frame
    // pacing under load and (on a live host) GPU vs CPU paint cost.
    results.throughputComparison = {
      webglLinesPerSec: w.bulk.linesPerSec,
      domLinesPerSec: d.bulk.linesPerSec,
      webglToDomRatio: w.bulk.linesPerSec / d.bulk.linesPerSec,
      webglBulkP95FrameGapMs: w.bulk.frameStats.p95GapMs,
      domBulkP95FrameGapMs: d.bulk.frameStats.p95GapMs,
    };
    console.log('--- assessment ---');
    for (const [k, v] of Object.entries(assessment)) console.log(`${v ? 'PASS' : 'FAIL'}  ${k}`);
    console.log(`info: webgl/dom bulk throughput ratio ${(w.bulk.linesPerSec / d.bulk.linesPerSec).toFixed(2)}x (parser-bound; not a gate)`);
    if (!assessment.bulk100kCompleted || !assessment.domFallbackCompleted100k) exitCode = 1;
  } catch (err) {
    results.fatal = String(err instanceof Error ? err.stack : err);
    console.error('FATAL:', err);
    exitCode = 2;
  } finally {
    await browser?.close();
    server.close();
  }

  const outDir = join(SPIKE_ROOT, 'results');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(outDir, `run-${stamp}.json`), JSON.stringify(results, null, 2));
  writeFileSync(join(outDir, 'latest.json'), JSON.stringify(results, null, 2));
  console.log(`results written to results/latest.json`);
  process.exit(exitCode);
}

void main();
