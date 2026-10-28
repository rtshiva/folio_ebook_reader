// Captures the living-page-block dressing (edge stacks, boards, finis,
// contact shadow, stand blocks) across themes, page modes and positions.
// Usage: node tests/manual/capture_edge_dress.mjs   (expects src served on 8124)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = 'tests/e2e/artifacts/edge-dress';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });

async function openWithTheme(theme) {
  await page.goto('http://127.0.0.1:8124/');
  await page.evaluate(() => localStorage.clear());
  await page.evaluate((t) => {
    localStorage.setItem('folio-settings', JSON.stringify({ theme: t, themeAuto: false }));
  }, theme);
  await page.reload();
  await page.locator('#btnDemo').waitFor({ timeout: 9000 });
  await page.click('#btnDemo');
  await page.waitForFunction(() => typeof LocEngine !== 'undefined' && LocEngine.ready(), null, { timeout: 20000 });
  await page.waitForTimeout(900);
}

async function jumpLast() {
  await page.evaluate(() => state.rendition.display(state.book.spine.length - 1));
  await page.waitForFunction(() => !document.body.classList.contains('at-start'), null, { timeout: 9000 });
  await page.waitForTimeout(700);
}

const shots = [];
const snap = async (name) => {
  const f = `${OUT}/${name}.png`;
  await page.screenshot({ path: f });
  shots.push(f);
};

// 1. paper: start / mid / end-of-book look / single page / drop caps
await openWithTheme('paper');
await snap('paper-start');
await page.evaluate(() => state.rendition.display(2));
await page.waitForFunction(() => !document.body.classList.contains('at-start'), null, { timeout: 9000 });
await page.waitForTimeout(700);
await snap('paper-mid');
await jumpLast();
await page.evaluate(() => EdgeStacks.set(1, { page: 2, total: 2 }));
await page.waitForFunction(() => parseFloat(getComputedStyle(document.getElementById('finis')).opacity) > 0.4, null, { timeout: 4000 });
await snap('paper-end-finis');
await page.evaluate(() => EdgeStacks.set(0.5, { page: 50, total: 100 }));
await page.evaluate(() => el('btnSpread').click());
await page.waitForTimeout(1400);
await snap('paper-single-mid');
await page.evaluate(() => { settings.dropCaps = true; save(); relayout(); });
await page.waitForTimeout(1200);
await snap('paper-dropcaps');

// 2. theme variants
await openWithTheme('noir');
await snap('noir-start');
await openWithTheme('ember');
await jumpLast();
await snap('ember-late');
await openWithTheme('velvet');
await snap('velvet-start');
await openWithTheme('aizome');
await page.evaluate(() => state.rendition.display(2));
await page.waitForTimeout(900);
await snap('aizome-mid');

console.log(shots.join('\n'));
await browser.close();
