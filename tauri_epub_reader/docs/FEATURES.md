# Folio Reader — Current Capabilities & Roadmap

> Tracking doc for reader features (EPUB reading experience only — no library management).
> Last updated: 2026-09-23, against `src/index.html` (4,267 lines) + `src-tauri` backend.
> ✅ = verified in code · ⚠️ = claimed in README/partially implemented · ❌ = not present

---

## 1. Platform & Backend

| Capability | Status | Notes |
|---|---|---|
| Tauri 2.0 + WebView2 (Edge) desktop shell | ✅ | ~9 MB binary, no bundled browser |
| `.epub` file association (double-click open) | ✅ | `tauri.conf.json` → `fileAssociations` |
| Open via CLI argument | ✅ | `get_initial_file` scans `std::env::args()` |
| Native file picker dialog | ✅ | Rust `rfd` crate, `pick_file` command |
| Drag & drop EPUB onto window | ✅ | Tauri `dragDropEnabled` + frontend overlay |
| Book bytes delivered to frontend | ✅ | `read_file_bytes` → raw bytes via `tauri::ipc::Response` binary IPC |
| Book data cached on disk (Rust side) | ❌ | In-memory LRU `BookCache` (keyed by path, returns cached raw bytes) added; disk cache still TODO |
| Raw IPC for large files | ✅ | `read_file_bytes` returns `tauri::ipc::Response` raw bytes — no JSON number-array serialization |

## 2. Reading Engine

| Capability | Status | Notes |
|---|---|---|
| EPUB 2/3 rendering (reflowable) | ✅ | Vendored epub.js 0.3 + JSZip, fully offline |
| Paginated layout, continuous spine | ✅ | CSS-column pagination inside sandboxed iframe |
| Single page / two-page spread | ✅ | `auto` (width-based) / on / off |
| Page width slider + auto-fit | ✅ | 460–2000 px, independent single/spread widths |
| Typography presets | ✅ | Classic / Relaxed / Focus + "Auto-tune" harmony reset |
| Typographic harmony engine | ✅ | CPL-based auto line-height, letter/word spacing, margins |
| Font size slider + auto-fit | ✅ | 15–28 px, 0.1 steps |
| Fonts | ✅ | Literata, Lexend, Atkinson Hyperlegible, OpenDyslexic (local woff2) |
| Justified text toggle | ✅ | |
| Drop caps toggle | ✅ | |
| Bionic reading (bold prefixes) | ✅ | `bionifyDoc` rewrites DOM text nodes on chapter load |
| Reading ruler / guide line | ✅ | Follows pointer when enabled (`G`) |
| Themes (paper variants) | ✅ | Manual pick + auto follow OS day/night (`themeAuto`) |
| Running header (chapter / book) | ✅ | Two-column header above the page |
| Per-book typography settings | ✅ | Settings keyed per book (`perBookType`) |

## 3. Page-Turn & Motion

| Capability | Status | Notes |
|---|---|---|
| Fold-sheet "paper flip" FX | ✅ | `PageTurnCompositor`: clipped flat sheet + paper-curl flap, fold shadow, edge highlight, ambient shadow, spine valley; DOM compositor animating `transform`/`translateX` + opacity only (GPU-composited, no per-frame clip-path repaint) |
| Full-spread two-phase fold | ✅ | Fold travels the whole spread (`PageTurnConfig.fullSpreadFold`, default on); phase-2 paper back-sheet overlaps the opposite page; legacy half-leaf path kept behind the flag / `quality:'basic'` |
| Paper texture + warmer fold light | ✅ | Shared 256px grain tile (one `toDataURL`, `multiply` wash) gated by a texture chip (default on, off for basic); warmer fold/ambient gradients; dual-band soft-light crease sheen; page-edge stack hints; mid-turn settle sound |
| Damped-spring physics | ✅ | `PageTurnPhysics` (settle on p < 0.003, v < 0.02) |
| Drag-to-turn gesture with fling | ✅ | `TurnGestureController`: 120 ms velocity window, edge/boundary detection, cross-iframe pointer capture |
| Slide FX | ✅ | Snapshot pool (6 warm iframes) slides |
| Instant (no FX) mode | ✅ | |
| FX quality tiers | ✅ | `premium` / `basic` |
| 15-page sliding content window | ✅ | `PageCacheManager`: −5 back / +10 forward, cross-spine resolve |
| Adjacent-spine preloading | ✅ | ±1 always, ±2 near chapter edges |
| Pre-rasterized page snapshots | ✅ | Iframe `srcdoc` snapshots pooled offscreen; never rotates live text |

## 4. Navigation & Progress

