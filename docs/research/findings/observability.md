# Observability for the-last-aibender: agent usage, cost, quota, and skill analytics

Stage-1 discovery research. Verified on the target machine (macOS, Apple M4 Max) on 2026-07-03 against Claude Code 2.1.193, OpenCode (SQLite storage era), and LM Studio (`lms` CLI present, server down). All account identifiers are placeholders: `MAX_A`, `MAX_B` (Claude Max plans), `ENT` (Claude Enterprise seat), `AWS_DEV_ACCOUNT_ID` (company dev AWS account).

---

## TL;DR

1. Claude Code ships first-class OpenTelemetry (metrics + events + beta traces) with per-request cost, tokens, cache split, and — critically — `skill.name` / `agent.name` / `mcp_server.name` attribution. Subscribe to it; don't reinvent it.
2. The `~/.claude/projects/**/*.jsonl` transcripts are the *only* source with full history and per-message `usage` blocks (incl. 5m/1h cache-TTL split). They are the ground-truth scrape source and also power the live context graph.
3. Remaining Max quota is programmatically readable **today** via the statusline hook JSON (`rate_limits.five_hour` / `seven_day`, `used_percentage`, `resets_at`) — supported, per-account, event-driven. The undocumented `/api/oauth/usage` endpoint works but 429s aggressively; use it only as a low-frequency fallback.
4. ENT seat analytics (Enterprise Analytics API, `/v1/organizations/analytics/…`) require an org **admin** key the user likely doesn't hold; treat ENT like a Max account locally (transcripts + statusline) and make the admin API an optional plug-in.
5. Real Bedrock USD = Cost Explorer (authoritative, ~24 h lag, $0.01/query) + an **application inference profile** with cost-allocation tags for the harness's own traffic + CloudWatch `AWS/Bedrock` metrics (tokens, TTFT, throttles) for near-real-time estimates.
6. OpenCode already computes per-message `cost` and `tokens` (incl. cache read/write) into `~/.local/share/opencode/opencode.db` (SQLite); its `opencode serve` HTTP server exposes sessions + an SSE `/event` stream for live subscription.
7. LM Studio's REST API (`/api/v0`, native `/api/v1` since 0.4.0) returns `tokens_per_second`, `time_to_first_token`, `generation_time` per call — route harness traffic through it and record stats inline; poll `/api/v0/models` for health (server is currently down; tolerate that).
8. Recommendation: a hybrid **subscribe (OTLP + SSE) / scrape (JSONL + SQLite tail) / poll (AWS + quota)** collector writing one normalized SQLite/DuckDB event store; dashboard leads with per-account quota gauges, 5h-block burn rate, real Bedrock USD, cache hit rate, latency percentiles, and a skill leaderboard (frequency × success rate × tokens-per-outcome).
9. Skill optimality is measurable from data that already exists: `skill_activated`/`tool_result` events + `/insights` facets (`outcome`, `user_satisfaction`, `friction_counts`) + transcript mining for retry/correction loops.
10. Secret hygiene: OTEL emits `user.email` and account UUIDs by default — the collector must map them to MAX_A/MAX_B/ENT at ingest and never persist raw identities in anything that could be committed.

---

## Current landscape

### 1. Claude Code OpenTelemetry (2026 state)

Claude Code has mature, documented OTEL support (docs: `code.claude.com/docs/en/monitoring-usage`). It is opt-in: `CLAUDE_CODE_ENABLE_TELEMETRY=1` plus at least one exporter. Signals:

**Metrics** (meter `com.anthropic.claude_code`, default export every 60 s, delta temporality):

| Metric | Unit | Notable attributes |
|---|---|---|
| `claude_code.session.count` | count | `start_type` (fresh/resume/continue) |
| `claude_code.cost.usage` | USD | `model`, `query_source` (main/subagent/auxiliary), `speed`, `effort`, **`agent.name`, `skill.name`, `plugin.name`, `mcp_server.name`, `mcp_tool.name`** |
| `claude_code.token.usage` | tokens | `type` (input/output/cacheRead/cacheCreation), `model`, plus the same skill/agent/MCP attribution |
| `claude_code.lines_of_code.count` | count | `type` (added/removed), `model` |
| `claude_code.commit.count`, `claude_code.pull_request.count` | count | |
| `claude_code.code_edit_tool.decision` | count | `tool_name`, `decision` (accept/reject), `source` |
| `claude_code.active_time.total` | s | `type` (user/cli) |

**Events** (OTLP logs, default export every 5 s): `user_prompt`, `assistant_response` (v2.1.193+), `tool_result` (with `success`, `duration_ms`, `error_type`, sizes), `tool_decision`, `api_request` (with `cost_usd`, `duration_ms`, all four token counts, `request_id`, `effort`, skill/agent/MCP attribution), `api_error` (with `status_code`, `attempt`), `api_retries_exhausted`, `api_refusal`, `permission_mode_changed`, `mcp_server_connection`, `skill_activated` (with `invocation_trigger`: user-slash / claude-proactive / nested-skill, and `skill.source`), `plugin_loaded`, `hook_execution_start/complete`, `compaction` (`pre_tokens`/`post_tokens`), `at_mention`, `internal_error`, `auth`, `feedback_survey`. All events carry a `prompt.id` UUID that chains everything triggered by one user prompt — this is the natural "unit of work" key for tokens-per-outcome analytics.

