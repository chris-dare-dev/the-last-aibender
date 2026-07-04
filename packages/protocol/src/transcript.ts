/**
 * `transcript.<sid>` channel payloads — the SDK message-stream projection
 * (blueprint §4.1: semantics come from the SDK message stream, hooks, OTel and
 * JSONL — never from PTY bytes). Broker → client only; the only client→broker
 * payload a transcript channel accepts is the generic `replay-request`
 * (replay.ts).
 *
 * The projection is deliberately NARROW (three kinds):
 *   - `transcript-delta`   streamed assistant text
 *   - `transcript-tool`    tool lifecycle (start / result)
 *   - `transcript-result`  the terminal result with usage + cost
 *
 * Anything richer (full message bodies, tool inputs/outputs) stays OFF this
 * channel by design: transcripts of record live in the per-account JSONL
 * files and the harness store; tool/file semantics flow through the hooks
 * contract (docs/contracts/hooks-contract.md). Keeping the wire projection
 * value-light is also the [X2] posture — no free-form payload echo paths.
 *
 * ============================================================================
 * FROZEN-M2 (2026-07-04). Amendments only via ICR (docs/contracts/icr/);
 * BE-ORCH lands, FE-ORCH co-signs. Prose of record: docs/contracts/ws-protocol.md.
 * ============================================================================
 */

/** Streamed assistant text for the live transcript island (FE-3). */
export interface TranscriptDelta {
  readonly kind: 'transcript-delta';
  /** Harness session id — MUST equal the channel's `<sid>`. */
  readonly sessionId: string;
  /**
   * Uuid of the message this delta extends (native JSONL uuid space) — the
   * client groups deltas into messages on this key.
   */
  readonly messageUuid: string;
  /** The appended text. Non-empty; empty deltas are never sent. */
  readonly text: string;
}

/**
 * Tool lifecycle event as projected from the SDK stream. `start` announces a
 * tool_use; `result` closes it. Inputs/outputs are deliberately absent (see
 * module header) — the pair (toolUseId, toolName, ok) is what the transcript
 * island renders.
 */
export interface TranscriptToolEvent {
  readonly kind: 'transcript-tool';
  readonly sessionId: string;
  /** Native tool_use id — pairs start with result. */
  readonly toolUseId: string;
  /** Tool name as the SDK reports it (e.g. `Read`). */
  readonly toolName: string;
  readonly phase: 'start' | 'result';
  /**
   * Success flag. REQUIRED when `phase === 'result'`; MUST be absent when
   * `phase === 'start'` (validated — a start has no outcome yet).
   */
  readonly ok?: boolean;
}

/**
 * The four ground-truth token classes (blueprint §6.2). Cache classes carry
 * the 5m/1h TTL split upstream; on this wire projection they are summed —
 * the split lives in the events store (BE-5, M3).
 */
export interface TranscriptUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

/** Terminal message of a query: mirrors the kernel seam's RunnerResultMessage. */
export interface TranscriptResult {
  readonly kind: 'transcript-result';
  readonly sessionId: string;
  readonly ok: boolean;
  /** SDK result subtype (e.g. `success`, `error_during_execution`). */
  readonly detail: string;
  readonly usage: TranscriptUsage;
  /** Client-side cost ESTIMATE in USD (never authoritative; blueprint §6.2). */
  readonly costUsd?: number;
  /** Wall-clock duration of the query in milliseconds. */
  readonly durationMs?: number;
}

export type TranscriptPayload = TranscriptDelta | TranscriptToolEvent | TranscriptResult;

export const TRANSCRIPT_PAYLOAD_KINDS = Object.freeze([
  'transcript-delta',
  'transcript-tool',
  'transcript-result',
] as const);