| Capability | Status | Notes |
|---|---|---|
| Table of contents | ✅ | Windowed rendering for huge TOCs, current-chapter marking |
| Top-left contents pill with live position | ✅ | `#posPill`: current chapter + percent, updates in `onRelocated`, click opens contents; closed drawers use `visibility:hidden` so no stray chrome paints |
| Bookmarks per book | ✅ | Ribbon toggle (`B`), bookmark tab, delete, badge count; keyed by title+author |
| Progress rail (chapter granularity) | ✅ | Draggable knob + fill, percent display; also seeks by page granularity via persisted LocEngine locations (`railSeek`) |
| Chapter progress ribbon | ✅ | 3 px top-edge strip, one segment per chapter weighted by location counts (`Ribbon`, capped at 240, click-to-jump with tooltips); accent playhead tracks progress, dims with hidden chrome |
| Page badge (page x / y within chapter) | ✅ | Plus book-wide "Page N of M" badge from persisted CFI locations (`LocEngine`) |
| Time-left-in-chapter estimate | ✅ | |
| Resume reading (CFI restore) | ✅ | "Continue reading" on landing + badge |
| Recent shelf with cover thumbnails | ✅ | Persisted title/author/pct/cfi/filePath, cover extracted on open |
| Global (book-wide) page numbers | ✅ | `LocEngine` persists CFI locations per book → "page N of M" badge, not just per-chapter; generation starts only in ≥2 ms idle windows, pauses while hidden, serialized after indexing via `BgJobs` |
| Mouse-wheel page turning | ✅ | Wheel down/up turns pages in the shell and inside chapter iframes; `Ctrl+Wheel` = type size, `Alt+Wheel` = page width |
| Click-to-turn edge zones | ✅ | Edge zones + drag-to-turn gesture cover click-to-turn |
| Auto-scroll mode | ✅ | Middle-click toggles auto-scroll (`AutoScroll`) |

## 5. Search & Lookup

| Capability | Status | Notes |
|---|---|---|
| Full-book search (`Ctrl+F`) | ✅ | Chapter text cache + index, excerpt highlighting, jump-to-match; index builds chunked across idle callbacks (≤6 spines/tick), persists partial progress, resumes after reload, pauses while hidden |
| Find from selection | ✅ | Selection toolbar "Find in book" |
| Word definition lookup | ⚠️ | Online `api.dictionaryapi.dev` plus offline `DictCache` of previously fetched definitions; full bundled dictionary still absent |
| Copy selection | ✅ | |
| Highlights / annotations | ✅ | 4-color palette (`selHl`), persisted per CFI (`Highlights`), listed in the Highlights drawer tab |
| Notes | ✅ | Click-to-annotate popup on highlights; persisted per book |

## 6. Read-Aloud (TTS)

| Capability | Status | Notes |
|---|---|---|
| Sentence pre-tokenization (current + next 3 pages) | ✅ | Infrastructure exists in `PageCacheManager` |
| Actual TTS engine (speechSynthesis) | ✅ | `TTS` engine: `btnSpeak` + `R` play/pause, `Shift+R` stop, `-`/`=` speed, sentence highlight via CSS Custom Highlight API, auto page advance |

## 7. Reading Stats

| Capability | Status | Notes |
|---|---|---|
| Session/day reading minutes | ✅ | 30 s heartbeat, only while visible & reading |
| Pages turned per day | ✅ | |
| Day streak | ✅ | |
| Stats on landing page | ✅ | "X min read · Y pages · Z-day streak" |

## 8. UI / Chrome

| Capability | Status | Notes |
|---|---|---|
| Auto-hiding chrome (3.4 s) | ✅ | Top/bottom bars slide away; any input pokes |
| Fullscreen (`F`) | ✅ | Tauri window fullscreen + UI sync |
| Keyboard shortcuts + help overlay (`?`) | ✅ | ←/→/Space/PgUp/PgDn, T, S, B, Ctrl+F, G, D, V, F, H, Esc |
| Built-in demo book (The Time Machine) | ✅ | Embedded HTML for instant first-run experience |
| Toasts, loader with min-display time | ✅ | |
| Settings persistence | ✅ | Debounced localStorage blob |
| Warmth / blue-light filter | ✅ | Night warmth slider (`#warm` overlay) |
| Page-turn sound | ✅ | Toggleable page-turn sound (`swSound`) |
| Image lightbox / zoom | ✅ | Click image → lightbox (`Lightbox`) |
| Footnote popup on tap | ✅ | EPUB noteref → inline popup (`Footnotes`) |

---

## 9. Roadmap — prioritized (performance & usability first, GPU-aware)

### P0 — Performance (measurable wins)

1. **[DONE]** **Zero-copy book loading + Rust-side disk cache.**
   `read_file_bytes` now returns `tauri::ipc::Response` raw bytes (no JSON array), and an in-memory LRU `BookCache` in Rust returns cached bytes on re-open. The Rust-side *disk* cache is still TODO.
