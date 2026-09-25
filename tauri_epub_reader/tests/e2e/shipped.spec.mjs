import { test, expect } from '@playwright/test';
import {
  fresh, openDemo, openDemoReady, badge, badgeWait,
  viewerFrame, SPEECH_MOCK, buildTestEpub, tauriBootScript,
} from './helpers.mjs';

test.beforeEach(async ({ page }) => { await fresh(page); });

test('R1 book opens, badge shows global pages', async ({ page }) => {
  await openDemo(page);
  await page.waitForFunction(
    () => /Page \d+ of \d+/.test(document.getElementById('pageBadge').textContent || ''),
    null, { timeout: 12000 });
  const ready = await page.evaluate(() => typeof LocEngine !== 'undefined' && LocEngine.ready());
  expect(ready).toBe(true);
});

test('R2 locations persist, second open skips generate()', async ({ page }) => {
  await openDemo(page);
  await page.waitForFunction(() => typeof LocEngine !== 'undefined' && LocEngine.ready(), null, { timeout: 12000 });
  const key = await page.evaluate(() => localStorage.getItem('folio-locs:The Time Machine'));
  expect(key).toBeTruthy();
  // Reload; install the generate() counter the moment the book object exists,
  // before the idle-scheduled ensure() can run.
  await page.reload();
  await page.click('#btnDemo');
  const wrapped = await page.evaluate(async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 9000) {
      if (typeof state !== 'undefined' && state.book && state.book.locations && !state.book.locations.__w) {
        state.book.locations.__w = true;
        const o = state.book.locations.generate.bind(state.book.locations);
        window.__genCalls = 0;
        state.book.locations.generate = (...a) => { window.__genCalls++; return o(...a); };
        return 'wrapped';
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return 'timeout';
  });
  expect(wrapped).toBe('wrapped');
  await page.waitForFunction(() => typeof LocEngine !== 'undefined' && LocEngine.ready(), null, { timeout: 12000 });
  expect(await page.evaluate(() => window.__genCalls)).toBe(0);
});

