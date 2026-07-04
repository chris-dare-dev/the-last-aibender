/**
 * Follow-guard unit coverage — the SPIKE-C discipline with a fake element
 * and a manual frame scheduler (the browser-truth pass with real resizes and
 * wheel events is pw/run-pw.ts). Rows per plan §9.2 FE-3: positive
 * (end-anchor holds during stream), edge (release on scroll-up, jump to
 * live, sustained-bottom re-engage).
 */

import { describe, expect, it } from 'vitest';
import {
  createFollowGuard,
  type FollowGuardElement,
  type FrameScheduler,
} from './followGuard.ts';

type Listener = (event: unknown) => void;

class FakeElement implements FollowGuardElement {
  scrollTop = 0;
  scrollHeight = 1000;
  clientHeight = 400;
  listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: (event: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener as Listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener as Listener);
  }

  fire(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  get deviation(): number {
    return this.scrollHeight - this.clientHeight - this.scrollTop;
  }
}

class ManualScheduler implements FrameScheduler {
  private next = 1;
  private queue = new Map<number, () => void>();

  request(callback: () => void): number {
    const handle = this.next++;
    this.queue.set(handle, callback);
    return handle;
  }

  cancel(handle: number): void {
    this.queue.delete(handle);
  }

  tick(frames = 1): void {
    for (let i = 0; i < frames; i += 1) {
      const pending = [...this.queue.entries()];
      this.queue.clear();
      for (const [, cb] of pending) cb();
    }
  }

  get pendingCount(): number {
    return this.queue.size;
  }
}

function rig(options: { reengageFrames?: number } = {}) {
  const el = new FakeElement();
  const scheduler = new ManualScheduler();
  const changes: boolean[] = [];
  const guard = createFollowGuard(el, {
    scheduler,
    onFollowChange: (f) => changes.push(f),
    ...(options.reengageFrames !== undefined ? { reengageFrames: options.reengageFrames } : {}),
  });
  return { el, scheduler, guard, changes };
}

describe('createFollowGuard (SPIKE-C discipline)', () => {
  it('pins to the bottom once per frame while following (idempotent write)', () => {
    const { el, scheduler, guard } = rig();
    expect(guard.following).toBe(true);
    el.scrollTop = 100; // content grew / tail re-measured
    scheduler.tick();
    expect(el.scrollTop).toBe(600); // scrollHeight - clientHeight
    el.scrollHeight = 1400; // stream appends
    scheduler.tick();
    expect(el.scrollTop).toBe(1000);
    scheduler.tick(); // already pinned — no further movement
    expect(el.scrollTop).toBe(1000);
  });

  it('pins across a container resize (the uniform-path property)', () => {
    const { el, scheduler } = rig();
    scheduler.tick();
    el.clientHeight = 200; // height shrink — the measured raw-mode killer
    scheduler.tick();
    expect(el.deviation).toBe(0);
    el.clientHeight = 700; // grow
    el.scrollTop = 250;
    scheduler.tick();
    expect(el.deviation).toBe(0);
  });

  it('releases ONLY on wheel-up; wheel-down never releases', () => {
    const { el, scheduler, guard, changes } = rig();
    el.fire('wheel', { deltaY: 120 });
    expect(guard.following).toBe(true);
    el.fire('wheel', { deltaY: -1 });
    expect(guard.following).toBe(false);
    expect(changes).toEqual([false]);
    // while released, frames must NOT pin (0 drift while reading scrollback)
    el.scrollTop = 100;
    el.scrollHeight = 5000; // stream keeps appending below
    scheduler.tick(5);
    expect(el.scrollTop).toBe(100);
  });

  it('releases on PageUp/Home/ArrowUp, not on other keys', () => {
    for (const key of ['PageUp', 'Home', 'ArrowUp']) {
      const { el, guard } = rig();
      el.fire('keydown', { key: 'Enter' });
      expect(guard.following).toBe(true);
      el.fire('keydown', { key });
      expect(guard.following, key).toBe(false);
    }
  });

  it('releases on touch scroll', () => {
    const { el, guard } = rig();
    el.fire('touchmove', {});
    expect(guard.following).toBe(false);
  });

  it('re-engages only after a SUSTAINED stretch at the live edge (10 frames)', () => {
    const { el, scheduler, guard, changes } = rig();
    el.fire('wheel', { deltaY: -1 });
    expect(guard.following).toBe(false);

    // user scrolls back to the bottom
    el.scrollTop = el.scrollHeight - el.clientHeight;
    scheduler.tick(9);
    expect(guard.following).toBe(false); // 9 frames is not enough (races the wheel)
    scheduler.tick(1);
    expect(guard.following).toBe(true);
    expect(changes).toEqual([false, true]);
  });

  it('an interrupted at-bottom streak resets the re-engage counter', () => {
    const { el, scheduler, guard } = rig();
    el.fire('wheel', { deltaY: -1 });
    el.scrollTop = el.scrollHeight - el.clientHeight;
    scheduler.tick(5);
    el.scrollTop -= 300; // user moves away again
    scheduler.tick(1);
    el.scrollTop = el.scrollHeight - el.clientHeight;
    scheduler.tick(9);
    expect(guard.following).toBe(false); // streak restarted — 9 < 10
    scheduler.tick(1);
    expect(guard.following).toBe(true);
  });

  it('jumpToLive re-engages and pins immediately', () => {
    const { el, guard, changes } = rig();
    el.fire('wheel', { deltaY: -1 });
    el.scrollTop = 0;
    el.scrollHeight = 3000;
    guard.jumpToLive();
    expect(guard.following).toBe(true);
    expect(el.scrollTop).toBe(3000 - el.clientHeight);
    expect(changes).toEqual([false, true]);
  });

  it('dispose stops the loop and removes listeners', () => {
    const { el, scheduler, guard } = rig();
    guard.dispose();
    guard.dispose(); // idempotent
    expect(scheduler.pendingCount).toBe(0);
    el.fire('wheel', { deltaY: -1 });
    expect(guard.following).toBe(true); // listener removed — no release
    el.scrollTop = 0;
    scheduler.tick(3);
    expect(el.scrollTop).toBe(0); // no pin after dispose
  });
});
