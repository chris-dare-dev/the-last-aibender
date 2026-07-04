# SQLite DDL contract — harness ledgers

> ## 🔒 FROZEN-M1 (kernel slice) · FROZEN-M3 (events slice) — 2026-07-04
> **Owner: BE-ORCH.** After this banner, frozen sections change **only**
> through an interface change request ([docs/contracts/icr/](icr/README.md)).
> This contract is **amended per milestone** (plan §3): M3 appended the
> events store (§7, this freeze), M4 appends the X4 workstream tables, M5
> the pipeline tables — each amendment lands as a NEW migration (never an
> edit to a frozen one) plus a new section here with its own freeze banner.
>
> The machine-checkable half is `packages/schema` (migrations 0001/0002 +
> accessors). **This document is the prose of record when the two disagree —
> file an ICR, never a silent divergence.**

Blueprint anchors: §4.1 (resume ledger), §6.2 (one SQLite/WAL store), plan §3
(freeze schedule). State-machine mechanics were proven by SPIKE-D (vii): real
SIGKILL, orphan detect/reap, crash-window recovery, exactly-once resume
([docs/spikes/spike-d-pty-supervision.md](../spikes/spike-d-pty-supervision.md)).

---

## 1. Engine & adapter — FROZEN (M1)

- **Engine: `node:sqlite`** (`DatabaseSync`) — in Node since 22.5, zero native
  dependencies (schema package pins `engines.node >= 22.5`). Chosen per the
  M1 build brief; the API is experimental-flagged in Node 22.x (emits a
  startup warning, harmless) and stabilizes in later lines.
- **WAL on open** (blueprint §6.2): the adapter applies
  `PRAGMA journal_mode = wal` (file-backed stores), `foreign_keys = ON`,
  `busy_timeout = 5000` at open. `:memory:` test stores report `memory`
  journal mode — SQLite cannot WAL a memory store; tests assert both.
- **Adapter interface**: all stores code against `SqliteDriver`
  (`exec` / `prepare().run|get|all` / `close`) — never against node:sqlite
  directly.
- **better-sqlite3 swap path** (documented, deliberately trivial): implement
  `SqliteDriver` over a better-sqlite3 `Database` — `exec→db.exec`,
  `prepare().run/get/all→stmt.run/get/all` (identical `{changes,
  lastInsertRowid}` and plain-object row shapes), `close→db.close`; apply the
  same three pragmas. No caller or migration changes. Motivation to swap:
  pre-22.5 Node, or measured statement-throughput needs.

## 2. Migration discipline — FROZEN (M1)

- Migrations are **forward-only** (no down migrations), applied **atomically
  per migration** (`BEGIN … COMMIT`, `ROLLBACK` on failure).
