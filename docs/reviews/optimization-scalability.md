# Stage-3 Review — Optimization & Scalability

Read-only principal-engineer review at `HEAD ≈ 3af781b` (protocol 1.5.0 /
FROZEN-M7, schema migration 0006). This dimension's reviewer crashed in the
main `stage3-review` run (StructuredOutput retry cap); it was re-run as a
focused follow-up and its three HIGH findings were **independently
re-verified against the cited code by the driving session** (see verdicts).

[X2]: identities appear only as placeholder labels (`MAX_A..MAX_Z`, `ENT`,
`AWS_DEV`, `LOCAL`). No real identifier appears here.

The framing question for this dimension (plan Stage 3): *is it easy to add a
new Claude account, and a new local LLM?* The account half is **yes** (the M7
registry generalization). The **backend/local-LLM half is now also yes** — OS-1
is **FIXED** (the OS-1 backend-registry workflow, ICR-0016): a `BackendDescriptor`
+ `registerBackend()` registry, migrations 0007/0008/0009 moving the backend
CHECK to the app layer, and a proven synthetic 4th-backend end-to-end route with
no branch edit. See the finding below and
[../runbooks/os1-backend-registry.md](../runbooks/os1-backend-registry.md).

---

## Findings (6): 3 high · 2 medium · 1 low

### OS-1 (HIGH — confirmed, gate-verified) — **FIXED (ICR-0016)** — Adding a new local backend is a cross-codebase fork; no adapter registry exists
> **RESOLUTION (OS-1 backend-registry workflow, ICR-0016, protocol 1.6.0 / FROZEN-M8).**
> `vocab.ts` now carries a `BackendDescriptor` (id, `servesLabel`, `sourceName`,
> `substrates`, `builtin`, optional adapter/probe keys) + a registry
> (`registerBackend` / `backendById` / `allBackends` / `unregisterBackend`)
> pre-seeded with the three built-ins; `isBackend` tests registry membership;
> `backendForLabel` / `isAccountLabel` / `sourceForBackend` / `substrateLegalFor`
> resolve through the descriptors. `sourceForBackend` moved from the
> `lineageCost.ts` if-chain into the registry; `projections.ts` local-offload
> classifies by the descriptor's `sourceName`, not `=== 'lmstudio'`. Migrations
> **0007** (kernel) / **0008** (events) / **0009** (step_attempt) relaxed every
> `backend`-pinned CHECK to a non-empty guard + built-in defense-in-depth, with
> the value set gated at the app layer (the M3-events open-vocabulary precedent),
> so a new backend needs **no** migration. Proven: a synthetic 4th backend
> registers and routes end-to-end (vocab → pipeline cost → read-model → schema →
> FE render) with no branch edit (`core/src/pipelines/backendRegistryRoute.spec.ts`,
> `packages/testkit/src/wsGolden.spec.ts` register→replay→unregister,
> `app/src/features/observability/fourthBackendRender.spec.tsx`); the built-in
> three are byte-identical (`app/src/lib/backendLabels.spec.ts`,
> `packages/schema/src/kernel.spec.ts` built-in pairing/pty CHECK still rejects an
> illegal built-in row). The remaining `=== 'claude_code'` sites are Claude-only
> ingest paths (`ingest.ts` OTel/JSONL joiner, `sessionKernel.ts`/`ptyHost.ts` pty)
> and registry-mediated semantic guards, not extension-blocking dispatch.
> **OS-2 and OS-6 are now RESOLVED (2026-07-05)** — see the ✅ resolution notes
> on each finding below. (OS-1, OS-3, OS-4, OS-5 were resolved earlier.)
- **Anchor:** `packages/protocol/src/vocab.ts:100` (`BACKENDS` frozen 3-tuple), `:194` (`backendForLabel` hardcoded if-chain), `:69` (`FIXED_BACKEND_LABELS` closed, "a new one would be a new backend, an ICR of its own").
- **Failure scenario:** to run Ollama directly, a 2nd OpenAI-compatible server, or LM Studio on a 2nd port as a *distinct* backend, one must edit a FROZEN protocol enum, ~42 non-spec files that branch on the `'claude_code'|'opencode'|'lmstudio'` literals (e.g. `lineageCost.ts` `sourceForBackend`, `projections.ts` `localTokens`, `ingest.ts`, `reconciler.ts`, `sessionKernel.ts`, `ptyHost.ts`), **and** add a schema migration to rebuild every account-pinned table — because every migration hardcodes `CHECK (backend IN ('claude_code','opencode','lmstudio'))` (verified in `0001-kernel.ts:48,74`, `0002-events.ts:63`, `0006-account-registry-events.ts:36`). This is exactly the extension cliff this dimension exists to catch — the *backend* twin of the account-label problem M7 just solved.
- **Gate verification:** CONFIRMED. `grep` counts **42** non-spec files referencing the backend literals; the migration CHECKs are present as cited.
- **Recommendation:** introduce a `BackendDescriptor` interface + `registerBackend()` map (id, label-matcher, adapter factory, source-name, health probe) so `backendForLabel`/`sourceForBackend`/collector+projection dispatch resolve through the registry instead of `=== 'lmstudio'` branches; derive the migration CHECK backend set from one generated constant. The `adapters/` dir already has symmetric per-backend factories to lift behind one interface. **This is the direct sequel to the M7 account-registry work** — same pattern, applied to backends.

