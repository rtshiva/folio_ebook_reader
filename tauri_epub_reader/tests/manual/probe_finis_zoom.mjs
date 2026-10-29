// One-off probe: is the finis mark visible at-end, and what does the region look like?
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 2 });
await page.goto('http://127.0.0.1:8124/');
await page.evaluate(() => localStorage.clear());
await page.evaluate(() => localStorage.setItem('folio-settings', JSON.stringify({ theme: 'velvet', themeAuto: false })));
await page.reload();
await page.locator('#btnDemo').waitFor({ timeout: 9000 });
await page.click('#btnDemo');
await page.waitForFunction(() => typeof LocEngine !== 'undefined' && LocEngine.ready(), null, { timeout: 20000 });
await page.waitForTimeout(800);
await page.evaluate(() => state.rendition.display(state.book.spine.length - 1));
await page.waitForFunction(() => !document.body.classList.contains('at-start'), null, { timeout: 9000 });
await page.waitForTimeout(500);
await page.evaluate(() => EdgeStacks.set(1, { page: 2, total: 2 }));
await page.waitForTimeout(1200);
const st = await page.evaluate(() => {
  const f = document.getElementById('finis');
  const cs = getComputedStyle(f);
  return {
    atEnd: document.body.classList.contains('at-end'),
    meta: document.getElementById('finisMeta').textContent,
    finisVisibility: cs.visibility, finisOpacity: cs.opacity,
    rect: f.getBoundingClientRect().toJSON(),
  };
});
console.log(JSON.stringify(st, null, 1));
await page.screenshot({ path: 'tests/e2e/artifacts/edge-dress/zoom-finis-region.png',
  clip: { x: 430, y: 700, width: 500, height: 130 } });
await browser.close();
