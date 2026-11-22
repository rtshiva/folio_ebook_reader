# Aurefolia — code review guide

> A map of the codebase for reviewers: what each part does, the contracts it
> must keep, where the sharp edges are, how to run the tests, and a checklist
> that turns a review into a repeatable pass.
>
> This is a **review aid**, not product documentation. It reflects the tree as
> of Nov 12 2026. No product code is changed by the review files.

## 1. How to use this guide

1. Read §3 (architecture) and §4 (contracts) before opening a file — most bugs
   here are contract violations, not syntax errors.
2. Use §5 (hot spots) to pick where to look; use §6 (bug index) to avoid
   re-reporting known issues.
3. Run the relevant commands in §7 before and after a change.
4. Walk §8 (checklist) against the diff.
5. Record new findings in a **new** file under `bugs/`, following the existing
   format, and add it to `bugs/README.md`.

## 2. Repository map

```
.
├─ README.md                      # user-facing overview, build/run, feature list
├─ docs/
│  ├─ CODE_REVIEW_GUIDE.md        # this file
│  └─ screenshots/
├─ bugs/                          # review-only reports (no code changes)
│  ├─ README.md                   # index + overlap notes
│  ├─ bugs_found.md               # independent pass: lib.rs/mobi.rs/tests/voice
│  ├─ mobi-rs-review.md           # deep MOBI parser review
│  ├─ lib-rs-review.md            # deep Tauri backend review
│  ├─ index-html-review.md        # frontend review (18 items)
│  ├─ configs-and-tooling-review.md
│  └─ additional-review.md        # this review's 24 follow-up findings
├─ tauri_epub_reader/
│  ├─ package.json                # scripts: dev/build/lint/scan/test
│  ├─ playwright.config.mjs       # http-server on :8124, 19 specs, 1 worker
│  ├─ eslint.config.mjs           # flat config for inline <script>
│  ├─ src/
│  │  ├─ index.html               # ~10.9k lines: entire frontend + inline JS
│  │  ├─ assets/                  # fonts, ornaments, page-art.js
│  │  └─ vendor/                  # epub.js, JSZip, kitten TTS + node stubs
│  ├─ src-tauri/
│  │  ├─ Cargo.toml
│  │  ├─ tauri.conf.json          # CSP, window, security
│  │  ├─ capabilities/default.json
│  │  ├─ deny.toml                # cargo-deny policy (currently unused by CI)
│  │  └─ src/
│  │     ├─ main.rs               # 5 lines: windows_subsystem + run()
│  │     ├─ lib.rs                # ~2.1k lines: commands, cache, protocol, tests
│  │     └─ mobi.rs               # ~1.9k lines: MOBI/AZW3 parser + tests
│  ├─ tests/
│  │  ├─ scan-file-handling.mjs   # 27 static invariant greps
│  │  └─ e2e/                     # 19 Playwright specs + synthetic builders
│  └─ docs/                       # DESIGN_AND_LLD, FEATURES, UX plans
└─ voice_testing/                 # separate TTS bench (not shipped)
   ├─ tts_bench.mjs               # HTTP server + browser bench page
   └─ engines/ttslab_engine.py    # Python sidecar for Chatterbox/Qwen
```

## 3. Runtime architecture

### 3.1 The two halves

- **Frontend:** one static `index.html` with an inline `<script>`. No build
  step. It renders the shelf/reader chrome and hosts an `<iframe>` per chapter
  via epub.js.
- **Backend:** a Tauri v2 Rust process. It validates paths, opens/extracts
  books, keeps an in-memory byte cache, and serves extracted files through a
  custom URI scheme.

### 3.2 Open → cache → protocol → iframe

