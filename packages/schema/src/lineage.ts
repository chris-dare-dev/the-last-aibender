/**
 * Typed row accessors for the M4 [X4] lineage tables (migration 0003:
 * workstream / session_node / session_edge / brief — blueprint §5, plan
 * §4/BE-7, docs/contracts/sqlite-ddl.md §8).
 *
 * DISCIPLINE (accessor-enforced on top of the DDL CHECKs, tested):
 *   - HARNESS IDS PRIMARY: every id is harness-minted (`ses_`/`ws_`/`edg_`/
 *     `br_` via @aibender/shared newId); the native session id is a nullable
 *     ATTRIBUTE with write-once backfill (the resume-ledger rule).
 *   - EDGE LEGALITY: `to_node`/`from_node` must exist (typed error before
 *     the FK fires); `from_node` REQUIRED except `import` (FORBIDDEN there);
 *     `handoff` requires a brief; a `continue` edge may be a self-edge
 *     (in-place resume) but every OTHER type refuses from === to.
 *   - MERGE = one new node with N `merge_parent` edges, written ATOMICALLY
 *     ({@link LineageStore.recordMerge}): 2..16 distinct existing parents +
 *     a mandatory merge brief, one transaction — a crash never leaves a
 *     merge node without its parents.
 *   - [X2]: free-text naming columns (title/description/tags/display_name/
 *     git_branch) pass the insert-time identity screen; path-bearing columns
 *     are `identifier`-tagged for redaction instead (LINEAGE_FIELD_TAGS —
 *     the events-store §7.6 precedent).
 *
 * ============================================================================
 * FROZEN-M4 (2026-07-04). Amendments only via ICR (docs/contracts/icr/).
 * Prose of record: docs/contracts/sqlite-ddl.md.
 * ============================================================================
 */

import {
  LABEL_BACKENDS,
  isAccountLabel,
  isBackend,
  isBriefKind,
  isBriefProvenance,
  isLineageConfidence,
  isSessionEdgeType,
  isSessionNodeOrigin,
  isSessionNodeState,
  isWorkstreamStatus,
  type AccountLabel,
  type Backend,
  type BriefKind,
  type BriefProvenance,
  type LineageConfidence,
  type SessionEdgeType,
  type SessionNodeOrigin,
  type SessionNodeState,
  type WorkstreamStatus,
} from '@aibender/protocol';
import type { FieldTag } from '@aibender/shared';

import type { SqlRow, SqliteDriver } from './driver.js';
import { assertIdentityFreeColumn } from './events.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class LineageStoreError extends Error {
  override readonly name: string = 'LineageStoreError';
}

export class LineageNodeNotFoundError extends LineageStoreError {
  override readonly name = 'LineageNodeNotFoundError';
  constructor(sessionId: string) {
    super(`no session_node row for session ${sessionId}`);
  }
}

// ---------------------------------------------------------------------------
// Field tags — consumed by @aibender/shared redaction (plan §3) [X2]
// ---------------------------------------------------------------------------

/**
 * Machine-local / path-bearing lineage columns (redacted downstream; exempt
 * from the insert-time identity screen — brief bodies and edge metadata
 * legitimately carry absolute paths and epoch digit runs). No lineage column
 * is `secret` — credentials never touch these tables (Keychain-primary).
 */
export const LINEAGE_FIELD_TAGS: Readonly<Record<string, readonly FieldTag[]>> = Object.freeze({
  cwd: ['identifier'],
  native_scope: ['identifier'],
  transcript_ref: ['identifier'],
  worktree: ['identifier'],
  body_md: ['identifier'],
  metadata: ['identifier'],
});

