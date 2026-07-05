/**
 * Migration 0008 — backend-registry generalization for the EVENTS-store DB
 * ([X1] scalability, finding OS-1, ICR-0016). The kernel-DB half is migration
 * 0007; this is its sibling on the separate events database
 * (EVENTS_STORE_MIGRATIONS).
 *
 * Relaxes the `backend` + `source` CHECKs and the label↔backend PAIRING CHECK on
 * the `events` fact table from the CLOSED literal sets to the OPEN app-layer
 * gate, matching migration 0007's decision (sqlite-ddl.md §11):
 *
 *   backend → length(backend) > 0                -- open; accessor isBackend()
 *   source  → length(source)  > 0                -- open; accessor isEventSource()
 *   pairing → the built-in triples hold for the built-in backends, OR the
 *             backend is NOT a built-in (a registered backend; the accessor's
 *             backendForLabel() pairing gate is authoritative)
 *
 * A fourth backend declares its own events `source` in its descriptor
 * (BackendDescriptor.sourceName); the accessor's `isEventSource` remains the
 * gate for the built-in source vocabulary and admits a descriptor's source. The
 * account CHECK is relaxed the same way as migration 0007 — the built-in open
 * MAX_<X> form (from 0006) OR a non-empty account paired with a NON-built-in
 * backend (a registered backend serving its own account-label form) — so a 4th
 * backend's events land with no schema change. quota_snapshots / session_outcomes
 * carry NO backend or source column, so they are NOT rebuilt here (0006 already
 * relaxed their account CHECK, and a registered backend feeds only the `events`
 * table; a quota/outcome row for a non-built-in account label would need its own
 * ICR, out of OS-1 scope).
 *
 *   - events  (backend CHECK + source CHECK + pairing relaxed; account CHECK kept)
 *
 * No inbound foreign key on `events`, so this is a straight
 * create-new / copy / drop / rename rebuild (SQLite cannot ALTER a CHECK).
 *
 * ============================================================================
 * FROZEN-M8 (2026-07-05) via ICR-0016. Amendments only via ICR. Frozen
 * migrations 0002/0006 stay byte-identical; changes ride 0008. Prose of
 * record: docs/contracts/sqlite-ddl.md §11.
 * ============================================================================
 */

import type { Migration } from '../index.js';

export const MIGRATION_0008_BACKEND_REGISTRY_EVENTS: Migration = {
  id: 8,
  name: 'backend-registry-open-set-events',
  up: `
-- ---------------------------------------------------------------------------
-- events — relax backend + source CHECKs and the pairing to the open form;
-- preserve the account CHECK (open MAX_<X> form from 0006) verbatim.
-- ---------------------------------------------------------------------------
CREATE TABLE events_new (
  id                       INTEGER PRIMARY KEY,
  ts_ms                    INTEGER NOT NULL CHECK (ts_ms >= 0),
  backend                  TEXT NOT NULL
                           CHECK (length(backend) > 0),
  account                  TEXT NOT NULL
                           CHECK ((account GLOB 'MAX_[A-Z]' OR account IN ('ENT','AWS_DEV','LOCAL'))
                                  OR (length(account) > 0 AND backend NOT IN ('claude_code','opencode','lmstudio'))),
  source                   TEXT NOT NULL
                           CHECK (length(source) > 0),
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
    backend NOT IN ('claude_code','opencode','lmstudio')
    OR ((account GLOB 'MAX_[A-Z]' OR account = 'ENT') AND backend = 'claude_code')
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

-- Reflect the widened contract in events-store metadata.
UPDATE schema_meta SET value = '3' WHERE key = 'events_ddl_version';
INSERT INTO schema_meta (key, value) VALUES ('frozen_milestone', 'M8')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
`,
};
