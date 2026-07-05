# M6 gate record — hardened v0 ship (BE-9 supervision + packaging + integration suites)

> **The final Stage-2 milestone.** Deliverables: BE-9 supervision & resource
> governor; Tauri v0 sidecar packaging (dry-run signing/notarize config, NOT
> flipped); the §9.3/§9.4 cross-department integration suites; the operator
> runbooks. Gate run + recorded by BE-ORCH (steward) on 2026-07-05, on top of
> the M5 baseline (`73d1f67`). No external mutation, no real signing/notarize,
> no real 24 h soak, no push — all owner/T-gated (see §5).

---

## 1. Gate-run evidence (what the gate actually executed)

| Check | Command | Result |
|---|---|---|
| Install | `pnpm install` | up to date, 8 projects |
| Typecheck (all) | `pnpm -r --if-present typecheck` | 7 packages Done, 0 errors |
| Workspace unit/component | `pnpm -r test` | **2121 pass / 1 skipped** across 6 packages (protocol 230, schema 94, shared 36, testkit 95, app 716, core 950/1-skip) |
| Root vitest workspace | `pnpm test` | 184 files, 2121 pass / 1 skip (integration excluded — §4) |
| Integration gate (§9.3/§9.4) | `pnpm test:integration` | **166 pass / 12 files** (standalone, serial — §4) |
| PTY flow-control soak (BE↔FE #2) | `pnpm -F aibender-core soak:m2` | verdict PASS — 6 PTY, 1 slow consumer, byteLoss 0, plateau stable, echo p95 0.141 ms (<100 budget) |
| Supervision soak (L9 mechanism) | `pnpm -F aibender-core soak:m6` | verdict PASS — 2880 ticks (24 sim-h), accountSessionsShed 0, residentRatchetViolations 0, identityLeaks 0, 4090 recycles, local model evicted |
| Golden corpus both sides | BE `serverGolden.spec` (67) + FE `goldenCorpus.spec` (124) | pass |
| Token lint (DESIGN.md) | `pnpm -F aibender-app lint:tokens` | OK — 196 files, 0 violations |
| Infra bats (SI suites) | `pnpm run test:infra` | 93 ok / 0 not-ok |
| CI bats (`infra/ci/tests`) | `bash infra/ci/tests/run.sh` | 45 ok / 0 not-ok |
| Live-check M6 | `bash infra/ci/live-check.sh --milestone M6` | RESULT PASS (1 pass, 0 fail, 4 skip) — honest T3/T4 SKIPs |
| Packaging smoke | `aibender-app --smoke-test` (debug binary) | `smoke-test: ok — headless boot`, exit 0 |
| shellcheck | `shellcheck infra/ci/live-check.sh` | clean |
| gitleaks Tier-1 | `gitleaks detect --config .gitleaks.toml --no-git` | no leaks (11.62 MB) |
| gitleaks Tier-2 | `gitleaks detect --config ~/.aibender/private/gitleaks-tier2.toml --no-git` | 12 findings, ALL in `.git/logs/*` (the known root-commit reflog echoes, pending the owner's history rewrite); **zero in any tracked/untracked source file** |

---

## 2. Deliverables (plan §8.2 M6)

- **BE-9** — `core/src/supervision/` (watchdog, pressureProbe, scheduler,
  hibernation, configMonitor, governor, publisher, slice) + the composeBroker
  supervision slice (`core/src/main/index.ts`).
- **Packaging** — `app/src-tauri/tauri.conf.json` bundle config active with
  externalBin sidecar + DRY-RUN signing/notarize placeholders +
  `entitlements.plist`; `app/src-tauri/scripts/build-sidecar.sh` +
  `ensure-sidecar-placeholder.sh`; `infra/ci/verify-bundle-config.sh`.
- **Integration suites** — `test/integration/` (`@aibender/integration`, plan
  §9.3/§9.4) + `docs/contracts/integration-suite.md` contract of record.
- **LaunchAgent-v1** — broker + lms plists finalized v1-ready, plist-lint
  validated (`infra/launchd/`), NOT installed.
- **Runbooks** — `docs/runbooks/recovery.md` (incl. §4 supervision soak),
  `quota-exhaustion.md`, `release-packaging.md`.

---

## 3. DoD checklist (plan §8.2 M6, item by item)

| # | DoD item | Status | Proof |
|---|---|---|---|
| 1 | Watchdog thresholds active + tested by induced bloat (fake-process harness) | **MET** | `core/src/supervision/watchdog.spec.ts` — claude warn 3 GB/recycle 6 GB, opencode warn 1 GB/recycle 1.5 GB, serve sustained-window; fake sampler, no real process bloated (rule 3). |
| 2 | …and one real recycle with lineage continuity | **MET (synthetic-composed)** | `core/src/main/composedSupervision.spec.ts` — a watchdog recycle runs the composed ptyHost + records a `continue` edge (`reason: recycle`) on the lineage store, over one real WS socket. The **real** recycle on a live account child is T3 (recovery.md §2 drill). |
| 3 | amber/red responses verified with the sacrifice order — account sessions never shed, account spawns honored post-shedding | **MET** | `core/src/supervision/scheduler.spec.ts` (500-registry × {amber,red} property test: no shed step targets an account; account spawn admitted / non-account refused at red) + `governor.spec.ts` + the soak's per-tick invariants (`soak:m6`, `soak.spec.ts`). |
| 4 | 24 h mixed soak within the ~17 GB envelope with no unsupervised growth | **MECHANISM MET; real 24 h = T4/pending-owner** | `soak:m6` (accelerated: 2880 ticks = a compressed day, full scenario, `residentRatchetViolations: 0`, resident bounded, accounts never shed) + `soak.spec.ts`. The **real** 24 h run is owner/T4 — runbooked (recovery.md §4), live-check `soak-24h` SKIPs pending-owner and never claims it ran. |
| 5 | All §9.4 integration suites green at the gate | **MET** | `pnpm test:integration` 166/166 (12 files across be-fe / be-si / si-fe / t3-enumeration); the T3 live halves enumerated in `infra/ci/live-check.sh`, asserted present by `src/t3/live-check-enumeration.spec.ts`. |
| 6 | Signed (dry-run) Tauri v0 sidecar build launches on a clean macOS user account | **MECHANISM MET; real signed clean-account launch = T3/pending-owner** | bundle-config shape validated (`verify-bundle-config.sh` PASS; live-check `bundle-config` PASS); `--smoke-test` headless boot exit 0 on the debug binary; the real `tauri build` + deep/strict codesign verify + clean-account launch is L8 (release-packaging.md §2–4), SKIPs pending-owner. |
| 7 | LaunchAgent-v1 plist validated Aqua-side but not flipped | **MET** | `infra/launchd/` plists v1-ready + plist-lint bats (test:infra); live-check `launchagent-v1` SKIPs — the `launchctl bootstrap` flip is owner-gated T3 and never run. |
| 8 | Operator runbooks complete (login bootstrap, version gate, recovery, quota-exhaustion playbook) | **MET** | `docs/runbooks/`: login-bootstrap.md, version-gate.md, recovery.md (incl. §4 supervision soak), quota-exhaustion.md, release-packaging.md, launchd.md, colima.md, hooks-telemetry.md — all indexed + link-integrity bats green. |

---

## 4. Gate deviations (named, minimal — BE-ORCH steward)

1. **Integration suite decoupled from the every-commit sweep.** The INTEG build
   wired `@aibender/integration` into `vitest.workspace.ts` and `pnpm -r test`,
   so its BE↔FE #2 slice (which drives the real `soak:m2` — 6 node-pty children)
   ran concurrently with the whole workspace and starved the soak's 120 s
   internal drain timeout (observed false-red under `pnpm -r test`; standalone
   green in ~2.5 s across repeats). Per plan §9.1 (soak/perf = a *gate* tier),
   I renamed the integration package's runnable `test`→`test:integration`,
   dropped `test/integration` from the default root workspace, and added a
   serial `Integration suite` step to CI's `linux-tests` job. Recorded in
   `docs/contracts/integration-suite.md` §1 + amendment; SI-ORCH co-owns
   `.github/workflows/` — this is a test-orchestration wiring change, not a
   pipeline redesign; SI-ORCH review noted. No wire/schema/contract surface.
2. **Accelerated supervision soak built to make the L9 claim true.** The
   live-check `soak-24h` SKIP and `recovery.md` had claimed "an accelerated
   synthetic soak" proves the mechanism, but no such runnable existed (only the
   PTY `soak:m2`). I added `core/scripts/m6-supervision-soak/run.ts` (`soak:m6`)
   + `core/src/supervision/soak.spec.ts` (fast unit edition) driving the REAL
   governor over a compressed day, and corrected the live-check pointer +
   authored `recovery.md §4`. Closes the honesty gap rather than papering over
   it. Owned by BE-9/BE-ORCH (`core/`, root scripts).

---

## 5. Pending-owner consolidated (T3/T4 — unchanged rules, honestly SKIPped)

- **Real 24 h resource soak (L9)** — T4/owner: real accounts + real cost over a
  real day. Mechanism proven by `soak:m6` + BE-9 unit tests; runbooked at
  recovery.md §4. NEVER claimed to have run in CI.
- **Real signed + notarized Tauri build, clean-account launch (L6/L8)** — T3/owner:
  real codesign identity + notarize + a clean macOS user account. Config is
  dry-run only; `--smoke-test` proves the headless mechanism.
- **LaunchAgent-v1 flip** — T3/owner: `launchctl bootstrap gui/<UID>` is never
  run here; plists validated Aqua-side only.
- **All prior T3 live seams** (keychain, real login, real hooks, LM Studio GPU,
  Colima probe, AWS post-apply) — enumerated in `infra/ci/live-check.sh`,
  SKIP pending-owner, unchanged from M1–M5.
- **History rewrite of the root commit + push** — owner-gated (SECURITY.md §5.1);
  all commits remain local. Tier-2's 12 findings are the reflog echoes that the
  rewrite clears.

---

## 6. Post-build ICRs landed at this gate (BE-ORCH steward)

The four freeze-forced/composition ICRs the BE-9/SI-M6 build returned were
reviewed, verified correct, and recorded in `docs/contracts/icr/README.md`:
(1) the forced `resource-health` entry in `DEFAULT_READ_MODEL_SOURCES` (inert —
the BE-9 governor owns the frame, the BE-6 publisher still emits exactly ten
leads); (2) the `publisher.spec` `.slice(0, 10)` fix; (3) the hooks.spec
`FROZEN-M5`→`FROZEN-M6` marker advance (matches `PROTOCOL_FREEZE`/`PROTOCOL_VERSION
1.4.0`); (4) the composeBroker supervision slice (mirrors the M4/M5 slice
pattern; proven E2E by `composedSupervision.spec.ts`). The M6 freeze co-signs
(ws-protocol §13.4 + integration-suite.md) are flipped to co-signed at this gate
— the flip is landed in the contract files: `docs/contracts/ws-protocol.md` M6
row now reads **co-signed (M6 gate, 2026-07-05)** for both FE-ORCH (the
`ResourceHealthInstrument.tsx` consumer + the `FROZEN-M6` freeze-literal +
observability specs off the hard-coded "10") and the BE-9 producer lane
(`publisher.spec.ts` narrowed to `.slice(0, 10)`/`.toHaveLength(10)`;
`hooks.spec.ts` at `FROZEN-M6`), and `docs/contracts/icr/README.md` records the
flip with the ~~struck~~ open marker per the M4/M5 precedent.

---

## 7. Stage 2 is complete

M6 is the FINAL Stage-2 milestone. The consolidated Stage-2 completion record —
what each of M0–M6 shipped, this gate's evidence, the full pending-owner ledger,
and the hand-off to Stage 3 (adversarial review + rendered-frontend screen
capture, which needs the owner's live logins) — is
[stage2-complete.md](stage2-complete.md).
