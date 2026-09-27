import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';

test.describe('Non-linear EPUB items (linear="no") sequential paging', () => {
  const epubPath = 'C:\\Users\\Siva\\Downloads\\My First Counting Book (Lillian Moore, Garth Williams) (z-library.sk, 1lib.sk, z-lib.sk).epub';

  test('successfully flips forward from cover and backward back to cover', async ({ page }) => {
    test.skip(!existsSync(epubPath), 'EPUB file not found on local path');

    const buf = readFileSync(epubPath);
    const base64 = buf.toString('base64');

    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();

    await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const len = bin.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
      await openBuffer(bytes.buffer, 'My First Counting Book');
    }, base64);

    // Wait for book to open in reading state
    await page.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 15000 });

    // Verify initial location is index 0 (cover page)
    const loc0 = await page.evaluate(() => {
      const l = state.rendition.currentLocation();
      return {
        index: l && l.start ? l.start.index : -1,
        href: l && l.start ? l.start.href : ''
      };
    });
    expect(loc0.index).toBe(0);

    // Turn forward from cover (linear="no")
    await page.evaluate(() => turn(1));
    await page.waitForFunction(() => {
      const l = state.rendition.currentLocation();
      return l && l.start && l.start.index > 0 && !document.body.classList.contains('turning');
    }, null, { timeout: 15000 });

    const loc1 = await page.evaluate(() => {
      const l = state.rendition.currentLocation();
      return {
        index: l && l.start ? l.start.index : -1,
        href: l && l.start ? l.start.href : ''
      };
    });
    expect(loc1.index).toBe(1);

    // Turn forward again
    await page.evaluate(() => turn(1));
    await page.waitForFunction(() => {
      const l = state.rendition.currentLocation();
      return l && l.start && l.start.index > 1 && !document.body.classList.contains('turning');
    }, null, { timeout: 15000 });

    const loc2 = await page.evaluate(() => {
      const l = state.rendition.currentLocation();
      return {
        index: l && l.start ? l.start.index : -1,
        href: l && l.start ? l.start.href : ''
      };
    });
    expect(loc2.index).toBe(2);

    // Turn backward towards frontmatter
    await page.evaluate(() => turn(-1));
    await page.waitForFunction(() => {
      const l = state.rendition.currentLocation();
      return l && l.start && l.start.index === 1 && !document.body.classList.contains('turning');
    }, null, { timeout: 15000 });

    // Turn backward back to cover
    await page.evaluate(() => turn(-1));
    await page.waitForFunction(() => {
      const l = state.rendition.currentLocation();
      return l && l.start && l.start.index === 0 && !document.body.classList.contains('turning');
    }, null, { timeout: 15000 });

    const locBack = await page.evaluate(() => {
      const l = state.rendition.currentLocation();
      return {
        index: l && l.start ? l.start.index : -1,
        href: l && l.start ? l.start.href : ''
      };
    });
    expect(locBack.index).toBe(0);
  });

  test('spine items with non-linear flags in packaging chain correctly for all sections', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => typeof ePub !== 'undefined' && typeof ensureEpubUrlPatched === 'function');

    const result = await page.evaluate(() => {
      ensureEpubUrlPatched();
      const book = new ePub.Book();
      const mockPackaging = {
        metadata: { layout: 'reflowable' },
        spine: [
          { idref: 'cover', linear: 'no' },
          { idref: 'dedication', linear: 'no' },
          { idref: 'ch1', linear: 'yes' },
          { idref: 'illustration', linear: 'no' },
          { idref: 'ch2', linear: 'yes' },
          { idref: 'ad', linear: 'no' }
        ],
        manifest: {
          cover: { href: 'cover.xhtml', properties: [] },
          dedication: { href: 'ded.xhtml', properties: [] },
          ch1: { href: 'ch1.xhtml', properties: [] },
          illustration: { href: 'illus.xhtml', properties: [] },
          ch2: { href: 'ch2.xhtml', properties: [] },
          ad: { href: 'ad.xhtml', properties: [] }
        },
        spineNodeIndex: 0
      };
      book.packaging = mockPackaging;
      book.unpack(mockPackaging);

      const chain = [];
      for (let i = 0; i < book.spine.length; i++) {
        const s = book.spine.get(i);
        chain.push({
          index: i,
          idref: s.idref,
          linear: s.linear,
          prev: s.prev() ? s.prev().idref : null,
          next: s.next() ? s.next().idref : null
        });
      }
      return chain;
    });

    expect(result.length).toBe(6);
    // Cover
    expect(result[0].idref).toBe('cover');
    expect(result[0].prev).toBeNull();
    expect(result[0].next).toBe('dedication');
    expect(result[0].linear).toBe(true);

    // Dedication (middle non-linear before linear ch1)
    expect(result[1].idref).toBe('dedication');
    expect(result[1].prev).toBe('cover');
    expect(result[1].next).toBe('ch1');

    // Ch1
    expect(result[2].idref).toBe('ch1');
    expect(result[2].prev).toBe('dedication');
    expect(result[2].next).toBe('illustration');

    // Illustration (middle non-linear between linear chapters)
    expect(result[3].idref).toBe('illustration');
    expect(result[3].prev).toBe('ch1');
    expect(result[3].next).toBe('ch2');

    // Ch2
    expect(result[4].idref).toBe('ch2');
    expect(result[4].prev).toBe('illustration');
    expect(result[4].next).toBe('ad');

    // Ad / Backmatter (trailing non-linear)
    expect(result[5].idref).toBe('ad');
    expect(result[5].prev).toBe('ch2');
    expect(result[5].next).toBeNull();
  });
});
