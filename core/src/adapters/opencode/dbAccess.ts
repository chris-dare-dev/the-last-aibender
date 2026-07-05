/**
 * Guarded read-only access to `opencode.db` (BE-4; blueprint §4.2 final
 * bullet; plan §7 [X2] row: "guards inside BE-4/BE-5 (no credential-table
 * reads)").
 *
 * `opencode.db` contains `account` and `credential` tables. ANY future
 * scraper (BE-5's backfill/orphan reconciler at M3, BE-7's reconciler at M4)
 * must be UNABLE to select from them — the guard lands HERE, in the one
 * db-access helper, so no reader can be written around it:
 *
 *   1. The database is opened READ ONLY (node:sqlite `readOnly: true`).
 *   2. The helper exposes ONLY `select()` — no exec, no run: writes are
 *      structurally impossible on top of being refused by the engine.
 *   3. Every statement is screened FAIL-CLOSED before prepare:
 *      - must be a single SELECT (or WITH … SELECT) statement;
 *      - must not contain ATTACH/PRAGMA/etc. anywhere;
 *      - must not reference a forbidden identifier (`account`, `credential`)
 *        in ANY position — quoted, bracketed, schema-qualified, aliased or
 *        as a CTE name. Even a legitimate column named `account` is refused;
 *        the events/session tables the harness reads have no such columns,
 *        and false-positive rejection is the correct failure mode [X2].
 *
 * The driver surface mirrors @aibender/schema's SqliteDriver so the engine
 * swap path documented there applies here too; opening bypasses
 * openNodeSqliteDatabase only because that helper applies WRITE pragmas
 * (WAL) that a read-only foreign database must never receive.
 *
 * SECURITY CONTRACT (SEC-6 / SEC-7): this guard rests on two documented
 * assumptions written up in SECURITY.md §6 ("The `opencode.db` credential-table
 * read guard") — READ IT before touching `FORBIDDEN_OPENCODE_TABLES` or the
 * screening logic:
 *   1. Frozen external schema. The blocklist is a negative match over the
 *      *current* OpenCode table names (`account`, `credential`). It stops
 *      covering them if OpenCode renames the credential tables in a future
 *      version, so **every OpenCode SDK/binary version bump is a security
 *      event** — re-validate `FORBIDDEN_OPENCODE_TABLES` against the new schema
 *      during SDK-integration testing before adopting the bump
 *      (docs/runbooks/version-gate.md §7, mirroring the Claude-CLI posture).
 *   2. OS-level read-only. `readOnly: true` blocks writes on THIS connection
 *      only; it does not stop a separate write-capable process from creating an
 *      aliasing view. The operational assumption is that `opencode.db` is an
 *      imported, OS-level read-only artifact enforced by file permissions.
 * Field-level column tagging / a runtime positive allowlist are the post-M7
 * hardening options on the watch list (SECURITY.md §6).
 */

import { DatabaseSync } from 'node:sqlite';

import type { SqlRow, SqlValue } from '@aibender/schema';

import { ForbiddenDbStatementError } from '../errors.js';

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

/** Tables no harness reader may ever touch [X2]. */
export const FORBIDDEN_OPENCODE_TABLES = Object.freeze(['account', 'credential'] as const);

/** Statement kinds that are never a plain read. */
const FORBIDDEN_KEYWORDS = Object.freeze([
  'attach',
  'detach',
  'pragma',
  'insert',
  'update',
  'delete',
  'replace',
  'create',
  'drop',
  'alter',
  'vacuum',
  'reindex',
  'analyze',
  'begin',
  'commit',
  'rollback',
  'savepoint',
  'release',
] as const);

/**
 * Strip string literals ('…' with '' escapes) and comments (-- and C-style)
 * so identifier screening cannot be smuggled past inside a literal, and a
 * literal cannot cause a false rejection.
 */
export function stripSqlLiteralsAndComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      out += ' ';
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Tokenize identifiers: bare words plus "quoted", `backticked` and
 * [bracketed] identifiers (all spellings SQLite accepts).
 */
function identifierTokens(strippedSql: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|`([^`]*)`|\[([^\]]*)\]|([A-Za-z_][A-Za-z0-9_$]*)/g;
  for (;;) {
    const match = re.exec(strippedSql);
    if (match === null) break;
    const token = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (token !== undefined) tokens.push(token.toLowerCase());
  }
  return tokens;
}

/**
 * Screen one statement. Throws {@link ForbiddenDbStatementError} unless it
 * is a single plain SELECT that never references a forbidden identifier.
 */
export function assertGuardedOpencodeSql(sql: string): void {
  const stripped = stripSqlLiteralsAndComments(sql);

  // Single statement only: no interior semicolon (trailing one tolerated).
  const withoutTrailing = stripped.replace(/;\s*$/, '');
  if (withoutTrailing.includes(';')) {
    throw new ForbiddenDbStatementError('multiple statements are not allowed');
  }

  const tokens = identifierTokens(withoutTrailing);
  const first = tokens[0];
  if (first !== 'select' && first !== 'with') {
    throw new ForbiddenDbStatementError('only SELECT statements are allowed');
  }
  for (const token of tokens) {
    if ((FORBIDDEN_KEYWORDS as readonly string[]).includes(token)) {
      throw new ForbiddenDbStatementError(`keyword ${token.toUpperCase()} is not allowed`);
    }
    if ((FORBIDDEN_OPENCODE_TABLES as readonly string[]).includes(token)) {
      throw new ForbiddenDbStatementError(
        `identifier ${JSON.stringify(token)} references a credential-bearing table [X2]`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

export interface GuardedOpencodeDb {
  readonly location: string;
  /** Run one screened SELECT. The ONLY data verb this helper exposes. */
  select(sql: string, params?: readonly SqlValue[]): SqlRow[];
  close(): void;
}

export interface OpenOpencodeDbOptions {
  /** Absolute path to an opencode.db (tests point at a synthesized one). */
  readonly path: string;
}

/** Open an opencode.db read-only behind the [X2] statement guard. */
export function openOpencodeDbReadOnly(options: OpenOpencodeDbOptions): GuardedOpencodeDb {
  const db = new DatabaseSync(options.path, { readOnly: true });
  return {
    location: options.path,
    select: (sql, params = []) => {
      assertGuardedOpencodeSql(sql);
      return db.prepare(sql).all(...(params as SqlValue[])) as SqlRow[];
    },
    close: () => db.close(),
  };
}
