# SQLite DDL contract — harness ledgers

> ## 🔒 FROZEN-M1 (kernel slice) — 2026-07-04
> **Owner: BE-ORCH.** After this banner, frozen sections change **only**
> through an interface change request ([docs/contracts/icr/](icr/README.md)).
> This contract is **amended per milestone** (plan §3): M3 appends the events
> store, M4 the X4 workstream tables, M5 the pipeline tables — each amendment
> lands as a NEW migration (never an edit to a frozen one) plus a new section
> here with its own freeze banner.
>
> The machine-checkable half is `packages/schema` (migration 0001 +
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

| Milestone | Tables (blueprint anchor) |
|---|---|
| M3 | `events`, `quota_snapshots`, `session_outcomes`, `prices` (§6.2) |
| M4 | `workstream`, `session_node`, `session_edge`, `brief` (§5) |
| M5 | workflow `runs`, `steps`, memoization journal (§7) |

Each lands as migration 000N appended to `KERNEL_MIGRATIONS` (or a sibling
list for a separate database file — decision at the owning milestone), plus a
frozen section here.

## 7. Amendment record

| Date | Change | ICR |
|---|---|---|
| 2026-07-04 | Initial M1 freeze (engine, runner discipline, migration 0001, state machine, tags) | — (the freeze itself) |
| 2026-07-04 | §4: documented the kernel pid-liveness guard proving the "child death" precondition of `running → resumed` (pid+nonce probe when recorded; SDK stdio-pipe-lifetime reasoning when pid is NULL). No DDL or transition change. | [ICR-0005](icr/icr-0005-pid-liveness-guard.md) |
