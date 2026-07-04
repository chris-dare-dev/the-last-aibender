# Architecture blueprint — the-last-aibender

> The opinionated, consolidated architecture for Stage 2. This document is **normative**: Stage 2
> implements exactly what is written here. Where findings documents disagreed, the resolution and
> its rationale are recorded in §12 (contradiction ledger); the overridden text in those docs is
> superseded by this blueprint.
> Companion: [00-executive-summary.md](00-executive-summary.md).
> Account identifiers are placeholders only — **MAX_A**, **MAX_B**, **ENT**, **AWS_DEV_ACCOUNT_ID**
> — per [X2 policy](../findings/x2-secret-hygiene.md). Consolidated: 2026-07-03.

---

## 1. Decisions at a glance

| Axis | Decision | Source of record |
|---|---|---|
| Execution engine | TypeScript Agent SDK `query()` under one broker daemon; node-pty for attended TUIs only; **no tmux in v1** | [session-substrate-tiebreak](../findings/session-substrate-tiebreak.md) |
| Broker placement | Host-native, **gui-domain (Aqua) LaunchAgent** in v1; Tauri sidecar in v0; never Background/user-domain | [session-substrate-tiebreak](../findings/session-substrate-tiebreak.md) |
| [X1] mechanism | Per-account `CLAUDE_CONFIG_DIR` + pinned `CLAUDE_SECURESTORAGE_CONFIG_DIR`; setup-token as rung-2 fallback | [x1-parallel-multi-account](../findings/x1-parallel-multi-account.md) |
| [X2] stack | Keychain-primary runtime secrets; two-tier gitleaks; CI backstop; **SOPS deferred** | [x2-secret-hygiene](../findings/x2-secret-hygiene.md) |
| [X3] verdict | **PARTIAL**: harness core host-native; existing k3s-in-Colima kept but demoted + shrunk; never a dependency | [x3-virtualization-colima-k3s](../findings/x3-virtualization-colima-k3s.md) |
| [X4] model | Harness-owned SQLite lineage ledger; typed edges recorded at action time; merge = brief synthesis | [x4-workstreams](../findings/x4-workstreams.md) |
| Observability | Subscribe (OTLP + SSE) / scrape (JSONL + SQLite) / poll (AWS + idle quota) → one SQLite events store | [observability](../findings/observability.md), [opencode-serve-event-probe](../findings/opencode-serve-event-probe.md) |
| Workflow engine | Harness-owned declarative JSON DAG; native dynamic workflows = interop target only | [pipeline-workflow-builder](../findings/pipeline-workflow-builder.md) |
| Shell / core | Tauri v2 shell over a shell-agnostic localhost TypeScript daemon (Node 22), one multiplexed WebSocket | [frontend-app-shell-stack](../findings/frontend-app-shell-stack.md) |
| Framework / graph | React 19.2 + zustand 5 + Compiler; graphology + d3-force worker + PixiJS v8 (WebGL2); Motion 12 | [frontend-stack-coherence](../findings/frontend-stack-coherence.md) |
| Design system | "Instrument Grade" token lock (DESIGN.md) with FORBIDDEN list, before any UI code | [ui-anti-slop-design](../findings/ui-anti-slop-design.md) |
| Resource policy | Watchdog→checkpoint→kill→resume supervision; JIT+TTL local model; [X1] sacrifice order encoded | [local-resource-feasibility](../findings/local-resource-feasibility.md) |

---

## 2. System topology

Everything hard lives in one host-native **broker daemon** ("aibender-core", TypeScript on
Node 22 LTS); every UI is a thin veneer over it
([app-shell findings](../findings/frontend-app-shell-stack.md)).

```
┌──────────────────────────────── macOS (host-native) ────────────────────────────────┐
│  Tauri v2 app — tray, notifications, windows, WKWebView SPA                         │
│      │ WebSocket ws://127.0.0.1:<port>  (binary PTY frames + JSON event envelope)   │
│      ▼                                                                              │
│  aibender-core (gui-domain Aqua LaunchAgent; Tauri sidecar in v0)                   │
│   ├─ session broker: Agent SDK query() per session, per-account env injection       │
│   ├─ ptyHost: node-pty running the SDK-bundled claude binary (attended TUIs, login) │
│   ├─ collector: OTLP receiver (127.0.0.1:4318) · JSONL fs-watch · statusline quota  │
│   │              · OpenCode /global/event SSE · opencode.db read-only · AWS polls    │
│   ├─ workflow engine: DAG walker + step journal + approval gates                    │
│   ├─ ledgers: SQLite (events · workstreams · resume ledger · workflow runs · prices)│
│   ├─ adapters: OpenCode (supervised `opencode serve`) · LM Studio (health + lms)    │
│   └─ catalog scanner: .claude/* + plugins + workflows + OpenCode /agent /command    │
└──────────────────────────────────────────────────────────────────────────────────────┘
   (optional, degradable) k3s-in-Colima aux plane: Grafana/Prometheus dashboards only
```

Rules of the topology:

