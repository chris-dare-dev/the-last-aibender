# Stage 2 complete — the hardened v0 harness (M0–M6)

> **Recorded at the M6 gate (2026-07-05) by BE-ORCH (steward), on the M5 baseline
> `73d1f67`.** Stage 2 of the-last-aibender is done: the full multi-account
> Claude Code broker, cockpit, collector, workstream lineage, pipelines, and the
> supervision/resource governor are built, frozen, gated, and committed locally.
> Nothing here was pushed, signed for real, notarized, installed as a real
> LaunchAgent, run against real accounts, or given a real 24 h soak — those are
> the owner/T3/T4 items enumerated in §3, unchanged by rule.

---

## 1. What Stage 2 shipped (M0 → M6)

| Milestone | Delivered | DoD record |
|---|---|---|
| **M0** | Monorepo scaffold, contracts skeleton, two-tier gitleaks gate, spikes, SECURITY.md, CI floor. | [m0-dod.md](m0-dod.md) |
| **M1** | Session kernel + per-account env injection (`CLAUDE_CONFIG_DIR`/securestorage per label), on-disk resume ledger, pid-liveness/orphan discipline, version-gate. | [m1-dod.md](m1-dod.md) |
| **M2** | ptyHost (attended TUIs, flow control, recycle), ApprovalBroker + `canUseTool`, the WS gateway (auth token + bootstrap file), adapters (opencode/lmstudio/claude-sdk), the Tauri shell + islands + launchers. | [m2-dod.md](m2-dod.md) |
| **M3** | Collector (8 sources), read models (10 §6.3 dashboard leads) + freshness state machine, observability deck, events store (schema 0002), the `events` payload union. | [m3-dod.md](m3-dod.md) |
| **M4** | Workstream lineage (schema 0003), the `LineageRecorder` action-time port + `SessionIdResolver`, the `workstream` channel (§16), the reconciler, the live context-graph island. | [m4-dod.md](m4-dod.md) |
| **M5** | Pipelines: the versioned JSON DAG contract (dag-schema v1), schema 0004 memoization journal, catalog scanner, the DAG engine (per-step account routing, process-group reaping, journal resume), builder + run-monitor. | [m5-dod.md](m5-dod.md) |
| **M6** | The supervision & resource governor (BE-9): footprint watchdog, pressure-delta amber/red state machine, the [X1] sacrifice-order scheduler, idle hibernation, the `~/.claude.json` monitor, the recycle→continue path, the `resource-health` frozen frame. Tauri v0 sidecar packaging (dry-run signing/notarize). The §9.3/§9.4 cross-department integration suite. Operator runbooks. | [m6-dod.md](m6-dod.md) |

**Protocol** is at `PROTOCOL_VERSION = '1.4.0'`, `PROTOCOL_FREEZE = 'FROZEN-M6'`
(see `packages/protocol/src/index.ts`); the golden corpus (both sides) is frozen
at `FROZEN-M6`. Schema is at migration 0004. All freeze co-signs through M6 are
recorded co-signed in [docs/contracts/icr/README.md](../contracts/icr/README.md).

## 2. M6 gate evidence (this gate, re-run at HEAD `73d1f67`)

| Check | Result |
|---|---|
| `pnpm install` | up to date, 8 projects |
| `pnpm -r --if-present typecheck` | 7 packages Done, 0 errors |
| `pnpm -r test` (workspace) | **2121 pass / 1 skipped** (protocol 230, schema 94, shared 36, testkit 95, app 716, core 950/1-skip) |
| `pnpm test:integration` (§9.3/§9.4) | **166 pass / 12 files** (standalone, serial — incl. the real 6-PTY `pty-flow-control` slice) |
| `soak:m2` (PTY flow control) | PASS — 6 PTY, 1 slow consumer, byteLoss 0, plateau stable, echo p95 **0.118 ms** (< 100 ms) |
| `soak:m6` (supervision, L9 mechanism) | PASS — 2880 ticks (24 sim-h), `accountSessionsShed 0`, `residentRatchetViolations 0`, `identityLeaks 0`, 4090 recycles, local model evicted, red account-spawns honored 950/950, red non-account-spawns refused 950/950 |
| Composed E2E | composedSupervision 5, composedBroker 9, composedWorkstreams 5, composedPipelines 2 — all green |
| Golden corpus both sides | BE `serverGolden` 67 + FE `goldenCorpus` 124 |
| `lint:tokens` | OK — 196 files, 0 violations |
| `test:infra` bats | 93 ok / 0 not-ok |
| `infra/ci/tests/run.sh` bats | 45 ok / 0 not-ok |
| `live-check.sh --milestone M6` | RESULT PASS (1 pass, 0 fail, 4 honest T3/T4 SKIP) |
| Tauri packaging | `cargo build` (debug) exit 0 · `--smoke-test` exit 0 · `cargo test` 5/5 · `verify-bundle-config.sh` PASS (bundle active, externalBin sidecar, signing DRY-RUN=null, entitlements JIT keys) |
| gitleaks Tier-1 (`--no-git`, full tree) | no leaks (11.64 MB) |
| gitleaks Tier-2 (private config, full tree) | **exactly the 12 known `.git/logs` reflog echoes** (6 `HEAD`, 4 `refs/heads/main`, 2 `refs/remotes/origin/main`) — zero in any tracked/untracked source file |

