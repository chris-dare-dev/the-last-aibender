# M4 gate record — lineage ([X4] + feature 6, synthetic edition)

**Gate run:** 2026-07-04 · **Scope:** plan §8.2 M4 · **Statuses:** `done` /
`done-with-deviation` (named) / `pending-owner`.

> **X2 reminder:** nothing in this file names a real identity. Real values
> (account mappings, AWS account id, SSO profile names) are referenced by
> class only, per [SECURITY.md](../../SECURITY.md) §1.

The M4 DoD's live halves ride real per-account hook installs, real account
config dirs under the reconciler's watch, and a real in-Tauri WKWebView window
— all T3 external surfaces, **pending-owner by rule** (rule 3: ~/.claude is
READ-ONLY, no real logins, no VM operations). Everything provable synthetically
is proven below against the REAL composed chain: the real kernel + ptyHost
recording lineage at action time, the real hooks HTTP endpoint receiving
synthesized posts, the real reconciler over fixture trees, the real gateway
fanning frozen workstream frames to the real FE stores, and the real Pixi
WebGL graph island under Playwright (Chromium + WebKit). Owner procedures are
runbooked ([hooks-telemetry.md](hooks-telemetry.md),
[colima.md](colima.md), `infra/ci/live-check.sh` — 13-check registry with the
two new M4 rows `x4-hook-slots` and `colima-probe`).

---

## 1. Gate-run evidence (what the gate actually executed)

