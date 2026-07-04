// the-last-aibender cockpit shell (FE-2, Tauri v2).
// Native affordances only: tray, notifications, window, bootstrap read.
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod commands;
mod sidecar;
mod smoke;
mod tray;

fn main() {
    // --smoke-test: the headless boot proof for milestone gates. MUST run
    // before any Tauri machinery — no window, no event loop, no WebView —
    // and exits 0 (bootstrap absent/malformed = "no broker advertised").
    if std::env::args().any(|arg| arg == "--smoke-test") {
        std::process::exit(smoke::run_smoke_test());
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            commands::read_bootstrap,
            commands::notify_native
        ])
        .setup(|app| {
            tray::install(app)?;
            let mode = sidecar::prepare(app);
            // Run-mode is surfaced in the UI (settings); stdout is enough here.
            println!("aibender-app: broker run mode = {mode}");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the aibender cockpit shell");
}