## 3. Consolidated pending-owner ledger (all of Stage 2 — T3/T4, unchanged by rule)

Every item below is **pending-owner by rule, not by omission**: the mechanism is
built, tested synthetically, and runbooked; only the real external mutation /
real cost / real login is withheld. This is the same ledger each milestone gate
carried, consolidated.

1. **History rewrite of the M0 root commit + force-push** (SECURITY.md §5.1) —
   the 12 `.git/logs` reflog echoes of the root-commit committer identity are
   metadata, not tree content; the rewrite that clears them + the push are the
   single standing owner action. All commits remain local.
2. **The three one-time real `claude /login`s** (one per MAX_A/MAX_B/ENT) —
   [login-bootstrap.md](login-bootstrap.md). Gates the entire live-account half
   of M1–M6 (real spawns, real JSONL/statusline/OTLP, real hooks floor).
3. **Real live-host M1 acceptance** (one broker, three concurrent real SDK
   sessions, zero re-login) + the real-child SIGKILL orphan re-run —
   [kernel-live-spawn.md](kernel-live-spawn.md).
4. **Keychain per-config-dir service-name probe on real items** — needs the
   logins; `live-check.sh` reads it read-only when the owner runs it.
5. **Windowed live cockpit** attending a real `claude` TUI, real login bootstrap,
   real one-off prompt + skill launch, real permission relay, the 6-PTY soak
   against real TUIs, real detach/reattach — [pty-attended-live.md](pty-attended-live.md).
6. **AWS Bedrock IaC apply** (`terraform apply`) + first real Cost Explorer /
   CloudWatch pollers — [bedrock-iac.md](bedrock-iac.md); the hard gate held (no
   credentialed plan, no apply, no AWS call). `live-check` reports SKIP.
7. **SI-3 live hooks + launchd install** into real `~/.claude`-adjacent dirs;
   the X4 brief-automation hook injection turned on (204 stays the default) —
   [launchd.md](launchd.md), [hooks-telemetry.md](hooks-telemetry.md).
8. **Colima probe live run + any colima/lima upgrade** — [colima.md](colima.md);
   the read-only probe is owner-run, version changes are owner-gated VM mutations.
9. **LM Studio real GPU residency + real local-model inference** — owner-gated
   (rule 3: do NOT start LM Studio; no cost-incurring inference).
10. **Real signed + notarized Tauri v0 build launching on a clean macOS user
    account** (L6/L8) — real Developer-ID codesign identity + notarize + a clean
    account; config is dry-run only (`--smoke-test` proves the headless
    mechanism). [release-packaging.md](release-packaging.md).
11. **LaunchAgent-v1 flip** (`launchctl bootstrap gui/<UID>`) — plists are
    v1-ready + plist-lint-validated Aqua-side, never flipped. [launchd.md](launchd.md).
12. **The real 24 h mixed soak** (3 accounts + 2 OpenCode + local JIT within the
    ~17 GB pessimistic envelope, blueprint §11) — T4/owner: real accounts + real
    cost over a real day. The mechanism is proven by `soak:m6` + the BE-9 unit
    tests; runbooked at [recovery.md](recovery.md) §4. **Never claimed to have
    run in CI.**
13. **FE-4 in-Tauri graph soak** (the windowed 5k-node render soak) — the
    component-level soak runs headless; the windowed run rides the live cockpit.

## 4. What comes next — Stage 3 (adversarial review)

Stage 2 is the last *build* stage. **Stage 3 is adversarial review + rendered-
frontend screen capture** — a red-team pass over the frozen contracts, the [X1]/
[X2]/[X4] invariants, the supervision governor, and the security posture, plus
real screen captures of the running cockpit. Stage 3 **needs the owner's live
logins for a real running app**: the screen-capture and end-to-end adversarial
scenarios require a windowed cockpit attending real (or login-bootstrapped)
sessions, which is exactly the pending-owner set in §3 (items 2, 5, 10). The
review itself is Claude's to drive; the live substrate underneath it is the
owner's to unlock.

Until then, everything provable without an external mutation is green at HEAD,
and every live-host half is scripted, runbooked, and waiting on the owner's
go-ahead — by rule, not by omission.
