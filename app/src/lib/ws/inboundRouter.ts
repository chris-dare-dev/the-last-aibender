/**
 * FE-2 inbound (broker → client) frame router — the client half of the
 * BE↔FE contract device (plan §9.3 BE↔FE #1). Routing order mirrors the
 * gateway's routeTextFrame/routeBinaryFrame and the golden corpus reference
 * replay: json-parse → envelope → channel-specific FROZEN validator.
 *
 * Wire data NEVER throws here; every failure is a verdict carrying the exact
 * frozen ErrorCode the golden corpus pins. Malformed frames are DROPPED by
 * the caller (logged, connection unaffected — plan §9.2 FE-2 negative row).
 */

import {
  decodePtyFrame,
  isReplayableChannel,
  sessionIdOfChannel,
  validateApprovalsServerMessage,
  validateContextGraphTouch,
  validateControlResponse,
  validateErrorPayload,
  validateEnvelope,
  validateEventsPayload,
  validateQuotaSnapshot,
  validateTranscriptPayload,
  validateWorkstreamServerPayload,
  validatePipelineServerPayload,
  type ApprovalsServerPayload,
  type ChannelName,
  type ContextGraphTouch,
  type ControlResponse,
  type ErrorCode,
  type ErrorPayload,
  type EventSummary,
  type OpaqueEventsPayload,
  type OpaquePipelinePayload,
  type OpaqueWorkstreamPayload,
  type PipelineServerPayload,
  type PtyFrame,
  type QuotaSnapshot,
  type ReadModelSnapshot,
  type TranscriptPayload,
  type WorkstreamServerPayload,
} from '@aibender/protocol';

/** The validation stage that produced a verdict (mirrors golden stages). */
export type InboundStage =
  | 'json-parse'
  | 'envelope'
  | 'control-response'
  | 'error-payload'
  | 'transcript-payload'
  | 'approvals-server-message'
  | 'quota-payload'
  | 'context-graph-payload'
  | 'events-payload'
  | 'workstream-payload'
  | 'pipelines-payload'
  | 'channel-policy'
  | 'pty-frame-codec';

export type InboundMessage =
  | { readonly kind: 'control-response'; readonly response: ControlResponse }
  | { readonly kind: 'pushed-error'; readonly error: ErrorPayload }
  | {
      readonly kind: 'transcript';
      readonly channel: ChannelName;
      readonly sessionId: string;
      readonly seq: number;
      readonly payload: TranscriptPayload;
    }
  | {
      readonly kind: 'approvals';
      readonly channel: ChannelName;
      readonly seq: number;
      readonly payload: ApprovalsServerPayload;
    }
  | {
      readonly kind: 'quota';
      readonly channel: ChannelName;
      readonly seq: number;
      readonly payload: QuotaSnapshot;
    }
  | {
      readonly kind: 'context-graph';
      readonly channel: ChannelName;
      readonly seq: number;
      readonly payload: ContextGraphTouch;
    }
  | {
      /**
       * events union FROZEN at M3 (ws-protocol.md §13): event summaries +
       * read-model snapshots; unknown kinds decode opaque and MUST be
       * ignored (the frozen forward-tolerant reader rule).
       */
      readonly kind: 'events';
      readonly channel: ChannelName;
      readonly seq: number;
      readonly payload: EventSummary | ReadModelSnapshot | OpaqueEventsPayload;
    }
  | {
      /**
       * workstream union FROZEN at M4 (ws-protocol.md §16): the X4 lineage
       * fan-out (snapshots, node upserts, edge appends, briefs, branch
       * advisories, merge resolutions); unknown kinds decode opaque and
       * MUST be ignored (the same frozen forward-tolerant reader rule).
       */
      readonly kind: 'workstream';
      readonly channel: ChannelName;
      readonly seq: number;
      readonly payload: WorkstreamServerPayload | OpaqueWorkstreamPayload;
    }
  | {
      /**
       * pipelines union FROZEN at M5 (ws-protocol.md §18): the features-4/5
       * fan-out (catalog snapshots, run/step status, validation results, save
       * acks); unknown kinds decode opaque and MUST be ignored (the same
       * frozen forward-tolerant reader rule as events/workstream).
       */
      readonly kind: 'pipelines';
      readonly channel: ChannelName;
      readonly seq: number;
      readonly payload: PipelineServerPayload | OpaquePipelinePayload;
    }
  | { readonly kind: 'pty-frame'; readonly frame: PtyFrame };

export type InboundVerdict =
  | { readonly ok: true; readonly message: InboundMessage }
  | { readonly ok: false; readonly code: ErrorCode; readonly stage: InboundStage };

/** Channel of a routed message when it participates in JSON replay, else undefined. */
export function replayableChannelOf(message: InboundMessage): ChannelName | undefined {
  switch (message.kind) {
    case 'transcript':
    case 'approvals':
    case 'quota':
    case 'context-graph':
    case 'events':
    case 'workstream':
    case 'pipelines':
      return isReplayableChannel(message.channel) ? message.channel : undefined;
    default:
      return undefined;
  }
}

