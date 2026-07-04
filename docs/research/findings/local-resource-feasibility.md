# Local-Resource Feasibility: Running the Full Harness on an Apple M4 Max / 36 GB

**Stage-1 discovery research — the-last-aibender**
**Topic:** Can this MacBook Pro (Apple M4 Max, 14 CPU cores, 36 GB unified RAM, macOS 26.6) concurrently run: three interactive Claude Code sessions (MAX_A, MAX_B, ENT), OpenCode→Bedrock sessions, an LM Studio local model, and the harness backend + frontend — and what defaults keep it healthy?
**Date:** 2026-07-03. All "measured" numbers below were taken read-only on this machine on this date.

---

## TL;DR

1. **Yes, comfortably — with active management.** The steady-state harness stack (3 Claude + 2 OpenCode + 8B-class local model + backend + Tauri-class frontend) budgets to ~8–9 GB above ambient; the 36 GB machine absorbs it.
2. The dominant risks are (a) **Claude Code's documented memory-leak history** (sessions growing from ~300 MB to multi-GB), and (b) **an idle local model pinned in memory** — both are supervision problems, not capacity problems.
3. Measured today: `claude` sessions run **225–502 MB RSS**; `opencode` **202–224 MB**; LM Studio service ~330 MB; Ollama idle 20 MB. This machine *already* runs with 12.7 GB swap used and ~14 GB in the compressor from ambient apps — headroom management matters more than peak capacity.
4. **Local model cap: 7–8B Q4 (≈5–5.5 GB) as default, 12–14B Q4 (≈8–11 GB) as opt-in max.** Always JIT-load with TTL (15–30 min) and auto-evict; never keep a model resident without TTL (that exact anti-pattern is live on this machine right now).
5. **tmux (not currently installed) as the session substrate + node-pty only as the frontend attach layer + launchd LaunchAgents for supervision** is the recommended PTY architecture.
6. Frontend: **Tauri or a plain localhost web app** saves 200–400 MB vs Electron; real but not decisive on 36 GB.
7. **[X1] honored explicitly:** if the budget forces a choice, the three parallel account sessions win. Sacrifice order: local model size → local model KV/context → frontend shell weight → non-Claude session hibernation → scrollback/history. The 3 Claude sessions (~1–6 GB combined) are never the victim.
8. Recommended defaults: **max 8 resident agent sessions** (12 registered w/ hibernation), warn at pressure level 2 / free < 25%, block non-account spawns at critical, per-session RSS watchdog at 3 GB.

---

## Ground truth measured on this machine (read-only, 2026-07-03)

| Item | Measured value | How |
|---|---|---|
| RAM | 38,654,705,664 B = 36 GiB; 14 cores; Apple M4 Max | `sysctl hw.memsize hw.ncpu` |
| Page size | 16 KiB | `vm_stat` |
| `claude` CLI (v2.1.197 native binary), 3 live sessions | **502 MB / 276 MB / 225 MB RSS** | `ps axo rss,command` |
| `opencode` (v1.17.13, `~/.opencode/bin`), 2 live TUI sessions | **224 MB / 202 MB RSS** | `ps axo rss,command` |
| Claude Desktop (Electron) total | ~850 MB+ (main 204 + renderer 526 + helpers) | `ps` |
| OpenCode Desktop (Electron) total | ~450 MB across 5 processes | `ps` |
| LM Studio service processes (GUI running, server down) | ~330 MB total | `ps` |
| Ollama server, idle, no model loaded | **20 MB RSS** | `ps`, `ollama ps` empty |
| LM Studio models on disk | gemma-4-12B QAT **Q4_0 GGUF 6.5 GB** (+167 MB mmproj); gemma-4-E4B **MLX 4-bit 6.4 GB**; nomic embed 84 MB | `lms ls`, `du` |
| LM Studio loaded-model state | `gemma-4-e4b` **LOADED, 6.86 GB, ctx 32768, PARALLEL 4, IDLE, TTL: none** | `lms ps` |
| Ollama models on disk | qwen3:8b 5.2 GB; qwen2.5-coder:7b 4.7 GB | `ollama list` |
| Swap | **12.7 GB used of 14.3 GB** (encrypted) | `sysctl vm.swapusage` |
| Compressor | 917,866 pages × 16 KiB ≈ **14.0 GiB compressed** | `vm_stat` |
| Active/inactive/wired/free | 7.7 / 7.7 / 4.2 / 0.7 GiB | `vm_stat` |
| Memory pressure | level **1 (normal)**; "System-wide memory free percentage: 47%" | `sysctl kern.memorystatus_vm_pressure_level`, `memory_pressure -Q` |
| tmux | **NOT installed** | `which tmux` empty |
| Ollama supervision | launchd job `homebrew.mxcl.ollama` running; LM Studio also has a launchd entry | `launchctl list` |

Three observations that shape everything below:

