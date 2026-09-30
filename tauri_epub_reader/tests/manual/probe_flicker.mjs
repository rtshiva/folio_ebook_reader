// Flicker probe: capture every rendered frame during a paper-flip turn via
// CDP screencast, then diff the page area between consecutive frames to find
// exactly which frame flashes. Frames land in tests/e2e/artifacts/flicker/.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { openDemo } from '../e2e/helpers.mjs';

const OUT = 'tests/e2e/artifacts/flicker';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
await page.goto('http://127.0.0.1:8124/');
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.locator('#btnDemo').waitFor({ timeout: 9000 });
await page.evaluate(() => { try { settings.themeAuto = false; save(); } catch (e) {} });
await openDemo(page);
await page.waitForFunction(() => typeof LocEngine !== 'undefined' && LocEngine.ready(), null, { timeout: 12000 });
await page.evaluate(() => { settings.turnFx = 'paper'; save(); });
await page.waitForTimeout(1200); // settle fonts/layout

const viewer = await page.evaluate(() => {
  const r = document.getElementById('viewer').getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
});
console.log('viewer rect:', JSON.stringify(viewer));

const cdp = await page.context().newCDPSession(page);
const frames = [];
cdp.on('Page.screencastFrame', async (ev) => {
  frames.push({ data: ev.data, ts: ev.metadata.timestamp });
  try { await cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }); } catch (e) {}
});

await cdp.send('Page.startScreencast', { format: 'png', everyFrame: true });
await page.waitForTimeout(400); // baseline frames (pre-flip)
const t0 = Date.now();
await page.evaluate(() => turn(1));
while (Date.now() - t0 < 2500) await page.waitForTimeout(100);
await cdp.send('Page.stopScreencast');
console.log('captured', frames.length, 'frames');

for (let i = 0; i < frames.length; i++) {
  writeFileSync(`${OUT}/f${String(i).padStart(3, '0')}.png`, Buffer.from(frames[i].data, 'base64'));
}

// Diff consecutive frames inside the page area, one frame per evaluate call.
await page.evaluate((viewer) => {
  const cv = document.createElement('canvas');
  cv.width = viewer.w; cv.height = viewer.h;
  window.__cx = cv.getContext('2d', { willReadFrequently: true });
  window.__viewer = viewer;
  window.__prev = null;
  window.__rows = [];
}, viewer);
const load = (page, url) => page.evaluate((url) => new Promise((res) => {
  const im = new Image();
  im.onload = () => {
    const { w, h, x, y } = window.__viewer;
    const cx = window.__cx;
    cx.clearRect(0, 0, w, h);
    cx.drawImage(im, -x, -y);
    const cur = cx.getImageData(0, 0, w, h).data;
    const prev = window.__prev;
    if (prev) {
      let sum = 0, big = 0;
      for (let p = 0; p < cur.length; p += 16) {
        const d = Math.abs(cur[p] - prev[p]) + Math.abs(cur[p + 1] - prev[p + 1]) + Math.abs(cur[p + 2] - prev[p + 2]);
        sum += d; if (d > 90) big++;
      }
      const samples = cur.length / 16;
      window.__rows.push({ i: window.__rows.length, diff: +(sum / samples).toFixed(2), chgPct: +(100 * big / samples).toFixed(1) });
    } else {
      window.__rows.push({ i: window.__rows.length, diff: 0, chgPct: 0 });
    }
    window.__prev = cur;
    res(true);
  };
  im.onerror = () => { window.__rows.push({ i: window.__rows.length, miss: true }); window.__prev = null; res(false); };
  im.src = url;
}), url);
for (let i = 0; i < frames.length; i++) {
  await load(page, 'data:image/png;base64,' + frames[i].data);
}
const report = await page.evaluate(() => window.__rows);
await browser.close();

for (const r of report) if (!r.miss) console.log(JSON.stringify(r));
console.log('frames saved to', OUT);
console.log('done');
