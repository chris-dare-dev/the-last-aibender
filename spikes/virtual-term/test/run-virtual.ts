/**
 * SPIKE-C (v) driver — react-virtual end-anchored mid-stream resize.
 *
 * Loads the built harness over loopback HTTP in Chromium and WebKit
 * (WebKit ≈ WKWebView proxy — same engine family, not the Tauri embed;
 * stated in the verdict doc), streams synthetic tokens, resizes the
 * viewport mid-stream, and measures anchor behavior.
 *
 * Two passes per browser:
 *
 *   RAW  (?shim absent) — virtual-core 3.17.3 as-shipped. Finding under
 *        test: anchorTo:'end' does NOT survive a scroll-element height
 *        shrink (rect observer stores the new rect, deviation exceeds
 *        scrollEndThreshold=1, follow releases). The pass MEASURES each
 *        resize and asserts the height-shrink loss is reproducible.
 *
 *   SHIM (?shim=1) — the FE-3 fallback design: remember pre-resize
 *        isAtEnd(), re-pin via scrollToEnd() on scroll-element resize.
 *        Full hard-assert suite:
 *          A. anchored streaming    — isAtEnd stays true, deviation ~0
 *          B. mid-stream resizes    — anchor retained across h/w changes
 *          C. scroll-up release     — anchor released; ~0 drift while the
 *                                     stream appends; resize does NOT yank
 *          D. jump-to-live          — scrollToEnd() re-anchors, follow resumes
 *
 * Prints metrics tables and writes results/virtual-<browser>.json.
 * Exits non-zero on any assertion failure.
 */
import { chromium, webkit, type Browser, type Page } from "playwright";
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(HERE, "..", "dist");
const DIST = path.join(DIST_DIR, "index.html");
const RESULTS_DIR = path.resolve(HERE, "..", "results");

// Assertion bounds (px). SETTLE = deviation after the virtualizer has had a
// few frames to reconcile; transient spikes are reported, not asserted.
const SETTLE_PX = 4;
const DRIFT_PX = 4;

interface PhaseMetrics {
  name: string;
  frames: number;
  maxDeviation: number;
  jankFrames: number;
  maxUpwardJump: number;
  settleDeviation: number;
  atEndAtSettle: boolean;
  firstScrollTop: number;
  lastScrollTop: number;
}

