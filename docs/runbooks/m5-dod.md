# M5 gate record — pipelines (features 4 & 5, synthetic edition)

**Gate run:** 2026-07-05 · **Scope:** plan §8.2 M5 · **Statuses:** `done` /
`done-with-deviation` (named) / `pending-owner`.

> **X2 reminder:** nothing in this file names a real identity. Real values
> (account mappings, AWS account id, SSO profile names) are referenced by
> class only, per [SECURITY.md](../../SECURITY.md) §1. Every pipeline/catalog
> payload carries paths + step ids + placeholder account labels only.

The M5 DoD's live halves ride a real catalog scan of the real account config
dirs and a real 3-backend pipeline run (MAX_A Claude + AWS_DEV Bedrock + LOCAL
LM Studio, each incurring real cost) — both **pending-owner by rule** (rule 3:
~/.claude is READ-ONLY, no cost-incurring model/inference/AWS calls, saved
dynamic-workflow scripts are STATICALLY parsed and NEVER executed). Everything
provable synthetically is proven below against the REAL surfaces: the real DAG
validator, the real catalog scanner over fixture trees, the real runner over a
real `@aibender/schema` memoization journal (file-backed for the restart
proof), the real composed broker fanning the frozen `pipelines` + `approvals` +
`workstream` frames over ONE WebSocket, and a REAL detached OS process group
for the reaper. Every pipeline step runs against `FakeStepExecutor` /
`FakeQueryRunner` (rule 3: no real spawn / inference / cost anywhere).

---

## 1. Gate-run evidence (what the gate actually executed)

