// Inside-page margins (PM-*): per-page top/bottom/side empty space. Top and
// bottom are pure iframe CSS; sides ride the epub.js gap (per-page inset =
// gap/2, spine gutter = whole gap) through the throttled resize path.
import { test, expect } from '@playwright/test';
import { fresh, openDemoReady, badge, badgeWait } from './helpers.mjs';

test.beforeEach(async ({ page }) => { await fresh(page); });

async function openAdvanced(page) {
  await openDemoReady(page);
  await page.keyboard.press('s');
  await page.waitForFunction(() => document.body.classList.contains('sheet-open'), null, { timeout: 5000 });
  await page.evaluate(() => { document.querySelector('details.adv').open = true; });
}

async function framePaddings(page) {
  // the gap-swap re-flow clears and rebuilds the views — wait for a live,
  // populated chapter frame before reading
  await page.waitForFunction(() => {
    const d = document.querySelector('#viewer iframe')?.contentDocument;
    return !!(d && d.body && (d.body.textContent || '').length > 40);
  }, null, { timeout: 9000 });
  return page.evaluate(() => {
    const d = document.querySelector('#viewer iframe').contentDocument;
    const cs = d.defaultView.getComputedStyle(d.body);
    return {
      top: parseFloat(cs.paddingTop), bottom: parseFloat(cs.paddingBottom),
      left: parseFloat(cs.paddingLeft), right: parseFloat(cs.paddingRight),
    };
  });
}

test('PM1 defaults: 20px top/bottom, sides at half the desk gutter', async ({ page }) => {
  await openDemoReady(page);
  const p = await framePaddings(page);
  expect(p.top).toBe(20);
  expect(p.bottom).toBe(20);
  const gap = await page.evaluate(() => state.rendition.manager.settings.gap);
  expect(p.left).toBe(gap / 2);
  expect(p.right).toBe(gap / 2);
  const gut = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gut')));
  expect(gut).toBe(gap);
});

test('PM2 sides slider drives the epub gap, spine gutter and per-page inset', async ({ page }) => {
  await openAdvanced(page);
  await page.evaluate(() => {
    const s = document.getElementById('pmSidesRange');
    s.value = 48; s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => state.rendition.manager.settings.gap === 96, null, { timeout: 9000 });
  const p = await framePaddings(page);
  expect(p.left).toBe(48);
  expect(p.right).toBe(48);
  const gut = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gut')));
  expect(gut).toBe(96);
  // auto chip off, output shows the raw value
  expect(await page.evaluate(() => document.getElementById('pmSidesAuto').classList.contains('on'))).toBe(false);
  expect(await page.evaluate(() => document.getElementById('pmSidesOut').textContent)).toBe('48px');
  // pagination stays healthy under the custom gap
  const prev = await badge(page);
  await page.evaluate(() => { document.getElementById('sheetClose').click(); });
  await page.evaluate(() => turn(1));
  await page.waitForFunction(() => !document.body.classList.contains('turning'), null, { timeout: 9000 });
  await badgeWait(page, prev);
});

test('PM3 top/bottom sliders apply as page padding and persist', async ({ page }) => {
  await openAdvanced(page);
  await page.evaluate(() => {
    const t = document.getElementById('pmTopRange');
    t.value = 64; t.dispatchEvent(new Event('input', { bubbles: true }));
    const b = document.getElementById('pmBottomRange');
    b.value = 90; b.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    try { return JSON.parse(localStorage.getItem('folio-settings') || '{}').pageMarginTop === 64; }
    catch (e) { return false; }
  }, null, { timeout: 5000 });
  expect((await framePaddings(page)).top).toBe(64);
  expect((await framePaddings(page)).bottom).toBe(90);
  await page.reload();
  await openDemoReady(page);
  expect((await framePaddings(page)).top).toBe(64);
  expect((await framePaddings(page)).bottom).toBe(90);
});

test('PM4 sides margins survive a reload and a single-page switch', async ({ page }) => {
  await openAdvanced(page);
  await page.evaluate(() => {
    const s = document.getElementById('pmSidesRange');
    s.value = 40; s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => state.rendition.manager.settings.gap === 80, null, { timeout: 9000 });
  await page.reload();
  await openDemoReady(page);
  expect(await framePaddings(page)).toMatchObject({ left: 40, right: 40 });
  // single-page mode keeps the same inset mechanism
  await page.evaluate(async () => { settings.spread = 'off'; save(); await applySpread(); });
  await page.waitForTimeout(900);
  expect(await framePaddings(page)).toMatchObject({ left: 40, right: 40 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('PM5 margins are per-book typography channels', async ({ page }) => {
  await openAdvanced(page);
  await page.evaluate(() => { document.getElementById('swPerBook').click(); });
  await page.evaluate(() => {
    const t = document.getElementById('pmTopRange');
    t.value = 70; t.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    try {
      const o = JSON.parse(localStorage.getItem('folio-typo:The Time Machine') || '{}');
      return o.pageMarginTop === 70;
    } catch (e) { return false; }
  }, null, { timeout: 5000 });
});
