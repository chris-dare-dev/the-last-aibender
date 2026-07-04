# M2 gate record — attended cockpit, features 2 & 3 v0 (synthetic edition)

**Gate run:** 2026-07-04 · **Scope:** plan §8.2 M2 · **Statuses:** `done` /
`done-with-deviation` (named) / `pending-owner`.

> **X2 reminder:** nothing in this file names a real identity. Real values
> (account mappings, the pre-history author email) are referenced by class
> only, per [SECURITY.md](../../SECURITY.md) §1.

The M2 DoD's live-host items ride real accounts, a real windowed cockpit, and
the real `claude` TUI — all T3 external mutations, **pending-owner by rule**,
not by omission. Everything provable synthetically is proven below against
the REAL composed chain (real gateway + real ptyHost + real node-pty children;
the only fakes are the TUI scripts and the ICR-0001 QueryRunner seam), and the
live procedures are scripted and runbooked up to the owner's go-ahead
([pty-attended-live.md](pty-attended-live.md),
[kernel-live-spawn.md](kernel-live-spawn.md),
[login-bootstrap.md](login-bootstrap.md)).

---

## 1. Gate-run evidence (what the gate actually executed)

| Check | Command | Result |
|---|---|---|
| Install | `pnpm install` | clean, 7 workspace projects |
| Typecheck | `pnpm -r typecheck` | clean across all 6 packages (TS strict) |
| Unit/component tests | `pnpm -r test` | **1012 pass / 1 skipped, 82 files, 0 fail** — protocol 72, shared 36, testkit 68, schema 40, app 309, core 487+1 (the skip is the double-gated live opencode spec's placeholder; its live half was ALSO run — see below) |
| Infra suite | `pnpm run test:infra` | **58/58 bats pass** — SI-2 accounts 22, SI-3 launchd 13, SI-3 hooks 23; shellcheck clean |
| Token lint | `pnpm -F aibender-app lint:tokens` | OK — 96 files scanned, **0 violations** (DESIGN.md locked) |
| SPA build | `pnpm -F aibender-app build` | vite build OK (one >500 kB chunk-size warning; code-splitting is an M6 packaging concern) |
| Island suites (Playwright) | `pnpm -F aibender-app test:islands` | terminal + transcript islands **PASS on Chromium AND WebKit** (follow-guard drift 0.00 px; 10k-item virtualization; zero jank frames on anchored phases) |
| Tauri shell build | `cargo build` (debug, app/src-tauri) | OK |
| Tauri smoke | `target/debug/aibender-app --smoke-test` | **exit 0** — `smoke-test: ok — headless boot, no broker advertised` (no `$AIBENDER_HOME/bootstrap/gateway.json` on this run, the contract's absent-file answer) |
| Tauri unit tests | `cargo test` (app/src-tauri) | **5/5 pass** (bootstrap validation matrix incl. torn/foreign bodies) |
| Golden corpus ↔ FE client | `vitest run src/lib/ws/goldenCorpus.spec.ts` (app) | **57/57** — every broker→client fixture through the REAL inbound router; outbound frames byte-identical to fixtures; binary codec round-trip |
| Golden corpus ↔ BE gateway | `vitest run src/gateway/serverGolden.spec.ts` (core) | **52/52** — every client→broker fixture replayed byte-for-byte over a real WebSocket against the live gateway; every gateway-sent frame re-validated against the frozen validators |
| Golden corpus reference | `vitest run src/wsGolden.spec.ts` (testkit) | **10/10** — corpus self-check (32 fixtures, freeze pinned to `PROTOCOL_FREEZE`) |
| Approval round-trip | `vitest run src/main/m2ApprovalRoundTrip.spec.ts` (core) | **3/3** — see DoD item 5 |
| 6-PTY soak + echo | `pnpm -F aibender-core soak:m2` (twice) | **PASS both runs** — see DoD items 6–7 for numbers |
| Live opencode serve (rule-3 exception) | `AIBENDER_OPENCODE_LIVE=1 vitest run serve.live` | **1/1** — real `opencode serve` (pinned 1.17.13) boots on a random loopback port, authenticates, streams SSE events, dies clean; health/list/event surfaces only, child reaped |
| Tier-1 scan (worktree) | `gitleaks dir <export> --config .gitleaks.toml` | **CLEAN** (468-file publishable export: tracked + untracked non-ignored) |
| Tier-2 scan (worktree) | `gitleaks dir <export> --config ~/.aibender/private/gitleaks-tier2.toml` | **CLEAN** (same export) |
| Tier-1 scan (history) | `gitleaks git . --config .gitleaks.toml` | **CLEAN** — 13 commits |
| Tier-2 scan (history) | `gitleaks git . --config <tier-2>` | **CLEAN** — 13 commits. The `.git/logs/` reflog echo of the root-commit author identity is unchanged and remains pending-owner item 1 (metadata, not tree content — SECURITY.md §5.1) |

## 2. Deliverables (plan §8.2 M2)

| Deliverable | Status | Notes |
|---|---|---|
| BE-2 ptyHost + approval broker | **done** | `core/src/kernel/pty/` (bounded ack ring, node-pty backend behind the live-spawn gate, login bootstrap, recycle v0, gateway-port adapters) + `core/src/kernel/approvals.ts` (queue, canUseTool bridge, kernel lifecycle wiring) |
| BE-3 gateway full | **done** | `core/src/gateway/`: transcript.<sid> projection, approvals channel, quota/events/context-graph validated pass-through stubs, binary PTY streaming with ack-watermark flow control, per-channel reconnect-replay journal |
| BE-4 OpenCode + LM Studio adapters (minimum viable) | **done** | `core/src/adapters/opencode/` (serve supervisor, SSE transport with `evt_` dedupe, SDK session client, read-only opencode.db guard, password/secret hygiene) + `core/src/adapters/lmstudio/` (health/`/v1`/`/api/v0`, residency policy) + claude-sdk wrapper; live serve probe green (see §1) |
| FE-2 shell + chrome + WS client/state | **done** | `app/src-tauri/` (Tauri v2, native affordances only, `--smoke-test`), `app/src/chrome/` (cockpit, panels, palette, inbox, settings, status bar), `app/src/lib/` (bootstrap reader, ws client, ring buffers, stores, projections), composition root |
| FE-3 islands | **done** | `app/src/islands/terminal/` (SPIKE-A attachRenderer chain) + `app/src/islands/transcript/` (SPIKE-C follow-guard port); Playwright component suites on Chromium + WebKit |
| FE-5 launcher slice | **done** | `app/src/features/launch/`: account picker, one-off composer, `/skill-name` launcher, history, wire dispatch |
| SI-3 hooks installed, launchd templates validated | **done** (templates + installer) / live install **pending-owner** | `infra/hooks/` (per-account settings fragments, installer/uninstaller, statusline tee — 23 bats), `infra/launchd/` (Aqua templates + render script — 13 bats); real `~/.claude`-adjacent dirs are owner-gated |
| SI-6 CI expansion | **done** | `.github/workflows/ci.yml` full pipeline + `infra/ci/` (live-check.sh T3 runner, branch-protection as code, playwright browser cache) |
| Contracts frozen: ws-protocol full + bootstrap-file + hooks-contract | **done** (M2 freeze commit `533cfb8`) | one post-freeze prose amendment via BE-ORCH stewardship (ws-protocol §6 attach-on-first-replay-request pin, recorded in the doc's amendment table); 32-fixture golden corpus is the contract device |

## 3. DoD checklist (plan §8.2 M2, item by item)

| # | DoD item | Status | Evidence / what remains |
|---|---|---|---|
| 1 | Tauri app boots, discovers the broker via bootstrap file, opens an attended TUI per account in the xterm island | **done** (every seam, synthetic) / windowed live run **pending-owner** | Headless boot proven this run (smoke exit 0) + bootstrap contract matrix (`cargo test` 5/5, `app/src/lib/bootstrap.spec.ts`, `core/src/gateway/bootstrap.spec.ts`). Attended-TUI chain proven end-to-end with real node-pty children: ptyHost attended sessions (`ptyHost.spec.ts`), gateway byte streaming (`serverStreaming.spec.ts` §pty), FE attach path (`wsClient.spec.ts`, `ptyConduit.spec.ts`, terminal island suites incl. WebKit). The windowed cockpit attending a REAL `claude` TUI on the three accounts is T3 — [pty-attended-live.md](pty-attended-live.md) |
| 2 | Login bootstrap of a fresh profile works end-to-end | **done** (synthetic TUI) / real login **pending-owner** | `launchLoginBootstrap` drives the ICR-0006 synthetic login TUI end-to-end (`ptyHost.spec.ts` positive rows: banner → interactive input → success marker, argv `['/login']`, spawn env from `buildSessionEnv`). The one-time real `claude /login` per account is the standing T3 item ([login-bootstrap.md](login-bootstrap.md)) |
| 3 | One-off prompt against a **specified** account streams into the transcript island | **done** (synthetic) / live SDK run **pending-owner** | FE-5 dispatch pins the account label on the frozen launch verb (`launch.spec.ts`, `wire.spec.ts`, `controller.spec.ts`); gateway projects the SDK stream onto `transcript.<sid>` and fans out (`transcriptProjector.spec.ts` 15, `serverStreaming.spec.ts` transcript rows); island renders the feed (`model.spec.ts`, `transcriptFeeds.spec.ts`, Playwright suite). Cross-checked against the golden corpus on BOTH ends (§1). Live = [kernel-live-spawn.md](kernel-live-spawn.md) |
| 4 | Skill launch via `/skill-name` works | **done** (synthetic) / live **pending-owner** | `app/src/features/launch/` skill launcher: `/skill-name` parse, catalog row, dispatch as the frozen prompt shape (`views.spec.ts`, `controller.spec.ts`, `launch.spec.ts`). Live skill execution rides the same T3 run as item 3 |
| 5 | Permission relay lands in the approval inbox (hooks floor + `canUseTool`) | **done** (`canUseTool`, full chain) / hooks-floor collector is **M3 scope by contract** | `canUseTool` proven END-TO-END over one real socket in `core/src/main/m2ApprovalRoundTrip.spec.ts` (3/3): real kernel mints the per-session handler → real ApprovalBroker → real gateway `approval-request` fan-out → client decision envelope → resolution fan-out → the awaiting canUseTool resolves → session proceeds to a wire-observable `exited`; plus allow-with-updatedInput, deny-with-note, §8 late-joiner replay, and the two-window `approval-not-pending` race. Depth suites: `approvals.spec.ts` (21), `serverStreaming.spec.ts` approvals rows, FE `ApprovalInbox.spec.tsx`. Hooks floor: the broker accepts `hook-floor` through the same queue (`approvals.spec.ts` M3/M5-slot row), SI-3 installs the frozen `PermissionRequest` hook POSTs (23 bats), and [hooks-contract.md](../contracts/hooks-contract.md) §"Acceptance rules" pins the accepting collector as **BE-5, M3** — the live floor lands there by design, not as an M2 gap |
| 6 | 6-PTY soak passes with flow control engaged (bounded memory, no dropped bytes) | **done** (real chain, synthetic TUIs) / real-TUI soak **pending-owner** | `pnpm -F aibender-core soak:m2` (`core/scripts/m2-soak/run.ts`), two consecutive PASSES: 6 attended sessions (REAL gateway + REAL ptyHost + REAL node-pty children flooding seq-tagged lines), **4,063,232 wire bytes/session (24,379,392 total)**, 7 consumers incl. ONE deliberately slow. Flow control observably engaged: with the slow consumer stalled, its in-flight bytes capped at exactly the **1 MiB delivery window** and the session-0 producer **plateaued stably at ~2 MiB (highWater)** — the real child blocked in a TTY write; after drain, **zero byte loss, zero duplication** (contiguous-offset reassembly, byte-exact against the generator, consumer totals == host `producedOffset()`), RSS delta bounded (≤ ~198 MB incl. the in-process validator retaining all 24 MB × 7 streams). Wall ≈ 1.7 s. Wire-level slow-consumer mechanics additionally unit-proven in `serverStreaming.spec.ts` (SPIKE-D rows). The same soak against six real `claude` TUIs is T3 ([pty-attended-live.md](pty-attended-live.md)); SPIKE-D (M0, spike vi) already proved the mechanism against the real TUI pre-harness |
| 7 | Typing echo p95 < 100 ms locally | **done** — **p95 0.14 ms** (×700 headroom) / real-TUI echo under load **pending-owner** | Soak phase 2: 200 sequential keystrokes through the full real chain (WS client → gateway INPUT frame → ptyHost → node-pty → TTY-driver echo → OUTPUT frame → client), latency captured on the frame-arrival hook: **p50 0.089 ms · p95 0.135–0.143 ms · p99 0.212 ms · max 0.533 ms** across both runs. The budget is met with the flood soak's memory still warm in the same process. Real-TUI echo (renderer + `claude` under load) is the T3 half |
| 8 | Detach/reattach restores scrollback | **done** (synthetic, both layers) / windowed live check **pending-owner** | Host layer: detach mid-output → reattach with `replayFrom` re-delivers retained bytes, offsets stable (`ptyHost.spec.ts` edge rows). Wire layer: reconnect replays retained OUTPUT from the client watermark exactly once, incl. output landed while detached and post-exit trailing bytes (`serverStreaming.spec.ts` reconnect rows); JSON channels replay per §8 (transcript/approvals reconnect rows + `journal.spec.ts`). FE: `wsClient.spec.ts` re-attach issues `pty-replay-request` at the stored watermark; terminal island scrollback via the serialize addon (island suites) |

## 4. Gate deviations (named, minimal)

- **D1 — Synthetic TUIs stand in for `claude` in the soak/echo/attended
  paths.** The composed chain is real (gateway, ptyHost, node-pty, WebSocket,
  frozen wire protocol); the children are `core/scripts/m2-soak/flood.cjs` /
  `quiet.cjs` and testkit's synthetic login TUI. Real-TUI runs are T3
  owner-gated by rule 3 — scripted in [pty-attended-live.md](pty-attended-live.md).
- **D2 — The approval round-trip's SDK substrate is the ICR-0001
  FakeQueryRunner.** The escalation entry point (`spec.canUseTool`) is exactly
  the surface the real SDK runner forwards (proven in `approvals.spec.ts`
  "the SDK runner forwards the handler as query() canUseTool"); everything
  downstream of it is real.
- **D3 — The composition root does not yet wire the M2 gateway ports**
  (`composeBroker` passes kernel only). The pty/approvals adapters are
  ready-made and gate-proven (`m2ApprovalRoundTrip.spec.ts` composes them the
  way `main` will); the transcript tee is BLOCKED on a BE-1 seam decision —
  tracked as a deferred watch item in
  [docs/contracts/icr/README.md](../contracts/icr/README.md).
- **D4 — `cargo clean` was NOT run after the smoke test**; the gitleaks gate
  used the documented publishable-export scan instead (`git ls-files … | tar`),
  which never walks `app/src-tauri/target/`. The durable Tier-1 allowlist for
  `target/` remains with SI-ORCH (app/src-tauri/README.md §Hygiene).

## 5. Pending-owner consolidated (T3, unchanged rules)

1. **History rewrite + reflog identity** (M0 §5.1, SECURITY.md): `.git/logs/`
   reflog still echoes the root-commit author identity; rewrite + `git push`
   are owner actions. Unchanged since M0/M1.
2. **Three one-time real logins** ([login-bootstrap.md](login-bootstrap.md))
   → unblocks real keychain probe (M1 item 2), version-gate `--init`
   baseline, and every live M2 item below.
3. **M1 live acceptance run** ([kernel-live-spawn.md](kernel-live-spawn.md)):
   three concurrent real SDK sessions + real-child SIGKILL orphan re-run.
4. **M2 live cockpit acceptance** ([pty-attended-live.md](pty-attended-live.md)):
   windowed Tauri boot + bootstrap discovery on a real broker; attended real
   `claude` TUI per account; real login bootstrap through the xterm island;
   live one-off prompt + `/skill-name`; 6-real-TUI soak; echo-under-load p95;
   windowed detach/reattach.
5. **SI-3 live installs**: hook settings into the real per-account config
   dirs; LaunchAgent bootstrap into the real Aqua session (+ the documented
   Background-domain expected-failure probe) — [launchd.md](launchd.md),
   [hooks-telemetry.md](hooks-telemetry.md), driven via `infra/ci/live-check.sh`.
6. **Tier-1 allowlist for `app/src-tauri/target/`** (SI-ORCH, value-free
   path rule) so full-dir scans stay clean on machines that built the shell
   without requiring `cargo clean` (D4). — **Resolved post-gate, same day:**
   global path allowlist landed in `.gitleaks.toml` with a SECURITY.md §2
   tuning-log entry; full-dir Tier-1 scan re-verified clean with the shell
   build present, and a seeded fabricated email outside `target/` still
   fired + the pre-commit hook still blocked it. Not an owner item anymore.

M2 gate verdict: **PASS (synthetic edition)** — every synthetic-provable DoD
item green at HEAD; live-host items scripted, runbooked, and owner-gated.
