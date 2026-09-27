// Book-switch lifecycle suite (BS-*): per-book caches, deferred work, turn
// state, gestures, and speech must not leak from the closed book into the
// next one. Uses tiny in-page-built EPUBs so switches run in seconds.
import { test, expect } from '@playwright/test';
import { fresh, viewerFrame, SPEECH_MOCK } from './helpers.mjs';

test.beforeEach(async ({ page }) => { await fresh(page); });

async function tinyBook(page, title, word) {
  return page.evaluate(async ({ title, word }) => {
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml',
      '<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" ' +
      'xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>' +
      '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>' +
      '</rootfiles></container>');
    const para = `${word} ${word} ${word} `.repeat(120);
    zip.file('OEBPS/ch.xhtml',
      '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml">' +
      `<head><title>${title}</title></head><body><h1>${title}</h1><p>${para}</p></body></html>`);
    zip.file('OEBPS/content.opf',
      '<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" ' +
      'version="3.0" unique-identifier="bid">\n<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      `<dc:identifier id="bid">urn:folio:test:${title}</dc:identifier>` +
      `<dc:title>${title}</dc:title><dc:language>en</dc:language></metadata>\n` +
      '<manifest><item id="ch" href="ch.xhtml" media-type="application/xhtml+xml"/></manifest>\n' +
      '<spine><itemref idref="ch"/></spine>\n</package>');
    return zip.generateAsync({ type: 'arraybuffer' }).then((buf) => {
      window.__tinyBuf = buf;
      return buf.byteLength;
    });
  }, { title, word });
}

async function openTiny(page, title, word) {
  await tinyBook(page, title, word);
  await page.evaluate((t) => openBuffer(window.__tinyBuf, t), title);
  await page.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 12000 });
  await page.waitForFunction((t) => {
    try { return state.currentTitle === t && !!document.querySelector('#viewer iframe'); }
    catch (e) { return false; }
  }, title, { timeout: 12000 });
}

const pos = (page) => page.evaluate(() => {
  try {
    const l = state.rendition.currentLocation();
    return l && l.start ? `${l.start.index}#${l.start.displayed ? l.start.displayed.page : 0}` : null;
  } catch (e) { return null; }
});

test('BS1 switched book inherits no chapter text or HTML', async ({ page }) => {
  await openTiny(page, 'SwitchA', 'alpha-one');
  // Force the caches to fill for book A (a turn drives update/harvest).
  await page.evaluate(() => turn(1).catch(() => {}));
  await page.waitForFunction(() => {
    try { return pageCache.chapterTexts.size > 0 || pageCache.chapterHtmls.size > 0; }
    catch (e) { return false; }
  }, null, { timeout: 9000 }).catch(() => {});
  await openTiny(page, 'SwitchB', 'beta-two');
  await page.waitForFunction(() => (document.getElementById('pct') || {}).textContent !== '', null, { timeout: 9000 });
  const leak = await page.evaluate(() => ({
    texts: [...pageCache.chapterTexts.values()].filter((t) => (t || '').includes('alpha-one')),
    htmls: [...pageCache.chapterHtmls.values()].filter((h) => (h || '').includes('alpha-one')),
    cached: (pageCache.cachedChapterHtml || '').includes('alpha-one'),
  }));
  expect(leak.texts).toEqual([]);
  expect(leak.htmls).toEqual([]);
  expect(leak.cached).toBe(false);
});

test('BS2 return-anchor history resets on open', async ({ page }) => {
  await openTiny(page, 'SwitchA', 'alpha-one');
  await page.evaluate(() => NavHistory.push('epubcfi(/6/2!/4/2)', 'Page 1', 'Ch One'));
  expect(await page.evaluate(() => NavHistory.stack.length)).toBe(1);
  await openTiny(page, 'SwitchB', 'beta-two');
  expect(await page.evaluate(() => NavHistory.stack.length)).toBe(0);
  expect(await page.evaluate(() => document.getElementById('jumpAnchor').className)).toMatch(/hide/);
});