1. **[DONE]** **Persist `locations.generate()` results per book.**
   `LocEngine` stores CFI locations per book; only generated on first open. Unlocked book-wide "page N of M" badge and page-granularity rail seeking (`railSeek`).
3. **[DONE]** **Move the page-flip to compositor-only properties (GPU).**
   The `PageTurnCompositor` render path now writes only `transform` (`translateX`/`rotateY`/`translateZ`) and opacity per frame — GPU-composited, no per-frame clip-path repaints.
4. **[DONE]** **Force GPU rasterization in WebView2.**
   `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` is merged with `--enable-gpu-rasterization` / `--enable-zero-copy` flags at startup in `lib.rs`.
5. **`content-visibility: auto` + `contain: strict` inside chapter docs.** (skipped — pagination-correctness risk)
   Long chapters lay out entire offscreen columns. `content-visibility` on section/paragraph blocks makes the iframe skip offscreen layout/paint.
6. **Search off the main thread.**
   Chapter text extraction (`innerText`) forces layout per chapter during search. Extract from cached chapter HTML strings in a Web Worker (regex/DOMParser text stripping), and make search incremental (stream results as chapters are scanned).
7. **Cheap text extraction for the page cache.**
   `extractTextForPage` calls `iframe.innerText` (layout flush) per relocation; slice from `chapterTexts` cache instead of the live frame.

### P1 — Usability (reader experience)

1. **[DONE]** **Wire up TTS read-aloud.** `speechSynthesis` engine with play/pause (`R`), stop (`Shift+R`), speed (`-`/`=`), sentence highlight via CSS Custom Highlight API, and auto page-turn at page end.
2. **[PARTIAL]** **Offline dictionary** for the Define action — `DictCache` persists previously fetched definitions for offline re-lookup; a full bundled (WordNet-derived) dict is still absent.
3. **[DONE]** **Mouse-wheel page turn** (shell + inside chapter iframes; `Ctrl+wheel` = size, `Alt+wheel` = width) + **edge click zones** for turning.
4. **[DONE]** **Global progress & page numbers**: book-wide "page N of M" from persisted `LocEngine` locations; the progress rail drags at *page* granularity (`railSeek`).
5. **[DONE]** **Highlights & annotations**: 4-color palette + notes persisted per CFI; Highlights tab in the TOC drawer.
6. **[DONE]** **Night comfort**: warmth/blue-light slider (`#warm`).
7. **[DONE]** **Per-book typography memory** (`perBookType`).
8. **[DONE]** **Reading polish pack**: page-turn sound toggle (`swSound`), image lightbox (`Lightbox`), footnote popups (`Footnotes`), middle-click auto-scroll (`AutoScroll`).
9. **[DONE]** **Ctrl+wheel font size**.

### P2 — Quality & robustness

1. Bionic pass during chapter HTML parse instead of a second DOM rewrite pass.
2. Persist search index + chapter text cache per book (IndexedDB) so search is instant on re-open.
3. Rearchitect the single 4,267-line `index.html` into modules (compositor / cache / ui / book) with a build step — safer iteration on P0/P1 items.
4. Error telemetry-free crash safety: persist last CFI on every `relocated` (already done) + window restore.
5. Optionally replace vendored epub.js pagination with a Rust-side pagination service feeding the same windowed cache — biggest possible perf ceiling, highest effort.

### GPU budget summary
| Feature | Status | Notes |
|---|---|---|
| Page flip rasterization | ✅ Shipped | GPU-composited `transform`/opacity-only compositor (no per-frame clip-path repaints) |
| Scroll/pagination paint | ❌ Not shipped | `content-visibility` culling skipped (pagination-correctness risk) |
| WebView2 raster pipeline | ✅ Shipped | `--enable-gpu-rasterization --enable-zero-copy` flags merged into `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` at startup |
| Book decode | ✅ Shipped (partial) | Raw binary IPC (`tauri::ipc::Response`) + in-memory LRU book cache; Rust disk cache still TODO |

---

## 10. Automated tests

| Capability | Status | Notes |
|---|---|---|
| Playwright e2e harness (`npm test`) | ✅ | `tests/e2e/` (helpers, demo-book driven, mocked speechSynthesis, stubbed dictionary API); `playwright.config.mjs` serves `src/` on :8124, 1 worker, failure screenshots to `tests/e2e/artifacts/` |
| Regression specs R1–R16 | ✅ | Book open, locations persist, turns, rail, TTS lifecycle/advance, highlights, warmth, per-book typo, footnotes, lightbox, dict cache, drawer chrome, boot-open, autoscroll |
| Design specs D1–D2 | ✅ | Contents pill behavior + closed-drawer hit-testing |
| Rust unit tests (`cargo test` via `npm run test:rust`) | ✅ | Harness wired; item specs (U1–U5) land with P-A |
