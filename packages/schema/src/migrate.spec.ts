import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  KERNEL_MIGRATIONS,
  MigrationApplyError,
  MigrationHistoryError,
  createMigrationRunner,
  openNodeSqliteDatabase,
  type Migration,
  type SqliteDriver,
} from './index.js';

const m = (id: number, name: string, up: string): Migration => ({ id, name, up });

const M1 = m(1, 'one', 'CREATE TABLE t_one (x INTEGER PRIMARY KEY) STRICT;');
const M2 = m(2, 'two', 'CREATE TABLE t_two (x INTEGER PRIMARY KEY) STRICT;');
const M3 = m(3, 'three', 'CREATE TABLE t_three (x INTEGER PRIMARY KEY) STRICT;');

let cleanups: Array<() => void> = [];
const memoryDriver = (): SqliteDriver => {
  const { driver } = openNodeSqliteDatabase({ path: ':memory:' });
  cleanups.push(() => driver.close());
  return driver;
};

afterEach(() => {
  for (const fn of cleanups) fn();
  cleanups = [];
});

describe('openNodeSqliteDatabase (adapter)', () => {
  it('enables WAL journal mode on file-backed stores (blueprint §6.2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aibender-schema-'));
    const { driver, journalMode } = openNodeSqliteDatabase({ path: join(dir, 'kernel.db') });
    expect(journalMode).toBe('wal');
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports memory journal mode for :memory: stores (WAL is file-only)', () => {
    const { driver, journalMode } = openNodeSqliteDatabase({ path: ':memory:' });
    expect(journalMode).toBe('memory');
    driver.close();
  });
});

describe('createMigrationRunner', () => {
  // -- positive: fresh apply -------------------------------------------------

  it('applies a fresh list in order and records the ledger', async () => {
    const runner = createMigrationRunner(memoryDriver(), {
      nowIso: () => '2026-07-04T00:00:00.000Z',
    });
    const applied = await runner.apply([M1, M2]);
    expect(applied.map((a) => a.id)).toEqual([1, 2]);
    expect(applied[0]?.appliedAtIso).toBe('2026-07-04T00:00:00.000Z');
    expect((await runner.applied()).map((a) => a.name)).toEqual(['one', 'two']);
  });

  it('applies the real kernel migrations on a fresh store', async () => {
    const driver = memoryDriver();
    const runner = createMigrationRunner(driver);
    const applied = await runner.apply(KERNEL_MIGRATIONS);
    // 0001 = M1 kernel tables; 0003 = M4 lineage tables (0002 lives on the
    // separate collector events database — EVENTS_STORE_MIGRATIONS).
    expect(applied.map((a) => a.name)).toEqual(['kernel-tables-init', 'lineage-tables-init']);
    // the three kernel tables + the four lineage tables exist:
    const tables = driver
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r['name']);
    expect(tables).toContain('resume_ledger');
    expect(tables).toContain('account_profiles');
    expect(tables).toContain('schema_meta');
    expect(tables).toContain('workstream');
    expect(tables).toContain('session_node');
    expect(tables).toContain('session_edge');
    expect(tables).toContain('brief');
  });

  // -- positive: re-run idempotence -------------------------------------------

  it('re-running the same list is a no-op (idempotent)', async () => {
    const runner = createMigrationRunner(memoryDriver());
    await runner.apply([M1, M2]);
    const second = await runner.apply([M1, M2]);
    expect(second).toEqual([]);
    expect((await runner.applied()).map((a) => a.id)).toEqual([1, 2]);
  });

  it('extending the list applies only the new tail', async () => {
    const runner = createMigrationRunner(memoryDriver());
    await runner.apply([M1, M2]);
    const third = await runner.apply([M1, M2, M3]);
    expect(third.map((a) => a.id)).toEqual([3]);
  });

  // -- negative: out-of-order + drift -----------------------------------------

  it('rejects an unapplied migration below the applied high-water mark', async () => {
    const runner = createMigrationRunner(memoryDriver());
    await runner.apply([M1, M3]); // history: 1, 3
    await expect(runner.apply([M1, M2, M3])).rejects.toThrow(MigrationHistoryError);
    await expect(runner.apply([M1, M2, M3])).rejects.toThrow(/out-of-order/);
  });

  it('rejects a partial list missing an applied migration', async () => {
    const runner = createMigrationRunner(memoryDriver());
    await runner.apply([M1, M2]);
    await expect(runner.apply([M2])).rejects.toThrow(MigrationHistoryError);
  });

  it('rejects name drift on an applied id', async () => {
    const runner = createMigrationRunner(memoryDriver());
    await runner.apply([M1]);
    await expect(runner.apply([m(1, 'renamed', M1.up)])).rejects.toThrow(/history drift/);
  });

  it('rejects unordered input lists via assertMigrationOrder', async () => {
    const runner = createMigrationRunner(memoryDriver());
    await expect(runner.apply([M2, M1])).rejects.toThrow(RangeError);
  });

  // -- edge: atomicity + empty list -------------------------------------------

  it('rolls back a failing migration atomically and applies nothing after it', async () => {
    const driver = memoryDriver();
    const runner = createMigrationRunner(driver);
    const broken = m(
      2,
      'broken',
      'CREATE TABLE t_partial (x INTEGER PRIMARY KEY) STRICT; CREATE TABLE syntax error;',
    );
    await expect(runner.apply([M1, broken, M3])).rejects.toThrow(MigrationApplyError);
    // 1 applied; 2 rolled back including its partial DDL; 3 never attempted.
    expect((await runner.applied()).map((a) => a.id)).toEqual([1]);
    const tables = driver
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r['name']);
    expect(tables).not.toContain('t_partial');
    expect(tables).not.toContain('t_three');
    // the store remains usable: fixing the migration succeeds.
    const fixed = m(2, 'broken', 'CREATE TABLE t_fixed (x INTEGER PRIMARY KEY) STRICT;');
    const applied = await runner.apply([M1, fixed, M3]);
    expect(applied.map((a) => a.id)).toEqual([2, 3]);
  });

  it('accepts an empty list on a fresh store (nothing to do)', async () => {
    const runner = createMigrationRunner(memoryDriver());
    expect(await runner.apply([])).toEqual([]);
    expect(await runner.applied()).toEqual([]);
  });

  it('kernel migrations re-run across a REOPEN of the same file (durability)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aibender-schema-'));
    const path = join(dir, 'kernel.db');
    const first = openNodeSqliteDatabase({ path });
    await createMigrationRunner(first.driver).apply(KERNEL_MIGRATIONS);
    first.driver.close();

    const second = openNodeSqliteDatabase({ path });
    const runner = createMigrationRunner(second.driver);
    expect(await runner.apply(KERNEL_MIGRATIONS)).toEqual([]); // already applied
    expect((await runner.applied()).map((a) => a.id)).toEqual([1, 3]);
    second.driver.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
