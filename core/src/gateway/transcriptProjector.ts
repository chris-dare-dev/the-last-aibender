/**
 * Transcript projector — RAW SDK message stream → the FROZEN
 * `transcript.<sid>` payload union (ws-protocol.md §9; @aibender/protocol
 * transcript.ts). One stateful projector per session (tool starts must be
 * paired with results by toolUseId; streamed text must not be re-emitted
 * when the final assistant message arrives).
 *
 * The projection is deliberately NARROW and value-light [X2]: streamed
 * assistant text, tool lifecycle (name + id + ok — never inputs/outputs),
 * and the terminal result with the four ground-truth token classes
 * (blueprint §6.2). Anything unrecognized projects to NOTHING — semantics of
 * record flow through hooks/JSONL/OTel (blueprint §4.1), never through a
 * permissive wire projection.
 *
 * SDK 0.3.201 shapes consumed (structural checks only — the SDK types are
 * not imported so this file compiles without the kernel lane):
 *   - `{ type:'stream_event', uuid, event:{ type:'content_block_delta',
 *      delta:{ type:'text_delta', text } } }`      → transcript-delta
 *   - `{ type:'assistant', uuid, message:{ content:[ {type:'text'|'tool_use'} ] } }`
 *      → transcript-delta (only when the session never streamed partial
 *        deltas — otherwise the final message would duplicate them) and
 *        transcript-tool phase:start
 *   - `{ type:'user', message:{ content:[ {type:'tool_result',
 *      tool_use_id, is_error?} ] } }`              → transcript-tool phase:result
 *   - `{ type:'result', subtype, usage?, total_cost_usd?, duration_ms? }`
 *      → transcript-result
 *   - `{ type:'other', raw }` wrappers (the kernel seam's RunnerOtherMessage)
 *     are unwrapped and re-projected.
 *
 * Every emitted payload satisfies validateTranscriptPayload by construction;
 * the server re-validates defensively before it touches the wire.
 */

import type { TranscriptPayload, TranscriptUsage } from '@aibender/protocol';

export interface TranscriptProjector {
  /** Project one raw SDK message into zero or more frozen payloads. */
  project(raw: unknown): TranscriptPayload[];
}

// ---------------------------------------------------------------------------
// Structural helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Non-negative safe integer, else 0 (usage classes never go negative on the wire). */
function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

// ---------------------------------------------------------------------------
// Projector
// ---------------------------------------------------------------------------

export function createTranscriptProjector(sessionId: string): TranscriptProjector {
  /** toolUseId → toolName, so results can carry the name (§9 pair contract). */
  const toolNames = new Map<string, string>();
  /**
   * True once a partial text delta streamed: the final assistant message
   * then repeats the full text and must not be re-emitted as deltas.
   */
  let sawStreamDelta = false;

  const projectAssistant = (message: Record<string, unknown>, uuid: string): TranscriptPayload[] => {
    const body = message['message'];
    if (!isRecord(body) || !Array.isArray(body['content'])) return [];
    const out: TranscriptPayload[] = [];
    for (const block of body['content'] as unknown[]) {
      if (!isRecord(block)) continue;
      if (block['type'] === 'text' && !sawStreamDelta) {
        const text = nonEmptyString(block['text']);
        if (text !== undefined) {
          out.push({ kind: 'transcript-delta', sessionId, messageUuid: uuid, text });
        }
      } else if (block['type'] === 'tool_use') {
        const toolUseId = nonEmptyString(block['id']);
        const toolName = nonEmptyString(block['name']);
        if (toolUseId !== undefined && toolName !== undefined) {
          toolNames.set(toolUseId, toolName);
          out.push({ kind: 'transcript-tool', sessionId, toolUseId, toolName, phase: 'start' });
        }
      }
    }
    return out;
  };

  const projectToolResults = (message: Record<string, unknown>): TranscriptPayload[] => {
    const body = message['message'];
    if (!isRecord(body) || !Array.isArray(body['content'])) return [];
    const out: TranscriptPayload[] = [];
    for (const block of body['content'] as unknown[]) {
      if (!isRecord(block) || block['type'] !== 'tool_result') continue;
      const toolUseId = nonEmptyString(block['tool_use_id']);
      if (toolUseId === undefined) continue;
      const toolName = toolNames.get(toolUseId);
      // A result whose start never streamed through this projector cannot
      // carry a toolName — skip rather than fabricate one (the transcript of
      // record has it; this wire projection only renders complete pairs).
      if (toolName === undefined) continue;
      toolNames.delete(toolUseId);
      out.push({
        kind: 'transcript-tool',
        sessionId,
        toolUseId,
        toolName,
        phase: 'result',
        ok: block['is_error'] !== true,
      });
    }
    return out;
  };

  const projectResult = (message: Record<string, unknown>): TranscriptPayload[] => {
    const detail = nonEmptyString(message['subtype']) ?? 'unknown';
    const rawUsage = message['usage'];
    const usage: TranscriptUsage = {
      inputTokens: tokenCount(isRecord(rawUsage) ? rawUsage['input_tokens'] : undefined),
      outputTokens: tokenCount(isRecord(rawUsage) ? rawUsage['output_tokens'] : undefined),
      // 5m/1h cache-TTL classes are summed upstream by the SDK's aggregate
      // fields; the split lives in the events store (BE-5, M3), not here.
      cacheReadTokens: tokenCount(isRecord(rawUsage) ? rawUsage['cache_read_input_tokens'] : undefined),
      cacheCreationTokens: tokenCount(
        isRecord(rawUsage) ? rawUsage['cache_creation_input_tokens'] : undefined,
      ),
    };
    const rawCost = message['total_cost_usd'];
    const costUsd =
      typeof rawCost === 'number' && Number.isFinite(rawCost) && rawCost >= 0 ? rawCost : undefined;
    const rawDuration = message['duration_ms'];
    const durationMs =
      typeof rawDuration === 'number' && Number.isSafeInteger(rawDuration) && rawDuration >= 0
        ? rawDuration
        : undefined;
    return [
      {
        kind: 'transcript-result',
        sessionId,
        ok: detail === 'success',
        detail,
        usage,
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      },
    ];
  };

  const projectStreamEvent = (message: Record<string, unknown>, uuid: string): TranscriptPayload[] => {
    const event = message['event'];
    if (!isRecord(event) || event['type'] !== 'content_block_delta') return [];
    const delta = event['delta'];
    if (!isRecord(delta) || delta['type'] !== 'text_delta') return [];
    const text = nonEmptyString(delta['text']);
    if (text === undefined) return []; // empty deltas are never sent (§9)
    sawStreamDelta = true;
    return [{ kind: 'transcript-delta', sessionId, messageUuid: uuid, text }];
  };

  const project = (raw: unknown): TranscriptPayload[] => {
    if (!isRecord(raw)) return [];
    switch (raw['type']) {
      case 'stream_event': {
        const uuid = nonEmptyString(raw['uuid']);
        return uuid === undefined ? [] : projectStreamEvent(raw, uuid);
      }
      case 'assistant': {
        const uuid = nonEmptyString(raw['uuid']);
        return uuid === undefined ? [] : projectAssistant(raw, uuid);
      }
      case 'user':
        return projectToolResults(raw);
      case 'result':
        return projectResult(raw);
      case 'other':
        // Kernel seam wrapper (RunnerOtherMessage) — unwrap and re-project.
        return project(raw['raw']);
      default:
        // init/system/unknown: nothing to project — the union stays narrow.
        return [];
    }
  };

  return { project };
}
