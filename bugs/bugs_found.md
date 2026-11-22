# Bug review — Rust backend, MOBI parser, and voice-testing tools

> Review-only pass. **No code was changed.** Reviewed: Nov 12 2026.
>
> Scope: everything **except** `tauri_epub_reader/src/index.html` (that file is
> already covered by `bugs/index-html-review.md`). Findings below are from
> `src-tauri/src/lib.rs`, `src-tauri/src/mobi.rs`, the Tauri config/capabilities,
> the e2e helpers/specs, and the `voice_testing/` tools.
>
> Files reviewed: `src-tauri/src/{lib,mobi,main}.rs`,
> `src-tauri/{Cargo.toml,tauri.conf.json,capabilities/default.json}`,
> `tests/e2e/{helpers.mjs,mobi.spec.mjs}`, `tests/scan-file-handling.mjs`,
> `playwright.config.mjs`, `eslint.config.mjs`, `package.json`,
> `voice_testing/{tts_bench.mjs,README.md,engines/ttslab_engine.py}`.
> No issues found in `main.rs` or `capabilities/default.json`.

## Severity summary

| # | Severity | Area | Summary |
|---|----------|------|---------|
| 1 | **Critical** | MOBI parser | Every `MobiHeader` field is read at the wrong offset (16-byte shift), so EXTH metadata, covers, KF8 detection and trailing-entry flags are all wrong |
| 2 | **High** | MOBI parser | The `header_len >= 244` guard excludes every normal 228/232-byte MOBI6 header, so trailing text entries are never stripped |
| 3 | **High** | MOBI parser | EXTH strings are always decoded as UTF-8, corrupting CP1252 author/title/publisher metadata |
| 4 | **High** | EPUB unpack | One Windows-invalid filename (or overlong path) aborts extraction of the entire book instead of skipping the entry |
| 5 | **High** | MOBI parser | `<img src = "...">` is not recognised, so a second `src` is appended → duplicate XML attribute → fatal chapter parse error |
| 6 | **Medium** | MOBI + protocol | BMP images are extracted, but `mime_for_path` has no `bmp` case, so they are served as `application/octet-stream` with `nosniff` |
| 7 | **Medium** | MOBI parser | Cover selection compares EXTH `coveroffset` to the index of *successfully extracted* images, not the record offset |
| 8 | **Medium** | Voice bench | `num()` treats a missing query parameter as `0`, so defaults never apply and values clamp to the minimum |
| 9 | **Medium** | Voice bench | Hard-coded `F:/Siva_f/...` repo path and stale usage comments; the default Piper path does not exist |
| 10 | **Medium** | Voice engine | `_nano_ref_clip()` resolves the Piper root three levels up, landing on `F:\Siva_f` instead of the repo |
| 11 | **Medium** | Voice bench | Python sidecars are never tracked/killed, and concurrent `/tts` calls can spawn duplicates on the same port |
| 12 | **Low** | MOBI sanitizer | `<style>`/CSS passes through and entity-obfuscated `javascript:` bypasses the substring check |
| 13 | **Low** | MOBI parser | Undefined CP1252 bytes map to C1 control characters instead of replacement characters |
| 14 | **Low** | Tauri command | `pick_file` is a synchronous command that opens a blocking native dialog |
| 15 | **Low** | EPUB unpack | Duplicate zip entry names silently overwrite each other and produce duplicate manifest rows |

---

## Confirmed bugs

### 1. [Critical] MOBI header fields are read 16 bytes off — EXTH metadata, cover, KF8 and trailing flags are broken

**File:** `tauri_epub_reader/src-tauri/src/mobi.rs:155-229`

`MobiHeader::parse` slices off the 16-byte PalmDOC header:

```rust
let mobi = &data[16..];          // line 161
```

The MOBI spec offsets (as published on MobileRead) are measured from the **start
of record 0**, i.e. they include that PalmDOC header. The code then indexes
`mobi[...]` using the *record-absolute* numbers, which shifts every field by 16
bytes. The header length, type, encoding, UID and version at the top of the
struct happen to be read correctly (they use `mobi[4..]`, `mobi[8..]`, etc.),
but the fields below are not:

