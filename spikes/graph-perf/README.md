# spike-b: graph perf (plan spikes ii + iii)

QUARANTINED M0 spike harness (see `spikes/README.md`). Never imported by prod
code — copy conclusions, not code paths. Verdict:
[`docs/spikes/spike-b-graph-perf.md`](../../docs/spikes/spike-b-graph-perf.md).

Two benchmarks:

- **(iii) worker layout round-trip** — `src/bench-layout.ts`: d3-force
  simulation in a Node `worker_threads` worker (proxy for the browser module
  worker), transferable `Float32Array` position epochs, measured at
  1k/3k/5k nodes (edges = 1.6x).
- **(ii) Pixi v8 node-graph soak** — `src/bench-pixi.ts` + `browser/pixi-soak.ts`:
  5k sprites + 8k re-stroked line edges, `antialias: false`, driven headless via
  Playwright Chromium (SwiftShader + ANGLE-Metal) and WebKit.

## Run

```sh
cd spikes/graph-perf
pnpm install                       # standalone root (own pnpm-workspace.yaml)
pnpm exec playwright install chromium webkit
pnpm bench:layout                  # writes results/layout-run-<ts>.json + layout-latest.json
pnpm bench:pixi                    # writes results/pixi-run-<ts>.json + pixi-latest.json
pnpm test                          # harness invariants (24 tests)
```

Captured runs live in `results/*.json` (synthetic data only, [X2] clean).
Captures are **append-only**: each run writes a timestamped `*-run-<ts>.json`
plus a `*-latest.json` pointer (same pattern as `spikes/webview-render`), so
re-runs never clobber the capture the verdict doc cites.
