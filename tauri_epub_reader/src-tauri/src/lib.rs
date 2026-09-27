use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
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
pub struct BookCache {
    entries: Mutex<HashMap<String, CachedBook>>,
    order: Mutex<Vec<String>>, // LRU order, least recently used first
}

const BOOK_CACHE_MAX_ENTRIES: usize = 4;
const BOOK_CACHE_MAX_BYTES: usize = 160 * 1024 * 1024;

impl BookCache {
    pub fn get(&self, path: &str, meta: &fs::Metadata) -> Option<Vec<u8>> {
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

    pub fn put(&self, path: String, meta: &fs::Metadata, bytes: Vec<u8>) {
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

// ---------------- P-A: Disk cache for unzipped books ----------------

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ManifestFile {
    pub zip_path: String,
    pub size: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct BookManifest {
    pub path: String,
    pub len: u64,
    pub mtime_ms: u128,
    pub files: Vec<ManifestFile>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BookHandle {
    pub hash: String,
    pub cache_dir: String,
    pub manifest: BookManifest,
}

pub fn sanitize_entry(name: &str) -> Option<PathBuf> {
    // Reject Windows drive letters (e.g. C:foo, C:/foo)
    if name.len() >= 2 && name.as_bytes()[1] == b':' {
        return None;
    }
    let p = Path::new(name);
    let mut clean = PathBuf::new();
    for comp in p.components() {
        match comp {
            std::path::Component::Normal(c) => clean.push(c),
            std::path::Component::CurDir => continue,
            _ => return None,
        }
    }
    if clean.as_os_str().is_empty() {
        return None;
    }
    Some(clean)
}

pub fn should_reunzip(manifest: Option<&BookManifest>, meta_len: u64, meta_mtime_ms: u128) -> bool {
    match manifest {
        Some(m) => m.len != meta_len || m.mtime_ms != meta_mtime_ms,
        None => true,
    }
}

pub fn compute_book_key(path: &str, meta: &fs::Metadata) -> (String, u64, u128) {
    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    let path_hash = format!("{:x}", hasher.finalize());
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let hash = format!("{}_{}_{}", &path_hash[..16], meta.len(), mtime_ms);
    (hash, meta.len(), mtime_ms)
}

pub fn unzip_epub(
    epub_path: &Path,
    target_dir: &Path,
    orig_path: &str,
    meta: &fs::Metadata,
    mtime_ms: u128,
) -> Result<BookManifest, String> {
    let file = fs::File::open(epub_path).map_err(|e| format!("Cannot open epub file: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Cannot read zip archive: {}", e))?;
    let mut files = Vec::new();

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("Cannot read zip entry: {}", e))?;
        let raw_name = entry.name().to_string();
        if entry.is_dir() {
            continue;
        }
        let clean_path = match sanitize_entry(&raw_name) {
            Some(p) => p,
            None => {
                log::warn!("Skipping disallowed zip entry: {}", raw_name);
                continue;
            }
        };
        let out_path = target_dir.join(&clean_path);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Cannot create dir: {}", e))?;
        }
        let mut outfile = fs::File::create(&out_path).map_err(|e| format!("Cannot create file: {}", e))?;
        std::io::copy(&mut entry, &mut outfile).map_err(|e| format!("Cannot extract file: {}", e))?;
        files.push(ManifestFile {
            zip_path: clean_path.to_string_lossy().replace('\\', "/"),
            size: entry.size(),
        });
    }

    let manifest = BookManifest {
        path: orig_path.to_string(),
        len: meta.len(),
        mtime_ms,
        files,
    };

    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| format!("Cannot serialize manifest: {}", e))?;
    fs::write(target_dir.join("manifest.json"), manifest_bytes)
        .map_err(|e| format!("Cannot write manifest.json: {}", e))?;

    // Touch atime
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let _ = fs::write(target_dir.join("atime"), now.to_string());

    Ok(manifest)
}

const DISK_CACHE_MAX_BYTES: u64 = 600 * 1024 * 1024; // 600 MB
const DISK_CACHE_MAX_BOOKS: usize = 30;

pub fn evict_disk_cache(cache_root: &Path, max_bytes: u64, max_books: usize) {
    let entries = match fs::read_dir(cache_root) {
        Ok(e) => e,
        Err(_) => return,
    };

    struct DirEntryInfo {
        path: PathBuf,
        atime: u128,
        bytes: u64,
    }

    fn dir_size(path: &Path) -> u64 {
        let mut total = 0;
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    if meta.is_dir() {
                        total += dir_size(&entry.path());
                    } else {
                        total += meta.len();
                    }
                }
            }
        }
        total
    }

    let mut dirs: Vec<DirEntryInfo> = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            let atime = fs::read_to_string(p.join("atime"))
                .ok()
                .and_then(|s| s.trim().parse::<u128>().ok())
                .unwrap_or_else(|| {
                    entry.metadata()
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis())
                        .unwrap_or(0)
                });
            let bytes = dir_size(&p);
            dirs.push(DirEntryInfo { path: p, atime, bytes });
        }
    }

    // Sort by atime ascending (oldest first)
    dirs.sort_by_key(|d| d.atime);

    let mut total_bytes: u64 = dirs.iter().map(|d| d.bytes).sum();
    let mut total_books = dirs.len();

    for d in dirs {
        if total_books <= max_books && total_bytes <= max_bytes {
            break;
        }
        if total_books <= 1 {
            break;
        }
        if fs::remove_dir_all(&d.path).is_ok() {
            total_books -= 1;
            total_bytes = total_bytes.saturating_sub(d.bytes);
        }
    }
}

