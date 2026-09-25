# Folio Reader — Improvement Design Document

> Detailed designs for the user-selected performance & appearance improvements.
> Covers: **P-A** disk cache for unzipped books · **P-B** chunked background work ·
> **A-A** top-left TOC + live position (and stray ✕ removal) · **A-B** chapter progress
> ribbon · **A-C** paper-grade page turn · **A-S** full-spread page flip (turning page
> completely overlaps the opposite side in two-page mode).
>
> Code anchors reference `src/index.html` (~5,050 lines) and `src-tauri/src/lib.rs`
> as of 2026-09-25. Effort: S ≤ half day · M ~1 day · L multi-day.

---

## P-A — Rust-side disk cache for unzipped books

**Goal.** Re-opening a previously read book skips JSZip inflation entirely: the
WebView receives ready-to-render spine HTML/resources from disk.

**Current behavior.** `read_file_bytes` (lib.rs) returns the raw `.epub` bytes via
`tauri::ipc::Response` with an in-memory LRU (`BookCache`, 4 entries / 160 MB).
The frontend then calls `ePub(buf)` — epub.js + JSZip inflate the whole archive in
the JS heap on *every* open. In-memory cache only helps within one session.

**Proposed design.**

1. **New Rust command `book_open(path) -> BookHandle`** (lib.rs):
   - Cache root: `{app_cache_dir}/folio-unzip/{hash}/` where
     `hash = sha256(path bytes) + len + mtime` (same invalidation key as `BookCache`).
   - On first open: unzip with the `zip` crate (add `zip = "2"` to Cargo.toml),
     sanitizing entry names (reject `..`, absolute paths, drive letters — zip-slip).
     Store the file list in `manifest.json` (`{zipPath, size, mediaType?}`).
   - On later opens: stat the `.epub`; if len+mtime match the manifest, skip unzip.
   - Return `{ cacheDir, manifest }` to the frontend.
2. **Serving cached files to epub.js.** epub.js fetches resources itself via the
   archive (JSZip) — bypassing that requires a custom protocol:
   - Register `folio-cache://` via `tauri::Builder::register_uri_scheme_protocol`
     ("unzipped" scope), resolving `folio-cache://{hash}/{zipPath}` to the file on
     disk with correct `Content-Type` (small mime map: xhtml/html/css/js/images/fonts).
   - Frontend opens with `ePub('folio-cache://{hash}/META-INF/container.xml')` —
     epub.js supports URL-based opening and will pull every resource through the
     protocol with HTTP-range-free plain GETs. Confirm epub.js 0.3 URL mode against
     the vendored bundle before committing (it must not require JSZip when given a
     URL — it uses XHR `container.xml` path loading, which it does in 0.3).
   - Fallback: if anything fails, open the old byte-array way (`tauriOpenPath`
     keeps both paths; `openBuffer` unchanged).
3. **Eviction.** Cap cache dir at ~600 MB or 30 books; evict least-recently-*opened*
   dirs (touch an `atime` file on open). Run eviction on a background thread
   (`std::thread::spawn` + `tauri::async_runtime`) after each `book_open`.
4. **Integration points.**
   - `tauriOpenPath()` in index.html: try `invoke('book_open', {path})` → build
     protocol URL → `openBuffer(null, name, path, {url})`; extend `openBuffer` to
     accept either buffer or URL (small change at `ePub(buf)` call, line ~1590).
   - Recent-shelf click path (renderRecentShelf) mirrors the same logic.
   - `BookStorage`/IndexedDB byte caching becomes redundant for file-backed books —
     keep it only for browser mode.

**Perf/GPU notes.** Zero rendering impact; the win is open-time (JSZip inflate of a
20 MB book ≈ 300–800 ms + large GC pressure → ~0) and memory (no full archive in JS heap).

**Risks & mitigations.**
- epub.js URL mode edge cases → byte-array fallback stays the default on any error.
- Disk space growth → eviction + size cap; cache is regenerable, safe to delete.
- Encrypted/DRM epubs → `zip` crate fails to extract → fallback path.

