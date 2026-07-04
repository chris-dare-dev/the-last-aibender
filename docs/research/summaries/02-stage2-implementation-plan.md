# Stage-2 implementation plan — the-last-aibender

> The build plan that turns [01-architecture-blueprint.md](01-architecture-blueprint.md) (normative
> architecture) into working software. Companion: [00-executive-summary.md](00-executive-summary.md).
> Where this plan and the blueprint appear to disagree, **the blueprint wins** — file an ADR under
> `docs/adr/` before deviating. Account identifiers are placeholders only — **MAX_A**, **MAX_B**,
> **ENT**, **AWS_DEV_ACCOUNT_ID** — per [X2 policy](../findings/x2-secret-hygiene.md).
> Plan date: 2026-07-03.

---

## 0. Scope of Stage 2

**Stage 2 delivers the v0 harness**: the `aibender-core` broker running as a **Tauri sidecar**
(LaunchAgent promotion is prepared but not flipped — blueprint §2), all six product features at v0
depth, and all four cross-cutting requirements ([X1]–[X4]) landed and proven.

**In scope:** hygiene commit + repo scaffold; DESIGN.md token lock; the ten risk spikes
(blueprint §13.5); account provisioning; broker kernel, gateway, adapters, collector, workstream
ledger, workflow engine; Tauri/React frontend with the three islands; the gated externals
(Bedrock application inference profile IaC, Colima right-size) — each behind its own explicit
verbal-OK gate.

