// Captures README screenshots featuring real Project Gutenberg books:
//   reading-room.png      hero — Royal Maroon room, opening leaf: Alice's
//                         cover as a closed book (cover right, desk left)
//   reading.png           Pride & Prejudice, single page (Natural Paper)
//   spread.png            Pride & Prejudice, forced two-page spread
//   contents.png          TOC drawer over the Pride & Prejudice spread
//   settings.png          typography sheet over the same spread
//   shortcuts.png         keyboard overlay over the same spread
//   night.png             Frankenstein under themeAuto with a dark OS scheme
//   theme-*.png           7-environment grid, one classic per desk
//   landing.png           start page with the Recent Books shelf holding all
//                         four classics (covers + progress, Real Books era)
//
// Books are cached in tests/manual/gutenberg-books/ (gitignored) and fetched
// on first run. The main gutenberg.org alternates with a maintenance page;
// the pglaf mirror serves the same cache/epub/ paths, so it is the primary
// source here. Each cached file must be a complete zip (EOCD present).
//
// Run:  node tests/manual/capture_gutenberg_shots.mjs
// Output: ../../docs/screenshots/*.png

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))); // tauri_epub_reader/
const OUT = path.join(ROOT, '..', 'docs', 'screenshots');
const BOOKS_DIR = path.join(ROOT, 'tests', 'manual', 'gutenberg-books');
const PORT = 8128;
const BASE = `http://127.0.0.1:${PORT}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

const BOOKS = {
  // `opening` = the single word searched to land on the body text: the
  // per-node search matcher can't match phrases (source HTML hard-wraps
  // inside text nodes), and each word's first hit is that opening chapter.
  alice:        { file: 'alice.epub',        id: 11,   opening: 'tired' },
  frankenstein: { file: 'frankenstein.epub', id: 84,   opening: 'rejoice' },
  pride:        { file: 'pride.epub',        id: 1342, opening: 'Michaelmas' },
  mobydick:     { file: 'mobydick.epub',     id: 2701, opening: 'Ishmael' },
};

// theme key → which classic sits on that desk
const THEMES = [
  ['paper',      'Natural Paper', 'pride'],
  ['light',      'Modern Clean',  'alice'],
  ['noir',       'Velvet Night',  'frankenstein'],
  ['aizome',     'Aizome',        'mobydick'],
  ['ember',      'Ember',         'frankenstein'],
  ['velvet',     'Velvet',        'pride'],
  ['emerald',    'Emerald',       'mobydick'],
];

mkdirSync(OUT, { recursive: true });
mkdirSync(BOOKS_DIR, { recursive: true });

const isCompleteZip = (buf) => buf.length > 50000 && buf.slice(0, 2).toString() === 'PK'
  && buf.subarray(Math.max(0, buf.length - 65536)).includes('PK\x05\x06');

async function ensureBooks() {
  for (const b of Object.values(BOOKS)) {
    const p = path.join(BOOKS_DIR, b.file);
    if (existsSync(p) && isCompleteZip(readFileSync(p))) continue;
    const url = `http://gutenberg.pglaf.org/cache/epub/${b.id}/pg${b.id}-images.epub`;
    console.log('downloading', b.file, 'from', url);
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (!r.ok) throw new Error(`download failed ${r.status} for ${url}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (!isCompleteZip(buf)) throw new Error('mirror returned a truncated/non-EPUB body for ' + b.file);
    writeFileSync(p, buf);
  }
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(url, tries = 60) {
  let last = '';
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return; last = 'status ' + r.status; }
    catch (e) { last = e.message; }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('http-server did not come up on ' + url + ' (last: ' + last + ')');
}

const server = spawn(process.execPath,
  [path.join(ROOT, 'node_modules', 'http-server', 'bin', 'http-server'),
   path.join(ROOT, 'src'), '-p', String(PORT), '--silent'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
server.stderr.on('data', (d) => console.error('[server]', d.toString().trim()));
server.on('exit', (code, sig) => console.log('[server] exited', code, sig));

try {
  await waitHttp(BASE);
  await ensureBooks();

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  await page.goto(BASE);
  await page.evaluate(() => localStorage.clear());

  const shot = async (name, delay = 400) => {
    await settle(delay);
    await page.screenshot({ path: path.join(OUT, name) });
    console.log('saved', name);
  };
  // synthetic pointer moves do not re-arm the app's chrome timer — call the
  // app's own showChrome() (key presses do not poke the chrome either)
  const showChrome = async () => { await page.evaluate(() => showChrome()); await settle(300); };
  const seed = async (settings) => {
    await page.evaluate((s) => {
      localStorage.setItem('folio-settings', JSON.stringify(s));
      localStorage.setItem('folio-coach-done', '1');
    }, settings);
    await page.reload();
    await page.locator('#btnDemo').waitFor();
    // pagehide's flushPendingPersist can re-write the PREVIOUS page's
    // in-memory settings over the seed after setItem but before the boot
    // reads it — verify the boot took the theme, else re-assert + re-boot
    // (the freshly booted page has no pending save, so reload 2 is safe)
    const took = await page.evaluate((s) =>
      (localStorage.getItem('folio-settings') || '').includes('"theme":"' + s.theme + '"'), settings);
    if (!took) {
      console.log('  [seed] clobbered by unload flush — re-asserting', settings.theme);
      await page.evaluate((s) => localStorage.setItem('folio-settings', JSON.stringify(s)), settings);
      await page.reload();
      await page.locator('#btnDemo').waitFor();
    }
  };
  const openBook = async (key, { intoText = false } = {}) => {
    const buf = readFileSync(path.join(BOOKS_DIR, BOOKS[key].file));
    await page.setInputFiles('#file', { name: BOOKS[key].file, mimeType: 'application/epub+zip', buffer: buf });
    await page.waitForFunction(() => document.body.classList.contains('state-reading'));
    await page.waitForFunction(() => typeof LocEngine !== 'undefined' && LocEngine.ready());
    // first-open toast fades after ~2.8s; give the ornaments a beat too
    await settle(4500);
    if (intoText) {
      // step off the front matter onto the book's iconic opening line
      await gotoOpening(page, BOOKS[key].opening);
    }
  };
  const waitRecentsHydrated = async (minCount) => {
    await page.waitForFunction((min) => (async () => {
      const r = JSON.parse(localStorage.getItem('folio-recents') || '[]');
      if (!Array.isArray(r) || r.length < min) return 0;
      for (const it of r) {
        const t = await Promise.resolve(StoreKV.get(it.thumbKey || ('thumb:' + it.title)));
        if (!t) return 0;
      }
      return r.length;
    })(), minCount, { timeout: 45000 });
    console.log('recents hydrated:', minCount, '+');
  };
  const goHome = async () => {
    await page.evaluate(() => goHome());
    await settle(600);
  };
  const gotoOpening = async (p, quote) => {
    // TOC fragment jumps resolve to the section top on these Gutenberg
    // files, so navigate by full-text search instead: the result jump uses
    // a text-terminal CFI, which relocates precisely. The query must be a
    // SINGLE word — the matcher runs per text node and the source HTML's
    // hard line-breaks split any phrase across nodes.
    await p.keyboard.press('Control+f');
    await p.locator('#searchDrawer.open').waitFor();
    await p.locator('#searchInput').fill(quote);
    // first search on a book builds the idle search index — be patient;
    // .search-res-item = real hits (the empty state also renders a bare li)
    await p.locator('#searchResults .search-res-item').first().waitFor({ timeout: 60000 });
    await settle(600);
    await p.locator('#searchResults .search-res-item').first().click();
    await p.evaluate(() => { try { closeSearch(); } catch (e) {} try { document.getElementById('btnJumpDismiss').click(); } catch (e) {} });
    await settle(3200);
  };
  const setSpread = async (mode) => {
    await page.evaluate((m) => { settings.spread = m; save(); relayout(); }, mode);
    await settle(2400);
  };

  // ---------- hero: Alice title-page spread in the Royal Maroon room ----------
  await seed({ theme: 'paper', themeAuto: false, rrTheme: 'royal-maroon', pageOrnaments: true });
  await openBook('alice');
  await showChrome();
  await shot('reading-room.png', 700);
  await goHome();
  await waitRecentsHydrated(1);

  // ---------- Pride & Prejudice: main screenshot set (paper desk) ----------
  // forced two-page seeded up front; spread.png shows Chapter I as a spread,
  // reading.png the same chapter single-page (the D toggle on real text)
  await seed({ theme: 'paper', themeAuto: false, rrTheme: 'match', pageOrnaments: true, spread: 'on' });
  await openBook('pride');
  await gotoOpening(page, BOOKS.pride.opening);
  await showChrome();
  await shot('spread.png', 500);
  await setSpread('off');
  await showChrome();
  await shot('reading.png', 700);
  // drawers/overlays ride on the Chapter I single-page state — call the
  // app's toggles directly (keystrokes can land in a stale dialog focus)
  await page.evaluate(() => toggleToc());
  await page.locator('#tocList').waitFor();
  await settle(500);
  await shot('contents.png');
  await page.evaluate(() => closePanels());
  await settle(400);
  await page.evaluate(() => toggleSheet());
  await page.locator('#sheet').waitFor();
  await settle(500);
  await shot('settings.png');
  await page.evaluate(() => closePanels());
  await settle(400);
  await page.evaluate(() => document.getElementById('btnHelp').click());
  await page.locator('#helpOverlay').waitFor();
  await settle(500);
  await shot('shortcuts.png');
  await page.evaluate(() => closePanels());
  await settle(400);
  await goHome();
  await waitRecentsHydrated(2);

  // ---------- night look: fresh context, dark OS scheme, Frankenstein ----------
  const dark = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    colorScheme: 'dark',
  });
  const dpage = await dark.newPage();
  // recents shots happen in the main context; this one just reads
  await dpage.goto(BASE);
  await dpage.evaluate(() => { localStorage.clear(); localStorage.setItem('folio-coach-done', '1'); });
  await dpage.evaluate(() => localStorage.setItem('folio-settings', JSON.stringify({ spread: 'on', pageOrnaments: true })));
  await dpage.reload();
  await dpage.locator('#btnDemo').waitFor();
  const dbuf = readFileSync(path.join(BOOKS_DIR, BOOKS.frankenstein.file));
  await dpage.setInputFiles('#file', { name: BOOKS.frankenstein.file, mimeType: 'application/epub+zip', buffer: dbuf });
  await dpage.waitForFunction(() => document.body.classList.contains('state-reading'));
  await dpage.waitForFunction(() => typeof LocEngine !== 'undefined' && LocEngine.ready());
  await settle(4500);
  await gotoOpening(dpage, BOOKS.frankenstein.opening);
  await dpage.evaluate(() => showChrome());
  await settle(300);
  await dpage.screenshot({ path: path.join(OUT, 'night.png') });
  console.log('saved night.png');
  await dark.close();

  // ---------- theme grid: one classic per environment ----------
  // recents keep accumulating in this context (localStorage + IDB), never
  // cleared, so the landing shelf ends up holding all four classics.
  const opened = new Set(['alice', 'pride']); // hero + main set already ran
  for (const [key, label, bookKey] of THEMES) {
    await seed({ theme: key, themeAuto: false, rrTheme: 'match', pageOrnaments: true });
    await openBook(bookKey, { intoText: true });
    // per-book preferences can override the global seed (pride was left in
    // single-page by the main set) — force the uniform two-page grid
    await setSpread('on');
    await showChrome();
    await shot('theme-' + key + '.png');
    await goHome();
    opened.add(bookKey);
    await waitRecentsHydrated(Math.min(opened.size, 4)); // shelf caps at 4
  }

  // ---------- landing: start page with the four-classic bookshelf ----------
  // paper desk so the landing text is dark-on-light (themed dark rooms wash
  // out the tagline/colophon — a known pre-existing legibility issue)
  const landingSettings = { theme: 'paper', themeAuto: false, rrTheme: 'match', pageOrnaments: true };
  await page.evaluate((s) => localStorage.setItem('folio-settings', JSON.stringify(s)), landingSettings);
  await page.reload();
  await page.locator('#btnDemo').waitFor();
  const took = await page.evaluate((s) =>
    (localStorage.getItem('folio-settings') || '').includes('"theme":"' + s.theme + '"'), landingSettings);
  if (!took) {
    await page.evaluate((s) => localStorage.setItem('folio-settings', JSON.stringify(s)), landingSettings);
    await page.reload();
    await page.locator('#btnDemo').waitFor();
  }
  await settle(2500);
  await page.waitForFunction(() =>
    document.querySelectorAll('#recentList .recent-cover-art img').length >= 4,
  null, { timeout: 20000 });
  await shot('landing.png', 500);

  await browser.close();
  console.log('all gutenberg shots done');
} finally {
  server.kill();
}
