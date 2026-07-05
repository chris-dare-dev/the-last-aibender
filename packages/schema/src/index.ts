/**
 * @aibender/schema — SQLite migrations + typed row accessors for ALL harness
 * ledgers: resume ledger; workstream/session_node/session_edge/brief
 * (blueprint §5); events + quota_snapshots + session_outcomes + prices
 * (blueprint §6.2); workflow runs/steps/memoization journal (blueprint §7).
 *
 * ============================================================================
 * FROZEN-M1 (2026-07-04) — kernel slice · FROZEN-M3 (2026-07-04) — events
 * slice. Owner BE-ORCH; amendments only via ICR (docs/contracts/icr/).
 * Prose of record: docs/contracts/sqlite-ddl.md.
 *
 * Frozen at M1:
 *   - the {@link SqliteDriver} adapter + node:sqlite implementation (WAL on
 *     open; better-sqlite3 swap path documented in driver.ts)
 *   - the migration runner (fresh apply, idempotent re-run, out-of-order and
 *     history-drift rejection; migrate.ts)
 *   - migration 0001: resume_ledger + account_profiles + schema_meta
 *   - kernel accessors + the resume-ledger state machine (kernel.ts)
 * Frozen at M3:
 *   - migration 0002: events + quota_snapshots + session_outcomes + prices
 *     (blueprint §6.2), applied to the SEPARATE collector-owned database
 *     (`~/.aibender/db/events.db`) via the EVENTS_STORE_MIGRATIONS sibling
 *     list — decision recorded in sqlite-ddl.md
 *   - events accessors: validated insert path with (backend, raw_ref) dedupe,
 *     identity-shape screen [X2], Cost Explorer cost_actual_usd backfill,
 *     quota/outcome dedupe, override-wins price pinning (events.ts)
 * Frozen at M4:
 *   - migration 0003: workstream / session_node / session_edge / brief
 *     (blueprint §5) — appended to KERNEL_MIGRATIONS: the lineage ledger
 *     lives in the KERNEL database (decision recorded in sqlite-ddl.md §8.1;
 *     edges are recorded at action time by the kernel path, and the
 *     SessionIdResolver seam joins resume_ledger + session_node)
 *   - lineage accessors (lineage.ts): harness-ids-primary, write-once native
 *     id backfill, the edge from/import + handoff-brief matrices, the ATOMIC
 *     recordMerge write path (one new node + N merge_parent edges), the
 *     detached-HEAD bucket queries, identity screen on naming columns [X2]
 * Frozen at M5 (this freeze):
 *   - migration 0004: pipeline_definition / pipeline_run / step_attempt
 *     (blueprint §7) — appended to KERNEL_MIGRATIONS: the pipeline store +
 *     the durable MEMOIZATION JOURNAL live in the KERNEL database (decision
 *     recorded in sqlite-ddl.md §10.1 — same commit boundary + query plan as
 *     the `workflow`-edge session_nodes each step attempt produces; journal
 *     writes are resume-ledger-rate)
 *   - pipeline accessors (pipelines.ts): definition upsert-by-id, run
 *     bookkeeping, the append-only step_attempt journal with the resume
 *     lookup findMemoized (a completed attempt's cached output is returned
 *     without re-execution — the M5 DoD), identity screen on the definition
 *     name [X2]
 *
 * Field-tag convention (consumed by @aibender/shared redaction filters):
 * columns carrying sensitive material are declared in KERNEL_FIELD_TAGS with
 * `secret`/`identifier` tags. Nothing identity-bearing enters any store —
 * identities are mapped to MAX_A/MAX_B/ENT at ingest [X2].
 * ============================================================================
 */

// M0 surface (kept verbatim — dependents already code against it) -------------

/** One forward-only SQLite migration step. */
export interface Migration {
  /** Positive integer, strictly increasing across the migration list. */
  readonly id: number;
  /** Human-readable slug, e.g. `kernel-tables-init`. */
  readonly name: string;
  /** Forward DDL/DML. Down-migrations are deliberately absent (forward-only). */
  readonly up: string;
}

/** Ledger row recording an applied migration. */
export interface AppliedMigration {
  readonly id: number;
  readonly name: string;
  /** ISO-8601 UTC timestamp of application. */
  readonly appliedAtIso: string;
}

/**
 * The migration runner every ledger opens through. The SQLite-backed
 * implementation is {@link createMigrationRunner}; tests may still fake this.
 */
export interface MigrationRunner {
  /** Migrations already applied to the store, in application order. */
  applied(): Promise<readonly AppliedMigration[]>;
  /**
   * Apply `pending` in order, atomically per migration, skipping ids already
   * applied. Callers must pass the FULL migration list (never a partial one)
   * satisfying {@link assertMigrationOrder}; out-of-order/history-drift lists
   * are refused (see migrate.ts).
   */
  apply(pending: readonly Migration[]): Promise<readonly AppliedMigration[]>;
}

