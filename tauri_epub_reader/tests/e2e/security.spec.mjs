import { test, expect } from '@playwright/test';
import { fresh } from './helpers.mjs';

test.describe('Security & XSS sanitization tests', () => {
  test('Recent books shelf does not execute malicious HTML/JS in title, author, or thumb', async ({ page }) => {
    await fresh(page);

    await page.evaluate(() => {
      window.__xss_executed = false;
      const maliciousRecents = [
        {
          title: '<img src="invalid_path.jpg" onerror="window.__xss_executed=true;">Exploit Title',
          author: '<script>window.__xss_executed=true;</script>Evil Author',
          pct: '50%"><script>window.__xss_executed=true;</script>',
          thumb: 'javascript:window.__xss_executed=true',
          cfi: null
        }
      ];
      localStorage.setItem('folio-recents', JSON.stringify(maliciousRecents));
      if (typeof renderRecentShelf === 'function') {
        renderRecentShelf();
      }
    });

    await page.waitForTimeout(500);

    const xssTriggered = await page.evaluate(() => window.__xss_executed);
    expect(xssTriggered).toBe(false);

    // Verify title was escaped and treated as textContent
    const titleEl = page.locator('.recent-book-title');
    await expect(titleEl).toContainText('<img src="invalid_path.jpg" onerror=');

    // Verify author was escaped and treated as textContent
    const authorEl = page.locator('.recent-book-author');
    await expect(authorEl).toContainText('<script>window.__xss_executed=true;</script>Evil Author');

    // Verify malicious thumb was not used as an img src
    const imgEl = page.locator('.recent-cover-art img');
    expect(await imgEl.count()).toBe(0);
  });

  test('Bookmarks render untrusted chapter and snippet strings safely via textContent', async ({ page }) => {
    await fresh(page);

    await page.evaluate(() => {
      window.__bm_xss = false;
      state.currentTitle = 'Security Test Book';
      const maliciousBookmarks = [
        {
          id: 'bm_sec_1',
          bookTitle: 'Security Test Book',
          cfi: 'epubcfi(/6/2[c1]!/4/2/1:0)',
          chapter: '<img src=x onerror="window.__bm_xss=true">Chapter 1',
          snippet: '<script>window.__bm_xss=true</script>Snippet with malicious text',
          pct: '10%'
        }
      ];
      StoreKV.set('bookmarks', maliciousBookmarks);
      if (typeof renderBookmarks === 'function') {
        renderBookmarks();
      }
    });

    await page.waitForTimeout(500);

    const xss = await page.evaluate(() => window.__bm_xss);
    expect(xss).toBe(false);

    const bmText = page.locator('#bmList .bm-item-text');
    await expect(bmText).toContainText('<script>window.__bm_xss=true</script>Snippet');
  });

  test('Highlights and notes render safely and escape malicious markup', async ({ page }) => {
    await fresh(page);

    await page.evaluate(() => {
      window.__hl_xss = false;
      state.currentTitle = 'Security Test Book';
      const maliciousHls = [
        {
          id: 'hl_sec_1',
          bookTitle: 'Security Test Book',
          cfi: 'epubcfi(/6/2[c1]!/4/2/1:0)',
          color: 'yellow',
          note: '<script>window.__hl_xss=true</script>Important Note',
          chapter: '<b onmouseover="window.__hl_xss=true">Ch 2</b>',
          snippet: '<svg onload="window.__hl_xss=true">Highlight snippet',
          date: 'Nov 1'
        }
      ];
      StoreKV.set('highlights', maliciousHls);
      if (typeof Highlights !== 'undefined') {
        Highlights.renderList();
      }
    });

    await page.waitForTimeout(500);

    const xss = await page.evaluate(() => window.__hl_xss);
    expect(xss).toBe(false);

    const itemText = page.locator('#hlList .bm-item-text');
    await expect(itemText).toContainText('<script>window.__hl_xss=true</script>Important Note');
  });

  test('Search results render malicious chapter and excerpts safely', async ({ page }) => {
    await fresh(page);

    await page.evaluate(() => {
      window.__srch_xss = false;
      const matches = [
        {
          cfi: 'epubcfi(/6/2!/4/2)',
          chapter: '<img src=x onerror="window.__srch_xss=true">Secret Chapter',
          excerpt: '<script>window.__srch_xss=true</script>Here is the target keyword inside the excerpt'
        }
      ];
      if (typeof renderSearchResults === 'function') {
        renderSearchResults(matches, 'target');
      }
    });

    await page.waitForTimeout(500);

    const xss = await page.evaluate(() => window.__srch_xss);
    expect(xss).toBe(false);

    const snip = page.locator('#searchResults .search-res-snip');
    await expect(snip).toContainText('<script>window.__srch_xss=true</script>');
    const mark = page.locator('#searchResults mark');
    await expect(mark).toHaveText('target');
  });

  test('Footnote popup strips dangerous script tags and event handlers', async ({ page }) => {
    await fresh(page);

    await page.evaluate(() => {
      const doc = new DOMParser().parseFromString(
        '<div>Normal text <script>window.__fn_xss=true;</script><img src="missing.png" onerror="window.__fn_xss=true"> <a href="javascript:window.__fn_xss=true">link</a></div>',
        'text/html'
      );
      const fakeNode = doc.body.firstChild;
      window.__fn_xss = false;
      if (typeof Footnotes !== 'undefined') {
        Footnotes.show(fakeNode, 200, 200);
      }
    });

    await page.waitForTimeout(500);

    const xss = await page.evaluate(() => window.__fn_xss);
    expect(xss).toBe(false);

    // Verify script element was removed from footnote
    const scripts = await page.evaluate(() => document.querySelectorAll('#fnPop script').length);
    expect(scripts).toBe(0);

    // Verify onerror attribute was stripped
    const badImgs = await page.evaluate(() => document.querySelectorAll('#fnPop [onerror]').length);
    expect(badImgs).toBe(0);
  });

  test('Lightbox rejects javascript: and unsafe protocols', async ({ page }) => {
    await fresh(page);

    await page.evaluate(() => {
      window.__lb_xss = false;
      if (typeof Lightbox !== 'undefined') {
        Lightbox.open('javascript:window.__lb_xss=true');
      }
    });

    await page.waitForTimeout(300);

    const xss = await page.evaluate(() => window.__lb_xss);
    expect(xss).toBe(false);

    const isLbShown = await page.evaluate(() => {
      const lb = document.getElementById('lightbox');
      return lb ? lb.classList.contains('show') : false;
    });
    expect(isLbShown).toBe(false);
  });

  test('Snapshot and warm iframes enforce sandbox=allow-same-origin', async ({ page }) => {
    await fresh(page);

    const sandboxAttrs = await page.evaluate(() => {
      // Create a test snap box
      const snapInfo = {
        docHtml: '<html><body>Test</body></html>',
        pageCSS: null,
        vRect: { left: 0, top: 0, width: 800, height: 600 },
        fRect: { width: 800, height: 600 },
        relLeft: 0,
        relTop: 0,
        isSpread: false
      };
      const { snap } = createSnapBox(snapInfo, 0, 800);
      return snap.getAttribute('sandbox');
    });

    expect(sandboxAttrs).toBe('allow-same-origin');
  });

  test('sanitizeChapterHtml completely strips script tags, iframes, and on* attributes', async ({ page }) => {
    await fresh(page);

    const cleaned = await page.evaluate(() => {
      const dirty = '<div class="body"><script>alert(1)</script><p>Text</p><iframe src="evil.html"></iframe><img src="pic.jpg" onerror="alert(2)" /><a href="javascript:void(0)" onclick="evil()">link</a></div>';
      return sanitizeChapterHtml(dirty);
    });

    expect(cleaned).not.toContain('<script');
    expect(cleaned).not.toContain('alert(1)');
    expect(cleaned).not.toContain('<iframe');
    expect(cleaned).not.toContain('evil.html');
    expect(cleaned).not.toContain('onerror');
    expect(cleaned).not.toContain('onclick');
    expect(cleaned).toContain('<p>Text</p>');
  });

  test('isSafeImageUrl strips control characters and rejects insecure http image URLs', async ({ page }) => {
    await fresh(page);

    const results = await page.evaluate(() => {
      return {
        plainHttp: isSafeImageUrl('http://attacker.com/evil.png'),
        controlCharBypass: isSafeImageUrl('java\x00script:alert(1)'),
        tabBypass: isSafeImageUrl('java\tscript:alert(1)'),
        safeHttps: isSafeImageUrl('https://example.com/cover.jpg'),
        safeData: isSafeImageUrl('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
        safeFolioCache: isSafeImageUrl('http://folio-cache.localhost/abc123def456/cover.jpg')
      };
    });

    expect(results.plainHttp).toBe(false);
    expect(results.controlCharBypass).toBe(false);
    expect(results.tabBypass).toBe(false);
    expect(results.safeHttps).toBe(true);
    expect(results.safeData).toBe(true);
    expect(results.safeFolioCache).toBe(true);
  });
});
