/**
 * FE-2 composition adapter: {@link PtyConduit} → the terminal island's
 * {@link TerminalPtyPort} (app/src/islands/terminal/port.ts — TYPE-ONLY
 * import; no island runtime enters the lib).
 *
 * Wire-mapping duties the port contract assigns to the lib side:
 *  - OUTPUT chunks are delivered as `{streamOffset, bytes}` pairs — the
 *    conduit surfaces the absolute offset of every delivered chunk;
 *  - `sendInput` → INPUT binary frames (the conduit owns the INPUT
 *    `streamOffset` accounting and `encodePtyFrame`);
 *  - `sendAck` carries the island's ABSOLUTE consumed watermark; the conduit
 *    tracks relative consumption, so the adapter converts (stale/duplicate
 *    watermarks become a no-op — acks stay monotonic on the wire);
 *  - `sendResize` → `pty-resize` (already clamped island-side);
 *  - `requestReplay` → {@link PtyConduit.replayFrom}, which repositions the
 *    conduit's delivered axis so the replayed bytes are not dropped as
 *    overlap before they reach the island's stream tracker.
 *
 * [X2]: nothing on this seam carries account identity — session ids and
 * bytes only.
 */

import type { PtyOutputChunk, TerminalPtyPort } from '../../islands/terminal/port.ts';
import type { PtyConduit } from '../ws/ptyConduit.ts';

/** Adapt one session's PTY conduit to the terminal island's port seam. */
export function terminalPortForConduit(conduit: PtyConduit): TerminalPtyPort {
  return {
    sessionId: conduit.sessionId,

    onOutput(listener: (chunk: PtyOutputChunk) => void): () => void {
      return conduit.onBytes((bytes, streamOffset) => listener({ streamOffset, bytes }));
    },

    sendInput(bytes: Uint8Array): void {
      conduit.write(bytes);
    },

    sendAck(watermark: number): void {
      // Island watermarks are absolute; consume() is relative and ignores
      // non-positive deltas, so stale watermarks never regress the ack axis.
      conduit.consume(watermark - conduit.consumedWatermark);
    },

    sendResize(cols: number, rows: number): void {
      conduit.resize(cols, rows);
    },

    requestReplay(fromWatermark: number): void {
      conduit.replayFrom(fromWatermark);
    },
  };
}
