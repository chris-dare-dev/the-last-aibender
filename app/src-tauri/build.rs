use std::path::Path;
use std::process::Command;

fn main() {
    // `generate_context!` validates that frontendDist (../dist) exists at
    // compile time; dev and --smoke-test builds may legitimately precede a
    // vite build, so ensure the directory (content is irrelevant here).
    let _ = std::fs::create_dir_all("../dist");

    // tauri-build ALSO validates that every `bundle.externalBin` file exists at
    // compile time (SI-6/M6 flipped the sidecar ON). The real sidecar is built
    // only at `tauri build` (bundle) time by scripts/build-sidecar.sh; for a
    // plain `cargo build` / `--smoke-test` we drop a tiny valid stub so the
    // check passes without the heavyweight bundle. The stub NEVER ships — the
    // bundle step overwrites it. See scripts/ensure-sidecar-placeholder.sh.
    let placeholder = Path::new("scripts/ensure-sidecar-placeholder.sh");
    if placeholder.exists() {
        println!("cargo:rerun-if-changed=scripts/ensure-sidecar-placeholder.sh");
        println!("cargo:rerun-if-changed=tauri.conf.json");
        match Command::new("bash").arg(placeholder).status() {
            Ok(status) if status.success() => {}
            Ok(status) => println!(
                "cargo:warning=ensure-sidecar-placeholder.sh exited {status}; \
                 tauri-build will report the missing externalBin"
            ),
            Err(e) => println!(
                "cargo:warning=could not run ensure-sidecar-placeholder.sh: {e}; \
                 tauri-build will report the missing externalBin"
            ),
        }
    }

    tauri_build::build()
}
