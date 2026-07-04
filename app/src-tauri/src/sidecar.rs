//! Sidecar wiring for `aibender-core` — PREPARED, deliberately NOT flipped.
//!
//! v0 decision (plan §0, blueprint §2): the broker runs SEPARATELY (manual
//! `node core` in dev; the SI-3 Aqua LaunchAgent is the v1 promotion path so
//! sessions outlive the app). The shell therefore spawns NOTHING by default;
//! discovery happens exclusively through the bootstrap file.
//!
//! Flip procedure (v1, gated on FE-ORCH + BE-ORCH sign-off):
//!  1. Bundle the packaged core binary as a Tauri sidecar: add it under
//!     `bundle.externalBin` in tauri.conf.json (the binary must exist at
//!     build time — that is WHY this stays unconfigured in v0), and grant
//!     `shell:allow-execute` for it in capabilities/default.json via
//!     tauri-plugin-shell.
//!  2. Enable the `sidecar` cargo feature and implement `prepare` to spawn
//!     the sidecar on setup + kill the PROCESS GROUP on exit (SPIKE-D
//!     finding 2: children double-fork; group-targeted termination only).
//!  3. Keep the bootstrap file as the ONLY discovery channel — the sidecar
//!     writes it exactly like the LaunchAgent-run broker does; the webview
//!     client stays byte-identical in both run modes.
//!  4. Signing: the sidecar binary must be signed with the app (spike ix,
//!     docs/spikes/ — the sidecar-signing dry run is SI-6's artifact gate).

/// v0: report the run mode; spawn nothing.
pub fn prepare(_app: &tauri::App) -> &'static str {
    #[cfg(feature = "sidecar")]
    {
        // Compile-time guard: the feature exists so the flip is a one-line
        // build change, but the v1 spawn path lands only with the flip PR.
        compile_error!("sidecar feature is prepared but not implemented — v0 runs core separately");
    }
    #[cfg(not(feature = "sidecar"))]
    {
        "external-core-v0"
    }
}
