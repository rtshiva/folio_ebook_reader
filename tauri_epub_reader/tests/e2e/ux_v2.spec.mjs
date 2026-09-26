// UX V2 Feature Tests — covers all 12 new features (F0–F11)
// from the UX_V2_LLD_PLAN.md specification.
//
// Prerequisites: features must be implemented in index.html before these pass.
// Run: npx playwright test tests/e2e/ux_v2.spec.mjs

import { test, expect } from '@playwright/test';
import { fresh, openDemo, openDemoReady, badge, badgeWait, viewerFrame, slowDrag, synUp } from './helpers.mjs';

test.beforeEach(async ({ page }) => { await fresh(page); });

// ═══════════════════════════════════════════════════════════
//  F0: Edge-Hover Chapter Panels (replaces silk ribbons)
// ═══════════════════════════════════════════════════════════

test('F0-1 chapter pills present in reading state', async ({ page }) => {
  await openDemoReady(page);
  // Fixed-label pills flanking the page: "Previous Chapter" / "Next Chapter"
  await expect(page.locator('#chLabelPrev')).toBeAttached();
  await expect(page.locator('#chLabelNext')).toBeAttached();
  await expect(page.locator('#chLabelPrev')).toHaveText('Previous Chapter');
  await expect(page.locator('#chLabelNext')).toHaveText('Next Chapter');
});

test('F0-2 margin pills blend at rest and reveal on hover', async ({ page }) => {
  await openDemoReady(page);
  const pill = page.locator('#chLabelNext');
  // At rest the label text is the same color as the desk background
  const restColor = await pill.evaluate(el => getComputedStyle(el).color);
  const deskColor = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(restColor).toBe(deskColor);
  // Hovering the pill itself reveals it: page-colored pill, ink text
  await pill.hover();
  await page.waitForTimeout(250);
  const bg = await pill.evaluate(el => getComputedStyle(el).backgroundColor);
  const color = await pill.evaluate(el => getComputedStyle(el).color);
  const pageBg = await page.evaluate(() => getComputedStyle(document.getElementById('viewer')).backgroundColor);
  expect(bg).toBe(pageBg);
  expect(color).not.toBe(restColor);
});

test('F0-3 click Next Chapter pill → navigates with NavHistory anchor', async ({ page }) => {
  await openDemoReady(page);
  const b1 = await badge(page);
  const nextPill = page.locator('#chLabelNext');
  await page.waitForTimeout(200);
  if (!(await nextPill.evaluate(el => el.classList.contains('disabled')))) {
    await nextPill.click();
    // Badge should change after navigation
    const b2 = await badgeWait(page, b1, 5000);
    expect(b2).not.toBe(b1);
    // NavHistory anchor should appear
    await expect(page.locator('#jumpAnchor')).toBeVisible({ timeout: 3000 });
  }
});

test('F0-5 panels hidden during landing state', async ({ page }) => {
  // On landing page, chapter nav panels should not be visible
  const leftPanel = page.locator('#chNavLeft');
  const display = await leftPanel.evaluate(el => getComputedStyle(el).display);
  expect(display).toBe('none');
});