### OS-2 (HIGH — confirmed, gate-verified) — Dashboard projections full-scan + JS-aggregate the entire window on every publish
- **Anchor:** `core/src/readmodels/projections.ts:147` (+`:196`, `:231`, `:292`, `:383`); `packages/schema/src/events.ts` `list()` = `SELECT <all cols> FROM events WHERE ts_ms>=? ORDER BY ts_ms,id` (no aggregation; LIMIT only if a filter passes one, and the projections pass none).
- **Failure scenario:** each of the 10 read-model projections calls `stores.events.list({ sinceTsMs })` over a 7–30 day window with **no SQL aggregation**, then does every group-by / sum / percentile / sort in JS. At 5→12 accounts each emitting `api_request` + tool/hook/otel rows, that materializes tens-of-thousands to millions of rows into JS objects and re-aggregates on **every** `publishAll()`. The `(account,ts_ms)`/`(ts_ms)` indexes can't cover a `SELECT *`. This is **design-latent**: `publishAll` is a pull seam not yet on a timer (`main/index.ts` config slice pending), so whatever cadence is chosen multiplies the cost.
- **Gate verification:** CONFIRMED (query shapes as cited; severity noted design-latent pending the publish-cadence decision).
- **Recommendation:** push aggregation into SQL (`GROUP BY`/`SUM`/percentile, or an incrementally-refreshed rollup table) + a covering index for the hot (account, ts_ms, token) path; bound each recompute to the dirty-account set so a tick is O(new rows), not O(window). Decide + document the publish cadence before a timer multiplies it.
- **✅ Resolution (2026-07-05, ICR-0017):** aggregation pushed into SQLite via a
  NEW additive read-only accessor `createEventsAggregatesStore(driver)` (the
  frozen `events.ts` write path untouched), threaded through the `EventsStore`
  bundle into `ReadModelStores`. The eight window-scanning leads no longer
  materialize the window as `EventRow`s (`SELECT *` → `eventFromSql` → 30-field
  objects + `JSON.parse`):
  - **COUNTs in SQL (O(groups))** — health (`CASE`-counts) and session-outcomes
    (`COUNT`) aggregate in SQLite; counts are bounded by the row count so they
    can never trip the marshaling limit below.
  - **Narrow scan + JS fold** — every other lead (cache-hit, local-offload,
    skill-leaderboard, burn-rate token sums; bedrock, api-equivalent, latency)
    takes a minimal-column scan (no `SELECT *`, no `eventFromSql`, no JSON parse)
    and folds token/USD/percentile arithmetic in JS. Token sums are deliberately
    NOT summed in SQL: the adversarial review's regression hunter proved a
    SQL-side `SUM(tokens)` (or a per-row 4-class sum) can cross 2^53, at which
    point node:sqlite (default non-BigInt) throws `ERR_OUT_OF_RANGE` — while the
    old JS path `Number()`d each safe (< 2^53) column and float-folded without
    throwing. Folding in JS over safe per-column values is byte-identical to the
    old fold (same order, same float semantics incl. past 2^53) and never throws.
    Float money likewise stays in JS (SQLite `SUM` is Kahan-compensated →
    last-ULP divergence).
  - **Byte-identical, proven** — grouped queries preserve the old first-appearance
    entry order via `ROW_NUMBER() OVER (ORDER BY ts_ms, id)` + `MIN(rn)`; a
    400-row seeded-corpus equivalence test (`packages/schema/src/eventsAggregates.spec.ts`,
    rows inserted OUT of ts order) checks every accessor field-for-field against a
    JS-over-`events.list()` reference. No wire change, no protocol bump, no
    golden-corpus change; the hand-checked `projections.spec.ts` is unchanged.
  - **Index / cadence decisions (documented, as the finding asked):** (1) *No new
    covering index* — the existing `events_ts_idx (ts_ms)` (rowid-appended, so it
    satisfies `ORDER BY ts_ms, id`) and `events_account_ts_idx (account, ts_ms)`
    serve the range scans; a covering `(account, ts_ms, <token cols>)` index was
    deferred because it adds write amplification on the high-volume collector DB
    for an index-only-scan win not yet shown necessary by N-account profiling.
    (2) *Publish cadence* — `publishAll()` remains a pull seam (not yet on a
    timer; the `main/index.ts` config slice is still pending). The recommended
    cadence when it is wired: a debounced coalescing tick (~a few seconds) plus
    on-demand, NOT per-event. With aggregation now O(groups)+narrow-O(rows) per
    tick rather than O(window)-materialized-in-JS, cadence no longer multiplies a
    heavy cost. (3) *Dirty-account incremental recompute* — the further "O(new
    rows) not O(window)" step is intentionally left for when the timer lands: it
    turns the pure projection functions stateful (a per-account rollup + watermark),
    which is premature before the cadence exists. The SQL push already removes the
    JS-materialization blow-up that was the finding's core.