**Traces (beta)**: `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` + `OTEL_TRACES_EXPORTER=otlp` yields a span tree `interaction → llm_request / tool → tool.execution / subagent spans`, with W3C `TRACEPARENT` propagated into Bash subprocesses and MCP HTTP calls.

**Redaction model (matters for skill analytics):** custom/user-defined skill names, third-party plugin names, user-configured MCP server names, Bash commands, and tool inputs are redacted to `custom`/`third-party` **unless `OTEL_LOG_TOOL_DETAILS=1`**. Prompt text requires `OTEL_LOG_USER_PROMPTS=1`; response text `OTEL_LOG_ASSISTANT_RESPONSES=1`; full request/response bodies `OTEL_LOG_RAW_API_BODIES` (inline 60 KB-truncated or `file:<dir>` untruncated). For a local-only collector, turning `OTEL_LOG_TOOL_DETAILS=1` on is the right call — otherwise every workspace skill shows up as `custom`.

**Identity/cardinality:** every metric/event carries `session.id`, `organization.id`, `user.account_uuid`, `user.email` (when OAuth-authenticated) by default; toggles exist (`OTEL_METRICS_INCLUDE_ACCOUNT_UUID`, `OTEL_METRICS_INCLUDE_SESSION_ID`, etc.). `OTEL_RESOURCE_ATTRIBUTES` lets the harness stamp each account's sessions with a synthetic label (e.g. `account=MAX_A`) — the clean way to do multi-account attribution without touching real identities. Note: Claude Code does **not** pass `OTEL_*` vars to subprocesses, so nested tools don't accidentally inherit the pipeline.

The ecosystem treats this as standard practice now: SigNoz, Grafana/VictoriaMetrics, AWS CloudWatch, and several OSS dashboards (`ColeMurray/claude-code-otel`, `claude_telemetry`) publish Claude Code OTEL dashboards.

### 2. Local artifacts on this machine (verified read-only)

All paths verified 2026-07-03; Claude Code 2.1.193 (a telemetry event on disk shows a 2.1.197 build also active via the desktop entrypoint).

- **`~/.claude/projects/<flattened-cwd>/<session-uuid>.jsonl`** — full transcripts, one JSON object per line. Line `type`s observed: `user`, `assistant`, `system`, `attachment`, `queue-operation`, `ai-title`, `last-prompt`. Each `assistant` line carries `message.model`, `requestId`, `timestamp`, `cwd`, `gitBranch`, `sessionId`, `parentUuid` (message lineage), `isSidechain` (subagent threads), and a full `usage` block:
  ```json
  {"input_tokens":6,"cache_creation_input_tokens":20144,"cache_read_input_tokens":17643,
   "output_tokens":244,"service_tier":"standard",
   "cache_creation":{"ephemeral_1h_input_tokens":20144,"ephemeral_5m_input_tokens":0},
   "server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"speed":"standard"}
  ```
  Tool invocations (including `Skill`, `Task`/subagent, MCP tools) and `tool_result` contents appear as content blocks in `assistant`/`user` lines — sufficient to mine skill frequency, file touches (Read/Edit/Write inputs), retries, and error loops for all history, with no telemetry enabled. This is also the live feed for the context graph: fs-watch the JSONL files and parse appended lines.
