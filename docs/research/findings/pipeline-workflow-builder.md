# Feature 5 — Workspace-scoped pipeline / workflow builder: discovery formats, workflow representation, execution semantics

> Stage-1 discovery research for **the-last-aibender**. Research date: 2026-07-03.
> Ground truth verified on the target machine: Claude Code CLI **2.1.193**, OpenCode **1.17.13**. All account references use placeholders: **MAX_A**, **MAX_B** (Claude Max), **ENT** (Claude Enterprise), **AWS_DEV_ACCOUNT_ID** (Bedrock dev account). Local inspection was read-only; file contents are described by key/schema only, never quoted with identifying values.

---

## TL;DR

1. **Everything the scanner must parse is markdown + YAML frontmatter or small JSON manifests.** Exact paths, schemas, and precedence rules for all six Claude Code surfaces (skills, commands, agents, plugins, workflows, teams) and four OpenCode surfaces (agents, commands, plugins, config) are enumerated below, verified against July-2026 docs *and* this machine.
2. **Custom commands have been merged into skills**: `.claude/commands/deploy.md` and `.claude/skills/deploy/SKILL.md` are the same feature with the same frontmatter. One parser handles both.
3. **Claude Code now ships a real workflow system — "dynamic workflows"**: JavaScript orchestration scripts (`agent()`, `parallel()`, `pipeline()`, `phase()` primitives) saved in `.claude/workflows/` / `~/.claude/workflows/`, executed by a built-in `Workflow` tool in a background bun runtime (16 concurrent / 1,000 agents per run). Verified locally: run records, per-run scripts, per-agent transcripts, and a `journal.jsonl` memoization log that powers resume. This answers the previously mysterious per-session `workflows/` directory.
4. **But native workflows are single-account, single-backend, no mid-run human input, and resume is session-scoped and demonstrably buggy** (GitHub #65796, #67488, #69856). Agent teams remain env-flag experimental with hard limitations. Neither can be the harness's execution foundation.
5. **OpenCode discovery should be API-first**: `opencode serve` exposes `GET /agent` and `GET /command`, so the scanner parses files only as fallback. Agent/command markdown formats are documented below.
6. **Recommendation: a harness-owned declarative JSON DAG schema** — step = `{prompt|skill|agent, account (MAX_A/MAX_B/ENT/AWS_DEV/LOCAL), cwd, permissionMode, budget, outputSchema, retry, approval gate}` with GitHub-Actions-style `needs:` edges — compiled at run time to per-step Agent SDK `query()` calls (per-account `CLAUDE_CONFIG_DIR` env), OpenCode SDK calls, or LM Studio chat calls.
7. **Steal the journal idea**: per-step memoization journal (step id + input hash → cached output) in the harness's SQLite makes pipelines resumable *across* harness restarts — strictly better than the native session-scoped resume.
8. **Every step attempt = a `session_node`** in the X4 workstream ledger; a workflow run is a recorded subgraph, and per-step cost attribution falls out of `ResultMessage.total_cost_usd` / OTel / OpenCode's per-session cost columns.
9. Human-approval gates between steps are the harness's differentiator — the one thing the native runtime explicitly cannot do ("No mid-run user input").
10. **Stability verdict**: build on skills/commands/agents/plugins (stable, documented) for discovery; build the executor on SDK `query()` fan-out; treat dynamic workflows as an interop/import-export target and observability read; do not target agent teams yet.

---

## Current landscape

### 1. Claude Code discovery surfaces (the scanner's parse targets)

#### 1.1 Skills — `SKILL.md`

Skills follow the [Agent Skills open standard](https://agentskills.io) with Claude Code extensions. Docs: [Extend Claude with skills](https://code.claude.com/docs/en/skills). (Note: `code.claude.com/docs/en/slash-commands` now redirects to this same page — commands and skills are one documentation surface.)

**Locations and scope** (verified table from docs):

| Scope | Path | Applies to |
| :-- | :-- | :-- |
| Enterprise | managed settings dir (`.claude/skills/` inside it) | whole org (ENT accounts!) |
| Personal | `~/.claude/skills/<skill-name>/SKILL.md` | all projects of that config dir |
| Project | `.claude/skills/<skill-name>/SKILL.md` | that project |
| Plugin | `<plugin>/skills/<skill-name>/SKILL.md` | wherever the plugin is enabled |

Precedence on name collision: **enterprise > personal > project**; any of these overrides a bundled skill of the same name; plugin skills are namespaced `plugin-name:skill-name` so they never collide; if a skill and a command share a name, **the skill wins**.

Additional discovery rules the scanner must replicate:

- **Parent-directory walk-up**: project skills load from `.claude/skills/` in the starting directory *and every parent up to the repository root*.
- **Nested on-demand discovery**: `.claude/skills/` in subdirectories below the cwd become available when files there are touched (monorepo support). A nested duplicate gets a directory-qualified name: `apps/web/.claude/skills/deploy/` → `/apps/web:deploy`. Both variants stay available.
- **`--add-dir` exception**: `.claude/skills/` inside an added directory loads (the only config type that does); `permissions.additionalDirectories` in settings does *not* load skills.
- **Symlinked skill dirs are followed**; same target reachable twice loads once.
- **Live change detection**: Claude Code watches skill dirs; edits apply within the session (SKILL.md text only). The harness's catalog watcher should mirror this.
- A skill folder containing `.claude-plugin/plugin.json` loads as a **skills-directory plugin** named `<name>@skills-dir` (can then bundle agents/hooks/MCP).

**Complete frontmatter reference** (all optional; only `description` recommended):

| Field | Semantics |
| :-- | :-- |
| `name` | Display name; defaults to directory name. Sets the command name only for a plugin-root `SKILL.md` |
| `description` | When to use; drives model auto-invocation. Falls back to first paragraph of body. Combined with `when_to_use`, truncated at 1,536 chars in the listing |
| `when_to_use` | Extra trigger context, appended to description |
| `argument-hint` | Autocomplete hint, e.g. `[issue-number]` |
| `arguments` | Named positional args (space-separated string or YAML list) → `$name` substitution |
| `disable-model-invocation` | `true` = user-only invocation (`/name`); removes description from context; also blocks preloading into subagents and (v2.1.196+) scheduled-task use |
| `user-invocable` | `false` = hides from `/` menu (model-only background knowledge) |
| `allowed-tools` | Tools pre-approved while the skill is active (permission grant, not a restriction). Space/comma string or YAML list. Gated on workspace trust for project skills |
| `disallowed-tools` | Tools removed from the pool while active; clears on next user message |
| `model` | Model override for the rest of the turn (same values as `/model`, or `inherit`) |
| `effort` | `low`–`max` override while active |
| `context` | `fork` = run in a forked subagent context (skill body becomes the subagent's task) |
| `agent` | Which subagent type executes when `context: fork` (built-ins `Explore`, `Plan`, `general-purpose`, or any custom agent; default `general-purpose`) |
| `hooks` | Hooks scoped to the skill's lifecycle |
| `paths` | Glob patterns limiting auto-activation to matching files |
| `shell` | `bash` (default) or `powershell` for inline `` !`cmd` `` execution |

**Argument/substitution machinery** (the launcher needs this to render a skill invocation): `$ARGUMENTS` (all args; if absent, args are appended as `ARGUMENTS: <value>`), `$ARGUMENTS[N]` / `$N` (0-based positional, shell-style quoting), `$name` (via `arguments` field), `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}` (v2.1.196+, also valid inside `allowed-tools` rules). Since v2.1.199 up to six skills can be **stacked** in one message (`/code-review /fix-issue 123`) with the trailing text passed as `$ARGUMENTS` to each.

**Dynamic context injection**: `` !`command` `` lines and ` ```! ` fenced blocks execute *before* the model sees the content (preprocessing, output substituted in). `"disableSkillShellExecution": true` in settings replaces each with a policy notice — relevant when the harness runs untrusted workspace skills.

**Programmatic control surfaces** the harness can use: permission rules `Skill(name)` / `Skill(name *)`; `skillOverrides` settings map (`"on"` / `"name-only"` / `"user-invocable-only"` / `"off"`; v2.1.199+ `"off"` also hides from Agent SDK callers); `disableBundledSkills`; listing budget `skillListingBudgetFraction` (default 1 % of context) and `skillListingMaxDescChars`.

**Parse robustness**: malformed frontmatter YAML → Claude Code loads the body with empty metadata (`/name` still works, no description). The harness scanner must tolerate this and — per local ground truth — tolerate *unknown* keys (see §1.8).

#### 1.2 Custom commands — `.claude/commands/*.md`

Officially merged into skills: a file at `.claude/commands/deploy.md` and `.claude/skills/deploy/SKILL.md` both create `/deploy` and support the **same frontmatter** (§1.1). Differences: commands are flat files (no supporting-files directory); command name = filename without extension; subdirectories namespace them. Scanner treatment: same parser, `kind: command`, lower precedence than an identically-named skill.

#### 1.3 Subagents — `.claude/agents/*.md`

Docs: [Create custom subagents](https://code.claude.com/docs/en/sub-agents).

**Scope and priority** (highest first):

| Priority | Location | Notes |
| :-- | :-- | :-- |
| 1 | Managed settings `.claude/agents/` | org-deployed (ENT) |
| 2 | `--agents '<json>'` CLI flag / SDK `agents:` option | session-only, not on disk |
| 3 | `.claude/agents/` (project) | walked up from cwd to repo root; nearest definition wins on duplicates (v2.1.178+); `--add-dir` dirs also scanned |
| 4 | `~/.claude/agents/` (user) | |
| 5 | plugin `agents/` | subfolders become part of the scoped id: `my-plugin:review:security` |

Project/user trees are scanned **recursively**; subfolders are organizational only (identity = `name` frontmatter). Duplicate names within one scope: only one loads (`/doctor` reports it, v2.1.196+). Files are watched live (same caveats as skills).

**Frontmatter** (only `name` + `description` required):

| Field | Semantics |
| :-- | :-- |
| `name` | Unique id (lowercase-hyphen); hooks receive it as `agent_type` |
| `description` | Delegation trigger for the model |
| `tools` | Allowlist (inherits all if omitted); supports `Agent(worker, researcher)` spawn-allowlist syntax (main-thread `--agent` only) and MCP patterns `mcp__<server>`/`mcp__<server>__*` |
| `disallowedTools` | Denylist, applied before `tools` |
| `model` | `sonnet` \| `opus` \| `haiku` \| `fable` \| full model id \| `inherit` (default). Resolution order: `CLAUDE_CODE_SUBAGENT_MODEL` env > per-invocation param > frontmatter > main model |
| `permissionMode` | `default` \| `acceptEdits` \| `auto` \| `dontAsk` \| `bypassPermissions` \| `plan` (+ `manual` alias, v2.1.200). Ignored for plugin agents |
| `maxTurns` | Turn cap |
| `skills` | Skills **preloaded** (full content injected at startup); cannot list `disable-model-invocation` skills |
| `mcpServers` | Named references or inline stdio/http/sse/ws definitions scoped to the agent. Ignored for plugin agents |
| `hooks` | Lifecycle hooks scoped to the agent (frontmatter `Stop` → `SubagentStop`). Ignored for plugin agents |
| `memory` | `user` (`~/.claude/agent-memory/<name>/`) \| `project` (`.claude/agent-memory/<name>/`) \| `local` (`.claude/agent-memory-local/<name>/`) |
| `background` | `true` = always run as background task (v2.1.198+ background is the default anyway) |
| `effort` | `low`–`max` |
| `isolation` | `worktree` = run in a temp git worktree |
| `color` | UI color |
| `initialPrompt` | Auto-submitted first turn when run as main session via `--agent` |

Markdown body = the subagent's **system prompt** (replaces the Claude Code default when run via `--agent`). The `--agents` CLI/SDK JSON accepts the same fields plus `prompt` for the body. Plugin agents drop `hooks`/`mcpServers`/`permissionMode` for security.

**Runtime facts relevant to the workflow engine**: subagents get fresh contexts (fork = exception, inherits everything, shares prompt cache); Explore/Plan skip CLAUDE.md + git status; nesting allowed to depth 5 (v2.1.172+); resume works via `SendMessage` by agent id/name (Explore/Plan are one-shot, not resumable); subagent transcripts persist at `~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<agentId>.jsonl`; subagent definitions double as **agent-team teammate roles** and as **workflow `agentType` values** (§1.5) — one definition, three execution paths.

#### 1.4 Plugins — `.claude-plugin/plugin.json`, marketplaces, install state

Docs: [Plugins reference](https://code.claude.com/docs/en/plugins-reference).

**Plugin = a directory** whose components live at the plugin **root** (not inside `.claude-plugin/`):

| Component | Default location | Notes |
| :-- | :-- | :-- |
| Manifest | `.claude-plugin/plugin.json` | optional; without it components are auto-discovered and the dir name is the plugin name |
| Skills | `skills/<name>/SKILL.md` | or a single root `SKILL.md` (single-skill plugin, v2.1.142+) |
| Commands | `commands/*.md` | legacy flat-file skills |
| Agents | `agents/*.md` | recursive; subfolders extend the scoped id |
| Hooks | `hooks/hooks.json` | or inline in plugin.json; full 30-event catalog incl. `http`, `mcp_tool`, `prompt`, `agent` hook types |
| MCP servers | `.mcp.json` | |
| LSP servers | `.lsp.json` | |
| Monitors | `monitors/monitors.json` | experimental; persistent background watcher commands |
| Themes | `themes/*.json` | experimental |
| Output styles | `output-styles/` | |
| Executables | `bin/` | added to Bash-tool PATH while enabled |
| Settings | `settings.json` | only `agent` and `subagentStatusLine` keys honored |

**Manifest schema** (only `name` required; unrecognized fields ignored with warnings): `name`, `displayName`, `version` (falls back to git SHA), `description`, `author {name,email,url}`, `homepage`, `repository`, `license`, `keywords`, `defaultEnabled`, component path overrides `skills` (adds to default), `commands`/`agents`/`outputStyles` (replace defaults), `hooks`/`mcpServers`/`lspServers` (merge), `experimental.{themes,monitors}`, `userConfig` (typed prompts at enable time; `sensitive: true` → keychain), `channels`, `dependencies` (other plugins, semver constraints). Path substitutions: `${CLAUDE_PLUGIN_ROOT}` (versioned install dir — changes on update), `${CLAUDE_PLUGIN_DATA}` (persistent: `~/.claude/plugins/data/<sanitized-id>/`), `${CLAUDE_PROJECT_DIR}`, `${user_config.KEY}`.

**Install-state files the scanner reads directly** (verified locally):

- `~/.claude/plugins/installed_plugins.json` — `{"version": 2, "plugins": {"<name>@<marketplace>": [{scope, installPath, version, installedAt, lastUpdated, gitCommitSha}]}}`. `installPath` points into the cache.
- `~/.claude/plugins/known_marketplaces.json` — `{"<marketplace>": {source: {source: "github", repo: "owner/repo"}, installLocation, lastUpdated}}`.
- Cache layout: `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` (a full plugin tree; an `.in_use/<pid>` dir tracks live sessions; orphaned versions garbage-collected after ~7 days — Glob/Grep skip them).
- Marketplace clone: `~/.claude/plugins/marketplaces/<name>/.claude-plugin/marketplace.json` — `{$schema, name, description, owner {name,email}, plugins: [{name, description, author, category, source: {source: github|git|git-subdir|npm|local..., url, path, ref, sha}, homepage, ...}]}` (verified against the official marketplace clone on disk).
- **Which plugins are actually enabled** comes from `enabledPlugins` in `settings.json` at user/project/local/managed scope (keys are `name@marketplace`), modulated by `defaultEnabled`. The scanner must join install state × enablement × scope to answer "what can this workspace invoke".

#### 1.5 Dynamic workflows — the shipped workflow system (answers the `workflows/` mystery)

Docs: [Orchestrate subagents at scale with dynamic workflows](https://code.claude.com/docs/en/workflows). Requires v2.1.154+; available on **all paid plans** and on Bedrock/Vertex/Foundry; works in the CLI, Desktop, IDE extensions, **`claude -p`, and the Agent SDK**.

**What it is**: a JavaScript orchestration script executed by a background runtime, spawning subagents at scale while the session stays responsive. Claude writes the script (triggered by natural language, the `ultracode` keyword, or `/effort ultracode`); the user approves; the run executes in the background; `/workflows` is the live progress view (phases → agents → per-agent prompt/tools/result; pause `p`, stop `x`, restart agent `r`, save `s`).

**Definition format** (saved workflows; verified locally against real scripts):

```javascript
export const meta = {
  name: 'audit-routes',
  description: 'Audit every route handler for missing auth checks',
  phases: [ { title: 'Implement', detail: '…' }, { title: 'Adversary', detail: '…' } ],  // optional
}

// plain JS body, top-level await; no imports, no fs, no shell from the script itself
const found = await agent('List every .ts file under src/routes/.', {
  schema: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } },
})
const audits = await pipeline(found.files, f => agent(`Audit ${f}…`, { label: f }))
return audits.filter(Boolean)
```

- **Primitives**: `agent(prompt, opts)` (one subagent), `parallel(...)`, `pipeline(list, fn)` (one agent per item), `phase(title)` (progress grouping). Locally observed `agent()` opts: `label`, `phase`, `agentType` (**references a subagent definition by name** — ties §1.3 into workflows), `model`; docs additionally show `schema` (JSON-schema-validated structured result — the data-passing mechanism between steps). Saved scripts read invocation input via a global `args` (structured data, `undefined` if omitted).
- **Save locations / discovery targets**: project `.claude/workflows/<name>.js` (shared via VCS; in monorepos, saves go to the closest existing `.claude/workflows/` between cwd and repo root; loads from every one along that path, closest wins on name clash) and personal `~/.claude/workflows/`. **Project beats personal** on a name clash. Saved workflows appear as `/name` commands.
- **The built-in `Workflow` tool** (verified from a local transcript): input is `{script}` for a new run or `{scriptPath, resumeFromRunId}` to re-run an edited script with cached agent results. The tool result (observed) reports: background Task ID, transcript dir, script file path, run ID, the resume incantation, and "Use /workflows to watch live progress."
- **On-disk run artifacts** (verified locally — this is what the earlier research saw as the mysterious per-session `workflows/` dir):
  - `~/.claude/projects/<encoded-cwd>/<session-id>/workflows/wf_<runid>.json` — run record. Observed keys: `runId`, `timestamp`, `taskId`, `script`, `scriptPath`, `result` (the script's return value, keyed by whatever the script returned), `agentCount`, `logs[]`, `durationMs`, `summary`, `workflowName`, `status` (`completed` observed), `startTime`, `phases[{title,detail}]`, `defaultModel`, `workflowProgress[{type:'workflow_phase',index,title}]`, `totalTokens`, `totalToolCalls`.
  - `…/workflows/scripts/<meta-name>-wf_<runid>.js` — the executed script, editable + re-runnable.
  - `…/subagents/workflows/wf_<runid>/agent-<agentId>.jsonl` + `agent-<agentId>.meta.json` (observed key: `agentType`) — per-agent transcripts.
  - `…/subagents/workflows/wf_<runid>/journal.jsonl` — the **memoization journal**: lines `{type: "started", key, agentId}` and `{type: "result", key, agentId, result}`. Resume = replay this journal; completed `key`s return cached results.
- **Runtime constraints** (docs): no mid-run user input (only permission prompts can pause); the script has no filesystem/shell access (agents do the work); ≤ 16 concurrent agents (fewer on small CPUs); ≤ 1,000 agents/run. Spawned subagents always run **`acceptEdits`** and inherit the session's tool allowlist regardless of session permission mode; un-allowlisted Bash/web/MCP calls still prompt mid-run.
- **Approval matrix**: default/acceptEdits → prompt every run (with per-workflow-per-project "don't ask again"); auto → first launch only; **bypassPermissions / `claude -p` / Agent SDK → never prompts, runs immediately**.
- **Resume**: within the same Claude Code session only; exiting Claude Code means the next session starts fresh. Pause/resume via `/workflows` (`p`) or relaunch with the same script.
- **Cost**: runs count against the plan's normal limits; `/workflows` shows per-agent tokens; every agent uses the session model unless the script routes stages elsewhere.
- **Kill switches**: `/config` toggle, `"disableWorkflows": true` (user or managed settings — ENT can turn this off org-wide), `CLAUDE_CODE_DISABLE_WORKFLOWS=1`. Local ground truth: `skipWorkflowUsageWarning` appears as a settings key on this machine (first-use warning suppression).
- **Bundled workflow**: `/deep-research`.

#### 1.6 Agent teams — runtime state, not a discovery format

Docs: [Agent teams](https://code.claude.com/docs/en/agent-teams). **Experimental, disabled by default**, gated on `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (env or settings). One session becomes the lead; teammates are full independent Claude Code sessions that message each other (`SendMessage`) and share a dependency-aware task list.

State locations (session-derived name = `session-` + first 8 chars of session id):

- `~/.claude/teams/<team-name>/config.json` — runtime state incl. `members[]` (name, agent id, agent type), tmux pane ids. **Deleted at session end; docs explicitly say don't pre-author or hand-edit it.** A project-level `.claude/teams/teams.json` is *not* recognized.
- `~/.claude/tasks/<team-name>/<N>.json` — the shared task list; persists (subject to `cleanupPeriodDays`). Locally verified task-file keys: `{id, subject, description, activeForm, status, blockedBy, blocks}` — i.e. a real dependency DAG with file-locked claiming. (On this machine, 51 task dirs exist keyed by plain session UUIDs — the task system is also used outside teams.)

Reusable "roles" for teammates are **subagent definitions** (§1.3) — the definition's `tools` + `model` apply and its body is appended to the teammate's system prompt (`skills`/`mcpServers` frontmatter do *not* apply on this path). Hooks: `TeammateIdle`, `TaskCreated`, `TaskCompleted` (exit-code-2 gating). Documented limitations that matter here: **no session resumption of in-process teammates; task status can lag; one team per session; no nested teams; lead is fixed; per-teammate permission modes can't be set at spawn**.

#### 1.7 Background agents / agent view

Docs: [Agent view](https://code.claude.com/docs/en/agent-view) — **research preview**, v2.1.139+. `claude --bg "<prompt>"` dispatches a detached full session; `claude agents` opens the management TUI; **`claude agents --json`** (verified in local `--help`) prints active sessions for scripting (`--all` includes completed, `--cwd <path>` filters); `claude attach <id>` / `claude stop`; `/bg` backgrounds a live session. A separate **supervisor process** hosts the sessions (they survive terminal close and machine sleep; state persists on disk through restarts). Rows expose state (working / needs-input / idle / completed / failed / stopped), Haiku-generated summaries, and PR status. Each background session burns subscription quota independently — directly relevant to per-account budgeting.

#### 1.8 Local ground truth summary (this machine, read-only, 2026-07-03)

- `~/.claude/`: **no** `skills/`, `commands/`, or `agents/` dirs; `teams/` exists but is empty; `tasks/` has 51 session-keyed dirs; `plugins/` fully populated (cache/marketplaces/data + the two JSON state files described in §1.4, schemas verified); `settings.json` top-level keys include `enabledPlugins`, `extraKnownMarketplaces`, `skipWorkflowUsageWarning`, `mcpServers`, plus OTel env wiring.
- A large work project (path withheld) demonstrates real-world scale for the scanner: `.claude/skills/` with ~30 skill dirs (frontmatter keys observed: `name`, `description`, `allowed-tools`, occasionally `version`, plus **non-standard user keys** `type`, `status`, `tags` — Obsidian-style metadata Claude Code tolerates and so must the scanner), `.claude/commands/` with 10 commands (`description`, `argument-hint` + the same custom keys; one is literally named `pipeline-builder.md` — the owner already hand-rolls this pattern), `.claude/agents/` with 20+ agents (standard keys `name`, `description`, `tools`, `model` plus non-standard `model-class`, `effort` (predates the official field), `memory`, `type`, `status`, `tags`), `.claude/agent-memory/`, `hooks/`, `scripts/`, `notes/`.
- Dynamic-workflow artifacts verified in `~/.claude/projects/<encoded-cwd>/<session-id>/`: `workflows/wf_*.json` run records, `workflows/scripts/*.js` scripts (with `export const meta`, `phase()`, `await agent(prompt, {label, phase, agentType, model})` — `agentType` values match the project's `.claude/agents/` names), `subagents/workflows/wf_*/agent-*.jsonl` + `.meta.json` + `journal.jsonl`. Transcript tool-name census for the producing session: `Workflow` (6), `Agent` (18), `Skill` (2) — confirming the tool trio the harness will see in transcripts.
- **No saved-workflow dirs exist yet** (`~/.claude/workflows/`, project `.claude/workflows/` absent) — all local runs were ad-hoc scripts, which is why the earlier research only saw per-session artifacts.

### 2. OpenCode discovery surfaces

Docs: [Agents](https://opencode.ai/docs/agents/), [Commands](https://opencode.ai/docs/commands/), [Plugins](https://opencode.ai/docs/plugins/), [Server](https://opencode.ai/docs/server/). OpenCode 1.17.13 verified locally.

#### 2.1 Agents

Three definition sites, **project overrides global**:

1. Global markdown: `~/.config/opencode/agents/*.md` (note: **plural `agents/`** in current docs and on this machine; older third-party writeups say `agent/` — scan both).
2. Project markdown: `.opencode/agents/*.md`.
3. `opencode.json(c)` under the `"agent"` key (verified locally: the `agent.build` entry carries `mode` + `model`).

Markdown format: filename = agent id (`review.md` → `@review`); YAML frontmatter + body as system prompt. Fields: `description` (required), `mode` (`primary` — Tab-cycled main assistant; `subagent` — `@mention`/auto-invoked; `all`, the default), `model` (`provider/model-id` — this is where an OpenCode agent pins e.g. the Bedrock Opus model), `temperature`, `top_p`, `prompt` (or `{file:./path}` reference), `steps` (max iterations), `disable`, `hidden` (hide from `@` autocomplete), `color`, and `permission` — per-capability `allow`/`ask`/`deny` over keys `edit` (gates write/edit/apply_patch), `bash` (supports glob maps like `{"*": "ask", "git status *": "allow"}`), `read`, `glob`, `grep`, `list`, `external_directory`, `webfetch`, `websearch`, `task` (gates subagent spawning, glob patterns). Built-ins: **Build** (primary, all-allow), **Plan** (primary, edit/bash deny), **General**, **Explore**, **Scout** (subagents). "Modes" as a separate concept were folded into agents via the `mode` field — there is no separate `mode/` directory to scan (verified absent locally). Local ground truth: six agent files in `~/.config/opencode/agents/`, frontmatter keys `description`, `mode`, `model`, `permission.edit`, `permission.bash` — matching the docs exactly.

#### 2.2 Commands

Locations: `~/.config/opencode/commands/*.md` (global), `.opencode/commands/*.md` (project), or the `"command"` key in `opencode.json`. Filename → `/name`. Frontmatter: `description`, `agent` (which agent executes it), `model` (override), `subtask` (boolean — force subagent execution), `template` (the prompt; in JSON config form). Body = template. Substitutions: `$ARGUMENTS`, `$1…$n`, shell injection `` !`cmd` ``, file inclusion `@path`. Custom commands can override built-ins. None exist locally yet.

#### 2.3 Plugins

`~/.config/opencode/plugins/*.{js,ts}` (global), `.opencode/plugins/` (project), plus npm packages listed in `opencode.json` `"plugin": []` (auto-installed via Bun, cached under `~/.cache/opencode/node_modules/`). A plugin exports `async ({ project, client, $, directory, worktree }) => ({ …hooks })` with hooks like `tool.execute.before/after`, `file.edited`, `session.created/compacted/idle`, `message.updated`, `permission.asked/replied`, `shell.env`, plus a `tool()` helper for defining new tools; types from `@opencode-ai/plugin`. Local ground truth: no plugin dirs, but `~/.config/opencode/package.json` depends on `@opencode-ai/plugin` 1.17.13 (types installed, plugin authoring anticipated).

#### 2.4 API-first discovery (the recommended scanner path)

`opencode serve` exposes `GET /agent` (all agents, merged from every config layer, post-precedence) and `GET /command`, plus `GET /config` and the OpenAPI spec at `/doc` — via `@opencode-ai/sdk` these are one-call catalog reads. **The scanner should treat the server API as the source of truth for OpenCode** (it resolves precedence, JSONC parsing, and npm-plugin loading for free) and fall back to file parsing only when no server is running and the harness doesn't want to start one.

#### 2.5 LM Studio

No skills/agents/commands concept — an OpenAI-compatible inference endpoint. For the workflow builder, LM Studio "capabilities" are harness-native prompt templates (stored in the harness's own catalog), not scanned artifacts.

### 3. Workflow representation — prior art survey

| System | Representation | Data passing | Human gates | Resume | Verdict for the harness |
| :-- | :-- | :-- | :-- | :-- | :-- |
| **Claude Code dynamic workflows** | Imperative JS (meta + body), primitives `agent/parallel/pipeline/phase` | Script variables; `schema` opt gives JSON-schema-validated agent results | None mid-run (by design) | Journal-based, session-scoped, buggy (see §Options A) | Inspiration + interop target; single-account only |
| **Claude Code agent teams** | No definition artifact; runtime task list with `blockedBy`/`blocks` | Mailbox messages, task list | Plan-approval requests to the lead | None (in-process teammates don't survive resume) | Watch only |
| **GitHub Actions** | Declarative YAML DAG: jobs + `needs:`, `if:` conditions, `strategy.matrix` fan-out, reusable workflows | `outputs` string map between jobs | `environment` protection rules (approvals) | Re-run failed jobs | The **schema shape** to copy: familiar, diffable, VCS-native |
| **LangGraph** | Graph of nodes over shared typed state; edges + conditional edges | State channels (typed) | First-class `interrupt()` + checkpointer | First-class: checkpointer persists every super-step; resume from any checkpoint | The **execution-semantics bar** to meet (checkpoint/interrupt); too heavy to adopt wholesale for spawning CLI-backed sessions |
| **n8n** | Visual node DAG serialized to JSON | JSON items along connections | Wait/approval nodes | Partial re-execution | UI inspiration (node editor); embedding the platform is overkill |
| **Conductor / Vibe-Kanban class** | Worktree/kanban orchestration of coding agents | none (git is the medium) | Human reviews PRs | n/a | Confirms the gap: nobody ships a cross-account, cross-backend DAG |
| **Agent SDK primitives** | `query()` + `options.agents` + `structured_output` (JSON-schema-validated result) + hooks + `canUseTool` + `AbortController` + `resume`/`forkSession` | Harness-mediated: structured output of step N templated into prompt of step N+1 | `canUseTool` callback + harness pauses between steps | Harness-owned (this doc's recommendation) | **The execution substrate** |

Key syntheses: (a) the ecosystem splits into *imperative-script* (dynamic workflows, LangGraph code) and *declarative-DAG* (Actions, n8n) camps — for a UI **builder** that non-experts edit and that the harness must validate against a catalog, declarative wins; (b) the two genuinely hard semantics — durable resume and human interrupts — are exactly what LangGraph's checkpointer formalizes and what Claude Code's journal.jsonl implements in miniature; the harness needs its own equivalent because native resume is scoped to a live Claude Code session; (c) structured outputs (JSON-schema results per step) are now natively supported at *both* the SDK level (`structured_output`) and inside dynamic workflows (`agent(…, {schema})`), so typed step-to-step data passing costs nothing.

---

## Options considered

### Option A — Build the workflow engine ON dynamic workflows (Workflow tool via SDK/`-p`)

**How it works.** The builder UI compiles pipelines to dynamic-workflow JS scripts; the harness launches them through the Agent SDK (where the approval prompt is skipped and runs start immediately), watches run records/journals on disk, and re-invokes with `{scriptPath, resumeFromRunId}` to resume.

**Pros.** The fan-out runtime, concurrency caps (16/1,000), progress UI, per-agent transcripts, journal-based memoization, and `agentType` reuse of `.claude/agents/` definitions all come for free; officially documented; works on all paid plans and Bedrock; scripts are shareable artifacts in `.claude/workflows/`.

**Cons.** One workflow run = one Claude Code session = **one account** — cross-account steps (MAX_A research → ENT synthesis) are impossible inside a run; no OpenCode or LM Studio steps ever; **no mid-run human gates by explicit design** ("For sign-off between stages, run each stage as its own workflow"); resume dies with the session; subagents are forced into `acceptEdits`, weakening per-step permission control; scripts are imperative JS, awkward as the storage format for a visual builder.

**Risks.** Demonstrated instability: resume silently re-runs completed agents after auto-compaction because the journal lives under the pre-compaction session dir ([#65796](https://github.com/anthropics/claude-code/issues/65796)); resume re-ran 26 completed fetch agents ignoring the journal cache ([#67488](https://github.com/anthropics/claude-code/issues/67488)); all workflows in a session share one bun runtime process — kill it and every concurrent run dies silently ([#69856](https://github.com/anthropics/claude-code/issues/69856)); the `workflow` keyword over-triggers ([#64413](https://github.com/anthropics/claude-code/issues/64413), [#65971](https://github.com/anthropics/claude-code/issues/65971)). Plus a policy knob: ENT managed settings can disable workflows org-wide.

### Option B — Build on agent teams

**How it works.** The builder spawns a lead session per pipeline; steps become tasks with `blockedBy` dependencies; teammates claim them.

**Pros.** Native dependency-aware task list with file-locked claiming; inter-agent messaging; teammate roles reuse subagent definitions.

**Cons/Risks.** Experimental behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`; no teammate resume; one team per session; lead fixed; per-teammate permissions can't be set at spawn; team config is explicitly not authorable; still single-account, single-backend. The docs' own limitations list reads as a disqualification for a foundation. **Rejected as a target; revisit when it leaves experimental.**

### Option C — Harness-owned declarative DAG engine compiling to per-step SDK/API calls

**How it works.** The harness defines its own workflow schema (JSON, below). An engine walks the DAG: each step becomes one Agent SDK `query()` (with per-account `CLAUDE_CONFIG_DIR` env, cwd, permissionMode, allowedTools, model), or an OpenCode SDK `session.prompt()`/`session.command()`, or an LM Studio chat call. Step outputs (JSON-schema-validated via `structured_output`) are journaled in SQLite and templated into successor prompts. Approval gates pause the walk; the frontend resumes it.

**Pros.** The only design that satisfies X1 (steps fan out **across MAX_A/MAX_B/ENT/OpenCode/LM Studio in parallel**), supports human gates, per-step permission modes and budgets, durable cross-restart resume, and native ledger integration (X4). Engine size is modest: a topological walker + journal + templating — not a workflow platform.

**Cons.** The harness owns scheduler correctness (concurrency limits, retry storms); no free progress TUI (the harness frontend must render it — but it must anyway); imperative loops ("fix until check passes") need an explicit loop-step type rather than free-form JS.

**Risks.** Schema design lock-in (mitigate: version the schema from day one); temptation to reimplement LangGraph — resist by capping v1 semantics at sequential/parallel/conditional/foreach/loop-until + gates.

### Option D — Embed an existing orchestrator (LangGraph JS, n8n, Temporal)

**How it works.** Model pipelines as LangGraph graphs or n8n workflows; nodes call the SDK.

**Pros.** Checkpointing/interrupts (LangGraph) or a mature visual editor (n8n) off the shelf.

**Cons.** None of them knows Claude Code sessions, skills, config-dir account isolation, or the workstream ledger — every step wrapper is custom anyway, so the framework only contributes its persistence layer while dictating runtime shape (n8n is an entire server product; LangGraph brings a framework dependency into a public repo for ~200 lines of walker logic the harness can own). Mapping framework checkpoints onto `session_node`/`session_edge` records duplicates state.

**Risks.** Version churn in fast-moving agent frameworks; conceptual mismatch (LangGraph state channels vs. session-based steps). **Rejected; borrow the checkpoint/interrupt semantics, not the dependency.**

### Option E — Option C + native interop (recommended)

Option C as the engine, plus three cheap interop layers: (1) the **scanner** treats `.claude/workflows/*.js` and `~/.claude/workflows/*.js` as first-class discovered artifacts (parse the `meta` export for name/description/phases — static regex/AST scan, never execute); (2) an **export** path that compiles a single-account, no-gate subgraph of a harness pipeline into a dynamic-workflow script the user can run natively or share; (3) a **read-only observer** that tails per-session `workflows/wf_*.json` run records and journals so native runs (including `/deep-research`) appear in the observability pane and ledger as `import`-origin nodes.

---

## Recommendation (opinionated)

**Build Option E.** Concretely:

### R1. The scanner (capability catalog)

One catalog service, shared with the X6 context-graph watcher, producing normalized records:

```jsonc
{
  "id": "cap_<ulid>",
  "kind": "skill | command | agent | workflow | oc-agent | oc-command | plugin",
  "name": "argocd-debug",                  // invocation name (post-namespacing, e.g. "my-plugin:review")
  "scope": "enterprise | user | project | plugin | opencode-global | opencode-project",
  "backendFamily": "claude | opencode",
  "workspace": "/abs/path or null",        // null for user/global scope
  "sourcePath": "/abs/path/SKILL.md",
  "contentHash": "sha256:…",               // for reproducibility pinning in runs
  "frontmatter": { "…": "parsed, unknown keys preserved" },
  "invocation": { "slash": "/argocd-debug", "argumentHint": "[app]", "arguments": ["…"] },
  "constraints": { "disableModelInvocation": false, "allowedTools": ["…"], "model": null }
}
```

Scan rules (mirroring §1 exactly): per Claude account (i.e. per `CLAUDE_CONFIG_DIR`): `<config>/skills/**`, `<config>/agents/**` (recursive), `<config>/commands/**`, `<config>/workflows/*.js`, plugin state files → enabled plugin trees in the cache; per workspace: `.claude/{skills,commands,agents,workflows}` with the walk-up-to-repo-root and nested-subdir rules, `.claude/settings*.json` for `enabledPlugins`/`skillOverrides`/`disableWorkflows`; OpenCode: `GET /agent` + `GET /command` from a harness-supervised `opencode serve`, file-scan fallback (`~/.config/opencode/{agents,commands,plugins}`, `.opencode/{agents,commands,plugins}`, `opencode.jsonc` keys `agent`/`command`/`plugin` — scan `agent/` and `command/` singular variants too for older installs). Precedence resolution is computed per (workspace, account) pair and stored, not recomputed in the UI. FSEvents watching keeps it live (matching Claude Code's own live-reload behavior). Frontmatter parsing must tolerate unknown keys and malformed YAML (fall back to body-only + filename, exactly like Claude Code does).

### R2. The workflow definition schema (harness-owned, versioned)

Declarative JSON (YAML-render in the UI), GitHub-Actions-shaped because it is the most widely understood DAG dialect, with agent-native extensions. Illustrative sketch (final naming in stage 2):

```jsonc
{
  "schemaVersion": 1,
  "id": "wf_<ulid>",
  "name": "auth-audit",
  "description": "Audit route handlers, adversarially verify, synthesize",
  "defaults": { "account": "MAX_A", "permissionMode": "default", "cwd": "${workspace}" },
  "inputs": { "paths": { "type": "array", "items": { "type": "string" } } },
  "steps": [
    {
      "id": "inventory",
      "kind": "prompt",                          // prompt | skill | agent | workflow-script
      "prompt": "List every route handler under ${inputs.paths}…",
      "outputSchema": { "type": "object", "required": ["files"], "properties": { "files": { "type": "array" } } }
    },
    {
      "id": "audit",
      "needs": ["inventory"],
      "forEach": "${steps.inventory.output.files}", // matrix fan-out, maxParallel below
      "kind": "agent",
      "agent": { "name": "security-reviewer", "scope": "project" },  // resolved against the catalog at plan time
      "prompt": "Audit ${item} for missing auth checks.",
      "account": "MAX_B",                         // ← the thing no native surface can do: per-step account
      "maxParallel": 4,
      "budget": { "usd": 2.0, "turns": 30, "wallClockSec": 900 },
      "retry": { "max": 2, "backoffSec": 30, "retryOn": ["rate_limit", "overloaded"] },
      "onError": "continue"                       // fail | continue | goto:<step>
    },
    {
      "id": "gate-review",
      "needs": ["audit"],
      "kind": "approval",                          // human gate: engine pauses, frontend prompts the owner
      "timeoutSec": 86400, "onTimeout": "fail"
    },
    {
      "id": "synthesize",
      "needs": ["gate-review"],
      "kind": "skill",
      "skill": { "name": "write-report", "args": "${steps.audit.outputs}" },
      "account": "ENT",
      "when": "${steps.audit.outputs.length} > 0"  // conditional edge
    },
    {
      "id": "cheap-summary",
      "needs": ["synthesize"],
      "kind": "prompt",
      "backend": "lmstudio",                       // or "opencode" with agent/command refs
      "prompt": "Summarize: ${steps.synthesize.output}"
    }
  ]
}
```

Semantics: `needs:` defines the DAG (parallel = same generation); `when` gives conditional execution; `forEach` + `maxParallel` gives matrix fan-out (cap total steps like the native 1,000-agent cap); a `loop` step kind (`until` expression + `maxIterations`) covers "fix until the check passes"; `kind: approval` is a first-class human gate; `kind: workflow-script` delegates a whole step to a native dynamic-workflow script on one account (interop). Data passing: every step's `outputSchema` is enforced via SDK `structured_output`; outputs live in the run journal and are templated (`${steps.<id>.output…}`) into successors — never through the model's context. Skill/agent references carry `{name, scope}` and are resolved against the catalog **for the step's cwd** at plan time; the resolved `sourcePath` + `contentHash` are pinned into the run record so a rerun months later can detect drift.

### R3. Execution semantics

- **Step execution**: one SDK `query()` per Claude step — `options.env = {CLAUDE_CONFIG_DIR: account.dir, OTEL_*…}`, `options.cwd`, `permissionMode`, `allowedTools`, `model`, `maxTurns`; skills invoked by prepending `/name args` to the prompt (documented headless behavior); agents via `options.agents` injection or `@agent-name` reference when defined on disk. OpenCode steps via `@opencode-ai/sdk` (`session.prompt()` with `agent`, or `session.command()`); LM Studio steps via `/v1/chat/completions` against harness-owned message arrays.
- **Cancellation**: per-step `AbortController` (SDK) / `POST /session/:id/abort` (OpenCode); a cancelled step is journaled `cancelled`, downstream steps are `skipped`; run-level cancel aborts all in-flight steps. The engine must also reap the child CLI processes it spawned (SIGTERM the process group) — lesson from native issue #69856.
- **Resume (the journal)**: SQLite tables `workflow_run {run_id, workflow_id, schema_hash, inputs_json, status, started_at, finished_at}` and `step_attempt {run_id, step_id, iteration, attempt, input_hash, status, native_session_id, output_json, cost_usd, tokens_in, tokens_out, error, started_at, finished_at}`. Resume = re-walk the DAG; any step whose `(step_id, iteration, input_hash)` has a `completed` attempt returns the cached `output_json` (exactly the native `journal.jsonl` contract, but durable across harness restarts and immune to the compaction-relocation bug class of #65796). A step whose native session died mid-run can optionally *continue* via SDK `resume` on its `native_session_id` instead of re-running — cheap because resume is first-class in the SDK.
- **Ledger integration (X4)**: every step attempt that spawns a session registers a `session_node` (`origin: 'harness'`, metadata `{run_id, step_id}`); edges: `handoff`-style edges from a step's node to its successors' nodes carrying the brief/output (`edge_type: 'workflow'` or reuse `handoff` with `metadata.workflow = {run_id, from_step, to_step}`); the whole run is a queryable subgraph of the workstream, so the lineage UI renders pipelines with zero extra plumbing. Approval gates append an annotation node (who approved, when).
- **Cost attribution per step**: Claude steps read `ResultMessage.total_cost_usd` + usage (incl. cache read/creation) directly into `step_attempt`; OTel enrichment adds `skill.name`/`agent.name` attribution; OpenCode steps read the session's `cost`/`tokens_*` columns via the API; LM Studio steps record tokens at $0 with `/api/v0` latency stats. Run cost = Σ steps; surfaced live in the run view and rolled up per account for the quota pane.
- **Budgets**: per-step `budget.usd` maps to the CLI's `--max-budget-usd` (print mode) where exposed by the SDK (open question O5), enforced belt-and-suspenders by the engine watching cumulative step cost and aborting on breach; `turns` → `maxTurns`; `wallClockSec` → engine timer.
- **Workspace-scoped vs global skill references**: a pipeline saved in a workspace may reference `{scope: "project"}` capabilities — portable only to workspaces where the name resolves; the builder validates every reference against the catalog for the selected cwd at edit time (red squiggle, "skill not found in this workspace") and again at launch; `{scope: "user"}` and plugin-namespaced references resolve per account config dir, so the validator also checks the *account* dimension (a skill in MAX_A's config dir doesn't exist for ENT runs — surface this explicitly).

### R4. Stability verdict on native surfaces (question 3, answered explicitly)

| Surface | Status | Verdict |
| :-- | :-- | :-- |
| Skills / commands / agents / plugins (file formats) | Documented, versioned, live-reloaded, open-standard (agentskills.io) | **Bedrock for discovery.** Parse them; expect additive frontmatter drift; preserve unknown keys |
| Dynamic workflows | Documented GA-ish (v2.1.154+, all paid plans, SDK/`-p` support) but: session-scoped resume with real cache bugs (#65796, #67488), shared-bun-runtime fragility (#69856), trigger over-eagerness (#64413/#65971), forced `acceptEdits` for spawned agents, ENT kill switch | **Interop target, not foundation.** Scan saved scripts, observe runs read-only, optionally export to it; don't build the engine on it |
| Agent teams | Experimental, env-flagged, no teammate resume, one team/session, config explicitly not authorable | **Do not target.** Re-evaluate on de-flagging; meanwhile the task-file format (`blockedBy`/`blocks`) is worth reading for observability |
| Background agents / agent view | Research preview but supervised, state persisted, `claude agents --json` scriptable | **Use as a read surface** (session inventory) and optionally as a dispatch convenience; the engine itself spawns via SDK for control |

---

## Implications for the harness

1. **One catalog service, three consumers**: the pipeline builder (palette of steps), the one-off launcher (feature 2/3 pickers), and the context graph (skills/agents as artifact nodes). Build the scanner once with per-(workspace, account) precedence resolution baked in.
2. **The builder UI is a DAG editor over catalog entities** with plan-time validation: reference resolution per cwd *and* per account, model availability per account (ENT `availableModels` allowlists), `disableWorkflows`/policy detection for ENT, budget sanity checks. n8n is the UX reference; GitHub Actions is the serialization reference.
3. **X1 is the product**: per-step `account` routing — parallel steps on MAX_A + MAX_B + ENT + Bedrock simultaneously — is precisely what no native or third-party surface offers. The engine's per-step `env` injection rides the already-recommended `CLAUDE_CONFIG_DIR`-per-account architecture unchanged.
4. **X2**: workflow definitions checked into the public repo contain only `MAX_A/MAX_B/ENT/AWS_DEV_ACCOUNT_ID` labels; account→config-dir mapping lives in `~/.aibender/`; run journals (which contain prompts/outputs) stay outside the repo; the exporter to native scripts must run the same redaction pass as X4 briefs.
5. **X3**: the engine spawns CLI child processes, reads Keychain-adjacent config dirs, and must reach LM Studio on 127.0.0.1 — it lives host-native with the session broker; only stateless UI/collector pieces are candidates for Colima/k3s.
6. **X4**: `workflow_run`/`step_attempt` reference `session_node` rows rather than duplicating them; a pipeline is a workstream subgraph, gates are annotations, and "continue this failed run" is the same affordance as "continue this session".
7. **Observability wins for free**: per-step cost/tokens/latency populate the cost pane; skill steps give exact skill-frequency/optimality data (which skill, which account, what cost, did the step's outputSchema validate) — richer than the OTel `skill.name` attribution alone.
8. **Version-drift discipline**: frontmatter parsers and the native-workflow artifact reader live in isolated adapter modules keyed on observed `version` fields; the native run-record schema (`wf_*.json`) is undocumented and internal — treat as enrichment-only, never load-bearing.

---

## Sources

**Official Claude Code docs (fetched 2026-07-03)**
- Skills (incl. merged commands, frontmatter reference, substitutions, skillOverrides, nested discovery): https://code.claude.com/docs/en/skills
- Subagents (frontmatter, scopes, background default, resume via SendMessage, forks): https://code.claude.com/docs/en/sub-agents
- Plugins reference (plugin.json schema, component locations, cache, marketplaces, skills-dir plugins): https://code.claude.com/docs/en/plugins-reference
- Dynamic workflows (primitives, save locations, limits, approval matrix, resume, disable switches): https://code.claude.com/docs/en/workflows
- Agent teams (experimental flag, teams/tasks paths, limitations): https://code.claude.com/docs/en/agent-teams
- Agent view / background agents (research preview, supervisor, `claude agents --json`): https://code.claude.com/docs/en/agent-view
- Headless mode (skills-in-prompt expansion, `--max-budget-usd`): https://code.claude.com/docs/en/headless
- Agent SDK sessions & TypeScript reference (structured_output, resume/fork; Workflow tool entry noted but not fully retrievable — see O1): https://code.claude.com/docs/en/agent-sdk/sessions , https://code.claude.com/docs/en/agent-sdk/typescript

**Stability evidence (GitHub, anthropics/claude-code)**
- Resume restarts after auto-compaction (journal under pre-compaction dir): https://github.com/anthropics/claude-code/issues/65796
- Resume ignores journal cache, re-runs completed agents: https://github.com/anthropics/claude-code/issues/67488
- Shared bun runtime: one kill takes down all concurrent workflow runs: https://github.com/anthropics/claude-code/issues/69856
- `workflow` keyword over-triggering: https://github.com/anthropics/claude-code/issues/64413 , https://github.com/anthropics/claude-code/issues/65971
- Ultracode/workflows config interplay: https://github.com/anthropics/claude-code/issues/63498

**Community writeups on dynamic workflows**
- https://alexop.dev/posts/claude-code-workflows-deterministic-orchestration/
- https://www.developersdigest.tech/blog/claude-code-dynamic-workflows-guide
- https://dev.to/thlandgraf/claude-code-workflows-the-plan-moves-out-of-claudes-head-and-into-a-script-you-can-edit-3k4b

**OpenCode docs**
- Agents (mode/permission/model fields, built-ins): https://opencode.ai/docs/agents/
- Commands (frontmatter, substitutions): https://opencode.ai/docs/commands/
- Plugins (hook API, npm loading): https://opencode.ai/docs/plugins/
- Server (GET /agent, /command, /doc): https://opencode.ai/docs/server/

**Prior art**
- GitHub Actions workflow syntax (needs/if/matrix): https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions
- LangGraph persistence & human-in-the-loop (checkpointer, interrupt): https://langchain-ai.github.io/langgraph/concepts/persistence/
- n8n workflow JSON export: https://docs.n8n.io/workflows/export-import/
- Agent Skills open standard: https://agentskills.io

**Local ground truth (read-only, this machine, 2026-07-03)**
- `claude --help` v2.1.193 (`--bg`, `agents --json`, `--agents`, `--bare` text listing "workflows" as a config surface)
- `~/.claude/plugins/{installed_plugins.json, known_marketplaces.json, cache/**, marketplaces/**}` — schemas as documented in §1.4
- `~/.claude/projects/<encoded-cwd>/<sid>/workflows/{wf_*.json, scripts/*.js}` and `…/subagents/workflows/wf_*/{agent-*.jsonl, agent-*.meta.json, journal.jsonl}` — key-level schemas in §1.5; transcript tool census (Workflow/Agent/Skill inputs: `{script}`, `{description, subagent_type, prompt, model?}`, `{skill, args}`)
- `~/.claude/tasks/<sid>/N.json` task schema `{id, subject, description, activeForm, status, blockedBy, blocks}`; `~/.claude/teams/` empty
- A work project's `.claude/{skills,commands,agents}` — frontmatter key census incl. non-standard keys (§1.8)
- `~/.config/opencode/{opencode.jsonc, agents/*.md, package.json}` — key census in §2

---

## Open questions

1. **The SDK `Workflow` tool's full option surface** — the docs point to the Agent SDK TypeScript reference for "the full set of options" on `agent()` (does it accept `cwd`, `isolation: worktree`, `effort`, per-agent `allowedTools`?), and the reference page didn't render that entry in this pass. Stage 2: read the bundled `@anthropic-ai/claude-agent-sdk` type declarations directly.
2. **Native workflows × multi-account harness**: a Workflow run inherits its session's account (config dir). Can N parallel `-p` sessions on different `CLAUDE_CONFIG_DIR`s each run native workflows concurrently without interference (given the shared-bun-runtime issue is per-session)? Cheap stage-2 experiment.
3. **`args` passing to saved workflows from `-p`**: the docs show conversational invocation ("Run /triage-issues on issues …"); what is the exact contract for passing structured `args` programmatically (prompt-embedded vs. a tool parameter)?
4. **Do workflow-spawned subagents have the `Skill` tool** (so an exported native script can still chain skills), and do plugin-scoped `agentType` names (`my-plugin:agent`) resolve inside `agent()` calls?
5. **Budget enforcement in the SDK**: `--max-budget-usd` exists on the CLI (print mode); confirm the corresponding SDK option name and whether it hard-aborts mid-turn or only between turns — determines how trustworthy per-step `budget.usd` is without the engine's watchdog.
6. **OpenCode `session.command()` semantics** for command steps: does it respect the command's `agent`/`model` frontmatter, and how are `$1…$n` passed via the SDK? Enumerate from the local OpenAPI (`/doc`) in stage 2.
7. **Scanner performance on monorepos**: replicate Claude Code's lazy nested-`.claude/skills` discovery, or scan exhaustively with ignore rules? Measure on a large tree before choosing.
8. **ENT policy detection**: managed settings can disable workflows, restrict `availableModels`, and deploy managed skills/agents; the catalog needs a per-account "capability probe" (cheap `-p` run + settings introspection) — design it in stage 2 alongside the X1 feature-detect.
9. **Frontmatter dialect drift**: OpenCode `agents/` vs older `agent/` directory naming, and Claude Code's tolerance for unknown keys — pin the scanner's compatibility matrix and add contract tests against both tools' release notes.
10. **Native run-record stability**: `wf_*.json` / `journal.jsonl` are undocumented internals; decide in stage 2 whether the observability reader feature-flags per Claude Code version (the `version` field appears in transcripts but not in run records — correlate via the owning session's JSONL).