/**
 * Validate a migration list: ids are positive safe integers, strictly
 * increasing; names are non-blank. Throws on the first violation.
 */
export function assertMigrationOrder(migrations: readonly Migration[]): void {
  let previousId = 0;
  for (const [index, migration] of migrations.entries()) {
    if (!Number.isSafeInteger(migration.id) || migration.id <= 0) {
      throw new RangeError(
        `migration[${index}] has invalid id ${String(migration.id)} (want positive integer)`,
      );
    }
    if (migration.id <= previousId) {
      throw new RangeError(
        `migration[${index}] id ${migration.id} is not strictly greater than ${previousId}`,
      );
    }
    if (typeof migration.name !== 'string' || migration.name.trim().length === 0) {
      throw new RangeError(`migration[${index}] (id ${migration.id}) has a blank name`);
    }
    previousId = migration.id;
  }
}

// M1 surface ------------------------------------------------------------------

export {
  openNodeSqliteDatabase,
  type OpenDatabaseOptions,
  type OpenedDatabase,
  type SqlRow,
  type SqlValue,
  type SqliteDriver,
  type SqliteStatement,
} from './driver.js';

export {
  MigrationApplyError,
  MigrationHistoryError,
  createMigrationRunner,
  type MigrationRunnerOptions,
} from './migrate.js';

export { KERNEL_MIGRATIONS, MIGRATION_0001_KERNEL } from './migrations/0001-kernel.js';

export { EVENTS_STORE_MIGRATIONS, MIGRATION_0002_EVENTS } from './migrations/0002-events.js';

export { MIGRATION_0003_LINEAGE } from './migrations/0003-lineage.js';

export { MIGRATION_0004_PIPELINES } from './migrations/0004-pipelines.js';

export { MIGRATION_0005_ACCOUNT_REGISTRY } from './migrations/0005-account-registry.js';

export { MIGRATION_0006_ACCOUNT_REGISTRY_EVENTS } from './migrations/0006-account-registry-events.js';

export { MIGRATION_0007_BACKEND_REGISTRY } from './migrations/0007-backend-registry.js';

export { MIGRATION_0008_BACKEND_REGISTRY_EVENTS } from './migrations/0008-backend-registry-events.js';

export { MIGRATION_0009_BACKEND_REGISTRY_STEP_ATTEMPT } from './migrations/0009-backend-registry-step-attempt.js';

export {
  ACTIVE_SESSION_STATES,
  IllegalTransitionError,
  KERNEL_FIELD_TAGS,
  KernelStoreError,
  LEGAL_TRANSITIONS,
  SessionNotFoundError,
  createAccountProfilesStore,
  createResumeLedgerStore,
  createSchemaMetaStore,
  isLegalTransition,
  type AccountProfileRow,
  type AccountProfilesStore,
  type KernelStoreOptions,
  type NewResumeLedgerRow,
  type ResumeLedgerRow,
  type ResumeLedgerStore,
  type SchemaMetaStore,
} from './kernel.js';

export {
  LINEAGE_FIELD_TAGS,
  LineageNodeNotFoundError,
  LineageStoreError,
  createLineageStore,
  type BriefRow,
  type BriefsStore,
  type LineageStore,
  type LineageStoreOptions,
  type NewBriefRow,
  type NewSessionEdgeRow,
  type NewSessionNodeRow,
  type NewWorkstreamRow,
  type RecordMergeInput,
  type RecordMergeResult,
  type SessionEdgeRow,
  type SessionEdgesStore,
  type SessionNodeRow,
  type SessionNodesStore,
  type WorkstreamRow,
  type WorkstreamsStore,
} from './lineage.js';

export {
  PIPELINES_FIELD_TAGS,
  PipelineNotFoundError,
  PipelineRunNotFoundError,
  PipelineStoreError,
  createPipelinesStore,
  type NewPipelineDefinitionRow,
  type NewPipelineRunRow,
  type NewStepAttemptRow,
  type PipelineDefinitionRow,
  type PipelineDefinitionsStore,
  type PipelineRunRow,
  type PipelineRunsStore,
  type PipelinesStore,
  type PipelinesStoreOptions,
  type StepAttemptResult,
  type StepAttemptRow,
  type StepAttemptsStore,
} from './pipelines.js';

export {
  EVENTS_FIELD_TAGS,
  EventNotFoundError,
  EventsStoreError,
  assertIdentityFreeColumn,
  createEventsTableStore,
  createPricesStore,
  createQuotaSnapshotsStore,
  createSessionOutcomesStore,
  type EventFilter,
  type EventInsertOutcome,
  type EventRow,
  type EventUsage,
  type EventsStoreOptions,
  type EventsTableStore,
  type NewEventRow,
  type NewQuotaSnapshotRow,
  type NewSessionOutcomeRow,
  type PriceRow,
  type PriceSource,
  type PricesStore,
  type QuotaSnapshotInsertOutcome,
  type QuotaSnapshotRow,
  type QuotaSnapshotsStore,
  type SessionOutcomeInsertOutcome,
  type SessionOutcomeRow,
  type SessionOutcomesStore,
} from './events.js';

