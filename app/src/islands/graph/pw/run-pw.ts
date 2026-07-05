/**
 * FE-4 graph island — Playwright component-test driver (Chromium + WebKit,
 * plan §9.2 FE-4 rows; WebKit ≈ WKWebView engine-family proxy — same stated
 * limitation as spike-B; the in-Tauri run is a T3/live-check item).
 *
 * Phases per browser:
 *   1. boot            real Pixi WebGL canvas + token theme + module worker
 *   2. live population fixture waves stream in; nodes/edges appear per
 *                      commit; commits coalesce (one per wave)
 *   3. spawn/pulse     spawn-at-referrer locality; amber pulse on the
 *                      actively-touched artifact ONLY (probe tint = accent)
 *   4. layer toggles   hide/show a kind → sprites leave/rejoin the scene
 *   5. cluster-dim     focus cluster → out-of-cluster alpha = DIM floor
 *   6. worker RT       transferable Float32Array epochs flow; layout moves
 *   7. degrade         induced worker crash → settled layout, canvas stays,
 *                      later touches still land (NO white screen)
 *   8. reduced motion  settled layout (no jiggle), camera jump cut, discrete
 *                      static pulse
 *   9. 5k soak         5 000 nodes / 8 000 edges, hot layout, 8 s window,
 *                      retina DPR — honest fps report vs the spike-B floor
 *
 * Spike-B floor (docs/spikes/spike-b-graph-perf.md §Verdict): 60 fps
 * operational = rAF frame-time p95 ≤ 16.7 ms AND < 1% of frames > 16.7 ms
 * over an 8 s+ hot-layout window; 30 fps is the hard floor. The floor is
 * ASSERTED on hardware GL; on a software rasterizer (SwiftShader/llvmpipe —
 * not the product environment, per the spike's own reading) the numbers are
 * reported and flagged instead.
 *
 * Pinned-pacing reading (M4 gate, 2026-07-04): spike-B §Method notes both
 * engines "pinned their pacing rate, so measured rAF fps is a floor" — the
 * spike's WebKit pinned at 85 Hz (frame mean 11.8 ms), where the p95
 * encoding is meaningful. Playwright 1.61 headless WebKit pins rAF to a
 * 60 Hz virtual vsync instead; under a 60 Hz pin the p95 ≤ 16.7 ms
 * encoding is unpassable for ANY scene — an M4-gate control run of this
 * same harness with a 4-node/3-edge COLD scene measured p95 18.00 ms /
 * 58.1% > 16.7 ms / 0% > 33.3 ms (statistically identical to the 5k hot
 * figures), i.e. the overage is vsync quantization, not render cost. When
 * pacing is detected pinned at 60 Hz, the floor's PRIMARY criterion — "60
 * fps sustained ... 30 fps (any sustained frame time > 33.3 ms) is the
 * hard floor" — is asserted directly: fps ≥ 58, < 1% frames > 33.3 ms
 * (a missed vsync interval is ≥ 33.3 ms by construction, so any real
 * degradation still fails), p95 within vsync jitter of the 16.7 ms budget.
 *
 * Run: `pnpm -F aibender-app run test:graph-island` (builds first).
 */

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, type Browser, type BrowserType, type Page } from 'playwright';

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
  nodeCount: number;
  edgeCount: number;
  commitCount: number;
  bridgeState: string;
  lastEpochSeq: number;
  reducedMotion: boolean;
  visibleKinds: string[];
  focusedCluster: string | undefined;
  canvasCount: number;
  epochRows: Array<{ seq: number; n: number; alpha: number; len: number; isFloat32: boolean }>;
  batchRows: Array<{
    addedNodes: number;
    addedEdges: number;
    pulses: number[];
    retagged: Array<{ index: number; kind: string }>;
  }>;
  cameraCounters: { animated: number; jumpCuts: number };
  camera: { x: number; y: number; scale: number };
  errors: string[];
}

const snap = (page: Page) =>
  page.evaluate(() => window.__fe4graph.snapshot()) as unknown as Promise<Snapshot>;

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
      throw new Error(
        `timeout waiting for ${label}: ${JSON.stringify({ ...s, epochRows: s.epochRows.length, batchRows: s.batchRows })}`,
      );
    }
    await sleep(40);
  }
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

