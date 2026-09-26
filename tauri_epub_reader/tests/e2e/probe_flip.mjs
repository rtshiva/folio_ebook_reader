// Deterministic page-turn probe v2: cache introspection + per-step visuals.
import { chromium } from 'playwright';
import { openDemo, spreadInfo } from './helpers.mjs';
import { mkdirSync } from 'node:fs';

mkdirSync('tests/e2e/artifacts/probe', { recursive: true });
const shot = (p, n) => p.screenshot({ path: `tests/e2e/artifacts/probe/${n}.png` });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
await page.goto('http://127.0.0.1:8124/');
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.locator('#btnDemo').waitFor({ timeout: 9000 });
await openDemo(page);
await page.waitForTimeout(1800);

const cacheState = () => page.evaluate(() => ({
  keys: [...pageCache.chapterHtmls.keys()],
  cached: (pageCache.cachedChapterHtml || '').match(/<title>([^<]*)<\/title>|<h1[^>]*>([^<]*)/i)?.[0] || '(none)',
  loc: (() => { try { const l = state.rendition.currentLocation(); return l && l.start ? { idx: l.start.index, pg: l.start.displayed.page, tot: l.start.displayed.total } : null; } catch (e) { return null; } })(),
}));
const compDump = (label) => page.evaluate((label) => {
  const root = document.querySelector('.pt-compositor');
  if (!root) return { label, comp: null };
  const v = document.getElementById('viewer').getBoundingClientRect();
  const g = (cl) => {
    const el2 = root.querySelector(cl);
    if (!el2) return null;
    const ifr = el2.querySelector('iframe');
    if (!ifr) return { noIframe: true };
    const r = el2.getBoundingClientRect(), ir = ifr.getBoundingClientRect();
    let txt = null, w = null;
    try {
      const d = ifr.contentDocument;
      txt = d && d.body ? d.body.innerText.slice(0, 40).replace(/\s+/g, ' ') : null;
      w = d ? Math.max(d.documentElement.scrollWidth, d.body ? d.body.scrollWidth : 0) : null;
    } catch (e) { txt = 'ERR'; }
    return { winL: Math.round(ir.left - r.left), boxW: Math.round(r.width), ifrW: Math.round(ir.width), docW: w, txt, left: ifr.style.left };
  };
  return { label, loc: (() => { try { const l = state.rendition.currentLocation(); return l && l.start ? l.start.index : null; } catch (e) { return null; } })(), sheet: g('.pt-sheet'), under: g('.pt-underneath-leaf'), stat: g('.pt-stationary-leaf') };
}, label);

console.log('open:', await cacheState());

// Step 1: forward cross-chapter (title -> ch I)
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(350);
console.log('FWD cross mid:', JSON.stringify(await compDump('fwd-cross')));
await shot(page, '20-fwd-cross-mid');
await page.waitForTimeout(1600);
console.log('after fwd:', await cacheState());

// Step 2: backward cross-chapter (ch I -> title), measureLast
await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(120);
console.log('cache before bwd cross:', await cacheState());
await page.waitForTimeout(300);
console.log('BWD cross mid:', JSON.stringify(await compDump('bwd-cross')));
await shot(page, '21-bwd-cross-mid');
await page.waitForTimeout(1600);
console.log('after bwd:', await cacheState());
await shot(page, '22-bwd-cross-settled');

// Step 3: forward into ch II, then backward ch II -> ch I (under = ch I LAST spread)
await page.keyboard.press('ArrowRight'); // title -> ch I
await page.waitForTimeout(1500);
await page.keyboard.press('ArrowRight'); // ch I -> ch II (cross)
await page.waitForTimeout(1500);
console.log('at ch II:', await cacheState());
await page.waitForTimeout(400); // let idle prefetch settle
console.log('cache settled:', await cacheState());
await page.keyboard.press('ArrowLeft');  // ch II -> ch I last spread
await page.waitForTimeout(450);
console.log('BWD chII->chI mid:', JSON.stringify(await compDump('bwd-ch2-ch1')));
await shot(page, '23-bwd-ch2ch1-mid');
await page.waitForTimeout(1500);
console.log('settled:', await cacheState());
await shot(page, '24-bwd-ch2ch1-settled');

await browser.close();
console.log('\nprobe v2 done');
