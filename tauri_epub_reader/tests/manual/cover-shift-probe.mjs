// Probe: can we shift the first section one column right in spread mode
// ([blank | first-page] like an opened book)? Measures epub.js's column
// math live, injects a padding-left, and checks pairing + paging survive.
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

const base = await page.evaluate(() => {
  const v = document.getElementById('viewer');
  const vw = Math.round(v.getBoundingClientRect().width);
  const loc = state.rendition.currentLocation();
  const fr = (window.viewerFrameProbe = null);
  const ifr = document.querySelector('#viewer iframe');
  const d = ifr.contentDocument;
  const b = d.body;
  const cs = getComputedStyle(b);
  // position of first content element and its column math
  const first = b.querySelector('p, h1, h2, div, img, section');
  const r = first ? first.getBoundingClientRect() : null;
  return {
    vw,
    displayed: loc.start.displayed,
    scrollW: b.scrollWidth,
    padL: cs.paddingLeft, padR: cs.paddingRight,
    colW: cs.columnWidth, colGap: cs.columnGap,
    firstRect: r ? { l: Math.round(r.left), w: Math.round(r.width) } : null,
    bWidth: cs.width,
  };
});
console.log('BASE:', JSON.stringify(base));
await page.screenshot({ path: outDir + 'cover-probe-0-base.png' });

// Inject: shift by one column slot. Step candidates: (mw+gut)/2
const shifted = await page.evaluate(() => {
  const v = document.getElementById('viewer');
  const vw = Math.round(v.getBoundingClientRect().width);
  const sm = spreadMetrics();
  const step = Math.round((vw + sm.gutter) / 2); // one column slot
  const ifr = document.querySelector('#viewer iframe');
  const b = ifr.contentDocument.body;
  b.style.setProperty('padding-left', step + 'px', 'important');
  const loc = state.rendition.currentLocation();
  const first = b.querySelector('p, h1, h2, div, img, section');
  const r = first ? first.getBoundingClientRect() : null;
  return {
    step, vw, gut: sm.gutter,
    displayed: loc.start.displayed,
    scrollW: b.scrollWidth,
    firstRect: r ? { l: Math.round(r.left), w: Math.round(r.width) } : null,
  };
});
console.log('SHIFTED:', JSON.stringify(shifted));
await page.waitForTimeout(300);
await page.screenshot({ path: outDir + 'cover-probe-1-shifted.png' });

// Does a page turn still behave?
await page.evaluate(() => { try { turn(1); } catch(e) { window.__turnErr = String(e); } });
await page.waitForTimeout(900);
const afterTurn = await page.evaluate(() => {
  const loc = state.rendition.currentLocation();
  const ifr = document.querySelector('#viewer iframe');
  const b = ifr.contentDocument.body;
  return {
    turnErr: window.__turnErr || null,
    displayed: loc.start.displayed,
    idx: loc.start.index,
    scrollLeft: Math.round((b.scrollingElement || b).scrollLeft || 0),
  };
});
console.log('AFTER TURN:', JSON.stringify(afterTurn));
await page.screenshot({ path: outDir + 'cover-probe-2-turned.png' });

await browser.close();
console.log('done');