- **The frontend never talks to Claude/OpenCode/LM Studio directly** — one multiplexed WebSocket,
  logical channels per stream, ack-based watermark flow control for PTY bytes
  ([app-shell](../findings/frontend-app-shell-stack.md)). Tauri IPC is used only for native
  affordances (tray, notifications, windows).
- **The broker must live in the Aqua session.** Verified live: gui-domain LaunchAgents have full
  login-keychain value access; Background/user-domain agents fail with
  `errSecInteractionNotAllowed` ([tie-break](../findings/session-substrate-tiebreak.md)). The
  plist ships with default (Aqua) session type and `KeepAlive={SuccessfulExit:false}`.
- **One spawner.** A single spawn layer owns env injection (config dir, securestorage dir,
  provider-env scrub, OTel vars) and chooses SDK-child vs node-pty-child; both execute the **same
  pinned SDK-bundled darwin-arm64 binary** — the one binary the harness ever spawns, upgraded only
  by deliberate SDK bumps ([tie-break](../findings/session-substrate-tiebreak.md)).
- Chrome is a free second frontend (same SPA on localhost) whenever WebGPU or devtools are wanted;
  Electron remains a pre-paid shell swap ([app-shell](../findings/frontend-app-shell-stack.md)).

---

## 3. [X1] Multi-account mechanism

Source of record: [x1-parallel-multi-account](../findings/x1-parallel-multi-account.md), confirmed
by [x3](../findings/x3-virtualization-colima-k3s.md) and
[harness-architecture](../findings/harness-architecture.md).

**Mechanism.** Each of MAX_A / MAX_B / ENT gets its own `CLAUDE_CONFIG_DIR` (machine-local paths,
never in the repo) with `CLAUDE_SECURESTORAGE_CONFIG_DIR` pinned to the same per-account path. On
macOS this yields a distinct keychain item per account (service name = base + first 8 hex of
sha256 of the NFC-normalized dir path — verified in the shipping binary and by a live suffixed
entry on this machine). One interactive `claude /login` per account, ever; thereafter every
session of every account runs concurrently with zero re-login. The SDK makes this per-*session*:
env is injected per `query()` call, so one broker process runs all three accounts at once.

**Fallback ladder** (each rung is the fallback of the one above):

| Rung | Mechanism | When |
|---|---|---|
| 1 | Per-account config dir + pinned securestorage dir | All host sessions, default |
| 2 | Rung 1 + `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` per process | Non-Aqua contexts (SSH, headless boot, Background helpers), >5-way same-account bursts |
| 3 | Linux container per account, volume-persisted `.credentials.json` | Scale-out only; gated on the LM Studio reachability probe ([X3]) |
| 4 | Separate macOS user accounts | Break-glass |
| watch | `ant` CLI profiles / `ANTHROPIC_PROFILE` | Promote to rung 1 if Max-subscription support is confirmed (Stage-2 experiment) |

**Non-negotiable operating rules** (from the findings, adopted verbatim):

1. One account ↔ exactly one live credential store per host; never copy or hot-swap tokens.
2. Byte-stable absolute `CLAUDE_CONFIG_DIR` strings on every launch (the hash is over the raw string).
3. Env hygiene per spawn: strip `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE`,
   `CLAUDE_CODE_USE_*` so precedence cannot hijack account selection.