test('R3 keyboard and wheel turns (window + iframe)', async ({ page }) => {
  await openDemoReady(page);
  // Badge numbers follow 1000-char locations, so a turn landing inside the
  // same chunk keeps its number (correct per LocEngine.forCfi containment).
  // Navigation itself is asserted via rendition CFI advancement per input.
  const cfi = () => page.evaluate(() => state.rendition.currentLocation().start.cfi);
  const b0 = await badge(page);
  await page.keyboard.press('ArrowRight');
  const b1 = await badgeWait(page, b0);
  expect(b1).not.toBe(b0);
  let prev = await cfi();
  await page.mouse.move(680, 430);
  await page.mouse.wheel(0, 240);
  await page.waitForFunction((p) => {
    const l = state.rendition.currentLocation();
    return l && l.start && String(l.start.cfi) !== p;
  }, prev, { timeout: 9000 });
  prev = await cfi();
  const frame = await viewerFrame(page);
  await frame.evaluate(() => {
    document.dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction((p) => {
    const l = state.rendition.currentLocation();
    return l && l.start && String(l.start.cfi) !== p;
  }, prev, { timeout: 9000 });
});

test('R4 rail scrub seeks and clamps', async ({ page }) => {
  await openDemoReady(page);
  const b0 = await badge(page);
  await page.evaluate(() => railSeek(0.5));
  const b1 = await badgeWait(page, b0);
  expect(b1).not.toBe(b0);
  await page.evaluate(() => railSeek(1));
  const bend = await badgeWait(page, b1);
  // End-jump clamps: current page never exceeds total (single or spread form).
  const m = bend.match(/Pages? (\d+)(?:–(\d+))? of (\d+)/);
  expect(m).toBeTruthy();
  expect(parseInt(m[2] || m[1], 10)).toBeLessThanOrEqual(parseInt(m[3], 10));
  await page.evaluate(() => railSeek(0));
  const b0again = await badgeWait(page, bend);
  expect(b0again).toMatch(/^Pages? 1([–-]\d+)? of \d+$/);
});

test('R5 TTS lifecycle with mocked synth', async ({ page }) => {
  await page.addInitScript(SPEECH_MOCK);
  await fresh(page);
  await openDemo(page);
  await page.evaluate(() => TTS.toggle());
  await page.waitForFunction(
    () => typeof TTS !== 'undefined' && TTS.sents.length > 0 && window.__speakCalls.length > 0,
    null, { timeout: 12000 });
  const first = await page.evaluate(() => ({
    spoken: window.__speakCalls[0],
    sent: TTS.sents[0].text,
  }));
  expect(first.spoken).toBe(first.sent);
  await page.evaluate(() => TTS.toggle());
  expect(await page.evaluate(() => TTS.paused)).toBe(true);
  await page.evaluate(() => TTS.stop());
  const st = await page.evaluate(() => ({ active: TTS.active, hl: TTS.hl }));
  expect(st.active).toBe(false);
  expect(st.hl).toBeNull();
});

test.describe('R6 TTS auto-advance', () => {
  // Narrow viewport = single-page mode, where the true last page is
  // reachable (in spread, epub.js no-ops next() at the final partial spread,
  // so no last page exists to stop on — verified by probe).
  test.use({ viewport: { width: 700, height: 860 } });
  test('calls turn once, stops at book end', async ({ page }) => {
    await page.addInitScript(SPEECH_MOCK);
    await fresh(page);
    await openDemo(page);
    await page.evaluate(() => {
      window.__turnCalls = [];
      window.__turnOrig = window.turn;
      window.turn = async () => { window.__turnCalls.push(1); };
    });
    await page.evaluate(() => TTS.toggle());
    await page.waitForFunction(() => (window.__turnCalls || []).length >= 1, null, { timeout: 12000 });
    expect(await page.evaluate(() => window.__turnCalls.length)).toBe(1);
    // End case: restore the real turn and let TTS walk to the true last page
    // via its natural relocated → speak → autoAdvance loop, then stop.
    await page.evaluate(() => { window.turn = window.__turnOrig; });
    await page.evaluate(() => railSeek(1));
    await page.waitForFunction(() => typeof TTS !== 'undefined' && TTS.active === false, null, { timeout: 12000 });
    expect(await page.evaluate(() => window.__turnCalls.length)).toBe(1);
  });
});

test('R7 highlight add, list, jump', async ({ page }) => {
  await openDemoReady(page);
  const cfi = await page.evaluate(() => state.rendition.currentLocation().start.cfi);
  await page.evaluate(() => { window.__displayCalls = []; });
  await page.evaluate(() => {
    const r = state.rendition, o = r.display.bind(r);
    r.display = (...a) => { window.__displayCalls.push(a[0]); return o(...a); };
  });
  await page.evaluate((c) => state.rendition.emit('selected', c), cfi);
  expect(await page.evaluate(() => Highlights.lastCfi)).toBe(cfi);
  await page.evaluate(() => { selText = 'test snippet'; document.getElementById('selHl').click(); });
  await page.evaluate(() => document.querySelector('#selHlPal .hl-dot[data-hl="yellow"]').click());
  const n = await page.evaluate(() => JSON.parse(localStorage.getItem('folio-highlights') || '[]').length);
  expect(n).toBe(1);
  expect(await page.evaluate(() => document.getElementById('hlCountBadge').textContent)).toBe('1');
  await page.evaluate(() => { toggleToc(); setTocTab('hl'); });
  await expect(page.locator('#hlList .bm-item')).toHaveCount(1);
  await page.locator('#hlList .bm-item').click();
  await page.waitForFunction(() => (window.__displayCalls || []).length >= 1, null, { timeout: 9000 });
  expect(await page.evaluate(() => window.__displayCalls[0])).toBe(cfi);
});

test('R8 highlight popup recolor and delete', async ({ page }) => {
  await openDemoReady(page);
  const id = await page.evaluate(() => {
    const cfi = state.rendition.currentLocation().start.cfi;
    Highlights.add(cfi, 'yellow', 'snip');
    const all = JSON.parse(localStorage.getItem('folio-highlights') || '[]');
    return all.length ? all[0].id : null;
  });
  expect(id).toBeTruthy();
  await page.evaluate(() => { window.__addCalls = 0; });
  await page.evaluate(() => {
    const a = state.rendition.annotations, o = a.add.bind(a);
    a.add = (...a2) => { window.__addCalls++; return o(...a2); };
  });
  await page.evaluate((pid) => Highlights.openPop(pid, { clientX: 400, clientY: 300 }), id);
  await expect(page.locator('#hlPop')).toBeVisible();
  const box = await page.locator('#hlPop').boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1360);
  await page.click('#hlPop .hl-dot[data-hl="green"]');
  expect(await page.evaluate(() => window.__addCalls)).toBeGreaterThan(0);
  await page.click('#hlPop [data-act="del"]');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('folio-highlights') || '[]').length)).toBe(0);
});

