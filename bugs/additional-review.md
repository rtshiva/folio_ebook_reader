# Additional code review — five follow-up cycles

> Review-only pass. **No product code was changed.** Reviewed Nov 12 2026.
>
> This file is a *third* independent pass over areas already covered by
> [`bugs_found.md`](bugs_found.md), [`mobi-rs-review.md`](mobi-rs-review.md),
> [`lib-rs-review.md`](lib-rs-review.md),
> [`index-html-review.md`](index-html-review.md) and
> [`configs-and-tooling-review.md`](configs-and-tooling-review.md). It records
> only findings **not already reported there**; overlaps are called out per
> item and summarised at the end.
>
> Method: static reading of the source at the cited lines. No Rust or JS test
> run was performed, and there are no real `.epub`/`.mobi` fixtures in the repo
> (the e2e builders are synthetic). Severities assume the shipped Windows
> 64-bit target.

## Cycles

| Cycle | Area | New findings |
|---|---|---|
| 1 | `src-tauri/src/mobi.rs` — remaining rewrite/sanitize surface | AR-1 … AR-5 |
| 2 | `src-tauri/src/lib.rs` — serving path not covered by `lib-rs-review.md` | AR-6 … AR-11 |
| 3 | `src/index.html` — persistence/search/export beyond the 18 known items | AR-12 … AR-16 |
| 4 | Tests, configs, CI | AR-17 … AR-20 |
| 5 | `voice_testing/` bench and sidecar | AR-21 … AR-24 |

## Severity summary

| ID | Severity | Area | Summary |
|---|----------|------|---------|
| AR-1 | **High** | MOBI parser | `rewrite_a_tag` inserts `href` without removing an existing one → duplicate attribute (fatal XHTML); also corrupts quoting when `filepos=` sits inside another attribute value |
| AR-2 | **High** | MOBI parser | `sanitize_html_tag` re-emits unquoted attribute values unquoted (invalid XHTML) and truncates them at `/`, turning the rest into bogus boolean attributes |
| AR-3 | Medium | MOBI parser | `prefix_cross_chapter_links` only matches lowercase double-quoted `href="#filepos_…"`; single-quoted/uppercase/spaced forms keep dead intra-chapter links |
| AR-4 | Low | MOBI parser | `extract_chapter_title` prefix-matches `<h1`/`<h2`/`<h3`, so `<h1foo>` can be misread as a heading |
| AR-5 | Low | MOBI parser | `collect_filepos_targets` scans prose, not just markup, so `filepos=123` in `<pre>` creates spurious anchors |
| AR-6 | Medium | Serving path | `mime_for_path` has no EPUB3 audio/video types (`mp3`, `m4a`, `mp4`, `ogg`, `wav`, `webm`), so media is served `application/octet-stream` + `nosniff` |
| AR-7 | Low | Serving path | `is_xml_mime` treats `image/svg+xml` as XML, so `fix_entities`/`strip_meta_refresh` rewrite SVG |
| AR-8 | Medium | Serving path | `xml_response_body` passes non-UTF-8 XML through untouched, so UTF-16/legacy chapters keep bare `&`/undefined entities and fail strict parsing |
| AR-9 | Low | Serving path | Protocol handler advertises `GET, HEAD, OPTIONS` but never branches on method; `HEAD` returns a body and `OPTIONS` is not handled |
| AR-10 | Low | Serving path | `is_valid_cache_hash` accepts any alphanumeric/`_`/`-` string ≤128 chars, not the `{16hex}_{len}_{mtime}` format it produces |
| AR-11 | Low | Serving path | `compute_book_key` hashes the raw path string, so equivalent spellings/casing create duplicate cache directories |
| AR-12 | **High** | Frontend storage | `StoreKV.migrateLegacy` deletes legacy values that are not JSON; `folio-dict:` is stored raw and older `folio-pos:` values may be raw → dictionary/position data loss |
| AR-13 | **High** | Frontend storage | Books, search indexes and bookmarks are keyed by title only; two books with the same title share/overwrite each other's buffer, path, progress, index and bookmarks |
| AR-14 | Low | Frontend export | `exportBookData` does not pass the book title through `mdLine`, so a newline/heading in the title breaks the exported Markdown |
| AR-15 | Low | Frontend search | `renderSearchResults` slices highlights with `toLowerCase()` offsets, which drift when case-folding changes string length (e.g. `İ`) |
| AR-16 | Low | Frontend TTS | `TTS.previewVoice` creates a blob URL and revokes it only on `ended`; failed/aborted playback leaks it |
| AR-17 | Medium | CI | The build workflow never runs the Playwright e2e suite or ESLint, and `npm audit … || true` is non-blocking |
| AR-18 | Low | CI | `deny.toml` exists but no workflow runs `cargo deny`; clippy omits `--all-targets` despite docs claiming all targets |
| AR-19 | Low | Tooling | `eslint.config.mjs` imports `globals`, which is not declared in `package.json` (only hoisted transitively); it also cites a non-existent `docs/CODE_QUALITY.md` |
| AR-20 | Low | Docs | Docs claim "42 Rust tests"; the files actually contain 47 (`lib.rs` 36 + `mobi.rs` 11) |
| AR-21 | Medium | Voice bench | `synthesizePiper` calls `readFileSync` inside the `close` handler after `finally` deletes the file; a throw leaves the promise unsettled and the request hangs |
| AR-22 | Low | Voice bench | The bench page never revokes the previous `URL.createObjectURL(blob)` on each Speak |
| AR-23 | Medium | Voice sidecar | `ensureSidecar` reuses an already-running sidecar started with a narrower `SERVED` set, so `/synth?engine=nano` fails with "engine nano not served" |
| AR-24 | Medium | Voice sidecar | `_nano_ref_clip` uses a fixed shared temp path and leaves `subprocess.TimeoutExpired` uncaught; concurrent sidecars can race/partial-read the WAV |

