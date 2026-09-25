import { test, expect } from '@playwright/test';
import { fresh, openDemoReady, badge, badgeWait } from './helpers.mjs';

test.beforeEach(async ({ page }) => { await fresh(page); });

async function hitTopLeft(page) {
  return page.evaluate(() => {
    const t = document.elementFromPoint(27, 38);
    if (!t || !t.closest) return 'none';
    if (t.closest('#tocClose,#searchClose,#sheetClose,#helpClose')) return 'closebtn';
    if ((t.tagName === 'svg' || t.tagName === 'path') && t.closest('#toc,#searchDrawer,#sheet,#helpOverlay')) return 'drawersvg';
    return 'ok:' + t.tagName;
  });
}

test('D1 posPill shows live chapter + pct, opens contents, truncates', async ({ page }) => {
  await openDemoReady(page);
  const b0 = await badge(page);
  await page.keyboard.press('ArrowRight');
  await badgeWait(page, b0);
  await page.keyboard.press('ArrowRight');
  await badgeWait(page, await badge(page));
  const pill = await page.evaluate(() => ({
    ch: document.getElementById('posPillCh').textContent,
    pct: document.getElementById('posPillPct').textContent,
    chapter: document.getElementById('chapter').textContent,
    pctMain: document.getElementById('pct').textContent,
  }));
  expect(pill.ch).toBe(pill.chapter);
  expect(pill.pct).toBe(pill.pctMain);
  await page.mouse.move(680, 4);
  await page.waitForFunction(() => !document.body.classList.contains('chrome-hidden'), null, { timeout: 5000 });
  await page.click('#posPill');
  await page.waitForFunction(() => document.body.classList.contains('toc-open'), null, { timeout: 5000 });
  await page.evaluate(() => document.body.classList.remove('toc-open'));
  await page.evaluate(() => { document.getElementById('posPillCh').textContent = 'x'.repeat(400); });
  const geom = await page.evaluate(() => {
    const c = document.getElementById('posPillCh');
    const titleEl = document.getElementById('bookTitle');
    const t = titleEl.getBoundingClientRect();
    return {
      truncated: c.scrollWidth > c.clientWidth,
      capped: c.clientWidth <= 461,
      titleIntact: titleEl.scrollWidth <= titleEl.clientWidth,
      titleRight: t.right, vw: innerWidth,
    };
  });
  expect(geom.truncated).toBe(true);
  expect(geom.capped).toBe(true);
  expect(geom.titleIntact).toBe(true);
  expect(geom.titleRight).toBeLessThanOrEqual(geom.vw);
});

test('D2 drawers never leak hit-testable chrome when closed', async ({ page }) => {
  await openDemoReady(page);
  expect(await hitTopLeft(page)).not.toMatch(/^(closebtn|drawersvg)$/);
  const cases = [
    ['toc', 'toggleToc'],
    ['search', 'openSearch'],
    ['sheet', 'toggleSheet'],
    ['help', 'toggleHelp'],
  ];
  for (const [name, fn] of cases) {
    await page.evaluate((f) => window[f](), fn);
    await page.waitForTimeout(500);
    await page.evaluate(() => closePanels());
    await page.waitForTimeout(700);
    expect(await hitTopLeft(page), `after ${name}`).not.toMatch(/^(closebtn|drawersvg)$/);
  }
});
