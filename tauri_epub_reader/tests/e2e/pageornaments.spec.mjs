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
    const q = (s2) => document.querySelector(s2);
    const viewer = document.getElementById('viewer').getBoundingClientRect();
    const l = q('.folio-vine.left:not(.under)');
    const g = q('.folio-vine.under.left');
    // NOTE the :not(.under) — the right group's gilt span precedes the vine
    // span in document order, so a bare '.folio-vine.right' matches the gilt
    // (that collision once left the right vine permanently invisible).
    const r = q('.folio-vine.right:not(.under)');
    const gr = q('.folio-vine.under.right');
    return {
      tight: document.body.classList.contains('vine-tight'),
      ivyShown: getComputedStyle(l).display,
      giltShown: getComputedStyle(g).display,
      giltW: Math.round(g.getBoundingClientRect().width),
      giltBg: (g.style.backgroundImage || '').slice(0, 40),
      ivyBg: (l.style.backgroundImage || '').slice(0, 40),
      // gilt abuts the gilt frame (8px outside the viewer box) on BOTH
      // flanks and never crosses onto the paper (paper starts at viewer edge)
      giltAtBook: Math.abs(g.getBoundingClientRect().right - (viewer.left - 8)) < 12,
      deskClear: g.getBoundingClientRect().right <= viewer.left + 2,
      ivyShownR: getComputedStyle(r).display,
      rBg: (r.style.backgroundImage || '').slice(0, 40),
      grBg: (gr.style.backgroundImage || '').slice(0, 40),
      giltAtBookR: Math.abs(gr.getBoundingClientRect().left - (viewer.right + 8)) < 12,
      deskClearR: gr.getBoundingClientRect().left >= viewer.right - 2,
    };
  });
  // 1920 spread: the desk margin is too narrow for both columns at full
  // height — both shrink (vine-tight) but stay visible, gilt at the book.
  const s = await read();
  expect(s.tight).toBe(true);
  expect(s.giltShown).toBe('block');
  expect(s.ivyShown).toBe('block');
  expect(s.giltW).toBeGreaterThan(50);
  expect(s.giltW).toBeLessThan(141); // shrunk to fit
  expect(s.giltAtBook).toBe(true);
  expect(s.deskClear).toBe(true);
  expect(s.giltBg).toContain('data:image/svg+xml');
  expect(s.ivyBg).toContain('data:image/svg+xml');
  // Right flank mirrors the left (vine span must carry its own background).
  expect(s.ivyShownR).toBe('block');
  expect(s.rBg).toContain('data:image/svg+xml');
  expect(s.grBg).toContain('data:image/svg+xml');
  expect(s.giltAtBookR).toBe(true);
  expect(s.deskClearR).toBe(true);
  // Wide desk: both columns at full height — gilt inner (touching the book),
  // vine outer, ~14px gap between them.
  await page.setViewportSize({ width: 2560, height: 1080 });
  await page.waitForTimeout(1100); // relayout + debounced vine-space recheck
  const wide = await page.evaluate(() => {
    const l = document.querySelector('.folio-vine.left:not(.under)').getBoundingClientRect();
    const g = document.querySelector('.folio-vine.under.left').getBoundingClientRect();
    const r = document.querySelector('.folio-vine.right:not(.under)').getBoundingClientRect();
    const gr = document.querySelector('.folio-vine.under.right').getBoundingClientRect();
    const viewer = document.getElementById('viewer').getBoundingClientRect();
    return {
      tight: document.body.classList.contains('vine-tight'),
      ivyShown: getComputedStyle(document.querySelector('.folio-vine.left:not(.under)')).display,
      fullHeight: Math.round(g.height),
      gap: Math.round(g.left - l.right),
      gapR: Math.round(r.left - gr.right),
      giltAtBook: Math.abs(g.right - (viewer.left - 8)) < 12,
      giltAtBookR: Math.abs(gr.left - (viewer.right + 8)) < 12,
      deskClearIvy: l.right <= viewer.left + 2,
      deskClearIvyR: r.left >= viewer.right - 2,
    };
  });
  expect(wide.tight).toBe(false);
  expect(wide.ivyShown).toBe('block');
  expect(wide.fullHeight).toBeGreaterThan(900); // --vine-h back to 1
  expect(Math.abs(wide.gap - 14)).toBeLessThanOrEqual(2);
  expect(Math.abs(wide.gapR - 14)).toBeLessThanOrEqual(2);
  expect(wide.giltAtBook).toBe(true);
  expect(wide.giltAtBookR).toBe(true);
  expect(wide.deskClearIvy).toBe(true);
  expect(wide.deskClearIvyR).toBe(true);
  // Ornament toggle strips and restores both columns.
  await page.setViewportSize({ width: 2560, height: 1080 });
  await page.keyboard.press('s');
  await page.waitForFunction(() => document.body.classList.contains('sheet-open'), null, { timeout: 5000 });
  await page.evaluate(() => { document.getElementById('swPageOrn').click(); });
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.folio-vine.under.left')).display)).toBe('none');
  await page.evaluate(() => { document.getElementById('swPageOrn').click(); });
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.folio-vine.under.left')).display)).toBe('block');
});
