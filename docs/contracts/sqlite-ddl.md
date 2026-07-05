# SQLite DDL contract — harness ledgers

> ## 🔒 FROZEN-M1 (kernel slice) · FROZEN-M3 (events slice) · FROZEN-M4 (lineage slice) · FROZEN-M5 (pipeline slice) — 2026-07-04
> **Owner: BE-ORCH.** After this banner, frozen sections change **only**
> through an interface change request ([docs/contracts/icr/](icr/README.md)).
> This contract is **amended per milestone** (plan §3): M3 appended the
> events store (§7), M4 appended the X4 lineage tables (§8), M5 appended the
> pipeline store + memoization journal (§10, this freeze) — each amendment
> lands as a NEW migration (never an edit to a frozen one) plus a new section
> here with its own freeze banner.
>
> The machine-checkable half is `packages/schema` (migrations 0001/0002/0003/
> 0004/0005/0006/0007/0008/0009 + accessors). **This document is the prose of
> record when the two disagree — file an ICR, never a silent divergence.**
>
> **AMENDED FROZEN-M8 (2026-07-05, ICR-0016) — backend-registry relaxation
> (finding OS-1).** The `backend` CHECK constraints below (shown verbatim from
> the frozen migrations 0001/0002/0003/0004) were pinned to the CLOSED 3-literal
> set `('claude_code','opencode','lmstudio')`, and the label↔backend pairing +
> pty CHECKs hardcoded those literals. Migrations **0007** (kernel) and **0008**
> (events) RELAX them: `backend`/`source` become `length(...) > 0` (the accessor's
> `isBackend`/`isEventSource` consult the runtime `BackendDescriptor` registry —
> a SQLite CHECK cannot); the account + pairing + pty CHECKs keep the BUILT-IN
> clauses and add a "backend is NOT one of the built-in three → defer to the app
> layer" branch. So a registered 4th backend lands with NO schema change, while
> the built-in three stay CHECK-enforced byte-identically. See §10.8. Migration
> **0009** (§10.9) closes the one table 0007 skipped — `step_attempt.account`
> widens to admit a registered backend's own label (keyed on the label form; no
> backend column on that table). The frozen migrations are NOT edited (the
> table-rebuilds land in the new 0007/0008/0009).
>
> **AMENDED FROZEN-M7 (2026-07-05, ICR-0013) — account-registry relaxation.**
> The account-label CHECK constraints below (shown verbatim from the frozen
> migrations 0001/0002/0003/0004) were pinned to the CLOSED 5-literal set
> `('MAX_A','MAX_B','ENT','AWS_DEV','LOCAL')`. Migrations **0005** (kernel) and
> **0006** (events) RELAX them to the OPEN, validated FORM — see §11. Wherever a
> CHECK below reads `account[_label] IN ('MAX_A','MAX_B','ENT','AWS_DEV','LOCAL')`
> the LIVE constraint after 0005/0006 reads
> `account[_label] GLOB 'MAX_[A-Z]' OR account[_label] IN ('ENT','AWS_DEV','LOCAL')`,
> and the pairing CHECK's `IN ('MAX_A','MAX_B','ENT')` clause becomes
> `(… GLOB 'MAX_[A-Z]' OR … = 'ENT')`. The label↔backend pairing is preserved
> verbatim. The frozen migrations are NOT edited (SQLite table-rebuild lands in
> the new 0005/0006).

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
| M5 | `pipeline_definition`, `pipeline_run`, `step_attempt` (memoization journal; §7 of the blueprint) | **LANDED — §10, migration 0004 on KERNEL_MIGRATIONS** |

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

## 10. Migration 0004 `pipeline-tables-init` — the M5 pipeline store + memoization journal — FROZEN (M5)

Blueprint §7 (pipeline engine), plan §4/BE-8, findings
[pipeline-workflow-builder.md](../research/findings/pipeline-workflow-builder.md)
§R3. Machine-checkable half:
`packages/schema/src/migrations/0004-pipelines.ts` + accessors in
`packages/schema/src/pipelines.ts`. Wire counterpart:
[ws-protocol.md §18](ws-protocol.md) (the `pipelines` channel); the saved DAG
document format: [dag-schema.md](dag-schema.md).