---

## Cycle 1 — `src-tauri/src/mobi.rs`

### AR-1. `rewrite_a_tag` inserts a second `href` and can corrupt quoting
**Lines:** `mobi.rs:1167–1195` (call site `1008`)

`rewrite_a_tag` finds `filepos=` and replaces the span from `filepos=` through
its closing quote with `href="#filepos_N"`:

```rust
1190: let end_pos = pos + 8 + end_offset;
1191: return format!("{}href=\"#filepos_{}\"{}", &tag[..pos], digits, &tag[end_pos..]);
```

If the tag already has an `href`, the result has **two `href` attributes**:

```html
<a href="notes.html" filepos="10">…</a>
→ <a href="notes.html" href="#filepos_10">…</a>
```

Chapters are served as `application/xhtml+xml`; duplicate attributes are a
fatal XML parse error, so the whole chapter goes blank.

The same code also fires when `filepos=` appears **inside another attribute
value**, e.g. `<a title="filepos=5">`. `pos` points inside the quoted value, the
replacement leaves the surrounding quote in place, and the output becomes
`<a title="href="#filepos_5"">` — nested quotes and a broken tag. A
`data-filepos="5"` attribute becomes `data-href="#filepos_5"`.

**Overlap:** `bugs_found.md` #5 already covers the general “literal substring
search matches inside other attributes” class for `src=`/`recindex=`. This item
adds the *duplicate `href`* and *quote-corruption* consequences specific to
`rewrite_a_tag`.

**Suggested fix:** parse attributes (or at least confirm `filepos=` is a
standalone attribute name preceded by whitespace and followed by `=`, and that
the tag has no existing `href`) before rewriting; drop any existing `href`
rather than appending a second one.

### AR-2. `sanitize_html_tag` emits unquoted values and truncates at `/`
**Lines:** `mobi.rs:1574–1591` (emission `1603–1607`)

For a tag that needs sanitizing, the unquoted-value branch does:

