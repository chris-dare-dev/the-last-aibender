/**
 * OTLP → events mapping (BE-5 source 3; blueprint §6.1 row 1: Claude Code
 * OTel events — `api_request`, `user_prompt`, `tool_result`, `tool_decision`,
 * `skill_activated`, … — arrive as OTLP LOG RECORDS; findings
 * observability.md §1).
 *
 * Attribution [X2]:
 *   - the ACCOUNT comes from the harness-stamped resource attribute
 *     `account=<LABEL>` (`OTEL_RESOURCE_ATTRIBUTES`, SI-3 env block) and from
 *     NOTHING else; a batch without a valid label is DROPPED and counted —
 *     never guessed;
 *   - identity-bearing attribute keys (user.email, user.account_uuid,
 *     organization.id, …) are dropped wholesale at ingest; every string
 *     value headed for a semantic column is shape-scrubbed.
 *
 * api_request records become JSONL↔OTel JOIN HALVES (OTel wins for
 * attribution, JSONL wins for tokens — ingest.ts); every other event becomes
 * a direct `claude-otel` row with a content-derived raw_ref (OTLP exporters
 * RETRY batches — the raw_ref must be stable so a redelivered batch dedupes
 * in the store).
 */

import type { AccountLabel } from '@aibender/protocol';
import { backendForLabel, isAccountLabel } from '@aibender/protocol';
import type { EventUsage, NewEventRow } from '@aibender/schema';

import { fnv32Hex } from '../hash.js';
import { isIdentityAttributeKey, scrubIdentityText } from '../identity.js';
import type { OtelApiRequestHalf } from '../ingest.js';