### OS-3 (HIGH — confirmed, gate-verified) — Per-account JSONL watcher does a synchronous recursive dir walk every 2 s
- **Anchor:** `core/src/collector/jsonl/accountWatcher.ts:66` (`listFilesRecursive` = `readdirSync(root, { recursive: true })`), `:214` (called from `scan()`), `:228-236` (`start(pollMs=2000)` → `setInterval`).
- **Failure scenario:** `~/.claude/projects/` grows monotonically for a heavy user (one dir per project-cwd, a `.jsonl` per session — thousands of files). One watcher runs **per Claude account**. At 12 accounts that's 12 **synchronous** full-subtree `readdir` walks + per-file `statSync` **every 2 s on the broker's main event loop**, blocking the latency-critical row-before-spawn path. The tailer comment confirms the interval poll is the source of truth (fs.watch is only an optional wake-up).
- **Gate verification:** CONFIRMED (synchronous `readdirSync({recursive:true})` on a 2 s interval, per-account, as cited).
- **Recommendation:** stop re-walking the whole tree every tick — track known files and re-scan only mtime-touched dirs, or drive scans off FSEvents/`fs.watch` with the full walk as a 30–60 s reconcile; offload the walk+stat to a worker thread or async `opendir`; stagger/interval-scale per-account scans by account count.

### OS-4 (MEDIUM — reviewer-reported, anchored) — [X1] supervision budget scoped to 3 accounts, not generalized to N
- **Anchor:** `core/src/supervision/scheduler.ts:169` (`admitSpawn` always admits account spawns even at red), `:117-119` (`planShed` never selects an account session), `hibernation.ts:7-9` (idle hibernation never applied to account sessions).
- **Failure scenario:** the blueprint §11 invariants ("3 account sessions ~1.2 GB", "never the victim", ceiling 8–10 resident) were written for 3 accounts. M7 generalized the account *registry* to N but the supervision *budget model* did not: with ~12 simultaneously-active accounts (~12×3 GB) the operator can exhaust the entire shed order and still be forced past red / past the ~17 GB envelope, because nothing caps or pushes back on account-session count, and the one machine-level relief (idle hibernation) is explicitly forbidden for account sessions.
- **Recommendation:** generalize the [X1] budget from "3 accounts" to N — a resident-account soft ceiling (derived from the pressure/footprint budget) above which even account spawns get an amber advisory / confirm; allow *checkpoint-hibernation* of idle account sessions under sustained red (the resume ledger already supports resume). Document the N-account budget math in blueprint §11 so "account spawns always honored" is bounded by a resident cap, not unbounded. **Ties the M6 supervision work to the M7 registry.**

