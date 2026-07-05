/**
 * Migration 0002 — M3 observability events store (blueprint §6.2, plan §3
 * "M3 (events)", plan §4/BE-5).
 *
 * SEPARATE DATABASE FILE (BE-ORCH decision at the M3 freeze, recorded in
 * docs/contracts/sqlite-ddl.md): this migration belongs to
 * {@link EVENTS_STORE_MIGRATIONS} — the sibling list the sqlite-ddl contract
 * §6 reserved — applied to the COLLECTOR-OWNED database
 * (`~/.aibender/db/events.db`), not to the kernel ledger. Blueprint §6.2:
 * "One SQLite (WAL) database owned by the collector"; high-volume collector
 * writes must never contend with the kernel's latency-critical
 * row-before-spawn inserts. Migration ids stay REPO-WIDE unique (0001 =
 * kernel, 0002 = events) so a migration number always names one DDL change.
 *
 * Tables (exactly the blueprint §6.2 set):
 *   events            the normalized fact table; dedupe key (backend, raw_ref)
 *   quota_snapshots   statusline tee / oauth-poll rows (mirrors the frozen
 *                     wire QuotaSnapshot, ws-protocol.md §11)
 *   session_outcomes  insights facets + session-meta (leaderboard/outcome-mix
 *                     inputs)
 *   prices            LiteLLM-seeded, PINNED, overridable (the ccusage lesson)
 *
 * [X2] — NO identity-bearing columns anywhere: `account` is the placeholder
 * label enum, CHECK-enforced so even a bypassing writer cannot land an
 * illegal row; the accessor layer (events.ts) additionally screens free-text
 * attribution columns for identity-shaped content at insert. Identity
 * attributes are dropped or mapped to labels AT INGEST (BE-5) — this store
 * never sees them.
 *
 * Timestamps: event-time columns are epoch-ms INTEGERs (`*_ms`) matching the
 * wire contract's epoch-ms convention (dashboard math needs numeric time);
 * bookkeeping columns stay ISO-8601 strings (`*_iso`) like the kernel tables.
 *
 * ============================================================================
 * FROZEN-M3 (2026-07-04). Amendments only via ICR (docs/contracts/icr/).
 * Prose of record: docs/contracts/sqlite-ddl.md.
 * ============================================================================
 */

import type { Migration } from '../index.js';

import { MIGRATION_0006_ACCOUNT_REGISTRY_EVENTS } from './0006-account-registry-events.js';

