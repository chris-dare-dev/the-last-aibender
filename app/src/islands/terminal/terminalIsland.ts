/**
 * FE-3 terminal island — imperative, framework-free (blueprint §8).
 *
 * One island == one attended `pty.<sid>` session rendered by xterm 6:
 *
 *  - renderer selection per the SPIKE-A contract (renderer.ts — WebGL addon
 *    preferred, DOM fallback, context-loss degradation, re-run on reattach);
 *  - OUTPUT byte consumption from the FE-2 port (port.ts) through the
 *    offset tracker (streamTracker.ts): write-ordered, duplicate-dropping,
 *    gap → `pty-replay-request`;
 *  - acks ride the terminal's write-completion callback, coalesced one
 *    flush per animation frame — the broker's bounded ack buffer
 *    (ws-protocol.md §6) sees consumption, not receipt;
 *  - keystrokes → `sendInput`; fit-addon geometry → `sendResize` (clamped
 *    to the frozen 1..4096 range, deduplicated);
 *  - detach/reattach via the serialize addon: `detach()` returns the
 *    scrollback snapshot + consumed watermark; a reattach restores the
 *    snapshot, re-runs renderer selection (SPIKE-A clause 5) and requests
 *    wire replay from the watermark (`pty-replay-request` — legal because
 *    the island never acks beyond what it consumed).
 *
 * Everything DOM/xterm-shaped is injected through {@link TerminalIslandDeps}
 * so the discipline above is unit-testable in Node; `xtermDeps.ts` provides
 * the real implementations for the app bundle.
 */

import { PTY_MAX_COLS, PTY_MAX_ROWS } from '@aibender/protocol';
import type {
  AttachRendererOptions,
  RendererSelection,
  RendererTelemetryEvent,
  RendererTerminal,
} from './renderer.ts';
import type { PtyOutputChunk, TerminalPtyPort } from './port.ts';
import { OutputStreamTracker } from './streamTracker.ts';
import type { TerminalTokenTheme } from './theme.ts';

/** Minimal addon shape the island loads/disposes (fit, serialize, webgl). */
export interface IslandTerminalAddon {
  dispose(): void;
}

/** Structural slice of xterm's Terminal the island drives (fakeable). */
export interface IslandTerminal {
  open(parent: HTMLElement): void;
  loadAddon(addon: IslandTerminalAddon): void;
  write(data: string | Uint8Array, callback?: () => void): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onResize(listener: (size: { cols: number; rows: number }) => void): { dispose(): void };
  dispose(): void;
  readonly cols: number;
  readonly rows: number;
  readonly element?: HTMLElement | undefined;
}

export interface FitAddonLike extends IslandTerminalAddon {
  fit(): void;
}

export interface SerializeAddonLike extends IslandTerminalAddon {
  serialize(options?: { scrollback?: number }): string;
}

/** Options bag handed to the terminal factory (mirrors xterm ITerminalOptions subset). */
export interface TerminalInitOptions {
  readonly scrollback: number;
  readonly theme: TerminalTokenTheme['theme'];
  readonly fontFamily?: string;
  readonly fontSize?: number;
}

/** Injected environment — real implementations live in xtermDeps.ts. */
export interface TerminalIslandDeps {
  createTerminal(init: TerminalInitOptions): IslandTerminal;
  createFitAddon(): FitAddonLike;
  createSerializeAddon(): SerializeAddonLike;
  attachRenderer(term: RendererTerminal, opts: AttachRendererOptions): RendererSelection;
  readTheme(container: HTMLElement): TerminalTokenTheme;
  /** Ack coalescing tick (default rAF). One callback per scheduled flush. */
  scheduleFlush(callback: () => void): void;
  /** Container geometry watcher; returns cleanup (default ResizeObserver). */
  observeResize(target: HTMLElement, callback: () => void): () => void;
}

