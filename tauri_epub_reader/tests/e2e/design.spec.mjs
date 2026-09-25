import { test, expect } from '@playwright/test';
import { fresh, openDemoReady, badge, badgeWait, buildStressBook, generateStressBuffer, openStressBuffer, searchIndexRecord, slowDrag, fastFling, synUp, spreadInfo, curCfi } from './helpers.mjs';

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

test('D5 texture adds no per-frame cost, single shared tile', async ({ page }) => {
  await openDemoReady(page);
  const r = await page.evaluate(() => {
    const out = {};
    let n = 0;
    const o = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...a) { n++; return o.apply(this, a); };
    try {
      const snap = snapshotPage();
      const adj = PageSurfacePool.getAdjacentSurfaceInfo(1, snap);
      const mk = () => new PageTurnCompositor(1, snap, adj);
      const bench = (c) => {
        const ts = [];
        for (let i = 0; i < 200; i++) {
          const t0 = performance.now();
          c.render(0.5);
          ts.push(performance.now() - t0);
        }
        ts.sort((a, b2) => a - b2);
        return ts[100];
      };
      const a = mk();
      out.grainOnCount = a.root.querySelectorAll('.pt-grain').length;
      out.medOn = bench(a);
      const bgA = a.root.querySelector('.pt-grain')
        ? getComputedStyle(a.root.querySelector('.pt-grain')).backgroundImage : null;
      settings.grain = false;
      const b = mk();
      out.grainOffCount = b.root.querySelectorAll('.pt-grain').length;
      out.medOff = bench(b);
      const bgA2 = a.root.querySelector('.pt-grain')
        ? getComputedStyle(a.root.querySelector('.pt-grain')).backgroundImage : null;
      out.sharedTile = !!bgA && bgA === bgA2 && bgA.indexOf('data:image') > 0;
      settings.grain = true;
      a.destroy(); b.destroy();
    } finally {
      HTMLCanvasElement.prototype.toDataURL = o;
    }
    out.extraToDataURL = n;
    return out;
  });
  expect(r.grainOnCount).toBeGreaterThan(0);
  expect(r.grainOffCount).toBe(0);
  expect(r.sharedTile).toBe(true);
  expect(r.extraToDataURL).toBe(0);
  expect(Math.abs(r.medOn - r.medOff)).toBeLessThan(1);
});

test('D6 full-spread phase 1: flat remainder, fold travel, untouched left', async ({ page }) => {
  test.setTimeout(120000);
  const mark = (s) => console.log(`D6 ${Date.now() - globalThis.__t0 || 0}ms ${s}`);
  globalThis.__t0 = Date.now();
  await openDemoReady(page);
  mark('ready');
  const spread = await page.evaluate(() => document.body.classList.contains('spread'));
  expect(spread).toBe(true);
  await page.evaluate(() => { settings.turnFx = 'paper'; save(); });
  const info = await slowDrag(page, 1, 0.3);
  const foldX = info.spreadW * 0.7;
  const st = await page.evaluate(() => {
    const sheet = document.querySelector('.pt-compositor .pt-sheet');
    const under = document.querySelector('.pt-compositor .pt-underneath-leaf iframe');
    const stat = document.querySelector('.pt-compositor .pt-stationary-leaf');
    const back = document.querySelector('.pt-compositor .pt-back-sheet');
    const clip = sheet ? getComputedStyle(sheet).clipPath : null;
    return {
      clip,
      underLoaded: !!(under && under.contentDocument && under.contentDocument.body),
      statVisible: !!stat,
      backHidden: !back || getComputedStyle(back).opacity === '0',
    };
  });
  // clip-path inset(0 R 0 0): visible region is [0, spreadW-R], R ~= 0.3*W
  const m = /inset\(0(px)? ([0-9.]+)px 0(px)? 0(px)?\)/.exec(st.clip || '');
  expect(m).toBeTruthy();
  expect(Math.abs(parseFloat(m[2]) - info.spreadW * 0.3)).toBeLessThan(45);
  expect(st.underLoaded).toBe(true);
  expect(st.statVisible).toBe(true);
  expect(st.backHidden).toBe(true);
  await synUp(page);
  await page.waitForFunction(() => !document.querySelector('.pt-compositor'), null, { timeout: 9000 });
});

test('D7 phase 2 overlap: back sheet covers opposite page', async ({ page }) => {
  await openDemoReady(page);
  await page.evaluate(() => { settings.turnFx = 'paper'; save(); });
  const info = await slowDrag(page, 1, 0.7);
  await page.evaluate(() => hideSelBar());
  const foldX = info.spreadW * 0.3, spineX = info.spreadW / 2;
  const st = await page.evaluate(({ fx, sx, vx }) => {
    const back = document.querySelector('.pt-compositor .pt-back-sheet');
    if (!back) return { present: false };
    const r = back.getBoundingClientRect();
    const clip = getComputedStyle(back).clipPath;
    const valley = document.querySelector('.pt-compositor .pt-spine-valley');
    // The drag-capture blanket (z 9999, by design) covers everything mid-drag;
    // lift it for this synchronous probe only, then restore.
    const cap = document.querySelector('.pt-drag-capture');
    if (cap) cap.style.display = 'none';
    const px = vx + (fx + sx) / 2, py = innerHeight / 2;
    const probe = document.elementFromPoint(px, py);
    const stack = (document.elementsFromPoint
      ? document.elementsFromPoint(px, py) : [probe]).slice(0, 6).map((e) => {
      if (!e || !e.tagName) return '?';
      const cs = getComputedStyle(e);
      return `${e.tagName}.${String(e.className).slice(0, 24)}#${e.id || '-'} z=${cs.zIndex} pe=${cs.pointerEvents} vis=${cs.visibility} op=${cs.opacity}`;
    });
    if (cap) cap.style.display = '';
    window.__hitStack = stack;
    return {
      present: true,
      rectLeft: r.left, rectRight: r.right, clip,
      valleyOpacity: valley ? parseFloat(getComputedStyle(valley).opacity || '1') : null,
      probeInBack: !!(probe && probe.closest && probe.closest('.pt-back-sheet')),
      stack: window.__hitStack,
    };
  }, { fx: foldX, sx: spineX, vx: info.left });
  expect(st.present).toBe(true);
  expect(Math.abs(st.rectLeft - info.left) < 45).toBe(true);
  expect(Math.abs(st.rectRight - (info.left + spineX)) < 45).toBe(true);
  const m = /inset\(0(px)? 0(px)? 0(px)? ([0-9.]+)px\)/.exec(st.clip || '');
  expect(m).toBeTruthy();
  expect(Math.abs(parseFloat(m[4]) - foldX)).toBeLessThan(45);
  console.log('HITSTACK: ' + JSON.stringify(st.stack));
  expect(st.probeInBack).toBe(true);
  expect(st.valleyOpacity).toBeLessThan(0.35);
  const before = await page.evaluate(() => state.rendition.currentLocation().start.cfi);
  await synUp(page);
  await page.waitForFunction((p) => {
    const l = state.rendition.currentLocation();
    return l && l.start && String(l.start.cfi) !== p;
  }, before, { timeout: 9000 });
});

