import { test, expect } from '@playwright/test';
import { fresh, openDemoReady, badge, badgeWait } from './helpers.mjs';

test.beforeEach(async ({ page }) => {
  await fresh(page);
});

test('UX1 chapter pills replace ribbons; keyboard jumps work', async ({ page }) => {
  await openDemoReady(page);

  // Both margin pills exist with their fixed labels
  await expect(page.locator('#chLabelPrev')).toBeAttached();
  await expect(page.locator('#chLabelNext')).toBeAttached();

  // Hover the margin strip -> the Next pill ghosts in; hover it fully
  const nextPill = page.locator('#chLabelNext');
  await page.waitForTimeout(250);
  await nextPill.hover();
  await page.waitForTimeout(200);
  const bg = await nextPill.evaluate(el => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe('rgba(0, 0, 0, 0)');

  // Keyboard shortcut ']' jumps to next chapter
  const b0 = await badge(page);
  await page.keyboard.press(']');
  const b1 = await badgeWait(page, b0);
  expect(b1).not.toBe(b0);

  // Keyboard shortcut '[' jumps back
  await page.keyboard.press('[');
  const b2 = await badgeWait(page, b1);
  expect(b2).not.toBe(b1);
});

test('UX2 safety anchor appears on chapter jumps and returns to previous position', async ({ page }) => {
  await openDemoReady(page);

  const anchor = page.locator('#jumpAnchor');
  const returnBtn = page.locator('#btnJumpReturn');
  const returnTxt = page.locator('#jumpReturnText');
  const dismissBtn = page.locator('#btnJumpDismiss');

  // Initially hidden
  await expect(anchor).toHaveClass(/hide/);

  // Jump via the Next Chapter margin pill
  const b0 = await badge(page);
  await page.waitForTimeout(250);
  await page.locator('#chLabelNext').click();
  await badgeWait(page, b0);

  // Safety anchor should now be visible with return label
  await expect(anchor).toHaveClass(/show/);
  await expect(returnTxt).toContainText(/Return to/);

  // Click return button -> returns to original page
  await returnBtn.click();
  const bReturned = await badgeWait(page, await badge(page));
  expect(bReturned).toBe(b0);
  await expect(anchor).toHaveClass(/hide/);

  // Trigger jump again and test dismiss button
  await page.waitForTimeout(250);
  await page.locator('#chLabelNext').click();
  await badgeWait(page, b0);
  await expect(anchor).toHaveClass(/show/);
  await dismissBtn.click();
  await expect(anchor).toHaveClass(/hide/);
});

test('UX3 non-destructive rail skimming shows preview card and commits on release', async ({ page }) => {
  await openDemoReady(page);

  const preview = page.locator('#railPreview');
  const rpCh = page.locator('#rpCh');
  const rpMeta = page.locator('#rpMeta');

  // Initially hidden
  await expect(preview).toHaveClass(/hide/);

  // Dispatch pointerdown on rail at 50%
  await page.evaluate(() => {
    const rail = document.getElementById('rail');
    const rect = rail.getBoundingClientRect();
    const e = new PointerEvent('pointerdown', {
      clientX: rect.left + rect.width * 0.5,
      clientY: rect.top + rect.height * 0.5,
      pointerId: 1,
      bubbles: true
    });
    rail.dispatchEvent(e);
  });

  // Preview card should become visible
  await expect(preview).not.toHaveClass(/hide/);
  await expect(rpCh).not.toBeEmpty();
  await expect(rpMeta).toContainText(/%/);

  // Release pointer
  await page.evaluate(() => {
    const rail = document.getElementById('rail');
    const rect = rail.getBoundingClientRect();
    const e = new PointerEvent('pointerup', {
      clientX: rect.left + rect.width * 0.5,
      clientY: rect.top + rect.height * 0.5,
      pointerId: 1,
      bubbles: true
    });
    rail.dispatchEvent(e);
  });

  // Preview card should hide after release
  await expect(preview).toHaveClass(/hide/);
});

test('UX4 optical reading environments apply preset typography, themes, and warmth', async ({ page }) => {
  await openDemoReady(page);

  // Open settings sheet
  await page.click('#btnSheet');
  await expect(page.locator('body')).toHaveClass(/sheet-open/);

  // 1. Natural Paper
  await page.locator('#envPaper').click();
  let envState = await page.evaluate(() => ({
    theme: settings.theme,
    font: settings.font,
    warmth: settings.warmth,
    paperSel: document.getElementById('envPaper').classList.contains('sel')
  }));
  expect(envState.theme).toBe('paper');
  expect(envState.font).toBe('Literata');
  expect(envState.warmth).toBe(0);
  expect(envState.paperSel).toBe(true);

  // 2. Modern Clean
  await page.locator('#envClean').click();
  envState = await page.evaluate(() => ({
    theme: settings.theme,
    font: settings.font,
    cleanSel: document.getElementById('envClean').classList.contains('sel')
  }));
  expect(envState.theme).toBe('light');
  expect(envState.font).toBe('Lexend');
  expect(envState.cleanSel).toBe(true);

  // 3. Velvet Night
  await page.locator('#envNight').click();
  envState = await page.evaluate(() => ({
    theme: settings.theme,
    warmth: settings.warmth,
    nightSel: document.getElementById('envNight').classList.contains('sel')
  }));
  expect(envState.theme).toBe('noir');
  expect(envState.warmth).toBeGreaterThan(0);
  expect(envState.nightSel).toBe(true);
});
