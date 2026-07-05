import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SYNTHETIC_CREDENTIAL_VALUE, buildFakeOpencodeDb } from '@aibender/testkit';
import { afterAll, describe, expect, it } from 'vitest';

import { ForbiddenDbStatementError } from '../errors.js';
import {
  FORBIDDEN_OPENCODE_TABLES,
  assertGuardedOpencodeSql,
  openOpencodeDbReadOnly,
  stripSqlLiteralsAndComments,
  type GuardedOpencodeDb,
} from './dbAccess.js';

const dir = mkdtempSync(join(tmpdir(), 'aibender-fake-ocdb-'));
const dbPath = join(dir, 'opencode.db');
buildFakeOpencodeDb({
  path: dbPath,
  sessions: [
    { sessionId: 'ses_synthA', eventTypes: ['session.created.1', 'message.updated.1'] },
    { sessionId: 'ses_synthB', eventTypes: ['session.created.1'] },
  ],
});

const openDbs: GuardedOpencodeDb[] = [];
const openDb = (): GuardedOpencodeDb => {
  const db = openOpencodeDbReadOnly({ path: dbPath });
  openDbs.push(db);
  return db;
};
afterAll(() => {
  for (const db of openDbs) db.close();
});

describe('opencode.db guarded reader — the [X2] hard guard (plan §9.2 BE-4 negative)', () => {
  // -- positive: legitimate event/scrape reads work ---------------------------

  it('reads durable events by aggregate (the reconciliation query shape)', () => {
    const db = openDb();
    const rows = db.select(
      'SELECT id, seq, type FROM event WHERE aggregate_id = ? ORDER BY seq',
      ['ses_synthA'],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.['type']).toBe('session.created.1');
    expect(rows[1]?.['seq']).toBe(1);
  });

  it('reads the migration head and event_sequence watermarks', () => {
    const db = openDb();
    expect(db.select('SELECT id FROM migration')).toHaveLength(1);
    const seqs = db.select('SELECT aggregate_id, seq FROM event_sequence ORDER BY aggregate_id');
    expect(seqs.map((row) => row['seq'])).toEqual([1, 0]);
  });

  it('permits WITH … SELECT and string literals mentioning forbidden words', () => {
    const db = openDb();
    const rows = db.select(
      "WITH recent AS (SELECT type FROM event WHERE type <> 'account.created') " +
        'SELECT COUNT(*) AS n FROM recent',
    );
    expect(rows[0]?.['n']).toBe(3);
  });

  it('permits identifiers that merely CONTAIN a forbidden word (accounting ≠ account)', () => {
    const db = openDb();
    const rows = db.select('SELECT id AS accounting FROM event LIMIT 1');
    expect(rows).toHaveLength(1);
  });

  // -- negative: account/credential tables are UNREADABLE ----------------------

  it.each([
    'SELECT * FROM account',
    'SELECT * FROM credential',
    'SELECT token FROM ACCOUNT', // case
    'SELECT * FROM "account"', // quoted
    'SELECT * FROM `credential`', // backticked
    'SELECT * FROM [account]', // bracketed
    'SELECT * FROM main.account', // schema-qualified
    'SELECT e.id FROM event e JOIN credential c ON 1=1', // join smuggle
    'WITH x AS (SELECT secret FROM credential) SELECT * FROM x', // CTE smuggle
    'SELECT (SELECT token FROM account LIMIT 1) AS t FROM event', // subquery
    'SELECT * FROM event; SELECT * FROM account', // second statement
    'SELECT * FROM/**/account', // comment splice
  ])('refuses %s', (sql) => {
    const db = openDb();
    expect(() => db.select(sql)).toThrow(ForbiddenDbStatementError);
  });

  it.each([
    'INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (1,2,3,4,5)',
    'UPDATE event SET type = ?',
    'DELETE FROM event',
    'DROP TABLE event',
    'CREATE TABLE sneak (x)',
    "ATTACH DATABASE '/synthetic/other.db' AS other",
    'PRAGMA user_version',
    'BEGIN',
    'VACUUM',
  ])('refuses non-SELECT statement: %s', (sql) => {
    const db = openDb();
    expect(() => db.select(sql)).toThrow(ForbiddenDbStatementError);
  });

  it('the credential VALUE physically present in the db can never be reached', () => {
    // Belt: the guard blocks the only tables carrying it. Suspenders: prove
    // the value exists in the file (the fixture wrote it), yet no guarded
    // query can return it.
    const db = openDb();
    expect(() => db.select('SELECT secret FROM credential')).toThrow(ForbiddenDbStatementError);
    expect(() => db.select('SELECT token FROM account')).toThrow(ForbiddenDbStatementError);
    // Legit queries never surface it either (events carry synthesized JSON).
    const all = db.select('SELECT data FROM event');
    for (const row of all) {
      expect(String(row['data'])).not.toContain(SYNTHETIC_CREDENTIAL_VALUE);
    }
  });

  it('exposes ONLY select() — no exec/run surface exists to write with', () => {
    const db = openDb();
    expect(Object.keys(db).sort()).toEqual(['close', 'location', 'select']);
  });

  // -- edge -------------------------------------------------------------------

  it('the forbidden list is exactly account + credential', () => {
    expect([...FORBIDDEN_OPENCODE_TABLES]).toEqual(['account', 'credential']);
  });

  it('the header documents the SEC-6/SEC-7 security contract (SECURITY.md §6 cross-ref)', () => {
    // SEC-6/SEC-7: the frozen-external-schema and OS-level-read-only
    // assumptions the guard rests on must be written down at BOTH doc sites —
    // SECURITY.md §6 (the security lane) AND this file's header (the BE lane).
    // SECURITY.md §6 asserts "the dbAccess.ts header carries a cross-reference
    // to this section"; this test makes that assertion enforceable so the
    // cross-reference cannot silently drift out. See SECURITY.md §6.
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'dbAccess.ts'), 'utf8');
    const header = source.slice(0, source.indexOf('*/') + 2);
    expect(header).toMatch(/SEC-6/);
    expect(header).toMatch(/SEC-7/);
    expect(header).toMatch(/SECURITY\.md §6/);
    // The version-bump security-event posture must survive in the header too:
    // renaming the OpenCode credential tables silently defeats the blocklist.
    expect(header).toMatch(/version bump/i);
    expect(header).toMatch(/version-gate\.md/);
  });

  it('stripSqlLiteralsAndComments removes literals and both comment styles', () => {
    expect(
      stripSqlLiteralsAndComments(
        "SELECT 'account' AS a -- credential\n, 1 /* account */ FROM event",
      ),
    ).not.toMatch(/account|credential/);
  });

  it('guard screening rejects PRAGMA even with leading whitespace/comments', () => {
    expect(() => assertGuardedOpencodeSql('  /* x */ PRAGMA user_version')).toThrow(
      ForbiddenDbStatementError,
    );
  });
});
