# Folio Reader — Desktop App (Tauri 2.0)

A high-performance, lightweight desktop ebook reader supporting **EPUB 2/3, MOBI, AZW, and AZW3** built with Tauri 2.0 and native Windows Edge WebView2.

## Features

- **Ultralight Desktop Binary**: Complete standalone executable under ~9 MB.
- **Offline-First Support**: Bundles `jszip.min.js`, `epub.min.js`, `Space Grotesk`, and local WOFF2 reading fonts—no internet required for reading.
- **Native File Associations**: Configured in `tauri.conf.json` so double-clicking any `.epub`, `.mobi`, `.azw`, or `.azw3` file on Windows launches the reader directly.
- **Single Instance with File Forwarding**: A second launch (e.g. another double-clicked ebook file) forwards its path to the running window instead of spawning a duplicate.
- **Instant Re-opens & Unzipped Disk Cache**: Re-opening previously read books uses a zip-slip-safe Rust disk cache (and PalmDOC LZ77 decompression for MOBI/AZW) served via custom `folio-cache://` protocol, bypassing JSZip decompression in the JS heap with 600 MB / 30-book LRU disk eviction and in-memory raw binary IPC fallback.
- **Drag & Drop**: Drop `.epub`, `.mobi`, `.azw`, or `.azw3` files directly into the desktop window.
- **Hotkeys**:
  - `Ctrl + O`: Open native file dialog to pick an ebook (EPUB, MOBI, AZW, AZW3).
  - `D`: Toggle between dual-page spread and single-page layout.
  - `Left` / `Right` or `Space`: Turn pages.
  - `T`: Toggle table of contents.
  - `S`: Toggle typography & settings panel.
  - `R`: Play/pause read aloud, `Shift + R`: stop, `-` / `=`: read-aloud speed.
- **Reading Engine**:
  - Dual-page spread and single-page reading modes.
  - 3D paper flip & slide page turn animations, GPU-accelerated (transform/opacity only) with forced GPU rasterization in WebView2.
  - Dynamic page width slider and responsive auto-fit.
  - Bionic reading, reading ruler/guide, custom font sizes, line heights, letter and word spacing.
  - Optional per-book typography memory and night warmth (blue-light) slider.
  - Text-to-speech read aloud: System voices (`speechSynthesis`) and offline **KittenTTS neural voices** via local WebAssembly / ONNX runtime. Play/pause (`R`), stop (`Shift + R`), speed (`-` / `=`), sentence highlighting, and auto page advance.
- **Navigation & Progress**: Book-wide page numbers ("page N of M") with per-book persistence, plus a draggable progress rail with page-granularity scrubbing. A top-left contents pill always shows the current chapter and percent — one click opens the contents. A hairline chapter ribbon across the very top maps the book structurally with a live position marker (click any segment to jump). Edge-hover chapter navigation panels (`#chNavLeft`/`#chNavRight`) provide quick chapter jumping with clamped desk margin pills.
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
├── package.json               # Scripts: "dev", "build", "test", "scan", "lint"
├── playwright.config.mjs      # Serves src/ on :8124, runs tests/e2e
├── tests/e2e/                 # Playwright specs (helpers, shipped, design) + failure artifacts
├── tests/                     # Static security and regression scans (scan-file-handling.mjs)
├── src/                       # Desktop frontend
│   ├── index.html             # The Folio reader adapted for desktop (~10,500 lines)
│   └── vendor/                # Local offline vendor bundles, fonts & neural models
│       ├── jszip.min.js
│       ├── epub.min.js
│       ├── kitten/            # KittenTTS ONNX WASM SIMD runtime and bundles
│       └── fonts/
└── src-tauri/                 # Rust backend
    ├── Cargo.toml             # Tauri 2 dependencies
    ├── tauri.conf.json        # Window settings, permissions & file associations
    └── src/
        ├── main.rs
        ├── lib.rs             # Tauri commands, folio-cache:// protocol & LRU cache (~2,100 lines)
        └── mobi.rs            # MOBI / AZW / PalmDOC decompressor & unpacker (~1,800 lines)
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

### Automated Tests & Quality Assurance

Folio maintains rigorous verification across Rust and JavaScript suites:
- **42 Rust unit & security tests** (`npm run test:rust`): Covers BookCache LRU, Zip-Slip prevention, PalmDOC LZ77 decompression, MOBI unpack roundtrip, and cache eviction.
- **27 static scan tests** (`npm run scan`): Verifies IPC safety, security policies, DOM invariants, and theme tokens.
- **ESLint code quality** (`npm run lint`): Validates frontend scripting standards.
- **Clippy clean**: 0 warnings across all targets (`cargo clippy --all-targets`).
- **Zero npm vulnerabilities**: Clean audit across all package dependencies.

```powershell
npm test            # runs 42 Rust tests + 27 static scan tests + Playwright e2e suite
npm run test:rust   # runs 42 Rust unit and security tests only
npm run scan        # runs 27 static invariant and security tests
npm run test:e2e    # runs Playwright browser suite only
npm run lint        # runs ESLint checks
```