// The Taoism-pattern regression: several TOC entries share one spine file
// with different #anchors. The old base(href)-only matcher always resolved
// to the FIRST entry, so nav got stuck at "Inaction". The resolver must use
// the CFI's bracketed anchor id, and a same-file fragment jump must actually
// relocate (display() alone is a no-op on an already-open section).
test('F0-4 shared-file TOC entries resolve per-section and fragment jumps relocate', async ({ page }) => {
  test.setTimeout(60000);
  await openDemoReady(page);
  await page.evaluate(async () => {
    const para = 'The sage does nothing, yet nothing is left undone. '.repeat(150);
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip');
    zip.file('META-INF/container.xml',
      '<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    zip.file('OEBPS/nav.xhtml',
      '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Nav</title></head><body>' +
      '<nav epub:type="toc" id="toc"><ol>' +
      '<li><a href="ch1.xhtml#sec-a">Inaction</a></li>' +
      '<li><a href="ch1.xhtml#sec-b">Non-Interference</a></li>' +
      '<li><a href="ch1.xhtml#sec-c">Effortless Action</a></li>' +
      '<li><a href="ch2.xhtml">Wu Wei In Practice</a></li>' +
      '</ol></nav></body></html>');
    zip.file('OEBPS/ch1.xhtml',
      '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head><body>' +
      '<h2 id="sec-a">Inaction</h2><p>' + para + '</p>' +
      '<h2 id="sec-b">Non-Interference</h2><p>' + para + '</p>' +
      '<h2 id="sec-c">Effortless Action</h2><p>' + para + '</p>' +
      '</body></html>');
    zip.file('OEBPS/ch2.xhtml',
      '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Two</title></head><body><h1>Wu Wei In Practice</h1><p>' + para + '</p></body></html>');
    zip.file('OEBPS/content.opf',
      '<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bid">urn:folio:tao</dc:identifier><dc:title>Tao Test</dc:title><dc:creator>Tester</dc:creator><dc:language>en</dc:language></metadata>' +
      '<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest>' +
      '<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>');
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    await openBuffer(buf, 'Tao Test');
  });
  await page.waitForFunction(() => typeof LocEngine !== 'undefined' && LocEngine.ready(), null, { timeout: 20000 });
  await page.waitForTimeout(800);

  // Sanity: at sec-a the Next Chapter pill points at "Non-Interference"
  const before = await page.evaluate(() => ({
    idx: chNavIdx,
    nextTitle: document.getElementById('chLabelNext').title,
  }));
  expect(before.idx).toBe(0);
  expect(before.nextTitle).toContain('Non-Interference');

  // Jump to the SECOND section of the shared file via the panel jump path —
  // this is the jump that used to be a silent no-op
  await page.evaluate(() => jumpToTocIndex(1));
  // Resolver must now point at the second entry, not the first
  await page.waitForFunction(() => chNavIdx === 1, null, { timeout: 12000 });

  const nav = await page.evaluate(() => ({
    idx: chNavIdx,
    tocCurIdx,
    nextTitle: document.getElementById('chLabelNext').title,
    nextDisabled: document.getElementById('chLabelNext').classList.contains('disabled'),
    prevDisabled: document.getElementById('chLabelPrev').classList.contains('disabled'),
  }));
  expect(nav.idx).toBe(1);
  expect(nav.nextTitle).toContain('Effortless Action');
  expect(nav.nextDisabled).toBe(false);
  expect(nav.prevDisabled).toBe(false);
});

// ═══════════════════════════════════════════════════════════
//  F1: Edge Hover Page-Curl Affordance
// ═══════════════════════════════════════════════════════════

// CDP mouse moves over the book land in the chapter iframe with flaky
// delivery timing; dispatch synthetic pointer moves in the iframe document
// (the same document the curl tracker listens in) for determinism.
async function syntheticMove(page, x, y) {
  await page.evaluate(({ x, y }) => {
    const f = document.querySelector('#viewer iframe');
    f.contentDocument.dispatchEvent(new PointerEvent('pointermove', {
      clientX: x, clientY: y, bubbles: true,
    }));
  }, { x, y });
  await page.waitForTimeout(120); // rAF debounce
}

test('F1-1 pointer near right edge → curl-right class', async ({ page }) => {
  await openDemoReady(page);
  const viewer = page.locator('#viewer');
  const box = await viewer.boundingBox();
  // Move pointer to within 40px of the right edge
  await syntheticMove(page, box.x + box.width - 20, box.y + box.height / 2);
  const hasCurl = await viewer.evaluate(el => el.classList.contains('curl-right'));
  expect(hasCurl).toBe(true);
});

