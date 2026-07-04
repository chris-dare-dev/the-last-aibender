# App Shell + Frontend Architecture for the-last-aibender (macOS-first harness)

**Stage-1 discovery research — no code. Researched 2026-07-03.**
Scope: app shell (Tauri v2 vs Electron vs pure local web app), PTY/terminal embedding, process
supervision, streaming transport, WebGL/WebGPU, memory budget, tray/notifications,
packaging/signing, LM Studio localhost reachability, frontend framework, state management,
virtualized rendering. Account identifiers are placeholders only: MAX_A, MAX_B, ENT,
AWS_DEV_ACCOUNT_ID.

---

## TL;DR

1. **Recommend: Tauri v2 shell + a detached local TypeScript "core" daemon (Node 22 + node-pty + WebSocket) + Svelte 5 + xterm.js/WebGL + three.js (WebGL2) force graph.**
2. The decisive architectural move is **shell-agnosticism**: put PTYs, child-process supervision, file watching, and all state in a localhost daemon; the UI talks to it over WebSocket. The shell (Tauri window, or any browser tab) becomes a thin, replaceable veneer.
3. This makes [X1] robust: one PTY per Claude account (`CLAUDE_CONFIG_DIR` per account) lives in the daemon, so sessions **survive UI restarts** — which also directly serves workstreams [X4].
4. Tauri v2 wins the shell on RAM (~45–90 MB vs ~180–400+ MB for Electron), native tray/notifications, and tiny signed artifacts; its weaknesses (IPC throughput, node-pty absence, WKWebView quirks) are all neutralized by the daemon+WebSocket design.
5. WebGPU inside WKWebView is **not dependable in 2026** even on macOS 26; ship the 3D graph on WebGL2 (fully supported), treat WebGPU as a progressive enhancement — or open the same UI in Chrome, which the daemon architecture allows for free.
6. Electron remains the safe fallback (Chromium consistency, mature node-pty story à la VS Code); the design keeps that door open at low cost.
7. A pure browser app is the leanest but loses menubar/tray, native notifications, and window management — rejected as primary, retained as a free secondary access mode.
8. Budget check on the 36 GB M4 Max: recommended stack idles ≈ 250–400 MB total, leaving ~30 GB for LM Studio models.

---

## Current landscape (2025–2026)

### Shells in the wild for exactly this class of app