```rust
1575: let val_end = after_eq
1576:     .find(|c: char| c.is_whitespace() || c == '/' || c == '>')
1577:     .unwrap_or(after_eq.len());
1578: let attr_val = &after_eq[..val_end];
...
1587: clean_attrs.push(' ');
1588: clean_attrs.push_str(attr_name);
1589: clean_attrs.push('=');
1590: clean_attrs.push_str(attr_val);
```

Two problems:

1. **Unquoted re-emission.** The original value had no quotes, and the cleaned
   attribute is written back with no quotes. XHTML requires quoted attribute
   values, so a sanitized tag can still fail strict parsing.
2. **Truncation at `/`.** `href=docs/page.html` is cut at the first `/`:
   `attr_val = "docs"`, and the remainder `/page.html` is then treated as a
   boolean attribute `page.html`. Output: `<a href=docs page.html>` — the URL
   is wrong and the extra attribute is invalid.

This only runs on tags that trip the sanitizer (an `on*` handler or a
dangerous scheme), which is exactly the hostile-input path where correctness
matters most.

**Overlap:** `bugs_found.md` #12 covers `<style>`/CSS stripping and
entity-obfuscated `javascript:` in the same function; the unquoted/slash
handling is new.

**Suggested fix:** always re-emit values quoted and escaped; do not treat `/`
as a value terminator (only whitespace/`>`), and skip a leading `/` only for
self-closing syntax.

### AR-3. `prefix_cross_chapter_links` misses non-lowercase/non-double-quoted `href`
**Lines:** `mobi.rs:1250–1271`

The first branch is an exact byte match:

```rust
1254: if html[i..].starts_with("href=\"#filepos_") {
```

It is case-sensitive and requires exactly `href="`. Source markup using
`HREF="#filepos_123"`, `href='#filepos_123'`, or `href = "#filepos_123"` is not
prefixed with the target chapter filename. Because each chapter is written to a
separate `ch_XXXX.xhtml`, those links resolve inside the *current* chapter (no
such anchor) and are dead.

The second `filepos=` branch (`1272`) runs after `rewrite_images_and_links` has
already converted most `filepos=` attributes, so it does not compensate.

**Overlap:** none.

**Suggested fix:** case-insensitively match `href`, tolerate whitespace around
`=`, and accept either quote character before extracting the digits.

### AR-4. `extract_chapter_title` prefix-matches heading tags
**Lines:** `mobi.rs:1450–1477`

```rust
1452: for heading in ["<h1", "<h2", "<h3", "<b>"] {
1453:     if let Some(pos) = lower.find(heading) {
```

`<h1` also matches `<h10>`, `<h1foo>`, etc. The code then searches for the
literal `</h1>` and can capture content from a much later, real heading, or
return a nonsense title. `<b>` is matched only in its exact form (no
attributes), so `<b class="x">` is skipped. Titles are cosmetic here, so this is
Low, but it feeds the TOC/chapter label.

**Overlap:** none.

**Suggested fix:** require a tag-name boundary (`<h1` followed by whitespace,
`>`, or `/`) and handle attributes/`</h1>` case-insensitively.

### AR-5. `collect_filepos_targets` scans prose as if it were markup
**Lines:** `mobi.rs:1205–1234`

The function walks the entire HTML string for `filepos=` / `filepos_` with no
`in_tag_at` check, unlike the rewrite path (`1240–1248`). A book containing
literal text such as `<pre>filepos=123</pre>` registers `123` as a target, and
the anchor insertion loop (`1421–1434`) then injects `<a id="filepos_123">`
into the middle of prose. That can split a word or leave an invalid anchor; it
does not create a working link.

**Overlap:** `mobi-rs-review.md` M2 covers *byte offsets* being invalidated by
encoding conversion; this is a separate false-target problem.

**Suggested fix:** apply the same `in_tag_at`/attribute-name check used by the
rewrite pass, or collect targets from the already-rewritten `<a href>` tags.

---

## Cycle 2 — `src-tauri/src/lib.rs` serving path

### AR-6. `mime_for_path` has no EPUB3 audio/video types
**Lines:** `lib.rs:963–987`

