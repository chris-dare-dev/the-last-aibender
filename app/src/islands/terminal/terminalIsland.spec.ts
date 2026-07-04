/**
 * Terminal island discipline — unit coverage with injected fakes (no DOM,
 * no xterm): output→write→ack chain, gap→replay, input encoding, resize
 * clamp/dedupe, detach/reattach watermark semantics, dispose idempotence.
 * The real-browser behavior (renderer chain, serialize scrollback fidelity)
 * is pw/run-pw.ts territory.
 */

import { describe, expect, it } from 'vitest';
import { PTY_MAX_COLS, PTY_MAX_ROWS } from '@aibender/protocol';
import type { PtyOutputChunk, TerminalPtyPort } from './port.ts';
import type { RendererSelection } from './renderer.ts';
import {
  createTerminalIsland,
  type IslandTerminal,
  type TerminalIslandDeps,
  type TerminalIslandOptions,
} from './terminalIsland.ts';

// ---------------------------------------------------------------- fakes

class FakePort implements TerminalPtyPort {
  readonly sessionId = 'ses_fake_1';
  listeners: Array<(chunk: PtyOutputChunk) => void> = [];
  inputs: Uint8Array[] = [];
  acks: number[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  replays: number[] = [];
  unsubscribed = 0;

  onOutput(listener: (chunk: PtyOutputChunk) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.unsubscribed += 1;
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  emit(streamOffset: number, textValue: string): void {
    const bytes = new TextEncoder().encode(textValue);
    for (const l of [...this.listeners]) l({ streamOffset, bytes });
  }

  sendInput(bytes: Uint8Array): void {
    this.inputs.push(bytes);
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
}

class FakeTerm implements IslandTerminal {
  writes: Array<string | Uint8Array> = [];
  cols = 80;
  rows = 24;
  disposed = 0;
  opened: unknown = null;
  loadedAddons: unknown[] = [];
  private dataListeners: Array<(data: string) => void> = [];
  private resizeListeners: Array<(size: { cols: number; rows: number }) => void> = [];
  /** When set, write callbacks are queued instead of firing synchronously. */
  deferWrites = false;
  pendingCallbacks: Array<() => void> = [];

  open(parent: HTMLElement): void {
    this.opened = parent;
  }

  loadAddon(addon: { dispose(): void }): void {
    this.loadedAddons.push(addon);
  }

  write(data: string | Uint8Array, callback?: () => void): void {
    this.writes.push(data);
    if (callback === undefined) return;
    if (this.deferWrites) this.pendingCallbacks.push(callback);
    else callback();
  }

  flushWrites(): void {
    const pending = this.pendingCallbacks;
    this.pendingCallbacks = [];
    for (const cb of pending) cb();
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.push(listener);
    return { dispose: () => undefined };
  }

  fireData(data: string): void {
    for (const l of this.dataListeners) l(data);
  }

  onResize(listener: (size: { cols: number; rows: number }) => void): { dispose(): void } {
    this.resizeListeners.push(listener);
    return { dispose: () => undefined };
  }

  fireResize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    for (const l of this.resizeListeners) l({ cols, rows });
  }

  dispose(): void {
    this.disposed += 1;
  }
}

interface Rig {
  port: FakePort;
  term: FakeTerm;
  deps: TerminalIslandDeps;
  flushQueue: Array<() => void>;
  runFlushes(): void;
  serializeOutput: string;
}

function makeRig(overrides: { serializeOutput?: string } = {}): Rig {
  const port = new FakePort();
  const term = new FakeTerm();
  const flushQueue: Array<() => void> = [];
  const serializeOutput = overrides.serializeOutput ?? 'SNAPSHOT';
  const deps: TerminalIslandDeps = {
    createTerminal: () => term,
    createFitAddon: () => ({ fit: () => undefined, dispose: () => undefined }),
    createSerializeAddon: () => ({ serialize: () => serializeOutput, dispose: () => undefined }),
    attachRenderer: (): RendererSelection => ({
      mode: 'dom',
      reason: 'forced-dom',
      webglAddon: null,
    }),
    readTheme: () => ({ theme: {} }),
    scheduleFlush: (cb) => flushQueue.push(cb),
    observeResize: () => () => undefined,
  };
  return {
    port,
    term,
    deps,
    flushQueue,
    runFlushes(): void {
      while (flushQueue.length > 0) (flushQueue.shift() as () => void)();
    },
    serializeOutput,
  };
}

const container = {} as HTMLElement;

function mount(rig: Rig, extra: Partial<TerminalIslandOptions> = {}) {
  return createTerminalIsland({ container, port: rig.port, deps: rig.deps, ...extra });
}

const utf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

// ---------------------------------------------------------------- tests

describe('createTerminalIsland', () => {
  it('writes in-order output and acks the consumed watermark once per flush', () => {
    const rig = makeRig();
    mount(rig);
    rig.port.emit(0, 'hello ');
    rig.port.emit(6, 'world');
    expect(rig.term.writes.filter((w) => typeof w !== 'string')).toHaveLength(2);
    expect(rig.port.acks).toEqual([]); // coalesced — nothing before the flush tick
    rig.runFlushes();
    expect(rig.port.acks).toEqual([11]); // ONE ack for both writes
  });

  it('acks track write completion, not receipt (slow renderer)', () => {
    const rig = makeRig();
    mount(rig);
    rig.term.deferWrites = true;
    rig.port.emit(0, 'abc');
    rig.runFlushes();
    expect(rig.port.acks).toEqual([]); // nothing consumed yet
    rig.term.flushWrites();
    rig.runFlushes();
    expect(rig.port.acks).toEqual([3]);
  });

  it('requests replay exactly once on a gap and never writes future bytes', () => {
    const rig = makeRig();
    mount(rig);
    rig.port.emit(0, 'abc');
    const writesBefore = rig.term.writes.length;
    rig.port.emit(100, 'FUTURE');
    rig.port.emit(106, 'MORE');
    expect(rig.term.writes.length).toBe(writesBefore); // order never corrupted
    expect(rig.port.replays).toEqual([3]); // one outstanding request per gap
  });

  it('drops duplicates silently (replay overshoot)', () => {
    const rig = makeRig();
    mount(rig);
    rig.port.emit(0, 'abcdef');
    const writesBefore = rig.term.writes.length;
    rig.port.emit(0, 'abcdef');
    rig.port.emit(2, 'cd');
    expect(rig.term.writes.length).toBe(writesBefore);
    expect(rig.port.replays).toEqual([]);
  });

  it('encodes keystrokes to UTF-8 INPUT bytes', () => {
    const rig = makeRig();
    mount(rig);
    rig.term.fireData('ls\n');
    expect(rig.port.inputs).toHaveLength(1);
    expect(utf8(rig.port.inputs[0] as Uint8Array)).toBe('ls\n');
  });

  it('sends resize on geometry change, clamped to the frozen 1..4096 range, deduplicated', () => {
    const rig = makeRig();
    mount(rig);
    expect(rig.port.resizes).toEqual([{ cols: 80, rows: 24 }]); // initial announce
    rig.term.fireResize(120, 40);
    rig.term.fireResize(120, 40); // no change → no send
    expect(rig.port.resizes).toEqual([
      { cols: 80, rows: 24 },
      { cols: 120, rows: 40 },
    ]);
    rig.term.fireResize(999_999, 0);
    expect(rig.port.resizes.at(-1)).toEqual({ cols: PTY_MAX_COLS, rows: 1 });
    expect(PTY_MAX_ROWS).toBe(4096); // frozen constant sanity
  });

  it('detach flushes the final ack and returns snapshot + consumed watermark', () => {
    const rig = makeRig({ serializeOutput: 'SCROLLBACK-SNAPSHOT' });
    const island = mount(rig);
    rig.port.emit(0, 'hello world');
    const state = island.detach();
    expect(state.snapshot).toBe('SCROLLBACK-SNAPSHOT');
    expect(state.watermark).toBe(11);
    expect(state.cols).toBe(80);
    expect(state.rows).toBe(24);
    expect(rig.port.acks).toEqual([11]); // final ack flushed synchronously
    expect(rig.term.disposed).toBe(1);
    expect(rig.port.unsubscribed).toBe(1);
  });

  it('reattach restores the snapshot, replays from the watermark, and continues the offset axis', () => {
    const rig = makeRig();
    mount(rig, {
      restore: { snapshot: 'SNAP', watermark: 11, cols: 80, rows: 24 },
    });
    expect(rig.term.writes[0]).toBe('SNAP'); // scrollback restored FIRST
    expect(rig.port.replays).toEqual([11]);

    rig.port.emit(0, 'hello world'); // pre-watermark replay overshoot → dropped
    const writesBefore = rig.term.writes.length;
    expect(writesBefore).toBe(1);
    rig.port.emit(11, '!'); // post-watermark bytes land
    expect(rig.term.writes.length).toBe(2);
    rig.runFlushes();
    expect(rig.port.acks).toEqual([12]);
  });

  it('dispose is idempotent and stops output/ack processing', () => {
    const rig = makeRig();
    const island = mount(rig);
    island.dispose();
    island.dispose();
    expect(rig.term.disposed).toBe(1);
    rig.port.emit(0, 'late'); // listener already unsubscribed
    rig.runFlushes();
    expect(rig.port.acks).toEqual([]);
  });

  it('surfaces the renderer selection from attachRenderer on the handle', () => {
    const rig = makeRig();
    const island = mount(rig);
    expect(island.renderer).toEqual({ mode: 'dom', reason: 'forced-dom', webglAddon: null });
  });
});
