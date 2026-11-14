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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'src/index.html'), 'utf8');
const rust = readFileSync(join(root, 'src-tauri/src/lib.rs'), 'utf8');
const rustMobi = readFileSync(join(root, 'src-tauri/src/mobi.rs'), 'utf8');
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

// 16b. Reading Room rooms: the [data-rr] first-paint block and the JS
// RR_THEMES entry must agree on the desk family and the dressing gold, so
// the FOUC paint and the runtime overlay never disagree.
const RR_ROOMS = ['royal-maroon'];
let rrDrift = '';
for (const name of RR_ROOMS) {
  const cssBlock = html.match(new RegExp(`\\[data-rr="${name}"\\]\\{([\\s\\S]*?)\\n\\}`, '')) || [];
  const jsLine = (html.match(new RegExp(`'${name}':\\s*\\{label[\\s\\S]*?\\}`)) || [''])[0];
  for (const pair of [['desk', 'desk'], ['on-desk', 'onDesk'], ['desk-meta', 'deskMeta'], ['rr-gold', 'gold']]) {
    const cssVal = (cssBlock[1] || '').match(new RegExp(`--${pair[0]}:\\s*(#[0-9a-fA-F]{6})`));
    const jsVal = jsLine.match(new RegExp(`${pair[1]}:'(#[0-9a-fA-F]{6})'`));
    if (!cssVal || !jsVal || cssVal[1].toLowerCase() !== jsVal[1].toLowerCase()) {
      rrDrift += `${name}.${pair[0]}: css=${cssVal && cssVal[1]} js=${jsVal && jsVal[1]}; `;
    }
  }
}
check('reading room CSS/JS palettes agree', rrDrift === '',
  `first-paint vs runtime drift: ${rrDrift || 'n/a'}`);
const rootBlock = (html.match(/:root\{([\s\S]*?)\n\}/) || [])[1] || '';
const rootVars = new Set([...rootBlock.matchAll(/--([\w-]+)\s*:/g)].map((m) => m[1]));
const usedVars = new Set([...html.matchAll(/var\(--([\w-]+)\)/g)].map((m) => m[1]));
// JS-owned vars (set at runtime, never in :root): layout fit vars, slider
// fills, and --grain (pre-existing dead reference kept for compatibility).
const jsOwned = new Set(['fit-font', 'mw', 'pad-y', 'fill', 'grain', 'stage-shift-x']);
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