- The applied ledger is **`schema_migrations`** — bootstrapped by the runner
  itself (it must exist before any migration can be recorded), NOT by a
  migration:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  id             INTEGER PRIMARY KEY CHECK (id > 0),
  name           TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  applied_at_iso TEXT    NOT NULL
) STRICT;
```

- Callers pass the **full migration list** every time (`KERNEL_MIGRATIONS`);
  applied ids are skipped → **re-run is a no-op** (tested).
- Refused loudly (`MigrationHistoryError`, tested):
  - an unapplied id **below** the applied high-water mark (out-of-order);
  - a passed list **missing** an applied id (partial list);
  - an applied id whose **name differs** from the list's (history drift).

## 3. Migration 0001 `kernel-tables-init` — FROZEN (M1)

Timestamps are ISO-8601 UTC strings throughout. All tables are `STRICT`.

### 3.1 `schema_meta`

```sql
CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY CHECK (length(trim(key)) > 0),
  value TEXT NOT NULL
) STRICT;
-- seeds: ('ddl_version','1'), ('frozen_milestone','M1')
```

### 3.2 `account_profiles`

```sql
CREATE TABLE account_profiles (
  label          TEXT PRIMARY KEY
                 CHECK (label IN ('MAX_A','MAX_B','ENT','AWS_DEV','LOCAL')),
  backend        TEXT NOT NULL
                 CHECK (backend IN ('claude_code','opencode','lmstudio')),
  config_dir     TEXT,             -- machine-local absolute path; NULL until provisioned
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  CHECK ((label IN ('MAX_A','MAX_B','ENT') AND backend = 'claude_code')
      OR (label = 'AWS_DEV' AND backend = 'opencode')
      OR (label = 'LOCAL'   AND backend = 'lmstudio'))
) STRICT;
```

- Seeded with the **five labels**, `config_dir = NULL`.
- **[X2]:** the repo carries labels and *path conventions* only
  (`~/.aibender/accounts/{max-a,max-b,ent}/`, plan §2). The real
  `config_dir` values are written at runtime by SI-2 provisioning into the
  machine-local database under `~/.aibender/db/` — never into any committed
  file. `CLAUDE_SECURESTORAGE_CONFIG_DIR` is pinned to the **same** path
  (blueprint §3), so one column suffices.

### 3.3 `resume_ledger`

Row-before-spawn fields exactly per blueprint §4.1, plus the two SPIKE-D
finding-2 columns (`pid`, `spawn_nonce`).

```sql
CREATE TABLE resume_ledger (
  id                TEXT PRIMARY KEY CHECK (length(id) > 0),  -- harness id, newId('ses')
  account_label     TEXT NOT NULL CHECK (account_label IN ('MAX_A','MAX_B','ENT','AWS_DEV','LOCAL')),
  backend           TEXT NOT NULL CHECK (backend IN ('claude_code','opencode','lmstudio')),
  cwd               TEXT NOT NULL CHECK (length(cwd) > 0),
  substrate         TEXT NOT NULL CHECK (substrate IN ('sdk','pty')),
  purpose           TEXT NOT NULL CHECK (length(purpose) > 0),
  workstream_hint   TEXT,
  native_session_id TEXT,          -- NULL at insert; backfilled from the init message
  state             TEXT NOT NULL CHECK (state IN
                    ('spawning','running','resumed','orphan_detected','orphan_killed','exited')),
  pid               INTEGER CHECK (pid IS NULL OR pid > 0),   -- ACTUAL session process (SPIKE-D f2)
  spawn_nonce       TEXT,                                     -- argv-nonce pid-reuse guard (SPIKE-D)
  created_at_iso    TEXT NOT NULL,
  updated_at_iso    TEXT NOT NULL,
  CHECK ((account_label IN ('MAX_A','MAX_B','ENT') AND backend = 'claude_code')
      OR (account_label = 'AWS_DEV' AND backend = 'opencode')
      OR (account_label = 'LOCAL'   AND backend = 'lmstudio')),
  CHECK (substrate != 'pty' OR backend = 'claude_code')
) STRICT;
CREATE INDEX resume_ledger_state_idx   ON resume_ledger (state);
CREATE INDEX resume_ledger_account_idx ON resume_ledger (account_label);
CREATE INDEX resume_ledger_native_idx  ON resume_ledger (native_session_id)
  WHERE native_session_id IS NOT NULL;
