/**
 * Transcript JSONL line normalization (BE-5 source 1; blueprint §6.1
 * "Claude transcripts + insights": ground-truth tokens INCLUDING the 5m/1h
 * cache-TTL split; observability findings §2 line shapes).
 *
 * One transcript line yields:
 *   - an api_request JOIN HALF when the line is an `assistant` message with
 *     a `usage` block and a `requestId` (routed through the JSONL↔OTel
 *     joiner — tokens are THE ground truth, ingest.ts);
 *   - direct `tool_use` / `tool_result` rows for content blocks (skill/agent/
 *     MCP attribution for the §6.3 leaderboard, file_refs for context);
 *   - `ignored` for the non-metric line types (`system`, `attachment`,
 *     `queue-operation`, `ai-title`, `last-prompt`, plain user prompts);
 *   - `malformed` for unparseable lines — SKIPPED AND COUNTED, the tail
 *     continues (plan §9.2 BE-5 negative row).
 *
 * [X2]: the ACCOUNT comes from the watch root that owns the file — NEVER
 * from line content. Free-text values headed for semantic columns are
 * scrubbed for identity shapes at ingest.
 */

import type { AccountLabel } from '@aibender/protocol';
import type { EventUsage, NewEventRow } from '@aibender/schema';

import { scrubIdentityText } from '../identity.js';
import type { JsonlApiRequestHalf } from '../ingest.js';

// ---------------------------------------------------------------------------
// Outcome shape
// ---------------------------------------------------------------------------

export type TranscriptLineOutcome =
  | { readonly kind: 'malformed' }
  | { readonly kind: 'ignored' }
  | {
      readonly kind: 'normalized';
      /** Present when the line carries a usage block + requestId (join half). */
      readonly apiRequest?: JsonlApiRequestHalf;
      /** Direct rows: usage-without-requestId, tool_use, tool_result. */
      readonly rows: readonly NewEventRow[];
    };

export interface NormalizeTranscriptLineInput {
  /** From the watch root ONLY [X2]. */
  readonly account: AccountLabel;
  readonly line: string;
}

// ---------------------------------------------------------------------------
// Field extraction helpers (defensive over an evolving CLI line format)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Decode the transcript `usage` block, including the ephemeral TTL split. */
export function usageFromTranscript(value: unknown): EventUsage | undefined {
  const usage = asRecord(value);
  if (usage === undefined) return undefined;
  const cacheCreation = asRecord(usage['cache_creation']);
  const inputTokens = asCount(usage['input_tokens']);
  const outputTokens = asCount(usage['output_tokens']);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  const cacheRead = asCount(usage['cache_read_input_tokens']);
  const cacheCreationTotal = asCount(usage['cache_creation_input_tokens']);
  const ttl5m = asCount(cacheCreation?.['ephemeral_5m_input_tokens']);
  const ttl1h = asCount(cacheCreation?.['ephemeral_1h_input_tokens']);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheCreationTotal !== undefined ? { cacheCreationTokens: cacheCreationTotal } : {}),
    ...(ttl5m !== undefined ? { cacheCreation5mTokens: ttl5m } : {}),
    ...(ttl1h !== undefined ? { cacheCreation1hTokens: ttl1h } : {}),
  };
}

function fileRefsFromToolInput(input: Record<string, unknown> | undefined): readonly string[] {
  if (input === undefined) return [];
  const refs: string[] = [];
  for (const key of ['file_path', 'path', 'notebook_path'] as const) {
    const value = input[key];
    if (typeof value === 'string' && value.startsWith('/')) refs.push(value);
  }
  return refs;
}

/** Attribution extras for one tool_use block (Skill / Task / MCP naming). */
function toolAttribution(
  name: string,
  input: Record<string, unknown> | undefined,
): Pick<NewEventRow, 'toolName' | 'skillName' | 'agentName' | 'mcpServer'> {
  const toolName = scrubIdentityText(name);
  const extras: {
    toolName: string;
    skillName?: string;
    agentName?: string;
    mcpServer?: string;
  } = { toolName };
  if (name === 'Skill') {
    const skill = asString(input?.['skill']) ?? asString(input?.['command']);
    if (skill !== undefined) extras.skillName = scrubIdentityText(skill);
  }
  if (name === 'Task') {
    const agent = asString(input?.['subagent_type']);
    if (agent !== undefined) extras.agentName = scrubIdentityText(agent);
  }
  if (name.startsWith('mcp__')) {
    const server = name.split('__')[1];
    if (server !== undefined && server.length > 0) extras.mcpServer = scrubIdentityText(server);
  }
  return extras;
}

