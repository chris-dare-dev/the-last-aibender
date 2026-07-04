# SPIKE-D — pty-supervision (plan spikes vi + vii)

Quarantined M0 risk-spike harness (see `spikes/README.md` for the quarantine
rules). **Verdict doc: [`docs/spikes/spike-d-pty-supervision.md`](../../docs/spikes/spike-d-pty-supervision.md)** —
copy conclusions out of this spike, never the code.

Two questions, synthetic substrates only (never the real `claude` TUI, never
real accounts):

- **(vi) 6-PTY flow-control soak** — node-pty spawns 6 synthetic flooder TUIs
  (`src/flood.ts`, sequence-numbered ANSI output at ~5 MB/s each); the harness
  (`src/ptySoak.ts`) applies ack-watermark flow control (`src/ackBuffer.ts`)
  with one deliberately slow consumer, and proves bounded memory + zero byte
  loss (`src/seqValidator.ts`).
- **(vii) broker-SIGKILL orphan/resume fidelity** — a stub broker
  (`src/broker.ts`, resume-ledger discipline in `src/ledger.ts`) supervises a
  journaling stub worker (`src/worker.ts`, journal in `src/journal.ts`); tests
  SIGKILL the broker mid-run and prove orphan detection, kill-then-resume, and
  exactly-once step history across restarts.

## Run it

```sh
pnpm install         # standalone workspace; node-pty build approved in pnpm-workspace.yaml
pnpm test            # 42 tests incl. the short (8 s) soak + real-SIGKILL integration
pnpm soak            # full 60 s, 6-PTY measurement run (JSON on stdout)
pnpm typecheck
```

Gotcha this spike found (handled by `scripts/fix-spawn-helper.mjs`, wired as
`postinstall`): pnpm installs node-pty 1.1.0's darwin prebuild with the
`spawn-helper` binary missing its exec bit → every spawn fails with
`Error: posix_spawnp failed.`
