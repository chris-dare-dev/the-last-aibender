# app/src-tauri — cockpit shell (FE-2, Tauri v2)

The Tauri v2 shell around the SPA. **Native affordances only** — tray,
notifications, window config, bootstrap-file read. Streaming NEVER rides
Tauri IPC (blueprint §2 topology rule); all session traffic is the single
multiplexed WebSocket to `aibender-core`.

## Run modes

| Mode | Command | Notes |
|---|---|---|
| Dev shell | `pnpm -F aibender-app tauri dev` | boots vite on :5173 + the shell |
| SPA only (Chrome-as-frontend) | `pnpm -F aibender-app dev` | free second frontend; bootstrap via the `__AIBENDER_BOOTSTRAP__` dev shim |
| **Smoke test** | `pnpm -F aibender-app smoke-test` (= `cargo run -- --smoke-test`) | headless boot proof for gates: no window, no event loop; reads `$AIBENDER_HOME/bootstrap/gateway.json` if present; **always exits 0** (absent/unreadable/malformed = "no broker advertised" per the bootstrap contract §4) |
| Rust unit tests | `cargo test --manifest-path app/src-tauri/Cargo.toml` | bootstrap validation matrix |

## Broker: v0 runs core SEPARATELY

`aibender-core` is NOT spawned by the shell in v0 (plan §0: sidecar wiring
prepared, LaunchAgent promotion is the v1 path so sessions outlive the app).
Discovery happens exclusively through the bootstrap file
(`docs/contracts/bootstrap-file.md`): start core however you like (dev:
`node core`; v1: SI-3's Aqua LaunchAgent), and the shell finds it.

The sidecar flip is prepared in `src/sidecar.rs` behind the `sidecar` cargo
feature — the module documents the exact four-step v1 flip (externalBin +
shell capability + process-group reaping + sidecar signing per spike ix).
The feature carries a `compile_error!` so it cannot be half-flipped.

## Hygiene: `target/` vs the milestone-gate dir scan

`cargo` output under `app/src-tauri/target/` (gitignored) embeds dependency
metadata (`.rmeta`) containing crate-author emails, which trips the
full-tree `gitleaks dir . --config .gitleaks.toml` scan HANDOFF §12 expects
to be clean — the staged pre-commit scan is unaffected (the directory is
never staged). **Pre-gate step on any machine that built the shell:**

```sh
cargo clean --manifest-path app/src-tauri/Cargo.toml
```

A durable value-free path allowlist for `app/src-tauri/target/` in Tier-1
is with SI-ORCH (.gitleaks.toml is SI-owned); until it lands, `cargo clean`
before the gate is the documented mitigation.

## Icons

- Tray: a runtime-generated 16×16 **template image** (macOS renders it
  monochrome) — no asset file at all.
- `icons/icon.png` (122 bytes): the one committed icon, required by Tauri's
  codegen as the default window icon even with bundling off. It is
  script-generated (32×32: `--ig-surface-base` charcoal field, `--ig-accent`
  amber hollow square — token-mirrored, DESIGN.md §2), not a designed asset.
  Real bundle iconography is an SI-6 packaging concern (M6).

## Security surface

- CSP restricts `connect-src` to `'self'` + loopback (`ws://127.0.0.1:*`,
  `http://127.0.0.1:*`) — the frontend can only ever talk to the local
  gateway.
- Capabilities grant `core:default` + `notification:default` to the `main`
  window; there is no fs/shell plugin surface. The bootstrap file is read by
  the app-defined `read_bootstrap` command only. Its token is used at WS
  connect time and never logged on either side of the IPC boundary [X2].
- Window `backgroundColor` mirrors `--ig-surface-base` `#111110` (DESIGN.md
  §2.1) so the pre-paint frame is already charcoal — the value is mirrored
  from the locked token table, never invented here.