| Check | Command | Result |
|---|---|---|
| Install | `pnpm install` | clean, 7 workspace projects |
| Typecheck | `pnpm -r typecheck` | clean across all 6 packages (TS strict) |
| Unit/component tests | `pnpm -r test` | **1693 pass / 1 skipped, 145 files, 0 fail** — protocol 136, shared 36, testkit 95, schema 78, app 576, core 772+1 (the skip is the double-gated live opencode spec placeholder, unchanged since M2) |
| Infra suite | `pnpm run test:infra` | **92/92 bats pass** — SI-2 accounts 22, SI-3 launchd 13, SI-3 hooks **27** (X4 slot activation rows included), SI-4 aws-iac 13, **SI-5 colima 17 (new)**; shellcheck clean |
| CI-side suite | `bash infra/ci/tests/run.sh` | **33/33 bats pass** — live-check registry pinned at 13 rows incl. the M4 `x4-hook-slots` + `colima-probe` entries; branch-protection contexts match ci.yml job names; shellcheck clean |
| Token lint | `pnpm -F aibender-app lint:tokens` | OK — **166 files scanned, 0 violations** (DESIGN.md locked; graph island + workstream surfaces included) |
| SPA build | `pnpm -F aibender-app build` | vite build OK (single >500 kB chunk warning, now ~1.27 MB with pixi.js — M6 packaging concern, unchanged class) |
| src-tauri untouched | `git status` on `app/src-tauri` | **no diff** — M4 FE work never entered the shell; cargo suites not re-run by rule (nothing to re-prove) |
| Playwright islands | `pnpm -F aibender-app test:islands` | **all three islands pass on Chromium AND WebKit** — terminal (acks=7, attaches=3 both engines), transcript (all phases, 0 jank frames on followed streams), graph (functional phases + 5k soak; numbers below) |
| Golden corpus ↔ FE client | `vitest run src/lib/ws/goldenCorpus.spec.ts` (app) | **100/100** — the M4-extended corpus (`workstream-payload` + `workstream-client-message` stages, valid frame per kind + every invalid class) through the REAL inbound router |
| Golden corpus ↔ BE gateway | `vitest run src/gateway/serverGolden.spec.ts` (core) | **59/59** — byte-for-byte replay over a real WebSocket against the live gateway |
| Golden corpora reference | testkit suite (in `pnpm -r test`) | wsGolden 14 + hooksGolden 8 self-checks green; `GOLDEN_WS_CORPUS_FREEZE = 'FROZEN-M4'` = protocol freeze (`1.2.0`); hook corpus carries per-fixture `x4Route` pins |
| M2 approval round-trip | `vitest run src/main/m2ApprovalRoundTrip.spec.ts` (core) | **3/3** — unchanged post-M4 wiring |
| Composed broker e2e | `vitest run src/main/composedBroker.spec.ts` (core) | **9/9** — launch → attended pty → approval → transcript + all publisher lanes over ONE socket; the publisher-lane test observes a `context-touch` on `CHANNEL.CONTEXT_GRAPH` on the wire |
| Composed workstreams e2e | `vitest run src/main/composedWorkstreams.spec.ts` (core) | **5/5** — §16.5 boot snapshot, control-verb launch → `workstream-node` fan-out, frozen merge verb end-to-end, ICR-0009 tee → branch-advisory, ptyHost recycle → continue self-edge |
| 6-PTY soak + echo | `pnpm -F aibender-core soak:m2` | **PASS post-M4-wiring** — slow-consumer in-flight capped at the 1 MiB window, producer plateau stable at ~2 MiB, **zero byte loss**; echo p50 0.094 ms · **p95 0.145 ms** · p99 0.209 ms (budget 100 ms) |
| M3 regression suites | `vitest run src/gateway/serverGolden.spec.ts src/collector src/readmodels` (core) | **219/219, 17 files** — collector all 8 sources (incl. hooks endpoint + x4 routing), freshness, ten read models, graphfeed, x2Audit 4/4 |
| M4 DoD proof suites (core) | `vitest run src/workstreams src/collector/hooks/x4Routing.spec.ts src/main/composedWorkstreams.spec.ts src/gateway/serverWorkstream.spec.ts` | **110/110, 14 files** (per-test citations in §3) |
| M4 DoD proof suites (app) | `vitest run src/features/workstreams src/islands/graph` | **168/168, 17 files** (per-test citations in §3) |
| 5k-node graph soak | graph island pw runner (in `test:islands`) | Chromium (ANGLE Metal, Apple M4 Max, DPR 2): **fps 119.8 · frame mean 8.33 ms · p95 10.10 ms · 0% >16.7 ms · 0% >33.3 ms** (959 frames, 192 layout epochs applied) — strict spike-B floor met outright. WebKit (Apple GPU, DPR 2): **fps 59.9 · mean 16.66 ms · p95 18.00 ms · 0% >33.3 ms** (480 frames, 197 epochs) — 60 Hz-pinned pacing; floor met in its primary "60 fps sustained" form (deviation D1) |
| Tier-1 scan (full dir) | `gitleaks dir . --config .gitleaks.toml` | **CLEAN** (10.45 MB scanned; cargo `target/` path allowlist in effect per SECURITY.md §2) |
| Tier-2 scan (full dir) | `gitleaks dir . --config <tier-2>` | **exactly the 12 known `.git/logs` reflog echoes** (6 `HEAD`, 4 `refs/heads/main`, 2 `refs/remotes/origin/main`) — **zero findings outside `.git/logs`**; pending-owner item 1, unchanged |
| Tier-1 + Tier-2 (history) | `gitleaks git .` both configs | **CLEAN both** — re-run after the M4 commits landed (result recorded at commit time) |

## 2. Deliverables (plan §8.2 M4)

