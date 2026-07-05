/**
 * Migration 0007 — backend-registry generalization for the KERNEL DB
 * ([X1] scalability, finding OS-1, ICR-0016). The BACKEND twin of the ICR-0013
 * account relaxation (0005). The events-store half is migration 0008.
 *
 * WHAT CHANGES: the `backend` CHECK constraints on the kernel-DB tables were
 * pinned to the CLOSED 3-literal set `('claude_code','opencode','lmstudio')`,
 * and the label↔backend PAIRING + `substrate != 'pty' OR backend='claude_code'`
 * CHECKs hardcoded those same literals. That made a fourth backend (a new local
 * LLM registered via `registerBackend`) a DB-level fork: a valid registered
 * backend id would be REFUSED by the frozen CHECK. This migration RELAXES the
 * DB checks so a registered backend lands WITHOUT a schema change, while KEEPING
 * every built-in invariant CHECK-enforced (defense-in-depth) verbatim:
 *
 *   backend  → length(backend) > 0            -- open, non-empty
 *   account  → the built-in open MAX_<X>/ENT/AWS_DEV/LOCAL form, OR a
 *              non-empty label paired with a NON-built-in backend (a registered
 *              4th backend serves its OWN account-label form — e.g. SYNTH_L —
 *              which the built-in account regex cannot express; the accessor's
 *              isAccountLabel() consults the registry and is authoritative)
 *   pairing  → the built-in triples hold for the built-in backends, OR the
 *              backend is NOT a built-in (a registered backend; the accessor's
 *              backendForLabel() pairing gate is authoritative for it)
 *   pty      → the built-in pty-is-claude-only rule holds for the built-in
 *              backends, OR the backend is NOT a built-in (deferred to the
 *              accessor's substrateLegalFor())
 *
 * WHY the account CHECK also relaxes here (not left frozen at the M7 form): a
 * registered backend, by definition, serves account labels OUTSIDE the built-in
 * MAX_<X>/ENT/AWS_DEV/LOCAL forms (its descriptor's servesLabel predicate). The
 * OS-1 goal — a 4th backend lands with NO schema change — is unreachable if the
 * account-label CHECK still pins the built-in form: the row would be refused by
 * the DB even though the app layer admits it. So the account CHECK becomes
 * "built-in form OR (non-empty AND backend is not built-in)": the built-in
 * account form stays CHECK-enforced for the built-in backends (byte-identical
 * defense-in-depth), and a registered backend's labels ride the app-layer
 * isAccountLabel() gate. The M7 open MAX_<X> form is thus a SUBSET of what the
 * relaxed CHECK admits — every M1-M7 row still validates.
 *
 * THE CHECK-DERIVATION DECISION (sqlite-ddl.md §11): a SQLite CHECK is static
 * SQL and CANNOT query the runtime BackendDescriptor registry, so option (a)
 * "derive the set from one generated constant" cannot be a live DB check for an
 * OPEN set. We take the M3-events precedent for open vocabularies (`event_type`,
 * `model`, `provider` are un-CHECK'd; the accessor screens them): the `backend`
 * VALUE set moves to the APP LAYER (`isBackend()` consults the registry at
 * insert; `backendForLabel()` enforces pairing; `substrateLegalFor()` enforces
 * the pty rule). The DB retains a NON-EMPTY guard + the BUILT-IN pairing/pty
 * clauses as defense-in-depth so a bypassing writer still cannot land an illegal
 * BUILT-IN row. The account-label CHECK (the open MAX_<X> form from 0005) is
 * PRESERVED verbatim — this migration touches ONLY the backend clauses.
 *
 * TABLES REBUILT (SQLite cannot ALTER a CHECK — a table rebuild is required),
 * mirroring the 0005 recipe exactly:
 *   - account_profiles   (backend CHECK + pairing; seed rows preserved)
 *   - resume_ledger      (backend CHECK + pairing + pty CHECK)
 *   - session_node       (backend CHECK + pairing; rebuilt WITH its inbound FK
 *                         from session_edge, re-pointed at the new table)
 *   - step_attempt       (NO backend column — but its account CHECK is
 *                         preserved; it is NOT rebuilt here since 0007 only
 *                         touches backend clauses and step_attempt has none)
 *
 * account_profiles/resume_ledger/session_node are the three kernel tables that
 * carry a `backend` column. step_attempt has none, so it is untouched.
 *
 * SAFE-REBUILD RECIPE: identical to 0005 — `PRAGMA defer_foreign_keys=ON`
 * (effective inside the runner's BEGIN…COMMIT, unlike `foreign_keys`), and for
 * the one inbound-FK table (session_node ← session_edge) rename-old-aside first,
 * build under the real name, copy, rebuild session_edge to re-point, drop temp.
 * `foreign_key_check` is clean at COMMIT.
 *
 * ============================================================================
 * FROZEN-M8 (2026-07-05) via ICR-0016. Amendments only via ICR. Frozen
 * migrations 0001-0006 stay byte-identical; changes ride 0007. Prose of
 * record: docs/contracts/sqlite-ddl.md §11 (backend-CHECK-derivation decision
 * + amendment row).
 * ============================================================================
 */

