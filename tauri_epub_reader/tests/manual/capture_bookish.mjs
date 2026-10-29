// Captures the bookish batch: embossed board lettering + gilt fore-edges
// (velvet), finis colophon with stats, classic indents, old-style numerals.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = 'tests/e2e/artifacts/edge-dress';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });

async function openWithSettings(theme, extra = {}) {
  await page.goto('http://127.0.0.1:8124/');
  await page.evaluate(() => localStorage.clear());
  await page.evaluate(({ t, ex }) => {
    localStorage.setItem('folio-settings', JSON.stringify({ theme: t, themeAuto: false, ...ex }));
  }, { t: theme, ex: extra });
  await page.reload();
  await page.locator('#btnDemo').waitFor({ timeout: 9000 });
  await page.click('#btnDemo');
  await page.waitForFunction(() => typeof LocEngine !== 'undefined' && LocEngine.ready(), null, { timeout: 20000 });
  await page.waitForTimeout(900);
}

// 1. velvet: embossed board lettering + gilt right stack
await openWithSettings('velvet');
await page.screenshot({ path: `${OUT}/bookish-velvet-start.png` });

// 2. finis with the stats colophon
await page.evaluate(() => localStorage.setItem('folio-bstat:The Time Machine',
  JSON.stringify({ min: 486, days: { '2026-10-20': 60, '2026-10-21': 120, '2026-10-27': 66, '2026-10-28': 240 } })));
await page.evaluate(() => state.rendition.display(state.book.spine.length - 1));
await page.waitForFunction(() => !document.body.classList.contains('at-start'), null, { timeout: 9000 });
await page.evaluate(() => EdgeStacks.set(1, { page: 2, total: 2 }));
await page.waitForFunction(() => (document.getElementById('finisMeta').textContent || '').length > 0, null, { timeout: 4000 });
await page.waitForTimeout(1000);
await page.screenshot({ path: `${OUT}/bookish-finis-meta.png` });

// 3. paper with classic indents + old-style numerals, on a chapter body
await openWithSettings('paper', { indent: true, oldstyle: true });
await page.evaluate(() => state.rendition.display(1));
await page.waitForTimeout(1100);
await page.screenshot({ path: `${OUT}/bookish-indent-oldstyle.png` });

await browser.close();
console.log('bookish shots done');