test('BS3 stuck turn flags clear and navigation works after switch', async ({ page }) => {
  await openTiny(page, 'SwitchA', 'alpha-one');
  await page.evaluate(() => {
    state.turning = true; turnQueue = 2;
    document.body.classList.add('turning');
  });
  await openTiny(page, 'SwitchB', 'beta-two');
  const st = await page.evaluate(() => ({
    turning: state.turning, queue: turnQueue,
    cls: document.body.className, recreating: state.recreating, settling: state.settling,
  }));
  expect(st.turning).toBe(false);
  expect(st.queue).toBe(0);
  expect(st.cls).not.toMatch(/turning/);
  expect(st.recreating).toBe(false);
  expect(st.settling).toBe(false);
  // Navigation is live immediately on the new book.
  const p0 = await pos(page);
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction((k) => {
    try {
      const l = state.rendition.currentLocation();
      const cur = l && l.start ? `${l.start.index}#${l.start.displayed ? l.start.displayed.page : 0}` : null;
      return cur && cur !== k && !document.body.classList.contains('turning');
    } catch (e) { return false; }
  }, p0, { timeout: 9000 });
});

test('BS4 pointer down on old book cannot turn the new one', async ({ page }) => {
  await openTiny(page, 'SwitchA', 'alpha-one');
  const frame = await viewerFrame(page);
  await frame.evaluate(() => {
    const tgt = document.elementFromPoint(300, 300) || document.body;
    tgt.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, clientX: 300, clientY: 300,
      button: 0, buttons: 1, pointerId: 7, pointerType: 'mouse', isPrimary: true,
    }));
  });
  expect(await page.evaluate(() => !!turnGesture.startTime)).toBe(true);
  await openTiny(page, 'SwitchB', 'beta-two');
  const p0 = await pos(page);
  // Late release from the old gesture must be a no-op (no capture, no turn).
  await frame.evaluate(() => {
    const tgt = document.elementFromPoint(300, 300) || document.body;
    tgt.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, clientX: 300, clientY: 300,
      button: 0, buttons: 0, pointerId: 7, pointerType: 'mouse', isPrimary: true,
    }));
  }).catch(() => {});
  await page.evaluate(() => {
    const tgt = document.elementFromPoint(680, 430) || document.body;
    tgt.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, clientX: 680, clientY: 430,
      button: 0, buttons: 0, pointerId: 7, pointerType: 'mouse', isPrimary: true,
    }));
  });
  await page.waitForTimeout(900);
  await page.waitForFunction(() => !document.body.classList.contains('turning'), null, { timeout: 5000 });
  expect(await pos(page)).toBe(p0);
  expect(await page.evaluate(() => !!document.querySelector('.pt-drag-capture'))).toBe(false);
  expect(await page.evaluate(() => !!document.querySelector('.pt-compositor'))).toBe(false);
});

test('BS5 speech stops hard on switch and timeouts are generation-gated', async ({ page }) => {
  await page.addInitScript(SPEECH_MOCK);
  await fresh(page);
  await openTiny(page, 'SwitchA', 'alpha-one');
  const g0 = await page.evaluate(() => TTS.gen);
  await page.evaluate(() => TTS.toggle());
  await page.waitForFunction(() => (window.__speakCalls || []).length > 0, null, { timeout: 12000 });
  await openTiny(page, 'SwitchB', 'beta-two');
  const st = await page.evaluate(() => ({
    gen: TTS.gen, active: TTS.active, sents: TTS.sents.length, speak: window.__speakCalls.length,
  }));
  expect(st.gen).toBeGreaterThan(g0);
  expect(st.active).toBe(false);
  expect(st.sents).toBe(0);
  // Stale pre-stop timeouts must not speak into the new book.
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => window.__speakCalls.length)).toBe(st.speak);
});