// 20. Packaged-exe cache URLs must use the fetchable http:// spelling.
// WebView2 cannot fetch literal folio-cache:// URLs ("URL scheme not
// supported"), which stranded the exe on "Loading contents…" while the
// byte-path browser flow kept working. Book URLs must go through
// folioCacheUrl(hash); the bare scheme is fine in comments/protocol checks.
const literalCacheUrls = (html.match(/folio-cache:\/\/\$\{/g) || []).length;
check('cache book URLs use the fetchable http form', literalCacheUrls === 0,
  `${literalCacheUrls} template literal folio-cache:// URL(s) in code; use folioCacheUrl(hash)`);

// 21. Living page block: the fore-edge stacks/stand blocks/boards/finis are
// progress chrome driven from the relocation hot pass. set() must be fed
// (frac, gPage) there, reset() must run on book open so widths never leak
// across books, and the boards/finis must key off the at-start/at-end body
// classes the same setter toggles.
check('living page block wired to relocations and open flow',
  /EdgeStacks\.set\(frac, gPage\)/.test(html) &&
  /EdgeStacks\.reset\(\)/.test(html) &&
  /id="edgeStackL"/.test(html) && /id="edgeStackR"/.test(html) &&
  /id="standBlockL"/.test(html) && /id="standBlockR"/.test(html),
  'hot pass must call EdgeStacks.set(frac, gPage), open must reset it, stack ids must exist');
check('book-end dressing keys off at-start/at-end',
  /body\.at-start \.board-edge\.left/.test(html) &&
  /body\.at-end \.board-edge\.right/.test(html) &&
  /body\.at-end #finis/.test(html),
  'cover boards and the finis mark must toggle with the body classes');
check('page-block vars resolve against theme tokens',
  ['--paper-edge', '--stand-a', '--stand-b', '--stand-c', '--stand-hi', '--ghost']
    .every((v) => html.includes(v + ':')),
  'living-page dressing uses a token no theme/root block defines');

// 24. Bookish dressing extras: the front board carries the book title as
// spine lettering, the finis mark carries per-book stats, and the gilt
// fore-edge line is theme-gated in applyTheme.
check('board lettering, finis meta and gilt edges wired',
  /id="boardTitle"/.test(html) &&
  /id="finisMeta"/.test(html) &&
  /boardTitle'\)\.textContent = getActiveTitle\(\)/.test(html) &&
  /fillFinisMeta\(\)/.test(html) &&
  /folio-bstat:/.test(html) &&
  /gilt-fore/.test(html) &&
  /key === 'velvet' \|\| key === 'emerald'/.test(html),
  'board title, finis meta, per-book stat keys and the gilt theme gate must all be present');

// 25. Bookish type channels (classic indents, old-style numerals) must join
// the folio-dyn hash so toggling re-injects chapter CSS, and must be
// persisted per book via TYPO_KEYS.
check('indent + oldstyle wired as typography channels',
  /settings\.indent \+ '\|' \+ settings\.oldstyle/.test(html) &&
  /TYPO_KEYS=[^\n]*'indent','oldstyle'/.test(html) &&
  /id="swIndent"/.test(html) && /id="swOldstyle"/.test(html) &&
  /swIndent'\)\.addEventListener/.test(html) && /swOldstyle'\)\.addEventListener/.test(html) &&
  /onum/.test(html) && /text-indent:1\.35em/.test(html),
  'hash entry, TYPO_KEYS, sheet toggles, listeners and injected rules must all exist');

// 26. Honest ribbon: multi-anchor files must split their location count
// across their TOC sections (groupSize), and the per-book stat heartbeat
// must ride the global one.
check('ribbon splits multi-anchor weights, book stats ride the heartbeat',
  /groupSize\[si\] = \(groupSize\[si\] \|\| 0\) \+ 1/.test(html) &&
  /\(counts\[si\] \|\| 0\) \/ \(groupSize\[si\] \|\| 1\)/.test(html) &&
  /loadBookStat\(getActiveTitle\(\)\)/.test(html) &&
  /bookStat\.min = \(bookStat\.min \|\| 0\) \+ 0\.5/.test(html),
  'multi-anchor weight split and the per-book heartbeat bump are missing');

// ---- 2026-11-12/13 packaged-exe regressions (CORS hang, CSP-blocked styles,
// broken covers, crossing ratchet) — these layers are invisible to the
// browser e2e harness, so their invariants are pinned here statically. ----

