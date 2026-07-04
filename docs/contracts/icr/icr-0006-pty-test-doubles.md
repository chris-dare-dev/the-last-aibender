# ICR-0006 — Promote BE-2 pty test doubles into @aibender/testkit

- Requesting lane: BE-B (BE-2 · pty host & approvals), via the BE-2 M2 return
- Surface: `packages/testkit`
- Freeze state at request time: n/a (testkit "grows continuously", plan §3)

## Motivation

BE-2 implemented its PtyBackend double locally under
`core/src/kernel/pty/testing/fakePtyBackend.ts` per the ICR-0001 precedent
("contribute the fake to packages/testkit via ICR if the steward has not
provided one"). The BE-2 return flagged it for promotion: FE-3 and BE-9 want
the same synthetic-TUI byte source (`syntheticLoginTui` + `asciiBytes`) that
drives the login-bootstrap and recycle suites, and every future pty-facing
suite should script the ONE canonical backend double.

## Change (landed 2026-07-04)

`packages/testkit/src/fakePtyBackend.ts` exports:

- **`FakePtyBackend` / `FakePtyProcess`** — deterministic scripted PtyBackend:
  spawn recording, monotonic fake pids, microtask-deferred scripts (mirrors
  real node-pty: output never precedes spawn() returning), spawn-failure
  injection, graceful-vs-SIGKILL settlement with `ignoreGracefulSignals` for
  grace-escalation tests, write/resize/signal recording.
- **`syntheticLoginTui` + `asciiBytes` + `SYNTHETIC_LOGIN_BANNER` /
  `SYNTHETIC_LOGIN_SUCCESS` / `FAKE_PTY_EXECUTABLE`** — the [X2] synthetic
  TUI byte source (banner on spawn, opaque echo, exit 0 on the
  CR-terminated fake code).
- **`PtyBackend` / `PtyProcess` / `PtySpawnSpec` / `PtyExitEvent`** —
  structural mirror of `core/src/kernel/pty/ptyBackend.ts` (the seam of
  record; ICR-0001 option (a) posture, same drift rule).

## Compatibility

Move semantics, per the ICR-0001 landing record: `core/src/kernel/pty/testing/`
was deleted and the two consuming specs (`ptyHost.spec.ts`,
`gatewayPort.spec.ts`) switched to `@aibender/testkit` in the same change.
The pty architecture suite is unaffected (it scopes to production sources in
`pty/` itself). Zero new testkit dependencies. Fixture policy [X2] honored —
every byte synthesized, loudly fake banner. A double sanity suite
(`fakePtyBackend.spec.ts`) moved in with the promotion.

## Sign-off

- Owning orchestrator (BE-ORCH): **landed 2026-07-04**
- Counterpart orchestrator: n/a (test-only surface; FE-3 consumes voluntarily)
