# OpenCode `serve` event probe: the exact SSE vocabulary, dedup keys, and DB mirror

> Stage-1 gap-filling research for **the-last-aibender**. Probe date: 2026-07-03.
> Method: controlled local probe of `opencode serve` **v1.17.13** (bound to `127.0.0.1`, non-default port, throwaway `OPENCODE_SERVER_PASSWORD`, killed afterward) + OpenAPI 3.1 spec from `/doc` + source-level verification against `anomalyco/opencode` (branch `dev`). One throwaway session was created/renamed/deleted via the REST API — **zero provider invocations, zero cost**. Read-only inspection of `~/.local/share/opencode/opencode.db`. All account references are placeholders: **MAX_A**, **MAX_B**, **ENT**, **AWS_DEV_ACCOUNT_ID**.
> This closes open question 5 in `observability.md`, open question 2 in `ui-motion-3d-context-graph.md`, and the §6/§256 deferral in `harness-architecture.md`.

---

## TL;DR

1. OpenCode v1.17.13 exposes **three parallel SSE vocabularies**: v1 `/event` (flat `{id,type,properties}`, 89 event types), `/global/event` (same payloads wrapped in `{directory,project,workspace,payload}` **plus** duplicate `type:"sync"` wrappers for durable events), and v2 `/api/event` (`{id,type,durable{aggregateID,seq,version},location{directory},data}`), plus a **replayable per-session durable stream** `GET /api/session/{id}/event?after=<seq>`.
2. **The dedup key is the event id** (`evt_`-prefixed, monotonic): verified live that the *same* `evt_…` id appears for one bus event across `/event`, `/global/event` (both plain and sync-wrapped), *and* `/api/event`.
3. **Durable events are persisted into `opencode.db`** (`event` + `event_sequence` tables) under the *same* `evt_` id with a versioned type (`session.created.1`, `session.next.step.ended.2`) and per-session `seq` — subscribe and scrape reconcile exactly; deltas (`*.delta`) are live-only and never stored.
4. **File-touch edges for the context graph** come from: `session.next.tool.called` (input incl. file paths, has sessionID+callID), `session.next.tool.success.outputPaths[]`, `session.next.step.ended.files[]`, `message.part.updated` (ToolPart input / PatchPart.files / FilePart), `session.diff`; `file.edited` and `file.watcher.updated` carry paths but **no sessionID** (corroboration only).
5. Token-by-token streaming exists on all streams: `message.part.delta` (v1) and `session.next.{text,reasoning,tool.input,compaction}.delta` (v2 family).
6. **SDK parity confirmed**: `@opencode-ai/sdk` `client.event.subscribe()` → `GET /event`, `client.global.event()` → `GET /global/event`, fully typed from the same OpenAPI spec (`packages/sdk/js/src/gen/{sdk,types}.gen.ts`); a v2 client exists at `packages/sdk/js/src/v2/`.
7. **Bedrock**: an *application* inference-profile ARN works as a custom-model wire `id` in the `amazon-bedrock` provider (AI SDK URL-encodes it; upstream fixes #9838/#10611 make caching/reasoning key off the config model key too — name the key with `claude` in it, and supply `cost` in config or client-side cost reads 0). The Keychain/API-key mantle path has no documented ARN support → attribute via the API key's IAM principal.
8. **Serve-mode RSS is spiky, not flat**: ~390 MB at boot, transient ~650 MB under API traffic, settling to **160–290 MB idle** — the 150–250 MB estimate in `local-resource-feasibility.md` holds only for *settled idle*; watchdogs must threshold on sustained RSS, not peaks.
9. Pin parsers to: `GET /global/health` → `{healthy,version}`, `session.version` per row/payload, the `migration` table head in `opencode.db`, and the durable-event version suffix. **Parsers must ignore unknown event types** — `server.heartbeat` (every 10 s) is emitted but absent from the OpenAPI spec.
10. Recommendation: **subscribe `/global/event` as the live source of truth** (dedupe on `payload.id`, drop `type:"sync"` wrappers), scrape `opencode.db` for backfill/orphans, and keep a thin adapter so the harness can flip to `/api/event` when v2 stabilizes.

---

## Current landscape

### 1. Serve mode, auth, and the `/doc` spec (verified live)

`opencode serve --port <p> --hostname 127.0.0.1` (default port `0` = random — **see the correction below: on v1.17.13 `--port 0` actually binds the DEFAULT port 4096**; default hostname `127.0.0.1`; `--print-logs`, `--log-level`, `--pure` to skip external plugins, `--mdns`, `--cors`). Auth is **HTTP Basic**: username `opencode` (overridable via `OPENCODE_SERVER_USERNAME`), password from `OPENCODE_SERVER_PASSWORD`. Verified: no auth → 401; `-u opencode:<password>` → 200; `Bearer` → 401. The server binds one process that can host **multiple directory-scoped instances** (query param `?directory=` / header `x-opencode-directory` on most routes; v2 routes also accept `location[directory]`).

> **Correction (BE-ORCH steward, 2026-07-04, from the BE-4 M2 build return; verified live on v1.17.13, independently re-verified by the steward the same day — `--port 0` bound 127.0.0.1:4096, health-only probe, server killed):**
> `opencode serve --port 0` does **NOT** bind an OS-random ephemeral port — it falls back to the
> **default port 4096**. Do not rely on `--port 0` for instance isolation: two supervisors doing so
> collide on 4096. The BE-4 serve supervisor (`core/src/adapters/opencode/serve.ts`) therefore picks
> its own ephemeral port and cross-checks the child's reported ready-line port against it. Any lane
> reading this doc for port-allocation guidance must follow that pattern.

`GET /doc` returns an **OpenAPI 3.1.0** spec (`info.version` is a static `"1.0.0"` — useless for pinning; use `/global/health`). The probe's spec had **162 paths** and **94 `Event*` schemas** (plus `SyncEvent*` and V2 mirrors). Endpoint families:

| Family | Representative endpoints |
|---|---|
| Session core (v1) | `GET/POST /session`, `GET/PATCH/DELETE /session/{id}`, `POST …/message` (prompt), `…/prompt_async`, `…/command`, `…/shell`, `…/abort`, `…/init`, `…/summarize`, `…/fork`, `…/children`, `…/diff`, `…/todo`, `…/revert`, `…/unrevert`, `…/share`, `…/permissions/{permissionID}`, `GET /session/status` |
| Session v2 (`/api`) | `POST /api/session/{id}/prompt`, `…/agent`, `…/model`, `…/compact`, `…/context`, `…/history`, `…/interrupt`, `…/permission(+/{requestID}/reply)`, `…/question(+reply/reject)`, `…/revert/{clear,commit,stage}`, `…/wait`, `GET /api/session/active` |
| **Event streams** | `GET /event`, `GET /global/event`, `GET /api/event`, `GET /api/session/{id}/event?after=<seq>` (all `text/event-stream`) |
| Config / providers / catalog | `GET/PATCH /config`, `/config/providers`, `/global/config`, `/provider(+auth,oauth)`, `/api/provider`, `/api/model`, `/agent`, `/command`, `/skill`, `/mcp(+auth/connect/disconnect)`, `/lsp`, `/formatter` |
| Files / search / VCS | `/file`, `/file/content`, `/file/status`, `/find`, `/find/file`, `/find/symbol`, `/api/fs/{find,list,read}`, `/vcs`, `/vcs/{status,diff,apply}` |
| PTY (embedded terminals) | `/pty*`, `/api/pty*` (create/connect/resize, `connect-token`) |
| Projects / workspaces / worktrees | `/project*`, `/experimental/workspace*`, `/experimental/worktree*`, `/experimental/session/{id}/background` |
| TUI remote control | `/tui/{append-prompt,submit-prompt,execute-command,show-toast,select-session,…}` |
| Sync / ops | `/sync/{start,history,replay,steal}`, `/global/health` (`{healthy,version:"1.17.13"}`), `/api/health`, `/global/dispose`, `/instance/dispose`, `/global/upgrade`, `/log`, `/path` |

Relevant for feature 2/4 (launching prompts/workflows): `POST /session` accepts `{parentID, title, agent, model:{id,providerID,variant}, metadata, permission}` — `parentID` is the lineage primitive [X4] and model selection is per-session at create time.

### 2. The three stream envelopes (verified live)

One bus event is fanned out to all connected streams. Live capture of a `session.created` during the probe (paths/ids truncated):

**v1 `/event`** — flat, one `data:` line per event, no SSE `event:`/`id:` fields:
```
data: {"id":"evt_f2b22fd4b001oxf…","type":"session.created","properties":{"sessionID":"ses_0d4dd02b…","info":{…Session…}}}
```

**`/global/event`** — adds instance context, and **double-delivers durable events** (plain + `sync` wrapper mirroring the DB event store):
```
data: {"directory":"<probe-dir>","project":"global","payload":{"id":"evt_f2b22fd4b001oxf…","type":"session.created","properties":{…}}}
data: {"directory":"<probe-dir>","project":"global","payload":{"type":"sync","id":"evt_f2b22fd4b001oxf…","syncEvent":{"id":"evt_f2b22fd4b001oxf…","type":"session.created.1","seq":0,"aggregateID":"ses_0d4dd02b…","data":{…}}}}
```
Note: stream-synthesized events (`server.connected`, `server.heartbeat`) arrive **without** `directory` even though the schema marks it required — treat `directory` as optional.

**v2 `/api/event`** — cleanest envelope; durable events carry `seq` + schema `version`:
```
data: {"id":"evt_f2b22fd4b001oxf…","type":"session.created","durable":{"aggregateID":"ses_0d4dd02b…","seq":0,"version":1},"location":{"directory":"<probe-dir>"},"data":{"sessionID":"ses_0d4dd02b…","info":{…}}}
```

**Per-session durable stream** `GET /api/session/{id}/event?after=<seq>` — SSE messages with `id`, `event`, `data` fields where `data` is a JSON-encoded `SessionDurableEvent` (the `session.next.*` non-delta subset). The `after` query param makes it **replayable** — the gap-repair primitive after a dropped connection.

**Heartbeats**: `/event` and `/global/event` emit a `server.heartbeat` event every **10 seconds** (`Stream.tick("10 seconds")` in the handler); `/api/event` sends an SSE *comment* (`: heartbeat`) instead. `server.heartbeat` is synthesized in the HTTP handlers (`packages/opencode/src/server/routes/instance/httpapi/handlers/{event,global}.ts`) and is **not in the OpenAPI Event union** — hard evidence that the harness parser must tolerate unknown `type` values. Each stream opens with a `server.connected` event whose id is per-connection (unlike bus events, connected/heartbeat ids differ across streams).

### 3. Full event catalogue (from `/doc` + `packages/schema/src`)

Event ids: `evt_` + monotonically ascending suffix (`packages/schema/src/event.ts`: `create: () => schema.make("evt_" + ascending())`) — **sortable global ordering**. Grouped by relevance:

**Session lifecycle** (all carry `sessionID`; `info` = full `Session` object incl. `parentID`, `directory`, `title`, `cost`, `tokens{input,output,reasoning,cache{read,write}}`, `version`, `time{created,updated,compacting,archived}`, `share`, `revert`):

| type | payload | durable |
|---|---|---|
| `session.created` / `session.updated` / `session.deleted` | `{sessionID, info:Session}` | yes (v1) |
| `session.idle` | `{sessionID}` | no |
| `session.status` | `{sessionID, status: {type:"idle"} \| {type:"busy"} \| {type:"retry",attempt,message,next,action?}}` | no |
| `session.error` | `{sessionID?, error: ProviderAuthError\|UnknownError\|MessageOutputLengthError\|MessageAbortedError\|StructuredOutputError\|ContextOverflowError\|ContentFilterError\|APIError}` | no |
| `session.compacted` | `{sessionID}` | no |
| `session.diff` | `{sessionID, diff: SnapshotFileDiff[]}` (per-file diffs → **file paths**) | no |

**Message/part (v1 family)** — the workhorse for transcripts:

| type | payload |
|---|---|
| `message.updated` | `{sessionID, info: UserMessage\|AssistantMessage}` — AssistantMessage has `cost`, `tokens`, `modelID`, `providerID`, `agent`, `time`, `finish`, `error?` → **per-message cost/token feed** |
| `message.removed` | `{sessionID, messageID}` |
| `message.part.updated` | `{sessionID, part: Part, time}` — `Part` union: Text, Reasoning, **Tool** (`callID`, `tool`, `state: pending\|running\|completed\|error` with `input`, `output`, `title`, `time{start,end}`, `attachments:FilePart[]`), **File** (`mime`, `filename`, `url`, `source`), StepStart/StepFinish, Snapshot, **Patch** (`hash`, `files[]` → **paths**), Agent, Retry, Compaction, Subtask |
| `message.part.removed` | `{sessionID, messageID, partID}` |
| `message.part.delta` | `{sessionID, messageID, partID, field, delta}` — **token-by-token streaming**, live-only |

**`session.next.*` (v2 step family)** — all carry `timestamp` (ms epoch) + `sessionID`; durable except `*.delta`:

| type | payload highlights |
|---|---|
| `session.next.prompted` / `.prompt.admitted` | `messageID`, `prompt`, `delivery: steer\|queue` |
| `session.next.step.started` | `assistantMessageID`, `agent`, `model{id,providerID,variant}`, `snapshot` |
| `session.next.step.ended` | `finish`, **`cost`**, **`tokens{input,output,reasoning,cache{read,write}}`**, `snapshot`, **`files[]`** (RelativePath) — durable **version 2**; the per-step cost/attribution record |
| `session.next.step.failed` | `error` |
| `session.next.text.started/.delta/.ended` | `textID`, `delta`/`text` |
| `session.next.reasoning.started/.delta/.ended` | `reasoningID`, `providerMetadata` |
| `session.next.tool.input.started/.delta/.ended` | `callID`, `name`, `delta`/`text` (args streaming) |
| `session.next.tool.called` | `callID`, `tool`, **`input`** (tool args → file paths for read/write/edit/glob/grep), `provider{executed,metadata}` |
| `session.next.tool.progress` | `callID`, `structured`, `content` |
| `session.next.tool.success` | `callID`, `structured`, `content`, **`outputPaths[]`**, `result`, `provider` |
| `session.next.tool.failed` | `callID`, `error`, `result`, `provider` |
| `session.next.shell.started/.ended` | `callID`, `command` / `output` |
| `session.next.compaction.started/.delta/.ended` | `reason: auto\|manual`, `text`, `recent` — compaction boundary feed for [X4] |
| `session.next.retried` | `attempt`, `error` |
| `session.next.agent.switched` / `.model.switched` / `.moved` / `.context.updated` / `.synthetic` | agent/model/location changes, injected context |
| `session.next.revert.staged/.cleared/.committed` | `revert: RevertState` |

**File events** (context-graph relevant, **no sessionID**):

| type | payload | emitted by |
|---|---|---|
| `file.edited` | `{file}` | OpenCode's own `write`/`edit`/`apply_patch` tools (`packages/opencode/src/tool/{write,edit,apply_patch}.ts`) |
| `file.watcher.updated` | `{file, event: add\|change\|unlink}` | built-in workspace file watcher (fires for external edits too) |

**Permissions / questions** (v1 + v2 coexist):
`permission.asked` `{id, sessionID, permission, patterns[], metadata, always[], tool{messageID,callID}}` / `permission.replied` `{sessionID, requestID, reply: once|always|reject}`; `permission.v2.asked` `{id, sessionID, action, resources[], save[], metadata, source{type,messageID,callID}}` / `permission.v2.replied`; `question.asked/.replied/.rejected` (+ `.v2.*`) `{id, sessionID, questions[], tool}`. Reply endpoints: `POST /session/{id}/permissions/{permissionID}`, `/permission/{requestID}/reply`, `/api/session/{id}/permission/{requestID}/reply`.

**Todo / commands / infra**: `todo.updated` `{sessionID, todos[]}`; `command.executed` `{name, sessionID, arguments, messageID}` (slash-command telemetry → skill-frequency metric); `mcp.tools.changed` `{server}`; `lsp.updated`; `vcs.branch.updated` `{branch}`; `project.updated`, `project.directories.updated`; `pty.created/.updated/.exited/.deleted`; `installation.updated`/`.update-available` `{version}`; `plugin.added`; `models-dev.refreshed`, `catalog.updated`, `integration.*`, `reference.updated`; `workspace.ready/.failed/.status`, `worktree.ready/.failed`; `tui.*` (prompt.append, command.execute, toast.show, session.select); `server.connected`, `server.heartbeat` (undocumented), `global.disposed`, `server.instance.disposed` `{directory}`.

### 4. The durable event store in `opencode.db` (verified read-only)

Beyond the tables documented in `x4-workstreams.md` §1.2, `opencode.db` contains an **event-sourcing store**:

```sql
CREATE TABLE event (
  id           TEXT PRIMARY KEY,   -- SAME evt_… id seen on the SSE streams
  aggregate_id TEXT NOT NULL,      -- ses_… (FK → event_sequence, ON DELETE CASCADE)
  seq          INTEGER NOT NULL,   -- per-aggregate ordering
  type         TEXT NOT NULL,      -- VERSIONED: session.created.1, message.part.updated.1, session.next.step.ended.2
  data         TEXT NOT NULL       -- JSON payload identical in shape to the SSE `properties`/`data`
);
CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, owner_id TEXT);
```

Observed contents on this machine: 458 rows across 3 sessions — `message.part.updated.1` (303), `message.updated.1` (114), `session.updated.1` (38), `session.created.1` (3). A sampled row's `data` is byte-for-byte the same structure as the corresponding SSE event. Deleting a session cascades its events away (verified: the probe session's rows vanished on `DELETE /session/{id}`). Versioning framework (`packages/schema/src/event.ts`): `versionedType(type, version)` → `"{type}.{version}"`; `Event.define({type, durable:{aggregate:"sessionID", version:N}, schema})`; `session.next.step.ended`/`.failed` are durable **version 2**, everything else currently version 1. Deltas are defined *without* `durable` → never persisted. Also present: `migration` (drizzle migration ids, head at probe time `20260622202450_simplify_session_input`) and `data_migration` tables; `PRAGMA user_version` is 0 (unused). The `part`/`message` tables mirror the same `prt_`/`msg_` ids carried in part/message events, with `time_created`/`time_updated` columns.

