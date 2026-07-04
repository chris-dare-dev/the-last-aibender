# M1 gate record — [X1] proven: three accounts, one broker (synthetic edition)

**Gate run:** 2026-07-04 · **Scope:** plan §8.2 M1 · **Statuses:** `done` /
`done-with-deviation` (named) / `pending-owner`.

> **X2 reminder:** nothing in this file names a real identity. Real values
> (account mappings, the pre-history author email) are referenced by class
> only, per [SECURITY.md](../../SECURITY.md) §1.

The M1 DoD's live-host items require the three one-time interactive logins
([login-bootstrap.md](login-bootstrap.md)) and the owner-gated real spawn path
([kernel-live-spawn.md](kernel-live-spawn.md)). Those are T3 external
mutations and are **pending-owner by rule**, not by omission — everything
provable synthetically is proven below, and the live procedure is fully
scripted and runbooked up to the owner's go-ahead.

---

## 1. Gate-run evidence (what the gate actually executed)

| Check | Command | Result |
|---|---|---|
| Install | `pnpm install` | clean, 7 workspace projects |
| Unit/component tests | `pnpm -r test` | **349/349 pass, 27 files, 0 fail** — protocol 49, app 32, shared 36, testkit 46, schema 40, core 146 |
| Typecheck | `pnpm -r --if-present typecheck` | clean across all 6 packages with `typecheck` scripts (TS strict, base config) |
| Infra suite | `pnpm run test:infra` | shellcheck clean; **22/22 bats pass** (provisioning, keychain probe, version gate — stubbed `security`, temp `$AIBENDER_HOME`) |
| Token lint | `pnpm -F aibender-app lint:tokens` | OK — 0 violations (no non-theme FE code exists yet; enforcement itself is test-proven since M0) |
| Tier-1 scan | `gitleaks dir <tree> --config .gitleaks.toml --redact` | **CLEAN** (committable tree; also clean over the full working dir incl. ignored files) |
| Tier-2 scan | `gitleaks dir <tree> --config ~/.aibender/private/gitleaks-tier2.toml --redact` | **CLEAN** on the committable tree (`.git/` + `node_modules/` excluded). The 12 redacted hits confined to `.git/logs/` reflogs are the M0 §5.1 pre-history identity, unchanged — see pending-owner item 1 |
| Synthetic X1 demo | `pnpm -F aibender-core demo:m1` | **PASS — 13/13 assertions** ([m1-demo-output.txt](m1-demo-output.txt)) |

## 2. Deliverables (plan §8.2 M1)

| Deliverable | Status | Notes |
|---|---|---|
| SI-2 account provisioning & keychain verification | **done** (scripts + tests) / live run pending-owner | `infra/scripts/accounts/{provision-accounts,keychain-probe,version-gate,lib}.sh`, SI-2 manifest + README under `infra/profiles/`, 22 bats tests, runbooks live. Real-keychain execution is T3 |
| BE-1 session kernel & account runtime | **done** | `core/src/kernel/`: profile registry (NFC-once, byte-stable), one spawn-env layer (scrub + token-mixing + `--bare` refusals), FSM over the resume ledger (row-before-spawn, double-resume block, pid-liveness guard, transcript-tail repair fork), SDK runner implemented behind the live-spawn gate |
| `packages/protocol` core frozen | **done** | `@aibender/protocol@1.0.0-m1-core`; ws-protocol.md FROZEN-M1-CORE; golden corpus in testkit (ICR-0003); amendments via ICR only (ICR-0004 landed, FE-ORCH co-sign pending) |
| `packages/schema` kernel tables frozen | **done** | migration 0001 (`resume_ledger`, `account_profiles`, `schema_meta`), LEGAL_TRANSITIONS state machine, node:sqlite (WAL) behind the driver interface; better-sqlite3 swap path documented in sqlite-ddl.md |
| BE-3 skeleton (control channel only) sufficient for a scripted demo | **done** | `core/src/gateway/`: WS server, per-boot token auth, control-verb mux, 0600 bootstrap discovery file; `composeBroker` adapts the real kernel; the demo drives it over the wire |

## 3. DoD checklist (plan §8.2 M1, item by item)

