// Zoomed spine-valley captures (user report: gutter band renders as a hard
// flat stripe on dark-page themes). 2x clips of the centre on Ember (dark
// page) and Paper (light page) to judge the fade by eye.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 2 });

async function capture(themeKey, out) {
  await page.goto('http://127.0.0.1:8124/');
  await page.evaluate(() => localStorage.clear());
  await page.evaluate((t) => localStorage.setItem('folio-settings', JSON.stringify({ theme: t, themeAuto: false })), themeKey);
  await page.reload();
  await page.locator('#btnDemo').waitFor({ timeout: 9000 });
  await page.click('#btnDemo');
  await page.waitForFunction(() => typeof LocEngine !== 'undefined' && LocEngine.ready(), null, { timeout: 20000 });
  await page.waitForTimeout(900);
  const w = await page.evaluate(() => {
    const r = document.getElementById('wrap').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  // centre strip: the whole gutter box plus ~45px of page each side
  await page.screenshot({
    path: out,
    clip: { x: w.x + w.w / 2 - 80, y: w.y + 100, width: 160, height: 420 },
  });
  console.log('captured', themeKey, '->', out);
}

await capture('ember', 'tests/e2e/artifacts/spine/ember-spine.png');
await capture('paper', 'tests/e2e/artifacts/spine/paper-spine.png');
await browser.close();
console.log('spine shots done');
