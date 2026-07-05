# SQLite DDL contract — harness ledgers

> ## 🔒 FROZEN-M1 (kernel slice) · FROZEN-M3 (events slice) · FROZEN-M4 (lineage slice) — 2026-07-04
> **Owner: BE-ORCH.** After this banner, frozen sections change **only**
> through an interface change request ([docs/contracts/icr/](icr/README.md)).
> This contract is **amended per milestone** (plan §3): M3 appended the
> events store (§7), M4 appended the X4 lineage tables (§8, this freeze),
> M5 appends the pipeline tables — each amendment lands as a NEW migration
> (never an edit to a frozen one) plus a new section here with its own
> freeze banner.
>
> The machine-checkable half is `packages/schema` (migrations 0001/0002/0003
> + accessors). **This document is the prose of record when the two disagree
> — file an ICR, never a silent divergence.**

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
| M3 | `events`, `quota_snapshots`, `session_outcomes`, `prices` (§6.2) | **LANDED — §7, migration 0002 on the events-store sibling list** |
| M4 | `workstream`, `session_node`, `session_edge`, `brief` (§5) | **LANDED — §8 (this freeze), migration 0003 on KERNEL_MIGRATIONS** |
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

## 8. Migration 0003 `lineage-tables-init` — the [X4] workstream lineage ledger — FROZEN (M4)

Blueprint §5 exactly (findings x4-workstreams Option B): `workstream` +
`session_node` + `session_edge` + `brief`. Machine-checkable half:
`packages/schema/src/migrations/0003-lineage.ts` + accessors in
`packages/schema/src/lineage.ts`. Wire counterpart:
[ws-protocol.md §16](ws-protocol.md) (the `workstream` channel); seam
counterpart: ws-protocol.md §15 (`LineageRecorder` / `SessionIdResolver`).

### 8.1 KERNEL DATABASE (the db-placement decision, made at this freeze)

Migration 0003 **appends to `KERNEL_MIGRATIONS`** — the lineage ledger lives
in the KERNEL database (`~/.aibender/db/kernel.db`), NOT in the collector's
events database. Why:

1. **Same commit boundary as the actions being recorded.** Edges are
   recorded AT ACTION TIME by the same kernel code path that writes
   resume-ledger rows (ws-protocol.md §15.1); one database means one WAL
   transaction scope and real FOREIGN KEYs between `session_edge`,
   `session_node`, and `brief`.
2. **Write rate is the resume-ledger rate, not ingest rate.** The §7.1
   contention argument that forced the events store into its own file
   (collector high-volume ingest vs. latency-critical row-before-spawn)
   does not apply: lineage writes happen per session ACTION and per
   reconciler cycle.
3. **The resolver seam is a single-database join.** `SessionIdResolver`
   (ws-protocol.md §15.2) resolves native → harness ids over
   `resume_ledger.native_session_id` + `session_node.native_session_id` —
   both indexed, one query plan, no cross-file ATTACH.

Migration ids stay repo-wide unique: 0001 = kernel (M1), 0002 = events
(M3, sibling list), 0003 = lineage (M4, kernel list). The kernel db's
`schema_meta` gains `('lineage_ddl_version','1')` and
`('lineage_frozen_milestone','M4')`; the M1 seeds (incl.
`frozen_milestone = 'M1'`) are deliberately untouched — each slice gets its
own keys (the events-db precedent).

**Timestamps (M4 decision):** lineage times are ACTION/EVENT times rendered
on the FE timeline, so they are **epoch-ms INTEGERs** (`*_ms`, the migration
0002 wire-aligned precedent). The §3 "ISO-8601 throughout" pin remains
scoped to the M1 kernel tables.

### 8.2 `workstream`

```sql
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
```

### 8.3 `session_node`

**Harness ids PRIMARY** (blueprint §5 "harness id, never the native id"):
`session_node.id` IS the harness session id — the resume-ledger id for
kernel-launched sessions (one id per session across ledger, wire channels,
and lineage), reconciler-minted (same charset) for external sessions.
Deliberately NOT a foreign key into `resume_ledger`: reconciled nodes have
no ledger row. The native id is a nullable ATTRIBUTE with write-once
backfill (the resume-ledger rule; lmstudio sessions are harness-native and
never get one).

