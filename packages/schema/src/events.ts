/**
 * Typed accessors for the M3 observability events store (migration 0002 —
 * events / quota_snapshots / session_outcomes / prices; blueprint §6.2,
 * plan §4/BE-5). Same adapter pattern as the kernel tables: everything talks
 * to {@link SqliteDriver}, never to node:sqlite directly.
 *
 * THE VALIDATED INSERT PATH [X2]: beyond the DDL CHECKs (label enum,
 * label↔backend pairing, source/error-kind enums), the insert path REFUSES
 * identity-shaped content (emails, 12-digit runs, token-shaped strings) in
 * the semantic attribution columns — a careless collector cannot launder an
 * identity attribute into the store. Machine-local PATH columns (raw_ref,
 * file_refs, facets_json) are exempt from the shape screen (paths are
 * legitimate machine-local values) and are instead `identifier`-tagged in
 * {@link EVENTS_FIELD_TAGS} for the @aibender/shared redaction filters.
 *
 * DEDUPE (blueprint §6.2): events dedupe on (backend, raw_ref) — a duplicate
 * insert is a silent no-op that reports `inserted: false` and returns the
 * EXISTING row (plan §9.2 BE-5 edge "duplicate (backend, raw_ref) upsert").
 * Cost Explorer backfill ({@link EventsStore.backfillCostActual}) writes
 * `cost_actual_usd` ONLY — never the estimate, never raw fields.
 *
 * ============================================================================
 * FROZEN-M3 (2026-07-04). Amendments only via ICR (docs/contracts/icr/).
 * Prose of record: docs/contracts/sqlite-ddl.md.
 * ============================================================================
 */

import {
  QUOTA_SOURCES,
  QUOTA_WINDOWS,
  backendForLabel,
  isAccountLabel,
  isBackend,
  isEventErrorKind,
  isEventSource,
  type AccountLabel,
  type Backend,
  type EventErrorKind,
  type EventSource,
  type QuotaSource,
  type QuotaWindow,
} from '@aibender/protocol';
import type { FieldTag } from '@aibender/shared';

import type { SqlRow, SqlValue, SqliteDriver } from './driver.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class EventsStoreError extends Error {
  override readonly name: string = 'EventsStoreError';
}

export class EventNotFoundError extends EventsStoreError {
  override readonly name = 'EventNotFoundError';
  constructor(backend: string, rawRef: string) {
    super(`no events row for (${backend}, ${rawRef})`);
  }
}

// ---------------------------------------------------------------------------
// Field tags — consumed by @aibender/shared redaction (plan §3) [X2]
// ---------------------------------------------------------------------------

/**
 * Column → redaction tags for events-store columns that can carry sensitive
 * material. Paths embed the machine username → `identifier`. Labels are
 * placeholders; nothing in this store is `secret` — credentials never touch
 * it (Keychain-primary [X2]).
 */
export const EVENTS_FIELD_TAGS: Readonly<Record<string, readonly FieldTag[]>> = Object.freeze({
  raw_ref: ['identifier'],
  file_refs: ['identifier'],
  facets_json: ['identifier'],
});

// ---------------------------------------------------------------------------
// Identity-shape screen (the validated insert path, [X2])
// ---------------------------------------------------------------------------

// Detector regexes only — no literal identity values live in this file.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const TWELVE_DIGIT_RE = /\d{12}/;
const TOKEN_SHAPED_RE = /\bsk-[A-Za-z0-9_-]{8,}/;

/**
 * Refuse identity-shaped content in a semantic attribution column. NOT
 * applied to path/JSON columns (raw_ref, file_refs, facets_json — epoch-ms
 * values inside JSON legitimately contain long digit runs); those are
 * `identifier`-tagged for redaction instead.
 */
export function assertIdentityFreeColumn(column: string, value: string): void {
  for (const [what, re] of [
    ['an email address', EMAIL_RE],
    ['a 12-digit run (AWS-account-id shaped)', TWELVE_DIGIT_RE],
    ['a token-shaped string', TOKEN_SHAPED_RE],
  ] as const) {
    if (re.test(value)) {
      throw new EventsStoreError(
        `events store refuses ${what} in column ${column} — identity attributes are ` +
          'dropped or mapped to labels at ingest [X2]',
      );
    }
  }
}

