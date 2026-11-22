# Code review — `src-tauri/src/lib.rs` (Tauri backend)

> Read-only review of the full file (2,314 lines), Nov 12 2026. Context files read:
> `main.rs`, `tauri.conf.json`, `Cargo.toml`, `capabilities/default.json`, plus
> targeted reads of `src/index.html`. **No code was changed.**

## Contract cross-check (verified — no payload/field mismatches)

Registered commands, `lib.rs:1256–1261`:

| `#[tauri::command]` | Defined | Frontend call (index.html) | Match |
|---|---|---|---|
| `get_initial_file` | 12–15 | `invoke('get_initial_file')` L11313 | ✅ |
| `read_file_bytes` | 210–242 | `invoke('read_file_bytes', { path })` L5205, L11296 | ✅ |
| `book_open` | 587–666 | `invoke('book_open', { path })` L5205, L11283 | ✅ |
| `pick_file` | 244–250 | `invoke('pick_file')` L10171 | ✅ |

- `BookHandle` (268–273) serializes `hash` / `cache_dir` / `manifest`; the frontend
  only consumes `handle.hash` — ✅. Hash format `{16-hex}_{len}_{mtime_ms}` matches
  the frontend regex (index.html:3407) — ✅.
- Cache URL `http://folio-cache.localhost/<hash>/` is parsed by
  `parse_cache_uri_hash_and_rel` (1092–1107) — ✅.

**One mismatch → M-5 below**: the frontend listens for event `'open-epub-file'`
(index.html:11316–11320) but **no Rust code emits any event** (grep for
`emit`/`emit_to`/`emit_all` across `src-tauri` returns nothing). Single-instance
forwards via `win.eval("window.__folioOpenPath(...)")` (1250–1252) instead. The
listener is dead code.

---

## High

### H-1. Origin allowlist and `frame-ancestors` omit the actual Windows production origin `http://tauri.localhost`
**Lines:** 1147–1156 (allowlist + fallback), 1212 (served CSP `frame-ancestors`), `tauri.conf.json:24`.

```rust
let allow_origin = if req_origin == "tauri://localhost"
    || req_origin == "http://localhost"
    || req_origin == "https://tauri.localhost"
    || req_origin == "http://folio-cache.localhost"
    || is_dev_origin
{ req_origin } else { "tauri://localhost" };   // fallback never matches on Windows
```

- `tauri.conf.json` does not set `useHttpsScheme`, so on Windows the webview
  origin is `http://tauri.localhost` — in **neither** the ACAO allowlist nor the
  static `frame-ancestors 'self' tauri://localhost https://tauri.localhost` header.
- Effect (if WebView2 enforces these headers on scheme-handler responses): every
  cross-origin `fetch` the main window makes to `http://folio-cache.localhost`
  (how epub.js loads book bytes/chapters) gets ACAO `tauri://localhost` → blocked;
  chapter iframes embedded from `http://tauri.localhost` are refused by
  `frame-ancestors`. Requests originating *inside* the folio-cache iframe are
  covered (L1150), which is why partial functionality can still appear to work.
- Dev builds work only because `is_dev_origin` (1142–1146) matches
  `http://localhost:<port>`; release builds have `is_dev_origin = false`.
- Caveat: WebView2's enforcement of CSP/CORS on `AddWebResourceRequestedFilter`
  responses is not fully consistent with a normal HTTP server — **verify at
  runtime**. Either way the allowlist should include `http://tauri.localhost`
  (and `https://folio-cache.localhost` for the https-scheme flavor).

---

## Medium

### M-1. Concurrent `book_open` for the same book races `remove_dir_all` against extraction
**Lines:** 612–640 (reunzip branch), 624 (`fs::remove_dir_all`), 625/634 (`create_dir_all`), 628–639 (unpack).

Two simultaneous `book_open` calls for the same path (double-click, duplicate
drag-drop, two rapid invokes — nothing serializes them) both compute the same
hash and both enter the stale/missing-manifest branch. Thread A can run
`remove_dir_all(&target_dir)` while thread B is mid-`unzip_epub` writing into the
same directory: extraction fails mid-flight, `manifest.json` deleted by A after B
wrote it, and the scheme handler can 404 mid-read. No per-hash in-flight lock.

