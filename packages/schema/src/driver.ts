/**
 * SQLite driver adapter [engine choice + swap path].
 *
 * ENGINE (M1 decision, per the build brief and plan §3): `node:sqlite`
 * (DatabaseSync) — in Node since 22.5, zero native dependencies, synchronous
 * API matching the ledger workloads. Every store in this package talks ONLY
 * to the {@link SqliteDriver} interface below, never to node:sqlite directly.
 *
 * BETTER-SQLITE3 SWAP PATH (documented, deliberately trivial): implement
 * {@link SqliteDriver} over a better-sqlite3 `Database` —
 *   exec(sql)         → db.exec(sql)
 *   prepare(sql).run  → stmt.run(...)   ({ changes, lastInsertRowid } matches)
 *   prepare(sql).get  → stmt.get(...)   (rows as plain objects — same shape)
 *   prepare(sql).all  → stmt.all(...)
 *   close()           → db.close()
 * and pass it to createMigrationRunner / the kernel stores unchanged. The
 * pragmas below are identical on both engines. No caller code changes.
 * Full prose: docs/contracts/sqlite-ddl.md §1.
 *
 * ============================================================================
 * FROZEN-M1 (2026-07-04) — kernel slice. Amendments only via ICR
 * (docs/contracts/icr/). Prose of record: docs/contracts/sqlite-ddl.md.
 * ============================================================================
 */

import { DatabaseSync } from 'node:sqlite';

/** Values crossing the driver boundary (superset compatible with better-sqlite3). */
export type SqlValue = null | number | bigint | string | Uint8Array;

export type SqlRow = Record<string, SqlValue>;

export interface SqliteStatement {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): SqlRow | undefined;
  all(...params: SqlValue[]): SqlRow[];
}

/** The minimal surface every schema store codes against. */
export interface SqliteDriver {
  /** Location the database was opened from (`:memory:` or an absolute path). */
  readonly location: string;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface OpenDatabaseOptions {
  /** `:memory:` (tests) or an absolute file path (e.g. ~/.aibender/db/kernel.db). */
  readonly path: string;
}

export interface OpenedDatabase {
  readonly driver: SqliteDriver;
  /**
   * The journal mode actually in effect after open: `wal` for file-backed
   * stores (blueprint §6.2: "One SQLite (WAL) database"); in-memory databases
   * report `memory` — SQLite cannot WAL a memory store, which is fine for tests.
   */
  readonly journalMode: string;
}

/**
 * Open (or create) a database through node:sqlite with the harness pragmas:
 * WAL journaling (file-backed), foreign keys ON, busy timeout 5 s.
 */
export function openNodeSqliteDatabase(options: OpenDatabaseOptions): OpenedDatabase {
  const db = new DatabaseSync(options.path);
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  const modeRow = db.prepare('PRAGMA journal_mode = wal;').get();
  const journalMode = String(modeRow?.['journal_mode'] ?? 'unknown');

  const driver: SqliteDriver = {
    location: options.path,
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const statement = db.prepare(sql);
      return {
        run: (...params) => statement.run(...params),
        get: (...params) => statement.get(...params) as SqlRow | undefined,
        all: (...params) => statement.all(...params) as SqlRow[],
      };
    },
    close: () => db.close(),
  };
  return { driver, journalMode };
}
