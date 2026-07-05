/**
 * Typed row accessors for the M5 pipeline tables (migration 0004:
 * pipeline_definition / pipeline_run / step_attempt — blueprint §7, plan
 * §4/BE-8, docs/contracts/sqlite-ddl.md §10; findings pipeline-workflow-builder
 * §R3). All live in the KERNEL database (the §10.1 decision).
 *
 * THE MEMOIZATION JOURNAL is `step_attempt`: the resume walk calls
 * {@link StepAttemptsStore.findMemoized} for a (runId, stepId, iteration,
 * inputHash) — a COMPLETED attempt returns its cached `output_json` and the
 * runner SKIPS re-execution (the M5 DoD "resumes from the memoization journal
 * without re-executing completed steps"; immune to the compaction-relocation
 * bug class of native #65796 because it is durable across harness restarts).
 *
 * DISCIPLINE (accessor-enforced on top of the DDL CHECKs, tested):
 *   - HARNESS IDS: `wf_…` definitions, `run_…` runs, `sa_…` attempts (via
 *     @aibender/shared newId); session_id is a nullable ATTRIBUTE (the node
 *     the attempt spawned — the `workflow` lineage edge target).
 *   - APPEND-ONLY JOURNAL: retries append a NEW attempt row (attempt+1);
 *     recording an existing (run, step, iteration, attempt) throws
 *     (UNIQUE index) — the journal never overwrites history.
 *   - [X2]: the stored definition name is identity-screened; document/output
 *     JSON is machine-local content, `identifier`-tagged for redaction.
 *
 * ============================================================================
 * FROZEN-M5 (2026-07-04). Amendments only via ICR (docs/contracts/icr/).
 * Prose of record: docs/contracts/sqlite-ddl.md.
 * ============================================================================
 */

import {
  isAccountLabel,
  isPipelineRunState,
  isPipelineStepState,
  type AccountLabel,
  type PipelineRunState,
  type PipelineStepState,
} from '@aibender/protocol';
import type { FieldTag } from '@aibender/shared';

import type { SqlRow, SqliteDriver } from './driver.js';
import { assertIdentityFreeColumn } from './events.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PipelineStoreError extends Error {
  override readonly name: string = 'PipelineStoreError';
}

export class PipelineNotFoundError extends PipelineStoreError {
  override readonly name = 'PipelineNotFoundError';
  constructor(id: string) {
    super(`no pipeline_definition row for ${id}`);
  }
}

export class PipelineRunNotFoundError extends PipelineStoreError {
  override readonly name = 'PipelineRunNotFoundError';
  constructor(id: string) {
    super(`no pipeline_run row for ${id}`);
  }
}

// ---------------------------------------------------------------------------
// Field tags — consumed by @aibender/shared redaction (plan §3) [X2]
// ---------------------------------------------------------------------------

/**
 * Machine-local / content-bearing pipeline columns (redacted downstream;
 * exempt from the insert-time identity screen — document JSON and step output
 * legitimately carry absolute paths and prompt bodies). No pipeline column is
 * `secret` — credentials never touch these tables (Keychain-primary).
 */
