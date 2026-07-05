/**
 * Migration 0004 — the M5 pipeline definitions store + the durable
 * MEMOIZATION JOURNAL (blueprint §7, plan §3 "M5 (pipelines)", plan §4/BE-8,
 * findings pipeline-workflow-builder §R3).
 *
 * KERNEL DATABASE (BE-ORCH decision at the M5 freeze, recorded in
 * docs/contracts/sqlite-ddl.md §10.1): this migration APPENDS to
 * {@link KERNEL_MIGRATIONS} — the pipeline tables live in the KERNEL ledger
 * (`~/.aibender/db/kernel.db`), NOT in the collector's events database. This
 * follows the M4 lineage precedent (§8.1) for the SAME three reasons:
 *
 *   1. SAME COMMIT BOUNDARY as the lineage rows the run produces. Findings §R3:
 *      "every step attempt = a `session_node`" and "a pipeline is a workstream
 *      subgraph". A step attempt writes both a `step_attempt` row (here) and a
 *      `session_node` + `workflow` `session_edge` (migration 0003, same db) —
 *      one WAL transaction scope, real FOREIGN-KEY-able co-location.
 *   2. WRITE RATE is the resume-ledger rate, NOT ingest rate. Journal writes
 *      happen per STEP ATTEMPT (a session action), never the collector's
 *      high-volume event ingest that forced events.db out (§7.1).
 *   3. RESUME is a single-database join. Cross-restart resume re-walks the DAG
 *      and reads `step_attempt` cached outputs + the `session_node` the attempt
 *      may `resume` in place (findings §R3) — both here, one query plan, no
 *      cross-file ATTACH.
 *
 * Migration ids stay REPO-WIDE unique: 0001 = kernel (M1), 0002 = events
 * (M3, sibling list), 0003 = lineage (M4, kernel), 0004 = pipelines (M5,
 * kernel). The kernel db's `schema_meta` gains pipeline keys; the M1/M4 seeds
 * are deliberately untouched (each slice gets its own keys — the events-db
 * precedent).
 *
 * Tables:
 *   pipeline_definition  the SAVED versioned JSON DAG document (dag-schema.md
 *                        v1): document JSON + schema_hash for drift detection
 *   pipeline_run         one run of a definition (findings §R3 `workflow_run`):
 *                        status + inputs + the pinned schema hash
 *   step_attempt         THE memoization journal (findings §R3 `step_attempt`):
 *                        (run_id, step_id, iteration, attempt) → cached output,
 *                        keyed for cross-restart resume by (run_id, step_id,
 *                        iteration, input_hash). A completed attempt's
 *                        output_json is returned WITHOUT re-execution on
 *                        resume — the M5 DoD "resumes from the memoization
 *                        journal without re-executing completed steps".
 *
 * [X2] — no identity-bearing columns: `account` is the placeholder enum,
 * CHECK-enforced with the label↔backend pairing; the DAG document JSON and
 * step output JSON are machine-local content (`identifier`-tagged for
 * redaction, PIPELINES_FIELD_TAGS) — the protocol DAG validator already
 * screens document naming fields for identity shapes at the wire, and the
 * accessor screens the stored definition name.
 *
 * Timestamps: run/attempt times are ACTION/EVENT times rendered on the FE run
 * monitor, so they are epoch-ms INTEGERs (`*_ms`) matching the frozen wire
 * convention (the migration 0002/0003 precedent).
 *
 * ============================================================================
 * FROZEN-M5 (2026-07-04). Amendments only via ICR (docs/contracts/icr/).
 * Prose of record: docs/contracts/sqlite-ddl.md.
 * ============================================================================
 */

import type { Migration } from '../index.js';

