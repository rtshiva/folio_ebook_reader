// Inspect: after a fragment jump within the same spine file, what does the
// relocated CFI carry, what does markTocCurrent resolve, chapterFor, etc.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const PORT = 8132;
const BASE = `http://127.0.0.1:${PORT}`;
const EPUB = 'F:/tmp_folio_multi.epub';
const settle = (ms) => new Promise(r => setTimeout(r, ms));

const server = spawn(process.execPath,
  [path.join(ROOT, 'node_modules', 'http-server', 'bin', 'http-server'),
   path.join(ROOT, 'src'), '-p', String(PORT), '--silent'], { stdio: 'ignore' });

try {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE); if (r.ok) break; } catch {} await settle(250); }
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  // record every relocated event's cfi/href
  await page.addInitScript(() => {
    window.__relocs = [];
    const orig = window.addEventListener?.bind(window);
    // hook after app defines rendition — poll instead
  });
  await page.goto(BASE);
  await page.evaluate(() => localStorage.clear());
  await page.evaluate(() => localStorage.setItem('folio-coach-done', '1'));
  await page.reload();
  await page.locator('#btnDemo').waitFor({ timeout: 9000 });
  await page.evaluate(() => { settings.themeAuto = false; save(); });
  await page.setInputFiles('#file', EPUB);
  await page.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 15000 });
  await settle(2000);
  await page.evaluate(() => {
    window.__relocs = [];
    state.rendition.on('relocated', (loc) => {
      window.__relocs.push({ cfi: loc.start.cfi, href: loc.start.href, idx: loc.start.index });
    });
  });

  const info = async (tag) => page.evaluate((t) => {
    const loc = state.rendition.currentLocation();
    return {
      tag: t, cfi: loc.start.cfi, href: loc.start.href,
      tocCurIdx, chNavIdx,
      chTitle: chapterFor(loc.start.href),
      mark: (() => { markTocCurrent(loc.start.href, loc.start.cfi); return tocCurIdx; })(),
    };
  }, tag).then(async (r) => { console.log(JSON.stringify(r)); });

  await info('t0 (part1)');
  await page.locator('#chLabelNext').click();
  await settle(2200);
  await info('after next (part2)');
  const relocs = await page.evaluate(() => window.__relocs);
  console.log('relocated events:', JSON.stringify(relocs, null, 1));
  await browser.close();
} finally { server.kill(); }