function nowIsoDefault(): string {
  return new Date().toISOString();
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

// ---------------------------------------------------------------------------
// events accessor
// ---------------------------------------------------------------------------

export interface EventUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  /** 5m/1h cache-TTL split (JSONL ground truth, blueprint §6.1). */
  readonly cacheCreation5mTokens?: number;
  readonly cacheCreation1hTokens?: number;
  readonly reasoningTokens?: number;
}

export interface NewEventRow extends EventUsage {
  readonly tsMs: number;
  readonly backend: Backend;
  readonly account: AccountLabel;
  readonly source: EventSource;
  /** Open vocabulary — non-empty, identity-screened. */
  readonly eventType: string;
  readonly sessionId?: string;
  readonly nativeSessionId?: string;
  readonly workstreamId?: string;
  readonly promptId?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly costEstimatedUsd?: number;
  readonly costActualUsd?: number;
  readonly latencyMs?: number;
  readonly ttftMs?: number;
  readonly toolName?: string;
  readonly skillName?: string;
  readonly agentName?: string;
  readonly mcpServer?: string;
  readonly ok?: boolean;
  readonly errorKind?: EventErrorKind;
  /** Absolute file paths; stored as a JSON array (identifier-tagged). */
  readonly fileRefs?: readonly string[];
  /** Pointer back to the source line/row — half of the dedupe key. */
  readonly rawRef: string;
}

export interface EventRow extends Omit<NewEventRow, 'fileRefs'> {
  readonly id: number;
  readonly fileRefs?: readonly string[];
  readonly ingestedAtIso: string;
}

export interface EventInsertOutcome {
  readonly row: EventRow;
  /** False when (backend, raw_ref) already existed — the dedupe no-op. */
  readonly inserted: boolean;
}

export interface EventFilter {
  readonly account?: AccountLabel;
  readonly backend?: Backend;
  readonly source?: EventSource;
  readonly eventType?: string;
  readonly sinceTsMs?: number;
  readonly untilTsMs?: number;
  readonly limit?: number;
}

const EVENT_COLUMNS =
  'id, ts_ms, backend, account, source, event_type, session_id, native_session_id, ' +
  'workstream_id, prompt_id, model, provider, input_tokens, output_tokens, ' +
  'cache_read_tokens, cache_creation_tokens, cache_creation_5m_tokens, ' +
  'cache_creation_1h_tokens, reasoning_tokens, cost_estimated_usd, cost_actual_usd, ' +
  'latency_ms, ttft_ms, tool_name, skill_name, agent_name, mcp_server, ok, error_kind, ' +
  'file_refs, raw_ref, ingested_at_iso';

function optionalNumber(value: SqlValue): number | undefined {
  return value === null ? undefined : Number(value);
}