import type { Migration } from '../index.js';

/** The three built-in backend ids, as a SQL set literal (defense-in-depth). */
const BUILTIN_BACKENDS = "('claude_code','opencode','lmstudio')";

/**
 * The relaxed account-label CHECK: the built-in open MAX_<X> form (from 0005)
 * stays enforced, OR a non-empty label paired with a NON-built-in backend (a
 * registered backend serving its own label form — app-layer isAccountLabel()
 * is authoritative for it). The M7 form is a strict subset of what this admits.
 */
const LABEL_FORM =
  "((label GLOB 'MAX_[A-Z]' OR label IN ('ENT','AWS_DEV','LOCAL')) " +
  "OR (length(label) > 0 AND backend NOT IN " +
  BUILTIN_BACKENDS +
  '))';
const ACCOUNT_LABEL_FORM =
  "((account_label GLOB 'MAX_[A-Z]' OR account_label IN ('ENT','AWS_DEV','LOCAL')) " +
  "OR (length(account_label) > 0 AND backend NOT IN " +
  BUILTIN_BACKENDS +
  '))';
const ACCOUNT_FORM =
  "((account GLOB 'MAX_[A-Z]' OR account IN ('ENT','AWS_DEV','LOCAL')) " +
  "OR (length(account) > 0 AND backend NOT IN " +
  BUILTIN_BACKENDS +
  '))';

