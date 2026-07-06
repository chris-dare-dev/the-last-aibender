# Live boot — running the aibender broker daemon

The broker is composed by `composeBroker` (core/src/main/index.ts) and booted as a
long-lived daemon by the **live-boot slice** (core/src/main/boot.ts). Before this
slice, running the daemon directly just printed a stub; now `… index.ts boot`
opens the real on-disk stores, discovers the account registry, composes the
broker, writes the discovery bootstrap, ticks the read-model publisher on a
timer, and runs until SIGINT/SIGTERM.

> **Local-only.** This is a machine-local daemon. It never deploys into any AWS
> account; AWS credentials (if present) are used only to invoke/bill Bedrock
> model calls. See the SI-4 note in `docs/reviews/optimization-scalability.md`
> and the project memory — the SI-4 terraform stays unapplied by design.

## Run it

```bash
pnpm -F aibender-core boot         # = tsx src/main/index.ts boot
```

It prints the gateway url + token + bootstrap path, then parks. Ctrl-C shuts it
down cleanly (publisher timer → gateway → ptyHost → kernel → stores; the
bootstrap file is retracted by the gateway on close).

The cockpit (Tauri app, or the vite dev server outside Tauri) discovers the
running broker through the bootstrap file the daemon wrote
(`$AIBENDER_HOME/bootstrap/gateway.json`) — no extra wiring.

## Config (environment)

| Env var | Default | Effect |
|---|---|---|
| `AIBENDER_HOME` | `~/.aibender` | Home for the bootstrap, `db/`, and the hook-token. |
| `AIBENDER_LIVE_SPAWN` | off | **Opt-in to the real Claude SDK spawn path.** Off → the composed runner refuses every spawn with a typed error; the gateway still serves and the cockpit still connects (launches error until you opt in). Real-account runs remain T3 owner-gated. |
| `AIBENDER_LIVE_PTY` | off | Opt-in to the real node-pty attended-PTY backend. Off → no PTY sessions. |
| `AIBENDER_PUBLISH_INTERVAL_MS` | `5000` | Read-model publish cadence (the OS-2 publish-cadence timer). |
| `AIBENDER_HOOKS` | on | Start the hooks accepting endpoint. The SEC-3 token gate is enforced only if `$AIBENDER_HOME/hook-token` exists (SI-3 mints it under `--hook-token`); otherwise the open loopback posture. |
| `AIBENDER_HOOKS_PORT` | endpoint default (4319) | Hooks listen port. |
| `AIBENDER_PROFILES_DIR` | repo `infra/profiles/` | Account-manifest dir the registry discovers Claude accounts from. Resolved CWD-independently (from the boot module); override for installs where the manifests live elsewhere. Empty/missing dir → zero accounts (the cockpit then falls back to a seed set). |
| `AIBENDER_COLLECTORS` | on | Master switch for the **v2 collector fleet** (the BE-5 sources that feed the events store). `=0` disables the whole fleet (dashboards stay NO-SIGNAL). Per-source toggles: `AIBENDER_COLLECTOR_JSONL`, `AIBENDER_COLLECTOR_QUOTA`, `AIBENDER_COLLECTOR_OTLP` (`=0` to disable one). |
| `AIBENDER_COLLECTOR_POLL_MS` | `2000` | Fleet scan/poll cadence (JSONL watchers + quota tee + join flush). |
| `AIBENDER_OTLP_PORT` | `4318` | Loopback OTLP receiver port. `port-in-use` degrades to a logged warning (the source goes idle), never a crash. |
| `AIBENDER_COLLECTOR_JOIN_WINDOW_MS` | `15000` | How long an `api_request` half waits for its JSONL↔OTel twin before it flushes as a single-source row. |

**Safe by construction:** with the defaults, boot spends no quota and spawns no
child — it stands up the gateway + read-model publisher + the collector fleet,
which READS machine-local files / loopback only (never spends quota). Flip
`AIBENDER_LIVE_SPAWN` on only when you intend real Claude sessions.

## What composes vs. what's deferred

**Composed now:** kernel + approvals + gated attended-PTY + gateway (with the
discovery bootstrap) + [X4] workstream lineage + the hooks accepting endpoint +
the BE-6 read-model publisher on a cadence timer + **the v2 collector fleet**
(core/src/main/collectors.ts) that feeds the events store the publisher reads.

The fleet wires three BE-5 sources (`AIBENDER_COLLECTORS=0` disables it):

- **Per-account JSONL watchers** — one per discovered `claude_code` account,
  tailing that account's OWN config dir (`projects/**`, `history.jsonl`,
  `usage-data/**`). Populates the token / burn-rate / cache-hit / api-equivalent
  leads. THE LABEL COMES FROM THE WATCH ROOT [X2].
- **Statusline quota tee ingestor** — reads `$AIBENDER_HOME/quota/<LABEL>.json`
  (SI-3's `aibender-statusline.sh` tees the CLI statusline JSON there). Populates
  the quota gauges.
- **Loopback OTLP receiver** on `127.0.0.1:4318` — the attribution/latency source
  (`api_request` OTel halves join the JSONL token-truth halves on request id).

> **Activation reality — a wired source is not a fed source.** Each lead renders
> honest NO-SIGNAL until its source actually has input on *this* machine:
> - **Quota gauges** need the SI-3 **statusline hook installed** so each account's
>   Claude Code tees `$AIBENDER_HOME/quota/<LABEL>.json`. No tee files → NO-SIGNAL.
> - **Token / burn / cache leads** need Claude Code sessions run **through
>   aibender** (which points `CLAUDE_CONFIG_DIR` at the per-account dir). The
>   watcher only tails each account's own config dir — the shared `~/.claude`
>   transcripts are unattributable by design and are never read.
> - **Attribution / latency** needs Claude Code's **OTel export enabled** and
>   pointed at `127.0.0.1:4318`. Off → the receiver listens idle.

**Still deferred** (each needs a live external system, not just a wire; the boot
surface exposes injection points):

- **Collector sources that need a running external process** — OpenCode SSE + db
  scrape (needs `opencode serve`), LM Studio inline capture (needs LM Studio),
  AWS Cost Explorer / CloudWatch pollers (SI-4-gated; estimate-only until), and
  the graphfeed context-graph sink (a separate publisher wire).
- **The supervision governor** — needs the real macOS `phys_footprint` sampler +
  pressure probe; until wired, the resource-health instrument renders NO SIGNAL.
- **The pipeline engine** — needs the real per-step executor fan-out
  (kernel / OpenCode / LM Studio); until wired, the gateway's documented
  `pipeline-not-found` degrade stands.

## Tests

`core/src/main/boot.spec.ts` drives the whole boot with fakes (FakeQueryRunner /
FakePtyBackend / synthetic registry / `:memory:` stores / captured timers):
config resolution, the real compose (on-disk bootstrap written, PTY gating,
workstream slice, publisher cadence, the collector fleet feeding the store), a
real WS round-trip (the timed publisher lane → gateway → a connecting client via
the frozen §8 replay), and idempotent shutdown. `core/src/main/collectors.spec.ts`
exercises the fleet in isolation over a `:memory:` store: config resolution, a
teed statusline payload landing in `quota_snapshots`, watcher counting, an honest
zero on absent inputs, OTLP disabled / injected-`listening` / `port-in-use`
degrade, and idempotent shutdown. No live system is touched.
