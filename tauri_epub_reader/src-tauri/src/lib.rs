use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::time::SystemTime;
use tauri::Manager;

#[tauri::command]
fn get_initial_file() -> Option<String> {
    first_epub_arg(std::env::args())
}

// First existing .epub path in an argv iterator (used for cold start and
// single-instance forwards alike).
fn first_epub_arg(args: impl IntoIterator<Item = String>) -> Option<String> {
    for arg in args {
        if arg.to_lowercase().ends_with(".epub") && Path::new(&arg).exists() {
            return Some(arg);
        }
    }
    None
}

/* In-memory byte cache for recently opened books: a re-open (recent shelf,
   drag-drop of the same file, resume) skips both the disk read and, more
   importantly, hands the WebView raw bytes through ipc::Response instead of
   serializing millions of numbers through the JSON IPC bridge. */
struct CachedBook {
    len: u64,
    mtime: Option<SystemTime>,
    bytes: Vec<u8>,
}

#[derive(Default)]
struct BookCache {
    entries: Mutex<HashMap<String, CachedBook>>,
    order: Mutex<Vec<String>>, // LRU order, least recently used first
}

const BOOK_CACHE_MAX_ENTRIES: usize = 4;
const BOOK_CACHE_MAX_BYTES: usize = 160 * 1024 * 1024;

impl BookCache {
    fn get(&self, path: &str, meta: &fs::Metadata) -> Option<Vec<u8>> {
        let entries = self.entries.lock().ok()?;
        let hit = entries.get(path)?;
        if hit.len != meta.len() || hit.mtime != meta.modified().ok() {
            return None; // file changed on disk — caller re-reads
        }
        if let Ok(mut order) = self.order.lock() {
            if let Some(pos) = order.iter().position(|p| p == path) {
                let p = order.remove(pos);
                order.push(p);
            }
        }
        Some(hit.bytes.clone())
    }

    fn put(&self, path: String, meta: &fs::Metadata, bytes: Vec<u8>) {
        let entry = CachedBook {
            len: meta.len(),
            mtime: meta.modified().ok(),
            bytes,
        };
        let mut order = match self.order.lock() {
            Ok(o) => o,
            Err(_) => return,
        };
        let mut entries = match self.entries.lock() {
            Ok(e) => e,
            Err(_) => return,
        };
        entries.insert(path.clone(), entry);
        if !order.contains(&path) {
            order.push(path.clone());
        }
        // Evict least-recently-used entries until within entry and byte caps.
        loop {
            let total: usize = entries.values().map(|e| e.bytes.len()).sum();
            if (order.len() <= BOOK_CACHE_MAX_ENTRIES && total <= BOOK_CACHE_MAX_BYTES)
                || order.len() <= 1
            {
                break;
            }
            if let Some(evict) = order.first().cloned() {
                if evict == path {
                    break; // never evict the entry we just added
                }
                order.remove(0);
                entries.remove(&evict);
            } else {
                break;
            }
        }
    }
}

#[tauri::command]
fn read_file_bytes(
    path: String,
    state: tauri::State<BookCache>,
) -> Result<tauri::ipc::Response, String> {
    let meta = fs::metadata(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    if let Some(hit) = state.get(&path, &meta) {
        return Ok(tauri::ipc::Response::new(hit));
    }
    let bytes = fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    state.put(path, &meta, bytes.clone());
    Ok(tauri::ipc::Response::new(bytes))
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
    // Ask WebView2 to rasterize on the GPU and keep textures zero-copy.
    // Must be set before the WebView2 environment is created (first window).
    // An existing user-provided value wins; we only append missing flags.
    #[cfg(target_os = "windows")]
    {
        let gpu_flags = "--enable-gpu-rasterization --enable-zero-copy --ignore-gpu-blocklist";
        let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        if !existing.contains("enable-gpu-rasterization") {
            let merged = if existing.trim().is_empty() {
                gpu_flags.to_string()
            } else {
                format!("{} {}", existing, gpu_flags)
            };
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", merged);
        }
    }

    tauri::Builder::default()
        .manage(BookCache::default())
        .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
        // Only one instance runs: a second Open-With launch forwards its file
        // path to the running window instead of opening a duplicate app.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(path) = first_epub_arg(args) {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_focus();
                    let _ = win.unminimize();
                    // Hand the path to the frontend reader directly.
                    let js = format!("window.__folioOpenPath && window.__folioOpenPath({});",
                        serde_json::to_string(&path).unwrap_or_else(|_| "\"\"".into()));
                    let _ = win.eval(&js);
                }
            }
        }))
        .invoke_handler(tauri::generate_handler![
            get_initial_file,
            read_file_bytes,
            pick_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