import { openNodeSqliteDatabase } from './driver.js';
import {
  createEventsTableStore,
  createPricesStore,
  createQuotaSnapshotsStore,
  createSessionOutcomesStore,
  type EventsStoreOptions,
  type EventsTableStore,
  type PricesStore,
  type QuotaSnapshotsStore,
  type SessionOutcomesStore,
} from './events.js';
import {
  createAccountProfilesStore,
  createResumeLedgerStore,
  createSchemaMetaStore,
  type AccountProfilesStore,
  type KernelStoreOptions,
  type ResumeLedgerStore,
  type SchemaMetaStore,
} from './kernel.js';
import { createLineageStore, type LineageStore } from './lineage.js';
import { createPipelinesStore, type PipelinesStore } from './pipelines.js';
import { createMigrationRunner } from './migrate.js';
import { KERNEL_MIGRATIONS } from './migrations/0001-kernel.js';
import { EVENTS_STORE_MIGRATIONS } from './migrations/0002-events.js';
import type { SqliteDriver } from './driver.js';

export interface KernelStore {
  readonly driver: SqliteDriver;
  /** `wal` for file-backed stores; `memory` for `:memory:` test stores. */
  readonly journalMode: string;
  readonly resumeLedger: ResumeLedgerStore;
  readonly accountProfiles: AccountProfilesStore;
  readonly schemaMeta: SchemaMetaStore;
  /** M4: the [X4] lineage ledger (migration 0003 — same database, see lineage.ts). */
  readonly lineage: LineageStore;
  /** M5: the pipeline store + memoization journal (migration 0004, see pipelines.ts). */
  readonly pipelines: PipelinesStore;
  close(): void;
}

export interface OpenKernelStoreOptions extends KernelStoreOptions {
  /** `:memory:` (tests) or an absolute file path (e.g. ~/.aibender/db/kernel.db). */
  readonly path: string;
}

/**
 * One-call composition root for the kernel database: open through the
 * node:sqlite adapter (WAL for file-backed stores), apply KERNEL_MIGRATIONS,
 * hand back the typed accessors.
 */
export async function openKernelStore(options: OpenKernelStoreOptions): Promise<KernelStore> {
  const { driver, journalMode } = openNodeSqliteDatabase({ path: options.path });
  const runner = createMigrationRunner(driver, options);
  await runner.apply(KERNEL_MIGRATIONS);
  const storeOptions: KernelStoreOptions = options.nowIso ? { nowIso: options.nowIso } : {};
  return {
    driver,
    journalMode,
    resumeLedger: createResumeLedgerStore(driver, storeOptions),
    accountProfiles: createAccountProfilesStore(driver, storeOptions),
    schemaMeta: createSchemaMetaStore(driver),
    lineage: createLineageStore(driver),
    pipelines: createPipelinesStore(driver),
    close: () => driver.close(),
  };
}

// M3 surface — the collector-owned events database (blueprint §6.2) ------------

export interface EventsStore {
  readonly driver: SqliteDriver;
  /** `wal` for file-backed stores; `memory` for `:memory:` test stores. */
  readonly journalMode: string;
  readonly events: EventsTableStore;
  readonly quotaSnapshots: QuotaSnapshotsStore;
  readonly sessionOutcomes: SessionOutcomesStore;
  readonly prices: PricesStore;
  close(): void;
}

export interface OpenEventsStoreOptions extends EventsStoreOptions {
  /** `:memory:` (tests) or an absolute file path (e.g. ~/.aibender/db/events.db). */
  readonly path: string;
}

/**
 * One-call composition root for the SEPARATE collector-owned events database
 * (blueprint §6.2 "One SQLite (WAL) database owned by the collector"; the
 * sibling-list decision of sqlite-ddl.md §6, recorded at the M3 freeze):
 * open through the node:sqlite adapter, apply EVENTS_STORE_MIGRATIONS, hand
 * back the typed accessors. NEVER pointed at the kernel database — the
 * collector's high-volume writes must not contend with row-before-spawn.
 */
export async function openEventsStore(options: OpenEventsStoreOptions): Promise<EventsStore> {
  const { driver, journalMode } = openNodeSqliteDatabase({ path: options.path });
  const runner = createMigrationRunner(driver, options);
  await runner.apply(EVENTS_STORE_MIGRATIONS);
  const storeOptions: EventsStoreOptions = options.nowIso ? { nowIso: options.nowIso } : {};
  return {
    driver,
    journalMode,
    events: createEventsTableStore(driver, storeOptions),
    quotaSnapshots: createQuotaSnapshotsStore(driver, storeOptions),
    sessionOutcomes: createSessionOutcomesStore(driver, storeOptions),
    prices: createPricesStore(driver, storeOptions),
    close: () => driver.close(),
  };
}
