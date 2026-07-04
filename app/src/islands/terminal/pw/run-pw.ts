/**
 * FE-3 terminal island — Playwright component-test driver (Chromium + WebKit,
 * plan §9.2 FE-3 rows; WebKit ≈ WKWebView engine-family proxy — same stated
 * limitation as SPIKE-A; the real Tauri embed is a T3 item).
 *
 * Phases per browser:
 *   1. boot            renderer selection + clause-8 test signals
 *   2. golden echo     golden binary fixture → decode → island → buffer + ack
 *   3. echo renders    300 SGR lines land; acks track the consumed watermark
 *   4. input + resize  keystrokes → INPUT bytes; container resize → pty-resize
 *   5. reattach        serialize snapshot restores scrollback; replay-from-
 *                      watermark; renderer selection re-runs (SPIKE-A clause 5)
 *   6. context loss    simulated loss → 3s grace → DOM fallback WITHOUT data
 *                      loss; no reflap; exactly one fallback event
 *   7. gap → replay    future offset never renders; pty-replay-request once
 *   8. forceDom        clause-1 override boots straight to the DOM renderer
 *
 * Run: `pnpm -F aibender-app run test:islands` (builds first). Exits non-zero
 * on any assertion failure.
 */

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, type Browser, type Page } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(HERE, 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
};

function serveDist(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const rel = (req.url ?? '/').split('?')[0] ?? '/';
    const file = path.join(DIST_DIR, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(DIST_DIR) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Snapshot {
  rendererMode: string;
  rendererReason: string;
  canvasCount: number;
  domRowsCount: number;
  textureAtlasPresent: boolean;
  bufferLines: number;
  cols: number;
  rows: number;
  attachCount: number;
  fallbacks: number;
  telemetry: Array<{ mode: string; reason: string }>;
  acks: number[];
  resizes: Array<{ cols: number; rows: number }>;
  replays: number[];
  inputs: string[];
  nextOffset: number;
  errors: string[];
}

const snap = (page: Page) =>
  page.evaluate(() => window.__fe3term.snapshot()) as unknown as Promise<Snapshot>;
const buffer = (page: Page) => page.evaluate(() => window.__fe3term.bufferText());

async function waitFor(
  page: Page,
  predicate: (s: Snapshot) => boolean,
  label: string,
  timeoutMs = 8000,
): Promise<Snapshot> {
  const t0 = Date.now();
  for (;;) {
    const s = await snap(page);
    if (predicate(s)) return s;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`timeout waiting for ${label}: ${JSON.stringify(s)}`);
    }
    await sleep(50);
  }
}

