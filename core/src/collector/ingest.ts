/**
 * The normalizer's JSONL↔OTel join (blueprint §6.2: "Dedup on (backend,
 * raw_ref); JSONL wins for token truth, OTel wins for attribution, joined on
 * request/session ids").
 *
 * Both the per-account JSONL tailer and the OTLP receiver observe the SAME
 * api_request: the transcript line carries the ground-truth `usage` block
 * (including the 5m/1h cache-TTL split that OTel does not expose), the OTel
 * event carries the attribution fields (skill/agent/MCP/tool names, prompt.id,
 * cost_usd, duration_ms). Inserting both naively would double-count tokens.
 *
 * The joiner therefore:
 *   1. buffers each half keyed on `request_id`;
 *   2. when both halves meet, inserts ONE merged row — tokens from JSONL,
 *      attribution from OTel, `source: 'claude-jsonl'` (token truth);
 *   3. flushes unmatched halves after a window as honest single-source rows;
 *   4. uses the CANONICAL raw_ref `api_request:<request_id>` for every
 *      api_request row from EITHER source, so the store's (backend, raw_ref)
 *      dedupe is the safety net: even a late twin that misses the in-memory
 *      window can never double-count — it lands on the existing row as a
 *      silent no-op (`inserted: false`), merely losing the merge for that row
 *      (counted in {@link ApiJoinerStats.lateTwinsDropped}).
 *
 * Restart safety: re-tailing a rotated transcript re-offers the same halves;
 * the canonical raw_ref makes every re-insert a dedupe no-op (plan §9.2 BE-5
 * edge rows).
 */

import type { AccountLabel } from '@aibender/protocol';
import { backendForLabel, isAccountLabel } from '@aibender/protocol';
import type { EventInsertOutcome, EventUsage, EventsTableStore, NewEventRow } from '@aibender/schema';

import { CollectorError } from './errors.js';

// ---------------------------------------------------------------------------
// Half shapes
// ---------------------------------------------------------------------------

/** Canonical api_request raw_ref — one key for both sources (dedupe axis). */
export function apiRequestRawRef(requestId: string): string {
  return `api_request:${requestId}`;
}

interface ApiRequestHalfBase {
  readonly requestId: string;
  /** From the watch root (JSONL) / resource attribute (OTel) ONLY [X2]. */
  readonly account: AccountLabel;
  readonly tsMs: number;
  readonly nativeSessionId?: string;
  readonly model?: string;
}

/** The transcript half: ground-truth tokens incl. the cache-TTL split. */
export interface JsonlApiRequestHalf extends ApiRequestHalfBase {
  readonly usage: EventUsage;
}

/** The OTel half: attribution truth (+ its own token counts as fallback). */
export interface OtelApiRequestHalf extends ApiRequestHalfBase {
  readonly usage?: EventUsage;
  readonly costEstimatedUsd?: number;
  readonly latencyMs?: number;
  readonly promptId?: string;
  readonly toolName?: string;
  readonly skillName?: string;
  readonly agentName?: string;
  readonly mcpServer?: string;
  readonly provider?: string;
  readonly ok?: boolean;
}

export interface ApiJoinerStats {
  /** Rows inserted with both halves merged. */
  readonly merged: number;
  /** Unmatched JSONL halves flushed as single-source rows. */
  readonly jsonlOnly: number;
  /** Unmatched OTel halves flushed as single-source rows. */
  readonly otelOnly: number;
  /** Halves whose insert hit an existing (backend, raw_ref) row. */
  readonly lateTwinsDropped: number;
  /** Halves whose account label disagreed (JSONL/watch-root label wins). */
  readonly labelMismatches: number;
  /**
   * Pending halves flushed EARLY as single-source rows because the map hit its
   * `maxPending` cap (finding OS-6). These are ALSO counted in jsonlOnly/otelOnly
   * (they land as single-source rows); `evicted` records how many of those were
   * cap-driven rather than window-driven. A late twin can still arrive and dedupe
   * onto the row (lateTwinsDropped), so eviction never double-counts tokens.
   */
  readonly evicted: number;
}

export interface ApiRequestJoiner {
  offerJsonl(half: JsonlApiRequestHalf): void;
  offerOtel(half: OtelApiRequestHalf): void;
  /** Insert unmatched halves older than the window (or all with maxAgeMs 0). */
  flush(maxAgeMs?: number): number;
  /** Buffered, not-yet-inserted halves (either side). */
  pendingCount(): number;
  stats(): ApiJoinerStats;
  /**
   * Stop the internal flush timer if one was started (`flushIntervalMs`). Safe to
   * call when no timer is running (a no-op). Idempotent. The composition root
   * calls this on broker teardown; ingest-driven joiners without a timer need not.
   */
  close(): void;
}

