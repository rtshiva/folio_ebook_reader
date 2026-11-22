// Probe 5: transform + overflow-x:clip — does docScrollW stay flat, and do
// seats survive jump-away-and-back (epub.js re-mapping the shifted section)?
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
await page.evaluate(() => { window.__probe = { disp: () => state.rendition.currentLocation().start.displayed }; });

const liveFrame = async () => {
  const h = await page.evaluateHandle(() => {
    let best = null, area = 0;
    for(const f of document.querySelectorAll('#viewer iframe')){
      const r = f.getBoundingClientRect();
      if(r.width * r.height > area){ area = r.width * r.height; best = f; }
    }
    return best;
  });
  return (await h.asElement().contentFrame());
};
let frame = await liveFrame();
await frame.evaluate(() => {
  const v = window.parent.document.getElementById('viewer');
  const vw = Math.round(v.getBoundingClientRect().width);
  document.body.style.setProperty('transform', 'translateX(' + Math.round(vw / 2) + 'px)', 'important');
  document.documentElement.style.setProperty('overflow-x', 'clip', 'important');
});
await page.waitForTimeout(250);
console.log('SHIFTED+CLIP:', JSON.stringify(await frame.evaluate(() => ({
  bodySW: document.body.scrollWidth, docSW: document.documentElement.scrollWidth,
}))));

// jump to ch1, then BACK to the title — does the title re-map with sane totals?
await page.evaluate(() => jumpToTocIndex(1));
await page.waitForFunction(() => chNavIdx === 1, null, { timeout: 12000 });
await page.waitForTimeout(700);
console.log('AT CH1:', JSON.stringify(await page.evaluate(() => window.__probe.disp())));
await page.evaluate(() => jumpToTocIndex(0));
await page.waitForFunction(() => chNavIdx === 0, null, { timeout: 12000 });
await page.waitForTimeout(900);
frame = await liveFrame();
console.log('BACK AT TITLE:', JSON.stringify({
  disp: await page.evaluate(() => window.__probe.disp()),
  geom: await frame.evaluate(() => ({
    bodySW: document.body.scrollWidth, docSW: document.documentElement.scrollWidth,
    transform: getComputedStyle(document.body).transform,
  })),
}));
await page.screenshot({ path: outDir + 'cover-probe-5-back.png' });
await browser.close();
console.log('done');
