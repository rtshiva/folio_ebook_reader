// Repro: click the Next Chapter pill repeatedly, track badge/pct/chNavIdx.
// Usage: node tests/manual/repro_nextch.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const PORT = 8129;
const BASE = `http://127.0.0.1:${PORT}`;
const settle = (ms) => new Promise(r => setTimeout(r, ms));

const server = spawn(process.execPath,
  [path.join(ROOT, 'node_modules', 'http-server', 'bin', 'http-server'),
   path.join(ROOT, 'src'), '-p', String(PORT), '--silent'], { stdio: 'ignore' });

try {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE); if (r.ok) break; } catch {} await settle(250); }
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 140)); });
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

  const snap = () => page.evaluate(() => ({
    badge: document.getElementById('pageBadge')?.textContent,
    pct: document.getElementById('pct')?.textContent,
    ch: document.getElementById('chapter')?.textContent || document.getElementById('runHeadLeft')?.textContent,
    chNavIdx: (typeof chNavIdx !== 'undefined') ? chNavIdx : 'n/a',
    tocCurIdx: (typeof tocCurIdx !== 'undefined') ? tocCurIdx : 'n/a',
    nextDisabled: document.getElementById('chLabelNext')?.classList.contains('disabled'),
    nextTitle: document.getElementById('chLabelNext')?.title,
    turning: state.turning, recreating: state.recreating, loading: state.loading,
  }));

  console.log('t0:', JSON.stringify(await snap()));

  // Rapid-fire: 8 clicks ~350ms apart, well within one jump's settle time
  for (let k = 1; k <= 8; k++) {
    await page.locator('#chLabelNext').click().catch(() => {});
    await settle(350);
    console.log(`rapid ${k}:`, JSON.stringify(await snap()));
  }
  console.log('--- settling 4s ---');
  await settle(4000);
  console.log('after settle:', JSON.stringify(await snap()));

  // Now does a single leisurely click still advance?
  await page.locator('#chLabelNext').click().catch(() => {});
  await settle(2500);
  console.log('final click:', JSON.stringify(await snap()));
  await browser.close();
} finally { server.kill(); }