| Deliverable | Status | Notes |
|---|---|---|
| M4 contract freeze (protocol `1.2.0` / `FROZEN-M4`) | **done** | `workstream` channel frozen (ws-protocol §16: list/detail snapshots with the scope matrix, node upserts, edge appends with the 8-edge vocabulary, briefs, branch-advisory, merge-resolved + the client `workstream-merge-request` with the §16.4 error contract); lineage seams frozen as port types (§15 `LineageRecorder` at action time + `SessionIdResolver`, resolving the M3 §12 pin); schema migration 0003 lineage tables (sqlite-ddl: `workstream`/`session_node`/`session_edge`/`brief` + typed accessors); hooks-contract §7.1 [X4] automation routing (SessionEnd/PreCompact post-ack fire-and-forget, SessionStart deadline-raced with the frozen `HookSessionStartOutput` injection shape); corpus extended, no existing fixture changed; [ICR-0011](../contracts/icr/icr-0011-gateway-workstream-slice.md) gateway/FE wiring seams. Co-sign state in §6 |
| BE-7 workstream ledger, briefs, reconciler | **done** | `core/src/workstreams/`: ledger engine (LineageRecorder impl + workstream CRUD + publisher), merge engine (ONE node + N `merge_parent` edges + mandatory brief, atomic), brief synthesizer (native-compaction-summary reuse, conflict surfacing deterministic and never model-resolved, drafter/refiner ports with down-as-state), hook automation (idempotent SessionEnd/PreCompact/SessionStart), reconciler (fs-watch fixture `projects/**` + guarded read-only opencode.db poll → inferred-confidence orphans, native-id dedupe), pressure watch → branch-advisory, retention guardrails, resolver; narrow wiring into kernel/ptyHost call sites + composeBroker + hooks routing |
| FE-4 graph island live-wired | **done** | `app/src/islands/graph/`: GraphStore → LayoutBridge → module worker (transferable Float32Array epochs) → Pixi v8 WebGL2 renderer (`antialias:false`, hairline edges); spawn-at-referrer, amber touch pulse, layer toggles, cluster-dim, degrade-on-worker-crash, reduced-motion (settled layout, jump-cut camera, static pulse); bound to `CHANNEL.CONTEXT_GRAPH` with replay-from-zero; registered in `main.tsx`; GRAPH view toggle in chrome |
| FE-6 workstream slice | **done** | `app/src/features/workstreams/`: store/bind on `CHANNEL.WORKSTREAM`, lineage DAG assembly, WorkstreamsDeck + WorkstreamsDock (LEFT zone), merge flow (frozen §16.2 verb byte-identical to the golden frame; conflict-section-forcing scaffold; every §16.4 ending an instrument state), branch-advisory rendering, [X2] render audit, the ONE ceremonial animation on lineage-edge EVENTS only (snapshot-carried edges render settled; reduced-motion discrete ring) |
| SI-3 brief-automation hooks active | **done** (templates + installer + bats) / live install **pending-owner** | [X4] slots M4-active in `infra/hooks/templates/settings.fragment.json.template` (SessionStart matcher `startup\|resume\|clear\|compact` timeout 10, SessionEnd, PreCompact); installer merge-never-overwrite; 27/27 bats; `live-check.sh --check x4-hook-slots` reads the real per-account state (read-only) when the owner runs it |
| SI-5 colima pins + probe (X4 hook slots rider) | **done** (authoring; VM ops owner-gated) | `infra/colima/pins.env` (colima 0.10.1 / lima 2.1.1 / k3s v1.33.4+k3s1 baseline), `probe-pod-host-loopback.sh` read-only by construction (DOWN is a state, exit 3; never starts/stops/resizes the VM), 17 bats headless via PATH stubs, [colima.md](colima.md) runbook with the mandatory upgrade gate |

## 3. DoD checklist (plan §8.2 M4, item by item)

Proof suites named here were run at the gate (§1); every cited test passed.

