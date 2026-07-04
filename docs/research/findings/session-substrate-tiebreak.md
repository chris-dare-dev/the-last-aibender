# Session-Execution Substrate Tie-Break: Agent SDK vs node-pty vs tmux, and the launchd/Keychain Question

> Stage-1 gap-filler research for **the-last-aibender**. Research date: 2026-07-03.
> This document reconciles the three mutually incompatible session-execution substrates prescribed by
> `harness-architecture.md` (Agent-SDK-only), `frontend-app-shell-stack.md` (daemon-owned node-pty PTYs),
> and `local-resource-feasibility.md` (tmux server) — and resolves the direct contradiction between
> `local-resource-feasibility.md` and `x1-parallel-multi-account.md` on whether a launchd-run daemon can
> read the macOS Keychain. Includes a **live launchd/Keychain experiment run on this machine** (results below).
> Account placeholders per repo policy: **MAX_A**, **MAX_B**, **ENT**, **AWS_DEV_ACCOUNT_ID**. No real
> identifiers, tokens, or credential values appear here.

---

## TL;DR

1. **One orchestration substrate: the TypeScript Agent SDK (`query()`), owned by a single broker daemon that runs as a gui-domain (Aqua) LaunchAgent.** Experimentally verified on this machine: an Aqua LaunchAgent has *full* login-keychain access (metadata + ACL-gated value reads); a Background/user-domain agent **fails value reads with `errSecInteractionNotAllowed` (exit 36)**.
2. The launchd contradiction dissolves: **both docs were partially right**. `local-resource-feasibility` is correct for gui-domain Aqua agents; `x1`'s warning (via issue #44089) applies only to SSH, Background-session agents, system daemons, and pre-login contexts — **not** to a LaunchAgent inside an active GUI login session.
3. Therefore `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` injection is **not mandatory** for daemon-spawned sessions. It stays exactly where x1 put it: rung-2 fallback, mandatory **only** for non-Aqua contexts (SSH, headless boot, Background agents, containers).
4. **Substrate matrix:** interactive attended sessions = real `claude` TUI in daemon-owned **node-pty** (PTY for pixels; hooks + JSONL for semantics; never ANSI scraping). Headless one-offs, workflow steps, and long-running background agents = **SDK `query()`**. tmux = **not in v1**.
5. tmux's survival property is replaced by: launchd `KeepAlive` on the broker + a SQLite **resume ledger** written before every spawn + the recycle discipline (checkpoint → kill → `resume`). What is genuinely lost without tmux: live processes surviving a *broker* crash, and attach-from-any-terminal. Both are acceptable trades; both are recoverable via `--resume`.
6. **SDK survival semantics (honest):** transcripts persist per completed message; broker death loses only the in-flight turn and any queued streaming input; `resume` recovers everything up to the last persisted message. Known sharp edges when a transcript ends mid-tool-call (#8004, #11277, #16861) demand a transcript-repair check before resume.
7. The recycle-watchdog model fits the SDK path cleanly: a recycle is `resume` (same node extended) or `resume + forkSession` (explicit continuation child) — [X4] lineage is *better* recorded on the SDK path than on any PTY path.
8. **Binary strategy: pin the SDK's bundled `darwin-arm64` binary and use it for every harness spawn (SDK and PTY).** Verified locally: the claude binary shells out to `/usr/bin/security` for all keychain ops, so keychain ACLs anchor to Apple's `security` tool, not the claude binary — the Homebrew-vs-bundled ACL fear is largely moot; pinning is about schema and service-name-derivation stability, with a keychain self-check on every upgrade.

---

## Current landscape

### What the three docs actually disagree on

| Axis | harness-architecture.md | frontend-app-shell-stack.md | local-resource-feasibility.md |
|---|---|---|---|
| Execution substrate | SDK `query()` only; PTY = optional UI feature | one node-pty PTY per account running the interactive TUI, daemon-owned | tmux server (new install) owns sessions; node-pty only as attach bridge |
| Session survival | SDK resume/fork | "survive UI restarts by construction" (daemon owns PTYs) | survive harness crash too (tmux outlives the daemon) |
| Login | one-time `claude auth login` per config dir | inside the embedded terminal | (not addressed) |
| Structured events | SDK stream + hooks + OTel + JSONL | (not its topic) | tmux `-CC` control-mode notifications |
| launchd/Keychain | (not addressed) | daemon graduates to a launchd LaunchAgent | "user-domain agents (Aqua session ⇒ Keychain access works)" |
| x1's counter-claim | — | — | "if the harness ever runs as a LaunchAgent/daemon or over SSH, keychain reads fail (#44089)" |

And what they already **agree** on, which this doc treats as settled: per-account `CLAUDE_CONFIG_DIR` (+ pinned `CLAUDE_SECURESTORAGE_CONFIG_DIR`) is the [X1] mechanism; a localhost daemon (not the UI shell) owns all execution; the event plane is hooks + OTel + JSONL + SDK stream; every long-lived agent process is presumed leaky and must be recycled (`checkpoint → kill → resume`); the UI attaches over one WebSocket.

### The launchd/Keychain experiment (load-bearing — run live on this machine, 2026-07-03)

**Background.** macOS keychain availability is governed by the *security session* a process belongs to, not by "is it launchd-run". launchd agents load into per-user domains: the **gui domain** (`gui/<uid>`, session type `Aqua`, exists only while the user is GUI-logged-in) and the **user domain** (`user/<uid>`, session type `Background`, exists whenever any process runs as the user). Apple's guidance (TN2083; Developer Forums) is that keychain APIs that may require user interaction need the Aqua session; without it the Security Server returns "interaction is not allowed" ([thread 696859](https://developer.apple.com/forums/thread/696859), [thread 107763](https://developer.apple.com/forums/thread/107763), [launchd-dev archive](https://launchd-dev.macosforge.narkive.com/MjjZdww0/launchd-launchctl-aqua-session-type-on-osx-tiger)). `LimitLoadToSessionType` defaults to `Aqua` for LaunchAgents.

**Method.** A harness-owned dummy generic-password item (`aibender-probe-dummy`, value = a non-credential marker string) was created in the login keychain. A probe script ran `security find-generic-password` **without** `-w` (metadata search), **with** `-w` *on the dummy item only* (the ACL-gated value-read path — the same call class Claude Code uses for its own items), `security show-keychain-info`, and a **metadata-only presence probe** of the real `Claude Code-credentials` item (never `-w`; no credential value was ever read). The probe ran in three contexts: (1) directly in the interactive shell; (2) as a LaunchAgent bootstrapped into `gui/$UID` with `LimitLoadToSessionType=Aqua`; (3) as a LaunchAgent bootstrapped into `user/$UID` with `LimitLoadToSessionType=Background`. All probe artifacts (agents, plists, dummy item) were removed afterward; removal verified.

**Results.**

| Probe | direct shell | LaunchAgent, gui domain (Aqua) | LaunchAgent, user domain (Background) |
|---|---|---|---|
| `launchctl managername` | `Aqua` | `Aqua` | `Background` |
| find *without* `-w` (metadata) | exit 0 | exit 0 | **exit 0** |
| find *with* `-w` (value read, dummy item) | exit 0, value matched | **exit 0, value matched** | **exit 36, no value** |
| `show-keychain-info` | exit 0 | exit 0 | exit 36 — `SecKeychainCopySettings <NULL>: User interaction is not allowed.` |
| `Claude Code-credentials` presence (metadata) | exit 0 | exit 0 | exit 0 |

Exit 36 corresponds to `errSecInteractionNotAllowed` (−25308): the Background security session does not hold the unlocked login-keychain state, unlocking would require UI, and UI interaction is disallowed in that session.

**Interpretation — the contradiction resolved:**

- **A user-domain (Aqua/gui) LaunchAgent inside an active GUI login session has full keychain access**, including the ACL-gated value reads Claude Code performs for `Claude Code-credentials-<hash>` items. `local-resource-feasibility.md`'s claim is **confirmed** for that context.
- **`x1-parallel-multi-account.md`'s warning is real but mis-scoped.** Issue [#44089](https://github.com/anthropics/claude-code/issues/44089) is specifically about **SSH sessions** (VS Code Remote SSH), where the Security framework has no GUI session to authorize against. The same failure occurs in Background-session agents (demonstrated above), true system daemons (`/Library/LaunchDaemons`), and pre-login contexts. It does **not** occur for a gui-domain LaunchAgent while the user is logged in.
- **Two subtleties that matter for the harness design:**
  1. **Metadata searches succeed even where value reads fail.** The x1-recommended self-check (`security find-generic-password -s <svc>` without `-w`) proves item *existence* anywhere, but does **not** prove the daemon context can actually *read* the credential. The startup self-check must therefore run **in the broker's own execution context** and treat "metadata OK" as necessary, not sufficient; the definitive probe is a `claude auth status --json` call spawned by the broker itself.
  2. **The Aqua gui domain only exists while the user is GUI-logged-in.** A gui-domain broker does not run before login, after logout, or at headless boot. That is the accepted trade: this is a laptop harness for an attended machine. If an unattended/headless mode is ever wanted, that is exactly when x1's rung 2 (`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` per account, paired with that account's `CLAUDE_CONFIG_DIR`/`CLAUDE_SECURESTORAGE_CONFIG_DIR` to contain issue [#37512](https://github.com/anthropics/claude-code/issues/37512)) becomes **mandatory**, or rung 3 (containers with file-based `.credentials.json`).

**Corroborating local fact.** The Homebrew `claude` 2.1.193 binary's strings show all keychain operations shell out to Apple's `security` tool (`security find-generic-password -a …`, `add-generic-password -U -a`, `delete-generic-password -a … -s`). Two consequences: (a) the keychain **ACL "creating application" is `/usr/bin/security`**, an Apple-signed binary stable across Claude Code updates — so the "codesign ACL breaks on every auto-update" theory in [#19456](https://github.com/anthropics/claude-code/issues/19456) cannot be the whole story for current builds (that issue's own reporter marks the root cause unproven; the observed failures were *delete/persist* errors, and the issue was closed not-planned); (b) which claude binary (Homebrew, SDK-bundled, Desktop-managed) performs the read **does not change the ACL identity** — binary choice matters for service-*name derivation* stability, not ACL trust.

### SDK session survival semantics (what actually dies with the broker)

From the [sessions documentation](https://code.claude.com/docs/en/agent-sdk/sessions): the SDK "writes it to disk automatically" — the session file at `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<session-id>.jsonl` accumulates every prompt, tool call, tool result, and response. Resume-by-ID is explicitly designed to "recover from an interruption" and "Restart your process… restore the conversation". Fork (`forkSession: true`) creates a new session ID with copied history; plain `resume` extends the same session. Resume is cwd-scoped (`<encoded-cwd>` must match).

**Loss model when the broker dies mid-`query()`** (SIGKILL, crash, or power loss):

| State | Fate | Recovered by resume? |
|---|---|---|
| Completed messages of the current session (incl. earlier turns of the in-flight `query()`) | Persisted to JSONL as they completed | **Yes** |
| The in-flight assistant turn (partial API generation, streaming deltas) | Lost — partial messages are not persisted; `stream_event` deltas live only in the stream | No (the turn re-runs from the last user/tool message) |
| Queued streaming input (`--input-format stream-json` messages buffered in broker memory, not yet delivered) | Lost with the broker process | No (broker must re-queue from its own ledger) |
| In-loop permission decisions pending in `canUseTool` | Lost; the pending tool call was never executed | No (re-prompted on re-run) |
| The CLI child process itself | Its stdin pipe closes → it terminates; exact orphan behavior (does it finish the current tool call and persist it?) is **unverified** — stage-2 probe | — |
| File mutations already made by tools | Real and on disk (sessions persist the *conversation*, not the filesystem; file checkpointing is the separate mechanism) | n/a |

**Known resume sharp edges** (must be engineered around, not wished away): transcripts that end with a `tool_use` lacking its `tool_result` historically produce `API Error 400: tool_use ids were found without tool_result blocks` on resume ([#8004](https://github.com/anthropics/claude-code/issues/8004), [#11277](https://github.com/anthropics/claude-code/issues/11277)); a (sub)agent transcript ending in an API error can make resume fail *silently* — "0 tool uses · 0 tokens" ([#16861](https://github.com/anthropics/claude-code/issues/16861)). Newer builds repair better (fixes noted around v2.1.156), but the broker should validate a transcript's tail before resuming and, on a malformed tail, resume with `forkSession: true` from the last coherent point or synthesize the missing `tool_result` line — a deliberate, small transcript-repair pass.

**Honest comparison with PTY/tmux survival:**

| Event | SDK `query()` under broker | node-pty TUI under broker | tmux-owned TUI |
|---|---|---|---|
| UI (Tauri window) restart | **survives** (broker owns it) | **survives** | **survives** |
| Broker/daemon restart or crash | in-flight turn lost; auto-resume from ledger | **process dies** (PTY master closes → SIGHUP); respawn `claude --resume` | **live process survives** (tmux server is a separate lineage) |
| tmux server crash / OOM | n/a | n/a | everything dies; resume required anyway |
| Reboot / logout | resume from ledger | resume | resume (tmux state is not reboot-persistent either) |
| In-flight turn across the failure | lost | lost (process died) | **preserved** only for broker-crash; lost for reboot |

The *only* row where tmux beats the daemon design is "live process survives broker crash". Every failure mode ultimately bottoms out in `--resume` anyway (reboots exist), so the harness must build first-class resume regardless — at which point tmux's marginal benefit is shaving one in-flight turn off a rare event, priced at: a new hard dependency (not installed), a second supervisor process outside the broker's control, control-mode (`-CC`) protocol parsing ([tmux wiki](https://github.com/tmux/tmux/wiki/Control-Mode), [iTerm2 integration](https://iterm2.com/documentation-tmux-integration.html)), byte-stream-only semantics (no structured Claude events — those still come from hooks/JSONL), and scrollback duplication. That is a bad trade in v1.

**Recycle-watchdog fit ([X4]).** `local-resource-feasibility`'s "a recycled session is a continuation child" maps onto the SDK path *better* than onto any PTY path: recycle = end/abort the `query()` → kill the child → new `query({ resume: id })` (same lineage node extended, recycle recorded as a harness event) or `query({ resume: id, forkSession: true })` (explicit continuation-child node, when the workstream model wants the recycle visible as lineage). On the PTY path the same loop is `kill` → `claude --resume <id>` respawned into the same xterm view (scrollback replayed via `@xterm/addon-serialize`). Both fit; the SDK path additionally yields the new session ID programmatically from the `init`/`result` messages instead of scraping it.

### Permission relay — the three channels, mapped

- **`canUseTool` (SDK, in-process):** per-tool-call callback relayed to the frontend over the broker's WebSocket; the sessions doc confirms permission prompts and `AskUserQuestion` are handled **in-loop** — they don't end the call. Only available for SDK-spawned sessions. Richest UX (approve / deny / always-allow / edit-input).
- **Hook-based `PermissionRequest` / `PreToolUse` (`type: "http"`, `permissionDecision: allow|deny|ask|defer`):** installed in each account's `settings.json` inside its config dir; works for **every** session in that account — SDK, PTY TUI, and externally launched terminals. This is the universal policy layer and the *only* programmatic gate for TUI sessions.
- **TUI dialog:** the native Claude Code permission dialog rendered in the embedded terminal; the human answers it directly. Zero engineering, human-only.

Layering rule: hooks are the account-wide policy floor (deny-lists, audit, [X4] event capture); `canUseTool` is the interactive relay on top for SDK sessions; TUI dialogs serve attended PTY sessions natively.

---

## Options considered

### Option A — Agent-SDK-only (harness-architecture.md's position)

**How it works.** Every session of every kind is a `query()` call in the broker; interactive use is a harness-built chat UI over the SDK stream; the embedded terminal exists only as an optional pass-through.

**Pros.** One substrate; typed events; in-loop permissions; session list/rename/tag; fork/resume as lineage primitives; bundled pinned binary; no PTY code in the critical path.
**Cons.** The attended experience is a rebuilt chat UI, not the real Claude Code TUI — losing pickers, statusline, `/login`, `/config`, plugin UIs; **auth bootstrap still needs an interactive TUI moment per account** (`claude /login` browser flow), so a PTY path must exist anyway; power users will keep opening real terminals, pushing those sessions into "externally launched" observability.
**Risks.** SDK churn (V2 session API added and removed in 0.3.142); rebuilding TUI affordances is a permanent UI tax.

### Option B — Daemon-owned node-pty TUIs as the primary substrate (frontend-app-shell-stack.md's position)

**How it works.** One PTY per account running interactive `claude`; sessions survive UI restarts because the daemon owns the PTYs; login happens in the embedded terminal.

**Pros.** Pixel-perfect real product UX; login bootstrap trivially solved; PTYs are cheap (~MBs); proven pattern (VS Code ptyHost).
**Cons.** As an *orchestration* substrate it is regex archaeology: no structured events from the byte stream, permission gating only via hooks or human, headless fan-out impossible; PTY children die with the daemon (SIGHUP), so its survival story is strictly weaker than tmux's and equal to the SDK's after a broker crash; scraping breaks per release.
**Risks.** "One PTY per account" also conflates account with session — an account can have N concurrent sessions ([X1] is per-process env, not per-terminal).

### Option C — tmux as the session substrate (local-resource-feasibility.md's position)

**How it works.** `brew install tmux`; one named tmux session per account; harness drives via `-CC` control mode; node-pty only bridges `tmux attach` to xterm.js; watchdog recycles leaky processes.

**Pros.** Live processes survive broker crash/restart; attach from any terminal; one small server owns all panes; control mode gives structured *terminal* events.
**Cons.** Control-mode messages are terminal-plumbing events (`%output`, `%window-add`), not Claude semantics — hooks/JSONL are still required for anything meaningful, so tmux adds a layer without replacing one; new hard dependency; a second stateful supervisor the broker must babysit; `%output` is octal-escaped byte soup for the UI to reparse; tmux state doesn't survive reboot, so resume machinery is required anyway; per-account *sessions* again conflate account and session.
**Risks.** The harness ends up maintaining three protocols (SDK stream, hook envelope, tmux control mode) where two suffice.

### Option D — Reconciled hybrid (recommended)

**How it works.** The SDK is the sole *programmatic* substrate (one-offs, workflow steps, background agents). The real `claude` TUI under daemon-owned node-pty is the sole *attended* surface (and the login-bootstrap path). Semantics never come from the PTY byte stream — they come from hooks (`type:"http"` per account config dir) and JSONL tails, identically for both substrates. No tmux. The broker is a gui-domain Aqua LaunchAgent (v1) or Tauri-managed sidecar (v0 — also inside the Aqua session, so keychain-equivalent).

**Pros.** Each session kind gets its most-native substrate; one event plane; PTY code exists but is never parsed; matches all three docs' *underlying* goals (structured orchestration, UI-restart survival, recycle discipline) with the minimum protocol count.
**Cons.** Two spawn paths to maintain (SDK child vs PTY child) — mitigated by both spawning the *same pinned binary* with the same env-injection layer.
**Risks.** Broker crash kills PTY TUI processes (SIGHUP) — mitigated by the resume ledger + auto-respawn; measured as acceptable because reboot/logout have the same effect under tmux too.

---

## Recommendation (opinionated)

### 1. The substrate matrix

| | (i) Interactive attended | (ii) Headless one-off prompt | (iii) Multi-agent workflow step | (iv) Long-running background agent |
|---|---|---|---|---|
| **Substrate** | Real `claude` TUI in **daemon-owned node-pty**, rendered in xterm.js | **SDK `query()`** (optionally `persistSession:false` for true throwaways; default ON for lineage) | **SDK `query()`** with `resume`/`forkSession` compiling the DAG | **SDK `query()`** in streaming-input mode under the broker |
| **Why** | Full product affordances (`/login`, pickers, dialogs); auth bootstrap requires it; humans consume pixels, not events | Typed stream, `total_cost_usd`, structured output, zero TUI overhead | Fork edges are the [X4] primitive; per-step env selects account; joins in the broker | Interrupt/abort control, in-loop permissions, programmatic session IDs for the recycle loop |
| **Permission relay** | Native TUI dialog (human) + account-level `PermissionRequest`/`PreToolUse` http hooks as policy floor/audit | `canUseTool` → frontend approve/deny; pre-granted `allowedTools` for read-only presets | `canUseTool` + workflow-template `allowedTools`; `--max-budget-usd` on Bedrock-billed steps | `canUseTool` with async human escalation (tray notification); deny-by-default allowlists for unattended stretches; hooks as audit trail |
| **[X4] lineage at action time** | `SessionStart`/`SessionEnd` + tool hooks fire per event; session ID captured from hook payloads/JSONL tail at spawn | Broker writes ledger row at spawn; `session_id` from `init` message; in-process hooks record file touches live | **Strongest cell**: fork edges recorded by construction at spawn; parent/child = `resume`+`forkSession` bookkeeping | Same as (iii); recycle events recorded as continuation edges |
| **Memory-watchdog / recycle** | footprint poll → notify user → graceful kill → respawn `claude --resume <id>` into same xterm view (scrollback via `@xterm/addon-serialize`) | Rarely needed (short-lived); timeout + abort | Per-step recycle = `resume`(+`forkSession`) mid-DAG; completed steps unaffected | **The critical cell**: checkpoint (last message uuid) → abort/kill child → `query({resume})`; recycle edge recorded |
| **Survives UI restart** | Yes (daemon owns PTY) | Yes | Yes | Yes |
| **Survives daemon restart** | No (SIGHUP) → auto-respawn `--resume` from ledger on boot | N/A (short) or re-run from ledger | Scheduler resumes DAG from ledger; completed step sessions intact | In-flight turn lost; auto-`resume` on broker boot per ledger policy |
| **xterm.js attach path** | Direct: PTY bytes as binary WS frames, flow-controlled | None; streamed transcript view in UI | None; step-inspector UI; debugging escape hatch: spawn a PTY `claude --resume <id> --fork-session` (never attach two live processes to one session ID) | Same escape hatch as (iii), only while the SDK query is paused/ended |

Cross-cutting: **every** cell spawns with the account's `CLAUDE_CONFIG_DIR` + pinned `CLAUDE_SECURESTORAGE_CONFIG_DIR` and scrubbed provider env (`ANTHROPIC_API_KEY` etc.) per x1's rules. [X1] parallelism is env-per-child-process; nothing in this matrix serializes accounts.

### 2. The launchd/Keychain ruling

- **The broker daemon MUST live in the user's Aqua session**: v0 as a Tauri-managed sidecar (child of the GUI app — same session), v1 as a LaunchAgent bootstrapped into `gui/$UID` with default (`Aqua`) session type, `RunAtLoad`, `KeepAlive={SuccessfulExit:false}`. **Never** `LimitLoadToSessionType=Background`, never `user/$UID` bootstrap for the credential-touching path, never a system daemon.
- Verified consequence: daemon-spawned `claude` processes read their `Claude Code-credentials-<hash>` items normally; no setup-token required for ordinary operation.
- **setup-token env injection becomes mandatory only** where the Aqua session is absent: SSH access to the machine, pre-login/boot automation, any future Background-domain helper, and containers (which use the documented Linux file store instead). Keep rung 2 implemented-but-dormant: mint one token per account into harness-owned Keychain items, inject only in flagged contexts, always paired with that account's config/securestorage dirs (#37512 containment).
- The broker's startup self-check must run **in its own context**: recompute expected service names (`sha256(dir)[0:8]` suffix per x1), `security find-generic-password -s <svc>` (no `-w`) for presence, then a real `claude auth status --json` per account as the value-read proof (metadata success ≠ value access — demonstrated by the Background-domain probe, where metadata reads passed and value reads failed).

### 3. Recycle and lineage semantics (SDK path, normative)

- A **recycle** (watchdog-triggered) = abort query → kill child → `query({resume: id})`; record a `recycle` event on the same workstream node. When the workstream view should show the break explicitly, use `forkSession: true` and mark the new session a *continuation child* — this is `local-resource-feasibility`'s model, natively expressible.
- Before any resume, run the **transcript-tail validator**: last line must close the tool_use/tool_result pairing; on violation, repair or fork from the last coherent message (mitigates #8004/#11277/#16861).
- The broker writes the **resume ledger row before spawning** (`{workstream, account, sessionId?, cwd, substrate, purpose}` in SQLite; sessionId backfilled from `init`): this is what turns every crash class — broker, UI, reboot — into "resume from ledger on next boot".

### 4. Binary/version strategy

- **Standardize on the SDK's bundled per-platform binary** (`@anthropic-ai/claude-agent-sdk-darwin-arm64`, selected via optionalDependencies) as **the one binary the harness ever spawns** — for SDK sessions implicitly, and for PTY TUI sessions explicitly by launching the same bundled binary path (`pathToClaudeCodeExecutable` documents its location; it is the full native CLI). One version everywhere; upgraded only by bumping the SDK dependency deliberately.
- This *supersedes* x1's "standardize on Homebrew" — but honors its intent: the actual finding is that keychain **ACLs anchor to `/usr/bin/security`** (the binary shells out for all keychain ops — verified in the 2.1.193 strings), so install channel doesn't affect ACL trust. What version drift *does* threaten is (a) the undocumented service-name derivation, (b) hook/JSONL schema, (c) resume-repair behavior. Pinning one binary controls all three; Homebrew's global auto-updating `claude` (2.1.193) and Claude Desktop's private copy (2.1.197 observed) stay for human/desktop use and are labeled "externally-owned" in observability.
- **Upgrade checklist (each SDK bump):** service-name recompute + presence probe per account; `claude auth status --json` per account from the broker context; #37512 canary (env-token process exit must not delete the default keychain entry); transcript-schema smoke test (parse one fresh JSONL); hook-event smoke test.

### 5. tmux verdict

**Not in v1.** No install, no control-mode parser, no tmux sessions. Its unique property — live processes surviving a broker crash — is replaced by (a) making the broker itself boring and supervised (launchd `KeepAlive`, small surface, no PTY parsing, watchdogged), and (b) universal resume: ledger + `--resume`/SDK `resume` covering broker crash, reboot, and logout identically. What is knowingly given up: one in-flight turn per broker crash, and attach-from-any-terminal (partially recoverable later: a `aibender attach` CLI that opens a PTY on `claude --resume`). **Re-open trigger:** if stage-2 soak tests show broker MTBF low enough that in-flight-turn loss is felt weekly, or if external-terminal attach becomes a real workflow need — then tmux enters scoped exactly as `local-resource-feasibility` drew it (interactive account sessions only, control mode, `history-limit` capped), not as the orchestration substrate.

---

## Implications for the harness

1. **Broker = gui-domain Aqua LaunchAgent (v1), Tauri sidecar (v0).** Ship the plist template with default session type and `KeepAlive={SuccessfulExit:false}`; document loudly that moving it to `user/$UID`, `Background`, or a system daemon silently breaks subscription auth (exit-36 class failures).
2. **Two spawn paths, one spawner.** A single `spawnClaude(account, purpose, opts)` layer owns env injection (config dir, securestorage dir, env scrub, OTel vars) and chooses SDK-child vs node-pty-child; both execute the same pinned bundled binary. PTY output is never parsed — semantics flow exclusively from hooks + JSONL + SDK stream, keeping the event plane identical across substrates.
3. **Resume ledger is core infrastructure**, not a feature: row-before-spawn, sessionId backfill, transcript-tail validation before every resume, boot-time reconciliation (respawn attended TUIs, offer-resume for background agents). This single mechanism delivers UI-restart survival, daemon-restart recovery, reboot recovery, and the [X4] continuation-child model.
4. **Permission architecture is two-layer**: account-wide http hooks (`PermissionRequest`/`PreToolUse` with `permissionDecision`) as the policy floor covering TUI and external sessions; `canUseTool` as the interactive relay for SDK sessions. The frontend renders both through one approval inbox.
5. **Auth bootstrap flow**: first-run wizard opens the embedded PTY terminal per account dir → `claude /login` → broker verifies via `auth status --json` → badge green. No credential ever transits the harness; the PTY is the login surface, exactly as `frontend-app-shell-stack` wanted.
6. **Keychain self-check runs in-context** (broker-spawned, not install-script-run), on every boot and every SDK bump. Metadata probe ≠ value probe; both are needed.
7. **Stage-2 spikes inherited from this decision:** (a) orphan behavior of the CLI child when the broker is SIGKILLed mid-turn (does the current tool call complete and persist?); (b) `claude --resume` fidelity for TUI respawn after kill (scrollback replay + history correctness); (c) soak-test broker MTBF to validate the no-tmux bet; (d) confirm the bundled SDK binary runs the interactive TUI identically to the standalone install (expected — same native binary — but verify pickers/login).

---

## Sources

**Local experiments and inspection (this machine, 2026-07-03 — probe artifacts created and removed):**
- launchd keychain probe: dummy generic-password item + probe script run in direct shell, `gui/$UID` (Aqua) LaunchAgent, and `user/$UID` (Background) LaunchAgent; results table above (`launchctl managername`, `security find-generic-password` with/without `-w` on the dummy item, `show-keychain-info`, metadata-only presence probe of `Claude Code-credentials`). Cleanup verified (item delete exit 44 on re-probe).
- `launchctl managername` in the working shell = `Aqua`; `launchctl print gui/$UID` type = login.
- `strings` on `/opt/homebrew/bin/claude` (2.1.193, Mach-O arm64): `security find-generic-password -a`, `add-generic-password -U -a`, `delete-generic-password -a … -s`, `.oauth_refresh.lock`, `CLAUDE_SECURESTORAGE_CONFIG_DIR` — keychain ops shell out to `/usr/bin/security`.
- `claude --version` = 2.1.193 (Homebrew); Claude Desktop-managed copy at `~/Library/Application Support/Claude/claude-code/2.1.197/claude.app`; `tmux` not installed.

**Apple / launchd / keychain:**
- https://developer.apple.com/forums/thread/696859 — LaunchAgent session types; Aqua default; GUI-context detection (Apple DTS)
- https://developer.apple.com/forums/thread/107763 — LimitLoadToSessionType semantics
- https://launchd-dev.macosforge.narkive.com/MjjZdww0/launchd-launchctl-aqua-session-type-on-osx-tiger — Aqua session requirement for Security Server interaction ("Interaction with the Security Server is not allowed" outside Aqua)
- https://developer.apple.com/library/archive/technotes/tn2083/_index.html — TN2083 Daemons and Agents (execution-context background)

**Claude Code issues:**
- https://github.com/anthropics/claude-code/issues/44089 — SSH keychain failure (scope: SSH, not GUI LaunchAgents); file-fallback workaround
- https://github.com/anthropics/claude-code/issues/19456 — post-update keychain persist/delete failures (root cause unproven; closed not-planned)
- https://github.com/anthropics/claude-code/issues/37512 — env-token exit deleting default keychain entry (containment per x1)
- https://github.com/anthropics/claude-code/issues/8004 · https://github.com/anthropics/claude-code/issues/11277 — resume 400 `tool_use`/`tool_result` mismatch after interruption
- https://github.com/anthropics/claude-code/issues/16861 — silent resume failure when transcript ends with an API error

**Agent SDK:**
- https://code.claude.com/docs/en/agent-sdk/sessions — persistence, continue/resume/fork semantics, cwd scoping, interruption recovery, `persistSession`
- https://code.claude.com/docs/en/agent-sdk/typescript — options incl. `pathToClaudeCodeExecutable`
- https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md — per-platform bundled binaries via optionalDependencies; V2 session API removal (0.3.142)
- https://github.com/anthropics/claude-agent-sdk-typescript/issues/205 — pathToClaudeCodeExecutable resolution behavior
- https://github.com/anthropics/claude-code-action/issues/1242 — SDK bundled-binary distribution mechanics
- https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk

**tmux control mode:**
- https://github.com/tmux/tmux/wiki/Control-Mode — `-CC` protocol, `%output` octal escaping
- https://iterm2.com/documentation-tmux-integration.html — the reference control-mode consumer

**Sibling findings docs (inputs being reconciled):** `harness-architecture.md`, `frontend-app-shell-stack.md`, `local-resource-feasibility.md`, `x1-parallel-multi-account.md` (this repo, `docs/research/findings/`).

---

## Open questions

1. **CLI-child orphan behavior on broker SIGKILL:** does the child finish (and persist) the current tool call before exiting on stdin EOF/EPIPE, or abort immediately? Determines whether a broker crash loses a whole turn or only its unpersisted tail. Stage-2 probe: kill a broker mid-tool-call, diff the JSONL tail.
2. **Keychain behavior at screen-lock:** the probe ran with the session unlocked. Does an Aqua LaunchAgent retain keychain reads while the screen is locked (login keychain typically stays unlocked, but "lock keychain on sleep" settings exist)? Matters for overnight background agents; test with display sleep + `security find-generic-password -w` on a fresh dummy item.
3. **Bundled-binary TUI parity:** confirm the SDK's darwin-arm64 binary run interactively is byte-identical in behavior to the standalone install (login flow, pickers, statusline) before making it the PTY-spawned binary.
4. **Transcript-repair recipe:** exact minimal JSONL edit (synthesized `tool_result`? truncate to last user message?) that current pinned versions accept on resume after a mid-tool-call kill — needed to code the tail validator.
5. **`persistSession: false` interaction with hooks/JSONL observability:** for throwaway one-offs, do hooks still fire and does OTel still attribute? If persistence-off also silences lineage, default it ON everywhere.
6. **Broker MTBF soak:** the no-tmux bet assumes a boringly stable broker; measure crash frequency under 8-session load for a week before v1 sign-off (re-open trigger defined in the tmux verdict).
7. **Aqua-agent behavior across fast user switching:** if a second macOS user logs in (x1's rung 4 fallback), does the first user's gui-domain broker keep keychain access while backgrounded? Relevant only if rung 4 is ever activated.
8. **Does Claude Desktop's 2.1.197 copy contend with harness sessions** on shared account stores (30 s keychain cache, refresh lock) when both run the same account? The refresh lock is per-store, so it should serialize correctly — verify once during stage 2.
