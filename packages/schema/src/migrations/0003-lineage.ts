/**
 * Migration 0003 — the M4 [X4] workstream lineage ledger (blueprint §5, plan
 * §3 "M4 (X4)", plan §4/BE-7; findings x4-workstreams Option B).
 *
 * KERNEL DATABASE (BE-ORCH decision at the M4 freeze, recorded in
 * docs/contracts/sqlite-ddl.md §8.1): this migration APPENDS to
 * {@link KERNEL_MIGRATIONS} — the lineage tables live in the KERNEL ledger
 * (`~/.aibender/db/kernel.db`), NOT in the collector's events database.
 * Rationale: edges are recorded AT ACTION TIME by the same kernel code path
 * that writes resume-ledger rows (row-before-spawn → node; resume/fork/
 * recycle/merge → edge) — same database means one WAL commit boundary and
 * real FOREIGN KEYs between edges, nodes, and briefs; lineage writes are
 * per-ACTION (resume-ledger rate), never the collector's high-volume ingest
 * that forced events.db out (sqlite-ddl.md §7.1); and the frozen
 * SessionIdResolver seam (native → harness mapping) reads resume_ledger and
 * session_node together — one database, one query plan. Migration ids stay
 * REPO-WIDE unique (0001 = kernel, 0002 = events, 0003 = lineage/kernel).
 *
 * Tables (exactly the blueprint §5 set):
 *   workstream    named lineage subgraphs (status enum, JSON tags)
 *   session_node  one session per row — HARNESS id PRIMARY (the resume-ledger
 *                 id for kernel-launched sessions; reconciler-minted for
 *                 external ones); the native id is a NULLABLE ATTRIBUTE
 *   brief         continuation/merge context artifacts (kind + provenance)
 *   session_edge  typed lineage edges — continue|fork|merge_parent|compact|
 *                 sidechain|handoff|import|workflow; a continuation is a
 *                 CHILD via `continue` (never a sibling); merge = one new
 *                 node with N `merge_parent` edges
 *
 * [X2] — labels only: `account` is the placeholder enum, CHECK-enforced with
 * the label↔backend pairing. Paths (cwd/native_scope/transcript_ref/
 * worktree) and brief bodies are machine-local and `identifier`-tagged for
 * redaction (LINEAGE_FIELD_TAGS); free-text naming columns pass the
 * insert-time identity screen (lineage.ts).
 *
 * Timestamps: lineage times are ACTION/EVENT times rendered on the FE
 * timeline, so they are epoch-ms INTEGERs (`*_ms`) matching the frozen wire
 * convention (the migration-0002 precedent); the migration-0001 ISO pin
 * remains scoped to the M1 kernel tables.
 *
 * ============================================================================
 * FROZEN-M4 (2026-07-04). Amendments only via ICR (docs/contracts/icr/).
 * Prose of record: docs/contracts/sqlite-ddl.md.
 * ============================================================================
 */

import type { Migration } from '../index.js';