function eventFromSql(row: SqlRow): EventRow {
  const backend = row['backend'];
  const account = row['account'];
  const source = row['source'];
  if (!isBackend(backend) || !isAccountLabel(account) || !isEventSource(source)) {
    throw new EventsStoreError(`events row ${String(row['id'])} fails vocabulary decode`);
  }
  const errorKind = row['error_kind'] === null ? undefined : String(row['error_kind']);
  if (errorKind !== undefined && !isEventErrorKind(errorKind)) {
    throw new EventsStoreError(`events row ${String(row['id'])} has unknown error_kind`);
  }
  const fileRefsJson = row['file_refs'];
  const opt = <T>(value: T | undefined, key: string): Record<string, T> | object =>
    value === undefined ? {} : { [key]: value };
  return {
    id: Number(row['id']),
    tsMs: Number(row['ts_ms']),
    backend,
    account,
    source,
    eventType: String(row['event_type']),
    ...opt(row['session_id'] === null ? undefined : String(row['session_id']), 'sessionId'),
    ...opt(
      row['native_session_id'] === null ? undefined : String(row['native_session_id']),
      'nativeSessionId',
    ),
    ...opt(row['workstream_id'] === null ? undefined : String(row['workstream_id']), 'workstreamId'),
    ...opt(row['prompt_id'] === null ? undefined : String(row['prompt_id']), 'promptId'),
    ...opt(row['model'] === null ? undefined : String(row['model']), 'model'),
    ...opt(row['provider'] === null ? undefined : String(row['provider']), 'provider'),
    ...opt(optionalNumber(row['input_tokens'] ?? null), 'inputTokens'),
    ...opt(optionalNumber(row['output_tokens'] ?? null), 'outputTokens'),
    ...opt(optionalNumber(row['cache_read_tokens'] ?? null), 'cacheReadTokens'),
    ...opt(optionalNumber(row['cache_creation_tokens'] ?? null), 'cacheCreationTokens'),
    ...opt(optionalNumber(row['cache_creation_5m_tokens'] ?? null), 'cacheCreation5mTokens'),
    ...opt(optionalNumber(row['cache_creation_1h_tokens'] ?? null), 'cacheCreation1hTokens'),
    ...opt(optionalNumber(row['reasoning_tokens'] ?? null), 'reasoningTokens'),
    ...opt(optionalNumber(row['cost_estimated_usd'] ?? null), 'costEstimatedUsd'),
    ...opt(optionalNumber(row['cost_actual_usd'] ?? null), 'costActualUsd'),
    ...opt(optionalNumber(row['latency_ms'] ?? null), 'latencyMs'),
    ...opt(optionalNumber(row['ttft_ms'] ?? null), 'ttftMs'),
    ...opt(row['tool_name'] === null ? undefined : String(row['tool_name']), 'toolName'),
    ...opt(row['skill_name'] === null ? undefined : String(row['skill_name']), 'skillName'),
    ...opt(row['agent_name'] === null ? undefined : String(row['agent_name']), 'agentName'),
    ...opt(row['mcp_server'] === null ? undefined : String(row['mcp_server']), 'mcpServer'),
    ...opt(row['ok'] === null ? undefined : Number(row['ok']) === 1, 'ok'),
    ...opt(errorKind as EventErrorKind | undefined, 'errorKind'),
    ...opt(
      fileRefsJson === null || fileRefsJson === undefined
        ? undefined
        : (JSON.parse(String(fileRefsJson)) as readonly string[]),
      'fileRefs',
    ),
    rawRef: String(row['raw_ref']),
    ingestedAtIso: String(row['ingested_at_iso']),
  } as EventRow;
}

/** Semantic attribution columns screened for identity shapes at insert. */
const SCREENED_EVENT_FIELDS = [
  ['event_type', 'eventType'],
  ['model', 'model'],
  ['provider', 'provider'],
  ['tool_name', 'toolName'],
  ['skill_name', 'skillName'],
  ['agent_name', 'agentName'],
  ['mcp_server', 'mcpServer'],
] as const;

export interface EventsTableStore {
  /**
   * THE validated insert path. Dedupes on (backend, raw_ref): a duplicate
   * returns the EXISTING row with `inserted: false` — never throws, never
   * overwrites (re-tailing a rotated file is normal, plan §9.2 BE-5 edge).
   */
  insert(row: NewEventRow): EventInsertOutcome;
  getByRawRef(backend: Backend, rawRef: string): EventRow | undefined;
  list(filter?: EventFilter): readonly EventRow[];
  /**
   * Cost Explorer backfill (blueprint §6.2): writes `cost_actual_usd` ONLY —
   * "backfill overwrites estimate not raw" means the ESTIMATE column and all
   * raw fields stay untouched; re-backfilling updates the actual.
   */
  backfillCostActual(backend: Backend, rawRef: string, costActualUsd: number): EventRow;
}

export interface EventsStoreOptions {
  /** Timestamp source, injectable for tests. */
  readonly nowIso?: () => string;
}

