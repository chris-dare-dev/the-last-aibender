/**
 * Typed row accessors for the M1 kernel tables (migration 0001) + the
 * resume-ledger state machine.
 *
 * ROW-BEFORE-SPAWN DISCIPLINE (blueprint §4.1, proven by SPIKE-D vii): the
 * kernel calls {@link ResumeLedgerStore.insertBeforeSpawn} BEFORE fork/exec —
 * the row always starts in `spawning`, so a crash landing between row and
 * spawn leaves a recoverable record, never an untracked child.
 *
 * State machine (storage-side legality; kernel owns pid-liveness semantics):
 *
 *   spawning ──► running ──► exited
 *      │            │  ├──► resumed          (dead-resume after broker SIGKILL)
 *      └──► exited  │  └──► orphan_detected ──► orphan_killed ──► resumed
 *                   │                                        └──► exited
 *   resumed ──► resumed | orphan_detected | exited
 *   exited  ──► (terminal)
 *
 * ============================================================================
 * FROZEN-M1 (2026-07-04) — kernel slice. Amendments only via ICR
 * (docs/contracts/icr/). Prose of record: docs/contracts/sqlite-ddl.md.
 * ============================================================================
 */

import {
  LABEL_BACKENDS,
  isAccountLabel,
  isBackend,
  isSessionState,
  isSubstrate,
  type AccountLabel,
  type Backend,
  type SessionState,
  type Substrate,
} from '@aibender/protocol';
import type { FieldTag } from '@aibender/shared';

import type { SqlRow, SqliteDriver } from './driver.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class KernelStoreError extends Error {
  override readonly name: string = 'KernelStoreError';
}

export class SessionNotFoundError extends KernelStoreError {
  override readonly name = 'SessionNotFoundError';
  constructor(sessionId: string) {
    super(`no resume_ledger row for session ${sessionId}`);
  }
}

export class IllegalTransitionError extends KernelStoreError {
  override readonly name = 'IllegalTransitionError';
  readonly from: SessionState;
  readonly to: SessionState;
  constructor(sessionId: string, from: SessionState, to: SessionState) {
    super(`illegal resume_ledger transition ${from} → ${to} for session ${sessionId}`);
    this.from = from;
    this.to = to;
  }
}

// ---------------------------------------------------------------------------
// State machine (SPIKE-D vii scenarios: live orphan, dead-resume, crash window)
// ---------------------------------------------------------------------------

export const LEGAL_TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> =
  Object.freeze({
    // crash-window respawn re-enters running on the SAME session id.
    spawning: ['running', 'exited'],
    running: ['resumed', 'orphan_detected', 'exited'],
    // a resumed session can be dead-resumed again, orphaned again, or exit.
    resumed: ['resumed', 'orphan_detected', 'exited'],
    orphan_detected: ['orphan_killed'],
    orphan_killed: ['resumed', 'exited'],
    exited: [],
  });

