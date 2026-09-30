// Captures README screenshots by driving the real frontend (served statically,
// same as the e2e harness) through its main views with the embedded demo book.
// Run from tauri_epub_reader/:  node tests/manual/capture_readme_shots.mjs
// Output: ../docs/screenshots/*.png (relative to the repo root).

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))); // tauri_epub_reader/
const OUT = path.join(ROOT, '..', 'docs', 'screenshots');
const PORT = 8127;
const BASE = `http://127.0.0.1:${PORT}`;

mkdirSync(OUT, { recursive: true });

const server = spawn(process.execPath,
  [path.join(ROOT, 'node_modules', 'http-server', 'bin', 'http-server'),
   path.join(ROOT, 'src'), '-p', String(PORT), '--silent'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
server.stderr.on('data', d => console.error('[server]', d.toString().trim()));
server.on('exit', (code, sig) => console.log('[server] exited', code, sig));

async function waitHttp(url, tries = 60) {
  let last = '';
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return; last = 'status ' + r.status; }
    catch (e) { last = e.message; }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('http-server did not come up on ' + url + ' (last: ' + last + ')');
}

const settle = (ms) => new Promise(r => setTimeout(r, ms));

try {
  await waitHttp(BASE);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const shot = async (name, delay = 400) => {
    await settle(delay);
    await page.screenshot({ path: path.join(OUT, name) });
    console.log('saved', name);
  };
  const showChrome = async () => { await page.mouse.move(800, 500); await page.mouse.move(799, 501); await settle(250); };

  // Landing (themeAuto is left on; headless defaults to light scheme)
  await page.goto(BASE);
  await page.evaluate(() => localStorage.clear());
  // Skip the first-run coach sequence so screenshots show a clean reader
  await page.evaluate(() => localStorage.setItem('folio-coach-done', '1'));
  await page.reload();
  await page.locator('#btnDemo').waitFor({ timeout: 15000 });
  await settle(800);
  await shot('landing.png');

  // Open the demo book and wait for it to be fully laid out. The first-open
  // toast ("Swipe or tap…") needs ~4s to fade before clean shots.
  await page.click('#btnDemo');
  await page.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 20000 });
  await page.waitForFunction(() => typeof LocEngine !== 'undefined' && LocEngine.ready(), null, { timeout: 20000 });
  await settle(4000);

  // Wide viewports auto-open two-page spread. The 'd' cycle is
  // auto → forced two-page → single, so two presses reach single page.
  // Wait out the 2.8s layout toast, then re-show the chrome via the app's
  // own showChrome() (key presses don't reset the 3.4s chrome-hide timer).
  await page.keyboard.press('d');
  await page.keyboard.press('d');
  await settle(2700);
  await page.evaluate(() => showChrome());
  await shot('reading.png', 700);

  // Two-page spread ('d' wraps single → auto, which is two pages here)
  await page.keyboard.press('d');
  await settle(2700);
  await page.evaluate(() => showChrome());
  await shot('spread.png', 300);

  // Contents drawer
  await page.keyboard.press('t');
  await page.locator('#tocList').waitFor({ timeout: 9000 });
  await settle(400);
  await shot('contents.png');
  await page.keyboard.press('Escape');
  await settle(400);

  // Typography & settings sheet
  await page.keyboard.press('s');
  await page.locator('#sheet').waitFor({ timeout: 9000 });
  await settle(400);
  await shot('settings.png');
  await page.keyboard.press('Escape');
  await settle(400);

  // Keyboard shortcuts overlay (chrome auto-hides; dispatch directly)
  await page.evaluate(() => document.getElementById('btnHelp').click());
  await page.locator('#helpOverlay').waitFor({ timeout: 9000 });
  await settle(400);
  await shot('shortcuts.png');
  await page.keyboard.press('Escape');
  await settle(400);

  // Night look: fresh context with dark OS scheme so themeAuto follows it
  const dark = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  });
  const dpage = await dark.newPage();
  await dpage.goto(BASE);
  await dpage.evaluate(() => localStorage.clear());
  await dpage.evaluate(() => localStorage.setItem('folio-coach-done', '1'));
  await dpage.reload();
  await dpage.locator('#btnDemo').waitFor({ timeout: 15000 });
  await dpage.click('#btnDemo');
  await dpage.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 20000 });
  await dpage.waitForFunction(() => typeof LocEngine !== 'undefined' && LocEngine.ready(), null, { timeout: 20000 });
  await settle(4000);
  await dpage.keyboard.press('d');
  await settle(2700);
  await dpage.evaluate(() => showChrome());
  await settle(300);
  await dpage.screenshot({ path: path.join(OUT, 'night.png') });
  console.log('saved night.png');

  await browser.close();
} finally {
  server.kill();
}
