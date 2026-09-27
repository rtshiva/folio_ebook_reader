// Static regression scan for EPUB file-handling invariants.
// Run: node tests/scan-file-handling.mjs  (exit 0 = clean, 1 = violation)
// Pinpoint regressions in the categories found by the file-handling audit:
//   1. single boot-open path (duplicate get_initial_file races two opens)
//   2. IPC byte shapes go through ipcByteLength/ipcToBuffer (ArrayBuffer has
//      no .length; raw checks misread valid reads as failures)
//   3. case-sensitive XML entity passthrough (&AMP; is fatal to the parser)
//   4. all "open a file" entries share openBookDialog (Ctrl+O must not bypass
//      the native picker)
//   5. no lossy UTF-8 conversion on the serve path (corrupts legacy encodings)
//   6. desktop drag-drop stays enabled (landing page advertises file drop)
//   7. edge-only click zones (whole-page tap-to-turn flips on body taps)
//   8. no idle desk-dim re-arm (ambient surround must sit still)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'src/index.html'), 'utf8');
const rust = readFileSync(join(root, 'src-tauri/src/lib.rs'), 'utf8');
const conf = readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8');

let failures = 0;
const check = (name, ok, hint) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) { failures++; console.log(`      -> ${hint}`); }
};

const count = (src, re) => (src.match(re) || []).length;

// 1. Exactly one cold-start query: checkStartupFile owns the boot open.
check('single get_initial_file call site',
  count(html, /invoke\('get_initial_file'\)/g) === 1,
  'second call site reintroduces the duplicate boot-open race (one file silently dropped)');

// 2a. No raw .length checks on IPC byte payloads (outside the helper itself).
const htmlNoHelper = html.replace(/function ipcByteLength\(bytes\)\{[\s\S]*?\n\}/, '');
const rawLen = htmlNoHelper.split('\n').filter((l) =>
  /bytes(\s*&&\s*bytes)?\.length/.test(l));
check('no raw bytes.length IPC checks', rawLen.length === 0,
  `use ipcByteLength(): ${rawLen.map((l) => l.trim().slice(0, 80)).join(' | ')}`);

// 2b. The only raw ArrayBuffer conversion is the central helper itself.
const rawConv = html.split('\n').filter((l) => /new Uint8Array\(bytes\)\.buffer/.test(l));
const inHelper = rawConv.length === 1 && /function ipcToBuffer[\s\S]{0,200}new Uint8Array\(bytes\)\.buffer/.test(html);
check('single sanctioned IPC buffer conversion', inHelper,
  'route IPC bytes through ipcToBuffer() so ArrayBuffer and array shapes both survive');

// 3. Entity passthrough must be case-sensitive (XML names are).
check('case-sensitive entity passthrough',
  !/\^\(amp\|lt\|gt\|quot\|apos\)\$\/i/.test(html),
  'a /i flag lets &AMP;/&LT; through and the strict XML parser fatals the chapter');

// 4. One file-dialog entry point shared by button and Ctrl+O.
check('single file-input trigger inside openBookDialog',
  count(html, /el\('file'\)\.click\(\)/g) === 1 && /async function openBookDialog/.test(html),
  'a second el(file).click() bypasses the native picker (whole file buffered in RAM)');

// 5. Serve path never lossy-converts bytes (percent_decode's own ASCII
// rebuild is the one sanctioned use; everything else must preserve bytes).
const rustNoDecode = rust.replace(/fn percent_decode[\s\S]*?\n\}/, '');
check('no from_utf8_lossy on serve path', !/from_utf8_lossy/.test(rustNoDecode),
  'lossy conversion burns legacy-encoded chapters into U+FFFD; use xml_response_body()');

// 6. Desktop file drop enabled to match the advertised drop hint.
check('dragDropEnabled true', /"dragDropEnabled":\s*true/.test(conf),
  'false blocks OS file drops in the Tauri build while the UI advertises them');

// 7. Click-to-turn lives only in the fore-edge band: no proportional
// whole-page zones (relX halves/thirds) that flip on body-of-page taps.
check('edge-only click zones',
  !/relX\s*<\s*0\.(44|28)/.test(html) && /clickEdgePx/.test(html),
  'proportional zones turn the page on taps deep inside the book; keep flips in clickEdgePx band');

// 8. The idle desk-dim timer must not re-arm: with no toggle to disable it,
// any re-arm repaints the surround on every idle/input cycle.
check('no idle desk-dim re-arm', !/deskDimTimer\s*=\s*setTimeout/.test(html),
  're-arming the dim timer brings back the ambient background cycling');

process.exit(failures ? 1 : 0);
