/**
 * FE-3 terminal island — in-page Playwright harness (component test body).
 *
 * Mounts the REAL island (real xterm 6, real webgl/fit/serialize addons, the
 * real attachRenderer) against an in-page fake of the FE-2 PTY port. OUTPUT
 * bytes travel through the real frozen codec (encodePtyFrame → decodePtyFrame
 * round-trip) so the wire path is exercised, and the golden binary corpus
 * (packages/testkit) is feedable by fixture name.
 *
 * All content is SYNTHESIZED [X2]. The driver (run-pw.ts) asserts through
 * window.__fe3term.
 */

import '@xterm/xterm/css/xterm.css';
import '../../../chrome/theme/tokens.css';
import { decodePtyFrame, encodePtyFrame } from '@aibender/protocol';
import { GOLDEN_WS_FIXTURES, goldenFrameBytes } from '@aibender/testkit';
import { mountTerminalIsland } from '../xtermDeps.ts';
import type { PtyOutputChunk, TerminalPtyPort } from '../port.ts';
import type { RendererTelemetryEvent } from '../renderer.ts';
import type { TerminalDetachState, TerminalIslandHandle } from '../terminalIsland.ts';

const SESSION_ID = 'ses_fake_1';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(`rejection: ${String(e.reason)}`));

class FakePort implements TerminalPtyPort {
  readonly sessionId = SESSION_ID;
  listeners: Array<(chunk: PtyOutputChunk) => void> = [];
  acks: number[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  replays: number[] = [];
  inputs: string[] = [];
  /** Next OUTPUT offset for sequential feeds. */
  nextOffset = 0;

  onOutput(listener: (chunk: PtyOutputChunk) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  sendInput(bytes: Uint8Array): void {
    this.inputs.push(decoder.decode(bytes));
  }

  sendAck(watermark: number): void {
    this.acks.push(watermark);
  }

  sendResize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  requestReplay(fromWatermark: number): void {
    this.replays.push(fromWatermark);
  }

  /** Feed OUTPUT text through the REAL frozen codec round-trip. */
  feedAt(streamOffset: number, text: string): void {
    const wire = encodePtyFrame({
      type: 'output',
      sessionId: SESSION_ID,
      streamOffset,
      payload: encoder.encode(text),
    });
    const decoded = decodePtyFrame(wire);
    if (!decoded.ok) throw new Error(`harness codec round-trip failed: ${decoded.message}`);
    const chunk: PtyOutputChunk = {
      streamOffset: decoded.value.streamOffset,
      bytes: decoded.value.payload,
    };
    for (const listener of [...this.listeners]) listener(chunk);
  }

  feed(text: string): void {
    const offset = this.nextOffset;
    this.nextOffset += encoder.encode(text).byteLength;
    this.feedAt(offset, text);
  }
}

interface HarnessState {
  port: FakePort;
  island: TerminalIslandHandle | null;
  attachCount: number;
  fallbacks: number;
  telemetry: RendererTelemetryEvent[];
  detachState: TerminalDetachState | null;
}

const state: HarnessState = {
  port: new FakePort(),
  island: null,
  attachCount: 0,
  fallbacks: 0,
  telemetry: [],
  detachState: null,
};

function stage(): HTMLElement {
  return document.getElementById('stage') as HTMLElement;
}

/** Access the real xterm buffer through the structural island handle. */
interface BufferTerminal {
  readonly element?: HTMLElement;
  readonly buffer: {
    readonly active: {
      readonly length: number;
      getLine(i: number): { translateToString(trim: boolean): string } | undefined;
    };
  };
}

function bufferTerm(): BufferTerminal | null {
  return state.island === null ? null : (state.island.term as unknown as BufferTerminal);
}

function boot(opts: { forceDom?: boolean; restore?: TerminalDetachState } = {}): unknown {
  if (state.island !== null) {
    state.island.dispose();
    state.island = null;
  }
  const container = stage();
  container.innerHTML = '';
  state.island = mountTerminalIsland({
    container,
    port: state.port,
    ...(opts.forceDom !== undefined ? { forceDom: opts.forceDom } : {}),
    ...(opts.restore !== undefined ? { restore: opts.restore } : {}),
    onRendererChange: () => {
      state.fallbacks += 1;
    },
    onTelemetry: (event) => {
      state.telemetry.push(event);
    },
  });
  state.attachCount += 1;
  return snapshot();
}

function snapshot(): Record<string, unknown> {
  const island = state.island;
  const term = bufferTerm();
  const el = term?.element ?? null;
  const rows = el?.querySelector('.xterm-rows') ?? null;
  const addon = island?.renderer.webglAddon as { textureAtlas?: unknown } | null | undefined;
  return {
    rendererMode: island?.renderer.mode ?? 'none',
    rendererReason: island?.renderer.reason ?? 'none',
    canvasCount: el === null ? -1 : el.querySelectorAll('canvas').length,
    domRowsCount: rows === null ? -1 : rows.childElementCount,
    textureAtlasPresent: addon?.textureAtlas != null,
    bufferLines: term?.buffer.active.length ?? -1,
    cols: (island?.term.cols as number | undefined) ?? -1,
    rows: (island?.term.rows as number | undefined) ?? -1,
    attachCount: state.attachCount,
    fallbacks: state.fallbacks,
    telemetry: state.telemetry,
    acks: [...state.port.acks],
    resizes: [...state.port.resizes],
    replays: [...state.port.replays],
    inputs: [...state.port.inputs],
    nextOffset: state.port.nextOffset,
    errors: [...errors],
  };
}

/** Text of the last `maxLines` buffer lines (right-trimmed, joined by \n). */
function bufferText(maxLines = 500): string {
  const term = bufferTerm();
  if (term === null) return '';
  const buf = term.buffer.active;
  const start = Math.max(0, buf.length - maxLines);
  const lines: string[] = [];
  for (let i = start; i < buf.length; i += 1) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  }
  return lines.join('\n');
}

/** Deterministic synthetic ANSI lines (SGR-colored) [X2]. */
function feedLines(count: number, tag = 'line'): void {
  const colors = [31, 32, 33, 34, 35, 36, 37, 90, 92, 94];
  let chunk = '';
  for (let i = 0; i < count; i += 1) {
    const c = colors[i % colors.length];
    chunk += `\u001b[${c}m[${tag}-${String(i).padStart(5, '0')}]\u001b[0m synthesized stream payload\r\n`;
  }
  state.port.feed(chunk);
}

/** Simulated context loss on every canvas in the terminal (spike-a method). */
function simulateContextLoss(): { attempted: boolean } {
  const el = bufferTerm()?.element;
  if (el == null) return { attempted: false };
  let attempted = false;
  for (const canvas of Array.from(el.querySelectorAll('canvas'))) {
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    const ext = gl?.getExtension('WEBGL_lose_context');
    if (ext) {
      ext.loseContext();
      attempted = true;
    }
  }
  return { attempted };
}

function detachReattach(opts: { forceDom?: boolean } = {}): unknown {
  if (state.island === null) throw new Error('boot() first');
  const detached = state.island.detach();
  state.island = null;
  state.detachState = detached;
  return boot({ restore: detached, ...(opts.forceDom !== undefined ? { forceDom: opts.forceDom } : {}) });
}

function feedGolden(name: string): void {
  const fixture = GOLDEN_WS_FIXTURES.find((f) => f.name === name);
  if (fixture === undefined || fixture.kind !== 'binary') {
    throw new Error(`no golden binary fixture named ${name}`);
  }
  const decoded = decodePtyFrame(goldenFrameBytes(fixture));
  if (!decoded.ok) throw new Error(`golden fixture ${name} did not decode: ${decoded.message}`);
  if (decoded.value.type !== 'output') throw new Error(`golden fixture ${name} is not OUTPUT`);
  const chunk: PtyOutputChunk = {
    streamOffset: decoded.value.streamOffset,
    bytes: decoded.value.payload,
  };
  state.port.nextOffset = Math.max(
    state.port.nextOffset,
    decoded.value.streamOffset + decoded.value.payload.byteLength,
  );
  for (const listener of [...state.port.listeners]) listener(chunk);
}

function resizeStage(width: number, height: number): void {
  const el = stage();
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
}

declare global {
  interface Window {
    __fe3term: {
      ready: boolean;
      boot: typeof boot;
      snapshot: typeof snapshot;
      bufferText: typeof bufferText;
      feed: (text: string) => void;
      feedAt: (offset: number, text: string) => void;
      feedLines: typeof feedLines;
      feedGolden: typeof feedGolden;
      simulateContextLoss: typeof simulateContextLoss;
      detachReattach: typeof detachReattach;
      resizeStage: typeof resizeStage;
      fit: () => void;
    };
  }
}

window.__fe3term = {
  ready: true,
  boot,
  snapshot,
  bufferText,
  feed: (text) => state.port.feed(text),
  feedAt: (offset, text) => state.port.feedAt(offset, text),
  feedLines,
  feedGolden,
  simulateContextLoss,
  detachReattach,
  resizeStage,
  fit: () => state.island?.fit(),
};
