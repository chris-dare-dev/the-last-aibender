# Spike D — PTY flow-control soak (vi) + broker-SIGKILL orphan/resume fidelity (vii)

> M0 risk spike per plan §8.2 / blueprint §13.5, items (vi) and (vii).
> Harness: `spikes/pty-supervision/` (quarantined). Executed 2026-07-04 on the
> dev Mac (Apple Silicon, macOS 26.x, Node v25.8.0, pnpm 11.9, node-pty 1.1.0
> darwin-arm64 prebuild). All substrates SYNTHETIC — no real `claude` TUI, no
> real accounts, zero subscription quota consumed.

## Question

1. **(vi)** Can one broker process supervise **6 concurrent high-throughput
   PTYs (~5 MB/s each)** with **ack-watermark flow control** such that memory
   stays bounded and **zero bytes are lost**, even with one deliberately slow
   consumer — the mechanism BE-3's gateway commits to (blueprint §2: "ack-based
   watermark flow control for PTY bytes… bounded buffers, slow-consumer
   backpressure — never unbounded")?
2. **(vii)** Does the **resume-ledger discipline** (blueprint §4.1:
   row-before-spawn, orphan detection, resume from last coherent journal entry)
   survive a **SIGKILL of the broker itself** with full fidelity — orphans
   detected and reaped, no completed step re-executed, no step lost?

## Method

Headless proxies, stated plainly:

- **Synthetic flooder ≈ real claude TUI.** `flood.ts` emits ANSI-decorated,
  sequence-numbered records (`<<S{id}:{seq}>>`, ~127 B/record) at a paced
  ~5 MB/s to its PTY slave. This is a deliberate over-stress — the real TUI
  emits far less sustained output — but it cannot reproduce the real TUI's
  interactive behaviors (cursor-position queries, bracketed paste, input echo).
  Real-TUI behavior is explicitly deferred to T3.
- **Flow control**: node-pty `onData` → per-session `BoundedAckBuffer`
  (cap 4 MiB, highWater 2 MiB, lowWater 512 KiB). Occupancy ≥ highWater →
  `pty.pause()` (kernel PTY buffer fills → the child's synchronous TTY write
  blocks — backpressure reaches the producer). Consumer acks a byte watermark;
  occupancy ≤ lowWater → `pty.resume()`. Bytes are never dropped; a cap breach
  throws. 5 fast consumers + 1 deliberately slow one (512 KiB/s drain).
  Zero-loss proof = per-producer sequence continuity (no gaps, no
  duplicates/reorders), with markers parsed across arbitrary chunk splits.
- **Stub worker ≈ SDK child; stub broker ≈ aibender-core kernel.** The worker
  performs numbered steps, fsyncing one JSONL journal record per completed step
  (running-checksum chain), and deliberately survives parent death. The broker
  implements: fsync'd ledger row **before** fork/exec; on restart, pid-liveness
  + **argv-nonce identity check** (pid-reuse guard) → classify
  `orphan-alive | dead-resume | crash-window-respawn`; kill-then-resume policy
  (process-group SIGKILL); resume from the journal's **last coherent step**
  (torn tails skipped). Real `SIGKILL` of real processes throughout — only the
  workload is synthetic.
- **Tests**: 42 vitest tests (positive/negative/edge per plan §9.2) including
  a short 8 s 6-PTY soak and three real-SIGKILL integration scenarios
  (live orphan / dead orphan / crash-window). Measurement run: 60 s soak via
  `pnpm soak`.

**Headless limitations:** no GUI, no WKWebView/xterm.js consumer (frontend-side
flow control is FE-2/FE-3 territory), no real `claude` binary, no real SDK
`query()` children, no real transcript JSONL — all named in "What remains".

## Result

**(vi) 60 s soak — 6 PTYs @ 5 MB/s target, slow consumer on session 0** (full
JSON archived by the run; summary):

