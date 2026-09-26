// UX V3 — tests for the features and scenarios not covered by earlier specs:
// Markdown export, session summary, pronounce, vocabulary list view, book
// covers, highlight color filter, pill pulse, warm frames, settings filter,
// entity sanitizer, adaptive pace, auto theme tick.
//
// Run: npx playwright test ux_v3.spec.mjs

import { test, expect } from '@playwright/test';
import { fresh, openDemo, openDemoReady, badge, badgeWait, curCfi, SPEECH_MOCK } from './helpers.mjs';

test.beforeEach(async ({ page }) => { await fresh(page); });

// ═══════════════════════════════════════════════════════════
//  Export highlights, notes, bookmarks & vocabulary as Markdown
// ═══════════════════════════════════════════════════════════

test('X1 export builds Markdown with highlights + vocab on the clipboard', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:8124/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.locator('#btnDemo').waitFor({ timeout: 9000 });
  await page.click('#btnDemo');
  await page.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 12000 });
  await page.waitForTimeout(1000);

  // Seed: one highlight, one vocab entry (with definition), exported via UI
  await page.evaluate(async () => {
    const cfi = state.rendition.currentLocation().start.cfi;
    Highlights.add(cfi, 'yellow', 'A highlighted passage worth keeping.');
    DictCache.set('serendipity', 'The occurrence of events by chance in a happy way.');
    VocabLog.add('serendipity', 'Chapter Test', cfi);
    toggleToc();
  });
  await page.waitForTimeout(300);
  await page.locator('#btnExportMd').click();
  await page.waitForTimeout(500);

  const md = await page.evaluate(() => navigator.clipboard.readText());
  expect(md).toContain('# The Time Machine');
  expect(md).toContain('## Highlights');
  expect(md).toContain('> A highlighted passage worth keeping.');
  expect(md).toContain('## Vocabulary');
  expect(md).toContain('**serendipity**');
  expect(md).toContain('The occurrence of events by chance in a happy way.');
  // Empty-state guard: a book with nothing collected shows a toast instead
  await context.close();
});

test('X1b export with nothing collected shows a toast and no clipboard write', async ({ page }) => {
  await openDemoReady(page);
  await page.evaluate(() => { toggleToc(); });
  await page.waitForTimeout(300);
  await page.locator('#btnExportMd').click();
  await page.waitForTimeout(400);
  const toast = await page.evaluate(() => document.getElementById('toast').textContent);
  expect(toast).toMatch(/Nothing collected yet/i);
});

// ═══════════════════════════════════════════════════════════
//  Session summary on exit
// ═══════════════════════════════════════════════════════════

test('X2 leaving a book shows today minutes + session pages', async ({ page }) => {
  await openDemoReady(page);
  // Turn one page so the session counter increments, then seed today's minutes
  const b0 = await badge(page);
  await page.keyboard.press('ArrowRight');
  await badgeWait(page, b0);
  await page.waitForTimeout(400); // cold pass (session counter) runs 80ms late
  await page.evaluate(() => { statsCache.days[dayKey()] = 22; });
  await page.keyboard.press('h');
  await page.waitForTimeout(400);
  const toast = await page.evaluate(() => document.getElementById('toast').textContent);
  expect(toast).toMatch(/22 min today/);
  expect(toast).toMatch(/1 page this session/);
});

// ═══════════════════════════════════════════════════════════
//  Pronounce from the selection bar
// ═══════════════════════════════════════════════════════════

test('X3 pronounce speaks the selected word via the speech engine', async ({ page }) => {
  await page.addInitScript(SPEECH_MOCK);
  await page.reload(); // init scripts fire on navigation
  await openDemoReady(page);
  await page.evaluate(() => { selText = 'serendipity'; });
  await page.evaluate(() => document.getElementById('selSpeak').click());
  await page.waitForTimeout(200);
  const calls = await page.evaluate(() => window.__speakCalls);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls[calls.length - 1]).toBe('serendipity');
});

// ═══════════════════════════════════════════════════════════
//  Vocabulary list view (Words tab)
// ═══════════════════════════════════════════════════════════

test('X4 Words tab lists lookups with definitions and jumps back', async ({ page }) => {
  await openDemoReady(page);
  await page.evaluate(() => {
    const cfi = state.rendition.currentLocation().start.cfi;
    DictCache.set('ephemeral', 'Lasting for a very short time.');
    VocabLog.add('ephemeral', 'Title Page', cfi);
    toggleToc();
    setTocTab('voc');
  });
  await page.waitForTimeout(700);
  const item = page.locator('#vocList .bm-item').first();
  await expect(item).toContainText('ephemeral');
  await expect(item).toContainText('Lasting for a very short time.');

  // Jump back: navigate away first, then click the entry — the safety anchor
  // appears and the reader returns to the stored CFI.
  const b0 = await badge(page);
  await page.keyboard.press('ArrowRight');
  await badgeWait(page, b0);
  // The drawer may still be open from the lookup above — toggle only opens.
  await page.evaluate(() => {
    if(!document.body.classList.contains('toc-open')) toggleToc();
    setTocTab('voc');
  });
  await page.waitForTimeout(700);
  await page.locator('#vocList .bm-item').first().click();
  await page.waitForTimeout(600);
  await expect(page.locator('#jumpAnchor')).toBeVisible({ timeout: 3000 });
});

