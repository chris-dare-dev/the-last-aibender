# ICR-0002 — Unified gateway kernel double (FakeKernel over FakeQueryRunner)

- Requesting lane: BE-C (BE-3 · gateway) via the BE-3 return; landed by BE-ORCH
- Surface: `packages/testkit`
- Freeze state at request time: pre-freeze (testkit "grows continuously", plan §3)

## Motivation

Two query-runner doubles grew during the M1 build: BE-1's rich scripted
`FakeQueryRunner` (`core/src/kernel/testing/`, promoted by ICR-0001) and a
private, simpler one inside BE-3's `core/src/gateway/fakeKernel.ts` (kept
deliberately unexported from the gateway index). BE-3's return asked for one
canonical double in `@aibender/testkit` so FE-2 contract tests can drive the
same kernel behavior the gateway suites see, against the golden WS fixtures
(ICR-0003).

## Change (landed 2026-07-04)

`packages/testkit/src/fakeKernel.ts` exports:

- **`FakeKernel`** — implements the gateway kernel port ON TOP of the
  canonical ICR-0001 `FakeQueryRunner` (default: `manual` mode + fake pids).
  Mirrors the real kernel's externally-visible discipline: row-before-spawn
  (`launch` answers `spawning`, status is answerable immediately), async spawn
  to `running`+pid, init-message `nativeSessionId` backfill, runner
  result/stream-end settles to `exited`, `double-resume-blocked` for un-forked
  running-family resumes, fork = continuation CHILD with `forkedFrom`, kill
  awaits the in-flight spawn then interrupts (graceful) or aborts (force).
  Test levers: `autoSpawn:false` gating (`releaseSpawn`/`failSpawn` — the
  kill-while-launching lever), `stateOf`, `spawnSettled`, `kills`, and the
  exposed `runner`.
- **`GatewayKernel` port + result/param types** — structural mirror of
  `core/src/gateway/kernel.ts` (the port of record; same drift rule as the
  ICR-0001 queryRunner mirror).
- **`FakeKernelVerbError` / `isKernelVerbErrorLike`** — a structural twin of
  core's `KernelVerbError` (same `name`/`code`/`retryable` shape) plus a
  structural guard that matches BOTH classes.

## Compatibility

- Testkit gained a `@aibender/protocol` workspace dependency (type-only wire
  vocab + `isErrorCode`); protocol is dependency-free, no cycle.
- `core/src/gateway/fakeKernel.ts` still exists and its suites still pass —
  migrating the gateway suites onto the testkit double is BE-3's follow-up,
  not forced here (BE-ORCH touches core only for the sanctioned ICR-0001
  import moves).
- **Known seam for that follow-up:** core's `isKernelVerbError` is an
  `instanceof` check, so a `FakeKernel` driven through the REAL gateway server
  must inject core's error class via the `verbError` option — or BE-3 loosens
  `isKernelVerbError` to the structural check (recommended; file it against
  ICR-0002 when taken).

## Sign-off

- Owning orchestrator (BE-ORCH): **landed 2026-07-04**
- Counterpart orchestrator: n/a (test-only surface; FE-2 consumes voluntarily)
