// One-off probe: landing legibility across desk combos after the desk-token
// conversion. Captures landing.png per combo + computes title/lede colors.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const combos = [
  { key: 'paper-maroon', theme: 'paper', rrTheme: 'royal-maroon' },   // was broken
  { key: 'velvet-maroon', theme: 'velvet', rrTheme: 'royal-maroon' }, // user env, titles invisible
  { key: 'paper-match', theme: 'paper', rrTheme: 'match' },           // regression guard
];
for (const c of combos) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto('http://127.0.0.1:8199/');
  await page.evaluate(() => localStorage.clear());
  await page.evaluate((s) => localStorage.setItem('folio-settings', JSON.stringify(s)), { theme: c.theme, themeAuto: false, rrTheme: c.rrTheme });
  await page.reload();
  await page.locator('.wordmark').waitFor({ timeout: 9000 });
  await page.waitForTimeout(500);
  const st = await page.evaluate(() => {
    const t = document.querySelector('.recent-book-title');
    return {
      bodyColor: getComputedStyle(document.getElementById('landing')).color,
      titleColor: t ? getComputedStyle(t).color : '(no shelf)',
      ledeColor: getComputedStyle(document.getElementById('lede')).color,
      deskBg: getComputedStyle(document.body).backgroundColor,
    };
  });
  console.log(c.key, JSON.stringify(st));
  await page.screenshot({ path: `tests/manual/landing-desk-${c.key}.png` });
  await page.close();
}
await browser.close();
