# ICR-0005 — Kernel pid-liveness guard on un-forked dead-resume of `running` rows

- Requesting lane: BE-ORCH (fix wave), implemented by the BE fix lane
- Surface: `docs/contracts/sqlite-ddl.md` §4 (prose alignment only — no DDL,
  no transition-table change, no `packages/schema` change)
- Freeze state at request time: frozen at M1 (kernel slice, 2026-07-04)

## Motivation

sqlite-ddl.md §4 defines `running → resumed` as legal only "after
broker+child death", and §3.3 carries the SPIKE-D finding-2 columns
(`pid`, `spawn_nonce`) precisely so a restarting broker can verify child
death before acting. The M1 kernel wrote those columns but never consulted
them: an un-forked `resume(fork:false)` of a `running`-state row judged
"live" solely by the in-process handle map, so after a broker crash it would
transcript-validate and re-drive the same native session even if the original
child was still alive — exactly the blueprint §5 un-forked double-resume
transcript-corruption mode. The M1 DoD item "SIGKILL orphan probe (vii)
re-run against the real kernel passes" exercises this path.

## Change (landed)

Kernel-side enforcement (`core/src/kernel/pidLiveness.ts` +
`sessionKernel.ts`), documented in sqlite-ddl.md §4:

1. **pid recorded** → un-forked dead-resume of a `running` row probes
   `kill(pid, 0)` + the argv `spawn_nonce` identity check (pid-reuse guard,
   SPIKE-D). Verified-alive → `double-resume-blocked`, row untouched (a live
   orphan belongs to restart reconciliation, BE-2/BE-9 at M2 —
   `running → orphan_detected → orphan_killed`). Forking stays available.
2. **pid NULL** (SDK path — `query()` cannot surface the child pid at SDK
   0.3.201) → un-forked dead-resume stays available. Reasoning, encoded as
   tests in `sessionKernel.spec.ts` ("pid-liveness guard" suite):
   - SDK children share the broker's stdio-pipe lifetime: spawned attached
     via pipes (never detached/setsid, same process group); a stream-json
     child exits on stdin EOF when the dead broker's pipe end closes.
   - Defense in depth: a child that could outlive its broker was mid-turn,
     and a mid-turn death leaves a dangling/torn transcript tail — the
     transcript-tail validator routes that to a repair **fork**, never an
     un-forked re-drive of the same native session.
3. The probe is injectable (`SessionKernelOptions.pidProbe`); the default
   implementation probes the real process table and is tested against real,
   test-owned child processes (`pidLiveness.spec.ts`).

## Compatibility

- No wire change, no DDL change, no storage-legality change. The guard
  refuses (typed `double-resume-blocked`) cases that previously proceeded
  unsafely; `resume(fork: true)` remains available for every refused row.
- Consumers: BE-1 kernel (enforcing), gateway/adapter answer the error code
  verbatim (already registered — no ErrorCode addition).

## Sign-off

- Owning orchestrator (BE-ORCH): **landed 2026-07-04** (decision directed in
  the M1 fix wave)
- Counterpart orchestrator: n/a (kernel + DDL prose; no FE-consumed surface
  changes)
