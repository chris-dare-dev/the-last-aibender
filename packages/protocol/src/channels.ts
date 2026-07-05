/**
 * Channel registry (plan §3): control · events · quota · approvals ·
 * pty.<sid> · transcript.<sid> · context-graph · workstream.
 *
 * ============================================================================
 * FROZEN-M1-CORE (2026-07-04). Amendments only via ICR (docs/contracts/icr/);
 * BE-ORCH lands, FE-ORCH co-signs. Prose of record: docs/contracts/ws-protocol.md.
 * Amendments: M4 freeze — the `workstream` channel (stream `workstream`)
 * registered for the X4 lineage view (workstreams.ts; ws-protocol.md §16,
 * amendment-recorded). M5 freeze — the `pipelines` channel (stream
 * `pipelines`) registered for features 4/5 (pipelines.ts; ws-protocol.md §18,
 * amendment-recorded). No M1–M4 channel or rule changed.
 * ============================================================================
 */

/** Channels that exist exactly once per gateway connection. */
export const CHANNEL = Object.freeze({
  EVENTS: 'events',
  CONTEXT_GRAPH: 'context-graph',
  QUOTA: 'quota',
  APPROVALS: 'approvals',
  CONTROL: 'control',
  /** M4: the X4 lineage fan-out + merge-request channel (workstreams.ts). */
  WORKSTREAM: 'workstream',
  /** M5: the catalog + pipeline run-monitor fan-out + verb channel (pipelines.ts). */
  PIPELINES: 'pipelines',
} as const);

export type StaticChannelName = (typeof CHANNEL)[keyof typeof CHANNEL];

export const STATIC_CHANNELS: readonly StaticChannelName[] = Object.freeze(
  Object.values(CHANNEL),
);

/** Session-scoped channel name shapes. `sid` is a harness session id — never a native id. */
export type PtyChannelName = `pty.${string}`;
export type TranscriptChannelName = `transcript.${string}`;

export type ChannelName = StaticChannelName | PtyChannelName | TranscriptChannelName;

/**
 * Logical stream families carried on the single multiplexed WebSocket.
 * Every channel maps to exactly one stream (see {@link streamForChannel}).
 */
export const STREAMS = Object.freeze([
  'control',
  'events',
  'quota',
  'approvals',
  'pty',
  'transcript',
  'context-graph',
  'workstream',
  'pipelines',
] as const);

export type StreamName = (typeof STREAMS)[number];

/** Session-id segment: conservative charset so channel names stay parseable. */
export const SESSION_ID_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

/** Max UTF-8 bytes of a session id (also bounds the binary PTY frame header). */
export const MAX_SESSION_ID_BYTES = 64;

export function isSessionIdSegment(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_SESSION_ID_BYTES &&
    SESSION_ID_SEGMENT_RE.test(value)
  );
}

function assertSessionId(sessionId: string): void {
  if (!isSessionIdSegment(sessionId)) {
    throw new RangeError(
      `invalid session id for channel name: ${JSON.stringify(sessionId)} ` +
        `(want ${SESSION_ID_SEGMENT_RE.source}, <= ${MAX_SESSION_ID_BYTES} chars)`,
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
      return isSessionIdSegment(value.slice(prefix.length));
    }
  }
  return false;
}

/**
 * The stream family a channel belongs to. Envelope validation enforces
 * `envelope.stream === streamForChannel(envelope.channel)`.
 */
export function streamForChannel(channel: ChannelName): StreamName {
  if (channel.startsWith('pty.')) return 'pty';
  if (channel.startsWith('transcript.')) return 'transcript';
  // Static channels share their stream name.
  return channel as StreamName;
}

/** The session id embedded in a session-scoped channel name, else undefined. */
export function sessionIdOfChannel(channel: ChannelName): string | undefined {
  for (const prefix of ['pty.', 'transcript.'] as const) {
    if (channel.startsWith(prefix)) return channel.slice(prefix.length);
  }
  return undefined;
}