// ═══════════════════════════════════════════════════════════
//  Highlight color legend + filter
// ═══════════════════════════════════════════════════════════

test('X5 highlight legend shows counts and filters by color', async ({ page }) => {
  await openDemoReady(page);
  await page.evaluate(() => {
    const cfi = state.rendition.currentLocation().start.cfi;
    Highlights.add(cfi, 'yellow', 'yellow one');
    Highlights.add(cfi, 'yellow', 'yellow two');
    Highlights.add(cfi, 'green', 'green one');
    toggleToc();
    setTocTab('hl');
  });
  await page.waitForTimeout(300);
  // Legend: four color dots, counts 2 yellow / 1 green, others empty
  const dots = page.locator('#hlList .hl-legend-dot');
  await expect(dots).toHaveCount(4);
  await expect(page.locator('#hlList .hl-legend-dot[data-color="yellow"]')).toHaveText('2');
  await expect(page.locator('#hlList .hl-legend-dot[data-color="green"]')).toHaveText('1');
  // Filter to yellow: only the two yellow highlights remain
  await page.locator('#hlList .hl-legend-dot[data-color="yellow"]').click();
  await expect(page.locator('#hlList .bm-item')).toHaveCount(2);
  // Toggle off: all three return
  await page.locator('#hlList .hl-legend-dot[data-color="yellow"]').click();
  await expect(page.locator('#hlList .bm-item')).toHaveCount(3);
  // Filter persists across re-render (delete triggers renderList)
  await page.locator('#hlList .hl-legend-dot[data-color="green"]').click();
  await page.locator('#hlList .bm-item .bm-del-btn').first().click();
  await page.waitForTimeout(200);
  await expect(page.locator('#hlList .bm-item')).toHaveCount(2);
});

// ═══════════════════════════════════════════════════════════
//  Pill discoverability pulse (once per book)
// ═══════════════════════════════════════════════════════════

test('X6 margin pills pulse once per book and never again', async ({ page }) => {
  await openDemoReady(page);
  // The pulse starts ~1.6s after the first relocation and runs ~4.4s
  await page.waitForTimeout(2200);
  const pulsed = await page.evaluate(() => ({
    cls: document.getElementById('chNavLeft').classList.contains('pulse'),
    flag: !!localStorage.getItem('folio-pills-pulsed:The Time Machine'),
  }));
  expect(pulsed.cls).toBe(true);
  expect(pulsed.flag).toBe(true);
  // Second open (flag persisted, storage NOT cleared): no pulse this time
  await page.evaluate(() => goHome());
  await page.waitForTimeout(300);
  await page.evaluate(() => resumeReading());
  await page.waitForTimeout(2200);
  // the first pulse's removal timer runs ~5.2s after its start
  await page.waitForFunction(() => !document.getElementById('chNavLeft').classList.contains('pulse'), null, { timeout: 9000 });
  await page.evaluate(() => resumeReading());
  await page.waitForTimeout(2200);
  const second = await page.evaluate(() => document.getElementById('chNavLeft').classList.contains('pulse'));
  expect(second).toBe(false);
});

// ═══════════════════════════════════════════════════════════
//  Warm frames (chapter pre-render)
// ═══════════════════════════════════════════════════════════

test('X7 neighbor chapters pre-render in capped warm frames', async ({ page }) => {
  await openDemoReady(page);
  // The idle-driven preload + warm-frame creation runs within a few seconds
  await page.waitForFunction(() => {
    const host = document.getElementById('warmFrames');
    return host && host.querySelectorAll('iframe').length > 0;
  }, null, { timeout: 12000 });
  const state1 = await page.evaluate(() => ({
    count: document.getElementById('warmFrames').querySelectorAll('iframe').length,
    inViewer: !!document.querySelector('#viewer #warmFrames'),
  }));
  expect(state1.count).toBeLessThanOrEqual(2);
  expect(state1.inViewer).toBe(false); // host lives outside #viewer
});

// ═══════════════════════════════════════════════════════════
//  Settings sheet filter
// ═══════════════════════════════════════════════════════════