| Session | Received | Producer rate | Markers | Gaps | Dup/reorder | Peak occupancy | Pauses/Resumes |
|---|---|---|---|---|---|---|---|
| 0 (SLOW, 0.5 MB/s drain) | 29.27 MB | **0.49 MB/s** | 246,434 | **0** | **0** | **2.00 MB** (= highWater) | 17/17 |
| 1 | 285.48 MB | 4.75 MB/s | 2,384,581 | 0 | 0 | 0.20 MB | 0/0 |
| 2 | 285.38 MB | 4.74 MB/s | 2,383,741 | 0 | 0 | 0.20 MB | 0/0 |
| 3 | 285.08 MB | 4.74 MB/s | 2,381,221 | 0 | 0 | 0.20 MB | 0/0 |
| 4 | 285.28 MB | 4.74 MB/s | 2,382,901 | 0 | 0 | 0.20 MB | 0/0 |
| 5 | 285.58 MB | 4.75 MB/s | 2,385,421 | 0 | 0 | 0.20 MB | 0/0 |

- **Total: 1,456 MB in 60.16 s (24.2 MB/s aggregate), ~12.16 M markers, zero
  gaps, zero duplicates** → zero byte loss end-to-end.
- **Memory bounded**: supervisor peak RSS **196.8 MB**, peak heap **57.4 MB**;
  no session's unacked buffer ever exceeded highWater + one chunk (slow session
  pinned at exactly 2.00 MB; cap 4 MB never approached). Worst-case retained
  design bound: sessions × cap = 24 MiB.
- **Backpressure demonstrably reaches the producer**: the slow session's
  flooder was throttled from its 5 MB/s target to **0.49 MB/s ≈ the consumer's
  0.5 MB/s drain rate** via pause → kernel-PTY-buffer-full → blocked TTY write.
  17 pause/resume cycles ≈ the predicted (highWater−lowWater)/drain-rate ≈ 3 s
  cycle. Fast sessions hit 4.74–4.75 MB/s of the 5.0 target (flooder timer
  granularity, not flow control — their buffers never paused).
- Children aggregate RSS peaked at 481 MB — an artifact of 6 node+tsx flooder
  processes (~80 MB each), not representative of real TUI children.

**(vii) SIGKILL fidelity — all three scenarios pass (real processes, real
SIGKILL):**

- **Live orphan**: broker SIGKILLed mid-run → worker (detached, own process
  group) provably keeps journaling with no supervisor (step counter advanced
  during the dead window) → restarted broker classifies `orphan-alive` via pid
  + argv-nonce, SIGKILLs the **process group**, resumes from the journal's last
  coherent step → **steps 1..60 exactly once**, checksum chain intact, ledger
  reads `spawning → running → orphan-detected → orphan-killed → spawning →
  resumed → exited` in order. 6.9 s.
- **Dead orphan**: broker AND worker SIGKILLed (worker possibly mid-write) →
  restart classifies `dead-resume`, resumes from last coherent step →
  exactly-once over steps 1..30; no orphan-kill rows on this path. 3.1 s.
- **Crash window**: broker exits between the fsync'd ledger row and fork
  (`--crash-after-ledger`, the deterministic stand-in for a SIGKILL landing in
  that window) → ledger holds `spawning` with no pid, journal empty → restart
  classifies `crash-window-respawn` and completes the **same sessionId** from
  step 0 → exactly-once over steps 1..10. 0.8 s. This is the row-before-spawn
  discipline's payoff: the crash window produces a *recoverable* record, never
  an untracked child.

**Incidental findings that must feed the prod packages:**

1. **node-pty 1.1.0 + pnpm loses `spawn-helper`'s exec bit** (darwin prebuild
   installs `-rw-r--r--`) → every spawn fails with the opaque
   `Error: posix_spawnp failed.`. The spike carries a postinstall fix
   (`scripts/fix-spawn-helper.mjs`); **BE-2 needs the same guard** (postinstall
   or doctor check) or attended sessions die on fresh installs.
2. **Launcher-shim pids poison the ledger.** Spawning TS children through the
   `.bin/tsx` wrapper recorded the *wrapper's* pid; SIGKILLing it leaked the
   real worker as a still-journaling untracked orphan (observed live before the
   fix). Prod rule: the resume ledger records the pid of the **actual session
   process**, and orphan reaping targets the **process group** (`kill(-pid)`)
   with single-pid fallback — matching BE-8's "child-process-group reaping".