/** Merge parent-set bounds (mirrors the frozen wire constants). */
const MERGE_MIN_PARENTS = 2;
const MERGE_MAX_PARENTS = 16;

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface WorkstreamRow {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: WorkstreamStatus;
  readonly tags: readonly string[];
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface NewWorkstreamRow {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly status?: WorkstreamStatus;
  readonly tags?: readonly string[];
}

export interface SessionNodeRow {
  readonly id: string;
  readonly workstreamId: string | null;
  readonly backend: Backend;
  readonly account: AccountLabel;
  readonly nativeSessionId: string | null;
  readonly nativeScope: string | null;
  readonly transcriptRef: string | null;
  readonly cwd: string | null;
  readonly gitBranch: string | null;
  readonly worktree: string | null;
  readonly displayName: string | null;
  readonly firstPromptHash: string | null;
  readonly state: SessionNodeState;
  readonly origin: SessionNodeOrigin;
  readonly confidence: LineageConfidence;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly costEstimatedUsd: number | null;
  readonly createdAtMs: number;
  readonly lastActiveAtMs: number | null;
}

export interface NewSessionNodeRow {
  readonly id: string;
  readonly workstreamId?: string;
  readonly backend: Backend;
  readonly account: AccountLabel;
  readonly nativeSessionId?: string;
  readonly nativeScope?: string;
  readonly transcriptRef?: string;
  readonly cwd?: string;
  readonly gitBranch?: string;
  readonly worktree?: string;
  readonly displayName?: string;
  readonly firstPromptHash?: string;
  readonly state: SessionNodeState;
  readonly origin: SessionNodeOrigin;
  readonly confidence: LineageConfidence;
}

export interface BriefRow {
  readonly id: string;
  readonly kind: BriefKind;
  readonly bodyMd: string;
  readonly sourceNodes: readonly string[];
  readonly provenance: BriefProvenance;
  readonly tokenCount: number | null;
  readonly createdAtMs: number;
}

export interface NewBriefRow {
  readonly id: string;
  readonly kind: BriefKind;
  readonly bodyMd: string;
  readonly sourceNodes: readonly string[];
  readonly provenance: BriefProvenance;
  readonly tokenCount?: number;
}

export interface SessionEdgeRow {
  readonly id: string;
  readonly fromNode: string | null;
  readonly toNode: string;
  readonly edgeType: SessionEdgeType;
  readonly briefId: string | null;
  readonly confidence: LineageConfidence;
  readonly metadataJson: string | null;
  readonly createdAtMs: number;
}

export interface NewSessionEdgeRow {
  readonly id: string;
  readonly fromNode?: string;
  readonly toNode: string;
  readonly edgeType: SessionEdgeType;
  readonly briefId?: string;
  /** Default `recorded` (action-time kernel writes; the reconciler passes `inferred`). */
  readonly confidence?: LineageConfidence;
  readonly metadataJson?: string;
}

// ---------------------------------------------------------------------------
// Store interfaces
// ---------------------------------------------------------------------------

export interface WorkstreamsStore {
  insert(row: NewWorkstreamRow): WorkstreamRow;
  get(id: string): WorkstreamRow | undefined;
  list(filter?: { readonly statuses?: readonly WorkstreamStatus[] }): readonly WorkstreamRow[];
  setStatus(id: string, status: WorkstreamStatus): WorkstreamRow;
  rename(id: string, title: string): WorkstreamRow;
  setTags(id: string, tags: readonly string[]): WorkstreamRow;
}

export interface SessionNodesStore {
  insert(row: NewSessionNodeRow): SessionNodeRow;
  get(sessionId: string): SessionNodeRow | undefined;
  /** THE resolver query (SessionIdResolver seam): native → node, if known. */
  byNativeSessionId(nativeSessionId: string): SessionNodeRow | undefined;
  list(filter?: {
    readonly workstreamId?: string;
    /** true = the detached-HEAD bucket (workstream_id IS NULL). */
    readonly detached?: boolean;
    readonly states?: readonly SessionNodeState[];
  }): readonly SessionNodeRow[];
  /** Assign / reassign / detach (null). Unknown workstream → LineageStoreError. */
  assignWorkstream(sessionId: string, workstreamId: string | null): SessionNodeRow;
  setState(sessionId: string, state: SessionNodeState): SessionNodeRow;
  /**
   * Write-once native-id backfill (the resume-ledger rule): same value is an
   * idempotent no-op, a DIFFERENT value throws.
   */
  backfillNativeSessionId(sessionId: string, nativeSessionId: string): SessionNodeRow;
  /** The `/cd` move: native scope is MUTABLE (blueprint §5) — lineage keeps the node. */
  updateNativeScope(sessionId: string, nativeScope: string): SessionNodeRow;
  /** Token/cost/activity snapshots for the node card (observability attach). */
  updateSnapshots(
    sessionId: string,
    snapshots: {
      readonly tokensIn?: number;
      readonly tokensOut?: number;
      readonly costEstimatedUsd?: number;
      readonly lastActiveAtMs?: number;
    },
  ): SessionNodeRow;
}

export interface BriefsStore {
  insert(row: NewBriefRow): BriefRow;
  get(id: string): BriefRow | undefined;
  list(filter?: { readonly kinds?: readonly BriefKind[] }): readonly BriefRow[];
}

export interface SessionEdgesStore {
  insert(row: NewSessionEdgeRow): SessionEdgeRow;
  get(id: string): SessionEdgeRow | undefined;
  /** Every edge touching the node (either endpoint), oldest first. */
  listByNode(sessionId: string): readonly SessionEdgeRow[];
  list(filter?: { readonly edgeTypes?: readonly SessionEdgeType[] }): readonly SessionEdgeRow[];
}

/** Atomic merge write input (blueprint §5: merge = synthesis, not concatenation). */
export interface RecordMergeInput {
  /** The NEW merge node (inserted by this call). */
  readonly node: NewSessionNodeRow;
  /** 2..16 DISTINCT existing parent node ids. */
  readonly parents: readonly string[];
  /** The mandatory merge brief (must exist, kind `merge`). */
  readonly briefId: string;
  /** One edge id per parent, harness-minted, same order as `parents`. */
  readonly edgeIds: readonly string[];
}

export interface RecordMergeResult {
  readonly node: SessionNodeRow;
  readonly edges: readonly SessionEdgeRow[];
}

export interface LineageStore {
  readonly workstreams: WorkstreamsStore;
  readonly nodes: SessionNodesStore;
  readonly briefs: BriefsStore;
  readonly edges: SessionEdgesStore;
  /**
   * ONE transaction: insert the merge node + its N `merge_parent` edges.
   * Refused (typed error, nothing written): <2 or >16 parents, duplicate
   * parents, unknown parent, unknown/non-merge brief, edgeIds length
   * mismatch. This is the storage half of the frozen merge verb.
   */
  recordMerge(input: RecordMergeInput): RecordMergeResult;
}

export interface LineageStoreOptions {
  /** Timestamp source (epoch ms), injectable for tests. */
  readonly nowMs?: () => number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function screenNaming(column: string, value: string | undefined): void {
  if (value !== undefined) assertIdentityFreeColumnLineage(column, value);
}

/** The events-store identity screen, rethrown as a lineage error. */
function assertIdentityFreeColumnLineage(column: string, value: string): void {
  try {
    assertIdentityFreeColumn(column, value);
  } catch (error) {
    throw new LineageStoreError(error instanceof Error ? error.message : String(error));
  }
}

function parseJsonStringArray(raw: unknown, what: string): readonly string[] {
  if (raw === null || raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw new LineageStoreError(`${what} column holds malformed JSON`);
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new LineageStoreError(`${what} column must hold a JSON array of strings`);
  }
  return parsed as string[];
}

function workstreamFromSql(row: SqlRow): WorkstreamRow {
  const status = row['status'];
  if (!isWorkstreamStatus(status)) {
    throw new LineageStoreError(`workstream row ${String(row['id'])} fails vocabulary decode`);
  }
  return {
    id: String(row['id']),
    title: String(row['title']),
    description: row['description'] === null ? null : String(row['description']),
    status,
    tags: parseJsonStringArray(row['tags'] ?? null, 'workstream.tags'),
    createdAtMs: Number(row['created_at_ms']),
    updatedAtMs: Number(row['updated_at_ms']),
  };
}

function nodeFromSql(row: SqlRow): SessionNodeRow {
  const backend = row['backend'];
  const account = row['account'];
  const state = row['state'];
  const origin = row['origin'];
  const confidence = row['confidence'];
  if (
    !isBackend(backend) ||
    !isAccountLabel(account) ||
    !isSessionNodeState(state) ||
    !isSessionNodeOrigin(origin) ||
    !isLineageConfidence(confidence)
  ) {
    throw new LineageStoreError(`session_node row ${String(row['id'])} fails vocabulary decode`);
  }
  return {
    id: String(row['id']),
    workstreamId: row['workstream_id'] === null ? null : String(row['workstream_id']),
    backend,
    account,
    nativeSessionId: row['native_session_id'] === null ? null : String(row['native_session_id']),
    nativeScope: row['native_scope'] === null ? null : String(row['native_scope']),
    transcriptRef: row['transcript_ref'] === null ? null : String(row['transcript_ref']),
    cwd: row['cwd'] === null ? null : String(row['cwd']),
    gitBranch: row['git_branch'] === null ? null : String(row['git_branch']),
    worktree: row['worktree'] === null ? null : String(row['worktree']),
    displayName: row['display_name'] === null ? null : String(row['display_name']),
    firstPromptHash: row['first_prompt_hash'] === null ? null : String(row['first_prompt_hash']),
    state,
    origin,
    confidence,
    tokensIn: row['tokens_in'] === null ? null : Number(row['tokens_in']),
    tokensOut: row['tokens_out'] === null ? null : Number(row['tokens_out']),
    costEstimatedUsd:
      row['cost_estimated_usd'] === null ? null : Number(row['cost_estimated_usd']),
    createdAtMs: Number(row['created_at_ms']),
    lastActiveAtMs: row['last_active_at_ms'] === null ? null : Number(row['last_active_at_ms']),
  };
}

function briefFromSql(row: SqlRow): BriefRow {
  const kind = row['kind'];
  const provenance = row['provenance'];
  if (!isBriefKind(kind) || !isBriefProvenance(provenance)) {
    throw new LineageStoreError(`brief row ${String(row['id'])} fails vocabulary decode`);
  }
  return {
    id: String(row['id']),
    kind,
    bodyMd: String(row['body_md']),
    sourceNodes: parseJsonStringArray(row['source_nodes'], 'brief.source_nodes'),
    provenance,
    tokenCount: row['token_count'] === null ? null : Number(row['token_count']),
    createdAtMs: Number(row['created_at_ms']),
  };
}

function edgeFromSql(row: SqlRow): SessionEdgeRow {
  const edgeType = row['edge_type'];
  const confidence = row['confidence'];
  if (!isSessionEdgeType(edgeType) || !isLineageConfidence(confidence)) {
    throw new LineageStoreError(`session_edge row ${String(row['id'])} fails vocabulary decode`);
  }
  return {
    id: String(row['id']),
    fromNode: row['from_node'] === null ? null : String(row['from_node']),
    toNode: String(row['to_node']),
    edgeType,
    briefId: row['brief_id'] === null ? null : String(row['brief_id']),
    confidence,
    metadataJson: row['metadata'] === null ? null : String(row['metadata']),
    createdAtMs: Number(row['created_at_ms']),
  };
}

const NODE_COLUMNS =
  'id, workstream_id, backend, account, native_session_id, native_scope, transcript_ref, ' +
  'cwd, git_branch, worktree, display_name, first_prompt_hash, state, origin, confidence, ' +
  'tokens_in, tokens_out, cost_estimated_usd, created_at_ms, last_active_at_ms';

const EDGE_COLUMNS =
  'id, from_node, to_node, edge_type, brief_id, confidence, metadata, created_at_ms';

const WORKSTREAM_COLUMNS = 'id, title, description, status, tags, created_at_ms, updated_at_ms';

const BRIEF_COLUMNS = 'id, kind, body_md, source_nodes, provenance, token_count, created_at_ms';

function requireNonBlankId(what: string, id: string): void {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new LineageStoreError(`${what} id must be a non-blank harness id`);
  }
}

export function createLineageStore(
  driver: SqliteDriver,
  options: LineageStoreOptions = {},
): LineageStore {
  const nowMs = options.nowMs ?? Date.now;

  const getWorkstream = (id: string): WorkstreamRow => {
    const row = driver
      .prepare(`SELECT ${WORKSTREAM_COLUMNS} FROM workstream WHERE id = ?`)
      .get(id);
    if (row === undefined) throw new LineageStoreError(`no workstream row for ${id}`);
    return workstreamFromSql(row);
  };

  const getNode = (sessionId: string): SessionNodeRow => {
    const row = driver
      .prepare(`SELECT ${NODE_COLUMNS} FROM session_node WHERE id = ?`)
      .get(sessionId);
    if (row === undefined) throw new LineageNodeNotFoundError(sessionId);
    return nodeFromSql(row);
  };

  const workstreams: WorkstreamsStore = {
    insert: (input) => {
      requireNonBlankId('workstream', input.id);
      if (input.title.trim().length === 0) {
        throw new LineageStoreError('workstream title must be non-blank');
      }
      screenNaming('title', input.title);
      screenNaming('description', input.description);
      for (const tag of input.tags ?? []) screenNaming('tags', tag);
      const status = input.status ?? 'active';
      if (!isWorkstreamStatus(status)) {
        throw new LineageStoreError(`unknown workstream status ${JSON.stringify(status)}`);
      }
      const ts = nowMs();
      driver
        .prepare(
          `INSERT INTO workstream (id, title, description, status, tags, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.title,
          input.description ?? null,
          status,
          input.tags !== undefined ? JSON.stringify(input.tags) : null,
          ts,
          ts,
        );
      return getWorkstream(input.id);
    },
    get: (id) => {
      const row = driver
        .prepare(`SELECT ${WORKSTREAM_COLUMNS} FROM workstream WHERE id = ?`)
        .get(id);
      return row === undefined ? undefined : workstreamFromSql(row);
    },
    list: (filter) => {
      const statuses = filter?.statuses;
      if (statuses !== undefined && statuses.length > 0) {
        const placeholders = statuses.map(() => '?').join(', ');
        return driver
          .prepare(
            `SELECT ${WORKSTREAM_COLUMNS} FROM workstream WHERE status IN (${placeholders}) ORDER BY created_at_ms, id`,
          )
          .all(...statuses)
          .map(workstreamFromSql);
      }
      return driver
        .prepare(`SELECT ${WORKSTREAM_COLUMNS} FROM workstream ORDER BY created_at_ms, id`)
        .all()
        .map(workstreamFromSql);
    },
    setStatus: (id, status) => {
      if (!isWorkstreamStatus(status)) {
        throw new LineageStoreError(`unknown workstream status ${JSON.stringify(status)}`);
      }
      getWorkstream(id);
      driver
        .prepare('UPDATE workstream SET status = ?, updated_at_ms = ? WHERE id = ?')
        .run(status, nowMs(), id);
      return getWorkstream(id);
    },
    rename: (id, title) => {
      if (title.trim().length === 0) {
        throw new LineageStoreError('workstream title must be non-blank');
      }
      screenNaming('title', title);
      getWorkstream(id);
      driver
        .prepare('UPDATE workstream SET title = ?, updated_at_ms = ? WHERE id = ?')
        .run(title, nowMs(), id);
      return getWorkstream(id);
    },
    setTags: (id, tags) => {
      for (const tag of tags) screenNaming('tags', tag);
      getWorkstream(id);
      driver
        .prepare('UPDATE workstream SET tags = ?, updated_at_ms = ? WHERE id = ?')
        .run(JSON.stringify(tags), nowMs(), id);
      return getWorkstream(id);
    },
  };

  const nodes: SessionNodesStore = {
    insert: (input) => {
      requireNonBlankId('session_node', input.id);
      if (!isAccountLabel(input.account)) {
        throw new LineageStoreError(`unknown account label ${JSON.stringify(input.account)}`);
      }
      if (LABEL_BACKENDS[input.account] !== input.backend) {
        throw new LineageStoreError(
          `label/backend pairing violation: ${input.account} requires ` +
            `${LABEL_BACKENDS[input.account]}, got ${String(input.backend)}`,
        );
      }
      if (!isSessionNodeState(input.state)) {
        throw new LineageStoreError(`unknown node state ${JSON.stringify(input.state)}`);
      }
      if (!isSessionNodeOrigin(input.origin)) {
        throw new LineageStoreError(`unknown node origin ${JSON.stringify(input.origin)}`);
      }
      if (!isLineageConfidence(input.confidence)) {
        throw new LineageStoreError(`unknown node confidence ${JSON.stringify(input.confidence)}`);
      }
      if (input.cwd !== undefined && !input.cwd.startsWith('/')) {
        throw new LineageStoreError('node cwd must be an absolute, byte-stable path');
      }
      if (input.workstreamId !== undefined) getWorkstream(input.workstreamId);
      screenNaming('display_name', input.displayName);
      screenNaming('git_branch', input.gitBranch);
      driver
        .prepare(
          `INSERT INTO session_node
             (id, workstream_id, backend, account, native_session_id, native_scope,
              transcript_ref, cwd, git_branch, worktree, display_name, first_prompt_hash,
              state, origin, confidence, tokens_in, tokens_out, cost_estimated_usd,
              created_at_ms, last_active_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL)`,
        )
        .run(
          input.id,
          input.workstreamId ?? null,
          input.backend,
          input.account,
          input.nativeSessionId ?? null,
          input.nativeScope ?? null,
          input.transcriptRef ?? null,
          input.cwd ?? null,
          input.gitBranch ?? null,
          input.worktree ?? null,
          input.displayName ?? null,
          input.firstPromptHash ?? null,
          input.state,
          input.origin,
          input.confidence,
          nowMs(),
        );
      return getNode(input.id);
    },
    get: (sessionId) => {
      const row = driver
        .prepare(`SELECT ${NODE_COLUMNS} FROM session_node WHERE id = ?`)
        .get(sessionId);
      return row === undefined ? undefined : nodeFromSql(row);
    },
    byNativeSessionId: (nativeSessionId) => {
      const row = driver
        .prepare(
          `SELECT ${NODE_COLUMNS} FROM session_node WHERE native_session_id = ? ORDER BY created_at_ms, id LIMIT 1`,
        )
        .get(nativeSessionId);
      return row === undefined ? undefined : nodeFromSql(row);
    },
    list: (filter) => {
      const clauses: string[] = [];
      const params: (string | number)[] = [];
      if (filter?.workstreamId !== undefined) {
        clauses.push('workstream_id = ?');
        params.push(filter.workstreamId);
      }
      if (filter?.detached === true) clauses.push('workstream_id IS NULL');
      const states = filter?.states;
      if (states !== undefined && states.length > 0) {
        clauses.push(`state IN (${states.map(() => '?').join(', ')})`);
        params.push(...states);
      }
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
      return driver
        .prepare(`SELECT ${NODE_COLUMNS} FROM session_node${where} ORDER BY created_at_ms, id`)
        .all(...params)
        .map(nodeFromSql);
    },
    assignWorkstream: (sessionId, workstreamId) => {
      getNode(sessionId);
      if (workstreamId !== null) getWorkstream(workstreamId);
      driver
        .prepare('UPDATE session_node SET workstream_id = ? WHERE id = ?')
        .run(workstreamId, sessionId);
      return getNode(sessionId);
    },
    setState: (sessionId, state) => {
      if (!isSessionNodeState(state)) {
        throw new LineageStoreError(`unknown node state ${JSON.stringify(state)}`);
      }
      getNode(sessionId);
      driver.prepare('UPDATE session_node SET state = ? WHERE id = ?').run(state, sessionId);
      return getNode(sessionId);
    },
    backfillNativeSessionId: (sessionId, nativeSessionId) => {
      if (nativeSessionId.trim().length === 0) {
        throw new LineageStoreError('nativeSessionId must be non-blank');
      }
      const current = getNode(sessionId);
      if (current.nativeSessionId !== null && current.nativeSessionId !== nativeSessionId) {
        throw new LineageStoreError(
          `native session id for node ${sessionId} is already ${current.nativeSessionId}; ` +
            `refusing overwrite with ${nativeSessionId} (write-once backfill)`,
        );
      }
      if (current.nativeSessionId === nativeSessionId) return current; // idempotent no-op
      driver
        .prepare('UPDATE session_node SET native_session_id = ? WHERE id = ?')
        .run(nativeSessionId, sessionId);
      return getNode(sessionId);
    },
    updateNativeScope: (sessionId, nativeScope) => {
      getNode(sessionId);
      driver
        .prepare('UPDATE session_node SET native_scope = ? WHERE id = ?')
        .run(nativeScope, sessionId);
      return getNode(sessionId);
    },
    updateSnapshots: (sessionId, snapshots) => {
      const current = getNode(sessionId);
      for (const [key, value] of Object.entries(snapshots)) {
        if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
          throw new LineageStoreError(`snapshot ${key} must be a non-negative finite number`);
        }
      }
      driver
        .prepare(
          `UPDATE session_node SET tokens_in = ?, tokens_out = ?, cost_estimated_usd = ?,
             last_active_at_ms = ? WHERE id = ?`,
        )
        .run(
          snapshots.tokensIn ?? current.tokensIn,
          snapshots.tokensOut ?? current.tokensOut,
          snapshots.costEstimatedUsd ?? current.costEstimatedUsd,
          snapshots.lastActiveAtMs ?? current.lastActiveAtMs,
          sessionId,
        );
      return getNode(sessionId);
    },
  };

  const briefs: BriefsStore = {
    insert: (input) => {
      requireNonBlankId('brief', input.id);
      if (!isBriefKind(input.kind)) {
        throw new LineageStoreError(`unknown brief kind ${JSON.stringify(input.kind)}`);
      }
      if (!isBriefProvenance(input.provenance)) {
        throw new LineageStoreError(`unknown brief provenance ${JSON.stringify(input.provenance)}`);
      }
      if (input.bodyMd.trim().length === 0) {
        throw new LineageStoreError('brief body must be non-blank');
      }
      if (input.sourceNodes.length === 0) {
        throw new LineageStoreError('brief sourceNodes must be non-empty');
      }
      for (const sourceNode of input.sourceNodes) getNode(sourceNode);
      if (
        input.tokenCount !== undefined &&
        (!Number.isSafeInteger(input.tokenCount) || input.tokenCount < 0)
      ) {
        throw new LineageStoreError('brief tokenCount must be a non-negative integer');
      }
      driver
        .prepare(
          `INSERT INTO brief (id, kind, body_md, source_nodes, provenance, token_count, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.kind,
          input.bodyMd,
          JSON.stringify(input.sourceNodes),
          input.provenance,
          input.tokenCount ?? null,
          nowMs(),
        );
      const row = driver.prepare(`SELECT ${BRIEF_COLUMNS} FROM brief WHERE id = ?`).get(input.id);
      if (row === undefined) throw new LineageStoreError(`brief ${input.id} vanished after insert`);
      return briefFromSql(row);
    },
    get: (id) => {
      const row = driver.prepare(`SELECT ${BRIEF_COLUMNS} FROM brief WHERE id = ?`).get(id);
      return row === undefined ? undefined : briefFromSql(row);
    },
    list: (filter) => {
      const kinds = filter?.kinds;
      if (kinds !== undefined && kinds.length > 0) {
        const placeholders = kinds.map(() => '?').join(', ');
        return driver
          .prepare(
            `SELECT ${BRIEF_COLUMNS} FROM brief WHERE kind IN (${placeholders}) ORDER BY created_at_ms, id`,
          )
          .all(...kinds)
          .map(briefFromSql);
      }
      return driver
        .prepare(`SELECT ${BRIEF_COLUMNS} FROM brief ORDER BY created_at_ms, id`)
        .all()
        .map(briefFromSql);
    },
  };

  const insertEdgeUnchecked = (input: NewSessionEdgeRow): SessionEdgeRow => {
    driver
      .prepare(
        `INSERT INTO session_edge (id, from_node, to_node, edge_type, brief_id, confidence, metadata, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.fromNode ?? null,
        input.toNode,
        input.edgeType,
        input.briefId ?? null,
        input.confidence ?? 'recorded',
        input.metadataJson ?? null,
        nowMs(),
      );
    const row = driver
      .prepare(`SELECT ${EDGE_COLUMNS} FROM session_edge WHERE id = ?`)
      .get(input.id);
    if (row === undefined) throw new LineageStoreError(`edge ${input.id} vanished after insert`);
    return edgeFromSql(row);
  };

  const validateEdgeInput = (input: NewSessionEdgeRow): void => {
    requireNonBlankId('session_edge', input.id);
    if (!isSessionEdgeType(input.edgeType)) {
      throw new LineageStoreError(`unknown edge type ${JSON.stringify(input.edgeType)}`);
    }
    if (input.confidence !== undefined && !isLineageConfidence(input.confidence)) {
      throw new LineageStoreError(`unknown edge confidence ${JSON.stringify(input.confidence)}`);
    }
    // The frozen from/import matrix.
    if (input.edgeType === 'import' && input.fromNode !== undefined) {
      throw new LineageStoreError('import edges must not carry from_node (no in-graph parent)');
    }
    if (input.edgeType !== 'import' && input.fromNode === undefined) {
      throw new LineageStoreError(`edge type ${input.edgeType} requires from_node`);
    }
    // A continuation is a CHILD (or the same node continuing in place) —
    // every NON-continue type must connect two distinct nodes.
    if (input.edgeType !== 'continue' && input.fromNode === input.toNode) {
      throw new LineageStoreError(`edge type ${input.edgeType} cannot be a self-edge`);
    }
    // Endpoints/brief must exist (typed error before the FK fires).
    getNode(input.toNode);
    if (input.fromNode !== undefined) getNode(input.fromNode);
    if (input.edgeType === 'handoff' && input.briefId === undefined) {
      throw new LineageStoreError('handoff edges require a brief (context travels by brief, blueprint §5)');
    }
    if (input.briefId !== undefined && briefs.get(input.briefId) === undefined) {
      throw new LineageStoreError(`no brief row for ${input.briefId}`);
    }
  };

  const edges: SessionEdgesStore = {
    insert: (input) => {
      validateEdgeInput(input);
      return insertEdgeUnchecked(input);
    },
    get: (id) => {
      const row = driver.prepare(`SELECT ${EDGE_COLUMNS} FROM session_edge WHERE id = ?`).get(id);
      return row === undefined ? undefined : edgeFromSql(row);
    },
    listByNode: (sessionId) =>
      driver
        .prepare(
          `SELECT ${EDGE_COLUMNS} FROM session_edge WHERE from_node = ? OR to_node = ? ORDER BY created_at_ms, id`,
        )
        .all(sessionId, sessionId)
        .map(edgeFromSql),
    list: (filter) => {
      const edgeTypes = filter?.edgeTypes;
      if (edgeTypes !== undefined && edgeTypes.length > 0) {
        const placeholders = edgeTypes.map(() => '?').join(', ');
        return driver
          .prepare(
            `SELECT ${EDGE_COLUMNS} FROM session_edge WHERE edge_type IN (${placeholders}) ORDER BY created_at_ms, id`,
          )
          .all(...edgeTypes)
          .map(edgeFromSql);
      }
      return driver
        .prepare(`SELECT ${EDGE_COLUMNS} FROM session_edge ORDER BY created_at_ms, id`)
        .all()
        .map(edgeFromSql);
    },
  };

  const recordMerge = (input: RecordMergeInput): RecordMergeResult => {
    if (input.parents.length < MERGE_MIN_PARENTS || input.parents.length > MERGE_MAX_PARENTS) {
      throw new LineageStoreError(
        `merge requires ${MERGE_MIN_PARENTS}..${MERGE_MAX_PARENTS} parents, got ${input.parents.length}`,
      );
    }
    if (new Set(input.parents).size !== input.parents.length) {
      throw new LineageStoreError('merge parents must be distinct');
    }
    if (input.edgeIds.length !== input.parents.length) {
      throw new LineageStoreError('merge edgeIds must match parents one-to-one');
    }
    for (const parent of input.parents) getNode(parent);
    const brief = briefs.get(input.briefId);
    if (brief === undefined) throw new LineageStoreError(`no brief row for ${input.briefId}`);
    if (brief.kind !== 'merge') {
      throw new LineageStoreError(`merge node requires a kind=merge brief, got ${brief.kind}`);
    }

    driver.exec('BEGIN IMMEDIATE');
    try {
      const node = nodes.insert(input.node);
      const edgeRows: SessionEdgeRow[] = [];
      for (const [index, parent] of input.parents.entries()) {
        const edgeId = input.edgeIds[index];
        if (edgeId === undefined) throw new LineageStoreError('merge edgeIds must be dense');
        validateEdgeInput({
          id: edgeId,
          fromNode: parent,
          toNode: node.id,
          edgeType: 'merge_parent',
          briefId: input.briefId,
        });
        edgeRows.push(
          insertEdgeUnchecked({
            id: edgeId,
            fromNode: parent,
            toNode: node.id,
            edgeType: 'merge_parent',
            briefId: input.briefId,
          }),
        );
      }
      driver.exec('COMMIT');
      return { node, edges: edgeRows };
    } catch (error) {
      driver.exec('ROLLBACK');
      throw error;
    }
  };

  return { workstreams, nodes, briefs, edges, recordMerge };
}
