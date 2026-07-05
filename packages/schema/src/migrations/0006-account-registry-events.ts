/**
 * Migration 0006 — account-registry generalization for the EVENTS-store DB
 * ([X1] scalability, ICR-0013). The kernel-DB half is migration 0005; this is
 * its sibling on the separate events database (EVENTS_STORE_MIGRATIONS).
 *
 * Relaxes the account-label CHECK on the three account-pinned events-store
 * tables from the CLOSED 5-literal set to the OPEN validated FORM (same rule as
 * 0005): `account GLOB 'MAX_[A-Z]' OR account IN ('ENT','AWS_DEV','LOCAL')`.
 * The label↔backend PAIRING CHECK (events table only) is preserved verbatim.
 * None of these tables has an inbound foreign key, so each is a straight
 * create-new / copy / drop / rename rebuild (SQLite cannot ALTER a CHECK).
 *
 *   - events            (pairing CHECK preserved)
 *   - quota_snapshots   (account CHECK only; no backend column)
 *   - session_outcomes  (account CHECK only; no backend column)
 *
 * ============================================================================
 * FROZEN-M7 (2026-07-05) via ICR-0013. Amendments only via ICR. Prose of
 * record: docs/contracts/sqlite-ddl.md.
 * ============================================================================
 */

import type { Migration } from '../index.js';

