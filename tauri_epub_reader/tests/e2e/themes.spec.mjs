// Bespoke theme suite (TH-*): Aizome and Ember apply through the shared
// theme pipeline (env cards -> settings -> applyTheme + book iframes),
// persist across reloads, and yield back to the Vellum desk.
import { test, expect } from '@playwright/test';
import { fresh, openDemoReady, viewerFrame } from './helpers.mjs';

test.beforeEach(async ({ page }) => { await fresh(page); });

async function openSheet(page) {
  await openDemoReady(page);
  await page.click('#btnSheet');
  await page.waitForFunction(() => document.body.classList.contains('sheet-open'), null, { timeout: 5000 });
}

const deskVar = (page) => page.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--desk').trim().toLowerCase());
const themeAttr = (page) => page.evaluate(() => document.documentElement.dataset.theme || '');
const frameBg = (frame) => frame.evaluate(() => getComputedStyle(document.body).backgroundColor);

test('TH1 Aizome applies indigo desk, cream page, and vermilion accent', async ({ page }) => {
  await openSheet(page);
  await page.click('#envAizome');
  expect(await themeAttr(page)).toBe('aizome');
  expect(await deskVar(page)).toBe('#012d31');
  expect(await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase())).toBe('#c33d2b');
  // Picker selection + settings persistence (save() debounces 150ms).
  expect(await page.evaluate(() => document.getElementById('envAizome').classList.contains('sel'))).toBe(true);
  await page.waitForFunction(() => {
    try { return JSON.parse(localStorage.getItem('folio-settings') || '{}').theme === 'aizome'; }
    catch (e) { return false; }
  }, null, { timeout: 5000 });
  // The book page itself follows (cream paper, ink text).
  const frame = await viewerFrame(page);
  expect(await frameBg(frame)).toBe('rgb(247, 242, 227)');
  expect(await frame.evaluate(() => getComputedStyle(document.body).color)).toBe('rgb(38, 42, 49)');
});

test('TH2 Ember applies kraft-dark night and retires the warmth overlay', async ({ page }) => {
  await openSheet(page);
  await page.click('#envEmber');
  expect(await themeAttr(page)).toBe('ember');
  expect(await deskVar(page)).toBe('#0b0a08');
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('warm')).display)).toBe('none');
  const frame = await viewerFrame(page);
  expect(await frameBg(frame)).toBe('rgb(26, 21, 16)');
  // Muted ember highlighter dots (no glare on dark paper).
  expect(await page.evaluate(() => getComputedStyle(
    document.querySelector('#selBar .hl-dot[data-hl="yellow"]')).backgroundColor)).toBe('rgb(199, 154, 63)');
});

test('TH3 theme persists across reload and yields to env cards', async ({ page }) => {
  await openSheet(page);
  await page.click('#envEmber');
  await page.reload();
  await page.locator('#btnDemo').waitFor({ timeout: 9000 });
  await openDemoReady(page);
  expect(await themeAttr(page)).toBe('ember');
  expect(await deskVar(page)).toBe('#0b0a08');
  // Picking a stock env returns to the Vellum desk (attribute cleared).
  await page.click('#btnSheet');
  await page.click('#envPaper');
  expect(await themeAttr(page)).toBe('');
  expect(await deskVar(page)).toBe('#e8dfca');
});

