// Probe 4: paint-only body transform on the live title doc (frame realm).
// Checks: visual [blank|title], scrollWidth untouched, turns + location sane.
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
await page.evaluate(() => { window.__probe = { rendition: () => state.rendition.currentLocation().start.displayed }; });

const liveFrame = async () => {
  const h = await page.evaluateHandle(() => {
    let best = null, area = 0;
    for(const f of document.querySelectorAll('#viewer iframe')){
      const r = f.getBoundingClientRect();
      if(r.width * r.height > area){ area = r.width * r.height; best = f; }
    }
    return best;
  });
  const el = h.asElement();
  const fr = await el.contentFrame();
  return fr;
};

let frame = await liveFrame();
const base = await frame.evaluate(() => ({
  scrollW: document.body.scrollWidth,
  docScrollW: document.documentElement.scrollWidth,
  transform: getComputedStyle(document.body).transform,
}));
console.log('BASE:', JSON.stringify(base));

await frame.evaluate(() => {
  const v = window.parent.document.getElementById('viewer');
  const vw = Math.round(v.getBoundingClientRect().width);
  window.parent.__slot = Math.round(vw / 2);
  document.body.style.setProperty('transform', 'translateX(' + Math.round(vw / 2) + 'px)', 'important');
});
await page.waitForTimeout(250);
const shifted = await frame.evaluate(() => ({
  scrollW: document.body.scrollWidth,
  docScrollW: document.documentElement.scrollWidth,
  transform: getComputedStyle(document.body).transform,
  displayed: window.parent.__probe.rendition(),
}));
console.log('SHIFTED:', JSON.stringify(shifted));
await page.screenshot({ path: outDir + 'cover-probe-4-shifted.png' });

// forward turn: expect [title-p2 | blank] then next spread = ch1
await page.evaluate(() => { try { turn(1); } catch(e) { window.__e1 = String(e); } });
await page.waitForTimeout(1000);
console.log('TURN1 err:', await page.evaluate(() => window.__e1 || null),
  'loc:', JSON.stringify(await page.evaluate(() => state.rendition.currentLocation().start.displayed)));
await page.screenshot({ path: outDir + 'cover-probe-4-turn1.png' });

await page.evaluate(() => { try { turn(1); } catch(e) { window.__e2 = String(e); } });
await page.waitForTimeout(1000);
console.log('TURN2 loc:', JSON.stringify(await page.evaluate(() => state.rendition.currentLocation().start.displayed)),
  'idx:', await page.evaluate(() => state.rendition.currentLocation().start.index));
await page.screenshot({ path: outDir + 'cover-probe-4-turn2.png' });

await browser.close();
console.log('done');