export const MIGRATION_0006_ACCOUNT_REGISTRY_EVENTS: Migration = {
  id: 6,
  name: 'account-registry-open-form-events',
  up: `
-- ---------------------------------------------------------------------------
-- events — relax account CHECK + preserve the label↔backend pairing verbatim.
-- ---------------------------------------------------------------------------
CREATE TABLE events_new (
  id                       INTEGER PRIMARY KEY,
  ts_ms                    INTEGER NOT NULL CHECK (ts_ms >= 0),
  backend                  TEXT NOT NULL
                           CHECK (backend IN ('claude_code','opencode','lmstudio')),
  account                  TEXT NOT NULL
                           CHECK (account GLOB 'MAX_[A-Z]' OR account IN ('ENT','AWS_DEV','LOCAL')),
  source                   TEXT NOT NULL
                           CHECK (source IN ('claude-jsonl','claude-otel','claude-quota','hooks',
                                             'opencode-sse','opencode-db','bedrock-cost-explorer',
                                             'bedrock-cloudwatch','lmstudio','ent-analytics')),
  event_type               TEXT NOT NULL CHECK (length(event_type) > 0),
  session_id               TEXT,
  native_session_id        TEXT,
  workstream_id            TEXT,
  prompt_id                TEXT,
  model                    TEXT,
  provider                 TEXT,
  input_tokens             INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens            INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cache_read_tokens        INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_creation_tokens    INTEGER CHECK (cache_creation_tokens IS NULL OR cache_creation_tokens >= 0),
  cache_creation_5m_tokens INTEGER CHECK (cache_creation_5m_tokens IS NULL OR cache_creation_5m_tokens >= 0),
  cache_creation_1h_tokens INTEGER CHECK (cache_creation_1h_tokens IS NULL OR cache_creation_1h_tokens >= 0),
  reasoning_tokens         INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  cost_estimated_usd       REAL CHECK (cost_estimated_usd IS NULL OR cost_estimated_usd >= 0),
  cost_actual_usd          REAL CHECK (cost_actual_usd IS NULL OR cost_actual_usd >= 0),
  latency_ms               INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  ttft_ms                  INTEGER CHECK (ttft_ms IS NULL OR ttft_ms >= 0),
  tool_name                TEXT,
  skill_name               TEXT,
  agent_name               TEXT,
  mcp_server               TEXT,
  ok                       INTEGER CHECK (ok IS NULL OR ok IN (0, 1)),
  error_kind               TEXT CHECK (error_kind IS NULL
                                       OR error_kind IN ('error','retry','throttle','timeout')),
  file_refs                TEXT,
  raw_ref                  TEXT NOT NULL CHECK (length(raw_ref) > 0),
  ingested_at_iso          TEXT NOT NULL,
  CHECK (
    ((account GLOB 'MAX_[A-Z]' OR account = 'ENT') AND backend = 'claude_code')
    OR (account = 'AWS_DEV' AND backend = 'opencode')
    OR (account = 'LOCAL'   AND backend = 'lmstudio')
  )
) STRICT;
INSERT INTO events_new
  SELECT id, ts_ms, backend, account, source, event_type, session_id, native_session_id,
         workstream_id, prompt_id, model, provider, input_tokens, output_tokens,
         cache_read_tokens, cache_creation_tokens, cache_creation_5m_tokens,
         cache_creation_1h_tokens, reasoning_tokens, cost_estimated_usd, cost_actual_usd,
         latency_ms, ttft_ms, tool_name, skill_name, agent_name, mcp_server, ok, error_kind,
         file_refs, raw_ref, ingested_at_iso
  FROM events;
DROP TABLE events;
ALTER TABLE events_new RENAME TO events;
CREATE UNIQUE INDEX events_dedupe_idx         ON events (backend, raw_ref);
CREATE INDEX        events_ts_idx             ON events (ts_ms);
CREATE INDEX        events_account_ts_idx     ON events (account, ts_ms);
CREATE INDEX        events_type_idx           ON events (event_type);
CREATE INDEX        events_session_idx        ON events (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX        events_native_session_idx ON events (native_session_id) WHERE native_session_id IS NOT NULL;
CREATE INDEX        events_skill_idx          ON events (skill_name) WHERE skill_name IS NOT NULL;

-- ---------------------------------------------------------------------------
-- quota_snapshots — relax account CHECK (no backend / pairing on this table).
-- ---------------------------------------------------------------------------
CREATE TABLE quota_snapshots_new (
  id              INTEGER PRIMARY KEY,
  account         TEXT NOT NULL
                  CHECK (account GLOB 'MAX_[A-Z]' OR account IN ('ENT','AWS_DEV','LOCAL')),
  window          TEXT NOT NULL CHECK (window IN ('5h','7d','7d_sonnet')),
  used_pct        REAL NOT NULL CHECK (used_pct >= 0 AND used_pct <= 100),
  resets_at_ms    INTEGER NOT NULL CHECK (resets_at_ms >= 0),
  captured_at_ms  INTEGER NOT NULL CHECK (captured_at_ms >= 0),
  source          TEXT NOT NULL CHECK (source IN ('statusline','oauth-poll')),
  ingested_at_iso TEXT NOT NULL
) STRICT;
INSERT INTO quota_snapshots_new
  SELECT id, account, window, used_pct, resets_at_ms, captured_at_ms, source, ingested_at_iso
  FROM quota_snapshots;
DROP TABLE quota_snapshots;
ALTER TABLE quota_snapshots_new RENAME TO quota_snapshots;
CREATE UNIQUE INDEX quota_snapshots_dedupe_idx
  ON quota_snapshots (account, window, captured_at_ms, source);
CREATE INDEX quota_snapshots_latest_idx
  ON quota_snapshots (account, window, captured_at_ms);

-- ---------------------------------------------------------------------------
-- session_outcomes — relax account CHECK (no backend / pairing on this table).
-- ---------------------------------------------------------------------------
CREATE TABLE session_outcomes_new (
  id                INTEGER PRIMARY KEY,
  account           TEXT NOT NULL
                    CHECK (account GLOB 'MAX_[A-Z]' OR account IN ('ENT','AWS_DEV','LOCAL')),
  native_session_id TEXT NOT NULL CHECK (length(native_session_id) > 0),
  outcome           TEXT NOT NULL CHECK (length(outcome) > 0),
  friction          TEXT,
  facets_json       TEXT,
  captured_at_ms    INTEGER NOT NULL CHECK (captured_at_ms >= 0),
  raw_ref           TEXT NOT NULL CHECK (length(raw_ref) > 0),
  ingested_at_iso   TEXT NOT NULL
) STRICT;
INSERT INTO session_outcomes_new
  SELECT id, account, native_session_id, outcome, friction, facets_json, captured_at_ms, raw_ref, ingested_at_iso
  FROM session_outcomes;
DROP TABLE session_outcomes;
ALTER TABLE session_outcomes_new RENAME TO session_outcomes;
CREATE UNIQUE INDEX session_outcomes_dedupe_idx ON session_outcomes (account, raw_ref);
CREATE INDEX        session_outcomes_session_idx ON session_outcomes (native_session_id);

-- Reflect the widened contract in events-store metadata.
UPDATE schema_meta SET value = '2' WHERE key = 'events_ddl_version';
INSERT INTO schema_meta (key, value) VALUES ('frozen_milestone', 'M7')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
`,
};
