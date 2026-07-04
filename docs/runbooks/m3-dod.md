# M3 gate record — instruments live, feature 1 (synthetic edition)

**Gate run:** 2026-07-04 · **Scope:** plan §8.2 M3 · **Statuses:** `done` /
`done-with-deviation` (named) / `pending-owner`.

> **X2 reminder:** nothing in this file names a real identity. Real values
> (account mappings, AWS account id, SSO profile names) are referenced by
> class only, per [SECURITY.md](../../SECURITY.md) §1.

The M3 DoD's live items ride real account config dirs, a real statusline
render loop, a real OTel-exporting `claude`, real OAuth endpoints, and a
real AWS account — all T3 external surfaces, **pending-owner by rule** (rules
3; live AWS calls additionally cost money per request). Everything provable
synthetically is proven below against the REAL composed chain (real gateway +
real collector servers on loopback + real SQLite events store + real read-model
publisher; the fakes are the ICR-0008/0010 testkit feeds and the AWS/OAuth
client ports), and the owner procedures are runbooked
([bedrock-iac.md](bedrock-iac.md), [hooks-telemetry.md](hooks-telemetry.md),
`infra/ci/live-check.sh`).

---

## 1. Gate-run evidence (what the gate actually executed)

| Check | Command | Result |
|---|---|---|
| Install | `pnpm install` | clean, 7 workspace projects |
| Typecheck | `pnpm -r typecheck` | clean across all 6 packages (TS strict) |
| Unit/component tests | `pnpm -r test` | **1323 pass / 1 skipped, 111 files, 0 fail** — protocol 104, shared 36, testkit 92, schema 61, app 375, core 655+1 (the skip is the double-gated live opencode spec placeholder, unchanged from M2) |
| Infra suite | `pnpm run test:infra` | **71/71 bats pass** — SI-2 accounts 22, SI-3 launchd 13, SI-3 hooks 23, **SI-4 aws-iac 13 (new)**; shellcheck clean |
| Token lint | `pnpm -F aibender-app lint:tokens` | OK — 116 files scanned, **0 violations** (DESIGN.md locked) |
| SPA build | `pnpm -F aibender-app build` | vite build OK (same single >500 kB chunk-size warning as M2; M6 packaging concern) |
| src-tauri untouched | `git status`/`git diff` on `app/src-tauri` | **no diff** — FE M3 work never entered the shell; cargo suites not re-run by rule (nothing to re-prove) |
| Golden corpus ↔ FE client | `vitest run src/lib/ws/goldenCorpus.spec.ts` (app) | **78/78** — the M3-extended corpus (events payloads incl. every read-model snapshot + invalid classes) through the REAL inbound router |
| Golden corpus ↔ BE gateway | `vitest run src/gateway/serverGolden.spec.ts` (core) | **52/52** — byte-for-byte replay over a real WebSocket against the live gateway |
| Golden corpora reference | testkit suite (in `pnpm -r test`) | ws corpus + **hook-POST corpus (new, `GOLDEN_HOOK_FIXTURES`)** self-checks green; `GOLDEN_WS_CORPUS_FREEZE = 'FROZEN-M3'` = protocol freeze |
| M2 approval round-trip | `vitest run src/main/m2ApprovalRoundTrip.spec.ts` (core) | **3/3** — unchanged post-composition-wiring |
| Composed broker e2e | `vitest run src/main/composedBroker.spec.ts` (core) | **9/9** — launch → attended pty → approval → transcript + all three publisher lanes over ONE socket |
| 6-PTY soak + echo | `pnpm -F aibender-core soak:m2` | **PASS post-composition-wiring** — 24,379,392 wire bytes total, slow-consumer in-flight capped at the 1 MiB window, producer plateau stable at ~2 MiB, **zero byte loss**; echo p50 0.089 ms · **p95 0.124 ms** · p99 0.188 ms (budget 100 ms) |
| M3 DoD proof suites | `vitest run src/collector/ src/readmodels/ src/main/composedBroker.spec.ts` (core) | **161/161, 16 files** (verbose per-test names cited in §3) |
| M3 dashboard suites | `vitest run src/features/observability/` (app) | **45/45, 8 files** |
| [X2] identity audit (automated) | `vitest run src/collector/x2Audit.spec.ts` (core) | **4/4** — every source ingested adversarial runtime-built identity shapes; EVERY column of EVERY row of EVERY table swept clean; account columns labels-only; store backstop still throws |
| [X2] identity audit (independent) | gate agent's own tsx sweep, detectors authored independently of `core/src/collector/identity.ts` | **CLEAN** — file-backed store populated through all 8 sources; 21 rows / 185 cells / 6 tables swept with 8 detector classes (email, word-bounded 12-digit, AKIA/ASIA key ids, sk- tokens, GitHub/Slack tokens, JWT, basic-auth creds) + literal presence of 8 injected adversarial values; 0 hits; all-source teeth check green |
| Tier-1 scan (full dir) | `gitleaks dir . --config .gitleaks.toml` | **CLEAN** (8.24 MB scanned; cargo `target/` path allowlist in effect per SECURITY.md §2) |
| Tier-2 scan (full dir) | `gitleaks dir . --config <tier-2>` | **exactly the 12 known `.git/logs` reflog echoes** (6 `HEAD`, 4 `refs/heads/main`, 2 `refs/remotes/origin/main`) — **zero findings outside `.git/logs`**; pending-owner item 1, unchanged |
| Tier-1 + Tier-2 (publishable export) | `gitleaks dir <export>` both configs | **CLEAN both** — 570-file export (tracked + untracked non-ignored) |
| Tier-1 + Tier-2 (history) | `gitleaks git .` both configs | **CLEAN both** — 25 commits |