| Field | Correct record offset | Correct `mobi[]` index | Code reads | What it actually reads |
|-------|----------------------|------------------------|------------|------------------------|
| First non-book index | `0x50` (80) | `64` | `mobi[112]` | EXTH flags (`0x80` / 128) |
| Full name offset | `0x54` (84) | `68` | `mobi[84]` | Output language (`0x64` / 100) |
| Full name length | `0x58` (88) | `72` | `mobi[88]` | Min version (`0x68` / 104) |
| First image index | `0x6C` (108) | `92` | `mobi[64]` | First non-book index (`0x50` / 80) |
| EXTH flags | `0x80` (128) | `112` | `mobi[80]` | Input language (`0x60` / 96) |
| Extra record data flags | `0xF0` (240) | `224` | `mobi[242]` | Unknown MOBI-header tail bytes (record 258) |
| KF8 boundary | EXTH record **121** | — | `mobi[192]` | FLIS record number (`0xD0` / 208) |

Consequences:

- **EXTH metadata is effectively never parsed.** For an English book the
  "EXTH flags" value read by the code is actually the input-language LCID
  (en-US is `0x0409`; `0x0409 & 0x40 == 0`). The `if (mobi_hdr.exth_flags & 0x40) != 0`
  gate at `mobi.rs:280` therefore stays false, so author stays `"Unknown"`,
  publisher/description/ISBN stay `None`, language stays `"en"`, and
  `cover_offset` stays `None`.
- **Title extraction is wrong.** `title_offset` is read from the output-language
  field (usually `0`, so the `title_offset > 0` check fails) and `title_len`
  from the min-version field. The book title falls back to the 31-byte PDB
  database name, or — when the output-language field is non-zero — slices
  arbitrary bytes.
- **Covers are never emitted**, because `cover_offset` is `None`.
- **KF8 combo detection never triggers.** The code reads the FLIS record number
  and then checks `pdb.records[flis_idx].data.starts_with(b"BOUNDARY")`, but the
  FLIS record starts with `"FLIS"`. KF8/AZW3 combo files therefore open as the
  legacy MOBI6 half.
- **Image numbering can be shifted.** `first_image_index` is taken from the
  first-non-book field. In many books those two are equal, so image extraction
  often works by accident; when a non-image record sits before the images, the
  `img_NNNN` numbering and `recindex` mapping are off.

**Why the tests pass:** the synthetic builders encode the *same wrong offsets*:

- `tauri_epub_reader/tests/e2e/helpers.mjs:199-201`
  (`setUint32(64, 2)` labelled "first image index", `setUint32(80, 0x40)` for
  EXTH, `setUint32(112, 3)` for first non-book)
- `tauri_epub_reader/src-tauri/src/lib.rs:1913-1915`
  (`mobi_hdr[64..68]`, `mobi_hdr[80..84]`, `mobi_hdr[112..116]` with the same
  comments)

Because both the writer and the reader are shifted the same way, the Rust
round-trip test and the e2e fixtures never exercise a real MOBI layout.

**Suggested fix:** read the fields at the spec offsets (`mobi[64]`,
`mobi[68]`, `mobi[72]`, `mobi[92]`, `mobi[112]`, `mobi[224]`), take the KF8
boundary from EXTH record 121, and update the length guards accordingly
(e.g. `mobi.len() >= 96` for the image index). Then fix both synthetic
builders so they follow the spec, and add at least one real `.mobi`/`.azw3`
fixture.

---

### 2. [High] Extra-data-flag guard rejects every normal MOBI6 header

**File:** `tauri_epub_reader/src-tauri/src/mobi.rs:198-202`

```rust
let extra_flags = if mobi.len() >= 244 && header_len >= 244 {
    u16::from_be_bytes([mobi[242], mobi[243]])
} else {
    0
};
```

The Extra Record Data Flags field lives at record offset `0xF0` (240), i.e.
MOBI-relative offset `0xE0` (224), and the spec says it is valid when the header
length is **228 or 232**. The code requires `header_len >= 244`, which excludes
the standard 228/232-byte headers produced by KindleGen and MobiPocket Creator.
For those books `extra_flags` is always `0`, so `strip_trailing_entries`
(`mobi.rs:420`) returns the record untouched.

Trailing entries (multibyte overlap bytes, TBS indexing data, uncrossable-break
data) are then fed to the PalmDOC decompressor as if they were compressed text.
That produces garbage bytes at the end of each 4 KiB text record, and can also
produce "invalid distance" errors. On uncompressed books the trailing bytes
appear directly in the chapter text.

