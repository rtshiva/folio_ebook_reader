use std::fs;
use std::path::Path;

#[tauri::command]
fn get_initial_file() -> Option<String> {
    for arg in std::env::args().skip(1) {
        if arg.to_lowercase().ends_with(".epub") && Path::new(&arg).exists() {
            return Some(arg);
        }
    }
    None
}

#[tauri::command]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
fn pick_file() -> Option<String> {
    let file = rfd::FileDialog::new()
        .add_filter("EPUB Books", &["epub"])
        .pick_file();
    file.map(|p| p.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
        .invoke_handler(tauri::generate_handler![get_initial_file, read_file_bytes, pick_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
