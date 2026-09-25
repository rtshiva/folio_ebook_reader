import { test, expect } from '@playwright/test';
import { fresh, openDemoReady, badge, badgeWait, buildStressBook, generateStressBuffer, openStressBuffer, searchIndexRecord } from './helpers.mjs';

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

test('D10 background slicing: no long tasks, chunked index, hidden pause', async ({ page }) => {
  await fresh(page);
  await page.evaluate(() => {
    window.__lt = [];
    window.__t0 = performance.now();
    try {
      const o = new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          window.__lt.push({ d: Math.round(e.duration), t: Math.round(performance.now() - window.__t0) });
        }
      });
      o.observe({ entryTypes: ['longtask'] });
    } catch (e) { window.__ltErr = String(e); }
  });
  await buildStressBook(page, 'Stress300', 300, 60);
  // Flip pages immediately while indexing runs in the background.
  const cfi = () => page.evaluate(() => state.rendition.currentLocation().start.cfi);
  let prev = await cfi();
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction((p) => {
      const l = state.rendition.currentLocation();
      return l && l.start && String(l.start.cfi) !== p;
    }, prev, { timeout: 9000 });
    prev = await cfi();
  }
  // Index progress must advance across multiple idle ticks.
  const samples = [];
  for (let i = 0; i < 6; i++) {
    const r = await searchIndexRecord(page, 'Stress300');
    samples.push(r ? r.done : -1);
    await page.waitForTimeout(400);
  }
  const distinct = new Set(samples.filter((v) => v >= 0)).size;
  const lastDone = samples[samples.length - 1];
  expect(distinct >= 2 || lastDone === 300).toBe(true);
  // No frame drops in the first 5 s from open start.
  const bad = await page.evaluate(() => (window.__lt || []).filter((e) => e.t < 5000 && e.d > 50));
  expect(bad).toEqual([]);
  // Hiding pauses background work; unhiding resumes it.
  const rec0 = await searchIndexRecord(page, 'Stress300');
  if (rec0 && !rec0.partial) {
    expect(rec0.done).toBe(300); // already complete: chunked build ran to completion
  } else {
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const a = (await searchIndexRecord(page, 'Stress300') || {}).done || 0;
    await page.waitForTimeout(1000);
    const b = (await searchIndexRecord(page, 'Stress300') || {}).done || 0;
    expect(b).toBe(a);
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(async () => {
      const r = await BookStorage.getSearchIndex('Stress300');
      return r && (!r.partial || r.done > 0) ? (r.done + '/' + r.partial) : null;
    }, null, { timeout: 6000 });
    const c = (await searchIndexRecord(page, 'Stress300') || {}).done || 0;
    expect(c > b || (await searchIndexRecord(page, 'Stress300')).partial === false).toBe(true);
  }
});

test('D11 index resume after reload without reprocessing', async ({ page }) => {
  await fresh(page);
  // Phase 1: generate + kick the open (don't await it) so polling observes
  // the build mid-flight; wait until the partial record shows done >= 10.
  await generateStressBuffer(page, 'Stress60', 60, 120);
  await openStressBuffer(page, 'Stress60', { awaitOpen: false });
  let doneBefore = 0;
  for (let i = 0; i < 30; i++) {
    const r = await searchIndexRecord(page, 'Stress60');
    if (r && r.partial && Number(r.done) >= 10) { doneBefore = Number(r.done); break; }
    await page.waitForTimeout(250);
  }
  expect(doneBefore).toBeGreaterThanOrEqual(10);
  // Freeze the build mid-flight so the reload below is guaranteed to catch a
  // partial record (a fast machine could otherwise complete it first).
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.reload();
  await page.locator('#btnDemo').waitFor({ timeout: 9000 });
  // Phase 2: regenerate, then kick the open and arm the load spy while the
  // open is still in flight — it lands before the resumed build's first load
  // (which waits on cache read + an idle round-trip). NOTE: the stack pattern
  // matches only `_build` — `LocEngine.ensure` (locations generation) also
  // loads every spine and must not be mistaken for index reprocessing.
  await generateStressBuffer(page, 'Stress60', 60, 120);
  await openStressBuffer(page, 'Stress60', { awaitOpen: false });
  await page.evaluate(async () => {
    window.__loads = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      if (typeof state !== 'undefined' && state.book && state.book.spine) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const sp = state.book.spine, og = sp.get.bind(sp);
    sp.get = (i) => {
      const it = og(i);
      if (it && typeof i === 'number' && !it.__w) {
        it.__w = true;
        const ol = it.load.bind(it);
        it.load = (...a) => {
          let st = '';
          try { st = new Error().stack || ''; } catch (e) {}
          window.__loads.push({ i, build: /_build/.test(st) });
          return ol(...a);
        };
      }
      return it;
    };
    return 'armed';
  });
  // Wait for the resumed build to complete, tracking the persisted progress
  // the whole way: a restart-from-zero would re-persist done < doneBefore.
  let rec = null;
  const seenDone = [];
  for (let i = 0; i < 40; i++) {
    rec = await searchIndexRecord(page, 'Stress60');
    if (rec) seenDone.push(Number(rec.done));
    if (rec && !rec.partial) break;
    await page.waitForTimeout(250);
  }
  expect(rec && !rec.partial).toBe(true);
  expect(rec.done).toBe(60);
  expect(rec.resumedFrom).toBeGreaterThanOrEqual(doneBefore);
  expect(Math.min(...seenDone)).toBeGreaterThanOrEqual(doneBefore);
  const loads = await page.evaluate(() => window.__loads);
  expect(loads.some((l) => l.build)).toBe(true); // stack sniffing works
  expect(loads.filter((l) => l.build && l.i < rec.resumedFrom)).toEqual([]);
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