export interface ApiRequestJoinerOptions {
  /** Injectable clock (epoch ms) for window math. */
  readonly nowMs?: () => number;
  /** Join window before an unmatched half flushes alone. Default 120 000. */
  readonly windowMs?: number;
  /**
   * Hard cap on buffered pending halves (finding OS-6). When a NEW request_id
   * would push `pending` past this, the OLDEST pending half is evicted first —
   * flushed as a single-source row (counted in {@link ApiJoinerStats.evicted}) —
   * so an imbalanced source (OTLP down / a JSONL-only burst) cannot grow the map
   * without bound. Default 50 000. Must be a positive integer.
   */
  readonly maxPending?: number;
  /**
   * When set, the joiner runs its OWN flush on this interval (ms), independent of
   * ingest arrival (finding OS-6 "drive flush on a timer independent of ingest").
   * The timer is `unref`'d so it never keeps the process alive; {@link
   * ApiRequestJoiner.close} clears it. Omit to keep the caller-driven flush the
   * only cadence (the default, byte-identical to the pre-OS-6 behavior).
   */
  readonly flushIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface PendingHalves {
  jsonl?: JsonlApiRequestHalf;
  otel?: OtelApiRequestHalf;
  bufferedAtMs: number;
}

function usageSpread(usage: EventUsage | undefined): EventUsage {
  if (usage === undefined) return {};
  return {
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: usage.cacheCreationTokens }
      : {}),
    ...(usage.cacheCreation5mTokens !== undefined
      ? { cacheCreation5mTokens: usage.cacheCreation5mTokens }
      : {}),
    ...(usage.cacheCreation1hTokens !== undefined
      ? { cacheCreation1hTokens: usage.cacheCreation1hTokens }
      : {}),
    ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
  };
}

