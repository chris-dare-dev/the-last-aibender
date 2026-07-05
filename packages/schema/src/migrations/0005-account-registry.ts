/**
 * Migration 0005 — account-registry generalization ([X1] scalability, ICR-0013).
 *
 * WHAT CHANGES: the account-label CHECK constraints on the kernel-DB tables were
 * pinned to the CLOSED 5-literal set `('MAX_A','MAX_B','ENT','AWS_DEV','LOCAL')`.
 * This migration RELAXES them to the OPEN, validated FORM so a newly provisioned
 * Claude Max account (MAX_C, MAX_D, …) lands WITHOUT a schema change:
 *
 *     account GLOB 'MAX_[A-Z]'                     -- the Max-account form
 *       OR account IN ('ENT','AWS_DEV','LOCAL')    -- enterprise + fixed backends
 *
 * `GLOB 'MAX_[A-Z]'` is the SQL mirror of the protocol's `CLAUDE_ACCOUNT_LABEL_RE`
 * (`^MAX_[A-Z]$`): GLOB treats `_` literally (unlike LIKE), `[A-Z]` is a single
 * uppercase-ASCII char class, and GLOB is case-sensitive — so `MAX_C` matches,
 * while `MAX_AB`/`MAX_1`/`max_a`/`HACKER` do NOT. The label↔backend PAIRING CHECK
 * is PRESERVED verbatim (defense-in-depth: a bypassing writer still cannot land an
 * illegal row) — only the label set widens, never the pairing rule.
 *
 * TABLES REBUILT (SQLite cannot ALTER a CHECK — a table rebuild is required):
 *   - account_profiles   (migration 0001; seed rows preserved)
 *   - resume_ledger      (migration 0001)
 *   - session_node       (migration 0003; rebuilt WITH its inbound FK from
 *                         session_edge, which is re-pointed at the new table)
 *   - step_attempt       (migration 0004; nullable `account` CHECK relaxed)
 *
 * The events-store DB tables (events/quota_snapshots/session_outcomes,
 * migration 0002) get the same relaxation in the sibling migration 0006
 * (0006-account-registry-events.ts, EVENTS_STORE_MIGRATIONS).
 *
 * SAFE-REBUILD RECIPE (proven by the accompanying migrate spec): the migrate
 * runner wraps `up` in BEGIN…COMMIT with `PRAGMA foreign_keys=ON`.
 * `PRAGMA foreign_keys` is a no-op inside a transaction, so the classic
 * "toggle foreign_keys OFF" recipe cannot run here. Instead we set
 * `PRAGMA defer_foreign_keys=ON` (which DOES take effect inside a txn — it
 * defers enforcement to COMMIT). For the one table with an inbound FK
 * (session_node ← session_edge) we rename the OLD table aside first (SQLite
 * auto-rewrites session_edge's FK to the temp name), build the new table under
 * the real name, copy, then rebuild session_edge to re-point at the real name,
 * and drop the temp. `foreign_key_check` is clean at COMMIT.
 *
 * ============================================================================
 * FROZEN-M7 (2026-07-05) via ICR-0013. Amendments only via ICR. Prose of
 * record: docs/contracts/sqlite-ddl.md (account-label section + amendment row).
 * ============================================================================
 */

import type { Migration } from '../index.js';

/** The relaxed label-set predicate, reused by every rebuilt table's CHECK. */
const ACCOUNT_FORM = "(account GLOB 'MAX_[A-Z]' OR account IN ('ENT','AWS_DEV','LOCAL'))";
/** account_profiles / resume_ledger name the column `label` / `account_label`. */
const LABEL_FORM = "(label GLOB 'MAX_[A-Z]' OR label IN ('ENT','AWS_DEV','LOCAL'))";
const ACCOUNT_LABEL_FORM =
  "(account_label GLOB 'MAX_[A-Z]' OR account_label IN ('ENT','AWS_DEV','LOCAL'))";

