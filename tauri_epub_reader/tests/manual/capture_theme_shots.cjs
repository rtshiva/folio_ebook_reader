// Captures one screenshot per reading environment for the README grid.
// Each theme is shown with its own desk (rrTheme: 'match') and the per-
// chapter page art on, at 1920x1080. Output: docs/screenshots/theme-*.png
const { chromium } = require('playwright');
const fs = require('fs');

const THEMES = [
  ['paper', 'Natural Paper'],
  ['light', 'Modern Clean'],
  ['noir', 'Velvet Night'],
  ['aizome', 'Aizome'],
  ['ember', 'Ember'],
  ['velvet', 'Velvet'],
  ['emerald', 'Emerald'],
];
const OUT = require('path').resolve(__dirname, '../../docs/screenshots') + '/';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  for (const [key, label] of THEMES) {
    await page.goto('http://127.0.0.1:8124/');
    await page.evaluate(() => localStorage.clear());
    await page.evaluate((k) => localStorage.setItem('folio-settings',
      JSON.stringify({ theme: k, themeAuto: false, rrTheme: 'match', pageOrnaments: true })), key);
    await page.evaluate(() => localStorage.setItem('folio-coach-done', '1'));
    await page.reload();
    await page.locator('#btnDemo').waitFor({ timeout: 9000 });
    await page.click('#btnDemo');
    await page.waitForFunction(() => typeof LocEngine !== 'undefined' && LocEngine.ready(), null, { timeout: 20000 });
    await page.waitForTimeout(900);
    await page.screenshot({ path: OUT + 'theme-' + key + '.png' });
    console.log('captured', key, '(' + label + ')');
  }
  await browser.close();
  console.log('all theme shots done');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