#[tauri::command]
fn book_open(path: String, app: tauri::AppHandle) -> Result<BookHandle, String> {
    let meta = fs::metadata(&path).map_err(|e| format!("Cannot read file metadata: {}", e))?;
    let (hash, len, mtime_ms) = compute_book_key(&path, &meta);
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Cannot get app cache dir: {}", e))?
        .join("folio-unzip");
    let target_dir = cache_root.join(&hash);

    let manifest_path = target_dir.join("manifest.json");
    let manifest = if manifest_path.exists() {
        match fs::read(&manifest_path).ok().and_then(|b| serde_json::from_slice::<BookManifest>(&b).ok()) {
            Some(m) if !should_reunzip(Some(&m), len, mtime_ms) => {
                // Cache hit! Touch atime
                let now = SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                let _ = fs::write(target_dir.join("atime"), now.to_string());
                m
            }
            _ => {
                let _ = fs::remove_dir_all(&target_dir);
                fs::create_dir_all(&target_dir).map_err(|e| format!("Cannot create cache dir: {}", e))?;
                unzip_epub(Path::new(&path), &target_dir, &path, &meta, mtime_ms)?
            }
        }
    } else {
        fs::create_dir_all(&target_dir).map_err(|e| format!("Cannot create cache dir: {}", e))?;
        unzip_epub(Path::new(&path), &target_dir, &path, &meta, mtime_ms)?
    };

    // Spawn background eviction
    let evict_root = cache_root.clone();
    std::thread::spawn(move || {
        evict_disk_cache(&evict_root, DISK_CACHE_MAX_BYTES, DISK_CACHE_MAX_BOOKS);
    });

    Ok(BookHandle {
        hash,
        cache_dir: target_dir.to_string_lossy().to_string(),
        manifest,
    })
}

fn percent_decode(s: &str) -> String {
    let mut bytes = Vec::new();
    let mut chars = s.bytes();
    while let Some(b) = chars.next() {
        if b == b'%' {
            if let (Some(h1), Some(h2)) = (chars.next(), chars.next()) {
                if let Ok(val) = u8::from_str_radix(std::str::from_utf8(&[h1, h2]).unwrap_or(""), 16) {
                    bytes.push(val);
                    continue;
                }
                bytes.push(b'%');
                bytes.push(h1);
                bytes.push(h2);
                continue;
            }
            bytes.push(b'%');
        } else {
            bytes.push(b);
        }
    }
    String::from_utf8_lossy(&bytes).to_string()
}

