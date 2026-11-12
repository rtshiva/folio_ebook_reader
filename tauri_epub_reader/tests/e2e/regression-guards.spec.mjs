// Regression guards for the 2026-11-12/13 packaged-exe batch (commits
// c617cbd / 3d8739c / 48a933c). Each test replays a failure mode that the
// browser-only harness could not see on its own:
//   G1/G2 fonts: the chapter folio-dyn must carry the embedded data-URI
//      faces AND the face must actually LOAD (fonts.check) — including with
//      every external network request blocked (the file://-opening case,
//      where all file-based sources die and text used to ride the CDN).
//   G3 crossing: flipping forward through a chapter boundary with page
//      ornaments ON must advance the spine — the ornament overlay once
//      ratcheted epub.js's page total +1 spread per turn, so inSameChapter
//      never went false and every flip landed on an empty phantom page.
//   G4 overlay clamp: the overlay box must stay inside the canvas
//      (documentElement.clientWidth) after turns — the clamp is what keeps
//      the measure honest even during fold overshoot.
//   G5 applyChapterBase: relative resource references (SVG <image>'s
//      xlink:href, plain img/src) must be rewritten to absolute URLs against
//      the section URL — re-setting the attribute is what re-fires a failed
//      load, and the rewrite must run even when a <base> already exists
//      (epub.js injects its own, after first paint).
import { test, expect } from '@playwright/test';
import { fresh, openDemoReady } from './helpers.mjs';

test.beforeEach(async ({ page }) => { await fresh(page); });

const chapterState = (page) => page.evaluate(() => {
  const frs = [...document.querySelectorAll('#viewer iframe')]
    .map((f) => ({ f, r: f.getBoundingClientRect() }))
    .sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height));
  const d = frs.length && frs[0].f.contentDocument;
  if (!d || !d.body) return null;
  const dyn = d.getElementById('folio-dyn');
  const pcs = d.getElementById('folio-pcs');
  let loc = null;
  try {
    const l = state.rendition.currentLocation();
    loc = { spine: l.start.index, page: l.start.displayed ? l.start.displayed.page : null, total: l.start.displayed ? l.start.displayed.total : null };
  } catch (e) { /* mid-turn */ }
  return {
    dynApplied: dyn ? [...d.styleSheets].some((ss) => ss.ownerNode === dyn) : false,
    dataFirst: dyn ? dyn.textContent.includes('data:font/woff2') : false,
    literata: d.fonts.check('16px "Literata"'),
    cornerArt: pcs ? pcs.querySelectorAll('.folio-pg,.folio-ph').length : 0,
    wrapRight: pcs ? Math.round(pcs.getBoundingClientRect().right) : null,
    clientWidth: d.documentElement.clientWidth,
    loc,
  };
});

test('G1 chapter fonts: embedded data-URI faces present and Literata loaded', async ({ page }) => {
  await openDemoReady(page);
  await page.waitForTimeout(700);
  const st = await chapterState(page);
  expect(st, 'chapter iframe reachable').toBeTruthy();
  expect(st.dataFirst, 'folio-dyn must embed the data: font sources').toBe(true);
  expect(st.literata, 'Literata must actually load in the chapter (fonts.check)').toBe(true);
  expect(st.dynApplied, 'folio-dyn must be applied (in styleSheets, not CSP-blocked)').toBe(true);
  expect(st.cornerArt, 'corner art pieces present').toBeGreaterThan(0);
});

test('G2 fonts load with all external network blocked (file://-opening case)', async ({ page }) => {
  // Block everything that is not the test server: mirrors the file:// opening
  // where jsdelivr is unreachable and all file-based font sources die.
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith('http://127.0.0.1:8124') || u.startsWith('data:')) return route.continue();
    return route.abort();
  });
  await openDemoReady(page);
  await page.waitForTimeout(700);
  const st = await chapterState(page);
  expect(st).toBeTruthy();
  expect(st.dataFirst, 'data: sources must be in folio-dyn').toBe(true);
  expect(st.literata, 'Literata must load offline (embedded data URIs)').toBe(true);
});

