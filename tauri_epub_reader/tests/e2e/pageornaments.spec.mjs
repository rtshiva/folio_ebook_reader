// Page corner art (PO-*): per-chapter ornaments in the reserved top and
// bottom margin bands. A chapter's opening spread shows a grand gold corner
// set + headpiece; every continuation spread a small centered fleuron. The
// markup rides the page cache so turn-compositor replays match, and the
// overlay is park-offset tracked (the section canvas is a wide parked iframe).
import { test, expect } from '@playwright/test';
import { fresh, openDemoReady, badge, badgeWait } from './helpers.mjs';

test.beforeEach(async ({ page }) => { await fresh(page); });

async function ornState(page) {
  return page.evaluate(() => {
    const d = document.querySelector('#viewer iframe').contentDocument;
    const pcs = d.getElementById('folio-pcs');
    const cs = d.defaultView;
    const g = d.querySelector('.folio-pg.tl');
    const ph = d.querySelector('.folio-ph.simple');
    return {
      present: !!pcs,
      spans: pcs ? pcs.children.length : 0,
      opening: pcs ? pcs.classList.contains('opening') : null,
      grandShown: g ? cs.getComputedStyle(g).display : 'none',
      simpleShown: ph ? cs.getComputedStyle(ph).display : 'none',
      goldB64: g ? ((cs.getComputedStyle(g).backgroundImage || '').match(/base64,([^")]+)/) || [''])[1].slice(0, 24) : '',
      padT: parseFloat(cs.getComputedStyle(d.body).paddingTop),
    };
  });
}
async function waitFrame(page) {
  await page.waitForFunction(() => {
    const d = document.querySelector('#viewer iframe')?.contentDocument;
    return !!(d && d.body && (d.body.textContent || '').length > 40);
  }, null, { timeout: 9000 });
}

test('PO1 corners inject by default with a reserved top band and opening state', async ({ page }) => {
  await openDemoReady(page);
  const s = await ornState(page);
  expect(s.present).toBe(true);
  expect(s.spans).toBe(6); // 4 grand corners + 2 headpieces
  expect(s.opening).toBe(true);
  expect(s.grandShown).toBe('block');
  expect(s.simpleShown).toBe('none');
  expect(s.goldB64).not.toBe('');
  expect(s.padT).toBeGreaterThanOrEqual(72);
});

test('PO2 the opening design is stable per chapter and deterministic', async ({ page }) => {
  await openDemoReady(page);
  const goldB64 = (await ornState(page)).goldB64;
  // deterministic hash pick for the demo's first chapter
  const expected = await page.evaluate(() =>
    window.PAGE_ART[PAGE_ORN.keys[pageOrnVariant(0)]].match(/base64,([^"']+)/)[1].slice(0, 24));
  expect(goldB64).toBe(expected);
  // leave and come back: the same chapter keeps its design
  await page.evaluate(() => turn(1));
  await page.waitForFunction(() => !document.body.classList.contains('turning'), null, { timeout: 9000 });
  await page.evaluate(() => turn(-1));
  await page.waitForFunction(() => !document.body.classList.contains('turning'), null, { timeout: 9000 });
  await page.waitForTimeout(700);
  expect((await ornState(page)).goldB64).toBe(goldB64);
});

test('PO3 the toggle strips and restores corners, padding follows', async ({ page }) => {
  await openDemoReady(page);
  expect((await ornState(page)).present).toBe(true);
  await page.keyboard.press('s');
  await page.waitForFunction(() => document.body.classList.contains('sheet-open'), null, { timeout: 5000 });
  await page.evaluate(() => { document.getElementById('swPageOrn').click(); });
  await page.waitForFunction(() => {
    try { return JSON.parse(localStorage.getItem('folio-settings') || '{}').pageOrnaments === false; }
    catch (e) { return false; }
  }, null, { timeout: 9000 });
  const off = await ornState(page);
  expect(off.present).toBe(false);
  expect(off.padT).toBe(20);
  await page.evaluate(() => { document.getElementById('swPageOrn').click(); });
  await page.waitForFunction(() => {
    try { return JSON.parse(localStorage.getItem('folio-settings') || '{}').pageOrnaments === true; }
    catch (e) { return false; }
  }, null, { timeout: 9000 });
  expect((await ornState(page)).present).toBe(true);
});

test('PO4 cached chapters re-normalize: ornaments survive navigation away and back', async ({ page }) => {
  await openDemoReady(page);
  const first = (await ornState(page)).goldB64;
  await page.evaluate(() => turn(1));
  await page.waitForFunction(() => !document.body.classList.contains('turning'), null, { timeout: 9000 });
  await page.waitForTimeout(500);
  await page.evaluate(() => turn(-1));
  await page.waitForFunction(() => !document.body.classList.contains('turning'), null, { timeout: 9000 });
  await page.waitForTimeout(700);
  expect((await ornState(page)).goldB64).toBe(first);
  expect(await page.evaluate(() => (pageCache.getChapterHtml() || '').includes('folio-pcs'))).toBe(true);
});

test('PO5 opening grand set yields to the fleuron on continuation spreads', async ({ page }) => {
  await openDemoReady(page);
  expect((await ornState(page)).opening).toBe(true);
  // two turns land inside the same section (past its opening spread)
  await page.evaluate(() => turn(1));
  await page.waitForFunction(() => !document.body.classList.contains('turning'), null, { timeout: 9000 });
  await page.waitForTimeout(400);
  await page.evaluate(() => turn(1));
  await page.waitForFunction(() => !document.body.classList.contains('turning'), null, { timeout: 9000 });
  await page.waitForTimeout(800);
  const s = await ornState(page);
  expect(s.opening).toBe(false);
  expect(s.grandShown).toBe('none');
  expect(s.simpleShown).toBe('block');
  // the fleuron is centered on the visible spread
  const cx = await page.evaluate(() => {
    const el = document.querySelector('#viewer iframe').contentDocument.querySelector('.folio-ph.simple');
    const r = el.getBoundingClientRect();
    return r.left + r.width / 2;
  });
  // wrapper-space centering (timing-independent): the fleuron sits centered
  // in the tracked overlay, which is glued to the visible spread
  const delta = await page.evaluate(() => {
    const d = document.querySelector('#viewer iframe').contentDocument;
    const pcs = d.getElementById('folio-pcs');
    const ph = d.querySelector('.folio-ph.simple');
    const wr = pcs.getBoundingClientRect();
    const pr = ph.getBoundingClientRect();
    return Math.abs((pr.left + pr.width / 2) - (wr.left + wr.width / 2));
  });
  expect(delta).toBeLessThan(6);
});

test('PO6 page turns stay healthy with corner art mounted', async ({ page }) => {
  await openDemoReady(page);
  const prev = await badge(page);
  await page.evaluate(() => turn(1));
  await page.waitForFunction(() => !document.body.classList.contains('turning'), null, { timeout: 9000 });
  await badgeWait(page, prev);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('PO7 side vines flank the book on the desk and swap per chapter', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openDemoReady(page);
  const read = () => page.evaluate(() => {
    const l = document.querySelector('.folio-vine.left');
    const r = document.querySelector('.folio-vine.right');
    return {
      shown: getComputedStyle(l).display,
      w: Math.round(l.getBoundingClientRect().width),
      lBg: (l.style.backgroundImage || '').match(/margin-vine|vine-\d+-l/) ? l.style.backgroundImage.slice(0, 40) : l.style.backgroundImage.slice(0, 40),
      rBg: (r.style.backgroundImage || '').slice(0, 40),
      deskClear: l.getBoundingClientRect().right <= document.getElementById('viewer').getBoundingClientRect().left,
    };
  });
  const s = await read();
  expect(s.shown).toBe('block');
  expect(s.w).toBeGreaterThan(80);
  expect(s.deskClear).toBe(true); // vine sits between page edge and desk, never on the page
  await page.keyboard.press('s');
  await page.waitForFunction(() => document.body.classList.contains('sheet-open'), null, { timeout: 5000 });
  await page.evaluate(() => { document.getElementById('swPageOrn').click(); });
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.folio-vine.left')).display)).toBe('none');
  await page.evaluate(() => { document.getElementById('swPageOrn').click(); });
  await page.waitForTimeout(600);
  expect(await read().then(s => s.shown)).toBe('block');
});
