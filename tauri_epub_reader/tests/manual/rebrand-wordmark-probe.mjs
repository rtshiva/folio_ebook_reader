// One-off probe: does the rebranded 9-letter wordmark "Aurefolia." fit the landing
// at the window minimum (800px) and default (1280px) sizes, with no horizontal overflow?
import { chromium } from 'playwright';

const browser = await chromium.launch();
const results = [];
for (const width of [800, 1280]) {
  const page = await browser.newPage({ viewport: { width, height: 820 } });
  await page.goto('http://127.0.0.1:8199/');
  await page.evaluate(() => localStorage.clear());
  await page.evaluate(() => localStorage.setItem('folio-settings', JSON.stringify({ theme: 'velvet', themeAuto: false })));
  await page.reload();
  await page.waitForSelector('.wordmark', { timeout: 9000 });
  await page.waitForTimeout(400);
  const st = await page.evaluate(() => {
    const wm = document.querySelector('.wordmark');
    const r = wm.getBoundingClientRect();
    const ghost = document.getElementById('ghost').getBoundingClientRect();
    return {
      wordmark: { text: wm.textContent, left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), fontSize: getComputedStyle(wm).fontSize },
      ghostRight: Math.round(ghost.right),
      docOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      innerWidth: window.innerWidth,
    };
  });
  st.wordmarkFits = st.wordmark.right <= st.innerWidth && !st.docOverflowX;
  results.push(st);
  await page.screenshot({ path: `tests/manual/rebrand-landing-${width}.png`, fullPage: false });
  await page.close();
}
console.log(JSON.stringify(results, null, 1));
await browser.close();