**Suggested fix:** read the flags at `mobi[224..226]` (or the 4-byte field at
`mobi[224..228]`) and guard with `header_len >= 228`. Keep the bit-order logic
in `get_size_of_trailing_data_entries` as-is.

---

### 3. [High] EXTH string metadata is decoded as UTF-8 even for CP1252 books

**File:** `tauri_epub_reader/src-tauri/src/mobi.rs:322-366`

The full-name title path correctly checks `mobi_hdr.encoding == 1252` and calls
`cp1252_to_utf8` (`mobi.rs:268-272`). Every EXTH string uses
`String::from_utf8_lossy` instead:

- author (type 100) — `mobi.rs:324`
- publisher (101) — `mobi.rs:331`
- description (103) — `mobi.rs:335`
- ISBN (104) — `mobi.rs:339`
- updated title (503) — `mobi.rs:355`
- language (524) — `mobi.rs:362`

For a CP1252 book, bytes such as `0xE9` ("é") are invalid UTF-8, so the
metadata is rendered with U+FFFD replacement characters
(`Auteur ?` / `Caf?`). This is user-visible in the library/shelf and the book
details panel.

**Suggested fix:** use a small helper that mirrors the title path:

```rust
let decode = |b: &[u8]| if mobi_hdr.encoding == 1252 {
    cp1252_to_utf8(b)
} else {
    String::from_utf8_lossy(b).to_string()
};
```

and apply it to every EXTH text record.

---

### 4. [High] One Windows-invalid filename aborts the whole EPUB extraction

**Files:** `tauri_epub_reader/src-tauri/src/lib.rs:307-336`, `lib.rs:390-425`

`sanitize_entry` rejects:

- any colon (drive letters / ADS),
- Windows reserved device names,
- components with trailing dots/spaces,
- `..`/absolute components.

It does **not** reject the other characters Windows forbids in filenames:
`< > " | ? *`, control characters `0x00-0x1F`, or paths longer than `MAX_PATH`.
When such an entry is encountered, the extraction loop does:

```rust
let outfile = fs::File::create(&out_path)
    .map_err(|e| format!("Cannot create file: {}", e))?;   // line 410
```

The `?` aborts `unzip_epub` and therefore the whole `book_open`, even though the
bad entry could simply be skipped (the rest of the EPUB is perfectly readable).
A malicious or merely sloppy EPUB can make a book unopenable this way.

**Suggested fix:** extend `sanitize_entry` to reject/replace the remaining
Windows-invalid characters and overlong paths, and/or treat a per-entry
`File::create` failure as a warning + `continue` instead of a fatal error. (Path
traversal itself is already handled correctly.)

---

### 5. [High] `rewrite_img_tag` does not tolerate whitespace around `=`, producing duplicate `src` attributes

**File:** `tauri_epub_reader/src-tauri/src/mobi.rs:1033-1164`

All attribute searches use the literal `"recindex="`, `"src="`, etc.:

```rust
if let Some(pos) = lower.find("recindex=") { ... }   // line 1042
if let Some(pos) = lower.find("src=") { ... }        // line 1076 / 1133
```

A tag written as `<img src = "1" recindex="1">` is legal HTML/XML whitespace,
but `find("src=")` does not match `src =`. After the `recindex` rewrite, the
`else` branch appends a *new* `src`:

```rust
format!("{} src=\"{}\"/>", trimmed.trim_end(), new_src)   // line 1151
```

The result is `<img src = "1" src="images/img_0001.jpg"/>`. The tag is then
passed through `sanitize_html_tag`, which preserves both `src` attributes, and
the chapter is served as `application/xhtml+xml`. Duplicate attributes are a
fatal XML well-formedness error, so the **entire chapter fails to render**.

The same literal search also matches inside other attribute names:

- `<img hisrc="cover480x640.gif" src="cover220x300.gif">` → `find("src=")` matches
  the `src=` inside `hisrc=`, so the code inspects the wrong attribute. With a
  numeric `hisrc="1"` it rewrites `hisrc` (leaving `hisrc="images/..."`) and
  leaves the real `src` untouched; with a filename value it finds no numeric
  image reference at all and the real `src` is never rewritten.
- `data-src=`, `losrc=`, etc. have the same problem.

**Suggested fix:** parse attributes rather than substring-search, or at minimum
use a whitespace-tolerant matcher (`\bsrc\s*=\s*`) and replace the existing
`src` value in place. Do the same for `recindex`/`filepos`/`kindle:embed`.