/// Named-entity table mirroring the frontend FOLIO_ENTITIES map: books
/// commonly carry named HTML entities (&nbsp; &mdash; ...) that strict XML
/// parsing rejects as undefined references.
fn entity_replacement(name: &str) -> Option<char> {
    Some(match name {
        "nbsp" => '\u{a0}',
        "iexcl" => '\u{a1}',
        "cent" => '\u{a2}',
        "pound" => '\u{a3}',
        "curren" => '\u{a4}',
        "yen" => '\u{a5}',
        "brvbar" => '\u{a6}',
        "sect" => '\u{a7}',
        "uml" => '\u{a8}',
        "copy" => '\u{a9}',
        "ordf" => '\u{aa}',
        "laquo" => '\u{ab}',
        "not" => '\u{ac}',
        "shy" => '\u{ad}',
        "reg" => '\u{ae}',
        "macr" => '\u{af}',
        "deg" => '\u{b0}',
        "plusmn" => '\u{b1}',
        "sup2" => '\u{b2}',
        "sup3" => '\u{b3}',
        "acute" => '\u{b4}',
        "micro" => '\u{b5}',
        "para" => '\u{b6}',
        "middot" => '\u{b7}',
        "cedil" => '\u{b8}',
        "sup1" => '\u{b9}',
        "ordm" => '\u{ba}',
        "raquo" => '\u{bb}',
        "frac14" => '\u{bc}',
        "frac12" => '\u{bd}',
        "frac34" => '\u{be}',
        "iquest" => '\u{bf}',
        "Agrave" => '\u{c0}',
        "Aacute" => '\u{c1}',
        "Acirc" => '\u{c2}',
        "Atilde" => '\u{c3}',
        "Auml" => '\u{c4}',
        "Aring" => '\u{c5}',
        "AElig" => '\u{c6}',
        "Ccedil" => '\u{c7}',
        "Egrave" => '\u{c8}',
        "Eacute" => '\u{c9}',
        "Ecirc" => '\u{ca}',
        "Euml" => '\u{cb}',
        "Igrave" => '\u{cc}',
        "Iacute" => '\u{cd}',
        "Icirc" => '\u{ce}',
        "Iuml" => '\u{cf}',
        "ETH" => '\u{d0}',
        "Ntilde" => '\u{d1}',
        "Ograve" => '\u{d2}',
        "Oacute" => '\u{d3}',
        "Ocirc" => '\u{d4}',
        "Otilde" => '\u{d5}',
        "Ouml" => '\u{d6}',
        "times" => '\u{d7}',
        "Oslash" => '\u{d8}',
        "Ugrave" => '\u{d9}',
        "Uacute" => '\u{da}',
        "Ucirc" => '\u{db}',
        "Uuml" => '\u{dc}',
        "Yacute" => '\u{dd}',
        "THORN" => '\u{de}',
        "szlig" => '\u{df}',
        "agrave" => '\u{e0}',
        "aacute" => '\u{e1}',
        "acirc" => '\u{e2}',
        "atilde" => '\u{e3}',
        "auml" => '\u{e4}',
        "aring" => '\u{e5}',
        "aelig" => '\u{e6}',
        "ccedil" => '\u{e7}',
        "egrave" => '\u{e8}',
        "eacute" => '\u{e9}',
        "ecirc" => '\u{ea}',
        "euml" => '\u{eb}',
        "igrave" => '\u{ec}',
        "iacute" => '\u{ed}',
        "icirc" => '\u{ee}',
        "iuml" => '\u{ef}',
        "eth" => '\u{f0}',
        "ntilde" => '\u{f1}',
        "ograve" => '\u{f2}',
        "oacute" => '\u{f3}',
        "ocirc" => '\u{f4}',
        "otilde" => '\u{f5}',
        "ouml" => '\u{f6}',
        "divide" => '\u{f7}',
        "oslash" => '\u{f8}',
        "ugrave" => '\u{f9}',
        "uacute" => '\u{fa}',
        "ucirc" => '\u{fb}',
        "uuml" => '\u{fc}',
        "yacute" => '\u{fd}',
        "thorn" => '\u{fe}',
        "yuml" => '\u{ff}',
        "OElig" => '\u{152}',
        "oelig" => '\u{153}',
        "Scaron" => '\u{160}',
        "scaron" => '\u{161}',
        "Yuml" => '\u{178}',
        "fnof" => '\u{192}',
        "circ" => '\u{2c6}',
        "tilde" => '\u{2dc}',
        "ensp" => '\u{2002}',
        "emsp" => '\u{2003}',
        "thinsp" => '\u{2009}',
        "zwnj" => '\u{200c}',
        "zwj" => '\u{200d}',
        "lrm" => '\u{200e}',
        "rlm" => '\u{200f}',
        "ndash" => '\u{2013}',
        "mdash" => '\u{2014}',
        "lsquo" => '\u{2018}',
        "rsquo" => '\u{2019}',
        "sbquo" => '\u{201a}',
        "ldquo" => '\u{201c}',
        "rdquo" => '\u{201d}',
        "bdquo" => '\u{201e}',
        "dagger" => '\u{2020}',
        "Dagger" => '\u{2021}',
        "bull" => '\u{2022}',
        "hellip" => '\u{2026}',
        "permil" => '\u{2030}',
        "prime" => '\u{2032}',
        "Prime" => '\u{2033}',
        "lsaquo" => '\u{2039}',
        "rsaquo" => '\u{203a}',
        "oline" => '\u{203e}',
        "frasl" => '\u{2044}',
        "euro" => '\u{20ac}',
        "larr" => '\u{2190}',
        "rarr" => '\u{2192}',
        "darr" => '\u{2191}',
        "harr" => '\u{2194}',
        "crarr" => '\u{21b5}',
        _ => return None,
    })
}

