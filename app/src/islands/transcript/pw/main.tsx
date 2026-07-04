/**
 * FE-3 transcript island — in-page Playwright harness (component test body).
 *
 * Mounts the REAL TranscriptIsland over the REAL store, fed by a
 * deterministic synthetic payload stream shaped exactly like SPIKE-C's
 * (mulberry32-seeded; 55% extend-the-tail-message deltas — the canonical
 * token-stream mutation — 35% new blocks, 10% tool bursts), plus a bulk
 * feeder for the 10k-line memory-flat row. Per-rAF recorder ported from the
 * spike (deviation / jank frames / upward jumps).
 *
 * All content is SYNTHESIZED [X2]. The driver (run-pw.ts) asserts through
 * window.__fe3tr; follow state is read from the island's own data-following
 * attribute — the app follow-intent IS the live oracle (SPIKE-C verdict).
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { TranscriptPayload } from '@aibender/protocol';
import '../../../chrome/theme/tokens.css';
import { createTranscriptStore } from '../model.ts';
import { TranscriptIsland } from '../TranscriptIsland.tsx';

const SID = 'ses_fake_1';

// ---------------------------------------------------------------- stream sim

/** mulberry32 — deterministic PRNG (same generator as the spike). */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  'token stream lattice anchor virtual transcript phosphor amber charcoal ' +
  'measure resize wrap element scroll frame budget ledger channel envelope ' +
  'kernel spawn quota gauge burn rate lineage brief merge fork resume'
).split(' ');

// ---------------------------------------------------------------- recorder

const JANK_PX = 8;

interface PhaseMetrics {
  name: string;
  frames: number;
  maxDeviation: number;
  jankFrames: number;
  maxUpwardJump: number;
  settleDeviation: number;
}

class Recorder {
  phases: PhaseMetrics[] = [];
  current: PhaseMetrics | null = null;
  private lastScrollTop = 0;

  markPhase(name: string): void {
    this.finishPhase();
    this.current = {
      name,
      frames: 0,
      maxDeviation: 0,
      jankFrames: 0,
      maxUpwardJump: 0,
      settleDeviation: 0,
    };
  }

  finishPhase(): void {
    if (this.current !== null) {
      this.phases.push(this.current);
      this.current = null;
    }
  }

  record(scrollTop: number, deviation: number): void {
    const p = this.current;
    if (p !== null) {
      p.frames += 1;
      if (deviation > p.maxDeviation) p.maxDeviation = deviation;
      if (deviation > JANK_PX) p.jankFrames += 1;
      const jump = this.lastScrollTop - scrollTop;
      if (jump > p.maxUpwardJump) p.maxUpwardJump = jump;
      p.settleDeviation = deviation;
    }
    this.lastScrollTop = scrollTop;
  }
}

// ---------------------------------------------------------------- harness

const store = createTranscriptStore(SID);
const recorder = new Recorder();

let rng = mulberry32(0xa1bdef);
let messageSeq = 0;
let toolSeq = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let currentMessage = '';

const word = () => WORDS[Math.floor(rng() * WORDS.length)] as string;
const sentence = (n: number) => Array.from({ length: n }, word).join(' ');

function newMessageUuid(): string {
  messageSeq += 1;
  return `synthmsg-${messageSeq}`;
}

function tick(): void {
  const r = rng();
  const batch: TranscriptPayload[] = [];
  if (r < 0.55 && currentMessage !== '') {
    // extend the tail message — the canonical streaming shape
    batch.push({
      kind: 'transcript-delta',
      sessionId: SID,
      messageUuid: currentMessage,
      text: ` ${sentence(1 + Math.floor(rng() * 3))}`,
    });
  } else if (r < 0.9 || currentMessage === '') {
    currentMessage = newMessageUuid();
    batch.push({
      kind: 'transcript-delta',
      sessionId: SID,
      messageUuid: currentMessage,
      text: sentence(3 + Math.floor(rng() * 40)),
    });
  } else {
    // tool burst — start/result pairs land as one projection batch
    for (let i = 0; i < 2; i += 1) {
      toolSeq += 1;
      const toolUseId = `synthtool-${toolSeq}`;
      batch.push({
        kind: 'transcript-tool',
        sessionId: SID,
        toolUseId,
        toolName: i % 2 === 0 ? 'Read' : 'Bash',
        phase: 'start',
      });
      batch.push({
        kind: 'transcript-tool',
        sessionId: SID,
        toolUseId,
        toolName: i % 2 === 0 ? 'Read' : 'Bash',
        phase: 'result',
        ok: rng() > 0.2,
      });
    }
    currentMessage = '';
  }
  store.applyMany(batch);
}

