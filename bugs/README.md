# Bug review index

Review-only bug reports for this repo. **No fixes are applied from these
files unless explicitly requested** — they document findings with exact file
paths and line numbers.

## Review files

| File | Scope | Date | Findings |
|---|---|---|---|
| [`index-html-review.md`](index-html-review.md) | `tauri_epub_reader/src/index.html` (10,958-line frontend) | Nov 11 2026 | 11 confirmed bugs + 7 minor |
| [`lib-rs-review.md`](lib-rs-review.md) | `src-tauri/src/lib.rs` (Tauri backend, 2,314 lines) | Nov 12 2026 | 1 High, 5 Medium, 8 Low |
| [`mobi-rs-review.md`](mobi-rs-review.md) | `src-tauri/src/mobi.rs` (MOBI/AZW3 parser, 2,049 lines) | Nov 12 2026 | 4 High, 5 Medium, 10 Low |
| [`configs-and-tooling-review.md`](configs-and-tooling-review.md) | `tauri.conf.json`, `Cargo.toml`, capabilities, test harness, voice tools + regression spot-check of patched `index.html` | Nov 12 2026 | 4 (1 High, 3 Medium) + 3 Low |
| [`bugs_found.md`](bugs_found.md) | `lib.rs`, `mobi.rs`, e2e helpers/specs, voice tools — independent second pass | Nov 12 2026 | 15 bugs + 1 test gap |

**Overlap note:** `bugs_found.md` independently corroborates the mobi.rs
wrong-offset family (its #1/#2 = mobi-rs-review H1/H3, #7 = M3, #13 = L3, #14 =
lib.rs L-8) and lib.rs M-1 (its minor observation). It adds findings not in the
other files: EPUB extraction aborting on one Windows-invalid filename (its #4),
`src = ` whitespace producing duplicate `src` attributes → fatal XML (its #5),
BMP served as `application/octet-stream` (its #6), EXTH strings always decoded
as UTF-8 (its #3 — latent until H1 is fixed), voice-bench `num()` defaults, sidecar
cleanup, `_nano_ref_clip()` path, `sanitize_html_tag` gaps, and duplicate zip
entries (its #8–#12, #15). One small discrepancy: for the trailing-entry flags
field, this repo's review cites KindleUnpack (u16 at rec0 `0xF2` → `mobi[226]`)
while `bugs_found.md` cites the MobileRead 4-byte field (rec0 `0xF0` →
`mobi[224]`); both agree the code's `mobi[242]` is wrong — verify against a
real book when fixing.

## Highest-impact items across all files

1. **mobi.rs H1–H4** — MOBI header fields read from *wrong offsets* (EXTH never
   parsed, title truncated to the 31-byte PDB name, AZW3 boundary detection
   dead, trailing bytes never stripped). The `lib.rs` unit tests bake in the
   same wrong offsets, which is why this survived the earlier 61-finding hunt.
2. **lib.rs H-1** — the CORS/frame-ancestors allowlist omits the actual Windows
   production origin `http://tauri.localhost`.
3. **configs C-1** — `window.__TAURI__` is used in the frontend but
   `app.withGlobalTauri` is not set and no opener/shell plugin exists → those
   code paths silently no-op.
4. **mobi.rs M1 / lib.rs M-1..M-4** — O(n²) scan hang, cache-eviction races,
   TOCTOU/junction gaps, renderer-driven memory amplification.
5. **configs C-2** — duplicate highlight-popup CSS blocks (557–571 vs 585–599)
   survived the index.html remediation.

## Status of `index-html-review.md`

All 18 findings were remediated by commits **de477a1** and **893e8e3**,
except the duplicate CSS blocks now tracked as **C-2** in
[`configs-and-tooling-review.md`](configs-and-tooling-review.md).

## Verification notes

- mobi.rs offsets verified against KindleUnpack `mobi_header.py` + MobileRead
  wiki (record-0-relative: title `0x54/0x58`, first image `0x6C`, EXTH flags
  `0x80`, trail flags `0xF2`).
- Frontend↔backend command contract verified end-to-end
  (`book_open` / `read_file_bytes` / `get_initial_file` / `pick_file` all
  match; the `'open-epub-file'` event contract is unfulfilled — lib.rs M-5).
- Panic audits for both Rust files completed; the 97fed4e non-ASCII panic fix
  is confirmed complete on 64-bit targets.
