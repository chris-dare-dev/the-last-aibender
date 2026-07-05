# Runbook — recovery: broker crash, orphan sessions, journal resume

**Status:** live (mechanism proven by unit + integration tests) · **the live
drills below are T3, owner-run** on a real machine with real sessions
**Sources of record:** blueprint §2 (broker crash-restart replaces tmux
survival) + §4.1 (row-before-spawn) + §5 (double-resume guard),
[sqlite-ddl.md §3.3/§4](../contracts/sqlite-ddl.md) (the `resume_ledger` table
+ its FROZEN state machine), [sqlite-ddl.md §10.4](../contracts/sqlite-ddl.md)
(the `step_attempt` memoization journal),
[kernel-live-spawn.md](kernel-live-spawn.md) (enabling the real spawn path),
[launchd.md](launchd.md) (broker LaunchAgent).

This runbook covers three recovery paths the harness is built to survive:

1. **Broker crash / restart** — the daemon dies (crash, OOM-kill, `kill -9`,
   or a clean stop); sessions it launched are recovered on the next start.
2. **Orphan sessions** — a child session process is still alive but its broker
   is gone; it must be reaped (process-group SIGKILL) before any resume.
3. **Pipeline journal resume** — a pipeline run interrupted mid-flight resumes
   from the memoization journal without re-executing completed steps.

Nothing here mutates the Keychain, `~/.claude`, or launchd. The one
destructive action a recovery may take is a **process-group SIGKILL of a
verified orphan** — and only after pid + argv-nonce identity is proven
(pid-reuse guard), never a blind kill.

---

## 0. The state that makes recovery possible

Everything recoverable is written **before** the risky action, in the
machine-local kernel database (`~/.aibender/db/`, sqlite):