test('G3 crossing: fast flips advance the spine with ornaments on, totals never ratchet', async ({ page }) => {
  await openDemoReady(page);
  await page.evaluate(() => { try { settings.pageOrnaments = true; save(); refreshCSS(); } catch (e) {} });
  await page.waitForTimeout(500);

  const startSpine = await page.evaluate(() => { try { return state.rendition.currentLocation().start.index; } catch (e) { return -1; } });
  const totals = new Map(); // per-spine max total seen — a ratchet grows it every turn
  let crossed = 0;
  let last = startSpine;
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(700);
    const s = await chapterState(page);
    if (!s || !s.loc) continue;
    const { spine, total } = s.loc;
    if (typeof spine === 'number' && spine >= 0) {
      if (spine > last && last >= 0) crossed++;
      last = spine;
      if (typeof total === 'number') {
        const prev = totals.get(spine);
        if (prev !== undefined && total > prev) {
          throw new Error(`page-total ratchet: spine ${spine} total grew ${prev} -> ${total} (overlay inflating epub.js's measure)`);
        }
        totals.set(spine, Math.max(prev ?? 0, total));
      }
    }
  }
  expect(crossed, 'flipping forward must cross chapter boundaries (no phantom-page trap)').toBeGreaterThan(0);
});

test('G4 ornament overlay box never exceeds the canvas after turns', async ({ page }) => {
  await openDemoReady(page);
  await page.evaluate(() => { try { settings.pageOrnaments = true; save(); refreshCSS(); } catch (e) {} });
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(600);
    const s = await chapterState(page);
    if (s && s.wrapRight !== null && s.clientWidth) {
      // The clamp may land exactly ON the canvas edge (last spread) — never past it.
      expect(s.wrapRight, `overlay right ${s.wrapRight} > canvas ${s.clientWidth} on turn ${i}`)
        .toBeLessThanOrEqual(s.clientWidth);
    }
  }
});

test('G5 applyChapterBase rewrites relative resource refs (SVG image + img) even when a base exists', async ({ page }) => {
  await page.goto('/');
  const res = await page.evaluate(() => {
    const SEC = 'http://folio-cache.localhost/abc123/OEBPS/text/title.xhtml';
    const doc = new DOMParser().parseFromString(
      `<!DOCTYPE html><html><head><base href="http://tauri.localhost/"></head><body>`
      + `<svg width="10" height="10"><image width="4" height="6" xlink:href="cover.jpeg"></image></svg>`
      + `<img src="pics/p1.jpeg"><img src="https://already/abs.jpeg"><img src="data:image/png;base64,AA">`
      + `<link rel="stylesheet" href="style.css"></body></html>`,
      'text/html');
    applyChapterBase(doc, SEC);
    const abs = (el, attrs) => attrs.map((a) => el.getAttribute(a)).filter(Boolean);
    const image = doc.querySelector('image');
    return {
      xlinkAbs: (image.getAttribute('xlink:href') || '').startsWith(SEC.replace(/[^/]*$/, '')),
      imgRel: doc.querySelectorAll('img')[0].getAttribute('src'),
      imgAbsKept: doc.querySelectorAll('img')[1].getAttribute('src'),
      imgDataKept: doc.querySelectorAll('img')[2].getAttribute('src'),
      linkAbs: doc.querySelector('link').getAttribute('href'),
      baseAlone: doc.querySelectorAll('base').length,
    };
  });
  expect(res.xlinkAbs, 'SVG image xlink:href must be absolutized (cover pages)').toBe(true);
  expect(res.imgRel, 'relative img src must be absolutized').toBe('http://folio-cache.localhost/abc123/OEBPS/text/pics/p1.jpeg');
  expect(res.imgAbsKept, 'absolute srcs stay untouched').toBe('https://already/abs.jpeg');
  expect(res.imgDataKept.startsWith('data:'), 'data: srcs stay untouched').toBe(true);
  expect(res.linkAbs, 'publisher link href must be absolutized').toBe('http://folio-cache.localhost/abc123/OEBPS/text/style.css');
  expect(res.baseAlone, 'no duplicate <base> injected when one exists').toBe(1);
});