### M-2. Eviction can delete the book currently being read (only the *last opened* book is protected)
**Lines:** 604–606 (protection scope), 552 (`ACTIVE_READING_HASH` check), 573–584 (eviction loop), 461–467 (`EvictRunGuard`).

`HashProtectionGuard` (605) only lives for the duration of `book_open`; after it
returns, protection depends on `ACTIVE_READING_HASH` — a single `Option<String>`
**overwritten on every open** (606). Sequence: open book A → open book B → A is
no longer protected; if the 600 MB / 30-book caps trip, `evict_disk_cache`
(spawned 647–655) deletes A's directory while its chapters are still being
rendered → in-flight and future chapter fetches 404.
`EvictRunGuard::drop` → `unprotect_book_hash` (464) additionally removes a set
entry another `book_open` may have added (strings, not refcounts), so protection
windows can end early. `protect_dir_name` (653) only protects the hash that
*spawned* the eviction run.

### M-3. TOCTOU / path-validation gaps in `book_open` and `read_file_bytes`
**Lines:** 156–163 (textual UNC rejection), 198–202 (symlink check on final component only), 378 (`unzip_epub` re-opens by path), 592 (`fs::metadata` by path).

- `read_file_bytes` correctly opens-then-stats the *handle* (221–222).
  `book_open` does not: it stats by path (592), validates, then `unzip_epub`
  opens the path **again** (378). A file swapped/replaced by a symlink between
  validation and open defeats the checks (per-entry/total caps at 376–377,
  403/417–419 do bound the blast radius).
- The symlink check (198–202) covers only the final path component. Intermediate
  **junctions/symlinks** in the path are followed silently: a pre-existing
  junction `C:\links\j → \\server\share` makes `C:\links\j\book.epub` pass all
  checks, and `File::open` still triggers SMB negotiation — the exact threat the
  UNC-rejection comment (156–163) says it prevents. Needs canonicalization
  (`dunce::canonicalize` + re-check) or component-wise reparse-point checks.
- Threat model: reachable from a compromised renderer via IPC; the extension
  allowlist limits disclosure to `.epub/.mobi/.azw/.azw3` names.

### M-4. Renderer-driven memory amplification in `read_file_bytes`
**Lines:** 216 (unbounded `spawn_blocking`), 223–236 (512 MB per call), 237 (`bytes.clone()` unconditional).

- Every `invoke('read_file_bytes')` spawns a blocking task that can materialize
  up to 512 MB; concurrency is unbounded (no semaphore). A compromised renderer
  looping the command can allocate N × 512 MB (+ clone) → OOM. The `BookCache`
  caps memory at 160 MB *after the fact* (60, 104–111) but doesn't cap
  concurrent reads.
- L237: `cache.put(clean_str, &meta, bytes.clone())` clones the full buffer
  **before** `put`'s oversized check (104) — for a 512 MB book the clone is made
  then immediately discarded. Check `bytes.len()` against the budget at the call
  site (or pass ownership and return a flag).

### M-5. Single-instance forwarding can silently drop paths; `'open-epub-file'` listener can never fire
**Lines:** `lib.rs` 1250–1252; `index.html` 11316–11320, 11371.

```rust
let js = format!("window.__folioOpenPath && window.__folioOpenPath({});", ...);
let _ = win.eval(&js);
```

If the eval lands before the frontend script defines `window.__folioOpenPath`
(defined at the bottom of index.html), the `&&` guard makes the statement a
no-op — the opened-with path is dropped with no retry or queue; `get_initial_file`
can't help because this is the *second* instance. Also, the frontend's stated
contract — an `'open-epub-file'` event (index.html:11316–11320) — is never
satisfied: nothing in `src-tauri` emits events. Emit the event (or queue the
pending path until `__folioOpenPath` appears).

---

## Low

### L-1. Lock poisoning silently degrades the book cache
**Lines:** 82 (`.ok()?`), 98–101 (return on poison), 136–144 (aggregate getters → 0).

A panic while holding `inner` would permanently disable the cache with no
signal — every `get`/`put` becomes a silent miss. Defensible defensive coding
("likely intentional"), but `unwrap_or_else(|p| p.into_inner())` as used
elsewhere (552, 606) would be consistent.

### L-2. `validate_book_path` does not reject `..` components
**Lines:** 150–208.