| # | DoD item | Status | Evidence / what remains |
|---|---|---|---|
| 1 | Live-host demo: one broker, three concurrent SDK sessions (one per account), each completes, zero re-login | **pending-owner** (live) / **done** (synthetic edition) | Synthetic acceptance: [m1-demo-output.txt](m1-demo-output.txt) — full broker (kernel + gateway + on-disk ledger + bootstrap discovery), three concurrent sessions on MAX_A/MAX_B/ENT with distinct per-session `CLAUDE_CONFIG_DIR`/`CLAUDE_SECURESTORAGE_CONFIG_DIR`, all completing. Live run needs the three one-time logins ([login-bootstrap.md](login-bootstrap.md)) then [kernel-live-spawn.md](kernel-live-spawn.md) §"M1 acceptance run" |
| 2 | Keychain probe shows three distinct per-config-dir service names | **pending-owner** (T3) | Probe implemented and proven against a stubbed `security` (never `-w`; bats 8–16 incl. the known service-name derivation vector and NFC/byte-stability edges). Real-keychain run requires the logins |
| 3 | Env-scrub unit-tested | **done** | `core/src/kernel/env.spec.ts` (ANTHROPIC_*/CLAUDE_CODE_USE_* scrub, token-mixing refusal, full-replacement env); demo assertion 6 re-proves scrub end-to-end |
| 4 | `--bare` refusal unit-tested | **done** | `core/src/kernel/env.spec.ts` (`assertNoForbiddenArgs`, incl. `--bare=` spelling) + `core/src/kernel/sdkQueryRunner.spec.ts` (refusal holds at the live-runner boundary) |
| 5 | Row-before-spawn unit-tested | **done** | `core/src/kernel/sessionKernel.spec.ts` (onStart observes the `spawning` row; crash-window seam; spawn-failure settles the row) + `packages/schema/src/kernel.spec.ts` (insertBeforeSpawn contract); demo assertions 7–8 |
| 6 | Double-resume block unit-tested | **done** | `core/src/kernel/sessionKernel.spec.ts` (live in-broker block; pid-liveness guard suite for dead-broker `running` rows) + over-the-wire in `core/src/main/index.spec.ts` and `core/src/gateway/server.spec.ts`; demo assertion 9 |
| 7 | SIGKILL orphan probe (vii) re-run against the real kernel passes | **done-with-deviation** (synthetic re-run) / live re-run **pending-owner** | SPIKE-D vii mechanics are encoded against the REAL kernel + real SQLite ledger with fake processes: dead-broker `running` rows, nonce-paired pid-liveness refusal, un-forked dead resume after verified child death, torn-tail repair fork (`sessionKernel.spec.ts` "pid-liveness guard" suite; `pidLiveness.spec.ts` real-process probe against this host's process table). The real-child SIGKILL re-run rides the live spawn path — scheduled in [kernel-live-spawn.md](kernel-live-spawn.md) as part of the acceptance run |
| 8 | Version-gate script documented in `docs/runbooks/` and wired as a required step for SDK bumps | **done** | [version-gate.md](version-gate.md) (live) + `infra/scripts/accounts/version-gate.sh` (bats 17–22: BLOCK on no baseline, hash drift, missing keychain item; PASS when aligned). Wired: SDK pinned exactly (`0.3.201` in core + `minimumReleaseAgeExclude` in pnpm-workspace.yaml), [kernel-live-spawn.md](kernel-live-spawn.md) precondition 3 requires a green gate, and the runbook's bump procedure is the only sanctioned pin-change path. Baseline `--init` on the real machine is T3 (needs real keychain items) |

## 4. Gate deviations (named, minimal)

- **D1 — Demo substitutes the FakeQueryRunner for the live SDK spawn.** This
  is the designed synthetic edition of the M1 acceptance: the live path is
  implemented (`createSdkQueryRunner`) but stays behind the explicit
  `liveSpawn` opt-in because real-account spawns are T3 owner-gated. Every
  other component in the demo is real (kernel, ledger on disk, gateway, wire
  protocol, bootstrap file).
- **D2 — `lint:tokens` scans 0 files.** Expected at M1: FE packages beyond
  the FE-1 theme chain are gated on DESIGN.md lock (flipped this gate) and no
  `app/src` UI code exists yet. The lint's enforcement is itself covered by
  the 14 lint spec tests from M0.

## 5. Pending-owner ledger (consolidated at the M1 gate)

Nothing below blocks local development; items 1–2 block publishing; items 3–7
are the live-host (T3) half of the M1 DoD.

1. **M0 §5.1 history rewrite + force-push** (SECURITY.md §5.1) — the
   pre-history author identity is still on the root commit and its reflog
   echoes (the 12 Tier-2 `.git/logs/` hits). Every SHA changes; do it before
   anything is pushed. (M0 carry-over.)
2. **GitHub email-privacy settings confirmation** (SECURITY.md §5.2). (M0
   carry-over.)
3. **Three one-time interactive logins** — one per account label, per
   [login-bootstrap.md](login-bootstrap.md).
4. **Keychain probe live run** — expect three distinct per-config-dir
   service names; then `version-gate.sh --init` to write the baseline.
5. **Live X1 demo** — enable `liveSpawn` per
   [kernel-live-spawn.md](kernel-live-spawn.md) and re-run the M1 acceptance
   against real accounts (three concurrent sessions, zero re-login).
6. **SIGKILL orphan probe (SPIKE-D vii) live re-run** — kill -9 the broker
   mid-session on the live path; verify pid-liveness refusal, reap, resume.
7. **Push + hosted CI green** — after item 1; all Stage-2 work remains
   local-only by rule until then.

Orchestrator (not owner) watch item: ICR-0004's FE-ORCH co-sign is still
pending (resume-verb `prompt` amendment).
