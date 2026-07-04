# SPIKE-E harness — (viii) `ant` profile experiment + (ix) sidecar signing dry run

QUARANTINED spike code (plan §8.2 M0, blueprint §13.5). Never imported by prod
code; not a pnpm workspace member; no runtime dependencies. Verdict doc:
[`docs/spikes/spike-e-signing-ant.md`](../../docs/spikes/spike-e-signing-ant.md).

## Contents

| File | Spike | What it does |
|---|---|---|
| `ant-preflight.ts` | (viii) | Read-only preflight for the owner-run 10-minute `ant`-profile experiment: checks `ant`/`claude` presence, pre-existing `~/.config/anthropic` state, poisoning env vars. Never logs in/out, never reads credential values, writes nothing. |
| `signing-dryrun.ts` | (ix) | Ad-hoc codesign dry run: builds a stub sidecar + stub `.app` in Tauri's `externalBin` layout, then measures signing order, tamper detection, sidecar-replacement seal breakage (the tauri#11992 gotcha class), hardened-runtime + JIT entitlements, and `spctl` assessment. All ad-hoc — no Apple account, no keychain writes. |

## Run

```bash
# Node >= 22 (with --experimental-strip-types) or >= 23.6 (native TS):
node signing-dryrun.ts     # 28 recorded steps; exit 0 = all invariants held
node ant-preflight.ts      # exit 0 = machine ready for the (viii) experiment
```

Build artifacts land in `out/` (gitignored), including `out/results.json` with
the full measured log of every codesign/spctl invocation.

[X2] hygiene: no real identities, tokens, or account references anywhere in
this directory; the dry run signs synthetic stub binaries only.
