# Executive summary — Stage-1 research, the-last-aibender

> Consolidates the recommendations of all fourteen Stage-1 findings documents into one narrative.
> Every claim links to its source. Companion document: [01-architecture-blueprint.md](01-architecture-blueprint.md)
> (the opinionated architecture Stage 2 implements). Account identifiers are placeholders throughout:
> **MAX_A**, **MAX_B**, **ENT**, **AWS_DEV_ACCOUNT_ID** — per the public-repo policy in the
> [X2 secret-hygiene findings](../findings/x2-secret-hygiene.md).
> Consolidated: 2026-07-03.

---

## The one-paragraph verdict

The harness is buildable, on this machine, with today's tooling — and every hard problem has a
verified answer. Parallel multi-account Claude sessions ([X1]) are solved with documented env vars
and a keychain behavior verified in the shipping binary ([X1 findings](../findings/x1-parallel-multi-account.md)).
The execution engine is the TypeScript Agent SDK under a single host-native broker daemon
([harness architecture](../findings/harness-architecture.md),
[session-substrate tie-break](../findings/session-substrate-tiebreak.md)). Remaining-quota
observability — feared to be the biggest gap — turns out to be programmatically readable today via
the statusline hook ([observability findings](../findings/observability.md)). Colima/k3s is demoted
to an optional auxiliary plane after the LM Studio connectivity gate empirically passed but the
resource math failed ([X3 findings](../findings/x3-virtualization-colima-k3s.md),
[resource feasibility](../findings/local-resource-feasibility.md)). Workstreams ([X4]) become a
harness-owned SQLite lineage ledger over native session primitives that already exist on disk
([X4 findings](../findings/x4-workstreams.md)). The frontend is Tauri v2 over a shell-agnostic
localhost core, React 19 chrome around three framework-free canvas islands, styled by a locked
"Instrument Grade" design-token file ([app-shell stack](../findings/frontend-app-shell-stack.md),
[frontend-stack coherence](../findings/frontend-stack-coherence.md),
[anti-slop design](../findings/ui-anti-slop-design.md)). One urgent action precedes everything:
the repo's existing commit leaks a work-domain author email and must be amended and force-pushed
before any code lands ([X2 findings](../findings/x2-secret-hygiene.md)).

---

## 1. Execution engine: Agent SDK under one broker daemon

The [harness-architecture findings](../findings/harness-architecture.md) establish that the
TypeScript Agent SDK is the sanctioned programmatic surface over Claude Code: it bundles its own
pinned CLI binary, exposes typed stream messages, in-process hooks, `canUseTool` permission
callbacks, resume/fork, and session list/rename/tag primitives that map 1:1 onto the workstreams
concept. Subscription auth works through the SDK today — the June 2026 credit-pool split was
paused, but it will likely return, so per-account usage accounting is built from day one. Raw
CLI-wrapping is strictly worse (undocumented control frames, `--permission-prompt-tool` removed),
and PTY-scraping is rejected for orchestration. One critical gotcha: `--bare` mode disables
subscription OAuth entirely and must never be used on MAX_A/MAX_B/ENT runs.

The [session-substrate tie-break](../findings/session-substrate-tiebreak.md) resolved the
three-way substrate conflict between earlier docs: **SDK `query()` is the sole programmatic
substrate** (one-offs, workflow steps, background agents), and the **real `claude` TUI under
daemon-owned node-pty is the sole attended surface** (and the mandatory login-bootstrap path).
Semantics never come from PTY bytes — only from hooks, JSONL transcripts, and the SDK stream.
tmux is **not in v1**: its only unique property (processes surviving a broker crash) is replaced
by launchd `KeepAlive` plus a row-before-spawn SQLite resume ledger with transcript-tail
validation. A live experiment on this machine settled the launchd/Keychain contradiction: a
**gui-domain (Aqua) LaunchAgent has full login-keychain access**, while a Background/user-domain
agent fails value reads — so the broker runs as an Aqua LaunchAgent (Tauri sidecar in v0) and
needs no setup-token for normal operation.

## 2. [X1] Parallel multi-account — solved, with a fallback ladder