**Explicitly out of scope for Stage 2** (recorded so nobody "helpfully" builds them):
LaunchAgent-v1 flip as the default run mode; cosmos.gl corpus mode and the 3D graph showcase;
cross-account transcript-copy as default (ships flag-gated only); SOPS+age (deferred, blueprint
§12 ledger #5); `ant` profile adoption (watch-rung experiment only); Electron shell swap; k3s as
anything but an optional telemetry adjunct; tmux in any form.

---

## 1. Departments, orchestrators, and the operating model

Three departments, each headed by an **orchestrator agent acting as principal engineer**, each
staffed by 2–4 **implementer agents** working in parallel on non-overlapping directory ownership.

| Dept | ID | Orchestrator | Implementer lanes | Root(s) owned |
|---|---|---|---|---|
| Backend (broker daemon) | **BE** | BE-ORCH | 4 lanes: BE-A…BE-D | `core/`, plus stewardship of `packages/protocol` & `packages/schema` |
| Frontend (Tauri app) | **FE** | FE-ORCH | 4 lanes: FE-A…FE-D | `app/`, `DESIGN.md` |
| Server-side config & infra | **SI** | SI-ORCH | 3 lanes: SI-A…SI-C | `infra/`, repo-root hygiene files, `.github/` |

### 1.1 Orchestrator duties (identical across departments)

1. **Review every implementer diff before merge.** No implementer self-merges. Review checks:
   blueprint conformance (cite the section), directory-ownership respected, [X2] hygiene (no
   literals, placeholders only, fixtures synthesized), tests present at the positive/negative/edge
   bar of §9, DESIGN.md conformance for anything visual.
2. **Own the department's shared surfaces.** BE-ORCH is the sole committer to
   `packages/protocol` and `packages/schema` (implementers submit *interface change requests* —
   a short markdown proposal in `docs/contracts/icr/` — which the owning orchestrator lands, with
   the counterpart orchestrator's sign-off when another department consumes the surface).
   FE-ORCH is the sole committer to `DESIGN.md` and `app/src/chrome/theme/`. SI-ORCH is the sole
   committer to `.gitleaks.toml` and `.github/workflows/`.
3. **Run the milestone gates.** Each milestone's definition-of-done (§8) is checked and recorded
   by the orchestrators jointly; the cross-department integration suites (§9.4) are executed at
   every gate.
4. **Write ADRs for deviations** in `docs/adr/` (one page: context, decision, blueprint section
   overridden, consequence). Deviating from the blueprint without an ADR is a review reject.
5. **Enforce the external-write gates.** `terraform apply` for the inference profile, the Colima
   VM resize, and the history force-push are each executed only on the owner's explicit verbal OK,
   surfaced with a plan/diff first.

### 1.2 Git workflow for this repo

Trunk-based on `main` with short-lived package branches (`be/kernel-spawner`,
`fe/graph-worker`, `si/hygiene`), merged by the department orchestrator after review. CI
(gitleaks + unit + lint + build) must be green to merge. Conventional-style commit subjects.
Agents are commit authors here, so **hook-level scanning is the enforcement, not agent
diligence** ([X2 findings](../findings/x2-secret-hygiene.md)) — the pre-commit gitleaks hook and
CI backstop are non-optional from the first commit onward.

### 1.3 No-file-conflict rule

Every work package lists the directories it **owns exclusively for the whole stage**. An
implementer never edits outside its ownership; anything needed from another package is consumed
through `packages/*` interfaces or requested via ICR. This is the mechanism that lets 2–4 agents
per department build simultaneously without merge conflicts.

---

## 2. Repository layout Stage 2 creates

pnpm-workspaces monorepo, TypeScript throughout, Node 22 LTS for `core/` (blueprint §2).

```
the-last-aibender/
├── README.md
├── DESIGN.md                      # Instrument Grade token lock + FORBIDDEN list (FE-ORCH; M0)
├── SECURITY.md                    # X2 policy doc — the committed half of the hygiene doctrine
├── .gitignore                     # ordered: exclusions before negations (X2 §3.3 step 3)
├── .env.example                   # placeholder-only; AWS_PROFILE-embeds-the-ID warning inline
├── .gitleaks.toml                 # Tier-1 generic value-free rules ONLY (never literals)
├── .github/
│   └── workflows/                 # ci.yml · gitleaks.yml · trufflehog-weekly.yml (contents: read)
├── docs/
│   ├── research/                  # existing findings + summaries (this doc lives here)
│   ├── adr/                       # deviation records (all orchestrators)
│   ├── contracts/                 # frozen interface specs (human-readable, versioned)
│   │   ├── ws-protocol.md         # envelope, channels, flow control     (BE-ORCH; freeze M1)
│   │   ├── sqlite-ddl.md          # all ledgers + events store DDL       (BE-ORCH; freeze M1, amend per milestone)
│   │   ├── hooks-contract.md      # http-hook payloads the collector accepts (BE-ORCH+SI-ORCH; M2)
│   │   ├── dag-schema.md          # pipeline JSON DAG v1                 (BE-ORCH; freeze M5)
│   │   ├── bootstrap-file.md      # port/token discovery file format     (BE-ORCH+FE-ORCH; M2)
│   │   └── icr/                   # interface change requests
│   ├── runbooks/                  # operator procedures (login bootstrap, version gate, recovery)
│   └── spikes/                    # one verdict doc per M0 spike (i–x)
├── packages/                      # shared, orchestrator-stewarded
│   ├── protocol/                  # @aibender/protocol — WS envelope + channel + message types, validation schemas
│   ├── schema/                    # @aibender/schema — SQLite migrations + typed row accessors for ALL ledgers
│   ├── shared/                    # @aibender/shared — ids, clock, logging, redaction/identifier-mapping utils
│   └── testkit/                   # @aibender/testkit — synthesized fixture generators + fake servers (§9.5)
├── core/                          # aibender-core daemon — BACKEND department
│   └── src/
│       ├── kernel/                # BE-A: spawner, env injection/scrub, profiles, resume ledger, lifecycle
│       │   └── pty/               # BE-A: ptyHost (node-pty), attended sessions, login bootstrap
│       ├── supervision/           # BE-A: watchdog, pressure signals, recycle loop, sacrifice order
│       ├── gateway/               # BE-B: WS server, channel mux, flow control, control API, bootstrap file
│       ├── adapters/              # BE-B: opencode/ · lmstudio/ · claude-sdk/ (spawn-facing wrappers)
│       ├── collector/             # BE-C: sources/ (jsonl, statusline, otlp, opencode-sse, opencode-db,
│       │                          #        aws, lmstudio) · normalize/ · store/ · graphfeed/
│       ├── readmodels/            # BE-C: dashboard query surfaces over the SQLite store
│       ├── workstreams/           # BE-D: X4 ledger, briefs, reconciler, guardrails
│       ├── pipelines/             # BE-D: catalog/ · dag/ · planner/ · runner/ · journal/
│       └── main/                  # BE-ORCH: composition root, config, startup/shutdown ordering
├── app/                           # Tauri v2 application — FRONTEND department
│   ├── src-tauri/                 # FE-A: shell config, tray, notifications, sidecar wiring
│   └── src/
│       ├── chrome/                # FE-A: layout cockpit, command palette, approval inbox, settings
│       │   └── theme/             # FE-A (FE-ORCH-gated): tokens generated from DESIGN.md
│       ├── lib/                   # FE-A: WS client, zustand stores, ring buffers, rAF projection utils
│       ├── islands/
│       │   ├── terminal/          # FE-B: xterm 6 island (webgl + fit + serialize addons, DOM fallback)
│       │   ├── transcript/        # FE-B: react-virtual end-anchored transcript island
│       │   └── graph/             # FE-C: graphology store, worker layout bridge, Pixi v8 renderer
│       └── features/
│           ├── launch/            # FE-D: one-off prompt + skill launchers, account pickers
│           ├── observability/     # FE-D: instrument dashboards, freshness states
│           ├── workstreams/       # FE-D: lineage views, brief viewer, merge flow
│           └── pipelines/         # FE-D: builder palette/canvas, run monitor, gate actions
├── infra/                         # SERVER-SIDE department (all committable = placeholders only)
│   ├── profiles/                  # SI-B: account profile manifests (labels MAX_A/MAX_B/ENT only)
│   ├── scripts/                   # SI-B: provisioning, keychain probes, version-gate, doctor, demos
│   ├── launchd/                   # SI-B: Aqua LaunchAgent plist templates (broker v1-ready, lms)
│   ├── hooks/                     # SI-B: statusline + http-hook settings templates per account dir
│   ├── aws/                       # SI-C: inference-profile + read-only IAM IaC (apply HARD-GATED)
│   ├── colima/                    # SI-C: right-size config, pod→host loopback probe, upgrade gate
│   └── ci/                        # SI-A: live-check runner definitions, CI helper config
├── spikes/                        # M0 spike harnesses — quarantined, never imported by prod code
└── var/                           # gitignored dev-mode runtime data (X2: ingested data never in tree)
```

**Machine-local runtime layout** (never in the repo; documented in `docs/runbooks/`):
`~/.aibender/accounts/{max-a,max-b,ent}/` as the per-account `CLAUDE_CONFIG_DIR` +
`CLAUDE_SECURESTORAGE_CONFIG_DIR` targets ([harness-architecture](../findings/harness-architecture.md));
`~/.aibender/db/` for the SQLite ledgers; `~/.aibender/bootstrap/` for the gateway port/token
discovery file; `~/.aibender/logs/`. Real account mapping (which human account is MAX_A) exists
only in machine-local files and the owner's head — never in the tree [X2].

---

## 3. Shared contract packages (built before everything, frozen per milestone)

These four packages are the anti-conflict and anti-drift device. Stubs exist at M0; each is
frozen at the milestone shown and amended only via ICR.

| Package | Owner | Contents | Freeze |
|---|---|---|---|
| `packages/protocol` | BE-ORCH (FE-ORCH co-signs) | WS envelope (`stream`, `channel`, `seq`, payload), channel registry (`pty.<sid>`, `transcript.<sid>`, `events`, `context-graph`, `quota`, `approvals`, `control`), binary PTY frame format, ack-watermark flow-control messages, error envelope | M1 core, M2 full |
| `packages/schema` | BE-ORCH | Migrations + typed accessors for: resume ledger; `workstream`/`session_node`/`session_edge`/`brief` (blueprint §5); `events` + `quota_snapshots` + `session_outcomes` + `prices` (blueprint §6.2); workflow `runs`/`steps`/memoization journal (blueprint §7) | M1 (kernel tables), M3 (events), M4 (X4), M5 (pipelines) |
| `packages/shared` | BE-ORCH | id generation, monotonic clock, structured logging with **redaction filters keyed off schema `secret`/`identifier` tags**, the identity→MAX_A/MAX_B/ENT mapping utility (mapping table loaded from machine-local config, never committed) | M1 |
| `packages/testkit` | BE-ORCH (all departments contribute via ICR) | synthesized JSONL transcript generator, fake statusline stdin feed, fake OTLP emitter, mock OpenCode `/global/event` SSE server (with `evt_` ids, duplicate `sync` wrappers, unknown-event injection, heartbeat), fake `opencode.db` builder, golden WS-protocol fixture corpus, fake LM Studio `/api/v0` | grows continuously |

---

## 4. Backend department (BE) — work packages

Substrate rules for every package here: SDK `query()` is the only programmatic substrate,
node-pty the only attended surface, semantics never from PTY bytes, one spawner, one pinned
SDK-bundled binary ([session-substrate-tiebreak](../findings/session-substrate-tiebreak.md),
blueprint §2/§4).

### BE-1 · Session kernel & account runtime — lane BE-A · M1 · size L

- **Owns:** `core/src/kernel/` (except `pty/`), kernel tables in `packages/schema` via ICR.
- **Builds:** profile registry (reads SI-B manifests; labels only); the **single spawn layer**:
  per-account env injection (`CLAUDE_CONFIG_DIR`, `CLAUDE_SECURESTORAGE_CONFIG_DIR` pinned to the
  same per-account path, byte-stable absolute strings), env scrub (`ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE`, `CLAUDE_CODE_USE_*`), OTel env block, refusal of
  `--bare` and of `CLAUDE_CODE_OAUTH_TOKEN`-mixing (blueprint §3 rules 1–3); SDK `query()`
  session lifecycle FSM (launch/resume/forkSession/abort); **resume ledger** with
  row-before-spawn discipline and transcript-tail validation before any resume; un-forked
  double-resume block (blueprint §4.1, §5 guardrails).
- **Key acceptance:** three concurrent sessions, one per account, from one process, zero
  re-login; ledger row provably precedes process spawn; validator repairs/forks from last
  coherent message after induced mid-tool-call kill.
- Sources: [x1-parallel-multi-account](../findings/x1-parallel-multi-account.md),
  [session-substrate-tiebreak](../findings/session-substrate-tiebreak.md).

### BE-2 · ptyHost, attended sessions, login bootstrap — lane BE-A · M2 · size M

- **Owns:** `core/src/kernel/pty/`.
- **Builds:** node-pty spawn of the pinned SDK-bundled `claude` binary through the same spawn
  layer (same env injection path — asserted by test); PTY byte streaming to gateway channels
  with resize handling; the **login-bootstrap flow** (fresh profile → attended TUI →
  `/login` → keychain item appears); serialize-friendly detach/reattach semantics for the
  frontend's serialize addon; recycle-loop v0 (checkpoint→kill→resume, emitting the [X4]
  continuation edge through BE-7's interface once it exists — stubbed until M4).
- Sources: blueprint §4.1; [session-substrate-tiebreak](../findings/session-substrate-tiebreak.md).

### BE-3 · Gateway & protocol runtime — lane BE-B · M2 · size M

- **Owns:** `core/src/gateway/`.
- **Builds:** the single multiplexed WebSocket on `ws://127.0.0.1:<port>` with per-boot random
  auth token; logical channels per `packages/protocol`; **binary PTY frames with ack-based
  watermark flow control** (bounded buffers, slow-consumer backpressure — never unbounded);
  reconnect-with-replay-watermark semantics; the bootstrap/port discovery file
  (`docs/contracts/bootstrap-file.md`); control channel (launch/resume/kill/approve verbs).
  The frontend never talks to any backend-of-backend directly (blueprint §2 topology rules).
- Sources: [frontend-app-shell-stack](../findings/frontend-app-shell-stack.md).

### BE-4 · Backend adapters (OpenCode, LM Studio, claude-sdk wrapper) — lane BE-B · M2–M3 · size L

- **Owns:** `core/src/adapters/`.
- **Builds:** supervised **`opencode serve`** child (127.0.0.1, random port, per-boot random
  `OPENCODE_SERVER_PASSWORD`, argv-`serve` process matching); Bedrock env injection replicating
  the owner's Keychain-fetch shell pattern — values fetched at spawn time, never serialized
  to disk; `@opencode-ai/sdk` client with `parentID` pass-through for [X4]; the SSE transport
  (connection + reconnection + `after=<seq>` durable replay) handed to BE-5 as a consumable
  stream; LM Studio adapter: `/v1` inference routing, feature-gated `/api/v0` state/perf reads,
  `lms`-CLI lifecycle verbs, **down-as-first-class-state** health checks with short timeout,
  JIT+TTL residency policy enforcement (1800 s TTL, 900 s under amber; ≤8B Q4 default; global
  "local model resident" budget line shared with any Ollama usage); verified unloads via API.
- Sources: blueprint §4.2/§4.3;
  [opencode-serve-event-probe](../findings/opencode-serve-event-probe.md),
  [local-resource-feasibility](../findings/local-resource-feasibility.md).

### BE-5 · Collector sources & normalized events store — lane BE-C · M3 · size L

- **Owns:** `core/src/collector/` (except `graphfeed/`), events-store migrations via ICR.
- **Builds:** the hybrid matrix of blueprint §6.1 — per-account JSONL fs-watch tailer (rotation-
  and truncation-safe; 5m/1h cache-TTL split extraction; `usage-data/{facets,session-meta}`,
  `history.jsonl`); statusline quota tee-file ingestion (`rate_limits.five_hour`/`seven_day`) +
  the rate-limited idle-account OAuth usage poller with backoff; in-process **OTLP receiver on
  127.0.0.1:4318**; OpenCode `/global/event` consumption with strict `evt_`-id dedupe, `sync`
  wrapper dropping after watermark capture, unknown-event tolerance; read-only `opencode.db`
  scrape **with a hard guard that the `account`/`credential` tables are never selected** [X2];
  AWS pollers (Cost Explorer 1–2×/day authoritative backfill into `cost_actual_usd`; CloudWatch
  `AWS/Bedrock` 5–15 min while active); LM Studio inline usage capture. Normalizer writes the
  `events` fact table + companions exactly per blueprint §6.2, deduped on (backend, raw_ref),
  JSONL-wins-for-tokens / OTel-wins-for-attribution join; **identity attributes dropped or
  mapped to MAX_A/MAX_B/ENT at ingest — nothing identity-bearing enters the store**.
- Sources: [observability](../findings/observability.md),
  [opencode-serve-event-probe](../findings/opencode-serve-event-probe.md).

### BE-6 · Context-graph feed, freshness states, read models — lane BE-C · M3–M4 · size M

- **Owns:** `core/src/collector/graphfeed/`, `core/src/readmodels/`.
- **Builds:** `{stream:'context-graph'}` envelope publication from the same hook/JSONL/SSE
  watchers (payloads are file paths + session ids only — no account identifiers needed [X2]);
  per-source freshness state machine (LM-Studio-down, cluster-absent, SSO-expired,
  account-logged-out are freshness states, never errors); dashboard read models: quota gauges +
  reset countdowns, 5h-block burn rate and projected exhaustion (ccusage block math), Bedrock
  actual-vs-estimate overlay, API-equivalent USD labeled as equivalence, cache hit rate with TTL
  split, latency p50/p95 + TTFT, skill leaderboard inputs, local-offload ratio (blueprint §6.3).
  Correction-intent classification for the leaderboard is dispatched as a **local-model job**
  through BE-4's LM Studio adapter.

### BE-7 · Workstream ledger, briefs, reconciler ([X4]) — lane BE-D · M4 · size L

- **Owns:** `core/src/workstreams/`, X4 migrations via ICR.
- **Builds:** the `workstream`/`session_node`/`session_edge`/`brief` model exactly per blueprint
  §5 — harness ids never native ids; edge types `continue | fork | merge_parent | compact |
  sidechain | handoff | import | workflow`; **edges recorded deterministically at action time**
  via a kernel-facing interface BE-1/BE-2 call on every launch/resume/fork/merge; continuation =
  child (never sibling); merge = one new node with N `merge_parent` edges seeded by a
  **synthesized, conflict-surfacing merge brief** (reuse native compaction summaries where
  present; else local-model draft refined by a Claude pass — the qwen-produces/Claude-reviews
  split); the reconciler (FSEvents on each account's `projects/**` + `opencode.db` polling)
  registering external sessions as inferred-confidence orphans in the "detached HEAD" bucket;
  brief automation handlers for `SessionEnd`/`PreCompact`/`SessionStart` (hook plumbing itself
  is SI-3); context-pressure watch proposing "branch now" at ~70%; guardrails (`unresumable`
  flags, retention monitoring, native stores **never mutated** — enforced by adapters having no
  write path, and tested as such).
- Sources: [x4-workstreams](../findings/x4-workstreams.md).

### BE-8 · Catalog scanner & pipeline engine (features 4/5) — lane BE-D · M5 · size L

- **Owns:** `core/src/pipelines/`, DAG + journal migrations via ICR, `docs/contracts/dag-schema.md` draft.
- **Builds:** the **one capability-catalog scanner, three consumers** — Claude skills/commands
  (single merged-frontmatter parser preserving unknown keys, surviving malformed YAML), agents,
  plugins (install-state × enablement × scope), saved dynamic-workflow scripts (static `meta`
  parse only, never executed), per (workspace, account-config-dir) with documented precedence
  and walk-up rules; OpenCode capabilities API-first via `GET /agent` / `GET /command` with file
  fallback. The **versioned JSON DAG engine**: step kinds `{prompt|skill|agent|workflow-script}`,
  `needs:` edges, `when` conditionals, `forEach` + `maxParallel`, `loop`, first-class `approval`
  gates; per-step `account` (MAX_A|MAX_B|ENT|AWS_DEV|LOCAL), cwd, permissionMode, budget
  (usd/turns/wall-clock), retry policy, JSON-schema `outputSchema` enforcement; plan-time
  capability resolution pinned by sourcePath + contentHash; per-step AbortController with
  child-process-group reaping; **durable SQLite memoization journal** (`step_id + input_hash →
  cached output`) for cross-restart resume; every step attempt registered as a `session_node`
  with `workflow` edges (via BE-7); per-step cost landed in the events store (via BE-5 ids).
  Native dynamic workflows: scan/import/export/observe only — never the execution foundation.
- Sources: [pipeline-workflow-builder](../findings/pipeline-workflow-builder.md), blueprint §7.

### BE-9 · Supervision & resource governor hardening — lane BE-A · M6 · size M

- **Owns:** `core/src/supervision/`.
- **Builds:** per-session footprint watchdog on **phys_footprint** (claude warn 3 GB / recycle
  6 GB; opencode warn 1 GB / recycle 1.5 GB; `opencode serve` **sustained** >500 MB for 5 min);
  pressure-delta health signals (`memory_pressure -Q`, pressure level, pageout rates — never
  naive free RAM); amber (level 2 / free <25% / swap >20 GB) and red (level 4 / free <12% /
  swap >26 GB) responses; **the [X1] sacrifice order encoded in the scheduler**: local model
  size → model KV/context → frontend shell weight → non-Claude session hibernation →
  scrollback/buffers — account sessions never the victim, account spawns still honored after
  shedding; idle hibernation after 30 min (never auto-applied to the three account sessions);
  `~/.claude.json` size monitoring per account dir. The recycle path reuses BE-2's
  checkpoint→kill→resume and thereby doubles as the [X4] continuation mechanism.
- Sources: [local-resource-feasibility](../findings/local-resource-feasibility.md), blueprint §11.

**BE lane map:** BE-A → BE-1, BE-2, BE-9 · BE-B → BE-3, BE-4 · BE-C → BE-5, BE-6 ·
BE-D → BE-7, BE-8. Four agents, zero shared files; cross-lane needs go through
`packages/protocol`/`packages/schema` ICRs or in-process interfaces defined in
`core/src/main/` by BE-ORCH.

---

## 5. Frontend department (FE) — work packages

Iron rules for every package here: **DESIGN.md before any UI code** (FE-1 gates the rest);
streaming discipline is mandatory — tokens land in non-reactive ring buffers, rAF-batched
projections into stores, transient subscribe for per-frame consumers, never per-token React
state; the locked exact-pin dependency table from
[frontend-stack-coherence](../findings/frontend-stack-coherence.md) (react/react-dom 19.2.7,
babel-plugin-react-compiler 1.0.0, zustand 5.0.14, motion 12.42.2, graphology 0.26.0,
d3-force 3.0.0, pixi.js 8.19.0, pixi-viewport 6.0.3, @tanstack/react-virtual 3.14.5,
@xterm/xterm 6.0.0 + addons, vite 8.1.3, tailwindcss 4.3.2) is the list of record — adding a
dependency requires an FE-ORCH-approved ADR.

### FE-1 · DESIGN.md + token build chain — lane FE-A · M0 · size M

- **Owns:** `DESIGN.md`, `app/src/chrome/theme/`.
- **Builds:** the Instrument Grade token lock — warm charcoal `#111110` surfaces, bone `#E8E6E1`
  text, single amber `#FFB000` accent, semantic-only status hues, 0–2 px radii, hairline rules,
  120–180 ms ease-out mechanical motion, phosphor-decay fade for live telemetry, exactly one
  ceremonial animation reserved for workstream lineage events, monospace character grid for data
  surfaces, latency <100 ms and command palette as first-class tokens, fixed panel positions +
  engraved mono labels for the five channels (MAX_A/MAX_B/ENT/BEDROCK/LMSTUDIO), ultrawide-first
  three-zone cockpit, the FORBIDDEN slop list; Tailwind 4 theme generated **from** the tokens
  (single source of truth); a lint rule that fails CI on off-token colors/radii/shadows; paid
  font binaries never enter the tree — license-clean fallbacks specified.
- Source: [ui-anti-slop-design](../findings/ui-anti-slop-design.md), blueprint §8.
- **Gate:** no other FE package may merge UI code until FE-ORCH marks DESIGN.md locked.

### FE-2 · App chrome, shell, WS client, state layer — lane FE-A · M2 · size L

- **Owns:** `app/src-tauri/`, `app/src/chrome/` (minus `theme/`), `app/src/lib/`.
- **Builds:** Tauri v2 shell (tray, notifications, windows via Tauri IPC **only** — never
  streaming); sidecar wiring for `aibender-core` in v0; the WS client implementing
  `packages/protocol` (reconnect with replay watermarks, bounded buffers); zustand 5 stores +
  ring-buffer/rAF projection utilities the islands consume; cockpit layout, command palette,
  **the single approval inbox** (permission relay surface for hooks-floor + `canUseTool` +
  workflow gates); settings; account channel panels with feature-detected ENT degradation.
- Sources: [frontend-app-shell-stack](../findings/frontend-app-shell-stack.md), blueprint §2/§4.1/§8.

### FE-3 · Terminal + transcript islands — lane FE-B · M0 spike, M2 · size M

- **Owns:** `app/src/islands/terminal/`, `app/src/islands/transcript/`.
- **Builds:** xterm 6 island — WebGL addon with **DOM-renderer fallback selected by the M0 spike
  verdict** (canvas renderer no longer exists; Safari-26 WebGL breakage is the top risk), fit +
  serialize addons (detach/reattach restores scrollback), resize handling against BE-2;
  react-virtual transcript island in end-anchored `anchorTo:'end'` mode, stream-safe (no
  autoscroll jank mid-stream, anchor released on user scroll-up, mid-stream resize per spike v).
- Sources: [frontend-stack-coherence](../findings/frontend-stack-coherence.md), blueprint §8.

### FE-4 · Context graph island (feature 6) — lane FE-C · M0 spike, M3–M4 · size L

- **Owns:** `app/src/islands/graph/`.
- **Builds:** the normative **GraphStore → LayoutBridge → GraphRenderer** contract so cosmos.gl
  and 3d-force-graph can plug in later without touching the store; graphology store; d3-force in
  a module Web Worker exchanging transferable Float32Array position epochs; PixiJS v8 renderer on
  WebGL2 with `antialias` off; incremental protocol — batch mutations per rAF/150 ms, spawn nodes
  at their referrer, gentle `alphaTarget(0.3)` reheat, amber pulse only on the actively-touched
  artifact; layer toggles + cluster-dim from day one (the documented hairball failure);
  reduced-motion path (settled layout, opacity-only fades, no fly-to) from day one; camera easing
  via vanilla Motion `animate()` through the renderer contract.
- Sources: [ui-motion-3d-context-graph](../findings/ui-motion-3d-context-graph.md),
  [frontend-stack-coherence](../findings/frontend-stack-coherence.md), blueprint §8.

### FE-5 · Launchers + observability dashboards (features 1/2/3 UI) — lane FE-D · M2–M3 · size L

- **Owns:** `app/src/features/launch/`, `app/src/features/observability/`.
- **Builds:** one-off prompt launcher against a **specified** account/backend (account picker
  shows MAX_A/MAX_B/ENT/AWS_DEV/LOCAL labels; ENT capabilities feature-detected); skill launcher
  (`/skill-name args` prompt composition; catalog-driven picker once BE-8 lands, free-text until
  then); the instrument dashboards in blueprint §6.3 order — per-account 5h + weekly quota gauges
  with reset countdowns, burn rate + projected exhaustion, Bedrock real USD with estimate
  overlay, API-equivalent USD labeled honestly, cache hit rate with TTL split, latency p50/p95 +
  TTFT, error/throttle health, skill leaderboard with worst-quartile flags, session outcome mix,
  local-offload ratio; every degraded source rendered as a dimmed **"NO SIGNAL" instrument, not
  an error toast**, with one-click remediation (e.g. `lms server start`).

### FE-6 · Workstream + pipeline surfaces (features 4/5 UI, [X4] UI) — lane FE-D · M4–M5 · size L

- **Owns:** `app/src/features/workstreams/`, `app/src/features/pipelines/`.
- **Builds:** workstream lineage view (git-metaphor UX over the X4 ledger — branch/continue/merge
  rendering, orphan "detached HEAD" bucket, brief viewer, merge flow with conflict-surfacing
  brief preview, "branch now" advisory); the pipeline builder — palette fed by the catalog
  scanner, DAG composition with per-step account routing (the [X1] differentiator, visually
  first-class), approval-gate placement, run monitor with per-step cost/status from the events
  store, resume-from-journal affordance; the one ceremonial animation fires on lineage events
  only (DESIGN.md).

**FE lane map:** FE-A → FE-1, FE-2 · FE-B → FE-3 · FE-C → FE-4 · FE-D → FE-5, FE-6.

---

## 6. Server-side configuration & infrastructure department (SI) — work packages

### SI-1 · Hygiene commit & scanning stack ([X2]) — lane SI-A · M0, serial-first · size M

- **Owns:** `.gitignore`, `.env.example`, `.gitleaks.toml`, `SECURITY.md`, `.github/workflows/`,
  the private Tier-2 config (out-of-repo, chmod 600), local pre-commit wiring.
- **Executes the [X2 §3.3 checklist](../findings/x2-secret-hygiene.md) in verbatim order:**
  (1) amend commit `62d11d0`'s work-domain author email to the GitHub noreply address and
  force-push **before anything else depends on the SHA** — a history rewrite on the public
  remote, executed only on the owner's explicit go-ahead; (2) GitHub email-privacy +
  push-protection settings on; (3) ordered `.gitignore` (negation after exclusion; includes
  `var/`, `.env`, local tier-2 path); (4) `.env.example` with the AWS_PROFILE-embeds-the-ID
  warning; (5) Tier-1 `.gitleaks.toml` (12-digit-near-AWS-context, personal-email-provider,
  catch-all email with placeholder allowlists — value-free rules only; a committed rule
  containing the literal *is* the leak); (6) Tier-2 private out-of-repo config with the exact
  literals, wired via a guarded pre-commit hook with `--redact`, failing **closed** when absent;
  (7) gitleaks install + hook wiring; (8) CI workflows with `contents: read` — gitleaks-action
  on push/PR + weekly TruffleHog `--results=verified`; (9) **deliberately fail the gate three
  ways** (fake 12-digit-near-AWS, fake personal email, fake token) and record the failures;
  (10) commit SECURITY.md. All one hygiene commit before any code. Remediation doctrine
  (rotate → `git-filter-repo --replace-text` → GitHub Support) documented in SECURITY.md.
- Also owns the blueprint §13.7 **doc hygiene chore** (annotate superseded lines in
  [frontend-app-shell-stack](../findings/frontend-app-shell-stack.md),
  [ui-motion-3d-context-graph](../findings/ui-motion-3d-context-graph.md), and the x3 SOPS
  stance with pointers to [frontend-stack-coherence](../findings/frontend-stack-coherence.md)
  and the blueprint ledger §12).

### SI-2 · Account provisioning & keychain verification ([X1] host side) — lane SI-B · M1 · size M

- **Owns:** `infra/profiles/`, `infra/scripts/` (accounts subset).
- **Builds:** profile manifests (labels + machine-local path *conventions*, no real identity);
  provisioning scripts creating `~/.aibender/accounts/{max-a,max-b,ent}/` with pinned
  securestorage dirs; the login runbook (one interactive `claude /login` per account, ever);
  **keychain probe script** — recompute expected service names (base + first 8 hex of sha256 of
  the NFC-normalized dir path), probe presence without `-w`, then prove value access in the
  broker's own context via `claude auth status --json` per account; the **version-gate script**
  required before any SDK bump, including the setup-token keychain-deletion canary (issue-#37512
  class) before rung 2 is ever enabled; rung-2 setup-token procedure (harness-owned Keychain
  items, paired with the same account's dirs, yearly-rotation reminder surfaced to the UI);
  the `ant`-profile watch experiment (spike viii) with a written promote/hold verdict.
- Sources: [x1-parallel-multi-account](../findings/x1-parallel-multi-account.md), blueprint §3.

### SI-3 · launchd, hooks, telemetry wiring — lane SI-B · M2–M4 · size M

- **Owns:** `infra/launchd/`, `infra/hooks/`.
- **Builds:** Aqua **gui-domain** LaunchAgent plist templates — broker (v1-ready; default
  session type, `KeepAlive={SuccessfulExit:false}`; Background/user-domain explicitly forbidden
  and tested-as-failing) and `lms` server; per-account hook settings templates: statusline hook
  teeing `rate_limits` stdin JSON to the per-account quota file, `type:"http"` hooks POSTing the
  ~30-event vocabulary (incl. `PreToolUse`/`PostToolUse`/`InstructionsLoaded`/`FileChanged`) to
  the collector — covering harness-launched *and* external sessions; OTel env blocks
  (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOG_TOOL_DETAILS=1`,
  `OTEL_RESOURCE_ATTRIBUTES=account=<LABEL>`, account-UUID attributes off); the [X4] hook
  automation wiring (`SessionEnd`/`PreCompact`/`SessionStart`) that BE-7 handles; hook installer
  + idempotent upgrade script.
- Sources: [session-substrate-tiebreak](../findings/session-substrate-tiebreak.md),
  [observability](../findings/observability.md), blueprint §2/§5/§6.1.

### SI-4 · AWS IaC: inference profile + read-only telemetry IAM — lane SI-C · M3 · size S · **HARD-GATED**

- **Owns:** `infra/aws/`.
- **Builds:** IaC for the **application inference profile** used for Bedrock cost attribution —
  config key containing `claude`, explicit cost block (else client-side cost reads 0);
  system-profile ARNs avoided (region-prefix mangling); read-only IAM for the Cost Explorer and
  CloudWatch pollers. All identifiers as variables; `AWS_DEV_ACCOUNT_ID` never literal in the
  tree. **`terraform plan` is shown, then STOP — apply only on the owner's explicit verbal OK**
  (External System Write Policy). Until applied, BE-5 runs in estimate-only mode with an honest
  freshness state.
- Sources: [opencode-serve-event-probe](../findings/opencode-serve-event-probe.md), blueprint §4.2/§13.6.

### SI-5 · Colima/k3s demotion & LM Studio guarantees ([X3]) — lane SI-C · any time after M0 · size S · **GATED**

- **Owns:** `infra/colima/`.
- **Builds:** the right-size change (8 CPU/24 GiB → ~4 CPU/8–12 GiB; brief downtime — owner OK
  required), deletion of the dormant 16 GiB x86_64 profile, colima/lima **version pins**
  (0.10.1 / 2.1.1 verified baseline), the pod→host loopback probe script
  (`host.lima.internal` → 127.0.0.1-bound host service) and the runbook making that probe a
  mandatory gate on every colima/lima upgrade; optional Grafana/Prometheus adjunct wiring
  (secondary consumer of the host-native OTLP receiver — candidate for later retirement);
  documentation that the 0.0.0.0 LM Studio rebind + token auth + firewall is strictly fallback.
  **k3s is never a dependency of session launch or LM Studio access** — the harness core never
  imports anything from this package.
- Sources: [x3-virtualization-colima-k3s](../findings/x3-virtualization-colima-k3s.md), blueprint §9.

### SI-6 · CI expansion & live-check runner — lane SI-A · M2 onward · size M

- **Owns:** `.github/workflows/` evolutions, `infra/ci/`.
- **Builds:** unit/component CI on Linux runners where possible (SQLite + fakes are
  platform-neutral), macOS CI job only for build + platform-touching units; the **live-check
  runner** — a scripted local suite for everything only testable on the real Mac (keychain,
  Aqua launchd, real `claude` binary, LM Studio) invoked as a milestone gate, never in hosted
  CI; artifact build of the Tauri app; sidecar signing dry-run automation (spike ix follow-on);
  weekly TruffleHog schedule; branch protection configuration for `main`.

**SI lane map:** SI-A → SI-1, SI-6 · SI-B → SI-2, SI-3 · SI-C → SI-4, SI-5.

---

## 7. Cross-cutting requirement packages — explicit [X1]–[X4] mapping

| Req | Decision implemented (verbatim from blueprint) | Work packages | Acceptance proof |
|---|---|---|---|
| **[X1]** parallel per-account sessions | Per-account `CLAUDE_CONFIG_DIR` + pinned `CLAUDE_SECURESTORAGE_CONFIG_DIR`; fallback ladder rungs 2–4 documented, rung-2 canary-gated; one account = one live credential store; never `--bare`; env scrub; byte-stable paths; version gate on every SDK bump | **SI-2** (provisioning, probes, version gate, ladder runbook) + **BE-1** (spawn-layer env injection/scrub, concurrent sessions) + **BE-2** (login bootstrap) + **BE-9** (sacrifice order — accounts never the victim) | M1 demo: three concurrent sessions, one per account, one broker process, zero re-login; keychain shows three distinct suffixed items; scrub + `--bare` refusal covered by tests |
| **[X2]** public-repo secret hygiene | Keychain-primary runtime secrets; env-interpolated committed config with `secret`/`identifier` schema tags; two-tier gitleaks (+ `--redact`); CI backstop; SOPS deferred; identity mapped to labels at ingest; fixtures synthesized | **SI-1** (hygiene commit, scanners, CI) + **SI-6** (CI evolution) + `packages/shared` redaction utils + guards inside **BE-4/BE-5** (no credential-table reads, no env serialization) + review rule in §1.1 | M0: amended history force-pushed; gate proven by three seeded failures; ongoing: automated audit query shows zero raw identifiers in any committed file or stored row |
| **[X3]** virtualization verdict (PARTIAL) | Harness core fully host-native — LM Studio 127.0.0.1 reachability guaranteed by construction; k3s kept but demoted to optional telemetry adjunct, VM shrunk; colima/lima pinned with the pod→host probe gating upgrades; k3s never a launch dependency | **SI-5** (right-size, pins, probe, adjunct) + **BE-4** (host-native LM Studio adapter, down-as-state) + a standing architectural test that `core/` has no k8s/colima imports | LM Studio reachable with Colima stopped (integration test); probe script green on pinned versions; VM resized after owner OK |
| **[X4]** workstreams | Harness-owned SQLite lineage ledger; typed edges at action time; continuation = child; merge = synthesized brief with N `merge_parent` edges; reconciler for external sessions; hook-automated briefs replace manual handoff docs; native stores never mutated | **BE-7** (ledger, briefs, reconciler, guardrails) + **SI-3** (hook wiring) + **FE-6** (lineage UI, merge flow) + **BE-2/BE-8** (edge emission from recycle and workflow steps) | M4 demo: branch→continue→merge lifecycle across two accounts with auto-briefs and correct DAG; external session appears as inferred orphan; zero writes to native stores under fs-audit |

---

## 8. Dependency order, integration milestones, definition of done

### 8.1 Order of operations (honors blueprint §13)

```
M0 ──► M1 ──► M2 ──► M3 ──► M4 ──► M5 ──► M6
 │      │      │      │
 │      │      │      └─ SI-4 AWS IaC (gated) feeds M3's "actual USD"; estimate-mode otherwise
 │      │      └─ FE-3/FE-2 join once DESIGN.md locked (M0) and protocol frozen (M1)
 │      └─ SI-2 accounts must precede BE-1's live proof
 └─ SI-1 hygiene commit is SERIAL-FIRST; spikes fan out after scaffold
SI-5 (Colima right-size) may run any time after M0, gated on owner OK
```

Parallelization per milestone (the 2–4-agents-per-department shape): M0 runs 1 SI agent serial
then fans to ~3 FE + 2 BE + 2 SI on spikes/scaffold; M1 runs BE-A + BE-B(prep) + SI-B + FE-A;
M2–M5 run all four BE lanes, all four FE lanes, and 2–3 SI lanes concurrently — ownership
boundaries in §4–§6 guarantee zero file conflicts throughout.

### 8.2 Milestones and definition of done

**M0 — Clean slate & risk burn-down** (blueprint §13.1–2, §13.5)
Deliverables: SI-1 complete; monorepo scaffold with the four `packages/*` stubs; FE-1 DESIGN.md
locked; all ten spikes executed from `spikes/` with verdict docs in `docs/spikes/`:
(i) xterm 6 WebGL in WKWebView on macOS 26.6 → picks FE-3 renderer path; (ii) Pixi v8 5k-node
soak in a Tauri window; (iii) worker layout round-trip latency; (iv) `navigator.gpu` probe in
WKWebView; (v) react-virtual mid-stream resize; (vi) 6-PTY flow-control soak with the real
claude TUI; (vii) broker-SIGKILL orphan/resume fidelity; (viii) `ant` profile Max-subscription
experiment; (ix) sidecar signing dry run; (x) Bun.Terminal parity check.
**DoD:** amended commit force-pushed and verified (`git log` clean of work-domain email); GitHub
privacy/push-protection settings confirmed; gitleaks gate proven by three seeded failures then
cleaned; CI green on the scaffold; DESIGN.md merged with the token-lint demonstrably failing an
off-token color; ten spike verdicts recorded, each naming the go/fallback consequence; findings
doc-hygiene annotations (§13.7) merged; research docs committed on the new SHA.

**M1 — [X1] proven: three accounts, one broker**
Deliverables: SI-2; BE-1; `packages/protocol` core + `packages/schema` kernel tables frozen;
BE-3 skeleton (control channel only) sufficient to drive a scripted demo.
**DoD:** live-host demo — one broker process runs three concurrent SDK sessions (one per
account), each completes, zero re-login; keychain probe shows three distinct per-config-dir
service names; env-scrub, `--bare` refusal, row-before-spawn, and double-resume block all
unit-tested; SIGKILL orphan probe (vii) re-run against the real kernel passes; version-gate
script documented in `docs/runbooks/` and wired as a required step for SDK bumps.

**M2 — Attended cockpit (features 2 & 3 v0)**
Deliverables: BE-2, BE-3 full, BE-4 (OpenCode + LM Studio adapters minimum viable); FE-2, FE-3;
FE-5 launcher slice; SI-3 (hooks installed, launchd templates validated); SI-6 CI expansion;
`docs/contracts/ws-protocol.md` + `bootstrap-file.md` + `hooks-contract.md` frozen.
**DoD:** Tauri app boots, discovers the broker via bootstrap file, opens an attended TUI per
account in the xterm island; login bootstrap of a fresh profile works end-to-end; one-off prompt
launched against a **specified** account streams into the transcript island; skill launch via
`/skill-name` works; permission relay lands in the approval inbox (hooks floor + `canUseTool`);
6-PTY soak passes with flow control engaged (bounded memory, no dropped bytes); typing echo
p95 <100 ms locally; detach/reattach restores scrollback.

**M3 — Instruments live (feature 1)**
Deliverables: BE-5, BE-6; FE-5 dashboards; SI-4 plan shown (apply if OK'd); estimate-mode
fallback wired.
**DoD:** all Claude sources (JSONL, statusline quota, OTLP) ingesting per account; OpenCode SSE
deduped on `evt_` ids with gap-repair proven by induced disconnect; `opencode.db` scrape
reconciles to identical ids; quota gauges show live `five_hour`/`seven_day` with reset
countdowns; burn-rate projection renders; Bedrock USD shows actuals (if SI-4 applied) or an
honestly-labeled estimate with freshness state; cache-TTL split visible; automated audit proves
zero identity-bearing rows in the store; every degraded source renders NO SIGNAL, not an error;
`{stream:'context-graph'}` envelopes observable on the wire.

**M4 — Lineage ([X4] + feature 6)**
Deliverables: BE-7; FE-4 live-wired; FE-6 workstream slice; SI-3 brief-automation hooks active.
**DoD:** every kernel launch/resume/fork/recycle records its typed edge at action time; an
externally-launched session appears as an inferred-confidence orphan within one reconciler
cycle; `SessionEnd` auto-brief, `PreCompact` snapshot + `compact` edge, and `SessionStart`
brief injection all fire in a live session; merge flow produces one node with N `merge_parent`
edges seeded by a conflict-surfacing brief; context graph populates **live** during an active
session as files are referenced, with layers/cluster-dim and the reduced-motion path both
working; 5k-node soak still meets the M0 spike's fps floor; fs-audit shows zero writes to
native stores.

**M5 — Pipelines (features 4 & 5)**
Deliverables: BE-8; FE-6 builder slice; `docs/contracts/dag-schema.md` frozen at v1.
**DoD:** catalog scanner passes the fixture-tree suite (precedence, walk-up, malformed-YAML
survival, unknown-key preservation) and lists OpenCode capabilities API-first; demo pipeline
runs 3 steps across MAX_A → AWS_DEV (OpenCode/Bedrock) → LOCAL (LM Studio) with an approval
gate in the middle, paused and resumed from the inbox; broker restart mid-run resumes from the
memoization journal without re-executing completed steps; every step visible as a `session_node`
with `workflow` edges; per-step cost visible in the run monitor from the events store; budget
breach aborts the step with process-group reaping (no orphan children).

**M6 — Hardened v0 ship**
Deliverables: BE-9; packaging; full integration suites; runbooks.
**DoD:** watchdog thresholds active and tested by induced bloat (fake-process harness) and one
real recycle with lineage continuity; amber/red responses verified with the sacrifice order —
account sessions never shed, account spawns honored post-shedding; 24 h mixed soak (3 account
sessions + 2 OpenCode + local model JIT) stays within the ~17 GB pessimistic envelope
(blueprint §11) with no unsupervised growth; all §9.4 integration suites green at the gate;
signed (dry-run) Tauri v0 sidecar build launches on a clean macOS user account; LaunchAgent-v1
plist validated Aqua-side but not flipped; operator runbooks complete (login bootstrap, version
gate, recovery, quota-exhaustion playbook).

---

## 9. Testing strategy

### 9.1 Test tiers

| Tier | Runs | Scope |
|---|---|---|
| T1 unit | every commit, Linux CI | pure logic against fakes from `packages/testkit`; the positive/negative/edge bar below |
| T2 component | every commit, Linux CI (macOS job where platform-bound) | one module + real SQLite + fake external servers (mock SSE, fake OTLP, fixture JSONL trees) |
| T3 live-host | milestone gates, local via SI-6 live-check runner | real keychain, real `claude` binary, real launchd, real LM Studio/OpenCode — everything hosted CI cannot see |
| T4 soak/perf | M2, M4, M6 gates | 6-PTY flow control, 5k-node graph fps, 24 h resource soak |

**Fixture policy [X2]:** all fixtures are synthesized by `packages/testkit` generators — never
copied from real transcripts; fixture identities use MAX_A/MAX_B/ENT/AWS_DEV_ACCOUNT_ID and
obviously-fake tokens that the gitleaks allowlist explicitly names.

### 9.2 Unit testing per department — positive / negative / edge

Every work package must land tests in all three columns for each behavior it owns; orchestrators
reject diffs missing a column. Representative matrix (the bar, not the ceiling):

**Backend**

| Package | Positive | Negative | Edge |
|---|---|---|---|
| BE-1 kernel | spawn env contains the account's config + securestorage dirs; scrub removes `ANTHROPIC_*`/`CLAUDE_CODE_USE_*`; ledger row precedes spawn | unknown account label rejected; `--bare` refused; token-mixing refused; double-resume of a running session blocked without fork | non-NFC path input normalized once, byte-stable thereafter; spawn raced with shutdown; resume against truncated transcript → validator forks from last coherent message |
| BE-2 pty | TUI bytes stream to channel; resize propagates; login bootstrap reaches keychain-write state (T3) | semantic parsing of PTY bytes is absent by construction (architectural test: no parser imports) | detach/reattach mid-output; recycle during active tool call → checkpoint then continuation edge |
| BE-3 gateway | channel mux routes; ack watermark advances; bootstrap file readable | bad auth token rejected; unknown channel rejected; oversized frame rejected | slow consumer → bounded buffer + backpressure, no OOM; reconnect replays from watermark exactly-once |
| BE-4 adapters | serve supervised with random port/password; Bedrock env injected from Keychain fetch at spawn; LM Studio JIT load + TTL evict verified via API | credentials never written to disk (fs-audit test); `account`/`credential` tables unreadable (guard test); desktop-app process never matched (argv test) | serve GC sawtooth ignored, sustained RSS trips; LM Studio down mid-request → down-state not error; TTL shortened under amber |
| BE-5 collector | JSONL line → events row with four token classes + cache-TTL split; statusline JSON → quota snapshot; `evt_` dedupe; OTel account attribution | malformed JSONL line skipped, tail continues; identity attrs dropped at ingest (audit assertion); unknown SSE event ignored silently | file rotation/truncation mid-tail; duplicate (backend, raw_ref) upsert; SSE gap → `after=<seq>` replay heals exactly; Cost Explorer backfill overwrites estimate not raw |
| BE-6 read models | burn-rate math matches ccusage block fixtures; freshness transitions correct | missing source → NO SIGNAL state, never fabricated zeros | reset boundary crossing mid-query; leaderboard with sparse data flags nothing |
| BE-7 workstreams | continue edge = child; merge node with N parents; brief generated on SessionEnd | sibling-continuation rejected; edge to missing node rejected; native-store write path absent (architectural test) | reconciler orphan for external session; `/cd` moves native scope without breaking lineage; 30-day cleanup → `unresumable` flag; compaction summary reused when present, local draft otherwise |
| BE-8 pipelines | topological run honoring `needs`; memoization skip on same input_hash; approval pause/resume; per-step account env | cycle detected at plan time; unresolved capability ref fails plan; budget breach aborts; output failing `outputSchema` handled per retry policy | `forEach` + `maxParallel` bounds; broker restart mid-run resumes from journal; contentHash drift between plan and run detected and surfaced |
| BE-9 supervision | warn/recycle at documented thresholds (fake phys_footprint feed); pressure deltas drive amber/red | account session never selected as victim (property test over shed decisions); naive-free-RAM inputs rejected by design | threshold flapping hysteresis; red-state account spawn still honored after shedding; hibernation never auto-applied to account sessions |

**Frontend** (unit = vitest + jsdom where possible; islands get headless-browser component tests)

| Package | Positive | Negative | Edge |
|---|---|---|---|
| FE-1 theme | tokens compile to the Tailwind theme; lint passes on-token styles | lint fails off-token color/radius/shadow (three seeded violations) | reduced-motion media query maps every animated token to its static variant |
| FE-2 chrome/WS | envelope round-trip against protocol goldens; store projections batch per rAF; inbox renders all three approval sources | malformed envelope dropped + logged, session unaffected; unauthenticated connect fails visibly | reconnect rehydrates from watermark without duplicate rows; per-token state updates provably absent (render-count assertion under a streaming fixture) |
| FE-3 terminal/transcript | echo renders; serialize reattach restores scrollback; end-anchor holds during stream | WebGL context lost → DOM fallback without data loss | mid-stream resize keeps anchor; scroll-up releases anchor, "jump to live" returns; 10k-line transcript virtualization memory-flat |
| FE-4 graph | node/edge mutations coalesce per rAF/150 ms; new node spawns at referrer; layer toggle + cluster-dim | worker crash → renderer degrades to settled layout, no white screen | 5k-node soak ≥ spike fps floor; reheat stays gentle (alphaTarget bound asserted); reduced-motion path skips fly-to |
| FE-5 launch/dashboards | account picker offers exactly the five labels; gauges match store fixtures numerically | ENT-restricted feature hidden when feature-detect says so; no dashboard ever shows a raw identifier (audit render test) | quota at 100% with resets_at in the past; conflicting estimate-vs-actual rendered as overlay not sum |
| FE-6 workstreams/pipelines | lineage renders branch/continue/merge fixtures correctly; builder emits schema-valid DAG JSON | invalid DAG (cycle, missing account) blocked client-side with the server as authority | merge preview with conflicting briefs surfaces conflicts; run monitor across a resume boundary shows memoized steps as cached |

**Server-side** (unit = bats/shell-test + terraform validate/plan assertions + plist lints)

| Package | Positive | Negative | Edge |
|---|---|---|---|
| SI-1 hygiene | placeholders pass the gate; CI workflow syntax valid | the three seeded leak classes each fail pre-commit AND CI | Tier-2 config absent → hook fails **closed** with instructions; allowlisted placeholder near a real-looking pattern still passes |
| SI-2 accounts | probe recomputes expected service names; `auth status --json` parses per account (T3) | probe never uses `-w` (static check); provisioning refuses to overwrite an existing populated config dir | non-NFC path input; hash suffix mismatch after simulated SDK bump → version gate blocks |
| SI-3 launchd/hooks | plists lint; Aqua session type asserted; hook templates install idempotently | Background/user-domain plist variant fails keychain value read (T3, expected-failure test) | KeepAlive restart-on-crash observed (T3); hook re-install preserves unrelated user settings |
| SI-4 aws | plan renders profile with cost block + `claude`-containing key; IAM is read-only | literal 12-digit ID anywhere in `infra/aws/` fails gitleaks; apply absent from CI by construction | plan against missing SSO session → clear failure, no partial state |
| SI-5 colima | probe green on pinned versions (T3) | harness core imports nothing from `infra/` (architectural test) | probe run with cluster stopped → LM Studio adapter unaffected (proves non-dependency) |

### 9.3 Cross-department integration tests

Executed at every milestone gate from M2 onward (earlier where inputs exist). All live-host
suites run via SI-6's runner; identifiers in outputs are redacted by `packages/shared` filters.

**Backend ↔ Server-side (BE↔SI)**
1. Broker launched via SI-3's Aqua LaunchAgent plist reads keychain values for all three
   accounts (`auth status --json`); the Background-domain variant fails as documented (T3).
2. BE-1 spawn using SI-2-provisioned dirs yields the expected per-config-dir keychain service
   names; version-gate script detects a simulated service-name drift and blocks.
3. A real session launched with SI-3 hook templates produces statusline quota files and http-hook
   POSTs that BE-5 ingests into `quota_snapshots`/`events` (T3).
4. SI-3 OTel env → BE-5's OTLP receiver rows carry `account=<LABEL>` attribution.
5. LM Studio via SI's `lms` LaunchAgent: up → BE-4 healthy; stopped → down-state; **Colima
   stopped entirely → LM Studio path unaffected** ([X3] non-dependency proof).
6. SI-4-applied inference profile ARN (post-gate) → OpenCode step cost lands non-zero
   client-side and reconciles with Cost Explorer backfill within the documented lag.
7. Seeded-canary branch proves gitleaks CI blocks agent-authored leaks (fake literals only).

**Server-side ↔ Frontend (SI↔FE)**
1. Tauri app cold-start boots the sidecar and discovers port/token via the bootstrap-file
   contract on a clean user account (T3; validates SI packaging + FE-2 discovery).
2. Login-bootstrap UX: fresh SI-2 profile → attended PTY login in the xterm island → account
   panel flips to authenticated (T3, semi-manual).
3. DESIGN.md → theme build chain: token change propagates to the built app; off-token style
   fails CI before reaching the app.
4. Freshness surfaces: LM Studio down / cluster absent / SSO expired each render the NO SIGNAL
   instrument with the correct one-click remediation, never an error toast.
5. Signing dry-run artifact (SI-6) launches and passes the cold-start test above.

**Backend ↔ Frontend (BE↔FE)** — the WS contract boundary
1. Golden protocol fixtures from `packages/testkit` replayed against both the FE client and BE
   gateway (contract tests run in both departments' CI; a fixture change requires both
   orchestrators' sign-off).
2. PTY round-trip: keystroke → echo p95 <100 ms locally; 6-PTY soak with one deliberately slow
   consumer — flow control bounds memory, no interleaving corruption.
3. Dashboard truth: golden SQLite store → read models → rendered gauges equal SQL-computed
   values exactly.
4. Approval round-trip: `canUseTool` escalation → inbox → decision → session proceeds; workflow
   `approval` gate pause/resume via the same inbox.
5. Reconnect: kill the WS mid-stream → FE resumes from watermarks with no duplicated or lost
   transcript rows; context-graph island converges to identical graph state after replay.

### 9.4 What is deliberately not CI-automated

Keychain semantics, Aqua/Background launchd behavior, real `claude` login, LM Studio GPU loads,
Colima probes — all T3 live-host, run at milestone gates and after any SDK/colima/macOS
upgrade (the version-gate and upgrade-gate runbooks make these mandatory, not best-effort).

---

## 10. Risks and escalation triggers

| Risk | Watch | Trigger → response |
|---|---|---|
| xterm 6 WebGL broken in WKWebView (top spike) | M0 spike i | Ship DOM renderer; if throughput unacceptable, escalate to Chrome-as-frontend (free second frontend, blueprint §2) — never rebuild on canvas |
| Keychain scoping changes in an SDK bump | SI-2 version gate | Gate blocks; hold the pinned SDK; consult [X1] fallback ladder rung 2 |
| Statusline `rate_limits` feed changes shape | BE-5 contract test on synthetic + live sample | Fall back to idle-endpoint polling with degraded freshness; file ADR |
| OpenCode v2 event surface lands | thin envelope adapter (BE-5) | Flip transport behind the adapter; `evt_` dedupe contract retained |
| Credit-pool split returns | per-account accounting built day one (BE-5) | Dashboards already per-account; no schema change expected |
| Resource envelope busted in M6 soak | BE-9 telemetry | Enforce sacrifice order; shrink local model tier; re-run; if still busted, cut non-Claude concurrency defaults — account sessions are never the victim |

---

## 11. Traceability

| Product feature / requirement | Packages | Findings depth |
|---|---|---|
| 1 · Usage/cost observability | BE-5, BE-6, FE-5, SI-4 | [observability](../findings/observability.md), [opencode-serve-event-probe](../findings/opencode-serve-event-probe.md) |
| 2 · One-off prompt vs specified account | BE-1, BE-3, FE-5 | [harness-architecture](../findings/harness-architecture.md) |
| 3 · Skills from a specified account | BE-1, BE-8 (catalog), FE-5 | [pipeline-workflow-builder](../findings/pipeline-workflow-builder.md) |
| 4 · Multi-agent workflows w/ account or Bedrock routing | BE-8, BE-4, FE-6 | [pipeline-workflow-builder](../findings/pipeline-workflow-builder.md) |
| 5 · Workspace-scoped pipeline builder + scanning | BE-8, FE-6 | [pipeline-workflow-builder](../findings/pipeline-workflow-builder.md) |
| 6 · Live context graph | BE-6, FE-4 | [ui-motion-3d-context-graph](../findings/ui-motion-3d-context-graph.md) |
| [X1] | SI-2, BE-1, BE-2, BE-9 | [x1-parallel-multi-account](../findings/x1-parallel-multi-account.md) |
| [X2] | SI-1, SI-6, shared redaction, BE-4/BE-5 guards | [x2-secret-hygiene](../findings/x2-secret-hygiene.md) |
| [X3] | SI-5, BE-4 | [x3-virtualization-colima-k3s](../findings/x3-virtualization-colima-k3s.md) |
| [X4] | BE-7, SI-3, FE-6, BE-2/BE-8 | [x4-workstreams](../findings/x4-workstreams.md) |
| Substrate & broker | BE-1…BE-3, SI-3 | [session-substrate-tiebreak](../findings/session-substrate-tiebreak.md) |
| Shell/framework/design | FE-1…FE-4 | [frontend-app-shell-stack](../findings/frontend-app-shell-stack.md), [frontend-stack-coherence](../findings/frontend-stack-coherence.md), [ui-anti-slop-design](../findings/ui-anti-slop-design.md) |
| Resources & supervision | BE-9 | [local-resource-feasibility](../findings/local-resource-feasibility.md) |

**First action, restated for the record:** nothing in this plan starts until SI-1 step 1 — the
author-email amend + force-push of commit `62d11d0` — is executed on the owner's go-ahead.
Nothing builds on the old SHA.
