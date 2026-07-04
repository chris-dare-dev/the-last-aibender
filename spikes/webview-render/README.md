# SPIKE-A harness — xterm 6 WebGL in WKWebView proxy + `navigator.gpu` probe

QUARANTINED M0 spike harness (plan §8.2 spikes **i** + **iv**, blueprint §13.5).
Never imported by prod code; conclusions live in the verdict doc:

**→ `docs/spikes/spike-a-webview-render.md`** (normative for FE-3's renderer selection)

## What it does

- Serves `page/index.html` (boots `@xterm/xterm` 6.0.0 + `@xterm/addon-webgl` 0.19.0)
  from a loopback static server.
- Drives it with Playwright **WebKit 26.5** as the WKWebView proxy:
  - run 1: WebGL-preferred boot → 100k-line bulk write → paced streaming →
    simulated `WEBGL_lose_context` loss → DOM fallback → post-loss marker write
  - run 2: forced DOM renderer, same workloads (fallback throughput floor)
  - probes: `navigator.gpu` / `requestAdapter()`, raw WebGL2 vendor strings
- Prints a PASS/FAIL assessment and writes `results/run-*.json` + `results/latest.json`.

All terminal content is synthesized (lorem + ANSI SGR noise) — no real
transcripts, no identifiers [X2].

## Run it

```sh
pnpm install            # standalone workspace — not a monorepo member
pnpm spike:webkit-install   # one-time Playwright WebKit download (~77 MB)
pnpm spike              # headless (canonical)
pnpm spike -- --headed  # opens a real window; secondary data point
pnpm typecheck
```

`results/latest.json` is always the most recent run; timestamped files are the
audit trail (the committed set includes both headless and one `--headed` run).