export const MIGRATION_0002_EVENTS: Migration = {
  id: 2,
  name: 'events-store-init',
  up: `
CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY CHECK (length(trim(key)) > 0),
  value TEXT NOT NULL
) STRICT;

INSERT INTO schema_meta (key, value) VALUES
  ('events_ddl_version', '1'),
  ('frozen_milestone', 'M3'),
  ('store', 'events');

CREATE TABLE events (
  id                       INTEGER PRIMARY KEY,
  -- Event time, epoch ms (wire-aligned; dashboards do numeric block math).
  ts_ms                    INTEGER NOT NULL CHECK (ts_ms >= 0),
  backend                  TEXT NOT NULL
                           CHECK (backend IN ('claude_code','opencode','lmstudio')),
  -- [X2]: the label enum IS the only account attribution this store knows.
  account                  TEXT NOT NULL
                           CHECK (account IN ('MAX_A','MAX_B','ENT','AWS_DEV','LOCAL')),
  -- Blueprint §6.1 collection matrix feed (protocol EVENT_SOURCES).
  source                   TEXT NOT NULL
                           CHECK (source IN ('claude-jsonl','claude-otel','claude-quota','hooks',
                                             'opencode-sse','opencode-db','bedrock-cost-explorer',
                                             'bedrock-cloudwatch','lmstudio','ent-analytics')),
  -- OPEN vocabulary (hook names bump in CLI minors; ingestion never breaks).
  event_type               TEXT NOT NULL CHECK (length(event_type) > 0),
  -- Harness session id when the event maps to one.
  session_id               TEXT,
  -- Native session id: the JSONL↔OTel join axis (blueprint §6.2).
  native_session_id        TEXT,
  workstream_id            TEXT,
  prompt_id                TEXT,
  model                    TEXT,
  provider                 TEXT,
  -- The four ground-truth token classes + reasoning (blueprint §6.2).
  input_tokens             INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens            INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cache_read_tokens        INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_creation_tokens    INTEGER CHECK (cache_creation_tokens IS NULL OR cache_creation_tokens >= 0),
  -- 5m/1h cache-TTL split — JSONL ground truth (blueprint §6.1 row 2).
  cache_creation_5m_tokens INTEGER CHECK (cache_creation_5m_tokens IS NULL OR cache_creation_5m_tokens >= 0),
  cache_creation_1h_tokens INTEGER CHECK (cache_creation_1h_tokens IS NULL OR cache_creation_1h_tokens >= 0),
  reasoning_tokens         INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  -- cost_estimated_usd (prices table math) vs cost_actual_usd (Cost Explorer
  -- backfill target — backfill writes THIS column only, never raw fields).
  cost_estimated_usd       REAL CHECK (cost_estimated_usd IS NULL OR cost_estimated_usd >= 0),
  cost_actual_usd          REAL CHECK (cost_actual_usd IS NULL OR cost_actual_usd >= 0),
  latency_ms               INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  ttft_ms                  INTEGER CHECK (ttft_ms IS NULL OR ttft_ms >= 0),
  -- tool/skill/agent/mcp attribution (skill-invocation leaderboard inputs).
  tool_name                TEXT,
  skill_name               TEXT,
  agent_name               TEXT,
  mcp_server               TEXT,
  ok                       INTEGER CHECK (ok IS NULL OR ok IN (0, 1)),
  error_kind               TEXT CHECK (error_kind IS NULL
                                       OR error_kind IN ('error','retry','throttle','timeout')),
  -- JSON array of absolute file paths (identifier-tagged for redaction).
  file_refs                TEXT,
  -- Pointer back to the source line/row; half of the dedupe key.
  raw_ref                  TEXT NOT NULL CHECK (length(raw_ref) > 0),
  ingested_at_iso          TEXT NOT NULL,
  CHECK (
    (account IN ('MAX_A','MAX_B','ENT') AND backend = 'claude_code')
    OR (account = 'AWS_DEV' AND backend = 'opencode')
    OR (account = 'LOCAL'   AND backend = 'lmstudio')
  )
) STRICT;

-- THE dedupe key (blueprint §6.2): one row per (backend, raw_ref).
CREATE UNIQUE INDEX events_dedupe_idx  ON events (backend, raw_ref);
CREATE INDEX events_ts_idx             ON events (ts_ms);
CREATE INDEX events_account_ts_idx     ON events (account, ts_ms);
CREATE INDEX events_type_idx           ON events (event_type);
CREATE INDEX events_session_idx        ON events (session_id)
  WHERE session_id IS NOT NULL;
CREATE INDEX events_native_session_idx ON events (native_session_id)
  WHERE native_session_id IS NOT NULL;
CREATE INDEX events_skill_idx          ON events (skill_name)
  WHERE skill_name IS NOT NULL;

CREATE TABLE quota_snapshots (
  id              INTEGER PRIMARY KEY,
  account         TEXT NOT NULL
                  CHECK (account IN ('MAX_A','MAX_B','ENT','AWS_DEV','LOCAL')),
  window          TEXT NOT NULL CHECK (window IN ('5h','7d','7d_sonnet')),
  used_pct        REAL NOT NULL CHECK (used_pct >= 0 AND used_pct <= 100),
  resets_at_ms    INTEGER NOT NULL CHECK (resets_at_ms >= 0),
  captured_at_ms  INTEGER NOT NULL CHECK (captured_at_ms >= 0),
  source          TEXT NOT NULL CHECK (source IN ('statusline','oauth-poll')),
  ingested_at_iso TEXT NOT NULL
) STRICT;

-- Statusline tees re-emit; identical captures dedupe silently.
CREATE UNIQUE INDEX quota_snapshots_dedupe_idx
  ON quota_snapshots (account, window, captured_at_ms, source);
CREATE INDEX quota_snapshots_latest_idx
  ON quota_snapshots (account, window, captured_at_ms);

CREATE TABLE session_outcomes (
  id                INTEGER PRIMARY KEY,
  account           TEXT NOT NULL
                    CHECK (account IN ('MAX_A','MAX_B','ENT','AWS_DEV','LOCAL')),
  native_session_id TEXT NOT NULL CHECK (length(native_session_id) > 0),
  -- Insights facet value — CLI-owned open vocabulary.
  outcome           TEXT NOT NULL CHECK (length(outcome) > 0),
  friction          TEXT,
  -- Full facets/session-meta record, verbatim JSON (identity already dropped
  -- at ingest [X2]).
  facets_json       TEXT,
  captured_at_ms    INTEGER NOT NULL CHECK (captured_at_ms >= 0),
  raw_ref           TEXT NOT NULL CHECK (length(raw_ref) > 0),
  ingested_at_iso   TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX session_outcomes_dedupe_idx ON session_outcomes (account, raw_ref);
CREATE INDEX session_outcomes_session_idx       ON session_outcomes (native_session_id);

CREATE TABLE prices (
  provider                TEXT NOT NULL CHECK (length(provider) > 0),
  model                   TEXT NOT NULL CHECK (length(model) > 0),
  input_usd_per_mtok      REAL NOT NULL CHECK (input_usd_per_mtok >= 0),
  output_usd_per_mtok     REAL NOT NULL CHECK (output_usd_per_mtok >= 0),
  cache_read_usd_per_mtok REAL CHECK (cache_read_usd_per_mtok IS NULL OR cache_read_usd_per_mtok >= 0),
  cache_write_usd_per_mtok REAL CHECK (cache_write_usd_per_mtok IS NULL OR cache_write_usd_per_mtok >= 0),
  -- The ccusage lesson: prices are PINNED (seed source recorded), and an
  -- operator override always wins and survives re-seeding.
  source                  TEXT NOT NULL CHECK (source IN ('litellm-pinned','override')),
  pinned_at_iso           TEXT NOT NULL,
  PRIMARY KEY (provider, model)
) STRICT;
`,
};

/**
 * The full ordered migration list for the COLLECTOR-OWNED events database
 * (`~/.aibender/db/events.db`) — the sibling list sqlite-ddl.md §6 reserved.
 * Later observability DDL appends here via ICR; kernel-ledger DDL (X4 at M4)
 * appends to KERNEL_MIGRATIONS instead. 0006 = the M7 account-registry
 * relaxation (account CHECKs widen to the open MAX_<X> form — ICR-0013). Never
 * reorder, never edit 0002.
 */
export const EVENTS_STORE_MIGRATIONS: readonly Migration[] = Object.freeze([
  MIGRATION_0002_EVENTS,
  MIGRATION_0006_ACCOUNT_REGISTRY_EVENTS,
]);
