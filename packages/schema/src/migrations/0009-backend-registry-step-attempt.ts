/**
 * Migration 0009 — backend-registry generalization for the step_attempt JOURNAL
 * ([X1] scalability, finding OS-1, ICR-0016 amendment). The kernel-DB backend
 * relaxation shipped in 0007, the events-store half in 0008. This migration
 * closes the ONE table 0007 explicitly skipped: `step_attempt`.
 *
 * WHY 0007 SKIPPED IT, AND WHY THAT WAS A GAP: migration 0007's charter was the
 * `backend`-carrying kernel tables (account_profiles / resume_ledger /
 * session_node), and its comment reasoned "step_attempt has no backend column"
 * so it left step_attempt untouched. But step_attempt DOES carry an `account`
 * column, and its CHECK — introduced by 0004, rebuilt by 0005 to the open M7
 * form `account IS NULL OR (account GLOB 'MAX_[A-Z]' OR account IN
 * ('ENT','AWS_DEV','LOCAL'))` — still admits ONLY the built-in account-label
 * forms. A backend registered via `registerBackend` (ICR-0016) serves its OWN
 * account-label form (e.g. `SYNTH_L`), which the built-in regex cannot express.
 * So a full pipeline RUN on a 4th-backend account was refused at the FIRST
 * journal write (`step_attempt.record`) with `CHECK constraint failed: account
 * IS NULL ...`, even though the runner's resolveBackend already routed the label
 * through the registry with no core branch and the lineage/events stores (0007/
 * 0008) already accept the label. The OS-1 goal — a 4th backend lands with NO
 * schema change — was therefore unreachable while step_attempt stayed pinned.
 *
 * WHAT CHANGES: rebuild `step_attempt` with its `account` CHECK relaxed exactly
 * the way events.account was relaxed in 0008 — the built-in open M7 form OR a
 * non-empty label outside that form (a registered backend's own label, gated at
 * the app layer by the registry-aware `isAccountLabel()` in the accessor's
 * `record`/`complete` paths):
 *
 *     account IS NULL
 *       OR (account GLOB 'MAX_[A-Z]' OR account IN ('ENT','AWS_DEV','LOCAL'))
 *       OR (length(account) > 0
 *           AND account NOT GLOB 'MAX_[A-Z]'
 *           AND account NOT IN ('ENT','AWS_DEV','LOCAL'))
 *
 * The M7 form is a strict SUBSET of what this admits, so every M1–M8 row still
 * validates (byte-identical acceptance for the built-in labels + NULL). The
 * third clause is what newly admits a registered backend's label. Note there is
 * NO backend column on this table, so — unlike 0007/0008 — the relaxation cannot
 * be gated on `backend NOT IN (built-ins)`; it is keyed purely on the LABEL FORM.
 * The DB retains the NULL + built-in-form clauses as defense-in-depth (a
 * bypassing writer still cannot land an EMPTY account), and the registry
 * VALUE-set gate for a non-built-in label is the app layer's authoritative
 * screen (`isAccountLabel()` consults the registry at `step_attempt.record`),
 * mirroring the sqlite-ddl.md §11 open-vocabulary decision that governs 0007/
 * 0008.
 *
 * TABLE REBUILT (SQLite cannot ALTER a CHECK): step_attempt only. It has NO
 * inbound foreign key (its one outbound FK to pipeline_run(id) is preserved), so
 * this is the straight create-new / copy / drop / rename recipe — the same shape
 * 0005 used for step_attempt, with only the account CHECK widened. All indexes
 * are re-created verbatim.
 *
 * ============================================================================
 * FROZEN-M8 (2026-07-05) via ICR-0016 (step_attempt amendment). Amendments only
 * via ICR. Frozen migrations 0001–0008 stay byte-identical; this change rides
 * 0009. Prose of record: docs/contracts/sqlite-ddl.md §11 (step_attempt row of
 * the backend-CHECK-derivation amendment).
 * ============================================================================
 */

import type { Migration } from '../index.js';

/**
 * The relaxed nullable-account CHECK for step_attempt: the built-in open M7 form
 * (from 0005) stays enforced, OR a non-empty label OUTSIDE the built-in forms (a
 * registered 4th backend's own label — app-layer `isAccountLabel()` is
 * authoritative for it). Keyed on the LABEL FORM, not a backend column (there is
 * none on this table).
 */
const ACCOUNT_FORM =
  "(account IS NULL " +
  "OR (account GLOB 'MAX_[A-Z]' OR account IN ('ENT','AWS_DEV','LOCAL')) " +
  "OR (length(account) > 0 " +
  "AND account NOT GLOB 'MAX_[A-Z]' " +
  "AND account NOT IN ('ENT','AWS_DEV','LOCAL')))";

export const MIGRATION_0009_BACKEND_REGISTRY_STEP_ATTEMPT: Migration = {
  id: 9,
  name: 'backend-registry-open-set-step-attempt',
  up: `
-- ---------------------------------------------------------------------------
-- step_attempt — relax the nullable account CHECK to the open form so a
-- registered 4th backend's own account label (e.g. SYNTH_L) is admitted at the
-- journal write. Every other column + CHECK + index is preserved verbatim from
-- the migration-0005 rebuild. No inbound FK; the outbound FK to pipeline_run(id)
-- is preserved.
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
  account            TEXT CHECK ${ACCOUNT_FORM},
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
UPDATE schema_meta SET value = '9' WHERE key = 'ddl_version';
INSERT INTO schema_meta (key, value) VALUES ('frozen_milestone', 'M8')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
`,
};
