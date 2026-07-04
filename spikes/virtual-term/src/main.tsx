/**
 * SPIKE-C (v): react-virtual 3.14 end-anchored transcript harness.
 *
 * A virtualized "transcript" fed by a simulated token stream (deterministic
 * PRNG, synthesized text only — [X2]). The Playwright driver resizes the
 * viewport mid-stream and reads the metrics collected here.
 *
 * Everything the driver needs is exposed on window.__spike.
 */
import { StrictMode, useEffect, useReducer, useRef } from "react";
import { createRoot } from "react-dom/client";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";

// ---------------------------------------------------------------- stream sim

/** mulberry32 — deterministic PRNG so every run sees the same stream. */
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

const WORDS =
  ("token stream lattice anchor virtual transcript phosphor amber charcoal " +
  "measure resize wrap element scroll frame budget ledger channel envelope " +
  "kernel spawn quota gauge burn rate lineage brief merge fork resume").split(" ");

interface Line {
  id: number;
  tag: string;
  text: string;
}

interface StreamState {
  lines: Line[];
}

type StreamAction =
  | { kind: "append-line"; line: Line }
  | { kind: "extend-last"; extra: string }
  | { kind: "burst"; lines: Line[] }
  | { kind: "reset" };

function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.kind) {
    case "append-line":
      return { lines: [...state.lines, action.line] };
    case "extend-last": {
      if (state.lines.length === 0) return state;
      const lines = state.lines.slice();
      const last = lines[lines.length - 1];
      lines[lines.length - 1] = { ...last, text: last.text + action.extra };
      return { lines };
    }
    case "burst":
      return { lines: [...state.lines, ...action.lines] };
    case "reset":
      return { lines: [] };
  }
}

// ---------------------------------------------------------------- metrics

interface Sample {
  t: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** px between the bottom edge of content and the bottom of the viewport */
  deviation: number;
  atEnd: boolean;
  count: number;
}

interface PhaseMetrics {
  name: string;
  frames: number;
  maxDeviation: number;
  /** frames whose bottom-deviation exceeded JANK_PX while the phase expected anchoring */
  jankFrames: number;
  /** largest single-frame upward (negative) scrollTop jump — the visible "yank" */
  maxUpwardJump: number;
  /** deviation of the final frame of the phase */
  settleDeviation: number;
  atEndAtSettle: boolean;
  firstScrollTop: number;
  lastScrollTop: number;
}

const JANK_PX = 8;

class Recorder {
  samples: Sample[] = [];
  phases: PhaseMetrics[] = [];
  current: PhaseMetrics | null = null;
  private lastScrollTop = 0;

  markPhase(name: string) {
    this.finishPhase();
    this.current = {
      name,
      frames: 0,
      maxDeviation: 0,
      jankFrames: 0,
      maxUpwardJump: 0,
      settleDeviation: 0,
      atEndAtSettle: false,
      firstScrollTop: -1,
      lastScrollTop: -1,
    };
  }

  finishPhase() {
    if (this.current) {
      this.phases.push(this.current);
      this.current = null;
    }
  }

  record(s: Sample) {
    this.samples.push(s);
    if (this.samples.length > 20000) this.samples.shift();
    const p = this.current;
    if (p) {
      p.frames++;
      if (p.firstScrollTop < 0) p.firstScrollTop = s.scrollTop;
      p.lastScrollTop = s.scrollTop;
      if (s.deviation > p.maxDeviation) p.maxDeviation = s.deviation;
      if (s.deviation > JANK_PX) p.jankFrames++;
      const jump = this.lastScrollTop - s.scrollTop;
      if (jump > p.maxUpwardJump) p.maxUpwardJump = jump;
      p.settleDeviation = s.deviation;
      p.atEndAtSettle = s.atEnd;
    }
    this.lastScrollTop = s.scrollTop;
  }
}

// ---------------------------------------------------------------- app

