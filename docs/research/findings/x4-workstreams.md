# X4 — Workstreams: session organization with branch / continue / merge lineage

**Stage-1 discovery research — the-last-aibender**
**Date:** 2026-07-03 · **Status:** research complete, no code
**Scope:** Claude Code session primitives, OpenCode session model, comparable tools, git-as-metaphor, merge semantics, data model + storage + UX proposal, cross-backend span (Claude accounts MAX_A / MAX_B / ENT, OpenCode→Bedrock via AWS_DEV_ACCOUNT_ID, LM Studio).

---

## TL;DR

1. The raw material for workstreams already exists: Claude Code writes per-session JSONL transcripts with message-level parent links, compaction boundaries (`logicalParentUuid` + `compactMetadata`), sidechain flags, and supports `--resume` / `--continue` / `--fork-session` / `/branch`; OpenCode stores sessions in SQLite with a first-class `parent_id` column and per-session cost/token columns.
2. Nobody models sequential lineage as a first-class product concept. Conductor, Crystal/Nimbalyst, Claude Squad, Vibe Kanban all organize sessions as **parallel siblings** (worktrees/kanban); Claude Code's own picker groups forks under a root but exposes no DAG, and manual handoff docs remain the continuation mechanism. This is the gap.
3. Recommendation: a **harness-owned SQLite lineage ledger** that references native session IDs per backend and records typed edges (`continue`, `fork`, `merge_parent`, `compact`, `sidechain`, `import`) **at action time** — the harness mediates every launch/resume/fork — plus a filesystem/DB watcher that reconciles sessions started outside the harness.
4. **Merge = synthesis, not concatenation**: distill each branch into a brief, fuse the briefs into a merge brief, and seed a new session with it. Claude Code's own auto-compaction (observed locally compressing ~965k → ~39k tokens) proves machine distillation of transcripts works; the arXiv "Conversation Tree Architecture" paper formalizes exactly this "selective upward merge".
5. Handoff docs get automated via Claude Code hooks (`SessionStart`, `SessionEnd`, `PreCompact`) which receive `transcript_path`, and the harness's own brief generator (LM Studio / local model can draft; a Claude session refines).
6. Use **git as metaphor only** — commits/branches/merges map beautifully as UX language, but storing sessions in an actual git repo is an impedance mismatch.

---

## 1. Current landscape

### 1.1 Claude Code session primitives (verified on this machine, v2.1.193, + official docs)

**Session identity & storage.** Every session has a UUID session ID. Transcripts are JSONL at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, where `<encoded-cwd>` is the absolute working directory with non-alphanumerics replaced by `-` (e.g. `/Users/me/proj` → `-Users-me-proj`). Confirmed locally: 30+ project dirs under `~/.claude/projects/`, one JSONL per session, plus a **per-session directory** `<session-id>/` alongside the JSONL containing `subagents/`, `tool-results/` (large tool outputs spilled to disk), and `workflows/`. The docs explicitly warn: *"The entry format is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release"* — a first-order risk for the harness. `CLAUDE_CONFIG_DIR` relocates the whole store; `cleanupPeriodDays` controls the 30-day retention; `--no-session-persistence` suppresses writes for `-p` runs.

**Observed JSONL record anatomy (local ground truth).** Line types seen across local transcripts: `user`, `assistant`, `system`, `attachment`, `queue-operation`, `last-prompt`, `ai-title`, `custom-title`, `file-history-snapshot`, `mode`, `permission-mode`. System subtypes observed: `compact_boundary`, `stop_hook_summary`, `api_error`, `turn_duration`, `away_summary`, `local_command`, `informational`. Message records carry:

- `uuid` + `parentUuid` — a **message-level parent chain** (an intra-session DAG already exists on disk);
- `logicalParentUuid` — present on `compact_boundary` records, bridging the pre-compaction chain to the post-compaction one;
- `isSidechain` — marks subagent traffic;
- `sessionId`, `cwd`, `gitBranch`, `version`, `entrypoint` (e.g. `claude-desktop`), `promptId`, `leafUuid`, `slug`.

**Compaction (what actually happens).** A locally observed `compact_boundary` record:

