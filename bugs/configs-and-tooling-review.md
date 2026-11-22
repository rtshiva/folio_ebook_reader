# Code review — configs, tooling & regression spot-check of patched `index.html`

> Read-only review, Nov 12 2026. Covers `tauri.conf.json`, `Cargo.toml`,
> `capabilities/default.json`, `main.rs`, `package.json`, the vendor stubs,
> `page-art.js`, `tests/scan-file-handling.mjs`, `voice_testing/*`, and a
> regression pass over the areas patched by commits de477a1 + 893e8e3 in
> `tauri_epub_reader/src/index.html`. **No code was changed.**

---

## High

### C-1. `tauri.conf.json` lacks `app.withGlobalTauri: true`, so every `window.__TAURI__` path in the frontend is dead
**File:** `tauri_epub_reader/src-tauri/tauri.conf.json` (no `withGlobalTauri` key; `app` block lines 9–22)
**File:** `tauri_epub_reader/src/index.html` — event listen at 11377; Footnotes `opener.openUrl` / `shell.open` fallbacks; `window.__TAURI__` checks

In Tauri v2 the `window.__TAURI__` global only exists when
`app.withGlobalTauri: true` is set (the `@tauri-apps/api` npm import produces
`__TAURI_INTERNALS__`, which does exist — but code branching on
`window.__TAURI__` never takes it). Consequences in this app:

- The `'open-epub-file'` event-listen path (index.html:11377) is doubly dead —
  no Rust code emits the event (see lib-rs-review M-5) *and* the listener
  branch requires `window.__TAURI__`, which never exists.
- Footnote-popup link handling: the `opener.openUrl` / `shell.open` fallbacks
  silently no-op and fall back to `window.open`, which WebView2 may block in
  this build — external links may do nothing.

Compounding it: **no opener or shell plugin exists in `Cargo.toml`** (only
`tauri`, `tauri-plugin-log`, `tauri-plugin-single-instance`, `rfd`, `zip`,
`sha2`), so even with the global, `opener.*` / `shell.*` would fail. Also note
`capabilities/default.json` grants only `core:default` — no
`opener:default`/`shell:*` permissions. Either wire the plugins + capability +
flag, or delete the dead branches.

---

## Medium

### C-2. Regression remnant: duplicate highlight-popup CSS blocks with conflicting values survive the remediation
**File:** `tauri_epub_reader/src/index.html`, lines **557–571** vs **585–599**

Two full copies of the highlight/note-popup stylesheet exist. The second block
wins on ties (same specificity, later in source), producing a **hybrid**:

| Selector | Block 1 (557–571) | Block 2 (585–599) | What actually applies |
|---|---|---|---|
| `.hl-dot` | `border:2px solid transparent; padding:0` | no `padding:0` | block 2 → dots render 2px larger |
| `#hlPop .hl-pop-dots` | `margin-bottom:10px` | `justify-content:center; margin-bottom:10px` | block 2 |
| `#hlPop textarea` | `min-height:56px; resize:vertical; bg 4%-mix; 13px var(--serif)` | `height:60px; resize:none; bg transparent; 12px var(--sans)` | block 2 (serif note box becomes sans, fixed 60px, no resize) |
| `#hlPop textarea:focus` | `border-color:var(--hairS)` | `border-color:var(--accent)` | block 2 |
| `.hl-pop-row` | `gap:6px; margin-top:8px` | `gap:8px; justify-content:flex-end; margin-top:10px` | block 2 |
| `.hl-pop-btn` | `flex:1; 11.5px; padding 7px 8px; color var(--muted)` | `12px; padding 6px 12px; color var(--ink)` | block 2 → **`flex:1` lost, buttons no longer stretch** |
| `.hl-pop-btn.danger:hover` | defined (571) | not defined | block 1 (markup uses `danger` at 5920) |
| `.hl-pop-btn.primary` | not defined | defined (598–599) | **dead** — markup never sets `primary` |

The JS (lines 5882–5921) sets `hl-pop-btn` and `hl-pop-btn danger` — matching
block 1's expectations — but block 2's overrides silently change the intended
look. One of the two blocks must go; keep the one that matches the markup's
class names (`danger`).

### C-3. Release CSP ships `'unsafe-inline'` and `'unsafe-eval'` in `script-src`
**File:** `tauri_epub_reader/src-tauri/tauri.conf.json:24`

```json
"script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:"
```

`unsafe-eval` defeats the XSS hardening in the chapter sanitizer (any injected
script in a book runs as same-origin code with full IPC reach: `read_file_bytes`
etc.). `unsafe-inline` is likely needed by the single-file `index.html` inline
boot script — the correct fix is extracting it to a file (or a nonce/hash), and
removing `unsafe-eval` unless something genuinely requires it (verify the
Kitten/WASM path — `wasm-unsafe-eval` may be sufficient without the broader
`unsafe-eval`).