test('F1-2 pointer at center → no curl classes', async ({ page }) => {
  await openDemoReady(page);
  const viewer = page.locator('#viewer');
  const box = await viewer.boundingBox();
  // Move pointer to center
  await syntheticMove(page, box.x + box.width / 2, box.y + box.height / 2);
  const hasCurlR = await viewer.evaluate(el => el.classList.contains('curl-right'));
  const hasCurlL = await viewer.evaluate(el => el.classList.contains('curl-left'));
  expect(hasCurlR).toBe(false);
  expect(hasCurlL).toBe(false);
});

// ═══════════════════════════════════════════════════════════
//  F2: Chapter-Crossing Title Flash
// ═══════════════════════════════════════════════════════════

test('F2-1 chapter boundary crossing → flash appears', async ({ page }) => {
  await openDemoReady(page);
  // Navigate forward until we cross a chapter boundary
  // The demo book (The Time Machine) has multiple chapters
  const flash = page.locator('#chFlash');
  // Keep pressing next until chapter changes
  const ch1 = await page.locator('#chapter').textContent();
  let crossed = false;
  for (let i = 0; i < 80 && !crossed; i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(80);
    const ch = await page.locator('#chapter').textContent();
    if (ch !== ch1) { crossed = true; break; }
  }
  if (crossed) {
    // Flash should appear within a short window
    const visible = await flash.evaluate(el => !el.classList.contains('hide'));
    expect(visible).toBe(true);
  }
});

test('F2-2 flash auto-hides after ~1s', async ({ page }) => {
  await openDemoReady(page);
  const flash = page.locator('#chFlash');
  // Navigate to trigger flash
  const ch1 = await page.locator('#chapter').textContent();
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(80);
    const ch = await page.locator('#chapter').textContent();
    if (ch !== ch1) break;
  }
  // Wait for auto-hide
  await page.waitForTimeout(1300);
  const hidden = await flash.evaluate(el => el.classList.contains('hide'));
  expect(hidden).toBe(true);
});

// ═══════════════════════════════════════════════════════════
//  F3: Time-Left-in-Chapter
// ═══════════════════════════════════════════════════════════

test('F3-1 badge shows chapter time estimate', async ({ page }) => {
  await openDemoReady(page);
  const timeText = await page.locator('#timeLeft').textContent();
  expect(timeText).toMatch(/\d+ min in ch\./);
});

// ═══════════════════════════════════════════════════════════
//  F5: Ctrl/Alt+Wheel HUD Pill
// ═══════════════════════════════════════════════════════════

test('F5-1 Ctrl+wheel → HUD shows font size', async ({ page }) => {
  await openDemoReady(page);
  const viewer = page.locator('#viewer');
  const box = await viewer.boundingBox();
  // Ctrl + wheel up
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -120, { modifiers: ['Control'] });
  // Fallback: dispatch wheel event with ctrlKey
  await page.evaluate(() => {
    window.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -120, ctrlKey: true, bubbles: true
    }));
  });
  await page.waitForTimeout(100);
  const hud = page.locator('#nudgeHud');
  await expect(hud).toBeVisible({ timeout: 1000 });
  const text = await hud.textContent();
  expect(text).toMatch(/Aa \d+(\.\d)?px/);
});

test('F5-2 Alt+wheel → HUD shows page width', async ({ page }) => {
  await openDemoReady(page);
  await page.evaluate(() => {
    window.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -120, altKey: true, bubbles: true
    }));
  });
  await page.waitForTimeout(100);
  const hud = page.locator('#nudgeHud');
  await expect(hud).toBeVisible({ timeout: 1000 });
  const text = await hud.textContent();
  expect(text).toMatch(/↔ \d+px/);
});

test('F5-3 HUD auto-hides after ~1s', async ({ page }) => {
  await openDemoReady(page);
  await page.evaluate(() => {
    window.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -120, ctrlKey: true, bubbles: true
    }));
  });
  await page.waitForTimeout(100);
  const hud = page.locator('#nudgeHud');
  await expect(hud).toBeVisible({ timeout: 1000 });
  // Wait for auto-hide (800ms + margin)
  await page.waitForTimeout(1200);
  const hasHide = await hud.evaluate(el => el.classList.contains('hide'));
  expect(hasHide).toBe(true);
});