### 5. SDK parity (source-verified)

- `@opencode-ai/sdk` (JS) is generated from this same OpenAPI spec. In `packages/sdk/js/src/gen/sdk.gen.ts`: `class Event { subscribe() }` → `GET /event` (SSE) and `class Global { event() }` → `GET /global/event` (SSE); both typed (`EventSubscribeResponses`, `GlobalEventResponses`) against `packages/sdk/js/src/gen/types.gen.ts` (~3.9 k lines; `EventSessionCreated`, `EventMessagePartUpdated`, … exactly the union above). Usage: `const events = await client.event.subscribe(); for await (const e of events.stream) {…}`.
- A **v2 client** lives at `packages/sdk/js/src/v2/` (own `gen/`), targeting `/api/*`; its request rewriter injects `x-opencode-directory`/`x-opencode-workspace` headers into `?directory=`/`?workspace=` (and `location[directory]` for `/api/*` routes).
- The **schema source of truth** is the `@opencode-ai/schema` package: `packages/schema/src/event-manifest.ts` (assembles `Definitions`/`ServerDefinitions`/`Latest`/`Durable`), `event.ts` (define/inventory/latest/durable + `evt_` ID), `session-event.ts` (`session.next.*`, `DurableDefinitions`), `v1/session.ts` (v1 session/message/part events), `filesystem.ts` (`file.edited`), `filesystem-watcher.ts`, `server-event.ts`, `durable-event-manifest.ts`, `permission.ts`/`permission-v1.ts`, `question*.ts`. The core re-exports them via `packages/opencode/src/event-manifest.ts`; an `event-v2-bridge.ts` translates between generations. Repo: `anomalyco/opencode` (the former sst/opencode lineage), default branch `dev`.