```sql
CREATE TABLE session_node (
  id                 TEXT PRIMARY KEY CHECK (length(id) > 0),
  workstream_id      TEXT REFERENCES workstream(id),             -- NULL = detached-HEAD bucket
  backend            TEXT NOT NULL CHECK (backend IN ('claude_code','opencode','lmstudio')),
  account            TEXT NOT NULL
                     CHECK (account IN ('MAX_A','MAX_B','ENT','AWS_DEV','LOCAL')),
  native_session_id  TEXT,          -- ATTRIBUTE, nullable; write-once backfill
  native_scope       TEXT,          -- encoded-cwd / opencode project id — MUTABLE (/cd moves it)
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
  CHECK ((account IN ('MAX_A','MAX_B','ENT') AND backend = 'claude_code')
      OR (account = 'AWS_DEV' AND backend = 'opencode')
      OR (account = 'LOCAL'   AND backend = 'lmstudio'))
) STRICT;
CREATE INDEX session_node_workstream_idx ON session_node (workstream_id)
  WHERE workstream_id IS NOT NULL;
CREATE INDEX session_node_native_idx     ON session_node (native_session_id)
  WHERE native_session_id IS NOT NULL;
CREATE INDEX session_node_state_idx      ON session_node (state);
```

Node **confidence** is `recorded | inferred` (the frozen enum): harness
nodes are `recorded` by construction; reconciler-registered external
sessions land as `inferred`-confidence orphans in the detached-HEAD bucket
(`workstream_id IS NULL`, `origin = 'reconciled'`) — the M4 DoD row.
`origin` names WHO created the row; `confidence` names HOW SURE the lineage
is (a reconciled node backed by a native first-class lineage column, e.g.
opencode `parent_id`, may still be `recorded`). Node `state` is the LINEAGE
enum, a different axis from the resume-ledger process states (§4).

### 8.4 `brief`

