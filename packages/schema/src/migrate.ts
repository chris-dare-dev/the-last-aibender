/**
 * SQLite migration runner over the {@link SqliteDriver} adapter.
 *
 * Discipline (tested fresh / re-run / out-of-order):
 *   - forward-only, atomic per migration (BEGIN … COMMIT, ROLLBACK on error)
 *   - the applied ledger lives in `schema_migrations` (bootstrapped here, NOT
 *     by a migration — it must exist before any migration can be recorded)
 *   - callers pass the FULL migration list every time (documented on the M0
 *     interface); already-applied ids are skipped → re-running is a no-op
 *   - HISTORY DRIFT is refused loudly:
 *       · an applied id missing from the passed list        → MigrationHistoryError
 *       · an applied id whose name differs from the list's  → MigrationHistoryError
 *       · an unapplied id BELOW the highest applied id      → MigrationHistoryError
 *         (out-of-order application would reorder history)
 *
 * ============================================================================
 * FROZEN-M1 (2026-07-04) — kernel slice. Amendments only via ICR
 * (docs/contracts/icr/). Prose of record: docs/contracts/sqlite-ddl.md.
 * ============================================================================
 */

import type { SqliteDriver } from './driver.js';
import type { AppliedMigration, Migration, MigrationRunner } from './index.js';
import { assertMigrationOrder } from './index.js';

export class MigrationHistoryError extends Error {
  override readonly name = 'MigrationHistoryError';
}

export class MigrationApplyError extends Error {
  override readonly name = 'MigrationApplyError';
  constructor(migration: Migration, cause: unknown) {
    super(
      `migration ${migration.id} (${migration.name}) failed and was rolled back: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

const BOOTSTRAP_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id             INTEGER PRIMARY KEY CHECK (id > 0),
  name           TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  applied_at_iso TEXT    NOT NULL
) STRICT;
`;

export interface MigrationRunnerOptions {
  /** Timestamp source, injectable for tests. Default: `new Date().toISOString()`. */
  readonly nowIso?: () => string;
}

/**
 * Create the real, SQLite-backed {@link MigrationRunner} (the M0 stub shipped
 * only the interface). Bootstraps `schema_migrations` immediately.
 */
export function createMigrationRunner(
  driver: SqliteDriver,
  options: MigrationRunnerOptions = {},
): MigrationRunner {
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  driver.exec(BOOTSTRAP_DDL);

  const readApplied = (): AppliedMigration[] =>
    driver
      .prepare('SELECT id, name, applied_at_iso FROM schema_migrations ORDER BY id')
      .all()
      .map((row) => ({
        id: Number(row['id']),
        name: String(row['name']),
        appliedAtIso: String(row['applied_at_iso']),
      }));

  return {
    applied: async () => readApplied(),

    apply: async (pending: readonly Migration[]): Promise<readonly AppliedMigration[]> => {
      assertMigrationOrder(pending);
      const applied = readApplied();
      const pendingById = new Map(pending.map((m) => [m.id, m]));

      // History-drift checks: every applied migration must appear in the
      // passed list under the same name.
      for (const row of applied) {
        const match = pendingById.get(row.id);
        if (match === undefined) {
          throw new MigrationHistoryError(
            `applied migration ${row.id} (${row.name}) is missing from the passed list — ` +
              `pass the full migration list, never a partial one`,
          );
        }
        if (match.name !== row.name) {
          throw new MigrationHistoryError(
            `applied migration ${row.id} is named ${JSON.stringify(row.name)} in the store ` +
              `but ${JSON.stringify(match.name)} in the passed list — history drift refused`,
          );
        }
      }

      const appliedIds = new Set(applied.map((row) => row.id));
      const maxAppliedId = applied.length > 0 ? (applied[applied.length - 1]?.id ?? 0) : 0;
      const toApply = pending.filter((m) => !appliedIds.has(m.id));

      // Out-of-order rejection: an unapplied migration below the applied
      // high-water mark cannot be slotted into history.
      for (const migration of toApply) {
        if (migration.id < maxAppliedId) {
          throw new MigrationHistoryError(
            `migration ${migration.id} (${migration.name}) is unapplied but below the ` +
              `applied high-water mark ${maxAppliedId} — out-of-order application refused`,
          );
        }
      }

      const newlyApplied: AppliedMigration[] = [];
      const insert = driver.prepare(
        'INSERT INTO schema_migrations (id, name, applied_at_iso) VALUES (?, ?, ?)',
      );
      for (const migration of toApply) {
        driver.exec('BEGIN');
        try {
          driver.exec(migration.up);
          const appliedAtIso = nowIso();
          insert.run(migration.id, migration.name, appliedAtIso);
          driver.exec('COMMIT');
          newlyApplied.push({ id: migration.id, name: migration.name, appliedAtIso });
        } catch (cause) {
          driver.exec('ROLLBACK');
          throw new MigrationApplyError(migration, cause);
        }
      }
      return newlyApplied;
    },
  };
}