declare global {
  interface Window {
    __spike: {
      ready: boolean;
      start: (opts?: { intervalMs?: number; seed?: number }) => void;
      stop: () => void;
      markPhase: (name: string) => void;
      finishPhase: () => void;
      phases: () => PhaseMetrics[];
      state: () => {
        atEnd: boolean;
        distanceFromEnd: number;
        scrollTop: number;
        scrollHeight: number;
        clientHeight: number;
        count: number;
        streaming: boolean;
        vTotalSize: number;
        vScrollOffset: number | null;
        vRectH: number;
        shimFollow: boolean;
      };
      scrollToEnd: () => void;
      options: () => Record<string, unknown>;
    };
  }
}

/**
 * ?shim=1 enables the follow-guard shim — the FE-3 fallback design.
 *
 * MEASURED FINDINGS driving it (virtual-core 3.17.3, as-shipped):
 *  1. SPONTANEOUS FOLLOW DROP: under token streaming where the TAIL item
 *     grows (extend-last — the canonical stream shape), a tail re-measure
 *     can leave deviation > scrollEndThreshold(1px). followOnAppend only
 *     re-engages when isAtEnd() at the next count-append; once past the
 *     threshold, follow is permanently dead — observed mid-stream with NO
 *     resize (st frozen at 376 while scrollHeight grew).
 *  2. RESIZE: the rect observer stores the new rect without any re-anchor
 *     path, so a height shrink or width rewrap releases the anchor too.
 *
 * The guard: the app owns the follow discipline. While follow-intent holds,
 * pin scrollTop to the bottom every frame (idempotent DOM write). Release
 * ONLY on user intent (wheel-up here; production adds touch + PageUp/Home).
 * Re-engage when the user returns to the bottom, or via jump-to-live.
 * The virtualizer is used purely for windowing/measurement.
 */
const SHIM_ENABLED = new URLSearchParams(location.search).get("shim") === "1";

