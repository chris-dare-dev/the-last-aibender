# ICR-0017 — additive SQL-aggregation accessor over the frozen events store (finding OS-2)

- Requesting lane: BE (read-models / collector optimization)
- Surface: `packages/schema` (public API — ADDITIVE only) + `core/src/readmodels` (internal)
- Freeze state at request time: events store frozen at **M3** (`packages/schema/src/events.ts`, FROZEN-M3)

## Motivation

Finding **OS-2** (`docs/reviews/optimization-scalability.md`): the ten BE-6
dashboard projections each called `stores.events.list({ sinceTsMs })` — a
`SELECT *` window scan whose every row is decoded by `eventFromSql` into a
30-field `EventRow` (with `JSON.parse(file_refs)`) — then did all group-by / sum
/ percentile work in JS. At N accounts × a 7–30 day window this materializes
tens-of-thousands to millions of rows into JS objects and re-aggregates on
**every** `publishAll()`. The frozen `events.list()` cannot express aggregation
(it is `SELECT <all cols> … ORDER BY ts_ms, id`, LIMIT-only).

## Proposed change

A NEW, read-only accessor surface — the FROZEN write/dedupe path (`events.ts`)
is **not touched**, so this is additive, not a freeze amendment:

- **New file** `packages/schema/src/eventsAggregates.ts`: `createEventsAggregatesStore(driver)`
  → `EventsAggregatesStore`. It aggregates COUNTs in SQLite for the count-based
  leads (health `CASE`-counts, session-outcomes `COUNT`) and takes NARROW-COLUMN
  scans (only the columns each lead reads) for everything else — the token-sum
  leads (cache-hit, local-offload, skill-leaderboard, burn-rate) and the
  float-USD / percentile leads (bedrock, api-equivalent, latency) — folding the
  token/USD arithmetic in JS. **Token sums are deliberately NOT done in SQL:**
  the OS-2 adversarial review's regression hunter proved that a SQL-side
  `SUM(tokens)` (or a per-row 4-class sum) can cross 2^53, at which point
  node:sqlite (default non-BigInt, driver.ts) throws `ERR_OUT_OF_RANGE` — whereas
  the old JS path `Number()`d each safe (< 2^53) column and float-folded without
  throwing. Folding in JS over safe per-column values is byte-identical to the
  old fold (same order, same float semantics, including past 2^53) and never
  throws. Only COUNTs — bounded by the row count, which cannot approach 2^53 —
  stay in SQL.
- **New export** from `packages/schema/src/index.ts` (the accessor + its row
  types) and a **new additive field** `eventsAggregates: EventsAggregatesStore`
  on the `EventsStore` bundle, wired in `openEventsStore` from the same driver.
- **Internal** `core/src/readmodels/projections.ts`: `ReadModelStores` gains
  `eventsAggregates`; the eight window-scanning leads consume it instead of
  `events.list()`. `estimateUsdForRow`'s parameter is widened to a structural
  subset (`EstimatableRow`) so the narrow cost rows share the exact per-row USD
  arithmetic.

**No DDL migration.** The existing `events_ts_idx (ts_ms)` (rowid-appended, so it
satisfies `ORDER BY ts_ms, id`) and `events_account_ts_idx (account, ts_ms)`
serve the range scans. A covering `(account, ts_ms, <token cols>)` index was
considered and **deferred**: it would add write amplification on the high-volume
collector-owned events DB (blueprint §6.2 keeps that DB separate precisely
because it is write-heavy) for an index-only-scan win that profiling on real
N-account volume has not yet shown to be needed. Revisit if that profiling lands.

## Byte-identical guarantee (the reason no wire/version change is needed)

The emitted `read-model-snapshot` payloads are unchanged, so no protocol bump
(`1.6.0`/FROZEN-M8 stand) and no golden-corpus change. The proof:

1. **Ordering** — the count-in-SQL leads tag rows with `ROW_NUMBER() OVER (ORDER
   BY ts_ms, id)` + `MIN(rn)`; the JS-fold leads scan in the same `ORDER BY
   ts_ms, id` and group into a Map — both reproduce the old Map's first-appearance
   entry order exactly.
2. **Token/USD arithmetic in JS, not SQL** — token sums fold in JS over safe
   per-column values (byte-identical to the old fold incl. past-2^53 float
   semantics; never trips node:sqlite's >2^53 marshaling throw). Float money is
   likewise never summed in SQL (SQLite `SUM` is Kahan-compensated → last-ULP
   divergence). Only COUNTs (bounded by row count) are aggregated in SQL.
3. **NULL → undefined / 0** decode mirrors `eventFromSql` + the projections' `?? 0`.

Proven by `packages/schema/src/eventsAggregates.spec.ts` — a 400-row seeded
corpus (inserted OUT of ts order) checked field-for-field against a JS reference
computed over `events.list()`, plus window-boundary and empty-window cases. The
existing hand-checked `core/src/readmodels/projections.spec.ts` remains green
unchanged.

## Compatibility

Consumers of `ReadModelStores` build it from `openEventsStore` (which now
provides `eventsAggregates`); the two hand-built test stores in
`backendRegistryRoute.spec.ts` were updated to pass the bundle's accessor. No
runtime consumer of the wire payloads changes.

## Sign-off

- Owning orchestrator (BE-ORCH, `packages/schema`): landed (additive; frozen
  `events.ts` untouched — no freeze amendment).
- Counterpart orchestrator: n/a (no `packages/protocol` wire change; FE reads
  the identical read-model snapshots).