`C:\public\..\private\secret.epub` passes. Exposure is bounded by the extension
allowlist and `p.is_file()` (204), so not arbitrary-file disclosure — but
combined with M-3 (junctions) it widens the reachable set. Rejecting
`Component::ParentDir` (or canonicalizing) closes it cheaply.

### L-3. Stale-cache reuse on ms-granularity mtime collision
**Lines:** 338–343 (`should_reunzip`), 345–357 (`compute_book_key`).

`mtime_ms` truncates to milliseconds and invalidation uses only
`(len, mtime_ms)` — a file rewritten with identical length within the same
millisecond is served as a "cache hit" with old content. Negligible in practice.

### L-4. `strip_meta_refresh` matches on substrings, not attributes
**Lines:** 1049–1050.

`tag.contains("http-equiv") && tag.contains("refresh")` — any meta tag whose
text merely contains both substrings is dropped entirely. Over-blocking, not
under-blocking. Likely intentional trade-off (comment cites the mobi.rs scanner).

### L-5. `unzip_epub` leaves partial extraction debris on error
**Lines:** 403–419 (early `return Err` mid-loop), 436 (manifest written last).

On "entry too large"/total-size trip, previously extracted files remain in
`target_dir` with no `manifest.json`. Self-heals on the next open (missing
manifest → `remove_dir_all` at 624), but in between the scheme handler can serve
stale partial chapters. Consider cleanup on the error path.

### L-6. Eviction can permanently exceed the byte cap when everything is protected
**Lines:** 574–579. `total_books <= 1 { break }` plus all-protected dirs means
`total_bytes` can stay above `max_bytes` forever. By design; benign.

### L-7. Fixed shared temp dir in one test
**Line:** 1496 — `std::env::temp_dir().join("folio_test_evict")` has no PID
suffix, unlike every other test. Concurrent `cargo test` invocations race on it.

### L-8. `pick_file` is a sync command blocking the main thread with a modal dialog
**Lines:** 244–250. Functional on Windows, but freezes the event loop for other
IPC while the dialog is open. Acceptable for a single dialog.

---

## Non-findings (checked and cleared, for the record)

- **Protocol-handler panics:** all `.unwrap()`/`.expect("500 response")` on
  `Response::builder` (1129, 1170, 1182, 1219, 1228, 1237) use static header
  values only — infallible, not attacker-triggerable.
- **Path traversal via the cache URL:** `is_valid_cache_hash` (359–363, charset
  `[A-Za-z0-9_-]`, ≤128) blocks `..`/`/`/`:`/`\`; `sanitize_entry` (307–336)
  rejects ParentDir, RootDir, Prefix, colons, reserved device names,
  trailing-dot/space components; percent-decoding happens exactly once before
  sanitization (1173–1174, tested 1638–1653). Double-encoding stays inert.
  `cache_root.join(hash).join(clean_rel)` cannot escape.
- **Panics on untrusted text:** all slicing in `fix_entities` (866–957) and
  `strip_meta_refresh` (1015–1070) is on ASCII-derived indices; `u32::from_str_radix`
  overflow funnels to U+FFFD (919, tested 2297). No UTF-8 boundary violations.
- **Integer overflow:** extraction totals use `saturating_add` (417); size
  checks compare `u64` (223, 234).
- **Deadlocks:** the three mutexes (`BookCache.inner`, `ACTIVE_READING_HASH`,
  `ACTIVE_BOOK_HASHES`) are each locked singly, never nested; `EVICT_IN_FLIGHT`
  is an atomic swap with a panic-safe `Drop` reset (456–467).

## Config observations (from companion files)

- **`tauri.conf.json` has no `app.withGlobalTauri: true`**, yet `index.html`
  uses `window.__TAURI__` (event listen at 11377, `opener.openUrl`/`shell.open`
  fallbacks in the Footnotes popup). Without the flag the `__TAURI__` global
  doesn't exist in Tauri v2, so those paths silently no-op (the event-listener
  path is dead per M-5 anyway; footnote links fall back to `window.open`,
  which may be blocked in the WebView2 build — see the configs review).
- `Cargo.toml` has no `[profile.release]` tuning (LTO/opt-level/strip) — build
  size/perf opportunity, not a correctness bug.
