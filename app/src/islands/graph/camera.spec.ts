// @vitest-environment jsdom
/**
 * FE-4 camera controller — Motion `animate()` THROUGH the renderer contract
 * (plan §9.2 FE-4 edge row: "reduced-motion path skips fly-to").
 *
 * The animated path drives real Motion frames (jsdom pretends to be visual,
 * so rAF exists); assertions poll the pose rather than pinning frame counts.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { CameraPose } from './types.ts';

// Defensive: some DOM environments omit rAF — Motion needs a frame source.
beforeAll(() => {
  const g = globalThis as {
    requestAnimationFrame?: (cb: (t: number) => void) => number;
    cancelAnimationFrame?: (h: number) => void;
  };
  if (typeof g.requestAnimationFrame !== 'function') {
    g.requestAnimationFrame = (cb) =>
      setTimeout(() => cb(performance.now()), 16) as unknown as number;
    g.cancelAnimationFrame = (h) => clearTimeout(h as unknown as NodeJS.Timeout);
  }
});

function fakeRenderer() {
  const calls: CameraPose[] = [];
  let pose: CameraPose = { x: 0, y: 0, scale: 1 };
  return {
    calls,
    setCamera(next: CameraPose): void {
      pose = next;
      calls.push(next);
    },
    get camera(): CameraPose {
      return pose;
    },
  };
}

const closeTo = (a: CameraPose, b: CameraPose, eps = 0.5): boolean =>
  Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.scale - b.scale) < eps;

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for camera predicate');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('camera controller', () => {
  it('jump-cuts under reduced motion (no tween, exactly one pose write)', async () => {
    const { createCameraController } = await import('./camera.ts');
    const renderer = fakeRenderer();
    const camera = createCameraController(renderer, { durationMs: 320, reducedMotion: true });
    camera.flyTo({ x: 100, y: 50, scale: 2 });
    expect(renderer.calls).toEqual([{ x: 100, y: 50, scale: 2 }]);
    expect(camera.jumpCuts).toBe(1);
    expect(camera.animatedMoves).toBe(0);
  });

  it('jump-cuts when the token duration is 0 (the reduced-motion CSS remap)', async () => {
    const { createCameraController } = await import('./camera.ts');
    const renderer = fakeRenderer();
    const camera = createCameraController(renderer, { durationMs: 0 });
    camera.flyTo({ x: -8, y: 4, scale: 1.5 });
    expect(renderer.calls).toHaveLength(1);
    expect(camera.jumpCuts).toBe(1);
  });

  it('eases to the target through MULTIPLE renderer pose writes', async () => {
    const { createCameraController } = await import('./camera.ts');
    const renderer = fakeRenderer();
    const camera = createCameraController(renderer, {
      durationMs: 80,
      ease: [0.2, 0, 0, 1],
    });
    const target = { x: 200, y: -100, scale: 3 };
    camera.flyTo(target);
    expect(camera.animatedMoves).toBe(1);
    await until(() => closeTo(renderer.camera, target));
    expect(renderer.calls.length).toBeGreaterThan(1); // a tween, not a teleport
  });

  it('stop freezes the pose mid-flight', async () => {
    const { createCameraController } = await import('./camera.ts');
    const renderer = fakeRenderer();
    const camera = createCameraController(renderer, { durationMs: 30_000 });
    camera.flyTo({ x: 1000, y: 0, scale: 1 });
    await until(() => renderer.calls.length >= 1);
    camera.stop();
    const frozen = renderer.calls.length;
    await new Promise((r) => setTimeout(r, 120));
    expect(renderer.calls.length).toBe(frozen);
    expect(renderer.camera.x).toBeLessThan(1000); // never reached the target
  });

  it('setReducedMotion(true) cancels in-flight moves and future ones jump-cut', async () => {
    const { createCameraController } = await import('./camera.ts');
    const renderer = fakeRenderer();
    const camera = createCameraController(renderer, { durationMs: 30_000 });
    camera.flyTo({ x: 1000, y: 0, scale: 1 });
    camera.setReducedMotion(true);
    const frozen = renderer.calls.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(renderer.calls.length).toBe(frozen);
    camera.flyTo({ x: 5, y: 5, scale: 1 });
    expect(renderer.camera).toEqual({ x: 5, y: 5, scale: 1 });
    expect(camera.jumpCuts).toBe(1);
  });
});