// 27. folio-cache CORS echo must trust the Windows app origin. On Windows
// WebView2 the app origin is http://tauri.localhost; missing it failed every
// CORS-mode fetch/XHR (epub.js container/OPF/chapters) and path-based opens
// hung forever on "Loading contents…" with zero pages. Inspect the policy
// function's own body (not the test module's copy of the literal).
const corsFn = (rust.match(/fn allowed_cors_origin[\s\S]*?\n\}/) || [''])[0];
check('folio-cache CORS echoes the Windows app origin',
  /allowed_cors_origin\((&)?req_origin/.test(rust) &&
  corsFn.includes('"http://tauri.localhost"') &&
  /fn test_u38_cors_echoes_every_app_origin/.test(rust),
  'allowed_cors_origin must list http://tauri.localhost in its trusted set and be wired into the handler (test_u38)');

// 28. Tauri's style-src nonce voids 'unsafe-inline' (CSP spec) and blocks
// every dynamically-created <style> inside srcdoc chapter iframes — book
// text fell back to the default serif and page corner art vanished. The
// asset-CSP modification must stay disabled for style-src (scripts keep
// their nonce), and font-src must admit data: (embedded faces).
check('asset CSP modification disabled for style-src (dynamic styles apply)',
  /"dangerousDisableAssetCspModification"\s*:\s*\[\s*"style-src"\s*\]/.test(conf) &&
  /font-src[^"]*data:/.test(conf),
  'tauri.conf.json needs dangerousDisableAssetCspModification:["style-src"] and data: in font-src');

// 29. Chapter iframes render as srcdoc/blob documents whose base cannot
// resolve file-based font URLs; the embedded data-URI copies are the first
// source so text never rides the CDN (font-display:swap re-render).
check('reading fonts embedded as data URIs and used first',
  /<script src="vendor\/fonts\/fonts-inline\.js"><\/script>/.test(html) &&
  /const FONT_DATA = window\.FOLIO_FONT_DATA/.test(html) &&
  /FONT_DATA\[file\.replace\(\/\\\.woff2\$\/,''\)\]/.test(html) &&
  /FONT_CDN_OFF = !!\(window\.__TAURI_INTERNALS__/.test(html) &&
  existsSync(join(root, 'src/vendor/fonts/fonts-inline.js')),
  'FS() must emit the data: source first (FOLIO_FONT_DATA lookup without the .woff2 suffix) and the script tag must load fonts-inline.js');

// 30. Chapter resources resolve against the APP root inside srcdoc docs —
// covers/images fetch the SPA fallback unless the relative attributes are
// RE-set (re-setting re-fires a failed load; a late <base> does not). The
// selector must match SVG <image> (covers use xlink:href), and the rewrite
// must run even when epub.js's own <base> already exists.
check('applyChapterBase re-fires relative resource loads (SVG image covered)',
  /function applyChapterBase/.test(html) &&
  /querySelectorAll\('img,image,link\[href\]/.test(html) &&
  /'xlink:href'/.test(html) &&
  !/querySelector\('base'\)\) return;/.test(html),
  'applyChapterBase must not bail on an existing <base>, must select image elements, and must rewrite xlink:href');

// 31. The corner-art overlay must never inflate epub.js's page-total
// measure: the wrapper ships zero-sized (a viewport-sized box rides inside
// Contents.textWidth()'s body Range after replay reparenting and ratcheted
// the canvas +1 spread per turn — perpetual empty flips, crossing dead),
// the tracker clamps its box to the canvas, and textWidth is measured with
// the overlay hidden.
check('ornament overlay cannot ratchet the page-total measure',
  /width:0;height:0;pointer-events:none;z-index:1/.test(html) &&
  /d\.documentElement\.clientWidth, chh = d\.documentElement\.clientHeight/.test(html) &&
  /__folioTwPatched/.test(html) &&
  /w\.style\.display = 'none';/.test(html),
  'pageOrnMarkup must ship width:0, trackPageOrnRun must clamp to clientWidth, and onContent must patch textWidth to measure without the overlay');

// 32. Book audio/video in cache-streamed books loads from folio-cache — the
// app CSP's media-src must admit both scheme spellings (frame-src already
// does; the omission silently muted embedded media).
check('media-src admits folio-cache (embedded book media plays)',
  /media-src[^"]*folio-cache:\s+http:\/\/folio-cache\.localhost/.test(conf),
  'tauri.conf.json media-src must include folio-cache: http://folio-cache.localhost');

// 33. MOBI metadata strings are NUL-padded to alignment boundaries; Rust's
// trim() does not strip NUL, and one leaked U+0000 makes the generated
// content.opf/toc.ncx a fatal XML error for epub.js — every MOBI hung forever
// on "Loading contents…" in the packaged exe.
check('MOBI metadata NUL padding stripped before OPF/NCX generation',
  /fn sanitize_meta_string/.test(rustMobi) &&
  (rustMobi.match(/sanitize_meta_string\(/g) || []).length >= 8 &&
  /fn test_u39_mobi_metadata_nul_padding_stripped/.test(rust),
  'mobi.rs metadata (record-0 title + every EXTH string record) must go through sanitize_meta_string (test_u39)');

// 34. mobi.rs tag-stripping scans must never sweep the rest of the body:
// find_tag_end on an unbounded suffix is the quadratic-CPU shape 893e8e3
// fixed in the close-tag searches.
{
  const unbounded = [...rust.matchAll(/find_tag_end\(&text\[i \+ close_idx\.\.\]\)/g)].length;
  check('mobi.rs tag-end scans stay window-bounded', unbounded === 0,
    `unbounded find_tag_end(&text[i + close_idx..]) found ${unbounded}× — bound to the 64KB window`);
}

// 35. applyChapterBase must treat srcset as a candidate LIST (absolutizing
// the whole string bakes one garbage URL over every candidate) and must
// cover video[src] (failed media loads never retry).
check('applyChapterBase handles srcset per candidate and video src',
  /a === 'srcset'/.test(html) &&
  /v\.split\(','\)\.map/.test(html) &&
  /'img,image,link\[href\],video\[poster\],video\[src\]/.test(html),
  'srcset must be absolutized per candidate with descriptors intact, and video[src] must be in the selector');

// 36. Bionification continues past the first 120 text nodes on idle ticks —
// the cache capture (onContent + preloadSpine) must await its completion or
// replays bake mixed bold/regular text.
check('cache capture waits for bionify completion',
  /Promise\.resolve\(bionifyDoc\(d\)\)\.then\(captureNow\)/.test(html) &&
  /await bionifyDoc\(sectionDoc\)/.test(html) &&
  /bookAtContent !== state\.book/.test(html),
  'onContent must defer captureNow until bionifyDoc resolves (identity-guarded) and preloadSpine must await it');

// 37. Bionic's word regex: the prefix class must be the NEGATED union
// ([^\p{L}\p{N}] = non-letter non-number). The original [\P{L}\P{N}] is the
// UNION of the two complements, which matches every character — the greedy
// prefix swallowed whole words and bionic never bolded a single word (dead
// since the feature's introduction, surfaced by the G6 capture test).
check('bionic word regex matches real words',
  /\[\^\\p\{L\}\\p\{N\}\]/.test(html) && !/\[\\P\{L\}\\P\{N\}\]/.test(html),
  'bionify WORD prefix class must be [^\\p{L}\\p{N}] — [\\P{L}\\P{N}] matches everything and disables bionic');

// 38. TTS PCM clearing must purge in-flight promises and started groups
// so switching books, chapters, or cancelling speech resets the deduplication set.
check('clearPcm purges cache, in-flight promises, and started groups',
  /clearPcm\(\)\s*\{[\s\S]*?this\.pcmCache\.clear\(\);[\s\S]*?this\._genP\.clear\(\);[\s\S]*?this\._startedGroups\.clear\(\);/.test(html),
  'clearPcm must purge pcmCache, _genP, and _startedGroups to prevent cross-session leaks');

// 39. TTS synthesis must record started groups and reuse in-flight promises
// to eliminate duplicate generation when pumpPrefetch and speakNext race.
check('synthesizeGroup deduplicates promises and tracks started groups',
  /synthesizeGroup\(gi,\s*gu\)\s*\{[\s\S]*?if\(this\._genP\.has\(gi\)\)[\s\S]*?if\(this\._startedGroups\.has\(gi\)\)[\s\S]*?this\._startedGroups\.add\(gi\);/.test(html),
  'synthesizeGroup must check _genP, _startedGroups, and add gi to _startedGroups');

// 40. getGroupText appends terminal punctuation to headings without duplicating
// periods or mutating the underlying sentence objects in TTS.sents.
check('getGroupText isolates heading punctuation cleanly and immutably',
  /getGroupText\(g\)\s*\{[\s\S]*?!\/\[\.\!\?\:\;…\]\$\/\.test\(text\)[\s\S]*?text\s*\+=\s*'\.';/.test(html) &&
  !/sents\[[^\]]+\]\.text\s*\+=/.test(html),
  'getGroupText must check ![.!?:;…]$ and never mutate underlying sents array elements');

process.exit(failures ? 1 : 0);
