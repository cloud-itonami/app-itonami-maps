// Maps keeps all state in the WebView (IndexedDB). The host exposes one
// read-only command and no filesystem, network, shell or installer permission.
// The single external download runs in the WebView through the shared Kotoba
// consent broker, not through the host.
#[tauri::command]
fn awai_host_info() -> serde_json::Value {
    serde_json::json!({"schema":"awai.shell.host.v1","app":"network.itonami.maps"})
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .runtime(tauri_runtime_wry::Wry::default())
        .invoke_handler(tauri::generate_handler![awai_host_info])
        .run(tauri::generate_context!())
        .expect("Maps initialization failed");
}
