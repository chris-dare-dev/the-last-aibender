/**
 * @aibender/schema — SQLite migrations + typed row accessors for ALL harness
 * ledgers: resume ledger; workstream/session_node/session_edge/brief
 * (blueprint §5); events + quota_snapshots + session_outcomes + prices
 * (blueprint §6.2); workflow runs/steps/memoization journal (blueprint §7).
 *
 * M0 STUB: only the migration-runner interface exists. Tables land per plan §3:
 * M1 (kernel), M3 (events), M4 (X4), M5 (pipelines) — owner BE-ORCH, amendments
 * via ICR (docs/contracts/icr/). DDL is documented in docs/contracts/sqlite-ddl.md.
 *
 * Field-tag convention (consumed by @aibender/shared redaction filters): every
 * column carrying sensitive material will be declared with `secret` /
 * `identifier` tags when accessors land. Nothing identity-bearing enters any
 * store — identities are mapped to MAX_A/MAX_B/ENT at ingest [X2].
 */

/** One forward-only SQLite migration step. */
export interface Migration {
  /** Positive integer, strictly increasing across the migration list. */
  readonly id: number;
  /** Human-readable slug, e.g. `resume-ledger-init`. */
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
 * The migration runner every ledger opens through. The real SQLite-backed
 * implementation lands at M1; M0 ships the interface so dependents can code
 * against it and tests can fake it.
 */
export interface MigrationRunner {
  /** Migrations already applied to the store, in application order. */
  applied(): Promise<readonly AppliedMigration[]>;
  /**
   * Apply `pending` in order, atomically per migration, skipping ids already
   * applied. Callers must pass a list that satisfies {@link assertMigrationOrder}.
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