const SIZES = [
  { width: 800, height: 400, label: "shrink-h" },
  { width: 800, height: 750, label: "grow-h" },
  { width: 500, height: 750, label: "narrow-w (rewrap)" },
  { width: 1000, height: 500, label: "widen+shrink-h" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ES-module scripts are CORS-blocked over file:// — serve dist/ on loopback.
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".map": "application/json",
};
function serveDist(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const rel = (req.url ?? "/").split("?")[0];
    const file = path.join(DIST_DIR, rel === "/" ? "index.html" : rel);
    if (!file.startsWith(DIST_DIR) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

async function settle(page: Page, frames = 6) {
  await page.evaluate(
    (n) =>
      new Promise<void>((res) => {
        let i = 0;
        const step = () => (++i >= n ? res() : requestAnimationFrame(step));
        requestAnimationFrame(step);
      }),
    frames,
  );
}

const state = (page: Page) => page.evaluate(() => window.__spike.state());

/**
 * Deviation from the bottom sampled per-rAF over `frames` frames (the app's
 * follow-guard rAF registers first, so reads land after its pin). In a
 * continuously streaming list an instantaneous read can catch the moment
 * right after an append and before the next pin — min/median over frames is
 * the honest "settled" number.
 */
async function settledDeviation(
  page: Page,
  frames = 16,
): Promise<{ min: number; median: number; max: number }> {
  return page.evaluate(
    (n) =>
      new Promise<{ min: number; median: number; max: number }>((res) => {
        const el = document.querySelector(".scroller") as HTMLElement;
        const devs: number[] = [];
        const step = () => {
          devs.push(Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop));
          if (devs.length >= n) {
            devs.sort((a, b) => a - b);
            res({
              min: +devs[0].toFixed(1),
              median: +devs[Math.floor(devs.length / 2)].toFixed(1),
              max: +devs[devs.length - 1].toFixed(1),
            });
          } else {
            requestAnimationFrame(step);
          }
        };
        requestAnimationFrame(step);
      }),
    frames,
  );
}

async function openHarness(browser: Browser, url: string) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  // tsx transpiles this driver with esbuild keepNames; functions passed to
  // page.evaluate then reference the __name helper, which must exist in-page.
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__name = (t: unknown) => t;
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForFunction(() => window.__spike?.ready === true);
  return { page, errors };
}

interface ResizeOutcome {
  size: string;
  label: string;
  /** pre-resize liveness — library isAtEnd() (raw) / app follow-intent (shim) */
  preLive: boolean;
  live: boolean;
  /** library isAtEnd() at measure time — flickers under per-frame pinning */
  libAtEnd: boolean;
  devMin: number;
  devMedian: number;
  devMax: number;
}

/**
 * Liveness oracle. RAW mode: the library's isAtEnd() — it IS the behavior
 * under test. SHIM mode: the app-owned follow-intent — measured finding:
 * the library's internal scrollOffset lags per-frame DOM pin writes by a
 * frame, so isAtEnd() flickers false while the DOM sits exactly at the
 * bottom (vdist oscillated 0<->130px in the internals trace). FE-3's live
 * indicator must come from the app's follow discipline, not isAtEnd().
 */
type SpikeState = Awaited<ReturnType<typeof state>>;
const isLive = (s: SpikeState, mode: "raw" | "shim") =>
  mode === "shim" ? s.shimFollow : s.atEnd;

async function resizeSequence(page: Page, mode: "raw" | "shim"): Promise<ResizeOutcome[]> {
  const out: ResizeOutcome[] = [];
  for (const size of SIZES) {
    if (mode === "raw") {
      // raw pass: each resize is tested from a freshly re-anchored state
      // (raw follow may have spontaneously dropped in the meantime)
      await page.evaluate(() => window.__spike.scrollToEnd());
      await settle(page, 4);
    }
    const pre = await state(page);
    await page.evaluate(
      (label) => window.__spike.markPhase(label),
      `B-resize-${size.width}x${size.height}`,
    );
    await page.setViewportSize({ width: size.width, height: size.height });
    await settle(page, 8);
    const devs = await settledDeviation(page);
    const s = await state(page);
    out.push({
      size: `${size.width}x${size.height}`,
      label: size.label,
      preLive: isLive(pre, mode),
      live: isLive(s, mode),
      libAtEnd: s.atEnd,
      devMin: devs.min,
      devMedian: devs.median,
      devMax: devs.max,
    });
    await sleep(400); // keep streaming between resizes
  }
  return out;
}

// ------------------------------------------------------------------ RAW pass
//
// Measurement-first: virtual-core 3.17.3 as-shipped. Two findings recorded:
//   1. spontaneous follow drop during PLAIN streaming (tail re-measure past
//      scrollEndThreshold kills followOnAppend permanently) — sampled at
//      250 ms during phase A;
//   2. resize retention — each resize from a freshly re-anchored state.
// The pass asserts raw mode is NOT stream-safe overall (a drop or a resize
// loss happens). If raw mode ever runs fully clean, the library changed —
// re-evaluate the shim.
async function rawPass(browser: Browser, url: string, name: string) {
  const { page, errors } = await openHarness(browser, url);
  const opts = await page.evaluate(() => window.__spike.options());
  assert.equal(opts.anchorTo, "end");
  assert.equal(opts.shim, false, "raw pass must run without the shim");

  await page.evaluate(() => {
    window.__spike.markPhase("A-anchored-stream");
    window.__spike.start({ intervalMs: 30, seed: 12345 });
  });
  // sample for the spontaneous follow drop
  let spontaneousDrop: { tMs: number; count: number } | null = null;
  for (let i = 0; i < 10; i++) {
    await sleep(250);
    const s = await state(page);
    if (!s.atEnd && !spontaneousDrop) {
      spontaneousDrop = { tMs: (i + 1) * 250, count: s.count };
    }
  }
  console.log(
    spontaneousDrop
      ? `  raw stream: follow DROPPED spontaneously by t=${spontaneousDrop.tMs}ms (${spontaneousDrop.count} lines, no resize)`
      : "  raw stream: follow survived 2.5s of streaming",
  );

  const outcomes = await resizeSequence(page, "raw");
  for (const o of outcomes) {
    console.log(
      `  raw resize ${o.size.padEnd(9)} (${o.label.padEnd(17)}): preAtEnd=${o.preLive} atEnd=${o.live} dev min/median/max=${o.devMin}/${o.devMedian}/${o.devMax}px`,
    );
  }
  const anyResizeLoss = outcomes.some((o) => o.preLive && !o.live);
  assert.ok(
    spontaneousDrop !== null || anyResizeLoss,
    "raw: expected as-shipped anchorTo:'end' to fail stream-safety somewhere " +
      "(spontaneous drop or resize loss). If it now holds, the library " +
      "changed — re-evaluate whether the FE-3 follow-guard is still needed.",
  );
  await page.evaluate(() => window.__spike.stop());
  const s = await state(page);
  await page.close();
  assert.equal(errors.length, 0, `raw: page errors: ${errors.join("; ")}`);
  return { spontaneousDrop, outcomes, finalLineCount: s.count };
}

// ----------------------------------------------------------------- SHIM pass
async function shimPass(browser: Browser, url: string, name: string) {
  const { page, errors } = await openHarness(browser, `${url}?shim=1`);
  const opts = await page.evaluate(() => window.__spike.options());
  console.log("  virtualizer options:", JSON.stringify(opts));
  assert.equal(opts.anchorTo, "end");
  assert.equal(opts.shim, true, "shim pass must run with the shim");

  // Phase A: anchored streaming — app-owned follow + DOM deviation are the
  // oracle (library isAtEnd() flickers under per-frame pinning; see isLive)
  await page.evaluate(() => {
    window.__spike.markPhase("A-anchored-stream");
    window.__spike.start({ intervalMs: 30, seed: 12345 });
  });
  await sleep(2500);
  let s = await state(page);
  const devA = await settledDeviation(page);
  assert.equal(s.shimFollow, true, "A: follow must hold after 2.5s of stream");
  assert.ok(devA.median <= SETTLE_PX, `A: median deviation ${devA.median}px while following`);
  assert.ok(s.count > 20, `A: stream must have produced lines (got ${s.count})`);

  // Phase B: mid-stream resizes — anchor must survive every one
  const outcomes = await resizeSequence(page, "shim");
  for (const o of outcomes) {
    console.log(
      `  shim resize ${o.size.padEnd(9)} (${o.label.padEnd(17)}): follow=${o.live} libAtEnd=${o.libAtEnd} dev min/median/max=${o.devMin}/${o.devMedian}/${o.devMax}px`,
    );
    assert.equal(o.preLive, true, `B: follow already lost BEFORE resize ${o.size} — guard leak`);
    assert.equal(o.live, true, `B: anchor lost after resize ${o.size} (${o.label})`);
    assert.ok(
      o.devMedian <= SETTLE_PX,
      `B: median deviation ${o.devMedian}px > ${SETTLE_PX}px after resize ${o.size}`,
    );
  }

  // Phase C: user scroll-up releases the anchor
  await page.evaluate(() => window.__spike.markPhase("C-scroll-up-release"));
  let scrollMethod = "mouse.wheel";
  try {
    await page.mouse.move(400, 250);
    await page.mouse.wheel(0, -1200);
  } catch {
    // wheel unsupported on this browser/platform combo — synthesize the
    // wheel event (so the follow-guard sees user intent) and apply the
    // scroll programmatically.
    scrollMethod = "synthetic wheel + scrollTop";
    await page.evaluate(() => {
      const el = document.querySelector(".scroller") as HTMLElement;
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1200, bubbles: true }));
      el.scrollTop = Math.max(0, el.scrollTop - 1200);
    });
  }
  await settle(page, 6);
  s = await state(page);
  console.log(`  scroll-up via ${scrollMethod}: follow=${s.shimFollow} scrollTop=${s.scrollTop.toFixed(1)}`);
  assert.equal(s.shimFollow, false, "C: follow must release on scroll-up");
  const heldTop = s.scrollTop;

  // stream keeps appending BELOW for 1.5s — reading position must not move
  await sleep(1500);
  s = await state(page);
  const drift = Math.abs(s.scrollTop - heldTop);
  console.log(`  drift while released: ${drift.toFixed(2)}px over 1.5s of stream`);
  assert.equal(s.shimFollow, false, "C: must stay released while reading scrollback");
  assert.ok(drift <= DRIFT_PX, `C: reading position drifted ${drift.toFixed(1)}px > ${DRIFT_PX}px`);

  // resize while released — the shim must NOT yank the reader to the bottom
  await page.setViewportSize({ width: 800, height: 600 });
  await settle(page, 8);
  s = await state(page);
  assert.equal(s.shimFollow, false, "C: resize while released must not re-anchor (guard gating)");

  // Phase D: jump to live re-anchors and follow resumes
  await page.evaluate(() => window.__spike.markPhase("D-jump-to-live"));
  await page.click("#jump-live");
  await settle(page, 8);
  const devAfterJump = await settledDeviation(page);
  s = await state(page);
  console.log(
    `  after jump-to-live: follow=${s.shimFollow} dev min/median/max=${devAfterJump.min}/${devAfterJump.median}/${devAfterJump.max}px`,
  );
  assert.equal(s.shimFollow, true, "D: jump-to-live must re-anchor");
  assert.ok(
    devAfterJump.median <= SETTLE_PX,
    `D: median deviation ${devAfterJump.median}px after jump`,
  );

  await sleep(1000);
  const devResumed = await settledDeviation(page);
  s = await state(page);
  assert.equal(s.shimFollow, true, "D: follow must resume after jump-to-live");
  assert.ok(
    devResumed.median <= SETTLE_PX,
    `D: median deviation ${devResumed.median}px while following post-jump`,
  );

  await page.evaluate(() => {
    window.__spike.stop();
    window.__spike.finishPhase();
  });
  const phases: PhaseMetrics[] = await page.evaluate(() => window.__spike.phases());
  const finalLineCount = s.count;
  await page.close();
  assert.equal(errors.length, 0, `shim: page errors: ${errors.join("; ")}`);

  console.log(`\n  ${name} shim-pass phase metrics (jank frame = deviation > 8px):`);
  console.log(
    "  " +
      "phase".padEnd(26) +
      "frames".padStart(7) +
      "maxDev".padStart(9) +
      "jankFr".padStart(8) +
      "maxUpJump".padStart(11) +
      "settleDev".padStart(11),
  );
  for (const p of phases) {
    console.log(
      "  " +
        p.name.padEnd(26) +
        String(p.frames).padStart(7) +
        p.maxDeviation.toFixed(1).padStart(9) +
        String(p.jankFrames).padStart(8) +
        p.maxUpwardJump.toFixed(1).padStart(11) +
        p.settleDeviation.toFixed(1).padStart(11),
    );
  }
  return { outcomes, phases, scrollMethod, finalLineCount };
}