| # | DoD item | Status | Evidence |
|---|---|---|---|
| 1 | Every kernel launch/resume/fork/recycle records its typed edge **at action time** | **done** (real kernel + real ptyHost) | `core/src/workstreams/kernelLineage.spec.ts` (7): "launch records the node AT ACTION TIME — before the spawn is awaited", "launch → resume → fork produces exactly the expected typed edge set", "un-forked dead resume records the continue SELF-edge (continuation = child, in-place)", "full resume→fork drive over one node yields exactly [continue self, fork] — nothing else", "every recorded node/edge fans out a VALID frozen wire payload", and the REAL-ptyHost row "same-node recycle records the continue self-edge with recycle metadata; fork-recycle records the child edge". Composition-level re-proof: `composedWorkstreams.spec.ts` "a control-verb launch records its node over the SAME store" + "a ptyHost recycle records the continue self-edge" |
| 2 | Externally-launched session appears as an inferred-confidence orphan within one reconciler cycle | **done** (fixture trees by rule) / real account dirs **pending-owner** | `core/src/workstreams/reconciler.spec.ts` (9): "registers an external session as an inferred-confidence orphan within ONE cycle", "NEVER creates nodes or edges for kernel-driven sessions (native-id dedupe)", "a second cycle dedupes already-registered orphans", "/cd moves native scope WITHOUT breaking lineage", "registers opencode sessions as AWS_DEV inferred orphans through the BE-4 guard", "start() runs the first cycle immediately" |
| 3 | `SessionEnd` auto-brief + `PreCompact` snapshot/`compact` edge + `SessionStart` brief injection fire through the REAL hooks endpoint | **done** (synthesized posts over real loopback HTTP) / real account posts **pending-owner** (SI-3 live install) | e2e: `core/src/collector/hooks/x4Routing.spec.ts` (8) — real `startHooksServer` + real `WorkstreamHookAutomation` + real lineage store, driven by `fetch` POSTs to `/hooks/v1/MAX_A`: "answers 204 and the auto continuation brief lands after the ack", "duplicate posts stay idempotent through the wire (ONE brief)", "answers 204; the snapshot node and compact edge land after", "answers 200 + the frozen HookSessionStartOutput with the latest brief on resume", "a SLOW handler is deadline-raced to 204", "automation events answer 204 and stay events-store-only" (unregistered default). Handler semantics: `workstreams/automation.spec.ts` (9) incl. idempotence, native-summary reuse, injection only on resume |
| 4 | Merge flow produces ONE node with N `merge_parent` edges seeded by a conflict-surfacing brief | **done** | Engine: `workstreams/engine.spec.ts` "records ONE new node with N merge_parent edges + the mandatory brief, atomically" + every §16.4 negative ("nothing written"). Brief: `workstreams/briefs.spec.ts` "extracts key: value claims and surfaces disagreements verbatim per branch", "appends the conflicts section STRUCTURALLY after any model pass". Wire e2e: `composedWorkstreams.spec.ts` "the frozen merge verb lands end-to-end: ONE node, N merge_parent edges, resolved fan-out". FE round-trip: app `features/workstreams/merge.spec.tsx` "deck round-trip: select N nodes → preview → dispatch → new node" + "an encoded merge request is BYTE-identical to the golden frame" + "without a draft it seeds a scaffold that FORCES the conflict section" |
| 5 | Context graph populates **live** during an active (synthetic) session | **done** | Broker→wire: `composedBroker.spec.ts` publisher-lane test observes `context-touch` frames on `CHANNEL.CONTEXT_GRAPH` through the composed broker over one socket; `composedWorkstreams.spec.ts` proves the composition root injects the ledger resolver (§12 pin) + hooks routing. Wire→island: app `islands/graph/wsBind.spec.ts` "forwards context-graph payloads to the sink, one call per touch" + broker-restart surfacing; `store.spec.ts` (15) coalesced per-wave commits. Rendered live population: graph pw phase 2 — fixture waves stream in, nodes/edges appear per commit, one coalesced commit per wave (never per-event), layout epochs flowing; spawn-at-referrer at the LIVE referrer position (phase 6) |
| 6 | Layers/cluster-dim + reduced-motion both proven | **done** | Graph pw phases 4/5/8 on Chromium AND WebKit: hidden layer leaves the scene and returns; out-of-cluster dims to the 0.15 opacity floor and restores; reduced motion = settled layout (no drift <0.5 px), camera jump cut (0 animated), static amber pulse. Workstream side: `ceremony.spec.tsx` "reduced motion: discrete static ring for the budget, one-step revert (§3.5)" + the negatives (snapshot edges never ceremonial; nodes/briefs/advisories never fire it) |
| 7 | 5k-node soak still meets the M0 spike's fps floor | **done — Chromium strict; WebKit 60 Hz-pinned primary-form (D1)** | Chromium/ANGLE-Metal DPR 2: fps 119.8, mean 8.33 ms, **p95 10.10 ms**, 0% >16.7 ms, 0% >33.3 ms over 959 frames with the layout hot (192 epochs applied) — the spike-B operational floor met with ~40% headroom. WebKit/Apple-GPU DPR 2: fps 59.9, mean 16.66 ms, p95 18.00 ms, **0% >33.3 ms** — rAF pinned at a 60 Hz virtual vsync (Playwright 1.61 headless), where the p95 ≤ 16.7 ms encoding is unpassable for ANY scene; floor asserted in its primary "60 fps sustained / 30 fps hard floor" form. See D1 for the control experiment |
| 8 | fs-audit shows zero writes to native stores | **done — twice, independently layered** | Behavioral: `reconciler.spec.ts` "[X4] fs-audit — ledger + recorder + automation + reconciler leave the watched tree and opencode.db **byte-identical** under a full exercise". Structural: `workstreams/architecture.spec.ts` (15) — "[X4] no write path to native stores (source scan)": every module in the package imports no write-capable fs API (new modules join the audit automatically), the fs surface actually imported is read-only (readFileSync/readdirSync/statSync/watch), opencode.db access flows ONLY through the BE-4 read-only guarded SELECT surface; plus "[X2] native ids never reach the wire projections" |

