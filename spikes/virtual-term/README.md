# SPIKE-C — virtual-term (plan spikes v + x)

QUARANTINED spike harness (see `spikes/README.md`): never imported by prod
code; conclusions travel, code does not. Verdict doc:
`docs/spikes/spike-c-virtual-term.md`.

Two questions:

- **(v)** Does `@tanstack/react-virtual` 3.14.5's end-anchored mode
  (`anchorTo:'end'`, virtual-core 3.17.3) survive a mid-stream viewport
  resize — and is it stream-safe at all? (`src/main.tsx` + `test/run-virtual.ts`)
- **(x)** Does `Bun.Terminal` (bun ≥ 1.3.5) reach node-pty parity for
  attended TUIs — spawn under a TTY, resize propagation, write/echo,
  kill/exit? (`bun-parity/`)

## Run

```sh
pnpm install                      # standalone install (own pnpm-workspace.yaml)
node_modules/.bin/playwright install webkit chromium   # engines, if missing
pnpm test                         # build + spike (v) both browsers + spike (x)
```

Outputs land in `results/*.json` and on stdout. The driver exits non-zero on
any assertion failure.

## Layout

| Path | What |
|---|---|
| `src/main.tsx` | React 19 harness: virtualized transcript fed by a deterministic synthetic token stream; `?shim=1` enables the app-owned **follow-guard** (the FE-3 design measured out by this spike); instrumentation on `window.__spike` |
| `test/run-virtual.ts` | Playwright driver: raw pass (library as-shipped, measurement-first) + shim pass (hard asserts) in Chromium and WebKit |
| `bun-parity/tui-sim.cjs` | Synthetic TUI child (TTY report, SIGWINCH report, echo, ANSI noise) — honest proxy for the claude TUI; no real accounts touched |
| `bun-parity/parity-node-pty.ts` | node-pty 1.1.0 baseline round-trip |
| `bun-parity/parity-bun.ts` | Same round-trip under `Bun.Terminal` (spike-local bun 1.3.14), resize-tolerant |
| `bun-parity/run-parity.ts` | Orchestrator + parity matrix; node-pty failure is fatal, Bun.Terminal result is informational |
| `results/` | Committed JSON evidence from the last run |

## Notes

- Playwright WebKit ≈ WKWebView **proxy**, not the Tauri embed — see the
  verdict doc's T3 list.
- node-pty's darwin-arm64 prebuild ships `spawn-helper` without the exec bit
  under pnpm (`posix_spawnp failed`); `run-parity.ts` re-applies `chmod +x`
  and the verdict doc records it as a BE-2 install-step requirement.
- The `bun` npm package (1.3.14) is installed spike-locally only to probe
  `Bun.Terminal`; the system bun (1.2.23) predates the API and is probed
  separately with a node_modules-stripped PATH.
