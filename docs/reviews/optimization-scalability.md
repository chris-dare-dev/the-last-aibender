# Stage-3 Review — Optimization & Scalability

Read-only principal-engineer review at `HEAD ≈ 3af781b` (protocol 1.5.0 /
FROZEN-M7, schema migration 0006). This dimension's reviewer crashed in the
main `stage3-review` run (StructuredOutput retry cap); it was re-run as a
focused follow-up and its three HIGH findings were **independently
re-verified against the cited code by the driving session** (see verdicts).

[X2]: identities appear only as placeholder labels (`MAX_A..MAX_Z`, `ENT`,
`AWS_DEV`, `LOCAL`). No real identifier appears here.

The framing question for this dimension (plan Stage 3): *is it easy to add a
new Claude account, and a new local LLM?* The account half is now **yes** (the
M7 registry generalization). The **backend/local-LLM half is still no** — see
OS-1, the highest-value finding here.

---

## Findings (6): 3 high · 2 medium · 1 low

### OS-1 (HIGH — confirmed, gate-verified) — Adding a new local backend is a cross-codebase fork; no adapter registry exists
- **Anchor:** `packages/protocol/src/vocab.ts:100` (`BACKENDS` frozen 3-tuple), `:194` (`backendForLabel` hardcoded if-chain), `:69` (`FIXED_BACKEND_LABELS` closed, "a new one would be a new backend, an ICR of its own").
- **Failure scenario:** to run Ollama directly, a 2nd OpenAI-compatible server, or LM Studio on a 2nd port as a *distinct* backend, one must edit a FROZEN protocol enum, ~42 non-spec files that branch on the `'claude_code'|'opencode'|'lmstudio'` literals (e.g. `lineageCost.ts` `sourceForBackend`, `projections.ts` `localTokens`, `ingest.ts`, `reconciler.ts`, `sessionKernel.ts`, `ptyHost.ts`), **and** add a schema migration to rebuild every account-pinned table — because every migration hardcodes `CHECK (backend IN ('claude_code','opencode','lmstudio'))` (verified in `0001-kernel.ts:48,74`, `0002-events.ts:63`, `0006-account-registry-events.ts:36`). This is exactly the extension cliff this dimension exists to catch — the *backend* twin of the account-label problem M7 just solved.
- **Gate verification:** CONFIRMED. `grep` counts **42** non-spec files referencing the backend literals; the migration CHECKs are present as cited.
- **Recommendation:** introduce a `BackendDescriptor` interface + `registerBackend()` map (id, label-matcher, adapter factory, source-name, health probe) so `backendForLabel`/`sourceForBackend`/collector+projection dispatch resolve through the registry instead of `=== 'lmstudio'` branches; derive the migration CHECK backend set from one generated constant. The `adapters/` dir already has symmetric per-backend factories to lift behind one interface. **This is the direct sequel to the M7 account-registry work** — same pattern, applied to backends.

### OS-2 (HIGH — confirmed, gate-verified) — Dashboard projections full-scan + JS-aggregate the entire window on every publish
- **Anchor:** `core/src/readmodels/projections.ts:147` (+`:196`, `:231`, `:292`, `:383`); `packages/schema/src/events.ts` `list()` = `SELECT <all cols> FROM events WHERE ts_ms>=? ORDER BY ts_ms,id` (no aggregation; LIMIT only if a filter passes one, and the projections pass none).
- **Failure scenario:** each of the 10 read-model projections calls `stores.events.list({ sinceTsMs })` over a 7–30 day window with **no SQL aggregation**, then does every group-by / sum / percentile / sort in JS. At 5→12 accounts each emitting `api_request` + tool/hook/otel rows, that materializes tens-of-thousands to millions of rows into JS objects and re-aggregates on **every** `publishAll()`. The `(account,ts_ms)`/`(ts_ms)` indexes can't cover a `SELECT *`. This is **design-latent**: `publishAll` is a pull seam not yet on a timer (`main/index.ts` config slice pending), so whatever cadence is chosen multiplies the cost.
- **Gate verification:** CONFIRMED (query shapes as cited; severity noted design-latent pending the publish-cadence decision).
- **Recommendation:** push aggregation into SQL (`GROUP BY`/`SUM`/percentile, or an incrementally-refreshed rollup table) + a covering index for the hot (account, ts_ms, token) path; bound each recompute to the dirty-account set so a tick is O(new rows), not O(window). Decide + document the publish cadence before a timer multiplies it.

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

---

## Confirmed SOUND (not findings — recorded to prevent re-flagging)

1. **Schema DOES scale to N accounts** — migrations 0005/0006 correctly widen every *account* CHECK to `account GLOB 'MAX_[A-Z]' OR account IN ('ENT','AWS_DEV','LOCAL')`. (Note: this is the *account* CHECK; the *backend* CHECK is the separate OS-1 problem.)
2. **PTY BoundedAckRing flow control** (`core/src/kernel/pty/flowControl.ts`) — hard caps (4 MiB/2 MiB/512 KiB), zero byte loss, cap-breach-is-a-bug assertion. Well engineered for growth.
3. **FE RingBuffer + rAF batch** — fixed-capacity drop-oldest, sized ≥ broker cap. Sound.
4. **Graph layout+render pipeline** — genuinely well-built *within* its 5k regime (off-thread layout, transferable Float32Array epochs, 2 `stroke()`/frame edge batching, halo culling). The only gap is upstream ceiling enforcement (OS-5).
5. **OTLP receiver** — a SINGLE shared `127.0.0.1:4318` endpoint with `account=<LABEL>` attribution; does NOT fan out per account, so it scales fine to N (only the JSONL watcher fans out — OS-3).
6. **Dynamic FE panels** render `registry.entries.map(...)` — bounded by the small account count, not a scaling risk.

**Method:** static analysis only (read-only, no live app / no LM Studio), so latency claims are derived from query shapes + documented spike budgets, not measured. The three HIGH findings were re-verified against the cited code by the driving session before commit.