test('TH4 Velvet applies claret desk, gilt stand, and ivory page', async ({ page }) => {
  await openSheet(page);
  await page.click('#envVelvet');
  expect(await themeAttr(page)).toBe('velvet');
  expect(await deskVar(page)).toBe('#5c222e');
  // Gilt fore-edge token feeds the page-turn gradients.
  expect(await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--paper-edge').trim().toLowerCase())).toBe('#b09758');
  expect(await page.evaluate(() => document.getElementById('envVelvet').classList.contains('sel'))).toBe(true);
  await page.waitForFunction(() => {
    try { return JSON.parse(localStorage.getItem('folio-settings') || '{}').theme === 'velvet'; }
    catch (e) { return false; }
  }, null, { timeout: 5000 });
  // Ivory reading surface preserved under the salon.
  const frame = await viewerFrame(page);
  expect(await frame.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(245, 238, 220)');
  // Embroidery cloth paints the desk behind the book.
  expect(await page.evaluate(() =>
    getComputedStyle(document.body).backgroundImage.includes('velvet-tile.webp'))).toBe(true);
});

test('TH5 Emerald applies green salon, cloth swatch, and ivory page', async ({ page }) => {
  await openSheet(page);
  await page.click('#envEmerald');
  expect(await themeAttr(page)).toBe('emerald');
  expect(await deskVar(page)).toBe('#073614');
  // The cloth swatch is the real reference tile (mirror-extended webp), a
  // real url(), never none.
  const deco = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--deco').trim());
  expect(deco).toMatch(/^url\(/);
  expect(await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--deco-size').trim())).toBe('1402px 2244px');
  expect(await page.evaluate(() => document.getElementById('envEmerald').classList.contains('sel'))).toBe(true);
  await page.waitForFunction(() => {
    try { return JSON.parse(localStorage.getItem('folio-settings') || '{}').theme === 'emerald'; }
    catch (e) { return false; }
  }, null, { timeout: 5000 });
  const frame = await viewerFrame(page);
  expect(await frame.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(245, 238, 220)');
  expect(await page.evaluate(() =>
    getComputedStyle(document.body).backgroundImage.includes('url('))).toBe(true);
});

test('TH6 cloth chrome stays legible (topbar, loader, theme row)', async ({ page }) => {
  await openSheet(page);
  await page.click('#envVelvet');
  // Wordmark, icons and Aa inherit chalk on the cloth topbar.
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('topbar')).color))
    .toBe('rgb(243, 233, 214)');
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('#topbar .wm-btn')).color))
    .toBe('rgb(243, 233, 214)');
  // Loader status follows the landing meta treatment (dusty rose, not paper taupe).
  await page.evaluate(() => showLoader('Typesetting…'));
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('loaderMsg')).color))
    .toBe('rgb(201, 168, 165)');
  await page.evaluate(() => hideLoader());
  // Nine theme buttons + auto wrap inside the sheet instead of overflowing.
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('themeRow')).flexWrap))
    .toBe('wrap');
  expect(await page.evaluate(() => {
    const r = document.getElementById('themeRow');
    return r.scrollWidth <= r.clientWidth + 1;
  })).toBe(true);
});

test('TH7 live theme switching updates the book and shell without a reload', async ({ page }) => {
  await openSheet(page);
  const frame = await viewerFrame(page);
  const iframeState = () => frame.evaluate(() => ({
    bg: getComputedStyle(document.body).backgroundColor,
    font: getComputedStyle(document.body).fontFamily,
  }));

  // env card -> bespoke theme: shell attribute, desk var, and the book
  // iframe's own theme CSS must all move together, with no app reload.
  await page.click('#envVelvet');
  expect(await themeAttr(page)).toBe('velvet');
  expect(await deskVar(page)).toBe('#5c222e');
  expect((await iframeState()).bg).toBe('rgb(245, 238, 220)');

  await page.click('#envEmerald');
  expect(await themeAttr(page)).toBe('emerald');
  expect((await iframeState()).bg).toBe('rgb(245, 238, 220)');

  // theme row back to a plain theme: attribute is removed, book follows.
  await page.locator('#themeRow .t-btn', { hasText: 'Paper' }).first().click();
  await page.waitForFunction(() => !document.documentElement.dataset.theme, null, { timeout: 5000 });
  expect((await iframeState()).bg).toBe('rgb(247, 241, 227)');

  // typeface swap while reading: the book's font must follow immediately.
  await page.evaluate(() => document.querySelector('.f-btn[data-font="lexend"]').click());
  await page.waitForFunction(() => {
    const fr = document.querySelector('#viewer iframe');
    return fr && fr.contentDocument &&
      getComputedStyle(fr.contentDocument.body).fontFamily.startsWith('Lexend');
  }, null, { timeout: 5000 });
  await page.evaluate(() => document.querySelector('.f-btn[data-font="literata"]').click());
  await page.waitForFunction(() => {
    const fr = document.querySelector('#viewer iframe');
    return fr && fr.contentDocument &&
      getComputedStyle(fr.contentDocument.body).fontFamily.startsWith('Literata');
  }, null, { timeout: 5000 });
});

