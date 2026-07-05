# app/src-tauri/binaries/ — aibender-core sidecar staging

Tauri's `externalBin` sidecar dir (v0 packaging, SI-6/M6). `tauri.conf.json`
declares `bundle.externalBin: ["binaries/aibender-core"]`; `tauri build` looks
here for `aibender-core-<target-triple>` (Tauri's rename convention, measured
in [spike-e](../../../docs/spikes/spike-e-signing-ant.md)) and copies it into
`Contents/MacOS/`, signing it inside-out with the app.

## Who fills this dir

`scripts/build-sidecar.sh` — invoked automatically by the `beforeBundleCommand`
during `tauri build`. It bundles `core/src/main/index.ts` (esbuild), produces a
Node **SEA launcher** named `aibender-core-<triple>`, and co-locates the
node-pty prebuilt addon under `native/`. Nothing here is committed (see
`.gitignore`): the artifacts are large, target-specific, and rebuilt every
bundle.

## What DOES and does NOT build it

| Command | Touches this dir? |
|---|---|
| `cargo build` (debug) / `--smoke-test` | **No** — short-circuits before Tauri bundle machinery (the M2/M6 debug-build gate). |
| `pnpm -F aibender-app tauri build` (release bundle) | **Yes** — runs `build-sidecar.sh` via `beforeBundleCommand`. |

## v0 signing posture

DRY-RUN: `macOS.signingIdentity` is `null`, so the artifact is **ad-hoc** signed
(local personal use — no quarantine bit, so Gatekeeper never assesses it). The
real Developer-ID sign + `xcrun notarytool` path is owner-gated T3, documented
step-by-step in [docs/runbooks/release-packaging.md](../../../docs/runbooks/release-packaging.md).