```
user picks a file (dialog, drag-drop, argv/Open-With)
        │
        ▼
frontend invoke('pick_file') / invoke('get_initial_file')   [optional]
        │
        ▼
frontend invoke('book_open', { path })
        │
        ▼
lib.rs::book_open (spawn_blocking)
  1. validate_book_path        (extension, ADS, symlink, is_file)
  2. fs::metadata              (size cap 512 MB)
  3. compute_book_key          (sha256(path)[..16]_len_mtime)
  4. BookCache lookup          (4 entries / 160 MB, LRU)
  5. cache hit? → return handle
     cache miss? → unzip_epub / mobi::convert_to_epub
        → app_cache_dir()/folio-unzip/<hash>/
        → manifest.json (len + mtime)
        → evict old books (600 MB / 30 books)
        → return BookHandle { hash, cache_dir, manifest }
        │
        ▼
frontend builds 'http://folio-cache.localhost/<hash>/'
        │
        ▼
epub.js requests chapters/assets from the custom scheme
        │
        ▼
lib.rs::register_uri_scheme_protocol("folio-cache")
  1. parse host/path → (hash, rel)
  2. is_valid_cache_hash
  3. percent_decode → sanitize_entry (no traversal/ADS/reserved names)
  4. cache_root/<hash>/<rel> exists?
  5. mime_for_path
  6. xml_response_body (fix_entities + strip_meta_refresh for XML)
  7. response: Content-Type, immutable cache, CORS, CSP, nosniff
        │
        ▼
chapter <iframe> (sandboxed, strict XML)
```

### 3.3 Two book formats

- **EPUB/AZW3:** `unzip_epub` extracts entries to the cache. ZIP-slip and
  Windows-invalid names are handled by `sanitize_entry` / `is_windows_reserved_name`.
- **MOBI/AZW/AZW3 (non-KF8):** `mobi.rs` parses the PalmDB + PalmDOC + MOBI
  header, decompresses text records, rewrites images/links, splits chapters,
  sanitizes tags, and writes a synthetic EPUB (`content.opf`, `toc.ncx`,
  `ch_XXXX.xhtml`, `images/`).

### 3.4 Frontend subsystems inside `index.html`

| Subsystem | Approx. lines | Responsibility |
|---|---|---|
| Boot / settings / themes | 1280–2400 | FOUC guard, `settings`, typography, CSS generation |
| Security / sanitization | 1780–1880 | `sanitizeDomNode`, `sanitizeChapterHtml`, URL allowlist |
| Persistence (`StoreKV`) | 2490–2666 | IndexedDB KV + localStorage migration + in-memory mirror |
| `BookStorage` | 2668–2864 | IndexedDB books + persisted search index |
| Reader lifecycle | 2900–4700 | open, render, relocate, spread, turn effects |
| TOC / bookmarks / highlights / vocab | 4760–5960 | side panels and CRUD |
| Search | 5960–6300 | `SearchIndex.ensure`, `doSearch`, result rendering |
| Page cache / bionic / ornaments | 3700–4000, 6500 | per-chapter DOM cache |
| TTS + KittenRunner | 8170–8500 | system + neural read-aloud |
| Panels / command palette / settings UI | 8700–10600 | chrome and controls |
| Export / stats | 10670–10730 | Markdown export, reading stats |

## 4. Contracts and invariants

### 4.1 Tauri command contract

| Command | Input | Output | Invariants |
|---|---|---|---|
| `get_initial_file` | — | `Option<String>` | first existing ebook path in argv |
| `pick_file` | — | `Option<String>` | native dialog; **blocking** (known issue) |
| `read_file_bytes` | `{ path }` | `Vec<u8>` | validates path, honours in-memory cache |
| `book_open` | `{ path }` | `BookHandle { hash, cache_dir, manifest }` | extraction is idempotent per hash |

The frontend must use the same field names (`path`, `hash`, `cache_dir`,
`manifest`). See `bugs/README.md` for the verified end-to-end match.

### 4.2 Cache key invariant