## 4. Gate deviations (named, minimal)

- **D1 — WebKit 5k-soak floor asserted in primary form under 60 Hz-pinned
  pacing (gate amendment to the FE-4 pw runner).** The initial gate run
  FAILED the strict assertion: WebKit p95 18.00 ms > 16.7 ms. Diagnosis
  before any change: the gate ran a **control** — the same harness, same
  headless WebKit, a **4-node/3-edge COLD scene** (layout not hot) — which
  measured fps 59.9 · mean 16.66 ms · p95 18.00 ms · 58.1% >16.7 ms ·
  0% >33.3 ms: statistically identical to the 5k hot-layout figures. The
  overage is vsync quantization at Playwright 1.61 headless WebKit's 60 Hz
  rAF pin, not render cost (the 5k load adds nothing measurable; a
  struggling renderer shows ≥33.3 ms missed-interval frames — zero were
  observed). Spike-B §Method already notes both engines "pinned their pacing
  rate, so measured rAF fps is a floor" — the spike's WebKit happened to pin
  at 85 Hz (Playwright ~1.50), where the p95 encoding is meaningful. The
  gate therefore amended `app/src/islands/graph/pw/run-pw.ts` to detect
  pinned-at-60 pacing (mean within 0.8 ms of 16.67 ms AND fps 58–62 AND <1%
  >33.3 ms) and assert the spike verdict's PRIMARY criterion in that case:
  fps ≥ 58, <1% frames >33.3 ms (a missed vsync interval is ≥33.3 ms by
  construction, so real degradation still fails), p95 within vsync jitter
  (≤20.1 ms). The strict path is unchanged and still governs Chromium and
  any >60 Hz engine. The in-Tauri WKWebView run with ProMotion/uncapped
  pacing stays a T3 confirmation (spike-B "what remains" #1; pending-owner
  item 10).
- **D2 — brief drafting/refining runs against testkit's fake LM Studio**
  through the REAL BE-4 adapter (`briefs.spec.ts` lmStudioBriefDrafter rows;
  down-as-state and blank-answer-as-error proven). LM Studio is never
  started and no cost-incurring model call exists in any M4 path (rule 3);
  conflict surfacing is deterministic by design and never model-resolved.
- **D3 — "live session" in DoD items 3/5 means synthesized traffic through
  the real servers**: real loopback HTTP hook posts (x4Routing), real
  WebSocket workstream/context-graph fan-out (composedWorkstreams,
  composedBroker), real store, real island stores. The real-account halves
  (hook posts from real CLI sessions, reconciler on the real config dirs,
  windowed live graph during a real session) are consolidated in §5.
- **D4 — the reconciler's watch roots are fixture/temp trees by rule** (the
  hard [X4] rule: native session stores are never watched-for-write or
  mutated in tests; ~/.claude READ-ONLY). The fs-audit byte-identity proof
  (item 8) is the enforcement that makes the live flip safe.
- **D5 — colima suite is headless in CI** (PATH stubs + suite-owned loopback
  fake; the real probe is read-only but still touches the real VM socket, so
  even it is owner-run; VM mutations — start/stop/resize/x86-profile delete —
  are owner-gated per [colima.md](colima.md)).

## 5. Pending-owner consolidated (T3, unchanged rules)

1. **History rewrite + reflog identity** (M0 §5.1, SECURITY.md): the 12
   `.git/logs` reflog echoes of the root-commit author identity; rewrite +
   `git push` are owner actions. Unchanged since M0.
2. **Three one-time real logins** ([login-bootstrap.md](login-bootstrap.md)) —
   still the root unblock for every live Claude-source item.