### 10.1 KERNEL DATABASE (the db-placement decision, made at this freeze)

Migration 0004 **appends to `KERNEL_MIGRATIONS`** — the pipeline store + the
durable MEMOIZATION JOURNAL live in the KERNEL database
(`~/.aibender/db/kernel.db`), NOT in the collector's events database. This
follows the M4 lineage precedent (§8.1) for the SAME three reasons:

1. **Same commit boundary as the lineage rows the run produces.** Findings §R3:
   "every step attempt = a `session_node`" and "a pipeline is a workstream
   subgraph". A step attempt writes both a `step_attempt` row (here) and a
   `session_node` + `workflow` `session_edge` (migration 0003, same db) — one
   WAL transaction scope, real FK-able co-location.
2. **Write rate is the resume-ledger rate, not ingest rate.** Journal writes
   happen per STEP ATTEMPT (a session action) — never the collector's
   high-volume event ingest that forced events.db out (§7.1).
3. **Resume is a single-database join.** Cross-restart resume re-walks the DAG
   and reads `step_attempt` cached outputs + the `session_node` the attempt may
   `resume` in place — both here, one query plan, no cross-file ATTACH.

Migration ids stay repo-wide unique: 0001 = kernel (M1), 0002 = events (M3,
sibling list), 0003 = lineage (M4, kernel list), 0004 = pipelines (M5, kernel
list). The kernel db's `schema_meta` gains `('pipeline_ddl_version','1')` and
`('pipeline_frozen_milestone','M5')`; the M1/M4 seeds are untouched (each slice
gets its own keys — the events-db precedent). Times are ACTION/EVENT times
rendered on the FE run monitor, so **epoch-ms INTEGERs** (`*_ms`, the migration
0002/0003 precedent).

### 10.2 `pipeline_definition`

The SAVED versioned JSON DAG document (dag-schema.md v1), stored verbatim.

```sql
CREATE TABLE pipeline_definition (
  id             TEXT PRIMARY KEY CHECK (length(id) > 0),         -- harness id, newId('wf')
  name           TEXT NOT NULL CHECK (length(trim(name)) > 0),    -- identifier-free [X2]
  document_json  TEXT NOT NULL CHECK (length(document_json) > 0), -- the full DAG doc, verbatim
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),     -- re-validated on load (forward-incompat)
  schema_hash    TEXT NOT NULL CHECK (length(schema_hash) > 0),   -- sha256(document_json), pinned into runs
  created_at_ms  INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms  INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;
```

Accessor: `upsert` overwrites by id (a save), preserving `created_at_ms`; the
definition `name` passes the §7.2 insert-time identity screen [X2].

### 10.3 `pipeline_run`

One run of a definition (findings §R3 `workflow_run`).

```sql
CREATE TABLE pipeline_run (
  id                 TEXT PRIMARY KEY CHECK (length(id) > 0),     -- harness id, newId('run')
  pipeline_id        TEXT NOT NULL REFERENCES pipeline_definition(id),
  schema_hash        TEXT NOT NULL CHECK (length(schema_hash) > 0), -- the doc hash this run PINNED (drift)
  inputs_json        TEXT,                                        -- bound inputs (identifier-tagged)
  workstream_id      TEXT,                                        -- X4 subgraph assignment
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
```

### 10.4 `step_attempt` — THE memoization journal

