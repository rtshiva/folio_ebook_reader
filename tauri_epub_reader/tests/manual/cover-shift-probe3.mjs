// Probe 3: all measurements in the IFRAME realm; check epub.js re-assertion.
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

// find the live frame object
const frHandle = await page.evaluateHandle(() => {
  let best = null, area = 0;
  for(const f of document.querySelectorAll('#viewer iframe')){
    const r = f.getBoundingClientRect();
    if(r.width * r.height > area){ area = r.width * r.height; best = f; }
  }
  return best;
});
const frame = await frHandle.asElement().contentFrame();

const measure = () => frame.evaluate(() => {
  const b = document.body;
  const cs = getComputedStyle(b);
  const first = b.querySelector('p, h1, h2, div, img, section');
  const r = first ? first.getBoundingClientRect() : null;
  const parentDisp = (window.parent.state && window.parent.state.rendition)
    ? window.parent.state.rendition.currentLocation().start.displayed : null;
  return {
    padL: cs.paddingLeft, scrollW: b.scrollWidth, colW: cs.columnWidth, colGap: cs.columnGap,
    firstL: r ? Math.round(r.left) : null, displayed: parentDisp,
    inlineStyle: b.getAttribute('style') || '(none)',
  };
});

console.log('BASE   :', JSON.stringify(await measure()));

// epub-injected body rules (who owns padding?)
const rules = await frame.evaluate(() => {
  const out = [];
  for(const sh of document.styleSheets){
    let list; try{ list = sh.cssRules; }catch(e){ continue; }
    for(const r of list){
      const t = r.cssText || '';
      if(/padding/i.test(t) && /body/i.test(t)) out.push(t.slice(0, 160));
    }
  }
  return out;
});
console.log('PADDING RULES:', JSON.stringify(rules, null, 1));

await frame.evaluate(() => {
  const v = window.parent.document.getElementById('viewer');
  const vw = Math.round(v.getBoundingClientRect().width);
  const gut = window.parent.spreadMetrics().gutter;
  const step = Math.round((vw + gut) / 2);
  window.__step = step;
  document.body.style.setProperty('padding-left', step + 'px', 'important');
});
console.log('T0     :', JSON.stringify(await measure()));
await page.waitForTimeout(600);
console.log('T600   :', JSON.stringify(await measure()));
await page.waitForTimeout(600);
console.log('T1200  :', JSON.stringify(await measure()));
await page.screenshot({ path: outDir + 'cover-probe-3-shifted.png' });

await browser.close();
console.log('done');