function validateNewEvent(input: NewEventRow): void {
  if (!isNonNegativeSafeInteger(input.tsMs)) {
    throw new EventsStoreError('tsMs must be a non-negative safe integer (epoch ms)');
  }
  if (!isAccountLabel(input.account)) {
    throw new EventsStoreError(`unknown account label ${JSON.stringify(input.account)}`);
  }
  if (backendForLabel(input.account) !== input.backend) {
    throw new EventsStoreError(
      `label/backend pairing violation: ${input.account} requires ` +
        `${backendForLabel(input.account)}, got ${String(input.backend)}`,
    );
  }
  if (!isEventSource(input.source)) {
    throw new EventsStoreError(`unknown source ${JSON.stringify(input.source)}`);
  }
  if (input.eventType.trim().length === 0) {
    throw new EventsStoreError('eventType must be non-blank');
  }
  if (input.rawRef.trim().length === 0) {
    throw new EventsStoreError('rawRef must be non-blank (half of the dedupe key)');
  }
  if (input.errorKind !== undefined && !isEventErrorKind(input.errorKind)) {
    throw new EventsStoreError(`unknown errorKind ${JSON.stringify(input.errorKind)}`);
  }
  for (const [field, value] of [
    ['inputTokens', input.inputTokens],
    ['outputTokens', input.outputTokens],
    ['cacheReadTokens', input.cacheReadTokens],
    ['cacheCreationTokens', input.cacheCreationTokens],
    ['cacheCreation5mTokens', input.cacheCreation5mTokens],
    ['cacheCreation1hTokens', input.cacheCreation1hTokens],
    ['reasoningTokens', input.reasoningTokens],
    ['latencyMs', input.latencyMs],
    ['ttftMs', input.ttftMs],
  ] as const) {
    if (value !== undefined && !isNonNegativeSafeInteger(value)) {
      throw new EventsStoreError(`${field} must be a non-negative safe integer`);
    }
  }
  for (const [field, value] of [
    ['costEstimatedUsd', input.costEstimatedUsd],
    ['costActualUsd', input.costActualUsd],
  ] as const) {
    if (value !== undefined && !isNonNegativeFinite(value)) {
      throw new EventsStoreError(`${field} must be a non-negative finite number`);
    }
  }
  if (input.fileRefs !== undefined) {
    for (const ref of input.fileRefs) {
      if (!ref.startsWith('/')) {
        throw new EventsStoreError('fileRefs must be absolute file paths');
      }
    }
  }
  // [X2] identity-shape screen on the semantic attribution columns.
  for (const [column, key] of SCREENED_EVENT_FIELDS) {
    const value = input[key];
    if (typeof value === 'string') assertIdentityFreeColumn(column, value);
  }
}