test('R9 warmth slider, reset, persistence', async ({ page }) => {
  await fresh(page);
  await page.evaluate(() => {
    const r = document.getElementById('warmRange');
    r.value = 60;
    r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => parseFloat(document.getElementById('warm').style.opacity || '0') > 0, null, { timeout: 5000 });
  await page.waitForFunction(() => {
    try { return JSON.parse(localStorage.getItem('folio-settings') || '{}').warmth === 60; }
    catch (e) { return false; }
  }, null, { timeout: 5000 });
  await page.evaluate(() => document.getElementById('warmOff').click());
  expect(await page.evaluate(() => document.getElementById('warm').style.opacity)).toBe('0');
});

test('R10 per-book typography memory', async ({ page }) => {
  await openDemoReady(page);
  const title = await page.evaluate(() => getActiveTitle());
  await page.evaluate(() => { settings.perBookType = true; settings.size = 21; save(); });
  await page.waitForFunction((t) => {
    try {
      const raw = localStorage.getItem('folio-typo:' + t);
      return raw && JSON.parse(raw).size === 21;
    } catch (e) { return false; }
  }, title, { timeout: 9000 });
  const before = await page.evaluate(() => localStorage.getItem('folio-settings'));
  await page.evaluate(() => { settings.size = 17; });
  await page.evaluate((t) => loadPerBookType(t), title);
  expect(await page.evaluate(() => settings.size)).toBe(21);
  expect(await page.evaluate(() => localStorage.getItem('folio-settings'))).toBe(before);
});

test('R11 footnote popup opens and closes', async ({ page }) => {
  await openDemoReady(page);
  const frame = await viewerFrame(page);
  await frame.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend',
      '<p>See note <a href="#fn1">1</a>.</p><p id="fn1">note text</p>');
  });
  await frame.locator('a[href="#fn1"]').click();
  await expect(page.locator('#fnPop.show')).toBeVisible();
  expect(await page.locator('#fnPop.show').textContent()).toContain('note text');
  await page.mouse.click(40, 400);
  await expect(page.locator('#fnPop.show')).toHaveCount(0);
});

test('R12 image lightbox opens and closes', async ({ page }) => {
  await openDemoReady(page);
  const frame = await viewerFrame(page);
  const src = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///////yH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  await frame.evaluate((s) => {
    const im = document.createElement('img');
    im.src = s; im.className = 'test-lb'; im.style.cssText = 'width:40px;height:40px';
    document.body.appendChild(im);
  }, src);
  await frame.locator('img.test-lb').click();
  await expect(page.locator('#lightbox.show')).toBeVisible();
  expect(await page.locator('#lightbox.show img').getAttribute('src')).toBe(src);
  await page.keyboard.press('Escape');
  await expect(page.locator('#lightbox.show')).toHaveCount(0);
});

test('R13 dictionary cache: network then offline', async ({ page }) => {
  await openDemoReady(page);
  await page.route('**/api.dictionaryapi.dev/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{ meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'a test' }] }] }]),
  }));
  await page.evaluate(() => { selText = 'test'; document.getElementById('selDefine').click(); });
  await page.waitForFunction(
    () => (document.getElementById('selDef') || {}).textContent === '(noun) a test',
    null, { timeout: 9000 });
  expect(await page.evaluate(() => localStorage.getItem('folio-dict:test'))).toBe('(noun) a test');
  await page.unrouteAll({ behavior: 'wait' });
  await page.route('**/api.dictionaryapi.dev/**', (route) => route.abort());
  await page.evaluate(() => { selText = 'test'; document.getElementById('selDefine').click(); });
  await page.waitForFunction(
    () => (document.getElementById('selDef') || {}).textContent === '(noun) a test',
    null, { timeout: 9000 });
});

test('R14 closed drawers leave no hit-testable chrome', async ({ page }) => {
  await openDemoReady(page);
  const hit = () => page.evaluate(() => {
    const t = document.elementFromPoint(27, 38);
    if (!t || !t.closest) return 'OK-none';
    if (t.closest('#tocClose,#searchClose,#sheetClose,#helpClose')) return 'BAD-closebtn';
    if ((t.tagName === 'svg' || t.tagName === 'path') && t.closest('#toc,#searchDrawer,#sheet,#helpOverlay')) return 'BAD-svg';
    return 'OK-' + t.tagName;
  });
  expect(await hit()).toMatch(/^OK-/);
  await page.evaluate(() => { toggleToc(); closePanels(); });
  await page.waitForTimeout(700);
  expect(await hit()).toMatch(/^OK-/);
  await page.evaluate(() => { openSearch(); closePanels(); });
  await page.waitForTimeout(700);
  expect(await hit()).toMatch(/^OK-/);
  await page.evaluate(() => { toggleSheet(); closePanels(); });
  await page.waitForTimeout(700);
  expect(await hit()).toMatch(/^OK-/);
});

test('R15 boot-open via faked Tauri backend', async ({ page }) => {
  const bytes = buildTestEpub();
  await page.addInitScript(tauriBootScript(bytes));
  await page.goto('/');
  await page.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 12000 });
  expect(await page.locator('#bookTitle').textContent()).toBe('B Test');
});

test('R16 middle-click autoscroll', async ({ page }) => {
  await openDemoReady(page);
  await page.evaluate(() => {
    window.__nextCalls = 0;
    const r = state.rendition, o = r.next.bind(r);
    r.next = (...a) => { window.__nextCalls++; return o(...a); };
  });
  await page.mouse.click(680, 430, { button: 'middle' });
  expect(await page.evaluate(() => AutoScroll.active)).toBe(true);
  await page.mouse.move(680, 560);
  await page.waitForFunction(() => (window.__nextCalls || 0) >= 1, null, { timeout: 9000 });
  expect(await page.evaluate(() => window.__nextCalls)).toBe(1);
  await page.mouse.click(680, 560, { button: 'left' });
  expect(await page.evaluate(() => AutoScroll.active)).toBe(false);
});
