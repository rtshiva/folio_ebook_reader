// Scroll mode (SC) — settings.scrollMode routes the wheel to instant noAnim
// steps (the AutoScroll primitive) instead of one fold per notch: continuous
// motion while input lasts, settled on a page when it stops, chapter
// boundaries crossed as one relocation each.
//   SC1  wheel streams pages in scroll mode, without touching NavHistory
//   SC2  continued wheel input crosses the chapter boundary by itself
//   SC3  toggle lives in the sheet, persists, and validateSettings rejects
//        non-boolean garbage back to the default
import { test, expect } from '@playwright/test';
import { fresh, openDemoReady, badge, badgeWait } from './helpers.mjs';

test('SC1 scroll mode streams instant wheel steps', async ({ page }) => {
  await fresh(page);
  await page.evaluate(() => { settings.scrollMode = true; save(); });
  await openDemoReady(page);
  const b0 = await badge(page);
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 160);
    await page.waitForTimeout(60);
  }
  await badgeWait(page, b0, 8000);
  await page.waitForFunction(() => !document.body.classList.contains('turning'), null, { timeout: 5000 });
  // wheel turns are navigation, not jumps — the jump-back stack stays empty
  expect(await page.evaluate(() => NavHistory.stack.length)).toBe(0);
});

test('SC2 continued wheel input crosses the chapter boundary', async ({ page }) => {
  await fresh(page);
  await page.evaluate(() => { settings.scrollMode = true; save(); });
  await openDemoReady(page);
  const idx0 = await page.evaluate(() => state.rendition.currentLocation().start.index);
  for (let i = 0; i < 40; i++) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(45);
    const idx = await page.evaluate(() => state.rendition.currentLocation().start.index);
    if (idx > idx0) return; // boundary crossed by wheel input alone
  }
  throw new Error('wheel input never crossed the chapter boundary');
});

test('SC3 toggle persists; validateSettings rejects non-boolean garbage', async ({ page }) => {
  await fresh(page);
  expect(await page.evaluate(() => settings.scrollMode)).toBe(false);
  await page.evaluate(() => { toggleSheet(); document.getElementById('swScroll').click(); });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => settings.scrollMode)).toBe(true);
  await page.reload();
  await page.locator('#btnDemo').waitFor({ timeout: 9000 });
  expect(await page.evaluate(() => settings.scrollMode)).toBe(true);

  // corrupted store: a non-boolean snaps back to the default on boot validate
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('folio-settings'));
    s.scrollMode = 'yes';
    localStorage.setItem('folio-settings', JSON.stringify(s));
  });
  await page.reload();
  await page.locator('#btnDemo').waitFor({ timeout: 9000 });
  expect(await page.evaluate(() => settings.scrollMode)).toBe(false);
});
