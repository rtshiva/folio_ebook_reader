// NavHistory back/forward stack (JB) — the jump-back feature:
// every programmatic jump (TOC, search, bookmarks, highlights, vocab,
// chapter strip, rail seek, in-book links) pushes the departure CFI;
// Alt+ArrowLeft / Alt+ArrowRight walk the two stacks browser-style.
//   JB1  TOC jump pushes; Alt+ArrowLeft returns; Alt+ArrowRight forward
//   JB2  consecutive jumps walk back stepwise; a fresh jump clears forward
//   JB3  empty stack is a harmless no-op (and a no-op on the landing too)
import { test, expect } from '@playwright/test';
import { fresh, openDemoReady, badge, badgeWait } from './helpers.mjs';

const badgeIs = (b) => document.getElementById('pageBadge').textContent === b;

test('JB1 TOC jump pushes; Alt+ArrowLeft returns; Alt+ArrowRight forward', async ({ page }) => {
  await fresh(page);
  await openDemoReady(page);
  const b0 = await badge(page);
  // jumpToTocIndex pushes the departure internally before relocating
  await page.evaluate(() => { jumpToTocIndex(2); closePanels(); });
  await badgeWait(page, b0);
  expect(await page.evaluate(() => NavHistory.stack.length)).toBeGreaterThan(0);

  await page.keyboard.press('Alt+ArrowLeft');
  await page.waitForFunction(badgeIs, b0, { timeout: 10000 });
  expect(await page.evaluate(() => NavHistory.fwd.length)).toBe(1);

  await page.keyboard.press('Alt+ArrowRight');
  await badgeWait(page, b0);
  expect(await page.evaluate(() => NavHistory.fwd.length)).toBe(0);
});

test('JB2 consecutive jumps walk back stepwise; a fresh jump clears forward', async ({ page }) => {
  await fresh(page);
  await openDemoReady(page);
  const b0 = await badge(page);
  await page.evaluate(() => { jumpToTocIndex(1); closePanels(); });
  await badgeWait(page, b0);
  const b1 = await badge(page);
  await page.evaluate(() => { jumpToTocIndex(3); closePanels(); });
  await badgeWait(page, b1);

  await page.keyboard.press('Alt+ArrowLeft');
  await page.waitForFunction(badgeIs, b1, { timeout: 10000 });
  await page.keyboard.press('Alt+ArrowLeft');
  await page.waitForFunction(badgeIs, b0, { timeout: 10000 });

  await page.keyboard.press('Alt+ArrowRight');
  await page.waitForFunction(badgeIs, b1, { timeout: 10000 });

  // a brand-new jump invalidates the forward stack
  await page.evaluate(() => { jumpToTocIndex(2); closePanels(); });
  await badgeWait(page, b1);
  expect(await page.evaluate(() => NavHistory.fwd.length)).toBe(0);
});

test('JB3 empty stack is a harmless no-op, on the page and on the landing', async ({ page }) => {
  await fresh(page);
  await openDemoReady(page);
  await page.evaluate(() => NavHistory.clear());
  const b0 = await badge(page);
  await page.keyboard.press('Alt+ArrowLeft');
  await page.waitForTimeout(600);
  expect(await badge(page)).toBe(b0);
  expect(await page.evaluate(() => NavHistory.stack.length)).toBe(0);

  // landing state: the guard skips NavHistory entirely
  await page.evaluate(() => goHome());
  await page.waitForFunction(() => document.body.classList.contains('state-landing'), null, { timeout: 8000 });  await page.keyboard.press('Alt+ArrowLeft');
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => document.body.classList.contains('state-landing'))).toBe(true);
});
