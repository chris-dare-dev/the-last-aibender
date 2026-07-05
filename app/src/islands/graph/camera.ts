/**
 * FE-4 camera controller — the sanctioned fly-to (DESIGN.md §3.4
 * `camera-ease`), driven by vanilla Motion `animate()` THROUGH the
 * {@link GraphRenderer} contract: the controller tweens a plain pose object
 * and pushes each frame via `renderer.setCamera`; the renderer only applies
 * transforms. No animation library ever enters the render hot path.
 *
 *  - duration + easing come from the tokens (§3.4: 320 ms, mechanical
 *    ease-out — never a spring);
 *  - the camera moves ONLY on explicit navigation calls (focus node /
 *    fit-to-selection) — data updates never move it;
 *  - REDUCED MOTION (token duration 0 or the island toggle): no fly-to; a
 *    jump cut to the target framing (plan §9.2 FE-4 edge row: the
 *    reduced-motion path skips fly-to).
 */

import { animate } from 'motion';
import type { CameraPose, GraphRenderer } from './types.ts';

export interface CameraController {
  /** Ease to the pose (or jump-cut under reduced motion). */
  flyTo(target: CameraPose): void;
  /** Cancel any in-flight ease (the pose freezes where it is). */
  stop(): void;
  setReducedMotion(reduced: boolean): void;
  /** Fly-to invocations that ANIMATED (assertable in tests). */
  readonly animatedMoves: number;
  /** Fly-to invocations that jump-cut (reduced motion). */
  readonly jumpCuts: number;
}

export interface CameraControllerOptions {
  /** Token-derived duration (ms). 0 ⇒ every move is a jump cut. */
  durationMs: number;
  /** Token-derived cubic-bezier points; absent ⇒ Motion's default ease. */
  ease?: readonly [number, number, number, number];
  reducedMotion?: boolean;
}

export function createCameraController(
  renderer: Pick<GraphRenderer, 'setCamera' | 'camera'>,
  options: CameraControllerOptions,
): CameraController {
  let reduced = options.reducedMotion ?? false;
  let controls: { stop(): void } | undefined;
  let animatedMoves = 0;
  let jumpCuts = 0;

  return {
    get animatedMoves(): number {
      return animatedMoves;
    },
    get jumpCuts(): number {
      return jumpCuts;
    },

    flyTo(target: CameraPose): void {
      controls?.stop();
      controls = undefined;

      if (reduced || options.durationMs <= 0) {
        jumpCuts += 1;
        renderer.setCamera(target);
        return;
      }

      animatedMoves += 1;
      const pose = { ...renderer.camera };
      controls = animate(
        pose,
        { x: target.x, y: target.y, scale: target.scale },
        {
          duration: options.durationMs / 1000,
          ...(options.ease !== undefined
            ? { ease: options.ease as [number, number, number, number] }
            : {}),
          onUpdate: () => {
            renderer.setCamera({ x: pose.x, y: pose.y, scale: pose.scale });
          },
          // Motion applies the terminal keyframe without a final onUpdate —
          // land the EXACT target pose or the fly-to stops ~1 frame short.
          onComplete: () => {
            renderer.setCamera({ x: target.x, y: target.y, scale: target.scale });
          },
        },
      );
    },

    stop(): void {
      controls?.stop();
      controls = undefined;
    },

    setReducedMotion(next: boolean): void {
      reduced = next;
      if (next) {
        controls?.stop();
        controls = undefined;
      }
    },
  };
}