```json
{"type":"system","subtype":"compact_boundary","content":"Conversation compacted",
 "logicalParentUuid":"949d8152-…","compactMetadata":{"trigger":"auto",
 "preTokens":965182,"postTokens":39221,"durationMs":110785}, …}
```

Immediately after it, the transcript contains a **synthetic user message** beginning *"This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation."* followed by a structured summary (primary request & intent, key technical concepts, files touched, errors and fixes, pending tasks, current work). **Claude Code already auto-generates the continuation brief X4 wants — it just keeps it inside one session file instead of exposing it as a lineage artifact.** Per the official context-window docs, after compaction the system prompt, CLAUDE.md, memory, and MCP tool listings reload automatically; the skill listing is the one exception (only skills actually invoked are preserved); full tool outputs and intermediate reasoning are gone.

**Resume / continue / fork / branch.**

- `claude --continue` — most recent session in the cwd; `claude --resume <id|name>` — specific session (ID lookup is **scoped to the current project directory and its git worktrees**); `claude --from-pr <n>` — session linked to a PR; `/resume` — in-session picker.
- `--fork-session` (with `--resume`/`--continue`) and in-session `/branch [name]` create a **copy of the transcript into a new file with freshly remapped message IDs**; the original is untouched. `/branch` prints both session IDs. Session-scoped permission grants do **not** carry into the fork. Warning from docs: resuming the same session in two terminals **without** forking interleaves both into one transcript (a corruption mode the harness must prevent).
- The `/resume` picker **groups forked sessions under their root session** (expand with `→`) — Claude Code has a shallow tree (root grouping), not a lineage DAG, and no timeline/graph view.
- Sessions are nameable (`claude -n <name>`, `/rename`, Ctrl+R in picker; plan-accept auto-names); unnamed interactive sessions get derived display names like `my-app-3f` (v2.1.196+) which are *not* resume handles.
- `/rewind` (double-Esc) opens checkpoint menu: restore code, conversation, or both to any prior prompt; or **"Summarize from here" / "Summarize up to here"** — targeted compaction where originals stay in the transcript. Checkpoints are per-user-prompt, persist across resumes, don't track bash-command or external edits, and are explicitly "local undo," not version control.
- `/clear` starts fresh but the prior conversation stays resumable; v2.1.191+ rewind menu offers `/resume <session-id> (previous session)` after a `/clear`.
- `/cd` (v2.1.169+) **relocates a session to another directory's project storage** — session→project mapping is mutable, so a harness must not treat `<encoded-cwd>` as a stable key.

**Agent SDK surface (the sanctioned programmatic layer).** `resume: <id>`, `forkSession: true`, `continue: true` on `query()`; session ID arrives on the init `SystemMessage` and every `ResultMessage`. Directly relevant helper APIs: `listSessions()`, `getSessionMessages()`, `getSessionInfo()`, `renameSession()`, `tagSession()` (TS + Python equivalents) — i.e. **an official read/annotate API exists, so the harness need not raw-parse JSONL for everything**. A `SessionStore` adapter mirrors transcripts to shared storage for cross-host resume; the documented low-tech alternative is **copying the JSONL file to the same `<encoded-cwd>` path on the other host** — which generalizes to cross-account handoff (see §5.3). `persistSession: false` (TS) keeps a session memory-only. The docs also flag the classic failure: resume from a different `cwd` silently creates a fresh session.

**Live-session and analytics side-channels (local ground truth, all reusable by the harness).**

- `~/.claude/sessions/<pid>.json` — live registry of running interactive sessions: `{pid, sessionId, cwd, startedAt, version, kind, entrypoint, name, nameSource}`.
- `claude agents --json` — scriptable list of active/background sessions; `--cwd <path>` filters.
- `~/.claude/usage-data/session-meta/<session-id>.json` — per-session analytics: duration, message counts, per-tool call counts, tokens in/out, lines added/removed, tool errors by category, first prompt, interruption counts. (Feeds the X-observability requirement for free.)
- `~/.claude/history.jsonl` — prompt history with `{display, timestamp, project, sessionId}`.
- Hooks receive `transcript_path` and `session_id` as common input fields; `SessionStart` (matchers: `startup|resume|clear|compact`), `SessionEnd`, and `PreCompact` are the automation hook points for lineage capture.