export function createApiRequestJoiner(
  store: EventsTableStore,
  options: ApiRequestJoinerOptions = {},
): ApiRequestJoiner {
  const nowMs = options.nowMs ?? Date.now;
  const windowMs = options.windowMs ?? 120_000;
  const maxPending =
    options.maxPending !== undefined && Number.isInteger(options.maxPending) && options.maxPending > 0
      ? options.maxPending
      : 50_000;

  const pending = new Map<string, PendingHalves>();
  const stats = { merged: 0, jsonlOnly: 0, otelOnly: 0, lateTwinsDropped: 0, labelMismatches: 0, evicted: 0 };

  const assertClaudeLabel = (half: ApiRequestHalfBase): void => {
    if (!isAccountLabel(half.account) || backendForLabel(half.account) !== 'claude_code') {
      throw new CollectorError(
        `api_request joiner only joins claude_code accounts — got ${String(half.account)}`,
      );
    }
    if (half.requestId.trim().length === 0) {
      throw new CollectorError('api_request half requires a non-blank requestId');
    }
  };

  const insertCounted = (row: NewEventRow, bucket: 'merged' | 'jsonlOnly' | 'otelOnly'): EventInsertOutcome => {
    const outcome = store.insert(row);
    if (outcome.inserted) stats[bucket] += 1;
    else stats.lateTwinsDropped += 1;
    return outcome;
  };

  const mergedRow = (jsonl: JsonlApiRequestHalf, otel: OtelApiRequestHalf): NewEventRow => {
    if (otel.account !== jsonl.account) stats.labelMismatches += 1; // JSONL (watch root) wins
    const nativeSessionId = jsonl.nativeSessionId ?? otel.nativeSessionId;
    const model = jsonl.model ?? otel.model;
    return {
      tsMs: jsonl.tsMs,
      backend: 'claude_code',
      account: jsonl.account,
      source: 'claude-jsonl', // token truth names the source of record
      eventType: 'api_request',
      rawRef: apiRequestRawRef(jsonl.requestId),
      ...(nativeSessionId !== undefined ? { nativeSessionId } : {}),
      ...(model !== undefined ? { model } : {}),
      ...usageSpread(jsonl.usage),
      ...(otel.promptId !== undefined ? { promptId: otel.promptId } : {}),
      ...(otel.provider !== undefined ? { provider: otel.provider } : {}),
      ...(otel.costEstimatedUsd !== undefined ? { costEstimatedUsd: otel.costEstimatedUsd } : {}),
      ...(otel.latencyMs !== undefined ? { latencyMs: otel.latencyMs } : {}),
      ...(otel.toolName !== undefined ? { toolName: otel.toolName } : {}),
      ...(otel.skillName !== undefined ? { skillName: otel.skillName } : {}),
      ...(otel.agentName !== undefined ? { agentName: otel.agentName } : {}),
      ...(otel.mcpServer !== undefined ? { mcpServer: otel.mcpServer } : {}),
      ...(otel.ok !== undefined ? { ok: otel.ok } : {}),
    };
  };

  const jsonlOnlyRow = (half: JsonlApiRequestHalf): NewEventRow => ({
    tsMs: half.tsMs,
    backend: 'claude_code',
    account: half.account,
    source: 'claude-jsonl',
    eventType: 'api_request',
    rawRef: apiRequestRawRef(half.requestId),
    ...(half.nativeSessionId !== undefined ? { nativeSessionId: half.nativeSessionId } : {}),
    ...(half.model !== undefined ? { model: half.model } : {}),
    ...usageSpread(half.usage),
  });

  const otelOnlyRow = (half: OtelApiRequestHalf): NewEventRow => ({
    tsMs: half.tsMs,
    backend: 'claude_code',
    account: half.account,
    source: 'claude-otel',
    eventType: 'api_request',
    rawRef: apiRequestRawRef(half.requestId),
    ...(half.nativeSessionId !== undefined ? { nativeSessionId: half.nativeSessionId } : {}),
    ...(half.model !== undefined ? { model: half.model } : {}),
    ...usageSpread(half.usage),
    ...(half.promptId !== undefined ? { promptId: half.promptId } : {}),
    ...(half.provider !== undefined ? { provider: half.provider } : {}),
    ...(half.costEstimatedUsd !== undefined ? { costEstimatedUsd: half.costEstimatedUsd } : {}),
    ...(half.latencyMs !== undefined ? { latencyMs: half.latencyMs } : {}),
    ...(half.toolName !== undefined ? { toolName: half.toolName } : {}),
    ...(half.skillName !== undefined ? { skillName: half.skillName } : {}),
    ...(half.agentName !== undefined ? { agentName: half.agentName } : {}),
    ...(half.mcpServer !== undefined ? { mcpServer: half.mcpServer } : {}),
    ...(half.ok !== undefined ? { ok: half.ok } : {}),
  });

  // Insert a pending entry's ONE buffered half as a single-source row. A pending
  // entry always holds exactly one side (a matched pair merges + deletes on the
  // spot), so this is unambiguous.
  const flushSingle = (entry: PendingHalves): void => {
    if (entry.jsonl !== undefined) insertCounted(jsonlOnlyRow(entry.jsonl), 'jsonlOnly');
    else if (entry.otel !== undefined) insertCounted(otelOnlyRow(entry.otel), 'otelOnly');
  };

  // OS-6: before buffering a NEW request_id, evict the OLDEST pending half if the
  // map is at its cap. Map iteration is insertion-ordered and `bufferedAtMs` is
  // stamped on first insert (preserved across the same-side re-set), so the first
  // key is the oldest-buffered entry. Evicting it early — as an honest
  // single-source row, counted — bounds memory under source imbalance (OTLP down,
  // a JSONL-only burst). A late twin still dedupes onto the row, so no double count.
  const evictIfFull = (): void => {
    while (pending.size >= maxPending) {
      const oldest = pending.keys().next();
      if (oldest.done === true) break;
      const requestId = oldest.value;
      const entry = pending.get(requestId);
      pending.delete(requestId);
      if (entry !== undefined) {
        flushSingle(entry);
        stats.evicted += 1;
      }
    }
  };

  const flush = (maxAgeMs = windowMs): number => {
    const cutoff = nowMs() - maxAgeMs;
    // OS-6: collect expired keys in a single pass (bounded by the expired count),
    // then delete — no `[...pending.entries()]` snapshot of the WHOLE map per flush.
    const expired: string[] = [];
    for (const [requestId, entry] of pending) {
      if (entry.bufferedAtMs <= cutoff) expired.push(requestId);
    }
    for (const requestId of expired) {
      const entry = pending.get(requestId);
      pending.delete(requestId);
      if (entry !== undefined) flushSingle(entry);
    }
    return expired.length;
  };

  // OS-6: an OPTIONAL flush cadence independent of ingest arrival. `unref` keeps
  // it from pinning the event loop / holding the process open; `close` clears it.
  let timer: ReturnType<typeof setInterval> | undefined;
  if (options.flushIntervalMs !== undefined && options.flushIntervalMs > 0) {
    timer = setInterval(() => {
      flush();
    }, options.flushIntervalMs);
    timer.unref?.();
  }

  return {
    offerJsonl: (half) => {
      assertClaudeLabel(half);
      const entry = pending.get(half.requestId);
      if (entry?.otel !== undefined) {
        pending.delete(half.requestId);
        insertCounted(mergedRow(half, entry.otel), 'merged');
        return;
      }
      if (entry === undefined) evictIfFull();
      pending.set(half.requestId, {
        ...(entry ?? { bufferedAtMs: nowMs() }),
        jsonl: half,
      });
    },

    offerOtel: (half) => {
      assertClaudeLabel(half);
      const entry = pending.get(half.requestId);
      if (entry?.jsonl !== undefined) {
        pending.delete(half.requestId);
        insertCounted(mergedRow(entry.jsonl, half), 'merged');
        return;
      }
      if (entry === undefined) evictIfFull();
      pending.set(half.requestId, {
        ...(entry ?? { bufferedAtMs: nowMs() }),
        otel: half,
      });
    },

    flush,

    pendingCount: () => pending.size,
    stats: () => ({ ...stats }),

    close: () => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