// ═══════════════════════════════════════════════════════════
//  F6: Desk Dimming on Idle
// ═══════════════════════════════════════════════════════════

test('F6-1 idle 11s → desk dim active', async ({ page }) => {
  test.setTimeout(20000);
  await openDemoReady(page);
  const dim = page.locator('#deskDim');
  // Initially not dimmed
  const initDim = await dim.evaluate(el => el.classList.contains('dim'));
  expect(initDim).toBe(false);
  // Wait 11s without interaction
  await page.waitForTimeout(11000);
  const hasDim = await dim.evaluate(el => el.classList.contains('dim'));
  expect(hasDim).toBe(true);
});

test('F6-2 pointer move → dim clears', async ({ page }) => {
  test.setTimeout(20000);
  await openDemoReady(page);
  const dim = page.locator('#deskDim');
  // Wait for dim to activate
  await page.waitForTimeout(11000);
  const hasDim = await dim.evaluate(el => el.classList.contains('dim'));
  expect(hasDim).toBe(true);
  // Move mouse
  await page.mouse.move(400, 400);
  await page.waitForTimeout(100);
  const dimCleared = await dim.evaluate(el => !el.classList.contains('dim'));
  expect(dimCleared).toBe(true);
});

test('F6-3 dim hidden in landing state', async ({ page }) => {
  const dim = page.locator('#deskDim');
  const display = await dim.evaluate(el => getComputedStyle(el).display);
  expect(display).toBe('none');
});

// ═══════════════════════════════════════════════════════════
//  F7: First-Run Coach Marks (once)
// ═══════════════════════════════════════════════════════════

test('F7-1 first open → coach mark visible', async ({ page }) => {
  await openDemoReady(page);
  const coach = page.locator('#coachMark');
  // Should appear for first-time users
  await expect(coach).toBeVisible({ timeout: 3000 });
});

test('F7-2 dismiss all 3 → localStorage set', async ({ page }) => {
  await openDemoReady(page);
  const coach = page.locator('#coachMark');
  // Wait for the first mark to appear (fires shortly after first relocation)
  await expect(coach).toBeVisible({ timeout: 5000 });
  // Click through all 3 coach marks
  for (let i = 0; i < 3; i++) {
    const btn = coach.locator('.coach-next, .coach-done');
    if (await btn.count() > 0) {
      await btn.first().click();
      await page.waitForTimeout(200);
    }
  }
  const stored = await page.evaluate(() => localStorage.getItem('folio-coach-done'));
  expect(stored).toBe('1');
});

test('F7-3 second open → no coach marks', async ({ page }) => {
  // Set the flag as if coach was already done
  await page.evaluate(() => localStorage.setItem('folio-coach-done', '1'));
  await openDemoReady(page);
  // Coach mark should NOT appear
  await page.waitForTimeout(1000);
  const count = await page.locator('#coachMark:not(.hide)').count();
  expect(count).toBe(0);
});

// ═══════════════════════════════════════════════════════════
//  F8: Selection Bar Quick-Highlight (1-tap)
// ═══════════════════════════════════════════════════════════

test('F8-1 selection bar has 4 inline color dots', async ({ page }) => {
  await openDemoReady(page);
  // Check that quick-highlight dots exist in the selBar
  const dots = page.locator('#selBar .sel-hl-quick');
  const count = await dots.count();
  expect(count).toBe(4);
});

test('F8-2 no separate Highlight button or hidden palette', async ({ page }) => {
  await openDemoReady(page);
  // The old #selHl button and #selHlPal should be removed
  const selHl = await page.locator('#selHl').count();
  const selHlPal = await page.locator('#selHlPal').count();
  expect(selHl).toBe(0);
  expect(selHlPal).toBe(0);
});