/** Seq of a routed replayable message (the client-side watermark axis). */
export function seqOf(message: InboundMessage): number | undefined {
  switch (message.kind) {
    case 'transcript':
    case 'approvals':
    case 'quota':
    case 'context-graph':
    case 'events':
    case 'workstream':
    case 'pipelines':
      return message.seq;
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Route one broker-pushed WS frame (text envelope or binary PTY frame). */
export function routeBrokerFrame(data: string | Uint8Array): InboundVerdict {
  if (typeof data !== 'string') {
    const decoded = decodePtyFrame(data);
    return decoded.ok
      ? { ok: true, message: { kind: 'pty-frame', frame: decoded.value } }
      : { ok: false, code: decoded.code, stage: 'pty-frame-codec' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { ok: false, code: 'bad-envelope', stage: 'json-parse' };
  }

  const envelope = validateEnvelope(parsed);
  if (!envelope.ok) return { ok: false, code: envelope.code, stage: 'envelope' };
  const { channel, seq, payload } = envelope.value;

  if (channel === 'control') {
    if (isRecord(payload) && payload['kind'] === 'error') {
      const pushed = validateErrorPayload(payload);
      return pushed.ok
        ? { ok: true, message: { kind: 'pushed-error', error: pushed.value } }
        : { ok: false, code: pushed.code, stage: 'error-payload' };
    }
    const response = validateControlResponse(payload);
    return response.ok
      ? { ok: true, message: { kind: 'control-response', response: response.value } }
      : { ok: false, code: response.code, stage: 'control-response' };
  }

  if (channel === 'approvals') {
    const message = validateApprovalsServerMessage(payload);
    return message.ok
      ? { ok: true, message: { kind: 'approvals', channel, seq, payload: message.value } }
      : { ok: false, code: message.code, stage: 'approvals-server-message' };
  }

  if (channel === 'quota') {
    const snapshot = validateQuotaSnapshot(payload);
    return snapshot.ok
      ? { ok: true, message: { kind: 'quota', channel, seq, payload: snapshot.value } }
      : { ok: false, code: snapshot.code, stage: 'quota-payload' };
  }

  if (channel === 'context-graph') {
    const touch = validateContextGraphTouch(payload);
    return touch.ok
      ? { ok: true, message: { kind: 'context-graph', channel, seq, payload: touch.value } }
      : { ok: false, code: touch.code, stage: 'context-graph-payload' };
  }

  const sid = sessionIdOfChannel(channel);
  if (sid !== undefined && channel.startsWith('transcript.')) {
    const transcript = validateTranscriptPayload(payload, sid);
    return transcript.ok
      ? {
          ok: true,
          message: {
            kind: 'transcript',
            channel,
            sessionId: sid,
            seq,
            payload: transcript.value,
          },
        }
      : { ok: false, code: transcript.code, stage: 'transcript-payload' };
  }

  if (sid !== undefined && channel.startsWith('pty.')) {
    // The broker never pushes JSON on pty channels (bytes are binary frames;
    // flow-control JSON is client→broker only) — a text envelope here is a
    // policy violation, not a payload-validation question.
    return { ok: false, code: 'bad-request', stage: 'channel-policy' };
  }

  if (channel === 'events') {
    // FROZEN at M3 (ws-protocol.md §13): event-summary + read-model
    // snapshots; unknown kinds decode opaque (forward-tolerant reader rule).
    const events = validateEventsPayload(payload);
    return events.ok
      ? { ok: true, message: { kind: 'events', channel, seq, payload: events.value } }
      : { ok: false, code: events.code, stage: 'events-payload' };
  }

  if (channel === 'workstream') {
    // FROZEN at M4 (ws-protocol.md §16): the X4 lineage union; unknown kinds
    // decode opaque (the same forward-tolerant reader rule as events).
    const workstream = validateWorkstreamServerPayload(payload);
    return workstream.ok
      ? { ok: true, message: { kind: 'workstream', channel, seq, payload: workstream.value } }
      : { ok: false, code: workstream.code, stage: 'workstream-payload' };
  }

  if (channel === 'pipelines') {
    // FROZEN at M5 (ws-protocol.md §18): the features-4/5 catalog + run-monitor
    // union; unknown kinds decode opaque (the same forward-tolerant reader
    // rule as events/workstream). Client verbs are outbound-only.
    const pipelines = validatePipelineServerPayload(payload);
    return pipelines.ok
      ? { ok: true, message: { kind: 'pipelines', channel, seq, payload: pipelines.value } }
      : { ok: false, code: pipelines.code, stage: 'pipelines-payload' };
  }

  return { ok: false, code: 'unknown-channel', stage: 'channel-policy' };
}
