// Repro 3: multi-anchor TOC book — leisure then burst Next-Chapter clicks.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const PORT = 8131;
const BASE = `http://127.0.0.1:${PORT}`;
const EPUB = process.argv[2] || 'F:/tmp_folio_multi.epub';
const settle = (ms) => new Promise(r => setTimeout(r, ms));

const server = spawn(process.execPath,
  [path.join(ROOT, 'node_modules', 'http-server', 'bin', 'http-server'),
   path.join(ROOT, 'src'), '-p', String(PORT), '--silent'], { stdio: 'ignore' });

try {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE); if (r.ok) break; } catch {} await settle(250); }
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  await page.goto(BASE);
  await page.evaluate(() => localStorage.clear());
  await page.evaluate(() => localStorage.setItem('folio-coach-done', '1'));
  await page.reload();
  await page.locator('#btnDemo').waitFor({ timeout: 9000 });
  await page.evaluate(() => { settings.themeAuto = false; save(); });
  await page.setInputFiles('#file', EPUB);
  await page.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 15000 });
  await settle(2000);

  const snap = (tag) => page.evaluate((t) => ({
    tag: t,
    badge: document.getElementById('pageBadge')?.textContent,
    ch: document.getElementById('chapter')?.textContent || document.getElementById('runHeadLeft')?.textContent,
    chNavIdx: (typeof chNavIdx !== 'undefined') ? chNavIdx : 'n/a',
    tocCurIdx: (typeof tocCurIdx !== 'undefined') ? tocCurIdx : 'n/a',
    nextDisabled: document.getElementById('chLabelNext')?.classList.contains('disabled'),
    turning: state.turning, recreating: state.recreating, loading: state.loading,
  }), tag).then(s => console.log(JSON.stringify(s)));

  await snap('t0');
  // Leisure clicks first
  for (let k = 1; k <= 4; k++) {
    await page.locator('#chLabelNext').click().catch((e) => console.log('click err', e.message.slice(0, 60)));
    await settle(2200);
    await snap('leisure' + k);
  }
  // Now bursts
  await page.locator('#chNavLeft').hover().catch(() => {});
  for (let b = 1; b <= 3; b++) {
    for (let j = 0; j < 3; j++) {
      await page.locator('#chLabelNext').click({ force: true }).catch(() => {});
      await settle(250);
    }
    await settle(2500);
    await snap('burst' + b);
  }
  await browser.close();
} finally { server.kill(); }
