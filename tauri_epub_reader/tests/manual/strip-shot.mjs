// One-off visual probe: the bottom reading strip with the new segment.
import { chromium } from 'playwright';

const out = 'F:/Siva_f/ebook_reader_glm53flash/tauri_epub_reader/tests/manual/strip-shot.png';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
await page.goto('http://127.0.0.1:8125/');
await page.evaluate(() => { localStorage.clear(); try { indexedDB.deleteDatabase('folio-kv-db'); } catch(e) {} });
await page.reload();
await page.click('#btnDemo');
await page.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 12000 });
await page.waitForFunction(() => typeof LocEngine !== 'undefined' && LocEngine.ready(), null, { timeout: 12000 });
await page.waitForTimeout(700);
console.log('timeLeft:', await page.locator('#timeLeft').textContent());
console.log('pageBadge:', await page.locator('#pageBadge').textContent());
// mid-chapter: jump into ch1 so a numeric count shows
await page.evaluate(() => jumpToTocIndex(1));
await page.waitForFunction(() => chNavIdx === 1, null, { timeout: 12000 });
await page.waitForTimeout(500);
console.log('after jump timeLeft:', await page.locator('#timeLeft').textContent());
await page.screenshot({ path: out, clip: { x: 0, y: 860 - 90, width: 1360, height: 90 } });
await browser.close();
console.log('saved', out);