**What is missing natively:** no cross-session lineage records in the transcripts on this machine (grepped for `rootSessionId`/`forkedFrom`/`parentSessionId` etc. across all local project dirs — zero hits); no merge concept; grouping is per-root only and per-project-dir; nothing spans OpenCode or multiple Claude accounts.

### 1.2 OpenCode session model (verified locally + docs)

**Storage moved to SQLite.** On this machine there is **no** `storage/session/*.json` tree (the older layout documented in third-party wikis); everything lives in `~/.local/share/opencode/opencode.db` (WAL mode). Tables include `session`, `session_message`, `part`, `project`, `workspace`, `todo`, `permission`, `session_share`, `account`, `credential`. The `session` table (schema read locally):

```sql
CREATE TABLE session (
  id TEXT PRIMARY KEY,            -- e.g. ses_0d741e01…
  project_id TEXT NOT NULL, workspace_id TEXT,
  parent_id TEXT,                 -- first-class parent/child lineage, indexed
  slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT,
  title TEXT NOT NULL, version TEXT NOT NULL,
  share_url TEXT,
  summary_additions INT, summary_deletions INT, summary_files INT, summary_diffs TEXT,
  metadata TEXT, cost REAL, tokens_input INT, tokens_output INT,
  tokens_reasoning INT, tokens_cache_read INT, tokens_cache_write INT,
  revert TEXT, permission TEXT, agent TEXT, model TEXT,
  time_created INT, time_updated INT, time_compacting INT, time_archived INT
);
```

Key observations: **`parent_id` is a native lineage edge** (used for subagent child sessions and forks; child sessions inherit context from the parent but keep separate histories; the TUI cycles children with `ctrl+right`). **Per-session `cost` and token columns** exist natively — OpenCode already does the accounting the harness's observability panel needs for the Bedrock path. `time_archived` gives archive-not-delete. `share_url` records `/share` links (`opncd.ai/s/<id>`; manual by default, auto-share optional).