export function isLegalTransition(from: SessionState, to: SessionState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/** Non-terminal states a restarting broker must reconcile (SPIKE-D restart scan). */
export const ACTIVE_SESSION_STATES: readonly SessionState[] = Object.freeze([
  'spawning',
  'running',
  'resumed',
  'orphan_detected',
  'orphan_killed',
]);

// ---------------------------------------------------------------------------
// Field tags — consumed by @aibender/shared redaction (plan §3) [X2]
// ---------------------------------------------------------------------------

/**
 * Column → redaction tags for every kernel column that can carry sensitive
 * material. Paths are `identifier` (they embed the machine username); labels
 * are placeholders and deliberately untagged. Nothing in the kernel schema is
 * `secret` — credentials NEVER touch these tables (Keychain-primary, [X2]).
 */
export const KERNEL_FIELD_TAGS: Readonly<Record<string, readonly FieldTag[]>> = Object.freeze({
  cwd: ['identifier'],
  config_dir: ['identifier'],
});

// ---------------------------------------------------------------------------
// resume_ledger accessor
// ---------------------------------------------------------------------------

export interface ResumeLedgerRow {
  readonly id: string;
  readonly accountLabel: AccountLabel;
  readonly backend: Backend;
  readonly cwd: string;
  readonly substrate: Substrate;
  readonly purpose: string;
  readonly workstreamHint: string | null;
  readonly nativeSessionId: string | null;
  readonly state: SessionState;
  readonly pid: number | null;
  readonly spawnNonce: string | null;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

export interface NewResumeLedgerRow {
  readonly id: string;
  readonly accountLabel: AccountLabel;
  readonly backend: Backend;
  readonly cwd: string;
  readonly substrate: Substrate;
  readonly purpose: string;
  readonly workstreamHint?: string;
}

export interface ResumeLedgerStore {
  /**
   * THE row-before-spawn call: insert with state `spawning`, no pid, no
   * native id. Must complete before the kernel forks anything.
   */
  insertBeforeSpawn(row: NewResumeLedgerRow): ResumeLedgerRow;
  get(sessionId: string): ResumeLedgerRow | undefined;
  list(filter?: { readonly states?: readonly SessionState[] }): readonly ResumeLedgerRow[];
  /** Sessions in non-terminal states — the restart reconciliation set. */
  unreconciled(): readonly ResumeLedgerRow[];
  /**
   * Backfill the pid + argv nonce of the ACTUAL session process (SPIKE-D
   * finding 2: never a launcher shim's pid). Refused on exited sessions.
   */
  backfillPid(sessionId: string, pid: number, spawnNonce: string): ResumeLedgerRow;
  /**
   * Backfill the native session id from the init message. Write-once: a
   * second backfill with a DIFFERENT value throws (same value is a no-op).
   */
  backfillNativeSessionId(sessionId: string, nativeSessionId: string): ResumeLedgerRow;
  /**
   * Advance the state machine. Illegal transitions throw
   * {@link IllegalTransitionError} (see LEGAL_TRANSITIONS).
   */
  transition(sessionId: string, to: SessionState): ResumeLedgerRow;
}

export interface KernelStoreOptions {
  /** Timestamp source, injectable for tests. */
  readonly nowIso?: () => string;
}

function rowFromSql(row: SqlRow): ResumeLedgerRow {
  const accountLabel = row['account_label'];
  const backend = row['backend'];
  const substrate = row['substrate'];
  const state = row['state'];
  if (
    !isAccountLabel(accountLabel) ||
    !isBackend(backend) ||
    !isSubstrate(substrate) ||
    !isSessionState(state)
  ) {
    throw new KernelStoreError(`resume_ledger row ${String(row['id'])} fails vocabulary decode`);
  }
  return {
    id: String(row['id']),
    accountLabel,
    backend,
    cwd: String(row['cwd']),
    substrate,
    purpose: String(row['purpose']),
    workstreamHint: row['workstream_hint'] === null ? null : String(row['workstream_hint']),
    nativeSessionId: row['native_session_id'] === null ? null : String(row['native_session_id']),
    state,
    pid: row['pid'] === null ? null : Number(row['pid']),
    spawnNonce: row['spawn_nonce'] === null ? null : String(row['spawn_nonce']),
    createdAtIso: String(row['created_at_iso']),
    updatedAtIso: String(row['updated_at_iso']),
  };
}

const SELECT_COLUMNS =
  'id, account_label, backend, cwd, substrate, purpose, workstream_hint, ' +
  'native_session_id, state, pid, spawn_nonce, created_at_iso, updated_at_iso';

export function createResumeLedgerStore(
  driver: SqliteDriver,
  options: KernelStoreOptions = {},
): ResumeLedgerStore {
  const nowIso = options.nowIso ?? (() => new Date().toISOString());

  const getRow = (sessionId: string): ResumeLedgerRow => {
    const row = driver
      .prepare(`SELECT ${SELECT_COLUMNS} FROM resume_ledger WHERE id = ?`)
      .get(sessionId);
    if (row === undefined) throw new SessionNotFoundError(sessionId);
    return rowFromSql(row);
  };

  return {
    insertBeforeSpawn: (input) => {
      if (!isAccountLabel(input.accountLabel)) {
        throw new KernelStoreError(`unknown account label ${JSON.stringify(input.accountLabel)}`);
      }
      if (LABEL_BACKENDS[input.accountLabel] !== input.backend) {
        throw new KernelStoreError(
          `label/backend pairing violation: ${input.accountLabel} requires ` +
            `${LABEL_BACKENDS[input.accountLabel]}, got ${String(input.backend)}`,
        );
      }
      if (input.substrate === 'pty' && input.backend !== 'claude_code') {
        throw new KernelStoreError('substrate pty is claude_code-only (blueprint §4.1)');
      }
      if (!input.cwd.startsWith('/')) {
        throw new KernelStoreError('cwd must be an absolute, byte-stable path (blueprint §3 rule 2)');
      }
      const ts = nowIso();
      driver
        .prepare(
          `INSERT INTO resume_ledger
             (id, account_label, backend, cwd, substrate, purpose, workstream_hint,
              native_session_id, state, pid, spawn_nonce, created_at_iso, updated_at_iso)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'spawning', NULL, NULL, ?, ?)`,
        )
        .run(
          input.id,
          input.accountLabel,
          input.backend,
          input.cwd,
          input.substrate,
          input.purpose,
          input.workstreamHint ?? null,
          ts,
          ts,
        );
      return getRow(input.id);
    },

    get: (sessionId) => {
      const row = driver
        .prepare(`SELECT ${SELECT_COLUMNS} FROM resume_ledger WHERE id = ?`)
        .get(sessionId);
      return row === undefined ? undefined : rowFromSql(row);
    },

    list: (filter) => {
      const states = filter?.states;
      if (states !== undefined && states.length > 0) {
        const placeholders = states.map(() => '?').join(', ');
        return driver
          .prepare(
            `SELECT ${SELECT_COLUMNS} FROM resume_ledger WHERE state IN (${placeholders}) ORDER BY created_at_iso, id`,
          )
          .all(...states)
          .map(rowFromSql);
      }
      return driver
        .prepare(`SELECT ${SELECT_COLUMNS} FROM resume_ledger ORDER BY created_at_iso, id`)
        .all()
        .map(rowFromSql);
    },

    unreconciled: () => {
      const placeholders = ACTIVE_SESSION_STATES.map(() => '?').join(', ');
      return driver
        .prepare(
          `SELECT ${SELECT_COLUMNS} FROM resume_ledger WHERE state IN (${placeholders}) ORDER BY created_at_iso, id`,
        )
        .all(...ACTIVE_SESSION_STATES)
        .map(rowFromSql);
    },

    backfillPid: (sessionId, pid, spawnNonce) => {
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new KernelStoreError(`pid must be a positive integer, got ${String(pid)}`);
      }
      if (spawnNonce.trim().length === 0) {
        throw new KernelStoreError('spawnNonce must be non-blank (SPIKE-D pid-reuse guard)');
      }
      const current = getRow(sessionId);
      if (current.state === 'exited') {
        throw new KernelStoreError(`cannot backfill pid on exited session ${sessionId}`);
      }
      driver
        .prepare('UPDATE resume_ledger SET pid = ?, spawn_nonce = ?, updated_at_iso = ? WHERE id = ?')
        .run(pid, spawnNonce, nowIso(), sessionId);
      return getRow(sessionId);
    },

    backfillNativeSessionId: (sessionId, nativeSessionId) => {
      if (nativeSessionId.trim().length === 0) {
        throw new KernelStoreError('nativeSessionId must be non-blank');
      }
      const current = getRow(sessionId);
      if (current.nativeSessionId !== null && current.nativeSessionId !== nativeSessionId) {
        throw new KernelStoreError(
          `native session id for ${sessionId} is already ${current.nativeSessionId}; ` +
            `refusing overwrite with ${nativeSessionId} (write-once backfill)`,
        );
      }
      if (current.nativeSessionId === nativeSessionId) return current; // idempotent no-op
      driver
        .prepare('UPDATE resume_ledger SET native_session_id = ?, updated_at_iso = ? WHERE id = ?')
        .run(nativeSessionId, nowIso(), sessionId);
      return getRow(sessionId);
    },

    transition: (sessionId, to) => {
      if (!isSessionState(to)) {
        throw new KernelStoreError(`unknown session state ${JSON.stringify(to)}`);
      }
      const current = getRow(sessionId);
      if (!isLegalTransition(current.state, to)) {
        throw new IllegalTransitionError(sessionId, current.state, to);
      }
      driver
        .prepare('UPDATE resume_ledger SET state = ?, updated_at_iso = ? WHERE id = ?')
        .run(to, nowIso(), sessionId);
      return getRow(sessionId);
    },
  };
}

// ---------------------------------------------------------------------------
// account_profiles accessor
// ---------------------------------------------------------------------------

export interface AccountProfileRow {
  readonly label: AccountLabel;
  readonly backend: Backend;
  /** Machine-local absolute config dir; NULL until provisioned. NEVER committed [X2]. */
  readonly configDir: string | null;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

export interface AccountProfilesStore {
  list(): readonly AccountProfileRow[];
  get(label: AccountLabel): AccountProfileRow | undefined;
  /** Record the machine-local config dir (absolute path required). */
  setConfigDir(label: AccountLabel, configDir: string): AccountProfileRow;
}

function profileFromSql(row: SqlRow): AccountProfileRow {
  const label = row['label'];
  const backend = row['backend'];
  if (!isAccountLabel(label) || !isBackend(backend)) {
    throw new KernelStoreError('account_profiles row fails vocabulary decode');
  }
  return {
    label,
    backend,
    configDir: row['config_dir'] === null ? null : String(row['config_dir']),
    createdAtIso: String(row['created_at_iso']),
    updatedAtIso: String(row['updated_at_iso']),
  };
}

export function createAccountProfilesStore(
  driver: SqliteDriver,
  options: KernelStoreOptions = {},
): AccountProfilesStore {
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  return {
    list: () =>
      driver
        .prepare(
          'SELECT label, backend, config_dir, created_at_iso, updated_at_iso FROM account_profiles ORDER BY label',
        )
        .all()
        .map(profileFromSql),
    get: (label) => {
      const row = driver
        .prepare(
          'SELECT label, backend, config_dir, created_at_iso, updated_at_iso FROM account_profiles WHERE label = ?',
        )
        .get(label);
      return row === undefined ? undefined : profileFromSql(row);
    },
    setConfigDir: (label, configDir) => {
      if (!isAccountLabel(label)) {
        throw new KernelStoreError(`unknown account label ${JSON.stringify(label)}`);
      }
      if (!configDir.startsWith('/')) {
        throw new KernelStoreError(
          'configDir must be an absolute, byte-stable path (blueprint §3 rule 2)',
        );
      }
      const result = driver
        .prepare('UPDATE account_profiles SET config_dir = ?, updated_at_iso = ? WHERE label = ?')
        .run(configDir, nowIso(), label);
      if (Number(result.changes) === 0) {
        throw new KernelStoreError(`account profile ${label} not found (migration 0001 seeds it)`);
      }
      const row = driver
        .prepare(
          'SELECT label, backend, config_dir, created_at_iso, updated_at_iso FROM account_profiles WHERE label = ?',
        )
        .get(label);
      if (row === undefined) throw new KernelStoreError(`account profile ${label} vanished`);
      return profileFromSql(row);
    },
  };
}

// ---------------------------------------------------------------------------
// schema_meta accessor
// ---------------------------------------------------------------------------

export interface SchemaMetaStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  all(): Readonly<Record<string, string>>;
}

export function createSchemaMetaStore(driver: SqliteDriver): SchemaMetaStore {
  return {
    get: (key) => {
      const row = driver.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key);
      return row === undefined ? undefined : String(row['value']);
    },
    set: (key, value) => {
      if (key.trim().length === 0) throw new KernelStoreError('schema_meta key must be non-blank');
      driver
        .prepare(
          'INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        )
        .run(key, value);
    },
    all: () => {
      const out: Record<string, string> = {};
      for (const row of driver.prepare('SELECT key, value FROM schema_meta ORDER BY key').all()) {
        out[String(row['key'])] = String(row['value']);
      }
      return out;
    },
  };
}
