<p align="center">
  <img src="../resources/app-icon/folio-icon-128x128.png" alt="Folio Logo" width="96" height="96" />
</p>

# Folio Reader — Desktop App (Tauri 2.0)

A high-performance, offline-first desktop ebook reader supporting **EPUB 2/3, MOBI, AZW, and AZW3** built with Tauri 2.0 and native WebViews (Edge WebView2 on Windows, WebKit on macOS).

## Key Capabilities

- **Ultralight Standalone Executable**: Native desktop binary without electron bloat.
- **Offline-First Core**: Bundles `jszip.min.js`, `epub.min.js`, `Space Grotesk`, and local WOFF2 reading fonts — completely self-contained.
- **Native File Associations**: Configured in `tauri.conf.json` so double-clicking any `.epub`, `.mobi`, `.azw`, or `.azw3` file on Windows launches the reader directly.
- **Single Instance with File Forwarding**: Secondary launches forward their file path to the existing window instead of creating duplicate processes.
- **Instant Re-opens & Unzipped Disk Cache**: Re-opening books uses a zip-slip-safe disk cache served via the custom `folio-cache://` protocol with 600 MB / 30-book LRU disk eviction and in-memory raw binary IPC fallback.
- **Neural Text-to-Speech**: Native multi-threaded ORT inference via bundled KittenTTS model (`src-tauri/models/kitten_tts_mini_v0_8.onnx`, ~78 MB) with sub-0.20 RTF performance, alongside system `speechSynthesis` voices.
- **Paper-Grade Page Turns**: GPU-composited 3D fold flips (paper grain texture, warm fold lighting, crease sheen, damped-spring physics) animating only `transform` and `opacity` properties.
- **Dual-Axis Theming**: Independent selection of 7 paper/ink reading environments and surrounding Reading Room desk wallpapers with botanical margin vines and gold corner ornaments.
- **Reader Tools**: Four-color highlights, notes with Markdown export, full-book search (`Ctrl+F`), bookmarks, reading ruler, bionic reading, and offline word definition popups.

## Project Structure

```
tauri_epub_reader/
├── docs/                      # Technical documentation
│   ├── DESIGN_AND_LLD.md      # Low-Level Design (LLD) and system specifications
│   ├── FEATURES.md            # Features tracking & roadmap
│   └── DESIGN-IMPROVEMENTS.md # Performance & UI design notes
├── package.json               # Scripts: "dev", "build", "test", "scan", "lint"
├── playwright.config.mjs      # Playwright e2e test configuration
├── tests/                     # Static security and regression scans (scan-file-handling.mjs)
├── src/                       # Desktop frontend
│   ├── assets/                # App icon, tiles, and SVG ornaments
│   ├── index.html             # Unified reader application
│   └── vendor/                # Bundled libraries & local fonts
└── src-tauri/                 # Rust backend
    ├── Cargo.toml             # Tauri 2 & ORT dependencies
    ├── tauri.conf.json        # Window settings, permissions & file associations
    ├── icons/                 # Platform icons (.ico, .icns, tile PNGs)
    ├── models/                # Neural voice models
    └── src/
        ├── main.rs
        ├── lib.rs             # Tauri commands, folio-cache:// protocol & LRU cache
        └── mobi.rs            # MOBI / PalmDOC / AZW parsing & extraction
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
To compile the standalone optimized release binary and installers:
```powershell
npm run build
# or without installers:
npx tauri build --no-bundle
```
Compiled artifacts are placed in `src-tauri/target/release/`:
- `app.exe` (standalone executable)
- `bundle/nsis/Folio Reader_1.0.0_x64-setup.exe` (NSIS setup installer)
- `bundle/msi/Folio Reader_1.0.0_x64_en-US.msi` (MSI installer)

### Verification & Quality Assurance

Folio enforces rigorous test and verification standards:
- **68 Rust unit & security tests** (`npm run test:rust`): Covers BookCache LRU, Zip-Slip prevention, PalmDOC LZ77 decompression, MOBI unpack roundtrip, and cache eviction.
- **42 static scan tests** (`npm run scan`): Verifies IPC safety, security policies, DOM invariants, and theme tokens.
- **Zero Clippy warnings**: Clean `-D warnings` across all compilation targets.
- **Clean npm audit**: Zero high or critical vulnerabilities.

```powershell
npm test            # runs 68 Rust tests + 42 static scan tests + Playwright e2e suite
npm run test:rust   # runs Rust unit and security tests
npm run scan        # runs static invariant and security tests
npm run test:e2e    # runs Playwright browser suite
npm run lint        # runs ESLint checks
```
