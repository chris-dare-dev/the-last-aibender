# HANDOFF — the-last-aibender

> **Audience:** a fresh Claude Code *ultracode* session, in a different account, with **zero prior
> context** on this project. Read this document top to bottom before doing anything. It tells you
> what the project is, exactly where the build stands, what you may and may **not** do, and precisely
> how to continue.
>
> **⚠ COMPANION DOC — READ IT SECOND (do not skip):**
> **[`docs/runbooks/workflow-orchestration.md`](runbooks/workflow-orchestration.md)**
> — the reusable multi-agent *Workflow* pattern that has driven every milestone. You will re-use it
> verbatim to build the remaining milestones. If you jump straight from §0 (TL;DR) to §3 (Status) or
> §9.1 (next action), come back for this before launching any workflow.
>
> **Last updated:** 2026-07-05 — **Stage 2 (M0–M6) + M7 account-registry + the full Stage-3 code
> review, fix loop, AND the OS-1 backend registry are all COMPLETE** (HEAD `4a7177a`, 2312 tests,
> protocol 1.6.0 / FROZEN-M8, schema kernel-ddl 9 / events-ddl 3). Owner has done all five logins; SEC-3
> composeBroker wiring landed (`5c34978`); rendered-frontend review FIRST PASS done (disconnected state).
> **Remaining:** the *populated* rendered pass (needs the broker running against the accounts), plus two
> deferred code items — **OS-2** (projection SQL, design-latent — defer until the publish-cadence timer
> is wired) and **OS-6** (joiner pending-map cap, LOW). Adding a Claude account OR a backend is now a
> pure data change (`add-an-account.md` / `add-a-backend.md`).
> **Machine:** the owner's MacBook Pro (Apple M4 Max, 14 cores, 36 GB RAM, macOS 26.6).
> **Repo (local):** `~/Personal/SourceCode/the-last-aibender` — public GitHub repo
> `chris-dare-dev/the-last-aibender`. **Everything is committed LOCAL-ONLY. Nothing has been pushed.
> Do not push** (see §6).

---

## 0. TL;DR — your first five minutes

1. `cd ~/Personal/SourceCode/the-last-aibender && git log --oneline -75 && git status` — confirm you
   are at `4a7177a` (or later) with a **clean tree**. If the tree is dirty, someone left work
   uncommitted; investigate before proceeding.
2. `pnpm install && pnpm -r typecheck && pnpm -r test` — you should see **2312 tests pass / 1 skipped**,
   typecheck clean. Also green: `pnpm run test:infra` (~117 bats) + `bash infra/ci/tests/run.sh` (49),
   `pnpm test:integration` (166, §9.3 cross-department), `pnpm -F aibender-app lint:tokens` (203 files),
   `pnpm -F aibender-core soak:m2` + `soak:m6`, `pnpm -F aibender-app test:islands`. Green baseline.
   (If `pnpm` is missing: `npm i -g pnpm`.)
3. Read the two **normative** specs (they are the source of truth, not this doc):
   `docs/research/summaries/01-architecture-blueprint.md` and
   `docs/research/summaries/02-stage2-implementation-plan.md`.
4. Read §6 (**hard gates**) and §7 (**secret hygiene**) of this file. These are non-negotiable and
   the auto-mode classifier *will* stop you if you cross them.
5. **Stage 2 is DONE.** Your immediate job is **§9.1 — Stage 3 (adversarial review & fix)**. Its
   code/security/scale/docs review half runs now; its rendered-frontend screen-capture half needs the
   owner's live logins (a real running app). Go there.

---

## 1. What this project is (full context)

**the-last-aibender** is a local macOS harness application with an interactive frontend that unifies
*all* of the owner's AI tooling behind one interface. The assets it unifies:

- **Claude subscription accounts** — Claude Max plans plus one Claude Enterprise account. Throughout
  the codebase these are referred to **only** by the placeholder labels **`MAX_<X>`** (the OPEN
  validated form `^MAX_[A-Z]$` — `MAX_A`, `MAX_B`, `MAX_C`, `MAX_D`, …; ICR-0013) and **`ENT`**. The
  owner may provision arbitrarily many Max accounts with **no code change** — see
  [`docs/runbooks/add-an-account.md`](runbooks/add-an-account.md) (manifest + one login + a probe).
  The real identities exist only in machine-local files and the owner's head.