| What | Where | Written when |
|---|---|---|
| Session record (account, backend, cwd, purpose, pid, spawn nonce) | `resume_ledger` | row inserted in state `spawning` **before** fork/exec (row-before-spawn, blueprint §4.1) |
| Native session id (the CLI/SDK's own id) | `resume_ledger.native_session_id` | backfilled from the session's init message (write-once) |
| Pipeline step outcomes + cached outputs | `step_attempt` (the memoization journal) | append-only as each step attempt settles |

Because the row precedes the spawn, a crash in the row↔spawn window leaves a
recoverable `spawning` record, never an untracked child. This is the invariant
recovery leans on — do not "clean up" ledger rows by hand.

---

## 1. Broker crash / restart recovery

### What happens automatically

- **Under the v1 LaunchAgent** (owner-flipped, [launchd.md](launchd.md)):
  `KeepAlive={SuccessfulExit:false}` restarts the broker on any crash /
  non-zero exit within launchd's ~10 s throttle, and leaves it down on a clean
  exit (exit 0). A restarted broker reconciles the ledger on startup.
- **Under the v0 Tauri sidecar:** the sidecar is respawned by the app on its
  own supervision path; the same ledger reconciliation runs at broker start.

### Startup reconciliation (what the broker does on every start)

The kernel reads `unreconciled()` — every ledger row **not** in the terminal
`exited` state (`spawning`, `running`, `resumed`, `orphan_detected`,
`orphan_killed`) — and classifies each against the live process table
(`sqlite-ddl.md §4`):

- `spawning` with no live pid → the spawn never completed; safe to resume or
  retire.
- `running`/`resumed` with **no** live pid → clean dead-resume path
  (`running → resumed`): the session is re-driven from its native id and the
  last coherent transcript entry. No orphan row is produced on this path.
- `running`/`resumed` with a live pid but no broker parent → **orphan** — see §2.

### Operator checks after an unexpected restart

```sh
# 1. Broker back up? (v1 LaunchAgent)
launchctl print "gui/$UID/com.aibender.broker" | head -20   # state = running, note PID

# 2. Ledger reconciliation state (read-only; sqlite ships with macOS)
sqlite3 "$HOME/.aibender/db/kernel.sqlite" \
  "SELECT id, account_label, backend, state, pid FROM resume_ledger
     WHERE state != 'exited' ORDER BY updated_at_iso;"

# 3. Broker logs (v1 LaunchAgent paths)
tail -n 100 "$HOME/.aibender/logs/broker.err.log"
```

- Every non-`exited` row should either be re-driven to `resumed` or reach
  `orphan_detected`→`orphan_killed`→`resumed`/`exited` within a few seconds of
  the restart. A row **stuck** in `orphan_detected` means the reap did not
  complete — go to §2.
- The account sessions never require a re-login on restart: their
  Keychain credentials are read fresh by each resumed session (that is the
  whole point of the Aqua-domain rule, [launchd.md](launchd.md)). If a resumed
  account session reports an auth failure, the broker is not in the Aqua
  session — re-verify the LaunchAgent domain, do **not** re-login.

---

## 2. Orphan detection + the SIGKILL-orphan drill

An **orphan** is a session child that is still alive while its broker is gone
(the classic "broker died, `claude` kept running" case). The danger is
**double-resume**: re-driving the same native session while the original child
still holds it corrupts the transcript (blueprint §5). So the kernel refuses
to resume until the orphan is provably dead.

### How an orphan is verified (never a blind kill)

Before touching anything, the kernel proves the recorded pid is still the
**same** process the ledger described (`pidLiveness.ts`, SPIKE-D pid-reuse
guard):

1. `process.kill(pid, 0)` — existence probe, no signal delivered.
2. **argv-nonce identity**: the live process's argv must contain the
   `spawn_nonce` recorded in the ledger. A live pid **without** the nonce is a
   pid-reuse stranger (some unrelated process now holds that pid) — the real
   child is gone, treat as dead.

Only a pid that exists **and** carries the nonce is a true orphan. It moves
`running → orphan_detected`, then the kernel reaps it.

### The reap: process-group SIGKILL

Claude/OpenCode children double-fork (SPIKE-D finding 2), so a single-pid kill
leaves grandchildren behind. The reap therefore targets the **process group**:
`orphan_detected → orphan_killed` is a process-group SIGKILL of the verified
orphan (`sqlite-ddl.md §4`). Only after `orphan_killed` may the kernel resume
(`orphan_killed → resumed`) from the last coherent journal entry, or retire it
(`orphan_killed → exited`) if resume is impossible/declined.

### The T3 drill (owner-run, real child)

Prove the whole chain on a real machine (the synthetic edition is covered by
the kernel unit tests — `pidLiveness.spec.ts`, `sessionKernel.spec.ts`):

```sh
# 1. Launch a real session via the broker (kernel-live-spawn.md), note its id.
# 2. Find the child pid the ledger recorded:
sqlite3 "$HOME/.aibender/db/kernel.sqlite" \
  "SELECT id, pid, spawn_nonce, state FROM resume_ledger WHERE state='running';"
# 3. Confirm the nonce is really in the child's argv (the pid-reuse guard input):
ps -o args= -p <pid> | grep -q "<spawn_nonce>" && echo "nonce present (true child)"
# 4. Simulate a broker crash that leaves the child alive:
#    kill -9 the BROKER pid (NOT the child). The child is now an orphan.
# 5. Restart the broker (launchctl kickstart the agent, or relaunch the sidecar).
# 6. Watch the ledger walk: running → orphan_detected → orphan_killed → resumed
sqlite3 "$HOME/.aibender/db/kernel.sqlite" \
  "SELECT id, state, updated_at_iso FROM resume_ledger ORDER BY updated_at_iso DESC LIMIT 5;"
# 7. Confirm no orphan grandchildren survived the process-group reap:
pgrep -g <original_child_pgid> || echo "process group fully reaped (no orphans)"
```

**If a live pid carrying the nonce survives step 7**, the process-group reap
did not target the right group — stop and file an ADR; do not paper over it
with a manual `kill -9`, which would defeat the guard the test exists to prove.

---

## 3. Pipeline journal-resume recovery

A pipeline run (M5) that is interrupted — broker crash, cancel, or a step
budget breach — resumes **without re-running completed steps**. The mechanism
is the `step_attempt` memoization journal (`sqlite-ddl.md §10.4`).

### How it resumes

- Every step attempt is appended to `step_attempt` keyed by
  `(run_id, step_id, iteration, attempt)`; a settled step carries its
  `input_hash` (`sha256` of resolved inputs) and, when COMPLETED, its cached
  output.
- On resume the runner calls `findMemoized(run, step, iteration, input_hash)`.
  A hit returns the cached output of a COMPLETED/`memoized` attempt — the step
  is **not** re-executed (this is the M5 DoD). Only steps with no memoized
  completion (or whose inputs changed → different `input_hash`) re-run.
- A run interrupted at an **approval gate** resumes `paused` and re-presents
  the gate in the inbox; approving it continues from the gate, not the top.

### Operator checks + resume

```sh
# Runs that did not reach a terminal state:
sqlite3 "$HOME/.aibender/db/kernel.sqlite" \
  "SELECT id, status, schema_hash FROM pipeline_run
     WHERE status IN ('running','paused') ORDER BY id;"

# Per-step journal for one run (what will be skipped vs re-run on resume):
sqlite3 "$HOME/.aibender/db/kernel.sqlite" \
  "SELECT step_id, iteration, attempt, state FROM step_attempt
     WHERE run_id='<run_id>' ORDER BY step_id, iteration, attempt;"
```

Re-launch/resume the run from the run monitor in the cockpit (or the pipeline
`resume` verb). Steps already `completed`/`memoized` in the journal are served
from cache; the run picks up at the first unsettled step.

### Budget-breach reaping (why a breached step leaves no orphans)

When a step exceeds its wall-clock budget or the run is cancelled, the runner
aborts the in-flight step **and reaps its process group** (`runner.ts`
`reapStep`/`reapAll`, `ProcessGroupReaper`). The breached step is journaled as
failed; on resume it re-runs (its inputs are unchanged, but a failed attempt is
not a memoized completion). No child of a breached step survives the reap — the
same process-group discipline as §2.

---

## 4. Resource-supervision soak (the ~17 GB envelope, L9)

The blueprint §11 budget target is the full scenario — 3 account sessions + 2
OpenCode + a JIT local model — staying within the ~17 GB pessimistic envelope
with **no unsupervised growth**, held there by the BE-9 governor
(`core/src/supervision/`): the per-session phys_footprint watchdog (claude warn
3 GB / recycle 6 GB; opencode warn 1 GB / recycle 1.5 GB; `opencode serve`
sustained >500 MB/5 min), the pressure-delta amber/red state machine, and the
[X1] sacrifice order (local model → model context → frontend weight →
non-account hibernation → scrollback — **account sessions are never the
victim**, and account spawns are still honored after shedding).

### The mechanism proof (runs anywhere, no accounts, no cost)

```sh
pnpm -F aibender-core soak:m6            # 2880 governor ticks = a compressed 24 h day
pnpm -F aibender-core soak:m6 20000      # deeper local run (argv overrides tick count)
```

This drives the **real** governor over a full day of accelerated pressure churn
against a FAKE ramping footprint feed + oscillating pressure feed — **no real
process is bloated, no `memory_pressure` is shelled** (blueprint §3). It prints
a JSON verdict and asserts, across every tick: no account session is ever a
shed/hibernate victim (`accountSessionsShed: 0`); bloated sessions are recycled
(continuation, not shedding); the resident set never ratchets up under sustained
red (`residentRatchetViolations: 0` — this IS the "no unsupervised growth"
check); the local model is evicted under red; account spawns stay admitted at
red while non-account spawns are refused; every emitted `resource-health`
snapshot validates and carries labels + numbers only [X2]. The same mechanism is
asserted on every `pnpm -r test` by `core/src/supervision/soak.spec.ts` (a fast
fixed-tick edition) and the induced-bloat unit tests
(`core/src/supervision/watchdog.spec.ts`, `governor.spec.ts`,
`scheduler.spec.ts`).

### The real 24 h soak (T4 / owner-gated — never run in CI)

The **real** 24 h mixed soak is inherently T4/pending-owner: it needs the real
provisioned accounts, real inference cost, and a real elapsed day, so it is NEVER run
from `live-check.sh` (the `soak-24h` entry SKIPs pending-owner and points here;
do not claim a real 24 h soak executed in CI). To run it on the owner's machine:

```sh
# 1. Boot the broker (Aqua LaunchAgent or the sidecar) with all provisioned accounts
#    logged in (login-bootstrap.md), two OpenCode sessions, and LM Studio up.
# 2. Enable the supervision slice with the REAL macOS phys_footprint sampler +
#    createSpawnPressureProbe (the guarded-real telemetry ports — see
#    core/src/supervision/index.ts and the composeBroker `supervision` block).
# 3. Drive a realistic mixed workload for 24 h. Watch the resource-health
#    instrument in the cockpit (or tail the events channel) and confirm:
#      - total resident memory stays within the ~17 GB pessimistic envelope;
#      - the resident session set does not grow unsupervised (recycles/hibernation
#        fire as footprints/pressure rise);
#      - the account sessions are never hibernated/shed, and an account
#        spawn is still honored while shedding under red.
# 4. If the envelope is busted: enforce the sacrifice order, shrink the local
#    model tier, re-run; if still busted, cut non-Claude concurrency defaults —
#    account sessions are never the victim (plan §10 risk row; blueprint §11).
```

---

## 5. What NOT to do

- **Do not hand-edit or delete `resume_ledger` rows** to "clear" a stuck
  session — the row-before-spawn invariant and the state machine are what make
  recovery safe. A stuck row is a signal to investigate (§1/§2), not to delete.
- **Do not `kill -9` a session child to "fix" an orphan** — that skips the
  pid-nonce verification and the process-group reap, the exact guards that
  prevent transcript corruption and orphan grandchildren.
- **Do not re-login an account** because a resumed session reported auth
  trouble — that is almost always the Aqua-domain issue ([launchd.md](launchd.md)),
  not a lost credential. One interactive login per account, ever
  ([login-bootstrap.md](login-bootstrap.md)).
- **Do not clear the memoization journal** to force a clean re-run unless you
  intend to pay for every completed step again — deleting `step_attempt` rows
  discards the exactly-once resume guarantee.
