# Bug review — `tauri_epub_reader/src/index.html`

> Review-only pass over the full file (10,958 lines). **No code was changed.**
> Reviewed: Nov 11 2026.

> **STATUS (Nov 12 2026):** All items below were remediated by commits
> `de477a1` + `893e8e3`; a regression spot-check confirmed the fixes landed —
> with **one remnant**: the duplicate CSS blocks originally behind #7/#8's
> popup styling still exist at lines 557–571 vs 585–599, now tracked as
> **C-2** in [`configs-and-tooling-review.md`](configs-and-tooling-review.md).
> See that file's "Regression spot-check" section for the per-item verification.

## Confirmed bugs

### 1. `validateSettings()` validates settings keys that don't exist
**Lines:** 1889–1905 (DEFAULTS at 1837–1851)

It checks/clamps `settings.fontSize`, `settings.letterSpacing`, `settings.wordSpacing` — but `DEFAULTS` and all UI use `size`, `letter`, `word`.

- Since `Number.isFinite(undefined)` is always true for these, the function *writes* `settings.fontSize = DEFAULTS.fontSize` → `undefined`, creating garbage keys that get persisted by `save()`.
- The real `size` / `letter` / `word` values are never validated at boot. Only `size` gets a point-of-use clamp (`effSize()`, line 2155); a corrupt stored `letter` / `word` passes straight into CSS.

**Impact:** settings validation is entirely dead for the real typography keys.

---

### 2. Duplicated toast in `TTS.setEngine`
**Line:** 7961

```js
toast('Read aloud engine: ' + ...);    toast('Read aloud engine: ' + ...);
```

The exact same statement appears twice on one line — every engine switch shows two identical toasts.

---

### 3. `TTS.supported()` uses an unrelated condition
**Lines:** 7925–7926

```js
return ('speechSynthesis' in window && 'SpeechSynthesisUtterance' in window) || !!window.PAGE_ART;
```

`window.PAGE_ART` is the page-ornament sprite data (line 3529), unrelated to speech. On a browser without `speechSynthesis` but with ornaments loaded, read-aloud reports "supported" and the system path then fails.

---

### 4. `applyEnvironment()` writes display-name fonts instead of canonical ids
**Lines:** 9612–9654 (related: 9678–9679, 2298, 2079, 9521, 1907–1914)

Sets `settings.font = 'Literata'` / `'Lexend'`, but `FONTS` / `FONT_DNA` are keyed by lowercase ids (`'literata'`, `'lexend'`, …). Consequences:

- `FONTS['Lexend']` is undefined → `applyFit()` / `buildCSS()` (line 2298) fall back to `FONTS.literata`, so the **"Clean" environment silently renders in Literata serif instead of Lexend** (Literata works only via accidental fallback).
- `FONT_DNA['Lexend']` misses (line 2079) → typographic harmony uses wrong font metrics.
- `syncFontSel()` (line 9521) compares against lowercase ids → **no font button shows as selected** after picking an environment.
- The capitalized values are normalized to lowercase at next boot (lines 1907–1914), after which `isPaper` / `isClean` (lines 9678–9679, comparing the capitalized names) become false → the environment card loses its selected state after restart.

---

### 5. Vacuous condition in `syncEnvCards()`
**Line:** 9680

```js
const isNight = settings.theme === 'noir' && (settings.warmth > 0 || settings.theme === 'noir');
```

The second operand makes the warmth check dead; it always reduces to `theme === 'noir'`.

---

### 6. Page cache is captured before bionification
**Lines:** 3711–3717 vs 3718–3725 (compositor replay at 6341–6345)

`onContent()` serializes `cleanHtml` **before** `bionifyDoc()` (3718) and before the `loading=lazy` / `decoding=async` img attributes (3721–3724) are applied. The turn compositor replays the cached HTML (`pageCache.getChapterHtml()`, 6341), so with bionic reading on, adjacent/turning pages render without bionic styling while the live page has it — visible mismatch mid-flip.

---

### 7. Highlight popup outside-click listeners accumulate
**Lines:** `Highlights.openPop` 5650–5655

Each open adds a `pointerdown`-capture `close` via `setTimeout(0)`; it only removes itself when an *outside* pointerdown fires. Closing via `hidePop()` (Save note, Delete, Esc, `closePanels`, `closeBook`) leaves them attached; reopening before any outside click stacks closures (each self-heals on the next outside pointerdown, but they accumulate until then).

---

### 8. Footnote popup outside-click closer leaks
**Lines:** `Footnotes.show` 8734–8739; `Footnotes.close` 8659