**Test plan.** (1) Open book A via picker → close → reopen from recent shelf: second
open has cache dir populated and no JSZip activity (log line). (2) Touch/modify the
.epub on disk → re-open re-unzips (mtime key). (3) Open 35 books → oldest caches
evicted. (4) Book with nested image paths + fonts renders identically to byte path.

**Effort: M–L** (protocol + epub.js URL-mode verification is the bulk).

---

## P-B — Chunked idle-time background work

**Goal.** Locations generation and search-index building never cause frame drops,
even on huge (300+ spine) books.

**Current behavior.**
- `LocEngine.ensure()` (index.html ~line 2870) calls `book.locations.generate(1000)`
  — epub.js loops all spines **in one promise chain**; each spine load + layout runs
  layout work on the main thread between microtasks, which still competes with
  rendering on big books.
- `SearchIndex.ensure()` (~line 2380) iterates spines with `await item.load(...)` +
  `innerText` — the `await` yields, but bursts of several spines can land in one frame.

**Proposed design.**
1. **Spine-by-spine locations.** Replace the single `generate(1000)` call with a
   chunked driver that mirrors epub.js Locations internals (already vendored, so we
   may call the lower-level `book.locations.generateFromSpineItems`? — not public).
   Practical approach: call `generate(1000)` **per chunk** is not supported, so
   instead schedule the existing call inside an idle-deadline loop:
   - `requestIdleCallback` with `timeout: 400`; inside the callback check
     `deadline.timeRemaining()` before starting; if the browser reports < 2 ms
     remaining, reschedule instead of starting (defers the burst).
   - Additionally wrap the *start* behind `document.hidden == false` — generating
     while the window is minimized wastes nothing (it's still main-thread when
     focused again); simplest: only generate when visible, pause when hidden
     (`visibilitychange` listener starts/stops a retry loop).
2. **Search index slicing.** `SearchIndex.ensure()` gains a `slice` mode: process at
   most N spines per `requestIdleCallback` tick where
   `N = clamp(deadline.timeRemaining() / 4, 1, 6)` (≈4 ms per spine measured on the
   demo; large image-heavy spines cost more). Persist partial progress in the
   existing IndexedDB record (`{partial: true, done: n}`) so an interrupted build
   resumes instead of restarting.
3. **Yield helper.** Add `const idleYield = () => new Promise(r => requestIdleCallback(r, {timeout: 300}))`
   and use it in both loops between spines/chunks.
4. **Priority.** Locations generation defers to search indexing (don't run both at
   once): a tiny `BgJobs` queue with `run(job)`/`cancel(tag)`; locations enqueued
   after index prepare completes for the current book.

**Integration points.** `LocEngine.ensure`, `SearchIndex.ensure/prepare` only; no UI changes.

**Risks.** Longer total time to first full index on huge books (acceptable — it is
background); partial-index resume logic must not double-append chapters (guard by
`chapters.length === done`).

**Test plan.** (1) 500-spine stress EPUB: open, immediately flip pages — no frame
drops (DevTools performance trace, long tasks < 50 ms). (2) Close book mid-index →
reopen → indexing resumes at recorded offset. (3) Locations badge appears within a
few idle seconds; page badge switches from chapter pages to global pages.

**Effort: S–M.**

---

## A-A — Top-left contents pill + live position (and remove the stray ✕)

**Goal.** One-glance answer to "where am I", and contents access without traveling
to the right corner. Also eliminate the unexplained ✕ at the top-left.

**Investigation note (open item).** `document.elementFromPoint(27, 38)` in the
running app returns a bare 18×18 X-shaped SVG (`stroke-width 1.8`, path shape of the
close icons used by `searchClose`/`tocClose`/`helpClose`). None of those should be
visible while reading with panels closed, so the likely causes are (a) a drawer's
close button bleeding through a transform during/after its slide-out, or (b) a
z-index/transform stacking quirk in `#topbar`'s left slot. First implementation step
is a 15-minute repro: screenshot the packaged app cold-open on a book, inspect the
computed style + parent chain of that SVG (the browser test showed the element but
not its container). If it is a panel close button, fix by adding
`visibility: hidden` (not just `transform`) to the closed-drawer state — CSS already
toggles `transform` only for `#toc`/`#searchDrawer`, which leaves buttons
focusable/hit-testable at their translated position; `visibility` fixes both.