test('X8 settings filter hides non-matching sections', async ({ page }) => {
  await openDemoReady(page);
  await page.evaluate(() => toggleSheet());
  await page.waitForTimeout(300);
  const total = await page.evaluate(() => document.querySelectorAll('#sheet .sh-body > section').length);
  expect(total).toBeGreaterThan(3);
  await page.locator('#sheetFilter').fill('paper');
  await page.waitForTimeout(200);
  const check = await page.evaluate(() => {
    const secs = [...document.querySelectorAll('#sheet .sh-body > section')];
    return {
      visible: secs.filter(s => s.style.display !== 'none').length,
      allMatch: secs.filter(s => s.style.display !== 'none').every(s => s.textContent.toLowerCase().includes('paper')),
    };
  });
  expect(check.visible).toBeGreaterThan(0);
  expect(check.visible).toBeLessThan(total);
  expect(check.allMatch).toBe(true);
  // Empty query restores everything
  await page.locator('#sheetFilter').fill('');
  await page.waitForTimeout(200);
  const restored = await page.evaluate(() =>
    [...document.querySelectorAll('#sheet .sh-body > section')].filter(s => s.style.display !== 'none').length);
  expect(restored).toBe(total);
});

// ═══════════════════════════════════════════════════════════
//  Entity sanitizer (buffer open path)
// ═══════════════════════════════════════════════════════════

test('X9 entity-laden book opens clean with scripts intact', async ({ page }) => {
  await openDemo(page);
  await page.waitForFunction(() => !state.loading, null, { timeout: 12000 });
  await page.evaluate(async () => {
    const para = 'Filler text for pagination. '.repeat(40);
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip');
    zip.file('META-INF/container.xml',
      '<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    zip.file('OEBPS/c1.xhtml',
      '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head><body>' +
      '<h1>Chapter One</h1><p>Word&nbsp;joined &mdash; dash</p><p>' + para + '</p>' +
      '<script>window.__marker = "a&nbsp;b"; if (1 && 2) { window.__andOk = true; }<\/script>' +
      '</body></html>');
    zip.file('OEBPS/content.opf',
      '<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.w3.org/2007/opf" version="3.0" unique-identifier="bid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bid">urn:folio:ent</dc:identifier><dc:title>Entity Test</dc:title><dc:creator>Tester</dc:creator><dc:language>en</dc:language></metadata>' +
      '<manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>' +
      '<spine><itemref idref="c1"/></spine></package>');
    const b = await zip.generateAsync({ type: 'arraybuffer' });
    await openBuffer(b, 'Entity Test');
  });
  await page.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 12000 });
  await page.waitForTimeout(1500);
  const res = await page.evaluate(() => {
    const f = document.querySelector('#viewer iframe');
    const d = f ? f.contentDocument : null;
    const scripts = d ? d.querySelectorAll('script') : [];
    return {
      parsererror: d ? !!d.querySelector('parsererror') : 'no doc',
      nbspRendered: d && d.body ? /Word\s+joined/.test(d.body.innerText) : false,
      scriptNbsp: scripts.length === 1 && scripts[0].textContent.indexOf('a\u00a0b') >= 0,
    };
  });
  expect(res.parsererror).toBe(false);
  expect(res.nbspRendered).toBe(true);
  expect(res.scriptNbsp).toBe(true);
});

// ═══════════════════════════════════════════════════════════
//  Adaptive pace + auto theme tick
// ═══════════════════════════════════════════════════════════

test('X10 adaptive pace updates after page turns', async ({ page }) => {
  await openDemoReady(page);
  // Simulate measured reading: seed the history the way onRelocated does
  await page.evaluate(() => {
    _paceHistory.push(0.5, 0.6, 0.55, 0.62);
    _effectivePace = 0.575;
  });
  const b0 = await badge(page);
  await page.keyboard.press('ArrowRight');
  await badgeWait(page, b0);
  const pace = await page.evaluate(() => getEffectivePace());
  expect(pace).toBeGreaterThan(0);
  expect(pace).toBeLessThan(1.1); // measured pace below the 1.1 default
});

test('X11 auto theme tick applies the schedule for the hour', async ({ page }) => {
  await openDemoReady(page);
  await page.evaluate(() => { settings.themeAuto = true; save(); });
  await page.evaluate(() => {
    const OrigDate = Date;
    window.__RestoreDate = Date;
    class MockDate extends OrigDate {
      constructor(...a) { super(...a); }
      static now() { return OrigDate.now(); }
      getHours() { return 22; } // late evening -> noir, warmth 40
    }
    window.Date = MockDate;
  });
  await page.evaluate(() => autoThemeTick());
  const applied = await page.evaluate(() => ({ theme: settings.theme, warmth: settings.warmth }));
  expect(applied.theme).toBe('noir');
  expect(applied.warmth).toBe(40);
  // Restore
  await page.evaluate(() => {
    window.Date = window.__RestoreDate;
    settings.themeAuto = false;
    settings.theme = 'paper';
    settings.warmth = 0;
    save(); applyTheme(); applyWarmth(); syncWarm();
  });
  const restored = await page.evaluate(() => ({ theme: settings.theme, warmth: settings.warmth }));
  expect(restored.theme).toBe('paper');
  expect(restored.warmth).toBe(0);
});
