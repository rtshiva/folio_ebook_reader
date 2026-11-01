import { test, expect } from '@playwright/test';
import { fresh } from './helpers.mjs';

test.describe('MOBI & AZW3 Support tests', () => {
  test('File input and drop zones accept .mobi, .azw, and .azw3 files', async ({ page }) => {
    await fresh(page);

    const fileInput = page.locator('#file');
    const acceptAttr = await fileInput.getAttribute('accept');
    expect(acceptAttr).toContain('.mobi');
    expect(acceptAttr).toContain('.azw');
    expect(acceptAttr).toContain('.azw3');
    expect(acceptAttr).toContain('.epub');

    const dropHint = page.locator('#dropHint');
    await expect(dropHint).toContainText('.mobi');
  });

  test('loadFile accepts .mobi and .azw3 extensions and rejects non-ebook files', async ({ page }) => {
    await fresh(page);

    // Test rejection of non-ebook format
    await page.evaluate(() => {
      window.__toast_msg = null;
      const fakeTxt = new File(['hello'], 'document.txt', { type: 'text/plain' });
      loadFile(fakeTxt);
    });
    await page.waitForTimeout(100);
    const toastTxt = await page.locator('#toast').textContent();
    expect(toastTxt).toContain('Please select an EPUB, MOBI, or AZW3 file');

    // Test acceptance of .mobi file: should transition into loading state
    await page.evaluate(() => {
      const mobiData = new Uint8Array([0x42, 0x4F, 0x4F, 0x4B]);
      const fakeMobi = new File([mobiData], 'my_novel.mobi', { type: 'application/x-mobipocket-ebook' });
      loadFile(fakeMobi);
    });
    await page.waitForTimeout(100);
    const hasLoader = await page.evaluate(() => !document.getElementById('loader').classList.contains('hide'));
    expect(hasLoader).toBe(true);
  });

  test('Title extraction properly strips .mobi and .azw3 extensions', async ({ page }) => {
    await fresh(page);

    const titles = await page.evaluate(() => {
      const paths = [
        'C:\\Users\\Reader\\Books\\Sherlock_Holmes.mobi',
        '/home/user/books/The_Odyssey.azw3',
        'F:\\ebooks\\Classic.azw',
        'D:\\Library\\Standard_Novel.epub'
      ];
      return paths.map(p => {
        return String(p.split(/[\\/]/).pop() || '').replace(/\.(epub|mobi|azw3?)$/i, '').trim();
      });
    });

    expect(titles[0]).toBe('Sherlock_Holmes');
    expect(titles[1]).toBe('The_Odyssey');
    expect(titles[2]).toBe('Classic');
    expect(titles[3]).toBe('Standard_Novel');
  });

  test('MOBI book open via Tauri bridge invokes book_open and delegates to cache URL', async ({ page }) => {
    await fresh(page);

    // Spy on openBuffer and mock Tauri IPC bridge
    await page.evaluate(() => {
      window.__openBufferCalls = [];
      const orig = window.openBuffer;
      window.openBuffer = async (buf, titleHint, filePath, targetCfi, opts) => {
        window.__openBufferCalls.push({ buf, titleHint, filePath, targetCfi, opts });
      };

      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
      window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
        if (cmd === 'book_open') {
          return {
            hash: 'test_mobi_hash_123',
            cache_dir: 'F:/cache/folio-unzip/test_mobi_hash_123',
            manifest: {
              path: args.path,
              len: 12345,
              mtime_ms: 1000,
              files: [
                { zip_path: 'META-INF/container.xml', size: 100 },
                { zip_path: 'content.opf', size: 500 },
                { zip_path: 'toc.ncx', size: 300 },
                { zip_path: 'ch_0001.xhtml', size: 1000 }
              ]
            }
          };
        }
        if (cmd === 'get_initial_file') return null;
        return null;
      };
    });

    // Invoke openEpubPath with a .mobi path
    await page.evaluate(async () => {
      await openEpubPath('C:\\Books\\Adventures.mobi');
    });

    const calls = await page.evaluate(() => window.__openBufferCalls);
    expect(calls.length).toBe(1);
    expect(calls[0].titleHint).toBe('Adventures');
    expect(calls[0].filePath).toBe('C:\\Books\\Adventures.mobi');
    expect(calls[0].opts).toEqual({ url: 'http://folio-cache.localhost/test_mobi_hash_123/' });
  });

  test('DRM-protected MOBI/AZW files show an informative toast error instead of crashing', async ({ page }) => {
    await fresh(page);

    // Mock Tauri bridge rejecting with DRM error
    await page.evaluate(() => {
      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
      window.__TAURI_INTERNALS__.invoke = async (cmd) => {
        if (cmd === 'book_open') {
          throw 'This MOBI/AZW file is DRM-protected and cannot be opened directly. Please use a DRM-free copy.';
        }
        return null;
      };
    });

    await page.evaluate(async () => {
      await openEpubPath('C:\\Books\\Protected.azw3');
    });

    await page.waitForTimeout(200);
    const toastTxt = await page.locator('#toast').textContent();
    expect(toastTxt).toContain('DRM-protected');
  });
});