export function createEventsTableStore(
  driver: SqliteDriver,
  options: EventsStoreOptions = {},
): EventsTableStore {
  const nowIso = options.nowIso ?? nowIsoDefault;

  const getByRawRef = (backend: Backend, rawRef: string): EventRow | undefined => {
    const row = driver
      .prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE backend = ? AND raw_ref = ?`)
      .get(backend, rawRef);
    return row === undefined ? undefined : eventFromSql(row);
  };

  return {
    insert: (input) => {
      validateNewEvent(input);
      const result = driver
        .prepare(
          `INSERT INTO events
             (ts_ms, backend, account, source, event_type, session_id, native_session_id,
              workstream_id, prompt_id, model, provider, input_tokens, output_tokens,
              cache_read_tokens, cache_creation_tokens, cache_creation_5m_tokens,
              cache_creation_1h_tokens, reasoning_tokens, cost_estimated_usd,
              cost_actual_usd, latency_ms, ttft_ms, tool_name, skill_name, agent_name,
              mcp_server, ok, error_kind, file_refs, raw_ref, ingested_at_iso)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (backend, raw_ref) DO NOTHING`,
        )
        .run(
          input.tsMs,
          input.backend,
          input.account,
          input.source,
          input.eventType,
          input.sessionId ?? null,
          input.nativeSessionId ?? null,
          input.workstreamId ?? null,
          input.promptId ?? null,
          input.model ?? null,
          input.provider ?? null,
          input.inputTokens ?? null,
          input.outputTokens ?? null,
          input.cacheReadTokens ?? null,
          input.cacheCreationTokens ?? null,
          input.cacheCreation5mTokens ?? null,
          input.cacheCreation1hTokens ?? null,
          input.reasoningTokens ?? null,
          input.costEstimatedUsd ?? null,
          input.costActualUsd ?? null,
          input.latencyMs ?? null,
          input.ttftMs ?? null,
          input.toolName ?? null,
          input.skillName ?? null,
          input.agentName ?? null,
          input.mcpServer ?? null,
          input.ok === undefined ? null : input.ok ? 1 : 0,
          input.errorKind ?? null,
          input.fileRefs === undefined ? null : JSON.stringify(input.fileRefs),
          input.rawRef,
          nowIso(),
        );
      const inserted = Number(result.changes) > 0;
      const row = getByRawRef(input.backend, input.rawRef);
      if (row === undefined) {
        throw new EventsStoreError('insert lost its own row (driver misbehavior)');
      }
      return { row, inserted };
    },

    getByRawRef,

    list: (filter = {}) => {
      const clauses: string[] = [];
      const params: SqlValue[] = [];
      if (filter.account !== undefined) {
        clauses.push('account = ?');
        params.push(filter.account);
      }
      if (filter.backend !== undefined) {
        clauses.push('backend = ?');
        params.push(filter.backend);
      }
      if (filter.source !== undefined) {
        clauses.push('source = ?');
        params.push(filter.source);
      }
      if (filter.eventType !== undefined) {
        clauses.push('event_type = ?');
        params.push(filter.eventType);
      }
      if (filter.sinceTsMs !== undefined) {
        clauses.push('ts_ms >= ?');
        params.push(filter.sinceTsMs);
      }
      if (filter.untilTsMs !== undefined) {
        clauses.push('ts_ms <= ?');
        params.push(filter.untilTsMs);
      }
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
      const limit = filter.limit !== undefined ? ` LIMIT ${Math.max(0, Math.trunc(filter.limit))}` : '';
      return driver
        .prepare(`SELECT ${EVENT_COLUMNS} FROM events${where} ORDER BY ts_ms, id${limit}`)
        .all(...params)
        .map(eventFromSql);
    },

    backfillCostActual: (backend, rawRef, costActualUsd) => {
      if (!isNonNegativeFinite(costActualUsd)) {
        throw new EventsStoreError('costActualUsd must be a non-negative finite number');
      }
      const result = driver
        .prepare('UPDATE events SET cost_actual_usd = ? WHERE backend = ? AND raw_ref = ?')
        .run(costActualUsd, backend, rawRef);
      if (Number(result.changes) === 0) throw new EventNotFoundError(backend, rawRef);
      const row = getByRawRef(backend, rawRef);
      if (row === undefined) throw new EventNotFoundError(backend, rawRef);
      return row;
    },
  };
}

// ---------------------------------------------------------------------------
// quota_snapshots accessor
// ---------------------------------------------------------------------------

export interface NewQuotaSnapshotRow {
  readonly account: AccountLabel;
  readonly window: QuotaWindow;
  readonly usedPct: number;
  readonly resetsAtMs: number;
  readonly capturedAtMs: number;
  readonly source: QuotaSource;
}

export interface QuotaSnapshotRow extends NewQuotaSnapshotRow {
  readonly id: number;
  readonly ingestedAtIso: string;
}

export interface QuotaSnapshotInsertOutcome {
  readonly row: QuotaSnapshotRow;
  readonly inserted: boolean;
}

export interface QuotaSnapshotsStore {
  /** Dedupes on (account, window, captured_at_ms, source) — tee re-emits are no-ops. */
  insert(row: NewQuotaSnapshotRow): QuotaSnapshotInsertOutcome;
  /** The latest snapshot per (account, window) — the gauge read model's feed. */
  latest(): readonly QuotaSnapshotRow[];
  list(filter?: { readonly account?: AccountLabel; readonly window?: QuotaWindow }): readonly QuotaSnapshotRow[];
}

const QUOTA_COLUMNS = 'id, account, "window", used_pct, resets_at_ms, captured_at_ms, source, ingested_at_iso';

function quotaFromSql(row: SqlRow): QuotaSnapshotRow {
  const account = row['account'];
  if (!isAccountLabel(account)) {
    throw new EventsStoreError('quota_snapshots row fails vocabulary decode');
  }
  return {
    id: Number(row['id']),
    account,
    window: String(row['window']) as QuotaWindow,
    usedPct: Number(row['used_pct']),
    resetsAtMs: Number(row['resets_at_ms']),
    capturedAtMs: Number(row['captured_at_ms']),
    source: String(row['source']) as QuotaSource,
    ingestedAtIso: String(row['ingested_at_iso']),
  };
}

export function createQuotaSnapshotsStore(
  driver: SqliteDriver,
  options: EventsStoreOptions = {},
): QuotaSnapshotsStore {
  const nowIso = options.nowIso ?? nowIsoDefault;
  return {
    insert: (input) => {
      if (!isAccountLabel(input.account)) {
        throw new EventsStoreError(`unknown account label ${JSON.stringify(input.account)}`);
      }
      if (!(QUOTA_WINDOWS as readonly string[]).includes(input.window)) {
        throw new EventsStoreError(`unknown quota window ${JSON.stringify(input.window)}`);
      }
      if (!(QUOTA_SOURCES as readonly string[]).includes(input.source)) {
        throw new EventsStoreError(`unknown quota source ${JSON.stringify(input.source)}`);
      }
      if (!isNonNegativeFinite(input.usedPct) || input.usedPct > 100) {
        throw new EventsStoreError('usedPct must be in 0..100 (collector clamps upstream noise)');
      }
      if (!isNonNegativeSafeInteger(input.resetsAtMs) || !isNonNegativeSafeInteger(input.capturedAtMs)) {
        throw new EventsStoreError('resetsAtMs/capturedAtMs must be non-negative safe integers');
      }
      const result = driver
        .prepare(
          `INSERT INTO quota_snapshots
             (account, "window", used_pct, resets_at_ms, captured_at_ms, source, ingested_at_iso)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (account, "window", captured_at_ms, source) DO NOTHING`,
        )
        .run(
          input.account,
          input.window,
          input.usedPct,
          input.resetsAtMs,
          input.capturedAtMs,
          input.source,
          nowIso(),
        );
      const inserted = Number(result.changes) > 0;
      const row = driver
        .prepare(
          `SELECT ${QUOTA_COLUMNS} FROM quota_snapshots
           WHERE account = ? AND "window" = ? AND captured_at_ms = ? AND source = ?`,
        )
        .get(input.account, input.window, input.capturedAtMs, input.source);
      if (row === undefined) throw new EventsStoreError('quota insert lost its own row');
      return { row: quotaFromSql(row), inserted };
    },

    latest: () =>
      driver
        .prepare(
          `SELECT ${QUOTA_COLUMNS} FROM quota_snapshots
           WHERE id IN (
             SELECT id FROM quota_snapshots q2
             WHERE q2.captured_at_ms = (
               SELECT MAX(q3.captured_at_ms) FROM quota_snapshots q3
               WHERE q3.account = q2.account AND q3."window" = q2."window"
             )
           )
           ORDER BY account, "window"`,
        )
        .all()
        .map(quotaFromSql),

    list: (filter = {}) => {
      const clauses: string[] = [];
      const params: SqlValue[] = [];
      if (filter.account !== undefined) {
        clauses.push('account = ?');
        params.push(filter.account);
      }
      if (filter.window !== undefined) {
        clauses.push('"window" = ?');
        params.push(filter.window);
      }
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
      return driver
        .prepare(
          `SELECT ${QUOTA_COLUMNS} FROM quota_snapshots${where} ORDER BY captured_at_ms, id`,
        )
        .all(...params)
        .map(quotaFromSql);
    },
  };
}

// ---------------------------------------------------------------------------
// session_outcomes accessor
// ---------------------------------------------------------------------------

export interface NewSessionOutcomeRow {
  readonly account: AccountLabel;
  readonly nativeSessionId: string;
  readonly outcome: string;
  readonly friction?: string;
  /** Verbatim facets/session-meta JSON (identity dropped at ingest [X2]). */
  readonly facetsJson?: string;
  readonly capturedAtMs: number;
  readonly rawRef: string;
}

export interface SessionOutcomeRow extends NewSessionOutcomeRow {
  readonly id: number;
  readonly ingestedAtIso: string;
}

export interface SessionOutcomeInsertOutcome {
  readonly row: SessionOutcomeRow;
  readonly inserted: boolean;
}

export interface SessionOutcomesStore {
  /** Dedupes on (account, raw_ref). */
  insert(row: NewSessionOutcomeRow): SessionOutcomeInsertOutcome;
  list(filter?: { readonly account?: AccountLabel }): readonly SessionOutcomeRow[];
}

const OUTCOME_COLUMNS =
  'id, account, native_session_id, outcome, friction, facets_json, captured_at_ms, raw_ref, ingested_at_iso';

function outcomeFromSql(row: SqlRow): SessionOutcomeRow {
  const account = row['account'];
  if (!isAccountLabel(account)) {
    throw new EventsStoreError('session_outcomes row fails vocabulary decode');
  }
  return {
    id: Number(row['id']),
    account,
    nativeSessionId: String(row['native_session_id']),
    outcome: String(row['outcome']),
    ...(row['friction'] === null ? {} : { friction: String(row['friction']) }),
    ...(row['facets_json'] === null ? {} : { facetsJson: String(row['facets_json']) }),
    capturedAtMs: Number(row['captured_at_ms']),
    rawRef: String(row['raw_ref']),
    ingestedAtIso: String(row['ingested_at_iso']),
  };
}

export function createSessionOutcomesStore(
  driver: SqliteDriver,
  options: EventsStoreOptions = {},
): SessionOutcomesStore {
  const nowIso = options.nowIso ?? nowIsoDefault;
  return {
    insert: (input) => {
      if (!isAccountLabel(input.account)) {
        throw new EventsStoreError(`unknown account label ${JSON.stringify(input.account)}`);
      }
      if (input.nativeSessionId.trim().length === 0) {
        throw new EventsStoreError('nativeSessionId must be non-blank');
      }
      if (input.outcome.trim().length === 0) {
        throw new EventsStoreError('outcome must be non-blank');
      }
      if (input.rawRef.trim().length === 0) {
        throw new EventsStoreError('rawRef must be non-blank');
      }
      if (!isNonNegativeSafeInteger(input.capturedAtMs)) {
        throw new EventsStoreError('capturedAtMs must be a non-negative safe integer');
      }
      assertIdentityFreeColumn('outcome', input.outcome);
      if (input.friction !== undefined) assertIdentityFreeColumn('friction', input.friction);
      const result = driver
        .prepare(
          `INSERT INTO session_outcomes
             (account, native_session_id, outcome, friction, facets_json, captured_at_ms,
              raw_ref, ingested_at_iso)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (account, raw_ref) DO NOTHING`,
        )
        .run(
          input.account,
          input.nativeSessionId,
          input.outcome,
          input.friction ?? null,
          input.facetsJson ?? null,
          input.capturedAtMs,
          input.rawRef,
          nowIso(),
        );
      const inserted = Number(result.changes) > 0;
      const row = driver
        .prepare(`SELECT ${OUTCOME_COLUMNS} FROM session_outcomes WHERE account = ? AND raw_ref = ?`)
        .get(input.account, input.rawRef);
      if (row === undefined) throw new EventsStoreError('outcome insert lost its own row');
      return { row: outcomeFromSql(row), inserted };
    },

    list: (filter = {}) => {
      const where = filter.account !== undefined ? ' WHERE account = ?' : '';
      const params: SqlValue[] = filter.account !== undefined ? [filter.account] : [];
      return driver
        .prepare(`SELECT ${OUTCOME_COLUMNS} FROM session_outcomes${where} ORDER BY captured_at_ms, id`)
        .all(...params)
        .map(outcomeFromSql);
    },
  };
}

// ---------------------------------------------------------------------------
// prices accessor (LiteLLM-seeded, pinned, overridable — the ccusage lesson)
// ---------------------------------------------------------------------------

export type PriceSource = 'litellm-pinned' | 'override';

export interface PriceRow {
  readonly provider: string;
  readonly model: string;
  readonly inputUsdPerMtok: number;
  readonly outputUsdPerMtok: number;
  readonly cacheReadUsdPerMtok?: number;
  readonly cacheWriteUsdPerMtok?: number;
  readonly source: PriceSource;
  readonly pinnedAtIso: string;
}

export interface PricesStore {
  /**
   * Upsert one price row. OVERRIDE-WINS SEMANTICS (the ccusage lesson):
   * a `litellm-pinned` upsert never replaces an existing `override` row
   * (returns the surviving override); an `override` upsert always wins.
   */
  upsert(row: Omit<PriceRow, 'pinnedAtIso'> & { readonly pinnedAtIso?: string }): PriceRow;
  get(provider: string, model: string): PriceRow | undefined;
  list(): readonly PriceRow[];
}

const PRICE_COLUMNS =
  'provider, model, input_usd_per_mtok, output_usd_per_mtok, cache_read_usd_per_mtok, ' +
  'cache_write_usd_per_mtok, source, pinned_at_iso';

function priceFromSql(row: SqlRow): PriceRow {
  const source = String(row['source']);
  if (source !== 'litellm-pinned' && source !== 'override') {
    throw new EventsStoreError('prices row fails vocabulary decode');
  }
  return {
    provider: String(row['provider']),
    model: String(row['model']),
    inputUsdPerMtok: Number(row['input_usd_per_mtok']),
    outputUsdPerMtok: Number(row['output_usd_per_mtok']),
    ...(row['cache_read_usd_per_mtok'] === null
      ? {}
      : { cacheReadUsdPerMtok: Number(row['cache_read_usd_per_mtok']) }),
    ...(row['cache_write_usd_per_mtok'] === null
      ? {}
      : { cacheWriteUsdPerMtok: Number(row['cache_write_usd_per_mtok']) }),
    source,
    pinnedAtIso: String(row['pinned_at_iso']),
  };
}

export function createPricesStore(
  driver: SqliteDriver,
  options: EventsStoreOptions = {},
): PricesStore {
  const nowIso = options.nowIso ?? nowIsoDefault;

  const get = (provider: string, model: string): PriceRow | undefined => {
    const row = driver
      .prepare(`SELECT ${PRICE_COLUMNS} FROM prices WHERE provider = ? AND model = ?`)
      .get(provider, model);
    return row === undefined ? undefined : priceFromSql(row);
  };

  return {
    upsert: (input) => {
      if (input.provider.trim().length === 0 || input.model.trim().length === 0) {
        throw new EventsStoreError('provider and model must be non-blank');
      }
      assertIdentityFreeColumn('provider', input.provider);
      assertIdentityFreeColumn('model', input.model);
      for (const [field, value] of [
        ['inputUsdPerMtok', input.inputUsdPerMtok],
        ['outputUsdPerMtok', input.outputUsdPerMtok],
        ['cacheReadUsdPerMtok', input.cacheReadUsdPerMtok],
        ['cacheWriteUsdPerMtok', input.cacheWriteUsdPerMtok],
      ] as const) {
        if (value !== undefined && !isNonNegativeFinite(value)) {
          throw new EventsStoreError(`${field} must be a non-negative finite number`);
        }
      }
      if (input.source !== 'litellm-pinned' && input.source !== 'override') {
        throw new EventsStoreError(`unknown price source ${JSON.stringify(input.source)}`);
      }
      const existing = get(input.provider, input.model);
      if (existing !== undefined && existing.source === 'override' && input.source === 'litellm-pinned') {
        // Override survives re-seeding — the seed is a no-op.
        return existing;
      }
      driver
        .prepare(
          `INSERT INTO prices
             (provider, model, input_usd_per_mtok, output_usd_per_mtok,
              cache_read_usd_per_mtok, cache_write_usd_per_mtok, source, pinned_at_iso)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (provider, model) DO UPDATE SET
             input_usd_per_mtok = excluded.input_usd_per_mtok,
             output_usd_per_mtok = excluded.output_usd_per_mtok,
             cache_read_usd_per_mtok = excluded.cache_read_usd_per_mtok,
             cache_write_usd_per_mtok = excluded.cache_write_usd_per_mtok,
             source = excluded.source,
             pinned_at_iso = excluded.pinned_at_iso`,
        )
        .run(
          input.provider,
          input.model,
          input.inputUsdPerMtok,
          input.outputUsdPerMtok,
          input.cacheReadUsdPerMtok ?? null,
          input.cacheWriteUsdPerMtok ?? null,
          input.source,
          input.pinnedAtIso ?? nowIso(),
        );
      const row = get(input.provider, input.model);
      if (row === undefined) throw new EventsStoreError('price upsert lost its own row');
      return row;
    },

    get,

    list: () =>
      driver
        .prepare(`SELECT ${PRICE_COLUMNS} FROM prices ORDER BY provider, model`)
        .all()
        .map(priceFromSql),
  };
}
