// Screenshot probe: open the demo book and capture the desk with the new
// side vines, both closed-book (shelf) and reading states. Artifacts land in
// tests/e2e/artifacts/probe-vine/.
// Usage: node tests/manual/probes/probe_vine_pair.mjs
import { chromium } from 'playwright';
import { fresh, openDemoReady } from '../../e2e/helpers.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

mkdirSync('tests/e2e/artifacts/probe-vine', { recursive: true });

// Standalone probe: no playwright.config webServer — serve src/ ourselves
// on the same port the suite uses.
const server = spawn(process.execPath, ['./node_modules/http-server/bin/http-server', 'src', '-p', '8124', '--silent'], { stdio: 'ignore' });
await new Promise((res) => setTimeout(res, 1200));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, baseURL: 'http://127.0.0.1:8124' });
await fresh(page);
await openDemoReady(page);
await page.waitForTimeout(1500); // relocation settle + vine background swap

const info = await page.evaluate(() => {
  const l = document.querySelector('.folio-vine.left');
  const r = document.querySelector('.folio-vine.right');
  const ul = document.querySelector('.folio-vine.under.left');
  const ur = document.querySelector('.folio-vine.under.right');
  const cs = getComputedStyle(l);
  return {
    leftBg: (l.style.backgroundImage || '').slice(0, 60),
    rightBg: (r.style.backgroundImage || '').slice(0, 60),
    underLeftBg: (ul && ul.style.backgroundImage || '').slice(0, 60),
    underRightBg: (ur && ur.style.backgroundImage || '').slice(0, 60),
    display: cs.display,
    aspect: cs.aspectRatio,
    lRect: l.getBoundingClientRect().toJSON(),
    rRect: r.getBoundingClientRect().toJSON(),
    ulRect: ul && ul.getBoundingClientRect().toJSON(),
    vinesInPageArt: Object.keys(window.PAGE_ART).filter(k => k.startsWith('vine-') || k.startsWith('gilt-')),
  };
});
console.log(JSON.stringify(info, null, 2));

// Full desk shot plus tight crops of each vine element.
await page.screenshot({ path: 'tests/e2e/artifacts/probe-vine/desk.png', fullPage: false });
// At narrow desk margins the outer vine yields (body.vine-tight) — shoot
// whatever is actually visible.
for(const [sel, name] of [['.folio-vine.left:not(.under)', 'vine-left'], ['.folio-vine.right:not(.under)', 'vine-right'],
  ['.folio-vine.under.left', 'gilt-left'], ['.folio-vine.under.right', 'gilt-right']]){
  const el = page.locator(sel);
  if(await el.isVisible()) await el.screenshot({ path: `tests/e2e/artifacts/probe-vine/${name}.png` });
  else console.log('hidden, skipped: ' + name);
}
// The right element is CSS-flipped; also capture it visually un-flipped via
// a canvas draw of the stored data URI, to confirm the baked mirror pairs
// with the left art (right-as-displayed should mirror left-as-authored).
const pairCheck = await page.evaluate(async () => {
  const imgL = new Image(); imgL.src = window.PAGE_ART['vine-01-l'];
  const imgR = new Image(); imgR.src = window.PAGE_ART['vine-01-r'];
  await Promise.all([imgL.decode(), imgR.decode()]);
  const c = document.createElement('canvas');
  c.width = imgL.naturalWidth + imgR.naturalWidth + 20;
  c.height = Math.max(imgL.naturalHeight, imgR.naturalHeight);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f3ead8';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(imgL, 0, 0);
  ctx.save();
  ctx.translate(c.width, 0); ctx.scale(-1, 1); // emulate .folio-vine.right CSS
  ctx.drawImage(imgR, c.width - imgR.naturalWidth, 0);
  ctx.restore();
  return c.toDataURL('image/png');
});
await page.evaluate(async (dataUrl) => {
  window.__pairShot = dataUrl;
}, pairCheck);
const pairData = await page.evaluate(() => window.__pairShot);
writeFileSync('tests/e2e/artifacts/probe-vine/pair-as-displayed.png', Buffer.from(pairData.split(',')[1], 'base64'));

await browser.close();
server.kill();
console.log('shots written to tests/e2e/artifacts/probe-vine/');