// ---------------------------------------------------------------------------
// The normalizer
// ---------------------------------------------------------------------------

export function normalizeTranscriptLine(
  input: NormalizeTranscriptLineInput,
): TranscriptLineOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.line);
  } catch {
    return { kind: 'malformed' };
  }
  const record = asRecord(parsed);
  if (record === undefined) return { kind: 'malformed' };

  const lineType = asString(record['type']);
  if (lineType !== 'assistant' && lineType !== 'user') return { kind: 'ignored' };

  const timestamp = asString(record['timestamp']);
  const tsMs = timestamp !== undefined ? Date.parse(timestamp) : Number.NaN;
  const message = asRecord(record['message']);
  const nativeSessionId = asString(record['sessionId']);
  const uuid = asString(record['uuid']);
  const content = Array.isArray(message?.['content']) ? (message['content'] as unknown[]) : [];

  const rows: NewEventRow[] = [];
  let apiRequest: JsonlApiRequestHalf | undefined;

  if (lineType === 'assistant' && message !== undefined) {
    const usage = usageFromTranscript(message['usage']);
    if (usage !== undefined) {
      // A metric-bearing line with no usable timestamp cannot be placed on
      // the dashboard time axis — treat as malformed (skipped, counted).
      if (!Number.isFinite(tsMs) || tsMs < 0) return { kind: 'malformed' };
      const requestId = asString(record['requestId']);
      const model = asString(message['model']);
      if (requestId !== undefined) {
        apiRequest = {
          requestId,
          account: input.account,
          tsMs,
          usage,
          ...(nativeSessionId !== undefined ? { nativeSessionId } : {}),
          ...(model !== undefined ? { model: scrubIdentityText(model) } : {}),
        };
      } else if (uuid !== undefined) {
        // No request id to join on — honest single-source row keyed by the
        // line uuid (stable across re-tails).
        rows.push({
          tsMs,
          backend: 'claude_code',
          account: input.account,
          source: 'claude-jsonl',
          eventType: 'api_request',
          rawRef: `jsonl-line:${uuid}`,
          ...(nativeSessionId !== undefined ? { nativeSessionId } : {}),
          ...(model !== undefined ? { model: scrubIdentityText(model) } : {}),
          ...usage,
        });
      }
    }

    // tool_use content blocks → attribution rows (leaderboard inputs).
    if (Number.isFinite(tsMs) && tsMs >= 0) {
      content.forEach((blockValue, index) => {
        const block = asRecord(blockValue);
        if (block === undefined || block['type'] !== 'tool_use') return;
        const name = asString(block['name']);
        if (name === undefined) return;
        const blockId = asString(block['id']);
        const toolInput = asRecord(block['input']);
        const fileRefs = fileRefsFromToolInput(toolInput);
        rows.push({
          tsMs,
          backend: 'claude_code',
          account: input.account,
          source: 'claude-jsonl',
          eventType: 'tool_use',
          rawRef:
            blockId !== undefined
              ? `tool_use:${blockId}`
              : `tool_use:${uuid ?? 'line'}:${String(index)}`,
          ...(nativeSessionId !== undefined ? { nativeSessionId } : {}),
          ...toolAttribution(name, toolInput),
          ...(fileRefs.length > 0 ? { fileRefs } : {}),
        });
      });
    }
  }

  if (lineType === 'user' && Number.isFinite(tsMs) && tsMs >= 0) {
    // tool_result blocks ride user lines (findings §2).
    content.forEach((blockValue, index) => {
      const block = asRecord(blockValue);
      if (block === undefined || block['type'] !== 'tool_result') return;
      const toolUseId = asString(block['tool_use_id']);
      const isError = block['is_error'] === true;
      rows.push({
        tsMs,
        backend: 'claude_code',
        account: input.account,
        source: 'claude-jsonl',
        eventType: 'tool_result',
        rawRef:
          toolUseId !== undefined
            ? `tool_result:${toolUseId}`
            : `tool_result:${uuid ?? 'line'}:${String(index)}`,
        ...(nativeSessionId !== undefined ? { nativeSessionId } : {}),
        ok: !isError,
        ...(isError ? { errorKind: 'error' as const } : {}),
      });
    });
  }

  if (apiRequest === undefined && rows.length === 0) return { kind: 'ignored' };
  return {
    kind: 'normalized',
    ...(apiRequest !== undefined ? { apiRequest } : {}),
    rows,
  };
}