export const MIGRATION_0003_LINEAGE: Migration = {
  id: 3,
  name: 'lineage-tables-init',
  up: `
-- The kernel db's schema_meta exists since 0001; record the lineage slice
-- WITHOUT touching the M1 seeds (frozen_milestone stays 'M1' by design —
-- each slice gets its own keys, the events-db precedent).
INSERT INTO schema_meta (key, value) VALUES
  ('lineage_ddl_version', '1'),
  ('lineage_frozen_milestone', 'M4');

CREATE TABLE workstream (
  id             TEXT PRIMARY KEY CHECK (length(id) > 0),        -- harness id, newId('ws')
  title          TEXT NOT NULL CHECK (length(trim(title)) > 0),  -- identifier-free [X2]
  description    TEXT,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','paused','merged','archived','abandoned')),
  tags           TEXT,                                           -- JSON array of tag strings
  created_at_ms  INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms  INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

CREATE TABLE session_node (
  -- HARNESS session id, PRIMARY (never a native id): the resume-ledger id
  -- for kernel-launched sessions; reconciler-minted (same charset) for
  -- external sessions. Deliberately NOT a foreign key into resume_ledger —
  -- reconciled nodes have no ledger row (blueprint §5 origin=reconciled).
  id                 TEXT PRIMARY KEY CHECK (length(id) > 0),
  workstream_id      TEXT REFERENCES workstream(id),             -- NULL = detached-HEAD bucket
  backend            TEXT NOT NULL CHECK (backend IN ('claude_code','opencode','lmstudio')),
  account            TEXT NOT NULL
                     CHECK (account IN ('MAX_A','MAX_B','ENT','AWS_DEV','LOCAL')),
  -- The native id is an ATTRIBUTE: nullable (lmstudio sessions are
  -- harness-native; kernel launches backfill it late), never the key.
  native_session_id  TEXT,
  -- encoded-cwd / opencode project id — MUTABLE (/cd moves it, blueprint §5).
  native_scope       TEXT,
  transcript_ref     TEXT,                                       -- path or db locator, best-effort
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
    (account IN ('MAX_A','MAX_B','ENT') AND backend = 'claude_code')
    OR (account = 'AWS_DEV' AND backend = 'opencode')
    OR (account = 'LOCAL'   AND backend = 'lmstudio')
  )
) STRICT;

CREATE INDEX session_node_workstream_idx ON session_node (workstream_id)
  WHERE workstream_id IS NOT NULL;
CREATE INDEX session_node_native_idx     ON session_node (native_session_id)
  WHERE native_session_id IS NOT NULL;
CREATE INDEX session_node_state_idx      ON session_node (state);

CREATE TABLE brief (
  id             TEXT PRIMARY KEY CHECK (length(id) > 0),        -- harness id, newId('br')
  -- Named by the automation moment (hooks-contract.md [X4] rows):
  kind           TEXT NOT NULL
                 CHECK (kind IN ('session-end','pre-compact','session-start-injection','merge')),
  body_md        TEXT NOT NULL CHECK (length(body_md) > 0),      -- paths+ids+labels only [X2]
  source_nodes   TEXT NOT NULL CHECK (length(source_nodes) > 0), -- JSON array of session_node ids
  -- The qwen-produces / Claude-reviews split (blueprint §5 merge semantics):
  provenance     TEXT NOT NULL
                 CHECK (provenance IN ('native-summary','local-draft','refined')),
  token_count    INTEGER CHECK (token_count IS NULL OR token_count >= 0),
  created_at_ms  INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT;

CREATE TABLE session_edge (
  id             TEXT PRIMARY KEY CHECK (length(id) > 0),        -- harness id, newId('edg')
  from_node      TEXT REFERENCES session_node(id),
  to_node        TEXT NOT NULL REFERENCES session_node(id),
  edge_type      TEXT NOT NULL
                 CHECK (edge_type IN ('continue','fork','merge_parent','compact',
                                      'sidechain','handoff','import','workflow')),
  brief_id       TEXT REFERENCES brief(id),
  confidence     TEXT NOT NULL DEFAULT 'recorded'
                 CHECK (confidence IN ('recorded','inferred')),
  metadata       TEXT,                                           -- JSON (compactMetadata, checkpoint ref, …)
  created_at_ms  INTEGER NOT NULL CHECK (created_at_ms >= 0),
  -- from_node is NULL ONLY for imports (no in-graph parent) …
  CHECK (edge_type = 'import' OR from_node IS NOT NULL),
  -- … and imports never carry one.
  CHECK (edge_type != 'import' OR from_node IS NULL),
  -- Handoff briefs are MANDATORY: context travels by brief (blueprint §5).
  CHECK (edge_type != 'handoff' OR brief_id IS NOT NULL)
) STRICT;

CREATE INDEX session_edge_from_idx ON session_edge (from_node) WHERE from_node IS NOT NULL;
CREATE INDEX session_edge_to_idx   ON session_edge (to_node);
CREATE INDEX session_edge_type_idx ON session_edge (edge_type);
`,
};
