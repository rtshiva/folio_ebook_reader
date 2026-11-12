use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;
use tauri::Manager;

pub mod mobi;

#[tauri::command]
fn get_initial_file() -> Option<String> {
    first_epub_arg(std::env::args())
}

// First existing ebook (.epub, .mobi, .azw, .azw3) path in an argv iterator
// (used for cold start and single-instance forwards alike).
fn first_epub_arg(args: impl IntoIterator<Item = String>) -> Option<String> {
    for arg in args {
        let l = arg.to_lowercase();
        if (l.ends_with(".epub") || l.ends_with(".mobi") || l.ends_with(".azw") || l.ends_with(".azw3"))
            && Path::new(&arg).exists()
        {
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
    bytes: Arc<Vec<u8>>,
}

struct BookCacheInner {
    entries: HashMap<String, CachedBook>,
    order: Vec<String>, // LRU order, least recently used first
    max_entries: usize,
    max_bytes: usize,
}

impl BookCacheInner {
    fn total_bytes(&self) -> usize {
        self.entries.values().map(|e| e.bytes.len()).sum()
    }
}

#[derive(Clone)]
pub struct BookCache {
    inner: Arc<Mutex<BookCacheInner>>,
}

const BOOK_CACHE_MAX_ENTRIES: usize = 4;
const BOOK_CACHE_MAX_BYTES: usize = 160 * 1024 * 1024;

impl Default for BookCache {
    fn default() -> Self {
        Self::new(BOOK_CACHE_MAX_ENTRIES, BOOK_CACHE_MAX_BYTES)
    }
}

impl BookCache {
    pub fn new(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(BookCacheInner {
                entries: HashMap::new(),
                order: Vec::new(),
                max_entries,
                max_bytes,
            })),
        }
    }

    pub fn get(&self, path: &str, meta: &fs::Metadata) -> Option<Vec<u8>> {
        let bytes_arc = {
            let mut inner = self.inner.lock().ok()?;
            let hit = inner.entries.get(path)?;
            if hit.len != meta.len() || hit.mtime != meta.modified().ok() {
                return None; // file changed on disk — caller re-reads
            }
            let bytes = hit.bytes.clone();
            if let Some(pos) = inner.order.iter().position(|p| p == path) {
                let p = inner.order.remove(pos);
                inner.order.push(p);
            }
            bytes
        };
        Some(Arc::try_unwrap(bytes_arc).unwrap_or_else(|a| (*a).clone()))
    }

    pub fn put(&self, path: String, meta: &fs::Metadata, bytes: Vec<u8>) {
        let mut inner = match self.inner.lock() {
            Ok(i) => i,
            Err(_) => return,
        };

        // Don't cache entries that exceed the configured byte budget.
        if bytes.len() > inner.max_bytes {
            if inner.entries.remove(&path).is_some() {
                if let Some(pos) = inner.order.iter().position(|p| p == &path) {
                    inner.order.remove(pos);
                }
            }
            return;
        }

        let entry = CachedBook {
            len: meta.len(),
            mtime: meta.modified().ok(),
            bytes: Arc::new(bytes),
        };

        inner.entries.insert(path.clone(), entry);
        if let Some(pos) = inner.order.iter().position(|p| p == &path) {
            inner.order.remove(pos);
        }
        inner.order.push(path);

        // Evict least-recently-used entries until within entry and byte caps.
        while inner.order.len() > inner.max_entries || inner.total_bytes() > inner.max_bytes {
            if inner.order.is_empty() {
                break;
            }
            let evict = inner.order.remove(0);
            inner.entries.remove(&evict);
        }
    }

    pub fn total_bytes(&self) -> usize {
        self.inner.lock().map(|i| i.total_bytes()).unwrap_or(0)
    }

    pub fn len(&self) -> usize {
        self.inner.lock().map(|i| i.order.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

pub const MAX_BOOK_FILE_BYTES: u64 = 512 * 1024 * 1024; // 512 MB

pub fn validate_book_path(path_str: &str) -> Result<PathBuf, String> {
    let trimmed = path_str.trim();
    if trimmed.is_empty() || trimmed.len() > 4096 {
        return Err("Invalid file path".to_string());
    }
    // Reject UNC / network shares to avoid SMB negotiation and credential leaking
    if trimmed.starts_with(r"\\")
        || trimmed.starts_with("//")
        || trimmed.starts_with(r"/\")
        || trimmed.starts_with(r"\/")
        || trimmed.starts_with(r"\?")
    {
        return Err("Network and UNC paths are not permitted".to_string());
    }

    #[cfg(windows)]
    {
        let p = Path::new(trimmed);
        if let Some(std::path::Component::Prefix(prefix)) = p.components().next() {
            match prefix.kind() {
                std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_) => {}
                _ => return Err("Non-local drive paths are not permitted".to_string()),
            }
        }
    }

    let lower = trimmed.to_lowercase();
    let is_valid_ext = lower.ends_with(".epub")
        || lower.ends_with(".mobi")
        || lower.ends_with(".azw")
        || lower.ends_with(".azw3");
    if !is_valid_ext {
        return Err("Only .epub, .mobi, .azw, and .azw3 files are permitted".to_string());
    }
    // Reject NTFS alternate data streams: `file.txt:stream.epub` passes the
    // extension check but reads a hidden stream on an arbitrary file. Allow
    // only a single drive prefix (`X:`), never a second colon.
    {
        let bytes = trimmed.as_bytes();
        let after_drive = if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
            &trimmed[2..]
        } else {
            trimmed
        };
        if after_drive.contains(':') {
            return Err("Alternate data streams and device paths are not permitted".to_string());
        }
    }
    if let Ok(meta) = fs::symlink_metadata(trimmed) {
        if meta.file_type().is_symlink() {
            return Err("Symlinks are not permitted".to_string());
        }
    }
    let p = PathBuf::from(trimmed);
    if !p.is_file() {
        return Err("Path does not exist or is not a regular file".to_string());
    }
    Ok(p)
}

#[tauri::command]
async fn read_file_bytes(
    path: String,
    state: tauri::State<'_, BookCache>,
) -> Result<tauri::ipc::Response, String> {
    let cache = (*state).clone();
    tauri::async_runtime::spawn_blocking(move || {
        let clean_path = validate_book_path(&path)?;
        let clean_str = clean_path.to_string_lossy().to_string();
        // Open once and stat the handle: stat-then-read on the path alone lets a
        // concurrent swap grow the file past the size cap between the two calls.
        let file = fs::File::open(&clean_path).map_err(|e| format!("Failed to read file: {}", e))?;
        let meta = file.metadata().map_err(|e| format!("Failed to read file: {}", e))?;
        if meta.len() > MAX_BOOK_FILE_BYTES {
            return Err("File exceeds maximum allowable size (512 MB)".to_string());
        }
        if let Some(hit) = cache.get(&clean_str, &meta) {
            return Ok(tauri::ipc::Response::new(hit));
        }
        use std::io::Read;
        let mut bytes = Vec::new();
        file.take(MAX_BOOK_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("Failed to read file: {}", e))?;
        if bytes.len() as u64 > MAX_BOOK_FILE_BYTES {
            return Err("File exceeds maximum allowable size (512 MB)".to_string());
        }
        cache.put(clean_str, &meta, bytes.clone());
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn pick_file() -> Option<String> {
    let file = rfd::FileDialog::new()
        .add_filter("E-Books (*.epub, *.mobi, *.azw3)", &["epub", "mobi", "azw", "azw3"])
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

pub fn is_windows_reserved_name(name: &str) -> bool {
    let stem = match name.split('.').next() {
        Some(s) => s.trim(),
        None => return false,
    };
    matches!(
        stem.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

pub fn sanitize_entry(name: &str) -> Option<PathBuf> {
    // Reject Windows drive letters and alternate data streams (any colon in name)
    if name.contains(':') {
        return None;
    }
    let p = Path::new(name);
    let mut clean = PathBuf::new();
    for comp in p.components() {
        match comp {
            std::path::Component::Normal(c) => {
                let s = c.to_string_lossy();
                if is_windows_reserved_name(&s) {
                    return None;
                }
                // Windows strips trailing dots/spaces on File::create, which
                // would desync the manifest from the on-disk name (404s).
                if s.trim_end_matches(['.', ' ']) != s {
                    return None;
                }
                clean.push(c);
            }
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

pub fn is_valid_cache_hash(hash: &str) -> bool {
    !hash.is_empty()
        && hash.len() <= 128
        && hash.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn unzip_epub(
    epub_path: &Path,
    target_dir: &Path,
    orig_path: &str,
    meta: &fs::Metadata,
    mtime_ms: u128,
) -> Result<BookManifest, String> {
    // Zip-bomb guards: a malicious EPUB must not fill the disk. The on-disk
    // cache is capped at 600 MB across books, but extraction happens before
    // eviction runs — so bound the extraction itself.
    const MAX_FILES: usize = 20000;
    const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024; // 100 MB single entry
    const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024; // 512 MB uncompressed total
    let file = fs::File::open(epub_path).map_err(|e| format!("Cannot open epub file: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Cannot read zip archive: {}", e))?;
    if archive.len() > MAX_FILES {
        return Err(format!(
            "EPUB has too many entries ({} > {})",
            archive.len(),
            MAX_FILES
        ));
    }
    let mut files = Vec::new();
    let mut total: u64 = 0;

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
        if entry.size() > MAX_FILE_BYTES {
            return Err(format!("EPUB entry too large: {}", raw_name));
        }
        let out_path = target_dir.join(&clean_path);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Cannot create dir: {}", e))?;
        }
        let mut outfile = fs::File::create(&out_path).map_err(|e| format!("Cannot create file: {}", e))?;
        use std::io::Read;
        let mut limited_entry = (&mut entry).take(MAX_FILE_BYTES + 1);
        let written = std::io::copy(&mut limited_entry, &mut outfile).map_err(|e| format!("Cannot extract file: {}", e))?;
        if written > MAX_FILE_BYTES {
            return Err(format!("EPUB entry exceeded maximum uncompressed size: {}", raw_name));
        }
        total = total.saturating_add(written);
        if total > MAX_TOTAL_BYTES {
            return Err("EPUB uncompressed size exceeds limit".to_string());
        }
        files.push(ManifestFile {
            zip_path: clean_path.to_string_lossy().replace('\\', "/"),
            size: written,
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

pub static ACTIVE_READING_HASH: Mutex<Option<String>> = Mutex::new(None);
static ACTIVE_BOOK_HASHES: Mutex<Option<HashSet<String>>> = Mutex::new(None);
// Debounce flag for the background eviction thread (module-level so the
// drop guard below can reset it on any exit path, panics included).
static EVICT_IN_FLIGHT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

// Reset the eviction debounce flag and drop the book-hash protection no
// matter how the eviction thread exits — a panic mid-eviction must not wedge
// eviction off for the rest of the process or leak a protection slot.
struct EvictRunGuard(String);
impl Drop for EvictRunGuard {
    fn drop(&mut self) {
        unprotect_book_hash(&self.0);
        EVICT_IN_FLIGHT.store(false, std::sync::atomic::Ordering::Release);
    }
}

pub fn protect_book_hash(hash: &str) {
    if let Ok(mut lock) = ACTIVE_BOOK_HASHES.lock() {
        lock.get_or_insert_with(HashSet::new).insert(hash.to_string());
    }
}

pub fn unprotect_book_hash(hash: &str) {
    if let Ok(mut lock) = ACTIVE_BOOK_HASHES.lock() {
        if let Some(set) = lock.as_mut() {
            set.remove(hash);
        }
    }
}

pub fn is_book_hash_protected(hash: &str) -> bool {
    ACTIVE_BOOK_HASHES
        .lock()
        .ok()
        .and_then(|lock| lock.as_ref().map(|s| s.contains(hash)))
        .unwrap_or(false)
}

struct HashProtectionGuard(String);

impl Drop for HashProtectionGuard {
    fn drop(&mut self) {
        unprotect_book_hash(&self.0);
    }
}

pub fn evict_disk_cache(
    cache_root: &Path,
    max_bytes: u64,
    max_books: usize,
    protect_dir_name: Option<&str>,
) {
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
    let mut total_books = 0usize;
    // Protected bytes still occupy disk, so they count toward the byte cap
    // even though the protected directory itself is never evicted.
    let mut total_bytes: u64 = 0;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            total_books += 1;
            let bytes = dir_size(&p);
            total_bytes += bytes;
            let dir_name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if let Some(protect) = protect_dir_name {
                if dir_name == protect {
                    continue;
                }
            }
            if is_book_hash_protected(dir_name) {
                continue;
            }
            if Some(dir_name) == ACTIVE_READING_HASH.lock().unwrap_or_else(|p| p.into_inner()).as_deref() {
                continue;
            }
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
            dirs.push(DirEntryInfo { path: p, atime, bytes });
        }
    }

    // Sort by atime ascending (oldest first)
    dirs.sort_by_key(|d| d.atime);

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
async fn book_open(path: String, app: tauri::AppHandle) -> Result<BookHandle, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let clean_path = validate_book_path(&path)?;
        let clean_str = clean_path.to_string_lossy().to_string();
        let meta = fs::metadata(&clean_path).map_err(|e| format!("Cannot read file metadata: {}", e))?;
        if meta.len() > MAX_BOOK_FILE_BYTES {
            return Err("Book file exceeds maximum allowable size (512 MB)".to_string());
        }
        let (hash, len, mtime_ms) = compute_book_key(&clean_str, &meta);
        let cache_root = app
            .path()
            .app_cache_dir()
            .map_err(|e| format!("Cannot get app cache dir: {}", e))?
            .join("folio-unzip");
        let target_dir = cache_root.join(&hash);

        protect_book_hash(&hash);
        let _guard = HashProtectionGuard(hash.clone());
        *ACTIVE_READING_HASH.lock().unwrap_or_else(|p| p.into_inner()) = Some(hash.clone());

        let lower = clean_str.to_lowercase();
        let is_mobi = lower.ends_with(".mobi") || lower.ends_with(".azw") || lower.ends_with(".azw3");

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
                    if is_mobi {
                        mobi::unpack_mobi(&clean_path, &target_dir, &clean_str, &meta, mtime_ms)?
                    } else {
                        unzip_epub(&clean_path, &target_dir, &clean_str, &meta, mtime_ms)?
                    }
                }
            }
        } else {
            fs::create_dir_all(&target_dir).map_err(|e| format!("Cannot create cache dir: {}", e))?;
            if is_mobi {
                mobi::unpack_mobi(&clean_path, &target_dir, &clean_str, &meta, mtime_ms)?
            } else {
                unzip_epub(&clean_path, &target_dir, &clean_str, &meta, mtime_ms)?
            }
        };

        // Spawn background eviction — debounced: rapid book_open calls must not
        // stack eviction threads each walking the whole cache tree.
        {
            let evict_root = cache_root.clone();
            let protect_hash = hash.clone();
            if !EVICT_IN_FLIGHT.swap(true, std::sync::atomic::Ordering::AcqRel) {
                std::thread::spawn(move || {
                    // Drop guard resets the debounce flag and drops the
                    // protection even if eviction panics mid-walk.
                    let _guard = EvictRunGuard(protect_hash.clone());
                    protect_book_hash(&protect_hash);
                    evict_disk_cache(&evict_root, DISK_CACHE_MAX_BYTES, DISK_CACHE_MAX_BOOKS, Some(&protect_hash));
                });
            }
        }

        Ok(BookHandle {
            hash,
            cache_dir: target_dir.to_string_lossy().to_string(),
            manifest,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn percent_decode(s: &str) -> String {
    let mut bytes = Vec::new();
    let mut chars = s.bytes();
    while let Some(b) = chars.next() {
        if b == b'%' {
            if let Some(h1) = chars.next() {
                if let Some(h2) = chars.next() {
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
                bytes.push(h1);
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
        "trade" => '\u{2122}',
        "larr" => '\u{2190}',
        "rarr" => '\u{2192}',
        "darr" => '\u{2191}',
        "harr" => '\u{2194}',
        "crarr" => '\u{21b5}',
        "minus" => '\u{2212}',
        "radic" => '\u{221a}',
        "infin" => '\u{221e}',
        "asymp" => '\u{2248}',
        "ne" => '\u{2260}',
        "le" => '\u{2264}',
        "ge" => '\u{2265}',
        "sdot" => '\u{22c5}',
        "loz" => '\u{25ca}',
        "spades" => '\u{2660}',
        "clubs" => '\u{2663}',
        "hearts" => '\u{2665}',
        "diams" => '\u{2666}',
        _ => return None,
    })
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
    let mut i = 0usize;
    while i < text.len() {
        if text[i..].starts_with("<![CDATA[") {
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
        if !text[i..].starts_with('&') {
            let remaining = &text[i..];
            let next_pos = match (remaining.find('&'), remaining.find("<![CDATA[")) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (Some(a), None) => Some(a),
                (None, Some(b)) => Some(b),
                (None, None) => None,
            };
            match next_pos {
                Some(offset) if offset > 0 => {
                    out.push_str(&text[i..i + offset]);
                    i += offset;
                    continue;
                }
                Some(_) => {} // at '&' or '<![CDATA['
                None => {
                    out.push_str(&text[i..]);
                    break;
                }
            }
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
                    // Form alone isn't enough: XML rejects codepoint 0,
                    // surrogates and anything above U+10FFFF, and producers
                    // emit &#0; in the wild — a served chapter carrying one
                    // is a fatal parse error. Rewrite invalid refs to U+FFFD.
                    let cp = u32::from_str_radix(&digits, if hex { 16 } else { 10 }).unwrap_or(0x110000);
                    let valid = cp != 0 && !(0xD800..=0xDFFF).contains(&cp) && cp <= 0x10FFFF;
                    let consumed = 1 + digits_start + digits.len() + 1;
                    if valid {
                        out.push_str(&text[i..i + consumed]);
                    } else {
                        out.push('\u{FFFD}');
                    }
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

pub fn is_xml_mime(mime: &str) -> bool {
    mime == "application/xhtml+xml"
        || mime == "application/xml"
        || mime == "application/oebps-package+xml"
        || mime == "application/x-dtbncx+xml"
        || mime.ends_with("+xml")
}

/// Body bytes for a folio-cache response: XML resources are repaired for
/// strict parsing when they are valid UTF-8, and passed through untouched
/// otherwise (binary-safe; never lossy).
pub fn xml_response_body(mime: &str, bytes: Vec<u8>) -> Vec<u8> {
    if is_xml_mime(mime) {
        match std::str::from_utf8(&bytes) {
            Ok(text) => strip_meta_refresh(&fix_entities(text)),
            Err(_) => bytes,
        }
    } else {
        bytes
    }
}

/* Strip <meta http-equiv=refresh> from served XHTML/HTML: the rendition
   iframe performs self-navigation on it (sandbox/CSP do not govern
   navigation), replacing the reader with an attacker page. The MOBI path
   (clean_chapter_body) already strips these; this covers the EPUB path. */
pub fn strip_meta_refresh(text: &str) -> Vec<u8> {
    if !text.to_ascii_lowercase().contains("<meta") {
        return text.as_bytes().to_vec();
    }
    let mut out = String::with_capacity(text.len());
    let lower = text.to_ascii_lowercase();
    let bytes_in = text.as_bytes();
    let mut i = 0usize;
    while i < text.len() {
        if lower[i..].starts_with("<meta") {
            let after = i + 5;
            let bounded = after >= text.len() || {
                match text[after..].chars().next() {
                    Some(c) => c.is_ascii_whitespace() || c == '/' || c == '>',
                    None => true,
                }
            };
            if bounded {
                // Quote-aware tag end (mirrors mobi.rs find_tag_end).
                let mut in_quote: Option<u8> = None;
                let mut end_rel: Option<usize> = None;
                for (idx, b) in bytes_in[i..].iter().enumerate() {
                    match (*b, in_quote) {
                        (b'"', None) => in_quote = Some(b'"'),
                        (b'"', Some(b'"')) => in_quote = None,
                        (b'\'', None) => in_quote = Some(b'\''),
                        (b'\'', Some(b'\'')) => in_quote = None,
                        (b'>', None) => { end_rel = Some(idx); break; }
                        _ => {}
                    }
                }
                if let Some(gt) = end_rel {
                    let tag = lower[i..i + gt].to_string();
                    // http-equiv=refresh (either attribute order, any quoting)
                    let is_refresh = tag.contains("http-equiv")
                        && tag.contains("refresh");
                    let tag_src = &text[i..i + gt + 1];
                    if is_refresh {
                        i += gt + 1; // drop the tag entirely
                        continue;
                    }
                    out.push_str(tag_src);
                    i += gt + 1;
                    continue;
                }
                // Unterminated meta: keep as-is and stop scanning this tag.
                out.push_str(&text[i..]);
                break;
            }
        }
        let ch_len = text[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
        out.push_str(&text[i..i + ch_len]);
        i += ch_len;
    }
    out.into_bytes()
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

/// Vendored reading fonts (folio-dyn's `@font-face` src) requested through the
/// folio-cache scheme: chapter documents resolve `vendor/fonts/…` against the
/// BOOK base (e.g. `<hash>/OEBPS/vendor/fonts/…`), which no book contains —
/// the face then never loads locally and book text falls back to a system
/// serif that swaps in late (visible font/alignment shift per page visit).
/// Serve the embedded app asset instead: same origin (folio-cache), so no
/// CORS applies and the chapter CSP's font-src already allows it. Matched by
/// basename against the embedded asset table — never joined to a filesystem
/// path — so a crafted rel cannot escape the book cache.
fn embedded_font_bytes(rel: &str, app: &tauri::AppHandle) -> Option<Vec<u8>> {
    let name = embedded_font_asset_name(rel)?;
    let asset = app.asset_resolver().get(name)?;
    Some(asset.bytes.to_vec())
}

/// Pure lookup half of `embedded_font_bytes`: the vendored-font asset name a
/// book-relative path refers to, or None for anything that is not one.
fn embedded_font_asset_name(rel: &str) -> Option<String> {
    let lower = rel.replace('\\', "/").to_lowercase();
    let idx = lower.rfind("vendor/fonts/")?;
    let name = &lower[idx..];
    if !(name.ends_with(".woff2") || name.ends_with(".woff")) {
        return None;
    }
    Some(name.to_string())
}

/// Extracts the book cache hash and inner relative path from a custom-protocol
/// request URI, supporting both `folio-cache://{hash}/{rel}` (direct custom
/// scheme) and `http://folio-cache.localhost/{hash}/{rel}` (Windows WebView2
/// fetchable custom scheme host syntax).
pub fn parse_cache_uri_hash_and_rel(host: &str, path_str: &str) -> (String, String) {    if !host.is_empty()
        && host != "localhost"
        && !host.ends_with(".localhost")
        && host != "folio-cache"
        && is_valid_cache_hash(host)
    {
        (host.to_string(), path_str.trim_start_matches('/').to_string())
    } else {
        let trimmed = path_str.trim_start_matches('/');
        match trimmed.split_once('/') {
            Some((h, r)) => (h.to_string(), r.to_string()),
            None => (trimmed.to_string(), String::new()),
        }
    }
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

            let req_origin = req
                .headers()
                .get("Origin")
                .or_else(|| req.headers().get("origin"))
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            // Allowlist: exact app origins. The wildcard-port localhost
            // entries exist only for `tauri dev` (vite/webpack dev servers);
            // a release build must not reflect arbitrary localhost ports.
            #[cfg(debug_assertions)]
            let is_dev_origin = req_origin.starts_with("http://localhost:")
                || req_origin.starts_with("http://folio-cache.localhost:");
            #[cfg(not(debug_assertions))]
            let is_dev_origin = false;
            // NOTE: on Windows the app origin is http://tauri.localhost (not
            // https, not tauri:). Omitting it made every CORS-mode fetch/XHR
            // from the reader (epub.js loading container.xml/OPF/chapters)
            // fail net::ERR_FAILED, so path-based opens — file association,
            // drag-drop, recents shelf — hung forever on "Loading contents…"
            // with no pages. Bug seen in packaged builds 2026-11-12.
            let allow_origin = if req_origin == "tauri://localhost"
                || req_origin == "http://tauri.localhost"
                || req_origin == "https://tauri.localhost"
                || req_origin == "http://localhost"
                || req_origin == "http://folio-cache.localhost"
                || is_dev_origin
            {
                req_origin
            } else {
                "tauri://localhost"
            };

            let uri = req.uri();
            let host = uri.host().unwrap_or("");
            let path_str = uri.path();

            let (hash, rel_path) = parse_cache_uri_hash_and_rel(host, path_str);

            if !is_valid_cache_hash(&hash) {
                return tauri::http::Response::builder()
                    .status(400)
                    .header("Access-Control-Allow-Origin", allow_origin)
                    .header("X-Content-Type-Options", "nosniff")
                    .body(vec![])
                    .unwrap();
            }

            let decoded_rel = percent_decode(&rel_path);
            let clean_rel = match sanitize_entry(&decoded_rel) {
                Some(p) => p,
                None => {
                    return tauri::http::Response::builder()
                        .status(400)
                        .header("Access-Control-Allow-Origin", allow_origin)
                        .header("X-Content-Type-Options", "nosniff")
                        .body(vec![])
                        .unwrap();
                }
            };

            let file_path = cache_root.join(hash).join(&clean_rel);
            if file_path.is_file() {
                match fs::read(&file_path) {
                    Ok(bytes) => {
                        let mime = mime_for_path(&file_path);
                        // Cache entries are content-addressed by book hash:
                        // the same hash always yields the same bytes, so the
                        // webview can cache resource fetches across chapters
                        // and sessions without any invalidation risk.
                        // Chapters are parsed as strict XML: repair bare
                        // '&' and named/unknown entities before serving
                        // (UTF-8 only; legacy encodings pass through raw).
                        let body: Vec<u8> = xml_response_body(mime, bytes);
                        tauri::http::Response::builder()
                            .status(200)
                            .header("Content-Type", mime)
                            .header("Cache-Control", "max-age=31536000, immutable")
                            .header("Access-Control-Allow-Origin", allow_origin)
                            .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
                            .header("X-Content-Type-Options", "nosniff")
                            // The top-window CSP does not apply inside these
                            // iframes (different origin). Restrict to what
                            // books legitimately use: local + inline styles,
                            // images.
                            .header(
                                "Content-Security-Policy",
                                "default-src 'none'; img-src folio-cache: http://folio-cache.localhost data: blob:; style-src 'unsafe-inline' folio-cache: http://folio-cache.localhost data:; font-src folio-cache: http://folio-cache.localhost data:; media-src folio-cache: http://folio-cache.localhost data: blob:; script-src 'none'; frame-ancestors 'self' tauri://localhost https://tauri.localhost; base-uri 'none'; form-action 'none';",
                            )
                            .body(body)
                            .unwrap_or_else(|_| {
                                tauri::http::Response::builder()
                                    .status(500)
                                    .body(Vec::new())
                                    .expect("500 response")
                            })
                    }
                    Err(_) => {
                        tauri::http::Response::builder()
                            .status(500)
                            .header("Access-Control-Allow-Origin", allow_origin)
                            .header("X-Content-Type-Options", "nosniff")
                            .body(vec![])
                            .unwrap()
                    }
                }
            } else if let Some(font_bytes) = embedded_font_bytes(&clean_rel.to_string_lossy(), app.app_handle()) {
                let mime = mime_for_path(Path::new(&clean_rel));
                tauri::http::Response::builder()
                    .status(200)
                    .header("Content-Type", mime)
                    .header("Cache-Control", "max-age=31536000, immutable")
                    .header("Access-Control-Allow-Origin", allow_origin)
                    .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
                    .header("X-Content-Type-Options", "nosniff")
                    .body(font_bytes)
                    .unwrap()
            } else {
                tauri::http::Response::builder()
                    .status(404)
                    .header("Access-Control-Allow-Origin", allow_origin)
                    .header("X-Content-Type-Options", "nosniff")
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
            pick_file,
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
        assert_eq!(fix_entities("Folio&trade;"), "Folio\u{2122}");
        assert_eq!(fix_entities("a &le; b &ge; c &ne; d"), "a \u{2264} b \u{2265} c \u{2260} d");
        assert_eq!(fix_entities("1 &minus; 2 &asymp; -1"), "1 \u{2212} 2 \u{2248} -1");
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

    #[test]
    fn test_u8_percent_decode() {
        assert_eq!(percent_decode("hello%20world"), "hello world");
        assert_eq!(percent_decode("hello%2"), "hello%2");
        assert_eq!(percent_decode("hello%"), "hello%");
        assert_eq!(percent_decode("hello%2Gworld"), "hello%2Gworld");
    }

    #[test]
    fn test_u9_is_valid_cache_hash() {
        assert!(is_valid_cache_hash("a1b2c3d4e5f6_12345_67890"));
        assert!(is_valid_cache_hash("abc-123_XYZ"));
        assert!(!is_valid_cache_hash(""));
        assert!(!is_valid_cache_hash("../traversal"));
        assert!(!is_valid_cache_hash("foo/bar"));
        assert!(!is_valid_cache_hash("foo\\bar"));
        assert!(!is_valid_cache_hash("C:"));
        assert!(!is_valid_cache_hash("has space"));
    }

    #[test]
    fn test_u10_is_xml_mime() {
        assert!(is_xml_mime("application/xhtml+xml"));
        assert!(is_xml_mime("application/xml"));
        assert!(is_xml_mime("application/oebps-package+xml"));
        assert!(is_xml_mime("application/x-dtbncx+xml"));
        assert!(is_xml_mime("image/svg+xml"));
        assert!(!is_xml_mime("text/css; charset=utf-8"));
        assert!(!is_xml_mime("application/javascript"));
        assert!(!is_xml_mime("image/png"));
    }

    #[test]
    fn test_u11_evict_disk_cache_protect() {
        let tmp = std::env::temp_dir().join("folio_test_evict");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let book1 = tmp.join("book1");
        let book2 = tmp.join("book2");
        fs::create_dir_all(&book1).unwrap();
        fs::create_dir_all(&book2).unwrap();

        fs::write(book1.join("atime"), "100").unwrap();
        fs::write(book2.join("atime"), "200").unwrap();

        // Evict with max 1 book, but protecting book1
        evict_disk_cache(&tmp, 1000000, 1, Some("book1"));

        // book1 was protected, so book2 was evicted
        assert!(book1.exists());
        assert!(!book2.exists());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_u12_response_body_repairs_utf8_and_preserves_legacy_bytes() {
        // Valid UTF-8 chapters get entity repair for strict XML parsing
        let repaired = xml_response_body(
            "application/xhtml+xml",
            b"<p>Tom & Jerry &mdash; ok</p>".to_vec(),
        );
        assert_eq!(
            String::from_utf8(repaired).unwrap(),
            "<p>Tom &amp; Jerry \u{2014} ok</p>"
        );

        // Legacy single-byte chapters (invalid UTF-8) pass through byte
        // identical: no U+FFFD corruption, encoding declaration still applies
        let legacy: Vec<u8> = vec![0x3c, 0x70, 0x3e, 0xe9, 0x26, 0x3c, 0x2f, 0x70, 0x3e];
        assert_eq!(
            xml_response_body("application/xhtml+xml", legacy.clone()),
            legacy
        );

        // Non-XML resources are never rewritten, even when valid UTF-8
        let css = b"a & b { color: red; }".to_vec();
        assert_eq!(xml_response_body("text/css; charset=utf-8", css.clone()), css);
    }

    #[test]
    fn test_u13_unzip_epub_roundtrip_and_guards() {
        use std::io::Write;
        let tmp = std::env::temp_dir().join(format!("folio_test_unzip_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let epub_path = tmp.join("mini.epub");
        {
            let f = fs::File::create(&epub_path).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file("mimetype", opts).unwrap();
            w.write_all(b"application/epub+zip").unwrap();
            w.start_file("OEBPS/ch1.xhtml", opts).unwrap();
            w.write_all(b"<html><body><p>hi</p></body></html>").unwrap();
            w.start_file("../evil.txt", opts).unwrap();
            w.write_all(b"nope").unwrap();
            w.finish().unwrap();
        }
        let meta = fs::metadata(&epub_path).unwrap();
        let target = tmp.join("out");
        fs::create_dir_all(&target).unwrap();
        let manifest = unzip_epub(&epub_path, &target, "mini.epub", &meta, 1).unwrap();
        // Traversal entry skipped, legitimate entries extracted
        assert_eq!(manifest.files.len(), 2);
        assert!(target.join("OEBPS/ch1.xhtml").is_file());
        assert!(!target.join("evil.txt").exists());
        assert!(target.join("manifest.json").is_file());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_u14_evict_counts_protected_bytes() {
        let tmp = std::env::temp_dir().join(format!("folio_test_evict2_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let book1 = tmp.join("book1");
        let book2 = tmp.join("book2");
        fs::create_dir_all(&book1).unwrap();
        fs::create_dir_all(&book2).unwrap();
        fs::write(book1.join("atime"), "100").unwrap();
        fs::write(book2.join("atime"), "200").unwrap();
        // 40 KB blob in each book; cap at 50 KB with room for 30 books:
        // only the byte cap can trigger, and only because the protected
        // book's bytes count toward it.
        fs::write(book1.join("blob.bin"), vec![1u8; 40 * 1024]).unwrap();
        fs::write(book2.join("blob.bin"), vec![2u8; 40 * 1024]).unwrap();
        evict_disk_cache(&tmp, 50 * 1024, 30, Some("book1"));
        assert!(book1.exists());
        assert!(!book2.exists());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_u15_first_epub_arg() {
        let tmp = std::env::temp_dir().join(format!("folio_test_arg_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let upper = tmp.join("BOOK.EPUB");
        let mobi = tmp.join("STORY.MOBI");
        let txt = tmp.join("note.txt");
        fs::write(&upper, b"fake epub").unwrap();
        fs::write(&mobi, b"fake mobi").unwrap();
        fs::write(&txt, b"not a book").unwrap();
        let missing = tmp.join("ghost.epub");

        // argv[0] is the exe itself; picks the first *existing* ebook (.epub, .mobi, .azw3),
        // case-insensitively, skipping text files and missing paths.
        let args = vec![
            "folio.exe".to_string(),
            txt.to_string_lossy().to_string(),
            missing.to_string_lossy().to_string(),
            upper.to_string_lossy().to_string(),
        ];
        assert_eq!(first_epub_arg(args), Some(upper.to_string_lossy().to_string()));

        let args_mobi = vec![
            "folio.exe".to_string(),
            txt.to_string_lossy().to_string(),
            mobi.to_string_lossy().to_string(),
        ];
        assert_eq!(first_epub_arg(args_mobi), Some(mobi.to_string_lossy().to_string()));

        // No existing ebook at all -> None (never a bogus path).
        let args_none = vec![
            "folio.exe".to_string(),
            txt.to_string_lossy().to_string(),
            missing.to_string_lossy().to_string(),
        ];
        assert_eq!(first_epub_arg(args_none), None);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_u16_percent_encoded_traversal_never_sanitizes() {
        // Single decoding turns %2E%2E%2F into ../evil.txt, which the
        // sanitizer must reject — this is the traversal the scheme handler
        // would otherwise serve from outside the book's cache dir.
        let decoded = percent_decode("%2E%2e%2Fevil.txt");
        assert_eq!(decoded, "../evil.txt");
        assert!(sanitize_entry(&decoded).is_none());
        // Mixed-case hex and absolute-path forms decode-then-reject too.
        assert!(sanitize_entry(&percent_decode("%2e%2E%5cevil.txt")).is_none());
        assert!(sanitize_entry(&percent_decode("%2Fabs.txt")).is_none());
        // Double-encoded input decodes only once, so it stays a harmless
        // single filename that can never escape (lookup yields 404).
        let once = percent_decode("%252E%252E%2Fevil.txt");
        assert_eq!(once, "%2E%2E/evil.txt");
        assert!(!once.starts_with("../"));
    }

    #[test]
    fn test_u17_unzip_rejects_entry_count_bomb() {
        use std::io::Write;
        let tmp = std::env::temp_dir().join(format!("folio_test_bomb_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let epub_path = tmp.join("bomb.epub");
        {
            let f = fs::File::create(&epub_path).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default();
            for i in 0..20001 {
                w.start_file(format!("f{}.txt", i), opts).unwrap();
                w.write_all(b"x").unwrap();
            }
            w.finish().unwrap();
        }
        let meta = fs::metadata(&epub_path).unwrap();
        let target = tmp.join("out");
        fs::create_dir_all(&target).unwrap();
        let err = unzip_epub(&epub_path, &target, "bomb.epub", &meta, 1).unwrap_err();
        assert!(err.contains("too many entries"), "unexpected error: {}", err);
        // Nothing extracted on rejection.
        assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_u18_cache_uri_hash_extraction() {
        // Direct custom scheme: folio-cache://<hash>/<rel>
        let (h1, r1) = parse_cache_uri_hash_and_rel("abc123def456", "/META-INF/container.xml");
        assert_eq!(h1, "abc123def456");
        assert_eq!(r1, "META-INF/container.xml");

        // Windows WebView2 fetchable format: http://folio-cache.localhost/<hash>/<rel>
        let (h2, r2) = parse_cache_uri_hash_and_rel("folio-cache.localhost", "/abc123def456/META-INF/container.xml");
        assert_eq!(h2, "abc123def456");
        assert_eq!(r2, "META-INF/container.xml");

        // Localhost custom scheme: folio-cache://localhost/<hash>/<rel>
        let (h3, r3) = parse_cache_uri_hash_and_rel("localhost", "/abc123def456/OEBPS/content.opf");
        assert_eq!(h3, "abc123def456");
        assert_eq!(r3, "OEBPS/content.opf");

        // HTTPS localhost format: https://folio-cache.localhost/<hash>/<rel>
        let (h4, r4) = parse_cache_uri_hash_and_rel("folio-cache.localhost", "/abc123def456/OEBPS/ch1.xhtml");
        assert_eq!(h4, "abc123def456");
        assert_eq!(r4, "OEBPS/ch1.xhtml");
    }

    #[test]
    fn test_u19_book_cache_oversized_and_byte_budget() {
        let temp_dir = std::env::temp_dir().join(format!("folio_test_u19_{}", std::process::id()));
        let _ = fs::create_dir_all(&temp_dir);

        // Cache with max 3 entries and budget of 3000 bytes
        let cache = BookCache::new(3, 3000);

        let f_oversized = temp_dir.join("oversized.epub");
        fs::write(&f_oversized, vec![0u8; 3500]).unwrap();
        let m_oversized = fs::metadata(&f_oversized).unwrap();
        let p_oversized = f_oversized.to_string_lossy().to_string();

        // 1. Oversized entry (> 3000 bytes) must never be cached
        cache.put(p_oversized.clone(), &m_oversized, vec![0u8; 3500]);
        assert_eq!(cache.get(&p_oversized, &m_oversized), None);
        assert_eq!(cache.total_bytes(), 0);
        assert_eq!(cache.len(), 0);

        // 2. Add two 1200-byte books (2400 bytes total <= 3000 bytes budget)
        let f1 = temp_dir.join("b1.epub");
        let f2 = temp_dir.join("b2.epub");
        fs::write(&f1, b"b1").unwrap();
        fs::write(&f2, b"b2").unwrap();
        let m1 = fs::metadata(&f1).unwrap();
        let m2 = fs::metadata(&f2).unwrap();
        let p1 = f1.to_string_lossy().to_string();
        let p2 = f2.to_string_lossy().to_string();

        cache.put(p1.clone(), &m1, vec![1u8; 1200]);
        cache.put(p2.clone(), &m2, vec![2u8; 1200]);
        assert_eq!(cache.total_bytes(), 2400);
        assert_eq!(cache.len(), 2);
        assert!(cache.get(&p1, &m1).is_some());
        assert!(cache.get(&p2, &m2).is_some());

        // 3. Adding a third 1200-byte book would reach 3600 bytes (> 3000 bytes),
        // so b1 (oldest LRU) must be evicted even though entry count (3) is within max_entries (3).
        let f3 = temp_dir.join("b3.epub");
        fs::write(&f3, b"b3").unwrap();
        let m3 = fs::metadata(&f3).unwrap();
        let p3 = f3.to_string_lossy().to_string();

        cache.put(p3.clone(), &m3, vec![3u8; 1200]);
        assert_eq!(cache.total_bytes(), 2400); // 1200 + 1200 = 2400 bytes <= 3000 bytes
        assert_eq!(cache.len(), 2);
        assert_eq!(cache.get(&p1, &m1), None); // b1 evicted
        assert!(cache.get(&p2, &m2).is_some());
        assert!(cache.get(&p3, &m3).is_some());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_u20_book_cache_concurrent_no_deadlock() {
        use std::sync::Arc;
        let temp_dir = std::env::temp_dir().join(format!("folio_test_u20_{}", std::process::id()));
        let _ = fs::create_dir_all(&temp_dir);

        let test_file = temp_dir.join("test.epub");
        fs::write(&test_file, b"thread test").unwrap();
        let meta = fs::metadata(&test_file).unwrap();
        let path_str = test_file.to_string_lossy().to_string();

        let cache = Arc::new(BookCache::new(5, 100_000));
        let mut handles = Vec::new();

        // Spawn multiple concurrent reader and writer threads to verify no lock inversions or deadlocks
        for i in 0..10 {
            let c = Arc::clone(&cache);
            let p = path_str.clone();
            let m = meta.clone();
            handles.push(std::thread::spawn(move || {
                for j in 0..100 {
                    if (i + j) % 2 == 0 {
                        c.put(p.clone(), &m, vec![(j % 255) as u8; 256]);
                    } else {
                        let _ = c.get(&p, &m);
                    }
                }
            }));
        }

        for h in handles {
            h.join().expect("Thread should not deadlock or panic");
        }

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_u21_unzip_malformed_archive() {
        let tmp = std::env::temp_dir().join(format!("folio_test_u21_{}", std::process::id()));
        let _ = fs::create_dir_all(&tmp);

        let corrupted_file = tmp.join("corrupted.epub");
        // Non-zip garbage bytes
        fs::write(&corrupted_file, b"NOT_A_VALID_ZIP_ARCHIVE_DATA_TRUNCATED").unwrap();
        let meta = fs::metadata(&corrupted_file).unwrap();

        let target = tmp.join("out");
        fs::create_dir_all(&target).unwrap();

        let res = unzip_epub(&corrupted_file, &target, "corrupted.epub", &meta, 1);
        assert!(res.is_err(), "Corrupted archive must return an error");

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_u22_percent_decode_and_custom_protocol_paths() {
        // Test malformed percent encodings
        assert_eq!(percent_decode("%"), "%");
        assert_eq!(percent_decode("%2"), "%2");
        assert_eq!(percent_decode("%ZZ"), "%ZZ");
        assert_eq!(percent_decode("hello%20world"), "hello world");

        // Cache hash validation
        assert!(!is_valid_cache_hash(""));
        assert!(!is_valid_cache_hash("../escape"));
        assert!(!is_valid_cache_hash("has spaces"));
        assert!(!is_valid_cache_hash("a/b"));
        assert!(is_valid_cache_hash("valid_hash-123_456"));

        // Malformed URI handling
        let (h_empty, r_empty) = parse_cache_uri_hash_and_rel("", "");
        assert_eq!(h_empty, "");
        assert_eq!(r_empty, "");

        let (h_slash, r_slash) = parse_cache_uri_hash_and_rel("localhost", "/");
        assert_eq!(h_slash, "");
        assert_eq!(r_slash, "");
    }

    #[test]
    fn test_u23_palmdoc_lz77_decompression() {
        use crate::mobi::decompress_palmdoc;

        // 1. Literal run and single bytes
        // 0x04 followed by "test", then '!', then 0xC1 (space + 'A')
        let compressed = vec![4, b't', b'e', b's', b't', b'!', 0xC1];
        let decompressed = decompress_palmdoc(&compressed).unwrap();
        assert_eq!(decompressed, b"test! A");

        // 2. LZ77 backreference
        // "abcde" followed by backreference to "cde"
        // In PalmDOC, distance = 3, length = 3
        // compound = (distance << 3) | (length - 3) = (3 << 3) | 0 = 24
        // compound is 14-bit: high 6 bits in byte 1 (with 0x80 bit set), low 8 bits in byte 2
        // compound = 24 -> byte1 = 0x80 | (24 >> 8) = 0x80, byte2 = 24 & 0xFF = 0x18
        let ref_compressed = vec![5, b'a', b'b', b'c', b'd', b'e', 0x80, 0x18];
        let ref_decomp = decompress_palmdoc(&ref_compressed).unwrap();
        assert_eq!(ref_decomp, b"abcdecde");
    }

    #[test]
    fn test_u24_trailing_bytes_and_cp1252() {
        use crate::mobi::{cp1252_to_utf8, strip_trailing_entries};

        // Test CP1252 encoding conversion for typographic quotes and dashes
        let cp1252_bytes = vec![0x93, b'H', b'i', 0x94, 0x97, 0x80];
        let utf8_res = cp1252_to_utf8(&cp1252_bytes);
        assert_eq!(utf8_res, "“Hi”—€");

        // Test trailing bytes stripping with bit 0 (multibyte)
        // If flag bit 0 is set: size is (last_byte & 3) + 1
        // E.g., last_byte = 0x02 -> extra size = 3 bytes
        let data = vec![b'H', b'e', b'l', b'l', b'o', 0xAA, 0xBB, 0x02];
        let stripped = strip_trailing_entries(&data, 1);
        assert_eq!(stripped, b"Hello");
    }

    fn create_synthetic_mobi(title: &str, author: &str, text: &str, encryption_type: u16) -> Vec<u8> {
        create_synthetic_mobi_opt(title, author, text, encryption_type, false)
    }

    // PalmDOC literal-run encoding (control byte 1..=8 + raw bytes) — no
    // backreferences, but it exercises the compression==2 decode path.
    fn palmdoc_literal_encode(data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        for chunk in data.chunks(8) {
            out.push(chunk.len() as u8);
            out.extend_from_slice(chunk);
        }
        out
    }

    fn create_synthetic_mobi_opt(title: &str, author: &str, text: &str, encryption_type: u16, palmdoc: bool) -> Vec<u8> {
        let mut rec0 = Vec::new();
        // compression = 1 (none) by default: rec1 below stores the text
        // UNcompressed, so the header must not claim PalmDOC(2) unless we
        // actually encode it — the parser would LZ77-decode raw UTF-8.
        rec0.extend_from_slice(&if palmdoc { 2u16 } else { 1u16 }.to_be_bytes());
        rec0.extend_from_slice(&0u16.to_be_bytes());
        rec0.extend_from_slice(&(text.len() as u32).to_be_bytes());
        rec0.extend_from_slice(&1u16.to_be_bytes()); // 1 text record
        rec0.extend_from_slice(&4096u16.to_be_bytes());
        rec0.extend_from_slice(&0u16.to_be_bytes());
        rec0.extend_from_slice(&encryption_type.to_be_bytes());

        let mobi_hdr_len = 232usize;
        let mut mobi_hdr = vec![0u8; mobi_hdr_len];
        mobi_hdr[0..4].copy_from_slice(b"MOBI");
        mobi_hdr[4..8].copy_from_slice(&(mobi_hdr_len as u32).to_be_bytes());
        mobi_hdr[8..12].copy_from_slice(&2u32.to_be_bytes());
        mobi_hdr[12..16].copy_from_slice(&65001u32.to_be_bytes()); // UTF-8
        mobi_hdr[16..20].copy_from_slice(&9999u32.to_be_bytes());
        mobi_hdr[20..24].copy_from_slice(&6u32.to_be_bytes());
        mobi_hdr[64..68].copy_from_slice(&2u32.to_be_bytes()); // first image index = 2
        mobi_hdr[80..84].copy_from_slice(&0x40u32.to_be_bytes()); // EXTH flag
        mobi_hdr[112..116].copy_from_slice(&3u32.to_be_bytes()); // first non book index
        rec0.extend_from_slice(&mobi_hdr);

        // EXTH header
        let mut exth_records = Vec::new();
        let a_bytes = author.as_bytes();
        let a_len = (8 + a_bytes.len() + 3) & !3;
        let mut a_rec = vec![0u8; a_len];
        a_rec[0..4].copy_from_slice(&100u32.to_be_bytes());
        a_rec[4..8].copy_from_slice(&(a_len as u32).to_be_bytes());
        a_rec[8..8 + a_bytes.len()].copy_from_slice(a_bytes);
        exth_records.extend_from_slice(&a_rec);

        let t_bytes = title.as_bytes();
        let t_len = (8 + t_bytes.len() + 3) & !3;
        let mut t_rec = vec![0u8; t_len];
        t_rec[0..4].copy_from_slice(&503u32.to_be_bytes());
        t_rec[4..8].copy_from_slice(&(t_len as u32).to_be_bytes());
        t_rec[8..8 + t_bytes.len()].copy_from_slice(t_bytes);
        exth_records.extend_from_slice(&t_rec);

        let exth_total_len = 12 + exth_records.len();
        rec0.extend_from_slice(b"EXTH");
        rec0.extend_from_slice(&(exth_total_len as u32).to_be_bytes());
        rec0.extend_from_slice(&2u32.to_be_bytes());
        rec0.extend_from_slice(&exth_records);

        let rec1 = if palmdoc {
            palmdoc_literal_encode(text.as_bytes())
        } else {
            text.as_bytes().to_vec()
        };
        // 1x1 GIF
        let rec2 = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;".to_vec();

        let num_records = 3usize;
        let header_size = 78 + num_records * 8 + 2;
        let mut out = Vec::new();

        let mut pdb_hdr = vec![0u8; 78];
        let name = b"SyntheticMobi";
        pdb_hdr[..name.len()].copy_from_slice(name);
        pdb_hdr[60..64].copy_from_slice(b"BOOK");
        pdb_hdr[64..68].copy_from_slice(b"MOBI");
        pdb_hdr[76..78].copy_from_slice(&(num_records as u16).to_be_bytes());
        out.extend_from_slice(&pdb_hdr);

        let off0 = header_size;
        let off1 = off0 + rec0.len();
        let off2 = off1 + rec1.len();
        let offsets = [off0, off1, off2];

        for (i, &off) in offsets.iter().enumerate() {
            out.extend_from_slice(&(off as u32).to_be_bytes());
            out.push(0);
            out.push(0);
            out.push(0);
            out.push(i as u8);
        }
        out.extend_from_slice(&[0, 0]);

        out.extend_from_slice(&rec0);
        out.extend_from_slice(&rec1);
        out.extend_from_slice(&rec2);

        out
    }

    #[test]
    fn test_u25_mobi_unpack_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("folio_test_mobi_roundtrip_{}", std::process::id()));
        let _ = fs::create_dir_all(&tmp);

        let mobi_file = tmp.join("book.mobi");
        let content = "<h1>Chapter One</h1><p>Welcome to Folio reading MOBI files.</p><img recindex=\"1\"><mbp:pagebreak/><h1>Chapter Two</h1><p>Second chapter is readable.</p>";
        let bytes = create_synthetic_mobi("Folio Story", "Arthur Conan Doyle", content, 0);
        fs::write(&mobi_file, bytes).unwrap();
        let meta = fs::metadata(&mobi_file).unwrap();

        let target = tmp.join("out");
        fs::create_dir_all(&target).unwrap();

        let manifest = crate::mobi::unpack_mobi(&mobi_file, &target, "book.mobi", &meta, 12345).unwrap();
        assert!(!manifest.files.is_empty());

        // Verify structure
        assert!(target.join("META-INF/container.xml").exists());
        assert!(target.join("content.opf").exists());
        assert!(target.join("toc.ncx").exists());
        assert!(target.join("manifest.json").exists());
        assert!(target.join("images/img_0001.gif").exists());
        assert!(target.join("ch_0001.xhtml").exists());
        assert!(target.join("ch_0002.xhtml").exists());

        // Check content of OPF and chapters
        let opf_text = fs::read_to_string(target.join("content.opf")).unwrap();
        assert!(opf_text.contains("Folio Story"));
        assert!(opf_text.contains("Arthur Conan Doyle"));

        let ch1_text = fs::read_to_string(target.join("ch_0001.xhtml")).unwrap();
        assert!(ch1_text.contains("Chapter One"));
        assert!(ch1_text.contains("images/img_0001.gif"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_u26_mobi_drm_protection_detected() {
        let tmp = std::env::temp_dir().join(format!("folio_test_mobi_drm_{}", std::process::id()));
        let _ = fs::create_dir_all(&tmp);

        let mobi_file = tmp.join("drm_book.mobi");
        let bytes = create_synthetic_mobi("Encrypted Book", "Unknown", "secret", 2);
        fs::write(&mobi_file, bytes).unwrap();
        let meta = fs::metadata(&mobi_file).unwrap();

        let target = tmp.join("out");
        fs::create_dir_all(&target).unwrap();

        let res = crate::mobi::unpack_mobi(&mobi_file, &target, "drm_book.mobi", &meta, 12345);
        assert!(res.is_err());
        let err = res.err().unwrap();
        assert!(err.contains("DRM-protected"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_u27_validate_book_path_security() {
        let tmp = std::env::temp_dir().join(format!("folio_test_sec_path_{}", std::process::id()));
        let _ = fs::create_dir_all(&tmp);

        // 1. Valid existing epub
        let valid_epub = tmp.join("valid.epub");
        fs::write(&valid_epub, b"PK0304").unwrap();
        assert!(validate_book_path(&valid_epub.to_string_lossy()).is_ok());

        // 2. Reject UNC / network paths
        assert!(validate_book_path(r"\\evil-server\share\book.epub").is_err());
        assert!(validate_book_path("//evil-server/share/book.epub").is_err());
        assert!(validate_book_path(r"/\evil-server\share\book.epub").is_err());
        assert!(validate_book_path(r"\/evil-server\share\book.epub").is_err());
        assert!(validate_book_path(r"\?C:\book.epub").is_err());

        // 3. Reject non-ebook extensions
        let bad_ext = tmp.join("secrets.txt");
        fs::write(&bad_ext, b"confidential").unwrap();
        assert!(validate_book_path(&bad_ext.to_string_lossy()).is_err());

        let ssh_key = tmp.join("id_rsa");
        fs::write(&ssh_key, b"key").unwrap();
        assert!(validate_book_path(&ssh_key.to_string_lossy()).is_err());

        // 4. Reject non-existent file
        assert!(validate_book_path(&tmp.join("missing.epub").to_string_lossy()).is_err());

        // 5. Reject directory
        assert!(validate_book_path(&tmp.to_string_lossy()).is_err());

        // 6. Reject NTFS alternate data streams and stray colons (even when
        // the stream name carries a valid ebook extension)
        assert!(validate_book_path("C:\\notes.txt:sneaky.epub").is_err());
        assert!(validate_book_path(&tmp.join("book.epub:hidden.mobi").to_string_lossy()).is_err());
        assert!(validate_book_path("book.epub::$DATA").is_err());
        // drive prefix itself is fine
        assert!(validate_book_path(&valid_epub.to_string_lossy()).is_ok());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_u28_sanitize_entry_windows_devices_and_streams() {
        // Windows reserved devices must be rejected
        assert_eq!(sanitize_entry("CON"), None);
        assert_eq!(sanitize_entry("con.xhtml"), None);
        assert_eq!(sanitize_entry("NUL.txt"), None);
        assert_eq!(sanitize_entry("aux.png"), None);
        assert_eq!(sanitize_entry("COM1.html"), None);
        assert_eq!(sanitize_entry("OEBPS/prn.xhtml"), None);
        assert_eq!(sanitize_entry("sub/lpt1.jpg"), None);

        // NTFS alternate data streams must be rejected
        assert_eq!(sanitize_entry("file.txt:evil"), None);
        assert_eq!(sanitize_entry("test::$DATA"), None);

        // Standard clean paths must succeed
        assert!(sanitize_entry("OEBPS/chapter1.xhtml").is_some());
        assert!(sanitize_entry("images/cover.jpg").is_some());
    }

    #[test]
    fn test_u29_mobi_html_sanitization() {
        let tmp = std::env::temp_dir().join(format!("folio_test_mobi_sec_{}", std::process::id()));
        let _ = fs::create_dir_all(&tmp);

        let mobi_file = tmp.join("malicious.mobi");
        let raw_html = "<html><body><h1>Danger</h1><script>alert('xss')</script><iframe src='https://evil.com'></iframe><img src='x.png' onerror='alert(1)' /><a href='javascript:evil()'>Click</a><p>Safe text</p></body></html>";
        let bytes = create_synthetic_mobi("Safe Title", "Author", raw_html, 0);
        fs::write(&mobi_file, bytes).unwrap();
        let meta = fs::metadata(&mobi_file).unwrap();

        let target = tmp.join("out");
        fs::create_dir_all(&target).unwrap();

        let res = crate::mobi::unpack_mobi(&mobi_file, &target, "malicious.mobi", &meta, 12345);
        assert!(res.is_ok());

        let ch0_text = fs::read_to_string(target.join("ch_0001.xhtml")).unwrap();
        // Script tag and body stripped
        assert!(!ch0_text.contains("<script"));
        assert!(!ch0_text.contains("alert('xss')"));
        // Iframe stripped
        assert!(!ch0_text.contains("<iframe"));
        assert!(!ch0_text.contains("evil.com"));
        // Inline event handler stripped
        assert!(!ch0_text.contains("onerror"));
        // Javascript link stripped
        assert!(!ch0_text.contains("javascript:"));
        // Safe text remains
        assert!(ch0_text.contains("Safe text"));

        let _ = fs::remove_dir_all(&tmp);
    }

    // P0 regression: every non-ASCII MOBI used to panic the byte-stepping
    // scanners (str slicing mid-UTF-8-char) and to_lowercase offset drift.
    #[test]
    fn test_u30_mobi_non_ascii_no_panic() {
        let tmp = std::env::temp_dir().join(format!("folio_test_mobi_uni_{}", std::process::id()));
        let _ = fs::create_dir_all(&tmp);

        // Curly quotes, accented chars, CJK, an İ (lowercases to 3 bytes),
        // pagebreak + heading + img + link markup all in the same text.
        let raw_html = "<html><body><h1>Voil\u{e0} — \u{130}stanbul \u{4f60}\u{597d}</h1>\
            <p>Don\u{2019}t stop caf\u{e9} cr\u{e8}me \u{1F600}</p>\
            <mbp:pagebreak/><p>Second part \u{4e16}\u{754c}</p>\
            <img recindex=\"0001\" src='1' alt\u{2003}caf\u{e9}><a filepos=\"0000000123\">r\u{e9}sum\u{e9}</a></body></html>";
        let bytes = create_synthetic_mobi("Titre \u{e9}trange", "Auteur \u{e9}", raw_html, 0);
        let mobi_file = tmp.join("unicode.mobi");
        fs::write(&mobi_file, bytes).unwrap();
        let meta = fs::metadata(&mobi_file).unwrap();

        let target = tmp.join("out");
        fs::create_dir_all(&target).unwrap();

        // Must not panic; must succeed and keep the non-ASCII text intact.
        let res = crate::mobi::unpack_mobi(&mobi_file, &target, "unicode.mobi", &meta, 77777);
        assert!(res.is_ok(), "unpack_mobi failed on non-ASCII content: {:?}", res.err());

        let mut all = String::new();
        let mut n = 1; // chapter files are 1-based: ch_0001.xhtml …
        while let Ok(s) = fs::read_to_string(target.join(format!("ch_{:04}.xhtml", n))) {
            all.push_str(&s);
            n += 1;
        }
        let n = n - 1;
        assert!(n >= 1, "no chapters produced");
        assert!(all.contains("caf\u{e9}"), "accented text lost");
        assert!(all.contains("\u{4f60}\u{597d}"), "CJK text lost");
        assert!(all.contains("r\u{e9}sum\u{e9}"), "link text lost");

        // Direct scanners too (split/clean/rewrite on raw non-ASCII input)
        let chunks = crate::mobi::split_into_chapters(raw_html);
        assert!(!chunks.is_empty());
        assert!(chunks.iter().all(|c| !c.body.contains("mbp:pagebreak")));
        let _ = fs::remove_dir_all(&tmp);
    }

    // Coverage: the unpack_mobi compression==2 branch (PalmDOC decode +
    // per-chunk budget wiring) must work end-to-end, including non-ASCII
    // text carried through literal-run records.
    #[test]
    fn test_u32_mobi_palmdoc_unpack() {
        let tmp = std::env::temp_dir().join(format!("folio_test_mobi_pd_{}", std::process::id()));
        let _ = fs::create_dir_all(&tmp);

        let content = "<h1>PalmDOC Chapter</h1><p>Caf\u{e9} cr\u{e8}me \u{4f60}\u{597d} readable.</p>";
        let bytes = create_synthetic_mobi_opt("PalmDOC Book", "Auth \u{f6}r", content, 0, true);
        let mobi_file = tmp.join("palmdoc.mobi");
        fs::write(&mobi_file, bytes).unwrap();
        let meta = fs::metadata(&mobi_file).unwrap();

        let target = tmp.join("out");
        fs::create_dir_all(&target).unwrap();
        let res = crate::mobi::unpack_mobi(&mobi_file, &target, "palmdoc.mobi", &meta, 4242);
        assert!(res.is_ok(), "PalmDOC unpack failed: {:?}", res.err());

        let ch = fs::read_to_string(target.join("ch_0001.xhtml")).unwrap();
        assert!(ch.contains("Caf\u{e9}"), "PalmDOC non-ASCII text lost");
        assert!(ch.contains("\u{4f60}\u{597d}"), "PalmDOC CJK text lost");
        let _ = fs::remove_dir_all(&tmp);
    }

    // P1 regression: PalmDOC expansion must be capped mid-decode, not after.
    #[test]
    fn test_u31_palmdoc_decompression_budget() {
        // A literal run of N 'A's (control byte 0x08 + 8 literals per group).
        let mut data = Vec::new();
        for _ in 0..100 {
            data.push(0x08);
            data.extend_from_slice(b"AAAAAAAA");
        }
        // Uncapped: 800 bytes out
        let full = crate::mobi::decompress_palmdoc(&data).unwrap();
        assert_eq!(full.len(), 800);
        // Capped at 100: must error mid-decode, not return 800 bytes
        let capped = crate::mobi::decompress_palmdoc_capped(&data, 100);
        assert!(capped.is_err(), "budget not enforced");
        // Capped at exactly the output size: ok
        assert_eq!(crate::mobi::decompress_palmdoc_capped(&data, 800).unwrap().len(), 800);
    }

    #[test]
    fn test_u33_active_book_hash_protection_in_eviction() {
        let tmp = std::env::temp_dir().join(format!("folio_test_active_protect_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let book1 = tmp.join("hash_active_1");
        let book2 = tmp.join("hash_stale_2");
        fs::create_dir_all(&book1).unwrap();
        fs::create_dir_all(&book2).unwrap();

        fs::write(book1.join("atime"), "100").unwrap();
        fs::write(book2.join("atime"), "200").unwrap();

        protect_book_hash("hash_active_1");
        assert!(is_book_hash_protected("hash_active_1"));

        // Evict with max 1 book, protect_dir_name is None, but hash_active_1 is in ACTIVE_BOOK_HASHES
        evict_disk_cache(&tmp, 1000000, 1, None);

        // hash_active_1 was protected by global active set, so hash_stale_2 was evicted
        assert!(book1.exists());
        assert!(!book2.exists());

        unprotect_book_hash("hash_active_1");
        assert!(!is_book_hash_protected("hash_active_1"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_u34_active_reading_hash_protection_in_eviction() {
        let tmp = std::env::temp_dir().join(format!("folio_test_active_read_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let book1 = tmp.join("reading_hash_1");
        let book2 = tmp.join("stale_hash_2");
        fs::create_dir_all(&book1).unwrap();
        fs::create_dir_all(&book2).unwrap();

        fs::write(book1.join("atime"), "100").unwrap();
        fs::write(book2.join("atime"), "200").unwrap();

        *ACTIVE_READING_HASH.lock().unwrap() = Some("reading_hash_1".to_string());

        // Evict with max 1 book, protect_dir_name is None, but reading_hash_1 is ACTIVE_READING_HASH
        evict_disk_cache(&tmp, 1000000, 1, None);

        // reading_hash_1 was protected, so stale_hash_2 was evicted
        assert!(book1.exists());
        assert!(!book2.exists());

        *ACTIVE_READING_HASH.lock().unwrap() = None;

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_u35_fix_entities_rejects_xml_invalid_char_refs() {
        // Form-valid but XML-illegal refs: NUL, surrogates, out of range.
        // They used to pass through and made the served chapter a fatal
        // XML parse error.
        assert_eq!(fix_entities("a&#0;b"), "a\u{FFFD}b");
        assert_eq!(fix_entities("&#xD800;"), "\u{FFFD}");
        assert_eq!(fix_entities("&#55296;"), "\u{FFFD}");
        assert_eq!(fix_entities("&#x110000;"), "\u{FFFD}");
        // Valid refs still pass through untouched.
        assert_eq!(fix_entities("&#65;&#x41;"), "&#65;&#x41;");
        // Overflowing digit runs parse as invalid, not as a panic.
        assert_eq!(fix_entities("&#999999999999999999999999;"), "\u{FFFD}");
    }

    #[test]
    fn test_u36_strip_meta_refresh_in_served_xhtml() {
        // Either attribute order, any case, any quoting: dropped.
        let out = xml_response_body("application/xhtml+xml", br#"<html><head><meta HTTP-EQUIV='Refresh' content="0;url=https://evil.example"/><title>t</title></head></html>"#.to_vec());
        let s = std::str::from_utf8(&out).unwrap();
        assert!(!s.to_ascii_lowercase().contains("refresh"), "meta refresh survived: {}", s);
        assert!(s.contains("<title>t</title>"), "chapter content lost: {}", s);
        // Benign meta stays.
        let out2 = xml_response_body("application/xhtml+xml", br#"<html><meta name="author" content="x"/></html>"#.to_vec());
        assert!(std::str::from_utf8(&out2).unwrap().contains("author"));
        // Non-XML mimes pass through untouched.
        let passthru = b"<meta http-equiv=refresh content=0>".to_vec();
        assert_eq!(xml_response_body("text/plain", passthru.clone()), passthru);
    }

    #[test]
    fn test_u37_embedded_font_asset_name() {
        // Book-relative request with a chapter prefix resolves to the vendored
        // font asset (the whole tail after vendor/fonts/, lowercased).
        assert_eq!(
            embedded_font_asset_name("OEBPS/vendor/fonts/literata-400-normal.woff2").as_deref(),
            Some("vendor/fonts/literata-400-normal.woff2")
        );
        assert_eq!(
            embedded_font_asset_name("SomeChapter/vendor/FONTS/Lexend-600-NORMAL.WOFF2").as_deref(),
            Some("vendor/fonts/lexend-600-normal.woff2")
        );
        assert_eq!(
            embedded_font_asset_name("OEBPS\\vendor\\fonts\\opendyslexic-400-normal.woff2").as_deref(),
            Some("vendor/fonts/opendyslexic-400-normal.woff2")
        );
        // Only webfonts qualify — never a book file that merely lives under a
        // same-named directory, and never anything without the marker path.
        assert_eq!(embedded_font_asset_name("OEBPS/vendor/fonts/payload.html"), None);
        assert_eq!(embedded_font_asset_name("OEBPS/vendor/fontface/x.woff2"), None);
        assert_eq!(embedded_font_asset_name("OEBPS/images/pic.woff2"), None);
        // Traversal attempts cannot escape: the matched tail is an embedded
        // asset-table key, not a filesystem path — but anything beyond the
        // font tail is simply not a font name.
        assert_eq!(embedded_font_asset_name("../../vendor/fonts/literata-400-normal.woff2").as_deref(),
            Some("vendor/fonts/literata-400-normal.woff2"));
    }
}