/** Everything needed to reattach elsewhere without byte loss. */
export interface TerminalDetachState {
  /** serialize-addon snapshot of buffer + scrollback (ANSI stream). */
  readonly snapshot: string;
  /** Consumed OUTPUT watermark at detach == the island's final ack. */
  readonly watermark: number;
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalIslandOptions {
  container: HTMLElement;
  port: TerminalPtyPort;
  deps: TerminalIslandDeps;
  /** SPIKE-A clause 1 override (settings/env). */
  forceDom?: boolean;
  /** Scrollback lines (default 10_000 — the spike-validated depth). */
  scrollback?: number;
  /** Reattach path: restore a prior `detach()` state. */
  restore?: TerminalDetachState;
  /** Fires when a runtime context loss degrades the renderer (clause 3). */
  onRendererChange?: (selection: RendererSelection) => void;
  /** SPIKE-A clause 7 telemetry hook (identifier-free [X2]). */
  onTelemetry?: (event: RendererTelemetryEvent) => void;
}

export interface TerminalIslandHandle {
  readonly term: IslandTerminal;
  readonly renderer: RendererSelection;
  /** Refit to the container (also wired to observeResize). */
  fit(): void;
  /** Send any pending ack immediately (used by detach; test-visible). */
  flushAck(): void;
  detach(): TerminalDetachState;
  dispose(): void;
}

const DEFAULT_SCROLLBACK = 10_000;

function clamp(value: number, max: number): number {
  return Math.min(Math.max(1, Math.round(value)), max);
}

export function createTerminalIsland(options: TerminalIslandOptions): TerminalIslandHandle {
  const { container, port, deps } = options;
  const scrollback = options.scrollback ?? DEFAULT_SCROLLBACK;
  const encoder = new TextEncoder();

  const tokenTheme = deps.readTheme(container);
  const init: TerminalInitOptions = {
    scrollback,
    theme: tokenTheme.theme,
    ...(tokenTheme.fontFamily !== undefined ? { fontFamily: tokenTheme.fontFamily } : {}), // token value from var(--ig-font-mono) via getComputedStyle (DESIGN.md §8.5)
    ...(tokenTheme.fontSize !== undefined ? { fontSize: tokenTheme.fontSize } : {}),
  };
  const term = deps.createTerminal(init);
  term.open(container);

  // SPIKE-A: renderer selection runs on every attach AND reattach (clause 5).
  const rendererOpts: AttachRendererOptions = {
    ...(options.forceDom !== undefined ? { forceDom: options.forceDom } : {}),
    onFallback: (selection) => options.onRendererChange?.(selection),
    ...(options.onTelemetry !== undefined ? { onTelemetry: options.onTelemetry } : {}),
  };
  const renderer = deps.attachRenderer(term, rendererOpts);

  const fitAddon = deps.createFitAddon();
  term.loadAddon(fitAddon);
  const serializeAddon = deps.createSerializeAddon();
  term.loadAddon(serializeAddon);

  const tracker = new OutputStreamTracker(options.restore?.watermark ?? 0);

  let disposed = false;
  let ackScheduled = false;

  const flushAck = (): void => {
    const watermark = tracker.takeAckWatermark();
    if (watermark !== null) port.sendAck(watermark);
  };

  const scheduleAck = (): void => {
    if (ackScheduled || disposed) return;
    ackScheduled = true;
    deps.scheduleFlush(() => {
      ackScheduled = false;
      if (disposed) return;
      flushAck();
    });
  };

  const handleChunk = (chunk: PtyOutputChunk): void => {
    if (disposed) return;
    const outcome = tracker.accept(chunk.streamOffset, chunk.bytes);
    if (outcome.action === 'write' && outcome.data !== undefined) {
      const end = chunk.streamOffset + chunk.bytes.byteLength;
      term.write(outcome.data, () => {
        tracker.markConsumed(end);
        scheduleAck();
      });
    } else if (outcome.action === 'gap' && outcome.replayFrom !== undefined) {
      port.requestReplay(outcome.replayFrom);
    }
  };
  const unsubscribeOutput = port.onOutput(handleChunk);

  // Input: keystrokes/paste → INPUT frames (the lib owns wire encoding).
  const dataSub = term.onData((data) => {
    if (!disposed) port.sendInput(encoder.encode(data));
  });

  // Geometry: fit-addon drives xterm; xterm's resize event drives the wire.
  let lastSentCols = -1;
  let lastSentRows = -1;
  const sendResize = (cols: number, rows: number): void => {
    const c = clamp(cols, PTY_MAX_COLS);
    const r = clamp(rows, PTY_MAX_ROWS);
    if (c === lastSentCols && r === lastSentRows) return;
    lastSentCols = c;
    lastSentRows = r;
    port.sendResize(c, r);
  };
  const resizeSub = term.onResize(({ cols, rows }) => sendResize(cols, rows));

  const fit = (): void => {
    if (disposed) return;
    try {
      fitAddon.fit();
    } catch {
      // A hidden/zero-size container mid-layout must never take the island down.
    }
  };
  const unobserveResize = deps.observeResize(container, fit);

  // Reattach path: restore scrollback locally, then ask the wire for what
  // arrived after our final ack (retained by contract — never below it).
  if (options.restore !== undefined) {
    term.write(options.restore.snapshot);
    port.requestReplay(options.restore.watermark);
  }

  // Initial geometry: fit to the container and tell the broker once.
  fit();
  sendResize(term.cols, term.rows);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    unsubscribeOutput();
    unobserveResize();
    dataSub.dispose();
    resizeSub.dispose();
    try {
      serializeAddon.dispose();
    } catch {
      /* addon already disposed by term teardown */
    }
    try {
      fitAddon.dispose();
    } catch {
      /* addon already disposed by term teardown */
    }
    try {
      renderer.webglAddon?.dispose();
    } catch {
      /* context-loss path already disposed it */
    }
    term.dispose();
  };

  const detach = (): TerminalDetachState => {
    // Final ack first so watermark == acked — replay-from is then legal by §6.
    flushAck();
    const state: TerminalDetachState = {
      snapshot: serializeAddon.serialize({ scrollback }),
      watermark: tracker.consumedOffset,
      cols: term.cols,
      rows: term.rows,
    };
    dispose();
    return state;
  };

  return {
    term,
    renderer,
    fit,
    flushAck,
    detach,
    dispose,
  };
}
