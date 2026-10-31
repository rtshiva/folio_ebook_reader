// Reading Room suite (RR-*): the desk-theme axis. The room (surroundings,
// damask, gilt frame, ornaments) is independent of the paper environment;
// env cards reset the room to "match"; Royal Maroon is the fresh-install
// default. Stage 1 covers the architecture + the Royal Maroon reference.
import { test, expect } from '@playwright/test';
import { fresh, openDemoReady, viewerFrame } from './helpers.mjs';

test.beforeEach(async ({ page }) => { await fresh(page); });

const deskVar = (page) => page.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--desk').trim().toLowerCase());
const pageVar = (page) => page.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--page').trim().toLowerCase());
const rrAttr = (page) => page.evaluate(() => document.documentElement.dataset.rr || '');

async function openRR(page) {
  await openDemoReady(page);
  await page.click('#btnSheet');
  await page.waitForFunction(() => document.body.classList.contains('sheet-open'), null, { timeout: 9000 });
}

test('RR1 fresh install wakes in Royal Maroon and persists the choice', async ({ page }) => {
  expect(await rrAttr(page)).toBe('royal-maroon');
  expect(await deskVar(page)).toBe('#431120');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement)
    .getPropertyValue('--rr-gold').trim())).toBe('#c9a45c');
  // the room owns the gilt on fresh installs (paper env alone would not)
  expect(await page.evaluate(() => document.body.classList.contains('gilt-fore'))).toBe(true);
  // save() debounces 150ms
  await page.waitForFunction(() => {
    try { return JSON.parse(localStorage.getItem('folio-settings') || '{}').rrTheme === 'royal-maroon'; }
    catch (e) { return false; }
  }, null, { timeout: 9000 });
});

test('RR2 room and paper are independent: velvet page under the maroon desk', async ({ page }) => {
  await openRR(page);
  // env first (whole-room choice resets the room), then pick the room back
  await page.click('#envVelvet');
  await page.waitForFunction(() => document.documentElement.dataset.rr === undefined ||
    document.documentElement.dataset.rr === '', null, { timeout: 9000 });
  await page.click('#rrMaroon');
  await page.waitForFunction(() => document.documentElement.dataset.rr === 'royal-maroon', null, { timeout: 9000 });
  // page/ink axis stayed velvet; desk axis is the room
  expect(await pageVar(page)).toBe('#f5eedc');
  expect(await deskVar(page)).toBe('#431120');
});

test('RR3 an environment card resets the room to match', async ({ page }) => {
  await openRR(page);
  await page.click('#rrMaroon');
  await page.waitForFunction(() => document.documentElement.dataset.rr === 'royal-maroon', null, { timeout: 9000 });
  await page.click('#envPaper');
  await page.waitForFunction(() => {
    const a = document.documentElement.dataset.rr || '';
    return a === '' && document.getElementById('rrMatch').classList.contains('sel');
  }, null, { timeout: 9000 });
  expect(await deskVar(page)).toBe('#e8dfca');
  await page.waitForFunction(() => {
    try { return JSON.parse(localStorage.getItem('folio-settings') || '{}').rrTheme === 'match'; }
    catch (e) { return false; }
  }, null, { timeout: 9000 });
});

test('RR4 room swaps live without touching the book layout or iframe', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openRR(page);
  const before = await page.evaluate(() => ({
    mw: getComputedStyle(document.documentElement).getPropertyValue('--mw').trim(),
    desk: getComputedStyle(document.documentElement).getPropertyValue('--desk').trim(),
  }));
  const frame = await viewerFrame(page);
  const frameBg = await frame.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.click('#rrMatch');
  await page.waitForFunction(() => !(document.documentElement.dataset.rr), null, { timeout: 9000 });
  const after = await page.evaluate(() => ({
    mw: getComputedStyle(document.documentElement).getPropertyValue('--mw').trim(),
    desk: getComputedStyle(document.documentElement).getPropertyValue('--desk').trim(),
  }));
  expect(after.desk).not.toBe(before.desk);       // the room changed…
  expect(after.mw).toBe(before.mw);               // …without re-layout
  const frame2 = await viewerFrame(page);
  expect(await frame2.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(frameBg);
});

test('RR5 ornament and frame toggles drive the dressing layers', async ({ page }) => {
  await openRR(page);
  await page.click('#rrMaroon');
  await page.waitForFunction(() => document.documentElement.dataset.rr === 'royal-maroon', null, { timeout: 9000 });
  const disp = (sel) => page.evaluate((s) =>
    getComputedStyle(document.querySelector(s)).display, sel);
  expect(await disp('#rrFrame')).toBe('block');
  expect(await disp('#rrRoom')).toBe('block');
  await page.evaluate(() => { document.getElementById('swRrFrame').click(); });
  await page.waitForFunction(() =>
    getComputedStyle(document.getElementById('rrFrame')).display === 'none', null, { timeout: 9000 });
  expect(await disp('#rrRoom')).toBe('block'); // ornaments independent of frame
  await page.evaluate(() => { document.getElementById('swRrOrn').click(); });
  await page.waitForFunction(() =>
    getComputedStyle(document.getElementById('rrRoom')).display === 'none', null, { timeout: 9000 });
  await page.waitForFunction(() => {
    try {
      const s = JSON.parse(localStorage.getItem('folio-settings') || '{}');
      return s.rrFrame === false && s.rrOrnaments === false;
    } catch (e) { return false; }
  }, null, { timeout: 9000 });
});

test('RR6 gilt frame tracks the spread; medallion yields to a narrow desk', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openRR(page);
  const rects = await page.evaluate(() => {
    const w = document.getElementById('wrap').getBoundingClientRect();
    const f = document.getElementById('rrFrame').getBoundingClientRect();
    return { w: { l: w.left, t: w.top, r: w.right, b: w.bottom }, f: { l: f.left, t: f.top, r: f.right, b: f.bottom } };
  });
  expect(rects.f.l).toBeCloseTo(rects.w.l - 8, 0);
  expect(rects.f.t).toBeCloseTo(rects.w.t - 8, 0);
  expect(rects.f.r).toBeCloseTo(rects.w.r + 8, 0);
  expect(rects.f.b).toBeCloseTo(rects.w.b + 8, 0);
  expect(await page.evaluate(() => document.body.classList.contains('rr-no-med'))).toBe(false);
  // narrow desk: the medallion steps aside
  await page.setViewportSize({ width: 1240, height: 720 });
  await page.waitForFunction(() => document.body.classList.contains('rr-no-med'), null, { timeout: 9000 });
  // and below 1100px the whole dressing simplifies away (guide §7)
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.waitForFunction(() =>
    getComputedStyle(document.getElementById('rrFrame')).display === 'none', null, { timeout: 9000 });
});

test('RR7 dressing is pure chrome: no pointer capture, no overflow', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openRR(page);
  const pe = await page.evaluate(() =>
    ['#rrFrame', '.rr-corner.tl', '.rr-corner.br', '.rr-spine-orn.top', '.rr-medallion']
      .map((s) => getComputedStyle(document.querySelector(s)).pointerEvents));
  expect(pe.every((v) => v === 'none')).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('RR8 saved room paints before the app boots (FOUC path)', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('folio-settings', JSON.stringify({ theme: 'paper', themeAuto: false, rrTheme: 'royal-maroon' }));
  });
  await page.goto('/');
  // the FOUC script (in <head>) must have stamped data-rr before boot
  expect(await rrAttr(page)).toBe('royal-maroon');
  expect(await deskVar(page)).toBe('#431120');
});