Related, lower-impact: the `recindex` removal loop (`mobi.rs:1096-1126`) scans
raw characters, so text like `alt="see recindex=5"` inside another attribute
value can be stripped.

---

### 6. [Medium] BMP images are extracted but served as `application/octet-stream`

**Files:** `tauri_epub_reader/src-tauri/src/mobi.rs:561-562`,
`tauri_epub_reader/src-tauri/src/lib.rs:963-987`

`detect_image_format` explicitly recognises BMP:

```rust
} else if data.starts_with(b"BM") {
    Some(("bmp", "image/bmp"))
```

The extracted file is written as `images/img_NNNN.bmp`, but `mime_for_path` has
no `"bmp"` arm and falls through to `"application/octet-stream"`. The custom
protocol also sets `X-Content-Type-Options: nosniff` (`lib.rs:1205`), so the
WebView will not sniff the bytes as an image and the picture does not render.

**Suggested fix:** add `"bmp" => "image/bmp"` (and consider `"avif"`/`"jxl"`
if those formats are ever added to `detect_image_format`).

---

### 7. [Medium] Cover selection uses the extracted-image index, not the record offset

**File:** `tauri_epub_reader/src-tauri/src/mobi.rs:772-787`

EXTH record 201 (`coveroffset`) is defined as an offset to add to the MOBI
header's first-image record. The code instead compares it to the enumerate index
of `extracted_images`:

```rust
for (idx, img) in extracted_images.iter().enumerate() {
    ...
    if idx == cov_off || idx + 1 == cov_off {
        cover_item_id = Some(format!("img_{:04}", idx + 1));
    }
}
```

If any record between `first_image_index` and the cover is not a recognised
image (a padding record, an index record, an unsupported format), the enumerate
index no longer equals the record offset and the wrong image becomes the cover.
The `idx + 1 == cov_off` alternative is not part of the format; it is normally
overwritten by the later `idx == cov_off` iteration, but when `cov_off` is out
of range it silently selects the last image instead of leaving the cover unset.

**Suggested fix:** build a map from the relative record offset
(`rec_idx - first_image_index`) to the emitted item id, then look up `cov_off`
in that map. Drop the `idx + 1` fallback.

Note: this is currently masked by bug #1 (EXTH is not parsed, so
`cover_offset` is always `None`); it will surface as soon as #1 is fixed.

---

### 8. [Medium] `num()` treats a missing query parameter as `0`, so defaults never apply

**File:** `voice_testing/tts_bench.mjs:103-106` (used at `124-127`)

```js
const num = (u, k, def, lo, hi) => {
  const v = Number(u.searchParams.get(k));
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
};
```

`URLSearchParams.get()` returns `null` for a missing key, and `Number(null)` is
`0` — which is finite. The clamp then returns `lo`, so the `def` argument is
dead code for every call:

| Parameter | Intended default | Actual value when omitted |
|-----------|------------------|---------------------------|
| `len` | `1.0` | `0.5` |
| `noise` | `0.667` | `0.05` |
| `noisew` | `0.8` | `0.05` |
| `sil` | `0` | `0` (coincidentally correct) |

The built-in page always sends these parameters, so the UI path hides the bug;
direct `/tts` URLs and any future caller that omits a knob get the minimum
instead of the documented default, which silently invalidates A/B comparisons.

**Suggested fix:**

```js
const raw = u.searchParams.get(k);
const v = raw === null ? NaN : Number(raw);
return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
```

---

### 9. [Medium] `tts_bench.mjs` hard-codes a machine-specific repo path and stale usage comments

**File:** `voice_testing/tts_bench.mjs:5,7,17-19`

```js
const REPO = 'F:/Siva_f/ebook_reader_glm53flash/tauri_epub_reader';
const PIPER = process.env.PIPER_EXE || path.join(REPO, 'bin', 'piper', 'piper', 'piper.exe');
const MODELS = process.env.PIPER_MODELS || path.join(REPO, 'bin', 'piper', 'models');
```

Problems:

- The absolute `F:/Siva_f/...` path breaks on any other machine or checkout.
- In this repo `tauri_epub_reader/bin/` is empty; the Piper binary and models
  actually live under `tauri_epub_reader/src-tauri/target/{debug,release}/bin/piper/`.
  With no `PIPER_EXE`/`PIPER_MODELS` override the bench fails to find the voice
  models (`readdirSync(MODELS)` at line 33 throws) or `piper.exe`.