fn utf8_seq_len(b: u8) -> usize {
    if b < 0x80 { 1 } else if b >> 5 == 0b110 { 2 } else if b >> 4 == 0b1110 { 3 } else if b >> 3 == 0b11110 { 4 } else { 1 }
}

/// Repair bare ampersands and named/unknown entities so a chapter parses
/// as strict XML: known named entities become their literal characters,
/// unknown names and stray '&' are escaped, numeric references pass
/// through. CDATA sections hold literal JS/CSS and are copied untouched.
fn fix_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len() + 64);
    let bytes = text.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'<' && text[i..].starts_with("<![CDATA[") {
            match text[i..].find("]]>") {
                Some(p) => {
                    let end = i + p + 3;
                    out.push_str(&text[i..end]);
                    i = end;
                }
                None => {
                    out.push_str(&text[i..]);
                    break;
                }
            }
            continue;
        }
        if bytes[i] != b'&' {
            let len = utf8_seq_len(bytes[i]);
            out.push_str(&text[i..i + len]);
            i += len;
            continue;
        }
        let rest = &text[i + 1..];
        let mut replaced: Option<String> = None;
        let first = rest.chars().next();
        match first {
            Some('#') => {
                let hex = rest[1..].starts_with('x') || rest[1..].starts_with('X');
                let digits_start = 1 + if hex { 1 } else { 0 };
                let digits: String = rest[digits_start..]
                    .chars()
                    .take_while(|c| if hex { c.is_ascii_hexdigit() } else { c.is_ascii_digit() })
                    .collect();
                let well_formed = !digits.is_empty()
                    && rest[digits_start + digits.len()..].starts_with(';');
                if well_formed {
                    let consumed = 1 + digits_start + digits.len() + 1;
                    out.push_str(&text[i..i + consumed]);
                    i += consumed;
                } else {
                    replaced = Some("&amp;".to_string());
                }
            }
            Some(c) if c.is_ascii_alphabetic() => {
                let name: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
                if name.len() <= 32 && rest[name.len()..].starts_with(';') {
                    let consumed = 1 + name.len() + 1;
                    match entity_replacement(&name) {
                        Some(ch) => out.push(ch),
                        None => {
                            if matches!(name.as_str(), "amp" | "lt" | "gt" | "quot" | "apos") {
                                out.push_str(&text[i..i + consumed]);
                            } else {
                                out.push_str("&amp;");
                                out.push_str(&name);
                                out.push(';');
                            }
                        }
                    }
                    i += consumed;
                } else {
                    replaced = Some("&amp;".to_string());
                }
            }
            _ => replaced = Some("&amp;".to_string()),
        }
        if let Some(esc) = replaced {
            out.push_str(&esc);
            i += 1;
        }
    }
    out
}

