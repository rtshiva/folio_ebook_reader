// Zoomed edge captures: 2x scale clips of both fore-edges + stand bottom.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 2 });
await page.goto('http://127.0.0.1:8124/');
await page.evaluate(() => localStorage.clear());
await page.evaluate(() => localStorage.setItem('folio-settings', JSON.stringify({ theme: 'paper', themeAuto: false })));
await page.reload();
await page.locator('#btnDemo').waitFor({ timeout: 9000 });
await page.click('#btnDemo');
await page.waitForFunction(() => typeof LocEngine !== 'undefined' && LocEngine.ready(), null, { timeout: 20000 });
await page.waitForTimeout(900);

const wrap = await page.evaluate(() => {
  const r = document.getElementById('wrap').getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
// right edge (full right stack at book start)
await page.screenshot({ path: 'tests/e2e/artifacts/edge-dress/zoom-right-start.png',
  clip: { x: wrap.x + wrap.w - 30, y: wrap.y + 80, width: 60, height: 300 } });
// left edge (front board at book start)
await page.screenshot({ path: 'tests/e2e/artifacts/edge-dress/zoom-left-start.png',
  clip: { x: wrap.x - 30, y: wrap.y + 80, width: 60, height: 300 } });
// mid-book both edges at 50%
await page.evaluate(() => state.rendition.display(2));
await page.waitForFunction(() => !document.body.classList.contains('at-start'), null, { timeout: 9000 });
await page.waitForTimeout(700);
await page.screenshot({ path: 'tests/e2e/artifacts/edge-dress/zoom-right-mid.png',
  clip: { x: wrap.x + wrap.w - 30, y: wrap.y + 80, width: 60, height: 300 } });
// stand bottom block at mid (blocks sit ~37px outside the wrap edges)
await page.screenshot({ path: 'tests/e2e/artifacts/edge-dress/zoom-stand-mid.png',
  clip: { x: wrap.x - 50, y: wrap.y + wrap.h - 26, width: 110, height: 34 } });
await page.screenshot({ path: 'tests/e2e/artifacts/edge-dress/zoom-stand-mid-r.png',
  clip: { x: wrap.x + wrap.w - 60, y: wrap.y + wrap.h - 26, width: 110, height: 34 } });
await browser.close();
console.log('zoom shots done');