| Check | Command | Result |
|---|---|---|
| Install | `pnpm install` | clean, 7 workspace projects, already up to date |
| Typecheck | `pnpm -r typecheck` | clean across all 6 packages (TS strict) |
| Unit/component tests | `pnpm -r test` | **1981 pass / 1 skipped, 169 files, 0 fail** — protocol 209, shared 36, testkit 95, schema 94, app 680, core 867+1 (the skip is the double-gated live `opencode serve` spec placeholder, unchanged since M2) |
| Infra suite | `pnpm run test:infra` | **92/92 bats pass** — SI-2 accounts 22, SI-3 launchd 13, SI-3 hooks 27, SI-4 aws-iac 13, SI-5 colima 17; shellcheck clean (no M5 infra change) |
| CI-side suite | `bash infra/ci/tests/run.sh` | **33/33 bats pass** — live-check registry pinned at 13 rows; branch-protection contexts match ci.yml job names; shellcheck clean |
| Token lint | `pnpm -F aibender-app lint:tokens` | OK — **189 files scanned, 0 violations** (DESIGN.md locked; +23 files vs M4's 166 — the pipelines builder/deck/run-monitor surfaces + CSS included) |
| SPA build | `pnpm -F aibender-app build` | vite 8.1.3 build OK, 1178 modules (single >500 kB chunk warning, ~1.31 MB with pixi.js — M6 packaging concern, unchanged class) |
| src-tauri untouched | `git status` on `app/src-tauri` | **no diff** — M5 FE work never entered the shell; cargo suites not re-run by rule |
| islands untouched | `git diff --name-only app/src/islands/` | **empty** — M5 touched no island code (terminal/transcript/graph); `test:islands` regression not required per the gate note |
| Golden corpus ↔ FE client | `vitest run src/lib/ws/goldenCorpus.spec.ts` (app) | **114/114** — the M5-extended corpus (`pipelines-payload` + `pipelines-client-message` stages, one valid frame per kind + each verb + every invalid class) through the REAL inbound router |
| Golden corpus ↔ BE gateway | `vitest run src/gateway/serverGolden.spec.ts` (core) | **67/67** — byte-for-byte replay over a real WebSocket against the live gateway |
| Golden corpora reference | testkit suite (`wsGolden` + `hooksGolden`) | **22/22** self-checks green; `GOLDEN_WS_CORPUS_FREEZE = 'FROZEN-M5'` = protocol freeze (`1.3.0`) |
| M2 approval round-trip | `vitest run src/main/m2ApprovalRoundTrip.spec.ts` (core) | **3/3** — unchanged post-M5 wiring |
| Composed broker e2e | `vitest run src/main/composedBroker.spec.ts` (core) | **9/9** — launch → attended pty → approval → transcript + all publisher lanes over ONE socket |
| Composed workstreams e2e | `vitest run src/main/composedWorkstreams.spec.ts` (core) | **5/5** — §16.5 boot snapshot, control-verb launch → `workstream-node` fan-out, frozen merge verb end-to-end, ICR-0009 tee → branch-advisory, ptyHost recycle → continue self-edge |
| Composed pipelines e2e | `vitest run src/main/composedPipelines.spec.ts` (core) | **2/2** — THE DEMO (§3 item below) + the absent-slice `pipeline-not-found` degrade |
| 6-PTY soak + echo | `pnpm -F aibender-core soak:m2` | **PASS post-M5-wiring** — 6 sessions/1 slow consumer, slow-consumer in-flight capped at the 1 MiB window, producer plateau stable at ~2 MiB, **zero byte loss**; echo p50 0.089 ms · **p95 0.125 ms** · p99 0.163 ms (budget 100 ms); RSS peak delta 146 MB |
| M3 regression suites | `vitest run src/collector src/readmodels` (core) | **160/160, 16 files** — collector all 8 sources, freshness, ten read models, graphfeed, x2Audit 4/4 |
| M5 DoD proof suites (core) | `vitest run src/pipelines src/gateway/serverPipelines.spec.ts src/main/composedPipelines.spec.ts` | **85 + 2 = 87 tests, 11 files** (per-test citations in §3) |
| M5 DoD proof suites (app) | `vitest run src/features/pipelines` | **82/82, 10 files** (per-test citations in §3) |
| Protocol DAG validator | `vitest run src/dag/validate.spec.ts src/m5Payloads.spec.ts` (protocol) | **73/73** — every `DAG_ISSUE_CODE` class + the forward-INCOMPAT rule + the `pipelines` wire payload/verb validators |
| Schema pipeline journal | `vitest run src/pipelines.spec.ts src/migrate.spec.ts` (schema) | **29/29** — migration 0004 tables + `findMemoized` resume lookup + accessors |
| Tier-1 scan (full dir) | `gitleaks dir . --config .gitleaks.toml` | **CLEAN** (11.17 MB scanned; no leaks; cargo `target/` path allowlist in effect per SECURITY.md §2) |
| Tier-2 scan (full dir) | `gitleaks dir . --config <tier-2> --redact` | **exactly the 12 known `.git/logs` reflog echoes** (6 `HEAD`, 4 `refs/heads/main`, 2 `refs/remotes/origin/main`) — **zero findings outside `.git/logs`**; pending-owner item 1, unchanged |
| Tier-1 + Tier-2 (history) | `gitleaks git .` both configs | **CLEAN both** — 41 commits scanned, no leaks (the reflog echoes exist only in the working-dir `.git/logs`, never in committed history) |

## 2. Deliverables (plan §8.2 M5)

| Deliverable | Status | Notes |
|---|---|---|
| M5 contract freeze (protocol `1.3.0` / `FROZEN-M5`) | **done** | `pipelines` channel frozen (ws-protocol §18: `catalog-snapshot` / `pipeline-run-snapshot` / `pipeline-run-status` / `pipeline-step-status` [per-step cost ref + the `memoized` resume state] / `pipeline-validation-result` / `pipeline-saved`, plus the six client verbs `validate·save·launch·pause·resume·cancel` with the §18.4 error contract); approval GATES ride the EXISTING approvals channel via the frozen `workflow-gate` source (§10.1/§18.3 — the M2 one-inbox precedent, no new gate wire); new closed registries `CAPABILITY_KINDS`/`CATALOG_SCOPES`/`CAPABILITY_BACKEND_FAMILIES`/`PIPELINE_RUN_STATES`/`PIPELINE_STEP_STATES`/`PIPELINE_CLIENT_VERBS`; error codes `pipeline-not-found`/`pipeline-run-not-found`/`pipeline-invalid`/`step-not-found`. Co-sign state in §6 |
| [dag-schema.md](../contracts/dag-schema.md) v1 | **done** | FROZEN-M5 v1: step kinds prompt·skill·agent·workflow-script·approval; `needs`/`when`/`forEach`+`maxParallel`/`loop`; per-step `account`/`backend`/`budget`/`retry`/`outputSchema`/`onError`; account↔backend consistency (§3); the seven `DAG_ISSUE_CODES` and the fixed validation ORDER (§4); the **forward-INCOMPAT rule** (§5 — the OPPOSITE of the wire's forward-tolerant unknown-kind rule: a DAG document is load-bearing execution state, an unknown `schemaVersion`/`kind` is REFUSED); the `workflow`-edge lineage seam pin (§6 — verified complete without amendment; the runner records edges directly, not via the LineageRecorder port). Machine-checkable half `packages/protocol/src/dag/` (`DAG_SCHEMA_VERSION = 1`) |
| schema migration 0004 (pipeline defs + memoization journal) | **done** | sqlite-ddl §10: `pipeline_definition` (saved versioned JSON DAG verbatim + schema_version re-validated on load + schema_hash drift) + `pipeline_run` (status enum pending·running·paused·completed·failed·cancelled) + `step_attempt` = THE memoization journal (append-only UNIQUE (run_id, step_id, iteration, attempt); `findMemoized` returns a completed/`memoized` attempt's cached output → no re-execution; state enum incl. `blocked`/`awaiting-approval`/`memoized`/`skipped`; nullable session_id = the `workflow`-edge target); KERNEL_MIGRATIONS (same commit boundary as the `workflow`-edge session_nodes); label-enum account CHECK [X2] |
| BE-8 catalog scanner + pipeline DAG engine | **done** | `core/src/pipelines/`: the ONE capability-catalog scanner, three consumers (Claude skills/commands via single merged-frontmatter parser preserving unknown keys + surviving malformed YAML; agents; plugins install×enablement×scope; saved workflow scripts STATIC meta only) per (workspace, account-config-dir) with documented precedence + walk-up; OpenCode capabilities API-first (`GET /agent`/`/command`) with file fallback. The versioned JSON DAG engine: topological runner honoring `needs`, plan-time capability resolution pinned by sourcePath + contentHash, per-step `account` routing (the [X1] differentiator), `budget`/`retry`/`outputSchema`, first-class `approval` gates, per-step AbortController + child-process-GROUP reaping, the durable SQLite memoization journal for cross-restart resume, every step attempt = a `session_node` with `workflow` edges (recorded directly on the lineage store), per-step cost via the events `(backend, raw_ref)` key |
| BE-8 wire + composeBroker slice | **done** | `serverPipelines` gateway handler over the frozen `pipelines` channel + `publishPipeline`; composeBroker injects the pipelines slice like the M4 workstreams slice (absent-slice degrades to `pipeline-not-found`); [ICR-0012](../contracts/icr/icr-0012-gateway-pipeline-slice.md) ratified (BE-ORCH) |
| FE-6 pipeline builder slice | **done** | `app/src/features/pipelines/`: builder canvas → schema-valid DAG (validated client-side against the frozen validator, server as authority); per-step account-routing chips (the [X1] differentiator, visually first-class); first-class approval-gate node; palette fed by the catalog scanner snapshot (degraded entries render as instrument states, never hidden); run monitor with per-step cost/status from the events store, the resume-from-journal affordance (`paused + resumable`), and memoized steps read as cached; the workflow gate deep-links THE single M2 inbox (no second inbox); bound to `CHANNEL.PIPELINES` with replay-from-zero; registered in `main.tsx`; the BUILDER center-view toggle |

## 3. DoD checklist (plan §8.2 M5, item by item)

Proof suites named here were run at the gate (§1); every cited test passed.

| # | DoD item | Status | Evidence |
|---|---|---|---|
| 1 | Catalog scanner passes the fixture-tree suite (precedence, walk-up, malformed-YAML survival, unknown-key preservation) | **done** (fixture trees by rule) / real account dirs **pending-owner** | `core/src/pipelines/catalog/scanner.spec.ts` (15) + `frontmatter.spec.ts` (8): **PRECEDENCE** — "enterprise beats user beats project on a name collision", "a skill beats a command of the same name"; **WALK-UP** — "loads project skills from cwd AND every parent up to the repo root", "nearest .claude wins on a duplicate name during walk-up", "stops at the repo root — a .claude above the ceiling is not scanned"; **MALFORMED-YAML SURVIVAL** — "surfaces a malformed skill as a degraded row, never a crash" + four frontmatter degrade-and-recover-body rows; **UNKNOWN-KEY PRESERVATION** — "preserves unknown frontmatter keys scanner-side" + "preserves Obsidian-style user keys verbatim alongside known keys". Plus the account-dimension + plugin install×enablement×scope rows |
| 2 | Lists OpenCode capabilities **API-first** | **done** | `scanner.spec.ts` "OpenCode API-first + file fallback": "uses the serve API when present (source of truth)" + "falls back to file scan when the serve API answers undefined (serve down)" |
| 3 | Demo pipeline runs 3 steps across **MAX_A → AWS_DEV (OpenCode/Bedrock) → LOCAL (LM Studio)** with an approval gate in the middle, **paused and resumed from the inbox** | **done** (fake-driven, over the REAL composed broker) / real 3-backend run **pending-owner** | THE DEMO: `core/src/main/composedPipelines.spec.ts` "runs 3 steps across MAX_A → AWS_DEV → LOCAL with an approval gate, paused + resumed from the inbox" — over ONE composed broker: `pipeline-launch` wire verb → engine runs `research` on MAX_A → pauses at the `sign-off` `approval` step, which fans a `workflow-gate` `approval-request` on the EXISTING approvals channel; downstream steps have NOT run (walk paused); an `approval-decision` from the inbox resumes the walk → `bedrock` runs on AWS_DEV/backend bedrock → `summary` on LOCAL; run/step status (incl. `awaiting-approval`) fans out on the `pipelines` channel. Unit-level pause/resume: `runner.spec.ts` "pauses on an approval step; an allow decision resumes the walk" + "a denied gate fails the downstream branch"; account routing: "routes each step to its own account (the [X1] differentiator)" |
| 4 | Broker restart mid-run **resumes from the memoization journal WITHOUT re-executing completed steps** | **done** (REAL store close/reopen) | `core/src/pipelines/runner.spec.ts` "broker restart mid-run resumes from journal (edge, DoD) — reopens a REAL store torn down mid-run and does not re-execute completed steps": a **file-backed** `@aibender/schema` store runs `s1` (journaled) then fails `s2`; the store is `close()`d mid-run (the broker restart); a second `openKernelStore` on the SAME file resumes — `s1` is a cache hit (executor never called for it), only `s2` re-runs. Memoization unit proof: "a re-run of a completed step returns cached output WITHOUT re-execution" (the completed attempt journaled as `memoized`) |
| 5 | Every step visible as a `session_node` with `workflow` edges | **done** | `core/src/pipelines/lineageCost.spec.ts` "registers a session_node per step and a workflow edge between them"; the wire-level proof in `composedPipelines.spec.ts` (THE DEMO) asserts ≥3 `workstream-node` frames and ≥1 `workstream-edge` with `edgeType === 'workflow'` fanned out on the `workstream` channel. The runner records these edges DIRECTLY on the lineage store (dag-schema.md §6 — the LineageRecorder port is kernel-scoped) |
| 6 | Per-step cost visible in the run monitor from the events store | **done** | Backend: `lineageCost.spec.ts` "a retry re-ingest of the same iteration DEDUPES on (backend, raw_ref)", "a distinct iteration is a distinct cost key (forEach fan-out)", "AWS_DEV cost lands on the opencode backend (pairing satisfied)", "lineage/cost are fire-and-forget: a store failure never throws" — cost keyed `pipeline:<runId>:<stepId>:<iteration>` in the events store. Frontend: `app/src/features/pipelines/runMonitor.spec.ts` "uses the run record cost when present", "sums the step rows when the run has no rollup", "lists distinct accounts the run routed across (the [X1] summary)", "memoized and completed both read as OK (settled, cached)" |
| 7 | Budget breach aborts the step with **process-group reaping (no orphan children)** | **done — REAL process group** | `core/src/pipelines/reaper.spec.ts` "REAL process group (integration) — reaps a real detached group so the grandchild child dies too": spawns a REAL detached group (`sh -c 'sleep 120 & sleep 120'`), confirms the group is alive via `kill(-pgid, 0)`, reaps it (SIGTERM → SIGKILL after grace), and confirms the WHOLE group is gone — the native-#69856 orphan failure mode defeated. Wired through the runner: `runner.spec.ts` "budget breach aborts + reaps (negative, DoD) — a wall-clock budget breach aborts the hanging step and reaps its group" (real 1 s timer; the step's group is reaped, the attempt journaled `failed`) + "run cancel aborts in-flight steps and reaps all groups" |

## 4. Gate deviations (named, minimal)

- **D1 — "demo pipeline runs 3 steps across three backends" (DoD item 3) means
  fake-driven over the real composed broker.** Every step runs against
  `FakeStepExecutor` / `FakeQueryRunner` (rule 3: no real spawn / inference /
  cost; pipeline steps in tests run against the testkit fakes ONLY). The
  cross-account routing, the approval-gate pause on the EXISTING approvals
  channel, the inbox-decision resume, the per-step cost, and the
  `session_node`/`workflow`-edge fan-out are all proven over a REAL composed
  broker (`composeBroker` → real gateway → real WebSocket → real lineage +
  events + pipeline stores). The real 3-backend run — MAX_A Claude + AWS_DEV
  Bedrock + LOCAL LM Studio, each a cost-incurring call — is the live half
  (pending-owner item 2).
- **D2 — the catalog scanner runs over fixture trees, never `~/.claude`
  (rule 3).** `~/.claude` is READ-ONLY; the scanner tests build synthetic
  `.claude/` fixture trees (skills/commands/agents/plugins/workflow-script
  meta) and exercise precedence, walk-up, malformed-YAML survival and
  unknown-key preservation against them. The real catalog scan of the real
  account config dirs is the live half (pending-owner item 3).
- **D3 — saved dynamic-workflow scripts are STATICALLY parsed (meta only),
  NEVER executed (rule 3).** `core/src/pipelines/catalog/arch.spec.ts` is the
  architectural enforcement: "`scanner.ts`/`workflowMeta.ts`/`frontmatter.ts`
  contain no code-execution primitive" and "workflowMeta returns meta from
  source text, never a live object". The `workflow-script` step kind is an
  INTEROP scan/import/observe target, never the execution foundation
  (dag-schema.md §2, findings §R4).
- **D4 — the reaper's real-process integration test spawns `sleep`
  processes, not model/inference calls** (the rule-3 temporary-local-process
  exception; every spawned pid is SIGKILL'd in `afterEach`). This is the
  genuine "no orphan children" proof and is the only real-process spawn in the
  M5 suites.
- **D5 — the memoization-journal restart proof uses a file-backed store in
  the scratchpad** (`:memory:` would vanish on `close()`). It is a real
  `@aibender/schema` store closed and reopened on the same path — the honest
  "broker restart" surface.

## 5. Pending-owner consolidated (T3, unchanged rules)

1. **History rewrite + reflog identity** (M0 §5.1, SECURITY.md): the 12
   `.git/logs` reflog echoes of the root-commit author identity; rewrite +
   `git push` are owner actions. Unchanged since M0 (committed history is
   clean — `gitleaks git` both tiers scan 41 commits with no leaks).
2. **Real 3-backend pipeline run** (the M5 DoD item 3 live half): a real demo
   pipeline routing MAX_A (Claude) → AWS_DEV (OpenCode/Bedrock) → LOCAL
   (LM Studio) with the mid-pipeline approval gate — each step a cost-incurring
   call. Gated by the three one-time logins (item 4 below), the SI-4 Bedrock
   apply (item 8), and a running LM Studio (item 10). Everything but the real
   cost is proven synthetically at this gate (THE DEMO, §3 item 3).
3. **Real catalog scan of the real account config dirs** (the M5 DoD item 1
   live half): running the scanner over the real `~/.aibender/accounts/*/`
   config dirs (still READ-ONLY — the scanner has no write path). Fixture-tree
   behavior is fully proven at this gate.
4. **Three one-time real logins** ([login-bootstrap.md](login-bootstrap.md)) —
   still the root unblock for every live Claude-source item.
5. **M1 live acceptance run** ([kernel-live-spawn.md](kernel-live-spawn.md)).
6. **M2 live cockpit acceptance** ([pty-attended-live.md](pty-attended-live.md)).
7. **SI-3 live installs** (hooks settings + statusline tee + OTel env block;
   launchd bootstrap; [X4] automation posts) —
   [hooks-telemetry.md](hooks-telemetry.md), [launchd.md](launchd.md).
8. **SI-4 owner sequence** ([bedrock-iac.md](bedrock-iac.md)): owner-run
   `terraform plan` → review → **explicit verbal OK** → `terraform apply` →
   wire the profile ARN. **No AWS call was made at this gate.** Prerequisite
   for the AWS_DEV/Bedrock leg of the real 3-backend run (item 2).
9. **Live AWS pollers** (post-item-8): flips the Bedrock instrument from
   estimate-only to actuals+lag; per-step Bedrock cost reconciles with the
   Cost Explorer backfill.
10. **LM Studio live capture probe** (owner starts LM Studio) — the LOCAL leg
    of the real 3-backend run (item 2). Do NOT start LM Studio (rule 3).
11. **Colima probe live run + any upgrade** ([colima.md](colima.md)): the
    read-only probe against the real VM is owner-run; VM mutations are
    owner-gated. Unchanged from M4; not on the M5 critical path (k3s is never a
    pipeline-launch dependency).
12. **FE-4 in-Tauri graph soak** (M4 D1 / spike-B "what remains"): unchanged
    from M4; not an M5 item.

## 6. Co-sign record (flips made at the M5 review, verified by this gate)

Flipped to **co-signed (M5 review)** by the reviewing orchestrators (recorded
in the owning amendment tables; the gate re-ran the cited proof suites):

- ws-protocol.md **M4 FREEZE** row (§15/§16) — FE-ORCH (the freeze-literal
  advance in `app/src/features/launch/wire.spec.ts` now pins `FROZEN-M5`
  reached through `FROZEN-M4`; the FE inbound-router `workstream` branch +
  the FE golden-corpus `workstream` round-trip both replay green).
- hooks-contract.md **M4 §7.1 [X4] routing** row — SI-ORCH (the 27/27 hooks
  bats with the [X4] slot rows re-run at this gate; the `x4Routing` e2e over
  the real collector handler green).
- [ICR-0011](../contracts/icr/icr-0011-gateway-workstream-slice.md) — FE-ORCH
  (the FE inbound-router workstream branch consumed the frozen surface;
  `goldenCorpus.spec.ts` 114/114 + `composedWorkstreams.spec.ts` 5/5 green).
- ws-protocol.md **M5 FREEZE** row (§18) — FE-ORCH (the M5 `pipelines`
  additions are forward-tolerant on the FE inbound path; the FE-6 deck +
  `sendPipelineMessage` + `PIPELINES` replay-from-zero + the `'pipelines'`
  chrome slot all consume them; `goldenCorpus.spec.ts` 114/114 incl. every
  `pipelines` frame + verb, `features/pipelines` 82/82 green).
- [dag-schema.md](../contracts/dag-schema.md) **v1** — FE-ORCH (the builder
  emits schema-valid DAG documents the frozen validator accepts and blocks
  cycle/invalid-account/bad-shape client-side; `builder.spec.ts` byte-identity
  against the validator-canonicalized corpus doc green).
- sqlite-ddl.md **§10 (migration 0004)** — FE-ORCH n/a for DDL, verified
  BE-ORCH: schema 0004 pipeline suites 29/29, `findMemoized` resume lookup
  proven by the runner restart DoD.
- [ICR-0012](../contracts/icr/icr-0012-gateway-pipeline-slice.md) — **BE-ORCH
  RATIFIED (recorded 2026-07-05)**; FE-ORCH **co-signed (M5 review)** (no FE
  change was bundled — the inbound router already flows `pipelines` frames
  forward-tolerantly; `serverPipelines.spec.ts` 10/10 + `composedPipelines`
  2/2 + the full `serverGolden` corpus replay green).

Still **pending** (long-standing, next review window):

- [ICR-0004](../contracts/icr/icr-0004-resume-prompt.md) resume-prompt
  co-sign — FE-ORCH (M1-era).
- bootstrap-file.md M2 freeze row — FE-ORCH (long-standing).
- icr-0003 counterpart co-sign (long-standing, M1-era).

M5 gate verdict: **PASS (synthetic edition)** — every synthetic-provable DoD
item green with runnable cited proofs (catalog scanner fixture-tree suite +
API-first; THE DEMO cross-account paused/resumed over the real composed broker;
broker-restart resume from a real reopened journal; `session_node`+`workflow`
edges + per-step cost; budget-breach abort with real-process-group reaping);
five named deviations (all rule-3 fake-driven / fixture-tree / static-parse /
temporary-local-process — no real cost, spawn, inference, or `~/.claude` write
anywhere); the two live halves (real catalog scan of real account dirs; real
3-backend run) runbooked and owner-gated.
