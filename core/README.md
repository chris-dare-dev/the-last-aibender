# core/ — `aibender-core` broker daemon (BACKEND department)

The host-native broker that drives every session. One process owns all
per-account Claude sessions, the OpenCode/Bedrock and LM Studio adapters, the
observability collector, the X4 lineage ledger, the pipeline DAG engine, and the
supervision governor — and exposes them to the cockpit over **one multiplexed
WebSocket** discovered via the bootstrap file
([docs/contracts/bootstrap-file.md](../docs/contracts/bootstrap-file.md)).

**To run it locally, read [docs/runbooks/local-dev-start.md](../docs/runbooks/local-dev-start.md)** —
in v0 the `start` script is a stub; a listening broker is composed via
`composeBroker()` (see `demo:m1` / `soak:m2`).

## Layout (`core/src/`)

| Dir | What lives there |
|---|---|
| `kernel/` | Per-account session spawn with `CLAUDE_CONFIG_DIR` env injection + provider-hijack scrub ([X1]); the resume ledger (row-before-spawn, double-resume block); `pty/` attended PTY host (ack-ring flow control, login bootstrap, recycle); the ApprovalBroker + `canUseTool` relay. |
| `gateway/` | The WS server: bootstrap file write/discovery, binary PTY streaming with backpressure, transcript projection, approvals bridge, reconnect-replay journals, multi-client fan-out. |
| `adapters/` | `opencode/` (supervised `opencode serve` + SSE dedupe + the guarded read-only `opencode.db` accessor — SECURITY.md §6) and `lmstudio/` (down-as-state, JIT/TTL residency). |
| `collector/` (+`graphfeed/`) | The §6.1 observability source matrix (JSONL tailer, statusline tee, OTLP receiver, SSE, hooks endpoint, …) and the context-graph feed. |
| `readmodels/` | The dashboard read models + the freshness state machine (down-as-state). |
| `workstreams/` | [X4] lineage: the action-time `LineageRecorder`, merge-brief synthesis, the reconciler, context-pressure watch. |
| `pipelines/` | The capability-catalog scanner + the versioned JSON DAG engine + the durable memoization journal. |
| `supervision/` | The governor: footprint watchdog, pressure state machine, the [X1] sacrifice-order scheduler, idle hibernation. |
| `main/` | `composeBroker()` — wires every port through one composition; the direct-execution entry (a v0 stub, see the runbook). |

`scripts/` holds the runnable proofs: `demo:m1` (the synthetic [X1] demo, the
canonical listening-broker example), `soak:m2` / `soak:m6` (the soaks).

## Ownership & boundaries

- **Owned by the Backend (BE) department**; shared surfaces (`packages/*`) are
  orchestrator-stewarded — cross-package needs go through an ICR
  ([docs/contracts/icr/README.md](../docs/contracts/icr/README.md)), never a
  silent edit.
- `core/` imports **nothing** from `infra/` (architectural test [X3]).
- The live SDK spawn path is owner-gated — the dev loop uses the
  `@aibender/testkit` `FakeQueryRunner` ([docs/runbooks/kernel-live-spawn.md](../docs/runbooks/kernel-live-spawn.md)).

## Commands

```bash
pnpm -F aibender-core test        # vitest
pnpm -F aibender-core typecheck   # strict tsc
pnpm -F aibender-core demo:m1     # the synthetic X1 demo (listening broker example)
pnpm -F aibender-core soak:m2     # M2 PTY soak;  soak:m6 = supervision soak
```
