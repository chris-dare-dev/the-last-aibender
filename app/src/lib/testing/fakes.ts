/**
 * Deterministic test fakes for the FE-2 client stack (the seam-injection
 * strategy: WsLike / Timers / FrameScheduler / BootstrapProvider are all
 * constructor seams, mirroring the FakeQueryRunner pattern in testkit).
 * Test-support code only — never imported by production modules.
 */

import { decodePtyFrame } from '@aibender/protocol';
import type { GatewayBootstrap } from '../bootstrap.ts';
import type { FrameScheduler } from '../projection/rafBatch.ts';
import type { Timers, WsFactory, WsLike, WsMessageEvent, WsCloseEvent } from '../ws/types.ts';

/**
 * Synthesized gateway token fixture, assembled at RUNTIME so no contiguous
 * key-shaped literal exists in the tree (plan §9.1 fixture policy; the
 * audit.spec.ts pattern — gitleaks Tier-1 sees only the parts) [X2].
 */
export const FAKE_GATEWAY_TOKEN = ['synth', 'fake', 'token'].join('-');

/** Same discipline for the "different boot identity" token fixture. */
export const FAKE_NEW_BOOT_TOKEN = ['new', 'boot', 'token'].join('-');

/** Synthesized bootstrap fixture — placeholder values only [X2]. */
export function fakeBootstrap(overrides: Partial<GatewayBootstrap> = {}): GatewayBootstrap {
  return {
    port: 49152,
    token: FAKE_GATEWAY_TOKEN,
    pid: 12345,
    startedAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  };
}

export class FakeWebSocket implements WsLike {
  binaryType = 'blob';
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((ev: WsMessageEvent) => void) | null = null;
  onclose: ((ev: WsCloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: (string | Uint8Array)[] = [];

  constructor(readonly url: string) {}

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (typeof data === 'string') this.sent.push(data);
    else if (data instanceof Uint8Array) this.sent.push(new Uint8Array(data));
    else this.sent.push(new Uint8Array(data));
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  // ---- test drivers ---------------------------------------------------------

  /** Server accepted the connection. */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Broker pushes a text frame. */
  receiveText(frame: string): void {
    this.onmessage?.({ data: frame });
  }

  /**
   * Broker pushes a binary frame — with the ws-protocol.md §6 attach pin
   * ENFORCED exactly as the real gateway does: OUTPUT frames for `pty.<sid>`
   * flow to a connection only after its FIRST `pty-replay-request` on that
   * channel. A client that never attaches receives nothing (no implicit
   * attach at subscribe time), so a test that forgets the attach sees the
   * same zero bytes it would see against the real BE-3 gateway.
   */
  receiveBinary(bytes: Uint8Array): void {
    const copy = new Uint8Array(bytes); // standalone buffer, exact length
    const decoded = decodePtyFrame(copy);
    if (decoded.ok && decoded.value.type === 'output' && !this.ptyAttached(decoded.value.sessionId)) {
      return; // withheld — never attached on this connection
    }
    this.onmessage?.({ data: copy.buffer });
  }

  /** True once this connection sent a `pty-replay-request` for `sessionId`. */
  private ptyAttached(sessionId: string): boolean {
    return this.sentTexts.some((frame) => {
      try {
        const envelope = JSON.parse(frame) as {
          payload?: { kind?: string; sessionId?: string };
        };
        return (
          envelope.payload?.kind === 'pty-replay-request' &&
          envelope.payload.sessionId === sessionId
        );
      } catch {
        return false;
      }
    });
  }

  /** Server-side close (e.g. 1008 after bad-auth). */
  serverClose(code: number, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  get sentTexts(): string[] {
    return this.sent.filter((f): f is string => typeof f === 'string');
  }

  get sentBinary(): Uint8Array[] {
    return this.sent.filter((f): f is Uint8Array => typeof f !== 'string');
  }
}

/** Factory that records every socket it hands out. */
export class FakeWsHub {
  readonly sockets: FakeWebSocket[] = [];

  readonly factory: WsFactory = (url) => {
    const socket = new FakeWebSocket(url);
    this.sockets.push(socket);
    return socket;
  };

  get latest(): FakeWebSocket {
    const socket = this.sockets[this.sockets.length - 1];
    if (socket === undefined) throw new Error('no socket was created');
    return socket;
  }
}

/** Deterministic manual clock for backoff/timeout paths. */
export class ManualTimers implements Timers {
  private tasks = new Map<number, { fn: () => void; at: number }>();
  private nextId = 1;
  now = 0;

  set(fn: () => void, ms: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { fn, at: this.now + ms });
    return id;
  }

  clear(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  /** Advance the clock, firing due tasks in schedule order. */
  advance(ms: number): void {
    this.now += ms;
    for (;;) {
      const due = [...this.tasks.entries()]
        .filter(([, t]) => t.at <= this.now)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) return;
      this.tasks.delete(due[0]);
      due[1].fn();
    }
  }

  get pendingCount(): number {
    return this.tasks.size;
  }
}

/** Manually-pumped frame scheduler for rAF-projection tests. */
export function manualFrames(): { schedule: FrameScheduler; frame(): void; scheduledCount(): number } {
  let pending: (() => void) | undefined;
  let count = 0;
  return {
    schedule: (flush) => {
      pending = flush;
      count += 1;
      return () => {
        pending = undefined;
      };
    },
    frame(): void {
      const flush = pending;
      pending = undefined;
      flush?.();
    },
    scheduledCount: () => count,
  };
}

/** Let queued microtasks + resolved promises settle. */
export async function flushAsync(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}