- The header comment still refers to `tests/manual/engines/ttslab_engine.py` and
  `tests/manual/piper_tune_server.mjs`, neither of which exists; the real files
  are `voice_testing/engines/ttslab_engine.py` and `voice_testing/tts_bench.mjs`.
  It also mentions a stale venv path (`F:/Siva_f/tts_lab/venv`).

**Suggested fix:** derive the repo root from `import.meta.url`, default to the
known `src-tauri/target/{debug,release}/bin/piper` locations (or search for
`piper.exe`), and update the comments to the current layout. Keep the env
overrides.

---

### 10. [Medium] `_nano_ref_clip()` resolves the Piper root one level too high

**File:** `voice_testing/engines/ttslab_engine.py:52-69` (root at line 59)

```python
root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
piper = os.path.join(root, "bin", "piper", "piper", "piper.exe")
model = os.path.join(root, "bin", "piper", "models", "en_US-lessac-high.onnx")
```

`__file__` is `.../ebook_reader_glm53flash/voice_testing/engines/ttslab_engine.py`.
Three `..` levels give `F:\Siva_f`, not the repository. The resulting paths are:

- `F:\Siva_f\bin\piper\piper\piper.exe` (does not exist)
- `F:\Siva_f\bin\piper\models\en_US-lessac-high.onnx` (does not exist)

So the first Nano synthesis raises `FileNotFoundError` or the
`"could not generate nano reference clip"` error. The actual Piper assets are in
`ebook_reader_glm53flash/tauri_epub_reader/src-tauri/target/{debug,release}/bin/piper/`.
The module header (`ttslab_engine.py:3`) is also stale (`F:/Siva_f/tts_lab/venv`,
`tests/manual/engines/`).

**Suggested fix:** make the Piper location configurable (`PIPER_EXE` /
`PIPER_MODELS` env vars, matching `tts_bench.mjs`) and default to the real
`src-tauri/target/.../bin/piper` location. Update the header comment.

---

### 11. [Medium] Sidecar processes are never tracked or killed; concurrent requests can spawn duplicates

**File:** `voice_testing/tts_bench.mjs:74-89`

`ensureSidecar` spawns a detached Python process but discards the `ChildProcess`
handle:

```js
spawn(side.py, [SIDE_SCRIPT, String(side.port), ...side.engines], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, HF_HOME },
});
```

There is no `process.on('exit'/'SIGINT'/'SIGTERM')` cleanup, so closing the bench
leaves the torch sidecars running and holding GPU memory (and port 8790/8791).
Also, `sideUp()` is checked before spawning but there is no in-flight lock: two
concurrent `/tts` requests for an engine that is not up yet can both see
`false` and spawn two sidecars on the same port. The second one fails to bind,
but the parent does not observe or report that.

**Suggested fix:** keep the child handles in a map, kill them on exit/SIGINT,
and serialize `ensureSidecar` per engine with a shared promise/lock.

---

### 12. [Low] `sanitize_html_tag` does not strip `<style>`/CSS and misses entity-obfuscated `javascript:`

**File:** `tauri_epub_reader/src-tauri/src/mobi.rs:1480-1608`

The sanitizer only inspects individual tags and checks for the literal strings
`javascript:`, `vbscript:` and `data:text/html`:

- `<style>` elements and their CSS are not removed at all.
- `href="java&#115;cript:alert(1)"` does not contain the literal `javascript:`,
  so the tag is returned unchanged. The chapter is parsed as XML, which decodes
  `&#115;` to `s`, producing a real `javascript:` URL.
- The early `has_event_handler` scan only recognises `on*` preceded by
  whitespace, `/`, or `<`. A malformed tag such as `src="x"onerror=...` (no
  whitespace) is not considered to need sanitizing and is returned as-is.

The per-chapter CSP does set `script-src 'none'` (`lib.rs:1212`), which blocks
script execution inside the rendition iframe, so this is a hardening gap rather
than an immediate RCE. It is still worth closing, especially if links are ever
forwarded to the system browser.

**Suggested fix:** strip `<style>` content (or run it through a CSS sanitizer),
decode character references before checking URI schemes, and remove the early
return so every tag goes through the attribute parser.

---

### 13. [Low] Undefined CP1252 bytes become C1 control characters

**File:** `tauri_epub_reader/src-tauri/src/mobi.rs:492-526`

