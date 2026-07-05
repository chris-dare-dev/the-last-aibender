# Stage-3 Adversarial Review — Index

Read-only principal-engineer review of `the-last-aibender` at
`HEAD = 0abf45f` (protocol 1.5.0 / FROZEN-M7, schema migration 0006). Every
finding below survived an independent adversarial verification pass; refuted
findings were dropped before this index. Each carries a file:line anchor, a
concrete failure scenario, a recommendation, and the verifier's
confirm/partial verdict — see the per-dimension docs.

This is a **findings-only** deliverable. A later, separate fix-team workflow
consumes the "Recommended fix order" below. No source was modified.

> **The rendered-frontend screen-capture review — FIRST PASS DONE**
> ([rendered-frontend.md](rendered-frontend.md)): captured the real running
> cockpit (vite dev server, preview MCP) in its disconnected/seed-3 state — 5
> findings (0 high · 3 med · 2 low), critiquing chrome/layout/IA/contrast/
> navigation from actual pixels (anti-slop bar cleared; a11y strong). A
> **populated** follow-up pass (live dashboards, context graph, lineage,
> pipelines, the real 5-account density, motion) is now possible with the 5
> logins done — see that doc's follow-up section. `frontend-correctness.md` is
> the separate source-level pass.

---

## Totals

**30 findings** across 5 dimensions: **7 high · 9 medium · 14 low.**

| Dimension | Doc | High | Med | Low | Total |
|---|---|:-:|:-:|:-:|:-:|
| Security & [X2] secret hygiene | [security.md](security.md) | 2 | 2 | 4 | 8 |
| Documentation & new-engineer onboarding | [docs-onboarding.md](docs-onboarding.md) | 1 | 3 | 4 | 8 |
| Cross-cutting requirements [X1/X2/X3/X4] | [x-requirements.md](x-requirements.md) | 0 | 2 | 2 | 4 |
| Frontend & protocol correctness (source-level) | [frontend-correctness.md](frontend-correctness.md) | 1 | 0 | 3 | 4 |
| Optimization & scalability | [optimization-scalability.md](optimization-scalability.md) | 3 | 2 | 1 | 6 |
| **Total** | | **7** | **9** | **14** | **30** |

Every dimension has a doc. **Note:** the optimization/scalability reviewer
crashed in the main run (StructuredOutput retry cap); it was re-run as a focused
follow-up (commit after this index) and its 3 HIGH findings were independently
re-verified against the cited code by the driving session. Two [X1/X2/X3/X4]
entries are verification-passed controls (X-3 env-scrub, X-4 arch-boundary),
recorded as evidence, not open work.

Two of the four [X1/X2/X3/X4] entries are **verification-passed controls**
(X-3 env-scrub, X-4 arch-boundary) recorded as evidence, not open work.

---

## Git-history secret-leak scan (independently re-run)

`gitleaks 8.30.1`, both tiers, over the full repository.

| Scan | Scope | Result |
|---|---|---|
| Tier-1 `git` (committed history, 59 commits) | 6.98 MB | **clean** |
| Tier-2 `git` (committed history, 59 commits) | 6.98 MB | **clean** |
| Tier-1 `dir` (working tree + `.git`) | 11.86 MB | **clean** |
| Tier-2 `dir` (working tree + `.git`) | 1.08 GB | **12 findings — all `.git/logs` reflog echoes (known-pending-owner)** |

