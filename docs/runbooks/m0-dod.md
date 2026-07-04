# M0 definition-of-done record — gate run 2026-07-04

Honest per-item status of the **M0 — Clean slate & risk burn-down** milestone
against [plan §8.2](../research/summaries/02-stage2-implementation-plan.md#82-milestones-and-definition-of-done)
(blueprint §13.1–2, §13.5). Recorded by the M0 gate agent at the gate run;
statuses are `done` / `done-with-deviation` (named) / `pending-owner`.

> **X2 reminder:** nothing in this file names a real identity. Where a real
> value is involved (the pre-history author email, account mappings) it is
> referenced by class only, per [SECURITY.md](../../SECURITY.md) §1.

---

## 1. Gate-run evidence (what the gate actually executed)

All commands run from the repo root on the build host, 2026-07-04.

| Check | Command | Result |
|---|---|---|
| Install | `pnpm install` | OK — 7 workspace projects, lockfile up to date |
| Workspace tests | `pnpm -r test` | **GREEN — 70/70 tests, 7 files** (protocol 9, schema 7, shared 10, testkit 8, core 4, app 32) |
| Token lint | `pnpm -F aibender-app lint:tokens` | OK — 0 violations (shipped `app/src` tree is clean; enforcement proven by the 14 lint spec tests incl. seeded violations) |
| Tier-1 scan | `gitleaks dir . --config .gitleaks.toml --redact` | **CLEAN** after one value-free allowlist addition (see §4, deviation D1) |
| Tier-2 scan | `gitleaks dir <tree> --config ~/.aibender/private/gitleaks-tier2.toml --redact` | **CLEAN** on the committable tree (`.git/` + `node_modules/` excluded). 12 redacted hits remain confined to `.git/logs/` reflogs — the pre-history author identity of `62d11d0`, i.e. exactly the pending §5.1 rewrite (SECURITY.md), not a working-tree leak |
| Pre-commit hook | `ls -l .git/hooks/pre-commit` | present, executable, fails closed (Tier-1 + Tier-2 `--redact`) |
| Identifier grep | 12-digit + provider-email + work-domain-email sweep, tree minus `.git/` | No emails of any class. Four 12-digit matches are decimal substrings of fps floats in `spikes/graph-perf/results/*.json` (e.g. `2222.222222222222`) — benign, no AWS context |
| CI workflow syntax | YAML parse of the three workflows | `ci.yml`, `gitleaks.yml`, `trufflehog-weekly.yml` all parse; all `permissions: contents: read` |

## 2. Deliverables

| Deliverable | Status | Notes |
|---|---|---|
| SI-1 hygiene stack complete | **done-with-deviation** | Two-tier gitleaks + fail-closed pre-commit + CI workflows + SECURITY.md + runbook all landed. Named deviations from the X2 §3.3 checklist are recorded in SECURITY.md §4 (tier-2 path, direct hook vs framework, split workflows, doc naming). The checklist's step 1 (history amend + force-push) is pending-owner — §3 below |
| Monorepo scaffold + four `packages/*` stubs | **done** | pnpm workspace with `packages/{protocol,schema,shared,testkit}`, `core/`, `app/`; every stub carries positive/negative/edge tests; `spikes/` deliberately outside the workspace |
| FE-1 DESIGN.md locked | **done-with-deviation** | DESIGN.md is **AUTHORED**, token chain built (`tokens.ts` → generated `tokens.css`/`tailwind.theme.css`) and lint-enforced. The formal FE-ORCH **lock mark is not yet applied** — until it is, other FE packages stay gated (plan §5 FE-1), which is the safe state |
| Ten spikes executed, verdicts in `docs/spikes/` | **done-with-deviation** | All ten spikes (i)–(x) executed from `spikes/` harnesses; verdicts recorded in five docs (each covers two spikes). Named deviations: (ii) ran in Playwright WebKit as a WKWebView proxy, real-Tauri-window re-run deferred to T3/M2; (vi) used a synthetic ANSI flooder approximating the claude TUI, real-TUI re-run at the M2 gate; (viii) procedure-only by design (no real accounts touched — owner T3 experiment documented) |

## 3. DoD checklist (plan §8.2 M0, item by item)

| # | DoD item | Status | Evidence / what remains |
|---|---|---|---|
| 1 | Amended commit force-pushed and verified (`git log` clean of work-domain email) | **pending-owner** | The rewrite procedure is fully scripted in SECURITY.md §5.1. History rewrites and pushes are owner-gated external mutations; all Stage-2 work remains local-only until executed. Local `git log` still shows the work-domain identity on `62d11d0` (by class; not quoted here) |
| 2a | GitHub email-privacy settings confirmed | **pending-owner** | Account-level settings, not API-reachable with the available token — SECURITY.md §5.2 |
| 2b | GitHub push-protection confirmed | **done** | `secret_scanning_push_protection` enabled 2026-07-04 via one authorized `gh api PATCH`; `secret_scanning` already active — SECURITY.md §5.3 |
| 3 | Gitleaks gate proven by three seeded failures then cleaned | **done** | Three seeded classes (fake 12-digit-near-AWS, fake personal email, fabricated non-docs AKIA key) each blocked by the pre-commit hook; blocked-commit transcripts recorded in [hygiene.md §4](hygiene.md); seeds removed after proof |
| 4 | CI green on the scaffold | **done-with-deviation** | Hosted CI cannot run until the owner executes item 1 and pushes (all work is local-only by rule). Local equivalent of `ci.yml` is green: `pnpm install` + `pnpm -r test` (70/70) + both gitleaks tiers clean; all three workflow YAMLs parse with `contents: read` |
| 5 | DESIGN.md merged with token-lint demonstrably failing an off-token color | **done** | `app/src/chrome/theme/lint-tokens.spec.ts` (14 tests) proves the lint fails on the three seeded violation classes — off-token hex, radius, shadow — plus Tailwind-shaped slop, forbidden faces, spring easing, sparkles/skeleton loaders; exits 2 (fails closed) on missing allowlist. Shipped tree passes clean. Formal FE-ORCH lock mark still pending (see §2) |
| 6 | Ten spike verdicts recorded, each naming the go/fallback consequence | **done** | §5 below; every verdict doc names its fallback consequence inline |
| 7 | Findings doc-hygiene annotations (§13.7) merged | **done** | Superseded-line annotations added to [frontend-app-shell-stack](../research/findings/frontend-app-shell-stack.md) (Svelte→React, three.js→Pixi, PTY-per-account correction), [ui-motion-3d-context-graph](../research/findings/ui-motion-3d-context-graph.md) (framework context, renderer confirmed), and [x3-virtualization-colima-k3s](../research/findings/x3-virtualization-colima-k3s.md) (SOPS adopt→DEFER), each pointing at frontend-stack-coherence and the blueprint §12 ledger |
| 8 | Research docs committed on the new SHA | **pending-owner** | "New SHA" only exists after the item-1 rewrite. Research docs are committed on the current local lineage and will be carried through the rewrite (identity-only rewrite; tree contents untouched) |

## 4. Gate deviations (named, minimal)

- **D1 — Tier-1 allowlist tuning (2026-07-04, this gate).** The full-tree
  Tier-1 scan flagged 5 false positives: retina-suffix asset filenames
  (`bar@2x.webp` shape) in vendored PixiJS JSDoc inside the spike bundle
  `spikes/graph-perf/browser/dist/pixi-soak.js` (gitignored via `dist/`, so
  never committed — but the gate's `gitleaks dir` full-tree scan sees ignored
  files and must be clean), matching the catch-all email rule. Fixed by one
  value-free allowlist regex (`@\dx\.(png|webp|…)$` — a filename shape, not an
  identity form) rather than path-allowlisting the bundle, so the file itself
  stays scanned. Logged in SECURITY.md §2 (tuning log), per the "adjust
  minimally and document" rule.

## 5. Spike verdict one-liners (i)–(x)

| Spike | Verdict | One line (go/fallback consequence in the doc) |
|---|---|---|
| (i) xterm 6 WebGL in WKWebView | **GO** | Ship the WebGL addon as FE-3's preferred renderer behind mandatory runtime detection; DOM renderer is the proven fallback floor (~0.2 s per 100k lines) — [spike-a](../spikes/spike-a-webview-render.md) |
| (ii) Pixi v8 5k-node soak | **GO** | 60 fps sustained at 5k nodes / 8k edges during active layout in the WebKit proxy; that figure is the M4 fps floor; real-Tauri-window re-run is a named T3 item with a degrade-lever fallback ladder — [spike-b](../spikes/spike-b-graph-perf.md) |
| (iii) Worker layout round-trip | **GO** | Transferable `Float32Array` epochs cost ~0.02–0.5 ms round-trip — messaging is noise, the d3-force tick dominates; worker-thread layout confirmed — [spike-b](../spikes/spike-b-graph-perf.md) |
| (iv) `navigator.gpu` in WKWebView | **INCONCLUSIVE-NEGATIVE, non-blocking** | Treat WebGPU as absent; WebGL2 is the committed path and nothing depends on WebGPU; product re-probes at runtime — [spike-a](../spikes/spike-a-webview-render.md) |
| (v) react-virtual mid-stream resize | **GO** | react-virtual 3.14.5 as the windowing engine only, with follow discipline owned by the app (`isAtEnd` threshold 1 px); anchor holds through all mid-stream resizes at 0.0 px settled deviation — [spike-c](../spikes/spike-c-virtual-term.md) |
| (vi) 6-PTY flow-control soak | **GO** | Bounded memory, zero dropped bytes with flow control engaged (synthetic ANSI flooder ≈ claude TUI; real-TUI re-run at the M2 gate); fallback (byte-budget shedding) not needed — [spike-d](../spikes/spike-d-pty-supervision.md) |
| (vii) Broker-SIGKILL orphan/resume | **GO** | Orphan adoption + ledger/journal resume fidelity confirmed as designed; quarantine-and-restart fallback not triggered — [spike-d](../spikes/spike-d-pty-supervision.md) |
| (viii) `ant` profile Max-subscription | **HOLD** | Watch rung unchanged (blueprint §3): documented-evidence verdict says profile ≠ subscription quota is the likely shape; the deciding 10-minute experiment is written up as an owner-run T3 (no real accounts touched by agents) — [spike-e](../spikes/spike-e-signing-ant.md) |
| (ix) Sidecar signing dry run | **GO (v0)** | Ad-hoc sidecar signing works end to end; the shared-build/`externalBin` notarization gotcha is documented with the manual sign-and-notarize script as named fallback; Developer-ID + notarytool end-to-end is owner/T3 — [spike-e](../spikes/spike-e-signing-ant.md) |
| (x) Bun.Terminal parity | **GO (for the incumbent)** | Stay on Node LTS + node-pty for the daemon; Bun.Terminal disqualified on parity — no fallback consequence triggered — [spike-c](../spikes/spike-c-virtual-term.md) |

## 6. Consolidated pending-owner ledger (M0)

Nothing below blocks local development; items 1–2 block publishing.

1. **History rewrite + force-push of the pre-history author identity**
   (SECURITY.md §5.1) — every SHA changes; do it before anything is built
   against public SHAs.
2. **GitHub account email-privacy settings** (SECURITY.md §5.2) — "Keep my
   email addresses private" + "Block command line pushes that expose my
   email".
3. **Hosted CI first run** — happens automatically on the first post-rewrite
   push; local equivalent already green (§1).
4. **Real-account T3 confirmations for spikes** — (viii) the 10-minute `ant`
   Max-subscription experiment; (ix) Developer-ID/notarytool end-to-end;
   (ii) Pixi soak re-run in the real Tauri WKWebView window (M2); (vi) real
   claude-TUI PTY soak (M2 gate).
5. **FE-ORCH lock mark on DESIGN.md** — flips FE-1 from AUTHORED to LOCKED and
   ungates the other FE packages.