export const MIGRATION_0005_ACCOUNT_REGISTRY: Migration = {
  id: 5,
  name: 'account-registry-open-form',
  up: `
PRAGMA defer_foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- account_profiles — relax label CHECK + pairing; preserve the 5 seed rows.
-- (No inbound FK: resume_ledger.account_label is a plain CHECK, not an FK.)
-- ---------------------------------------------------------------------------
CREATE TABLE account_profiles_new (
  label          TEXT PRIMARY KEY
                 CHECK ${LABEL_FORM},
  backend        TEXT NOT NULL
                 CHECK (backend IN ('claude_code','opencode','lmstudio')),
  config_dir     TEXT,
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  CHECK (
    ((label GLOB 'MAX_[A-Z]' OR label = 'ENT') AND backend = 'claude_code')
    OR (label = 'AWS_DEV' AND backend = 'opencode')
    OR (label = 'LOCAL'   AND backend = 'lmstudio')
  )
) STRICT;
INSERT INTO account_profiles_new SELECT label, backend, config_dir, created_at_iso, updated_at_iso FROM account_profiles;
DROP TABLE account_profiles;
ALTER TABLE account_profiles_new RENAME TO account_profiles;

-- ---------------------------------------------------------------------------
-- resume_ledger — relax account_label CHECK + pairing (no inbound FK).
-- ---------------------------------------------------------------------------
CREATE TABLE resume_ledger_new (
  id                TEXT PRIMARY KEY CHECK (length(id) > 0),
  account_label     TEXT NOT NULL
                    CHECK ${ACCOUNT_LABEL_FORM},
  backend           TEXT NOT NULL
                    CHECK (backend IN ('claude_code','opencode','lmstudio')),
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
    ((account_label GLOB 'MAX_[A-Z]' OR account_label = 'ENT') AND backend = 'claude_code')
    OR (account_label = 'AWS_DEV' AND backend = 'opencode')
    OR (account_label = 'LOCAL'   AND backend = 'lmstudio')
  ),
  CHECK (substrate != 'pty' OR backend = 'claude_code')
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
-- session_node — inbound FK from session_edge(from_node,to_node). Rename OLD
-- aside (session_edge's FK auto-rewrites to session_node_old), build NEW under
-- the real name, copy, rebuild session_edge to re-point at session_node, drop
-- the temp. defer_foreign_keys makes the intermediate dangle legal until COMMIT.
-- ---------------------------------------------------------------------------
ALTER TABLE session_node RENAME TO session_node_old;
-- The rename carries session_node's indexes along under their original (global)
-- names; drop them so the rebuilt table can reclaim those names.
DROP INDEX session_node_workstream_idx;
DROP INDEX session_node_native_idx;
DROP INDEX session_node_state_idx;
CREATE TABLE session_node (
  id                 TEXT PRIMARY KEY CHECK (length(id) > 0),
  workstream_id      TEXT REFERENCES workstream(id),
  backend            TEXT NOT NULL CHECK (backend IN ('claude_code','opencode','lmstudio')),
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
    ((account GLOB 'MAX_[A-Z]' OR account = 'ENT') AND backend = 'claude_code')
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

-- Rebuild session_edge so its FKs point at the NEW session_node (they currently
-- reference session_node_old after the rename). CHECK set is unchanged.
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

-- ---------------------------------------------------------------------------
-- step_attempt — nullable account CHECK relaxed to the open form (no inbound FK;
-- outbound FK to pipeline_run(id) preserved).
-- ---------------------------------------------------------------------------
CREATE TABLE step_attempt_new (
  id                 TEXT PRIMARY KEY CHECK (length(id) > 0),
  run_id             TEXT NOT NULL REFERENCES pipeline_run(id),
  step_id            TEXT NOT NULL CHECK (length(step_id) > 0),
  iteration          INTEGER NOT NULL DEFAULT 0 CHECK (iteration >= 0),
  attempt            INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  input_hash         TEXT NOT NULL CHECK (length(input_hash) > 0),
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','blocked','running','awaiting-approval',
                                       'completed','memoized','failed','skipped','cancelled')),
  session_id         TEXT,
  account            TEXT CHECK (account IS NULL OR ${ACCOUNT_FORM}),
  output_json        TEXT,
  cost_estimated_usd REAL CHECK (cost_estimated_usd IS NULL OR cost_estimated_usd >= 0),
  tokens_in          INTEGER CHECK (tokens_in IS NULL OR tokens_in >= 0),
  tokens_out         INTEGER CHECK (tokens_out IS NULL OR tokens_out >= 0),
  error_kind         TEXT,
  started_at_ms      INTEGER CHECK (started_at_ms IS NULL OR started_at_ms >= 0),
  finished_at_ms     INTEGER CHECK (finished_at_ms IS NULL OR finished_at_ms >= 0),
  created_at_ms      INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT;
INSERT INTO step_attempt_new
  SELECT id, run_id, step_id, iteration, attempt, input_hash, status, session_id,
         account, output_json, cost_estimated_usd, tokens_in, tokens_out, error_kind,
         started_at_ms, finished_at_ms, created_at_ms
  FROM step_attempt;
DROP TABLE step_attempt;
ALTER TABLE step_attempt_new RENAME TO step_attempt;
CREATE UNIQUE INDEX step_attempt_identity_idx
  ON step_attempt (run_id, step_id, iteration, attempt);
CREATE INDEX step_attempt_memo_idx
  ON step_attempt (run_id, step_id, iteration, input_hash);
CREATE INDEX step_attempt_run_idx     ON step_attempt (run_id);
CREATE INDEX step_attempt_session_idx ON step_attempt (session_id)
  WHERE session_id IS NOT NULL;

-- Reflect the widened contract in schema metadata.
UPDATE schema_meta SET value = '5' WHERE key = 'ddl_version';
INSERT INTO schema_meta (key, value) VALUES ('frozen_milestone', 'M7')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
`,
};
