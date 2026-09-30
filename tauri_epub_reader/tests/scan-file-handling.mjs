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

// 9-12. Book-switch lifecycle: per-book caches, deferred work, turn state,
// and speech sessions must not leak from the closed book into the next one.
const regionAfter = (src, marker, n) => {
  const i = src.indexOf(marker);
  if (i < 0) return '';
  return src.slice(i, i + 4000).split('\n').slice(0, n).join('\n');
};
const closeBody = regionAfter(html, 'async function closeBook(){', 45);
check('closeBook purges per-book caches and deferred work',
  /pageCache\.clear\(\)/.test(closeBody) && /clearTimeout\(_relocColdTimer\)/.test(closeBody),
  'stale chapter HTML and a pending cold-path pass leak into the next book');
check('closeBook parks gestures, flags, and the turn queue',
  /turnGesture\.cancel\(\)/.test(closeBody) && /state\.turning\s*=\s*false/.test(closeBody) &&
  /turnQueue\s*=\s*0/.test(closeBody),
  'a mid-turn close leaves a capture overlay, stuck flags, or queued turns');
check('per-book navigation resets on open', /NavHistory\.clear\(\)/.test(html),
  'return-anchors hold CFIs into the previous book after a switch');
check('turns never continue on a swapped rendition',
  /state\.rendition\s*!==\s*rGen/.test(html),
  'an in-flight turn queue keeps advancing the newly opened book');
check('speech timeouts are generation-gated', /this\.gen/.test(html),
  'a pre-stop speak timeout can fire into the next book or session');

// 15-16. Bespoke themes keep one palette: the [data-theme] first-paint block
// and the JS THEMES runtime map must agree on the core vars, and every var
// the themes set must exist as a :root default (no unresolved var()).
const BESPOKE = ['aizome', 'ember', 'velvet', 'emerald'];
const CORE = ['desk', 'page', 'ink', 'muted', 'accent'];
let themeDrift = '';
for (const name of BESPOKE) {
  const cssBlock = html.match(new RegExp(`\\[data-theme="${name}"\\]\\{([\\s\\S]*?)\\n\\}`, '')) || [];
  const jsLine = (html.match(new RegExp(`^\\s*${name}:\\s*\\{label.*$`, 'm')) || [''])[0];
  for (const v of CORE) {
    const cssVal = (cssBlock[1] || '').match(new RegExp(`--${v}:\\s*(#[0-9a-fA-F]{6})`));
    const jsVal = jsLine.match(new RegExp(`${v}:'(#[0-9a-fA-F]{6})'`));
    if (!cssVal || !jsVal || cssVal[1].toLowerCase() !== jsVal[1].toLowerCase()) {
      themeDrift += `${name}.${v}: css=${cssVal && cssVal[1]} js=${jsVal && jsVal[1]}; `;
    }
  }
}
check('bespoke theme CSS/JS palettes agree', themeDrift === '',
  `first-paint vs runtime drift: ${themeDrift || 'n/a'}`);
const rootBlock = (html.match(/:root\{([\s\S]*?)\n\}/) || [])[1] || '';
const rootVars = new Set([...rootBlock.matchAll(/--([\w-]+)\s*:/g)].map((m) => m[1]));
const usedVars = new Set([...html.matchAll(/var\(--([\w-]+)\)/g)].map((m) => m[1]));
// JS-owned vars (set at runtime, never in :root): layout fit vars, slider
// fills, and --grain (pre-existing dead reference kept for compatibility).
const jsOwned = new Set(['fit-font', 'mw', 'pad-y', 'fill', 'grain']);
const missing = [...usedVars].filter((v) => !rootVars.has(v) && !jsOwned.has(v));
check('every themed var() resolves to a :root default', missing.length === 0,
  `unresolved tokens: ${missing.join(', ') || 'n/a'}`);

// 17-19. Cloth-chrome legibility: cloth topbars must carry a chalk
// foreground (wordmark/icons inherit it), the loader status must not sit in
// paper-muted on cloth, and the theme row must wrap its ten buttons.
const topbarBlock = (name) => html.match(new RegExp(`\\[data-theme="${name}"\\] #topbar\\{([\\s\\S]*?)\\n\\}`, '')) || [];
check('cloth topbars carry chalk foreground',
  ['velvet', 'emerald'].every((n) => /color:\s*var\(--on-desk\)/.test((topbarBlock(n)[1] || ''))) &&
  /\[data-theme="velvet"\] \.wm-btn\{color:var\(--on-desk\)\}/.test(html) &&
  /\[data-theme="emerald"\] \.wm-btn\{color:var\(--on-desk\)\}/.test(html),
  'dark ink wordmark/icons on the dark cloth topbar are unreadable');
check('loader status readable on cloth',
  ['aizome', 'velvet', 'emerald'].every((n) => html.includes(`[data-theme="${n}"] #loader .kicker`)),
  'loader kicker falls back to paper-muted, invisible on dark cloth');
check('theme row wraps its buttons',
  /\.theme-row\{[^}]*flex-wrap:\s*wrap/.test(html),
  'nine theme buttons + auto overflow the 352px sheet');

process.exit(failures ? 1 : 0);
