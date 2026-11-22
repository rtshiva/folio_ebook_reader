// Probe the REAL installed exe: open The Butcher's Masquerade, then replay
// the user's flow (mid-book -> rail seek to 0% -> back-turn into the cover
// section) while sampling every iframe doc across the flip timeline.
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import * as fsmod from 'fs';

const exe = 'F:/myInstalls/FolioReader/app.exe';
const BOOK = 'G:/books/The_Butchers_Masquerade__Dunge_-_Matt_Dinniman.epub';
const proc = spawn(exe, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9333' },
  stdio: 'ignore',
});
let browser = null;
for(let i = 0; i < 40 && !browser; i++){
  await new Promise(r => setTimeout(r, 500));
  try { browser = await chromium.connectOverCDP('http://127.0.0.1:9333'); } catch(e) {}
}
if(!browser){ console.log('CDP attach failed'); process.exit(1); }
const ctx = browser.contexts()[0];
const page = ctx.pages()[0] || await ctx.newPage();
await page.waitForFunction(() => !!document.body, null, { timeout: 15000 });
const cdp = await ctx.newCDPSession(page);
const { windowId } = await cdp.send('Browser.getWindowForTarget').catch(() => ({}));
if(windowId){ await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal', width: 1920, height: 1224 } }).catch(() => {}); }
await page.waitForTimeout(1200);

await page.evaluate(async (bookPath) => {
  try { if(document.body.classList.contains('state-reading')) closeBook(); } catch(e) {}
  await openEpubPath(bookPath);
}, BOOK).catch(e => console.log('open err:', String(e).slice(0, 200)));
await page.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 30000 });
await page.waitForFunction(() => LocEngine.ready(), null, { timeout: 30000 }).catch(() => {});
console.log('OPENED:', JSON.stringify(await page.evaluate(() => ({
  idx: state.rendition.currentLocation().start.index,
  disp: state.rendition.currentLocation().start.displayed,
  locsReady: LocEngine.ready(),
}))));

// go mid-book, then rail-seek to 0% (the user's flow)
await page.evaluate(() => { try { jumpToTocIndex(1); } catch(e) {} });
await page.waitForFunction(() => state.rendition.currentLocation().start.index > 0, null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(800);
await page.evaluate(() => { try { railSeekCommit(0); } catch(e) {} });
await page.waitForTimeout(1200);
console.log('SEEK0:', JSON.stringify(await page.evaluate(() => ({
  idx: state.rendition.currentLocation().start.index,
  badge: document.getElementById('pageBadge').textContent,
}))));

// back-turn into the cover section, sampling iframe docs during the flip
await page.evaluate(() => { try { turn(-1); } catch(e) {} });
for(const t of [150, 300, 450, 600, 900]){
  if(t === 300){ await page.waitForTimeout(150); await page.screenshot({ path: 'tests/manual/dcc-midflip.png' }); }
  await page.waitForTimeout(t === 150 ? 150 : t - (t === 300 ? 150 : t === 450 ? 300 : t === 600 ? 450 : 600));
  const snap = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('#viewer iframe').forEach(f => {
      let d = null; try { d = f.contentDocument; } catch(e) { return; }
      if(!d || !d.body) return;
      const r = f.getBoundingClientRect();
      const svg = d.querySelector('svg');
      const wrap = d.querySelector('.folio-image-wrapper, div:has(svg), div:has(img)');
      out.push({
        w: Math.round(r.width), h: Math.round(r.height), l: Math.round(r.left),
        compat: d.compatMode,
        htmlCls: (d.documentElement.getAttribute('class') || '(none)').slice(0, 55),
        dynShift: ((d.getElementById('folio-dyn') || {}).textContent || '').includes('folio-first-leaf'),
        tx: getComputedStyle(d.body).transform.slice(0, 26),
        svg: svg ? { l: Math.round(svg.getBoundingClientRect().left), t: Math.round(svg.getBoundingClientRect().top), w: Math.round(svg.getBoundingClientRect().width), h: Math.round(svg.getBoundingClientRect().height) } : null,
        wrap: wrap ? { l: Math.round(wrap.getBoundingClientRect().left), w: Math.round(wrap.getBoundingClientRect().width), h: Math.round(wrap.getBoundingClientRect().height) } : null,
      });
    });
    return out;
  });
  console.log('IFRAMES @' + t + 'ms:', JSON.stringify(snap));
}
await page.waitForTimeout(1200);
console.log('BG PROBE:', JSON.stringify(await page.evaluate(() => {
  const v = document.getElementById('viewer');
  let best = null, area = 0;
  for(const f of document.querySelectorAll('#viewer iframe')){
    const r = f.getBoundingClientRect();
    if(r.width * r.height > area){ area = r.width * r.height; best = f; }
  }
  const d = best.contentDocument;
  const de = d.documentElement;
  return {
    viewerCls: v.className,
    viewerBg: getComputedStyle(v).backgroundColor,
    docCls: de.getAttribute('class'),
    htmlBg: getComputedStyle(de).backgroundColor,
    bodyBg: getComputedStyle(d.body).backgroundColor,
    dynHasRule: ((d.getElementById('folio-dyn') || {}).textContent || '').includes('html.folio-first-leaf{background:transparent'),
  };
})));
console.log('HIT PROBE:', JSON.stringify(await page.evaluate(() => {
  const v = document.getElementById('viewer').getBoundingClientRect();
  const x = Math.round(v.left + v.width * 0.25), y = Math.round(v.top + v.height * 0.5);
  const elHit = document.elementFromPoint(x, y);
  const chain = [];
  let n = elHit;
  while(n && n !== document.body){
    const cs = getComputedStyle(n);
    chain.push({ tag: n.tagName + (n.id ? '#' + n.id : '') + (n.className && typeof n.className === 'string' ? '.' + n.className.split(' ').slice(0,2).join('.') : ''), bg: cs.backgroundColor, bgImg: (cs.backgroundImage || 'none').slice(0, 40) });
    n = n.parentElement;
  }
  // also the iframe-internal hit
  let best = null, area = 0;
  for(const f of document.querySelectorAll('#viewer iframe')){
    const r = f.getBoundingClientRect();
    if(r.width * r.height > area){ area = r.width * r.height; best = f; }
  }
  const d = best.contentDocument;
  const inner = d.elementFromPoint(x - Math.round(best.getBoundingClientRect().left), y - Math.round(best.getBoundingClientRect().top));
  const innerChain = [];
  let m = inner;
  while(m && m !== d.documentElement){
    const cs = d.defaultView.getComputedStyle(m);
    innerChain.push({ tag: m.tagName, bg: cs.backgroundColor });
    m = m.parentElement;
  }
  return { x, y, outerChain: chain, iframeL: Math.round(best.getBoundingClientRect().left), innerChain };
})));
console.log('SETTLED:', JSON.stringify(await page.evaluate(() => {
  const loc = state.rendition.currentLocation();
  return { idx: loc.start.index, disp: loc.start.displayed };
})));
await page.screenshot({ path: 'tests/manual/dcc-deskleft.png' });

await page.evaluate(() => { try { closeBook(); } catch(e) {} }).catch(() => {});
proc.kill();
console.log('done');
