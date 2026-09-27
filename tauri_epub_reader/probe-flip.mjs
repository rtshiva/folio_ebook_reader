// Probe: X4 replication — ArrowRight with the voc drawer open.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('http://127.0.0.1:8124/');
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.locator('#btnDemo').waitFor({ timeout: 9000 });
await page.evaluate(() => { try { settings.themeAuto = false; save(); } catch (e) {} });
await page.click('#btnDemo');
await page.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 12000 });
await page.waitForFunction(() => typeof LocEngine !== 'undefined' && LocEngine.ready(), null, { timeout: 12000 });

await page.evaluate(() => {
  window.__log = [];
  const origT = window.turn;
  window.turn = function (dir) { window.__log.push({ ev: 'turn', dir, t: Math.round(performance.now()) }); return origT(dir); };
  const origOnKey = window.onKey;
});
await page.evaluate(() => {
  const cfi = state.rendition.currentLocation().start.cfi;
  DictCache.set('ephemeral', 'Lasting for a very short time.');
  VocabLog.add('ephemeral', 'Title Page', cfi);
  toggleToc();
  setTocTab('voc');
});
await page.waitForTimeout(700);
console.log('toc-open:', await page.evaluate(() => document.body.classList.contains('toc-open')));
console.log('panelsOpen:', await page.evaluate(() => panelsOpen()));
console.log('activeElement:', await page.evaluate(() => {
  const a = document.activeElement;
  return a ? `${a.tagName}#${a.id || ''}.${String(a.className).slice(0, 20)}` : 'none';
}));
const b0 = await page.locator('#pageBadge').textContent();
console.log('b0:', b0);
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(2500);
console.log('log:', JSON.stringify(await page.evaluate(() => window.__log)));
console.log('badge now:', await page.locator('#pageBadge').textContent());
console.log('turning:', await page.evaluate(() => state.turning));
await browser.close();
