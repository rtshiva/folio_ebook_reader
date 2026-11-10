// D8 replica with turn-call logging to find the relocation cascade.
import { chromium } from 'playwright';
import { openDemoReady, badge, badgeWait, slowDrag, fastFling, synUp, curCfi } from './helpers.mjs';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
await page.goto('http://127.0.0.1:8124/');
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.locator('#btnDemo').waitFor({ timeout: 9000 });
await openDemoReady(page);
await page.evaluate(() => { settings.turnFx = 'paper'; save(); });

for (let i = 0; i < 2; i++) {
  const b = await badge(page);
  await page.keyboard.press('ArrowRight');
  await badgeWait(page, b);
}
await page.waitForFunction(() => !state.turning && !state.recreating, null, { timeout: 9000 });
await page.waitForTimeout(300);

await page.evaluate(() => {
  window.__turnLog = [];
  const r = state.rendition;
  const no = r.next.bind(r), po = r.prev.bind(r);
  r.next = (...a) => { window.__turnLog.push(['next', Date.now() % 100000]); return no(...a); };
  r.prev = (...a) => { window.__turnLog.push(['prev', Date.now() % 100000]); return po(...a); };
  r.on('relocated', l => window.__turnLog.push(['reloc', Date.now() % 100000, l && l.start ? l.start.index + ':' + l.start.displayed.page : '?']));
  const origAnim = PageTurnPhysics.animate.bind(PageTurnPhysics);
  PageTurnPhysics.animate = (opts) => {
    window.__turnLog.push(['anim', Date.now() % 100000, 'from=' + opts.fromP.toFixed(2), 'to=' + opts.toP, 'v0=' + (opts.initialVelocity || 0).toFixed(2)]);
    return origAnim(opts);
  };
  // instrument controller entry
  const g = turnGesture;
  const origUp = g.onPointerUp.bind(g);
  let n = 0;
  g.onPointerUp = (e) => {
    const id = ++n;
    window.__turnLog.push(['up-enter', id, Date.now() % 100000, 'pid=' + e.pointerId, 'active=' + g.active, 'startT=' + (g.startTime ? 1 : 0), 'p=' + g.currentP.toFixed(2), g.compositor ? 'comp' : 'nocomp']);
    return origUp(e);
  };
  const origDown = g.onPointerDown.bind(g);
  g.onPointerDown = (e) => { window.__turnLog.push(['down', Date.now() % 100000]); return origDown(e); };
});

const info = await slowDrag(page, -1, 0.3);
console.log('drag held, loc:', await page.evaluate(() => { const l = state.rendition.currentLocation(); return l.start.index + ':' + l.start.displayed.page; }));
await synUp(page);
await page.waitForFunction(() => !document.querySelector('.pt-compositor'), null, { timeout: 9000 });
console.log('after cancel, log:', await page.evaluate(() => window.__turnLog.splice(0)));
console.log('after cancel, loc:', await page.evaluate(() => { const l = state.rendition.currentLocation(); return l.start.index + ':' + l.start.displayed.page; }));

await fastFling(page, 1, 0.12);
const before = await curCfi(page);
await synUp(page);
await page.waitForTimeout(2500);
console.log('fling log:', await page.evaluate(() => window.__turnLog.splice(0)));
console.log('final loc:', await page.evaluate(() => { const l = state.rendition.currentLocation(); return l.start.index + ':' + l.start.displayed.page; }));
console.log('before cfi:', before);

await browser.close();
