/**
 * FE-3 follow-guard — the SPIKE-C (v) verdict, ported from the measured
 * shim in spikes/virtual-term/src/main.tsx (docs/spikes/spike-c-virtual-term.md).
 *
 * Measured findings this guard exists for (virtual-core 3.17.3 as-shipped):
 *  1. SPONTANEOUS FOLLOW DROP under plain streaming: a tail-item re-measure
 *     leaves deviation past `scrollEndThreshold` (1 px) between appends;
 *     `followOnAppend` then never re-engages — follow is permanently dead.
 *  2. NO RESIZE RETENTION PATH: the rect observer stores the new rect and
 *     nothing re-anchors.
 *
 * Normative design (spike verdict, measured 0 px deviation / 0 jank frames
 * in Chromium AND WebKit):
 *  - the APP owns follow discipline; the virtualizer is windowing only;
 *  - while follow-intent holds, pin `scrollTop = scrollHeight - clientHeight`
 *    once per rAF (idempotent DOM write — covers appends, tail re-measures
 *    AND container resizes uniformly);
 *  - release ONLY on user intent: wheel-up, touch scroll, PageUp/Home/ArrowUp;
 *  - re-engage via jump-to-live, or after the user sits at the live edge for
 *    ≥10 consecutive frames (an instant re-engage races the releasing wheel
 *    scroll and un-releases it — measured dead end);
 *  - the LIVE indicator is driven by THIS state, never by the library's
 *    `isAtEnd()` (it flickers a frame behind per-frame pinning — measured).
 *
 * Dead ends measured out — do not resurrect (spike §"Dead-end designs"):
 * ResizeObserver + isAtEnd memory; single scrollToEnd() on resize;
 * threshold-based release; library isAtEnd() as the live oracle.
 *
 * Framework-free and structurally typed so the discipline is unit-testable
 * with a fake element + manual frame scheduler.
 */

/** Structural slice of the scroll element the guard drives (fakeable). */
export interface FollowGuardElement {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  addEventListener(type: string, listener: (event: Event) => void, options?: unknown): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/** Injectable rAF so tests can drive frames deterministically. */
export interface FrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

export interface FollowGuardOptions {
  /** Consecutive at-bottom frames before re-engaging (spike: 10). */
  reengageFrames?: number;
  /** At-bottom tolerance in px (spike: 1 — sub-pixel scrollTop rounding). */
  epsilonPx?: number;
  /** Fired on every follow-intent transition — drives the LIVE indicator. */
  onFollowChange?: (following: boolean) => void;
  scheduler?: FrameScheduler;
}

export interface FollowGuard {
  /** App-owned follow intent — THE live oracle (never library isAtEnd()). */
  readonly following: boolean;
  /** Re-engage follow and pin immediately (the "jump to live" affordance). */
  jumpToLive(): void;
  dispose(): void;
}

const RELEASE_KEYS = new Set(['PageUp', 'Home', 'ArrowUp']);

function defaultScheduler(): FrameScheduler {
  return {
    request: (cb) => requestAnimationFrame(() => cb()),
    cancel: (handle) => cancelAnimationFrame(handle),
  };
}

export function createFollowGuard(
  el: FollowGuardElement,
  options: FollowGuardOptions = {},
): FollowGuard {
  const reengageFrames = options.reengageFrames ?? 10;
  const epsilon = options.epsilonPx ?? 1;
  const scheduler = options.scheduler ?? defaultScheduler();

  let following = true;
  let atBottomFrames = 0;
  let disposed = false;
  let frameHandle: number | null = null;

  const setFollowing = (next: boolean): void => {
    if (following === next) return;
    following = next;
    options.onFollowChange?.(next);
  };

  const deviation = (): number =>
    Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop);

  const pin = (): void => {
    if (deviation() > epsilon) el.scrollTop = el.scrollHeight - el.clientHeight;
  };

  // Release is EVENT-driven (no rAF ordering races — measured dead end).
  const release = (): void => {
    atBottomFrames = 0;
    setFollowing(false);
  };

  const onWheel = (event: WheelEvent): void => {
    if (event.deltaY < 0) release();
  };
  const onTouchMove = (): void => release();
  const onKeyDown = (event: KeyboardEvent): void => {
    if (RELEASE_KEYS.has(event.key)) release();
  };

  el.addEventListener('wheel', onWheel as (event: Event) => void, { passive: true });
  el.addEventListener('touchmove', onTouchMove as (event: Event) => void, { passive: true });
  el.addEventListener('keydown', onKeyDown as (event: Event) => void);

  const loop = (): void => {
    if (disposed) return;
    if (following) {
      pin();
      atBottomFrames = 0;
    } else {
      atBottomFrames = deviation() <= epsilon ? atBottomFrames + 1 : 0;
      if (atBottomFrames >= reengageFrames) {
        atBottomFrames = 0;
        setFollowing(true); // user parked at the live edge
      }
    }
    frameHandle = scheduler.request(loop);
  };
  frameHandle = scheduler.request(loop);

  return {
    get following(): boolean {
      return following;
    },
    jumpToLive(): void {
      setFollowing(true);
      el.scrollTop = el.scrollHeight - el.clientHeight;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (frameHandle !== null) scheduler.cancel(frameHandle);
      el.removeEventListener('wheel', onWheel as (event: Event) => void);
      el.removeEventListener('touchmove', onTouchMove as (event: Event) => void);
      el.removeEventListener('keydown', onKeyDown as (event: Event) => void);
    },
  };
}