`compute_book_key` must produce `{16 lowercase hex}_{len}_{mtime_ms}`.
`is_valid_cache_hash` should accept exactly that shape (currently too loose —
AR-10). The hash is also the directory name and the URL host/path segment, so
it must never contain `/`, `\`, `:`, or `..`.

### 4.3 Path-safety invariant

`sanitize_entry` must reject:

- any `:` (drive letters, ADS),
- absolute paths and `..` traversal,
- Windows reserved device names (`CON`, `NUL`, `COM1`…),
- empty components.

`validate_book_path` must reject symlinks, non-files, ADS, and oversized
files. Canonicalisation before hashing is desirable (AR-11).

### 4.4 Served-resource invariant

Every response should have:

- a correct `Content-Type` (media types included — AR-6),
- `X-Content-Type-Options: nosniff`,
- `Cache-Control: max-age=31536000, immutable` for content-addressed files,
- a CORS origin from the allowlist (including the real Windows origin),
- a restrictive `Content-Security-Policy` for chapter iframes.

XML documents (XHTML/OPF/NCX) must be well-formed before they reach the strict
parser. The serve path repairs UTF-8 only; extraction should not rely on it
(AR-8, `mobi-rs-review.md` M5).

### 4.5 MOBI pipeline invariant

After `convert_to_epub`:

- every chapter file is well-formed XHTML,
- every `src`/`href` points at a file that exists in the synthetic EPUB,
- `filepos` targets are byte offsets into the *converted* text (encoding
  conversion invalidates them — `mobi-rs-review.md` M2),
- no duplicate attributes (AR-1, `bugs_found.md` #5),
- attribute values are quoted and escaped (AR-2),
- event handlers and dangerous schemes are stripped (`bugs_found.md` #12).

### 4.6 Frontend persistence invariant

- `StoreKV` mirror and IndexedDB must agree after `init()`.
- Migration must never destroy a value it cannot parse (AR-12).
- A book's identity must not be its display title (AR-13).
- Reads must be synchronous from the mirror; writes are async but ordered.
- If IndexedDB is unavailable, the same keys must fall back to localStorage.

### 4.7 Chapter/iframe invariant

- Chapters are untrusted: sanitize DOM, strip scripts/iframes/objects/forms,
  remove `on*` and `javascript:` URLs.
- Internal navigation stays inside the rendition; external URLs go through the
  documented handler.
- The iframe must not be able to reach Tauri IPC (CSP `script-src 'none'` for
  the cache origin).

## 5. Hot spots

| Area | File:lines | Why it is risky |
|---|---|---|
| MOBI header parsing | `mobi.rs:154–430` | wrong offsets (known H1–H4); bounds checks are subtle |
| PalmDOC decompression | `mobi.rs:432–538` | expansion bombs, overlapping backrefs |
| Image/link rewriting | `mobi.rs:983–1295` | substring parsing, duplicate attributes, encoding drift |
| Chapter splitting/sanitizing | `mobi.rs:1380–1780` | XHTML validity, `filepos` anchors, tag sanitizer |
| Path validation | `lib.rs:150–208, 275–337` | traversal, ADS, reserved names, symlinks/junctions |
| Book cache + eviction | `lib.rs:35–148, 449–585` | LRU, byte budget, active-book protection, races |
| Protocol handler | `lib.rs:1122–1239` | origin allowlist, MIME, XML repair, methods |
| Cache key/validation | `lib.rs:345–363` | hash shape, path canonicalisation |
| Settings/migration | `index.html:2490–2666` | raw vs JSON values, quota, fallback |
| Book/search storage | `index.html:2668–2864` | title as key, stale index, eviction |
| Reader/relocation | `index.html:3198–4700` | CFI math, spread detection, page cache |
| Search | `index.html:5984–6300` | index reuse, Unicode folding, cancellation |
| TTS | `index.html:8170–8500` | engine state, blob URLs, voice selection |
| Sanitizer | `index.html:1780–1880` | XSS bypasses, scheme obfuscation |
| CI/tooling | `.github/workflows/build-installers.yml`, `eslint.config.mjs` | missing gates, undeclared deps |

## 6. Known-bug index (do not re-report)

| File | Scope | Count |
|---|---|---|
| [`bugs/mobi-rs-review.md`](../bugs/mobi-rs-review.md) | MOBI parser deep dive | 4 High, 5 Medium, 10 Low |
| [`bugs/lib-rs-review.md`](../bugs/lib-rs-review.md) | Rust backend deep dive | 1 High, 5 Medium, 8 Low |
| [`bugs/index-html-review.md`](../bugs/index-html-review.md) | Frontend | 11 confirmed + 7 minor |
| [`bugs/configs-and-tooling-review.md`](../bugs/configs-and-tooling-review.md) | Configs, CSP, tooling, regression spot-check | 1 High, 3 Medium, 3 Low |
| [`bugs/bugs_found.md`](../bugs/bugs_found.md) | Independent second pass | 15 + 1 test gap |
| [`bugs/additional-review.md`](../bugs/additional-review.md) | This review's 5 cycles | 24 (4 High, 7 Medium, 13 Low) |

Before writing a new finding, grep all six files for the function name and the
symptom. If it is already there, add a cross-reference instead of a duplicate.

## 7. Test map and commands

### 7.1 Suites

| Suite | Command | What it covers |
|---|---|---|
| Rust unit tests | `npm run test:rust` (`cd src-tauri && cargo test`) | `lib.rs` path/cache/entity helpers + `mobi.rs` parser/sanitizer (47 tests) |
| Static scan | `npm run scan` (`node tests/scan-file-handling.mjs`) | 27 string invariants: single boot-open, IPC byte shapes, entity case, open paths, UTF-8 serve, drag-drop, edge zones, idle dim |
| Playwright e2e | `npm run test:e2e` (`playwright test`) | 19 specs: layout, bookish, switching, chapter nav, design, edge stacks, MOBI, nonlinear, margins, ornaments, page turn, reading room, security, storage, TOC, TTS, typography, vocabulary |
| Lint | `npm run lint` (`eslint .`) | inline script + tests/configs |
| Full | `npm test` | rust + scan + e2e |

### 7.2 Local setup

```powershell
cd tauri_epub_reader
npm ci
npm run test:rust      # Rust only
npm run scan           # static invariants
npm run test:e2e       # starts http-server on :8124
npm run lint
```

The e2e suite runs against `src/` with `http-server` (no Tauri). Native
commands are mocked/stubbed in the specs, so e2e **cannot** catch Rust
regressions.

### 7.3 What the tests do *not* cover

- No real `.epub`/`.mobi` fixtures — MOBI tests use a synthetic builder that
  encodes the parser's own wrong offsets (`mobi-rs-review.md` test-fixture
  note).
- No tests for the custom URI scheme, CORS, HEAD/OPTIONS, or MIME types.
- No tests for `StoreKV` migration of raw values or same-title books.
- The voice bench is manual (GPU/venv required).

## 8. Review checklist

### 8.1 General

- [ ] Does the change keep the command/field contract (`path`, `hash`,
      `cache_dir`, `manifest`)?
- [ ] Are all new paths validated (`validate_book_path` / `sanitize_entry`)?
- [ ] Are all new strings that reach XML escaped (`escape_xml`, `fix_entities`)?
- [ ] Are new attributes quoted and free of duplicates?
- [ ] Are new files served with the right MIME and `nosniff`?
- [ ] Does any new state survive a book switch / window reload?
- [ ] Are new listeners, timers, object URLs, and observers cleaned up?
- [ ] Is the new code reachable in a release build (not behind a dead
      `window.__TAURI__` branch)?
- [ ] Does the change preserve the "single boot-open path" invariant?

### 8.2 Rust / backend

- [ ] Every slice index is bounds-checked or clamped; no `unwrap()` on
      untrusted data.
- [ ] Decompression and allocation are capped (`decompress_palmdoc_capped`,
      256 MB text, 512 MB file).
- [ ] Cache keys are canonical and validated to the exact shape.
- [ ] Eviction cannot delete the active book or a protected hash.
- [ ] Errors return `Result`/`Option`, never panic across the IPC boundary.
- [ ] Concurrency: no lock held across I/O; no TOCTOU between check and use.
- [ ] Protocol handler handles `GET`/`HEAD`/`OPTIONS` and rejects others.
- [ ] XML repair runs for UTF-8 documents; non-UTF-8 is either transcoded or
      documented as unsupported.

### 8.3 MOBI parser

- [ ] Header fields use record-0-relative offsets (see
      `mobi-rs-review.md`).
- [ ] `filepos` offsets account for encoding conversion.
- [ ] `recindex`/cover mapping reserves slots for non-image records.
- [ ] Tag scanning is bounded (`find_tag_end_bounded`) and quote-aware.
- [ ] Attribute parsing is not a substring search.
- [ ] Output XHTML has no duplicate/invalid attributes and is well-formed.
- [ ] Sanitizer removes `on*`, `javascript:`, `vbscript:`, `data:text/html`
      (including entity-obfuscated forms).

### 8.4 Frontend

- [ ] Persistence uses a stable book id, not the title.
- [ ] Migration preserves unparseable raw values.
- [ ] `innerHTML` is used only with trusted/escaped strings; user/book text
      goes through `textContent` or the sanitizer.
- [ ] Search results use the original string for slicing, not a folded copy.
- [ ] TTS previews revoke blob URLs on all exit paths.
- [ ] Settings validation only touches keys that exist in `DEFAULTS`.
- [ ] Panel/popup closers are removed before re-adding.
- [ ] Page cache is captured after bionification/ornaments.
- [ ] CFI/position keys include a book identity, not just title.

### 8.5 Tests / CI

- [ ] New behavior has a Rust unit test or a Playwright spec.
- [ ] The static scan still passes (no invariant was weakened).
- [ ] CI runs lint + e2e (currently missing — AR-17).
- [ ] `cargo deny` and `clippy --all-targets` are part of the gate (AR-18).
- [ ] Fixtures are spec-conformant, not copies of the parser's assumptions.
- [ ] Documented counts/commands match reality (AR-20).

## 9. Severity rubric

| Level | Meaning |
|---|---|
| **Critical** | Data loss, RCE/XSS, or every book of a format fails to open |
| **High** | A common book renders blank/garbled, or user data is silently lost/overwritten |
| **Medium** | A feature is broken for a subset of books/inputs, or a protocol/security invariant is weakened |
| **Low** | Cosmetic, edge-case, hardening, or documentation drift |

When unsure, pick the lower level and state the conditions that would raise it.

## 10. Known doc drift and gotchas

- `tauri_epub_reader/docs/DESIGN_AND_LLD.md` claims 42 Rust tests; actual is 47.
- `eslint.config.mjs` cites `docs/CODE_QUALITY.md`, which does not exist.
- `README.md` describes `npm test` as if CI runs it; the build workflow does
  not run the e2e or lint steps.
- `voice_testing/README.md` and module headers still reference old
  `tests/manual/...` paths.
- `bugs/index-html-review.md` items were mostly fixed in `de477a1`/`893e8e3`;
  the remaining duplicate CSS is tracked as C-2 in
  `configs-and-tooling-review.md`.
- The `folio-cache` protocol is also spelled `http://folio-cache.localhost/`
  in the frontend; both forms must be handled.

## 11. Adding a review

1. Pick a cycle (one file/area).
2. Read the corresponding deep-dive file first (§6).
3. Verify each candidate against the actual source; prefer a failing input or
   a precise state transition over a hunch.
4. Write `bugs/<area>-review-<n>.md` with: severity, file:line, code excerpt,
   impact, repro/trigger, suggested fix, and overlap note.
5. Add the file to `bugs/README.md` and update this guide's §6 table.
6. Do not change product code unless the user explicitly asks for fixes.
