/**
 * Reconnect-with-replay for JSON channels (plan BE-3 "reconnect-with-replay-
 * watermark semantics"; §9.3 BE↔FE #5). Frozen at M2.
 *
 * MECHANISM — deliberately the same shape as the PTY path (pty.ts
 * `pty-replay-request`), with `seq` as the axis instead of byte offsets:
 *
 *  - The broker journals a BOUNDED window of outbound envelopes per
 *    replayable channel, scoped to the broker boot. On those channels the
 *    envelope `seq` is per-(boot, channel) and CONTINUES across connections —
 *    a reconnecting client can therefore name exactly where it stopped.
 *  - On (re)connect a client MAY send one `replay-request` per channel — ON
 *    that channel — naming `fromSeq`, the first seq it has NOT processed.
 *    The broker re-sends every retained envelope with `seq >= fromSeq`, in
 *    order, with their ORIGINAL seq values, then live flow continues.
 *    `fromSeq === lastSeq + 1` is a legal no-op ("I am current").
 *  - `fromSeq` beyond `lastSeq + 1`, or below the journal's retention floor,
 *    answers `watermark-out-of-range` — below-floor history is unrecoverable
 *    from the wire BY DESIGN (bounded memory, SPIKE-D posture); the client
 *    rebuilds from read models / the store instead.
 *  - A broker RESTART invalidates every watermark: the client detects it via
 *    the bootstrap file's boot identity (token/pid/startedAt —
 *    docs/contracts/bootstrap-file.md) and starts fresh.
 *
 * REPLAYABLE CHANNELS: the broker→client fan-out set — `events`, `quota`,
 * `approvals`, `transcript.<sid>`, `context-graph`. NOT `control` (responses
 * correlate by request id and die with the connection; its seq stays
 * per-connection) and NOT `pty.<sid>` (bytes replay on the streamOffset axis,
 * frozen at M1 — pty.ts).
 *
 * ============================================================================
 * FROZEN-M2 (2026-07-04). Amendments only via ICR (docs/contracts/icr/);
 * BE-ORCH lands, FE-ORCH co-signs. Prose of record: docs/contracts/ws-protocol.md.
 * ============================================================================
 */

import type { ChannelName, StreamName } from './channels.js';
import { streamForChannel } from './channels.js';

/** Stream families whose channels are journaled + replayable. */
export const REPLAYABLE_STREAMS: readonly StreamName[] = Object.freeze([
  'events',
  'quota',
  'approvals',
  'transcript',
  'context-graph',
]);

/** True when `channel` participates in JSON reconnect-replay. */
export function isReplayableChannel(channel: ChannelName): boolean {
  return REPLAYABLE_STREAMS.includes(streamForChannel(channel));
}

/**
 * Client → broker, sent ON the channel being replayed. The embedded
 * `channel` MUST equal the envelope's channel (cross-checked, exactly like
 * pty payload sessionIds are cross-checked against `pty.<sid>`).
 */
export interface JsonReplayRequest {
  readonly kind: 'replay-request';
  readonly channel: ChannelName;
  /** First seq the client has NOT processed (replay is `seq >= fromSeq`). */
  readonly fromSeq: number;
}
