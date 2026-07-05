# Runbook — enabling the kernel's REAL claude spawn path (T3, owner-gated)

> BE-1 ships the real spawn path **implemented but disabled**. Everything on
> this page is a live-host (T3) operation against real accounts and runs only
> on the owner's machine, on the owner's go-ahead. Nothing here executes in CI
> or in unit tests — those use the FakeQueryRunner exclusively.

## What the gate is

`composeKernel` (core/src/main/) wires a **refusing runner** by default: every
spawn attempt throws a typed `LiveSpawnDisabledError` (and still exercises the
row-before-spawn discipline — the refused launch leaves a settled `exited`
ledger row, never an untracked child).

The real path is `createSdkQueryRunner({ liveSpawnOptIn: true })`, reachable
only via explicit config:

```ts
const composed = await composeKernel({
  storePath: '/Users/<you>/.aibender/db/kernel.db',
  liveSpawn: { enabled: true },          // ← the explicit opt-in
});
```

Properties of the live runner (all enforced in code, tested with fakes):

- **Pinned binary**: `pathToClaudeCodeExecutable` resolves to the binary
  bundled with the pinned SDK (`@anthropic-ai/claude-agent-sdk-<platform>-
  <arch>/claude`, resolved through the SDK's own module graph). Never a
  Homebrew/global `claude`. Changing the binary = a deliberate SDK version
  bump through the version-gate runbook (docs/runbooks/version-gate.md).
- **Full env replacement**: the SDK is passed the complete buildSessionEnv
  output; verified against SDK 0.3.201 that `options.env` replaces the
  subprocess environment (no process.env merge) — the ANTHROPIC_*/
  CLAUDE_CODE_USE_* scrub cannot leak back.
- **Refusals hold on the live path too**: `--bare`, any extraArgs (M1), and
  CLAUDE_CODE_OAUTH_TOKEN in the spawn env are typed errors at the runner
  boundary, independent of the kernel's own checks.

## Preconditions (all owner-executed, in order)

1. SI-2 provisioning done: `~/.aibender/accounts/<stem>/` exist
   (see docs/runbooks/login-bootstrap.md) and one interactive `claude /login`
   per account has been performed, ever.
2. Keychain probe green for every per-config-dir service name (SI-2
   probe script; never `security ... -w`).
3. Version gate green for the pinned SDK (docs/runbooks/version-gate.md) —
   includes the keychain service-name recompute and, before any rung-2 use,
   the setup-token deletion canary (issue-#37512 class).
4. `AIBENDER_HOME` resolves where you expect (default `~/.aibender`); if the
   account dirs live elsewhere, write machine-local overrides to
   `$AIBENDER_HOME/profiles.json` (absolute paths; NEVER committed [X2]).

## M1 acceptance run (the [X1] live proof)

With the preconditions green, the owner runs the M1 demo: one broker process,
three concurrent SDK sessions (one per account label), each completing with
zero re-login, distinct `CLAUDE_CONFIG_DIR` per session visible in each spawn
env, ledger rows `spawning → running → exited` per session. The SIGKILL
orphan probe (SPIKE-D vii) is then re-run against the real kernel per the M1
DoD.

**Pending owner items** (do not run without a verbal OK):

- First live spawn against MAX_A/MAX_B/ENT (consumes real quota).
- SIGKILL orphan re-run against real SDK children.
- Any rung-2 (`claude setup-token`) experiment — canary-gated, SI-2 owns it.

## Rollback

Remove `liveSpawn: { enabled: true }` from the composition config (or stop
passing a runner). The default composition refuses all spawns; ledger and
profiles remain intact and readable.
