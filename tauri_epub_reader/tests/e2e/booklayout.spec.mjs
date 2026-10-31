// Book layout & physical dressing (BL-*): spread proportions and margins,
// the paper-edge sheen layers, the spine-valley sheen, and the drawer
// desk-shift (stage yields toward the free side without EPUB reflow).
import { test, expect } from '@playwright/test';
import { fresh, openDemoReady } from './helpers.mjs';

test.beforeEach(async ({ page }) => { await fresh(page); });

const spreadMetrics = (page) => page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  const mw = parseFloat(cs.getPropertyValue('--mw'));
  const gut = parseFloat(cs.getPropertyValue('--gut'));
  const r = document.getElementById('wrap').getBoundingClientRect();
  return {
    mw, gut,
    width: r.width,
    left: r.left,
    right: innerWidth - r.right,
    spread: document.body.classList.contains('spread'),
    overflow: document.documentElement.scrollWidth > innerWidth,
  };
});

test('BL1 large desktop: pages cap near 950px, spread centred with >=24px margins', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openDemoReady(page);
  const m = await spreadMetrics(page);
  expect(m.spread).toBe(true);
  expect(m.width).toBeCloseTo(m.mw, 0);
  // each page stays within the ~960px ceiling (950 cap + slack)
  expect((m.mw - m.gut) / 2).toBeLessThanOrEqual(960);
  // outer margins balanced and never below the 24px floor
  expect(m.left).toBeGreaterThanOrEqual(24);
  expect(m.right).toBeGreaterThanOrEqual(24);
  expect(Math.abs(m.left - m.right)).toBeLessThanOrEqual(1.5);
  expect(m.overflow).toBe(false);
});

test('BL2 cramped window: auto fallback to a centred single page, no overflow', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 720 });
  await openDemoReady(page);
  const m = await spreadMetrics(page);
  // below ~15px auto size a spread stops being readable -> single page
  expect(m.spread).toBe(false);
  expect(m.overflow).toBe(false);
  expect(Math.abs(m.left - m.right)).toBeLessThanOrEqual(1.5);
  expect(m.left).toBeGreaterThanOrEqual(24);
});

test('BL3 paper dressing layers: outer-edge sheen on #wrap, spine sheen in #gutter', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openDemoReady(page);
  const after = await page.evaluate(() => {
    const s = getComputedStyle(document.getElementById('wrap'), '::after');
    return { bg: s.backgroundImage, pe: s.pointerEvents, z: s.zIndex };
  });
  expect((after.bg.match(/linear-gradient/g) || []).length).toBeGreaterThanOrEqual(2);
  expect(after.pe).toBe('none');
  expect(after.z).toBe('6');
  const gutter = await page.evaluate(() => {
    const s = getComputedStyle(document.getElementById('gutter'));
    return { bg: s.backgroundImage, pe: s.pointerEvents };
  });
  // valley shadow + sheen tails = two gradient layers
  expect((gutter.bg.match(/linear-gradient/g) || []).length).toBeGreaterThanOrEqual(2);
  expect(gutter.pe).toBe('none');
});

test('BL4 drawer desk-shift: stage slides clear of the TOC and returns on close', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openDemoReady(page);
  const before = (await spreadMetrics(page)).left;
  await page.keyboard.press('t');
  await page.waitForFunction(() => document.body.classList.contains('toc-open'), null, { timeout: 5000 });
  await page.waitForFunction(() => document.getElementById('stage').classList.contains('desk-shift'), null, { timeout: 5000 });
  // the shift eases in over .4s — wait for the wrap to actually move
  await page.waitForFunction(
    (b) => document.getElementById('wrap').getBoundingClientRect().left > b + 5,
    before, { timeout: 3000 });
  const during = (await spreadMetrics(page)).left;
  // stage eases right, away from the left drawer, but never off-viewport
  expect(during).toBeGreaterThan(before);
  expect((await spreadMetrics(page)).right).toBeGreaterThanOrEqual(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('stage').classList.contains('desk-shift'), null, { timeout: 5000 });
  // ease back out, then the book re-centres exactly
  await page.waitForFunction(
    (b) => Math.abs(document.getElementById('wrap').getBoundingClientRect().left - b) < 1.5,
    before, { timeout: 3000 });
  expect((await spreadMetrics(page)).left).toBeCloseTo(before, 0);
});

test('BL5 desk-shift is transform-only: --mw unchanged while a drawer is open', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openDemoReady(page);
  const mwBefore = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--mw').trim());
  await page.keyboard.press('t');
  await page.waitForFunction(() => document.getElementById('stage').classList.contains('desk-shift'), null, { timeout: 5000 });
  const mwDuring = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--mw').trim());
  expect(mwDuring).toBe(mwBefore);
});
