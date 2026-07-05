# Runbook — Stage-3 adversarial-review fix run (what landed)

**Status:** complete (Stage-3 fix-team + gate, Opus 4.8) · **Audience:** owner + future maintainers
**Sources of record:** the per-dimension review docs under
[`docs/reviews/`](../reviews/README.md) (finding IDs, anchors, scenarios) and
the commits cited below. This runbook is the human-readable summary of the fix
run; the review [`README.md`](../reviews/README.md) is the authoritative
FIXED/OPEN ledger.

## What this run did

A Stage-3 adversarial principal-engineer review landed 30 findings across 5
dimensions (7 high · 9 medium · 14 low). This fix run implemented the in-scope
findings, added a regression test for each code fix, and re-ran the full gate.
**OS-1 (backend-adapter registry) and OS-2 (projection SQL-aggregation
rewrite) were explicitly OUT of scope** and remain OPEN — they are separate
future workflows. **OS-6 (ApiRequestJoiner pending-map bound, LOW) was not
implemented this run** and remains OPEN.

## Commit batches

| Batch | Commit | Findings | Summary |
|---|---|---|---|
| (a) | `828ab83` | SEC-1, SEC-2, FE-1, FE-4 | bootstrap-removal race, scrubber identity map, registry resync |
| (b) | `24ee98a` | SEC-3, X-1, X-2, SEC-5 | hooks-endpoint auth, merge-brief guard, X2 audit + env scrub |
| (c) | `a9e1734` | OS-3, OS-4, OS-5 | bound the watcher walk + graph store; N-account supervision |
| (d) | `2f2e0c5` | FE-2, FE-3 | approval-inbox race, workstream drop logging |
| (e) | this commit | DOC-1..8, SEC-4, SEC-6, SEC-7 | dev-start runbook, contract/onboarding prose, tier-2 chmod guard, opencode.db read-only doc |

## Per-finding coverage + proof

Each fix carries a regression test that would have caught the bug (or, for
docs, the changed file). Anchors below are the proof.

### Batch (a) — bootstrap-carrier + restart lifecycle
- **SEC-1** (HIGH) — `removeBootstrapFile` is now an atomic
  rename-to-marker -> validate-on-marker -> exclusive-link-restore sequence; a
  stale broker can never delete a newer boot's file (bootstrap-file.md 3.4);
  ENOENT is idempotent. Proof: `core/src/gateway/bootstrap.spec.ts` —
  "SEC-1: a stale broker never deletes a newer boot file that lands
  mid-removal" + the interleaved-removal test.
- **SEC-2** (HIGH) — gateway loads the identity map at boot and passes it into
  `createLineScrubber`; `reloadIdentityScrub()` re-reads it on the restart
  trigger. Proof: `core/src/gateway/serverScrub.spec.ts` (redacts a synthesized
  mapped identity; reload picks up a new account).
- **FE-1** (HIGH) — configured Claude accounts moved to a reactive store;
  `installAccountRegistrySync` re-syncs on `onBrokerRestart`. Proof:
  `app/src/lib/accountConfig.spec.ts` — "syncs at boot AND re-syncs on
  onBrokerRestart" + the shrink test.
- **FE-4** (LOW) — the seed fallback logs its reason (absent / empty). Proof:
  same spec (fallback-reason assertions). [X2]: nothing identifier-bearing.

### Batch (b) — [X2]/[X4] hardening
- **SEC-3** (MED) — per-install token gate on the hooks endpoint
  (`x-aibender-hook-token`, constant-time, 401 before any parse). Proof:
  `core/src/collector/hooks/hooks.spec.ts` "SEC-3 —". Install-side token
  injection lives in `infra/hooks/` (opt-in; ICR-0015).
- **X-1** (MED) — `LineageMergeAction.briefId` is now required in the port type
  + a runtime guard in `recorder.ts`. Proof: `core/src/workstreams/recorder.spec.ts`
  "X-1: a merge recorded with NO briefId is DROPPED" + the empty-string case.
- **X-2** (MED) — the [X2] audit sweep derives its source list from
  `EVENT_SOURCES` and asserts a partition. Proof:
  `core/src/collector/x2Audit.spec.ts` "X-2: the audit buckets PARTITION
  EVENT_SOURCES".