// The fold compositor replays CACHED chapter HTML whose baked-in folio-dyn
// style holds the capture-time theme colors. Without a re-tint on env switch,
// every paper-flip animates leaves in the OLD theme's colors (the flip-only
// flicker). TH8 guards the whole chain: cache, snapshotPage, live flip leaf.
test('TH8 flip surfaces re-tint on environment switch (no stale-theme flicker)', async ({ page }) => {
  await openSheet(page);
  // Stock paper env bakes #f7f1e3 into the cached chapter HTML.
  const cacheDynCss = () => page.evaluate(() => {
    const html = (typeof pageCache !== 'undefined' && pageCache.getChapterHtml()) || '';
    const m = /<style id="folio-dyn">([\s\S]*?)<\/style>/.exec(html);
    return m ? m[1] : '';
  });
  await page.waitForFunction(() => {
    const html = (typeof pageCache !== 'undefined' && pageCache.getChapterHtml()) || '';
    return html.includes('folio-dyn');
  }, null, { timeout: 9000 });
  expect(await cacheDynCss()).toContain('#f7f1e3');

  await page.click('#envVelvet');
  expect(await cacheDynCss()).toContain('#f5eedc');
  expect(await cacheDynCss()).not.toContain('#f7f1e3');
  // Extra spines cached by preload/onContent re-tint too (retintHtml covers
  // the whole chapterHtmls map; refreshCSS only fires it on a css change).
  const seeded = await page.evaluate(() => {
    pageCache.chapterHtmls.set(999,
      '<!DOCTYPE html><html><head><style id="folio-dyn">html,body{background:#f7f1e3 !important;}</style></head><body></body></html>');
    pageCache._cssMark = '';          // velvet css was already retinted above
    pageCache.retintHtml(buildCSS());
    const ok = pageCache.getChapterHtml(999).includes('#f5eedc');
    pageCache.chapterHtmls.delete(999);
    return ok;
  });
  expect(seeded).toBe(true);

  // snapshotPage() is what the compositor actually consumes.
  const snapDyn = await page.evaluate(() => {
    const s = snapshotPage();
    const m = s ? /<style id="folio-dyn">([\s\S]*?)<\/style>/.exec(s.docHtml) : null;
    return m ? m[1] : '';
  });
  expect(snapDyn).toContain('#f5eedc');

  // Live paper flip right after the switch: the turning leaf's iframe must
  // paint the NEW theme's paper, not the previous environment's.
  await page.click('#sheetClose');
  await page.waitForFunction(() => !document.body.classList.contains('sheet-open'), null, { timeout: 5000 });
  await page.evaluate(() => { settings.turnFx = 'paper'; save(); });
  // Shrink the book so the stage arrows are live (PT5 pattern).
  await page.evaluate(() => { settings.widthAuto = false; settings.widthSpread = 720; save(); relayout(); });
  await page.waitForFunction(() => !document.getElementById('stage').classList.contains('no-arrows'), null, { timeout: 9000 });
  await page.click('#btnNext');
  await page.waitForFunction(() => {
    const f = document.querySelector('.pt-compositor iframe');
    if (!f || !f.contentDocument || !f.contentDocument.body) return false;
    return getComputedStyle(f.contentDocument.body).backgroundColor === 'rgb(245, 238, 220)';
  }, null, { timeout: 5000 });
  await page.waitForFunction(() => !document.querySelector('.pt-compositor'), null, { timeout: 5000 });
});
