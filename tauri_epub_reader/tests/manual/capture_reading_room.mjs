// Reading Room captures: Royal Maroon reference room — full frame, corner /
// medallion / frame zooms at 2x, chrome-tucked immersive shot, and the
// velvet-paper-under-maroon-desk combo.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
const clamp = (v) => Math.max(0, v);

async function boot(settings) {
  await page.goto('http://127.0.0.1:8124/');
  await page.evaluate(() => localStorage.clear());
  if (settings) await page.evaluate((s) => localStorage.setItem('folio-settings', JSON.stringify(s)), settings);
  await page.evaluate(() => localStorage.setItem('folio-coach-done', '1'));
  await page.reload();
  await page.locator('#btnDemo').waitFor({ timeout: 9000 });
  await page.click('#btnDemo');
  await page.waitForFunction(() => typeof LocEngine !== 'undefined' && LocEngine.ready(), null, { timeout: 20000 });
  await page.waitForTimeout(900);
}

// 1. Royal Maroon room over the default paper environment
await boot({ themeAuto: false, rrTheme: 'royal-maroon' });
const w = await page.evaluate(() => {
  const r = document.getElementById('wrap').getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
// chrome-tucked immersive frame (bars hide on scroll/idle; force the class)
await page.evaluate(() => document.body.classList.add('chrome-hidden'));
await page.waitForTimeout(500);
await page.screenshot({ path: 'tests/manual/shots/readingroom/maroon-full.png' });
await page.evaluate(() => document.body.classList.remove('chrome-hidden'));
await page.waitForTimeout(400);
await page.screenshot({ path: 'tests/manual/shots/readingroom/maroon-corner-tl.png',
  clip: { x: 0, y: 0, width: 260, height: 260 } });
await page.screenshot({ path: 'tests/manual/shots/readingroom/maroon-corner-br.png',
  clip: { x: 1920 - 260, y: 1080 - 260, width: 260, height: 260 } });
await page.screenshot({ path: 'tests/manual/shots/readingroom/maroon-medallion.png',
  clip: { x: 1920 - 240, y: 1080 / 2 - 130, width: 240, height: 260 } });
await page.screenshot({ path: 'tests/manual/shots/readingroom/maroon-top-frame.png',
  clip: { x: w.x + w.w / 2 - 170, y: clamp(w.y - 60), width: 340, height: 120 } });

// 2. Independence combo: velvet paper (dark page) under the maroon room
await page.evaluate(() => {
  settings.rrTheme = 'royal-maroon'; save();
  applyEnvironment('velvet');
  settings.rrTheme = 'royal-maroon'; save(); applyTheme();
});
await page.waitForTimeout(700);
await page.screenshot({ path: 'tests/manual/shots/readingroom/maroon-velvet-combo.png' });

// 3. Match-env regression: velvet alone must look untouched
await page.evaluate(() => { settings.rrTheme = 'match'; save(); applyTheme(); });
await page.waitForTimeout(700);
await page.screenshot({ path: 'tests/manual/shots/readingroom/velvet-match.png' });

await browser.close();
console.log('reading room shots done');