export const MIGRATION_0004_PIPELINES: Migration = {
  id: 4,
  name: 'pipeline-tables-init',
  up: `
-- The kernel db's schema_meta exists since 0001; record the pipeline slice
-- WITHOUT touching the M1/M4 seeds (each slice gets its own keys).
INSERT INTO schema_meta (key, value) VALUES
  ('pipeline_ddl_version', '1'),
  ('pipeline_frozen_milestone', 'M5');

CREATE TABLE pipeline_definition (
  id             TEXT PRIMARY KEY CHECK (length(id) > 0),         -- harness id, newId('wf')
  name           TEXT NOT NULL CHECK (length(trim(name)) > 0),    -- identifier-free [X2]
  -- The FULL versioned JSON DAG document (dag-schema.md v1). Stored verbatim
  -- so a rerun months later replays the exact document; the schema_version
  -- lives inside the JSON and is re-validated on load (forward-incompat rule).
  document_json  TEXT NOT NULL CHECK (length(document_json) > 0),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  -- sha256 of document_json — pinned into runs for drift detection.
  schema_hash    TEXT NOT NULL CHECK (length(schema_hash) > 0),
  created_at_ms  INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms  INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

CREATE TABLE pipeline_run (
  id                 TEXT PRIMARY KEY CHECK (length(id) > 0),     -- harness id, newId('run')
  pipeline_id        TEXT NOT NULL REFERENCES pipeline_definition(id),
  -- The document hash this run PINNED (findings §R3: pin sourcePath+contentHash
  -- so a resume detects drift). Equals the definition's hash at launch.
  schema_hash        TEXT NOT NULL CHECK (length(schema_hash) > 0),
  -- The run's bound inputs (JSON object; identifier-tagged).
  inputs_json        TEXT,
  -- Optional workstream assignment (X4 lineage — the run's subgraph).
  workstream_id      TEXT,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','running','paused','completed','failed','cancelled')),
  cost_estimated_usd REAL CHECK (cost_estimated_usd IS NULL OR cost_estimated_usd >= 0),
  started_at_ms      INTEGER CHECK (started_at_ms IS NULL OR started_at_ms >= 0),
  finished_at_ms     INTEGER CHECK (finished_at_ms IS NULL OR finished_at_ms >= 0),
  created_at_ms      INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms      INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

CREATE INDEX pipeline_run_pipeline_idx ON pipeline_run (pipeline_id);
CREATE INDEX pipeline_run_status_idx   ON pipeline_run (status);

CREATE TABLE step_attempt (
  id                 TEXT PRIMARY KEY CHECK (length(id) > 0),     -- harness id, newId('sa')
  run_id             TEXT NOT NULL REFERENCES pipeline_run(id),
  -- The DAG step id (dag-schema.md STEP_ID_RE); not an FK (steps live in the
  -- document JSON, not a table).
  step_id            TEXT NOT NULL CHECK (length(step_id) > 0),
  -- forEach/loop iteration (0 for a scalar step); retry attempt (0 = first).
  iteration          INTEGER NOT NULL DEFAULT 0 CHECK (iteration >= 0),
  attempt            INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  -- THE memoization key: sha256 of the step's resolved inputs. The resume
  -- walk returns a completed attempt's output for a matching (run_id, step_id,
  -- iteration, input_hash) WITHOUT re-executing (findings §R3, the M5 DoD).
  input_hash         TEXT NOT NULL CHECK (length(input_hash) > 0),
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','blocked','running','awaiting-approval',
                                       'completed','memoized','failed','skipped','cancelled')),
  -- The session_node the attempt spawned (harness id; the workflow edge
  -- target — migration 0003). NOT an FK: an attempt may fail before a node
  -- exists. lmstudio steps and gate steps may never spawn one.
  session_id         TEXT,
  account            TEXT CHECK (account IS NULL
                       OR account IN ('MAX_A','MAX_B','ENT','AWS_DEV','LOCAL')),
  -- The structured (outputSchema-validated) step result — templated into
  -- successors. Machine-local content (identifier-tagged for redaction).
  output_json        TEXT,
  cost_estimated_usd REAL CHECK (cost_estimated_usd IS NULL OR cost_estimated_usd >= 0),
  tokens_in          INTEGER CHECK (tokens_in IS NULL OR tokens_in >= 0),
  tokens_out         INTEGER CHECK (tokens_out IS NULL OR tokens_out >= 0),
  -- Identifier-free failure class [X2], when failed.
  error_kind         TEXT,
  started_at_ms      INTEGER CHECK (started_at_ms IS NULL OR started_at_ms >= 0),
  finished_at_ms     INTEGER CHECK (finished_at_ms IS NULL OR finished_at_ms >= 0),
  created_at_ms      INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT;

-- One attempt row per (run, step, iteration, attempt) — the append-only
-- journal identity. Retries append a NEW row (attempt+1), never overwrite.
CREATE UNIQUE INDEX step_attempt_identity_idx
  ON step_attempt (run_id, step_id, iteration, attempt);
-- THE resume lookup: a completed attempt for (run, step, iteration, input_hash)
-- returns its cached output without re-execution.
CREATE INDEX step_attempt_memo_idx
  ON step_attempt (run_id, step_id, iteration, input_hash);
CREATE INDEX step_attempt_run_idx     ON step_attempt (run_id);
CREATE INDEX step_attempt_session_idx ON step_attempt (session_id)
  WHERE session_id IS NOT NULL;
`,
};