`cp1252_to_utf8` maps the defined CP1252 high bytes correctly, but the fallback
is `b as char`. The five undefined CP1252 bytes (`0x81`, `0x8D`, `0x8F`, `0x90`,
`0x9D`) therefore become U+0081/U+008D/U+008F/U+0090/U+009D control characters
instead of the replacement character. They can leak into titles/author strings
and confuse rendering or copy/paste.

**Suggested fix:** map those five bytes to `'\u{FFFD}'` (or skip them) in the
`match`.

---

### 14. [Low] `pick_file` is a synchronous command that opens a blocking native dialog

**File:** `tauri_epub_reader/src-tauri/src/lib.rs:244-250`

```rust
#[tauri::command]
fn pick_file() -> Option<String> {
    let file = rfd::FileDialog::new()...pick_file();
    ...
}
```

A non-`async` Tauri command runs on the main thread by default. `rfd::pick_file`
blocks until the user dismisses the dialog. On Windows the native dialog runs its
own message loop, so this usually does not deadlock, but it does block the
WebView/main thread for the lifetime of the dialog and is fragile across
platforms (macOS in particular has stricter main-thread requirements for
dialogs).

**Suggested fix:** mark the command `#[tauri::command(async)]`, or use the
official Tauri dialog plugin, which handles the threading for you.

---

### 15. [Low] Duplicate zip entries silently overwrite and duplicate manifest rows

**File:** `tauri_epub_reader/src-tauri/src/lib.rs:390-425`

The extraction loop does not track entry names. If an EPUB contains the same
`zip_path` twice (legal in the ZIP format), the second `File::create` overwrites
the first, but both entries are pushed into `files`. The manifest then contains
duplicate `zip_path` rows, and which bytes survive depends on archive order.
This is not a security issue (the path is still sanitized), but it can make the
cache/manifest inconsistent.

**Suggested fix:** keep a `HashSet` of cleaned paths; skip (with a warning) or
rename duplicates before writing.

---

## Test coverage gap

### 16. [Test gap] No real MOBI/EPUB fixtures; synthetic builders reproduce the parser bug

**Files:** `tauri_epub_reader/tests/e2e/helpers.mjs:199-201`,
`tauri_epub_reader/src-tauri/src/lib.rs:1913-1915`,
`tauri_epub_reader/tests/e2e/mobi.spec.mjs`

There are no `.epub`/`.mobi`/`.azw3` fixtures anywhere in the repository. The
only MOBI parsing tests use `buildTestMobi` / `create_synthetic_mobi_opt`, and
both write the header fields at the *same shifted offsets* that the parser
reads (see bug #1). The e2e `mobi.spec.mjs` suite only checks frontend
behaviour (file filters, title stripping, bridge calls, DRM toast); it never
opens a real MOBI.

As a result, a real KindleGen/MobiPocket file would lose its author, cover,
publisher, description and full title, and could produce corrupted text — while
every test stays green.

**Suggested fix:** commit a tiny, freely licensed real `.mobi` (and `.azw3`)
fixture, or generate one in CI with `kindlegen`/`ebook-convert`, and assert
author/title/cover/language extraction. Also update the synthetic builders to
the real spec offsets so they remain useful as unit-test fixtures.

---

## Minor observations (not counted as confirmed bugs)

- **`mobi.rs:695-700`** — when `first_non_book_index <= first_image_index`, the
  image scan falls back to `pdb.records.len()`, walking every remaining record.
  It is bounded by the 256 MB budget and magic-byte detection, so it is mostly
  a performance issue, not a correctness one.
- **`lib.rs:19-29`** — `first_epub_arg` matches any argv that *ends with* an
  ebook extension and exists on disk, including arguments that are not intended
  as file paths. Low risk, but a `--flag=x.epub` argument could be treated as a
  book path.
- **`lib.rs:588-666`** — `book_open` removes and recreates the target cache
  directory before extraction, with no per-hash lock. Two simultaneous opens of
  the same file (double-click, recent-shelf + drag-drop) can race and delete
  each other's partially extracted files. Worth a per-hash mutex if rapid
  double-opens are observed.
- **`tauri.conf.json:24`** — the CSP allows `'unsafe-inline'` and
  `'unsafe-eval'` for scripts. This is a deliberate choice for the single-file
  app, but it substantially weakens the CSP; revisit if the inline script can be
  extracted.