const AMBER = 0xffb000;
const SES_ALPHA = 'session:ses-alpha';
const MAIN_TS = 'file:/synthetic/proj-a/src/main.ts';

async function runFunctional(page: Page): Promise<void> {
  // -- 1. boot ----------------------------------------------------------------
  await page.evaluate(() => window.__fe4graph.create({ seed: 7 }));
  let s = await snap(page);
  assert.equal(s.canvasCount, 1, '1: Pixi canvas mounted');
  const theme = await page.evaluate(() => window.__fe4graph.theme());
  assert.equal(theme.background, 0x0c0c0b, '1: --ig-surface-well token feeds the canvas');
  assert.equal(theme.accent, 0xffb000, '1: --ig-accent token read');
  assert.equal(theme.cameraEaseMs, 320, '1: camera-ease duration token read');
  const identity = await page.evaluate(() => window.__fe4graph.rendererIdentity());
  console.log(
    `  boot: gl="${identity.glVersion}" renderer="${identity.renderer}" dpr=${identity.devicePixelRatio}`,
  );
  assert.equal(identity.antialiasAttr, false, '1: antialias OFF is normative (spike-B lock #3)');
  s = await waitFor(page, (x) => x.bridgeState === 'running' || x.bridgeState === 'idle', '1: worker ready');

  // -- 2. live population (fixture-feed harness) -------------------------------
  const expected = [
    { nodes: 4, edges: 3 },
    { nodes: 7, edges: 6 },
    { nodes: 10, edges: 8 },
  ];
  for (let wave = 0; wave < 3; wave++) {
    await page.evaluate((w) => window.__fe4graph.feedWave(w), wave);
    s = await waitFor(
      page,
      (x) => x.nodeCount === expected[wave]?.nodes && x.edgeCount === expected[wave]?.edges,
      `2: wave ${wave} landed (${expected[wave]?.nodes}n/${expected[wave]?.edges}e)`,
    );
  }
  assert.equal(s.commitCount, 3, '2: one coalesced commit per wave — never per-event');
  s = await waitFor(page, (x) => x.lastEpochSeq >= 1, '2: layout epochs flowing');

  // -- 3. spawn-at-referrer + amber pulse --------------------------------------
  const sesRec = (await page.evaluate(
    (id) => window.__fe4graph.nodeRecord(id),
    SES_ALPHA,
  )) as { spawnX: number; spawnY: number };
  const fileRec = (await page.evaluate(
    (id) => window.__fe4graph.nodeRecord(id),
    'file:/synthetic/proj-a/CLAUDE.md',
  )) as { spawnX: number; spawnY: number; kind: string };
  assert.equal(fileRec.kind, 'claude-md', '3: instructions classified');
  assert.ok(
    dist({ x: fileRec.spawnX, y: fileRec.spawnY }, { x: sesRec.spawnX, y: sesRec.spawnY }) <= 24 * Math.SQRT2,
    '3: artifact spawned AT its session referrer (+ bounded jitter), no origin fling',
  );
  // Wave 1 re-touched main.ts: its batch pulsed EXACTLY that node.
  const mainIndex = (await page.evaluate((id) => window.__fe4graph.indexOf(id), MAIN_TS)) as number;
  assert.deepEqual(s.batchRows[1]?.pulses, [mainIndex], '3: pulse = re-touched artifact ONLY');
  assert.deepEqual(s.batchRows[0]?.pulses, [], '3: first-touch enters never pulse');
  // A fresh re-touch drives the sprite to the AMBER bright phase + halo.
  // Sampled IN-PAGE per frame: the 80 ms hold window is shorter than a
  // couple of Playwright round-trips on slower transports.
  let probe = (await page.evaluate(async (id) => {
    const api = window.__fe4graph;
    api.feedTouches([
      {
        kind: 'context-touch',
        sessionId: 'ses-alpha',
        path: id.slice('file:'.length),
        relation: 'read',
        ts: 999,
      },
    ]);
    api.commitNow();
    const t0 = performance.now();
    for (;;) {
      const p = api.probe(id);
      // The bright phase = amber tint AND halo, in the SAME painted frame.
      // (A boundary sample can catch the amber of a prior pulse before the
      // fresh entry's first frame paints — wait for the co-occurrence.)
      if ((p.tint === 0xffb000 && (p.haloAlpha ?? 0) > 0) || performance.now() - t0 > 2000) {
        return p;
      }
      await new Promise((r) => setTimeout(r, 8));
    }
  }, MAIN_TS)) as {
    tint?: number | undefined;
    haloAlpha?: number | undefined;
    resting?: number | undefined;
    visible?: boolean | undefined;
    alpha?: number | undefined;
  };
  assert.equal(probe.tint, AMBER, '3: actively-touched artifact lights THE amber');
  assert.ok((probe.haloAlpha ?? 0) > 0, '3: pulse halo visible during the bright phase');
  // Phosphor decay: back to resting ink inside hold(80) + decay(640) + slack.
  await sleep(1200);
  probe = await page.evaluate((id) => window.__fe4graph.probe(id), MAIN_TS);
  assert.equal(probe.tint, probe.resting, '3: pulse decays to resting ink (no permanent amber)');
  assert.equal(probe.haloAlpha, 0, '3: halo extinguished after decay');

  // -- 4. layer toggles ---------------------------------------------------------
  await page.evaluate(() => window.__fe4graph.setLayer('reference', false));
  await sleep(80); // ≥1 frame: filters apply in the render loop
  probe = await page.evaluate((id) => window.__fe4graph.probe(id), 'file:/synthetic/proj-b/spec.md');
  assert.equal(probe.visible, false, '4: hidden layer leaves the scene');
  const sesProbe = await page.evaluate((id) => window.__fe4graph.probe(id), SES_ALPHA);
  assert.equal(sesProbe.visible, true, '4: other layers unaffected');
  await page.evaluate(() => window.__fe4graph.setLayer('reference', true));
  await sleep(80);
  probe = await page.evaluate((id) => window.__fe4graph.probe(id), 'file:/synthetic/proj-b/spec.md');
  assert.equal(probe.visible, true, '4: layer returns');
  s = await snap(page);
  assert.ok(s.visibleKinds.includes('reference'), '4: snapshot mirrors the toggle');

  // -- 5. cluster-dim -----------------------------------------------------------
  await page.evaluate(() => window.__fe4graph.focusCluster('ses-beta'));
  await sleep(80);
  const dimmed = await page.evaluate((id) => window.__fe4graph.probe(id), SES_ALPHA);
  const focused = await page.evaluate((id) => window.__fe4graph.probe(id), 'file:/synthetic/proj-b/spec.md');
  assert.equal(dimmed.alpha, 0.15, '5: out-of-cluster dims to the opacity floor');
  assert.equal(focused.alpha, 1, '5: focused cluster at full ink');
  await page.evaluate(() => window.__fe4graph.focusCluster(undefined));
  await sleep(80);
  const restored = await page.evaluate((id) => window.__fe4graph.probe(id), SES_ALPHA);
  assert.equal(restored.alpha, 1, '5: clearing focus restores full ink');

  // -- 6. worker round-trip -------------------------------------------------------
  const lastEpoch = (await snap(page)).epochRows.at(-1);
  assert.ok(lastEpoch !== undefined, '6: epochs recorded');
  assert.equal(lastEpoch?.isFloat32, true, '6: epochs are Float32Array views (never JSON)');
  assert.equal(lastEpoch?.len, 2 * (lastEpoch?.n ?? 0), '6: epoch length = 2×nodeCount');
  await page.evaluate(() => window.__fe4graph.holdHeat(true));
  const posA = (await page.evaluate((id) => window.__fe4graph.positionOf(id), MAIN_TS)) as {
    x: number;
    y: number;
  };
  await sleep(500);
  const posB = (await page.evaluate((id) => window.__fe4graph.positionOf(id), MAIN_TS)) as {
    x: number;
    y: number;
  };
  assert.ok(dist(posA, posB) > 0, '6: hot layout moves node positions (worker → renderer)');
  await page.evaluate(() => window.__fe4graph.holdHeat(false));
  // Spawn-at-referrer against the LIVE position: new artifact lands near its
  // session's current on-screen location.
  const sesLive = (await page.evaluate((id) => window.__fe4graph.positionOf(id), SES_ALPHA)) as {
    x: number;
    y: number;
  };
  await page.evaluate(() => {
    window.__fe4graph.feedTouches([
      { kind: 'context-touch', sessionId: 'ses-alpha', path: '/synthetic/proj-a/late.md', relation: 'read', ts: 1000 },
    ]);
    window.__fe4graph.commitNow();
  });
  const lateRec = (await page.evaluate(
    (id) => window.__fe4graph.nodeRecord(id),
    'file:/synthetic/proj-a/late.md',
  )) as { spawnX: number; spawnY: number };
  assert.ok(
    dist({ x: lateRec.spawnX, y: lateRec.spawnY }, sesLive) < 80,
    `6: late artifact spawns at the referrer's LIVE position (d=${dist({ x: lateRec.spawnX, y: lateRec.spawnY }, sesLive).toFixed(1)})`,
  );

  // -- 7. degrade (induced worker crash → settled layout, no white screen) -------
  const crashed = await page.evaluate(() => window.__fe4graph.crashWorker());
  assert.ok(crashed, '7: crash hook reached the live worker');
  s = await waitFor(page, (x) => x.bridgeState === 'degraded', '7: bridge degrades', 5000);
  assert.equal(s.canvasCount, 1, '7: canvas SURVIVES the crash (no white screen)');
  const nodesBefore = s.nodeCount;
  await page.evaluate(() => {
    window.__fe4graph.feedTouches([
      { kind: 'context-touch', sessionId: 'ses-alpha', path: '/synthetic/proj-a/post-crash.md', relation: 'read', ts: 2000 },
    ]);
    window.__fe4graph.commitNow();
  });
  s = await waitFor(page, (x) => x.nodeCount === nodesBefore + 1, '7: post-crash touches still land');
  const postPos = await page.evaluate(
    (id) => window.__fe4graph.positionOf(id),
    'file:/synthetic/proj-a/post-crash.md',
  );
  assert.ok(postPos !== undefined, '7: degraded nodes rest at their spawn coordinates');
  const settled = s.epochRows.at(-1);
  assert.equal(settled?.alpha, 0, '7: degrade epochs are settled (alpha 0)');

  // -- 8. reduced motion (day-one path) -----------------------------------------
  await page.evaluate(() => window.__fe4graph.create({ seed: 7, reducedMotion: true }));
  await page.evaluate(() => {
    window.__fe4graph.feedWave(0);
  });
  s = await waitFor(page, (x) => x.nodeCount === 4, '8: wave lands under reduced motion');
  s = await waitFor(
    page,
    (x) => x.epochRows.length > 0 && (x.epochRows.at(-1)?.alpha ?? 1) < 0.001,
    '8: layout SETTLES per commit (converged epoch, no live jiggle)',
  );
  // Let the renderer finish easing ONTO the settled epoch (the interpolation
  // window is ≤250 ms) — then the field must be perfectly still.
  await sleep(350);
  const rmA = (await page.evaluate((id) => window.__fe4graph.positionOf(id), SES_ALPHA)) as {
    x: number;
    y: number;
  };
  await sleep(400);
  const rmB = (await page.evaluate((id) => window.__fe4graph.positionOf(id), SES_ALPHA)) as {
    x: number;
    y: number;
  };
  assert.ok(dist(rmA, rmB) < 0.5, '8: settled positions do not drift');
  // Camera: jump cut, never a fly-to.
  await page.evaluate((id) => window.__fe4graph.focusNode(id, 2), SES_ALPHA);
  s = await snap(page);
  assert.equal(s.cameraCounters.jumpCuts, 1, '8: focus = jump cut');
  assert.equal(s.cameraCounters.animated, 0, '8: NO fly-to under reduced motion');
  assert.equal(s.camera.scale, 2, '8: target framing applied instantly');
  // Pulse: DISCRETE static amber tick (no tween) — still exactly amber mid-window.
  await page.evaluate(() => {
    window.__fe4graph.feedTouches([
      { kind: 'context-touch', sessionId: 'ses-alpha', path: '/synthetic/proj-a/src/main.ts', relation: 'read', ts: 50 },
    ]);
    window.__fe4graph.commitNow();
  });
  await sleep(800); // full-motion would be mid-decay (a lerped, non-amber tint)
  probe = await page.evaluate((id) => window.__fe4graph.probe(id), MAIN_TS);
  assert.equal(probe.tint, AMBER, '8: reduced-motion pulse is a STATIC amber tick');

  const finalSnap = await snap(page);
  assert.deepEqual(finalSnap.errors, [], `in-page errors: ${finalSnap.errors.join('; ')}`);
}

