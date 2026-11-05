// Storage reliability (ST-*): StoreKV — the IndexedDB key-value layer that
// carries the EPUB-derived records (bookmarks, highlights, stats, per-book
// typography, reading positions, vocab). Covers the one-time localStorage
// migration, corrupt-JSON recovery, IDB shape-check recovery, and the
// localStorage fallback when IDB is unavailable.
import { test, expect } from '@playwright/test';
import { fresh, openDemoReady } from './helpers.mjs';

const LEGACY = {
  bookmarks: JSON.stringify([{ cfi: 'epubcfi(/6/2!/4/2)', text: 'Chapter 1', createdAt: 1 }]),
  highlights: JSON.stringify([{ cfi: 'epubcfi(/6/2!/4/4)', color: 'yellow', note: 'nice <img src=x onerror=alert(1)> bit' }]),
  stats: JSON.stringify({ min: 42, pages: 7, days: { '2026-11-01': 42 } })
};

async function idbGet(page, key) {
  return page.evaluate((k) => new Promise((res) => {
    const r = indexedDB.open('folio-kv-db', 1);
    r.onsuccess = () => {
      const db = r.result;
      try {
        const rq = db.transaction('kv', 'readonly').objectStore('kv').get(k);
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => res(undefined);
      } catch (e) { res(undefined); }
    };
    r.onerror = () => res(undefined);
  }), key);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
});

test('ST1 legacy localStorage records migrate into IDB and are removed', async ({ page }) => {
  await page.evaluate((legacy) => {
    for (const [k, v] of Object.entries(legacy)) localStorage.setItem('folio-' + k, v);
    localStorage.setItem('folio-typo:The Time Machine', JSON.stringify({ font: 'lexend', size: 21 }));
    localStorage.setItem('folio-pos:The Time Machine', 'epubcfi(/6/2!/4/2/2)');
  }, LEGACY);
  // stats needs valid shape — overwrite with a proper JSON string
  await page.evaluate(() => localStorage.setItem('folio-stats', JSON.stringify({ min: 42, pages: 7, days: {} })));
  await page.reload();
  await page.locator('#btnDemo').waitFor({ timeout: 9000 });
  // migration runs during boot; wait for the flag/meta
  await page.waitForFunction(() => StoreKV.ready, null, { timeout: 9000 });
  expect(await idbGet(page, 'bookmarks')).toEqual(JSON.parse(LEGACY.bookmarks));
  expect(await idbGet(page, 'highlights')).toEqual(JSON.parse(LEGACY.highlights));
  expect((await idbGet(page, 'stats')).min).toBe(42);
  expect((await idbGet(page, 'typo:The Time Machine')).size).toBe(21);
  // legacy keys removed after migration
  const left = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('folio-bookmarks') || k.startsWith('folio-highlights') || k.startsWith('folio-typo:') || k.startsWith('folio-pos:')));
  expect(left).toEqual([]);
});

test('ST2 corrupt legacy JSON is quarantined, not crashed on', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('folio-bookmarks', '{corrupt json!!');
    localStorage.setItem('folio-highlights', '[1,2,'); // truncated
    localStorage.setItem('folio-stats', 'not an object at all');
  });
  await page.reload();
  await page.locator('#btnDemo').waitFor({ timeout: 9000 });
  await page.waitForFunction(() => StoreKV.ready, null, { timeout: 9000 });
  // corrupt entries skipped: mirrors empty, app functional
  expect(await idbGet(page, 'bookmarks')).toBeUndefined();
  expect(await idbGet(page, 'highlights')).toBeUndefined();
  const TTSOK = await page.evaluate(() => typeof TTS.toggle === 'function');
  expect(TTSOK).toBe(true);
});

test('ST3 wrong-shaped IDB entries are skipped on hydration', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('folio-settings', JSON.stringify({ themeAuto: false })));
  await page.reload();
  await page.locator('#btnDemo').waitFor({ timeout: 9000 });
  // write wrong-shaped values directly into the kv store
  await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('folio-kv-db', 1);
    r.onsuccess = () => {
      const db = r.result;
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(42, 'bookmarks');           // number, not array
      tx.objectStore('kv').put('nope', 'stats');           // string, not object
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    };
  }));
  await page.reload();
  await page.locator('#btnDemo').waitFor({ timeout: 9000 });
  await page.waitForFunction(() => StoreKV.ready, null, { timeout: 9000 });
  // hydration skipped the wrong shapes -> mirrors empty -> defaults used
  const mirror = await page.evaluate(() => ({
    bookmarks: StoreKV.get('bookmarks'),
    stats: StoreKV.get('stats')
  }));
  // the number 42 and string 'nope' fail the shape checks — the app recovers
  // by writing fresh defaults (loadStats persists an empty stats object)
  expect(mirror.bookmarks).toBeUndefined();
  expect(mirror.stats === undefined || (typeof mirror.stats === 'object' && !Array.isArray(mirror.stats))).toBe(true);
});

test('ST4 bookmarks and highlights round-trip through IDB across reloads', async ({ page }) => {
  await openDemoReady(page);
  await page.evaluate(() => {
    StoreKV.set('bookmarks', [{ cfi: 'epubcfi(/6/2!/4/2)', text: 'Chapter 1' }]);
    StoreKV.set('highlights', [{ cfi: 'epubcfi(/6/2)', color: 'green' }]);
  });
  await page.reload();
  await openDemoReady(page);
  const out = await page.evaluate(() => ({
    bookmarks: StoreKV.get('bookmarks'),
    highlights: StoreKV.get('highlights'),
    inLocalStorage: localStorage.getItem('folio-bookmarks')
  }));
  expect(out.bookmarks.length).toBe(1);
  expect(out.highlights.length).toBe(1);
  expect(out.inLocalStorage).toBeNull(); // no longer the persistence layer
});

test('ST5 IDB unavailable: localStorage fallback keeps the old behavior', async ({ page }) => {
  // break indexedDB.open before any app script runs
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', {
      value: { open() { throw new Error('IDB disabled for test'); } },
      configurable: true
    });
  });
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload();
  await page.locator('#btnDemo').waitFor({ timeout: 9000 });
  expect(await page.evaluate(() => StoreKV.failed)).toBe(true);
  await page.evaluate(() => {
    StoreKV.set('bookmarks', [{ cfi: 'epubcfi(/6/2!/4/2)', text: 'Chapter 1' }]);
  });
  // fallback writes JSON into localStorage under the folio- prefix
  const raw = await page.evaluate(() => localStorage.getItem('folio-bookmarks'));
  expect(raw).not.toBeNull();
  await page.reload();
  await page.locator('#btnDemo').waitFor({ timeout: 9000 });
  const out = await page.evaluate(() => StoreKV.get('bookmarks'));
  expect(out.length).toBe(1);
});
