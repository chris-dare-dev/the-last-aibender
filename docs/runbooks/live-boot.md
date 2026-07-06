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

**Safe by construction:** with the defaults, boot spends no quota and spawns no
child — it stands up the gateway + read-model publisher (honest NO-SIGNAL until
data flows) so the cockpit connects to a real broker. Flip `AIBENDER_LIVE_SPAWN`
on only when you intend real Claude sessions.

## What v1 composes vs. what's deferred

**Composed now:** kernel + approvals + gated attended-PTY + gateway (with the
discovery bootstrap) + [X4] workstream lineage + the hooks accepting endpoint +
the BE-6 read-model publisher on a cadence timer.

**Deferred to a v2 wire** (each needs a live-system port the codebase marks
"bound at the operator-config slice", guarded like `liveSpawn`; the boot surface
already exposes injection points):

- **The full BE-5 collector fleet** — JSONL tailers (per account), the OTLP
  receiver, statusline tee, OpenCode SSE, AWS pollers. Until wired, the
  read-model publisher renders honest NO-SIGNAL / estimate-only from an empty
  events store (plus whatever the hooks endpoint feeds). This is the biggest v2
  piece and the one that "lights up" the dashboards with real data.
- **The supervision governor** — needs the real macOS `phys_footprint` sampler +
  pressure probe; until wired, the resource-health instrument renders NO SIGNAL.
- **The pipeline engine** — needs the real per-step executor fan-out
  (kernel / OpenCode / LM Studio); until wired, the gateway's documented
  `pipeline-not-found` degrade stands.

## Tests

`core/src/main/boot.spec.ts` drives the whole boot with fakes (FakeQueryRunner /
FakePtyBackend / synthetic registry / `:memory:` stores / a captured publisher
timer): config resolution, the real compose (on-disk bootstrap written, PTY
gating, workstream slice, publisher cadence), a real WS round-trip (the timed
publisher lane → gateway → a connecting client via the frozen §8 replay), and
idempotent shutdown. No live system is touched.