fn mime_for_path(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    match ext.as_str() {
        // Served as XML on purpose: chapters are XML-parsed everywhere, and
        // fix_entities() below rewrites bare '&' / named entities on the way
        // out so the strict parser never sees an undefined entity.
        "xhtml" | "html" | "htm" => "application/xhtml+xml",
        "xml" => "application/xml",
        "opf" => "application/oebps-package+xml",
        "ncx" => "application/x-dtbncx+xml",
        "css" => "text/css; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => "application/octet-stream",
    }
}

pub fn merge_gpu_flags(existing: &str) -> String {
    let gpu_flags = "--enable-gpu-rasterization --enable-zero-copy --ignore-gpu-blocklist";
    let trimmed = existing.trim();
    if trimmed.is_empty() {
        return gpu_flags.to_string();
    }
    let mut result = trimmed.to_string();
    for flag in gpu_flags.split_whitespace() {
        if !result.split_whitespace().any(|part| part == flag) {
            result.push(' ');
            result.push_str(flag);
        }
    }
    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Ask WebView2 to rasterize on the GPU and keep textures zero-copy.
    // Must be set before the WebView2 environment is created (first window).
    // An existing user-provided value wins; we only append missing flags.
    #[cfg(target_os = "windows")]
    {
        let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        let merged = merge_gpu_flags(&existing);
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", merged);
    }

    tauri::Builder::default()
        .register_uri_scheme_protocol("folio-cache", |app, req| {
            let cache_root = match app.app_handle().path().app_cache_dir() {
                Ok(p) => p.join("folio-unzip"),
                Err(_) => {
                    return tauri::http::Response::builder()
                        .status(500)
                        .body(vec![])
                        .unwrap();
                }
            };

            let uri = req.uri();
            let host = uri.host().unwrap_or("");
            let path_str = uri.path();

            let (hash, rel_path) = if !host.is_empty() && host != "localhost" {
                (host.to_string(), path_str.trim_start_matches('/').to_string())
            } else {
                let trimmed = path_str.trim_start_matches('/');
                match trimmed.split_once('/') {
                    Some((h, r)) => (h.to_string(), r.to_string()),
                    None => (trimmed.to_string(), String::new()),
                }
            };

            let decoded_rel = percent_decode(&rel_path);
            let clean_rel = match sanitize_entry(&decoded_rel) {
                Some(p) => p,
                None => {
                    return tauri::http::Response::builder()
                        .status(400)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(vec![])
                        .unwrap();
                }
            };

            let file_path = cache_root.join(hash).join(clean_rel);
            if file_path.is_file() {
                match fs::read(&file_path) {
                    Ok(bytes) => {
                        let mime = mime_for_path(&file_path);
                        // Cache entries are content-addressed by book hash:
                        // the same hash always yields the same bytes, so the
                        // webview can cache resource fetches across chapters
                        // and sessions without any invalidation risk.
                        // Chapters are parsed as strict XML: repair bare
                        // '&' and named/unknown entities before serving.
                        let body: Vec<u8> = if mime == "application/xhtml+xml" { fix_entities(&String::from_utf8_lossy(&bytes)).into_bytes() } else { bytes };
                        tauri::http::Response::builder()
                            .status(200)
                            .header("Content-Type", mime)
                            .header("Cache-Control", "max-age=31536000, immutable")
                            .header("Access-Control-Allow-Origin", "*")
                            .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
                            .body(body)
                            .unwrap()
                    }
                    Err(_) => {
                        tauri::http::Response::builder()
                            .status(500)
                            .header("Access-Control-Allow-Origin", "*")
                            .body(vec![])
                            .unwrap()
                    }
                }
            } else {
                tauri::http::Response::builder()
                    .status(404)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(vec![])
                    .unwrap()
            }
        })
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
            book_open,
            pick_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_u1_book_cache_key() {
        let temp_dir = std::env::temp_dir().join(format!("folio_test_u1_{}", std::process::id()));
        let _ = fs::create_dir_all(&temp_dir);
        let test_file = temp_dir.join("test.epub");
        fs::write(&test_file, b"test content").unwrap();
        let meta = fs::metadata(&test_file).unwrap();

        let cache = BookCache::default();
        let path_str = test_file.to_string_lossy().to_string();

        cache.put(path_str.clone(), &meta, vec![1, 2, 3, 4]);
        // Same len + mtime -> cache hit
        let hit = cache.get(&path_str, &meta);
        assert_eq!(hit, Some(vec![1, 2, 3, 4]));

        // Modify file content to change len/mtime
        std::thread::sleep(std::time::Duration::from_millis(50));
        fs::write(&test_file, b"test content modified!").unwrap();
        let meta2 = fs::metadata(&test_file).unwrap();

        // Modified mtime/len -> cache miss
        let miss = cache.get(&path_str, &meta2);
        assert_eq!(miss, None);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_u2_book_cache_lru() {
        let temp_dir = std::env::temp_dir().join(format!("folio_test_u2_{}", std::process::id()));
        let _ = fs::create_dir_all(&temp_dir);

        let cache = BookCache::default();
        let mut paths = Vec::new();
        let mut metas = Vec::new();

        for i in 0..5 {
            let f = temp_dir.join(format!("book_{}.epub", i));
            fs::write(&f, format!("book content {}", i)).unwrap();
            let m = fs::metadata(&f).unwrap();
            let p = f.to_string_lossy().to_string();
            cache.put(p.clone(), &m, vec![i as u8; 1024]);
            paths.push(p);
            metas.push(m);
        }

        // Capacity is 4, so book 0 should have been evicted
        assert_eq!(cache.get(&paths[0], &metas[0]), None);
        // Books 1, 2, 3, 4 should still be cached
        for i in 1..5 {
            assert!(cache.get(&paths[i], &metas[i]).is_some());
        }

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_u3_zip_slip() {
        // Reject .. traversal
        assert!(sanitize_entry("../evil.txt").is_none());
        assert!(sanitize_entry("foo/../../evil.txt").is_none());

        // Reject Windows drive letter and root paths
        assert!(sanitize_entry("C:/abs.txt").is_none());
        assert!(sanitize_entry("C:\\abs.txt").is_none());
        assert!(sanitize_entry("/abs.txt").is_none());
        assert!(sanitize_entry("\\abs.txt").is_none());

        // Accept normal paths
        let clean = sanitize_entry("ok.xhtml");
        assert!(clean.is_some());
        assert_eq!(clean.unwrap(), Path::new("ok.xhtml"));

        let clean_nested = sanitize_entry("OEBPS/chapters/ch1.xhtml");
        assert!(clean_nested.is_some());
        assert_eq!(clean_nested.unwrap(), Path::new("OEBPS/chapters/ch1.xhtml"));

        // Accept relative paths with ./ components
        let clean_cur = sanitize_entry("./OEBPS/chapters/ch1.xhtml");
        assert!(clean_cur.is_some());
        assert_eq!(clean_cur.unwrap(), Path::new("OEBPS/chapters/ch1.xhtml"));
    }

    #[test]
    fn test_u4_manifest() {
        let manifest = BookManifest {
            path: "C:/books/sample.epub".to_string(),
            len: 12345,
            mtime_ms: 1700000000000,
            files: vec![
                ManifestFile { zip_path: "META-INF/container.xml".to_string(), size: 100 },
                ManifestFile { zip_path: "OEBPS/content.opf".to_string(), size: 500 },
                ManifestFile { zip_path: "OEBPS/ch1.xhtml".to_string(), size: 2000 },
            ],
        };

        // Roundtrip JSON serialization
        let json = serde_json::to_string(&manifest).unwrap();
        let deserialized: BookManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(manifest, deserialized);

        // Invalidation logic: same len + mtime -> no reunzip
        assert!(!should_reunzip(Some(&manifest), 12345, 1700000000000));

        // Mismatched mtime -> reunzip
        assert!(should_reunzip(Some(&manifest), 12345, 1700000000001));

        // Mismatched len -> reunzip
        assert!(should_reunzip(Some(&manifest), 99999, 1700000000000));

        // Missing manifest -> reunzip
        assert!(should_reunzip(None, 12345, 1700000000000));
    }

    #[test]
    fn test_u5_gpu_flags_merge() {
        // Empty existing arguments -> flags only
        let empty_merged = merge_gpu_flags("");
        assert!(empty_merged.contains("--enable-gpu-rasterization"));
        assert!(empty_merged.contains("--enable-zero-copy"));
        assert!(empty_merged.contains("--ignore-gpu-blocklist"));

        // Preset existing with all flags -> no duplicate flags
        let preset = "--enable-gpu-rasterization --enable-zero-copy --ignore-gpu-blocklist";
        let preset_merged = merge_gpu_flags(preset);
        assert_eq!(preset_merged, preset);

        // Custom arguments preserved, missing flags appended
        let custom = "--renderer-process-limit=4";
        let custom_merged = merge_gpu_flags(custom);
        assert!(custom_merged.starts_with("--renderer-process-limit=4"));
        assert!(custom_merged.contains("--enable-gpu-rasterization"));
        assert!(custom_merged.contains("--enable-zero-copy"));
        assert!(custom_merged.contains("--ignore-gpu-blocklist"));

        // Partial flags present -> only missing flags appended
        let partial = "--enable-zero-copy --other-flag";
        let partial_merged = merge_gpu_flags(partial);
        assert!(partial_merged.contains("--other-flag"));
        assert_eq!(partial_merged.matches("--enable-zero-copy").count(), 1);
        assert!(partial_merged.contains("--enable-gpu-rasterization"));
    }

    #[test]
    fn test_u6_fix_entities_named_and_bare_ampersand() {
        // Known named entities decode to their literal characters
        assert_eq!(fix_entities("a&nbsp;b"), "a\u{a0}b");
        assert_eq!(fix_entities("x&mdash;y"), "x\u{2014}y");
        assert_eq!(fix_entities("1&frac12;"), "1\u{bd}");
        assert_eq!(fix_entities("m&sup2;"), "m\u{b2}");
        assert_eq!(fix_entities("m&sup3;"), "m\u{b3}");
        // Bare ampersands (JS &&, prose "Tom & Jerry") get escaped so the
        // strict XML parser accepts them
        assert_eq!(fix_entities("if (a && b) {}"), "if (a &amp;&amp; b) {}");
        assert_eq!(fix_entities("Tom & Jerry"), "Tom &amp; Jerry");
        // A trailing '&' with nothing after it
        assert_eq!(fix_entities("ends &"), "ends &amp;");
        // Valid numeric references pass through untouched
        assert_eq!(fix_entities("&#160;&#x2014;"), "&#160;&#x2014;");
        // XML-native entities are left alone (no double-escaping)
        assert_eq!(fix_entities("a &amp; b &lt; c"), "a &amp; b &lt; c");
        // Unknown named entities are escaped rather than left fatal
        assert_eq!(fix_entities("&foobar;"), "&amp;foobar;");
        // Case sensitivity: exact-case entities decode, unknown case escapes
        assert_eq!(fix_entities("&Auml;"), "\u{c4}");
        assert_eq!(fix_entities("&AUML;"), "&amp;AUML;");
        // No ampersands at all -> unchanged
        assert_eq!(fix_entities("plain text"), "plain text");
    }

    #[test]
    fn test_u7_fix_entities_cdata_and_structure() {
        // CDATA sections are literal JS/CSS: entities and bare '&' survive
        let cdata = "<script>if (a & b && c) {}</script><![CDATA[x & y&nbsp;z]]>";
        let fixed = fix_entities(cdata);
        assert!(fixed.contains("<![CDATA[x & y&nbsp;z]]>"));
        // The script part (outside CDATA) still gets repaired
        assert!(fixed.contains("if (a &amp; b &amp;&amp; c) {}"));
        // A malformed numeric reference is escaped, not passed through
        assert_eq!(fix_entities("&#xzz;"), "&amp;#xzz;");
        assert_eq!(fix_entities("&#;"), "&amp;#;");
        // Realistic chapter snippet: paragraph with entities plus script
        let chapter = "<p>Word&nbsp;joined &mdash; ok</p><script>var s=\"a\"; if (s && t) {}</script>";
        let fixed = fix_entities(chapter);
        assert!(fixed.contains("Word\u{a0}joined \u{2014} ok"));
        assert!(fixed.contains("if (s &amp;&amp; t) {}"));
    }
}