The durable journal (findings §R3 `step_attempt`, "step id + input hash →
cached output"): **append-only**, keyed for cross-restart resume by
`(run_id, step_id, iteration, input_hash)`.

```sql
CREATE TABLE step_attempt (
  id                 TEXT PRIMARY KEY CHECK (length(id) > 0),     -- harness id, newId('sa')
  run_id             TEXT NOT NULL REFERENCES pipeline_run(id),
  step_id            TEXT NOT NULL CHECK (length(step_id) > 0),   -- the DAG step id (not an FK)
  iteration          INTEGER NOT NULL DEFAULT 0 CHECK (iteration >= 0),  -- forEach/loop iteration
  attempt            INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),    -- retry attempt (0 = first)
  input_hash         TEXT NOT NULL CHECK (length(input_hash) > 0), -- THE memoization key: sha256(resolved inputs)
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','blocked','running','awaiting-approval',
                                       'completed','memoized','failed','skipped','cancelled')),
  session_id         TEXT,                                        -- the spawned session_node (workflow edge target); not an FK
  -- account: nullable; built-in open form (0005) OR a non-empty label OUTSIDE
  -- the built-in forms — a REGISTERED 4th backend's own label (0009, §10.9).
  -- No backend column here, so the relaxation is keyed on the LABEL FORM; the
  -- app layer's registry-aware isAccountLabel() is the authoritative value gate.
  account            TEXT CHECK (account IS NULL
                       OR (account GLOB 'MAX_[A-Z]' OR account IN ('ENT','AWS_DEV','LOCAL'))
                       OR (length(account) > 0
                           AND account NOT GLOB 'MAX_[A-Z]'
                           AND account NOT IN ('ENT','AWS_DEV','LOCAL'))),
  output_json        TEXT,                                        -- the outputSchema-validated result (identifier-tagged)
  cost_estimated_usd REAL CHECK (cost_estimated_usd IS NULL OR cost_estimated_usd >= 0),
  tokens_in          INTEGER CHECK (tokens_in IS NULL OR tokens_in >= 0),
  tokens_out         INTEGER CHECK (tokens_out IS NULL OR tokens_out >= 0),
  error_kind         TEXT,                                        -- identifier-free failure class [X2]
  started_at_ms      INTEGER CHECK (started_at_ms IS NULL OR started_at_ms >= 0),
  finished_at_ms     INTEGER CHECK (finished_at_ms IS NULL OR finished_at_ms >= 0),
  created_at_ms      INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT;
CREATE UNIQUE INDEX step_attempt_identity_idx ON step_attempt (run_id, step_id, iteration, attempt);
CREATE INDEX step_attempt_memo_idx    ON step_attempt (run_id, step_id, iteration, input_hash);
CREATE INDEX step_attempt_run_idx     ON step_attempt (run_id);
CREATE INDEX step_attempt_session_idx ON step_attempt (session_id) WHERE session_id IS NOT NULL;
```

Rules (accessor-enforced, tested — pipelines.ts):

- **THE resume lookup** (`findMemoized(runId, stepId, iteration, inputHash)`):
  the newest COMPLETED attempt (`completed` or `memoized`) for a matching key
  returns its cached `output_json` — the runner SKIPS re-execution (the M5 DoD;
  durable across harness restarts, immune to the compaction-relocation bug class
  of native #65796). A miss on a different `input_hash` (input changed) or on a
  `failed` attempt correctly re-executes.
- **Append-only** (`step_attempt_identity_idx` UNIQUE): a retry appends a NEW
  row (`attempt+1`); recording an existing `(run, step, iteration, attempt)`
  throws — the journal never overwrites history.
- **[X2]:** `account` is the placeholder FORM, CHECK-enforced (built-in open
  form OR a registered backend's own label, §10.9; the registry-aware
  `isAccountLabel()` is the authoritative value gate — an EMPTY account is still
  DB-refused); the definition `name` is identity-screened; `document_json` /
  `inputs_json` / `output_json` are machine-local content, `identifier`-tagged
  (`PIPELINES_FIELD_TAGS`) for redaction — brief/prompt bodies legitimately carry
  paths, exempt from the insert-time identity screen (the events §7.6 precedent).

### 10.5 The `workflow`-edge + cost seams (verified, no amendment)

Findings §R3: each step attempt is a `session_node` with `workflow`
`session_edge`s to its successors; per-step cost lands in the events store.
This freeze VERIFIED both seams are complete without a schema change: the
`workflow` edge type has been in the frozen `session_edge` vocabulary since M4
(§8.5), and the accessor accepts a step→successor `workflow` edge (not import →
from required; not handoff → no mandatory brief; not continue → no self-edge).
Per-step cost keys the events `(backend, raw_ref)` dedupe (§7.2) as
`pipeline:<runId>:<stepId>:<iteration>` — distinct iterations are distinct keys;
retry-safe re-ingest dedupes. The pipeline runner (BE-8) records these directly
(NOT via the LineageRecorder port, which is for kernel session actions —
ws-protocol.md §15.1 / dag-schema.md §6).

## 10.7. Migrations 0005 / 0006 `account-registry-open-form` — the [X1] relaxation — FROZEN (M7)

**Why.** The account-label CHECK constraints were pinned to the CLOSED 5-literal
set. The owner can provision arbitrarily many Claude Max subscriptions (the
keychain isolation scales automatically), so the closed set made a new account
invisible without a schema change. ICR-0013 RELAXES the label CHECK to the OPEN,
validated FORM — mirroring the protocol's `CLAUDE_ACCOUNT_LABEL_RE` (`^MAX_[A-Z]$`).

**The relaxed predicate** (SQLite `GLOB`, which treats `_` literally and `[A-Z]`
as a case-sensitive char class — a faithful SQL mirror of the regex):

```sql
account GLOB 'MAX_[A-Z]' OR account IN ('ENT','AWS_DEV','LOCAL')   -- the label form
-- pairing (unchanged rule, GLOB form):
((account GLOB 'MAX_[A-Z]' OR account = 'ENT') AND backend = 'claude_code')
  OR (account = 'AWS_DEV' AND backend = 'opencode')
  OR (account = 'LOCAL'   AND backend = 'lmstudio')
```

- **Migration 0005** (kernel DB, `KERNEL_MIGRATIONS`) rebuilds `account_profiles`,
  `resume_ledger`, `session_node`, and `step_attempt` (nullable account) with the
  relaxed CHECK. Bumps `schema_meta` `ddl_version=5`, `frozen_milestone=M7`.
- **Migration 0006** (events DB, `EVENTS_STORE_MIGRATIONS`) rebuilds `events`
  (pairing preserved), `quota_snapshots`, `session_outcomes`. Bumps
  `events_ddl_version=2`, `frozen_milestone=M7`.

**Why a table rebuild + WHY it is safe.** SQLite cannot `ALTER` a CHECK, so each
affected table is recreated / copied / dropped / renamed. The migrate runner
wraps `up` in `BEGIN…COMMIT` with `foreign_keys=ON`, where `PRAGMA foreign_keys`
is a no-op — so 0005 uses `PRAGMA defer_foreign_keys=ON` (which DOES apply inside
a txn, deferring enforcement to COMMIT). For the one inbound-FK table
(`session_node ← session_edge`), the OLD table is renamed aside first (SQLite
auto-rewrites `session_edge`'s FK to the temp name), its indexes are dropped so
the rebuilt table can reclaim the names, the new table is built under the real
name + copied, then `session_edge` is rebuilt to re-point its FK at the real
name, and the temp is dropped. `PRAGMA foreign_key_check` is clean at COMMIT.
The seed rows, all indexes, and the label↔backend pairing are preserved; the
frozen migrations 0001–0004 are NOT edited. Proven by the `migrate.spec` /
`kernel.spec` / `events.spec` suites (seeded-with-FK-data apply; MAX_C admitted;
HACKER + pairing-violation rejected post-migration).

**Defense-in-depth, preserved.** The app-layer accessors already enforce the
form + pairing (`isAccountLabel` + `backendForLabel`); the DB CHECK is the
second line so even a bypassing writer cannot land `HACKER` or a mispaired row.

## 10.8. Migrations 0007 / 0008 `backend-registry-open-set` — the [X1] BACKEND relaxation — FROZEN (M8)

**Why.** The `backend` CHECK constraints (and the label↔backend pairing +
`substrate != 'pty' OR backend='claude_code'` CHECKs) were pinned to the CLOSED
3-literal set `('claude_code','opencode','lmstudio')`. Finding OS-1: adding a
fourth local LLM / backend was therefore a DB-level fork — a valid registered
backend id (`vocab.ts` `registerBackend`, ICR-0016) would be REFUSED by the
frozen CHECK. Migrations 0007/0008 relax the backend clauses so a registered
backend lands with NO schema change, while keeping every BUILT-IN invariant
CHECK-enforced.

**THE CHECK-DERIVATION DECISION.** A SQLite CHECK is static SQL and CANNOT query
the runtime `BackendDescriptor` registry, so option (a) "derive the set from one
generated constant" is not achievable as a live DB check for an OPEN set. We
take the M3-events precedent for open vocabularies (`event_type`, `model`,
`provider` are un-CHECK'd; the accessor screens them): the backend/source VALUE
set moves to the APP LAYER (the accessor's `isBackend` consults the registry at
insert; `backendForLabel` enforces pairing; `substrateLegalFor` enforces the pty
rule). The DB retains a NON-EMPTY guard + the BUILT-IN pairing/pty clauses as
defense-in-depth. This is decision **(b)** in the OS-1 contract (app-layer
validated insert + drop the closed DB enum), NOT a generated-constant CHECK.

**The relaxed predicates** (SQLite; `NOT IN` the three built-in ids selects the
"registered backend" branch, which defers to the app layer):

```sql
backend TEXT NOT NULL CHECK (length(backend) > 0)              -- open, non-empty
source  TEXT NOT NULL CHECK (length(source)  > 0)              -- events only; open
-- account: built-in open form OR (non-empty AND non-built-in backend):
(account GLOB 'MAX_[A-Z]' OR account IN ('ENT','AWS_DEV','LOCAL'))
  OR (length(account) > 0 AND backend NOT IN ('claude_code','opencode','lmstudio'))
-- pairing: built-in triples for built-in backends, else defer to the app layer:
backend NOT IN ('claude_code','opencode','lmstudio')
  OR ((account GLOB 'MAX_[A-Z]' OR account = 'ENT') AND backend = 'claude_code')
  OR (account = 'AWS_DEV' AND backend = 'opencode')
  OR (account = 'LOCAL'   AND backend = 'lmstudio')
-- pty (resume_ledger): claude-only for built-ins, else defer:
substrate != 'pty' OR backend = 'claude_code'
  OR backend NOT IN ('claude_code','opencode','lmstudio')
```

- **Migration 0007** (kernel DB, `KERNEL_MIGRATIONS`) rebuilds the three
  `backend`-carrying tables — `account_profiles`, `resume_ledger`, `session_node`
  (the inbound-FK table, same `defer_foreign_keys` + rename-old-aside +
  child-re-point recipe as 0005). `step_attempt` was SKIPPED here on the "no
  backend column" reasoning — but its `account` CHECK still needed the
  registered-backend clause; migration **0009** (§10.9) closes that gap. Bumps
  `schema_meta` `ddl_version=7`, `frozen_milestone=M8`.
- **Migration 0008** (events DB, `EVENTS_STORE_MIGRATIONS`) rebuilds `events`
  (relaxes `backend`, `source`, account, and pairing). `quota_snapshots` /
  `session_outcomes` have no backend/source column and are NOT rebuilt (a
  registered backend feeds only the `events` table). Bumps
  `events_ddl_version=3`, `frozen_milestone=M8`.

**Why the account CHECK also relaxes here.** A registered backend, by definition,
serves account labels OUTSIDE the built-in `MAX_<X>`/`ENT`/`AWS_DEV`/`LOCAL`
forms (its descriptor's `servesLabel`). The OS-1 goal is unreachable if the
account CHECK still pins the built-in form — the row would be DB-refused though
the app layer admits it. So the account CHECK becomes "built-in form OR
(non-empty AND backend is not built-in)": the M7 open form stays enforced for the
built-in backends (byte-identical) and is a strict SUBSET of what the relaxed
CHECK admits — every M1–M7 row still validates.

**Safety + proof.** Same table-rebuild-is-safe reasoning as 0005 (SQLite cannot
ALTER a CHECK; `defer_foreign_keys` for the FK table; `foreign_key_check` clean at
COMMIT). Seed rows, all indexes, and the account CHECK (open MAX_<X> form) are
preserved; frozen migrations 0001–0006 are NOT edited. Proven by `migrate.spec`
(kernel ids `[1,3,4,5,7]` durable across REOPEN), `kernel.spec` (a registered
4th backend `synthbackend`/`SYNTH_L` lands end-to-end via the accessor; an
empty backend + a built-in pairing violation still rejected by the DDL), and
`events.spec` (a registered-4th-backend `events` row lands; unregistered
refused). The kernel accessor's pty rule now routes through
`substrateLegalFor` (registry-driven) — built-in behaviour byte-identical.

## 10.9. Migration 0009 `backend-registry-open-set-step-attempt` — the step_attempt amendment — FROZEN (M8)

**Why.** Migration 0007 (§10.8) relaxed the three `backend`-carrying kernel
tables but explicitly SKIPPED `step_attempt` on the reasoning "no backend
column". That overlooked that `step_attempt.account` (from 0004, rebuilt to the
open M7 form by 0005) still admits ONLY the built-in account-label forms —
`account IS NULL OR (account GLOB 'MAX_[A-Z]' OR account IN
('ENT','AWS_DEV','LOCAL'))`. A REGISTERED 4th backend serves its OWN
account-label form (e.g. `SYNTH_L`), which the built-in regex cannot express, so
a full pipeline RUN on a 4th-backend account was refused at the FIRST journal
write (`step_attempt.record` → `CHECK constraint failed: account IS NULL ...`)
even though the runner's `resolveBackend` already routed the label through the
registry with no core branch and 0007/0008 already accepted the label in the
lineage/events stores. The OS-1 goal — a 4th backend lands with NO schema change
— was unreachable while `step_attempt` stayed pinned.

**What changes.** Migration **0009** (kernel DB, `KERNEL_MIGRATIONS`) rebuilds
`step_attempt` (straight create-new / copy / drop / rename — no inbound FK; the
outbound FK to `pipeline_run(id)` and all four indexes are preserved verbatim)
with only its nullable `account` CHECK widened, exactly as 0008 widened
`events.account` — but keyed on the LABEL FORM, since this table carries NO
backend column to gate on:

```sql
account IS NULL
  OR (account GLOB 'MAX_[A-Z]' OR account IN ('ENT','AWS_DEV','LOCAL'))  -- built-in form (0005)
  OR (length(account) > 0                                                -- a registered 4th
      AND account NOT GLOB 'MAX_[A-Z]'                                   --   backend's own
      AND account NOT IN ('ENT','AWS_DEV','LOCAL'))                      --   label
```

The M7 form is a strict SUBSET of what this admits — every M1–M8 row (built-in
labels + NULL) validates byte-identically. The third clause newly admits a
registered backend's label. Consistent with the §10.8 CHECK-derivation decision:
the VALUE-set gate for a non-built-in label is the app layer's registry-aware
`isAccountLabel()` (enforced at `stepAttempts.record`/`complete`); the DB keeps
the NULL + built-in-form clauses as defense-in-depth so an EMPTY account is still
refused. Bumps `schema_meta` `ddl_version=9` (milestone stays `M8` — same
ICR-0016 freeze).

**Proof.** `pipelines.spec` (a registered `synthbackend`/`SYNTH_L` step attempt
lands via `record` + `complete`; the built-in form + NULL still admitted; an
unregistered `SYNTH_L` refused by the app-layer gate), `migrate.spec` (kernel
ids `[1,3,4,5,7,9]` durable across REOPEN), `kernel.spec` (`ddl_version=9`), and
core `backendRegistryRoute.spec` (a full engine RUN on `SYNTH_L` now COMPLETES
end-to-end with the attempt journaled under `SYNTH_L` — NO core edit). Frozen
migrations 0001–0008 are NOT edited.

## 11. Amendment record

| Date | Change | ICR |
|---|---|---|
| 2026-07-04 | Initial M1 freeze (engine, runner discipline, migration 0001, state machine, tags) | — (the freeze itself) |
| 2026-07-04 | §4: documented the kernel pid-liveness guard proving the "child death" precondition of `running → resumed` (pid+nonce probe when recorded; SDK stdio-pipe-lifetime reasoning when pid is NULL). No DDL or transition change. | [ICR-0005](icr/icr-0005-pid-liveness-guard.md) |
| 2026-07-04 | **M3 events-store freeze (§7).** Migration 0002 `events-store-init`: `events` fact table (dedupe UNIQUE (backend, raw_ref); label-enum + label↔backend pairing CHECKs [X2]; four token classes + 5m/1h TTL split + reasoning; `cost_estimated_usd` vs `cost_actual_usd` backfill target; latency/TTFT; tool/skill/agent/mcp attribution; `error_kind` enum; `file_refs`/`raw_ref`) + `quota_snapshots` + `session_outcomes` + `prices` (override-wins pinning). Decisions recorded: SEPARATE collector-owned database `~/.aibender/db/events.db` via the `EVENTS_STORE_MIGRATIONS` sibling list (§7.1, blueprint §6.2 "owned by the collector"; repo-wide-unique migration ids); epoch-ms integers for event-time columns (§7.2, wire-aligned); insert-time identity-shape screen on semantic columns with path/JSON columns `identifier`-tagged instead (§7.2/§7.6). Migration 0001 and KERNEL_MIGRATIONS untouched. | — (M3 freeze; plan §3 schema row) |
| 2026-07-04 | §7.4 **usage-data mapping clarification** (prose only, NO DDL change; the interpretation question raised in the BE-5 M3 return): facets → `session_outcomes` (the assessment row); session-meta → `events` with `event_type 'session_meta'` (token totals, no outcome — never mirrored into `session_outcomes`, whose `outcome` is NOT NULL by design). Blesses the landed normalizer (core/src/collector/jsonl/usageData.ts). | — (BE-ORCH steward, prose pin) |
| 2026-07-04 | **M4 lineage freeze (§8).** Migration 0003 `lineage-tables-init`: `workstream` (status enum, JSON tags) + `session_node` (HARNESS id PRIMARY — the resume-ledger id for kernel launches, reconciler-minted for external; native id a nullable write-once ATTRIBUTE; label-enum + pairing CHECKs [X2]; lineage state/origin/confidence enums; mutable `native_scope` for `/cd`; token/cost snapshots) + `brief` (kind session-end·pre-compact·session-start-injection·merge; provenance native-summary·local-draft·refined; body `identifier`-tagged) + `session_edge` (edge_type EXACTLY continue·fork·merge_parent·compact·sidechain·handoff·import·workflow; from/import + handoff-brief CHECK matrices; continue self-edges legal). Decisions recorded: **KERNEL DATABASE via KERNEL_MIGRATIONS** (§8.1 — action-time recording shares the kernel's commit boundary; lineage writes are resume-ledger-rate; the SessionIdResolver join is single-db; repo-wide-unique migration ids 0001/0002/0003); epoch-ms integers for lineage times (§8.1); accessor-enforced edge legality + ATOMIC `recordMerge` (§8.5); naming-column identity screen + `LINEAGE_FIELD_TAGS` (§8.6). `schema_meta` gains lineage keys, M1 seeds untouched. Migrations 0001/0002 untouched; `openKernelStore` now also hands back the `lineage` accessors. | — (M4 freeze; plan §3 schema row) |
| 2026-07-04 | **M5 pipeline freeze (§10).** Migration 0004 `pipeline-tables-init`: `pipeline_definition` (the saved versioned JSON DAG document verbatim + schema_version re-validated on load + schema_hash for drift) + `pipeline_run` (status enum pending·running·paused·completed·failed·cancelled; pinned schema_hash; inputs/workstream) + `step_attempt` = **THE memoization journal** (append-only via UNIQUE (run_id, step_id, iteration, attempt); the resume lookup `findMemoized(run,step,iteration,input_hash)` returns a COMPLETED/`memoized` attempt's cached output → no re-execution, the M5 DoD; state enum incl. `blocked`/`awaiting-approval`/`memoized`/`skipped`; nullable session_id = the spawned node / workflow-edge target; label-enum account CHECK [X2]). Decisions recorded: **KERNEL DATABASE via KERNEL_MIGRATIONS** (§10.1 — same commit boundary + query plan as the `workflow`-edge session_nodes each attempt produces; journal writes are resume-ledger-rate; repo-wide-unique migration ids 0001/0002/0003/0004); epoch-ms integers (§10.1); `PIPELINES_FIELD_TAGS` on document/inputs/output JSON, definition name identity-screened (§10.4). Verified sufficient, NO change: the `workflow` edge type (in the frozen §8.5 vocabulary since M4) + the events `(backend, raw_ref)` dedupe key carry the per-step lineage + cost seams (§10.5). `schema_meta` gains pipeline keys, M1/M4 seeds untouched. Migrations 0001/0002/0003 untouched; `openKernelStore` now also hands back the `pipelines` accessors. | — (M5 freeze; plan §3 schema row) |
| 2026-07-05 | **M7 account-registry relaxation (§10.7).** Migrations **0005** `account-registry-open-form` (kernel: `account_profiles`, `resume_ledger`, `session_node` [inbound-FK table-rebuild with `defer_foreign_keys` + child re-point], `step_attempt`) and **0006** `account-registry-open-form-events` (events: `events`, `quota_snapshots`, `session_outcomes`) RELAX the account-label CHECK from the CLOSED 5-literal set to the OPEN form `account[_label] GLOB 'MAX_[A-Z]' OR IN ('ENT','AWS_DEV','LOCAL')` — the SQL mirror of `CLAUDE_ACCOUNT_LABEL_RE` — so a newly provisioned Claude Max account (MAX_C, MAX_D, …) is admitted WITHOUT a schema change ([X1]). The label↔backend pairing CHECK is preserved verbatim (GLOB form); seed rows + all indexes preserved; frozen migrations 0001–0004 untouched. `schema_meta`: kernel `ddl_version=5`/`frozen_milestone=M7`, events `events_ddl_version=2`/`frozen_milestone=M7`. | [ICR-0013](icr/icr-0013-account-registry.md) |
| 2026-07-05 | **M8 backend-registry relaxation (§10.8; finding OS-1).** Migrations **0007** `backend-registry-open-set` (kernel: `account_profiles`, `resume_ledger`, `session_node` [same inbound-FK rebuild recipe as 0005]) and **0008** `backend-registry-open-set-events` (events: `events`) RELAX the `backend` CHECK from the CLOSED 3-literal set to `length(backend) > 0` (the events `source` too), and relax the account + label↔backend pairing + pty CHECKs to "built-in clauses hold for the built-in backends, OR the backend is NOT one of the three built-ins" — so a REGISTERED 4th backend (`vocab.ts` `registerBackend`, ICR-0016) lands WITHOUT a schema change ([X1]). The CHECK-derivation decision (§10.8): a SQLite CHECK cannot query the runtime `BackendDescriptor` registry, so the backend/source VALUE set moves to the app-layer validated insert (`isBackend`/`isEventSource`/`backendForLabel`/`substrateLegalFor`) — the M3-events open-vocabulary precedent — while the built-in pairing/pty clauses stay CHECK-enforced (defense-in-depth, byte-identical). `step_attempt`/`quota_snapshots`/`session_outcomes` have no backend/source column and are NOT rebuilt. Seed rows + indexes + the account (open MAX_<X>) form preserved; frozen migrations 0001–0006 untouched. `schema_meta`: kernel `ddl_version=7`/`frozen_milestone=M8`, events `events_ddl_version=3`/`frozen_milestone=M8`. | [ICR-0016](icr/icr-0016-backend-registry.md) |
| 2026-07-05 | **M8 backend-registry — `step_attempt` amendment (§10.9; finding OS-1).** Migration **0009** `backend-registry-open-set-step-attempt` (kernel, `KERNEL_MIGRATIONS`) closes the table 0007 explicitly SKIPPED: it rebuilds `step_attempt` (no inbound FK; outbound FK + all indexes preserved) with only its nullable `account` CHECK widened — `account IS NULL OR (built-in open MAX_<X> form) OR (length(account) > 0 AND NOT built-in form)`. Keyed on the LABEL FORM (this table has NO backend column), so a REGISTERED 4th backend's own account label (e.g. `SYNTH_L`) is admitted at the journal write WITHOUT a schema change ([X1]); the M7 form is a strict subset (every M1–M8 row still validates byte-identically). Consistent with the §10.8 decision: the registry-aware `isAccountLabel()` is the authoritative value gate at `stepAttempts.record`/`complete`; the DB keeps the NULL + built-in-form clauses as defense-in-depth (an EMPTY account still refused). Frozen migrations 0001–0008 untouched. `schema_meta`: kernel `ddl_version=9`/`frozen_milestone=M8` (same ICR-0016 freeze). Proof: `pipelines.spec` (SYNTH_L lands via record+complete; built-in + NULL preserved; unregistered refused), `migrate.spec` (kernel ids `[1,3,4,5,7,9]`), core `backendRegistryRoute.spec` (a full engine run on SYNTH_L now COMPLETES end-to-end, NO core edit). | [ICR-0016](icr/icr-0016-backend-registry.md) |