test('D8 backward mirror and fling commit', async ({ page }) => {
  await openDemoReady(page);
  await page.evaluate(() => { settings.turnFx = 'paper'; save(); });
  // Move off page 1 first: backward from page 1 is boundary overscroll, not
  // a real turn. Two forward turns put us mid-book for a genuine backward leg.
  for (let i = 0; i < 2; i++) {
    const b = await badge(page);
    await page.keyboard.press('ArrowRight');
    await badgeWait(page, b);
  }
  // Let the turn fully settle (turning flag + animations) before grabbing.
  await page.waitForFunction(() => !state.turning && !state.recreating, null, { timeout: 9000 });
  await page.waitForTimeout(300);
  const info = await slowDrag(page, -1, 0.3);
  const st = await page.evaluate(() => {
    const sheet = document.querySelector('.pt-compositor .pt-sheet');
    return { clip: sheet ? getComputedStyle(sheet).clipPath : null };
  });
  // backward phase 1: un-turned remainder [foldX, VW], foldX ~= 0.3W.
  const m = /inset\(0(px)? 0(px)? 0(px)? ([0-9.]+)px\)/.exec(st.clip || '');
  expect(m).toBeTruthy();
  expect(Math.abs(parseFloat(m[4]) - info.spreadW * 0.3)).toBeLessThan(45);
  await synUp(page);
  await page.waitForFunction(() => !document.querySelector('.pt-compositor'), null, { timeout: 9000 });
  // Fling from ~12%: high velocity commits despite low displacement.
  await fastFling(page, 1, 0.12);
  const before = await curCfi(page);
  const t0 = Date.now();
  await synUp(page);
  await page.waitForFunction((p) => {
    try {
      const l = state.rendition.currentLocation();
      return l && l.start && String(l.start.cfi) !== p;
    } catch (e) { return null; }
  }, before, { timeout: 9000 });
  expect(Date.now() - t0).toBeLessThan(9000);
  const after = await curCfi(page);
  expect(String(after)).not.toBe(String(before));
  await page.waitForTimeout(1500);
  const still = await curCfi(page);
  expect(String(still)).toBe(String(after));
});

test('D9 legacy path with flag off: no back sheet, old clip', async ({ page }) => {
  await openDemoReady(page);
  await page.evaluate(() => { settings.turnFx = 'paper'; save(); PageTurnConfig.fullSpreadFold = false; });
  try {
    const info = await slowDrag(page, 1, 0.7);
    expect(await page.evaluate(() => !!document.querySelector('.pt-compositor .pt-sheet'))).toBe(true);
    const st = await page.evaluate(() => {
      const back = document.querySelector('.pt-compositor .pt-back-sheet');
      const sheet = document.querySelector('.pt-compositor .pt-sheet');
      const r = sheet ? sheet.getBoundingClientRect() : null;
      return {
        backPresent: !!back,
        sheetLeft: r ? r.left : null,
        clip: sheet ? getComputedStyle(sheet).clipPath : null,
      };
    });
    expect(st.backPresent).toBe(false);
    // Old half-leaf path: sheet element anchored at the leaf (right half).
    expect(st.sheetLeft).toBeGreaterThan(info.spreadW * 0.4);
  } finally {
    await page.evaluate(() => { PageTurnConfig.fullSpreadFold = true; });
    await synUp(page).catch(() => {});
    await page.waitForFunction(() => !document.querySelector('.pt-compositor'), null, { timeout: 9000 });
  }
});

test.describe('D9 single-page mode', () => {
  test.use({ viewport: { width: 700, height: 860 } });
  test('never creates a back sheet', async ({ page }) => {
    await openDemoReady(page);
    expect(await page.evaluate(() => document.body.classList.contains('spread'))).toBe(false);
    await page.evaluate(() => { settings.turnFx = 'paper'; save(); });
    await slowDrag(page, 1, 0.7);
    expect(await page.evaluate(() => !!document.querySelector('.pt-compositor .pt-sheet'))).toBe(true);
    try {
      expect(await page.evaluate(() => !!document.querySelector('.pt-compositor .pt-back-sheet'))).toBe(false);
    } finally {
      await synUp(page).catch(() => {});
      await page.waitForFunction(() => !document.querySelector('.pt-compositor'), null, { timeout: 9000 });
    }
  });
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
