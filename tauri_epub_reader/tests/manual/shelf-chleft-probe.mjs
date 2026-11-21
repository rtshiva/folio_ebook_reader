// One-off visual probe: landing shelf with seeded chLeft records.
// Serves nothing itself — expects http-server on 127.0.0.1:8125 (run separately).
import { chromium } from 'playwright';

const out = process.argv[2] || 'F:/Siva_f/ebook_reader_glm53flash/tauri_epub_reader/tests/manual/shelf-chleft-probe.png';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
await page.goto('http://127.0.0.1:8125/');
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem('folio-recents', JSON.stringify([
    { title: 'The Time Machine', author: 'H. G. Wells', pct: 42, chLeft: 6, chNext: 'IV', filePath: null, thumb: null, timestamp: Date.now() },
    { title: 'Pride and Prejudice', author: 'Jane Austen', pct: 87, chLeft: 1, chNext: 'Chapter 34', filePath: null, thumb: null, timestamp: Date.now() - 1 },
    { title: 'Frankenstein', author: 'Mary Shelley', pct: 100, chLeft: null, chNext: null, filePath: null, thumb: null, timestamp: Date.now() - 2 },
    { title: 'A Tale of Two Cities', author: 'Charles Dickens', pct: 8, filePath: null, thumb: null, timestamp: Date.now() - 3 }
  ]));
});
await page.reload();
await page.locator('.recent-card').first().waitFor({ timeout: 9000 });
await page.waitForTimeout(400);
await page.locator('.recent-shelf').screenshot({ path: out });
await browser.close();
console.log('saved', out);
