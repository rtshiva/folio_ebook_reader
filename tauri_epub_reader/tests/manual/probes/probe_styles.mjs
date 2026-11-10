// Dump live chapter doc layout styles (what epub.js writes inline) + epub.js version.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
await page.goto('http://127.0.0.1:8124/');
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.locator('#btnDemo').waitFor({ timeout: 9000 });
await page.click('#btnDemo');
await page.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 12000 });
await page.waitForTimeout(1500);

const out = await page.evaluate(() => {
  const f = [...document.querySelectorAll('#viewer iframe')].sort((a, b) =>
    b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
  const d = f.contentDocument;
  const cs = getComputedStyle(d.documentElement);
  const bs = getComputedStyle(d.body);
  return {
    epubjs: (typeof ePub !== 'undefined' && ePub.VERSION) || 'unknown',
    htmlStyle: d.documentElement.style.cssText,
    bodyStyle: d.body.style.cssText,
    computed: {
      colW: cs.columnWidth, colGap: cs.columnGap, colFill: cs.columnFill,
      htmlW: cs.width, htmlH: cs.height, htmlPad: cs.padding, htmlMargin: cs.margin, overflow: cs.overflow,
      bodyW: bs.width, bodyH: bs.height, bodyPad: bs.padding, bodyMargin: bs.margin,
    },
    scrollW: d.documentElement.scrollWidth,
    headStyles: [...d.querySelectorAll('style')].map(s => s.textContent.slice(0, 120)),
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