- **SEC-5** (LOW) — `buildSessionEnv` fail-closes on the whole unknown
  ANTHROPIC_/CLAUDE_ namespace + secret-shaped names. Proof:
  `core/src/kernel/env.spec.ts` "SEC-5: buildSessionEnv drops a synthesized
  future SDK credential var".

### Batch (c) — scale hardening
- **OS-3** (HIGH) — the per-account JSONL watcher walks asynchronously
  (`opendir`), skips unchanged-mtime dirs, and full-reconciles only
  periodically. Proof: `core/src/collector/jsonl/jsonl.spec.ts`.
- **OS-4** (MED) — supervision budget generalized to N: a config-derived
  resident-account soft ceiling (amber advisory, never a hard gate) + opt-in
  checkpoint-hibernation of idle account sessions under sustained red. Proof:
  `core/src/supervision/scheduler.spec.ts`, `hibernation.spec.ts`,
  `governor.spec.ts`. N-account math documented in blueprint §11.
- **OS-5** (MED) — GraphStore LRU/recency eviction at the 5k ceiling; emits
  `removedNodes` batches the renderer consumes. Proof:
  `app/src/islands/graph/store.spec.ts` "OS-5 recency eviction".

### Batch (d) — low-severity observability
- **FE-2** (LOW) — `deciding` set in the approvals store prevents
  double-send/stutter. Proof: `app/src/chrome/ApprovalInbox.spec.tsx`
  "FE-2 decision race".
- **FE-3** (LOW) — dropped opaque workstream kinds are DEBUG-logged. Proof:
  `app/src/features/workstreams/renderCount.spec.tsx` "FE-3: DEBUG-logs a
  dropped opaque payload".

### Batch (e) — docs + defence-in-depth
- **DOC-1** (HIGH) — `docs/runbooks/local-dev-start.md` (the cold-start dev
  loop).
- **DOC-2/4** (MED) — `docs/contracts/README.md` §0 "how to read a frozen
  contract" + §0.1 protocol version/freeze cadence.
- **DOC-3** (MED) — DESIGN.md determinism rationale at the lock notice.
- **DOC-5/6/7/8** (LOW) — README purpose column + `core/README.md`;
  `add-an-account.md` forward refs in SECURITY.md/HANDOFF; workflow-orchestration
  prominence; HANDOFF §3 M7 flagged as a CRITICAL FIX.
- **SEC-4** (MED) — the pre-commit hook fails closed unless the Tier-2 config is
  mode 600 (cross-platform `stat`). Proof: `infra/scripts/tests/hooks-install.bats`
  (600 passes; 644/640/664 block).
- **SEC-6/7** (LOW) — the opencode.db guard's frozen-external-schema +
  OS-level-read-only assumptions are documented in the `dbAccess.ts` header and
  SECURITY.md §6. Proof: `core/src/adapters/opencode/dbAccess.spec.ts` (header
  cross-ref test).

## Gate result

- **Workspace tests:** 2272 passed / 1 skipped (baseline 2210/1 -> **+62**, no regression).
- **Integration:** 166 passed (unchanged).
- **Infra bats (`test:infra`):** 107 ok / 0 fail (baseline 99 -> **+8**, from the SEC-4 hooks-install suite).
- **CI bats (`infra/ci/tests/run.sh`):** 46 ok / 0 fail (unchanged).
- **typecheck:** clean (7 projects). **lint:tokens:** 0 violations. **app build:** OK.
- **Soaks:** `soak:m2` PASS (0 byte loss, echo p95 0.157 ms) · `soak:m6` PASS
  (0 resident-ratchet violations, 0 identity leaks).
- **Composed suites + golden corpus:** green both sides.
- **gitleaks:** Tier-1 dir clean; Tier-2 dir = the known 12 `.git/logs` reflog
  echoes only (no new leak of any class); both tiers clean on committed history.

## Still OPEN (not this run)

- **OS-1** (HIGH) — backend-adapter registry (`BackendDescriptor` +
  `registerBackend()`); the backend twin of the M7 account-label work. Deferred
  to a separate workflow.
- **OS-2** (HIGH) — push dashboard-projection aggregation into SQL / a rollup
  table before wiring the publish-cadence timer. Deferred to a separate workflow.
- **OS-6** (LOW) — hard-cap the `ApiRequestJoiner` pending map with oldest-half
  eviction (`core/src/collector/ingest.ts`). Not implemented this run; the
  current time-window flush bounds it in the normal case, but an imbalanced
  source is still unbounded until flush. Left as a clear follow-up.
