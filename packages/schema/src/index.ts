/**
 * @aibender/schema — SQLite migrations + typed row accessors for ALL harness
 * ledgers: resume ledger; workstream/session_node/session_edge/brief
 * (blueprint §5); events + quota_snapshots + session_outcomes + prices
 * (blueprint §6.2); workflow runs/steps/memoization journal (blueprint §7).
 *
 * ============================================================================
 * FROZEN-M1 (2026-07-04) — kernel slice. Owner BE-ORCH; amendments only via
 * ICR (docs/contracts/icr/). Prose of record: docs/contracts/sqlite-ddl.md.
 *
 * Frozen at M1:
 *   - the {@link SqliteDriver} adapter + node:sqlite implementation (WAL on
 *     open; better-sqlite3 swap path documented in driver.ts)
 *   - the migration runner (fresh apply, idempotent re-run, out-of-order and
 *     history-drift rejection; migrate.ts)
 *   - migration 0001: resume_ledger + account_profiles + schema_meta
 *   - kernel accessors + the resume-ledger state machine (kernel.ts)
 * Lands later (each via ICR at its milestone): M3 events tables, M4 X4
 * tables, M5 pipeline tables.
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

import { openNodeSqliteDatabase } from './driver.js';
import {
  createAccountProfilesStore,
  createResumeLedgerStore,
  createSchemaMetaStore,
  type AccountProfilesStore,
  type KernelStoreOptions,
  type ResumeLedgerStore,
  type SchemaMetaStore,
} from './kernel.js';
import { createMigrationRunner } from './migrate.js';
import { KERNEL_MIGRATIONS } from './migrations/0001-kernel.js';
import type { SqliteDriver } from './driver.js';

export interface KernelStore {
  readonly driver: SqliteDriver;
  /** `wal` for file-backed stores; `memory` for `:memory:` test stores. */
  readonly journalMode: string;
  readonly resumeLedger: ResumeLedgerStore;
  readonly accountProfiles: AccountProfilesStore;
  readonly schemaMeta: SchemaMetaStore;
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
    close: () => driver.close(),
  };
}
