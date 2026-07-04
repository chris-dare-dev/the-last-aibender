/**
 * Outbound (client → broker) frame construction per ws-protocol.md §2:
 * one JSON envelope per text frame, `seq` per-channel monotonic and — on
 * client→broker traffic — PER-CONNECTION (reset when a new socket opens).
 *
 * Envelope key order is `{stream, channel, seq, payload}` and payload keys
 * follow the golden-corpus fixture order, so frames produced here can be
 * byte-compared against `GOLDEN_WS_FIXTURES` (the corpus pins EXACT wire
 * bytes; JSON.stringify preserves insertion order).
 */

import { streamForChannel, type ChannelName } from '@aibender/protocol';

/** Per-connection, per-channel outbound seq counters. */
export class OutboundSeq {
  private counters = new Map<ChannelName, number>();

  /** Next seq for `channel` (0-based, monotonic within the connection). */
  next(channel: ChannelName): number {
    const current = this.counters.get(channel) ?? 0;
    this.counters.set(channel, current + 1);
    return current;
  }

  /** New connection ⇒ client→broker seq restarts (ws-protocol.md §2). */
  reset(): void {
    this.counters.clear();
  }
}

/** Serialize one envelope exactly as the golden corpus builders do. */
export function encodeEnvelope(channel: ChannelName, seq: number, payload: unknown): string {
  return JSON.stringify({ stream: streamForChannel(channel), channel, seq, payload });
}