**Proposed design.**

1. **Remove ✕:** add `visibility:hidden` to `#toc`, `#searchDrawer`, `#sheet`,
   `#helpOverlay` closed states (and `visibility:visible` on open) so no closed-panel
   chrome can ever paint or intercept hits. This is very likely the fix for the ✕
   (a closed drawer's close icon sitting under the top-left area).
2. **Contents pill (topbar left slot).** `#topbar` currently has a Home button
   (`btnHome`) on the left. New markup after it:
   ```html
   <button id="posPill" class="pos-pill" title="Contents & position (T)">
     <svg class="pill-ic">…list icon…</svg>
     <span id="posPillCh">—</span>
     <span id="posPillPct" class="pill-pct">12%</span>
   </button>
   ```
   - `#posPillCh` = current chapter short name (`chapterFor(loc.start.href)`,
     truncated with ellipsis at ~28 chars); `#posPillPct` = existing `pct` value.
   - Updated inside `onRelocated()` (single place, already computes both).
   - Click → `toggleToc()`. Keyboard unchanged (`T`).
   - Hides on the landing state (`body.state-landing #posPill{display:none}`) and
     participates in chrome auto-hide (it is inside `#topbar`, so it inherits the
     existing slide-away for free).
3. **Style:** pill = 1px `var(--hair)` border, 999px radius, 12px sans, muted ink,
   hover → ink + `var(--hairS)` border; accent-colored left dot marker. Sits in the
   existing topbar flex row: `gap:10px` after `btnHome`; `max-width: min(42vw, 460px)`
   with text-overflow ellipsis so long chapter names never push the book title away
   (book title keeps priority — pill truncates, title doesn't).
4. **Mobile/narrow:** below 760 px the pill shows only the icon + percent (chapter
   name hidden) to preserve the title.

**Risks.** Very low; purely additive UI. Must verify the pill doesn't sit under the
swipe/edge-click zones (it's inside `#topbar`, which the turn gesture already
excludes via `closest('header, footer, aside')`).

**Test plan.** (1) Visual: pill shows chapter + % and updates on every turn, wheel,
rail scrub. (2) Click opens contents; Esc/scrim closes. (3) 400-char chapter title
truncates with ellipsis; book title still fully visible at 800 px width. (4) Stray ✕
gone cold-open and after opening/closing each drawer once.

**Effort: S.**

---

## A-B — Chapter progress ribbon

**Goal.** A spatial map of the book's chapters with a live position marker —
"how far into this book, structurally" at a glance, click any segment to jump.

**Proposed design.**

1. **Placement.** A 3 px-high strip pinned to the very top of the viewport
   (`position:fixed; top:0; left:0; right:0; z-index:40`), *above* the running
   header and topbar, spanning full width. It stays visible even in
   `chrome-hidden` mode (that's its point) but at 45% opacity, 100% on hover —
   reading immersion is preserved because it is hairline-thin.
2. **Segments.** One flex child per chapter, `flex-grow: chapterWeight`, where
   `chapterWeight` comes from `LocEngine` when ready (`locations per spine` — count
   CFIs whose spine index matches) else fallback equal weights. Build once per book
   in `buildTOC()` (which already has the flattened `tocItems`) and rebuild if
   locations arrive later (`LocEngine.refreshUI` calls a `Ribbon.rebuild()`).
   Cap rendered segments at 240 (merge tail chapters of very long TOCs).
3. **Marker.** A 2 px accent-colored playhead positioned by global fraction
   (`left: pct%`), updated in `onRelocated()` next to the existing `railFill`
   write. Add a subtle `transition: left .2s` for smooth movement across turns.
4. **Interaction.** Click a segment → `state.rendition.display(item.href)` (same as
   TOC row). Hover → native `title` tooltip with chapter label + its % range
   (`title` attribute is free; no custom tooltip machinery). The strip has
   `pointer-events:auto` only on itself (not its parent), and `cursor:pointer`.
5. **Data flow.** New tiny module `Ribbon = { el, build(tocItems, weights), move(frac) }`,
   wired from `buildTOC`, `onRelocated`, `LocEngine.refreshUI`, and cleared in
   `closeBook`. No storage, no settings.
6. **Relationship to the bottom rail.** Keep both for now: the rail scrubs
   page-continuously (drag), the ribbon is structural (chapters). If it feels busy,
   a follow-up could gate the ribbon behind a settings chip — out of scope here.

**Risks.** Top-edge hover conflicts with the chrome-reveal zone
(`CHROME_TOP_ZONE = 64`): the ribbon is only 3 px, so pointermove hits remain
dominated by the existing top-zone logic — but clicking the ribbon must not toggle
chrome (it won't; chrome only reacts to pointermove proximity). Long TOCs (500+) —
solved by the 240-segment cap.

**Test plan.** (1) Demo book: 4 proportional segments, playhead moves each turn.
(2) 60-chapter book: segments render < 16 ms (one-time build), hover tooltips show
labels. (3) Click jumps to chapter and TOC current-marker syncs. (4) Chrome-hidden:
ribbon dims to 45% and hover restores. (5) With locations late-arriving, segments
re-proportion without a visible flicker (build into a detached node, swap in).

**Effort: S–M.**

---

## A-C — Paper-grade page turn

**Goal.** Make the fold feel like real paper without giving up the "never rotate
live text" guarantee or the transform/opacity-only GPU discipline added last round.

**Proposed design.** All changes inside `PageTurnCompositor` (index.html ~3130) and
its CSS block; strictly additive divs + CSS, no algorithm change to fold math.

1. **Page texture (`pt-grain`).** One shared, generated 256×256 noise tile
   (canvas-generated once at startup, `toDataURL`, reused by every turn via CSS
   `background-image`). Applied as a `background-blend-mode: multiply` layer at
   ~4–6% opacity over `.pt-sheet` and the stationary/underneath leaves. Cost: zero
   per-turn rasterization (same tile, GPU-cached), one extra composited layer.
2. **Warmer fold lighting.** Current `.pt-fold-shadow` is a neutral radial
   (`rgba(15,10,5,…)`). Split into two gradient stops tuned warmer
   (`rgba(38,24,10,…)`) + widen `foldShadowWidth` 32 → 40 px and let opacity curve
   `0.35 + 0.65·C` become `0.28 + 0.72·C` (slightly stronger at peak, softer at
   the ends — paper shadow concentrates near contact). Numbers live in
   `PageTurnConfig`, one-line tuning.
3. **Edge specular sheen.** Upgrade `.pt-curl-highlight` from a 3 px white line to
   a 6 px gradient with `mix-blend-mode: soft-light` and a faint second highlight
   offset 2 px below (paper crease catches two highlights). Still opacity-animated
   only.
4. **Page-edge stack hints.** Two static decorative strips at the outer margins of
   `#wrap` (`.edge-stack.right/.left`): 2–3 hairlines (`1px` lines, 40% opacity,
   3 px total width) suggesting stacked pages; in spread mode they sit at both
   outer edges, in single mode only on the right (forward direction). Pure CSS,
   zero JS per frame; `prefers-reduced-motion` and `turnFx:'none'` hide them.
5. **Sound pairing.** The existing `PageSound` swish already exists; add a softer
   second noise burst at fold-midpoint (`C > 0.5` crossing) for two-stage paper
   settle — one `if` in `render()` guarded by a `playedMid` flag reset per turn.

**Perf/GPU notes.** Everything remains transform/opacity/clip-path writes; the
grain tile and gradients are rasterized once. Watch layer count: grain layer adds
1 composited layer per visible leaf (3–4 total) — well within budget; verify with a
DevTools layers snapshot that no layer exceeds viewport size.

**Risks.** Blend modes (`multiply`, `soft-light`) force their own compositing
steps — if a perf regression shows on integrated GPUs, ship items 2/3/4 (cheap)
and gate item 1 behind a "Paper texture" chip (settings row next to
`swSound`), default on, off for `quality:'basic'`.

**Test plan.** (1) Visual A/B screenshots demo book, day + noir themes. (2) Perf
trace: 100 rapid turns — frame time distribution unchanged vs baseline (no >1 ms
median regression). (3) `prefers-reduced-motion` + Instant mode show no texture
layers (verify via layers panel). (4) Spread + single mode both look right.

**Effort: S–M.**

---

## A-S — Full-spread page flip (turning page completely overlaps the opposite side)

**Goal (user request).** In two-page mode, today's flip only animates the turning
half-leaf next to the spine; the opposite page never sees the page pass over it.
Make the turning page sweep **across the whole spread** — mid-turn, its back
visibly lies over the opposite page, exactly like a physical book — while keeping
the never-mirror-live-text guarantee and GPU-only animation.

**Current behavior (anchor: `PageTurnCompositor.init()` spread branch, ~3230).**
Forward turn (dir>0): stationary left page (old), underneath right page (new),
fold sheet = right leaf only (`leafW = VW - spineX`, `leafX = spineX`), fold
`fx = bw·(1-p)` travels from the right outer edge **to the spine and stops**.
The opposite (left) page is never covered.

**Proposed design — two-phase fold across the full spread.**

1. **Phase geometry.** Redefine the fold to travel the *full* width:
   `foldX(dir>0) = spreadW·(1-p)` — starts at right outer edge (p=0), crosses the
   spine at p=0.5, ends at the left outer edge (p=1). Backward mirrors.
2. **Phase 1 — front-of-page (fold right of spine, p<0.5).** Identical to today:
   the front sheet (live snapshot of the turning page, anchored at the right half)
   is clipped to `[spineX, foldX]` — wait, inverted from today: today's sheet shows
   `[spine, fold]` as the *remaining* page. New phase 1 shows the page's un-turned
   remainder `[foldX, VW]` (the part right of the fold that hasn't lifted), which
   is the physically correct projection (the lifted part is the flap). This changes
   the clip from `inset(0 cut 0 0)` to `inset(0 0 0 cutFromSpine)`-style logic —
   sheet element stays full-leaf, `clip-path` inset side depends on phase.
   Underneath right-of-fold: the *next* page (already the case).
3. **Phase 2 — back-of-page (fold left of spine, p≥0.5).** A new `pt-back-sheet`
   div spanning `[foldX, spineX]`: plain paper (same visual language as the flap —
   `--page` gradient + grain from A-C), **never live text**, so mirroring is
   impossible by construction. It visually *lies over the left (opposite) page*,
   delivering the requested overlap. Width driven per frame by `clip-path: inset()`
   on a full-width element (GPU discipline kept: clip + transform only).
   The opposite page's own content stays rendered underneath and is progressively
   revealed as foldX → 0. Physical note: mid-turn, the left page would actually be
   covered by the *back* of the turning page — so phase 2's underneath-left shows
   the *incoming spread's* left page only after foldX passes 0; during phase 2 the
   old left page is dimmed by the `pt-ambient-shadow` moving with the fold.
4. **Flap & shadows.** The existing flap, fold shadow, and edge highlight already
   ride `fx`; they simply continue tracking `foldX` across the spine. Add a soft
   contact shadow on the back-sheet's leading edge (reuse `pt-fold-shadow`
   element, it already follows the fold).
5. **Drag parity.** `TurnGestureController` maps drag distance to progress `p`
   (`rawP = dx/W` uses `leafW`); for full-spread it must use the full spread width
   so the page follows the pointer 1:1 across both halves (one-line change where
   `W = this.compositor.leafW` is read, ~line 3990).
6. **Settle behavior.** `PageTurnPhysics` is unchanged (still p∈[0,1]); commit
   threshold 0.38 still feels right because the crossover is at 0.5.
7. **Fallback.** Keep the old half-leaf behavior behind
   `PageTurnConfig.fullSpreadFold = true|false` (default true) so any visual
   regression can be reverted by config, and `quality:'basic'` skips phase 2
   entirely (old look).

**Perf/GPU notes.** One extra composited element (`pt-back-sheet`) visible only in
phase 2; all per-frame writes remain clip-path/transform/opacity. Snapshot pool
unchanged (same 2 snapshots per turn).

**Risks.**
- Phase 1 clip inversion is the delicate part — the sheet must still *look* like
  the same page (content anchored, fold eating from the spine side outward). Build
  behind the config flag and A/B against the current flip before defaulting.
- Backward turns mirror everything — implement dir-symmetric from the start.
- Interaction with `#gutter`/spine valley shadow: the valley gradient should fade
  out during phase 2 (the "book" is mid-air); tie its opacity to
  `1 - |2p-1|` … actually to `min(p, 1-p)·2`.

**Test plan.** (1) Spread mode, slow-drag forward: front page lifts from right,
back-of-page covers the left page by mid-turn, settles flat as the new spread.
(2) Same backward. (3) Fling from 10% progress commits correctly. (4) Single-page
mode visually unchanged (full-spread logic gated by `isSpread`). (5) Boundary turn
(end of book) shows no ghost back-sheet. (6) 100-turn perf trace vs baseline.

**Effort: M** (geometry care, not volume).

---

## Suggested implementation order

1. **A-A** (S) — quick win, also fixes the ✕ annoyance.
2. **P-B** (S–M) — makes everything after it smoother to verify.
3. **A-C** (S–M) + **A-S** (M) — same subsystem (compositor), land together behind
   the `fullSpreadFold`/texture config flags.
4. **A-B** (S–M) — independent UI.
5. **P-A** (M–L) — biggest but most self-contained; ships last with its fallback.

---

## Explicit test suite (design)

**Goal.** Repeatable, automated confirmation that every feature — the already-shipped
batch **and** each item designed above — behaves as expected. No test currently
exists; everything so far was verified by hand-driven smoke checks that cannot be
re-run cheaply.

### T1. Harness

Two layers, both runnable from one command (`npm test`):

1. **Frontend browser suite — `tests/e2e/` (Playwright, dev-only dependency).**
   - `npm test` starts `http-server` on `src/` (port 8124) and launches headless
     Chromium at 1360×860, then runs the spec files below.
   - The app is a single static HTML file with no build step, so the suite drives
     the real page — same as a user — via `page.evaluate` for state assertions and
     real input events (wheel, keys, pointer) for interaction.
   - Shared helpers in `tests/e2e/helpers.mjs`:
     - `openDemo(page)` — click "Read the sample", wait for
       `body.state-reading` (the built-in demo book powers everything; no fixtures).
     - `badge(page)` / `pct(page)` — read `#pageBadge` / `#pct` text.
     - `iframeDoc(page)` — return the live chapter iframe's `contentDocument`.
     - `fresh(page)` — `localStorage.clear()` + reload (suite isolates every spec
       this way so persisted state never leaks between tests).
   - TTS assertions mock `speechSynthesis` before the app script runs
     (`page.addInitScript`): a fake that records `speak()` calls and fires `onend`
     after a tick — real voices don't exist headless, and the suite must not depend
     on audio hardware. Network lookups (dictionary API) are routed to
     `page.route` fulfill stubs so `DictCache` behavior is deterministic.
2. **Rust unit suite — `src-tauri/tests/` + `#[cfg(test)]` in `lib.rs` (`cargo test`).**
   - Pure-logic tests for the cache/manifest/sanitizer pieces (P-A, below); no
     window needed.

### T2. Regression specs — shipped features (`tests/e2e/shipped.spec.mjs`)

| ID | Test | Steps | Pass criteria |
|---|---|---|---|
| R1 | Book opens + global pages | `openDemo`, wait 3 s | `state-reading`; badge matches `/Page \d+ of \d+/`; `LocEngine.ready()` true |
| R2 | Locations persisted | reload page, `openDemo` again | Second open reaches `LocEngine.ready()` with **no** `generate()` call (spy via `book.locations.generate` wrap in init script); `localStorage['folio-locs:The Time Machine']` exists |
| R3 | Keyboard/wheel turns | press `ArrowRight`; dispatch `WheelEvent(deltaY:240)` on window AND inside chapter iframe | badge advances by 1 after each; both surfaces turn (guards the iframe-binding regression found on 2026-09-25) |
| R4 | Rail scrub | `railSeek(0.5)` then `railSeek(1)` then `railSeek(0)` | badge strictly changes for 0.5; end-jump clamps (`Page ≤ total`, never 11/10 — regression found earlier); 0 returns to `Page 1` |
| R5 | TTS lifecycle | mock synth; `TTS.toggle()` | `active=true`, `sents.length>0`, first `speak()` text equals `sents[0].text`; `TTS.toggle()` pauses; `TTS.stop()` clears highlight and `active=false` |
| R6 | TTS auto-advance | fake `onend` fires immediately; stub `turn` to resolve | after last sentence, `rendition.next()` was called once; at book end (rail to 1 first) TTS stops instead |
| R7 | Highlight add/list/jump | `rendition.emit('selected', cfi)` with test CFI → click `#selHl` → click yellow dot | `folio-highlights` has 1 entry; `#hlCountBadge` = 1; `setTocTab('hl')` renders card with snippet; click card calls `display(cfi)` (spy) |
| R8 | Highlight popup | call `Highlights.openPop(id,{clientX,clientY})` | `#hlPop` visible within viewport bounds; color dot click re-adds annotation with new fill (spy `annotations.add`); Delete removes entry |
| R9 | Warmth | set slider 60 | `#warm` opacity > 0; `warmthOff` resets to 0; value survives reload via `folio-settings` |
| R10 | Per-book typography | enable `perBookType`, `settings.size=21`, `save()`, wait 300 ms | `folio-typo:<title>.size===21`; `loadPerBookType` on fresh open restores 21 while global `folio-settings` size unchanged |
| R11 | Footnote popup | inject `<a href="#fn1">n</a><p id="fn1">note text</p>` into chapter doc, click link | default navigation prevented; `#fnPop.show` contains "note text"; outside click closes |
| R12 | Image lightbox | inject `<img src="data:...1x1">` into chapter doc, click | `#lightbox.show` with same src; Esc closes |
| R13 | Dict cache | `page.route` the API to `{meanings:[{partOfSpeech:"noun",definitions:[{definition:"a test"}]}]}`; click Define on "test" | first call shows "(noun) a test" and writes `folio-dict:test`; second call (route now aborts) still resolves from cache, no network |
| R14 | Closed drawers leave no chrome | open+close TOC, search, sheet; then `elementFromPoint(27,38)` | no drawer close-icon SVG is hit-testable there (the ✕ regression, once A-A's `visibility` fix lands) |
| R15 | Boot-open integration | `page.addInitScript` faking `window.__TAURI_INTERNALS__.invoke` mapping `get_initial_file→'C:/b.epub'`, `read_file_bytes→ArrayBuffer(demo epub built in-test via JSZip)` | app opens the book without any user click |
| R16 | Autoscroll | middle-click (`pointerdown button:1`) | `AutoScroll.active` true; pointermove +130 px triggers `next()` once per rate window; left-click stops |

### T3. Design-item specs (`tests/e2e/design.spec.mjs` — added as each lands)

| ID | Covers | Test | Pass criteria |
|---|---|---|---|
| D1 | **A-A** pill | `openDemo`; turn twice | `#posPillCh` equals current chapter label; `#posPillPct` equals `#pct`; click opens `toc-open`; long-title chapter truncates (scrollWidth ≤ clientWidth) and `#bookTitle` still fully visible at 800 px viewport |
| D2 | **A-A** ✕ fix | cold open + open/close each drawer | hit-test at (27,38) never returns a drawer element (shared with R14, kept for the closed-state matrix) |
| D3 | **A-B** ribbon | `openDemo`; move to 50% | segment count = chapter count (capped 240); playhead `left` ≈ pct ± 1 px; click 3rd segment displays its href (spy); ribbon dimmed (opacity < 1) when `chrome-hidden` |
| D4 | **A-B** weights | finish locations; force `Ribbon.rebuild()` | segments re-proportion by location counts within one frame (no FOUC: rebuild swaps a detached node) |
| D5 | **A-C** texture/layers | 20 rapid turns with `performance.mark/measure` around each `playTurnFx` | median turn frame time within 1 ms of baseline recorded with texture chip off; grain tile cached (single `toDataURL` call — spy) |
| D6 | **A-S** full-spread phase 1 | spread mode (viewport 1360 ⇒ feasible); slow-drag 30% via pointer events | front sheet clip shows un-turned remainder `[foldX, VW]`; underneath page visible right of fold; left page untouched |
| D7 | **A-S** phase 2 overlap | drag to 70% | `pt-back-sheet` present, spans `[foldX, spineX]`, lies above the left page (z-order assert via `elementFromPoint` at left-page center); spine valley opacity ~0 at mid-turn |
| D8 | **A-S** symmetric + commit | backward drag 30%; fling from 10% | backward mirrors D6/D7; fling reaches p=1 and rendition advanced once |
| D9 | **A-S** flag off | `PageTurnConfig.fullSpreadFold=false` | old half-leaf behavior (no `pt-back-sheet` ever created); single-page mode never creates it either |
| D10 | **P-B** slicing | build a 300-chapter stress EPUB in-test (JSZip loop); open; record `performance` long tasks > 50 ms in first 5 s | zero long tasks; index progress advances across multiple idle ticks; hide window (`page.evaluate → document.hidden` stub) pauses generation |
| D11 | **P-B** resume | stop mid-index (reload) after ≥ 10 chapters | IndexedDB record has `partial:true, done≥10`; reopen resumes at `done` without reprocessing chapter 0 (spy on `item.load`) |

### T4. Rust unit tests (`cargo test`)

| ID | Covers | Test | Pass criteria |
|---|---|---|---|
| U1 | P-A cache key | same len+mtime → cache hit; changed mtime → miss | `BookCache::get` returns Some/None accordingly |
| U2 | P-A LRU eviction | insert 5 books over the 4-entry cap | least-recently-used evicted, newest never evicted; total bytes ≤ cap |
| U3 | P-A zip-slip | fixture zip with `../evil.txt`, `C:/abs.txt`, `ok.xhtml` | `sanitize_entry` rejects the first two, accepts the third; nothing written outside cache root |
| U4 | P-A manifest | unzip fixture → reload manifest | file list round-trips byte-identical; mtime mismatch triggers re-unzip decision (pure fn on the key) |
| U5 | GPU flags merge | call the flag-merge helper with preset/empty/custom env values | existing user value wins; no duplicate flags; empty → flags only (extract the merge logic into a testable `fn` — it is currently inline in `run()`) |

### T5. Manual-only checklist (not automatable headless)

- Real speech voices (rate slider, pause/resume on actual audio pipeline).
- Single-instance forwarding: run the packaged `app.exe` twice with different
  `.epub` args (second launch focuses window and swaps books).
- MSI install → `.epub` double-click association → boot-open in packaged build.
- GPU rasterization flags effective: `chrome://gpu` inside WebView2 shows
  "Hardware accelerated" for rasterization (packaged app only).
- Page-flip feel (A-C/A-S) on the target machine — visual, judge by eye.

### T6. Wiring & CI

- `package.json`: `"test": "npm run test:rust && npm run test:e2e"`,
  `test:e2e`: start server + `playwright test`; `test:rust`: `cd src-tauri && cargo test`.
- Dev-only deps: `playwright`, `http-server` (no runtime impact on the 9 MB binary).
- Every spec file uses `fresh(page)` isolation; global timeout 15 s; failures
  screenshot to `tests/e2e/artifacts/` for triage.
- Recommended pre-release gate: `npm test` green + T5 checklist signed off.

**Effort: M** (harness + R1–R16 ≈ 1 day; D/U specs grow incrementally as each
design item lands — each spec is written in the same change as its feature, not
after).