3. **Torn-tail + resume corrupts without a line-boundary repair.** A SIGKILL
   mid-append leaves a partial JSONL line; a resumed writer appending directly
   would concatenate its first record onto the fragment and corrupt both. The
   journal writer must `ensureLineBoundary()` before a new segment (spike does;
   the transcript-tail validator / ledger writers in BE-1 need the same).
4. **Coherence must be checksum-chained, not just parseable.** The resume point
   is the last step whose running checksum matches — a parseable-but-wrong
   record breaks the chain there rather than being trusted (tested).
5. node-pty 1.1.0's darwin-arm64 prebuild loads fine on Node v25.8 (ABI 141);
   `pause()`/`resume()` behave as documented. Prod pins Node 22 LTS — re-verify
   at T3 on the pinned runtime.

## Confidence

**Medium-high overall.**

- **High** that the ack-watermark mechanism (bounded buffers, pause/resume,
  producer backpressure, zero loss) works at ≥2× any realistic claude-TUI
  output volume, and that the resume-ledger discipline holds under real
  SIGKILL — these were measured, not argued.
- **Medium** on extrapolation to the real TUI and real SDK children: the real
  `claude` TUI is interactive (terminal queries, input echo, resize redraws),
  and a paused PTY delays its *reads* of our keystroke responses too —
  prolonged pause during attended use may degrade UX in ways a flooder cannot
  reveal. Real SDK-session resume validates a transcript, not a synthetic
  checksum chain.

## Verdict

**GO — both mechanisms are confirmed as designed; no fallback needs to be
exercised.**

- **(vi)** Ack-watermark flow control with bounded per-session buffers is the
  right BE-3 design: it held 6 × 5 MB/s with one slow consumer, bounded memory
  (peak occupancy = highWater, cap never hit), zero byte loss, and backpressure
  that throttles the producer to the consumer's rate. The M2 DoD criterion
  ("6-PTY soak passes with flow control engaged — bounded memory, no dropped
  bytes") is achievable with margin. *Fallback consequence had this failed*:
  lossy display path with drop accounting + full-repaint resync (serialize
  addon) while teeing lossless bytes to disk — **not needed**; do not build it.
- **(vii)** Row-before-spawn + nonce-verified orphan detection +
  kill-then-resume from the last coherent journal entry gives exactly-once
  resume fidelity through broker SIGKILL, including the ledger-row/spawn crash
  window. This validates the resume-ledger discipline BE-1 encodes and the M1
  DoD's "SIGKILL orphan probe (vii) re-run against the real kernel passes"
  gate. *Fallback consequence had this failed*: quarantine-orphans-and-restart
  (fresh session, lineage break recorded) — **not needed**.
- Carry findings 1–4 above into BE-1/BE-2/BE-8 as requirements (spawn-helper
  exec-bit guard; real-pid ledger rows + group reaping; line-boundary repair;
  checksum-chained coherence).

## What remains for live-host (T3) confirmation

1. **Real claude TUI under node-pty** (M2 gate): the pinned SDK-bundled binary
   flooding through resize/redraw/interactive prompts; pause/resume behavior
   while the TUI is awaiting input; typing-echo p95 < 100 ms with flow control
   engaged; detach/reattach with the serialize addon.
2. **Real SDK children** (M1 gate): re-run the SIGKILL probe against the real
   kernel — SDK `query()` child as the orphan, resume via the real resume
   ledger + transcript-tail validation of actual JSONL (mid-tool-call kill
   repair/fork per blueprint §4.1), not a synthetic checksum chain.
3. **End-to-end consumer**: the WS gateway + xterm.js island as the real slow
   consumer (render stalls, reconnect-with-replay-watermark) instead of an
   in-process stub.
4. **Pinned-runtime re-verify**: node-pty build/behavior on the Node 22 LTS the
   broker ships with (spike ran on Node 25.8), plus the spawn-helper exec-bit
   check in the packaged app.
5. **24 h mixed soak** (M6): memory boundedness over hours with recycles, not
   60 s bursts.