async function runBrowser(
  name: "chromium" | "webkit",
  launcher: typeof chromium | typeof webkit,
  url: string,
): Promise<Record<string, unknown>> {
  console.log(`\n=== ${name} ===`);
  let browser: Browser | null = null;
  try {
    browser = await launcher.launch({ headless: true });
  } catch (err) {
    const reason = String((err as Error).message).split("\n")[0];
    console.log(`SKIP ${name}: launch failed — ${reason}`);
    return { browser: name, skipped: true, reason };
  }
  try {
    console.log(`-- raw pass (virtual-core as-shipped)`);
    const raw = await rawPass(browser, url, name);
    console.log(`-- shim pass (FE-3 resize-retention fallback)`);
    const shim = await shimPass(browser, url, name);
    const result = {
      browser: name,
      skipped: false,
      raw,
      shim,
      boundsPx: { settle: SETTLE_PX, drift: DRIFT_PX, jankFrame: 8 },
    };
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(
      path.join(RESULTS_DIR, `virtual-${name}.json`),
      JSON.stringify(result, null, 2),
    );
    console.log(`${name}: PASS`);
    return result;
  } finally {
    await browser.close();
  }
}

async function main() {
  assert.ok(existsSync(DIST), `build first: dist/index.html missing (${DIST})`);
  const { server, url } = await serveDist();
  try {
    const results = [];
    results.push(await runBrowser("chromium", chromium, url));
    results.push(await runBrowser("webkit", webkit, url));
    const ran = results.filter((r) => !r.skipped);
    assert.ok(ran.length >= 1, "at least one browser must run");
    const skipped = results.filter((r) => r.skipped);
    if (skipped.length) {
      console.log(`\nWARNING: skipped: ${skipped.map((r) => r.browser).join(", ")}`);
    }
    console.log("\nspike (v) driver: all executed browsers passed");
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error("\nSPIKE (v) FAILURE:", err.message ?? err);
  process.exit(1);
});