function App() {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [state, dispatch] = useReducer(streamReducer, { lines: [] });
  const recorder = useRef(new Recorder());
  const streaming = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const nextId = useRef(0);
  const rng = useRef(mulberry32(0xa1bdef));
  /** app-owned follow discipline (shim mode) */
  const followIntent = useRef(true);

  const virtualizer: Virtualizer<HTMLDivElement, Element> = useVirtualizer({
    count: state.lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 26,
    overscan: 10,
    // The behavior under test (virtual-core >= 3.16):
    anchorTo: "end",
    followOnAppend: "instant",
  });

  const vRef = useRef(virtualizer);
  vRef.current = virtualizer;
  const linesRef = useRef(state.lines);
  linesRef.current = state.lines;

  // User-intent release: wheel-up releases the follow (production adds
  // touch-scroll and PageUp/Home). Event-driven — no rAF ordering races.
  useEffect(() => {
    if (!SHIM_ENABLED) return;
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) followIntent.current = false;
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // rAF sampling loop — one Sample per frame, always on. In shim mode it
  // also runs the follow-guard: while follow-intent holds, pin to bottom
  // with an idempotent DOM write (verified to stick; covers appends, tail
  // re-measures, AND container resizes uniformly). Re-engage when the user
  // has been back at the live edge for a SUSTAINED stretch — an instant
  // dev<=1 re-engage races the async application of the releasing wheel
  // scroll (measured: release + immediate re-engage + re-pin, the wheel
  // scroll never lands).
  const REENGAGE_FRAMES = 10;
  useEffect(() => {
    let raf = 0;
    let atBottomFrames = 0;
    const loop = () => {
      const el = scrollRef.current;
      if (el) {
        if (SHIM_ENABLED) {
          const dev = el.scrollHeight - el.clientHeight - el.scrollTop;
          if (followIntent.current) {
            if (dev > 1) el.scrollTop = el.scrollHeight - el.clientHeight;
            atBottomFrames = 0;
          } else {
            atBottomFrames = dev <= 1 ? atBottomFrames + 1 : 0;
            if (atBottomFrames >= REENGAGE_FRAMES) {
              followIntent.current = true; // user parked at the live edge
              atBottomFrames = 0;
            }
          }
        }
        const deviation = Math.max(
          0,
          el.scrollHeight - el.clientHeight - el.scrollTop,
        );
        const atEnd = vRef.current.isAtEnd();
        recorder.current.record({
          t: performance.now(),
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          deviation,
          atEnd,
          count: linesRef.current.length,
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // window.__spike control surface
  useEffect(() => {
    const rand = () => rng.current();
    const word = () => WORDS[Math.floor(rand() * WORDS.length)];
    const sentence = (n: number) =>
      Array.from({ length: n }, word).join(" ");
    const mkLine = (tag: string, words: number): Line => ({
      id: nextId.current++,
      tag,
      text: sentence(words),
    });

    window.__spike = {
      ready: true,
      start: (opts) => {
        if (streaming.current) return;
        if (opts?.seed !== undefined) rng.current = mulberry32(opts.seed);
        streaming.current = true;
        const interval = opts?.intervalMs ?? 40;
        timer.current = setInterval(() => {
          const r = rand();
          if (r < 0.55) {
            // token(s) appended to the tail line — the common streaming shape
            dispatch({ kind: "extend-last", extra: " " + sentence(1 + Math.floor(rand() * 3)) });
          } else if (r < 0.9) {
            // new line, variable length so measureElement stays busy
            dispatch({ kind: "append-line", line: mkLine("out", 3 + Math.floor(rand() * 40)) });
          } else {
            // tool-output burst — 5 lines at once
            dispatch({
              kind: "burst",
              lines: Array.from({ length: 5 }, () =>
                mkLine("tool", 2 + Math.floor(rand() * 25)),
              ),
            });
          }
        }, interval);
      },
      stop: () => {
        streaming.current = false;
        if (timer.current) clearInterval(timer.current);
        timer.current = null;
      },
      markPhase: (name) => recorder.current.markPhase(name),
      finishPhase: () => recorder.current.finishPhase(),
      phases: () => recorder.current.phases.concat(recorder.current.current ? [recorder.current.current] : []),
      state: () => {
        const el = scrollRef.current!;
        const v = vRef.current as unknown as {
          isAtEnd: () => boolean;
          getDistanceFromEnd: () => number;
          getTotalSize: () => number;
          scrollOffset: number | null;
          scrollRect: { width: number; height: number } | null;
        };
        return {
          atEnd: v.isAtEnd(),
          distanceFromEnd: v.getDistanceFromEnd(),
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          count: linesRef.current.length,
          streaming: streaming.current,
          // virtualizer internals (debug)
          vTotalSize: v.getTotalSize(),
          vScrollOffset: v.scrollOffset,
          vRectH: v.scrollRect?.height ?? -1,
          shimFollow: followIntent.current,
        };
      },
      scrollToEnd: () => {
        followIntent.current = true;
        vRef.current.scrollToEnd();
      },
      options: () => ({
        anchorTo: (vRef.current.options as Record<string, unknown>).anchorTo,
        followOnAppend: (vRef.current.options as Record<string, unknown>).followOnAppend,
        scrollEndThreshold: (vRef.current.options as Record<string, unknown>).scrollEndThreshold,
        shim: SHIM_ENABLED,
      }),
    };
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  const items = virtualizer.getVirtualItems();

  return (
    <>
      <div ref={scrollRef} className="scroller" data-testid="scroller">
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: "100%",
            position: "relative",
          }}
        >
          {items.map((vi) => {
            const line = state.lines[vi.index];
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                className="row"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                <span className="tag">[{line?.tag}#{line?.id}]</span>
                {line?.text}
              </div>
            );
          })}
        </div>
      </div>
      <button
        id="jump-live"
        onClick={() => {
          followIntent.current = true;
          virtualizer.scrollToEnd();
        }}
      >
        JUMP TO LIVE
      </button>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