async function run(name: 'chromium' | 'webkit', launcher: typeof chromium, url: string) {
  console.log(`\n=== terminal island · ${name} ===`);
  const browser: Browser = await launcher.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>)['__name'] = (t: unknown) => t;
    });
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.goto(url);
    await page.waitForFunction(() => window.__fe3term?.ready === true);

    // -- 1. boot: renderer selection + clause-8 signals ----------------------
    await page.evaluate(() => window.__fe3term.boot());
    let s = await snap(page);
    console.log(`  boot: mode=${s.rendererMode} reason=${s.rendererReason} canvases=${s.canvasCount}`);
    assert.equal(s.rendererMode, 'webgl', '1: WebGL must select in the proxy (SPIKE-A verdict)');
    assert.equal(s.rendererReason, 'webgl-ok');
    assert.ok(s.canvasCount > 0, '1: WebGL active ⇔ canvases present (clause 8)');
    assert.equal(s.fallbacks, 0);
    assert.deepEqual(s.telemetry.at(-1), { mode: 'webgl', reason: 'webgl-ok' }, '1: clause-7 telemetry');
    assert.deepEqual(s.resizes.length, 1, '1: initial geometry announced once');

    // -- 2. golden corpus echo ----------------------------------------------
    await page.evaluate(() => window.__fe3term.feedGolden('pty-frame-output-valid'));
    s = await waitFor(page, (x) => x.acks.includes(9), '2: ack of the golden frame (offset 0 + 9 bytes)');
    assert.ok((await buffer(page)).includes('synth-out'), '2: golden payload rendered');

    // -- 3. echo renders + watermark acks ------------------------------------
    const before = s.nextOffset;
    await page.evaluate(() => window.__fe3term.feedLines(300, 'echo'));
    s = await waitFor(page, (x) => x.acks.at(-1) === x.nextOffset && x.nextOffset > before, '3: ack reaches the fed watermark');
    const text = await buffer(page);
    assert.ok(text.includes('[echo-00299]'), '3: last line rendered');
    assert.ok(s.bufferLines > 250, `3: buffer grew (got ${s.bufferLines})`);
    const monotonic = s.acks.every((w, i) => i === 0 || w > (s.acks[i - 1] as number));
    assert.ok(monotonic, `3: ack watermarks strictly increase: ${s.acks.join(',')}`);
    assert.ok(s.textureAtlasPresent, '3: texture atlas present after writes (clause 8 secondary signal)');

    // -- 4. input + resize ----------------------------------------------------
    await page.click('#stage .xterm');
    await page.keyboard.type('ls');
    s = await waitFor(page, (x) => x.inputs.join('') === 'ls', '4: keystrokes → INPUT bytes');
    const resizesBefore = s.resizes.length;
    await page.evaluate(() => window.__fe3term.resizeStage(600, 360));
    s = await waitFor(page, (x) => x.resizes.length > resizesBefore, '4: pty-resize after container resize');
    const last = s.resizes.at(-1) as { cols: number; rows: number };
    assert.ok(last.cols >= 1 && last.cols <= 4096 && last.rows >= 1 && last.rows <= 4096, '4: frozen bounds');
    assert.ok(last.cols < 80 * 2 && last.cols > 10, `4: plausible cols for 600px (${last.cols})`);

    // -- 5. detach → reattach (serialize + replay watermark) ------------------
    await page.evaluate(() => window.__fe3term.feed('REATTACH-MARK-1\r\n'));
    s = await waitFor(page, (x) => x.acks.at(-1) === x.nextOffset, '5: quiescent before detach');
    const watermarkAtDetach = s.nextOffset;
    await page.evaluate(() => window.__fe3term.detachReattach());
    s = await snap(page);
    assert.equal(s.attachCount, 2, '5: second attach ran');
    assert.equal(s.rendererMode, 'webgl', '5: fresh attach re-ran selection (clause 5)');
    assert.ok(s.replays.includes(watermarkAtDetach), `5: replay requested from detach watermark ${watermarkAtDetach}`);
    const restored = await buffer(page);
    assert.ok(restored.includes('REATTACH-MARK-1'), '5: scrollback restored via serialize');
    assert.ok(restored.includes('[echo-00299]'), '5: deep scrollback retained');
    // stream continues on the same axis after reattach
    await page.evaluate(() => window.__fe3term.feed('POST-REATTACH\r\n'));
    s = await waitFor(page, (x) => x.acks.at(-1) === x.nextOffset, '5: acks resume after reattach');
    assert.ok((await buffer(page)).includes('POST-REATTACH'));

    // -- 6. context-loss chain (negative row: fallback WITHOUT data loss) -----
    await page.evaluate(() => window.__fe3term.feed('PRE-LOSS-MARK\r\n'));
    await waitFor(page, (x) => x.acks.at(-1) === x.nextOffset, '6: quiescent before loss');
    const lossAttempt = await page.evaluate(() => window.__fe3term.simulateContextLoss());
    assert.ok((lossAttempt as { attempted: boolean }).attempted, '6: loss simulation reached a canvas');
    // the addon waits its 3s restoration grace before firing onContextLoss
    s = await waitFor(page, (x) => x.rendererMode === 'dom', '6: DOM fallback after grace window', 10_000);
    assert.equal(s.rendererReason, 'context-loss');
    assert.equal(s.fallbacks, 1, '6: exactly one fallback event');
    assert.equal(s.canvasCount, 0, '6: WebGL canvases gone (clause 8)');
    assert.ok(s.domRowsCount > 0, '6: DOM renderer rows populated (clause 8)');
    assert.ok((await buffer(page)).includes('PRE-LOSS-MARK'), '6: NO DATA LOSS across the fallback');
    await page.evaluate(() => window.__fe3term.feed('POST-LOSS-MARK\r\n'));
    s = await waitFor(page, (x) => x.acks.at(-1) === x.nextOffset, '6: writes continue after fallback');
    assert.ok((await buffer(page)).includes('POST-LOSS-MARK'), '6: post-loss bytes render on DOM');
    await sleep(1200);
    s = await snap(page);
    assert.equal(s.rendererMode, 'dom', '6: degradation is permanent within the attach (no reflap)');
    assert.equal(s.fallbacks, 1, '6: still exactly one fallback');

    // -- 7. gap → replay-request ----------------------------------------------
    const gapBase = s.nextOffset;
    await page.evaluate(
      (base) => window.__fe3term.feedAt(base + 50, 'FUTURE-BYTES\r\n'),
      gapBase,
    );
    s = await snap(page);
    assert.ok(s.replays.includes(gapBase), `7: replay requested from first missing byte ${gapBase}`);
    assert.ok(!(await buffer(page)).includes('FUTURE-BYTES'), '7: future bytes never render out of order');
    // broker replays the missing range, then re-sends the future chunk
    await page.evaluate((base) => {
      window.__fe3term.feedAt(base, 'x'.repeat(50));
      window.__fe3term.feedAt(base + 50, 'FUTURE-BYTES\r\n');
    }, gapBase);
    await waitFor(page, (x) => x.acks.at(-1) === gapBase + 50 + 14, '7: ack past the healed gap');
    assert.ok((await buffer(page)).includes('FUTURE-BYTES'), '7: healed bytes render in order');

    // -- 8. forceDom override (clause 1) --------------------------------------
    await page.evaluate(() => window.__fe3term.boot({ forceDom: true }));
    await page.evaluate(() => window.__fe3term.feed('FORCED-DOM\r\n'));
    s = await waitFor(page, (x) => x.acks.length > 0, '8: forced-dom island consumes');
    assert.equal(s.rendererMode, 'dom');
    assert.equal(s.rendererReason, 'forced-dom');
    assert.equal(s.canvasCount, 0, '8: no WebGL attempted under forceDom');
    assert.ok(s.domRowsCount > 0, '8: DOM renderer active');

    const finalSnap = await snap(page);
    assert.deepEqual(finalSnap.errors, [], `in-page errors: ${finalSnap.errors.join('; ')}`);
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('; ')}`);
    console.log(`  ${name}: PASS (acks=${finalSnap.acks.length}, attaches=${finalSnap.attachCount})`);
  } finally {
    await browser.close();
  }
}

async function main() {
  assert.ok(existsSync(path.join(DIST_DIR, 'index.html')), 'build first: pnpm -F aibender-app run pw:build:terminal');
  const { server, url } = await serveDist();
  try {
    await run('chromium', chromium, url);
    await run('webkit', webkit as typeof chromium, url);
    console.log('\nterminal island pw: all browsers passed');
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error('\nTERMINAL ISLAND PW FAILURE:', err instanceof Error ? err.message : err);
  process.exit(1);
});