**Verdict:** committed history is clean on both tiers; nothing leaked was ever
committed or pushed. The only Tier-2 hits are the expected **12 `.git/logs`
reflog echoes** (6× `HEAD`, 4× `refs/heads/main`, 2× `refs/remotes/origin/main`;
rule classes `work-domain-literal` / `work-domain-email-literal`) — historical
commit-message subjects echoed into the local, unpushed reflog. Clearing the
reflog is an owner-gated action. **No new leak of any class was found.** Full
detail in [security.md](security.md#git-history-secret-leak-scan-independent-re-run).

---

## Top findings across all dimensions

The single highest-severity, highest-confidence issue and the rest of the HIGH tier:

1. **SEC-1 (HIGH, confirmed) — Bootstrap-file removal TOCTOU.**
   `removeBootstrapFile` (`core/src/gateway/bootstrap.ts:240-252`) reads +
   token-checks, then unconditionally unlinks. A concurrent newer boot can be
   deleted, violating bootstrap-file.md §3.4. **← highest-severity finding.**
2. **SEC-2 (HIGH, confirmed) — Log scrubber identity map never wired.** The
   gateway builds its scrubber with only the boot token, no `identityMap`
   (`core/src/gateway/server.ts:270`), so account emails are never scrubbed from
   logs; new accounts and rotated emails are unprotected. An [X2] defense
   present in the library but disconnected.
3. **FE-1 (HIGH, confirmed) — Account registry lost on broker restart.**
   Configured Claude accounts live in a module closure set once at boot
   (`app/src/main.tsx:84-97`); `onBrokerRestart` never re-syncs, so a
   newly-provisioned MAX_C goes invisible across the whole cockpit until a
   manual reload — [X1] regression.
4. **DOC-1 (HIGH, confirmed) — No local-dev-start runbook.** No unified
   "install → start broker → start Tauri app → verify" document exists; a fresh
   engineer cannot cold-start the app without reverse-engineering scattered
   fragments.
5. **OS-1 (HIGH, gate-verified) — Adding a new local LLM/backend is a
   cross-codebase fork.** No adapter registry: `BACKENDS` is a frozen 3-tuple,
   `backendForLabel` a hardcoded if-chain, the literals branch across ~42 files,
   and every migration hardcodes `CHECK (backend IN (…3…))`. The *backend* twin
   of the account-label problem M7 solved. ([optimization-scalability.md](optimization-scalability.md))
6. **OS-2 (HIGH, gate-verified) — Dashboard projections full-scan +
   JS-aggregate the whole window every publish** (`readmodels/projections.ts`);
   O(window) per tick, table-scans as events grow. Design-latent until the
   publish cadence is wired.
7. **OS-3 (HIGH, gate-verified) — Per-account JSONL watcher does a synchronous
   recursive dir walk every 2 s** (`collector/jsonl/accountWatcher.ts`); at 12
   accounts, 12 blocking full-tree walks/2 s on the broker event loop.

---

## Fix-run status (Stage-3 fix-team + gate, Opus 4.8)

The fix run below is **complete**. Full summary + per-finding proof:
[`docs/runbooks/stage3-fixes.md`](../runbooks/stage3-fixes.md). Commit batches:
(a) `828ab83`, (b) `24ee98a`, (c) `a9e1734`, (d) `2f2e0c5`, (e) docs (this batch).

| Finding | Status | Commit |
|---|---|---|
| SEC-1 · SEC-2 · FE-1 · FE-4 | **FIXED** | `828ab83` |
| SEC-3 · X-1 · X-2 · SEC-5 | **FIXED** | `24ee98a` |
| OS-3 · OS-4 · OS-5 | **FIXED** | `a9e1734` |
| FE-2 · FE-3 | **FIXED** | `2f2e0c5` |
| DOC-1..8 · SEC-4 · SEC-6 · SEC-7 | **FIXED** | (e) docs batch |
| **OS-1** | **FIXED** | OS-1 backend-registry workflow (`BackendDescriptor` + `registerBackend` registry; migrations 0007/0008/0009; ICR-0016) — see [os1-backend-registry.md](../runbooks/os1-backend-registry.md) |
| **OS-2** | **OPEN — deferred** | separate future workflow (projection SQL aggregation) |
| **OS-6** | **OPEN** | not implemented this run; joiner pending-map still time-window-bounded only |
| SEC-8 · X-3 · X-4 | no action (intentional / verified control) | — |

Gate (OS-1 backend-registry workflow): workspace tests **2312 pass / 1 skip**
(baseline 2276 -> +36, no regression); 166 integration; 117 infra bats / 49 CI
bats; both soaks PASS; protocol 1.6.0 / FROZEN-M8, schema kernel ddl 9 / events
ddl 3; gitleaks both tiers clean except the known 12 `.git/logs` reflog echoes.
**OS-2 and OS-6 remain OPEN.**

## Recommended fix order (for the fix-team workflow)

Ordered by severity, then by exploiting shared fix surfaces so related items are
fixed together. Verdicts: (C) confirmed, (P) partial. **Status tags added by the
fix-run gate.**

**Batch A — bootstrap-carrier + restart lifecycle (do first; one code surface, three HIGH/related items)** — **FIXED `828ab83`**
1. **SEC-1** (HIGH, C) — **FIXED** — atomic re-validate-before-unlink in
   `removeBootstrapFile`; treat ENOENT as idempotent success; race test.
2. **FE-1** (HIGH, C) — **FIXED** — move configured accounts into a reactive store; re-sync
   on `onBrokerRestart` (boot-identity change).
3. **SEC-2** (HIGH, C) — **FIXED** — load + pass the identity map into the gateway
   `createLineScrubber`; make it reloadable on the same restart trigger as FE-1.
4. **FE-4** (LOW, C) — **FIXED** — log the account-registry fallback reason (self-heals once
   FE-1 lands; same file).

> A, items 2–4 share the bootstrap→registry→restart seam; read bootstrap-file.md
> §3–§4 once and land them as a cluster.

**Batch B — onboarding (independent, docs-only, unblocks new engineers/agents)** — **FIXED (docs batch e)**
5. **DOC-1** (HIGH, C) — **FIXED** — write `docs/runbooks/local-dev-start.md`.
6. **DOC-2** (MED, C) — **FIXED** — add "how to read a frozen contract" §0 to
   `docs/contracts/README.md`.
7. **DOC-4** (MED, C) — **FIXED** — document the protocol-version/freeze-cadence rule (§0.1).
8. **DOC-3** (MED, C) — **FIXED** — one-sentence determinism rationale in DESIGN.md.
9. **DOC-5/6/7/8** (LOW, C) — **FIXED** — README purpose column + `core/` README; forward
   references to `add-an-account.md`; promote workflow-orchestration link;
   flag M7 as a critical fix in HANDOFF §3.

**Batch C — [X2]/[X4] hardening** — **FIXED `24ee98a`** (SEC-4 in docs batch e)
10. **X-1** (MED, P) — **FIXED `24ee98a`** — require `briefId` for `kind:'merge'` (port type +
    runtime guard in `recorder.ts`); negative test.
11. **X-2** (MED, P) — **FIXED `24ee98a`** — derive the X2-audit source list from `EVENT_SOURCES`;
    fail if a defined source is unswept.
12. **SEC-3** (MED, P) — **FIXED `24ee98a`** — per-install token auth on the hooks endpoint (keep
    loopback bind; firewall framing dropped).
13. **SEC-4** (MED, P) — **FIXED (docs batch e)** — `chmod 600` assertion for the Tier-2 config in
    the pre-commit hook + bats.

**Batch D — low-severity hygiene / observability (opportunistic)** — **FIXED `2f2e0c5`** (SEC-5 in `24ee98a`, SEC-6/7 in docs batch e)
14. **FE-2** (LOW, C) — **FIXED `2f2e0c5`** — `deciding` state in approvalsStore to prevent
    double-send/stutter.
15. **FE-3** (LOW, P) — **FIXED `2f2e0c5`** — DEBUG-log dropped opaque workstream kinds.
16. **SEC-5** (LOW, P) — **FIXED `24ee98a`** — secret-shaped-name fail-close in `buildSessionEnv`.
17. **SEC-6/7** (LOW, P) — **FIXED (docs batch e)** — document the opencode.db frozen/external + OS-level
    read-only assumptions (dbAccess.ts header + SECURITY.md §6).

**Batch E — scale hardening (the optimization/scalability dimension; do after A–C)**
18. **OS-1** (HIGH) — **FIXED (OS-1 backend-registry workflow, ICR-0016).** A `BackendDescriptor` + `registerBackend()` registry so a
    new local LLM/backend is one descriptor, not ~42 edits + a migration. The
    migration backend CHECK moved to the app layer (0007 kernel / 0008 events /
    0009 step_attempt relax it to a non-empty guard + built-in defense-in-depth;
    the value set is gated by the registry-driven `isBackend()` at insert — the
    M3-events open-vocabulary precedent). Direct sequel to the M7 account-registry
    pattern; the built-in three behave byte-identically; a synthetic 4th backend
    routes end-to-end with no branch edit. See
    [os1-backend-registry.md](../runbooks/os1-backend-registry.md).
19. **OS-3** (HIGH) — **FIXED `a9e1734`** — stop the per-account synchronous 2 s full-tree walk:
    async mtime-scoped rescan + periodic full reconcile, off the event loop.
20. **OS-2** (HIGH) — **OPEN — deferred to a separate future workflow.** Push read-model aggregation into SQL (or a rollup table) +
    a covering index; bound recompute to the dirty-account set; fix before wiring
    the publish cadence timer.
21. **OS-4** (MED) — **FIXED `a9e1734`** — generalize the [X1] supervision budget from 3 accounts to N
    (resident-account soft ceiling + checkpoint-hibernation of idle accounts under
    red); document the N-account math in blueprint §11.
22. **OS-5** (MED) — **FIXED `a9e1734`** — LRU/recency eviction on the GraphStore to enforce the 5k-node
    render regime; **OS-6** (LOW) — **OPEN** — bound the ApiRequestJoiner pending map (not implemented this run).

**No action needed (documented as intentional):**
- **SEC-8** (LOW, C) — bootstrap double-sanitization is intentional
  defense-in-depth (bootstrap-file.md §4.6). Comment-only.
- **X-3, X-4** — verification-passed controls; guards are live and green.

---

## Method notes

- Source was treated as read-only throughout; the only writes are these
  findings docs under `docs/reviews/`.
- All findings docs are [X2]-clean: identities appear only as placeholder labels
  (`MAX_A..MAX_D`, `ENT`, `AWS_DEV`, `LOCAL`, `AWS_DEV_ACCOUNT_ID`). No real
  email, AWS account id, token, or key appears in any doc — verified by running
  both gitleaks tiers over the staged tree before commit.
- Two concurrent local sessions were doing narrow cleanup (a completed
  `backendForLabel` migration; a docs-prose refresh); anchors above were
  spot-re-verified against `HEAD = 0abf45f` and hold.