interface SoakOutcome {
  stats: {
    frames: number;
    seconds: number;
    fps: number;
    frameMsMean: number;
    frameMsP95: number;
    pctOver16_7: number;
    pctOver33_3: number;
    epochsApplied: number;
  };
  identity: { glVersion: string; vendor: string; renderer: string; devicePixelRatio: number };
  software: boolean;
}

async function runSoak(page: Page): Promise<SoakOutcome> {
  await page.evaluate(() => window.__fe4graph.create({ seed: 42, width: 1600, height: 1000 }));
  await waitFor(page, (x) => x.bridgeState === 'running' || x.bridgeState === 'idle', 'soak: worker ready');
  const target = await page.evaluate(() => window.__fe4graph.soakLoad({}));
  assert.equal(target.nodeCount, 5000, 'soak: script pins the 5k ceiling');
  assert.equal(target.edgeCount, 8000, 'soak: script pins the 8k edge ceiling');
  const s = await waitFor(
    page,
    (x) => x.nodeCount === 5000 && x.edgeCount === 8000,
    'soak: full population in the store',
    30_000,
  );
  assert.equal(s.canvasCount, 1, 'soak: canvas alive under full population');
  await page.evaluate(() => window.__fe4graph.holdHeat(true));
  await waitFor(page, (x) => (x.epochRows.at(-1)?.n ?? 0) === 5000, 'soak: layout covers 5k nodes', 30_000);
  await sleep(1500); // warmup (spike method)
  const statsBefore = await page.evaluate(() => {
    window.__fe4graph.beginStats();
    return window.__fe4graph.readStats();
  });
  void statsBefore;
  await sleep(8000); // the 8 s hot-layout soak window
  const stats = (await page.evaluate(() => window.__fe4graph.readStats())) as SoakOutcome['stats'];
  await page.evaluate(() => window.__fe4graph.holdHeat(false));
  const identity = (await page.evaluate(() =>
    window.__fe4graph.rendererIdentity(),
  )) as SoakOutcome['identity'];
  const software = /swiftshader|software|llvmpipe/i.test(
    `${identity.vendor} ${identity.renderer}`,
  );
  return { stats, identity, software };
}

