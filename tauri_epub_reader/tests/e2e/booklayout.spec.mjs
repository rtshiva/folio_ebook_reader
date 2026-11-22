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
    before, { timeout: 9000 });
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
    before, { timeout: 9000 });
  // assert within the same tolerance the settle-wait uses — the ease tail
  // can still be moving sub-pixel frames when the wait releases (racy at 0.5)
  expect(Math.abs((await spreadMetrics(page)).left - before)).toBeLessThanOrEqual(1.5);
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

test('BL9 opening leaf shift: first section renders [blank | first page] in spread mode', async ({ page }) => {
  await openDemoReady(page);
  await page.waitForTimeout(1100); // cold pass + park settle
  const r = await page.evaluate(() => {
    const v = document.getElementById('viewer').getBoundingClientRect();
    let best = null, area = 0;
    for(const f of document.querySelectorAll('#viewer iframe')){
      const rr = f.getBoundingClientRect();
      if(rr.width * rr.height > area){ area = rr.width * rr.height; best = f; }
    }
    const d = best.contentDocument;
    const first = d.body.querySelector('p, h1, h2, div, img, section');
    const fr = first ? first.getBoundingClientRect() : null;
    return {
      vw: Math.round(v.width),
      cls: d.documentElement.classList.contains('folio-first-leaf'),
      tx: getComputedStyle(d.body).transform,
      firstLeft: fr ? Math.round(fr.left) : null,
      cacheHasCls: (pageCache.getChapterHtml(0) || '').includes('folio-first-leaf'),
      viewerCls: document.getElementById('viewer').classList.contains('folio-first-leaf'),
      viewerBg: getComputedStyle(document.getElementById('viewer')).backgroundColor,
      htmlBgImg: getComputedStyle(d.documentElement).backgroundImage,
    };
  });
  expect(r.cls, 'opening doc carries the shift class').toBe(true);
  const slot = Math.round(r.vw / 2);
  expect(r.tx, `body translated exactly one page slot (${slot}px)`)
    .toBe(`matrix(1, 0, 0, 1, ${slot}, 0)`);
  expect(r.firstLeft, 'first page content sits on the right-hand slot')
    .toBeGreaterThan(r.vw / 2);
  expect(r.cacheHasCls, 'compositor cache replays carry the same geometry').toBe(true);
  expect(r.viewerCls, 'viewer yields its paper for the desk-left look').toBe(true);
  expect(r.viewerBg, 'viewer background transparent over the desk').toBe('rgba(0, 0, 0, 0)');
  expect(r.htmlBgImg, 'html carries a background-image (blocks canvas propagation of body paper)')
    .not.toBe('none');
});

test('BL10 opening leaf shift: single-page mode renders unshifted', async ({ page }) => {
  await openDemoReady(page);
  await page.waitForTimeout(1100);
  await page.keyboard.press('d'); // auto -> on (still spread)
  await page.keyboard.press('d'); // on -> off (single page)
  await page.waitForFunction(() => !document.body.classList.contains('spread'), null, { timeout: 9000 });
  await page.waitForTimeout(900); // recreate + relocation
  const r = await page.evaluate(() => {
    let best = null, area = 0;
    for(const f of document.querySelectorAll('#viewer iframe')){
      const rr = f.getBoundingClientRect();
      if(rr.width * rr.height > area){ area = rr.width * rr.height; best = f; }
    }
    const d = best.contentDocument;
    return {
      cls: d.documentElement.classList.contains('folio-first-leaf'),
      tx: getComputedStyle(d.body).transform,
    };
  });
  expect(r.cls, 'no shift class in single-page mode').toBe(false);
  expect(r.tx, 'body not translated in single-page mode').toBe('none');
});
