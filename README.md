<p align="center">
  <img src="docs/app-icon.png" alt="Folio Logo" width="128" height="128" />
</p>

<h1 align="center">Folio — A Beautiful Reading Experience</h1>

<p align="center">
  <strong>An offline-first, beautifully crafted desktop ebook reader for Windows and macOS.</strong>
  <br>
  Supporting <b>EPUB 2/3, MOBI, AZW, and AZW3</b> with realistic page turns, refined typography, botanical page ornaments, neural text-to-speech, and immersive reading environments.
</p>

<p align="center">
  <a href="https://github.com/rtshiva/folio_ebook_reader/actions/workflows/build-installers.yml"><img src="https://github.com/rtshiva/folio_ebook_reader/actions/workflows/build-installers.yml/badge.svg" alt="CI Build" /></a>
  <a href="https://github.com/rtshiva/folio_ebook_reader/releases/latest"><img src="https://img.shields.io/github/v/release/rtshiva/folio_ebook_reader?color=blue&label=latest%20release" alt="Latest Release" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20(arm64)-orange" alt="Platform: Windows & macOS" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License: MIT" />
</p>

---

Folio is designed around a simple conviction: **reading a digital book should feel as comfortable, immersive, and visually tactile as reading a finely printed volume.**

Built with **Tauri 2**, **Rust**, **WebView2**, and **epub.js**, Folio pairs a low-overhead native backend with a bespoke reading canvas. Rather than presenting ebooks as sterile documents, Folio recreates the physical intimacy of reading — from spring-physics page turns and textured paper stock to decorative chapter openings, botanical margin vines, and full-book neural text-to-speech.

### What makes Folio unique?
- **Universal reflowable format support**: DRM-free **EPUB 2/3**, **MOBI** (Mobi 6/7/PalmDOC), **AZW**, and **AZW3 / KF8**.
- **Tactile page turns**: GPU-accelerated fold-sheet page flips with paper texture, crease sheen, warm fold light, and damped-spring drag physics.
- **Dual-axis reading aesthetics**: Independent selection of your paper/ink environment and your surrounding **Reading Room** desk wallpaper.
- **Botanical ornamentation**: Chapter-opening headpieces, gold corner cartouches, fleuron chapter continuation markers, and climbing margin vines.
- **Refined typography harmony**: Auto-fitting layout targeting ~68 characters per line with bundled typefaces (Literata, Lexend, Atkinson Hyperlegible, OpenDyslexic), drop caps, and bionic reading.
- **Neural Read Aloud (KittenTTS)**: High-fidelity offline neural voice synthesis powered by native multi-threaded ORT inference with fallback to WebAssembly.
- **Local-first privacy**: Zero telemetry, no cloud accounts, and fully offline operation.