async function run(name: 'chromium' | 'webkit', launcher: BrowserType, url: string): Promise<void> {
  console.log(`\n=== graph island · ${name} ===`);
  // Chromium: --use-angle=metal reaches the real GPU in headless (spike-B
  // method); WebKit headless uses the Apple GPU directly.
  const browser: Browser = await launcher.launch({
    headless: true,
    ...(name === 'chromium' ? { args: ['--use-angle=metal'] } : {}),
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1720, height: 1120 },
      deviceScaleFactor: 2, // the floor is defined at retina DPR
    });
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>)['__name'] = (t: unknown) => t;
    });
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.goto(url);
    await page.waitForFunction(() => window.__fe4graph?.ready === true);

    await runFunctional(page);
    console.log(`  functional phases: PASS`);

    const soak = await runSoak(page);
    const { stats, identity, software } = soak;
    console.log(
      `  5k soak [${name}]: renderer="${identity.renderer}" dpr=${identity.devicePixelRatio}`,
    );
    console.log(
      `  5k soak [${name}]: fps=${stats.fps.toFixed(1)} frameMs mean=${stats.frameMsMean.toFixed(2)} p95=${stats.frameMsP95.toFixed(2)} >16.7ms=${stats.pctOver16_7.toFixed(2)}% >33.3ms=${stats.pctOver33_3.toFixed(2)}% frames=${stats.frames} epochsApplied=${stats.epochsApplied}`,
    );
    assert.ok(stats.frames > 200, 'soak: measured a real frame population');
    assert.ok(stats.epochsApplied > 60, 'soak: layout stayed HOT through the window');
    if (software) {
      console.warn(
        `  !! SOFTWARE RASTERIZER (${identity.renderer}) — not the product environment; ` +
          `the spike-B floor is asserted on hardware GL only (spike-B §Result reads the ` +
          `software rows as a lower bound, not the target). Numbers above stand as the record.`,
      );
    } else {
      // Pinned-at-60Hz detection (see header "Pinned-pacing reading"): mean
      // frame time sits ON the 16.7 ms vsync budget with zero dropped
      // intervals. An engine actually struggling shows 33.3 ms+ frames
      // (missed vsync intervals) and a falling fps — never a 16.7 ms mean.
      const VSYNC_60 = 1000 / 60;
      const pinnedAt60 =
        Math.abs(stats.frameMsMean - VSYNC_60) < 0.8 &&
        stats.fps >= 58 &&
        stats.fps <= 62 &&
        stats.pctOver33_3 < 1;
      if (pinnedAt60) {
        console.warn(
          `  !! rAF pacing PINNED at 60Hz (mean ${stats.frameMsMean.toFixed(2)}ms) — asserting the ` +
            `spike-B floor in its primary "60 fps sustained" form; the p95<=16.7ms encoding is ` +
            `unpassable under a 60Hz pin (control: cold 4-node scene measures p95 18.0ms). ` +
            `Uncapped-pacing confirmation stays a T3 live-check item (spike-B §remains #1).`,
        );
        assert.ok(
          stats.fps >= 58,
          `soak FLOOR MISS (60Hz-pinned): fps ${stats.fps.toFixed(1)} < 58`,
        );
        assert.ok(
          stats.pctOver33_3 < 1,
          `soak HARD-FLOOR MISS (60Hz-pinned): ${stats.pctOver33_3.toFixed(2)}% of frames over 33.3ms (sustained)`,
        );
        assert.ok(
          stats.frameMsP95 <= VSYNC_60 + 3.4,
          `soak FLOOR MISS (60Hz-pinned): p95 ${stats.frameMsP95.toFixed(2)}ms beyond vsync jitter of the 16.7ms budget`,
        );
      } else {
        // The spike-B verdict floor, asserted (M4 DoD: "5k-node soak still
        // meets the M0 spike's fps floor").
        assert.ok(
          stats.frameMsP95 <= 16.7,
          `soak FLOOR MISS: frame-time p95 ${stats.frameMsP95.toFixed(2)}ms > 16.7ms`,
        );
        assert.ok(
          stats.pctOver16_7 < 1,
          `soak FLOOR MISS: ${stats.pctOver16_7.toFixed(2)}% of frames over 16.7ms (floor: <1%)`,
        );
        // Hard floor per the verdict wording: "any SUSTAINED frame time
        // > 33.3ms". An isolated GC-outlier frame is anticipated by the spike
        // ("one late epoch, invisible behind interpolated rendering") — a
        // sustained breach shows up as ≥1% of the window, not one frame.
        assert.ok(
          stats.pctOver33_3 < 1,
          `soak HARD-FLOOR MISS: ${stats.pctOver33_3.toFixed(2)}% of frames over 33.3ms (sustained)`,
        );
      }
    }

    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('; ')}`);
    console.log(`  ${name}: PASS`);
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  assert.ok(
    existsSync(path.join(DIST_DIR, 'index.html')),
    'build first: pnpm -F aibender-app run pw:build:graph',
  );
  const { server, url } = await serveDist();
  try {
    await run('chromium', chromium, url);
    await run('webkit', webkit, url);
    console.log('\ngraph island pw: all browsers passed');
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error('\nGRAPH ISLAND PW FAILURE:', err instanceof Error ? err.message : err);
  process.exit(1);
});
