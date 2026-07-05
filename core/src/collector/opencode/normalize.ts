/**
 * OpenCode event normalization (BE-5 sources 4+5; blueprint §6.1 OpenCode
 * row; probe findings opencode-serve-event-probe.md; observability findings
 * §6 message.data shape: cost USD, token split incl. reasoning + cache
 * read/write, provider/model, latency = completed − created).
 *
 * INGESTED event types (live SSE): the message lifecycle events that carry
 * metric truth (`message.updated`, `message.part.updated`) and the session
 * lifecycle set (`session.created`, `session.updated`, `session.deleted`,
 * `session.error`, `session.idle`). UNKNOWN types — `server.heartbeat` is
 * not even in the OpenAPI spec — are IGNORED SILENTLY and counted (plan
 * §9.2 BE-5 negative row); the transport already tolerates them, the
 * collector just declines to mint rows for them.
 *
 * raw_ref discipline (the reconcile axis):
 *   - live SSE events carry the monotonic `evt_` id → raw_ref = that id;
 *   - the opencode.db `event` table stores THE SAME ids → a scrape row
 *     lands on the identical (backend='opencode', raw_ref) key and dedupes
 *     against its SSE twin (M3 DoD: "opencode.db scrape reconciles to
 *     identical ids");
 *   - durable REPLAY frames (`after=<seq>` gap repair) do NOT re-carry the
 *     original bus id (the stream re-wraps them), so healed rows key on
 *     `oc-durable:<sessionId>:<seq>` — stable per durable slot, replay-safe.
 */

import type { AccountLabel } from '@aibender/protocol';
import { backendForLabel, isAccountLabel } from '@aibender/protocol';
import type { NewEventRow } from '@aibender/schema';

import { CollectorError } from '../errors.js';
import { scrubIdentityText } from '../identity.js';

// ---------------------------------------------------------------------------
// Shared field extraction
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
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/** Event types the collector mints rows for (everything else: silent). */
export const OPENCODE_INGESTED_TYPES = Object.freeze([
  'message.updated',
  'message.part.updated',
  'session.created',
  'session.updated',
  'session.deleted',
  'session.error',
  'session.idle',
] as const);

export function isIngestedOpencodeType(type: string): boolean {
  return (OPENCODE_INGESTED_TYPES as readonly string[]).includes(type);
}

export function assertOpencodeLabel(account: AccountLabel): void {
  if (!isAccountLabel(account) || backendForLabel(account) !== 'opencode') {
    throw new CollectorError(`opencode sources require an opencode label — got ${String(account)}`);
  }
}

export interface MessageMetrics {
  readonly nativeSessionId?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly costEstimatedUsd?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly latencyMs?: number;
  readonly tsMs?: number;
}

/**
 * Pull the verified assistant-message metric block out of an event
 * `properties`/durable `data` payload (`info` wrapper or bare message.data).
 */
export function messageMetrics(properties: unknown): MessageMetrics {
  const record = asRecord(properties);
  const info = asRecord(record?.['info']) ?? record;
  if (info === undefined) return {};
  const tokens = asRecord(info['tokens']);
  const cache = asRecord(tokens?.['cache']);
  const time = asRecord(info['time']);
  const created = asCount(time?.['created']);
  const completed = asCount(time?.['completed']);
  const sessionId = asString(info['sessionID']) ?? asString(record?.['sessionID']);
  const model = asString(info['modelID']);
  const provider = asString(info['providerID']);
  const cost = info['cost'];
  return {
    ...(sessionId !== undefined ? { nativeSessionId: sessionId } : {}),
    ...(model !== undefined ? { model: scrubIdentityText(model) } : {}),
    ...(provider !== undefined ? { provider: scrubIdentityText(provider) } : {}),
    ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
      ? { costEstimatedUsd: cost }
      : {}),
    ...(asCount(tokens?.['input']) !== undefined ? { inputTokens: asCount(tokens?.['input']) } : {}),
    ...(asCount(tokens?.['output']) !== undefined
      ? { outputTokens: asCount(tokens?.['output']) }
      : {}),
    ...(asCount(tokens?.['reasoning']) !== undefined
      ? { reasoningTokens: asCount(tokens?.['reasoning']) }
      : {}),
    ...(asCount(cache?.['read']) !== undefined ? { cacheReadTokens: asCount(cache?.['read']) } : {}),
    ...(asCount(cache?.['write']) !== undefined
      ? { cacheCreationTokens: asCount(cache?.['write']) }
      : {}),
    ...(created !== undefined && completed !== undefined && completed >= created
      ? { latencyMs: completed - created }
      : {}),
    ...(created !== undefined ? { tsMs: created } : {}),
  } as MessageMetrics;
}