| Prior-art app | Shell | Notes |
|---|---|---|
| **opcode** (ex-Claudia) — GUI/toolkit for Claude Code sessions, agents, usage dashboard | **Tauri 2** + React + Rust backend | Closest existing analogue to this harness; AGPL. ([github.com/winfunc/opcode](https://github.com/winfunc/opcode)) |
| **Crystal / Nimbalyst** — parallel Claude Code/Codex sessions in git worktrees | **Electron** | Session persistence, multi-session mgmt; Crystal deprecated in favor of Nimbalyst. ([github.com/stravu/crystal](https://github.com/stravu/crystal)) |
| **Vibe Kanban** (BloopAI) — kanban orchestration of Claude Code/Codex/Gemini agents | **Rust (axum) backend + React UI in the browser (localhost)** | Local-first, SQLite+SQLx, `ts-rs` generates TS types from Rust structs, git worktrees per task. ([github.com/BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban)) |
| **VS Code** — the reference embedded-terminal architecture | Electron | PTYs moved out of the renderer into a dedicated **ptyHost utility process**, talking over MessagePorts — the pattern to copy regardless of shell. ([code.visualstudio.com sandbox blog](https://code.visualstudio.com/blogs/2022/11/28/vscode-sandbox)) |
| Claude Desktop / Claude Code desktop surface | Electron | Anthropic's own desktop shell is Electron; multiple parallel Claude Code sessions shipped there in 2026. |

All three candidate architectures are proven for "supervise many coding-agent sessions on a Mac."
The differentiators are resource cost, native integration, and rendering-stack guarantees.

### Platform facts that matter this year

- **Versions (verified/current):** Claude Code 2.1.193 installed locally; host is macOS 26.6 (Tahoe) on M4 Max/36 GB. Tauri stable is 2.11.x (May 2026, [docs.rs](https://docs.rs/crate/tauri/latest)); Electron stable is v42.x (June 2026, [releases.electronjs.org](https://releases.electronjs.org/)).
- **WKWebView** (Tauri's macOS engine) updates with the OS — on macOS 26 it is the Safari 26-class WebKit ([v2.tauri.app/reference/webview-versions](https://v2.tauri.app/reference/webview-versions/)).
- **WebGPU:** Safari 26 ships WebGPU **enabled by default on macOS Tahoe 26** ([webkit.org WWDC25](https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/); [gpuweb wiki](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status)). **BUT** the gpuweb status page cautions that embedded webviews (Android WebView, iOS WKWebView) do **not** ship WebGPU on by default; the macOS-WKWebView-in-Tauri case is undocumented and an old Tauri feature request to expose experimental-feature flags was closed "not planned" ([tauri#6381](https://github.com/tauri-apps/tauri/issues/6381)). Treat WebGPU-in-Tauri as *unverified* until spiked. WebGL2 in WKWebView is mature (ANGLE-on-Metal) and is what three.js uses by default.
- **WKWebView caps rendering at 60 fps**; a community Tauri plugin exists to unlock ProMotion >60 fps ([tauri-plugin-macos-fps](https://github.com/userFRM/tauri-plugin-macos-fps)). Cosmetic, not blocking.
- **PTY libraries:** `node-pty` 1.1.x is the battle-tested standard (VS Code, Hyper, Tabby); native module, needs `@electron/rebuild` inside Electron and has recurring ABI/prebuild friction there ([microsoft/node-pty#728](https://github.com/microsoft/node-pty/issues/728), [Electron native-modules docs](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)). Rust has wezterm's solid `portable-pty`; Tauri has a thin young wrapper `tauri-plugin-pty` 0.1.x (single maintainer, Aug 2025) ([github.com/Tnze/tauri-plugin-pty](https://github.com/Tnze/tauri-plugin-pty), [lib.rs](https://lib.rs/crates/tauri-plugin-pty)). **New in Dec 2025:** Bun 1.3.5 shipped native PTY support (`Bun.spawn({ terminal })` / `Bun.Terminal`) on POSIX ([bun.com/blog/bun-v1.3.5](https://bun.com/blog/bun-v1.3.5)).
- **Streaming norms:** every major LLM provider streams tokens over **SSE**; industry guidance is "SSE for one-way token streams, WebSocket when you need bidirectional control (interrupts, tool events, multi-session multiplexing)" ([websocket.org AI guide](https://websocket.org/guides/websockets-and-ai/), [zknill.io](https://zknill.io/posts/ai-token-streaming-isnt-about-sse-vs-websockets/)). Note browsers cap SSE at ~6 concurrent connections per origin over HTTP/1.1 — a real constraint for "many parallel sessions."
- **Tauri IPC:** historically string-serialized through the webview bridge — the known bottleneck ([tauri discussion #5690](https://github.com/tauri-apps/tauri/discussions/5690)). Tauri v2 added `Channel` (ordered, used internally for child-process output streaming) and raw-body invoke, and async custom-protocol streaming ([v2.tauri.app/develop/calling-frontend](https://v2.tauri.app/develop/calling-frontend/), [IPC concepts](https://v2.tauri.app/concept/inter-process-communication/)). Community guidance for sidecar/event-bus cases is still "just use a localhost WebSocket" ([tauri discussion #4492](https://github.com/orgs/tauri-apps/discussions/4492)); an SSE-alternative feature request is open ([#14552](https://github.com/orgs/tauri-apps/discussions/14552)).
- **xterm.js:** `@xterm/xterm` 5.x + `@xterm/addon-webgl` (WebGL2 renderer, ~3–5× faster than DOM/canvas) is the standard; xterm.js maintains an official **flow-control guide** (pause/resume, LOW/HIGH watermarks ≤500 KB, ack-based backpressure over WebSocket) — mandatory for fast PTY output ([xtermjs.org/docs/guides/flowcontrol](https://xtermjs.org/docs/guides/flowcontrol/), [#2077](https://github.com/xtermjs/xterm.js/issues/2077)).
- **Multi-account Claude sessions:** `CLAUDE_CONFIG_DIR` gives a fully isolated Claude Code identity (credentials, settings, history, plugins) per directory; both accounts run **simultaneously with no re-login**, since the env var is read at process launch ([blog.ambi.se](https://blog.ambi.se/two-claude-accounts-parallel), [wmedia.es](https://wmedia.es/en/tips/claude-code-multiple-profiles-config-dir)). This is what makes "one PTY per account" the concrete mechanism for [X1]: the shell just needs to spawn N PTYs with different env.
- **LM Studio:** OpenAI-compatible server on `127.0.0.1:1234`, controlled by the `lms` CLI (`lms server start --port 1234 --cors`), with a headless daemon option (`llmster`) ([lmstudio.ai/docs/developer/core/server](https://lmstudio.ai/docs/developer/core/server), [headless](https://lmstudio.ai/docs/developer/core/headless), [lms CLI](https://lmstudio.ai/docs/cli)). Verified locally: LM Studio.app installed, `lms` at `~/.lmstudio/bin/lms`, server currently **down** (connection refused) — the harness must health-check and ideally auto-start it via `lms server start`.

---

## Options considered

### Option A — Electron shell

**How it works.** Bundled Chromium + Node.js. Renderer(s) show the UI; main process (Node) spawns
`claude`/`opencode` via `child_process`/`node-pty`; VS Code-style hardening moves PTYs into a
`utilityProcess` ptyHost connected by MessagePorts ([Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process), [process model](https://www.electronjs.org/docs/latest/tutorial/process-model)).

**Pros**
- Chromium everywhere: identical rendering, best DevTools, **mature WebGPU today** (Chromium has shipped WebGPU on macOS since 2023) — zero risk for the 3D context graph.
- `node-pty` runs in-process; the exact VS Code ptyHost pattern is documented and battle-tested.
- Most mature packaging/auto-update ecosystem (electron-builder/Forge + `@electron/notarize`).
- Tray (`Tray`), `Notification`, global shortcuts, multi-window — all first-class and stable.
- Biggest body of AI-codegen-friendly examples (Crystal, Hyper, Tabby, VS Code are all open source).

**Cons**
- RAM/disk: ~180 MB+ idle baseline, each `BrowserWindow` is another renderer process; bundles
  100 MB+; comparisons consistently show 50–75 % higher memory than Tauri ([pkgpulse](https://www.pkgpulse.com/guides/electron-vs-tauri-2026), [buildmvpfast](https://www.buildmvpfast.com/blog/tauri-v2-vs-electron-desktop-apps-2026)); Hoppscotch measured −70 % memory and 165 MB→8 MB bundle after migrating away ([openreplay blog](https://blog.openreplay.com/comparing-electron-tauri-desktop-applications/)).
- Native-module churn: `node-pty` must be rebuilt per Electron ABI; recurring breakage
  ([node-pty#728](https://github.com/microsoft/node-pty/issues/728)); prebuilt-multiarch forks exist as mitigation ([@homebridge/node-pty-prebuilt-multiarch](https://github.com/homebridge/node-pty-prebuilt-multiarch)).
- Chromium security-update treadmill (8-week majors) for a personal tool.

**Risks.** Mostly cost/weight, not feasibility. On a 36 GB machine that also hosts LM Studio
models (4–20 GB each), a 400–800 MB shell is tolerable but wasteful; the bigger risk is
"Electron gravity": everything ends up in the main process, coupling session lifetime to the UI.

### Option B — Tauri v2 shell

**How it works.** Rust core process + system WKWebView on macOS. UI ↔ Rust via invoke/events/
Channels; child processes via the shell plugin/sidecars; PTYs via `portable-pty`
(`tauri-plugin-pty`) or an external Node sidecar; tray via built-in `TrayIcon`; notifications via
the notification plugin ([v2.tauri.app](https://v2.tauri.app/)).

**Pros**
- Lightest real app shell: ~30–90 MB idle, single-digit-MB bundles ([pkgpulse](https://www.pkgpulse.com/guides/electron-vs-tauri-2026), [tech-insider](https://tech-insider.org/tauri-vs-electron-2026/)).
- First-class macOS tray, menus, notifications, multi-window, deep links; signing/notarization built into `tauri build` via `APPLE_ID`/`APPLE_API_KEY` env ([v2.tauri.app/distribute/sign/macos](https://v2.tauri.app/distribute/sign/macos/)).
- Rust core is a real systems runtime: file watching (FSEvents), SQLite, process supervision are
  cheap and robust; precedent: opcode and Vibe Kanban both orchestrate Claude Code from Rust.
- WKWebView on macOS 26 is a current-generation engine (Safari 26 features, WebGL2 solid).

**Cons**
- **IPC bridge is the weak spot** for high-frequency token/PTY streams: string/JSON serialization
  through the webview bridge; v2 Channels help but community practice for streaming-heavy apps is
  still localhost WebSockets ([#5690](https://github.com/tauri-apps/tauri/discussions/5690), [#4492](https://github.com/orgs/tauri-apps/discussions/4492)).
- **WebGPU unverified in WKWebView-embedded contexts** (see landscape); WebGL2 is the safe floor.
- No Node in-process: `node-pty` unavailable unless you run a Node/Bun **sidecar**; the native
  Rust PTY plugin is young (0.1.x, one maintainer). `portable-pty` itself (wezterm) is solid.
- WKWebView quirks: 60 fps cap (plugin workaround exists), occasional macOS-version crashes in
  wry ([wry#1576](https://github.com/tauri-apps/wry/issues/1576)), Safari-not-Chrome rendering deltas, weaker devtools.
- Sidecar (`externalBin`) signing/notarization has known sharp edges ([tauri#11992](https://github.com/tauri-apps/tauri/issues/11992)).
- Fetching `http://127.0.0.1:1234` from the `tauri://`-scheme page is cross-origin: needs LM Studio
  `--cors`, the official `@tauri-apps/plugin-http` (Rust-side fetch, bypasses webview CORS), or a
  community transparent-CORS plugin ([tauri-plugin-cors-fetch](https://github.com/idootop/tauri-plugin-cors-fetch)) — or simply proxying through the local daemon (recommended).

**Risks.** If PTY streaming were forced through Tauri IPC and the graph forced onto WebGPU, this
option would be risky. Both risks are removed by the daemon+WebSocket+WebGL2 design below.

### Option C — Pure local web app (localhost daemon + your own browser)

**How it works.** A local server (Rust axum like Vibe Kanban, or Node/Bun) owns PTYs, child
processes, files, DB; UI is a plain SPA served on `http://127.0.0.1:PORT`, opened in Chrome/Safari.

**Pros**
- Zero shell overhead beyond the browser you already run; zero packaging/signing/notarization —
  distribute via `brew`/`npx`/git clone. No Gatekeeper at all.
- Chrome gives you **full WebGPU + the best devtools** for the 3D graph, free.
- WebSocket/SSE transport is native to this shape; N sessions multiplex over one WS.
- Trivially remote-able later (Tailscale to the daemon) and k3s-friendly [X3] — the UI doesn't
  care where the daemon runs.

**Cons**
- **No menubar/tray, no reliable native notifications, no global shortcuts, no dock presence, no
  window management.** Web Notifications from a localhost origin work but are second-class.
- Background-tab throttling: timers and rAF are throttled/paused in hidden tabs (WS delivery
  continues); the "live" graph freezes when not visible.
- Lives inside browser chrome — tab loss, ⌘W hazards, no app identity.
- Port management, browser-profile variance, and "is the daemon running?" UX are on you.

**Risks.** The missing tray/notifications directly conflict with the harness's ambient-monitoring
role (usage alerts, session-finished notifications). Mitigations (SwiftBar/xbar plugin, Raycast
extension) are glue, not architecture.

### Option D (recommended) — Tauri v2 shell over a shell-agnostic localhost core

**How it works.** Fuse B and C:

```
┌──────────────────────────── macOS ────────────────────────────┐
│  Tauri v2 app (tray, notifications, windows, WKWebView UI)    │
│        │  WebSocket ws://127.0.0.1:PORT  (+ REST for CRUD)    │
│        ▼                                                      │
│  aibender-core daemon (TypeScript, Node 22 LTS)               │
│   ├─ ptyHost: node-pty → one PTY per session;                 │
│   │    per-account env: CLAUDE_CONFIG_DIR=~/.claude-max-a|b|… │
│   ├─ supervisor: spawn/restart claude, opencode; exit codes   │
│   ├─ watchers: .claude/ dirs, OpenCode JSON, JSONL transcripts│
│   ├─ providers: Bedrock cost math, LM Studio health/autostart │
│   └─ store: SQLite (sessions, workstreams lineage, metrics)   │
└───────────────────────────────────────────────────────────────┘
```

- The daemon is the **only** owner of PTYs and child processes → sessions survive UI reload/crash
  (VS Code ptyHost precedent, generalized out-of-process).
- The Tauri app is packaging + tray + notifications + a WKWebView pointed at the same SPA the
  daemon serves. Tauri IPC is used **only** for native affordances (tray menu events, notification
  clicks, window control), never for token/PTY streams.
- Because the UI is a plain web app on localhost, **Chrome is a free second front-end** whenever
  WebGPU or Chromium devtools are wanted — and Electron remains a drop-in shell swap if WKWebView
  ever becomes a blocker. This is the cheap insurance policy on every WKWebView risk above.
- Daemon runs as a Tauri-managed sidecar in v0 (simplest), graduating to a `launchd` LaunchAgent so
  sessions persist even when the app is closed (aligns with [X4] workstreams).

**Why Node (not Rust, not Bun) for the core.** (a) `node-pty` is the most battle-tested PTY layer
in existence for exactly this workload; (b) the Claude ecosystem to be reused is TypeScript —
the Agent SDK, usage parsing à la `ccusage` over `~/.claude` JSONL, OpenCode config parsing;
(c) no Electron-ABI rebuild pain because it's plain Node, prebuilds just work; (d) Bun 1.3.5's
native PTY is attractive but three-months-old — revisit at Stage 2; (e) Rust (axum +
portable-pty, the Vibe Kanban shape) is a fine core too, but every feature of this harness is
glue around TS-centric artifacts, and dev velocity with AI codegen is materially higher in TS.
Type-safety across the WS boundary via a shared `zod`/TS schema package (Vibe Kanban solves the
same problem with `ts-rs` from the Rust side).

**Transport choice.** One multiplexed WebSocket per UI surface, with logical channels
(`session/<id>/pty`, `session/<id>/events`, `graph/updates`, `metrics`). WS over SSE because:
bidirectional (stdin, resize, interrupts, tool-approval responses), no 6-connection HTTP/1.1 SSE
cap with many parallel sessions, and xterm.js flow control needs client→server acks
([xtermjs flowcontrol](https://xtermjs.org/docs/guides/flowcontrol/)). PTY bytes ride as binary
frames; JSON events as text frames. Implement watermark backpressure (pause/resume the PTY when
the socket send-buffer or client ack lag crosses HIGH ≈ 256–500 KB).

**Pros.** Best-of-all: lightest shell with full native affordances; UI portable across
WKWebView/Chrome/Electron; sessions decoupled from UI lifetime; k3s-migration story for the
daemon [X3]; zero Tauri-IPC throughput exposure; LM Studio reached server-side (no CORS at all).
**Cons.** Two processes to build and version instead of one; sidecar signing gotcha
([tauri#11992](https://github.com/tauri-apps/tauri/issues/11992)) when notarizing; slightly more
initial plumbing than "everything in Electron main".
**Risks.** Low. The riskiest components (WKWebView WebGPU, tauri-plugin-pty, Bun PTY) are all
*out* of the critical path.

---

## Per-axis comparison (summary table)

| Axis | Electron | Tauri v2 | Pure web app | Option D |
|---|---|---|---|---|
| PTY layer | node-pty in utilityProcess (proven, ABI pain) | tauri-plugin-pty 0.1.x (young) or sidecar | node-pty/Bun in server | **node-pty in daemon — proven, no ABI pain** |
| Child-process supervision | main/utilityProcess | Rust (excellent) or sidecar | server process | **daemon (plain Node child_process)** |
| Token/PTY streaming | Electron IPC (fine) | Tauri IPC/Channels (historic bottleneck) | WS/SSE native | **WS on 127.0.0.1, binary frames + flow control** |
| WebGL2 (3D graph floor) | ✅ | ✅ (ANGLE/Metal) | ✅ | ✅ |
| WebGPU 2026 | ✅ mature | ⚠️ unverified in WKWebView embed | ✅ in Chrome | ⚠️ in shell / ✅ via Chrome mode |
| Idle RAM (shell only) | ~180–400 MB | ~30–90 MB | ~0 (existing browser) | ~50–150 MB shell + ~80–150 MB daemon |
| Tray/menubar + notifications | ✅ mature | ✅ TrayIcon + notification plugin | ❌ | ✅ (Tauri side) |
| macOS packaging/signing | electron-builder + @electron/notarize, heavy | built-in notarize flow, tiny DMG; sidecar gotcha | none needed | Tauri flow; personal builds can skip notarization |
| LM Studio localhost | ✅ | CORS nuance from tauri:// origin | ✅ (CORS flag) | ✅ daemon-proxied, no CORS |
| Sessions survive UI restart | only if utilityProcess detached (unusual) | only via sidecar/daemon | ✅ | ✅ **by construction** |

## Frontend framework, state, and rendering

**Framework — Svelte 5 (runes).** The three candidates in 2026: SolidJS has the most surgical
signal updates; Svelte 5 runes achieve near-identical fine-grained updates at compile time with a
larger ecosystem and gentler DX; React 19 + Compiler narrows the gap but keeps re-render semantics
([pkgpulse reactivity guide](https://www.pkgpulse.com/guides/solidjs-vs-svelte-5-vs-react-reactivity-2026), [leapcell](https://leapcell.io/blog/next-gen-reactivity-rethink-preact-solidjs-signals-vs-svelte-5-runes)).
Two harness-specific observations shrink the stakes: the two hottest surfaces — terminals
(xterm.js renders to its own canvas) and the 3D graph (three.js render loop) — **bypass the
framework's DOM entirely**; and TanStack Virtual ships adapters for React/Solid/Svelte alike.
Svelte 5 is the pick: rune stores in plain `.svelte.ts` modules are exactly the "session registry
+ per-session state" shape needed, bundles are smallest, and there is no dependency-array/memo
tax while streaming. **Fallback:** React 19 + zustand (with transient `subscribe` for
high-frequency paths — [zustand docs/discussions](https://github.com/pmndrs/zustand/discussions/1179)) if AI-codegen fluency/ecosystem is later judged to matter more; the swap
cost is contained to the chrome around canvas components.

**State model for many concurrent live sessions.**
- **Event-log first:** each session's stream lands in a non-reactive append-only ring buffer
  (plain JS array/`Uint8Array`, capped) owned by a WS demultiplexer — *never* pushed token-by-token
  into reactive state.
- **Batched projection:** a rAF- (or 30–60 ms-) throttled flush derives reactive summaries
  (last message, token counts, status, cost) into per-session rune stores; panes subscribe only to
  their session's store. This is the standard high-frequency-stream discipline ([sitepoint re-render chaos](https://www.sitepoint.com/streaming-backends-react-controlling-re-render-chaos/)).
- Session registry: `Map<sessionId, SessionHandle>` in a module store; workstream lineage [X4] is
  daemon-side SQLite, mirrored read-only in the UI.

**Terminal rendering.** `@xterm/xterm` + `@xterm/addon-webgl` (WebGL2 renderer, works in
WKWebView), `@xterm/addon-fit`, `@xterm/addon-serialize` (persist scrollback; reattach after UI
restart by replaying serialized state from the daemon), watermark flow control per the xterm.js
guide. For dozens of live sessions: render only visible terminals; headless `@xterm/headless` in
the daemon can maintain scrollback for detached sessions.

**Log/transcript rendering.** TanStack Virtual with the new **end-anchored virtualization**
(`anchorTo: 'end'`): purpose-built for streaming chat/agent logs — append-follow only when pinned
to bottom, prepend-stable history, handles items that resize while tokens stream in
([tanstack.com/blog/tanstack-virtual-chat](https://tanstack.com/blog/tanstack-virtual-chat)).

**3D context graph.** three.js (WebGL2) via `3d-force-graph`, or Cosmograph if node counts grow
large (GPU-accelerated layout on WebGL). Capability-detect `navigator.gpu` and light up a WebGPU
path only when present (Chrome mode today; WKWebView whenever Apple flips it for embeds). Live
population: daemon watchers (chokidar/FSEvents on `~/.claude`, project `.claude/` dirs, Obsidian
vault, transcript JSONL) emit `graph/updates` deltas over the WS.

---

## Recommendation (the full stack)

- **Shell:** Tauri v2 (2.11.x) — tray via built-in TrayIcon, `@tauri-apps/plugin-notification`,
  multi-window; Tauri IPC only for native affordances.
- **Core daemon:** TypeScript on Node 22 LTS — `node-pty` 1.1.x ptyHost (one PTY per session,
  `CLAUDE_CONFIG_DIR` per account for MAX_A / MAX_B / ENT; `oc-bedrock`-equivalent env injection for
  OpenCode/Bedrock), Hono or Fastify + `ws`, SQLite (better-sqlite3) for sessions/workstreams/
  metrics, chokidar for watchers, LM Studio health-check + `lms server start` auto-start.
  Sidecar-launched in v0; `launchd` LaunchAgent by v1 so sessions outlive the app.
- **Transport:** one multiplexed WebSocket per UI surface on 127.0.0.1; binary frames for PTY
  bytes, JSON for events; ack-based watermark flow control; REST for request/response CRUD.
- **UI:** Svelte 5 + Vite + TypeScript; Tailwind for velocity; rune-store state model as above.
- **Terminal:** @xterm/xterm + WebGL addon + serialize addon (+ headless in daemon).
- **Lists:** TanStack Virtual (end-anchored).
- **Graph:** three.js/3d-force-graph on WebGL2; WebGPU as progressive enhancement.
- **Packaging:** `tauri build` DMG; for personal use run locally-built (no notarization needed);
  when sharing, Tauri's `APPLE_ID`/API-key notarization flow, minding the sidecar-signing issue.
- **Escape hatches (pre-paid by the architecture):** open the SPA in Chrome for WebGPU/devtools;
  swap shell to Electron if WKWebView misbehaves; move daemon into Colima/k3s later [X3] provided
  LM Studio remains reachable host-side (daemon-proxied, so a host-gateway route suffices).

**Rationale in one paragraph.** Every hard requirement of this harness — parallel per-account
PTY sessions [X1], session lineage that outlives windows [X4], live file-driven graph, LM Studio
management — is *backend* work that no webview should own. Once a localhost daemon owns it, the
shell choice stops being existential and becomes a UX decision, and on UX-per-megabyte Tauri v2
beats Electron decisively while a bare browser tab can't do tray/notifications. The known Tauri
pain points (IPC throughput, no node-pty, WebGPU uncertainty) are all pain points *of putting the
workload inside Tauri*, which this design deliberately does not do.

---

## Implications for the harness

1. **[X1] parallel accounts:** the daemon spawns `claude` under per-account
   `CLAUDE_CONFIG_DIR` homes (e.g. `~/.claude-max-a`, `~/.claude-max-b`, `~/.claude-ent` — names
   only, no identifiers) each in its own PTY; login happens once per config dir, interactively,
   inside the embedded terminal — the harness never touches credentials. Resource efficiency never
   constrains account parallelism because PTYs are ~MBs each.
2. **[X2] public repo:** no tokens/IDs anywhere in this design; Keychain access (e.g. the
   `bedrock-openai-api-key` item) stays inside the daemon at runtime via `security` lookups,
   values never serialized to disk or UI. All ports/paths/account labels are config/env.
3. **[X3] Colima/k3s:** only the daemon would containerize; the Tauri shell stays host-native.
   PTY-spawning `claude` processes inside a container changes their filesystem view of `~/.claude`
   and Keychain access — flag to the infra research track that the daemon likely must stay
   host-native even if other services move to k3s. LM Studio reachability is preserved either way
   because only the daemon talks to `127.0.0.1:1234`.
4. **[X4] workstreams:** daemon-owned sessions + SQLite lineage (parent/child on
   branch/continue/merge) is the natural home; UI reattach uses `--resume`-style CLI continuation
   plus serialized xterm scrollback.
5. **Observability (feature 1):** daemon tails `~/.claude/usage-data`, `history.jsonl`, project
   JSONL transcripts and OpenCode logs; Bedrock USD math server-side; metrics stream over the same
   WS. (Detail belongs to the observability research track.)
6. **Pipeline builder (feature 5) & graph (feature 6):** both are pure daemon watchers + WS
   deltas; no shell dependency.
7. **Stage-2 spikes to schedule (cheap, de-risking):** (a) WKWebView WebGPU probe inside a Tauri
   window on macOS 26.6; (b) node-pty × 6 PTYs + xterm.js flow-control soak with `claude` running
   `yes`-grade output; (c) Tauri sidecar signing dry run; (d) Bun.Terminal parity test vs node-pty.

---

## Sources

- https://v2.tauri.app/reference/webview-versions/ — WKWebView/engine mapping
- https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/ — Safari 26 WebGPU
- https://github.com/gpuweb/gpuweb/wiki/Implementation-Status — WebGPU status incl. webview caveat
- https://github.com/tauri-apps/tauri/issues/6381 — Tauri WebGPU feature request (closed, not planned)
- https://github.com/userFRM/tauri-plugin-macos-fps — WKWebView 60 fps cap workaround
- https://github.com/tauri-apps/tauri/discussions/5690 — Tauri IPC bottleneck + improvements
- https://v2.tauri.app/develop/calling-frontend/ and https://v2.tauri.app/concept/inter-process-communication/ — Channels, events
- https://github.com/orgs/tauri-apps/discussions/4492 — sidecar event bus via WebSocket
- https://github.com/orgs/tauri-apps/discussions/14552 — SSE-alternative feature request
- https://xtermjs.org/docs/guides/flowcontrol/ and https://github.com/xtermjs/xterm.js/issues/2077 — flow control/backpressure
- https://www.npmjs.com/package/@xterm/addon-webgl — WebGL renderer
- https://github.com/Tnze/tauri-plugin-pty and https://lib.rs/crates/tauri-plugin-pty — Tauri PTY plugin
- https://github.com/microsoft/node-pty and https://github.com/microsoft/node-pty/issues/728 — node-pty & Electron ABI issues
- https://github.com/homebridge/node-pty-prebuilt-multiarch — prebuilt fallback
- https://bun.com/blog/bun-v1.3.5 and https://github.com/oven-sh/bun/issues/22468 — Bun native PTY
- https://www.electronjs.org/docs/latest/api/utility-process and https://www.electronjs.org/docs/latest/tutorial/process-model — Electron process model
- https://code.visualstudio.com/blogs/2022/11/28/vscode-sandbox — VS Code ptyHost architecture
- https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules — native module rebuilds
- https://www.pkgpulse.com/guides/electron-vs-tauri-2026 , https://www.buildmvpfast.com/blog/tauri-v2-vs-electron-desktop-apps-2026 , https://tech-insider.org/tauri-vs-electron-2026/ , https://blog.openreplay.com/comparing-electron-tauri-desktop-applications/ — 2026 shell comparisons & memory data
- https://v2.tauri.app/distribute/sign/macos/ — Tauri signing/notarization
- https://github.com/tauri-apps/tauri/issues/11992 — externalBin signing issue
- https://v2.tauri.app/plugin/notification/ — Tauri notifications
- https://github.com/idootop/tauri-plugin-cors-fetch and https://github.com/tauri-apps/tauri/issues/8339 — webview CORS handling
- https://websocket.org/guides/websockets-and-ai/ , https://zknill.io/posts/ai-token-streaming-isnt-about-sse-vs-websockets/ , https://www.hivenet.com/post/llm-streaming-sse-websockets — SSE vs WS for LLM streaming
- https://tanstack.com/blog/tanstack-virtual-chat and https://tanstack.com/virtual/latest — end-anchored virtualization
- https://www.pkgpulse.com/guides/solidjs-vs-svelte-5-vs-react-reactivity-2026 , https://leapcell.io/blog/next-gen-reactivity-rethink-preact-solidjs-signals-vs-svelte-5-runes — framework reactivity comparisons
- https://github.com/pmndrs/zustand/discussions/1179 and https://www.sitepoint.com/streaming-backends-react-controlling-re-render-chaos/ — high-frequency state patterns
- https://github.com/winfunc/opcode , https://github.com/stravu/crystal , https://github.com/BloopAI/vibe-kanban — prior art
- https://blog.ambi.se/two-claude-accounts-parallel , https://wmedia.es/en/tips/claude-code-multiple-profiles-config-dir — CLAUDE_CONFIG_DIR multi-account
- https://lmstudio.ai/docs/developer/core/server , https://lmstudio.ai/docs/developer/core/headless , https://lmstudio.ai/docs/cli — LM Studio server/CLI
- https://releases.electronjs.org/ and https://docs.rs/crate/tauri/latest — current versions
- Local verification (read-only, 2026-07-03): `claude --version` = 2.1.193; macOS 26.6 / M4 Max / 36 GB; `~/.claude` layout (usage-data, sessions, projects, telemetry present); LM Studio.app installed, `lms` at `~/.lmstudio/bin/lms`, `127.0.0.1:1234` refusing connections (server down).

## Open questions

1. **Is WebGPU actually exposed in WKWebView (macOS 26) as embedded by wry/Tauri?** Public docs
   only confirm Safari; a 30-minute spike (`navigator.gpu` probe in a Tauri window) settles it.
2. **Does the interactive `claude` TUI behave fully under node-pty at 6+ concurrent PTYs** (raw
   mode, resize storms, bracketed paste, OSC sequences) — and does OpenCode's TUI too?
3. **Session reattach fidelity:** is `@xterm/addon-serialize` scrollback replay + `claude --resume`
   good enough UX, or do we need daemon-side headless xterm per detached session?
4. **Bun vs Node for the daemon at Stage 2:** is `Bun.Terminal` (1.3.5+) stable enough to replace
   node-pty and win on startup/RAM, or stay on Node LTS?
5. **launchd LaunchAgent vs Tauri sidecar** for daemon lifetime: does sidecar-managed suffice for
   v0, and what is the clean upgrade path without orphaning running Claude sessions?
6. **Notification depth:** are Tauri-plugin notifications (actions, replies) sufficient, or will
   macOS notification *actions* (approve tool call from the banner) require a small native Swift
   helper?
7. **k3s/Colima interaction [X3]:** can the PTY daemon ever move into a container given
   `~/.claude` filesystem and Keychain dependencies, or is it permanently host-native (with only
   auxiliary services containerized)?
8. **Multi-window memory scaling in Tauri on macOS:** per-window WKWebView cost when the user opens
   several workstream windows — measure before committing to a multi-window UX.
