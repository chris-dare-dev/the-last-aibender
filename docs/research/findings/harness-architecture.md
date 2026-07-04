# Harness architecture: driving subscription Claude, OpenCode, and LM Studio programmatically

> Stage-1 discovery research for **the-last-aibender**. Research date: 2026-07-03.
> Ground truth verified on the target machine: Claude Code CLI **2.1.193**, OpenCode **1.17.13**, LM Studio `lms` CLI installed (server not running). All account references use placeholders: **MAX_A**, **MAX_B** (Claude Max), **ENT** (Claude Enterprise), **AWS_DEV_ACCOUNT_ID** (Bedrock dev account).

---

## TL;DR

1. **Use the TypeScript Claude Agent SDK as the core session engine.** It is the sanctioned programmatic surface over Claude Code, exposes typed streaming messages, in-process hooks, `canUseTool` approval callbacks, resume/fork, and per-`query()` env injection.
2. **Subscription auth works through the SDK today**: the SDK spawns the Claude Code CLI, which resolves subscription OAuth from its config dir. Anthropic's planned June 15, 2026 move of Agent SDK / `claude -p` usage to a separate paid credit pool was **paused on June 15–16, 2026** — subscription limits currently apply unchanged. Policy risk remains; build cost/usage accounting from day one.
3. **Parallel multi-account [X1]: one `CLAUDE_CONFIG_DIR` per account** (`~/.claude-max-a`, `~/.claude-max-b`, `~/.claude-ent`), injected per spawned session via the SDK's `env` option. Each dir holds independent OAuth credentials → three accounts run concurrently in one harness process with zero re-login. Fallback: one `claude setup-token` (1-year, inference-only) per account in `CLAUDE_CODE_OAUTH_TOKEN`.
4. **Event pipe**: SDK message stream (primary) + `type:"http"` hooks POSTing to a harness endpoint (lifecycle + live file-touch events for the context graph) + JSONL transcript tailing (sessions the harness didn't launch) + an OTLP receiver for Claude Code OTel metrics/logs (tokens, cost, cache hit rate, per-skill attribution).
5. **OpenCode**: drive via `opencode serve` (HTTP + SSE `/global/event`, OpenAPI 3.1 at `/doc`) through `@opencode-ai/sdk`; never wrap its TUI.
6. **LM Studio**: OpenAI-compatible `/v1` for inference, native `/api/v0` for model state + perf stats, `lms` CLI for lifecycle (`lms server start`, `lms ps`). Harness must health-check 127.0.0.1:1234 and degrade gracefully (server is currently down on this machine).
7. **Do not PTY-wrap interactive `claude`** for orchestration; offer an optional embedded terminal (node-pty + xterm.js) only as a pass-through convenience feature.

---

## Current landscape

### 1. The Claude Agent SDK (TypeScript + Python)

The Agent SDK (renamed from "Claude Code SDK" in late 2025) is Anthropic's official library for running the full Claude Code agent loop programmatically — same tools, same context management, same filesystem config ([overview](https://code.claude.com/docs/en/agent-sdk/overview)).

**Packages**
- TypeScript: `@anthropic-ai/claude-agent-sdk` (npm). *Bundles a native Claude Code binary for the platform as an optional dependency* — no separate CLI install needed.
- Python: `claude-agent-sdk` (PyPI, Python ≥ 3.10).

**Execution model.** Both SDKs are wrappers that spawn the Claude Code runtime as a child process and speak a newline-delimited-JSON protocol over stdio (the same `--input-format stream-json` / `--output-format stream-json` surface the CLI exposes, plus undocumented `control_request`/`control_response` frames used for interrupts, permission callbacks, and hook callbacks). This matters architecturally: **anything the SDK can do, the CLI protocol can do — but the SDK gives you a stable, typed, supported facade over it.**

**Capabilities relevant to the harness** (verified against docs, July 2026):

| Capability | TypeScript | Python |
|---|---|---|
| One-shot agent run | `query({ prompt, options })` async iterator | `query(prompt=..., options=...)` async generator |
| Multi-turn in-process | `continue: true` per call (the experimental V2 `createSession()` API was **removed** in TS SDK 0.3.142) | `ClaudeSDKClient` (holds session across `client.query()` calls) |
| Resume by ID | `options.resume` | `options=ClaudeAgentOptions(resume=...)` |
| Fork lineage | `options.forkSession: true` (with `resume`) | `fork_session=True` |
| Session enumeration | `listSessions()`, `getSessionMessages()`, `getSessionInfo()`, `renameSession()`, `tagSession()` | `list_sessions()`, `get_session_messages()`, `get_session_info()`, `rename_session()`, `tag_session()` |
| In-memory-only sessions | `persistSession: false` | not available (always persists) |
| Tool gating | `canUseTool` callback, `allowedTools`, `disallowedTools`, `permissionMode` | same (snake_case) |
| Hooks (in-process callbacks) | `hooks: { PreToolUse: [{ matcher, hooks: [fn] }], ... }` | `HookMatcher(...)` |
| Subagents | `agents: { name: { description, prompt, tools } }` + `Agent` in `allowedTools`; subagent messages carry `parent_tool_use_id` | `AgentDefinition(...)` |
| MCP servers | `mcpServers` option (stdio/HTTP/SSE + in-process SDK-defined servers) | `mcp_servers` |
| Filesystem config (skills, commands, CLAUDE.md, plugins) | loaded from `.claude/` + `~/.claude/` by default; restrict with `settingSources` | `setting_sources` |
| Structured output | JSON-schema-validated `structured_output` | same |
| Per-session env / executable | `options.env`, `pathToClaudeCodeExecutable` | same |

The session-management surface ([sessions doc](https://code.claude.com/docs/en/agent-sdk/sessions)) is unusually rich and maps almost 1:1 onto the [X4] "workstreams" concept: **fork = branch, resume = continue, and the SDK exposes list/rename/tag primitives** for building a custom session organizer. Session files live at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` (or `$CLAUDE_CONFIG_DIR/projects/...` when the env var is set) where `<encoded-cwd>` is the absolute cwd with every non-alphanumeric character replaced by `-`. Resume requires a matching cwd — a hard constraint the workstream layer must track.

**Which language?** TypeScript is the first-class citizen: it bundles the CLI binary, gets features first (e.g. `persistSession: false` is TS-only), and shares a runtime with any web frontend the harness will have. Python's `ClaudeSDKClient` is ergonomically nicer for long-lived multi-turn holding, but everything it does is achievable in TS with `resume`/`continue`.

### 2. Auth model and the 2026 policy situation (the load-bearing question)

**How auth actually resolves.** The SDK itself has no auth; the spawned CLI resolves credentials in this precedence order ([authentication doc](https://code.claude.com/docs/en/authentication)):

1. Cloud provider (`CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY`)
2. `ANTHROPIC_AUTH_TOKEN` (bearer, for gateways)
3. `ANTHROPIC_API_KEY`
4. `apiKeyHelper` script output (refreshed every 5 min or on 401; TTL via `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`)
5. `CLAUDE_CODE_OAUTH_TOKEN` (long-lived token from `claude setup-token`)
6. **Subscription OAuth from `/login`** — the default for Pro/Max/Team/Enterprise

So the Agent SDK **does** ride the Claude Code OAuth subscription login whenever levels 1–5 are absent. Credential storage: macOS Keychain (encrypted); Linux/Windows `.credentials.json` under the config dir. `claude auth status` / `claude auth login|logout` exist as CLI subcommands (verified locally on 2.1.193).

**`claude setup-token`**: generates a **one-year OAuth token** tied to the subscription (Pro/Max/Team/Enterprise required), intended for "CI pipelines and scripts where browser login isn't available." It is inference-only (no Remote Control) and — critically — **`--bare` mode does not read `CLAUDE_CODE_OAUTH_TOKEN`** (bare mode accepts only `ANTHROPIC_API_KEY`/`apiKeyHelper`). Usage counts against the subscription's limits, not a separate API invoice.

**The policy (as of 2026-07-03):**

- The [legal & compliance page](https://code.claude.com/docs/en/legal-and-compliance) states: *"OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications"*, and *"Anthropic does not permit third-party developers to offer Claude.ai login or to route requests through Free, Pro, or Max plan credentials **on behalf of their users**."* The same page says advertised Pro/Max limits *"assume ordinary, individual usage of Claude Code **and the Agent SDK**"* — i.e. individual Agent SDK usage under a subscription is explicitly anticipated by the usage policy.
- The [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) tells **developers shipping products to other users** to use API keys: *"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products."*
- **The May→June 2026 whiplash**: on May 13–14, 2026 Anthropic announced that from **June 15, 2026**, Agent SDK usage, `claude -p`, Claude Code GitHub Actions, and *"third-party apps that authenticate with your Claude subscription through the Agent SDK"* would stop drawing from subscription limits and instead consume a separate monthly credit ($20 Pro / $100 Max 5x / $200 Max 20x) **billed at standard API rates** (a 12–175x effective price increase for heavy headless users, per community analysis). On **June 15–16, 2026 Anthropic paused the change**: subscribers were told it is *"not taking effect yet"*, that ACP usage, `claude -p`, the Agent SDK, and third-party apps *"continue to work with Claude subscriptions exactly as they did before"*, and that advance notice will precede any future change ([Zed's summary](https://zed.dev/blog/anthropic-subscription-changes), [The New Stack](https://thenewstack.io/anthropic-agent-sdk-credits/), [digitalapplied](https://www.digitalapplied.com/blog/anthropic-claude-credit-overhaul-june-15-2026)).

**Reading for this project**: the-last-aibender is a *personal harness operated by the subscription owner on their own machine* — it is the account holder using Claude Code/Agent SDK, not a third party offering claude.ai login to others. That is squarely inside "ordinary, individual usage." Two real risks remain: (a) the credit-pool split will likely return in some revised form — headless/SDK usage may get its own metered budget, so the harness's per-account usage accounting is not optional; (b) automated volume that stops looking "ordinary and individual" (e.g. unattended 24/7 fan-out) could trip enforcement. ENT adds a third wrinkle: Enterprise admins control managed policy settings and could restrict headless usage or `setup-token` for org members — the harness must treat ENT capabilities as discoverable at runtime, not assumed.

### 3. The `claude` CLI headless surface (verified locally, v2.1.193)

`claude -p` runs the full agent non-interactively; **all** CLI options work with it ([headless doc](https://code.claude.com/docs/en/headless)). The flags that matter for a harness:

| Flag | Behavior |
|---|---|
| `-p, --print` | Non-interactive; skips workspace-trust dialog; invalid settings files silently ignored |
| `--output-format text\|json\|stream-json` | `json` includes `result`, `session_id`, `total_cost_usd`, per-model usage; `stream-json` = NDJSON event stream |
| `--include-partial-messages` | Adds `stream_event` lines with raw API deltas (token-by-token text) |
| `--include-hook-events` | Emits hook lifecycle events into the stream-json output |
| `--input-format stream-json` | **Realtime streaming input** — keep stdin open, send user messages as NDJSON; this is the bidirectional channel the SDK uses |
| `--replay-user-messages` | Echoes stdin user messages back on stdout for acknowledgment (stream-json both directions) |
| `--session-id <uuid>` | Pin a specific session UUID (harness-generated IDs possible) |
| `-r, --resume [id]` / `-c, --continue` | Resume specific / most recent session (cwd-scoped lookup) |
| `--fork-session` | With resume/continue: new session ID, copied history — lineage primitive |
| `--no-session-persistence` | Print-mode sessions not written to disk |
| `--permission-mode` | `acceptEdits`, `auto`, `bypassPermissions`, `default`, `dontAsk`, `plan` |
| `--allowedTools / --disallowedTools / --tools` | Permission-rule syntax, e.g. `Bash(git diff *)` |
| `--agents <json>` | Define custom subagents inline |
| `--json-schema` | Structured output with schema validation |
| `--max-budget-usd` | Hard dollar cap per invocation (print mode) |
| `--fallback-model <list>` | Auto-fallback when primary is overloaded (print mode) |
| `--settings <file-or-json>` / `--setting-sources user,project,local` | Inject/restrict configuration |
| `--mcp-config` / `--strict-mcp-config` | Per-invocation MCP wiring |
| `--bare` | Skip hooks/plugins/CLAUDE.md/keychain — **API-key auth only**; recommended default for scripted calls in future releases, but **incompatible with subscription OAuth**, so the harness generally must NOT use it for MAX_A/MAX_B/ENT runs |
| `--bg` + `claude agents --json` | Dispatch background agent sessions and script their status |
| `--remote-control` | Interactive session controllable remotely (inference-only tokens can't use it) |

Notable stream-json events documented: `system/init` (model, tools, MCP servers, plugins loaded — first event), `system/api_retry` (with `error` categories like `rate_limit`, `overloaded`, `oauth_org_not_allowed`), `system/plugin_install`. Result messages carry `total_cost_usd` and per-model usage including cache read/creation tokens — the direct feed for the observability pane's cache-hit-rate metric.

**Skills in headless mode**: *"User-invoked skills and custom commands work in `-p` mode: include `/skill-name` in the prompt string and Claude Code expands it before running."* Interactive-only built-ins (`/login`) don't work; settings can be flipped via `/config key=value` in the prompt. This is the documented, supported way to trigger skills programmatically — no PTY needed.

**Interactive PTY wrapping** (running full-screen `claude` under node-pty and scraping the TUI) is the alternative the ecosystem used before stream-json matured. In 2026 it buys nothing for orchestration: no structured events, ANSI-parsing fragility, breaks on every UI redesign, and permission dialogs become screen-scraping problems. Its only remaining value is *showing the real Claude Code UI* inside the harness as an embedded terminal.

### 4. Event surfaces a frontend can subscribe to

Four independent, combinable surfaces exist:

**(a) SDK / stream-json message stream** — per-session, in-band: `system/init`, `assistant` (with content blocks incl. `tool_use`), `user` (tool results), `stream_event` partial deltas, `result` (cost/usage/duration). Lowest-latency, richest source for sessions the harness launches.

**(b) Hooks** — the 2026 hook system ([hooks reference](https://code.claude.com/docs/en/hooks)) is far bigger than the original 2025 set. Events now include: `SessionStart`, `SessionEnd`, `Setup`, `UserPromptSubmit`, `UserPromptExpansion`, `Stop`, `StopFailure`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `PermissionRequest`, `PermissionDenied`, `SubagentStart`, `SubagentStop`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `FileChanged` (watch arbitrary paths!), `CwdChanged`, `InstructionsLoaded` (fires when CLAUDE.md/rules load — **direct feed for the live context graph [feature 6]**), `ConfigChange`, `WorktreeCreate/Remove`, `PreCompact`/`PostCompact`, `Notification`, `MessageDisplay`, `Elicitation`. Every hook payload carries `session_id`, `transcript_path`, `cwd`, `permission_mode`, and for tool events `tool_name`/`tool_input`/`tool_output`/`tool_use_id`.
Five hook types matter here: `command`, **`http` (POST the JSON payload straight to a URL — i.e. directly to the harness's localhost collector, no shell hop)**, `mcp_tool`, `prompt`, `agent`. Hooks can also *decide* (`permissionDecision: allow|deny|ask|defer`, `updatedInput`, `additionalContext`), which makes them a second permission-gating channel that works even for sessions the harness didn't spawn.

**(c) OpenTelemetry** ([monitoring doc](https://code.claude.com/docs/en/monitoring-usage)) — opt-in via `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_METRICS_EXPORTER=otlp` + `OTEL_LOGS_EXPORTER=otlp` + `OTEL_EXPORTER_OTLP_ENDPOINT`. Metrics: `claude_code.token.usage` (input/output/cache-read/cache-creation), `claude_code.cost.usage` (USD), `session.count`, `lines_of_code.count`, `commit.count`, `active_time.total`. Events: `api_request`, `api_error`, `tool_result`, `tool_decision`, `user_prompt`, `mcp_server_connection`, `auth`. Attributes include `session.id`, `user.account_uuid`, `model`, `query_source` (main/subagent), **`skill.name`**, `agent.name`, `mcp_server.name`, and a per-prompt correlation UUID (`prompt.id`). This is the *only* surface that natively attributes tokens/cost to **skills** — it directly satisfies the "skill frequency/optimality" observability requirement. The harness should embed a tiny OTLP/HTTP receiver and set these env vars on every spawned session (per-account endpoints or an `account` resource attribute).

**(d) Transcript JSONL tailing** — `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` (per config dir). Schema verified locally (keys only): line types `user`, `assistant`, `system`, `attachment`, `queue-operation`, `ai-title`, `last-prompt`; message lines carry `uuid`, `parentUuid`, `sessionId`, `isSidechain` (subagent branches), `cwd`, `gitBranch`, `version`, `promptId`, `requestId`, `timestamp`. The `uuid`/`parentUuid` chain is a ready-made lineage DAG — the [X4] workstream model can be *derived* from transcripts rather than invented. Tailing (fs.watch/chokidar) is the only surface that also covers sessions started *outside* the harness (a plain terminal `claude` run), at the cost of parsing an undocumented, version-drifting format. `~/.claude/usage-data/` (facets, session-meta, generated HTML reports) and `history.jsonl` exist as additional local mines for the observability pane.

### 5. Skills and multi-agent workflows programmatically

- **Skills**: ship as `.claude/skills/*/SKILL.md` (user/project/plugin scope). Programmatic invocation = `/skill-name args` inside the `-p`/SDK prompt string; discovery = scanning those dirs (plus plugin manifests) — exactly what the pipeline-builder feature (5) needs. The SDK loads them when `settingSources` includes the relevant scopes; `--bare` skips discovery but still resolves explicit `/skill-name` calls.
- **Subagents**: `--agents '{...}'` (CLI) or `agents:` (SDK) define them per-invocation; `.claude/agents/*.md` defines them on disk. Subagent activity is observable via `SubagentStart`/`SubagentStop` hooks and `parent_tool_use_id` on messages.
- **Multi-agent workflows**: three composition patterns, all harness-driveable: (1) subagents inside one session (Task/Agent tool); (2) harness-orchestrated fan-out — N parallel `query()` calls with different prompts/accounts, results joined by the harness (this is what the harness's workflow builder compiles to); (3) Claude Code's newer built-ins (background agents via `--bg`/`claude agents`, experimental agent teams — `~/.claude/teams` and the `TeammateIdle` hook exist locally) which are powerful but less stable surfaces.

### 6. Driving OpenCode headlessly (v1.17.13 verified locally)

OpenCode is architected client/server, so headless driving is native, not bolted on:

- **`opencode run [message]`** — one-shot CLI: `--model provider/model`, `--agent`, `--session <id>` / `--continue`, `--fork`, `--auto` (auto-approve). Good for cheap one-offs; JSON export via `opencode export [sessionID]`.
- **`opencode serve --port 4096 --hostname 127.0.0.1`** — persistent headless server ([server doc](https://opencode.ai/docs/server/)). OpenAPI 3.1 spec served at `/doc`. Key endpoints: `POST /session`, `GET /session`, `POST /session/:id/message` (send & await), `POST /session/:id/prompt_async`, `POST /session/:id/abort`, `GET /session/:id/message` (history), **`GET /global/event` (SSE stream of all server events)**, `GET /config`, `PATCH /config`, `GET /provider`, `GET /agent`, `GET /command`, file ops (`/find`, `/file/content`, `/file/status`). Basic-auth via `OPENCODE_SERVER_PASSWORD`. There is also `opencode attach <url>`, `opencode web`, ACP support (`opencode acp`), and `opencode stats` (token usage + cost from local session data).
- **`@opencode-ai/sdk`** (TS) — typed client generated from the OpenAPI spec: `createOpencode()` (spawns server + client), `createOpencodeClient()` (attach), `session.create()/prompt()/messages()/command()`, `event.subscribe()` → `for await (const event of events.stream)`.
- **Auth/config**: providers come from `opencode.jsonc` + env. For the Bedrock provider the harness must replicate what the `oc-bedrock` zsh function does: ensure AWS SSO session validity (`aws sso login` needs a browser once per SSO session lifetime), export `AWS_PROFILE`/`AWS_REGION`, and fetch the Bedrock API key from Keychain (item `bedrock-openai-api-key`) into `OPENAI_API_KEY` for the Responses-API provider — all as *process env of the spawned `opencode serve`*, never on disk. Real Bedrock USD cost = token counts (from OpenCode events/stats) × published Bedrock pricing, cross-checkable against Cost Explorer on AWS_DEV_ACCOUNT_ID (out of scope here).

### 7. LM Studio APIs

([REST docs](https://lmstudio.ai/docs/developer/rest/endpoints)) Three surfaces:

- **OpenAI-compatible `/v1`** on `127.0.0.1:1234`: `/v1/models`, `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings` — what the harness's "cheap local work" router should target (drop-in OpenAI client). LM Studio also exposes **Anthropic-compatible messages endpoints**, meaning some Claude-shaped clients can be pointed at it directly.
- **Native REST `/api/v0`** (beta): same inference ops plus **model state (loaded/unloaded), quantization, max context length, and per-response `tokens_per_second` / `time_to_first_token`** — exactly the latency/perf fields the observability pane wants for the local tier.
- **`lms` CLI** (verified locally): `lms server start|status`, `lms ps` (loaded models), `lms ls` (on-disk models), `lms load|unload`, `lms log` (message log stream). Headless/auto-start-on-boot supported. Since the server is currently *down* on this machine, the harness's LM Studio adapter must: health-check (`GET /api/v0/models` with short timeout), surface state in the UI, and offer one-click `lms server start` remediation — satisfying the "tolerate it being down, ideally manage/detect it" requirement and hard rule [X3] (LM Studio reachability from the harness runtime is non-negotiable; note `127.0.0.1`-bound servers are unreachable from inside Colima/k3s VMs without host-gateway plumbing — a concrete reason the session-execution layer stays host-native).

### 8. Parallel multi-account sessions [X1] — the hardest problem, solved pattern

Community-converged pattern (multiple independent sources, 2025–2026): **one `CLAUDE_CONFIG_DIR` per account**. Each directory is a fully isolated Claude Code universe — credentials, `settings.json`, `projects/` transcripts, plugins, history. On macOS, credentials live in the Keychain under a key **derived from the config dir path** (community-documented as a sha256-prefix scheme; the official docs only spell out the Linux/Windows `.credentials.json`-under-`CLAUDE_CONFIG_DIR` behavior — flagged as an open verification item). Log in once per dir; thereafter any process spawned with `CLAUDE_CONFIG_DIR=~/.claude-max-b` *is* MAX_B, concurrently with other accounts in other processes. Tools like [claude-swap](https://github.com/realiti4/claude-swap) instead swap tokens in/out of the default location — that serializes accounts and is therefore **disqualified** by the parallel-capability-wins rule.

The SDK makes this per-*session* rather than per-process: `query({ options: { env: { ...process.env, CLAUDE_CONFIG_DIR: accountDir } } })` — one harness process, three accounts, N concurrent sessions. `claude setup-token` (one per account, stored in macOS Keychain by the harness, injected as `CLAUDE_CODE_OAUTH_TOKEN`) is the belt-and-suspenders fallback that removes all keychain-prompt and browser-login friction for a year at a time, at the cost of being inference-only and sitting one precedence level above `/login` credentials.

---

## Options considered

### Option A — TypeScript Agent SDK as the session engine (per Claude account)

**How it works.** A single Node/Bun "session broker" service owns all Claude execution. Each launched session = one `query()` call with per-account `env` (`CLAUDE_CONFIG_DIR`, OTel vars), per-session `cwd`, `resume`/`forkSession` for lineage, `hooks` for in-process events, `canUseTool` for frontend-relayed approvals, and the async-iterator message stream multiplexed onto a WebSocket to the frontend.

**Pros.** Officially supported facade over the stream-json protocol; typed messages; in-loop permission callbacks (no PTY dialogs, no exit-and-resume dance); session list/rename/tag primitives for workstreams; bundles its own CLI binary (harness controls the version, decoupled from the user's `claude` upgrades); same language as the frontend; `env` injection solves multi-account cleanly.

**Cons.** Heavier dependency than shelling out; SDK evolves fast (V2 session API added then removed in 0.3.142 — churn is real); subscription-auth-via-SDK sits in a policy gray zone that Anthropic has signaled it will eventually meter separately.

**Risks.** (1) Policy: the paused credit-pool change returns and headless usage gets its own budget — mitigated by building usage accounting now. (2) A future SDK/CLI version changes hook or message schemas — mitigated by pinning the bundled binary version. (3) Keychain access prompts when a new binary reads OAuth creds (macOS codesign-scoped ACLs) — first-run UX to design for, or bypassed entirely with `setup-token` env auth.

### Option B — Python Agent SDK

**How it works.** Same as A but `claude-agent-sdk` + `ClaudeSDKClient`.

**Pros.** `ClaudeSDKClient` holds multi-turn sessions elegantly; Python is comfortable for data/observability tooling.

**Cons.** Second runtime alongside the JS frontend; no `persistSession: false`; features land TS-first; requires the CLI to be present/located rather than bundling it.

**Risks.** Same policy risks as A plus a two-runtime maintenance tax in a public repo.

### Option C — Direct CLI wrapping (`claude -p --input-format stream-json --output-format stream-json`)

**How it works.** The harness spawns `claude` itself, writes NDJSON user messages to stdin, parses NDJSON events from stdout, uses `--session-id`/`--resume`/`--fork-session` for lifecycle and `--permission-mode` + settings-file hooks for gating.

**Pros.** Zero SDK dependency; total control; identical event surface; works with any installed CLI version; trivially portable to other languages.

**Cons.** You hand-roll everything the SDK ships: message types, control-protocol handshakes (interrupt, in-loop permission responses are *undocumented* control frames), error taxonomies, reconnection. Since v2.1.193 the old `--permission-prompt-tool` flag is gone from the CLI surface (verified locally) — interactive approval mid-run without the SDK now means hook-based gating (`PermissionRequest`/`PreToolUse` HTTP hooks with `permissionDecision`) rather than a simple callback.

**Risks.** Undocumented wire details drift between CLI releases with no changelog obligations; you rediscover SDK bugs one by one.

### Option D — PTY-wrapping the interactive TUI (node-pty + xterm.js)

**How it works.** Spawn full-screen `claude` in a pseudo-terminal; render in the frontend via xterm.js; scrape state from ANSI output.

**Pros.** Pixel-perfect Claude Code UX with all interactive affordances (pickers, dialogs, statusline); zero semantic-parsing work *if you never need structured data*.

**Cons.** No structured events (everything is ANSI soup); permission prompts, trust dialogs and pickers become automation hazards; state extraction is regex archaeology that breaks per release; can't drive fan-out workflows.

**Risks.** Highest maintenance surface in the codebase for the least semantic value. Verdict: never for orchestration; acceptable as an *optional embedded terminal* feature where the human, not the harness, is the consumer.

### Option E — Hybrid (recommended): SDK-orchestrated core + hook/OTel/JSONL sidecars + native HTTP for OpenCode & LM Studio

**How it works.** Option A for all harness-launched Claude sessions; `type:"http"` hooks installed in each account's `settings.json` (inside its config dir) POSTing lifecycle events to the harness collector — covering *both* harness-launched and externally-launched sessions; JSONL tailing per config dir as the catch-all + lineage source; embedded OTLP receiver for metrics; OpenCode exclusively via `opencode serve` + `@opencode-ai/sdk` + SSE; LM Studio via `/v1` (inference), `/api/v0` (state/stats), `lms` (lifecycle); optional PTY terminal as a UI feature only.

**Pros.** Each backend is driven through its most-native, most-supported surface; event coverage is complete (including sessions the harness didn't start — required for a truthful observability pane and the live context graph); every component degrades independently.

**Cons.** Four event sources to normalize and deduplicate (hook events vs stream events vs JSONL lines describe overlapping facts); more moving parts than any single option.

**Risks.** Normalization bugs (double-counting tokens across surfaces); mitigated by designating one source of truth per fact type (see below).

---

## Recommendation

**Adopt Option E, with the TypeScript Agent SDK as the single execution engine for Claude sessions.** Concretely:

1. **Session broker (Node or Bun, TypeScript).** One long-lived local service. Public API: WebSocket + small REST (localhost-only). It owns three *account profiles* — MAX_A, MAX_B, ENT — each mapping to a `CLAUDE_CONFIG_DIR` (e.g. `~/.aibender/accounts/max-a/`) never referenced by real identity anywhere in the repo. Every Claude session = `query()` with `options.env = { CLAUDE_CONFIG_DIR: profile.dir, CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_* → harness collector, ...}` and `options.cwd = workspace`. One-time interactive `claude auth login` per profile at setup; generate a `setup-token` per profile into the harness's own Keychain items as the no-browser fallback. **Never `--bare` on subscription profiles** (it disables OAuth). Do not use account-swap approaches — they serialize accounts, violating [X1].
2. **Permission flow.** Default `permissionMode: "default"` with `canUseTool` relaying approval requests to the frontend (approve/deny/always-allow per rule). Pre-approve read-only tool sets per workflow template via `allowedTools`. `--max-budget-usd` on Bedrock-billed runs.
3. **Event pipeline (single normalized envelope).** `{ ts, source, account, backend, sessionId, workstreamId, kind, payload }` over one WebSocket, fanned into UI panes. Source-of-truth policy: *tokens/cost* → `result` message + OTel metrics (OTel wins for skill/agent attribution); *tool activity & file touches (context graph)* → hooks (`PreToolUse`/`PostToolUse`/`InstructionsLoaded`/`FileChanged`); *text streaming* → SDK `stream_event` deltas; *externally-launched sessions* → HTTP hooks first, JSONL tail as fallback; *lineage* → JSONL `uuid`/`parentUuid` + `forkSession` bookkeeping in the harness's SQLite.
4. **Workstreams [X4]** = harness-level entities keyed by session-ID DAGs: `continue` → same node extended; `resume` → child; `forkSession: true` → branch; merges are harness-synthesized (new session whose prompt embeds both parents' summaries — API has no native merge). Store `{workstream, sessionId, parentSessionId, account, cwd}`; remember that resume is cwd-scoped, so workstreams must pin the cwd.
5. **Skills & workflows.** Launch skills as `/skill-name args` prompts on a chosen profile. The pipeline builder scans `~/.claude/skills`, `~/.claude/agents`, `.claude/{skills,agents,commands}` per workspace, plugin manifests, and OpenCode's `~/.config/opencode/` (agents dir + `opencode.jsonc`) — read-only discovery, compile to fan-out `query()` DAGs.
6. **OpenCode adapter.** Harness supervises one `opencode serve` (port from config, `OPENCODE_SERVER_PASSWORD` random per boot), env-injected with SSO profile + Keychain-fetched key (never persisted); drive via `@opencode-ai/sdk`; subscribe `/global/event` SSE into the same envelope; poll `opencode stats`/session data for token/cost.
7. **LM Studio adapter.** Health-check `/api/v0/models`; inference via `/v1/chat/completions`; surface `tokens_per_second`/`time_to_first_token`/load-state from `/api/v0`; manage via `lms server start` with user consent. Because of this adapter (and Keychain + browser-OAuth dependencies), **the session-execution layer runs host-native**; Colima/k3s, if adopted at all [X3], hosts only stateless helpers (dashboards, collectors) — never the broker.
8. **Secret hygiene [X2].** Config dirs, tokens, SSO profiles, and the OTLP data live outside the repo under `~/.aibender/`; repo contains only placeholder-driven config templates (`MAX_A`, `MAX_B`, `ENT`, `AWS_DEV_ACCOUNT_ID`) and a gitleaks/pre-commit scan in CI.

---

## Implications for the harness

- **Frontend transport is one WebSocket**, not N streams: the broker multiplexes SDK iterators, hook POSTs, SSE, and OTel into the normalized envelope. The frontend never talks to Claude/OpenCode/LM Studio directly.
- **The live context graph (feature 6) is hook-fed**: `PostToolUse` on `Read|Write|Edit|Glob|Grep`, `InstructionsLoaded` for CLAUDE.md/rules, `FileChanged` for watched artifacts — all delivered in real time via `type:"http"` hooks with `session_id` + file paths, which is exactly the "populates live during an active session" requirement. JSONL tailing backfills sessions that predate the harness.
- **Observability requirements map cleanly**: USD (result `total_cost_usd`, OTel `cost.usage`, Bedrock = tokens×price), tokens & cache hit rate (usage fields: cache-read vs input tokens), latency (OTel `api_request`, LM Studio `/api/v0` stats), skill frequency/optimality (OTel `skill.name` attribution — enable telemetry on every profile from day one). **Remaining subscription quota has no public API** — see open questions.
- **Version pinning matters**: the TS SDK's bundled CLI binary insulates the harness from the user's global `claude` auto-updates; hook/JSONL schema changes arrive with CLI versions, so pin and upgrade deliberately.
- **ENT is a second-class citizen until proven otherwise**: managed policy settings can constrain permission modes, telemetry, and possibly `setup-token`; the broker must feature-detect per profile (`claude auth status`, trial `-p` run) and degrade the UI per account.
- **Policy watchdog**: encode the account-usage accounting so that if the credit-pool split returns, the harness can show projected per-account credit burn immediately. Keep all Claude traffic attributable per profile.

## Sources

- Agent SDK overview (capabilities, auth note, packages): https://code.claude.com/docs/en/agent-sdk/overview
- Agent SDK sessions (resume/fork/list/tag, JSONL paths, cwd scoping): https://code.claude.com/docs/en/agent-sdk/sessions
- Headless / `claude -p` (stream-json schemas, skills-in-prompt, `--bare` auth constraint): https://code.claude.com/docs/en/headless
- Hooks reference (full 2026 event list, http/mcp_tool/prompt/agent hook types, decision schema): https://code.claude.com/docs/en/hooks
- Monitoring / OpenTelemetry (metrics, events, `skill.name` attribution): https://code.claude.com/docs/en/monitoring-usage
- Authentication (precedence chain, Keychain, `setup-token`, `CLAUDE_CODE_OAUTH_TOKEN`): https://code.claude.com/docs/en/authentication
- Legal & compliance (OAuth-vs-API-key policy, "ordinary, individual usage ... and the Agent SDK"): https://code.claude.com/docs/en/legal-and-compliance
- June 2026 billing change pause: https://zed.dev/blog/anthropic-subscription-changes ; https://thenewstack.io/anthropic-agent-sdk-credits/ ; https://www.digitalapplied.com/blog/anthropic-claude-credit-overhaul-june-15-2026 ; https://www.techtimes.com/articles/317625/20260602/anthropic-ends-subscription-subsidy-agents-june-15-credit-pool-replaces-flat-rate-access.htm ; community analysis: https://gist.github.com/MagnaCapax/d9177e35b355853f03c730dfcaa693ef
- Multi-account patterns (`CLAUDE_CONFIG_DIR`, keychain derivation, parallel use): https://gist.github.com/KMJ-007/0979814968722051620461ab2aa01bf2 ; https://blog.ambi.se/two-claude-accounts-parallel ; https://wmedia.es/en/tips/claude-code-multiple-profiles-config-dir ; https://github.com/realiti4/claude-swap ; https://agentsroom.dev/features/claude-multi-account
- OpenCode server API: https://opencode.ai/docs/server/ ; SDK: https://opencode.ai/docs/sdk/
- LM Studio REST API (`/api/v0`, OpenAI-compat, `lms`): https://lmstudio.ai/docs/developer/rest/endpoints
- SDK changelogs (churn evidence, V2 removal): https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md ; https://github.com/anthropics/claude-agent-sdk-python/blob/main/CHANGELOG.md
- Local ground truth: `claude --help` / `claude auth --help` / `claude agents --help` (v2.1.193), `~/.opencode/bin/opencode --help` (v1.17.13), `~/.lmstudio/bin/lms --help`, `~/.claude/` layout, transcript JSONL key-schema inspection (keys only, no content).

## Open questions

1. **macOS Keychain isolation under `CLAUDE_CONFIG_DIR`** — official docs only document `.credentials.json` relocation on Linux/Windows; community sources say the macOS Keychain entry is keyed by a hash of the config dir. Must be empirically verified on this machine (three dirs, three logins, parallel `claude auth status`) before the profile design is locked.
2. **ENT constraints** — does the Enterprise org allow `setup-token`, headless `-p`, and telemetry for member accounts, or do managed policy settings restrict them? Feature-detect at runtime.
3. **Remaining-quota visibility** — no public API exposes subscription usage/limit state (weekly quota, 5-hour windows). Candidates: parsing `/usage`-style data, `~/.claude/usage-data/` + `history.jsonl` mining, or the undocumented OAuth usage endpoint the CLI itself calls. Needs a stage-2 spike with MITM-free observation (e.g. `--debug api`).
4. **Stream-json control-protocol stability** — if we ever bypass the SDK, are `control_request/control_response` frames versioned? (SDK pinning is the current mitigation.)
5. **Return of the credit-pool split** — Anthropic promised advance notice; what monitoring (release notes, support article RSS) should the harness surface to the owner?
6. **OpenCode SSE event schema** — `/global/event` payload types need enumeration from the local `/doc` OpenAPI spec during stage 2 (server not started in this read-only stage).
7. **LM Studio `/api/v0` beta drift** — the native API is marked beta; confirm endpoint stability or feature-gate the stats pane on `/api/v0` availability.
8. **Agent teams / background agents (`claude agents`, `~/.claude/teams`, `TeammateIdle`)** — promising for multi-agent workflows but experimental; evaluate stability before the workflow builder targets them.
