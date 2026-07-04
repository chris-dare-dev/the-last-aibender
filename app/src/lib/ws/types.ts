/**
 * Structural WebSocket seam. The browser/WKWebView `WebSocket` satisfies
 * this shape; tests inject a deterministic fake (mirrors BE-1's
 * FakeQueryRunner seam pattern — the seam IS the testing strategy, plan §9).
 */

export const WS_OPEN = 1;

export interface WsMessageEvent {
  readonly data: string | ArrayBuffer;
}

export interface WsCloseEvent {
  readonly code: number;
  readonly reason: string;
}

export interface WsLike {
  binaryType: string;
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: WsMessageEvent) => void) | null;
  onclose: ((ev: WsCloseEvent) => void) | null;
  onerror: (() => void) | null;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type WsFactory = (url: string) => WsLike;

/** Default factory — the platform WebSocket (Tauri WKWebView or browser). */
export const platformWsFactory: WsFactory = (url) => {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => unknown }).WebSocket;
  if (Ctor === undefined) {
    throw new Error('no WebSocket implementation available in this environment');
  }
  return new Ctor(url) as WsLike;
};

/** Injectable timer seam (deterministic reconnect/backoff tests). */
export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const platformTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};
