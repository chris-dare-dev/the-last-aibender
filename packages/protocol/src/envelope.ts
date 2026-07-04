/**
 * The JSON event envelope carried on the single multiplexed WebSocket
 * (`ws://127.0.0.1:<port>`, blueprint §2). Binary PTY frames use the codec in
 * pty.ts and are NOT wrapped in this envelope.
 *
 * ============================================================================
 * FROZEN-M1-CORE (2026-07-04). Amendments only via ICR (docs/contracts/icr/);
 * BE-ORCH lands, FE-ORCH co-signs. Prose of record: docs/contracts/ws-protocol.md.
 * ============================================================================
 */

import type { ChannelName } from './channels.js';
import { isChannelName, streamForChannel } from './channels.js';
import type { ControlRequest, ControlResponse } from './control.js';
import type { ErrorPayload } from './errors.js';
import type { PtyClientMessage } from './pty.js';
import type { ValidationResult } from './result.js';
import { invalid, valid } from './result.js';

export interface Envelope<TPayload = unknown> {
  /** Logical stream family — MUST equal `streamForChannel(channel)`. */
  stream: string;
  /** Concrete channel instance the payload belongs to. */
  channel: ChannelName;
  /**
   * Per-channel, monotonically increasing sequence number assigned by the
   * sender of the envelope. Feeds reconnect-with-replay bookkeeping (JSON
   * channels); PTY byte flow control uses the binary frame streamOffset axis
   * instead (see pty.ts).
   */
  seq: number;
  /** Channel-specific payload (see the payload unions below). */
  payload: TPayload;
}

/**
 * Payload kinds frozen at M1-CORE. The full cross-channel union (events,
 * quota, approvals, transcript, context-graph) freezes at M2 — their DRAFT
 * placeholders live in draft.ts and MUST NOT be built against as stable.
 */
export type FrozenM1Payload = ControlRequest | ControlResponse | ErrorPayload | PtyClientMessage;

/**
 * Structural + consistency validation of a decoded JSON envelope. Enforces
 * stream/channel agreement; does NOT validate the payload (channel-specific
 * validators in validate.ts do).
 */
export function validateEnvelope(value: unknown): ValidationResult<Envelope> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid('bad-envelope', 'envelope must be a JSON object');
  }
  const v = value as Record<string, unknown>;
  const channel = v['channel'];
  if (!isChannelName(channel)) {
    return invalid('unknown-channel', `unregistered or malformed channel ${JSON.stringify(channel)}`);
  }
  const stream = v['stream'];
  const expectedStream = streamForChannel(channel);
  if (typeof stream !== 'string' || stream !== expectedStream) {
    return invalid(
      'bad-envelope',
      `stream ${JSON.stringify(stream)} does not match channel ${channel} (want ${JSON.stringify(expectedStream)})`,
    );
  }
  const seq = v['seq'];
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
    return invalid('bad-envelope', `seq must be a non-negative safe integer, got ${JSON.stringify(seq)}`);
  }
  if (!('payload' in v)) {
    return invalid('bad-envelope', 'envelope has no payload key');
  }
  return valid({ stream, channel, seq, payload: v['payload'] });
}

/** Boolean form of {@link validateEnvelope} (kept from the M0 draft surface). */
export function isEnvelope(value: unknown): value is Envelope {
  return validateEnvelope(value).ok;
}
