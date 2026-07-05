# Stage-3 Adversarial Review — Index

Read-only principal-engineer review of `the-last-aibender` at
`HEAD = 0abf45f` (protocol 1.5.0 / FROZEN-M7, schema migration 0006). Every
finding below survived an independent adversarial verification pass; refuted
findings were dropped before this index. Each carries a file:line anchor, a
concrete failure scenario, a recommendation, and the verifier's
confirm/partial verdict — see the per-dimension docs.

This is a **findings-only** deliverable. A later, separate fix-team workflow
consumes the "Recommended fix order" below. No source was modified.

> **The rendered-frontend screen-capture review is a SEPARATE pass, still
> PENDING** — it needs the live app running (a T3 owner-gated activity).
> `frontend-correctness.md` here is source-level only.

---

## Totals

**24 findings** across 4 dimensions: **4 high · 7 medium · 13 low.**

| Dimension | Doc | High | Med | Low | Total |
|---|---|:-:|:-:|:-:|:-:|
| Security & [X2] secret hygiene | [security.md](security.md) | 2 | 2 | 4 | 8 |
| Documentation & new-engineer onboarding | [docs-onboarding.md](docs-onboarding.md) | 1 | 3 | 4 | 8 |
| Cross-cutting requirements [X1/X2/X3/X4] | [x-requirements.md](x-requirements.md) | 0 | 2 | 2 | 4 |
| Frontend & protocol correctness (source-level) | [frontend-correctness.md](frontend-correctness.md) | 1 | 0 | 3 | 4 |
| **Total** | | **4** | **7** | **13** | **24** |

Every dimension had survivors — no doc was omitted. (Optimization/scalability
was folded into [X1] and the frontend docs where its survivors landed; it has
no standalone doc because it produced no independent survivors of its own.)

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

---

## Recommended fix order (for the fix-team workflow)

Ordered by severity, then by exploiting shared fix surfaces so related items are
fixed together. Verdicts: (C) confirmed, (P) partial.

**Batch A — bootstrap-carrier + restart lifecycle (do first; one code surface, three HIGH/related items)**
1. **SEC-1** (HIGH, C) — atomic re-validate-before-unlink in
   `removeBootstrapFile`; treat ENOENT as idempotent success; race test.
2. **FE-1** (HIGH, C) — move configured accounts into a reactive store; re-sync
   on `onBrokerRestart` (boot-identity change).
3. **SEC-2** (HIGH, C) — load + pass the identity map into the gateway
   `createLineScrubber`; make it reloadable on the same restart trigger as FE-1.
4. **FE-4** (LOW, C) — log the account-registry fallback reason (self-heals once
   FE-1 lands; same file).

> A, items 2–4 share the bootstrap→registry→restart seam; read bootstrap-file.md
> §3–§4 once and land them as a cluster.

**Batch B — onboarding (independent, docs-only, unblocks new engineers/agents)**
5. **DOC-1** (HIGH, C) — write `docs/runbooks/local-dev-start.md`.
6. **DOC-2** (MED, C) — add "how to read a frozen contract" §0 to
   `docs/contracts/README.md`.
7. **DOC-4** (MED, C) — document the protocol-version/freeze-cadence rule.
8. **DOC-3** (MED, C) — one-sentence determinism rationale in DESIGN.md.
9. **DOC-5/6/7/8** (LOW, C) — README purpose column + `core/` README; forward
   references to `add-an-account.md`; promote workflow-orchestration link;
   flag M7 as a critical fix in HANDOFF §3.

**Batch C — [X2]/[X4] hardening**
10. **X-1** (MED, P) — require `briefId` for `kind:'merge'` (port type or
    runtime guard in `recorder.ts`); negative test.
11. **X-2** (MED, P) — derive the X2-audit source list from `EVENT_SOURCES`;
    fail if a defined source is unswept.
12. **SEC-3** (MED, P) — per-boot HMAC/token auth on the hooks endpoint (keep
    loopback bind; drop the firewall framing).
13. **SEC-4** (MED, P) — add a `chmod 600` assertion for the Tier-2 config to
    the pre-commit hook.

**Batch D — low-severity hygiene / observability (opportunistic)**
14. **FE-2** (LOW, C) — `deciding` state in approvalsStore to prevent
    double-send/stutter.
15. **FE-3** (LOW, P) — DEBUG-log dropped opaque workstream kinds.
16. **SEC-5** (LOW, P) — secret-shaped-name fail-close in `buildSessionEnv`.
17. **SEC-6/7** (LOW, P) — document the opencode.db frozen/external + OS-level
    read-only assumptions; consider runtime-schema allowlist.

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