The match handles images, fonts, CSS/JS/JSON and XML, then falls through to
`application/octet-stream`. EPUB3 books can legitimately reference `mp3`,
`m4a`, `mp4`, `ogg`, `wav` and `webm` (audio/video, read-aloud, media
overlays). Those files are served with `Content-Type: application/octet-stream`
and `X-Content-Type-Options: nosniff`, so the WebView refuses to play them.

**Overlap:** `bugs_found.md` #6 already reports the missing `bmp` arm (and
suggests `avif`/`jxl`). This item is scoped to the *media* extensions; do not
re-report BMP.

**Suggested fix:** add the media MIME types (and `bmp`/`avif` per #6) to the
match, or derive the type from the EPUB manifest.

### AR-7. `is_xml_mime` classifies `image/svg+xml` as XML
**Lines:** `lib.rs:989–1009`

```rust
994: || mime.ends_with("+xml")
```

`image/svg+xml` matches, so `xml_response_body` runs `fix_entities` and
`strip_meta_refresh` on SVG bytes. `fix_entities` rewrites bare `&` and
unknown named entities in SVG text/CSS; `strip_meta_refresh` can remove a
`<meta>` element inside an SVG `foreignObject`. SVG is XML, but it is *image*
content, not a chapter, and should not be entity-repaired as XHTML.

**Overlap:** none.

**Suggested fix:** exclude `image/svg+xml` from the repair set (only repair
the document MIME types), or special-case it before the `+xml` test.

### AR-8. `xml_response_body` leaves non-UTF-8 XML unrepaired
**Lines:** `lib.rs:1000–1009`

```rust
1002: match std::str::from_utf8(&bytes) {
1003:     Ok(text) => strip_meta_refresh(&fix_entities(text)),
1004:     Err(_) => bytes,
1005: }
```

UTF-16 chapters (valid EPUB, BOM-prefixed) and legacy-encoded XHTML are passed
through byte-for-byte. Their bare `&` / undefined named entities are therefore
never repaired, and the strict XML parser rejects the chapter (blank page).
The comment says “binary-safe; never lossy”, which is true, but the correctness
gap is silent.

**Overlap:** `mobi-rs-review.md` M5 notes that MOBI output relies on serve-time
repair; this is the complementary case where serve-time repair *cannot* run.

**Suggested fix:** detect UTF-16 BOMs and transcode to UTF-8 before
`fix_entities`, or repair entities at extraction time so the serve path is not
the only line of defence.

### AR-9. Protocol handler advertises `HEAD`/`OPTIONS` but does not implement them
**Lines:** `lib.rs:1199–1214`

The response sets `Access-Control-Allow-Methods: GET, HEAD, OPTIONS`, but the
handler never inspects `req.method()`. Consequences:

- `HEAD` still reads the file and returns the full body, violating HTTP
  semantics and wasting I/O on every probe.
- `OPTIONS` is treated as a normal request: it still requires a valid cache
  hash and an existing file, so a preflight for a resource that is not on disk
  gets `404` instead of a CORS response, and a successful `OPTIONS` returns a
  body.

**Overlap:** none.

**Suggested fix:** branch on `req.method()`: `HEAD` → same headers, empty body;
`OPTIONS` → `204` with the CORS headers and no path validation; other methods →
`405`.

### AR-10. `is_valid_cache_hash` accepts more than the generated format
**Lines:** `lib.rs:359–363`

```rust
361: && hash.len() <= 128
362: && hash.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
```

`compute_book_key` always produces `{16 hex}_{len}_{mtime}`. The validator
accepts any alphanumeric/`_`/`-` string up to 128 chars (e.g. `foo`, `A_B-c`).
It is not a traversal risk (`/`, `\`, `.` are rejected), but it lets the
protocol handler probe arbitrary directory names under the cache root and
weakens the “content-addressed” invariant the cache comment relies on.

**Overlap:** none.

**Suggested fix:** validate the exact shape (`16` lowercase hex, `_`, digits,
`_`, digits) or check that the directory is one the cache created.

### AR-11. `compute_book_key` hashes the raw path string
**Lines:** `lib.rs:345–357` (call `596`)

```rust
346: let mut hasher = Sha256::new();
347: hasher.update(path.as_bytes());
```

`clean_str` comes from `validate_book_path` (`590–591`) and is not
canonicalised beyond `PathBuf::from`. `C:\Books\a.epub`, `c:\books\a.epub`,
`C:/Books/a.epub` and a path with `..` segments can all name the same file but
hash differently. Each spelling gets its own cache directory, its own
extraction, and its own book state, so the reader may re-extract and lose the
“same book” association. This also makes the 600 MB / 30-book eviction budget
easier to exhaust.

**Overlap:** `lib-rs-review.md` L-3 covers mtime-collision reuse; this is a
distinct key-normalisation issue.

**Suggested fix:** canonicalise with `fs::canonicalize` (and normalise case on
Windows) before hashing.

---

## Cycle 3 — `src/index.html` persistence, search and export

### AR-12. `StoreKV.migrateLegacy` deletes legacy values that are not JSON
**Lines:** `index.html:2558–2577`; raw-string writers `9148–9162`; fallback
read `2639–2649`

```js
2564: let val;
2565: try{ val = JSON.parse(raw); }
2566: catch(e){
2567:   try{ localStorage.removeItem(k); }catch(e2){} // corrupt legacy JSON: quarantine
2568:   continue;
2569: }
```

`LEGACY_PREFIXES` includes `folio-dict:` and `folio-pos:` (`2509`).
`DictCache.set` stores dictionary definitions as **raw strings** in the
IndexedDB mirror (`9155–9158`), and older `folio-pos:` values were also stored
unquoted (the comment at `2636–2638` says so). On first run, any such value
fails `JSON.parse`, and the migration **deletes** it instead of importing it.
The result is silent loss of cached dictionary entries and possibly reading
positions.

The migration’s own comment says corrupt JSON is “quarantined and skipped”, but
deleting is neither quarantining nor skipping.

**Overlap:** none.

**Suggested fix:** treat unparseable values as raw strings (`val = raw`) for
the prefixes that legitimately store raw text, and only quarantine genuinely
corrupt records (e.g. move to a `folio-quarantine:` key) instead of deleting.

### AR-13. Title is the primary key for books, search indexes and bookmarks
**Lines:** `index.html:2687–2692` (stores), `2702–2720` (`saveBook`),
`2837–2862` (`save/getSearchIndex`), `5997` (search cache lookup),
`5256–5265` (bookmark filtering)

```js
2687: const store = db.createObjectStore(this.STORE_NAME, { keyPath: 'title' });
2691: db.createObjectStore(this.SEARCH_STORE, { keyPath: 'title' });
```

`BookStorage.saveBook` writes with `title` as the key, so opening a second book
with the same title overwrites the first book’s stored buffer, `filePath`,
`cfi` and `pct`. `SearchIndex.ensure` looks up by `getActiveTitle()`, so the
second book can be served the first book’s stale full-text index — and its CFIs
point into the wrong book. Bookmarks filter by `b.bookTitle === title`
(`5262–5265`), so two same-title books share one bookmark list.

Real examples are common: multiple volumes named “Complete Works”, different
editions of the same novel, or untitled/“Untitled” imports.

**Overlap:** `index-html-review.md` #15 reports *position-key* collisions from
sanitising `filePath` into `state.posKey`. That is a different key (reading
position) with a different failure mode; this item is about the IndexedDB
primary keys and bookmark grouping. They should be fixed together by using a
stable book identity (path hash or identifier) rather than the display title.

**Suggested fix:** key `books`, `search-index` and bookmark records by a stable
book id (e.g. the Rust `book_key`/path hash, or `identifier`), keep the title
only as a display field, and migrate existing records.

### AR-14. `exportBookData` does not escape the book title
**Lines:** `index.html:10677`, `10687`

```js
10677: const title = getActiveTitle() || 'Untitled';
10687: const L = ['# ' + title, ...];
```

`mdLine` is applied to snippets, chapters, notes and vocabulary, but not to the
title. A title containing a newline injects arbitrary lines into the export; a
title beginning with `#`/`>` fakes a heading/quote. The filename is sanitised
separately (`10722`), so only the Markdown body is affected.

**Overlap:** none.

**Suggested fix:** `'# ' + mdLine(title)` (and keep the filename sanitiser).

### AR-15. Search-result highlight offsets assume case-folding preserves length
**Lines:** `index.html:6241–6252`

```js
6241: const lowerSnip = excerpt.toLowerCase();
6242: const lowerQ = q.toLowerCase();
6245: while ((matchIdx = lowerSnip.indexOf(lowerQ, lastIdx)) !== -1) {
...
6250: mark.textContent = excerpt.slice(matchIdx, matchIdx + q.length);
```

`toLowerCase()` can change string length (`İ` → `i̇`, `ẞ` → `ß` in some
locales, surrogate pairs). `matchIdx` is an offset into the lowercased string
but is used to slice the original, so the `<mark>` can start/end mid-character
or highlight the wrong span. It is cosmetic, but it can also loop incorrectly
when the folded query length differs from `q.length`.

**Overlap:** none.

**Suggested fix:** use a case-insensitive regex with the `u`/`i` flags on the
original string, or map folded indices back to original indices.

### AR-16. `TTS.previewVoice` leaks its blob URL on failure/abort
**Lines:** `index.html:8441–8444`

```js
8441: const url = URL.createObjectURL(blob);
8442: const aud = new Audio(url);
8443: aud.onended = () => URL.revokeObjectURL(url);
8444: await aud.play();
```

Revocation is wired only to `ended`. If `play()` rejects (autoplay policy,
device error), the clip is replaced by a new preview, or the user navigates
away, the URL is never revoked. Each preview leaks the WAV bytes for the life
of the document.

**Overlap:** none.

**Suggested fix:** revoke in a `finally` after `play()` settles, and also on
`error`/`pause`/replacement; keep a single “current preview” URL and revoke the
previous one when starting a new preview.

---

## Cycle 4 — tests, configs and CI

### AR-17. CI never runs the e2e suite or ESLint; audit cannot fail
**File:** `.github/workflows/build-installers.yml:67–85`

The build job runs the static scan (`67–69`), clippy (`71–73`), `npm audit …
|| true` (`75–77`), `cargo test` (`79–81`) and `tauri build` (`83–85`). It never
runs `npm run test:e2e` / `playwright test` (19 spec files under
`tests/e2e/`) or `npm run lint` (`eslint .`). A PR can merge with a broken
frontend, a broken Playwright suite, or lint errors, and the first signal is a
release build. The `|| true` on the audit also means high-severity npm
advisories never fail the job.

**Overlap:** `configs-and-tooling-review.md` C-6 discusses the static scan’s
limits but does not cover the missing CI steps.

**Suggested fix:** add `npm run lint` and `npm run test:e2e` steps (Playwright
with its web-server config) before the build, and drop `|| true` or gate it on
a documented allow-list.

### AR-18. `deny.toml` is unused and clippy is not run on all targets
**Files:** `src-tauri/deny.toml`; `.github/workflows/build-installers.yml:71–73`

`deny.toml` configures advisories, licences, bans and sources, but no workflow
or package script invokes `cargo deny` (grep across the repo finds only the
config file). The file therefore provides no protection. The clippy step is
`cargo clippy -- -D warnings`, which omits `--all-targets`, so test/bench code
is not linted even though `tauri_epub_reader/docs/DESIGN_AND_LLD.md` describes
the gate as covering all targets.

**Overlap:** none.

**Suggested fix:** add a `cargo deny check` step (and a `deny` dev dependency /
pinned action), and use `cargo clippy --all-targets -- -D warnings`.

### AR-19. ESLint config imports an undeclared package and cites a missing doc
**Files:** `tauri_epub_reader/eslint.config.mjs:2,10`;
`tauri_epub_reader/package.json`

```js
2: // See docs/CODE_QUALITY.md for the bug-class -> rule mapping.
10: import globals from 'globals';
```

`globals` is not in `package.json` (`dependencies` or `devDependencies`). It
resolves today only because ESLint hoists it transitively via
`@eslint/eslintrc`; a future dedupe/prune can break `npm run lint`. The
referenced `docs/CODE_QUALITY.md` does not exist in either `docs/` directory,
so the rule-mapping rationale is unfindable.

**Overlap:** none.

**Suggested fix:** add `globals` to `devDependencies`, and either create
`docs/CODE_QUALITY.md` or point the comment at the real document.

### AR-20. Documented Rust test count is wrong
**Files:** `tauri_epub_reader/docs/DESIGN_AND_LLD.md:732`; `README.md:193`

The docs say `npm test` “Runs 42 Rust tests + 27 static scan tests + Playwright
e2e suite”. The source contains `36` `#[test]` functions in `lib.rs` and `11`
in `mobi.rs` = **47**; the static scan has 27 checks. The exact number is not
important, but a stale count hides test deletions and makes the docs
untrustworthy. (The `mobi-rs-review.md` test-fixture note explains why the
Rust tests pass despite the parser’s offset bugs.)

**Overlap:** none.

**Suggested fix:** state the count generically (“Rust unit tests, 27 static
scan checks, Playwright e2e”) or derive it in CI.

---

## Cycle 5 — `voice_testing/` bench and sidecar

### AR-21. `synthesizePiper` can leave its promise unsettled
**File:** `voice_testing/tts_bench.mjs:62–67`

```js
62: p.on('close', code => {
63:   try {
64:     if (code !== 0) return reject(new Error('piper exit ' + code + ': ' + errs.join('')));
65:     resolve(readFileSync(outFile));
66:   } finally { try { rmSync(outFile); } catch {} }
67: });
```

`readFileSync` runs *before* `finally` deletes the file, so the ordering is
fine on the happy path. But if `readFileSync` throws (file missing because
piper wrote elsewhere, permission error, antivirus lock), the `finally` still
runs and the throw escapes the `close` event handler. Because the Promise was
never resolved or rejected, the pending HTTP request never completes; in Node
the uncaught exception can also terminate the bench process. Either way the
bench appears to hang.

**Overlap:** `bugs_found.md` covers the bench `num()` defaults and hardcoded
paths; `configs-and-tooling-review.md` C-7 covers the empty-voice-list crash.
This hang is new.

**Suggested fix:** wrap the whole handler in `try { … } catch (e) { reject(e); }`
and only `rmSync` after the read; guard against double-settle.

### AR-22. The bench page leaks object URLs on every Speak
**File:** `voice_testing/tts_bench.mjs:303`

```js
303: $('player').src = URL.createObjectURL(blob);
```

Each Speak creates a new blob URL and assigns it to the same `<audio>`; the
previous URL is never revoked. Repeated A/B tests leak every WAV for the life
of the page.

**Overlap:** none.

**Suggested fix:** keep the previous URL and revoke it before assigning the new
one (or revoke on `ended`/`error`).

### AR-23. `ensureSidecar` reuses a sidecar with the wrong engine set
**File:** `voice_testing/tts_bench.mjs:74–89`

```js
77: if (await sideUp(side.port)) return true;
```

`sideUp` only checks `/health`. If a sidecar for the same port is already
running with a narrower `SERVED` set (e.g. started manually as
`ttslab_engine.py 8790 chatterbox`, or left over from an earlier bench run
that only needed one engine), `ensureSidecar('nano')` returns success and the
subsequent `/synth?engine=nano` fails with “engine nano not served”. The bench
reports a synthesis error instead of spawning a correctly configured sidecar.

**Overlap:** none.

**Suggested fix:** have `/health` report the served engine set and compare it
with `side.engines`; restart/replace the sidecar when the set is insufficient.

### AR-24. `_nano_ref_clip` shares one temp path and can hang on timeout
**File:** `voice_testing/engines/ttslab_engine.py:52–69`

```python
57: ref = os.path.join(tempfile.gettempdir(), "ttslab_ref.wav")
58: if not os.path.exists(ref):
...
65: p = subprocess.run([...], input=text.encode(), capture_output=True, timeout=120)
```

Two problems:

1. **Shared path.** Every sidecar/process uses the same `ttslab_ref.wav`.
   Concurrent sidecars (the bench can run `venv-chat` and `venv-qwen`
   sidecars, and a developer may start a second manually) race: one may see
   the file while another is still writing it, then load a partial/truncated
   WAV as the Nano reference clip. The `exists` check is also TOCTOU.
2. **Uncaught timeout.** `subprocess.TimeoutExpired` is not caught, so a slow
   piper run aborts `load_nano` with a traceback rather than a clean
   “reference generation timed out” error (the bench then reports a generic
   load failure).

**Overlap:** `bugs_found.md` already reports the `_nano_ref_clip` root-path
problem (and the hardcoded Piper path). This item is scoped to the shared-temp
race and the uncaught timeout.

**Suggested fix:** use `tempfile.mkstemp`/`NamedTemporaryFile` per process (or
include the PID in the name), write atomically (write to a temp name, then
`os.replace`), and catch `TimeoutExpired` to return a clear error.

---

## Overlaps deliberately not re-reported

| Area | Already covered by |
|---|---|
| MOBI header offsets, EXTH, KF8 boundary, trailing flags | `mobi-rs-review.md` H1–H4; `bugs_found.md` #1–#2 |
| `rewrite_img_tag` duplicate `src` / whitespace around `=` | `bugs_found.md` #5 |
| `sanitize_html_tag` `<style>`/CSS and entity-obfuscated schemes | `bugs_found.md` #12 |
| `filepos` offsets invalidated by cp1252 conversion | `mobi-rs-review.md` M2 |
| Bare `&` surviving to disk, relying on serve-time repair | `mobi-rs-review.md` M5 |
| BMP served as `application/octet-stream` (and `avif`/`jxl` suggestion) | `bugs_found.md` #6 |
| Origin allowlist / `frame-ancestors` missing `http://tauri.localhost` | `lib-rs-review.md` H-1; `configs-and-tooling-review.md` C-4 |
| Cache eviction races, TOCTOU/junction checks, memory amplification | `lib-rs-review.md` M-1…M-4 |
| `..` acceptance, mtime collision, lock poisoning, partial extraction | `lib-rs-review.md` L-1…L-6 |
| Settings validation, TTS engine bugs, font ids, page-cache/bionic order, listener leaks, TDZ, bookmark granularity, position-key collisions | `index-html-review.md` #1–#18 |
| `window.__TAURI__` / opener/shell dead paths, duplicate CSS, CSP `unsafe-eval` | `configs-and-tooling-review.md` C-1…C-3 |
| Synthetic MOBI fixture using the parser’s own wrong offsets | `mobi-rs-review.md` test-fixture note; `bugs_found.md` #1/#16 |
| Bench `num()` defaults, hardcoded Piper paths, `_nano_ref_clip` root path, sidecar lifecycle, stale README paths | `bugs_found.md` #8–#11; `configs-and-tooling-review.md` C-7 |

## Suggested fix order

1. **AR-1, AR-2** — duplicate/invalid attributes make whole chapters blank on
   real MOBI input; both are in the hostile-input path.
2. **AR-12, AR-13** — silent data loss and cross-book contamination in the
   frontend persistence layer.
3. **AR-8** — chapters that fail to render on non-UTF-8 input.
4. **AR-17** — wire the existing e2e/lint suites into CI so the rest of these
   findings are caught automatically.
5. **AR-6, AR-21, AR-23, AR-24** — media playback and dev-bench reliability.
6. Remaining Low items as cleanup.