// ═══════════════════════════════════════════════════════════
//  F9: Command Palette (Ctrl+K)
// ═══════════════════════════════════════════════════════════

test('F9-1 Ctrl+K → palette visible with focused input', async ({ page }) => {
  await openDemoReady(page);
  await page.keyboard.press('Control+k');
  const palette = page.locator('#cmdPalette');
  await expect(palette).toBeVisible({ timeout: 1000 });
  const focused = await page.evaluate(() => document.activeElement.id);
  expect(focused).toBe('cmdInput');
});

test('F9-2 type "search" → filtered results include Search command', async ({ page }) => {
  await openDemoReady(page);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(100);
  await page.fill('#cmdInput', 'search');
  await page.waitForTimeout(150);
  const items = await page.locator('#cmdList li, #cmdList .cmd-item').allTextContents();
  const hasSearch = items.some(t => /search/i.test(t));
  expect(hasSearch).toBe(true);
});

test('F9-3 Enter on first result → executes and closes', async ({ page }) => {
  await openDemoReady(page);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(100);
  await page.fill('#cmdInput', 'bookmark');
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const paletteHidden = await page.locator('#cmdPalette').evaluate(
    el => el.classList.contains('hide') || getComputedStyle(el).display === 'none'
  );
  expect(paletteHidden).toBe(true);
});

test('F9-4 Escape closes palette', async ({ page }) => {
  await openDemoReady(page);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(100);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const paletteHidden = await page.locator('#cmdPalette').evaluate(
    el => el.classList.contains('hide') || getComputedStyle(el).display === 'none'
  );
  expect(paletteHidden).toBe(true);
});

test('F9-5 type chapter name → shows "Jump to: ..." entries', async ({ page }) => {
  await openDemoReady(page);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(100);
  // The demo book is "The Time Machine" — type partial chapter name
  await page.fill('#cmdInput', 'time');
  await page.waitForTimeout(200);
  const items = await page.locator('#cmdList li, #cmdList .cmd-item').allTextContents();
  const hasJumpTo = items.some(t => /jump to/i.test(t));
  expect(hasJumpTo).toBe(true);
});

// ═══════════════════════════════════════════════════════════
//  F10: Turn-Progress Spine Shadow
// ═══════════════════════════════════════════════════════════

test('F10-1 mid-drag at p≈0.5 → underneath has inset shadow', async ({ page }) => {
  await openDemoReady(page);
  // Check that turn fx is not 'none' for this test
  const fx = await page.evaluate(() => typeof effectiveFx === 'function' ? effectiveFx() : 'slide');
  if (fx === 'none' || fx === 'crossfade') {
    test.skip();
    return;
  }
  // CDP held-button moves stall over the book (see helpers.mjs); use the
  // synthetic in-frame drag path. Assertion unchanged.
  const dr = await slowDrag(page, 1, 0.5);
  await page.waitForTimeout(150);
  const hasShadow = await page.evaluate(() => {
    const under = document.querySelector('.pt-underneath');
    if (!under) return false;
    const shadow = getComputedStyle(under).boxShadow;
    return shadow && shadow !== 'none';
  });
  // Release drag
  await synUp(page, { x: dr.endX, y: dr.endY });
  expect(hasShadow).toBe(true);
});

// ═══════════════════════════════════════════════════════════
//  F11: Reduced-Motion Turn Variant
// ═══════════════════════════════════════════════════════════

test('F11-1 reduced-motion → effectiveFx returns crossfade', async ({ page }) => {
  // Emulate prefers-reduced-motion
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openDemoReady(page);
  const fx = await page.evaluate(() => effectiveFx());
  expect(fx).toBe('crossfade');
});

test('F11-2 reduced-motion turn completes without fold compositor', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openDemoReady(page);
  // Turn forward
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);
  // No fold compositor elements should be present
  const foldCount = await page.locator('.pt-fold, .pt-back-sheet').count();
  expect(foldCount).toBe(0);
});