function metricsSpread(metrics: MessageMetrics): Partial<NewEventRow> {
  return {
    ...(metrics.nativeSessionId !== undefined ? { nativeSessionId: metrics.nativeSessionId } : {}),
    ...(metrics.model !== undefined ? { model: metrics.model } : {}),
    ...(metrics.provider !== undefined ? { provider: metrics.provider } : {}),
    ...(metrics.costEstimatedUsd !== undefined
      ? { costEstimatedUsd: metrics.costEstimatedUsd }
      : {}),
    ...(metrics.inputTokens !== undefined ? { inputTokens: metrics.inputTokens } : {}),
    ...(metrics.outputTokens !== undefined ? { outputTokens: metrics.outputTokens } : {}),
    ...(metrics.reasoningTokens !== undefined ? { reasoningTokens: metrics.reasoningTokens } : {}),
    ...(metrics.cacheReadTokens !== undefined ? { cacheReadTokens: metrics.cacheReadTokens } : {}),
    ...(metrics.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: metrics.cacheCreationTokens }
      : {}),
    ...(metrics.latencyMs !== undefined ? { latencyMs: metrics.latencyMs } : {}),
  };
}

// ---------------------------------------------------------------------------
// Live SSE event → row
// ---------------------------------------------------------------------------

export interface NormalizeLiveEventInput {
  readonly account: AccountLabel;
  /** The `evt_` id (dedupe key). Blank ids fall back to a content hash. */
  readonly id: string;
  readonly type: string;
  readonly properties: unknown;
  /** Clock for events without an embedded timestamp. */
  readonly fallbackTsMs: number;
}

export type LiveEventOutcome =
  | { readonly kind: 'row'; readonly row: NewEventRow }
  | { readonly kind: 'ignored' };

export function normalizeLiveOpencodeEvent(input: NormalizeLiveEventInput): LiveEventOutcome {
  if (!isIngestedOpencodeType(input.type)) return { kind: 'ignored' };
  if (input.id.length === 0) return { kind: 'ignored' }; // no dedupe key → refuse to guess
  const metrics = messageMetrics(input.properties);
  const isError = input.type === 'session.error';
  return {
    kind: 'row',
    row: {
      tsMs: metrics.tsMs ?? input.fallbackTsMs,
      backend: 'opencode',
      account: input.account,
      source: 'opencode-sse',
      eventType: scrubIdentityText(input.type),
      rawRef: input.id,
      ...metricsSpread(metrics),
      ...(isError ? { ok: false, errorKind: 'error' as const } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Durable replay frame → row (gap repair)
// ---------------------------------------------------------------------------

export interface NormalizeDurableEventInput {
  readonly account: AccountLabel;
  readonly sessionId: string;
  readonly seq: number;
  /** Parsed durable payload (SessionDurableEvent shape, kept loose). */
  readonly payload: unknown;
  readonly fallbackTsMs: number;
}

export function normalizeDurableOpencodeEvent(input: NormalizeDurableEventInput): NewEventRow {
  const record = asRecord(input.payload);
  const type = asString(record?.['type']) ?? 'durable-event';
  const metrics = messageMetrics(record?.['data']);
  return {
    tsMs: metrics.tsMs ?? input.fallbackTsMs,
    backend: 'opencode',
    account: input.account,
    source: 'opencode-sse',
    eventType: scrubIdentityText(type),
    rawRef: `oc-durable:${input.sessionId}:${String(input.seq)}`,
    ...metricsSpread(metrics),
    // The replay parameters name the session authoritatively.
    nativeSessionId: input.sessionId,
  };
}