- **OpenCode → AWS Bedrock** through the owner's company **dev** AWS account (placeholder
  **`AWS_DEV_ACCOUNT_ID`**). A shell function `oc-bedrock` (in `~/.zshrc`) does `aws sso login`, exports
  the profile + region + a Keychain-fetched API key, then launches `opencode`. OpenCode config is at
  `~/.config/opencode/opencode.jsonc` (two providers: `amazon-bedrock` via SigV4/SSO, and an
  OpenAI-compatible provider pointed at Bedrock's `bedrock-mantle` Responses API).
- **LM Studio** — a local OpenAI-compatible LLM server (default `127.0.0.1:1234`), used to off-load
  cheap work from the paid providers. **It is frequently *down*** — "down" is a first-class UI state,
  never an error.

### The six product features the frontend must deliver
1. **Usage & cost observability** — weekly usage, remaining quota, accumulated cost (real USD for
   Bedrock), tokens, cache-hit rates, latency, skill frequency/optimality, and more.
2. **Launch a one-off prompt** against a single agent from a **specified** account/backend (any of the
   three Claude accounts, OpenCode+Bedrock, or LM Studio).
3. **Launch Claude *skills*** from a specified account.
4. **Launch multi-agent workflows** driven by a specified Claude account *or* Bedrock via OpenCode.
5. **Pipeline / workflow builder** page, scoped to a chosen **workspace** (a bound base directory),
   scanning that workspace's `.claude/` dirs and OpenCode `.json` files to discover skills/agents/
   workflows.
6. **Live context-graph** page — a large, Obsidian-style force-directed graph of all context artifacts
   (CLAUDE.md, memory files, agent artifacts, references) tied to an active session that **populates
   live** as files are referenced/read/written during the session.

### The four cross-cutting requirements (apply to *every* milestone) — see §5
- **[X1]** Parallel, per-account Claude sessions without repeated login — *the hardest problem*.
- **[X2]** Public-repo secret hygiene — no real identifiers/credentials in the tree or history, ever.
- **[X3]** Conditional Colima+k3s+SOPS virtualization — but LM Studio connectivity always wins.
- **[X4]** "Workstreams" — session organization independent of working directory, with branch/
  continue/merge lineage that replaces manual handoff documents.

---

## 2. Where the truth lives (normative specs)

This handoff summarizes; **these files decide.** If this doc and a spec disagree, the spec wins.

| File | Role |
|---|---|
| `docs/research/summaries/01-architecture-blueprint.md` | **NORMATIVE architecture.** Every decision for [X1]–[X4], the session-execution model per backend, observability pipeline, frontend stack, resource budget, and a §12 "contradiction ledger" of what was overridden and why. |
| `docs/research/summaries/02-stage2-implementation-plan.md` | **NORMATIVE build plan.** The three departments (BE/FE/SI), every work package (BE-1…BE-9, FE-1…FE-6, SI-1…SI-6), the repo layout, milestones **M0–M6** with definition-of-done, and the §9 testing strategy (positive/negative/edge matrix per package + cross-department integration suites). |
| `docs/research/summaries/00-executive-summary.md` | Narrative digest linking back to the 14 findings docs. |
| `docs/research/findings/*.md` | 14 deep research docs (one per topic: x1-parallel-multi-account, x2-secret-hygiene, x3-virtualization, x4-workstreams, observability, harness-architecture, session-substrate-tiebreak, pipeline-workflow-builder, frontend-app-shell-stack, frontend-stack-coherence, ui-anti-slop-design, ui-motion-3d-context-graph, local-resource-feasibility, opencode-serve-event-probe). Consult when you need depth. |
| `docs/spikes/*.md` | 5 spike verdict docs (A–E) with **empirical** results + normative contracts (e.g. `attachRenderer()` for xterm, the graph fps floor, the react-virtual follow-guard). Implementers MUST honor these. |
| `DESIGN.md` | **LOCKED** "Instrument Grade" design token system + a 20-item FORBIDDEN anti-slop list. All UI must pass `pnpm -F aibender-app lint:tokens`. Changing it requires an ADR + FE-ORCH sign-off. |
| `docs/contracts/*.md` | **FROZEN** interface contracts: `ws-protocol.md` (FROZEN-M2), `sqlite-ddl.md`, `bootstrap-file.md`, `hooks-contract.md`. Amend only via the freeze phase of a milestone or an ICR. |
| `SECURITY.md` | The [X2] doctrine, the tier model, the remediation playbook, and the **pending-owner ledger** (incl. the history rewrite in §5.1). |
| `docs/runbooks/*.md` | Operator procedures + per-milestone DoD records (`m0-dod.md`, `m1-dod.md`, `m2-dod.md`, login-bootstrap, version-gate, launchd, hooks-telemetry, pty-attended-live). |

---

## 3. Status — the milestone ledger

The program has three stages: **Stage 1** (research, no code) → **Stage 2** (implement + test,
milestones M0–M6) → **Stage 3** (adversarial review + fix, incl. mandatory screen-capture of the real
rendered frontend). You are inside **Stage 3** — the code review + fix loop is done; the rendered-frontend
screen-capture pass is the last remaining piece.

| Milestone | State | What it delivered |
|---|---|---|
| **Stage 1 — Discovery** | ✅ committed (`e978cee`) | 14 findings docs + 3 summaries from a 17-agent research fan-out. No code. |
| **M0 — Clean slate & risk burn-down** | ✅ committed (`98673ac`→`5804dca`) | [X2] hygiene stack (two-tier gitleaks, fail-closed pre-commit hook, CI), pnpm monorepo + 4 `@aibender/*` contract stubs, **DESIGN.md locked**, all **ten** risk spikes executed with verdicts. |
| **M1 — [X1] proven (synthetic)** | ✅ committed (`96b6872`→`04c395f`) | FROZEN-M1 protocol core + kernel SQLite schema; **BE-1 session kernel** (per-account env injection + scrub, resume ledger with row-before-spawn, transcript-tail validator, double-resume block, FakeQueryRunner seam); **BE-3 gateway control skeleton** + bootstrap discovery; **SI-2** account provisioning + keychain-probe + version-gate scripts. Synthetic 3-account concurrency demo passes (13/13 assertions). |
| **M2 — Attended cockpit** | ✅ committed (`533cfb8` freeze; `a04a1ab`→`20cb4f8` impl+gate; `096c6b1` hygiene follow-up) | Freeze: protocol → FROZEN-M2 + `bootstrap-file.md`/`hooks-contract.md` + 32 golden fixtures. Impl (8 packages, 3 orchestrator reviews w/ 9 material fixes applied, serial gate): **BE-2** ptyHost (node-pty attended sessions through the M1 spawn layer, SPIKE-D ack-ring flow control, liveSpawn-gated login bootstrap, recycle v0, ApprovalBroker + canUseTool wiring); **BE-3** gateway full (binary PTY streaming w/ backpressure, transcript.<sid> projection, approvals bridge, reconnect-replay journals, multi-client fan-out); **BE-4** adapters (supervised `opencode serve` + SSE dedupe + gated SecretFetcher, LM Studio down-as-state + JIT/TTL residency, [X2] credential-table read guard); **FE-2** Tauri v2 shell + `--smoke-test` + WS client + zustand/rAF state + cockpit chrome + single approval inbox; **FE-3** xterm/transcript islands (spike-A/C contracts, Playwright Chromium+WebKit); **FE-5** launchers (5-label picker + identifier-audit test); **SI-3** launchd/hook templates + merge-never-overwrite installer; **SI-6** full CI + `live-check.sh` T3 runner. Gate evidence: 1012 tests, 58 bats, 6-PTY soak (zero byte loss/dup, bounded memory), echo p95 0.14 ms, Tauri smoke exit 0, both gitleaks tiers clean. Record: `docs/runbooks/m2-dod.md` (deviations D1–D4; live items T3 pending-owner). |
| **M3 — Instruments live** | ✅ committed (`f086c50`→`bb7ef95`) | Freeze: protocol 1.1.0/FROZEN-M3 (`events` payload union closed: `event-summary` + `read-model-snapshot` w/ required per-source freshness; registries shared with schema CHECKs), schema migration 0002 events store (separate collector-owned db, validated insert path refuses identity shapes), hooks-contract §7 acceptance types + golden hook-POST corpus, ICR-0009 kernel message tap (the transcript-tee seam). Impl (all 3 reviews approve, 0 fixes): **BE-5** collector — full §6.1 source matrix (JSONL tailer, statusline tee + gated OAuth scaffold, loopback OTLP receiver, SSE dedupe + induced-disconnect gap-repair, guarded db scrape reconciling to identical evt_ ids, fake-only AWS pollers w/ live clients refusing sans opt-in, LM inline capture, hooks accepting endpoint w/ PermissionRequest→hook-floor relay, JSONL-wins-tokens/OTel-wins-attribution joiner); **BE-6** graph feed + freshness state machine (down-as-state) + all ten §6.3 read models (ccusage block math cited) + classification queue via BE-4; **FE-5** instrument dashboards (NO-SIGNAL doctrine, honest-labeling audit: "ACTUAL" unrenderable under estimate-only); **BE-MAIN** composeBroker wires every port (resolves M2 D3); **SI-4** Bedrock IaC authored + validated, **hard gate HELD** (no plan-with-creds/apply/AWS call). Gate: 1323 tests / 71 bats, identity audit double-proven (in-suite + gate's independent sweep, 0 hits/185 cells), soak still passes composed, both gitleaks tiers clean. Record: `docs/runbooks/m3-dod.md` (D1–D5). |
| **M4 — Lineage** | ✅ committed (`7478d3f`→`c623ffa`) | Freeze: protocol 1.2.0/FROZEN-M4 — schema migration 0003 lineage tables (harness-ids-primary, 8-edge enum w/ CHECK matrices), the `LineageRecorder` action-time port (§15.1), the bidirectional `workstream` channel (§16, merge verb + error contract), `SessionIdResolver` (§15.2, resolves the M3 §12 pin), hooks §7.1 [X4] automation routing w/ frozen SessionStart injection shape. Impl (all 3 reviews approve, 0 fixes; run was session-cap-killed mid-build and RESUMED with survivor-work directives): **BE-7** ledger/merge-engine (atomic ONE-node+N-merge_parent)/conflict-surfacing briefs (structurally appended after any model pass)/idempotent hook automation/reconciler (inferred orphans in one cycle, native-id dedupe)/pressure-watch/resolver + narrow kernel/ptyHost/composeBroker wiring; **FE-4** graph island (GraphStore→worker layout→Pixi WebGL2, spawn-at-referrer, layers/cluster-dim, reduced-motion; fixed 6 additional real bugs found test-driven); **FE-6** lineage view + merge flow (byte-identical golden frame) + the ONE ceremonial animation; **SI-3/5** X4 hook slots active in templates + colima pins/read-only probe/runbook. Gate: 1693 tests / 92 bats / 33 CI bats, 5k soak Chromium strict (p95 10.10 ms, ~40% headroom) + WebKit primary-form under 60Hz pin (deviation D1, control-experiment-diagnosed), fs-audit byte-identical + structural no-write-path scan, both gitleaks tiers clean, co-signs flipped for all M2/M3 rows (M4 rows pend next review). Record: `docs/runbooks/m4-dod.md`. |
| **M5 — Pipelines** | ✅ committed (`46b10c1`→`7cab37a`, gate on **Opus 4.8**) | Freeze: protocol 1.3.0/FROZEN-M5 — `dag-schema.md` v1 (step kinds prompt/skill/agent/workflow-script/approval, needs/when/forEach+maxParallel/loop, per-step account/budget/retry/outputSchema; forward-INCOMPAT unknown-kind rule since a DAG doc is load-bearing state), schema migration 0004 (pipeline_definition/pipeline_run/step_attempt = durable memoization journal, kernel db), `pipelines` channel (§18: catalog snapshots + run/step monitor payloads + 6 client verbs; approval gates ride the existing approvals channel via `workflow-gate` source). Impl: **BE-8** one catalog scanner/three consumers (malformed-YAML-surviving, unknown-key-preserving, workflow scripts static-parse-only per arch test; OpenCode API-first w/ file fallback) + versioned DAG engine (plan-time contentHash pinning, per-step account routing [X1], budget→AbortController+**real process-group reaping**, retry, outputSchema) + memoization journal (real store close/reopen resume, no re-exec) + lineage/cost integration (session_node + `workflow` edges, cost keyed `pipeline:<run>:<step>:<iter>`); **FE-6** builder (account routing visually first-class) + run monitor (deep-links the single M2 inbox, resume-from-journal). Note: run died once on the Fable 5 cap mid-freeze (no survivor work), relaunched clean on Opus 4.8; one Fix-phase agent hit the StructuredOutput retry cap but its 2 fixes were redundant with the SI reviewer's and landed anyway (commit succeeded ⇒ fail-closed gitleaks hook passed). Gate: 1981 tests, the 3-step MAX_A→AWS_DEV→LOCAL demo w/ mid-run approval pause/resume + broker-restart journal resume, both gitleaks tiers clean; all pending contract co-signs flipped. Record: `docs/runbooks/m5-dod.md`. |
| **M6 — Hardened v0 ship** | ✅ committed (`b6fe50b`→`5864cff`, Opus 4.8) | Freeze: protocol 1.4.0/FROZEN-M6 — added the `resource-health` read-model kind on the events channel (pressure state, per-session footprints w/ watchdog bands, shed/recycle notices as states; labels+numbers only [X2]); `docs/contracts/integration-suite.md` contract-of-record. Impl (all 3 reviews approve, 0 fixes): **BE-9** supervision governor (`core/src/supervision/`) — phys_footprint watchdog w/ sustained-window debounce, pressure-delta amber/red state machine (never naive free-RAM), the **[X1] sacrifice-order scheduler** (account sessions never the victim + account spawns honored under red — 500-iter property test), idle hibernation excluding account sessions, `~/.claude.json` monitor, recycle→continue-edge via ptyHost (doubles as [X4] continuation), resource-health publisher, composeBroker slice; **FE** resource-health instrument in the observability deck; **INTEG** the §9.3 cross-department integration suite (`test/integration/`, `pnpm test:integration`); **SI** dry-run Tauri v0 sidecar packaging (bundle ON, signing/notarize dry-run, debug build + `--smoke-test` proven), LaunchAgent-v1 validated-not-flipped, operator runbooks (recovery/quota-exhaustion/release). Gate: 2121 tests + 166 integration, `soak:m6` accelerated 2880-tick synthetic soak (accountSessionsShed 0, identityLeaks 0, within ~17 GB envelope; **real 24h soak is T4/pending-owner**), both gitleaks tiers clean, all contract co-signs flipped. Records: `docs/runbooks/m6-dod.md` + `docs/runbooks/stage2-complete.md`. |
| **Stage 3 · account-registry (M7)** | ✅ committed (`81a24b6`→`e5ae65f`, Opus 4.8) | **CRITICAL [X1] scalability FIX** landed immediately after M6, when the owner logged into a 4th/5th Max account (MAX_C/MAX_D) and they did not merely go "unseen" — a MAX_C/MAX_D launch would have **FAILED VALIDATION at multiple layers**: M6's `isAccountLabel()` was a hardcoded membership check against a 5-literal array (the wire check) and the schema CHECK constraints pinned the same 5 values, so a 5th account was **non-functional**, not just invisible. M7 relaxed the closed 5-set → an OPEN validated FORM so a newly provisioned account works with **no code change**. Details: [account-registry.md](runbooks/account-registry.md) + [ICR-0013](contracts/icr/icr-0013-account-registry.md). `vocab.ts` (was FROZEN-M1-CORE) closed 5-set → an OPEN validated FORM: `CLAUDE_ACCOUNT_LABEL_RE=/^MAX_[A-Z]$/` + `ENT`, with `AWS_DEV`/`LOCAL` staying closed as `FIXED_BACKEND_LABELS`; `isAccountLabel` keys off the form; `LABEL_BACKENDS` Record → `backendForLabel()` fn (pairing preserved); DAG `ACCOUNT_STEP_BACKENDS` → `accountStepBackendsFor()`. Runtime `core/src/kernel/accountRegistry.ts` discovers `infra/profiles/*.profile.json`; composeBroker threads `accountRegistry.labels()` → bootstrap `claudeAccounts` (ICR-0014 carrier); FE picker + channel panels + all deck chips enumerate the registry (`app/src/lib/accountRegistry.ts`), never a hardcoded 5 (ADR-0001 for the N-panel layout). Schema migrations 0005(kernel)+0006(events) relax the account CHECK to `GLOB 'MAX_[A-Z]' OR IN ('ENT','AWS_DEV','LOCAL')`; pairing CHECK kept. Protocol 1.4.0→**1.5.0**/FROZEN-M6→**FROZEN-M7**. [X2] MAX_<X> placeholder doctrine generalized (MAX_C/MAX_D first-class; no gitleaks rule changed). ICR-0013 + ICR-0014 BE-ORCH-ratified + FE-ORCH co-signed. Gate: **2210 tests/1 skip** (+89, no regression) + 166 integration + 99/46 bats, both soaks pass, both gitleaks tiers clean; N-account proof cited (form accept MAX_C/D + reject HACKER/MAX_AB; 4th/5th launch over composed broker; picker/panels render N w/ identifier audit intact; `provision --dry-run` PLANs 5). Records: `docs/runbooks/account-registry.md` + `add-an-account.md`. (One BE-core lane agent died on the StructuredOutput retry cap — its file writes landed and the BE-ORCH review + gate verified them directly; independently re-confirmed green.) |
| **Stage 3 — code review + fix** | ✅ committed (review `3af781b`/`df45878`; fixes `828ab83`→`bfef260`, Opus 4.8) | 5-dimension adversarial review (security/opt-scale/docs/[X1-X4]/frontend + full git-history leak scan, each finding adversarially refuted) → **30 findings (7 high)** in `docs/reviews/`. Fix team landed all 4 non-scale highs + all mediums + most lows across 5 batches: SEC-1 bootstrap-removal TOCTOU (atomic rename-to-marker), SEC-2 log-scrubber identity-map wiring, FE-1 registry-resync-on-restart, DOC-1 local-dev-start runbook, SEC-3 hooks per-boot token, X-1 merge-brief guard, X-2 audit-from-EVENT_SOURCES, OS-3 watcher off-event-loop, OS-4 supervision N-account soft-ceiling, OS-5 GraphStore LRU, FE-2/3/4, all DOC-*, SEC-4/5/6/7. Gate: **2272 tests/1 skip** (+62, no regression), 166 integration, 117 infra bats, both soaks pass, both gitleaks tiers clean. Every fix has a regression test. Records: `docs/reviews/README.md` + `docs/runbooks/stage3-fixes.md`. **OPEN (deferred):** OS-1 (backend-adapter registry — the "add a new LLM" twin of M7, milestone-sized), OS-2 (projection SQL-aggregation, design-latent), OS-6 (joiner pending-map cap, low). Two partial wirings noted: SEC-2's `reloadIdentityScrub` and SEC-3's hooks `authToken` are built+tested but not yet triggered/minted from the live composition root (small follow-ons). |
| **Stage 3 — rendered-frontend review** | ⬜ **NEXT / last piece** — unblocked (5 logins done) | Screen-capture the real running cockpit (vite dev server on :5173 with `window.AIBENDER_CLAUDE_ACCOUNTS` injected, captured via the preview MCP — quota-free; or the Tauri desktop app via computer-use) and critique the *rendered image* (layout, depth/motion, navigation, anti-AI-slop bar) — NOT source. Bedrock/LM-Studio panels need SI-4 apply / LM Studio start (separable, owner-gated); the Claude cockpit renders fully without them. |

**Two empirical wins already banked** (the riskiest Stage-1 assumptions, now proven on this machine):
- [X1] keychain isolation: the `claude` credential Keychain item **is** scoped per `CLAUDE_CONFIG_DIR`
  (service name = base `"Claude Code-credentials"` + first 8 hex of `sha256(NFC(dir))`), verified by
  read-only `strings` inspection of the shipping binary **v2.1.193**.
- The SDK's `query({ options.env })` **replaces** the child process environment (does not merge), which
  makes the [X1] env-scrub airtight. Verified against `@anthropic-ai/claude-agent-sdk` 0.3.201.

---

## 4. Exact repo state right now

- **HEAD:** `5864cff docs: M6 DoD and Stage 2 completion record`. Tree **clean**.
- **Baseline health:** `pnpm -r typecheck` clean (7 packages); **2121 tests pass / 1 skipped** (protocol 230,
  shared 36, testkit 95, schema 94, app 716, core 950+1 — the skip is the double-gated live-opencode
  placeholder); `pnpm test:integration` 166/12 files (§9.3 cross-department); `pnpm run test:infra` 93 bats
  + `infra/ci/tests/run.sh` 45; `pnpm -F aibender-app lint:tokens` clean (196 files); `test:islands` all
  three islands green Chromium + WebKit; `soak:m2` + `soak:m6` PASS. gitleaks tier-1 clean on a full-dir
  scan (cargo `target/` path-allowlisted — SECURITY.md §2); tier-2 clean except the known 12 `.git/logs`
  reflog echoes (see wart below). Protocol at **1.4.0/FROZEN-M6**; schema at **migration 0004**.
- **Layout** (see plan §2 for the full intended tree):
  - `packages/{protocol,schema,shared,testkit}` — shared, orchestrator-stewarded contract packages
    (testkit now carries the 32-fixture golden corpus + the promoted pty/gateway/adapter test doubles,
    ICR-0006/7/8).
  - `core/src/{kernel,gateway,adapters,collector,readmodels,workstreams,pipelines,supervision,main}` —
    the `aibender-core` broker daemon (BACKEND dept). ALL built: `kernel/pty/`, `gateway/`, `adapters/`
    (M2), `collector/`(+`graphfeed/`) + `readmodels/` (M3), `workstreams/` (M4), `pipelines/` (M5),
    `supervision/` (M6: watchdog, pressure probe, sacrifice-order scheduler, hibernation, governor);
    `composeBroker` wires every port incl. lineage + pipelines + supervision.
  - `app/` — the Tauri v2 frontend (FRONTEND dept). Built: `src-tauri/` (shell + `--smoke-test` +
    v0 sidecar bundle config, dry-run signing), `src/chrome/`, `src/lib/`,
    `src/islands/{terminal,transcript,graph}/`, `src/features/{launch,observability,workstreams,pipelines}/`
    (+ the M6 resource-health instrument in observability), plus the locked theme.
  - `test/integration/` — the §9.3 cross-department integration suite (`pnpm test:integration`, M6).
  - `infra/{profiles,scripts,launchd,hooks,aws,colima,ci}` — SERVER-SIDE dept. All populated:
    `profiles/`+`scripts/` (SI-2), `launchd/`+`hooks/` (SI-3, X4 slots active in templates), `ci/` +
    full `.github/workflows/` (SI-6), `aws/` (SI-4 IaC authored + validated; **apply pending-owner**),
    `colima/` (SI-5 pins + read-only probe; **VM ops pending-owner**).
  - `spikes/` — the 5 quarantined M0 spike harnesses (real, runnable, **never imported by prod code**).
  - `docs/{research,contracts,adr,runbooks,spikes}` — runbooks now include `m2-dod.md`,
    `pty-attended-live.md`, `launchd.md`, `hooks-telemetry.md`; `docs/contracts/icr/README.md` tracks
    the deferred watch items.
- **Known non-blocking wart:** `.git/logs/` reflogs still echo the pre-history author identity of the
  root commit `62d11d0`. Tier-2 gitleaks flags these 12 reflog lines. They are **not** a working-tree
  leak and cannot be cleared without the owner-gated history rewrite (see §6). Report them as
  pre-existing/pending-owner, exactly as M1/M2 did — do not try to "fix" them by expiring reflogs while
  the root commit still carries the identity.

---

## 5. The four cross-cutting requirements — how each is being implemented

Full detail in blueprint §3/§9/§10/§5 respectively. Summary of the *chosen* mechanisms:

- **[X1] Parallel per-account sessions.** Each of MAX_A/MAX_B/ENT gets its own `CLAUDE_CONFIG_DIR` with
  `CLAUDE_SECURESTORAGE_CONFIG_DIR` **pinned to the same path** → a distinct Keychain item per account →
  all three run concurrently from one broker process with zero re-login. One interactive `claude /login`
  per account, ever. Fallback ladder (blueprint §3): setup-token env injection → per-account Linux
  containers → separate macOS users. **Priority rule: if resource efficiency ever conflicts with
  parallel multi-account capability, the capability wins.** Implemented by SI-2 + BE-1 (+BE-2 login
  bootstrap, +BE-9 sacrifice order).
- **[X2] Public-repo secret hygiene.** Keychain-primary runtime secrets; env-interpolated committed
  config; **two-tier gitleaks** (tier-1 value-free rules in-repo at `.gitleaks.toml`; tier-2 real
  literals in an **out-of-repo** file at `~/.aibender/private/gitleaks-tier2.toml`, chmod 600);
  fail-closed pre-commit hook; CI backstop. Placeholders `MAX_A/MAX_B/ENT/AWS_DEV_ACCOUNT_ID` everywhere.
  Fixtures synthesized, never copied from real transcripts. SOPS deferred (blueprint §12 ledger #5).
- **[X3] Virtualization = PARTIAL.** Harness core is **host-native** (guarantees LM Studio
  `127.0.0.1` reachability by construction). The existing k3s-in-Colima cluster is *kept but demoted*
  to an optional telemetry adjunct and shrunk. k3s is **never** a dependency of session launch.
  Implemented by SI-5 (+ an architectural test that `core/` imports nothing from `infra/`).
- **[X4] Workstreams.** A harness-owned SQLite lineage ledger (`workstream`/`session_node`/
  `session_edge`/`brief`) with typed edges recorded at *action time*; a continuation is a **child**
  (not a sibling); a **merge** is one new node with N `merge_parent` edges seeded by a synthesized,
  conflict-surfacing brief; hook-automated briefs replace manual handoff docs; native stores never
  mutated. Implemented by BE-7 (+SI-3 hook wiring, +FE-6 UI). Lands M4.

---

## 6. HARD GATES — owner-gated actions you must NOT perform

These require the **owner's explicit verbal OK, per action**. Do not perform them on assumption; the
auto-mode classifier will (correctly) block several of them anyway. When you reach one, implement
everything *up to* it, script/document it, list it in the milestone's pending-owner items, and stop.

1. **No `git push` / no history rewrite.** Everything stays **local-only** until the owner runs the
   [X2] history rewrite that scrubs the work-email author identity from the root commit `62d11d0`
   (procedure scripted in `SECURITY.md §5.1`: a `git-filter-repo` email callback mapping the
   work-domain email → the GitHub noreply address, then a force-push). **Pushing more history on top
   before that rewrite makes the leak permanent.** The classifier blocks `git commit --amend` on the
   root commit; do not fight it.
2. **No `terraform apply`** for the Bedrock **application inference profile** (SI-4). Author the IaC,
   run `terraform plan`, show it, **stop**. This is the External System Write Policy.
3. **No Colima VM resize / start / stop** (SI-5) without an OK — it causes brief downtime.
4. **No real `claude /login` or logout, no keychain writes, never `security ... -w`.** `~/.claude` is
   **read-only** to you. The three one-time logins are owner-run per `docs/runbooks/login-bootstrap.md`.
   (Note: probing the Keychain for credentials is itself classifier-blocked — don't.)
5. **No LM Studio start, no cost-incurring model calls.** You *may* spawn a temporary local
   `opencode serve` for adapter integration tests **if** the binary exists — health/list/event
   endpoints **only**, never message/inference calls (they cost money) — and kill it when done.
6. **No GitHub mutations** beyond what the owner has already sanctioned (push protection is already on).

The practical consequence: every milestone is proven in a **synthetic** edition (fakes, temp
`$AIBENDER_HOME`, stub processes). The **live** proofs (real logins, real TUIs, real Bedrock USD) are
recorded as **T3 pending-owner** items in each `docs/runbooks/mN-dod.md`. That is by design — do not try
to make them "real" yourself.

---

## 7. Secret hygiene rules for *you* (critical — you are in a different account, public repo)

- **Never write a real account email, real AWS account ID, token, or key into any repo file** — not in
  code, comments, tests, fixtures, docs, or commit messages. Use `MAX_A / MAX_B / ENT /
  AWS_DEV_ACCOUNT_ID`.
- The **only** place real literals live is the out-of-repo tier-2 gitleaks config at
  `~/.aibender/private/gitleaks-tier2.toml` (chmod 600). It already exists on this machine. You never
  need to read it; the pre-commit hook uses it automatically.
- **Repo git identity is already set** to the owner's GitHub `…@users.noreply.github.com` noreply
  address (see `git config user.email` in the repo — not repeated here so tier-1 gitleaks stays strict).
  Do not change it. Your account's real email must never author a commit here.
- **The pre-commit hook is the enforcement, not your diligence.** It runs gitleaks tier-1 + tier-2 and
  **fails closed**. Never bypass with `--no-verify`. If it blocks on a genuine false positive, extend
  the tier-1 allowlist minimally and document why in `SECURITY.md`.
- Every agent you spawn in a workflow must be told these rules (the `COMMON` preamble in the
  orchestration runbook already contains them — reuse it).

---

## 8. How the build actually gets done (the methodology)

This project is **not** built by hand-editing files one at a time. It is built by **multi-agent
Workflow orchestration**, and you must continue in the same style so the work stays parallel, reviewed,
and consistent. The full, reusable pattern — the `COMMON` agent preamble, the JSON schemas, and the
five-phase skeleton — is in **[`docs/runbooks/workflow-orchestration.md`](runbooks/workflow-orchestration.md)**.
Read it before launching anything. In brief:

- **Three departments**, each with an **orchestrator acting as principal engineer**:
  **BE** (backend broker, owns `core/` + stewards `packages/*`), **FE** (frontend Tauri app, owns
  `app/` + `DESIGN.md`), **SI** (server-side config/infra, owns `infra/` + repo-root hygiene + CI).
- **Zero-conflict parallelism via exclusive directory ownership.** Each work package owns specific
  directories for the whole stage; cross-package needs go through `packages/*` interfaces or an
  **ICR** (interface change request) that the owning orchestrator lands. This is what lets 2–4
  implementer agents per department run simultaneously without merge conflicts.
- **Every milestone is one Workflow run with the same phases:**
  `Freeze` (BE-ORCH freezes the contracts this milestone needs) → `Build` (implementers in parallel) →
  ICR stewardship → `Review` (each orchestrator reviews its department's diffs, returns a `fixes` list)
  → `Fix` (apply required fixes) → `Gate` (a single **serial committer agent** runs typecheck + tests +
  soaks + gitleaks, writes the `mN-dod.md`, and lands the conventional commits **locally**).
- **Agents never commit.** Only the gate agent commits, and only locally (never pushes).
- **Honesty rule:** agents must return `tests_passed: false` with notes rather than a false green. The
  orchestrator reviews and the gate re-verify independently.

**You (the driving session) are the quality gate above the gate.** After each workflow completes,
independently verify: read the gate's report, re-run `pnpm -r test` and `gitleaks dir .` yourself,
confirm the commits landed and the tree is clean, and read the `mN-dod.md` for honesty before moving on.

**Local-model offload (optional, no API cost):** a `local-llm` MCP server (Ollama `qwen2.5-coder:7b`)
is available for mechanical/high-volume first-draft work — but **you review everything it produces**;
it is never the reviewer or authority. See the owner's global policy. Not required to make progress.

---

## 9. HOW TO PROCEED

### 9.1 IMMEDIATE NEXT ACTION — Stage 3 (adversarial review & fix)

**All of Stage 2 (M0–M6) is DONE** (see §3 + `docs/runbooks/stage2-complete.md`). The workflow scripts
that built every milestone are saved under
`~/.claude/projects/-Users-chris-dare-Personal-SourceCode-the-last-aibender/894bbe44-c473-4c8b-b7e4-633d58bc246b/workflows/scripts/`
(`stage2-m2-impl`, `stage2-m3`, `stage2-m4`, `stage2-m5`, `stage2-m6`) — reuse them as structural
references for the Stage-3 workflows.

**Recovery/ops lessons banked across Stage 2** (all proven in-flight): (a) a mid-**build** session-cap
death is resumable with `resumeFromRunId` + survivor-work directives appended to the dead builders'
prompts, freeze prompt kept byte-identical so its cache holds (M4); (b) a death **during the freeze**
leaves nothing cached — relaunch clean (M5); (c) redundant reviewer coverage means one Fix-agent death
rarely loses a fix (M5); (d) on the `claude-fable-5` limit, `/model claude-opus-4-8` and relaunch —
workflow agents inherit the session model (M5+M6 gates ran on Opus 4.8). Opus 4.8 occasionally trips
`parallel[N] failed: StructuredOutput retry cap` on schema'd agents; it has self-recovered so far, but
after any workflow **always** run the §8 independent verification and reconcile agent deaths by hand.

Stage 3 splits into a part you can run **now** and a part **gated on the owner's live logins**:

**9.1a — Adversarial code review (RUN NOW, no logins needed).** Author a Workflow (e.g.
`stage3-review`) fanning out reviewer/adversary agents, each writing a findings doc under
`docs/reviews/`:
- **Security** — [X2] deepest: scan the ACTUAL git history for leaked identifiers (`gitleaks git`
  both tiers over all commits — already clean, but re-prove adversarially), plus the credential-table
  guard, the SecretFetcher never-serialized property, the loopback-only binds, the hooks endpoint.
- **Optimization / scale** — *is it easy to add a new Claude account or a new local LLM?* (the plan's
  named scalability test); the resource envelope; hot paths (ring buffers, rAF projection, the graph
  worker).
- **Documentation / new-engineer onboarding** — would the repo layout + contracts + runbooks let a
  fresh engineer land safely? where would they be confused?
- **[X1]–[X4] stress** — parallel multi-account robustness; secret hygiene; [X3] LM-Studio-still-
  connects + k3s-never-a-dependency; [X4] branch/merge correctness.
Then a **principal-engineer fix team** Workflow addresses every finding (same Freeze→Fix→Gate shape,
gate commits locally).

**9.1b — Mandatory rendered-frontend review (NEEDS OWNER + LIVE LOGINS — coordinate).** Agents must
**screen-capture the actual running frontend on macOS** (via the `computer-use` MCP, or
`mcp__Claude_Preview__*` for a served web build) and critique the *real rendered image* — they must
**NOT** fall back to reading source. This requires the app to actually run:
- Best case: the owner completes the three one-time `claude /login`s (`docs/runbooks/login-bootstrap.md`)
  so the cockpit shows live data — then the rendered review covers real dashboards/graph/lineage.
- Fallback without logins: a synthetic-broker-backed dev build renders the chrome/layout/navigation
  (panels in their NO-SIGNAL state) — enough to critique composition, depth/motion, and first-run
  navigation, but not live data. Decide with the owner which to do.

**Owner-gated items still open** (consolidated in `stage2-complete.md` §3 / each `mN-dod.md`): the [X2]
history rewrite + first push; the three real logins; SI-4 `terraform apply`; SI-3 live installs; the
real 24 h soak; real Tauri sign+notarize; LaunchAgent-v1 flip; colima VM ops. None block 9.1a.

---

## 10. Environment specifics (this machine)

- **Hardware/OS:** Apple M4 Max, 14 cores, 36 GB RAM, macOS 26.6. Memory is the binding resource (blueprint
  §11 budget: full target ~8.7 GB typical / ~17 GB pessimistic).
- **Toolchain present:** node **v25**, npm 11, **pnpm** (install via `npm i -g pnpm` if absent), cargo/
  rustc 1.93 (for Tauri `src-tauri`), **gitleaks 8.30** (`brew install gitleaks`), terraform 1.15, jq,
  sqlite3 3.51, Xcode CLT. Playwright is used by the spikes/islands (Chromium + WebKit).
- **`$AIBENDER_HOME`** (machine-local, never in repo) = `~/.aibender/`: `accounts/{max-a,max-b,ent}/`
  (the per-account `CLAUDE_CONFIG_DIR`+securestorage targets), `db/`, `bootstrap/gateway.json`, `logs/`,
  `private/gitleaks-tier2.toml`, `state/` (version-gate baselines), `quota/<label>.json`. Provisioned by
  SI-2 scripts; real logins are owner-run.
- **LM Studio:** default `127.0.0.1:1234`, **usually down** — tolerate it; never auto-start it.
- **OpenCode:** `oc-bedrock` shell function + `~/.config/opencode/opencode.jsonc`. The `opencode` binary
  may or may not be installed; adapters must degrade if absent.
- **SQLite in code:** prefer `node:sqlite` (Node ≥22.5, zero native deps) behind the `@aibender/schema`
  adapter; a `better-sqlite3` swap path is documented in `driver.ts` / `sqlite-ddl.md`.

---

## 11. Gotchas & recovery patterns (learned the hard way)

- **A workflow can die mid-run on usage/session limits** (this is exactly what happened to M2, and
  earlier to an M0 gate). The `Freeze` agent had already produced healthy work that no gate had
  committed — it sat uncommitted until verified and committed by hand. **After every workflow, check
  `git status` for uncommitted survivor work** and for a `<name>.output` task file with per-agent
  results; salvage anything healthy (verify typecheck+tests+gitleaks, then commit with the message the
  gate *would* have used).
- **`Workflow resumeFromRunId` is same-session only.** A different session cannot resume a prior run —
  it must author a fresh workflow (this is how M2's impl was recovered: a fresh `stage2-m2-impl`
  authored from the runbook skeleton + the saved script of the dead run).
- **The auto-mode classifier blocks** credential-store probing and history rewrites of pre-session
  commits. These blocks are *correct* — surface them to the owner, don't work around them.
- **Session-limit hardening for long workflows:** keep milestones to one Workflow each; the serial gate
  commits at the end so a mid-run death never loses *committed* progress. If you expect to be near a
  limit, prefer smaller per-milestone workflows over one mega-run.
- **Never let an agent's confident summary substitute for your own verification.** Re-run the checks.

---

## 12. Command cheat-sheet

```bash
cd ~/Personal/SourceCode/the-last-aibender

# health baseline (expect 374 tests green at 533cfb8)
pnpm install
pnpm -r typecheck
pnpm -r test
pnpm -F aibender-app lint:tokens        # DESIGN.md token enforcement
pnpm run test:infra                      # SI bats + shellcheck (if present)

# secret hygiene (both must be clean)
gitleaks dir . --config .gitleaks.toml
gitleaks dir . --config ~/.aibender/private/gitleaks-tier2.toml --redact

# state
git log --oneline -15
git status --porcelain

# the normative specs — READ THESE
$EDITOR docs/research/summaries/01-architecture-blueprint.md
$EDITOR docs/research/summaries/02-stage2-implementation-plan.md
$EDITOR docs/runbooks/workflow-orchestration.md    # how to drive the build
```

**Golden rule:** local-only, placeholders-only, verify-everything, and honor the hard gates in §6.
When in doubt, the blueprint and the plan decide — this handoff only points the way.
