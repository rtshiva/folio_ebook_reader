// Living page block: fore-edge stacks track reading progress (left = pages
// read, right = remaining), cover boards take a side's place once its block
// empties (book start/end), finis marks the last page, and the flip lifts
// the receiving stack. EdgeStacks reads LocEngine pages when ready and falls
// back to the spine fraction, so assertions hold on either path.
import { test, expect } from '@playwright/test';
import { fresh, openDemoReady } from './helpers.mjs';

async function stackState(page) {
  return page.evaluate(() => {
    const g = (id) => document.getElementById(id);
    const info = (e) => e ? { w: e.style.width, v: e.style.visibility } : null;
    return {
      l: info(g('edgeStackL')),
      r: info(g('edgeStackR')),
      atStart: document.body.classList.contains('at-start'),
      atEnd: document.body.classList.contains('at-end'),
      boardL: getComputedStyle(document.querySelector('.board-edge.left')).opacity,
      boardR: getComputedStyle(document.querySelector('.board-edge.right')).opacity,
      finis: getComputedStyle(g('finis')).opacity,
    };
  });
}

test('ES1 book start: full right block, bare left, front board, no finis', async ({ page }) => {
  await fresh(page);
  await openDemoReady(page);
  const st = await stackState(page);
  expect(st.atStart).toBe(true);
  expect(st.l.w).toBe('0px');
  expect(st.l.v).toBe('hidden');
  expect(parseInt(st.r.w)).toBeGreaterThanOrEqual(10);
  expect(st.r.v).toBe('visible');
  expect(parseFloat(st.boardL)).toBeGreaterThan(0.5);
  expect(parseFloat(st.boardR)).toBe(0);
  expect(parseFloat(st.finis)).toBe(0);
});

test('ES2 stacks follow progress: late chapter thickens left, thins right', async ({ page }) => {
  await fresh(page);
  await openDemoReady(page);
  await page.evaluate(() => state.rendition.display(state.book.spine.length - 1));
  await page.waitForFunction(() => !document.body.classList.contains('at-start'), null, { timeout: 9000 });
  const st = await stackState(page);
  const lw = parseInt(st.l.w), rw = parseInt(st.r.w);
  expect(lw).toBeGreaterThanOrEqual(3);
  expect(lw).toBeGreaterThan(rw);
  expect(st.atEnd === false || lw > 10).toBe(true);
});

test('ES3 end of book: finis mark and back board arrive, then leave', async ({ page }) => {
  await fresh(page);
  await openDemoReady(page);
  // Drive the setter with a known last-page location: at-end keys off
  // gPage.page >= gPage.total - 1 when LocEngine pages exist.
  await page.evaluate(() => EdgeStacks.set(1, { page: 2, total: 2 }));
  await page.waitForFunction(() => document.body.classList.contains('at-end'), null, { timeout: 9000 });
  await page.waitForFunction(() => parseFloat(getComputedStyle(document.getElementById('finis')).opacity) > 0.4, null, { timeout: 4000 });
  const end = await stackState(page);
  expect(parseFloat(end.boardR)).toBeGreaterThan(0.5);
  expect(end.r.v).toBe('hidden');

  await page.evaluate(() => EdgeStacks.set(0.5, { page: 50, total: 100 }));
  await page.waitForFunction(() => !document.body.classList.contains('at-end'), null, { timeout: 9000 });
  await page.waitForFunction(() => parseFloat(getComputedStyle(document.getElementById('finis')).opacity) < 0.1, null, { timeout: 4000 });
});

test('ES4 flip micro-lift raises the receiving stack', async ({ page }) => {
  await fresh(page);
  await openDemoReady(page);
  await page.evaluate(() => document.body.classList.add('lift-l'));
  await page.waitForFunction(() => {
    const t = getComputedStyle(document.getElementById('edgeStackL')).transform;
    return t && t !== 'none';
  }, null, { timeout: 4000 });
  await page.evaluate(() => document.body.classList.remove('lift-l'));
  await page.waitForFunction(() => {
    const t = getComputedStyle(document.getElementById('edgeStackL')).transform;
    return t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)';
  }, null, { timeout: 4000 });
});