- **The machine already lives over-committed.** ~14 GiB compressed + 12.7 GB swapped *at pressure level "normal"*. macOS tolerates enormous over-commit by compressing/swap­ping idle pages (mostly Electron apps and browser tabs). Planning must therefore use *pressure and swap deltas*, not naive "free RAM", as the health signal.
- **A 6.86 GB model is "loaded" right now with no TTL** — and notably its pages have been largely reclaimed by the OS while idle (no LM Studio process shows multi-GB RSS; the pages sit in compressor/swap). The moment it serves a request, those pages must be faulted back in — the swap-thrash scenario in miniature. This is precisely what JIT + TTL fixes.
- **RSS under-reports under pressure.** A "loaded" model or leaky session whose pages were compressed/swapped shows small RSS. For truthful per-process accounting use `footprint(1)` / `proc_pid_rusage` `phys_footprint` (the metric Jetsam uses), not `ps rss` alone.

---

## Current landscape

### 1. Claude Code CLI process profile

- Since v2.1.113 Claude Code ships as a **native binary compiled with `bun build --compile`** (Bun runtime, JavaScriptCore engine) rather than a Node.js script ([frr.dev](https://www.frr.dev/posts/claude-code-native-build-bun/), [wotai.co](https://wotai.co/blog/claude-code-2-1-116)). The npm package now just installs the same native binary ([official setup docs](https://code.claude.com/docs/en/setup)). Consequence: the popular `NODE_OPTIONS="--max-old-space-size=4096"` heap-cap workaround **no longer applies** to current installs — it was a V8/Node flag. Supervision must be external (watchdog + recycle).
- Official system requirements: **4 GB+ RAM minimum** ([docs](https://code.claude.com/docs/en/setup)).
- Baseline: ~300 MB at launch is the figure reported in issue telemetry ([#27421](https://github.com/anthropics/claude-code/issues/27421)); our live sessions measure 225–502 MB, consistent.
- **Leak history is long and severe** — this is the single most important sourced fact for capacity planning:
  - RSS 500 MB → 4.6 GB within minutes ([#46931](https://github.com/anthropics/claude-code/issues/46931));
  - ~2.6 GB RSS in ~3 min, ~45 GB/h growth ([#33441](https://github.com/anthropics/claude-code/issues/33441));
  - native-addon leak (~18 GB/h, node-pty implicated) ([#32752](https://github.com/anthropics/claude-code/issues/32752));
  - 93 GB heap ([#22188](https://github.com/anthropics/claude-code/issues/22188)); 120–129 GB before OOM-kill ([#4953](https://github.com/anthropics/claude-code/issues/4953), [#11315](https://github.com/anthropics/claude-code/issues/11315));
  - unbounded in-memory message accumulation on long sessions ([#25926](https://github.com/anthropics/claude-code/issues/25926));
  - heap OOM parsing a huge `~/.claude.json` ([#10592](https://github.com/anthropics/claude-code/issues/10592));
  - the 1.0.81-era leak chronicle ([Hyperdev](https://hyperdev.matsuoka.com/p/critical-memory-leak-in-claude-code)).
  - Specific leaks get fixed version-to-version, but the *class* of failure recurs across a year of releases. **Design assumption: any long-lived `claude` process may grow without bound and must be recycled, not trusted.**
- Sessions are resumable (`claude --resume <session-id>`; transcripts in `~/.claude/projects/.../*.jsonl`), which makes **kill-and-resume ("process hibernation") a safe, cheap mitigation** — the RAM cost of a session is disposable state; the durable state is on disk.

**Planning numbers (claude, per interactive session):** launch ~0.3 GB; typical steady 0.3–0.6 GB; long-session p95 1–2 GB; leak scenario >3 GB (watchdog territory).

### 2. OpenCode process profile

- Measured here: 202–224 MB RSS per TUI session (v1.17.13, Bun-based single binary).
- Upstream issues report **unbounded growth in long sessions**: 602 MB RSS + 1.15 GB swap on an 8 GB box, multi-GB SQLite session DBs with no auto-cleanup, ~1 GB+ complaints, growth until stuck ([#16697](https://github.com/anomalyco/opencode/issues/16697), [#3013](https://github.com/anomalyco/opencode/issues/3013), [#2805](https://github.com/anomalyco/opencode/issues/2805), [#3530](https://github.com/sst/opencode/issues/3530), large-file spike [#2585](https://github.com/sst/opencode/issues/2585)). Same class of problem as Claude Code, slightly smaller magnitude.
- `opencode serve` (headless server) exists for non-TUI automation; expect a similar 150–250 MB baseline (same runtime, no TUI render loop).

**Planning numbers (opencode, per session):** typical 0.2–0.35 GB; p95 0.6–1.5 GB; watchdog at 1.5 GB.

### 3. LM Studio serving 7–14B models on Apple Silicon

**Engines and formats.** LM Studio uses **MLX** (Apple's array framework, unified-memory native) when an MLX build of the model exists, **llama.cpp/GGUF** otherwise. Community benchmarking: MLX 4-bit files run ~5–10% smaller than GGUF Q4_K_M for the same parameters; MLX gives materially higher decode throughput on M-series (claims range up to 2×+) with efficient zero-copy unified-memory use; Q4_K_M has a slight quality edge under 30B due to mixed-precision attention tensors ([Contra Collective 2026 comparison](https://contracollective.com/blog/gguf-vs-mlx-quantization-formats-apple-silicon-2026), [inventivehq](https://inventivehq.com/blog/running-llms-on-apple-silicon-mlx), [sitepoint 2026 guide](https://www.sitepoint.com/local-llms-apple-silicon-mac-2026/)). Caveat: MLX reads GGUF only for Q4_0/Q4_1/Q8_0; other GGUF quants get cast to FP16 — don't mix formats casually.

**Weights RAM (rule of thumb: resident ≈ file size + 10–20% runtime buffers):**

| Model class | Q4 file size | Resident (weights+buffers) |
|---|---|---|
| 7B (qwen2.5-coder:7b, on disk) | 4.7 GB | ~5.2–5.6 GB |
| 8B (qwen3:8b, on disk) | 5.2 GB | ~5.7–6.2 GB |
| 12B (gemma-4-12B QAT Q4_0, on disk) | 6.5 GB (+0.17 mmproj) | ~7.3–8 GB |
| 14B Q4_K_M (typical) | ~8.5–9 GB | ~9.5–10.5 GB |

**KV-cache growth (the hidden multiplier).** Formula: `bytes/token = 2 × layers × kv_heads × head_dim × bytes_per_element` (×batch for parallel slots) ([mbrenndoerfer calculator](https://mbrenndoerfer.com/writing/kv-cache-memory-calculation-llm-inference-gpu), [dev.to calculator](https://dev.to/jagmarques/kv-cache-memory-calculator-how-much-does-your-llm-actually-use-85n), [InsiderLLM KV guide](https://insiderllm.com/guides/kv-cache-optimization-guide/)). Architecture-derived FP16 estimates:

| Model (arch) | KV per token | @8K ctx | @32K ctx |
|---|---|---|---|
| Qwen2.5-Coder-7B (28L, 4 KV heads, d128) | 56 KiB | 0.44 GiB | 1.75 GiB |
| Llama-3.1-8B-class (32L, 8 KV, d128) | 128 KiB | 1.0 GiB | 4.0 GiB |
| Qwen3-8B (36L, 8 KV, d128) | 144 KiB | 1.1 GiB | 4.5 GiB |
| Generic 14B (48L, 8 KV, d128) | 192 KiB | 1.5 GiB | 6.0 GiB |

Two harness-relevant traps: (1) **context length doubles → KV doubles**; a 14B at 32K FP16 KV costs almost as much as its weights. (2) LM Studio's **`PARALLEL` slots multiply worst-case KV** — the currently-loaded model on this machine sits at ctx 32768 × parallel 4, i.e. a worst-case KV envelope far beyond its 6.86 GB weight figure. Mitigations: default utility models to ctx 8192, parallelism 1–2; llama.cpp supports Q8_0 KV quantization (halves KV, needs flash attention); MLX supports quantized/rotating KV.

**Lifecycle controls (the load-shedding API we build on).** LM Studio has exactly the knobs the harness needs, documented at [Idle TTL and Auto-Evict](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict) (introduced in [0.3.9](https://lmstudio.ai/blog/lmstudio-v0.3.9)):
- **JIT loading:** inference request loads the model on demand.
- **Idle TTL:** `"ttl": <seconds>` per request payload, or `lms load --ttl <seconds>`; JIT default TTL is 60 min; timer resets on each request.
- **Auto-Evict (default ON):** at most 1 JIT-loaded model resident; loading a new one evicts the prior. Manual (GUI) loads are exempt — which is why the no-TTL idle model observed on this machine survives.
- **Headless:** `lms server start`, or the `llmster` standalone daemon (no GUI) ([headless docs](https://lmstudio.ai/docs/developer/core/headless)).
- **Observability:** `lms ps`; REST `GET /api/v0/models` returns per-model `state` (loaded/not-loaded), max context, quantization ([REST docs](https://lmstudio.ai/docs/developer/rest/endpoints)); LM Studio 0.4.0+ adds a native `/api/v1/*` API.
- Known bug to design around: models loaded via certain paths bypass auto-evict/JIT policies ([lmstudio-bug-tracker #2051](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/2051), [#634](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/634)) — the harness should verify unloads via `/api/v0/models` rather than assume.

**GPU/unified-memory ceiling.** On Apple Silicon, GPU (Metal) allocations are *wired* — non-swappable. Default cap is ~2/3 of RAM for machines ≤36 GB (~24 GB here), ~3/4 above that; tunable via `sudo sysctl iogpu.wired_limit_mb` (resets on reboot) ([pixelesque](https://pixelesque.net/other/snippets/macos/changing-mac-unified-memory-gpu-limit/), [llama.cpp discussion #2182](https://github.com/ggml-org/llama.cpp/discussions/2182), [peddals](https://blog.peddals.com/en/fine-tune-vram-size-of-mac-for-llm/)). At our recommended caps (≤14B Q4, ≤16K ctx ⇒ ≤ ~12 GB) the default 24 GB limit is never approached — **do not raise it**; wired model memory is the most dangerous kind under pressure because the OS can't reclaim it.

**Ollama coexistence.** Ollama runs on this machine as a launchd service (the `local-llm` MCP producer, qwen2.5-coder:7b). Idle cost is trivial (20 MB measured) and it unloads models after its own idle timeout (default 5 min). Risk: **LM Studio and Ollama both JIT-loading 5–7 GB models simultaneously** doubles local-model footprint. The harness should treat "local model resident" as a single global budget line across both servers.

### 4. Harness shell overhead: Electron vs Tauri vs browser

- Benchmarks converge on **Electron ~200–300 MB idle** (multi-process Chromium + Node) vs **Tauri ~30–50 MB idle** (native WKWebView + Rust core); on macOS Chromium renderer processes measured ~2× WKWebView for the same window ([gethopp benchmark](https://www.gethopp.app/blog/tauri-vs-electron), [levminer real-world](https://www.levminer.com/blog/tauri-vs-electron), [RaftLabs](https://www.raftlabs.com/blog/tauri-vs-electron-pros-cons/)).
- For a *complex* app (force-directed context graph, xterm.js terminals, charts) realistic numbers are higher: Electron 300–600 MB, Tauri 100–250 MB (the web content itself dominates; WKWebView still wins by roughly half). Locally measured corroboration: Claude Desktop ≈850 MB, OpenCode Desktop ≈450 MB — both Electron.
- Third option: **no shell at all** — harness backend serves a localhost web UI in the user's existing browser. Marginal cost is one more tab (~100–300 MB in an already-running browser); zero new framework processes. Caveats: no native menu bar/tray, weaker process-lifecycle integration, needs the browser open.
- Each embedded xterm.js terminal view costs ~10–50 MB depending on scrollback; cap scrollback (e.g. 5–10K lines) and virtualize inactive terminal views.

### 5. PTY / terminal orchestration on macOS

- **node-pty** ([microsoft/node-pty](https://github.com/microsoft/node-pty)): the standard forkpty binding (VS Code's terminal). Per-PTY overhead is trivial (a few MB incl. the spawned `zsh`); the real costs are (a) native-module packaging pain in Electron ([Deegan](https://thomasdeegan.medium.com/electron-forge-node-pty-9dd18d948956)), (b) PTYs die with their parent — VS Code solved this with a separate **ptyHost daemon**, and Superset documents the same "persistent terminal daemon" pattern for Electron apps ([Superset deep-dive](https://superset.sh/blog/terminal-daemon-deep-dive)), (c) node-pty has appeared in leak/crash reports (claude-code [#32752](https://github.com/anthropics/claude-code/issues/32752), vscode [#243952](https://github.com/microsoft/vscode/issues/243952)).
- **tmux as headless multiplexer** — *not currently installed; add `brew install tmux`*. One `tmux` server process (~10–50 MB total) owns all sessions/panes; sessions survive harness restarts, which is exactly the persistence property [X4] workstreams need. Automation surface:
  - `tmux -CC` **control mode**: a text protocol on stdout (`%output`, `%session-changed`, `%window-add`, …) designed for programs (iTerm2 uses it) — the harness can subscribe to structured pane events instead of scraping;
  - `send-keys` + `capture-pane`: the de-facto standard for driving interactive AI CLIs; the emerging "agent orchestration" ecosystem is built on exactly this (send, then verify via capture-pane) ([PrimeLine tmux orchestration](https://primeline.cc/blog/tmux-orchestration), [tmux skill for agents](https://skillregistry.io/skill/tmux), [hboon](https://hboon.com/using-tmux-with-claude-code/), [Anthropic agent-teams docs](https://code.claude.com/docs/en/agent-teams));
  - per-account naming: `tmux new -s MAX_A -e CLAUDE_CONFIG_DIR=...` — one named session per account keeps [X1] isolation legible at the multiplexer layer.
- **launchd LaunchAgents** for supervision: user-domain agents (Aqua session ⇒ Keychain access works, which the Bedrock key requires). Key facts: `KeepAlive` with `SuccessfulExit=false` restarts only on crash; plain `KeepAlive=true` restarts always; launchd throttles rapid respawn loops (`ThrottleInterval`, default 10 s); prefer on-demand jobs per Apple guidance ([Apple launchd guide](https://support.apple.com/guide/terminal/script-management-with-launchd-apdc6c1077b-5d5d-4d35-9c19-60f2397b2369/mac), [launchd.plist(5)](https://www.manpagez.com/man/5/launchd.plist/), [tjluoma/launchd-keepalive](https://github.com/tjluoma/launchd-keepalive), [Apple daemon docs](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)). Precedent on this machine: Ollama and LM Studio already run under launchd.

### 6. Colima + k3s resource lens ([X3] intersection)

Colima's default VM is 2 CPU / 2 GiB; a useful k3s node needs 4–8 GB ([colima docs](https://colima.run/docs/configuration/), [GitHub](https://github.com/abiosoft/colima), [oneuptime comparison](https://oneuptime.com/blog/post/2026-02-08-how-to-choose-between-colima-and-docker-desktop-on-macos/view)). Resource-wise this is the **worst kind of allocation on this machine**: a static VM carve-out that competes directly with the local model's 5–11 GB, plus 30–50% filesystem overhead for write-heavy workloads. It also complicates the hard [X3] constraint — LM Studio binds 127.0.0.1 on the *host*; pods reach it only via `host.lima.internal`-style routing or by binding LM Studio to 0.0.0.0 (a security regression on a laptop). From a pure resource standpoint: **host-native now; revisit k3s only if the harness outgrows one machine.**

---

## Options considered

### A. Frontend shell

| Option | How it works | Pros | Cons / risks |
|---|---|---|---|
| **Electron** | Bundled Chromium + Node per app | Richest ecosystem; node-pty in-process; Claude/OpenCode desktop precedent | 300–600 MB realistic; another Chromium on a machine already running several; native-module packaging pain |
| **Tauri** | Native WKWebView + Rust core | ~half the memory on macOS; tiny bundle; good sidecar/process APIs | Rust backend seam; WKWebView quirks for heavy canvas/WebGL (force graph needs testing); node-pty lives in a separate backend process anyway |
| **Localhost web app** (backend daemon + browser tab) | Harness backend (Bun/Node) serves UI at 127.0.0.1 | Near-zero marginal shell cost; trivially inspectable; backend already needed for PTY/daemon work | No tray/menubar/global-shortcut integration; depends on a browser being open; "app-ness" lost |

### B. Session substrate (how agent processes are owned)

| Option | How it works | Pros | Cons / risks |
|---|---|---|---|
| **Raw node-pty children of harness** | Backend forks PTYs directly | Simplest; lowest latency to stream | Sessions die with backend; leak-prone native addon in one big process; no CLI-side inspection |
| **tmux server + control mode (recommended)** | tmux owns sessions; harness attaches via `-CC`/`capture-pane`; frontend attaches via node-pty running `tmux attach` | Sessions survive harness crash/restarts ([X4]); structured events; human can attach from any terminal; per-account session naming; ~10–50 MB total | New dependency (not installed); control-mode protocol parsing work; scrollback history sizing (`history-limit`) must be capped |
| **Headless-only (`claude -p`, `opencode run/serve`)** | No PTY; JSON in/out | Cheapest per invocation; ideal for one-off prompts (vision feature 2) | No interactive sessions — cannot be the *only* substrate; loses the interactive multi-account capability [X1] |

*(Hybrid is the real answer: tmux for interactive account sessions; headless `-p`/`serve` invocations for one-shot prompts and pipeline steps.)*

### C. Local model serving strategy

| Option | How it works | Pros | Cons / risks |
|---|---|---|---|
| **Keep model resident, no TTL** | Manual load in LM Studio GUI | Zero first-token latency | 5–11 GB pinned; wired Metal pages non-reclaimable while active; observed live on this machine as an anti-pattern |
| **JIT + TTL + auto-evict (recommended)** | `lms server start` headless; requests carry `"ttl": 900–1800`; auto-evict caps residency at 1 model | Memory only spent while used; ~free when idle; per-request TTL override | Cold-load latency (~2–6 s for 5–7 GB from SSD); TTL-bypass bugs require verification via API |
| **Ollama as the only local server** | Existing launchd service | Already supervised; 5-min idle unload | Weaker model/format control than LM Studio (no MLX); vision statement names LM Studio; running *both* JIT servers risks double-residency — govern with one global budget line |

### D. Containerized (Colima+k3s) vs host-native

Covered in Landscape §6 — host-native wins the resource argument decisively on a 36 GB single machine; static VM reservation is the first thing that would force sacrifices [X1] forbids.

---

## Resource budget and concurrency ceiling

### Per-component budget (planning numbers)

| Component | Typical | P95 / long session | Watchdog trigger |
|---|---|---|---|
| macOS base (wired + system) | 4–6 GB | — | — |
| Ambient user apps (browser, Claude Desktop, mail…) — *measured reality on this machine* | 6–12 GB | — | — |
| `claude` interactive session (each) | 0.3–0.6 GB | 1–2 GB | recycle > 3 GB |
| `claude -p` one-shot (transient) | 0.3–0.5 GB | short-lived | timeout |
| `opencode` session (each) | 0.2–0.35 GB | 0.6–1.5 GB | recycle > 1.5 GB |
| tmux server + shells (all sessions) | 0.05–0.1 GB | 0.15 GB | — |
| Harness backend (Bun/Node daemon) | 0.05–0.15 GB | 0.3 GB | restart > 0.5 GB |
| Frontend: Tauri / browser tab | 0.1–0.25 GB | 0.4 GB | — |
| Frontend: Electron (if chosen) | 0.3–0.6 GB | 0.8 GB | — |
| LM Studio service (headless) | 0.2–0.4 GB | — | — |
| Local model 7–8B Q4 @8–16K ctx | 5.0–6.5 GB | +KV per slot | TTL unload |
| Local model 12B Q4 @8K ctx | 7.5–8 GB | — | TTL unload |
| Local model 14B Q4 @16K ctx | 9.5–11.5 GB | — | opt-in only |
| Ollama idle / with 7B loaded | 0.02 GB / 5–6 GB | — | 5-min auto-unload |

### The target scenario ("everything on"): MAX_A + MAX_B + ENT interactive + 2 OpenCode/Bedrock + 8B local model + harness

| Line | Typical | Pessimistic (long sessions, pre-watchdog) |
|---|---|---|
| 3 × claude (accounts) | 1.2 GB | 6.0 GB |
| 2 × opencode | 0.6 GB | 2.5 GB |
| tmux + shells + node-pty | 0.1 GB | 0.15 GB |
| Harness backend + Tauri-class frontend | 0.3 GB | 0.6 GB |
| LM Studio service + 8B Q4 @16K | 6.5 GB | 7.5 GB |
| **Harness stack total** | **~8.7 GB** | **~16.8 GB** |
| + macOS base | 5 GB | 6 GB |
| + ambient apps (moderate) | 8 GB | 12 GB |
| **Machine total** | **~22 GB / 36 GB — comfortable** | **~35 GB — pressure warning; mitigations fire** |

### Ceiling statement

With supervision active (watchdogs + hibernation + model TTL), a realistic ceiling on this machine is:

- **8–10 resident interactive agent sessions + one 7–8B Q4 local model**, or
- **4–6 resident sessions + one 12–14B Q4 model (ctx ≤ 16K)**, or
- **12+ registered sessions** where anything beyond ~8 is hibernated (process killed, resumable via session id).

CPU is not the binding constraint: agent CLIs are network-bound (14 cores idle along); the local model saturates GPU, not CPU. Memory is the only budget that matters.

---

## Contention risks and mitigations

| Risk | Mechanism | Mitigation |
|---|---|---|
| **Leaky agent session eats the machine** | Documented multi-GB leaks in both claude and opencode | Per-session RSS/footprint watchdog (poll `proc_pid_rusage`/`ps` every 30 s); soft action at 3 GB (`/compact`, prompt user), hard recycle at 6 GB: checkpoint → kill → `claude --resume` |
| **Swap thrash while local model loads** | Faulting 5–11 GB of weights while compressor already holds ~14 GB forces pageout storms | Gate model JIT-load on pressure level: refuse load (or auto-pick smaller model) at level ≥ 2; pre-check `memory_pressure -Q` free% before load |
| **Idle model pins memory** | No-TTL loads (live example on this machine); Metal wired pages non-reclaimable | Always JIT + `ttl` 900–1800 s + auto-evict; verify unload via `GET /api/v0/models`; never manual GUI loads for harness work |
| **KV blow-up via parallel slots / big ctx** | ctx 32K × parallel 4 multiplies KV envelope (up to +6 GB on 14B) | Default utility ctx 8192, parallel 1–2; Q8 KV cache where supported |
| **Double local-model residency** | LM Studio and Ollama both JIT-load ~5 GB models | One global "local model resident" budget line in the harness scheduler across both servers |
| **Electron pile-up** | Claude Desktop (~850 MB) + OpenCode Desktop (~450 MB) + harness shell | Prefer Tauri/browser shell; harness can (long-term) replace desktop-app usage |
| **Session pile-up (lazy user, eager orchestrator)** | Each workflow spawns sessions that never end | Lazy spawn (create on first prompt, not on registration); idle hibernation after 30 min (kill process, keep session id + tmux window name); scrollback caps (`history-limit 5000`) |
| **Backend crash loses PTYs** | node-pty children die with parent | tmux owns processes; harness reattaches after restart; launchd `KeepAlive` (SuccessfulExit=false) restarts backend |
| **~/.claude.json bloat** | Giant state file → startup OOM ([#10592](https://github.com/anthropics/claude-code/issues/10592)) | Harness monitors file sizes under each account's `CLAUDE_CONFIG_DIR`; alert > 50 MB |

---

## Monitoring hooks (what the harness observability layer polls)

- **System pressure (primary signal):** `sysctl kern.memorystatus_vm_pressure_level` → 1 normal / 2 warning / 4 critical; `memory_pressure -Q` → parseable "System-wide memory free percentage: N%" (measured example: 47%). Event-driven alternative for a native helper: `DISPATCH_SOURCE_TYPE_MEMORYPRESSURE` dispatch source ([Apple docs](https://developer.apple.com/documentation/dispatch/dispatch_source_type_memorypressure), [xnu memorystatus notes](https://github.com/apple-oss-distributions/xnu/blob/main/doc/vm/memorystatus_notify.md)).
- **Swap & compressor trend:** `sysctl vm.swapusage`; `vm_stat` deltas (Pageouts, Swapins/Swapouts, "Pages used by compressor") — *rate of change* matters more than absolutes on a machine that idles over-committed.
- **Per-process truth:** `ps -o rss=` for cheap polling; `footprint <pid>` / `proc_pid_rusage` `phys_footprint` for accurate accounting (RSS lies under pressure — demonstrated above by the "loaded" 6.86 GB model showing no multi-GB process).
- **Local model state:** `lms ps` (CLI), `GET /api/v0/models` (`state`, context, quant) — poll to enforce the TTL/eviction policy and drive the dashboard's "local model" tile; Ollama: `GET /api/ps`.
- **Session inventory:** `tmux list-sessions -F ...` + control-mode notifications for live pane events.
- Suggested cadence: pressure + swap every 10 s; per-session footprint every 30 s; model state every 15 s while a local job is queued, else 60 s.

---

## [X1] Priority statement — parallel multi-account sessions win

If the resource budget ever forces a choice, **parallel MAX_A + MAX_B + ENT sessions are non-negotiable and everything else is expendable.** Quantified sacrifice order (first sacrificed → last):

1. **Local model size** — the single biggest lever: dropping 14B→8B frees ~4–5 GB; unloading entirely frees **5–11.5 GB**. Local-work offload degrades to cloud/queued.
2. **Local model context/KV** — 32K→8K on an 8B-class model frees **1–3.5 GB**; parallel slots 4→1 frees up to several GB more on big-ctx configs.
3. **Frontend shell weight** — Electron→Tauri/browser tab frees **0.2–0.4 GB**; dropping live graph animation/virtualizing terminals frees ~0.1–0.3 GB.
4. **Non-Claude sessions** — hibernate idle OpenCode/Bedrock sessions: **0.2–1.5 GB each** (resumable; Bedrock work is API-side anyway).
5. **Scrollback/history/telemetry buffers** — tmux history-limit, xterm.js scrollback, monitoring cadence: **0.1–0.5 GB**.
6. **Never sacrificed:** the three account sessions. Worst honest case (all three leaking simultaneously at watchdog threshold) is ~9 GB — still fits on 36 GB with everything above shed. Typical cost is ~1.2 GB, which is trivially affordable; the leak-watchdog (recycle-and-resume, which preserves the session, not kills the capability) is the only control ever applied to them.

Corollary already applied in this doc: Colima+k3s is rejected at this stage *because* its static 4–8 GB reservation would be paid before, and at the expense of, the parallel-session guarantee.

---

## Recommended defaults

| Knob | Default | Rationale |
|---|---|---|
| Max **resident** interactive sessions | **8** (3 Claude accounts + 5 others) | Fits pessimistic budget with a 8B model loaded |
| Max **registered** sessions (incl. hibernated) | 24 | Hibernated sessions cost ~0 RAM (disk-resumable) |
| Idle hibernation timer | 30 min (never auto-applied to the 3 account sessions without user opt-in) | Leak exposure ∝ session lifetime |
| Per-session watchdog | claude: warn 3 GB / recycle 6 GB; opencode: warn 1 GB / recycle 1.5 GB | Sourced leak history |
| Local model default | **≤8B Q4 (MLX preferred), ctx 16K, parallel 1** ≈ 5.5–6.5 GB | Biggest capability per GB |
| Local model max (opt-in) | 14B Q4, ctx ≤16K, only when resident sessions ≤ 6 | ~11.5 GB envelope |
| LM Studio mode | `lms server start` headless, JIT ON, auto-evict ON, request `"ttl": 1800` (900 under amber) | Idle model ≈ free |
| Amber threshold | pressure level 2, or free < 25%, or swap-used > 20 GB | Stop prewarm, shorten TTL, offer hibernation |
| Red threshold | pressure level 4, or free < 12%, or swap-used > 26 GB | Refuse new non-account spawns; unload local model; force-hibernate idle sessions. Account-session spawns (MAX_A/MAX_B/ENT) still allowed after shedding [X1] |
| tmux | `brew install tmux`; `history-limit 5000`; one named session per account | Persistence [X4] + structured control |
| Supervision | launchd LaunchAgents (user domain) for harness backend + `lms server start`; `KeepAlive={SuccessfulExit:false}`, `ThrottleInterval 10` | Keychain access; crash-only restart |
| `iogpu.wired_limit_mb` | leave at 0 (default ~24 GB) | Never needed at our model caps; raising it endangers session RAM |

---

## Implications for the harness

1. **Build a supervisor, not just a launcher.** The sourced failure mode of every component here is unbounded growth; the harness's core resource feature is the watchdog→checkpoint→recycle→resume loop, which doubles as the enabling mechanism for [X4] workstream continuations (a recycled session *is* a continuation child).
2. **tmux is a hard dependency to add** (`brew install tmux`); design the session layer around tmux session/window naming as the source of truth, with node-pty only bridging tmux→xterm.js for the UI.
3. **The local-model scheduler is a first-class module:** one global residency budget across LM Studio and Ollama, JIT+TTL enforcement with API verification, pressure-gated loads, and model-size auto-downgrade under amber.
4. **The observability dashboard gets its "system" tiles for free** from `memory_pressure -Q`, `vm_stat` deltas, `lms ps`/REST, and per-pid footprint polling — no kernel extensions or privileged helpers needed (all commands above run unprivileged).
5. **Frontend choice is a 0.2–0.4 GB decision, not an existential one** — pick Tauri or localhost-browser on developer-experience grounds; reject Electron only if a third Chromium genuinely offends on a machine already running two.
6. **Host-native deployment** for stage 2; the k3s/[X3] question should be revisited only with a concrete multi-host need, and any future VM must be sized *after* the [X1] session budget, never before.
7. **Secret-hygiene note for implementers [X2]:** all monitoring above is content-free (numbers, not payloads); keep it that way — never log session transcripts or Keychain-derived values into telemetry that could be committed.

---

## Sources

**Claude Code**
- https://code.claude.com/docs/en/setup (system requirements: 4 GB+ RAM; native binary via npm; auto-update)
- https://www.frr.dev/posts/claude-code-native-build-bun/ (native Bun binary)
- https://wotai.co/blog/claude-code-2-1-116 (2.1.113+ native binary)
- https://github.com/anthropics/claude-code/issues/4953 · /11315 · /22188 · /25926 · /27421 · /32752 · /33441 · /46931 · /10592 (memory-leak/OOM history)
- https://hyperdev.matsuoka.com/p/critical-memory-leak-in-claude-code (1.0.81 leak chronicle, NODE_OPTIONS workaround era)

**OpenCode**
- https://github.com/anomalyco/opencode/issues/16697 · /3013 · /2805 · https://github.com/sst/opencode/issues/3530 · /2585 (memory growth reports)
- https://opencode.ai/docs/tui/ (TUI docs)

**LM Studio / local models / Apple Silicon**
- https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict (JIT, TTL, auto-evict)
- https://lmstudio.ai/blog/lmstudio-v0.3.9 (TTL introduction)
- https://lmstudio.ai/docs/developer/core/headless (headless / llmster)
- https://lmstudio.ai/docs/developer/rest/endpoints (REST /api/v0, model state)
- https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/2051 · /634 (auto-evict bypass bugs)
- https://contracollective.com/blog/gguf-vs-mlx-quantization-formats-apple-silicon-2026 (MLX vs GGUF)
- https://inventivehq.com/blog/running-llms-on-apple-silicon-mlx · https://www.sitepoint.com/local-llms-apple-silicon-mac-2026/ (Apple Silicon LLM guides)
- https://mbrenndoerfer.com/writing/kv-cache-memory-calculation-llm-inference-gpu · https://dev.to/jagmarques/kv-cache-memory-calculator-how-much-does-your-llm-actually-use-85n · https://insiderllm.com/guides/kv-cache-optimization-guide/ (KV-cache math)
- https://pixelesque.net/other/snippets/macos/changing-mac-unified-memory-gpu-limit/ · https://github.com/ggml-org/llama.cpp/discussions/2182 · https://blog.peddals.com/en/fine-tune-vram-size-of-mac-for-llm/ (iogpu.wired_limit_mb, default GPU caps)

**Shell frameworks**
- https://www.gethopp.app/blog/tauri-vs-electron (benchmark: idle memory, macOS renderer comparison)
- https://www.levminer.com/blog/tauri-vs-electron (real-world app comparison)
- https://www.raftlabs.com/blog/tauri-vs-electron-pros-cons/ (framework trade-offs)

**PTY / tmux / launchd**
- https://github.com/microsoft/node-pty (node-pty)
- https://thomasdeegan.medium.com/electron-forge-node-pty-9dd18d948956 (Electron packaging pain)
- https://superset.sh/blog/terminal-daemon-deep-dive (persistent terminal daemon pattern)
- https://github.com/microsoft/vscode/issues/243952 (pty.node crash)
- https://primeline.cc/blog/tmux-orchestration · https://skillregistry.io/skill/tmux · https://hboon.com/using-tmux-with-claude-code/ (tmux agent orchestration patterns)
- https://code.claude.com/docs/en/agent-teams (official multi-session orchestration)
- https://support.apple.com/guide/terminal/script-management-with-launchd-apdc6c1077b-5d5d-4d35-9c19-60f2397b2369/mac · https://www.manpagez.com/man/5/launchd.plist/ · https://github.com/tjluoma/launchd-keepalive · https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html (launchd/KeepAlive)

**macOS memory monitoring**
- https://developer.apple.com/documentation/dispatch/dispatch_source_type_memorypressure (dispatch memory-pressure source)
- https://github.com/apple-oss-distributions/xnu/blob/main/doc/vm/memorystatus_notify.md (kernel pressure levels)
- http://newosxbook.com/articles/MemoryPressure.html (memorystatus/Jetsam background)

**Colima / k3s**
- https://github.com/abiosoft/colima · https://colima.run/docs/configuration/ (defaults, sizing)
- https://oneuptime.com/blog/post/2026-02-08-how-to-choose-between-colima-and-docker-desktop-on-macos/view (k3s vs Docker Desktop footprint)

---

## Open questions

1. **Actual leak behavior of claude v2.1.19x native binaries under multi-hour sessions** — the issue history spans many versions; a stage-2 soak test (3 sessions × 8 h, footprint sampled per minute) should calibrate the 3 GB/6 GB watchdog thresholds empirically.
2. **Bun/JSC heap-cap flag** — is there a supported equivalent of `--max-old-space-size` for the native binary (e.g. JSC RAM-size env vars), or is external recycling the only control? Needs experimentation; do not assume.
3. **MLX vs GGUF for the *specific* utility models chosen** (per-model quality at Q4 for skill-routing/summarization tasks) — throughput and RAM favor MLX; quality needs a task-level eval.
4. **LM Studio `PARALLEL` slot KV accounting** — does LM Studio pre-allocate KV for all slots or grow lazily? Determines whether parallel=4 is a real +GB cost at load or only under concurrent load. Verify against `/api/v0/models` + footprint while issuing concurrent requests.
5. **WKWebView (Tauri) performance for the force-directed context graph** at 1–5K nodes with live updates — the one plausible technical reason to accept Electron's memory premium.
6. **tmux control-mode parsing effort** vs plain `send-keys`/`capture-pane` polling — prototype both; control mode is cleaner but the polling pattern is battle-tested by the agent-orchestration community.
7. **Interaction between harness-managed sessions and Claude Desktop's bundled claude-code processes** (observed running from `~/Library/Application Support/Claude/claude-code/...`) — double-management risk if the user also opens sessions in the Desktop app; the session-inventory scanner should recognize and label these as externally-owned.
8. **Whether `opencode serve` shares the TUI's leak profile** — headless server mode is attractive for pipeline steps but its long-run growth is unmeasured.
