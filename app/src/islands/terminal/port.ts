/**
 * FE-3 terminal island ↔ FE-2 lib seam — the PTY port.
 *
 * The terminal island NEVER touches the WebSocket. It consumes this narrow
 * port, which the FE-2 WS client (app/src/lib) provides at composition time
 * for one attached `pty.<sid>` channel (ws-protocol.md §5/§6, FROZEN-M2).
 * Until FE-2 wires it, tests drive the port with local fakes (the same
 * discipline as FE-5's LaunchControlPort — see the FE-3 return's
 * icr_requests).
 *
 * Wire mapping the FE-2 implementation MUST honor:
 *
 *  - {@link TerminalPtyPort.onOutput} ← binary OUTPUT frames (§5), already
 *    decoded via `decodePtyFrame` and cross-checked against the channel's
 *    sid. Chunks are delivered in wire order; the island tolerates
 *    duplicates/overlaps/gaps on the `streamOffset` axis (reconnect replay).
 *  - {@link TerminalPtyPort.sendInput} → binary INPUT frames (§5). The lib
 *    owns the INPUT-direction `streamOffset` accounting and frame encoding
 *    (`encodePtyFrame`), splitting at PTY_FRAME_MAX_PAYLOAD_BYTES.
 *  - {@link TerminalPtyPort.sendAck} → `pty-ack` JSON on the channel (§6).
 *    Watermarks from the island are monotonic by construction.
 *  - {@link TerminalPtyPort.sendResize} → `pty-resize` JSON (§6). The island
 *    clamps to 1..PTY_MAX_COLS/ROWS before calling.
 *  - {@link TerminalPtyPort.requestReplay} → `pty-replay-request` JSON (§6).
 *    A `watermark-out-of-range` answer is a lib-level concern (the island's
 *    recovery from unrecoverable history is the serialize-addon snapshot it
 *    already holds — ws-protocol.md §6).
 *
 * [X2]: nothing on this seam carries account identity — session ids and
 * bytes only.
 */

/** One decoded OUTPUT chunk on the session's broker→client byte stream. */
export interface PtyOutputChunk {
  /** Absolute byte offset of `bytes[0]` on the OUTPUT watermark axis. */
  readonly streamOffset: number;
  readonly bytes: Uint8Array;
}

/** The slice of the FE-2 WS surface one terminal island consumes. */
export interface TerminalPtyPort {
  /** Harness session id (`SESSION_ID_SEGMENT_RE`) — never a native id. */
  readonly sessionId: string;
  /**
   * Subscribe to ordered OUTPUT chunks. Returns an unsubscribe function.
   * The lib replays retained bytes through the same listener after a
   * `requestReplay` — the island's stream tracker de-duplicates.
   */
  onOutput(listener: (chunk: PtyOutputChunk) => void): () => void;
  /** Keystrokes/paste for the attended session (client → broker). */
  sendInput(bytes: Uint8Array): void;
  /** Ack consumption: every OUTPUT byte with offset < watermark is consumed. */
  sendAck(watermark: number): void;
  /** Terminal geometry change (already clamped to the frozen 1..4096 range). */
  sendResize(cols: number, rows: number): void;
  /** Reconnect/reattach path: replay retained OUTPUT bytes from a watermark. */
  requestReplay(fromWatermark: number): void;
}
