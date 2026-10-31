// Debug: why aren't .rr-corner flourishes painting? Inspect computed mask,
// resource loads, and box geometry.
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const failures = [];
page.on('requestfailed', (r) => failures.push(r.url() + ' :: ' + (r.failure() || {}).errorText));
await page.goto('http://127.0.0.1:8124/');
await page.evaluate(() => localStorage.clear());
await page.evaluate(() => localStorage.setItem('folio-settings', JSON.stringify({ themeAuto: false, rrTheme: 'royal-maroon' })));
await page.reload();
await page.locator('#btnDemo').waitFor({ timeout: 9000 });
await page.click('#btnDemo');
await page.waitForFunction(() => typeof LocEngine !== 'undefined' && LocEngine.ready(), null, { timeout: 20000 });
await page.waitForTimeout(500);
const info = await page.evaluate(() => {
  const c = document.querySelector('.rr-corner.tl');
  const s = getComputedStyle(c);
  const r = c.getBoundingClientRect();
  const w = document.getElementById('wrap').getBoundingClientRect();
  return {
    display: s.display, bg: s.backgroundColor, maskImage: s.maskImage.slice(0, 90),
    webkitMask: s.webkitMaskImage ? s.webkitMaskImage.slice(0, 90) : '(none)',
    rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    wrap: { x: w.x, y: w.y }, opacity: s.opacity, z: s.zIndex, vis: s.visibility,
    dataRR: document.documentElement.dataset.rr, bodyOrn: document.body.className.includes('rr-orn'),
  };
});
console.log(JSON.stringify(info, null, 1));
console.log('failed requests:', failures.length ? failures : 'none');
const loaded = await page.evaluate(() => performance.getEntriesByType('resource')
  .filter((e) => e.name.includes('ornaments')).map((e) => e.name.split('/').pop() + ' ' + (e.transferSize || e.decodedBodySize)));
console.log('ornament resources:', loaded);
await browser.close();
