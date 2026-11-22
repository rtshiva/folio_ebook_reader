// Probe 2: same shift, but on the LIVE (largest-area) chapter iframe.
import { chromium } from 'playwright';
const outDir = 'F:/Siva_f/ebook_reader_glm53flash/tauri_epub_reader/tests/manual/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
await page.goto('http://127.0.0.1:8127/');
await page.evaluate(() => { localStorage.clear(); try { indexedDB.deleteDatabase('folio-kv-db'); } catch(e) {} });
await page.reload();
await page.click('#btnDemo');
await page.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 12000 });
await page.waitForFunction(() => typeof LocEngine !== 'undefined' && LocEngine.ready(), null, { timeout: 12000 });
await page.waitForTimeout(700);

const live = () => {
  let best = null, area = 0;
  for(const f of document.querySelectorAll('#viewer iframe')){
    const r = f.getBoundingClientRect();
    if(r.width * r.height > area){ area = r.width * r.height; best = f; }
  }
  return best;
};
const base = await page.evaluate(() => {
  const ifr = (() => { let best=null, area=0; for(const f of document.querySelectorAll('#viewer iframe')){ const r=f.getBoundingClientRect(); if(r.width*r.height>area){area=r.width*r.height; best=f;} } return best; })();
  const v = document.getElementById('viewer');
  const vw = Math.round(v.getBoundingClientRect().width);
  const d = ifr.contentDocument; const b = d.body;
  const cs = getComputedStyle(b);
  const first = b.querySelector('p, h1, h2, div, img, section');
  const r = first ? first.getBoundingClientRect() : null;
  return { vw, displayed: state.rendition.currentLocation().start.displayed,
    scrollW: b.scrollWidth, padL: cs.paddingLeft, colW: cs.columnWidth, colGap: cs.columnGap,
    firstL: r ? Math.round(r.left) : null, docURL: (d.URL||'').slice(0,40) };
});
console.log('BASE:', JSON.stringify(base));
await page.screenshot({ path: outDir + 'cover-probe-0-base.png' });

const shifted = await page.evaluate(() => {
  const v = document.getElementById('viewer');
  const vw = Math.round(v.getBoundingClientRect().width);
  const gut = spreadMetrics().gutter;
  const step = Math.round((vw + gut) / 2);
  let best=null, area=0; for(const f of document.querySelectorAll('#viewer iframe')){ const r=f.getBoundingClientRect(); if(r.width*r.height>area){area=r.width*r.height; best=f;} }
  const d = best.contentDocument; const b = d.body;
  b.style.setProperty('padding-left', step + 'px', 'important');
  const cs = getComputedStyle(b);
  const first = b.querySelector('p, h1, h2, div, img, section');
  const r = first ? first.getBoundingClientRect() : null;
  return { step, displayed: state.rendition.currentLocation().start.displayed,
    scrollW: b.scrollWidth, padL: cs.paddingLeft, firstL: r ? Math.round(r.left) : null };
});
console.log('SHIFTED:', JSON.stringify(shifted));
await page.waitForTimeout(300);
await page.screenshot({ path: outDir + 'cover-probe-1-shifted.png' });

await page.evaluate(() => { try { turn(1); } catch(e) { window.__turnErr = String(e); } });
await page.waitForTimeout(1000);
const afterTurn = await page.evaluate(() => {
  let best=null, area=0; for(const f of document.querySelectorAll('#viewer iframe')){ const r=f.getBoundingClientRect(); if(r.width*r.height>area){area=r.width*r.height; best=f;} }
  const loc = state.rendition.currentLocation();
  const b = best.contentDocument.body;
  return { turnErr: window.__turnErr || null, displayed: loc.start.displayed, idx: loc.start.index,
    scrollLeft: Math.round((b.scrollingElement || b).scrollLeft || 0) };
});
console.log('AFTER TURN:', JSON.stringify(afterTurn));
await page.screenshot({ path: outDir + 'cover-probe-2-turned.png' });
await browser.close();
console.log('done');