### OS-5 (MEDIUM — reviewer-reported, anchored) — GraphStore grows unbounded; the renderer's 5k-node ceiling is not enforced upstream
- **Anchor:** `app/src/islands/graph/store.ts:27` (graphology `UndirectedGraph`, no prune/evict/TTL — only listener removal at `:176`); renderer/worker are built for the 5k regime (`layout.worker.ts:6`, `pixiRenderer.ts:303-305` halo-cull cites "the 5k ceiling").
- **Failure scenario:** a node is added per touched file-path/session from `context-touch` events and never pruned. A long-lived cockpit over a large workspace (many files × sessions × 12 accounts) accumulates well past 5k nodes; the off-thread layout tick and per-frame edge rebuild degrade superlinearly and the Float32Array epoch grows with it — beyond the regime the pipeline was spike-proven for.
- **Recommendation:** enforce the 5k regime where data enters — LRU/recency eviction on the GraphStore (drop least-recently-touched nodes + incident edges past a configurable ceiling, emitting removal batches the renderer can already consume) and/or clamp what the collector graphfeed emits; surface an "older context elided" affordance.

### OS-6 (LOW — reviewer-reported, anchored) — ApiRequestJoiner pending map is unbounded and full-copied per flush
- **Anchor:** `core/src/collector/ingest.ts:138` (pending `Map` keyed on request_id, 120 s window at `:136`), `:250` (`flush()` snapshots the whole map with `[...pending.entries()]`).
- **Failure scenario:** if one join half stops arriving (OTLP receiver down / port-in-use, or a JSONL-only burst), unmatched halves accumulate until flush; with 12 accounts feeding one joiner and an imbalanced source, `pending.size` and the per-flush array copy grow with the imbalance, not a fixed bound.
- **Recommendation:** hard-cap the pending map with oldest-half eviction (flush the evicted half as single-source, counted in stats); drive flush on a timer independent of ingest; avoid the full-array spread copy.
- **✅ Resolution (2026-07-05, `core/src/collector/ingest.ts`):** all three, landed
  together:
  - **Hard cap** — new `maxPending` option (default 50 000). Before buffering a
    NEW `request_id`, the OLDEST pending half is evicted (Map insertion order → the
    first key is the oldest-buffered), flushed as an honest single-source row and
    counted in a new `evicted` stat (also in `jsonlOnly`/`otelOnly`, since it lands
    as a single-source row). A late twin still dedupes onto the canonical
    `api_request:<id>` raw_ref, so eviction can never double-count tokens.
  - **Independent timer** — new opt-in `flushIntervalMs` runs the joiner's own
    `flush()` off an `unref`'d interval, independent of ingest arrival; a new
    idempotent `close()` clears it. Off by default (byte-identical to the prior
    caller-driven cadence).
  - **No full-array copy** — `flush()` no longer does `[...pending.entries()]`; it
    collects only the expired keys in one pass, then deletes — O(expired), not a
    whole-map snapshot per flush.
  - Proven by four new `ingest.spec.ts` cases (cap eviction bounds `pendingCount`;
    cap-evicted half dedupes a late twin; the timer flushes with no ingest and
    `close()` stops it; `close()` is a safe no-op without a timer).

---

## Confirmed SOUND (not findings — recorded to prevent re-flagging)

1. **Schema DOES scale to N accounts** — migrations 0005/0006 correctly widen every *account* CHECK to `account GLOB 'MAX_[A-Z]' OR account IN ('ENT','AWS_DEV','LOCAL')`. (Note: this is the *account* CHECK; the *backend* CHECK is the separate OS-1 problem.)
2. **PTY BoundedAckRing flow control** (`core/src/kernel/pty/flowControl.ts`) — hard caps (4 MiB/2 MiB/512 KiB), zero byte loss, cap-breach-is-a-bug assertion. Well engineered for growth.
3. **FE RingBuffer + rAF batch** — fixed-capacity drop-oldest, sized ≥ broker cap. Sound.
4. **Graph layout+render pipeline** — genuinely well-built *within* its 5k regime (off-thread layout, transferable Float32Array epochs, 2 `stroke()`/frame edge batching, halo culling). The only gap is upstream ceiling enforcement (OS-5).
5. **OTLP receiver** — a SINGLE shared `127.0.0.1:4318` endpoint with `account=<LABEL>` attribution; does NOT fan out per account, so it scales fine to N (only the JSONL watcher fans out — OS-3).
6. **Dynamic FE panels** render `registry.entries.map(...)` — bounded by the small account count, not a scaling risk.

**Method:** static analysis only (read-only, no live app / no LM Studio), so latency claims are derived from query shapes + documented spike budgets, not measured. The three HIGH findings were re-verified against the cited code by the driving session before commit.
