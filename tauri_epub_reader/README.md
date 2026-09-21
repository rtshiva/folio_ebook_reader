# Folio Reader — Desktop App (Tauri 2.0)

A high-performance, lightweight desktop EPUB reader built with Tauri 2.0 and native Windows Edge WebView2.

## Features

- **Ultralight Desktop Binary**: Complete standalone executable under ~9 MB.
- **True Offline Support**: Bundles `jszip.min.js`, `epub.min.js`, and core reading styles locally—zero internet or CDN required.
- **Native `.epub` File Association**: Configured in `tauri.conf.json` so double-clicking any `.epub` file on Windows launches the reader directly.
- **Drag & Drop**: Drop `.epub` files directly into the desktop window.
- **Hotkeys**:
  - `Ctrl + O`: Open native file dialog to pick an EPUB.
  - `D`: Toggle between dual-page spread and single-page layout.
  - `Left` / `Right` or `Space`: Turn pages.
  - `T`: Toggle table of contents.
  - `A`: Toggle typography & settings panel.
- **Reading Engine**:
  - Dual-page spread and single-page reading modes.
  - 3D paper flip & slide page turn animations.
  - Dynamic page width slider and responsive auto-fit.
  - Bionic reading, reading ruler/guide, custom font sizes, line heights, letter and word spacing.
  - Text-to-speech read aloud.

## Project Structure

```
tauri_epub_reader/
├── package.json               # Scripts: "dev", "build"
├── src/                       # Desktop frontend
│   ├── index.html             # The Folio reader adapted for desktop
│   └── vendor/                # Local offline vendor bundles
│       ├── jszip.min.js
│       └── epub.min.js
└── src-tauri/                 # Rust backend
    ├── Cargo.toml             # Tauri 2 dependencies
    ├── tauri.conf.json        # Window settings, permissions & file associations
    └── src/
        ├── main.rs
        └── lib.rs             # Tauri commands (get_initial_file, read_file_bytes)
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