### C-4. CORS/frame-ancestors origin allowlist omits the actual Windows production origin
**File:** `tauri_epub_reader/src-tauri/src/lib.rs:1147–1156, 1212` + `tauri.conf.json` (no `useHttpsScheme`)

Documented fully in **`bugs/lib-rs-review.md` H-1** — listed here because the
fix has a config component: either add `http://tauri.localhost` (+ the
`https://folio-cache.localhost` flavor) to the allowlist / `frame-ancestors`,
or set `app.windows[].useHttpsScheme` explicitly so the origin is
predictable. Listed here so it isn't lost when only the config file is touched.

---

## Low

### C-5. `Cargo.toml` has no `[profile.release]` tuning and template metadata
**File:** `tauri_epub_reader/src-tauri/Cargo.toml:1–8, end-of-file`

No `[profile.release]` (lto, codegen-units, opt-level, strip) — the shipped
binary is larger and slower than it needs to be. Package metadata is still the
cargo template: `name = "app"`, `description = "A Tauri App"`,
`authors = ["you"]`. Cosmetic, but it lands in any installer metadata.

### C-6. `scan-file-handling.mjs` checks are string-based and can false-pass
**File:** `tauri_epub_reader/tests/scan-file-handling.mjs` (reviewed, sound overall)

The 8 invariant checks are exact-string/substring greps of `index.html`. They
will not catch renamed helpers, reordered arguments, or logic moved into new
files. Fine as a regression tripwire; not a substitute for the e2e suite.
No action needed — just don't treat scan-green as proof.

### C-7. `voice_testing` dev tools: two minor defects
**File:** `voice_testing/tts_bench.mjs` — if the piper `models` dir has voices
but zero `.onnx`/`.json` pairs after filtering, the UI list ends up empty and a
select handler indexing `voices[0].file` throws. Also the hardcoded
`REPO = 'F:/Siva_f/...'` absolute path (line 17) breaks on other machines.
Dev-only.

**File:** `voice_testing/engines/ttslab_engine.py` — in the `/synth` error
path, `_send_error(500, ...)` is invoked after a 200 response with streaming
headers may already have been sent in some failure orders → `BrokenPipe`-style
secondary error instead of the intended status. Dev-only.

---

## Verified *not* bugs (for the record)

- **`main.rs`** — trivial, correct (`windows_subsystem` attr + `run()`).
- **`capabilities/default.json`** — minimal (`core:default`), least-privilege;
  correct for the currently-registered commands. (The missing plugin
  permissions are part of C-1, not a security gap.)
- **`package.json`** — scripts and dependency set consistent; `test` chains
  rust tests + static scan + e2e sensibly.
- **`src/vendor/kitten/node-stub.js` / `ort-node-stub.js`** — intentional
  stubs; the second deliberately throws (`onnxruntime-node unavailable in
  browser`) — correct behavior.
- **`src/assets/ornaments/page-art.js`** — pure data (base64 URIs) +
  regeneration comment; no logic to review.
- **The other patched `index.html` areas** — see "Regression spot-check" below.

---

## Regression spot-check of patched `index.html` (de477a1 + 893e8e3)

Verified fixed:

1. **`TTS.supported()`** (8272–8275) — now checks only `speechSynthesis` +
   `SpeechSynthesisUtterance`; the `PAGE_ART` false-positive is gone.
2. **Duplicate engine toast** (8310) — single `toast(...)` line now.
3. **Pre-bionic page cache** (3891–3909) — cache capture moved after
   `bionifyDoc()` and the lazy-img attributes, with an explanatory comment.
4. **KittenRunner progress** (8111–8135, 8397–8398) —
   `_progressCb` is stored and invoked; the install badge branch is reachable.
5. **Highlight popup closer leak** — `hidePop()` (5861–5867) removes
   `_popCloser`; `openPop()` (5940–5942) removes the previous closer before
   re-adding.
6. **Footnote popup closer leak** — `Footnotes.el()`/show path stores `_closer`
   and removes it on close (9061; 9137–9143).
7. **`validateSettings` key mismatch** — no `settings.fontSize` /
   `letterSpacing` / `wordSpacing` references remain (grep clean).
8. **Environment font names** — no `settings.font = 'Literata'` /
   `'Lexend'` assignments remain.
9. **Vacuous `isNight`** (10093) — now `settings.theme === 'noir'`.

Still broken: **C-2 above** (duplicate CSS blocks at 557–571 vs 585–599).

## Suggested priorities

1. **C-1** — wire (or delete) the `__TAURI__`/opener/shell contract
2. **C-2** — delete one duplicate CSS block
3. **C-3** — revisit `unsafe-eval` in the release CSP
4. **C-4** — origin allowlist (see lib-rs-review H-1)