`Footnotes.close()` removes the popup but never removes the `pointerdown`-capture `closer` added in `show()`; closing via ✕ (or Esc) leaves the listener attached until some later outside pointerdown fires it. Same pattern as #7.

---

### 9. `KittenRunner.install(onProgress)` ignores its callback
**Lines:** 7790–7801 (callers: 7944, 7968; badge at 8045–8047, 8066–8067)

There is no download-progress tracking at all — `installPct` jumps −1 → 100. The callbacks passed by `TTS.kittenInstall()` (7944) and `setEngine()` (7968) are never invoked, so the "Installing… X%" badge branch in `syncVoiceUI` is unreachable mid-install; the badge shows "not installed" until it suddenly says ready.

---

### 10. Near-duplicate Open-With implementations
**Lines:** `tauriOpenPath` 10902–10936; `openEpubPath` 10827–10866

Two nearly identical copies of the same flow (pending-park, `book_open` with fallback, `read_file_bytes`). `window.__folioOpenPath = tauriOpenPath` (10937) while `checkStartupFile()` uses `openEpubPath` — any fix applied to one copy silently misses the other.

---

### 11. Extra ignored argument to `TTS.startGroupHighlight`
**Line:** 8217 vs signature at 8170

Called as `startGroupHighlight(group, gu, ctx.currentTime)` but the method signature is `(g, gu)` — the third argument is silently dropped. Harmless, but misleading.

---

## Minor / fragility issues

### 12. `buildCSS` hash includes `settings.warmth` but the CSS never uses it
**Lines:** 2292 (hash) vs 2300–2398 (generated CSS)

Warmth lives on the shell overlay, not the chapter CSS. Any `refreshCSS()` after a warmth change rebuilds an identical stylesheet and re-retints the whole page cache for nothing.

### 13. `panelsOpen()` TDZ fragility
**Line:** 8773

`typeof CmdPalette !== 'undefined'` does **not** protect against the temporal dead zone of a top-level `const` (`typeof` throws for `let`/`const`, unlike undeclared vars). Safe today only because the first call happens after full script evaluation.

### 14. Bookmark matching is page-granular
**Lines:** ~5010–5100 (`isPageBookmarked` / `toggleBookmark`)

CFI matching by spine-prefix + fragment can match/remove the wrong bookmark after repagination.

### 15. Position-key collisions
`state.posKey` uses title + `filePath` sanitized to `[a-zA-Z0-9_-]`, so `a/b.epub` and `a_b.epub` collapse to the same key — reading positions can cross books sharing a title.

### 16. Vocab-log key mismatch
`VocabLog` writes under `state.currentTitle` (possibly `''` → key `vocab:`) while the stats UI reads via `getActiveTitle()` (which can return `'Folio'`) — counts can be written/read under different keys on the landing screen.

### 17. Sanitization gap in the chapter path
**Lines:** `sanitizeChapterHtml` 1794–1822 (`FORBIDDEN_TAGS` at 1801) vs `sanitizeDomNode` 1763–1792

`FORBIDDEN_TAGS` omits `STYLE`, `LINK`, `FORM`, and the chapter path keeps `style` attributes — unlike the popup path's `sanitizeDomNode` (1787), which strips all of them. Book chapters can inject arbitrary CSS into their iframe and `<link>` remote-stylesheet beacons. Hardening gap only (`SCRIPT` / `IFRAME` / `on*` / `javascript:` are covered).

### 18. Linked images navigate instead of lightboxing
`wireContents` click handler: `closest('a')` wins over `img`, so an image wrapped in an anchor opens as a link rather than in the Lightbox.

---

## Verified *not* bugs (checked to avoid false positives)

- `tauriInvoke`, `folioCacheUrl`, `ipcByteLength`, `ipcToBuffer`, `openEpubPath` — all defined at lines 10800–10866 as hoisted function declarations; references at 3450 / 3501 / 4969 / 4976 resolve fine.
- `openBuffer`'s `pending.tauriPath` drain (3446–3450) is **live** — `openEpubPath` / `tauriOpenPath` park `{ tauriPath }` at 10832 / 10906.
- The double-bound turn-gesture targets (viewer + stage bubbling) and the per-iframe keydown listeners are properly guarded — no double handling.

---

## Suggested priorities

1. **#1** — settings validation is entirely dead for the real keys
2. **#4** — "Clean" environment's Lexend font silently never applies
3. **#6** — bionic mismatch in the turn compositor
