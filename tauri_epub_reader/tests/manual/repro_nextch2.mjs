// Repro 2: click Next Chapter DURING the in-flight turn/jump, then probe
// whether the guards (turning/recreating) leak and clicks die permanently.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const PORT = 8130;
const BASE = `http://127.0.0.1:${PORT}`;
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
  await page.click('#btnDemo');
  await page.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 12000 });
  await page.waitForFunction(() => typeof LocEngine !== 'undefined' && LocEngine.ready(), null, { timeout: 12000 });
  await settle(1000);

  const snap = (tag) => page.evaluate((t) => ({
    tag: t,
    badge: document.getElementById('pageBadge')?.textContent,
    ch: document.getElementById('chapter')?.textContent || document.getElementById('runHeadLeft')?.textContent,
    chNavIdx: (typeof chNavIdx !== 'undefined') ? chNavIdx : 'n/a',
    nextDisabled: document.getElementById('chLabelNext')?.classList.contains('disabled'),
    turning: state.turning, recreating: state.recreating, loading: state.loading,
    compositor: !!document.querySelector('.pt-compositor'),
  }), tag).then(s => console.log(JSON.stringify(s)));

  await snap('t0');
  // Click, then click twice more DURING the in-flight jump/turn window
  await page.locator('#chLabelNext').click();
  await settle(120);
  await page.locator('#chLabelNext').click().catch(() => {});
  await settle(120);
  await page.locator('#chLabelNext').click().catch(() => {});
  await settle(3000);
  await snap('after burst');

  // Watch guards for 2s — do they ever clear?
  for (let i = 0; i < 4; i++) { await settle(500); await snap('watch' + i); }

  // Leisurely clicks still work?
  for (let k = 1; k <= 3; k++) {
    await page.locator('#chLabelNext').click().catch(() => {});
    await settle(2000);
    await snap('leisure' + k);
  }
  await browser.close();
} finally { server.kill(); }