4. Version-gate every Claude Code (SDK) upgrade: recompute expected keychain service names, probe
   presence (never `-w`), then prove value access **in the broker's own context** via
   `claude auth status --json` per account; run the setup-token keychain-deletion canary
   (issue #37512 class) before enabling rung 2.
5. Setup-tokens live in harness-owned Keychain items, always paired with that account's own
   config/securestorage dirs; yearly rotation reminder surfaced in the UI.
6. ENT is feature-detected at runtime (managed policy may restrict headless use, telemetry,
   workflows, models); the UI degrades per account. Rejected outright: HOME-per-process,
   keychain-swap switchers, tty-as-isolation.

---

## 4. Session-execution architecture per backend

### 4.1 Claude accounts (MAX_A / MAX_B / ENT)

Source of record: [session-substrate-tiebreak](../findings/session-substrate-tiebreak.md)
(reconciling [harness-architecture](../findings/harness-architecture.md),
[app-shell](../findings/frontend-app-shell-stack.md),
[resource feasibility](../findings/local-resource-feasibility.md)).

| Session kind | Substrate | Notes |
|---|---|---|
| Interactive attended | Real `claude` TUI in daemon-owned **node-pty**, rendered in xterm.js | PTY carries pixels only; also the login-bootstrap path |
| Headless one-off prompt (feature 2) | **SDK `query()`** | `/skill-name args` in the prompt triggers skills (feature 3); persistence ON by default for lineage |
| Multi-agent workflow step (feature 4/5) | **SDK `query()`** with resume/forkSession | Per-step account env; fork edges recorded by construction |
| Long-running background agent | **SDK `query()`** streaming-input mode | Recycle loop; async permission escalation via tray |

- **Semantics never come from PTY bytes.** Events flow from: (a) the SDK message stream (text
  deltas, result cost/usage); (b) per-account `type:"http"` hooks POSTing to the collector
  (~30 events incl. `PreToolUse`/`PostToolUse`/`InstructionsLoaded`/`FileChanged` — the context
  graph feed, covering harness-launched *and* external sessions); (c) OTel OTLP (skill/agent cost
  attribution); (d) JSONL transcript tailing (history + externally-launched coverage)
  ([harness-architecture](../findings/harness-architecture.md)).
- **Permission relay is two-layer**: account-wide http hooks (`PermissionRequest`/`PreToolUse`
  with `permissionDecision`) as the policy floor for all sessions; `canUseTool` as the in-loop
  interactive relay for SDK sessions; native TUI dialogs for attended PTYs. One approval inbox in
  the UI ([tie-break](../findings/session-substrate-tiebreak.md)).
- **Resume ledger is core infrastructure**: a SQLite row is written *before* every spawn
  (workstream, account, cwd, substrate, purpose; session id backfilled from the init message).
  Before any resume, a transcript-tail validator repairs or forks from the last coherent message
  (mitigates the known mid-tool-call resume failures). Recycle = resume (same node) or
  resume+forkSession (explicit continuation child).
- **Never `--bare`** on subscription profiles (it disables OAuth); never mix
  `CLAUDE_CODE_OAUTH_TOKEN` with OAuth-file mode in one config dir
  ([x1](../findings/x1-parallel-multi-account.md)).

### 4.2 OpenCode → Bedrock (AWS_DEV_ACCOUNT_ID)

Source of record: [opencode-serve-event-probe](../findings/opencode-serve-event-probe.md),
[harness-architecture](../findings/harness-architecture.md).

- The broker supervises one **`opencode serve`** (127.0.0.1, random port, per-boot random
  `OPENCODE_SERVER_PASSWORD`, HTTP Basic). Bedrock env (SSO profile, Keychain-fetched key —
  replicating the owner's existing shell function) is injected into the spawned server's process
  env, never persisted to disk.
- Drive via `@opencode-ai/sdk`. Sessions are created with `parentID` where lineage applies
  ([X4]); per-session model selection at create time.
- **Live events: subscribe `/global/event`** (one connection covers all directory instances);
  dedupe strictly on the monotonic `evt_` id; drop the duplicate `sync` wrappers after recording
  their seq watermarks; silently ignore unknown event types (the 10 s heartbeat is not even in the
  OpenAPI spec). Gap repair after disconnects via the replayable per-session durable stream
  (`after=<seq>`). Backfill/orphans via read-only `opencode.db` scrape — same ids, exact
  reconciliation. Keep the envelope adapter thin so the transport can flip to the v2 `/api/event`
  surface later.
- **Bedrock cost attribution**: adopt an **application inference-profile ARN** as a custom
  `amazon-bedrock` model — config key must contain `claude` (feature gates key off it) and must
  carry an explicit cost block (else client-side cost reads 0). System-profile ARNs would be
  region-prefix-mangled; avoid. The Keychain/API-key mantle path is attributed via its IAM
  principal. Creating the inference profile is an AWS IaC change and is **hard-gated on an
  explicit go-ahead** (External System Write Policy).
- Watchdog: threshold on **sustained** RSS (>~500 MB for 5 min), not instantaneous peaks — the
  serve process is a Bun GC sawtooth (measured 160–650 MB). Match on argv `serve`, never on
  process name (the desktop app is unrelated).
- [X2]: `opencode.db` contains `account`/`credential` tables — the scraper never selects from them.

### 4.3 LM Studio (local tier)

Source of record: [harness-architecture](../findings/harness-architecture.md),
[resource feasibility](../findings/local-resource-feasibility.md),
[x3](../findings/x3-virtualization-colima-k3s.md).

- Inference via the OpenAI-compatible `/v1`; state and perf (`tokens_per_second`,
  `time_to_first_token`, load state, quantization) via native `/api/v0` (feature-gated — it is
  beta); lifecycle via the `lms` CLI under a LaunchAgent.
- **"Down" is a first-class state** (the server was down during every probe): health-check with a
  short timeout, render a dimmed "NO SIGNAL" instrument (not an error toast —
  [design](../findings/ui-anti-slop-design.md)), offer one-click `lms server start`.
- Binding stays **127.0.0.1**; `--bind 0.0.0.0` + API-token auth + firewall is recorded strictly
  as the fallback if the k3s aux plane ever needs direct access and usernet semantics regress.
- **Residency policy**: JIT load + per-request TTL (1800 s; 900 under amber pressure) + auto-evict;
  default model ≤8B Q4 (MLX preferred) at ctx 16K, parallel 1; 12–14B opt-in only when ≤6 sessions
  are resident; unloads verified via the API (known auto-evict-bypass bugs). One **global**
  "local model resident" budget line across LM Studio *and* Ollama.
- LM Studio is stateless per request, so **the harness is the session store** for local chats —
  making local sessions the most capable lineage citizens and the default target for brief
  drafting ([x4](../findings/x4-workstreams.md)).

---

## 5. [X4] Workstreams data model

Source of record: [x4-workstreams](../findings/x4-workstreams.md) (Option B + Option E slice).

**Entities** (harness SQLite; final DDL in Stage 2):

- `workstream` — id, title, status (active|paused|merged|archived|abandoned), tags.
- `session_node` — harness id (never the native id), workstream ref, `backend`
  (claude_code|opencode|lmstudio), `account` (MAX_A|MAX_B|ENT|AWS_DEV|LOCAL — labels only),
  `native_session_id`, native scope (encoded-cwd / project id — **mutable**, `/cd` moves it),
  cwd/git branch, state, `origin` (harness|reconciled), token/cost snapshots.
- `session_edge` — from→to node, `edge_type` ∈ {continue, fork, merge_parent, compact, sidechain,
  handoff, import, workflow}, optional `brief` ref, `confidence` (recorded|inferred), metadata.
- `brief` — kind (continuation|merge|handoff|compaction_capture), markdown content, source nodes,
  generating model.

**Semantics.** A continuation is a **child** via a `continue` edge (never a sibling); a fork is a
sibling-creating child from the fork point; a **merge is one new node with N `merge_parent`
edges**; `sidechain` maps subagent traffic (`isSidechain` / OpenCode `parent_id`); `handoff` is a
cross-account/cross-backend continue whose brief is mandatory. Workstreams are first-class and
independent of working directory — directory/worktree is a node *attribute*.

**Recording discipline.** Edges are recorded **deterministically at action time** because every
launch/resume/fork/merge flows through the harness launcher adapters. A reconciler (FSEvents on
each account's `projects/**` + `opencode.db` polling) registers externally created sessions as
inferred-confidence orphans ("detached HEAD" bucket) — the same watcher doubles as the context
graph's event bus. Native stores are **never mutated**.

**Merge = synthesis, not concatenation**: per-branch distillates (reuse the native compaction
summary where present — locally observed compressing ~965k→39k tokens; else a local-model draft
refined by a Claude pass) fused into a schema'd merge brief with conflicts surfaced explicitly,
which seeds the merge node.

**Handoff automation** (kills the manual handoff doc): `SessionEnd` → auto continuation brief;
`PreCompact` → full-fidelity snapshot + compact edge; `SessionStart` (resume|clear) → inject the
workstream's latest brief; context-pressure watch proposes "branch now" at ~70%. Cross-account
transcript-copy (MAX_A→MAX_B) ships behind an experimental flag; brief-based handoff is default.

**Guardrails**: block un-forked double-resume of a running session (transcript-corruption mode);
flag `unresumable` nodes (30-day native cleanup, `/cd` moves); the harness raises/monitors
retention for transcripts under active workstreams.

---

## 6. Observability pipeline and metrics schema

Source of record: [observability](../findings/observability.md), refined by
[opencode-serve-event-probe](../findings/opencode-serve-event-probe.md).

### 6.1 Collection matrix

| Source | Mode | Feed |
|---|---|---|
| Claude Code OTel (per account) | Subscribe | OTLP → in-process receiver on 127.0.0.1:4318; `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOG_TOOL_DETAILS=1` (else custom skills show as `custom`), `OTEL_RESOURCE_ATTRIBUTES=account=MAX_A…`; account-UUID attributes off |
| Claude transcripts + insights | Scrape | fs-watch `projects/**/*.jsonl` per config dir (ground-truth tokens incl. 5m/1h cache-TTL split; file-touch feed), `usage-data/{facets,session-meta}`, `history.jsonl` |
| Claude quota | Subscribe + poll | Statusline hook tees stdin JSON (`rate_limits.five_hour`/`seven_day`) to a per-account file; undocumented OAuth usage endpoint polled ≤1/10–15 min **only** for idle accounts, with backoff |
| OpenCode | Subscribe + scrape | `/global/event` SSE (dedupe on `evt_` id) + read-only `opencode.db` (per-message cost/tokens; durable `event` table for replayable per-step cost) |
| Bedrock real USD | Poll | Cost Explorer 1–2×/day (authoritative, ~24 h lag); CloudWatch `AWS/Bedrock` every 5–15 min while active (tokens, TTFT, throttles); application inference profile segregates harness traffic |
| LM Studio | Inline + poll | Record usage + perf stats per harness-routed call; `GET /api/v0/models` as the health poll |
| ENT org analytics | Optional | Admin-key-gated adapter; otherwise ENT is treated locally like a Max account |

### 6.2 Store and schema

One SQLite (WAL) database owned by the collector — no ClickHouse, no Prometheus server
([X3 resource stance](../findings/local-resource-feasibility.md)). Fact table `events`
(ts, backend, account, session/workstream/prompt ids, event_type, model/provider, four token
classes + reasoning, `cost_estimated_usd` vs `cost_actual_usd` (Cost Explorer backfill), latency
+ TTFT, tool/skill/agent/mcp attribution, success/error fields, `file_refs`, `raw_ref` back to
the source line/row). Companions: `quota_snapshots` (window, used_pct, resets_at, source),
`session_outcomes` (insights facets), `prices` (LiteLLM-seeded, pinned, overridable — the
ccusage lesson). Dedup on (backend, raw_ref); JSONL wins for token truth, OTel wins for
attribution, joined on request/session ids. **Identity attributes (emails, org/account UUIDs) are
dropped or mapped to MAX_A/MAX_B/ENT at ingest** — nothing identity-bearing enters the store [X2].

### 6.3 Dashboard leads (in order)

Per-account 5h + weekly quota gauges with reset countdowns; current 5h-block burn rate and
projected exhaustion (ccusage block math); Bedrock real USD (MTD + yesterday) with client-side
estimate overlay; API-equivalent USD by backend (labeled honestly as equivalence, not spend);
cache hit rate with TTL split; latency p50/p95 + TTFT; error/retry/throttle health; skill
leaderboard (frequency × success rate × correction rate × tokens-per-outcome, worst-quartile
flags — correction-intent classification is a local-model job); session outcome/friction mix;
local-offload ratio. LM-Studio-down, cluster-absent, SSO-expired, account-logged-out are all
per-source freshness states, never errors.

---

## 7. Pipeline / workflow builder (feature 5)

Source of record: [pipeline-workflow-builder](../findings/pipeline-workflow-builder.md) (Option E).

- **One capability-catalog scanner, three consumers** (builder palette, one-off launcher pickers,
  context graph): Claude skills/commands (one merged frontmatter dialect, one parser), agents,
  plugins (install-state JSON × enablement × scope), saved dynamic-workflow scripts (static
  `meta` parse only — never executed), per (workspace, account-config-dir) with documented
  precedence and walk-up rules baked in; OpenCode via `GET /agent` + `GET /command` API-first,
  file fallback. Parsers preserve unknown frontmatter keys and survive malformed YAML, exactly
  like Claude Code does.
- **Harness-owned versioned JSON DAG schema**: steps are `{prompt|skill|agent|workflow-script}`
  with `needs:` edges, `when` conditionals, `forEach` fan-out with `maxParallel`, a `loop` kind,
  and first-class `approval` gate steps; each step carries `account`
  (MAX_A|MAX_B|ENT|AWS_DEV|LOCAL), cwd, permissionMode, budget (usd/turns/wall-clock), retry
  policy, and a JSON-schema `outputSchema` enforced via structured output. Capability references
  are resolved against the catalog at plan time and pinned by sourcePath + contentHash.
- **Execution**: one SDK `query()` per Claude step (per-account env), OpenCode SDK or LM Studio
  call otherwise; per-step AbortController cancellation with child-process-group reaping; a
  durable SQLite memoization journal (`step_id + input_hash → cached output`) gives
  cross-restart resume — the native `journal.jsonl` contract made durable. Every step attempt
  registers a `session_node` with workflow edges in the X4 ledger; per-step cost lands in the
  observability store.
- **Native surfaces**: dynamic workflows are single-account, gate-free, session-scoped-resume and
  demonstrably buggy → scan/import/export/observe only. Agent teams stay untargeted until they
  leave experimental. Per-step **account routing is the product** — the one thing no native
  surface offers ([X1]).

---

## 8. Frontend: shell, framework, graph, design

Source of record: [frontend-app-shell-stack](../findings/frontend-app-shell-stack.md) (topology),
[frontend-stack-coherence](../findings/frontend-stack-coherence.md) (framework/renderer/deps —
supersedes conflicting lines in the two earlier UI docs),
[ui-motion-3d-context-graph](../findings/ui-motion-3d-context-graph.md) (graph protocol),
[ui-anti-slop-design](../findings/ui-anti-slop-design.md) (design system).

- **Shell**: Tauri v2 (tray, notifications, windows only — never streaming over Tauri IPC).
  Daemon as sidecar in v0, LaunchAgent in v1 so sessions outlive the app. Locally-built personal
  use needs no notarization; the sidecar-signing gotcha is a known item for shared builds.
- **Framework**: React 19.2 + zustand 5 + React Compiler 1.0, hosting **three imperative,
  framework-free islands**: xterm 6 terminals (WebGL addon, serialize addon for reattach, DOM
  renderer fallback), TanStack react-virtual transcripts (end-anchored `anchorTo:'end'` mode),
  and the context graph. Streaming discipline is mandatory: tokens land in non-reactive ring
  buffers, rAF-batched projections into stores, transient subscribe for per-frame consumers —
  never per-token React state.
- **Context graph (feature 6)**: graphology store → d3-force simulation in a module Web Worker
  (transferable Float32Array position epochs) → PixiJS v8 renderer on WebGL2, behind the
  normative GraphStore→LayoutBridge→GraphRenderer contract, so cosmos.gl (corpus mode) and
  3d-force-graph (3D showcase) can plug in later without touching the store. Incremental
  protocol: batch mutations per rAF/150 ms, spawn nodes at their referrer, gentle
  `alphaTarget(0.3)` reheat, amber pulse only on the artifact being actively touched, layer
  toggles + cluster-dim from day one (the documented hairball failure), `antialias` off.
  Reduced-motion (settled layout, opacity-only fades, no fly-to) ships from day one.
- **Feed**: the same hook/JSONL/SSE watcher that feeds observability publishes
  `{stream:'context-graph'}` envelopes; graph payloads are file paths and session ids — no
  account identifiers needed at all [X2].
- **Animation**: Motion 12 is the single animation dependency (motion/react chrome; vanilla
  `animate()` for camera easing through the renderer contract); GSAP held as escalation; no
  anime.js in v1.
- **Design system**: DESIGN.md is a Stage-2 deliverable **before any UI code** — the Instrument
  Grade token block (warm charcoal #111110 surfaces, bone #E8E6E1 text, single amber #FFB000
  accent, semantic-only status hues, 0–2 px radius, hairline rules, 120–180 ms ease-out,
  phosphor-decay fade on live telemetry, exactly one ceremonial animation on workstream lineage
  events) plus the FORBIDDEN slop list, injected into every build agent's context. Channels
  (MAX_A/MAX_B/ENT/BEDROCK/LMSTUDIO) get fixed panel positions and engraved mono labels;
  ultrawide-first three-zone cockpit layout; latency <100 ms and a command palette are design
  tokens. Paid font binaries never enter the tree; license-clean fallbacks are specified.
- **Locked dependency table** (exact-pin, registry-verified 2026-07-03, all MIT except d3-force
  ISC): react/react-dom 19.2.7, babel-plugin-react-compiler 1.0.0, zustand 5.0.14, motion
  12.42.2, graphology 0.26.0, d3-force 3.0.0, pixi.js 8.19.0, pixi-viewport 6.0.3,
  @tanstack/react-virtual 3.14.5, @xterm/xterm 6.0.0 + webgl/fit/serialize addons, vite 8.1.3,
  tailwindcss 4.3.2 (bound to DESIGN.md tokens) —
  [frontend-stack-coherence](../findings/frontend-stack-coherence.md).

---

## 9. [X3] Verdict: PARTIAL — and how LM Studio connectivity is guaranteed

Source of record: [x3-virtualization-colima-k3s](../findings/x3-virtualization-colima-k3s.md),
reinforced by [local-resource-feasibility](../findings/local-resource-feasibility.md).

- **Harness core is host-native, full stop.** Claude sessions (Keychain + config dirs), the
  broker (Aqua session requirement), LM Studio (no Linux-guest GPU exists under
  Virtualization.framework — it *cannot* be containerized), the collector (must fs-watch
  `~/.claude*` and reach 127.0.0.1 ports), and the frontend all run as host processes.
- **LM Studio connectivity is guaranteed by construction**: only the host-native daemon dials
  127.0.0.1:1234, so the hard gate cannot be breached by the harness itself. The empirical result
  that a k3s pod *can* reach a host loopback-bound service via `host.lima.internal` (verified
  live on Colima 0.10.1 / Lima 2.1.1 / vz / macOS 26.6) is recorded with versions as the aux
  plane's contract: **pin colima/lima and gate every upgrade on re-running that pod→host probe**.
  The 0.0.0.0 rebind (with LM Studio token auth + firewall) is documented strictly as fallback.
- **The existing k3s-in-Colima cluster is kept but demoted**: it remains an optional
  telemetry/dashboard adjunct (Grafana/Prometheus); the VM is right-sized from 8 CPU/24 GiB to
  ~4 CPU/8–12 GiB (broken vz ballooning makes the current reservation a standing threat to model
  memory) and the dormant 16 GiB x86_64 profile is deleted. The harness degrades gracefully when
  the cluster is absent — k3s is never a dependency of session launch or LM Studio access. The
  harness's own host-native OTLP receiver is the collection source of truth (§6); the in-cluster
  collector/Grafana stack is a secondary consumer that may be retired later.
- **SOPS+age**: deferred (see §10 and the contradiction ledger) — but pre-decided as the
  mechanism the day the k8s path grows or a versioned-sensitive file appears; both binaries are
  already installed, so the pivot is one keygen away.

---

## 10. [X2] Secret hygiene stack and first-commit checklist

Source of record: [x2-secret-hygiene](../findings/x2-secret-hygiene.md).

**The stack**: macOS Keychain as the primary runtime secret store (generalizing the owner's
proven pattern; item names committable, values fetched at spawn time and never serialized) +
env-interpolated committed config (`{env:VAR}` idiom; schema tags `secret`/`identifier` fields to
power log redaction, export scrubbing, and a `doctor` command) + gitignored `.env` with committed
`.env.example` + **two-tier gitleaks**: Tier 1 generic value-free rules committed in
`.gitleaks.toml` (12-digit-near-AWS-context, personal-email-provider, catch-all email with
placeholder allowlists); Tier 2 private out-of-repo config holding the exact literals, wired in
via a guarded local pre-commit hook with `--redact` (a committed rule containing the literal
*is* the leak). CI backstop: gitleaks-action on push/PR (free on a personal account) + weekly
TruffleHog `--results=verified`; GitHub push protection + email-privacy settings on. Remediation
doctrine: rotate first, then `git-filter-repo --replace-text`, then GitHub Support for cached
views. Skipped: 1Password, git-secrets, detect-secrets, committed `.envrc`. Deferred: SOPS+age.

**Architectural rules**: the repo holds code and schemas only; all ingested runtime data
(transcripts, usage data, quota files, ledgers) lives outside the tree or under gitignored
`var/`; test fixtures are synthesized, never copied from real transcripts; MAX_A/MAX_B/ENT are
the persisted identity everywhere with the real mapping resolved at runtime (UI-time join);
agents are commit authors here, so hook-level scanning — not agent diligence — is the enforcement.

**First Stage-2 action — the §3.3 checklist, verbatim order**: (1) amend the existing
work-email-authored commit to the GitHub noreply address and force-push **before anything else
depends on the SHA**; (2) enable GitHub email-privacy + push-blocking settings; (3) ordered
`.gitignore` (negation after exclusion); (4) `.env.example` with the AWS_PROFILE-embeds-the-ID
warning; (5) Tier-1 `.gitleaks.toml`; (6) Tier-2 private config, chmod 600; (7) `brew install
gitleaks` + pre-commit wiring; (8) CI workflows with `contents: read`; (9) deliberately fail the
gate three ways to prove it; (10) commit the policy doc. All as one hygiene commit before any code.

---

## 11. Resource budget and supervision

Source of record: [local-resource-feasibility](../findings/local-resource-feasibility.md),
amended by [opencode-serve-event-probe](../findings/opencode-serve-event-probe.md) and
[session-substrate-tiebreak](../findings/session-substrate-tiebreak.md).

- **Budget** (36 GB M4 Max): full target scenario — 3 claude sessions (~1.2 GB typical) +
  2 opencode (~0.6 GB) + broker + Tauri-class frontend (~0.3 GB) + LM Studio with an 8B Q4 model
  (~6.5 GB) — totals ~8.7 GB typical / ~17 GB pessimistic; machine total ~22 GB with ambient apps.
  CPU/GPU are not binding; memory is. Ceiling with supervision: 8–10 resident sessions + one
  7–8B model (or 4–6 + one 12–14B), 24 registered sessions with hibernation.
- **Supervision is the core feature, not an add-on**: per-session footprint watchdog (claude warn
  3 GB / recycle 6 GB; opencode warn 1 GB / recycle 1.5 GB; serve >500 MB sustained 5 min);
  recycle = checkpoint→kill→resume, doubling as the [X4] continuation mechanism. Health signals
  are **pressure/swap deltas** (`memory_pressure -Q`, pressure level, pageout rates), never naive
  free RAM; per-process truth via phys_footprint, not `ps rss`.
- **Thresholds**: amber at pressure level 2 / free <25% / swap >20 GB (stop prewarm, shorten
  model TTL, offer hibernation); red at level 4 / free <12% / swap >26 GB (refuse non-account
  spawns, unload the local model, force-hibernate idle sessions — **account spawns are still
  honored after shedding**).
- **[X1] sacrifice order, encoded in the scheduler**: local model size → local model KV/context →
  frontend shell weight → non-Claude session hibernation → scrollback/buffers. The three account
  sessions are never the victim.
- Idle hibernation after 30 min (never auto-applied to the three account sessions);
  `iogpu.wired_limit_mb` stays default; `~/.claude.json` size monitored per account dir.

---

## 12. Contradiction ledger (what was overridden, and why)

| # | Conflict | Resolution | Overridden doc(s) |
|---|---|---|---|
| 1 | Session substrate: SDK-only ([harness-architecture](../findings/harness-architecture.md)) vs PTY-per-account ([app-shell](../findings/frontend-app-shell-stack.md)) vs tmux ([resource feasibility](../findings/local-resource-feasibility.md)) | Hybrid per the [tie-break](../findings/session-substrate-tiebreak.md): SDK for all programmatic work, node-pty for attended TUIs + login bootstrap, **no tmux in v1** (survival replaced by KeepAlive + resume ledger; re-open trigger defined) | resource-feasibility's tmux substrate; app-shell's "one PTY per account" (conflated account with session) |
| 2 | Can a launchd daemon read the Keychain? ([resource feasibility](../findings/local-resource-feasibility.md) yes vs [x1](../findings/x1-parallel-multi-account.md) warning) | Both partially right — settled by live experiment: **Aqua gui-domain agents yes, Background/user-domain no**. Broker = Aqua LaunchAgent; setup-token only for non-Aqua contexts | x1's warning re-scoped (SSH/Background only); resource-feasibility's phrasing ("user domain") corrected to gui domain |
| 3 | Frontend framework: Svelte 5 ([app-shell](../findings/frontend-app-shell-stack.md)) vs React assumptions ([motion/3D](../findings/ui-motion-3d-context-graph.md)) | **React 19.2 + zustand 5 + Compiler**, via the app-shell doc's own fallback clause: Motion has no Svelte adapter, the Svelte virtual adapter is buggy, AI-codegen fluency favors React in an agent-built codebase ([coherence tie-break](../findings/frontend-stack-coherence.md)) | app-shell's Svelte 5 pick |
| 4 | Graph renderer: three.js/3d-force-graph ([app-shell](../findings/frontend-app-shell-stack.md), one line) vs graphology+d3-force+Pixi ([motion/3D](../findings/ui-motion-3d-context-graph.md), full analysis) | **Pixi stack confirmed** (Obsidian-proven architecture, 2D-first mandate from [anti-slop](../findings/ui-anti-slop-design.md), total visual ownership); 3d-force-graph demoted to deferred showcase mode | app-shell's three.js line |
| 5 | SOPS+age: adopt now unconditionally ([x3](../findings/x3-virtualization-colima-k3s.md)) vs defer ([x2](../findings/x2-secret-hygiene.md)) | **Defer**, per the dedicated hygiene research: nothing in the repo needs encrypt-in-repo, "not in repo at all" beats "in repo encrypted", and premature ceremony adds surface without closing a risk. Pre-decided pivot (one keygen away) the day k3s grows or a versioned-sensitive file appears | x3's "adopt unconditionally" |
| 6 | Quota observability: "no public API — biggest gap" ([harness-architecture](../findings/harness-architecture.md)) vs statusline rate_limits feed ([observability](../findings/observability.md)) | The statusline hook JSON is a supported, per-account, event-driven quota feed **today**; OAuth usage endpoint is the rate-limited idle fallback. Gap closed | harness-architecture's open question 3 |
| 7 | Claude binary channel: standardize Homebrew ([x1](../findings/x1-parallel-multi-account.md)) vs pin the SDK-bundled binary ([tie-break](../findings/session-substrate-tiebreak.md)) | **SDK-bundled binary for every harness spawn** — keychain ACLs anchor to Apple's `security` tool, so channel doesn't affect ACL trust; pinning controls schema + service-name drift. Homebrew/Desktop copies remain for human use, labeled externally-owned | x1's Homebrew standardization (intent honored) |
| 8 | OpenCode serve watchdog: 150–250 MB estimate ([resource feasibility](../findings/local-resource-feasibility.md)) vs measured GC sawtooth ([serve probe](../findings/opencode-serve-event-probe.md)) | Threshold on **sustained** RSS (~>500 MB for 5 min); the flat estimate holds only for settled idle | resource-feasibility's flat threshold |
| 9 | Telemetry plane placement: consume the in-cluster claude-otel-collector ([x3](../findings/x3-virtualization-colima-k3s.md)) vs host-native collector ([observability](../findings/observability.md)) | The harness's **own host-native OTLP receiver is the source of truth** (it must fs-watch and reach loopback ports anyway); the k3s Grafana stack is an optional secondary consumer, candidate for later retirement | x3's lean toward the in-cluster collector as the read path |

---

## 13. Stage-2 order of operations

1. **Hygiene commit first** — execute the [X2 §3.3 checklist](../findings/x2-secret-hygiene.md)
   starting with the author-email history amend. Nothing builds on the old SHA.
2. **DESIGN.md** — freeze the Instrument Grade tokens + FORBIDDEN list
   ([anti-slop](../findings/ui-anti-slop-design.md)) before any UI code.
3. **Account profiles** — create the three config dirs, one login each, keychain self-check,
   `auth status --json` probes ([x1](../findings/x1-parallel-multi-account.md)).
4. **Broker skeleton** — spawner (env injection + scrub), resume ledger, WS envelope, hooks
   installation per account dir; then the collector (JSONL tail → statusline quota → OTLP
   receiver → OpenCode SSE) ([harness-architecture](../findings/harness-architecture.md),
   [observability](../findings/observability.md)).
5. **Risk spikes, in this order** ([coherence](../findings/frontend-stack-coherence.md),
   [tie-break](../findings/session-substrate-tiebreak.md),
   [app-shell](../findings/frontend-app-shell-stack.md)):
   (i) xterm 6 WebGL inside WKWebView on macOS 26.6 (canvas renderer is gone; Safari-26 WebGL
   breakage is open); (ii) Pixi v8 5k-node soak in a Tauri window; (iii) worker layout round-trip
   latency; (iv) `navigator.gpu` WebGPU probe in WKWebView; (v) react-virtual mid-stream resize;
   (vi) 6-PTY flow-control soak with the real claude TUI; (vii) broker-SIGKILL orphan/resume
   fidelity probes; (viii) `ant` profile Max-subscription experiment; (ix) sidecar signing dry
   run; (x) Bun.Terminal parity check.
6. **Gated externals** — the Bedrock application inference profile (AWS IaC, explicit verbal OK
   required) and the Colima VM right-size (`colima stop/start --memory`, brief downtime)
   ([observability](../findings/observability.md),
   [x3](../findings/x3-virtualization-colima-k3s.md)).
7. **Doc hygiene chore** — annotate the superseded lines in
   [frontend-app-shell-stack](../findings/frontend-app-shell-stack.md) and
   [ui-motion-3d-context-graph](../findings/ui-motion-3d-context-graph.md) with pointers to
   [frontend-stack-coherence](../findings/frontend-stack-coherence.md), and the x3 SOPS stance
   with a pointer to this blueprint's ledger (§12).