- **`~/.claude/usage-data/`** — output of the `/insights` feature (added early 2026): `report.html` (self-contained local report), `facets/<session-uuid>.json` (Haiku-generated per-session assessments: `underlying_goal`, `goal_categories`, `outcome` (e.g. `mostly_achieved`), `user_satisfaction_counts`, `claude_helpfulness`, `friction_counts`/`friction_detail`, `session_type`), and `session-meta/<session-uuid>.json` (deterministic per-session stats: `duration_minutes`, message counts, `tool_counts` per tool, `tool_errors` + `tool_error_categories`, `input_tokens`/`output_tokens`, `lines_added`/`lines_removed`, `git_commits`/`git_pushes`, `user_interruptions`, `uses_task_agent`/`uses_mcp`, hourly activity). These are **pre-computed outcome labels** — a free training set for skill-optimality scoring.
- **`~/.claude/history.jsonl`** — every prompt with `display`, `timestamp`, `project`, `sessionId`. Cheap global prompt-frequency index.
- **`~/.claude/telemetry/1p_failed_events.*.json`** — JSONL batches of Anthropic's internal (1st-party) event stream that failed to upload. Events like `tengu_config_cache_stats` include model, session id, betas, and a base64 `additional_metadata` containing `subscription_type` and config-cache hit rates. Undocumented and unstable; useful only as a curiosity/fallback, not a foundation.
- **`~/.claude/settings.json`** already contains `OTEL_*` keys (`OTEL_METRICS_EXPORTER`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_LOG_USER_PROMPTS`, …) — the user has experimented with telemetry before; the harness can manage these per-account via each account's isolated config dir.
- **Credentials location caveat (macOS):** `~/.claude/.credentials.json` does **not** exist on this machine — on macOS the OAuth token lives in the Keychain (Claude Code credentials item). Any quota-poll fallback must read the token from Keychain at runtime (never persisting it), or better, avoid needing it (statusline approach below).

### 3. Max plan quota model and programmatic access

- **Model:** two layers per account — a 5-hour rolling window (starts at first message, resets 300 min later) and a rolling 7-day cap; both consumed by tokens across Claude surfaces. On 2026-05-06 Anthropic doubled 5-hour limits for Pro/Max/Team/Enterprise-seat plans and removed peak-hour reductions. Weekly caps reset on a rolling 7-day basis (community observation: Thursday ~8 pm PT for many accounts, not UTC midnight — treat `resets_at` from the API as authoritative, not assumptions).
- **In-product surfaces:** `/usage` inside Claude Code shows 5-hour and weekly progress bars + reset times; claude.ai Settings → Usage shows the same. Neither is an API.
- **Supported programmatic surface — statusline input JSON:** since Claude Code v1.2.80, the statusline hook receives `rate_limits.five_hour` and `rate_limits.seven_day`, each with `used_percentage` and `resets_at`, alongside `cost.total_cost_usd`, `context_window.used_percentage`, `model`, `session_id`, etc. A statusline command that tees this JSON to a per-account file gives the harness fresh quota data on every render tick of any live session, with zero extra API calls, per account. This is the highest-quality quota feed available.
- **Undocumented endpoint:** `GET https://api.anthropic.com/api/oauth/usage` with the account OAuth token + header `anthropic-beta: oauth-2025-04-20` returns `five_hour`, `seven_day`, `seven_day_sonnet` objects with `utilization` (0–1) and `resets_at`. Known issues: aggressive 429 rate-limiting (GitHub issue #31637), no absolute numbers (percent only), unversioned/undocumented (may break). An official `claude usage`/API is a long-open feature request (#44328). Verdict: fallback only, polled ≤ once per 10–15 min per account with caching and exponential backoff, useful when an account has no live session emitting statusline ticks.

### 4. Enterprise (ENT) visibility

- Enterprise admins get a usage/cost analytics dashboard (by group and user; artifacts created, skills/connectors used next to cost; CSV export) and the **Enterprise Analytics API** under `https://api.anthropic.com/v1/organizations/analytics/…` — per-user daily metrics across chat and Claude Code (sessions, commits, PRs, lines of code, tool actions, estimated cost), data available from 2026-01-01. Requires an org **Admin API key**.
- For API organizations there is the parallel **Usage & Cost Admin API** (`/v1/organizations/usage_report/messages`, cost reports, and a Claude Code analytics daily feed) — also Admin-key-gated.
- Reality check for the harness: the user holds an ENT *seat*, almost certainly not an org admin key. So ENT observability locally = same as Max (transcripts, statusline quota, OTEL) tagged `account=ENT`; the Analytics API should be an optional adapter that lights up if an admin key is ever provided. Enterprise seat quota also shows in `/usage` (seat-based Enterprise gained the same limit surfaces in 2026).

### 5. AWS Bedrock (via OpenCode) — real USD

Bedrock is the only backend with true marginal dollar cost. Four complementary surfaces:

1. **Cost Explorer API** (`GetCostAndUsage`): authoritative USD, filter `SERVICE = Amazon Bedrock` (+ region), group by `USAGE_TYPE` or cost-allocation tag. Latency ~24 h; each paginated request costs $0.01 — poll once or twice a day, not continuously.
2. **CUR 2.0 / Data Exports**: line-item detail (per usage-type token quantities) delivered to S3; overkill for a single-dev harness unless per-line-item reconciliation is wanted. Bedrock line items include input/output/cache token usage types per model.
3. **Application inference profiles**: `CreateInferenceProfile` copying from a system profile (e.g. `us.anthropic.claude-opus-4-8`), tagged (e.g. `app=last-aibender`, `agent=<name>`); invoke via the profile ARN and costs arrive in Cost Explorer/CUR pre-tagged. Since April 2026, AWS *also* supports IAM-principal cost allocation for Bedrock (attribute spend to the SSO role/user without changing invocation code). The harness should adopt the inference-profile ARN in OpenCode's model config to segregate "harness traffic" from other users of AWS_DEV_ACCOUNT_ID.
4. **CloudWatch**: namespace `AWS/Bedrock`, per-`ModelId` metrics: `Invocations`, `InvocationLatency`, `InvocationThrottles`, `InvocationClientErrors`, `InputTokenCount`, `OutputTokenCount`, `CacheReadInputTokenCount`, `CacheWriteInputTokenCount`, and newer `TimeToFirstToken` and `EstimatedTPMQuotaUsage`. Near-real-time; multiply token counts by the on-demand price sheet for a same-day USD estimate. **Model invocation logging** (opt-in, to CloudWatch Logs/S3) adds one record per call with token counts and identity — the standard pattern for per-user Claude-Code-on-Bedrock cost attribution — but ingestion costs $0.50/GB and full prompt/response capture should stay off.

Important nuance: OpenCode already computes a client-side `cost` per message (verified below), so the harness gets an instant estimate for its own traffic without any AWS API; AWS surfaces exist to make it *true* (billing-grade) and to catch traffic from other tools. Note the second OpenCode provider (Bedrock's OpenAI-compatible Responses API endpoint with a long-term API key from Keychain item `bedrock-openai-api-key`) bills into the same AWS account and appears in the same Cost Explorer/CUR data.

### 6. OpenCode usage surfaces (verified locally)

- **Storage (current versions): SQLite** at `~/.local/share/opencode/opencode.db` (WAL mode; older versions used JSON files under `storage/`). Verified schema: `session` (with `parent_id` — session lineage relevant to workstreams [X4], `project_id`, `directory`, `title`, share fields), `message` (`id`, `session_id`, `time_created`, `data` JSON), `part`, `project`, `permission`, `todo`, etc. A verified assistant `message.data`:
  ```json
  {"role":"assistant","mode":"build","agent":"build","cost":0.054208,
   "tokens":{"total":9496,"input":9424,"output":72,"reasoning":0,
             "cache":{"write":0,"read":0}},
   "modelID":"openai.gpt-5.5","providerID":"amazon-bedrock",
   "time":{"created":1783097463410,"completed":1783097465291},"finish":"stop"}
  ```
  i.e. per-message cost USD, token split incl. reasoning and cache read/write, provider/model, latency (completed − created). Read-only `sqlite3 file:...?mode=ro` polling or an fs-watch on the WAL is a robust scrape.
- **Server:** `opencode serve` (default `127.0.0.1:4096`) exposes REST (`GET /session`, `GET /session/:id/message`, `POST /session/:id/message`, agents, config) + **SSE `/event` and `/global/event`** streams (first event `server.connected`, then bus events incl. message updates) + OpenAPI 3.1 at `/doc`. When the harness launches OpenCode anyway (feature 2/4), running it in serve mode gives push-based observability for free.
- **Community:** `opencode stats`-style tooling exists (`opencode-tokenscope`, `tokscale`, `opencode-token-tracker` plugin with budget alerts, `ocmonitor`); ccusage now also parses OpenCode data. These confirm the scrape approach and can be cannibalized for schema details rather than adopted wholesale.

### 7. LM Studio server stats

- OpenAI-compatible `/v1/*` returns standard `usage` (prompt/completion tokens); the **native REST API** adds performance stats per response: `stats: {tokens_per_second, time_to_first_token, generation_time, stop_reason}` plus model metadata (quantization, arch, max context, loaded state). `/api/v0` (0.3.6+) is beta; LM Studio 0.4.0 shipped the official `/api/v1/*`. Endpoints: `GET /api/v0/models` (also the cheapest health check), `POST /api/v0/chat/completions`, `/completions`, `/embeddings`.
- CLI: `lms server status`, `lms ps` (loaded models + memory), `lms ls`, `lms log stream` (live request log). Verified present at `~/.lmstudio/bin/lms`; server currently **not running** — the collector must degrade gracefully (health poll with 1–2 s timeout, "backend down" state on the dashboard, optional `lms server start` action from the harness).
- There is no persistent usage database exposed by LM Studio; the reliable pattern is: harness routes its own LM Studio calls through a thin recording client (capture `usage` + `stats` per call), plus `lms log stream` for traffic originating elsewhere (e.g. the existing `local-llm` MCP server).

### 8. Presentation patterns worth stealing (Langfuse, LangSmith, Helicone, AgentOps, Braintrust) and ccusage

- **Langfuse** (OSS, self-hostable): trace → observation tree with per-span model, tokens, USD, latency; session grouping; dashboards for token cost/session, cache efficiency, latency distributions. Self-hosting is heavy (ClickHouse + Postgres + Redis) — disproportionate for one laptop.
- **LangSmith**: deepest run-tree/replay UX; near-zero overhead; SaaS-first.
- **Helicone**: proxy-based; its winning UI is a dense *requests table* (time, model, tokens in/out, cost, latency, status, cache hit) with drill-in — the right center-of-gravity for a harness "recent activity" view.
- **AgentOps**: session replay timelines (spans over wall-clock) for multi-agent runs — the right model for visualizing multi-agent workflows (feature 4).
- **Braintrust**: eval-centric (scores over time, regression gates); relevant later for skill-optimality scoring, not for the core dashboard. Generous free tier if hosted evals ever wanted.
- **Common metric vocabulary across all five**: cost/tokens per trace & per day, p50/p95/p99 latency, TTFT, error rate, cache hit rate = `cache_read_tokens / (input_tokens + cache_read_tokens)`.
- **ccusage** (the de-facto community standard, 4.8k★): parses Claude Code JSONL (and now Codex/OpenCode/Gemini/…) locally; `daily/weekly/monthly/session/blocks` reports; `blocks` reconstructs **5-hour billing windows** with live burn-rate and projected exhaustion; `statusline` mode; prices via bundled LiteLLM data with offline mode and per-model overrides. Two lessons: (a) 5h-block reconstruction from transcript timestamps is proven; (b) pricing tables should come from LiteLLM's dataset, pinned and overridable. Companion tools: ccflare, Claude-Code-Usage-Monitor, claude-code-otel Grafana stacks.

---

## Options considered

### Option A — OTEL-only ("subscribe everything")

**How:** enable `CLAUDE_CODE_ENABLE_TELEMETRY=1` + OTLP for every Claude account into a local collector (otel-collector or a tiny custom OTLP receiver) → store → dashboard.

- **Pros:** richest structured signal (cost, effort, skill/agent/MCP attribution, permission decisions, hook timings, api errors/retries, refusals); push-based, near-real-time (5 s events); versioned/documented contract; per-account resource attributes solve multi-account tagging cleanly.
- **Cons:** zero history before enablement; only covers Claude Code (OpenCode/LM Studio don't emit compatible OTEL out of the box); needs a collector process; custom skill names redacted unless `OTEL_LOG_TOOL_DETAILS=1`; USD figures are *estimates* of API-equivalent cost, not subscription spend.
- **Risks:** beta tracing may change; `user.email`/account UUIDs on by default (hygiene risk if the store ever leaks into the public repo); OTLP endpoint misconfig silently drops data.

### Option B — Scrape-only ("files are the API")

**How:** fs-watch + parse `~/.claude/projects/**/*.jsonl` (per account config dir), `usage-data/{facets,session-meta}`, `history.jsonl`; poll `opencode.db`; ccusage-style pricing math.

- **Pros:** full history back to first install; zero configuration of the agents themselves; works identically for MAX_A/MAX_B/ENT (each has its own config dir when isolated); transcripts contain tool inputs (file paths!) that OTEL redacts — required anyway for the live context graph; proven by ccusage/tokenscope at scale.
- **Cons:** undocumented, occasionally-shifting schemas (ccusage tracks breakage constantly); no permission/hook/api-error detail that only OTEL has; polling latency unless fs-watching; JSONL parse cost on very large transcripts (hundreds of MB observed in the wild).
- **Risks:** Anthropic could move transcripts into the encrypted session store (a `sessions/` dir already exists); OpenCode moved JSON→SQLite once already (verified) and can move again — isolate parsers behind adapters.

### Option C — Adopt a hosted/self-hosted LLM-obs platform (Langfuse/Helicone/LangSmith/AgentOps)

**How:** point Claude Code OTLP at Langfuse's OTLP endpoint (or run traffic through Helicone's proxy) and embed their UI.

- **Pros:** polished trace UI immediately; no dashboard build.
- **Cons:** none of them answer the questions that matter here — Max quota remaining, 5h-block burn, Bedrock real USD, LM Studio health; SaaS = transcripts/prompts leave the machine (conflicts with the local-first ethos and [X2] caution); self-hosted Langfuse is a ClickHouse+Redis+Postgres stack on a laptop that also needs LM Studio RAM [X3]; proxying Anthropic OAuth traffic through third parties is ToS-fragile and jeopardizes [X1].
- **Risks:** platform lock-in for the harness's core UI; upgrade churn.

### Option D — Bedrock cost sub-options

1. **Cost Explorer poll only:** authoritative but ~24 h stale and unattributed within the shared dev account. 2. **CUR 2.0:** most detailed, S3+Athena plumbing, slow to stand up. 3. **Application inference profile + tags:** precise attribution of harness traffic, near-zero cost, but needs one-time IaC in AWS_DEV_ACCOUNT_ID and OpenCode model-ARN change. 4. **CloudWatch metrics/invocation logs:** near-real-time tokens→USD estimate + latency/throttles, but estimate-grade and (for logs) an infra mutation. 5. **Client-side (OpenCode `cost` field):** instant, already exists, covers only harness/OpenCode traffic.
**Best:** 5 for real-time, 1 for truth, 3 for attribution, 4 (metrics only) for latency/throttle health; skip 2 initially.

### Option E — Quota-reading sub-options

1. **Statusline hook capture** (v1.2.80+ JSON with `rate_limits`): supported, per-account, pushes on every active session; no token handling. Gap: silent accounts emit nothing (stale gauge). 2. **`/api/oauth/usage` poll:** works for idle accounts; undocumented, 429-prone, needs OAuth token from macOS Keychain per account. 3. **Parsing `/usage` screen via PTY:** brittle, don't. 4. **ccusage blocks math:** estimates burn from transcripts but cannot know Anthropic's actual window accounting; good for *projection*, not for *truth*.
**Best:** 1 as primary, 2 as ≤1/10-min idle-account fallback with backoff, 4 for burn-rate projection UX.

---

## Recommendation (opinionated)

**Build a small local "collector" daemon + one embedded analytics store + the harness's own dashboard. Subscribe where push exists, scrape where files exist, poll only AWS and idle-account quota.** Concretely:

### Collection architecture per backend

| Backend | Mode | Concrete source | Freshness |
|---|---|---|---|
| Claude Code (MAX_A, MAX_B, ENT) | **Subscribe** | OTLP → `http://127.0.0.1:4318` (http/protobuf); per-account env in each isolated config dir: `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_LOG_TOOL_DETAILS=1`, `OTEL_RESOURCE_ATTRIBUTES=account=MAX_A` (etc.), `OTEL_METRICS_INCLUDE_ACCOUNT_UUID=false` | 5–60 s |
| Claude Code (history + context graph + facets) | **Scrape** | fs-watch `<config-dir>/projects/**/*.jsonl` (append-parse), `<config-dir>/usage-data/{facets,session-meta}/*.json`, `history.jsonl` | real-time (fs events) |
| Claude quota | **Subscribe + poll** | statusline command tees stdin JSON (`rate_limits.*`) to `~/.last-aibender/quota/<account>.json`; fallback `GET api.anthropic.com/api/oauth/usage` (beta header, Keychain token) every 10–15 min only for accounts with no session in the last N min | seconds / 15 min |
| ENT org analytics (optional) | Poll | `/v1/organizations/analytics/…` **iff** an Admin API key is ever provided; otherwise skip | daily |
| OpenCode / Bedrock (traffic) | **Scrape + subscribe** | `sqlite3 file:~/.local/share/opencode/opencode.db?mode=ro` — `message.data` (cost, tokens, provider, latency), `session` (lineage); when harness launches OpenCode, prefer `opencode serve` + SSE `GET /event` | real-time / poll 30 s |
| Bedrock (真 USD) | **Poll** | Cost Explorer `GetCostAndUsage` daily granularity, filter Bedrock service (+ inference-profile tag once created), 1–2×/day; CloudWatch `AWS/Bedrock` `GetMetricData` (tokens, `TimeToFirstToken`, `InvocationThrottles`) every 5–15 min while OpenCode active — via the same SSO profile `oc-bedrock` uses | 24 h / 5 min |
| LM Studio | **Inline + poll** | record `usage` + `stats` (tokens_per_second, TTFT) from every harness-routed call to `/api/v0//api/v1`; health = `GET /api/v0/models` (2 s timeout); `lms log stream` sidecar for non-harness traffic | real-time |

Storage: **one SQLite (WAL) database** owned by the collector (DuckDB acceptable; SQLite preferred since OpenCode proves the pattern and the frontend can read it read-only). No ClickHouse, no Prometheus server — [X3] says don't burden the laptop; an in-process OTLP receiver (fastify/hono handler for `/v1/metrics` + `/v1/logs` protobuf/JSON) is ~200 lines and removes the otel-collector dependency.

### Harness metrics schema (normalized envelope)

One `events` fact table; everything else is a rollup or dimension:

```sql
events(
  ts            INTEGER,      -- epoch ms
  backend       TEXT,         -- claude_code | opencode | lmstudio
  account       TEXT,         -- MAX_A | MAX_B | ENT | AWS_DEV | LOCAL
  session_id    TEXT, workstream_id TEXT,        -- [X4] lineage key
  prompt_id     TEXT,         -- unit-of-work chain (OTEL prompt.id / parentUuid chain)
  event_type    TEXT,         -- api_request | tool_result | skill_activated | quota_snapshot | ...
  model         TEXT, provider TEXT,
  input_tokens  INTEGER, output_tokens INTEGER,
  cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
  cost_estimated_usd REAL,    -- client/OTEL/LiteLLM-priced
  cost_actual_usd    REAL,    -- Cost Explorer reconciliation (Bedrock only, backfilled)
  latency_ms REAL, ttft_ms REAL,
  tool_name TEXT, skill_name TEXT, agent_name TEXT, mcp_server TEXT,
  success INTEGER, error_type TEXT, status_code INTEGER, attempt INTEGER,
  file_refs JSON,             -- context-graph edges (paths read/written)
  raw_ref TEXT                -- pointer back to JSONL line / db row / OTLP batch
)
quota_snapshots(ts, account, window TEXT /*5h|7d|7d_sonnet*/, used_pct REAL, resets_at INTEGER, source TEXT)
session_outcomes(session_id, account, outcome TEXT, satisfaction TEXT, frictions JSON, source TEXT /*insights_facet|heuristic*/)
prices(model, provider, in_per_mtok REAL, out_per_mtok REAL, cache_read_per_mtok REAL, cache_write_per_mtok REAL, as_of TEXT)  -- seeded from LiteLLM dataset, overridable
```

Dedup key: (`backend`, `raw_ref`) — OTEL and JSONL will both report the same api_request; prefer JSONL as source of truth for tokens (it has the cache-TTL split), OTEL for attribution fields, joined on `request_id`/`session_id`.

### Skill FREQUENCY and OPTIMALITY — measurable definitions

Frequency (per skill, per account, per week):
- `invocations` = count of `skill_activated` events (OTEL) ∪ `Skill` tool_use blocks in transcripts (dedup by tool_use_id); split by `invocation_trigger` (user-slash vs claude-proactive vs nested).
- `proactive precision` = proactive invocations not followed by user interruption/cancel within the same prompt chain ÷ proactive invocations (mines `queue-operation`/interrupt markers + next-user-message sentiment).

Optimality proxies (computed over the `prompt.id` chain from invocation to the next user prompt, and over the session):
- **Success rate** = chains where (a) no `tool_result.success=false` terminal failure, (b) no `api_error`/`api_retries_exhausted`, and (c) the session's `/insights` facet `outcome ∈ {achieved, mostly_achieved}` when the skill was a primary activity. Facets are Haiku-labeled and cached locally — free labels, refreshed by running `/insights` periodically.
- **Retry/correction rate** = (user messages within 2 turns that re-state or correct the same request + re-invocations of the same skill within the session + `Edit`-after-`Edit` churn on the same file) ÷ invocations. The correction-intent classifier is an ideal `local_classify` job for the local model (per the delegation policy) — cheap, high-volume, verifiable.
- **Tokens-per-outcome** = Σ(all four token classes, weighted by price) across the chain ÷ successful outcomes; compare within a `goal_category` (from facets) so unlike tasks aren't compared.
- **Latency-to-done** = wall-clock from `skill_activated` to chain quiescence; report p50/p95.
- Composite "optimality score" = success rate × (1 − correction rate) ÷ normalized tokens-per-outcome — rank skills, flag the worst quartile for prompt surgery.

### Top 10 dashboard signals (lead with these, in order)

1. **Quota gauges per account** — 5h and 7-day `used_percentage` + `resets_at` countdown for MAX_A / MAX_B / ENT (statusline feed; stale-marker if >15 min old).
2. **Current 5h-block burn rate** — tokens/min and projected exhaustion time per active account (ccusage-blocks math over live JSONL).
3. **Bedrock real USD** — month-to-date + yesterday, by model (Cost Explorer), with client-side estimate overlay for today (OpenCode `cost` sums).
4. **Normalized spend/day by backend** — API-equivalent USD (OTEL `cost.usage` / LiteLLM pricing) stacked: MAX_A, MAX_B, ENT, Bedrock, LM Studio($0) — shows what the subscriptions are "worth".
5. **Cache hit rate** — `cache_read/(input+cache_read)` per backend/model, with 5m vs 1h cache-TTL split (transcripts) — the single biggest cost/quota lever.
6. **Latency percentiles** — api_request `duration_ms` p50/p95 per backend/model + TTFT (LM Studio stats; Bedrock `TimeToFirstToken`).
7. **Error & retry health** — api_error rate, retries-exhausted count, tool_result failure rate, Bedrock `InvocationThrottles`.
8. **Skill leaderboard** — frequency × success rate × tokens-per-outcome, worst-quartile flags.
9. **Session outcomes** — facet mix (achieved/partial/failed), satisfaction trend, top friction categories.
10. **Local-offload ratio** — share of requests/tokens served by LM Studio vs paid backends (target metric for the qwen-producer policy), plus LM Studio up/down state.

---

## Implications for the harness

- **[X1] Multi-account:** per-account isolation (separate `CLAUDE_CONFIG_DIR`-style homes) is exactly what makes observability clean — each account gets its own `projects/`, statusline quota file, and OTEL resource attribute. The collector's account registry maps config-dir → placeholder label; nothing identity-bearing leaves the store. ccusage already proves multi-dir parsing works.
- **[X2] Public repo:** the observability store and quota files live *outside* the repo (e.g. `~/.last-aibender/`); OTEL must run with `OTEL_METRICS_INCLUDE_ACCOUNT_UUID=false` and the ingest layer must drop `user.email`/`organization.id` attributes; any fixture/sample committed for tests must be synthesized. Keychain items (`bedrock-openai-api-key`, Claude Code credentials) are referenced by name only, values read at runtime.
- **[X3] Colima/k3s:** the collector should be **host-native** (launchd), not in k3s — it must fs-watch `~/.claude*` paths and reach `127.0.0.1:1234` (LM Studio) and `127.0.0.1:4318` (OTLP from host processes); containerizing it adds bind-mount and host-networking fragility for zero gain. If the frontend runs in k3s later, it reads the SQLite store via a thin host API.
- **[X4] Workstreams:** the lineage data needed already exists — Claude transcripts have `sessionId` + `parentUuid` chains and resume/continue `start_type`; OpenCode `session.parent_id` is a literal parent pointer. The `workstream_id` column in the schema is populated by the harness's own session-launch bookkeeping and joined to these native keys; observability and workstream lineage should share one store.
- **Live context graph (feature 6):** the same JSONL fs-watch pipeline that feeds metrics yields file-reference edges in real time (tool_use inputs of Read/Edit/Write/Glob and `at_mention` events) — build one tailer, fan out to both consumers.
- **Launch features (2–4):** every harness-launched run should stamp `OTEL_RESOURCE_ATTRIBUTES` (Claude) / inference-profile ARN (Bedrock) / recording client (LM Studio) so attribution is by construction, not inference.
- **Sequencing:** transcripts+OpenCode scrape and quota statusline are pure-read and can ship first; OTEL enablement is a per-account env change (config edit, gated); Bedrock inference profile + Cost Explorer polling need AWS IaC and an explicit go-ahead in AWS_DEV_ACCOUNT_ID (External System Write Policy applies).
- **Failure tolerance:** every source must be optional at runtime — LM Studio down (verified now), OpenCode not serving, an account logged out, AWS SSO expired — the dashboard shows per-source freshness/health rather than erroring.

## Sources

- Claude Code OTEL/monitoring docs: https://code.claude.com/docs/en/monitoring-usage
- Agent SDK observability: https://code.claude.com/docs/en/agent-sdk/observability
- Statusline docs (rate_limits JSON input): https://code.claude.com/docs/en/statusline ; field guide: https://gist.github.com/AKCodez/ffb420ba6a7662b5c3dda2edce7783de ; https://julianpaul.me/blog/claude-code-statusline-model-context-cost-limits-in-one-line/
- Usage limits: https://support.claude.com/en/articles/9797557-usage-limit-best-practices ; https://www.morphllm.com/claude-code-usage-limits ; https://inventivehq.com/blog/claude-code-rate-limits-explained ; https://knightli.com/en/2026/06/10/claude-usage-limits-5-hour-weekly-tokens/
- OAuth usage endpoint (undocumented): https://ianlpaterson.com/blog/tracking-claude-codex-gemini-quotas-from-one-script/ ; rate-limit bug https://github.com/anthropics/claude-code/issues/31637 ; feature request https://github.com/anthropics/claude-code/issues/44328 ; https://github.com/anthropics/claude-code/issues/45392
- ccusage: https://github.com/ryoppippi/ccusage ; https://ccusage.com/guide/getting-started ; ecosystem overview https://claudefa.st/blog/tools/monitors/claude-code-usage-monitor ; https://www.toriihq.com/articles/five-claude-code-usage-dashboards-and-monitoring-tools
- /insights local report + facets: https://www.zolkos.com/2026/02/03/deep-dive-how-claude-codes-insights-command-works.html ; https://angelo-lima.fr/en/claude-code-insights-command/ ; https://blog.vincentqiao.com/en/posts/claude-code-insights/
- Enterprise analytics: https://claude.com/blog/giving-admins-more-visibility-and-control-over-claude-usage-and-spend ; https://support.claude.com/en/articles/13694757-get-started-with-the-claude-enterprise-analytics-api ; https://www.finout.io/blog/anthropics-enterprise-analytics ; https://www.anthropic.com/news/claude-code-on-team-and-enterprise
- Admin/Usage & Cost API (API orgs): https://docs.anthropic.com/en/api/administration-api ; https://docs.anthropic.com/en/api/usage-cost-api ; https://www.minware.com/blog/how-to-get-reporting-data-out-of-claude-code
- Bedrock cost: https://docs.aws.amazon.com/bedrock/latest/userguide/cost-management.html ; https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-understanding-cur-data.html ; https://aws.amazon.com/blogs/machine-learning/introducing-granular-cost-attribution-for-amazon-bedrock/ ; https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles.html ; https://aws.amazon.com/blogs/machine-learning/manage-multi-tenant-amazon-bedrock-costs-using-application-inference-profiles/ ; IAM-principal cost allocation https://aws.amazon.com/blogs/aws-cloud-financial-management/track-amazon-bedrock-costs-by-caller-identity-with-iam-based-cost-allocation/ ; https://aws.amazon.com/bedrock/pricing/
- Bedrock CloudWatch: https://docs.aws.amazon.com/bedrock/latest/userguide/monitoring-runtime-metrics.html ; TTFT/quota metrics https://aws.amazon.com/blogs/machine-learning/improve-operational-visibility-for-inference-workloads-on-amazon-bedrock-with-new-cloudwatch-metrics-for-ttft-and-estimated-quota-consumption/ ; per-user CC-on-Bedrock costs https://zenn.dev/kiiwami/articles/claude_code_bedrock_cost_pattern?locale=en ; CC usage via CloudWatch+OTEL https://aws.amazon.com/blogs/mt/analyzing-claude-code-usage-with-cloudwatch-and-opentelemetry/
- OpenCode: https://opencode.ai/docs/server/ ; https://opencode.ai/docs/cli/ ; community trackers https://github.com/ramtinJ95/opencode-tokenscope ; https://github.com/junhoyeo/tokscale ; https://github.com/tongsh6/opencode-token-tracker
- LM Studio: https://lmstudio.ai/docs/developer/rest/endpoints ; https://lmstudio.ai/blog/0.4.0 (native /api/v1) ; https://lmstudio.ai/docs/api/rest-api
- Obs platforms: https://www.digitalapplied.com/blog/agent-observability-platforms-langsmith-langfuse-arize-2026 ; https://latitude.so/blog/best-ai-agent-observability-tools-2026-comparison ; https://appscale.blog/en/blog/langfuse-vs-langsmith-vs-braintrust-vs-helicone-2026 ; https://aimultiple.com/agentic-monitoring
- OSS Claude Code OTEL dashboards: https://github.com/ColeMurray/claude-code-otel ; https://signoz.io/docs/claude-code-monitoring/ ; https://tcude.net/how-i-monitor-my-claude-code-usage-with-grafana-opentelemetry-and-victoriametrics/ ; https://github.com/TechNickAI/claude_telemetry

## Open questions

1. **Statusline vs multiple simultaneous sessions per account:** does each session's statusline tick report identical account-level `rate_limits` (expected) — verify once parallel sessions run, and pick last-writer-wins per account.
2. **`/api/oauth/usage` stability:** exact 429 thresholds per account, and whether the `oauth-2025-04-20` beta header version changes; needs a controlled probe in Stage 2 (one account, low frequency).
3. **ENT admin access:** can the user obtain (or request) an Enterprise Admin API key for org analytics, or is ENT permanently "local-signals-only"? Also whether ENT org policy already enforces managed OTEL settings that would conflict with harness-managed env.
4. **Transcript schema durability:** how often do `projects/*.jsonl` line schemas change across Claude Code releases (ccusage changelog is a good canary); do encrypted `sessions/` stores eventually replace plaintext transcripts?
5. **OpenCode SSE event vocabulary:** the docs don't enumerate bus event types — inspect `/doc` OpenAPI on a running `opencode serve` to map message-update events before relying on subscribe-mode.
6. **Bedrock inference-profile adoption:** confirm OpenCode's `amazon-bedrock` provider accepts an application-inference-profile ARN as `modelID` (it should, Converse API supports profile ARNs), and whether the OpenAI-compat Bedrock endpoint (`bedrock-mantle…/openai/v1`) traffic can also be tagged (likely only via IAM-principal attribution, since the API-key path has no profile ARN).
7. **/insights refresh automation:** can facet generation be triggered headlessly (`claude /insights` in print mode?) on a schedule without burning meaningful quota (it runs Haiku over sessions), and does it work identically on ENT accounts with org policies?
8. **OTEL cost.usage semantics on subscription auth:** confirm the USD figure emitted for Max/ENT OAuth sessions equals API-list-price equivalence (community reports say yes) so signal #4 is labeled honestly as "API-equivalent value", never "spend".
9. **LM Studio non-harness traffic:** is `lms log stream` machine-parseable enough (JSON mode?) to capture calls from the existing `local-llm` MCP server, or should that MCP server be pointed through the harness's recording proxy instead?
10. **Weekly-cap Opus/Sonnet split:** the OAuth endpoint exposes `seven_day_sonnet` — confirm whether Max plans now meter Opus and Sonnet weekly buckets separately per account plan generation, and mirror whatever buckets `/usage` shows into `quota_snapshots.window`.
