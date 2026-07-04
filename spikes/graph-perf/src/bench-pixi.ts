/**
 * Spike B / plan spike (ii): Pixi v8 5k-node soak — Playwright driver.
 *
 * Bundles browser/pixi-soak.ts with esbuild, serves it over loopback HTTP,
 * and runs the soak matrix:
 *   - Chromium headless, default GPU config (usually SwiftShader — software
 *     rasterizer; a conservative LOWER bound for real hardware)
 *   - Chromium headless with ANGLE-Metal flags (hardware GL if granted)
 *   - WebKit headless (Playwright WebKit ~ WKWebView proxy; NOT the real
 *     Tauri WKWebView — that is the T3 live-host confirmation)
 *
 * Sizes: 1k/3k/5k on the primary config; 5k on the others. pixelLine on/off
 * at 5k to expose the tessellated-stroke worst case.
 *
 * Run: pnpm bench:pixi   (from spikes/graph-perf/)
 */

import { createServer, type Server } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { chromium, webkit, type Browser } from 'playwright';
import { round } from './stats.ts';

const here = dirname(fileURLToPath(import.meta.url));
const spikeRoot = join(here, '..');
const browserDir = join(spikeRoot, 'browser');

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.map': 'application/json',
};

function bundlePage(): void {
  buildSync({
    entryPoints: [join(browserDir, 'pixi-soak.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    outfile: join(browserDir, 'dist', 'pixi-soak.js'),
  });
}

function serve(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const rel = url.pathname === '/' ? '/pixi-soak.html' : url.pathname;
      const path = join(browserDir, rel);
      if (!path.startsWith(browserDir) || !existsSync(path)) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
      res.end(readFileSync(path));
    } catch {
      res.writeHead(500).end('error');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') throw new Error('no port');
      resolve({ server, port: addr.port });
    });
  });
}

interface RunSpec {
  label: string;
  engine: 'chromium' | 'webkit';
  args?: string[];
  n: number;
  e: number;
  pixelLine: boolean;
}

async function runOne(browser: Browser, port: number, spec: RunSpec): Promise<any> {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  try {
    const q = `n=${spec.n}&e=${spec.e}&pixelLine=${spec.pixelLine ? 1 : 0}`;
    await page.goto(`http://127.0.0.1:${port}/pixi-soak.html?${q}`);
    await page.waitForFunction(
      // eslint-disable-next-line no-undef
      () => (window as any).__RESULT__ !== undefined || (window as any).__ERROR__ !== undefined,
      undefined,
      { timeout: 120_000 },
    );
    const error = await page.evaluate(() => (window as any).__ERROR__);
    if (error) return { label: spec.label, n: spec.n, e: spec.e, failed: true, error, consoleErrors };
    const result = await page.evaluate(() => (window as any).__RESULT__);
    return { label: spec.label, ...result, consoleErrors };
  } finally {
    await page.close();
  }
}

function fmt(r: any): string {
  if (r.failed) return `  ${r.label}: FAILED — ${String(r.error).split('\n')[0]}`;
  const raf = r.raf;
  const un = r.unthrottled;
  return (
    `  ${r.label} [n=${r.n} e=${r.e} pixelLine=${r.pixelLine}]\n` +
    `    renderer: ${r.renderer.pixi} ${r.renderer.glVersion} | ${r.renderer.renderer}\n` +
    `    rAF:         ${round(raf.fps, 1)} fps  frame mean ${round(raf.frameMs.mean, 2)}ms ` +
    `p95 ${round(raf.frameMs.p95, 2)}ms  >16.7ms ${round(raf.pctOver16_7, 1)}%  >33.3ms ${round(raf.pctOver33_3, 1)}%\n` +
    `    unthrottled: ${round(un.fps, 1)} fps  frame mean ${round(un.frameMs.mean, 2)}ms ` +
    `p95 ${round(un.frameMs.p95, 2)}ms`
  );
}

async function main() {
  bundlePage();
  const { server, port } = await serve();
  const results: any[] = [];

  const chromiumFlagsGpu = [
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
  ];

  const matrix: Array<{ engine: 'chromium' | 'webkit'; label: string; args?: string[]; specs: Array<{ n: number; pixelLine: boolean }> }> = [
    {
      engine: 'chromium',
      label: 'chromium-headless-default',
      specs: [
        { n: 1000, pixelLine: true },
        { n: 3000, pixelLine: true },
        { n: 5000, pixelLine: true },
        { n: 5000, pixelLine: false },
      ],
    },
    {
      engine: 'chromium',
      label: 'chromium-headless-angle-metal',
      args: chromiumFlagsGpu,
      specs: [
        { n: 5000, pixelLine: true },
        { n: 5000, pixelLine: false },
      ],
    },
    {
      engine: 'webkit',
      label: 'webkit-headless',
      specs: [
        { n: 1000, pixelLine: true },
        { n: 5000, pixelLine: true },
        { n: 5000, pixelLine: false },
      ],
    },
  ];

  try {
    for (const cfg of matrix) {
      const launcher = cfg.engine === 'chromium' ? chromium : webkit;
      let browser: Browser | null = null;
      try {
        browser = await launcher.launch({ headless: true, args: cfg.args });
      } catch (err) {
        results.push({ label: cfg.label, failed: true, error: `launch failed: ${(err as Error).message}` });
        process.stdout.write(`  ${cfg.label}: LAUNCH FAILED\n`);
        continue;
      }
      for (const s of cfg.specs) {
        const spec: RunSpec = {
          label: cfg.label,
          engine: cfg.engine,
          args: cfg.args,
          n: s.n,
          e: Math.round(s.n * 1.6),
          pixelLine: s.pixelLine,
        };
        try {
          const r = await runOne(browser, port, spec);
          results.push(r);
          process.stdout.write(fmt(r) + '\n');
        } catch (err) {
          const r = { label: cfg.label, n: s.n, failed: true, error: (err as Error).message };
          results.push(r);
          process.stdout.write(fmt(r) + '\n');
        }
      }
      await browser.close();
    }
  } finally {
    server.close();
  }

  // Evidence captures are append-only (mirrors spikes/webview-render's
  // run-<ts>.json + latest.json pattern): every run writes a timestamped file
  // plus a `pixi-latest.json` pointer, so a re-run can never silently clobber
  // a committed capture that the verdict doc cites.
  const outDir = join(spikeRoot, 'results');
  mkdirSync(outDir, { recursive: true });
  const capturedAt = new Date().toISOString();
  const payload = JSON.stringify(
    {
      spike: 'B-ii pixi v8 node-graph soak',
      host: `${process.platform}/${process.arch} node ${process.version} — Playwright headless proxies (NOT the real Tauri WKWebView; see verdict doc)`,
      capturedAt,
      results,
    },
    null,
    2,
  );
  const stamp = capturedAt.replace(/[:.]/g, '-');
  const runPath = join(outDir, `pixi-run-${stamp}.json`);
  writeFileSync(runPath, payload);
  writeFileSync(join(outDir, 'pixi-latest.json'), payload);
  process.stdout.write(`\nwrote ${runPath} (+ pixi-latest.json)\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
