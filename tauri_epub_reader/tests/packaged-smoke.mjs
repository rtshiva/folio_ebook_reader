// Packaged-exe smoke test — the layer that caught nothing until 2026-11-13
// because every harness ran in a plain browser. This drives the REAL exe via
// WebView2 remote debugging and asserts the things only the exe can break:
//   - path-based opens (file association) actually render pages + TOC
//   - folio-dyn is APPLIED inside chapter docs (Tauri's style-src nonce must
//     not void 'unsafe-inline' — dangerousDisableAssetCspModification)
//   - fonts load (data: first source) and Literata is usable
//   - corner art present; fast flips CROSS chapters (no page-total ratchet)
//
// Run: npm run test:exe     (builds nothing: requires a current
//      src-tauri/target/release/app.exe — run `npm run build` first if stale)
// Windows-only. Not part of `npm test` (needs a release build + a window).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMultiChapterEpub } from './e2e/helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exe = join(root, 'src-tauri', 'target', 'release', 'app.exe');
const srcHtml = join(root, 'src', 'index.html');
const CDP = 'http://127.0.0.1:9391';

const fail = (msg) => { console.error('FAIL  ' + msg); process.exit(1); };
if (process.platform !== 'win32') fail('packaged smoke is Windows-only');
let st;
try { st = statSync(exe); } catch { fail('app.exe not found — run `npm run build` first'); }
let stHtml;
try { stHtml = statSync(srcHtml); } catch { fail('src/index.html missing'); }
if (st.mtimeMs < stHtml.mtimeMs) {
  fail('app.exe is STALE (older than src/index.html) — run `npm run build` first');
}

// One instance only: a running app would swallow the file-association launch
// (single-instance forwards instead of opening).
{
  const { execSync } = await import('node:child_process');
  const listing = execSync('tasklist /FI "IMAGENAME eq app.exe" /FO CSV /NH', { encoding: 'utf8' }).trim();
  if (listing && !/INFO:/.test(listing) && /app\.exe/i.test(listing)) {
    fail('app.exe is already running — close it first (single-instance would swallow the launch)');
  }
}

// Write the smoke book to a temp dir (a real file = file-association cold start).
const dir = mkdtempSync(join(tmpdir(), 'folio-smoke-'));
const epubPath = join(dir, 'Smoke Test.epub');
writeFileSync(epubPath, Buffer.from(buildMultiChapterEpub('Smoke Test', 3)));

console.log('launching packaged exe with a file-association open…');
const child = spawn(exe, [epubPath], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9391' },
  stdio: 'ignore',
});
const cleanup = () => { try { child.kill(); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// Wait for the CDP endpoint
let browser = null;
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try { browser = await chromium.connectOverCDP(CDP); break; } catch { /* not up yet */ }
}
if (!browser) fail('WebView2 CDP endpoint never came up (app crashed at boot?)');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('tauri.localhost')) || ctx.pages()[0];
if (!page) fail('no tauri.localhost page found');

// Give the open up to 20s, then assert the state.
let opened = null;
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(2000);
  opened = await page.evaluate(() => {
    const frames = document.querySelectorAll('#viewer iframe').length;
    const toc = ((document.getElementById('tocList') || {}).textContent || '');
    return {
      reading: document.body.classList.contains('state-reading'),
      loading: typeof state !== 'undefined' ? state.loading : null,
      frames, tocFilled: toc.length > 0 && !toc.includes('Loading contents'),
      tocLen: toc.length,
    };
  }).catch(() => null);
  if (opened && opened.reading && opened.frames > 0 && opened.tocFilled) break;
}
if (!opened) fail('page unreachable via CDP');
if (!opened.reading || opened.frames === 0) fail(`book never rendered (state-reading=${opened.reading}, frames=${opened.frames}) — the CORS/open hang is back`);
if (!opened.tocFilled) fail(`TOC stuck at "Loading contents…" (tocLen=${opened.tocLen}) — chapter fetches are failing`);
console.log('PASS  file-association open renders (frames, TOC filled)');

const st1 = await page.evaluate(() => {
  const frs = [...document.querySelectorAll('#viewer iframe')]
    .map((f) => ({ f, r: f.getBoundingClientRect() }))
    .sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height));
  const d = frs.length && frs[0].f.contentDocument;
  if (!d || !d.body) return null;
  const dyn = d.getElementById('folio-dyn');
  const pcs = d.getElementById('folio-pcs');
  return {
    dynApplied: dyn ? [...d.styleSheets].some((ss) => ss.ownerNode === dyn) : false,
    dataFirst: dyn ? dyn.textContent.includes('data:font/woff2') : false,
    literata: d.fonts.check('16px "Literata"'),
    cornerArt: pcs ? pcs.querySelectorAll('.folio-pg,.folio-ph').length : 0,
    wrapRight: pcs ? Math.round(pcs.getBoundingClientRect().right) : null,
    clientWidth: d.documentElement.clientWidth,
  };
}).catch(() => null);
if (!st1) fail('chapter doc unreachable');
if (!st1.dynApplied) fail('folio-dyn NOT applied — Tauri style-src nonce is voiding unsafe-inline again (dangerousDisableAssetCspModification)');
if (!st1.dataFirst) fail('embedded data-URI fonts missing from folio-dyn');
if (!st1.literata) fail('Literata not loaded in the chapter');
if (st1.cornerArt === 0) fail('corner art markup missing');
if (st1.wrapRight !== null && st1.clientWidth && st1.wrapRight > st1.clientWidth) {
  fail(`ornament overlay exceeds the canvas (${st1.wrapRight} > ${st1.clientWidth}) — page-total ratchet risk`);
}
console.log('PASS  styles applied, embedded fonts load, corner art present, overlay clamped');

// Crossing: fast flips must advance the spine (demo book: ch0 -> ch1).
let last = await page.evaluate(() => { try { return state.rendition.currentLocation().start.index; } catch { return -1; } });
let crossed = 0;
for (let i = 0; i < 10; i++) {
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(700);
  const sp = await page.evaluate(() => { try { return state.rendition.currentLocation().start.index; } catch { return -1; } });
  if (sp > last && last >= 0) crossed++;
  last = sp;
}
if (crossed === 0) fail(`no chapter crossing in 10 fast turns (stuck at spine ${last}) — the page-total ratchet is back`);
console.log(`PASS  fast flips cross chapters (crossings=${crossed}, spine=${last})`);

console.log('PACKAGED SMOKE: all green');
cleanup();
process.exit(0);
