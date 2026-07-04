/**
 * FE-3 transcript island — Playwright component-test driver (Chromium +
 * WebKit; WebKit ≈ WKWebView engine-family proxy, same stated limitation as
 * SPIKE-C; real Tauri embed + trackpad inertial scroll are T3 items).
 *
 * The SPIKE-C shim hard-assert suite, run against the REAL island (the
 * production follow-guard, react-virtual windowing, frozen payload model):
 *
 *   A. anchored streaming    0 px pin (median 0, jank frames 0), LIVE lit
 *   B. mid-stream resizes    all four spike resize classes retain the anchor
 *   C. scroll-up release     follow releases, ZERO drift while streaming,
 *                            resize while released does not yank, JUMP shown
 *   D. jump-to-live          re-anchors to 0 px, follow + LIVE resume
 *   E. 10k-line bulk         DOM row count flat (virtualization), deviation
 *                            still 0, Chromium heap growth bounded
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

// Hard-assert bounds. The spike measured 0/0/0 settled deviation and 0 jank
// frames on both engines; median must be EXACTLY 0 (the "0px deviation" hard
// assert), min 0, with 1px tolerated only at max for sub-pixel scrollTop.
const MEDIAN_PX = 0;
const MAX_SETTLE_PX = 1;
const DRIFT_PX = 1;
const DOM_ROWS_CAP = 90; // viewport rows (~30) + 2×overscan(10) + measurement slack
const DOM_ROWS_FLAT_DELTA = 25;
const HEAP_GROWTH_CAP_BYTES = 64 * 1024 * 1024;

const RESIZES = [
  { width: 800, height: 400, label: 'shrink-h' },
  { width: 800, height: 750, label: 'grow-h' },
  { width: 500, height: 750, label: 'narrow-w (rewrap)' },
  { width: 1000, height: 500, label: 'widen+shrink-h' },
];

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

interface IslandState {
  count: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  deviation: number;
  following: boolean;
  liveVisible: boolean;
  jumpVisible: boolean;
  domRowCount: number;
  streaming: boolean;
}

const state = (page: Page) => page.evaluate(() => window.__fe3tr.state()) as Promise<IslandState>;
const settled = (page: Page) =>
  page.evaluate(() => window.__fe3tr.settledDeviation()) as Promise<{
    min: number;
    median: number;
    max: number;
  }>;

async function settleFrames(page: Page, frames = 8): Promise<void> {
  await page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        let i = 0;
        const step = (): void => {
          i += 1;
          if (i >= n) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    frames,
  );
}

async function run(name: 'chromium' | 'webkit', launcher: typeof chromium, url: string) {
  console.log(`\n=== transcript island · ${name} ===`);
  const launchArgs = name === 'chromium' ? { args: ['--js-flags=--expose-gc'] } : {};
  const browser: Browser = await launcher.launch({ headless: true, ...launchArgs });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>)['__name'] = (t: unknown) => t;
    });
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.goto(url);
    await page.waitForFunction(() => window.__fe3tr?.ready === true);

    // -- A. anchored streaming (positive row: end-anchor holds) ---------------
    await page.evaluate(() => {
      window.__fe3tr.markPhase('A-anchored-stream');
      window.__fe3tr.start({ intervalMs: 30, seed: 12345 });
    });
    await sleep(2500);
    let s = await state(page);
    const devA = await settled(page);
    console.log(`  A stream: count=${s.count} dev min/med/max=${devA.min}/${devA.median}/${devA.max}px`);
    assert.equal(s.following, true, 'A: follow-intent must hold after 2.5s of stream');
    assert.equal(s.liveVisible, true, 'A: LIVE readout lit while following');
    assert.equal(s.jumpVisible, false, 'A: no jump control while following');
    assert.equal(devA.median, MEDIAN_PX, `A: median deviation ${devA.median}px (0px hard assert)`);
    assert.equal(devA.min, 0, 'A: min deviation must touch 0');
    assert.ok(devA.max <= MAX_SETTLE_PX, `A: max settled deviation ${devA.max}px > ${MAX_SETTLE_PX}px`);
    assert.ok(s.count > 20, `A: stream produced items (got ${s.count})`);

    // -- B. mid-stream resizes (edge row: all four spike resize classes) ------
    for (const size of RESIZES) {
      const pre = await state(page);
      assert.equal(pre.following, true, `B: follow lost BEFORE resize ${size.label} — guard leak`);
      await page.evaluate((label) => window.__fe3tr.markPhase(`B-${label}`), size.label);
      await page.setViewportSize({ width: size.width, height: size.height });
      await settleFrames(page, 8);
      const devB = await settled(page);
      const sb = await state(page);
      console.log(
        `  B resize ${String(size.width).padStart(4)}x${size.height} (${size.label.padEnd(17)}): follow=${sb.following} dev=${devB.min}/${devB.median}/${devB.max}px`,
      );
      assert.equal(sb.following, true, `B: anchor lost after ${size.label}`);
      assert.equal(devB.median, MEDIAN_PX, `B ${size.label}: median ${devB.median}px (0px hard assert)`);
      assert.ok(devB.max <= MAX_SETTLE_PX, `B ${size.label}: max ${devB.max}px > ${MAX_SETTLE_PX}px`);
      await sleep(300); // keep streaming between resizes
    }
    await page.setViewportSize({ width: 800, height: 600 });
    await settleFrames(page, 8);

    // -- C. scroll-up release (edge row) --------------------------------------
    await page.evaluate(() => window.__fe3tr.markPhase('C-release'));
    let scrollMethod = 'mouse.wheel';
    try {
      await page.mouse.move(400, 300);
      await page.mouse.wheel(0, -1200);
    } catch {
      scrollMethod = 'synthetic wheel + scrollTop';
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="tr-scroller"]') as HTMLElement;
        el.dispatchEvent(new WheelEvent('wheel', { deltaY: -1200, bubbles: true }));
        el.scrollTop = Math.max(0, el.scrollTop - 1200);
      });
    }
    await settleFrames(page, 6);
    s = await state(page);
    console.log(`  C release via ${scrollMethod}: following=${s.following} scrollTop=${s.scrollTop.toFixed(1)}`);
    assert.equal(s.following, false, 'C: follow must release on wheel-up');
    assert.equal(s.liveVisible, false, 'C: LIVE readout off while released');
    assert.equal(s.jumpVisible, true, 'C: JUMP TO LIVE control shown while released');
    const heldTop = s.scrollTop;
    assert.ok(s.deviation > 100, `C: reader parked in scrollback (deviation ${s.deviation}px)`);

    await sleep(1500); // stream keeps appending below
    s = await state(page);
    const drift = Math.abs(s.scrollTop - heldTop);
    console.log(`  C drift while released: ${drift.toFixed(2)}px over 1.5s`);
    assert.equal(s.following, false, 'C: must stay released while reading scrollback');
    assert.ok(drift <= DRIFT_PX, `C: reading position drifted ${drift.toFixed(1)}px > ${DRIFT_PX}px`);

    // resize while released must NOT yank the reader (guard gating)
    await page.setViewportSize({ width: 700, height: 500 });
    await settleFrames(page, 8);
    s = await state(page);
    assert.equal(s.following, false, 'C: resize while released must not re-anchor');
    assert.ok(s.deviation > 50, `C: reader still in scrollback after resize (deviation ${s.deviation}px)`);

    // -- D. jump-to-live (edge row) --------------------------------------------
    // (phase mark lands AFTER the click so the jank metric measures the
    // re-anchored stretch, not the released frames while the click is in flight)
    await page.click('[data-testid="tr-jump"]');
    await page.evaluate(() => window.__fe3tr.markPhase('D-post-jump'));
    await settleFrames(page, 8);
    const devD = await settled(page);
    s = await state(page);
    console.log(`  D jump: following=${s.following} dev=${devD.min}/${devD.median}/${devD.max}px`);
    assert.equal(s.following, true, 'D: jump-to-live must re-anchor');
    assert.equal(s.liveVisible, true, 'D: LIVE readout returns');
    assert.equal(devD.median, MEDIAN_PX, `D: median ${devD.median}px after jump (0px hard assert)`);
    await sleep(800);
    const devD2 = await settled(page);
    s = await state(page);
    assert.equal(s.following, true, 'D: follow resumes and holds');
    assert.equal(devD2.median, MEDIAN_PX, `D: median ${devD2.median}px while following post-jump`);

    // -- E. 10k-line memory-flat (edge row) ------------------------------------
    await page.evaluate(() => {
      window.__fe3tr.markPhase('E-10k-bulk');
      window.__fe3tr.stop();
    });
    const samples: Array<{ count: number; domRows: number; heap: number | null }> = [];
    for (const target of [2000, 6000, 10_000]) {
      await page.evaluate((n) => window.__fe3tr.appendUntil(n), target);
      await settleFrames(page, 8);
      const st = await state(page);
      const heap = (await page.evaluate(() => window.__fe3tr.heapUsed())) as number | null;
      samples.push({ count: st.count, domRows: st.domRowCount, heap });
      console.log(
        `  E @${st.count} items: domRows=${st.domRowCount} heap=${heap === null ? 'n/a' : `${(heap / 1e6).toFixed(1)}MB`}`,
      );
    }
    const last = samples.at(-1) as { count: number; domRows: number; heap: number | null };
    assert.ok(last.count >= 10_000, `E: reached 10k items (got ${last.count})`);
    for (const sample of samples) {
      assert.ok(
        sample.domRows > 0 && sample.domRows <= DOM_ROWS_CAP,
        `E: DOM rows ${sample.domRows} outside (0, ${DOM_ROWS_CAP}] — virtualization broken`,
      );
    }
    const rowCounts = samples.map((x) => x.domRows);
    const flatDelta = Math.max(...rowCounts) - Math.min(...rowCounts);
    assert.ok(
      flatDelta <= DOM_ROWS_FLAT_DELTA,
      `E: DOM row count not flat across 2k→10k (delta ${flatDelta})`,
    );
    const devE = await settled(page);
    s = await state(page);
    assert.equal(s.following, true, 'E: follow held through the bulk feed');
    assert.equal(devE.median, MEDIAN_PX, `E: median ${devE.median}px at 10k items (0px hard assert)`);
    const heapFirst = samples[0]?.heap;
    const heapLast = last.heap;
    if (typeof heapFirst === 'number' && typeof heapLast === 'number') {
      const growth = heapLast - heapFirst;
      console.log(`  E heap growth 2k→10k: ${(growth / 1e6).toFixed(1)}MB`);
      assert.ok(
        growth <= HEAP_GROWTH_CAP_BYTES,
        `E: heap grew ${(growth / 1e6).toFixed(1)}MB > ${HEAP_GROWTH_CAP_BYTES / 1e6}MB across 8k items`,
      );
    }

    // -- phase metrics + error gate --------------------------------------------
    await page.evaluate(() => window.__fe3tr.finishPhase());
    const phases = (await page.evaluate(() => window.__fe3tr.phases())) as Array<{
      name: string;
      frames: number;
      maxDeviation: number;
      jankFrames: number;
      maxUpwardJump: number;
    }>;
    console.log(`  ${name} phase metrics (jank frame = deviation > 8px):`);
    for (const p of phases) {
      console.log(
        `    ${p.name.padEnd(26)} frames=${String(p.frames).padStart(4)} maxDev=${p.maxDeviation.toFixed(1).padStart(7)} jank=${String(p.jankFrames).padStart(3)} maxUpJump=${p.maxUpwardJump.toFixed(1)}`,
      );
    }
    for (const p of phases) {
      if (p.name.startsWith('A-') || p.name.startsWith('B-') || p.name.startsWith('D-')) {
        assert.equal(p.jankFrames, 0, `${p.name}: jank frames while anchored (guard leak)`);
      }
    }
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('; ')}`);
    console.log(`  ${name}: PASS`);
  } finally {
    await browser.close();
  }
}

async function main() {
  assert.ok(existsSync(path.join(DIST_DIR, 'index.html')), 'build first: pnpm -F aibender-app run pw:build:transcript');
  const { server, url } = await serveDist();
  try {
    await run('chromium', chromium, url);
    await run('webkit', webkit as typeof chromium, url);
    console.log('\ntranscript island pw: all browsers passed');
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error('\nTRANSCRIPT ISLAND PW FAILURE:', err instanceof Error ? err.message : err);
  process.exit(1);
});
