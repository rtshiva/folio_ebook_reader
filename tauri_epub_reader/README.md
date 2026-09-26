# Folio Reader — Desktop App (Tauri 2.0)

A high-performance, lightweight desktop EPUB reader built with Tauri 2.0 and native Windows Edge WebView2.

## Features

- **Ultralight Desktop Binary**: Complete standalone executable under ~9 MB.
- **True Offline Support**: Bundles `jszip.min.js`, `epub.min.js`, and core reading styles locally—zero internet or CDN required.
- **Native `.epub` File Association**: Configured in `tauri.conf.json` so double-clicking any `.epub` file on Windows launches the reader directly.
- **Single Instance with File Forwarding**: A second launch (e.g. another double-clicked `.epub`) forwards its path to the running window instead of spawning a duplicate.
- **Instant Re-opens & Unzipped Disk Cache**: Re-opening previously read books uses a zip-slip-safe Rust disk cache served via custom `folio-cache://` protocol, bypassing JSZip decompression in the JS heap with 600 MB / 30-book LRU disk eviction and in-memory raw binary IPC fallback.
- **Drag & Drop**: Drop `.epub` files directly into the desktop window.
- **Hotkeys**:
  - `Ctrl + O`: Open native file dialog to pick an EPUB.
  - `D`: Toggle between dual-page spread and single-page layout.
  - `Left` / `Right` or `Space`: Turn pages.
  - `T`: Toggle table of contents.
  - `A`: Toggle typography & settings panel.
  - `R`: Play/pause read aloud, `Shift + R`: stop, `-` / `=`: read-aloud speed.
- **Reading Engine**:
  - Dual-page spread and single-page reading modes.
  - 3D paper flip & slide page turn animations, GPU-accelerated (transform/opacity only) with forced GPU rasterization in WebView2.
  - Dynamic page width slider and responsive auto-fit.
  - Bionic reading, reading ruler/guide, custom font sizes, line heights, letter and word spacing.
  - Optional per-book typography memory and night warmth (blue-light) slider.
  - Text-to-speech read aloud: play/pause (`R`), stop (`Shift + R`), speed (`-` / `=`), sentence highlighting, and auto page advance.
- **Navigation & Progress**: Book-wide page numbers ("page N of M") with per-book persistence, plus a draggable progress rail with page-granularity scrubbing. A top-left contents pill always shows the current chapter and percent — one click opens the contents. A hairline chapter ribbon across the very top maps the book structurally with a live position marker (click any segment to jump).
- **Paper-grade page turns**: shared-grain paper texture (toggleable), warm fold lighting, crease sheen, page-edge hints, and a full-spread flip whose back sweeps over the opposite page.
- **Highlights & Notes**: Highlight selections in four colors, add notes, and manage them from the contents drawer — stored per book.
- **Mouse & Wheel Input**: Wheel turns pages (also inside book pages), `Ctrl + Wheel` changes font size, `Alt + Wheel` changes page width, middle-click toggles auto-scroll.
- **Extras**: Footnote popups, image lightbox, page-turn sound toggle, and an offline cache of previously fetched word definitions.

## Project Structure

```
tauri_epub_reader/
├── docs/                      # Technical documentation
│   ├── DESIGN_AND_LLD.md      # Comprehensive design document & Low-Level Design (LLD)
│   ├── FEATURES.md            # Features tracking & roadmap
│   └── DESIGN-IMPROVEMENTS.md # Performance & UI design notes
├── package.json               # Scripts: "dev", "build", "test" (cargo + Playwright e2e)
├── playwright.config.mjs      # Serves src/ on :8124, runs tests/e2e
├── tests/e2e/                 # Playwright specs (helpers, shipped, design) + failure artifacts
├── src/                       # Desktop frontend
│   ├── index.html             # The Folio reader adapted for desktop
│   └── vendor/                # Local offline vendor bundles & local WOFF2 fonts
│       ├── jszip.min.js
│       ├── epub.min.js
│       └── fonts/
└── src-tauri/                 # Rust backend
    ├── Cargo.toml             # Tauri 2 dependencies
    ├── tauri.conf.json        # Window settings, permissions & file associations
    └── src/
        ├── main.rs
        └── lib.rs             # Tauri commands (get_initial_file, read_file_bytes, book_open, pick_file) & folio-cache:// protocol
```

## Running the App

### Development Mode
From the `tauri_epub_reader` directory:
```powershell
npm run dev
# or
npx tauri dev
```

### Production Build
To compile the standalone optimized release binary:
```powershell
npm run build
# or
npx tauri build --no-bundle
```
The compiled executable will be at:
`src-tauri/target/release/app.exe`

### Automated Tests
```powershell
npm test            # cargo test (U1–U5) + Playwright e2e (29 specs, demo-book driven)
npm run test:e2e    # browser suite only
npm run test:rust   # Rust unit tests only
```
