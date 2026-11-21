// Recents-shelf regression net: the "N pages till next chapter" line under
// each cover. The count is computed on the relocation cold pass (pages left
// in the current spine file, cleared for the final TOC chapter), persisted
// on the recents record by the debounced flush, and rendered on the landing
// shelf. The Next Chapter pill tooltip carries the same count while reading.

import { test, expect } from '@playwright/test';
import { fresh, openDemoReady } from './helpers.mjs';

test('SHELF1 relocation persists chLeft/chNext and the landing shelf renders the pages line', async ({ page }) => {
  await fresh(page);
  await openDemoReady(page);
  await page.waitForTimeout(600); // 80ms cold pass must have run

  // Move into chapter 1 so the persisted count is mid-book, then pin the
  // contract: chLeft = per-file remainder, spread-adjusted like "min in ch.".
  await page.evaluate(() => jumpToTocIndex(1));
  await page.waitForFunction(() => chNavIdx === 1, null, { timeout: 12000 });
  await page.waitForTimeout(600); // cold pass for the new position

  const r = await page.evaluate(() => {
    const l = state.rendition.currentLocation();
    const d = l.start.displayed;
    const expected = Math.max(0, d.total - (d.page + (state.spreadOn ? 1 : 0)));
    closeBook(); // flushes the debounced _recentPending synchronously
    return {
      expected,
      rec: (JSON.parse(localStorage.getItem('folio-recents') || '[]'))[0] || null,
    };
  });
  expect(r.rec, 'the demo book lands on the recents history').toBeTruthy();
  expect(r.rec.title).toBe('The Time Machine');
  expect(typeof r.rec.chLeft, 'pages till next chapter persists as a number').toBe('number');
  expect(r.rec.chLeft, 'chLeft equals the per-file remainder (spread-adjusted)').toBe(r.expected);
  expect(r.rec.chNext, 'the next chapter label persists alongside the count').toBeTruthy();

  const phrase = r.rec.chLeft <= 0 ? 'next page begins a new chapter'
    : r.rec.chLeft === 1 ? '1 page till next chapter'
    : r.rec.chLeft + ' pages till next chapter';
  await expect(page.locator('.recent-card').first().locator('.recent-chleft'))
    .toHaveText(phrase);
});

test('SHELF2 final TOC chapter clears the line; Next pill tooltip carries the page hint', async ({ page }) => {
  await fresh(page);
  await openDemoReady(page);
  await page.waitForTimeout(600);

  const nextTitle = await page.evaluate(() => document.getElementById('chLabelNext').title);
  expect(nextTitle, 'tooltip names the next chapter and appends the pages hint')
    .toMatch(/^Next: .+ · \d+ pages?$/);

  await page.evaluate(() => jumpToTocIndex(tocItems.length - 1));
  await page.waitForFunction(() => chNavIdx === tocItems.length - 1, null, { timeout: 12000 });
  await page.waitForTimeout(600); // cold pass persists the final-chapter position

  const rec = await page.evaluate(() => {
    closeBook();
    return (JSON.parse(localStorage.getItem('folio-recents') || '[]'))[0] || null;
  });
  expect(rec && rec.chLeft === null, 'final chapter -> count explicitly cleared (stale value must not linger)').toBe(true);
  await expect(page.locator('.recent-card').first().locator('.recent-chleft')).toHaveCount(0);
});

test('SHELF3 reading strip appends pages-till-next-ch. in the badge page numbers', async ({ page }) => {
  await fresh(page);
  await openDemoReady(page);
  await page.waitForTimeout(600); // hot pass wrote the strip segment

  // Pin the strip contract independently of the app's helper: the segment
  // equals the per-file remainder (spread-adjusted), or the boundary phrase.
  const strip = await page.evaluate(() => {
    const l = state.rendition.currentLocation();
    const d = l.start.displayed;
    const n = Math.max(0, d.total - (d.page + (state.spreadOn ? 1 : 0)));
    return {
      badge: document.getElementById('pageBadge').textContent,
      time: document.getElementById('timeLeft').textContent,
      segment: n === 0 ? ' · ch. ends this page'
        : ` · ${n === 1 ? '1 page' : n + ' pages'} till next ch.`,
    };
  });
  expect(strip.badge).toMatch(/^Page \d+ of \d+$/);
  expect(strip.time.endsWith(strip.segment), 'strip ends with exactly the computed segment')
    .toBe(true);

  // On the final TOC chapter there is no next chapter: the segment must go.
  await page.evaluate(() => jumpToTocIndex(tocItems.length - 1));
  await page.waitForFunction(() => chNavIdx === tocItems.length - 1, null, { timeout: 12000 });
  await page.waitForTimeout(300);
  const strip2 = await page.evaluate(() => document.getElementById('timeLeft').textContent);
  expect(strip2, 'final chapter -> no pages-till-next segment').not.toMatch(/till next ch\./);
  expect(strip2).not.toMatch(/ch\. ends this page/);
});
