# Runbook — attended PTY sessions live (BE-2, T3 owner-gated)

**Status:** implemented at M2, live verification PENDING OWNER (T3)
**Audience:** owner only — real accounts, real TUI, real Keychain
**Sources of record:** plan §4/BE-2 + §9.4, blueprint §4.1,
[spike-d-pty-supervision](../spikes/spike-d-pty-supervision.md),
[login-bootstrap.md](login-bootstrap.md) (SI-2's shell-level procedure — this
runbook is the harness-driven variant),
[kernel-live-spawn.md](kernel-live-spawn.md) (the SDK-substrate gate this one
mirrors).

Everything below runs the REAL pinned SDK-bundled `claude` binary in a
daemon-owned node-pty. Unit tests never do this — they run the synthetic TUI
backend (`core/src/kernel/pty/testing/fakePtyBackend.ts`). The real path is
double-gated:

1. `createNodePtySpawner({ liveSpawnOptIn: true })` — same explicit opt-in
   flag class as the SDK runner; anything else throws
   `LiveSpawnDisabledError`.
2. You, running it on purpose, per this runbook.

---

## 1. What the live pass must verify (SPIKE-D "what remains" §1 + plan §8.2 M2 DoD)

| # | Check | Where it is coded |
|---|---|---|
| 1 | Attended TUI spawns via node-pty with `buildSessionEnv` env (config-dir pair, scrub) | `ptyHost.ts` `insertRowAndSpawn` |
| 2 | `--session-id <uuid>` is accepted by the pinned binary and pins the native session id | `defaultPtyArgv` (`attended` kind) — **version-gate this argv on every SDK bump** (SI-2 gate; the builder is injectable for drift) |
| 3 | Login bootstrap: fresh profile → `claude /login` in the PTY → browser hop → Keychain item appears (probe WITHOUT `-w`, SI-2 script) | `launchLoginBootstrap` + `infra/scripts` probes |
| 4 | Flow control against the real TUI: pause during interactive prompts does not wedge redraw; typing echo p95 < 100 ms with flow control engaged | gateway `ptyStream` + host levers |
| 5 | Detach → reattach replays from the watermark; serialize-addon snapshot covers below-floor history | `attach({ replayFrom })` |
| 6 | Recycle v0 on a live session: graceful hangup → `--resume <native-id>` continues the conversation; `--fork-session` forks it | `recycle()` — **verify both argv shapes against the pinned binary** |
| 7 | spawn-helper exec bit intact in the packaged/installed tree | `core/scripts/fix-spawn-helper.mjs` (postinstall) + `ensureSpawnHelperExecutable` (runtime) |

## 2. Procedure (dev Mac, provisioned accounts)

```ts
// owner-run script sketch (tsx), NOT part of CI:
import { openKernelStore } from '@aibender/schema';
import {
  createNodePtySpawner, createPtyHost, createProfileRegistry,
} from 'aibender-core/src/kernel/index.js';

const store = await openKernelStore({ path: `${process.env.HOME}/.aibender/db/kernel.db` });
const host = createPtyHost({
  ledger: store.resumeLedger,
  profiles: createProfileRegistry({}),
  backend: createNodePtySpawner({ liveSpawnOptIn: true }),   // THE gate
});
const session = await host.launchAttended({
  accountLabel: 'MAX_A', backend: 'claude_code', substrate: 'pty',
  cwd: `${process.env.HOME}/scratch`, purpose: 'T3 attended verification',
});
session.attach((frame) => process.stdout.write(frame.payload)); // eyeball the TUI
```

- Login bootstrap: `host.launchLoginBootstrap({ accountLabel: 'ENT' })`, then
  follow the TUI/browser flow; verify with SI-2's keychain probe (never `-w`).
- Recycle: `await host.recycle(session.sessionId)` mid-conversation; confirm
  the TUI comes back resumed on the same native session.
- Record outcomes in this file's table (pass/fail + binary version) — checks 2
  and 6 pin argv behavior of the pinned binary and become version-gate rows.

## 3. Known deliberate limits (v0)

- Fork-recycle children get no native-id backfill (the forked binary mints a
  new one; only JSONL/hook sources can observe it — BE-5/BE-7 reconcile at
  M3/M4). Such a child cannot itself recycle until reconciled.
- Login-bootstrap rows record the executable path as a conservative spawn
  nonce (no unique argv token) — a false "alive" only blocks a resume, which
  is the safe direction (`pidLiveness.ts`).
- Recycle does not tail-validate before respawn (the graceful hangup flushes
  the TUI; torn-tail repair remains on the kernel's SDK dead-resume path).
  BE-9 hardens this at M6.
- Completion of a login is NEVER detected from PTY bytes (nothing parses
  them); the operator (or the SI-2 probe) is the authority.