// ---------------------------------------------------------------------------
// OTLP JSON decoding (the http/json flavor SI-3 configures)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Decode one OTLP AnyValue into a JS primitive (undefined when exotic). */
function decodeAnyValue(value: unknown): string | number | boolean | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  if (typeof record['stringValue'] === 'string') return record['stringValue'];
  if (typeof record['boolValue'] === 'boolean') return record['boolValue'];
  if (typeof record['doubleValue'] === 'number') return record['doubleValue'];
  const intValue = record['intValue'];
  if (typeof intValue === 'number') return intValue;
  if (typeof intValue === 'string') {
    const parsed = Number(intValue);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Flatten an OTLP attribute list into a record, DROPPING identity-bearing
 * keys at ingest [X2].
 */
export function decodeOtlpAttributes(
  attributes: unknown,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!Array.isArray(attributes)) return out;
  for (const entry of attributes) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    const key = record['key'];
    if (typeof key !== 'string' || key.length === 0) continue;
    if (isIdentityAttributeKey(key)) continue; // dropped at ingest [X2]
    const value = decodeAnyValue(record['value']);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The resource-attribute account label, or undefined (drop, never guess). */
export function accountFromResource(resource: unknown): AccountLabel | undefined {
  const attrs = decodeOtlpAttributes(asRecord(resource)?.['attributes']);
  const label = attrs['account'];
  if (typeof label === 'string' && isAccountLabel(label) && backendForLabel(label) === 'claude_code') {
    return label;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Log-record → row/half mapping
// ---------------------------------------------------------------------------

function attrString(
  attrs: Record<string, string | number | boolean>,
  ...keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = attrs[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function attrCount(
  attrs: Record<string, string | number | boolean>,
  ...keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = attrs[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.round(value);
    }
    if (typeof value === 'string' && value.length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed);
    }
  }
  return undefined;
}

function attrUsd(
  attrs: Record<string, string | number | boolean>,
  ...keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = attrs[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    if (typeof value === 'string' && value.length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
  }
  return undefined;
}

function tsMsOfLogRecord(record: Record<string, unknown>, fallbackMs: number): number {
  for (const key of ['timeUnixNano', 'observedTimeUnixNano'] as const) {
    const value = record[key];
    const nano = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN;
    if (Number.isFinite(nano) && nano > 0) return Math.round(nano / 1e6);
  }
  return fallbackMs;
}

export type MappedLogRecord =
  | { readonly kind: 'api-request-half'; readonly half: OtelApiRequestHalf }
  | { readonly kind: 'row'; readonly row: NewEventRow }
  | { readonly kind: 'skipped' };

/**
 * Map one OTLP log record. `api_request` events become join halves; all
 * other named events become direct rows; records with no event name are
 * skipped (counted by the receiver).
 */
export function mapOtlpLogRecord(
  account: AccountLabel,
  logRecord: unknown,
  fallbackNowMs: number,
): MappedLogRecord {
  const record = asRecord(logRecord);
  if (record === undefined) return { kind: 'skipped' };
  const attrs = decodeOtlpAttributes(record['attributes']);
  const body = decodeAnyValue(record['body']);

  const eventName =
    attrString(attrs, 'event.name', 'event_name') ??
    (typeof body === 'string' && body.length > 0 && body.length <= 64 ? body : undefined);
  if (eventName === undefined) return { kind: 'skipped' };

  const tsMs = tsMsOfLogRecord(record, fallbackNowMs);
  const nativeSessionId = attrString(attrs, 'session.id', 'session_id');
  const model = attrString(attrs, 'model');
  const promptId = attrString(attrs, 'prompt.id', 'prompt_id');
  const requestId = attrString(attrs, 'request_id', 'request.id', 'requestId');
  const toolName = attrString(attrs, 'tool_name', 'tool.name');
  const skillName = attrString(attrs, 'skill.name', 'skill_name');
  const agentName = attrString(attrs, 'agent.name', 'agent_name');
  const mcpServer = attrString(attrs, 'mcp_server.name', 'mcp_server');
  const durationMs = attrCount(attrs, 'duration_ms', 'duration.ms');
  const costUsd = attrUsd(attrs, 'cost_usd', 'cost.usd');
  const success = attrs['success'];

  const inputTokens = attrCount(attrs, 'input_tokens');
  const outputTokens = attrCount(attrs, 'output_tokens');
  const cacheReadTokens = attrCount(attrs, 'cache_read_tokens');
  const cacheCreationTokens = attrCount(attrs, 'cache_creation_tokens');
  const usage: EventUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
  };

  const attribution = {
    ...(toolName !== undefined ? { toolName: scrubIdentityText(toolName) } : {}),
    ...(skillName !== undefined ? { skillName: scrubIdentityText(skillName) } : {}),
    ...(agentName !== undefined ? { agentName: scrubIdentityText(agentName) } : {}),
    ...(mcpServer !== undefined ? { mcpServer: scrubIdentityText(mcpServer) } : {}),
  };

  if (eventName === 'api_request' && requestId !== undefined) {
    return {
      kind: 'api-request-half',
      half: {
        requestId,
        account,
        tsMs,
        usage,
        ...(nativeSessionId !== undefined ? { nativeSessionId } : {}),
        ...(model !== undefined ? { model: scrubIdentityText(model) } : {}),
        ...(promptId !== undefined ? { promptId } : {}),
        ...(costUsd !== undefined ? { costEstimatedUsd: costUsd } : {}),
        ...(durationMs !== undefined ? { latencyMs: durationMs } : {}),
        ...attribution,
        ...(typeof success === 'boolean' ? { ok: success } : {}),
      },
    };
  }

  // Direct row. Content-derived raw_ref: identical redelivered records
  // (exporter retry) land on the same key and dedupe in the store.
  const identity = JSON.stringify([account, eventName, tsMs, nativeSessionId ?? '', attrs]);
  const errorish = eventName === 'api_error' || attrs['error'] !== undefined;
  const retryish = eventName === 'api_retries_exhausted';
  return {
    kind: 'row',
    row: {
      tsMs,
      backend: 'claude_code',
      account,
      source: 'claude-otel',
      eventType: scrubIdentityText(eventName),
      rawRef: `otel:${fnv32Hex(identity)}`,
      ...(nativeSessionId !== undefined ? { nativeSessionId } : {}),
      ...(model !== undefined ? { model: scrubIdentityText(model) } : {}),
      ...(promptId !== undefined ? { promptId } : {}),
      ...usage,
      ...(costUsd !== undefined ? { costEstimatedUsd: costUsd } : {}),
      ...(durationMs !== undefined ? { latencyMs: durationMs } : {}),
      ...attribution,
      ...(typeof success === 'boolean' ? { ok: success } : {}),
      ...(retryish ? { errorKind: 'retry' as const } : errorish ? { errorKind: 'error' as const } : {}),
    },
  };
}