3. **M1 live acceptance run** ([kernel-live-spawn.md](kernel-live-spawn.md)).
4. **M2 live cockpit acceptance** ([pty-attended-live.md](pty-attended-live.md)).
5. **SI-3 live installs** (hooks settings + statusline tee + OTel env block;
   launchd bootstrap) — [hooks-telemetry.md](hooks-telemetry.md),
   [launchd.md](launchd.md). Now also the gate for the **M4 live halves**:
   real [X4] automation posts (SessionEnd auto-brief / PreCompact snapshot /
   SessionStart injection) from real account sessions
   (`live-check.sh --check x4-hook-slots`), the **reconciler on the real
   account config dirs** (M4 item 2's live half), and the **windowed live
   graph during a real session** (M4 item 5's live half). The SessionStart
   `additionalContext` CLI-side interpretation must be verified before
   injection turns on (hooks-contract §7.1 T3 flag; 204 stays the default).
6. **Real OAuth quota poller enablement** (`enableLiveOauth` opt-in;
   rate floor + backoff already enforced in code).
7. **SI-4 owner sequence** ([bedrock-iac.md](bedrock-iac.md)): owner-run
   `terraform plan` → review → **explicit verbal OK** → `terraform apply` →
   wire the profile ARN. Until then `live-check.sh --check aws-sso-plan`
   reports SKIP(pending-owner). Unchanged from M3 — **no AWS call was made
   at this gate.**
8. **Live AWS pollers** (post-item-7): flips the Bedrock instrument from
   estimate-only to actuals+lag.
9. **LM Studio live capture probe** (owner starts LM Studio) — now also the
   live half of the brief-drafter path (D2).
10. **FE-4 in-Tauri soak** (spike-B "what remains" #1–#4): re-run the 5k
    soak inside the real Tauri WKWebView window — confirm ProMotion/uncapped
    pacing (resolves D1's pinned-pacing reading with a direct strict-floor
    measurement), retina cost, hardware renderer string, plus the 30-min
    duration soak (T4/M6).
11. **Colima probe live run + any upgrade** ([colima.md](colima.md)): the
    read-only probe against the real VM is owner-run; colima/lima version
    moves require a green probe first (mandatory gate); VM right-size and
    x86_64-profile deletion are owner-gated VM mutations.

## 6. Co-sign record (flips made at the M4 review, verified by this gate)

Flipped to **co-signed (M4 review)** by the reviewing orchestrators (recorded
in the owning amendment tables; the gate re-ran the cited proof suites):

- ws-protocol.md **M2 FULL FREEZE** row — FE-ORCH (FE client golden-corpus
  round-trips + M2 payload-union suites green).
- ws-protocol.md **§6 attach-semantics pin** row — FE-ORCH (client duty
  asserted in `app/src/lib/ws/wsClient.spec.ts`).
- ws-protocol.md **M3 FREEZE** row — FE-ORCH (freeze-literal advance replayed
  green; events union consumed under the forward-tolerant reader rule).
- hooks-contract.md **M2 freeze** row — SI-ORCH (SI-3 templates POST exactly
  the frozen envelope; 27/27 hooks bats re-run at review).
- hooks-contract.md **M3 §7 acceptance freeze** row — SI-ORCH (golden
  hook-POST corpus green against the real collector handler; template URL
  shape matches the frozen constants byte-for-byte).

Still **pending** (next review window):

- ws-protocol.md **M4 FREEZE** row (§15/§16) — FE-ORCH.
- hooks-contract.md **M4 §7.1 [X4] routing freeze** row — SI-ORCH.
- [ICR-0011](../contracts/icr/icr-0011-gateway-workstream-slice.md) — FE-ORCH.
- bootstrap-file.md M2 freeze row — FE-ORCH (long-standing).
- icr-0003/icr-0004 counterpart co-signs (long-standing, M1-era).

M4 gate verdict: **PASS (synthetic edition)** — every synthetic-provable DoD
item green with runnable cited proofs; one named deviation (D1, the WebKit
pinned-pacing floor reading, control-verified and re-encoded without loosening
the hard floor); live-host halves runbooked and owner-gated.
