/**
 * Migration 0001 — M1 kernel tables (blueprint §4.1, plan §3 "M1 kernel").
 *
 * Tables:
 *   schema_meta      key/value store metadata (ddl version, freeze milestone)
 *   account_profiles the five placeholder labels + machine-local config-dir
 *                    slot (NO real paths committed — provisioning fills it,
 *                    the column is `identifier`-tagged for redaction) [X2]
 *   resume_ledger    row-before-spawn discipline, exactly the blueprint §4.1
 *                    fields plus the SPIKE-D finding-2 columns (pid of the
 *                    ACTUAL session process + argv spawn nonce for the
 *                    pid-reuse orphan guard — docs/spikes/spike-d-pty-supervision.md)
 *
 * The label/backend pairing and pty-is-claude-only rules are enforced here as
 * CHECK constraints so even a buggy accessor cannot write an illegal row.
 * State-machine transition legality is enforced by the accessor layer
 * (kernel.ts) — SQL CHECKs cannot see the previous state.
 *
 * ============================================================================
 * FROZEN-M1 (2026-07-04). Amendments only via ICR (docs/contracts/icr/).
 * Prose of record: docs/contracts/sqlite-ddl.md.
 * ============================================================================
 */

import type { Migration } from '../index.js';

import { MIGRATION_0003_LINEAGE } from './0003-lineage.js';

export const MIGRATION_0001_KERNEL: Migration = {
  id: 1,
  name: 'kernel-tables-init',
  up: `
CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY CHECK (length(trim(key)) > 0),
  value TEXT NOT NULL
) STRICT;

INSERT INTO schema_meta (key, value) VALUES
  ('ddl_version', '1'),
  ('frozen_milestone', 'M1');

CREATE TABLE account_profiles (
  label          TEXT PRIMARY KEY
                 CHECK (label IN ('MAX_A','MAX_B','ENT','AWS_DEV','LOCAL')),
  backend        TEXT NOT NULL
                 CHECK (backend IN ('claude_code','opencode','lmstudio')),
  -- Machine-local absolute CLAUDE_CONFIG_DIR (== securestorage dir, pinned).
  -- NULL until provisioning (SI-2) fills it at runtime. NEVER committed [X2].
  config_dir     TEXT,
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  CHECK (
    (label IN ('MAX_A','MAX_B','ENT') AND backend = 'claude_code')
    OR (label = 'AWS_DEV' AND backend = 'opencode')
    OR (label = 'LOCAL'   AND backend = 'lmstudio')
  )
) STRICT;

INSERT INTO account_profiles (label, backend, config_dir, created_at_iso, updated_at_iso) VALUES
  ('MAX_A',   'claude_code', NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('MAX_B',   'claude_code', NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ENT',     'claude_code', NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('AWS_DEV', 'opencode',    NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('LOCAL',   'lmstudio',    NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TABLE resume_ledger (
  -- Harness session id (never a native id) — @aibender/shared newId('ses').
  id                TEXT PRIMARY KEY CHECK (length(id) > 0),
  account_label     TEXT NOT NULL
                    CHECK (account_label IN ('MAX_A','MAX_B','ENT','AWS_DEV','LOCAL')),
  backend           TEXT NOT NULL
                    CHECK (backend IN ('claude_code','opencode','lmstudio')),
  cwd               TEXT NOT NULL CHECK (length(cwd) > 0),
  substrate         TEXT NOT NULL CHECK (substrate IN ('sdk','pty')),
  purpose           TEXT NOT NULL CHECK (length(purpose) > 0),
  workstream_hint   TEXT,
  -- Native session id, NULL at insert, backfilled from the init message.
  native_session_id TEXT,
  -- SPIKE-D state machine; transition legality enforced in kernel.ts.
  state             TEXT NOT NULL
                    CHECK (state IN ('spawning','running','resumed','orphan_detected','orphan_killed','exited')),
  -- SPIKE-D finding 2: pid of the ACTUAL session process (never a launcher
  -- shim), backfilled after spawn; orphan reaping targets the process GROUP.
  pid               INTEGER CHECK (pid IS NULL OR pid > 0),
  -- SPIKE-D argv-nonce identity check (pid-reuse guard on restart).
  spawn_nonce       TEXT,
  created_at_iso    TEXT NOT NULL,
  updated_at_iso    TEXT NOT NULL,
  CHECK (
    (account_label IN ('MAX_A','MAX_B','ENT') AND backend = 'claude_code')
    OR (account_label = 'AWS_DEV' AND backend = 'opencode')
    OR (account_label = 'LOCAL'   AND backend = 'lmstudio')
  ),
  CHECK (substrate != 'pty' OR backend = 'claude_code')
) STRICT;

CREATE INDEX resume_ledger_state_idx ON resume_ledger (state);
CREATE INDEX resume_ledger_account_idx ON resume_ledger (account_label);
CREATE INDEX resume_ledger_native_idx ON resume_ledger (native_session_id)
  WHERE native_session_id IS NOT NULL;
`,
};

/**
 * The full ordered migration list for the kernel database. Appended per
 * milestone (never reorder, never edit a frozen migration): 0001 = M1 kernel
 * tables; 0003 = the M4 [X4] lineage tables (0002 is the events store on the
 * SEPARATE collector database — EVENTS_STORE_MIGRATIONS; ids stay repo-wide
 * unique). M5 pipeline tables append here via ICR.
 */
export const KERNEL_MIGRATIONS: readonly Migration[] = Object.freeze([
  MIGRATION_0001_KERNEL,
  MIGRATION_0003_LINEAGE,
]);
