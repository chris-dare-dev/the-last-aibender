//! Tauri IPC commands — native affordances ONLY (blueprint §2: Tauri IPC is
//! never a streaming path; the WS gateway carries all session traffic).

use tauri_plugin_notification::NotificationExt;

/// Read the gateway bootstrap file (docs/contracts/bootstrap-file.md §4).
/// Returns the raw JSON body; the webview validates structurally. The token
/// inside crosses this boundary solely to be presented at WS connect time —
/// it is never logged on either side [X2].
#[tauri::command]
pub fn read_bootstrap() -> Option<String> {
    crate::smoke::read_bootstrap_raw()
}

/// System notification (approval arrivals, broker faults). Body text is
/// identifier-free by construction — summaries come off the wire already
/// redacted (ws-protocol.md §10.1).
#[tauri::command]
pub fn notify_native(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}