**CLI:** `opencode run --session/-s <id>`, `--continue/-c`, `--fork` (fork when continuing), `--share`, `--title`; `opencode session list --format json`; `opencode export [sessionID] --sanitize` (JSON export with redaction — useful for the public-repo constraint X2); `opencode import <file|share-url>`. The SDK exposes fork-off-existing-session (child inherits the parent's **compacted** history).

**Gaps acknowledged upstream:** open feature requests for navigating child→parent in the UI (#3291), forwarding session/parent IDs as HTTP headers for observability (#12930), and cross-session/inter-project context bridging (#10300) — i.e., OpenCode users are asking for exactly the workstream features X4 proposes.

### 1.3 How comparable tools model lineage

| Tool | Model | Lineage? |
|---|---|---|
| **Conductor** (conductor.build, Mac) | "Workspaces" = git worktrees, one agent each; review & merge **code** changes; reuses existing Claude/Codex login | Parallel siblings only. Merge = git merge of code, not of conversations |
| **Crystal → Nimbalyst** (stravu) | Electron app; sessions in parallel worktrees; **SQLite persistence**; archive-not-delete; "conversation continuity" = resume with full history | Sibling list + resume; no branch/merge DAG. Crystal deprecated Feb 2026 in favor of Nimbalyst |
| **Claude Squad** | tmux + worktrees TUI; mixes Claude Code / Codex / OpenCode / Aider slots | Parallel slots, zero lineage |
| **Vibe Kanban** | Kanban columns (To Do / In Progress / Review / Done) of agent tasks; MCP-driven card creation | Task states, not session lineage. Company (Bloop) shut down Apr 2026; community-maintained |
| **Cursor** | Chat tabs + **checkpoints** in the chat timeline (file snapshots, click-to-restore) | Linear per-chat undo; tabs are siblings |
| **Windsurf/Cascade** | Named checkpoints; **@-mention a previous conversation** to retrieve its summaries/checkpoints into the current one | The @-mention is the closest shipped thing to "merge": on-demand cross-session context retrieval — but ad-hoc, not modeled |
| **claude-sessions / claude-handoff / context-handoff (community skills)** | Skills/commands that distill the live session into a handoff doc; claude-handoff does chain detection, sequence numbers, multi-pass extraction at 500k+ tokens | Linear chains via docs — automating exactly the manual handoff X4 wants to kill, but file-based and Claude-only |

**Conclusion:** the ecosystem has converged on *parallelism* (worktrees, kanban) and *within-session undo* (checkpoints). Sequential lineage — "this session is the continuation of that one" — is represented at best as a grouped picker entry (Claude Code), a `parent_id` column (OpenCode), or a markdown handoff doc (community). A cross-backend session DAG with merge is unclaimed territory.

### 1.4 Research anchors for tree/DAG conversations

- **Loom** (socketteer/loom; generative.ink "Loom: interface to the multiverse") — the canonical tree-writing interface for LLM interaction: nodes = generations, users navigate/curate branches of a "textual multiverse." Validates tree navigation UX at message granularity.
- **Conversation Tree Architecture** (arXiv 2603.21278) — formalizes conversations as trees of **context-isolated nodes**; context flows *downstream on branch creation* and *upstream on branch deletion*; "volatile nodes" are transient branches whose local context must be **selectively merged upward or discarded** before purging. This is the cleanest formal statement of what "merging two session lineages" means: not transcript concatenation, but selective upward propagation of distilled context.
- **LangChain "branching chat"** docs — mainstream framing of message-level trees (edit/regenerate = fork).

X4 operates one level up: nodes are whole **sessions**, not messages — but the same flow rules apply (downstream inheritance on fork = continuation brief; upward selective merge = merge brief).

---

## 2. Options considered

### Option A — Native-only: lean on each backend's built-ins

**How it works.** Use Claude Code's picker grouping + naming conventions, OpenCode's `parent_id`, and community handoff skills. The harness UI just re-renders what each backend already stores.

**Pros:** zero new state; no drift risk; nothing to reconcile.
**Cons:** Claude Code exposes no queryable lineage (no fork-origin field observed in transcripts; grouping logic is internal to the picker); lineage is per-backend and per-project-dir; no merge concept anywhere; no cross-account view (MAX_A/MAX_B/ENT each with separate `CLAUDE_CONFIG_DIR` = separate stores); handoff stays manual.
**Risks:** builds the flagship X4 feature on undocumented internals with no write path. **Rejected as primary**, but native stores remain the source of truth for transcript *content*.

### Option B — Harness-owned lineage ledger (SQLite) + action-time edge recording + reconciler

**How it works.** The harness owns a small SQLite DB. Every session the harness launches/resumes/forks/merges goes through a harness "launcher" (per backend: Claude Code CLI/Agent SDK; OpenCode CLI/SDK; LM Studio = harness-native chat loop), so the harness *knows* the lineage at the moment it creates it and records a typed edge deterministically — no inference needed. A background **reconciler** (FSEvents watcher on `~/.claude/projects/**` per account config dir + read-only polling of `opencode.db`) registers sessions created *outside* the harness as orphan nodes, enriches them (name, tokens, cwd, git branch, compact boundaries), and lets the user attach them to a workstream. Compaction events become self-edges/annotations by parsing `compact_boundary` records (best-effort) or via a `PreCompact` hook that reports to the harness.

**Pros:** deterministic lineage for harness-mediated work (the common case); works uniformly across MAX_A/MAX_B/ENT/OpenCode/LM Studio; merge becomes implementable (it's a harness concept anyway); native stores never mutated (safe, upgrade-proof); the watcher doubles as the event source for the X6 live context graph.
**Cons:** two sources of truth (ledger + native stores) require reconciliation; JSONL parsing is version-fragile (mitigate: treat it as enrichment only, prefer Agent SDK `listSessions()`/`getSessionMessages()`, pin parsers per observed `version` field, degrade gracefully).
**Risks:** externally created forks (`/branch` inside a terminal the harness didn't spawn) yield edges the harness can only *infer* (heuristics: identical transcript prefix / remapped-ID copy detection, same first-prompt hash, temporal adjacency). Acceptable: mark inferred edges as `confidence: inferred`.

### Option C — Git as the implementation (sessions in an actual git repo)

**How it works.** Serialize each session turn as a commit; `git branch` per workstream; fork = branch; merge = git merge (or octopus) of session artifacts; lineage = `git log --graph`.

**Pros:** DAG storage, refs, GC, diff, and visualization tooling for free; the lineage survives anything; naturally maps to the user's mental model.
**Cons:** transcripts are append-only JSONL owned by other tools — committing copies duplicates gigabytes; git merge on transcripts is semantically meaningless (conflict markers in conversations); no natural place for cross-backend nodes; every UI query becomes a git plumbing call; sessions mutate (compaction rewrites effective context) in ways commits don't.
**Risks:** high build cost for an impedance mismatch. **Rejected as implementation; adopted as metaphor** — the UX vocabulary (branch/continue/merge, DAG view, "detached head" for orphan sessions) and the *edge semantics* (merge has ≥2 parents) come straight from git.

### Option D — Rewrite/annotate native transcripts to embed lineage

**How it works.** Inject custom records (e.g. `{"type":"harness-lineage",…}`) into JSONL files or extra rows in `opencode.db`.

**Pros:** lineage travels with the transcript file.
**Cons/Risks:** mutating files an actively running CLI appends to invites corruption; format is declared unstable; violates the "don't mutate other tools' state" hygiene the whole harness depends on. **Rejected outright.**

### Option E — Handoff-doc automation only (no DAG)

**How it works.** Ship an automated version of the manual handoff doc (a `SessionEnd`/`PreCompact` hook writes a continuation brief; new sessions start with it), like claude-handoff, but harness-managed. No graph, just chains of briefs.

**Pros:** small; solves the acute pain (manual handoff writing) immediately.
**Cons:** keeps the flat mental model; no merge; no cross-backend map; briefs pile up as files with no queryable structure.
**Risks:** none serious — which is why it's the right **first milestone inside** Option B, not a competing endpoint.

---

## 3. Recommendation (opinionated)

**Build Option B, with Option E as its first vertical slice, and git as UX metaphor.** Concretely:

### 3.1 Data model

Entities (SQLite; illustrative DDL, final naming for Stage 2):

```sql
CREATE TABLE workstream (
  id TEXT PRIMARY KEY,              -- ws_<ulid>
  title TEXT NOT NULL, description TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- active|paused|merged|archived|abandoned
  tags TEXT,                        -- JSON array
  created_at INT NOT NULL, updated_at INT NOT NULL
);

CREATE TABLE session_node (
  id TEXT PRIMARY KEY,              -- sn_<ulid>; harness identity, never the native id
  workstream_id TEXT REFERENCES workstream(id),
  backend TEXT NOT NULL,            -- claude_code|opencode|lmstudio
  account TEXT NOT NULL,            -- MAX_A|MAX_B|ENT|AWS_DEV|LOCAL  (labels only; X2)
  native_session_id TEXT,           -- claude UUID / ses_* ; NULL for lmstudio (harness-native)
  native_scope TEXT,                -- encoded-cwd or opencode project_id (mutable! see /cd)
  transcript_ref TEXT,              -- path or db locator, best-effort
  cwd TEXT, git_branch TEXT, worktree TEXT,
  display_name TEXT, first_prompt_hash TEXT,
  state TEXT NOT NULL,              -- running|idle|completed|abandoned|unresumable|external
  origin TEXT NOT NULL,             -- harness|reconciled
  tokens_in INT, tokens_out INT, cost_usd REAL,   -- snapshots for observability
  created_at INT, last_active_at INT
);

CREATE TABLE session_edge (
  id TEXT PRIMARY KEY,
  from_node TEXT REFERENCES session_node(id),   -- NULL only for edge_type='import'
  to_node   TEXT NOT NULL REFERENCES session_node(id),
  edge_type TEXT NOT NULL,   -- continue|fork|merge_parent|compact|sidechain|handoff|import
  brief_id TEXT REFERENCES brief(id),            -- the context artifact carried across
  confidence TEXT NOT NULL DEFAULT 'recorded',   -- recorded|inferred
  metadata TEXT,             -- JSON: compactMetadata, rewind uuid, target account, etc.
  created_at INT NOT NULL
);

CREATE TABLE brief (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,        -- continuation|merge|handoff|compaction_capture
  content_md TEXT NOT NULL,
  source_nodes TEXT NOT NULL,        -- JSON array of session_node ids
  generated_by TEXT,                 -- model used (e.g. local draft + claude refine)
  token_count INT, created_at INT NOT NULL
);
```

Semantics: a **continuation is a child** (`continue` edge, exactly one parent); a **fork** is a sibling-creating child (`fork` edge from the fork point); a **merge** is one new node with **N `merge_parent` edges**; `compact` is a self-annotating edge (or node attribute) recording an in-place context rewrite with its `compactMetadata`; `sidechain` links subagent sessions (from `isSidechain` / OpenCode `parent_id`); `handoff` is a cross-account/cross-backend continue whose `brief_id` is mandatory (context traveled by brief, not transcript). Workstream = a named connected subgraph; sessions can be reassigned; an orphan (reconciled, unassigned) list is the "detached HEAD" bucket.

### 3.2 Merge semantics (the genuinely new part)

"Merging two session lineages" = **synthesized context brief from both branches feeding a new session**:

1. For each selected leaf, produce a **branch distillate**: prefer the cheapest sound source — the most recent compaction summary already in the transcript, else `claude -p --resume <id> "summarize …"` (docs-sanctioned), else harness-side distillation of `getSessionMessages()` output (first draft on LM Studio/local model, refined by a Claude pass, per the local-delegation policy).
2. Fuse distillates into a **merge brief** with a fixed schema: shared goal; per-branch findings/decisions; conflicts between branches (explicitly surfaced, like git conflict markers — the human resolves them in the brief editor before launch); files/artifacts touched; pending tasks; next step.
3. Launch the merge node on a chosen backend/account with the brief as the opening message; record N `merge_parent` edges + the `brief`.
This mirrors CTA's "selective upward merge" and Windsurf's @-mention retrieval, and reuses the exact summary genre Claude Code's compactor already emits (~965k→39k observed locally).

### 3.3 Automation that replaces the manual handoff doc

- **`PreCompact` hook** → snapshot the pre-compaction transcript state and register a `compact` edge with metadata (the harness keeps the full-fidelity history even after native compaction).
- **`SessionEnd` hook** → auto-generate a `continuation` brief; the workstream node flips to `idle` with a ready "continue from here" affordance.
- **Context-pressure watch**: harness tracks token counts (transcript growth / `session-meta`); at a threshold (e.g. 70%), surface "branch now with a fresh-context continuation?" — proactive, replacing the panicked end-of-context handoff.
- **`SessionStart` hook (matcher `resume|clear`)** → inject the workstream's latest brief so even native `claude --resume` sessions get lineage context.

### 3.4 UX

- **Lineage graph view**: left-to-right DAG per workstream (time flows right), nodes as cards (backend/account badge, name, state dot, token gauge, cost, last-active); `continue` edges solid, `fork` dashed, `merge_parent` converging, `compact` as an in-node tick mark. This is deliberately the `git log --graph` shape, and it can share rendering infrastructure with the X6 force-graph (different layout, same canvas stack).
- **Node actions**: **Continue from here** (resume in place — native resume for same backend+account), **Branch here** (`--fork-session` / `--fork`), **Merge these…** (multi-select leaves → brief editor → pick target backend/account → launch), **Hand off to…** (other account/backend; brief-based, or transcript-copy for Claude↔Claude, §3.5), **Rename / Assign to workstream / Archive**.
- **Workstream rail**: workstreams (not directories) as the primary navigation; each shows its active leaf sessions, status, aggregate tokens/cost. Directory/worktree becomes a node *attribute*, fulfilling "independent of working directory."
- **Guardrails in UI**: refuse un-forked double-resume of a running session (interleaving corruption); flag `unresumable` nodes (deleted by 30-day cleanup, or moved by `/cd`).

### 3.5 Spanning backends and accounts

- **Claude Code (MAX_A / MAX_B / ENT)**: each account runs with its own `CLAUDE_CONFIG_DIR` (per X1 research), so each has its own `projects/` store. Same-account lineage uses native resume/fork. **Cross-account handoff** has two levels: (a) *brief-based* (always works, default); (b) *transcript-copy* — the SDK docs' cross-host recipe ("persist `…/<session-id>.jsonl` and restore it to the same path on the new host; the cwd must match") applied across config dirs, giving full-fidelity continuation of a MAX_A session under MAX_B when a weekly limit hits. Ship (a) first; (b) behind an "experimental" flag pending validation (see Open questions).
- **OpenCode / Bedrock**: read `opencode.db` read-only for nodes/costs; drive `opencode run --session/--fork/--title` for actions; `opencode export --sanitize` as the distillate source. OpenCode's native `parent_id` children (subagents) map to `sidechain` edges.
- **LM Studio**: the OpenAI-compatible server is stateless per request — there is no native session store, so **the harness itself is the backend**: it owns the message array, persists turns in its own tables, and trivially supports fork (copy array) and merge (brief). LM Studio nodes are thus the *most* capable lineage citizens, and cheap enough to be the default target for brief drafting.
- **Cross-backend merge/handoff is always brief-based** — transcripts are not portable between Claude Code and OpenCode; the brief is the lingua franca. This is also the privacy seam: briefs are harness artifacts and must respect X2 (no account identifiers beyond MAX_A/MAX_B/ENT/AWS_DEV_ACCOUNT_ID labels, `--sanitize`-style redaction before anything is exportable).

---

## 4. Implications for the harness

1. **The launcher is the linchpin.** Deterministic lineage exists only if session actions flow through the harness. Every backend adapter must expose: `start(prompt|brief, account, cwd) → native_id`, `resume(node)`, `fork(node) → new native_id`, and capture session IDs from `SDKResultMessage` / init messages / `opencode run` output.
2. **One watcher, two features.** The FSEvents tail of `~/.claude/projects/**` (per account config dir) + `opencode.db` polling feeds both workstream reconciliation and the X6 live context graph — build it once as an event bus.
3. **Observability comes cheap.** `usage-data/session-meta/*.json` (Claude) and `session.cost/tokens_*` (OpenCode) attach per-node metrics without new instrumentation; the workstream view doubles as a cost view.
4. **Version-drift discipline.** JSONL/`opencode.db` parsing lives in isolated adapter modules keyed on the `version` fields both stores embed; Agent SDK helpers (`listSessions`, `getSessionMessages`) and `opencode session list --format json` / `export` are the preferred stable interfaces; raw parsing is enrichment with graceful degradation.
5. **X1 interplay.** Per-account `CLAUDE_CONFIG_DIR` isolation (the X1 direction) *fragments* session stores — the workstream ledger is what re-unifies them. The reconciler must watch N config dirs, and `session_node.account` is derived from *which* store the transcript lives in.
6. **X3 interplay.** The watcher needs host filesystem access to `~/.claude*` and `~/.local/share/opencode`; if the harness backend ever moves into Colima/k3s, these must be volume-mounted read-only or the watcher stays a host-native agent.
7. **Hygiene (X2).** The ledger stores account *labels* only; briefs pass a redaction step before export/share; never store Keychain values; transcript copies for cross-account handoff stay inside `~/.claude*` trees, never in the repo.
8. **Migration path for existing habit:** import command that scans existing handoff markdown docs and past transcripts, creating `import` edges — so current manual chains become visible history rather than lost prehistory.

---

## 5. Sources

**Official docs**
- Claude Code — Manage sessions: https://code.claude.com/docs/en/sessions
- Claude Code — Checkpointing (/rewind, summarize from/up-to here): https://code.claude.com/docs/en/checkpointing
- Claude Code — Context window (compaction survival semantics): https://code.claude.com/docs/en/context-window
- Agent SDK — Work with sessions (resume/forkSession, listSessions, SessionStore, cross-host): https://code.claude.com/docs/en/agent-sdk/sessions
- Claude Cookbook — Building a session browser: https://platform.claude.com/cookbook/claude-agent-sdk-05-building-a-session-browser
- OpenCode — CLI (run --session/--fork, session list, export --sanitize, import): https://opencode.ai/docs/cli/ (fetched via docs mirror)
- OpenCode — Share: https://opencode.ai/docs/share/

**OpenCode issues (lineage demand signals)**
- Parent-session navigation: https://github.com/sst/opencode/issues/3291
- Session/parent IDs as HTTP headers: https://github.com/anomalyco/opencode/issues/12930
- Inter-project context bridging: https://github.com/anomalyco/opencode/issues/10300

**Comparable tools**
- Crystal (→ Nimbalyst): https://github.com/stravu/crystal · https://nimbalyst.com/crystal/
- Conductor: https://www.conductor.build/ · https://www.conductor.build/docs
- Claude Squad review: https://vibecodinghub.org/tools/claude-squad
- Vibe Kanban landscape: https://www.mindstudio.ai/blog/vibe-kanban-vs-paperclip-vs-claude-code-dispatch-comparison · https://nimbalyst.com/blog/best-agent-management-tools-2026/
- Agent-orchestrator survey: https://github.com/andyrewlee/awesome-agent-orchestrators
- Cursor agent/checkpoints: https://cursor.com/docs/agent/overview
- Windsurf Cascade (checkpoints, @-mention past conversations): https://docs.windsurf.com/windsurf/cascade/cascade

**Tree-conversation research & handoff ecosystem**
- Loom: https://github.com/socketteer/loom · https://generative.ink/posts/loom-interface-to-the-multiverse/
- Conversation Tree Architecture: https://arxiv.org/abs/2603.21278
- LangChain branching chat: https://docs.langchain.com/oss/python/langchain/frontend/branching-chat
- claude-handoff skill: https://github.com/REMvisual/claude-handoff
- claude-sessions: https://github.com/hex/claude-sessions
- Handoff practice posts: https://www.nathanonn.com/claude-code-handoff-doc-skill/ · https://www.jdhodges.com/blog/ai-session-handoffs-keep-context-across-conversations/

**Local ground truth (read-only inspection, this machine, 2026-07-03)**
- `claude --version` = 2.1.193; `claude --help` (`--continue`, `--resume`, `--fork-session`, `--from-pr`, `-n/--name`, `--no-session-persistence`); `claude agents --json`
- `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` record types/fields incl. `parentUuid`, `logicalParentUuid`, `isSidechain`, `compact_boundary`+`compactMetadata` (preTokens 965182 → postTokens 39221 observed), post-compaction synthetic continuation message; per-session dirs (`subagents/`, `tool-results/`, `workflows/`)
- `~/.claude/sessions/<pid>.json` live registry; `~/.claude/usage-data/session-meta/<sid>.json`; `~/.claude/history.jsonl`
- `~/.local/share/opencode/opencode.db` schema (session.parent_id, cost/token columns, share_url, time_archived); 3 local sessions, parent_id unused so far

---

## 6. Open questions

1. **Where does Claude Code itself record fork lineage?** The picker groups forks under a root, but no fork-origin field appears in local transcripts (none contain forks yet). Confirm by forking a scratch session and diffing the two JSONLs + any index files — determines how much fork inference the reconciler needs. *(Stage-2 experiment, trivially cheap.)*
2. **Cross-account transcript copy (MAX_A→MAX_B):** technically sanctioned for cross-*host* resume; does copying between two `CLAUDE_CONFIG_DIR` stores on one machine behave identically (leafUuid/state files, `session-env/<sid>`, checkpoints in `file-history/`)? Any ToS considerations for continuing one account's conversation under another? Ship brief-based handoff first regardless.
3. **JSONL & `opencode.db` schema stability:** what is the cheapest sustainable strategy — Agent SDK-only (are `listSessions`/`getSessionMessages` complete enough for compact-boundary and sidechain data?) vs. pinned raw parsers per `version`?
4. **Merge-brief quality:** needs an evaluation loop (does a merged session actually act on both branches' context?). Candidate: golden-transcript fixtures + rubric scoring in Stage 3.
5. **`/cd` and worktree moves:** session relocation mutates `native_scope`; how does the harness detect a moved session (same sid, new project dir) without double-registering?
6. **Claude Desktop / claude.ai sessions:** local transcripts show `entrypoint: claude-desktop` — should desktop-initiated sessions be first-class workstream nodes (they share the same store), and do web sessions (separate history per docs) stay out of scope?
7. **Granularity:** X4 fixes nodes = sessions; is a per-node "expand to message tree" view (Loom-style, from `parentUuid`) worth the rendering cost in v1, or defer?
8. **Concurrency guard:** can the harness reliably detect "session already running" via `~/.claude/sessions/<pid>.json` + pid liveness to block un-forked double-resume, including sessions started in external terminals?
9. **Retention:** native 30-day cleanup will delete transcripts under active workstreams — should the harness auto-raise `cleanupPeriodDays`, or archive transcripts it cares about into its own store (space vs. fidelity trade-off)?
