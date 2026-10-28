// Flip pages in the running exe via CDP and confirm chapters load cleanly.
import { chromium } from 'playwright';
const port = process.argv[2] || '9333';
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = browser.contexts()[0].pages()[0];
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 120)); });
page.on('requestfailed', (r) => errors.push('REQFAIL ' + r.url().slice(0, 100)));
for (let i = 0; i < 4; i++) {
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(900);
}
const out = await page.evaluate(() => ({
  badge: document.getElementById('pageBadge')?.textContent,
  pct: document.getElementById('pct')?.textContent,
  iframes: document.querySelectorAll('#viewer iframe').length,
  tocEmpty: !!document.querySelector('#tocList li.empty'),
}));
console.log(JSON.stringify(out));
console.log('console/network errors:', errors.length ? errors : 'none');
await browser.close();