export const MIGRATION_0007_BACKEND_REGISTRY: Migration = {
  id: 7,
  name: 'backend-registry-open-set',
  up: `
PRAGMA defer_foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- account_profiles — backend CHECK open; built-in pairing preserved. Account
-- label CHECK (open MAX_<X> form) preserved verbatim. Seed rows preserved.
-- (No inbound FK: resume_ledger.account_label is a plain CHECK, not an FK.)
-- ---------------------------------------------------------------------------
CREATE TABLE account_profiles_new (
  label          TEXT PRIMARY KEY
                 CHECK ${LABEL_FORM},
  backend        TEXT NOT NULL
                 CHECK (length(backend) > 0),
  config_dir     TEXT,
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  CHECK (
    backend NOT IN ${BUILTIN_BACKENDS}
    OR ((label GLOB 'MAX_[A-Z]' OR label = 'ENT') AND backend = 'claude_code')
    OR (label = 'AWS_DEV' AND backend = 'opencode')
    OR (label = 'LOCAL'   AND backend = 'lmstudio')
  )
) STRICT;
INSERT INTO account_profiles_new SELECT label, backend, config_dir, created_at_iso, updated_at_iso FROM account_profiles;
DROP TABLE account_profiles;
ALTER TABLE account_profiles_new RENAME TO account_profiles;

-- ---------------------------------------------------------------------------
-- resume_ledger — backend CHECK open; built-in pairing + built-in pty rule
-- preserved. Account label CHECK preserved verbatim. (No inbound FK.)
-- ---------------------------------------------------------------------------
CREATE TABLE resume_ledger_new (
  id                TEXT PRIMARY KEY CHECK (length(id) > 0),
  account_label     TEXT NOT NULL
                    CHECK ${ACCOUNT_LABEL_FORM},
  backend           TEXT NOT NULL
                    CHECK (length(backend) > 0),
  cwd               TEXT NOT NULL CHECK (length(cwd) > 0),
  substrate         TEXT NOT NULL CHECK (substrate IN ('sdk','pty')),
  purpose           TEXT NOT NULL CHECK (length(purpose) > 0),
  workstream_hint   TEXT,
  native_session_id TEXT,
  state             TEXT NOT NULL
                    CHECK (state IN ('spawning','running','resumed','orphan_detected','orphan_killed','exited')),
  pid               INTEGER CHECK (pid IS NULL OR pid > 0),
  spawn_nonce       TEXT,
  created_at_iso    TEXT NOT NULL,
  updated_at_iso    TEXT NOT NULL,
  CHECK (
    backend NOT IN ${BUILTIN_BACKENDS}
    OR ((account_label GLOB 'MAX_[A-Z]' OR account_label = 'ENT') AND backend = 'claude_code')
    OR (account_label = 'AWS_DEV' AND backend = 'opencode')
    OR (account_label = 'LOCAL'   AND backend = 'lmstudio')
  ),
  -- pty is claude_code-only for the BUILT-IN backends; a registered backend
  -- defers to the accessor's substrateLegalFor() (its descriptor decides).
  CHECK (substrate != 'pty' OR backend = 'claude_code' OR backend NOT IN ${BUILTIN_BACKENDS})
) STRICT;
INSERT INTO resume_ledger_new
  SELECT id, account_label, backend, cwd, substrate, purpose, workstream_hint,
         native_session_id, state, pid, spawn_nonce, created_at_iso, updated_at_iso
  FROM resume_ledger;
DROP TABLE resume_ledger;
ALTER TABLE resume_ledger_new RENAME TO resume_ledger;
CREATE INDEX resume_ledger_state_idx   ON resume_ledger (state);
CREATE INDEX resume_ledger_account_idx ON resume_ledger (account_label);
CREATE INDEX resume_ledger_native_idx  ON resume_ledger (native_session_id)
  WHERE native_session_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- session_node — inbound FK from session_edge(from_node,to_node). Same
-- rename-old-aside recipe as 0005. backend CHECK open; built-in pairing kept;
-- account CHECK (open form) preserved verbatim.
-- ---------------------------------------------------------------------------
ALTER TABLE session_node RENAME TO session_node_old;
DROP INDEX session_node_workstream_idx;
DROP INDEX session_node_native_idx;
DROP INDEX session_node_state_idx;
CREATE TABLE session_node (
  id                 TEXT PRIMARY KEY CHECK (length(id) > 0),
  workstream_id      TEXT REFERENCES workstream(id),
  backend            TEXT NOT NULL CHECK (length(backend) > 0),
  account            TEXT NOT NULL
                     CHECK ${ACCOUNT_FORM},
  native_session_id  TEXT,
  native_scope       TEXT,
  transcript_ref     TEXT,
  cwd                TEXT CHECK (cwd IS NULL OR cwd LIKE '/%'),
  git_branch         TEXT,
  worktree           TEXT,
  display_name       TEXT,
  first_prompt_hash  TEXT,
  state              TEXT NOT NULL
                     CHECK (state IN ('running','idle','completed','abandoned','unresumable','external')),
  origin             TEXT NOT NULL CHECK (origin IN ('harness','reconciled')),
  confidence         TEXT NOT NULL CHECK (confidence IN ('recorded','inferred')),
  tokens_in          INTEGER CHECK (tokens_in IS NULL OR tokens_in >= 0),
  tokens_out         INTEGER CHECK (tokens_out IS NULL OR tokens_out >= 0),
  cost_estimated_usd REAL CHECK (cost_estimated_usd IS NULL OR cost_estimated_usd >= 0),
  created_at_ms      INTEGER NOT NULL CHECK (created_at_ms >= 0),
  last_active_at_ms  INTEGER CHECK (last_active_at_ms IS NULL OR last_active_at_ms >= 0),
  CHECK (
    backend NOT IN ${BUILTIN_BACKENDS}
    OR ((account GLOB 'MAX_[A-Z]' OR account = 'ENT') AND backend = 'claude_code')
    OR (account = 'AWS_DEV' AND backend = 'opencode')
    OR (account = 'LOCAL'   AND backend = 'lmstudio')
  )
) STRICT;
INSERT INTO session_node
  SELECT id, workstream_id, backend, account, native_session_id, native_scope,
         transcript_ref, cwd, git_branch, worktree, display_name, first_prompt_hash,
         state, origin, confidence, tokens_in, tokens_out, cost_estimated_usd,
         created_at_ms, last_active_at_ms
  FROM session_node_old;
CREATE INDEX session_node_workstream_idx ON session_node (workstream_id)
  WHERE workstream_id IS NOT NULL;
CREATE INDEX session_node_native_idx     ON session_node (native_session_id)
  WHERE native_session_id IS NOT NULL;
CREATE INDEX session_node_state_idx      ON session_node (state);

-- Rebuild session_edge so its FKs point at the NEW session_node (they reference
-- session_node_old after the rename). CHECK set unchanged.
CREATE TABLE session_edge_new (
  id             TEXT PRIMARY KEY CHECK (length(id) > 0),
  from_node      TEXT REFERENCES session_node(id),
  to_node        TEXT NOT NULL REFERENCES session_node(id),
  edge_type      TEXT NOT NULL
                 CHECK (edge_type IN ('continue','fork','merge_parent','compact',
                                      'sidechain','handoff','import','workflow')),
  brief_id       TEXT REFERENCES brief(id),
  confidence     TEXT NOT NULL DEFAULT 'recorded'
                 CHECK (confidence IN ('recorded','inferred')),
  metadata       TEXT,
  created_at_ms  INTEGER NOT NULL CHECK (created_at_ms >= 0),
  CHECK (edge_type = 'import' OR from_node IS NOT NULL),
  CHECK (edge_type != 'import' OR from_node IS NULL),
  CHECK (edge_type != 'handoff' OR brief_id IS NOT NULL)
) STRICT;
INSERT INTO session_edge_new
  SELECT id, from_node, to_node, edge_type, brief_id, confidence, metadata, created_at_ms
  FROM session_edge;
DROP TABLE session_edge;
ALTER TABLE session_edge_new RENAME TO session_edge;
CREATE INDEX session_edge_from_idx ON session_edge (from_node) WHERE from_node IS NOT NULL;
CREATE INDEX session_edge_to_idx   ON session_edge (to_node);
CREATE INDEX session_edge_type_idx ON session_edge (edge_type);

DROP TABLE session_node_old;

-- Reflect the widened contract in schema metadata.
UPDATE schema_meta SET value = '7' WHERE key = 'ddl_version';
INSERT INTO schema_meta (key, value) VALUES ('frozen_milestone', 'M8')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
`,
};