export const PIPELINES_FIELD_TAGS: Readonly<Record<string, readonly FieldTag[]>> = Object.freeze({
  document_json: ['identifier'],
  inputs_json: ['identifier'],
  output_json: ['identifier'],
});

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface PipelineDefinitionRow {
  readonly id: string;
  readonly name: string;
  /** The full versioned JSON DAG document (dag-schema.md v1), stored verbatim. */
  readonly documentJson: string;
  readonly schemaVersion: number;
  readonly schemaHash: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface NewPipelineDefinitionRow {
  readonly id: string;
  readonly name: string;
  readonly documentJson: string;
  readonly schemaVersion: number;
  readonly schemaHash: string;
}

export interface PipelineRunRow {
  readonly id: string;
  readonly pipelineId: string;
  readonly schemaHash: string;
  readonly inputsJson: string | null;
  readonly workstreamId: string | null;
  readonly status: PipelineRunState;
  readonly costEstimatedUsd: number | null;
  readonly startedAtMs: number | null;
  readonly finishedAtMs: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface NewPipelineRunRow {
  readonly id: string;
  readonly pipelineId: string;
  readonly schemaHash: string;
  readonly inputsJson?: string;
  readonly workstreamId?: string;
  readonly status?: PipelineRunState;
}

export interface StepAttemptRow {
  readonly id: string;
  readonly runId: string;
  readonly stepId: string;
  readonly iteration: number;
  readonly attempt: number;
  readonly inputHash: string;
  readonly status: PipelineStepState;
  readonly sessionId: string | null;
  readonly account: AccountLabel | null;
  readonly outputJson: string | null;
  readonly costEstimatedUsd: number | null;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly errorKind: string | null;
  readonly startedAtMs: number | null;
  readonly finishedAtMs: number | null;
  readonly createdAtMs: number;
}

export interface NewStepAttemptRow {
  readonly id: string;
  readonly runId: string;
  readonly stepId: string;
  readonly iteration?: number;
  readonly attempt?: number;
  readonly inputHash: string;
  readonly status?: PipelineStepState;
  readonly sessionId?: string;
  readonly account?: AccountLabel;
}

/** Terminal-transition patch for an attempt (completed/failed/etc.). */
export interface StepAttemptResult {
  readonly status: PipelineStepState;
  readonly sessionId?: string;
  readonly account?: AccountLabel;
  readonly outputJson?: string;
  readonly costEstimatedUsd?: number;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly errorKind?: string;
  readonly finishedAtMs?: number;
}

// ---------------------------------------------------------------------------
// Store interfaces
// ---------------------------------------------------------------------------

export interface PipelineDefinitionsStore {
  /** Insert or REPLACE a definition (a save overwrites by id, bumps updated). */
  upsert(row: NewPipelineDefinitionRow): PipelineDefinitionRow;
  get(id: string): PipelineDefinitionRow | undefined;
  list(): readonly PipelineDefinitionRow[];
}

export interface PipelineRunsStore {
  insert(row: NewPipelineRunRow): PipelineRunRow;
  get(id: string): PipelineRunRow | undefined;
  list(filter?: {
    readonly pipelineId?: string;
    readonly statuses?: readonly PipelineRunState[];
  }): readonly PipelineRunRow[];
  setStatus(
    id: string,
    status: PipelineRunState,
    patch?: {
      readonly costEstimatedUsd?: number;
      readonly startedAtMs?: number;
      readonly finishedAtMs?: number;
    },
  ): PipelineRunRow;
}

export interface StepAttemptsStore {
  /**
   * Record a NEW attempt row (pending/running). Appending an existing
   * (runId, stepId, iteration, attempt) throws (append-only journal).
   */
  record(row: NewStepAttemptRow): StepAttemptRow;
  /** Patch an attempt to its terminal state (+ output/cost/session). */
  complete(id: string, result: StepAttemptResult): StepAttemptRow;
  get(id: string): StepAttemptRow | undefined;
  /**
   * THE resume lookup (the memoization journal): the newest COMPLETED attempt
   * for (runId, stepId, iteration) whose inputHash matches, or undefined. A
   * hit means the runner returns the cached output WITHOUT re-executing.
   * `memoized` counts as completed (a resumed cache hit stays a hit).
   */
  findMemoized(
    runId: string,
    stepId: string,
    iteration: number,
    inputHash: string,
  ): StepAttemptRow | undefined;
  /** All attempts for a run, oldest first (the run-monitor rebuild). */
  listByRun(runId: string): readonly StepAttemptRow[];
}

export interface PipelinesStore {
  readonly definitions: PipelineDefinitionsStore;
  readonly runs: PipelineRunsStore;
  readonly stepAttempts: StepAttemptsStore;
}

export interface PipelinesStoreOptions {
  /** Timestamp source (epoch ms), injectable for tests. */
  readonly nowMs?: () => number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFINITION_COLUMNS =
  'id, name, document_json, schema_version, schema_hash, created_at_ms, updated_at_ms';

const RUN_COLUMNS =
  'id, pipeline_id, schema_hash, inputs_json, workstream_id, status, cost_estimated_usd, ' +
  'started_at_ms, finished_at_ms, created_at_ms, updated_at_ms';

const ATTEMPT_COLUMNS =
  'id, run_id, step_id, iteration, attempt, input_hash, status, session_id, account, ' +
  'output_json, cost_estimated_usd, tokens_in, tokens_out, error_kind, ' +
  'started_at_ms, finished_at_ms, created_at_ms';

/** The completed-family the resume lookup treats as a cache hit. */
const COMPLETED_STATES: ReadonlySet<PipelineStepState> = new Set(['completed', 'memoized']);

const COMPLETED_STATES_ARR = [...COMPLETED_STATES];

function requireNonBlankId(what: string, id: string): void {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new PipelineStoreError(`${what} id must be a non-blank harness id`);
  }
}

function screenName(value: string): void {
  try {
    assertIdentityFreeColumn('pipeline_definition.name', value);
  } catch (error) {
    throw new PipelineStoreError(error instanceof Error ? error.message : String(error));
  }
}

function nonNegInt(what: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new PipelineStoreError(`${what} must be a non-negative integer`);
  }
}

function definitionFromSql(row: SqlRow): PipelineDefinitionRow {
  return {
    id: String(row['id']),
    name: String(row['name']),
    documentJson: String(row['document_json']),
    schemaVersion: Number(row['schema_version']),
    schemaHash: String(row['schema_hash']),
    createdAtMs: Number(row['created_at_ms']),
    updatedAtMs: Number(row['updated_at_ms']),
  };
}

function runFromSql(row: SqlRow): PipelineRunRow {
  const status = row['status'];
  if (!isPipelineRunState(status)) {
    throw new PipelineStoreError(`pipeline_run row ${String(row['id'])} fails status decode`);
  }
  return {
    id: String(row['id']),
    pipelineId: String(row['pipeline_id']),
    schemaHash: String(row['schema_hash']),
    inputsJson: row['inputs_json'] === null ? null : String(row['inputs_json']),
    workstreamId: row['workstream_id'] === null ? null : String(row['workstream_id']),
    status,
    costEstimatedUsd:
      row['cost_estimated_usd'] === null ? null : Number(row['cost_estimated_usd']),
    startedAtMs: row['started_at_ms'] === null ? null : Number(row['started_at_ms']),
    finishedAtMs: row['finished_at_ms'] === null ? null : Number(row['finished_at_ms']),
    createdAtMs: Number(row['created_at_ms']),
    updatedAtMs: Number(row['updated_at_ms']),
  };
}

function attemptFromSql(row: SqlRow): StepAttemptRow {
  const status = row['status'];
  if (!isPipelineStepState(status)) {
    throw new PipelineStoreError(`step_attempt row ${String(row['id'])} fails status decode`);
  }
  const account = row['account'];
  if (account !== null && !isAccountLabel(account)) {
    throw new PipelineStoreError(`step_attempt row ${String(row['id'])} fails account decode`);
  }
  return {
    id: String(row['id']),
    runId: String(row['run_id']),
    stepId: String(row['step_id']),
    iteration: Number(row['iteration']),
    attempt: Number(row['attempt']),
    inputHash: String(row['input_hash']),
    status,
    sessionId: row['session_id'] === null ? null : String(row['session_id']),
    account: account === null ? null : (account as AccountLabel),
    outputJson: row['output_json'] === null ? null : String(row['output_json']),
    costEstimatedUsd:
      row['cost_estimated_usd'] === null ? null : Number(row['cost_estimated_usd']),
    tokensIn: row['tokens_in'] === null ? null : Number(row['tokens_in']),
    tokensOut: row['tokens_out'] === null ? null : Number(row['tokens_out']),
    errorKind: row['error_kind'] === null ? null : String(row['error_kind']),
    startedAtMs: row['started_at_ms'] === null ? null : Number(row['started_at_ms']),
    finishedAtMs: row['finished_at_ms'] === null ? null : Number(row['finished_at_ms']),
    createdAtMs: Number(row['created_at_ms']),
  };
}

export function createPipelinesStore(
  driver: SqliteDriver,
  options: PipelinesStoreOptions = {},
): PipelinesStore {
  const nowMs = options.nowMs ?? Date.now;

  const getDefinition = (id: string): PipelineDefinitionRow => {
    const row = driver
      .prepare(`SELECT ${DEFINITION_COLUMNS} FROM pipeline_definition WHERE id = ?`)
      .get(id);
    if (row === undefined) throw new PipelineNotFoundError(id);
    return definitionFromSql(row);
  };

  const getRun = (id: string): PipelineRunRow => {
    const row = driver.prepare(`SELECT ${RUN_COLUMNS} FROM pipeline_run WHERE id = ?`).get(id);
    if (row === undefined) throw new PipelineRunNotFoundError(id);
    return runFromSql(row);
  };

  const getAttempt = (id: string): StepAttemptRow => {
    const row = driver.prepare(`SELECT ${ATTEMPT_COLUMNS} FROM step_attempt WHERE id = ?`).get(id);
    if (row === undefined) throw new PipelineStoreError(`no step_attempt row for ${id}`);
    return attemptFromSql(row);
  };

  const definitions: PipelineDefinitionsStore = {
    upsert: (input) => {
      requireNonBlankId('pipeline_definition', input.id);
      if (input.name.trim().length === 0) {
        throw new PipelineStoreError('pipeline definition name must be non-blank');
      }
      screenName(input.name);
      if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion <= 0) {
        throw new PipelineStoreError('pipeline definition schemaVersion must be a positive integer');
      }
      if (input.documentJson.trim().length === 0) {
        throw new PipelineStoreError('pipeline definition documentJson must be non-blank');
      }
      if (input.schemaHash.trim().length === 0) {
        throw new PipelineStoreError('pipeline definition schemaHash must be non-blank');
      }
      const ts = nowMs();
      const existing = driver
        .prepare('SELECT created_at_ms FROM pipeline_definition WHERE id = ?')
        .get(input.id);
      const createdAtMs = existing === undefined ? ts : Number(existing['created_at_ms']);
      driver
        .prepare(
          `INSERT INTO pipeline_definition
             (id, name, document_json, schema_version, schema_hash, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             name = excluded.name,
             document_json = excluded.document_json,
             schema_version = excluded.schema_version,
             schema_hash = excluded.schema_hash,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .run(
          input.id,
          input.name,
          input.documentJson,
          input.schemaVersion,
          input.schemaHash,
          createdAtMs,
          ts,
        );
      return getDefinition(input.id);
    },
    get: (id) => {
      const row = driver
        .prepare(`SELECT ${DEFINITION_COLUMNS} FROM pipeline_definition WHERE id = ?`)
        .get(id);
      return row === undefined ? undefined : definitionFromSql(row);
    },
    list: () =>
      driver
        .prepare(`SELECT ${DEFINITION_COLUMNS} FROM pipeline_definition ORDER BY created_at_ms, id`)
        .all()
        .map(definitionFromSql),
  };

  const runs: PipelineRunsStore = {
    insert: (input) => {
      requireNonBlankId('pipeline_run', input.id);
      getDefinition(input.pipelineId); // FK precondition, typed error before the SQL FK fires
      if (input.schemaHash.trim().length === 0) {
        throw new PipelineStoreError('pipeline run schemaHash must be non-blank');
      }
      const status = input.status ?? 'pending';
      if (!isPipelineRunState(status)) {
        throw new PipelineStoreError(`unknown pipeline run status ${JSON.stringify(status)}`);
      }
      const ts = nowMs();
      driver
        .prepare(
          `INSERT INTO pipeline_run
             (id, pipeline_id, schema_hash, inputs_json, workstream_id, status,
              cost_estimated_usd, started_at_ms, finished_at_ms, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          input.id,
          input.pipelineId,
          input.schemaHash,
          input.inputsJson ?? null,
          input.workstreamId ?? null,
          status,
          ts,
          ts,
        );
      return getRun(input.id);
    },
    get: (id) => {
      const row = driver.prepare(`SELECT ${RUN_COLUMNS} FROM pipeline_run WHERE id = ?`).get(id);
      return row === undefined ? undefined : runFromSql(row);
    },
    list: (filter) => {
      const clauses: string[] = [];
      const params: (string | number)[] = [];
      if (filter?.pipelineId !== undefined) {
        clauses.push('pipeline_id = ?');
        params.push(filter.pipelineId);
      }
      const statuses = filter?.statuses;
      if (statuses !== undefined && statuses.length > 0) {
        clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
        params.push(...statuses);
      }
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
      return driver
        .prepare(`SELECT ${RUN_COLUMNS} FROM pipeline_run${where} ORDER BY created_at_ms, id`)
        .all(...params)
        .map(runFromSql);
    },
    setStatus: (id, status, patch) => {
      if (!isPipelineRunState(status)) {
        throw new PipelineStoreError(`unknown pipeline run status ${JSON.stringify(status)}`);
      }
      const current = getRun(id);
      nonNegInt('run startedAtMs', patch?.startedAtMs);
      nonNegInt('run finishedAtMs', patch?.finishedAtMs);
      if (
        patch?.costEstimatedUsd !== undefined &&
        (!Number.isFinite(patch.costEstimatedUsd) || patch.costEstimatedUsd < 0)
      ) {
        throw new PipelineStoreError('run costEstimatedUsd must be a non-negative finite number');
      }
      driver
        .prepare(
          `UPDATE pipeline_run SET status = ?, cost_estimated_usd = ?, started_at_ms = ?,
             finished_at_ms = ?, updated_at_ms = ? WHERE id = ?`,
        )
        .run(
          status,
          patch?.costEstimatedUsd ?? current.costEstimatedUsd,
          patch?.startedAtMs ?? current.startedAtMs,
          patch?.finishedAtMs ?? current.finishedAtMs,
          nowMs(),
          id,
        );
      return getRun(id);
    },
  };

  const stepAttempts: StepAttemptsStore = {
    record: (input) => {
      requireNonBlankId('step_attempt', input.id);
      getRun(input.runId); // FK precondition
      if (input.stepId.trim().length === 0) {
        throw new PipelineStoreError('step_attempt stepId must be non-blank');
      }
      if (input.inputHash.trim().length === 0) {
        throw new PipelineStoreError('step_attempt inputHash must be non-blank');
      }
      nonNegInt('step_attempt iteration', input.iteration);
      nonNegInt('step_attempt attempt', input.attempt);
      const status = input.status ?? 'pending';
      if (!isPipelineStepState(status)) {
        throw new PipelineStoreError(`unknown step state ${JSON.stringify(status)}`);
      }
      if (input.account !== undefined) {
        if (!isAccountLabel(input.account)) {
          throw new PipelineStoreError(`unknown account label ${JSON.stringify(input.account)}`);
        }
      }
      const iteration = input.iteration ?? 0;
      const attempt = input.attempt ?? 0;
      const ts = nowMs();
      const startedAt = status === 'running' ? ts : null;
      try {
        driver
          .prepare(
            `INSERT INTO step_attempt
               (id, run_id, step_id, iteration, attempt, input_hash, status, session_id, account,
                output_json, cost_estimated_usd, tokens_in, tokens_out, error_kind,
                started_at_ms, finished_at_ms, created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL, ?)`,
          )
          .run(
            input.id,
            input.runId,
            input.stepId,
            iteration,
            attempt,
            input.inputHash,
            status,
            input.sessionId ?? null,
            input.account ?? null,
            startedAt,
            ts,
          );
      } catch (cause) {
        throw new PipelineStoreError(
          `step_attempt (${input.runId}, ${input.stepId}, iter ${iteration}, attempt ${attempt}) ` +
            `already exists — the journal is append-only (${(cause as Error).message})`,
        );
      }
      return getAttempt(input.id);
    },
    complete: (id, result) => {
      const current = getAttempt(id);
      if (!isPipelineStepState(result.status)) {
        throw new PipelineStoreError(`unknown step state ${JSON.stringify(result.status)}`);
      }
      if (result.account !== undefined && !isAccountLabel(result.account)) {
        throw new PipelineStoreError(`unknown account label ${JSON.stringify(result.account)}`);
      }
      nonNegInt('attempt tokensIn', result.tokensIn);
      nonNegInt('attempt tokensOut', result.tokensOut);
      nonNegInt('attempt finishedAtMs', result.finishedAtMs);
      if (
        result.costEstimatedUsd !== undefined &&
        (!Number.isFinite(result.costEstimatedUsd) || result.costEstimatedUsd < 0)
      ) {
        throw new PipelineStoreError('attempt costEstimatedUsd must be a non-negative finite number');
      }
      driver
        .prepare(
          `UPDATE step_attempt SET status = ?, session_id = ?, account = ?, output_json = ?,
             cost_estimated_usd = ?, tokens_in = ?, tokens_out = ?, error_kind = ?,
             finished_at_ms = ? WHERE id = ?`,
        )
        .run(
          result.status,
          result.sessionId ?? current.sessionId,
          result.account ?? current.account,
          result.outputJson ?? current.outputJson,
          result.costEstimatedUsd ?? current.costEstimatedUsd,
          result.tokensIn ?? current.tokensIn,
          result.tokensOut ?? current.tokensOut,
          result.errorKind ?? current.errorKind,
          result.finishedAtMs ?? current.finishedAtMs ?? nowMs(),
          id,
        );
      return getAttempt(id);
    },
    get: (id) => {
      const row = driver.prepare(`SELECT ${ATTEMPT_COLUMNS} FROM step_attempt WHERE id = ?`).get(id);
      return row === undefined ? undefined : attemptFromSql(row);
    },
    findMemoized: (runId, stepId, iteration, inputHash) => {
      const placeholders = COMPLETED_STATES_ARR.map(() => '?').join(', ');
      const row = driver
        .prepare(
          `SELECT ${ATTEMPT_COLUMNS} FROM step_attempt
             WHERE run_id = ? AND step_id = ? AND iteration = ? AND input_hash = ?
               AND status IN (${placeholders})
             ORDER BY attempt DESC, created_at_ms DESC LIMIT 1`,
        )
        .get(runId, stepId, iteration, inputHash, ...COMPLETED_STATES_ARR);
      return row === undefined ? undefined : attemptFromSql(row);
    },
    listByRun: (runId) =>
      driver
        .prepare(
          `SELECT ${ATTEMPT_COLUMNS} FROM step_attempt WHERE run_id = ?
             ORDER BY created_at_ms, iteration, attempt, id`,
        )
        .all(runId)
        .map(attemptFromSql),
  };

  return { definitions, runs, stepAttempts };
}
