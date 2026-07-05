/**
 * FE-4 layout worker wire protocol — shared by layout.worker.ts (the module
 * worker shell) and layoutBridge.ts (the main-thread port). Positions cross
 * ONLY as transferable ArrayBuffers (spike-B lock #2: never copy, never
 * JSON-encode a position).
 */

/** main → worker */
export type LayoutWorkerRequest =
  | { readonly type: 'init'; readonly epochIntervalMs?: number }
  | {
      readonly type: 'add';
      readonly count: number;
      /** 2×count float32 spawn positions (transferred). */
      readonly positions: ArrayBuffer;
      /** u32 pairs of GLOBAL node indexes (transferred). */
      readonly edges: ArrayBuffer;
    }
  | { readonly type: 'reheat'; readonly alphaTarget: number }
  | { readonly type: 'cooldown' }
  | { readonly type: 'settle' }
  | { readonly type: 'pin'; readonly index: number; readonly x: number; readonly y: number }
  | { readonly type: 'unpin'; readonly index: number }
  /** Test hook: deterministic crash for the degrade-path suites. */
  | { readonly type: 'crash' }
  | { readonly type: 'stop' };

/** worker → main */
export type LayoutWorkerResponse =
  | { readonly type: 'ready' }
  | {
      readonly type: 'epoch';
      /** 2×n float32 positions (transferred; fresh buffer per epoch). */
      readonly buf: ArrayBuffer;
      readonly n: number;
      readonly seq: number;
      readonly alpha: number;
      /** The clamped alphaTarget in force at emit time (bound assertable). */
      readonly alphaTarget: number;
    }
  | { readonly type: 'error'; readonly message: string };

export function isLayoutWorkerResponse(value: unknown): value is LayoutWorkerResponse {
  if (typeof value !== 'object' || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return t === 'ready' || t === 'epoch' || t === 'error';
}
