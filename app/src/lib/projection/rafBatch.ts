/**
 * rAF-batched projection — the mandatory streaming discipline (plan §5 FE
 * iron rules; blueprint §8): tokens/events land in a non-reactive buffer and
 * are projected into reactive stores AT MOST ONCE PER FRAME. Never per-token
 * React state; the render-count assertion test (plan §9.2 FE-2 edge) pins
 * this behavior.
 *
 * The frame scheduler is injectable so tests drive flushes deterministically
 * and non-browser environments degrade to a ~16 ms timeout.
 */

import { RingBuffer } from '../buffers/ringBuffer.ts';

/**
 * Schedules exactly one upcoming flush; returns a cancel function. The
 * projector re-arms itself after every flush while items keep arriving.
 */
export type FrameScheduler = (flush: () => void) => () => void;

/** requestAnimationFrame when present (WKWebView), else a 16 ms timer. */
export const defaultFrameScheduler: FrameScheduler = (flush) => {
  const g = globalThis as {
    requestAnimationFrame?: (cb: FrameRequestCallback) => number;
    cancelAnimationFrame?: (h: number) => void;
  };
  if (typeof g.requestAnimationFrame === 'function') {
    const handle = g.requestAnimationFrame(() => flush());
    return () => g.cancelAnimationFrame?.(handle);
  }
  const handle = setTimeout(flush, 16);
  return () => clearTimeout(handle);
};

export interface RafProjector<T> {
  /** Buffer one item (non-reactive — no store write happens here). */
  push(item: T): void;
  /** Synchronous flush (used on dispose and by tests). */
  flushNow(): void;
  /** Buffered-but-unflushed item count. */
  readonly pending: number;
  /** Total flush callbacks executed (assertable: store writes ≤ flushes). */
  readonly flushCount: number;
  /** Items evicted because the buffer cap was reached between frames. */
  readonly droppedCount: number;
  dispose(): void;
}

export interface RafProjectorOptions<T> {
  /** Receives the whole frame batch — implementations do ONE store write. */
  onFlush(batch: readonly T[]): void;
  schedule?: FrameScheduler;
  /**
   * Buffer cap between frames (drop-oldest beyond it). Sized for pathological
   * streams; at normal token rates a frame batch is tens of items.
   */
  capacity?: number;
}

export function createRafProjector<T>(options: RafProjectorOptions<T>): RafProjector<T> {
  const schedule = options.schedule ?? defaultFrameScheduler;
  const buffer = new RingBuffer<T>(options.capacity ?? 4096);
  let cancel: (() => void) | undefined;
  let disposed = false;
  let flushes = 0;

  const flush = (): void => {
    cancel = undefined;
    if (buffer.size === 0) return;
    const batch = buffer.drain();
    flushes += 1;
    options.onFlush(batch);
  };

  return {
    push(item: T): void {
      if (disposed) return;
      buffer.push(item);
      cancel ??= schedule(flush);
    },
    flushNow(): void {
      cancel?.();
      cancel = undefined;
      flush();
    },
    get pending(): number {
      return buffer.size;
    },
    get flushCount(): number {
      return flushes;
    },
    get droppedCount(): number {
      return buffer.droppedCount;
    },
    dispose(): void {
      if (disposed) return;
      this.flushNow();
      disposed = true;
    },
  };
}