Kinds are named by the AUTOMATION MOMENT (hooks-contract.md §7.1):
`session-end` (auto continuation brief) · `pre-compact` (full-fidelity
snapshot) · `session-start-injection` (the injected body) · `merge` (the
conflict-surfacing merge brief). The blueprint's naming maps onto these
(continuation→session-end, compaction_capture→pre-compact, handoff briefs
are session-end briefs carried by a `handoff` edge, merge→merge).
Provenance is the qwen-produces/Claude-reviews split: `native-summary`
(reuse the transcript's own compaction summary) · `local-draft` ·
`refined`.

```sql
CREATE TABLE brief (
  id             TEXT PRIMARY KEY CHECK (length(id) > 0),        -- harness id, newId('br')
  kind           TEXT NOT NULL
                 CHECK (kind IN ('session-end','pre-compact','session-start-injection','merge')),
  body_md        TEXT NOT NULL CHECK (length(body_md) > 0),      -- paths+ids+labels only [X2]
  source_nodes   TEXT NOT NULL CHECK (length(source_nodes) > 0), -- JSON array of session_node ids
  provenance     TEXT NOT NULL
                 CHECK (provenance IN ('native-summary','local-draft','refined')),
  token_count    INTEGER CHECK (token_count IS NULL OR token_count >= 0),
  created_at_ms  INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT;
```

### 8.5 `session_edge`

The edge vocabulary is **exactly** the blueprint §5 set — CHECK-enforced so
even a bypassing writer cannot land an illegal edge:

```sql
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
  CHECK (edge_type = 'import' OR from_node IS NOT NULL),   -- from NULL ONLY for imports …
  CHECK (edge_type != 'import' OR from_node IS NULL),      -- … and imports never carry one
  CHECK (edge_type != 'handoff' OR brief_id IS NOT NULL)   -- handoff briefs are MANDATORY
) STRICT;
CREATE INDEX session_edge_from_idx ON session_edge (from_node) WHERE from_node IS NOT NULL;
CREATE INDEX session_edge_to_idx   ON session_edge (to_node);
CREATE INDEX session_edge_type_idx ON session_edge (edge_type);
```

Rules (accessor-enforced on top of the CHECKs, tested — lineage.ts):

- **A continuation is a CHILD via `continue`, never a sibling**; an
  in-place resume/recycle is a `continue` SELF-edge (from = to, the M2
  `ContinuationEdgeEmitter` convention). Every NON-continue type refuses
  self-edges.
- **Merge = ONE new node with N `merge_parent` edges (2..16 distinct
  parents), written atomically** (`recordMerge`: node + edges + the
  mandatory kind=`merge` brief in one transaction — a crash never leaves a
  merge node without its parents).
- Endpoints and briefs must exist (typed error before the FK fires);
  unknown vocabularies are refused at the accessor AND the CHECK.
- Kernel-recorded edges default `confidence = 'recorded'` (action time,
  ws-protocol.md §15.1); reconciler inferences pass `inferred`.

### 8.6 Redaction field tags (lineage slice)

`LINEAGE_FIELD_TAGS`: `cwd`, `native_scope`, `transcript_ref`, `worktree`,
`body_md`, `metadata` → `identifier` (machine-local paths / path-bearing
markdown+JSON; exempt from the insert-time identity screen — brief bodies
legitimately carry absolute paths — and redacted downstream instead).
Free-text NAMING columns (`title`, `description`, `tags`, `display_name`,
`git_branch`) pass the §7.2 insert-time identity screen. No lineage column
is `secret` [X2].

## 9. Amendment record

| Date | Change | ICR |
|---|---|---|
| 2026-07-04 | Initial M1 freeze (engine, runner discipline, migration 0001, state machine, tags) | — (the freeze itself) |
| 2026-07-04 | §4: documented the kernel pid-liveness guard proving the "child death" precondition of `running → resumed` (pid+nonce probe when recorded; SDK stdio-pipe-lifetime reasoning when pid is NULL). No DDL or transition change. | [ICR-0005](icr/icr-0005-pid-liveness-guard.md) |
| 2026-07-04 | **M3 events-store freeze (§7).** Migration 0002 `events-store-init`: `events` fact table (dedupe UNIQUE (backend, raw_ref); label-enum + label↔backend pairing CHECKs [X2]; four token classes + 5m/1h TTL split + reasoning; `cost_estimated_usd` vs `cost_actual_usd` backfill target; latency/TTFT; tool/skill/agent/mcp attribution; `error_kind` enum; `file_refs`/`raw_ref`) + `quota_snapshots` + `session_outcomes` + `prices` (override-wins pinning). Decisions recorded: SEPARATE collector-owned database `~/.aibender/db/events.db` via the `EVENTS_STORE_MIGRATIONS` sibling list (§7.1, blueprint §6.2 "owned by the collector"; repo-wide-unique migration ids); epoch-ms integers for event-time columns (§7.2, wire-aligned); insert-time identity-shape screen on semantic columns with path/JSON columns `identifier`-tagged instead (§7.2/§7.6). Migration 0001 and KERNEL_MIGRATIONS untouched. | — (M3 freeze; plan §3 schema row) |
| 2026-07-04 | §7.4 **usage-data mapping clarification** (prose only, NO DDL change; the interpretation question raised in the BE-5 M3 return): facets → `session_outcomes` (the assessment row); session-meta → `events` with `event_type 'session_meta'` (token totals, no outcome — never mirrored into `session_outcomes`, whose `outcome` is NOT NULL by design). Blesses the landed normalizer (core/src/collector/jsonl/usageData.ts). | — (BE-ORCH steward, prose pin) |
| 2026-07-04 | **M4 lineage freeze (§8).** Migration 0003 `lineage-tables-init`: `workstream` (status enum, JSON tags) + `session_node` (HARNESS id PRIMARY — the resume-ledger id for kernel launches, reconciler-minted for external; native id a nullable write-once ATTRIBUTE; label-enum + pairing CHECKs [X2]; lineage state/origin/confidence enums; mutable `native_scope` for `/cd`; token/cost snapshots) + `brief` (kind session-end·pre-compact·session-start-injection·merge; provenance native-summary·local-draft·refined; body `identifier`-tagged) + `session_edge` (edge_type EXACTLY continue·fork·merge_parent·compact·sidechain·handoff·import·workflow; from/import + handoff-brief CHECK matrices; continue self-edges legal). Decisions recorded: **KERNEL DATABASE via KERNEL_MIGRATIONS** (§8.1 — action-time recording shares the kernel's commit boundary; lineage writes are resume-ledger-rate; the SessionIdResolver join is single-db; repo-wide-unique migration ids 0001/0002/0003); epoch-ms integers for lineage times (§8.1); accessor-enforced edge legality + ATOMIC `recordMerge` (§8.5); naming-column identity screen + `LINEAGE_FIELD_TAGS` (§8.6). `schema_meta` gains lineage keys, M1 seeds untouched. Migrations 0001/0002 untouched; `openKernelStore` now also hands back the `lineage` accessors. | — (M4 freeze; plan §3 schema row) |