### 6. Bedrock inference-profile question (desk research only — no AWS calls)

**Converse-path (`amazon-bedrock` provider): YES, an application inference-profile ARN works as the wire model id**, with sharp edges:

- OpenCode resolves the provider through `@ai-sdk/amazon-bedrock`; `packages/opencode/src/provider/provider.ts` `getModel()` passes `modelID` to `sdk.languageModel(modelID)`. The AI SDK URL-encodes it (`encodeURIComponent(modelId)` in vercel/ai `packages/amazon-bedrock/src/amazon-bedrock-chat-language-model.ts` `getUrl()`), and the Bedrock Converse API accepts inference-profile ARNs as `modelId` (AWS-documented).
- **Region-prefix mangling risk**: `getModel()` prepends `us.`/`eu.`/`jp.`/`apac.`/`au.` when the modelID *contains* `claude`/`nova*`/etc. An **application** inference-profile ARN (`arn:aws:bedrock:us-east-1:AWS_DEV_ACCOUNT_ID:application-inference-profile/<opaque-id>`) contains no such substring → passes through untouched. A **system** inference-profile ARN (`…:inference-profile/us.anthropic.claude-…`) *does* contain `claude` → would be mangled to `us.arn:…`. Use application profiles only.
- **Model-family feature gates were the historical blocker and are fixed**: issue [#9803](https://github.com/anomalyco/opencode/issues/9803) (no `cachePoint` → cache tokens always 0 with ARN ids; fixed by PR #9838) and [#10611](https://github.com/anomalyco/opencode/issues/10611) (extended thinking not triggered) — both CLOSED. Current `provider/transform.ts` gates caching on `model.api.id` **or `model.id`** containing `anthropic`/`claude` (and applies Bedrock message-level `cachePoint` when `model.api.npm === "@ai-sdk/amazon-bedrock"`). **Therefore: name the custom model key with `claude` in it.** One residual: the tool-call-id scrub at `transform.ts` keys off `model.api.id.includes("claude")` only — watch for ARN-related regressions on such minor branches.
- **Config shape** (mirrors the existing gpt-5.4 override pattern in `opencode.jsonc`): under `provider["amazon-bedrock"].models`, add a key like `"claude-opus-4-8-aibender"` with `"id": "arn:aws:bedrock:us-east-1:AWS_DEV_ACCOUNT_ID:application-inference-profile/…"` and a `cost` block (`Model.Cost`: `{input, output, cache:{read,write}}` per Mtok, optional context-size tiers — `packages/schema/src/model.ts`). Without `cost`, OpenCode's client-side `cost` field computes 0 for the custom model, breaking the instant-estimate feed observability.md relies on.
- **OpenAI-compat mantle path** (`bedrock-mantle.…api.aws/openai/v1`, Keychain API key): AWS docs for the mantle Chat Completions endpoint show only plain model ids (`openai.gpt-…`); ARN-as-`model` is **not documented** there (community proxies like bedrock-access-gateway and LiteLLM do support ARN pass-through, but that's not this endpoint). Attribution fallback is solid, though: Bedrock long-term API keys are bound to an IAM user, so the April-2026 **IAM-principal cost allocation** attributes that traffic without any invocation change; or move harness traffic off mantle onto the Converse provider with the tagged application profile.

### 7. Serve-mode footprint (measured during the probe)

Single Bun-runtime process (`~/.opencode/bin/opencode serve`), no helper processes (the separately-running OpenCode desktop app is an unrelated Electron process tree — do not conflate when the watchdog scans by name; match on argv `serve`).

| Uptime | Activity | RSS |
|---|---|---|
| 35 s | boot, config loaded, no requests yet | ~391 MB |
| ~4–5 min | after /doc fetch + 3 SSE clients + session create/rename/delete | ~648 MB (peak observed) |
| ~9 min | idle, SSE clients still attached | ~195 MB |
| ~13 min | idle | ~162 MB |
| ~14 min (kill) | idle | ~290 MB |

Reading: Bun's GC produces a sawtooth — transient spikes past 600 MB, settling to **160–290 MB idle**. The 150–250 MB planning estimate in `local-resource-feasibility.md` is right for the settled state but a watchdog that kills at, say, 300 MB instantaneous would misfire; threshold on RSS sustained over minutes (e.g. >500 MB for 5 min). A long soak (hours, with real prompt traffic) is a **Stage-2 item**.

---

## Options considered (primary live-event source for the harness)

### Option A — v1 `/event` (per-instance bus)
**How:** `client.event.subscribe()`; flat `{id,type,properties}`.
**Pros:** simplest payloads; the documented, SDK-default surface; observed to deliver events regardless of the `?directory` scoping in a single-instance setup.
**Cons:** no directory/project envelope (multi-workspace attribution needs a separate lookup); no seq/replay; heartbeat pollution in-band.
**Risks:** it is the *legacy* vocabulary — an `event-v2-bridge.ts` exists upstream, signalling eventual migration.

### Option B — `/global/event` (global bus with instance envelope)
**How:** `client.global.event()`; `{directory,project,workspace,payload}`.
**Pros:** one connection covers every instance/directory the server hosts; envelope gives workspace attribution for free; carries the `sync` wrappers that expose the durable store's `seq`/versioned type live.
**Cons:** durable events arrive **twice** (plain + sync wrapper) — must drop one by `payload.id`; schema says `directory` required but heartbeats omit it.
**Risks:** same v1-vocabulary sunset risk as A, but the envelope matches the v2 `location` concept, easing migration.

### Option C — v2 `/api/event`
**How:** raw SSE or the v2 SDK client; `{id,type,durable{aggregateID,seq,version},location,data}`.
**Pros:** cleanest envelope; explicit durable seq + schema version inline; comment-style heartbeats (no fake events).
**Cons:** the `/api/*` surface is the newest and churns fastest (migration names like `reset_v2_session_state` are recent); no documented replay param on the firehose itself.
**Risks:** breaking change velocity; less community documentation.

### Option D — per-session durable stream `/api/session/{id}/event?after=<seq>`
**Pros:** replayable (exactly-once reconstruction after disconnects); durable-only signal.
**Cons:** one connection per session; no deltas; misses non-session events (files, permissions v1, projects).

### Option E — scrape `opencode.db` (`event`/`message`/`part`/`session` tables)
**Pros:** complete durable history incl. sessions from *other* serve instances or the desktop app; survives harness downtime; same ids as SSE → trivially reconcilable.
**Cons:** no deltas, no ephemeral events (status, permissions asks are in a separate `permission` table, file watcher events absent); polling latency; schema owned by drizzle migrations.

---

## Recommendation (opinionated)

1. **Primary live subscription: `/global/event`** through `@opencode-ai/sdk` (`client.global.event()`). Normalize as: `envelopeDirectory = directory`, then process `payload` exactly like a v1 event. **Drop `payload.type === "sync"` duplicates** after recording their `syncEvent.seq` into the session's watermark. Ignore unknown `type`s silently (heartbeat precedent), log-once per new type for drift detection.
2. **Dedup key: the `evt_` id**, globally — across streams, across reconnects, and against `opencode.db.event.id`. For facts without evt ids (scraped `part`/`message` rows) the key is the entity id + `time_updated` (`prt_…`, `msg_…`, `ses_…`).
3. **Gap repair:** on reconnect, for each session with in-flight work, replay `GET /api/session/{id}/event?after=<lastSeq>` (watermark from step 1) instead of rescanning the DB.
4. **Backfill/orphans:** read-only `opencode.db` scrape (`session`, `message`, `part`, `event`) exactly as `x4-workstreams.md` planned — now with the bonus that `event.aggregate_id+seq` reconstructs ordered per-session history.
5. **Keep the envelope adapter thin** so flipping the transport to `/api/event` (v2) later is a one-module change; do not couple the normalized harness envelope to v1 field names (`properties` vs `data`).

### Context-graph mapping (feature 6) — which events yield file-touch edges

| Graph fact | Event(s) | Edge identity (dedup) | Notes |
|---|---|---|---|
| Agent **read** a file | `session.next.tool.called` (`tool: read`/`glob`/`grep`, `input.filePath`/pattern); v1 mirror: `message.part.updated` ToolPart `state.input` | `(sessionID, callID)` + path | callID is shared across called/progress/success — one edge per callID |
| Agent **wrote/edited** a file | `session.next.tool.success.outputPaths[]`; corroborated by `file.edited {file}` and `file.watcher.updated {file, change}` | `(sessionID, callID)` + path; suppress session-less `file.edited` when a tool event with the same path arrives within a short window (~2 s) | `file.edited` has **no sessionID** — corroboration only |
| Step-level touched set | `session.next.step.ended.files[]` (RelativePath — resolve against session `directory`) | `(sessionID, assistantMessageID)` | durable v2 → also scrapeable |
| Patch applied | `message.part.updated` PatchPart `{hash, files[]}`; `session.diff.diff[]` | `(sessionID, partID)` / part id | |
| Prompt-attached file | `message.part.updated` FilePart `{filename, url, source}` | `(sessionID, partID)` | source may be file/symbol/resource |
| External (non-agent) edit in workspace | `file.watcher.updated {file, event}` | path + event + evt id | OpenCode ships its own watcher — the harness does **not** need fswatch for OpenCode workspaces |
| Session node create/rename/lineage | `session.created/.updated/.deleted` (`info.parentID`) | sessionID | |

### Source-of-truth policy per fact type (extends the observability.md table)

| Fact | Source of truth | Role of the other |
|---|---|---|
| Live file-touch edges | **Subscribe** (tool events; SSE only — deltas/ephemeral never hit the DB) | Scrape `part` rows to rebuild tool inputs after downtime (loses ordering fidelity of deltas — acceptable) |
| Per-message cost/tokens | **Scrape** `message.data` (at-rest, authoritative) | `message.updated` SSE as the live ticker; must converge with scrape |
| Per-step cost/tokens (skill/agent attribution) | **Subscribe** `session.next.step.ended` (durable v2, has agent+model via `step.started`) | Same rows in `event` table for backfill |
| Session lifecycle/lineage [X4] | **Scrape** `session` table (survives everything) | SSE `session.*` for live UI |
| Permission asks/replies | **Subscribe** (`permission[.v2].asked/.replied`) | `permission` table stores saved rules, not the ask stream |
| Idle/busy/retry status | **Subscribe** `session.status`/`session.idle`; snapshot via `GET /session/status` on connect | — |
| Compaction boundaries | **Subscribe** `session.next.compaction.*` | CompactionPart rows in `part` |

### Schema-drift pinning (task 6)

Pin the OpenCode adapter on, in order: (1) `GET /global/health` → `version` (e.g. `1.17.13`) — gate the whole adapter on a tested semver range; (2) `opencode.db` `migration` table head (timestamped drizzle ids; head at probe: `20260622202450_simplify_session_input`) — gate the *scraper*; (3) durable event `type` version suffix (`.1`/`.2`) and V2 `durable.version` — gate per-event decoders; (4) `session.version` / message JSON version fields for per-row provenance. Do **not** use OpenAPI `info.version` (static `1.0.0`) or `PRAGMA user_version` (0). At startup, diff the live `/doc` event-union type list against the compiled-in list and log new/missing types (cheap, catches vocabulary drift the day it ships).

---

## Implications for the harness

1. **The normalized event envelope can now be finalized.** Proposed minimum: `{id: evt|synthetic, backend:"opencode", account:null, sessionKey: ses_…, workspace: directory, type: normalized, ts, payload}` — `evt_` ids satisfy the cross-stream dedup requirement outright; Claude-side events need synthetic ids (hook payload hash) since Claude Code has no equivalent.
2. **One SSE connection per serve process** (`/global/event`), not per session — cheap fan-in matches the single-WebSocket broker design in `harness-architecture.md` Option E.
3. **The context graph gets OpenCode parity with Claude hooks**: tool events carry everything `PostToolUse` does (tool name, input, output paths, timing via `time{start,end}`/`timestamp`), plus watcher events replace fswatch inside OpenCode workspaces.
4. **Observability gets a per-step durable cost record** (`session.next.step.ended`) that is *replayable* — burn-rate and skill-optimality metrics can be recomputed from `opencode.db.event` alone after any harness outage.
5. **Bedrock cost attribution plan stands**: adopt an application inference-profile ARN as a custom model (`id` = ARN, key contains `claude`, `cost` block supplied) once the AWS-side IaC is approved (External System Write Policy gate); mantle-path traffic is attributed via its API key's IAM principal. No OpenCode code changes needed.
6. **Watchdog thresholds** in `local-resource-feasibility.md` should move from "RSS > 250 MB" to "RSS > ~500 MB sustained 5 min" for the serve process, and must distinguish the harness-owned `opencode serve` from the user's desktop app.
7. **[X2] hygiene note**: `opencode.db` contains `account`, `control_account`, and `credential` tables — the scraper must never select from them, and no db dumps may land in the repo.
8. **Server password**: per-boot random `OPENCODE_SERVER_PASSWORD` (as already planned) + Basic auth username `opencode`; the SDK accepts it via client config.

---

## Sources

- Local probe artifacts (session-scratch, not in repo): `/doc` OpenAPI 3.1 dump, SSE captures of `/event`, `/global/event`, `/api/event`, `serve` RSS samples — `opencode serve` v1.17.13, 2026-07-03.
- OpenCode server docs (auth, /event, /global/event, /doc): https://opencode.ai/docs/server/
- OpenCode SDK docs (`createOpencodeClient`, `event.subscribe`): https://opencode.ai/docs/sdk/
- Source (anomalyco/opencode, branch `dev`, read 2026-07-03):
  - `packages/schema/src/event.ts` (evt_ id, define/inventory/latest/durable, `versionedType`)
  - `packages/schema/src/event-manifest.ts`, `durable-event-manifest.ts`
  - `packages/schema/src/session-event.ts` (session.next.*, DurableDefinitions, step.ended v2)
  - `packages/schema/src/v1/session.ts` (v1 session/message/part events)
  - `packages/schema/src/filesystem.ts`, `filesystem-watcher.ts`, `server-event.ts`, `model.ts` (Model.Cost)
  - `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts`, `global.ts` (10 s heartbeat, server.connected synthesis)
  - `packages/opencode/src/tool/write.ts`, `edit.ts`, `apply_patch.ts` (file.edited publishers)
  - `packages/opencode/src/provider/provider.ts` (amazon-bedrock loader, region-prefix logic), `provider/transform.ts` (caching/reasoning gates)
  - `packages/sdk/js/src/gen/sdk.gen.ts`, `types.gen.ts`, `packages/sdk/js/src/v2/client.ts`
- npm SDK repo: https://github.com/anomalyco/opencode-sdk-js
- Bedrock/ARN issues: https://github.com/anomalyco/opencode/issues/9803 (closed, PR #9838), https://github.com/anomalyco/opencode/issues/10611 (closed), https://github.com/anomalyco/opencode/issues/2746
- AI SDK bedrock provider (`encodeURIComponent(modelId)`): vercel/ai `packages/amazon-bedrock/src/amazon-bedrock-chat-language-model.ts`
- AWS Bedrock OpenAI-compat Chat Completions (mantle vs runtime endpoints, API-key auth): https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions-mantle.html
- AWS inference-profile invocation: https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-use.html
- Prior findings: `docs/research/findings/harness-architecture.md` §6, `observability.md` §6 + OQ5/OQ6, `ui-motion-3d-context-graph.md` OQ2, `x4-workstreams.md` §1.2

---

## Open questions

1. **v1 vocabulary sunset timeline** — `event-v2-bridge.ts` and the `/api/*` build-out imply `/event`+`/global/event` will eventually be deprecated; no upstream announcement found. The adapter boundary (Recommendation §5) is the mitigation; re-check at each OpenCode minor bump.
2. **`/api/event` resume semantics** — no `Last-Event-ID`/`after` on the firehose in the spec; confirm whether SSE `id:` fields are honored for resume or whether per-session `after` replay is the only mechanism (probe suggests the latter).
3. **`file.edited` correlation under concurrency** — with two busy sessions editing the same path, the session-less `file.edited` cannot be attributed; validate the callID-window suppression heuristic in Stage 2 with real tool traffic.
4. **Event-table growth/retention** — 458 rows for 3 sessions; no pruning observed. Determine growth per heavy session and whether OpenCode compacts the `event` table, before the scraper assumes full history.
5. **RSS long soak** — Stage-2: multi-hour serve run with real prompt traffic (and several directory instances) to confirm the 160–290 MB settled band and pick the final watchdog threshold.
6. **Mantle endpoint + ARN** — undocumented; if per-agent attribution on the OpenAI-compat path ever matters, either test ARN-as-`model` against mantle (needs explicit AWS go-ahead, ~$0.01) or rely on IAM-principal allocation and keep agents on the Converse provider.
7. **Multi-instance event scoping** — the probe ran one directory instance; verify that `/event` without `?directory` really receives all instances' events (observed once) or whether the harness must always subscribe `/global/event` (recommended anyway).
