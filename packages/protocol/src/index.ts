/**
 * @aibender/protocol — WS envelope, channel, and message types shared by the
 * aibender-core gateway (BE-3) and every frontend client (FE-2).
 *
 * ============================================================================
 * FIRST DRAFT — PRE-FREEZE. DO NOT TREAT AS STABLE.
 *
 * Owner: BE-ORCH (FE-ORCH co-signs). Freeze schedule per plan §3:
 *   - M1: envelope core + control channel
 *   - M2: full registry (binary PTY frame format, ack-watermark flow-control
 *         messages, error envelope) — specified in docs/contracts/ws-protocol.md
 * Amendments only via ICR (docs/contracts/icr/). Anything not present here yet
 * (PTY frames, flow control, error envelope) is deliberately absent at M0.
 * ============================================================================
 */

/** Draft marker so consumers can assert they are not building on a frozen surface. */
export const PROTOCOL_VERSION = '0.0.0-prefreeze' as const;

// ---------------------------------------------------------------------------
// Channel registry (plan §3): pty.<sid> · transcript.<sid> · events ·
// context-graph · quota · approvals · control
// ---------------------------------------------------------------------------

/** Channels that exist exactly once per gateway connection. */
export const CHANNEL = Object.freeze({
  EVENTS: 'events',
  CONTEXT_GRAPH: 'context-graph',
  QUOTA: 'quota',
  APPROVALS: 'approvals',
  CONTROL: 'control',
} as const);

export type StaticChannelName = (typeof CHANNEL)[keyof typeof CHANNEL];

export const STATIC_CHANNELS: readonly StaticChannelName[] = Object.freeze(
  Object.values(CHANNEL),
);

/** Session-scoped channel name shapes. `sid` is a harness session id — never a native id. */
export type PtyChannelName = `pty.${string}`;
export type TranscriptChannelName = `transcript.${string}`;

export type ChannelName = StaticChannelName | PtyChannelName | TranscriptChannelName;

/** Session-id segment: conservative charset so channel names stay parseable. */
const SESSION_ID_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || !SESSION_ID_SEGMENT_RE.test(sessionId)) {
    throw new RangeError(
      `invalid session id for channel name: ${JSON.stringify(sessionId)} ` +
        `(want ${SESSION_ID_SEGMENT_RE.source})`,
    );
  }
}

/** Build the per-session PTY byte channel name, e.g. `pty.s01`. */
export function ptyChannel(sessionId: string): PtyChannelName {
  assertSessionId(sessionId);
  return `pty.${sessionId}`;
}

/** Build the per-session transcript channel name, e.g. `transcript.s01`. */
export function transcriptChannel(sessionId: string): TranscriptChannelName {
  assertSessionId(sessionId);
  return `transcript.${sessionId}`;
}

/** True when `value` is a registered static channel or a well-formed session-scoped channel. */
export function isChannelName(value: unknown): value is ChannelName {
  if (typeof value !== 'string') return false;
  if ((STATIC_CHANNELS as readonly string[]).includes(value)) return true;
  for (const prefix of ['pty.', 'transcript.'] as const) {
    if (value.startsWith(prefix)) {
      return SESSION_ID_SEGMENT_RE.test(value.slice(prefix.length));
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Envelope (plan §3: `stream`, `channel`, `seq`, payload)
// ---------------------------------------------------------------------------

/**
 * The JSON event envelope carried on the single multiplexed WebSocket
 * (`ws://127.0.0.1:<port>`, blueprint §2). Binary PTY frames use a separate
 * (not-yet-drafted) binary format and are NOT wrapped in this envelope.
 */
export interface Envelope<TPayload = unknown> {
  /** Logical stream family, e.g. `'events'`, `'context-graph'`, `'pty'`. */
  stream: string;
  /** Concrete channel instance the payload belongs to. */
  channel: ChannelName;
  /**
   * Per-channel, monotonically increasing sequence number. Feeds the
   * ack-watermark flow control and reconnect-with-replay semantics (BE-3).
   */
  seq: number;
  /** Channel-specific payload. Message-type unions land at M1/M2 freezes. */
  payload: TPayload;
}

/** Structural runtime check for a decoded JSON envelope. */
export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['stream'] === 'string' &&
    v['stream'].length > 0 &&
    isChannelName(v['channel']) &&
    typeof v['seq'] === 'number' &&
    Number.isSafeInteger(v['seq']) &&
    v['seq'] >= 0 &&
    'payload' in v
  );
}