function start(opts: { intervalMs?: number; seed?: number } = {}): void {
  if (timer !== null) return;
  if (opts.seed !== undefined) rng = mulberry32(opts.seed);
  timer = setInterval(tick, opts.intervalMs ?? 30);
}

function stop(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
}

/** Bulk feeder for the 10k memory-flat row: appends until `total` items. */
async function appendUntil(total: number, chunk = 250): Promise<number> {
  stop();
  while (store.getSnapshot().items.length < total) {
    const batch: TranscriptPayload[] = [];
    const need = Math.min(chunk, total - store.getSnapshot().items.length);
    for (let i = 0; i < need; i += 1) {
      batch.push({
        kind: 'transcript-delta',
        sessionId: SID,
        messageUuid: newMessageUuid(),
        text: sentence(3 + Math.floor(rng() * 20)),
      });
    }
    store.applyMany(batch);
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  }
  return store.getSnapshot().items.length;
}

function scroller(): HTMLElement {
  return document.querySelector('[data-testid="tr-scroller"]') as HTMLElement;
}

function state() {
  const el = scroller();
  const island = document.querySelector('.tr-island') as HTMLElement;
  return {
    count: store.getSnapshot().items.length,
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    deviation: Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop),
    following: island.getAttribute('data-following') === '1',
    liveVisible: document.querySelector('[data-testid="tr-live"]') !== null,
    jumpVisible: document.querySelector('[data-testid="tr-jump"]') !== null,
    domRowCount: el.querySelectorAll('[data-index]').length,
    streaming: timer !== null,
  };
}

/** Settled deviation over n frames (min/median/max — the spike's oracle). */
function settledDeviation(frames = 16): Promise<{ min: number; median: number; max: number }> {
  return new Promise((resolve) => {
    const el = scroller();
    const devs: number[] = [];
    const step = (): void => {
      devs.push(Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop));
      if (devs.length >= frames) {
        devs.sort((a, b) => a - b);
        resolve({
          min: +(devs[0] as number).toFixed(1),
          median: +(devs[Math.floor(devs.length / 2)] as number).toFixed(1),
          max: +(devs[devs.length - 1] as number).toFixed(1),
        });
      } else {
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  });
}

function heapUsed(): number | null {
  const perf = performance as unknown as { memory?: { usedJSHeapSize?: number } };
  const gc = (window as unknown as { gc?: () => void }).gc;
  if (typeof gc === 'function') {
    gc();
    gc();
  }
  return perf.memory?.usedJSHeapSize ?? null;
}

declare global {
  interface Window {
    __fe3tr: {
      ready: boolean;
      start: typeof start;
      stop: typeof stop;
      appendUntil: typeof appendUntil;
      state: typeof state;
      settledDeviation: typeof settledDeviation;
      markPhase: (name: string) => void;
      finishPhase: () => void;
      phases: () => PhaseMetrics[];
      heapUsed: typeof heapUsed;
    };
  }
}

window.__fe3tr = {
  ready: false,
  start,
  stop,
  appendUntil,
  state,
  settledDeviation,
  markPhase: (name) => recorder.markPhase(name),
  finishPhase: () => recorder.finishPhase(),
  phases: () => recorder.phases.concat(recorder.current ? [recorder.current] : []),
  heapUsed,
};

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <TranscriptIsland feed={store} />
  </StrictMode>,
);

// Per-rAF sampling loop — MUST register after the island's follow-guard rAF
// loop is running: rAF callbacks fire in registration order and the guard
// re-requests inside its own callback, so once we register later than its
// first frame, every per-frame read lands POST-pin (the spike's stated
// sampling discipline — an earlier registration reads the pre-pin state and
// reports phantom jank).
function startRecorder(): void {
  const el = document.querySelector('[data-testid="tr-scroller"]') as HTMLElement | null;
  const island = document.querySelector('.tr-island');
  if (el === null || island === null || island.getAttribute('data-following') === null) {
    setTimeout(startRecorder, 10);
    return;
  }
  setTimeout(() => {
    // 50ms after mount the guard's passive effect has registered its loop.
    window.__fe3tr.ready = true;
    requestAnimationFrame(function loop() {
      recorder.record(el.scrollTop, Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop));
      requestAnimationFrame(loop);
    });
  }, 50);
}
startRecorder();