```

Notes:

- `pid`/`spawn_nonce` are additions grounded in the SPIKE-D verdict ("carry
  findings 1–4 into BE-1/BE-2/BE-8 as requirements"): the ledger records the
  pid of the **actual session process** (never a launcher shim), and restart
  reconciliation verifies pid + nonce before classifying an orphan (pid-reuse
  guard). Orphan reaping targets the process **group**.
- The label/backend pairing and pty-is-claude-only rules are CHECK-enforced so
  even a bypassing writer cannot land an illegal row (tested).

## 4. Resume-ledger state machine — FROZEN (M1)

**Row-before-spawn discipline** (blueprint §4.1, SPIKE-D vii): the kernel
calls `insertBeforeSpawn` — row lands in `spawning` with `pid = NULL` —
**before** fork/exec. A crash in the row↔spawn window therefore leaves a
recoverable record, never an untracked child.

Legal transitions (`LEGAL_TRANSITIONS`, accessor-enforced; illegal →
`IllegalTransitionError` — SQL CHECKs cannot see the previous state):

| From | To | Meaning |
|---|---|---|
| `spawning` | `running` | spawn succeeded (pid backfilled) — includes the crash-window respawn of the SAME id |
| `spawning` | `exited` | spawn failed |
| `running` | `resumed` | dead-resume after broker+child death (no orphan rows on this path) |
| `running` | `orphan_detected` | restart found the pid alive with no broker (pid+nonce verified) |
| `running` | `exited` | normal completion / kill |
| `resumed` | `resumed` · `orphan_detected` · `exited` | a resumed session lives the same life |
| `orphan_detected` | `orphan_killed` | process-group SIGKILL of the verified orphan |
| `orphan_killed` | `resumed` | resume from the last coherent journal entry |
| `orphan_killed` | `exited` | resume impossible/declined |
| `exited` | — | terminal |

Everything else is illegal — notably `spawning → resumed` (nothing ran),
`orphan_detected → running/exited` (must reap first), any self-transition
except `resumed → resumed`, and anything out of `exited`.

Backfills (accessor rules, tested): `backfillPid(pid, nonce)` requires a
positive integer pid + non-blank nonce, refused on `exited`;
`backfillNativeSessionId` is **write-once** (same-value re-backfill is a
no-op; a different value throws). `unreconciled()` returns the non-terminal
states — the restart reconciliation set.

The **un-forked double-resume block** (blueprint §5 guardrail) is a kernel
rule layered on this machine: `resume(fork:false)` against a running-family
session answers `double-resume-blocked` (see ws-protocol.md §4.2); the
storage machine records only the resulting legal transition.

**Kernel pid-liveness guard on `running → resumed` (M1, ICR-0005).** The
table above defines `running → resumed` as legal only *after broker+child
death*. The kernel enforces the child-death half before any un-forked
dead-resume of a `running` row (`core/src/kernel/pidLiveness.ts`):

- **pid recorded** (SPIKE-D finding-2 columns): probe `kill(pid, 0)` plus the
  argv `spawn_nonce` identity check (pid-reuse guard). A verified-alive child
  answers `double-resume-blocked` and leaves the row untouched — driving
  `running → orphan_detected → orphan_killed` for a live orphan is restart
  reconciliation (BE-2/BE-9, M2). Forking the row remains available.
- **pid NULL** (the SDK spawn path cannot surface the child pid at SDK
  0.3.201): un-forked dead-resume remains available, on two documented
  grounds encoded as tests (`sessionKernel.spec.ts`, pid-liveness suite):
  (1) SDK children share the broker's stdio-pipe lifetime — `query()` spawns
  the bundled binary attached via pipes, never detached/setsid, and a
  stream-json child exits on stdin EOF when the dead broker's pipe end
  closes; (2) a child that could have outlived its broker was mid-turn, and a
  mid-turn death leaves a dangling/torn transcript tail, which the
  transcript-tail validator routes to a repair **fork** — never an un-forked
  re-drive of the same native session.

No DDL or transition-table change — this documents which component proves the
"child death" precondition the table already required.

## 5. Redaction field tags — FROZEN (M1)

`KERNEL_FIELD_TAGS` (consumed by `@aibender/shared` filters, plan §3):

| Column | Tags | Rationale |
|---|---|---|
| `cwd` | `identifier` | absolute paths embed the machine username |
| `config_dir` | `identifier` | same, and it locates the credential store |
| everything else | — | labels are [X2] placeholders; no kernel column is `secret` — credentials never touch these tables (Keychain-primary) |

## 6. Reserved — future milestones (DRAFT, land via ICR)

| Milestone | Tables (blueprint anchor) | Status |
|---|---|---|
| M3 | `events`, `quota_snapshots`, `session_outcomes`, `prices` (§6.2) | **LANDED — §7 (this freeze), migration 0002 on the events-store sibling list** |
| M4 | `workstream`, `session_node`, `session_edge`, `brief` (§5) | reserved |
| M5 | workflow `runs`, `steps`, memoization journal (§7 of the blueprint) | reserved |

Each lands as migration 000N appended to `KERNEL_MIGRATIONS` (or a sibling
list for a separate database file — decision at the owning milestone), plus a
frozen section here. Migration ids stay **repo-wide unique** across both
lists (0001 = kernel, 0002 = events) so a migration number always names one
DDL change.

## 7. Migration 0002 `events-store-init` — the observability events store — FROZEN (M3)

Blueprint §6.2 exactly: fact table `events` + companions `quota_snapshots`,
`session_outcomes`, `prices`. Machine-checkable half:
`packages/schema/src/migrations/0002-events.ts` + accessors in
`packages/schema/src/events.ts`. Wire counterpart:
[ws-protocol.md §13](ws-protocol.md) (`event-summary` mirrors an `events`
row minus the machine-locating columns).

### 7.1 SEPARATE DATABASE (the sibling-list decision, made at this freeze)

Migration 0002 belongs to **`EVENTS_STORE_MIGRATIONS`** — the sibling list
§6 reserved — applied to the **collector-owned database**
`~/.aibender/db/events.db` (`openEventsStore()`), NOT to the kernel ledger.
Rationale: blueprint §6.2 says "one SQLite (WAL) database **owned by the
collector**", and the collector's high-volume ingest writes must never
contend with the kernel's latency-critical row-before-spawn inserts. The
events database bootstraps its own `schema_migrations` + `schema_meta`
(seeds: `events_ddl_version=1`, `frozen_milestone=M3`, `store=events`).

### 7.2 `events` — the fact table

Time convention (M3 decision): **event-time columns are epoch-ms INTEGERs**
(`*_ms`, matching the wire's epoch-ms convention — dashboards do numeric
block math); bookkeeping columns stay ISO-8601 strings (`*_iso`) like the
kernel tables. All tables `STRICT`.

```sql
CREATE TABLE events (
  id                       INTEGER PRIMARY KEY,
  ts_ms                    INTEGER NOT NULL CHECK (ts_ms >= 0),
  backend                  TEXT NOT NULL CHECK (backend IN ('claude_code','opencode','lmstudio')),
  account                  TEXT NOT NULL
                           CHECK (account IN ('MAX_A','MAX_B','ENT','AWS_DEV','LOCAL')),
  source                   TEXT NOT NULL
                           CHECK (source IN ('claude-jsonl','claude-otel','claude-quota','hooks',
                                             'opencode-sse','opencode-db','bedrock-cost-explorer',
                                             'bedrock-cloudwatch','lmstudio','ent-analytics')),
  event_type               TEXT NOT NULL CHECK (length(event_type) > 0),   -- OPEN vocabulary
  session_id               TEXT,            -- harness id when known
  native_session_id        TEXT,            -- the JSONL↔OTel join axis
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
  file_refs                TEXT,            -- JSON array of absolute paths
  raw_ref                  TEXT NOT NULL CHECK (length(raw_ref) > 0),
  ingested_at_iso          TEXT NOT NULL,
  CHECK ((account IN ('MAX_A','MAX_B','ENT') AND backend = 'claude_code')
      OR (account = 'AWS_DEV' AND backend = 'opencode')
      OR (account = 'LOCAL'   AND backend = 'lmstudio'))
) STRICT;
CREATE UNIQUE INDEX events_dedupe_idx  ON events (backend, raw_ref);   -- THE dedupe key
CREATE INDEX events_ts_idx             ON events (ts_ms);
CREATE INDEX events_account_ts_idx     ON events (account, ts_ms);
CREATE INDEX events_type_idx           ON events (event_type);
CREATE INDEX events_session_idx        ON events (session_id)        WHERE session_id IS NOT NULL;
CREATE INDEX events_native_session_idx ON events (native_session_id) WHERE native_session_id IS NOT NULL;
CREATE INDEX events_skill_idx          ON events (skill_name)        WHERE skill_name IS NOT NULL;
```

Rules (accessor-enforced, tested):

- **Dedupe (backend, raw_ref)** — blueprint §6.2. A duplicate insert is a
  silent no-op returning the EXISTING row (`inserted: false`); re-tailing a
  rotated file never duplicates or overwrites (plan §9.2 BE-5 edge).
- **Cost Explorer backfill** (`backfillCostActual`) writes `cost_actual_usd`
  ONLY — "overwrites estimate not raw" means the estimate column and all raw
  fields stay untouched; re-backfilling updates the actual.
- **[X2] — no identity-bearing columns.** `account` is the placeholder-label
  enum, CHECK-enforced so even a bypassing writer cannot land an illegal
  row. The validated insert path additionally REFUSES identity-shaped
  content (emails, 12-digit runs, token-shaped strings) in the semantic
  attribution columns (`event_type`, `model`, `provider`, `tool_name`,
  `skill_name`, `agent_name`, `mcp_server`). Identity attributes are dropped
  or mapped to labels AT INGEST (BE-5); this store never sees them.
- Skill-invocation leaderboard inputs are `events` rows with skill/tool
  attribution — no separate table.

### 7.3 `quota_snapshots`

Mirror of the frozen wire snapshot (ws-protocol.md §11), epoch-ms columns:

```sql
CREATE TABLE quota_snapshots (
  id              INTEGER PRIMARY KEY,
  account         TEXT NOT NULL CHECK (account IN ('MAX_A','MAX_B','ENT','AWS_DEV','LOCAL')),
  window          TEXT NOT NULL CHECK (window IN ('5h','7d','7d_sonnet')),
  used_pct        REAL NOT NULL CHECK (used_pct >= 0 AND used_pct <= 100),
  resets_at_ms    INTEGER NOT NULL CHECK (resets_at_ms >= 0),
  captured_at_ms  INTEGER NOT NULL CHECK (captured_at_ms >= 0),
  source          TEXT NOT NULL CHECK (source IN ('statusline','oauth-poll')),
  ingested_at_iso TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX quota_snapshots_dedupe_idx
  ON quota_snapshots (account, window, captured_at_ms, source);
CREATE INDEX quota_snapshots_latest_idx
  ON quota_snapshots (account, window, captured_at_ms);
```

Statusline tees re-emit — identical captures dedupe silently; `latest()`
returns one row per (account, window) for the gauge read model.

### 7.4 `session_outcomes`

Insights facets + session-meta (`usage-data/{facets,session-meta}`):

> **Normalizer mapping (M3 stewarding clarification, prose only — no DDL
> change):** of the two usage-data files, only
> **`facets/<uuid>.json`** produces a `session_outcomes` row (`raw_ref
> facets:<uuid>`) — facets carry the assessment (`outcome`,
> `friction_detail`) this table's NOT-NULL `outcome` column models.
> **`session-meta/<uuid>.json`** carries deterministic token/tool totals and
> NO outcome, so it lands as an `events` row (`event_type: 'session_meta'`,
> `raw_ref session-meta:<uuid>`, §7.2) — the fact table token counters are
> built for it. This blesses the BE-5 normalizer decision
> (core/src/collector/jsonl/usageData.ts); mirroring session-meta into this
> table would require fabricating an outcome and is deliberately NOT done.

```sql
CREATE TABLE session_outcomes (
  id                INTEGER PRIMARY KEY,
  account           TEXT NOT NULL CHECK (account IN ('MAX_A','MAX_B','ENT','AWS_DEV','LOCAL')),
  native_session_id TEXT NOT NULL CHECK (length(native_session_id) > 0),
  outcome           TEXT NOT NULL CHECK (length(outcome) > 0),  -- CLI-owned open vocabulary
  friction          TEXT,
  facets_json       TEXT,          -- verbatim facets record (identity dropped at ingest)
  captured_at_ms    INTEGER NOT NULL CHECK (captured_at_ms >= 0),
  raw_ref           TEXT NOT NULL CHECK (length(raw_ref) > 0),
  ingested_at_iso   TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX session_outcomes_dedupe_idx ON session_outcomes (account, raw_ref);
CREATE INDEX session_outcomes_session_idx       ON session_outcomes (native_session_id);
```

### 7.5 `prices`

LiteLLM-seeded, **pinned**, overridable — the ccusage lesson:

```sql
CREATE TABLE prices (
  provider                 TEXT NOT NULL CHECK (length(provider) > 0),
  model                    TEXT NOT NULL CHECK (length(model) > 0),
  input_usd_per_mtok       REAL NOT NULL CHECK (input_usd_per_mtok >= 0),
  output_usd_per_mtok      REAL NOT NULL CHECK (output_usd_per_mtok >= 0),
  cache_read_usd_per_mtok  REAL CHECK (cache_read_usd_per_mtok IS NULL OR cache_read_usd_per_mtok >= 0),
  cache_write_usd_per_mtok REAL CHECK (cache_write_usd_per_mtok IS NULL OR cache_write_usd_per_mtok >= 0),
  source                   TEXT NOT NULL CHECK (source IN ('litellm-pinned','override')),
  pinned_at_iso            TEXT NOT NULL,
  PRIMARY KEY (provider, model)
) STRICT;
```

**Override-wins semantics** (accessor-enforced, tested): a `litellm-pinned`
upsert never replaces an existing `override` row (re-seeding cannot clobber
an operator override); an `override` upsert always wins.

### 7.6 Redaction field tags (events slice)

`EVENTS_FIELD_TAGS`: `raw_ref`, `file_refs`, `facets_json` → `identifier`
(machine-local paths / path-bearing JSON; exempt from the insert-time shape
screen — epoch values inside JSON legitimately contain long digit runs —
and redacted downstream instead). No events-store column is `secret`.

## 8. Amendment record

| Date | Change | ICR |
|---|---|---|
| 2026-07-04 | Initial M1 freeze (engine, runner discipline, migration 0001, state machine, tags) | — (the freeze itself) |
| 2026-07-04 | §4: documented the kernel pid-liveness guard proving the "child death" precondition of `running → resumed` (pid+nonce probe when recorded; SDK stdio-pipe-lifetime reasoning when pid is NULL). No DDL or transition change. | [ICR-0005](icr/icr-0005-pid-liveness-guard.md) |
| 2026-07-04 | **M3 events-store freeze (§7).** Migration 0002 `events-store-init`: `events` fact table (dedupe UNIQUE (backend, raw_ref); label-enum + label↔backend pairing CHECKs [X2]; four token classes + 5m/1h TTL split + reasoning; `cost_estimated_usd` vs `cost_actual_usd` backfill target; latency/TTFT; tool/skill/agent/mcp attribution; `error_kind` enum; `file_refs`/`raw_ref`) + `quota_snapshots` + `session_outcomes` + `prices` (override-wins pinning). Decisions recorded: SEPARATE collector-owned database `~/.aibender/db/events.db` via the `EVENTS_STORE_MIGRATIONS` sibling list (§7.1, blueprint §6.2 "owned by the collector"; repo-wide-unique migration ids); epoch-ms integers for event-time columns (§7.2, wire-aligned); insert-time identity-shape screen on semantic columns with path/JSON columns `identifier`-tagged instead (§7.2/§7.6). Migration 0001 and KERNEL_MIGRATIONS untouched. | — (M3 freeze; plan §3 schema row) |
| 2026-07-04 | §7.4 **usage-data mapping clarification** (prose only, NO DDL change; the interpretation question raised in the BE-5 M3 return): facets → `session_outcomes` (the assessment row); session-meta → `events` with `event_type 'session_meta'` (token totals, no outcome — never mirrored into `session_outcomes`, whose `outcome` is NOT NULL by design). Blesses the landed normalizer (core/src/collector/jsonl/usageData.ts). | — (BE-ORCH steward, prose pin) |