The [X1 findings](../findings/x1-parallel-multi-account.md) verified — by de-minifying the
shipping binary *and* by a live keychain entry on this machine — that Claude Code scopes its macOS
keychain credential item **per config dir** (service name suffixed with a hash of
`CLAUDE_CONFIG_DIR`). One config dir per account therefore gives true parallel multi-account auth
with zero re-login. The undocumented `CLAUDE_SECURESTORAGE_CONFIG_DIR` decouples credential store
from config dir — the seam that lets per-workstream config dirs share one per-account credential
store. OAuth refresh races are real but intra-account only, and current builds serialize refresh
with a lock file. The non-negotiable invariant: **one account ↔ exactly one live credential store
per host**. The fallback ladder: (1) per-account config dir + pinned securestorage dir →
(2) + `claude setup-token` env injection for headless/non-Aqua contexts → (3) Linux container per
account with file credentials → (4) separate macOS user accounts (break-glass) → (watch) official
`ant` CLI profiles, pending verification that Max subscriptions can back them. ToS analysis found
no one-account-per-person clause; self-owned multi-account with humane concurrency is compliant.

## 3. Observability: subscribe + scrape + poll into one SQLite store

The [observability findings](../findings/observability.md) close what
[harness-architecture](../findings/harness-architecture.md) had flagged as the project's biggest
gap: **remaining Max quota is readable today** via the statusline hook's stdin JSON
(`rate_limits.five_hour` / `seven_day` with `used_percentage` and `resets_at`), with the
undocumented OAuth usage endpoint as a rate-limited fallback for idle accounts. The collection
architecture is hybrid: **subscribe** to Claude Code OpenTelemetry (the only surface with native
`skill.name`/`agent.name` cost attribution) and OpenCode SSE; **scrape** the
`projects/**/*.jsonl` transcripts (ground truth for tokens incl. the 5m/1h cache-TTL split, and
the live context-graph feed) plus OpenCode's SQLite; **poll** AWS Cost Explorer (authoritative
Bedrock USD, ~24 h lag) and CloudWatch Bedrock metrics for near-real-time estimates. Everything
lands in one normalized local SQLite events store with real identities mapped to
MAX_A/MAX_B/ENT at ingest. The [OpenCode serve probe](../findings/opencode-serve-event-probe.md)
then enumerated the exact SSE vocabulary: subscribe `/global/event`, dedupe on the monotonic
`evt_` id (verified identical across all three streams *and* the on-disk durable event store),
replay per-session durable streams for gap repair, and tolerate unknown event types (the
heartbeat isn't even in the spec). Bedrock cost attribution uses an application
inference-profile ARN as a custom OpenCode model — with the config key named to contain
`claude` and an explicit cost block, per the probe's source-level verification.

## 4. [X2] Secret hygiene: local enforcement, because GitHub can't see identifiers

The [X2 findings](../findings/x2-secret-hygiene.md) establish that GitHub's free secret scanning
covers provider tokens only — there is **no pattern for 12-digit AWS account IDs or emails**, and
custom patterns need a paid org plan. The project's highest-risk leak class (personal
identifiers; even the AWS SSO profile name embeds AWS_DEV_ACCOUNT_ID) therefore gets zero hosted
enforcement, so the defense is local: **two-tier gitleaks** (generic value-free rules committed
in `.gitleaks.toml`; literal identifiers in a private out-of-repo config with `--redact`) at
pre-commit, plus gitleaks-action and weekly verified-only TruffleHog in CI. Runtime secrets stay
in the macOS Keychain (the owner's proven pattern). SOPS+age is deferred until the k3s path or a
genuinely versioned-and-sensitive file appears — "not in repo at all" beats "in repo encrypted"
(this overrides the [X3 findings](../findings/x3-virtualization-colima-k3s.md)' adopt-now stance;
see the [blueprint's contradiction ledger](01-architecture-blueprint.md)). **Urgent**: the repo's
single existing commit was authored with a work-domain email and must be amended + force-pushed
first; the doc's §3.3 ten-step hygiene checklist is the very first Stage-2 action.

## 5. [X3] Verdict: PARTIAL — host-native core, k3s demoted, gate honored

The [X3 findings](../findings/x3-virtualization-colima-k3s.md) ran the hard gate empirically:
a k3s pod inside Colima **did** reach a host service bound strictly to 127.0.0.1 via
`host.lima.internal` — no rebinding needed — but the behavior is version-fragile and LM Studio can
never run inside the VM anyway (no guest GPU under Virtualization.framework). Meanwhile the
[resource-feasibility findings](../findings/local-resource-feasibility.md) show the existing
8-CPU/24-GiB VM reservation, with broken vz memory ballooning, directly starves LM Studio model
loads. Verdict: **harness core is host-native** (sessions, LM Studio, broker, frontend); the
existing 282-day-old k3s cluster is kept but demoted to an optional telemetry adjunct and shrunk
to ~4 CPU / 8–12 GiB; colima/lima versions are pinned and every upgrade re-runs the pod→host
loopback probe. k3s is never a dependency of session launch or LM Studio access.

## 6. [X4] Workstreams: a harness-owned lineage ledger over native primitives

The [X4 findings](../findings/x4-workstreams.md) found the raw material already on disk: Claude
Code writes per-session JSONL with message-level parent chains, sidechain flags, and compaction
boundaries whose auto-generated continuation summary *is* the handoff brief the feature wants —
just trapped inside single session files. OpenCode has a first-class indexed `parent_id` column
plus per-session cost/token columns. No shipped tool models sequential session lineage as a
product concept — a cross-backend session DAG with merge is unclaimed territory. The design:
a **harness-owned SQLite ledger** (workstream / session_node / session_edge / brief tables)
recording typed edges (`continue`, `fork`, `merge_parent`, `compact`, `sidechain`, `handoff`,
`import`) **deterministically at action time** because every launch/resume/fork/merge flows
through the harness's launcher adapters, plus a reconciler that registers externally created
sessions as inferred-confidence orphans. **Merge = synthesis**: per-branch distillates fused into
a conflict-surfacing merge brief that seeds a new session with N merge-parent edges. Hooks
(`SessionEnd`/`PreCompact`/`SessionStart`) automate continuation briefs, killing the manual
handoff doc. Native stores are never mutated; git is UX metaphor only.

## 7. Pipeline builder: harness-owned DAG, native workflows as interop only

The [pipeline-workflow-builder findings](../findings/pipeline-workflow-builder.md) enumerated
every discovery surface (Claude skills/commands — now one merged format — agents, plugins, and
the newly-shipped dynamic workflows; OpenCode agents/commands via the API-first `GET /agent` /
`GET /command`). Native dynamic workflows are documented but single-account, single-backend,
forbid mid-run human input, and carry demonstrated resume bugs — so the execution engine is
**harness-owned**: a versioned declarative JSON DAG (GitHub-Actions-shaped `needs:` edges) where
each step routes to an account/backend (the one thing no native surface can do), compiled to
per-step SDK `query()` / OpenCode SDK / LM Studio calls, with first-class human-approval gates, a
durable SQLite memoization journal for cross-restart resume, and every step registered as a
session node in the X4 ledger. Native workflow scripts are scanned, optionally exported to, and
observed read-only — never built upon.

## 8. Frontend: Tauri shell, shell-agnostic core, React chrome, Pixi graph

The [app-shell findings](../findings/frontend-app-shell-stack.md) make the decisive move
**shell-agnosticism**: PTYs, supervision, watchers, and state live in a localhost TypeScript
daemon; the UI talks to it over one multiplexed WebSocket, so Tauri's weaknesses (IPC throughput,
no node-pty, WebGPU uncertainty) are all neutralized while its wins (RAM, tray, notifications)
are kept — and Chrome becomes a free second frontend. The
[frontend-stack coherence tie-break](../findings/frontend-stack-coherence.md) resolved the two
open contradictions: the context graph ships as **graphology + d3-force in a Web Worker + PixiJS
v8 on WebGL2** (the Obsidian-proven architecture, per the
[motion/3D findings](../findings/ui-motion-3d-context-graph.md)), and the framework is **React
19.2 + zustand 5 + React Compiler** (superseding Svelte 5 via the app-shell doc's own fallback
clause — Motion v12 has no Svelte adapter, TanStack Virtual's Svelte adapter is buggy, and
AI-codegen fluency decisively favors React for an agent-built codebase). Motion 12 is the single
animation dependency; a locked, exact-pinned MIT/ISC dependency table is the list of record. The
riskiest new unknown — xterm 6 removed its canvas renderer while a Safari-26 WebGL breakage issue
is open — is the top Stage-2 spike.

## 9. Design: "Instrument Grade", token-locked against AI slop

The [anti-slop findings](../findings/ui-anti-slop-design.md) treat the generic AI aesthetic as an
enumerable failure mode with a known cause, and the unanimous remedy — since this harness will be
built largely *by* coding agents — is a locked DESIGN.md token file with explicit FORBIDDEN lists,
delivered before any UI code. The chosen direction is **"Instrument Grade"** (Braun/Rams ×
teenage-engineering flight deck): warm charcoal surfaces, bone text, a single instrument-amber
accent, semantic-only status colors, hairline rules instead of cards, 0–2 px radii, 120–180 ms
mechanical motion — importing the monospace character grid for data surfaces and a phosphor-decay
fade as the live-telemetry motion signature. Latency (<100 ms interactions) and a command palette
are first-class design tokens. Paid font binaries never enter the public tree.

## 10. Resource budget: it fits, with supervision

The [resource-feasibility findings](../findings/local-resource-feasibility.md) measured the
actual stack: the full target scenario (three Claude account sessions + two OpenCode + an 8B
local model + broker + Tauri-class frontend) budgets to ~8.7 GB typical / ~17 GB pessimistic on
the 36 GB M4 Max — comfortable, *provided supervision exists from day one*. Claude Code has a
documented multi-GB memory-leak history and is now a native Bun binary immune to the old heap-cap
workaround, so the harness's core resource feature is a watchdog→checkpoint→kill→resume loop
(recycle thresholds: claude 3/6 GB, opencode warn 1 GB and — per the
[serve probe's](../findings/opencode-serve-event-probe.md) GC-sawtooth measurement — recycle on
sustained RSS, not peaks). The local model runs JIT-loaded with TTL and auto-evict (the exact
anti-pattern — a 6.86 GB model resident with no TTL — was live on this machine). The [X1]
sacrifice order is encoded: model size → model KV → shell weight → non-Claude sessions → buffers;
the three account sessions are never the victim.

---

## The five headline decisions

1. **One host-native broker daemon (gui-domain Aqua LaunchAgent) owns all execution**; the
   TypeScript Agent SDK is the only programmatic substrate, node-pty TUIs the only attended
   surface, and per-account `CLAUDE_CONFIG_DIR` (+ pinned securestorage dir) delivers [X1]
   — [session-substrate tie-break](../findings/session-substrate-tiebreak.md),
   [X1 findings](../findings/x1-parallel-multi-account.md),
   [harness architecture](../findings/harness-architecture.md).
2. **A hybrid subscribe/scrape/poll collector into one SQLite store** answers every
   observability requirement, including live per-account quota gauges
   — [observability](../findings/observability.md),
   [OpenCode serve probe](../findings/opencode-serve-event-probe.md).
3. **Host-native core; k3s demoted to optional aux; SOPS deferred; Keychain-primary secrets;
   two-tier gitleaks from the very first (amended) commit**
   — [X3](../findings/x3-virtualization-colima-k3s.md),
   [X2](../findings/x2-secret-hygiene.md).
4. **Workstreams and pipelines are harness-owned SQLite ledgers over native session IDs**,
   with merge-as-synthesis and per-step account routing as the differentiators
   — [X4](../findings/x4-workstreams.md),
   [pipeline builder](../findings/pipeline-workflow-builder.md).
5. **Tauri v2 + localhost core + React 19 chrome + Pixi/d3-force context graph, token-locked to
   the Instrument Grade design system**
   — [app-shell](../findings/frontend-app-shell-stack.md),
   [frontend coherence](../findings/frontend-stack-coherence.md),
   [motion/3D](../findings/ui-motion-3d-context-graph.md),
   [anti-slop design](../findings/ui-anti-slop-design.md).

The full architecture, the contradiction-resolution ledger, and the ordered Stage-2 actions are
in [01-architecture-blueprint.md](01-architecture-blueprint.md).
