// Probe 6: the real implementation end-to-end (open / turn / back / single).
import { chromium } from 'playwright';
const outDir = 'F:/Siva_f/ebook_reader_glm53flash/tauri_epub_reader/tests/manual/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if(m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto('http://127.0.0.1:8127/');
await page.evaluate(() => { localStorage.clear(); try { indexedDB.deleteDatabase('folio-kv-db'); } catch(e) {} });
await page.reload();
await page.click('#btnDemo');
await page.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 12000 });
await page.waitForFunction(() => typeof LocEngine !== 'undefined' && LocEngine.ready(), null, { timeout: 12000 });
await page.waitForTimeout(1100); // cold pass + park settle

const st = await page.evaluate(() => {
  const v = document.getElementById('viewer').getBoundingClientRect();
  let best = null, area = 0;
  for(const f of document.querySelectorAll('#viewer iframe')){
    const r = f.getBoundingClientRect();
    if(r.width * r.height > area){ area = r.width * r.height; best = f; }
  }
  const d = best.contentDocument;
  const de = d.documentElement;
  const first = d.body.querySelector('p, h1, h2, div, img, section');
  return {
    cls: de.classList.contains('folio-first-leaf'),
    tx: getComputedStyle(d.body).transform,
    firstTopL: first ? Math.round(first.getBoundingClientRect().left) : null, // parent-realm top space
    vw: Math.round(v.width),
    disp: state.rendition.currentLocation().start.displayed,
    cacheHasCls: (pageCache.getChapterHtml(0) || '').includes('folio-first-leaf'),
  };
});
console.log('OPEN:', JSON.stringify(st));
await page.screenshot({ path: outDir + 'cover-live-0-open.png' });

// forward turn → expect ch1 spread [p1|p2] (demo's blank verso skipped)
await page.evaluate(() => turn(1));
await page.waitForTimeout(1000);
console.log('TURN1:', JSON.stringify(await page.evaluate(() => ({
  disp: state.rendition.currentLocation().start.displayed,
  idx: state.rendition.currentLocation().start.index,
}))));
await page.screenshot({ path: outDir + 'cover-live-1-turn.png' });

// back → expect [blank | title] again
await page.evaluate(() => turn(-1));
await page.waitForTimeout(1000);
const back = await page.evaluate(() => {
  let best = null, area = 0;
  for(const f of document.querySelectorAll('#viewer iframe')){
    const r = f.getBoundingClientRect();
    if(r.width * r.height > area){ area = r.width * r.height; best = f; }
  }
  const d = best.contentDocument;
  const first = d.body.querySelector('p, h1, h2, div, img, section');
  return {
    disp: state.rendition.currentLocation().start.displayed,
    tx: getComputedStyle(d.body).transform,
    firstTopL: first ? Math.round(first.getBoundingClientRect().left) : null,
  };
});
console.log('BACK:', JSON.stringify(back));
await page.screenshot({ path: outDir + 'cover-live-2-back.png' });

// single-page mode must be untouched
await page.evaluate(() => { state.spreadOn = false; document.body.classList.remove('spread'); });
await page.evaluate(() => jumpToTocIndex(0));
await page.waitForTimeout(900);
const single = await page.evaluate(() => {
  let best = null, area = 0;
  for(const f of document.querySelectorAll('#viewer iframe')){
    const r = f.getBoundingClientRect();
    if(r.width * r.height > area){ area = r.width * r.height; best = f; }
  }
  const d = best.contentDocument;
  return {
    cls: d.documentElement.classList.contains('folio-first-leaf'),
    tx: getComputedStyle(d.body).transform,
    disp: state.rendition.currentLocation().start.displayed,
  };
});
console.log('SINGLE:', JSON.stringify(single));
console.log('ERRORS:', errors.length ? errors.slice(0,5) : 'none');
await browser.close();
console.log('done');