![Folio's Reading Room — The Time Machine in the Royal Maroon room with per-chapter vine ornaments](docs/screenshots/reading-room.png)

## Downloads

Download the latest release from the **[GitHub Releases Page](https://github.com/rtshiva/folio_ebook_reader/releases/latest)**:

### Windows (64-bit)
- **[Windows NSIS Setup (.exe)](https://github.com/rtshiva/folio_ebook_reader/releases/latest)** — Recommended desktop installer with Start Menu integration and file associations.
- **[Windows MSI Installer (.msi)](https://github.com/rtshiva/folio_ebook_reader/releases/latest)** — Standard Windows Installer package for managed/enterprise environments.
- **[Standalone Portable Executable (.exe)](https://github.com/rtshiva/folio_ebook_reader/releases/latest)** — Single self-contained binary (`Folio.exe`) without installation.

### macOS (Apple Silicon arm64)
- **[macOS Disk Image (.dmg)](https://github.com/rtshiva/folio_ebook_reader/releases/latest)** — Drag-and-drop installer for Apple Silicon (M1/M2/M3/M4) Macs.
- **[macOS Application Tarball (.app.tar.gz)](https://github.com/rtshiva/folio_ebook_reader/releases/latest)** — Portable application bundle archive.

> [!NOTE]
> **macOS Gatekeeper notice**: macOS builds are currently unsigned. On first launch, right-click the application and select **Open** (twice), or run `xattr -cr "/Applications/Folio Reader.app"` in Terminal to clear the quarantine attribute.

---

## Architecture Overview

Folio marries a security-hardened native Rust host with an Edge WebView2 reading canvas:

```mermaid
flowchart TD
    subgraph Frontend ["Frontend (Edge WebView2)"]
        UI["Reading Interface & Typography Engine"]
        Renderer["epub.js Core"]
        Turns["GPU Page-Turn Compositor"]
        TTSWorker["KittenTTS WASM Fallback Worker"]
    end

    subgraph Backend ["Native Backend (Tauri 2 / Rust)"]
        IPC["Tauri IPC Commands (book_open, tts_synthesize)"]
        CustomProto["folio-cache:// Protocol Handler"]
        MobiEngine["PalmDOC / MOBI / AZW Unpack Engine"]
        ORT["ONNX Runtime Native Neural Inference"]
        DiskStore["Unzipped Disk Cache (600 MB / 30-Book LRU)"]
    end

    UI --> Renderer
    Renderer --> CustomProto
    CustomProto --> DiskStore
    IPC --> MobiEngine
    IPC --> ORT
```

- **Native Rust Host (Tauri 2)**: Handles window management, Windows & macOS file associations, single-instance routing (forwarding secondary file launches to the running window), and decompression bounds.
- **Custom `folio-cache://` Protocol**: High-throughput content-addressed cache protocol that serves pre-extracted book assets directly to WebView2 with strict Content Security Policies (`script-src 'none'`) and XML entity repair.
- **Native Neural TTS (ONNX Runtime)**: Multi-threaded native synthesis with sub-0.20 RTF (Real-Time Factor), volume-bounded PCM chunking, and fallback to WebAssembly in browser contexts.
- **GPU Page-Turn Compositor**: Pure `transform` and `opacity` shader animations that eliminate layout thrashing during page flips.

---

## Screenshots

| Reading Room (Royal Maroon) | Two-Page Spread |
|---|---|
| ![Reading Room with side vines and page corner art](docs/screenshots/reading-room.png) | ![Two-page spread](docs/screenshots/spread.png) |

| Library Landing | Single Page Reading |
|---|---|
| ![Landing page](docs/screenshots/landing.png) | ![Single page reading](docs/screenshots/reading.png) |

| Table of Contents | Typography & Reader Settings |
|---|---|
| ![Contents drawer](docs/screenshots/contents.png) | ![Typography settings](docs/screenshots/settings.png) |

| Keyboard Shortcuts Overlay | Velvet Night Theme |
|---|---|
| ![Shortcuts overlay](docs/screenshots/shortcuts.png) | ![Night theme](docs/screenshots/night.png) |

---

## Reading Environments

Seven curated environments, each with its own desk tone, cloth texture, and side-vine dressing:

| Natural Paper | Modern Clean |
|---|---|
| ![Natural Paper](docs/screenshots/theme-paper.png) | ![Modern Clean](docs/screenshots/theme-light.png) |

| Velvet Night | Aizome |
|---|---|
| ![Velvet Night](docs/screenshots/theme-noir.png) | ![Aizome](docs/screenshots/theme-aizome.png) |

| Ember | Velvet |
|---|---|
| ![Ember](docs/screenshots/theme-ember.png) | ![Velvet](docs/screenshots/theme-velvet.png) |

| Emerald | |
|---|---|
| ![Emerald](docs/screenshots/theme-emerald.png) | |

---

## Core Features

### Format Support & Ingestion
- **Formats**: Reflowable DRM-free **EPUB 2/3**, **MOBI** (Mobi 6/7/PalmDOC), **AZW**, and **AZW3 / KF8**.
- **Launch Vectors**: Native file dialog (`Ctrl+O`), drag & drop, CLI file arguments, and OS file association double-clicks with single-instance forwarding.
- **Decompression Safety**: Path traversal protection against Zip-Slip attacks, NTFS alternate data stream filters, and PalmDOC decompression byte quotas (256 MB bounds).
- **Recent Books Shelf**: Persistent reading shelf with cover thumbnails, read percentage, and exact CFI location restore.

### Reading Engine & Typography
- **Harmonic Typography**: Continuous slider control over font size (15–28 px), line height (1.2–2.2), page width (460–2000 px), and side/inside margins.
- **Embedded Offline Fonts**: Literata, Lexend, Atkinson Hyperlegible, OpenDyslexic, and Space Grotesk UI.
- **Page Presentation**: Single-page and dual-page spread (`D`), justified alignment, drop caps, bionic reading (bold word prefixes), and reading ruler/guide.
- **Per-Book Preferences**: Remembers independent typography, layout, and zoom preferences per title.

### Navigation, Bookmarks & Annotations
- **Progress Tracking**: Scannable progress bar, chapter ribbons, live reading percentage, time remaining, and page scrub preview.
- **Chapter Navigation**: Fixed or auto-hiding previous/next chapter hover panels with proximity protection.
- **Bookmarks & Highlights**: Four highlight colors, inline annotations, persistent per-book bookmark shelf, and one-click Markdown export.
- **Full-Text Search (`Ctrl+F`)**: Instant in-book full search with excerpt highlighting and jump-to-location.
- **Offline Dictionary**: Word selection definition popover with offline local caching.

### Neural Read Aloud (TTS)
- **Engine Options**: Native **KittenTTS neural voices** via local ONNX runtime (~78 MB bundled model) with thread-count clamping, or standard system voices (`speechSynthesis`).
- **Playback Controls**: Play/pause (`R`), stop (`Shift+R`), variable speed (0.5x–2.0x), synchronized sentence highlighting, and seamless cross-chapter advance.

---

## Keyboard Shortcuts

| Keys | Action |
|---|---|
| `→` / `Space` / `PgDn` | Next page |
| `←` / `PgUp` | Previous page |
| `[` / `]` | Previous / next chapter |
| `D` | Toggle single / two-page spread |
| `T` | Table of contents drawer |
| `S` | Typography & settings drawer |
| `Ctrl + F` | Search inside book |
| `B` / `Ctrl + B` | Add / remove bookmark |
| `R` / `Shift + R` | Play-pause / stop read aloud |
| `-` / `=` | Decrease / increase speech speed |
| `F` | Toggle full screen |
| `G` | Toggle reading ruler / guide |
| `Ctrl + O` | Open ebook file |
| `Mouse Wheel` | Turn pages (including inside page frames) |
| `Ctrl + Wheel` / `Alt + Wheel` | Adjust font size / page width |
| `Middle Click` | Toggle auto-scroll |
| `?` / `Esc` | Help overlay / close active drawers |

---

## Development & Building

### Prerequisites
- [Node.js](https://nodejs.org/) (v20+)
- [Rust](https://www.rust-lang.org/) (1.77.2+)
- Windows 10/11 with WebView2 runtime, or macOS 12+ (Apple Silicon)

### Commands

All development tasks run from the `tauri_epub_reader` directory:

```bash
cd tauri_epub_reader

# Install dependencies
npm ci

# Run development mode with hot reload
npm run dev

# Run full test suite (Rust unit tests, static scan, Playwright e2e)
npm test

# Run Rust unit and security tests (68 tests)
npm run test:rust

# Run static invariant & security scan (42 checks)
npm run scan

# Run Clippy lints with -D warnings
npm run lint

# Build standalone executable & installers
npm run build
```

Compiled desktop binaries are produced in `tauri_epub_reader/src-tauri/target/release/`:
- `app.exe` (Windows standalone binary)
- `bundle/nsis/Folio Reader_1.0.0_x64-setup.exe` (NSIS setup installer)
- `bundle/msi/Folio Reader_1.0.0_x64_en-US.msi` (MSI installer)

---

## Test & Verification Standards

Folio maintains an uncompromising test and security posture:
- **68 Rust Unit & Security Tests**: Full coverage for PalmDOC compression/decompression, Zip-Slip prevention, XML entity repairs, CORS isolation, cache bounds, and eviction safety.
- **42 Invariant Static Scan Checks**: Enforces IPC conversion safety, origin reflection, theme agreement, reading font embedding, and sanitized DOM insertion.
- **Zero Clippy Warnings**: Strict `-D warnings` enforcement across all platforms and compilation targets.
- **Clean Dependency Audit**: Zero high or critical vulnerabilities across npm and Cargo packages.

---

## Repository Structure

```
├── resources/
│   └── app-icon/                  # Master icon set, ICO, multi-res PNGs, and source archive
├── design-sources/
│   └── raw-assets/                # Raw vector ornaments, EPS backgrounds, and design assets
├── docs/
│   ├── CODE_REVIEW_GUIDE.md       # Comprehensive code review standards
│   ├── app-icon.png               # High-resolution application icon
│   └── screenshots/               # Application captures across themes and layouts
└── tauri_epub_reader/
    ├── src/                       # Frontend web application (offline-bundled JS, fonts, CSS)
    │   ├── assets/                # App icon, tiles, and SVG ornaments
    │   ├── vendor/                # epub.js, jszip, and Space Grotesk font files
    │   └── index.html             # Unified reader shell
    ├── src-tauri/                 # Rust backend (Tauri 2 host)
    │   ├── icons/                 # Platform icons (.ico, .icns, tile PNGs)
    │   ├── models/                # KittenTTS ONNX neural voice model
    │   ├── src/
    │   │   ├── lib.rs             # Tauri commands, cache manager & folio-cache:// protocol
    │   │   └── mobi.rs            # MOBI / PalmDOC / AZW parsing & extraction
    │   └── tauri.conf.json        # Window definitions, bundle targets, security CSP
    └── tests/                     # Playwright end-to-end and static scan test suites
```

---

## License

This project is licensed under the [MIT License](LICENSE).