## 2. Deliverables (plan §8.2 M3)

| Deliverable | Status | Notes |
|---|---|---|
| M3 contract freeze (protocol `1.1.0` / `FROZEN-M3`) | **done** | `events` payload union frozen (ws-protocol §13: `event-summary` + `read-model-snapshot` + the forward-tolerant unknown-kind rule); closed registries `EVENT_SOURCES` / `SOURCE_FRESHNESS_STATES` / `EVENT_ERROR_KINDS` / `READ_MODEL_IDS`; schema migration 0002 events store (sqlite-ddl §7: `events` + `quota_snapshots` + `session_outcomes` + `prices`, separate collector-owned db); hooks-contract §7 acceptance types + 29-name vocabulary + golden hook-POST corpus; ICR-0009 kernel message tap (the BE-1 transcript-tee seam); ICR-0010 collector fixture feeds. Co-signs recorded as pending in the amendment tables: FE-ORCH (ws-protocol M3 row — the freeze-literal advance in `app/src/features/launch/wire.spec.ts` is in-tree and green), SI-ORCH (hooks-contract §7 row) |
| BE-5 collector: all §6.1 sources | **done** (fakes for AWS/OAuth clients by rule) | `core/src/collector/`: JSONL account watcher (tailer, transcripts, history, usage-data), statusline quota tee + OAuth poller scaffold, OTLP http/json receiver (loopback), OpenCode SSE + db scrape, Cost Explorer + CloudWatch pollers (fake clients, live client refused without opt-in), LM Studio inline capture, hooks accepting endpoint (incl. PermissionRequest→ApprovalBroker hook-floor relay), api_request joiner, [X2] identity scrub at ingest |
| BE-6 read models + freshness + graph feed | **done** | `core/src/readmodels/` (all ten §6.3 leads, ccusage block assembly, burn-rate + exhaustion projection, freshness state machine with down-as-state conditions, classification queue via the real BE-4 LM Studio adapter, publisher) + `core/src/collector/graphfeed/` (hook-post/watcher touches → `{stream:'context-graph'}`) |
| FE-5 dashboards | **done** | `app/src/features/observability/`: deck in the frozen §6.3 instrument order, store/bind with rAF batching (per-message React updates provably absent), freshness doctrine rendering (NO SIGNAL, never errors), honest-labeling audit, [X2] render audit, ObservabilityDock chrome wiring via the registry seam, `registerObservability` at boot + `CHANNEL.EVENTS` replay-from-zero |
| BE-MAIN composition | **done** | `composeBroker` wires EVERY gateway port through one composition (kernel verbs, shared ApprovalBroker both halves, BE-2 ptyHost, ICR-0009 transcript tee, M3 publisher lanes); resolves the M2 deferred watch item — recorded in [docs/contracts/icr/README.md](../contracts/icr/README.md) |
| SI-4 plan shown (apply if OK'd) | **done (authoring + validation)** / plan+apply **pending-owner** | `infra/aws/` Terraform stack (inference profile copy, read-only telemetry IAM, optional cost-allocation-tag activation); fmt + validate green (hashicorp/aws v6.53.0, `init -backend=false`); credential-scrubbed plan attempt fails cleanly with no partial state (pinned as a bats edge test); 13-test bats suite proves apply absent from CI by construction; owner sequence in [bedrock-iac.md](bedrock-iac.md). **Not applied — the hard gate held: no `terraform plan` with credentials, no apply, no AWS API call was made** |
| Estimate-mode fallback wired | **done** | `cost_estimated_usd` at ingest (litellm-pinned prices fallback) vs `cost_actual_usd` backfill target; publisher renders estimate-only BY STATE while Cost Explorer never signaled; FE honesty audit proves "ACTUAL" never renders in that state |

## 3. DoD checklist (plan §8.2 M3, item by item)

Proof suites named here were run at the gate (§1); every cited test passed.

| # | DoD item | Status | Evidence |
|---|---|---|---|
| 1 | All Claude sources (JSONL, statusline quota, OTLP) ingesting per account | **done** (synthetic fixtures) / live host **pending-owner** | JSONL: `jsonl.spec.ts` "createAccountConfigWatcher ingests transcripts + history + usage-data; the label comes from the root" (+ truncation/rotation/re-tail dedupe edges). Statusline: `quota.spec.ts` "ingests `<LABEL>.json` tee files; label from the FILE NAME only" + "maps five_hour/seven_day into 5h/7d snapshots". OTLP: `otlp.spec.ts` "attributes rows to the harness-stamped account resource attribute" + retry-dedupe + 415-on-protobuf. Per-account attribution is label-only at ingest [X2]. Live JSONL/statusline/OTLP from the real accounts needs SI-3 installs + real logins (T3) |
| 2 | OpenCode SSE deduped on `evt_` ids with gap-repair proven by induced disconnect | **done** | `opencode.spec.ts` "ingests live events once; a verbatim re-emit dedupes on the evt_ id" + "SSE gap → `after=<seq>` replay heals EXACTLY (**induced disconnect**)" + "sync correlation covers a slot WITHOUT a follow-up event (one-chunk window closed)" — the last riding the BE-4 `onSync` hardening landed this milestone |
| 3 | `opencode.db` scrape reconciles to identical ids | **done** | `opencode.spec.ts` "scrapes durable events read-only and reconciles to IDENTICAL evt_ ids"; the [X2] credential-table read guard re-proven on the consumed handle |
| 4 | Quota gauges show live `five_hour`/`seven_day` with reset countdowns | **done** (fixture tee files + wire snapshots) | Ingest from fixture tee files (item 1); read model: `projections.spec.ts` "quota gauges (lead 1) maps the latest snapshot per (account, window)"; wire: `publisher.spec.ts` "read models ride events, **quota rides quota**"; render: app `golden.spec.tsx` deck hydration, `instruments.spec.ts` "countdowns are compact and never read 0M in the future", `freshness.spec.tsx` "live quota-channel snapshots move a gauge between read-model recomputes" |
| 5 | Burn-rate projection renders | **done** | `blocks.spec.ts` (ccusage-fixture block assembly, hand-computed burn + linear exhaustion extrapolation, clock-skew edges) + `projections.spec.ts` "burn rate (lead 2)" rows + app `instruments.spec.ts` "burn-rate rows follow the frozen label order; exhaustion degrades" |
| 6 | Bedrock USD shows actuals (if SI-4 applied) or an honestly-labeled estimate with freshness state | **done — estimate branch (SI-4 not applied, the expected state)** | `projections.spec.ts` "bedrock cost (lead 3) sums MTD estimates; actuals + yesterday + lag only when backfill landed"; `publisher.spec.ts` "bedrock overlay renders **estimate-only BY STATE** while Cost Explorer never signaled"; app `honesty.spec.tsx` `"ACTUAL" never renders while freshness=estimate-only — full matrix` + "un-gated actuals render as an OVERLAY next to the estimate — never a sum". The actuals branch is proven against the fake Cost Explorer client incl. backfill-only re-poll (`aws.spec.ts`); real actuals are gated on the SI-4 owner apply |
| 7 | Cache-TTL split visible | **done** | Ingest: `jsonl.spec.ts` "extracts all four token classes + the 5m/1h cache-TTL split" + `ingest.spec.ts` joiner carries it; read model: `projections.spec.ts` "cache hit rate (lead 5) — TTL split carried through"; render: app `golden.spec.tsx` §"5 · CACHE HIT — TTL split visible" |
| 8 | Automated audit proves zero identity-bearing rows in the store | **done — twice, independently** | (1) `x2Audit.spec.ts` 4/4: all 8 sources ingest runtime-built adversarial identity content, then EVERY column of EVERY row of EVERY table sweeps clean, account columns carry only the five labels, and the schema-level insert backstop still throws. (2) The gate's independent sweep (own detector set: email, `\b\d{12}\b`, AKIA/ASIA, sk-, gh?_, xox?-, JWT, basic-auth-in-URL, + injected-literal presence) over a file-backed store populated through the same 8 sources: **0 hits over 185 cells**, teeth check confirms every source landed rows |
| 9 | Every degraded source renders NO SIGNAL, not an error | **done** | Freshness machine: `freshness.spec.ts` (core) — no-signal without fabricated timestamps, stale/re-freshen, monotonic, all five frozen down-as-state conditions. Render: `freshness.spec.tsx` (app) walks EVERY frozen state per doctrine (fresh, stale, no-signal, lmstudio-down, cluster-absent, sso-expired, account-logged-out, estimate-only) + "an absent read model renders NO SIGNAL — never a fabricated zero" + "gateway down dims EVERY instrument to NO SIGNAL, slots retained". Degraded-state carriage over the wire: `publisher.spec.ts` "carries degraded sources as STATES" |
| 10 | `{stream:'context-graph'}` envelopes observable on the wire | **done** | `publisher.spec.ts` "publisher + graphfeed — over the real gateway wire: … touches ride context-graph" (asserts `stream === 'context-graph'` on received envelopes); `composedBroker.spec.ts` publisher-lane test observes a `context-touch` on `CHANNEL.CONTEXT_GRAPH` end-to-end through the composed broker over one socket |

## 4. Gate deviations (named, minimal)

- **D1 — AWS pollers are proven against fake clients only.** Rule 3 forbids
  live AWS API calls (Cost Explorer bills per request); the live-client
  constructors REFUSE to run without an explicit opt-in, and that refusal is
  itself a tested behavior (`aws.spec.ts` negative rows). Same pattern for the
  OAuth quota poller (`enableLiveOauth` gate, refusal tested).
- **D2 — "live" in DoD items 1/4 means synthesized fixture feeds** (ICR-0010
  statusline/OTLP generators, fixture JSONL trees, fixture tee files) through
  the real servers/watchers/stores on loopback. The real-host halves are
  runbooked and consolidated in §5.
- **D3 — the classification queue runs against testkit's fake LM Studio
  server** through the REAL BE-4 adapter (down-as-state proven mid-request).
  LM Studio itself is never started (rule 3).
- **D4 — SI-4 stops at authoring + credential-less validation.** No
  plan-with-credentials, no apply, no cloud call. This is the hard gate
  working as specified, not a gap: the DoD's Bedrock-USD item passes on its
  estimate branch (§3 item 6).
- **D5 — hooks-floor gating verification on the real CLI remains T3**
  (hooks-contract §4): the collector's `200 {permissionDecision}` answers are
  golden-fixture-frozen, but the real CLI's interpretation must be verified at
  SI-3 install before the floor turns enforcing.

## 5. Pending-owner consolidated (T3, unchanged rules)

1. **History rewrite + reflog identity** (M0 §5.1, SECURITY.md): the 12
   `.git/logs` reflog echoes of the root-commit author identity; rewrite +
   `git push` are owner actions. Unchanged since M0.
2. **Three one-time real logins** ([login-bootstrap.md](login-bootstrap.md)) —
   still the root unblock for every live Claude-source item.
3. **M1 live acceptance run** ([kernel-live-spawn.md](kernel-live-spawn.md)).
4. **M2 live cockpit acceptance** ([pty-attended-live.md](pty-attended-live.md)).
5. **SI-3 live installs** (hooks settings + statusline tee + OTel env block
   into the real per-account dirs; launchd bootstrap) —
   [hooks-telemetry.md](hooks-telemetry.md), [launchd.md](launchd.md). Now
   also the gate for: **live JSONL/statusline/OTLP ingest from the real
   accounts** (M3 item 1's live half) and the **hooks-floor gating
   verification** (D5) before the floor turns enforcing.
6. **Real OAuth quota poller enablement**: owner supplies the live client
   opt-in (`enableLiveOauth`) once the endpoint behavior is confirmed on a
   real idle account; the rate floor and backoff are already enforced in code.
7. **SI-4 owner sequence** ([bedrock-iac.md](bedrock-iac.md)): `aws sso login`
   → owner-run `terraform plan` → review → **explicit verbal OK** →
   `terraform apply` → wire the profile ARN into OpenCode config → optional
   second apply for cost-allocation-tag activation. Until then
   `infra/ci/live-check.sh --check aws-sso-plan` reports SKIP(pending-owner).
8. **Live AWS pollers** (post-item-7): first real Cost Explorer + CloudWatch
   polls (cost-incurring, 1–2×/day floor enforced) — flips the Bedrock
   instrument from estimate-only to actuals+lag.
9. **LM Studio live capture probe**: owner starts LM Studio; the inline
   capture and residency policy then get their live half.

M3 gate verdict: **PASS (synthetic edition)** — every synthetic-provable DoD
item green at HEAD with runnable cited proofs; the estimate-mode Bedrock
branch is the honest expected state pre-SI-4; live-host items runbooked and
owner-gated.
