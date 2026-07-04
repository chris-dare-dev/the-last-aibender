# spikes/ — M0 risk-spike harnesses (QUARANTINED)

Throwaway harnesses for the ten M0 risk spikes (plan §8.2, blueprint §13.5).

**Quarantine rules:**

1. **Never imported by production code.** Nothing under `core/`, `app/`, or
   `packages/` may import from `spikes/` — this will be enforced by an
   architectural test once prod code lands. Copy a *conclusion* out of a spike,
   never the code path.
2. **Not a workspace member.** `pnpm-workspace.yaml` deliberately excludes
   `spikes/`; each spike that needs dependencies carries its own standalone
   `package.json` and installs locally.
3. **Committed, not shipped.** Spike code is tracked in git for auditability
   (see `.gitignore` notes) but carries no quality bar beyond [X2] hygiene —
   placeholders only, synthesized data only.
4. **Every spike ends in a verdict doc** under `docs/spikes/` naming the
   go/fallback consequence (e.g. "WebGL broken → ship DOM renderer").

The ten spikes (i–x): (i) xterm 6 WebGL in WKWebView; (ii) Pixi v8 5k-node
soak; (iii) worker layout round-trip latency; (iv) `navigator.gpu` probe in
WKWebView; (v) react-virtual mid-stream resize; (vi) 6-PTY flow-control soak;
(vii) broker-SIGKILL orphan/resume fidelity; (viii) `ant` profile experiment;
(ix) sidecar signing dry run; (x) Bun.Terminal parity check.
