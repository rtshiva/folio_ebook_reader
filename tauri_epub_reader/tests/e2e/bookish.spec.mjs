// Bookish dressing batch: embossed board lettering, theme-gated gilt
// fore-edges, multi-anchor ribbon weight split, per-book finis colophon,
// and the classic-indent / old-style-numerals typography channels.
import { test, expect } from '@playwright/test';
import { fresh, openDemo, openDemoReady, viewerFrame } from './helpers.mjs';

test('BK1 front board carries the book title; gilt only on gold-stand themes', async ({ page }) => {
  await fresh(page);
  await openDemoReady(page);
  // Pin desk-follows-environment: fresh installs wake in the Royal Maroon
  // room, whose gilt would otherwise own the fore-edges (RR1 covers that).
  await page.evaluate(() => { settings.rrTheme = 'match'; applyTheme(); });
  expect(await page.evaluate(() => document.getElementById('boardTitle').textContent)).toBe('The Time Machine');
  expect(await page.evaluate(() => document.body.classList.contains('gilt-fore'))).toBe(false);
  await page.evaluate(() => { settings.theme = 'velvet'; applyTheme(); });
  expect(await page.evaluate(() => document.body.classList.contains('gilt-fore'))).toBe(true);
  await page.evaluate(() => { settings.theme = 'emerald'; applyTheme(); });
  expect(await page.evaluate(() => document.body.classList.contains('gilt-fore'))).toBe(true);
  await page.evaluate(() => { settings.theme = 'paper'; applyTheme(); });
  expect(await page.evaluate(() => document.body.classList.contains('gilt-fore'))).toBe(false);
});

test('BK2 ribbon splits multi-anchor file weights across their sections', async ({ page }) => {
  await fresh(page);
  await openDemoReady(page);
  // Uneven multi-anchor book: file 1 is one paragraph, file 2 is five, with
  // four TOC anchors each. Unsplit, every file-2 segment would claim the
  // file's full location count (integer weights ~5x file 1's); split, the
  // weights become fractional (count/groupSize).
  await page.evaluate(async () => {
    const para = (s) => s.repeat(40);
    const chapter = (n, paras) => '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ch' + n + '</title></head><body>' +
      '<h1 id="s1">File ' + n + ' — one</h1>' + Array.from({ length: paras }, () => '<p>' + para('Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima. ') + '</p>').join('') +
      '<h2 id="s2">File ' + n + ' — two</h2><p>' + para('The quick brown fox jumps over the lazy dog while calm waves roll under amber skies. ') + '</p>' +
      '<h2 id="s3">File ' + n + ' — three</h2><p>' + para('Pack my box with five dozen liquor jugs; how vexingly quick daft zebras jump far. ') + '</p>' +
      '<h2 id="s4">File ' + n + ' — four</h2><p>' + para('Sphinx of black quartz judge my vow for the night is long and the road is longer still. ') + '</p>' +
      '</body></html>';
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip');
    zip.file('META-INF/container.xml',
      '<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    zip.file('OEBPS/text/ch1.xhtml', chapter(1, 1));
    zip.file('OEBPS/text/ch2.xhtml', chapter(2, 5));
    let manifest = '', spine = '', lis = '', points = '';
    for (let f = 1; f <= 2; f++) {
      manifest += '<item id="c' + f + '" href="text/ch' + f + '.xhtml" media-type="application/xhtml+xml"/>';
      spine += '<itemref idref="c' + f + '"/>';
      for (let s = 1; s <= 4; s++) {
        lis += '<li><a href="text/ch' + f + '.xhtml#s' + s + '">S' + f + '-' + s + '</a></li>';
        points += '<navPoint id="np' + f + s + '" playOrder="' + (f * 4 + s) + '"><navLabel><text>S' + f + '-' + s + '</text></navLabel><content src="text/ch' + f + '.xhtml#s' + s + '"/></navPoint>';
      }
    }
    zip.file('OEBPS/nav.xhtml',
      '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Nav</title></head><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol>' + lis + '</ol></nav></body></html>');
    zip.file('OEBPS/toc.ncx',
      '<?xml version="1.0" encoding="utf-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:folio:uneven"/></head><docTitle><text>Uneven</text></docTitle><navMap>' + points + '</navMap></ncx>');
    zip.file('OEBPS/content.opf',
      '<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bid">urn:folio:uneven</dc:identifier><dc:title>Uneven</dc:title><dc:creator>Tester</dc:creator><dc:language>en</dc:language><meta property="dcterms:modified">2026-10-28T00:00:00Z</meta></metadata>' +
      '<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' + manifest + '</manifest>' +
      '<spine toc="ncx">' + spine + '</spine></package>');
    const b = await zip.generateAsync({ type: 'arraybuffer' });
    await openBuffer(b, 'Uneven');
  });
  await page.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 12000 });
  await page.waitForFunction(() => typeof LocEngine !== 'undefined' && LocEngine.ready(), null, { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll('#chRibbon .ch-seg').length === 8, null, { timeout: 12000 });
  const res = await page.evaluate(() => {
    const segs = [...document.querySelectorAll('#chRibbon .ch-seg')];
    const grow = segs.map((s) => parseFloat(s.style.flexGrow));
    // Reproduce the split expectation from LocEngine counts.
    const counts = {};
    LocEngine.data.locations.forEach((cfi) => {
      const m = /\/6\/(\d+)/.exec(String(cfi));
      if (m) { const si = parseInt(m[1], 10) / 2 - 1; if (si >= 0) counts[si] = (counts[si] || 0) + 1; }
    });
    const siOf = (i) => i < 4 ? 0 : 1;
    const gs = { 0: 4, 1: 4 };
    const expected = grow.map((_, i) => Math.max(0.5, (counts[siOf(i)] || 0) / gs[siOf(i)]));
    return { grow, expected, counts };
  });
  expect(res.counts[0]).toBeGreaterThanOrEqual(1);
  expect(res.counts[1]).toBeGreaterThan(res.counts[0]);
  res.grow.forEach((g, i) => expect(g).toBeCloseTo(res.expected[i], 1));
  expect(res.grow.some((g) => Math.abs(g - Math.round(g)) > 0.05)).toBe(true);
});

test('BK3 finis colophon carries per-book days and minutes', async ({ page }) => {
  await fresh(page);
  await page.evaluate(() => StoreKV.set('bstat:The Time Machine',
    { min: 125, days: { '2026-10-27': 30, '2026-10-28': 95 } }));
  await openDemo(page);
  await page.evaluate(() => EdgeStacks.set(1, { page: 2, total: 2 }));
  await page.waitForFunction(() => (document.getElementById('finisMeta').textContent || '').length > 0, null, { timeout: 4000 });
  const meta = await page.evaluate(() => document.getElementById('finisMeta').textContent);
  expect(meta).toContain('read across 2 days');
  expect(meta).toContain('2 h 5 min');
});

test('BK4 classic indents and old-style numerals reach the chapter CSS', async ({ page }) => {
  await fresh(page);
  await openDemoReady(page);
  // Off by default
  expect(await page.evaluate(() => buildCSS())).not.toContain('text-indent:1.35em');
  expect(await page.evaluate(() => buildCSS())).not.toContain('"onum" 1');
  await page.evaluate(() => el('swIndent').click());
  await page.evaluate(() => el('swOldstyle').click());
  await page.waitForFunction(() => buildCSS().includes('text-indent:1.35em'), null, { timeout: 6000 });
  expect(await page.evaluate(() => buildCSS())).toContain('"onum" 1');
  // Persisted (debounced 150ms) + live in the chapter iframe
  await page.waitForFunction(() => {
    try { return JSON.parse(localStorage.getItem('folio-settings')).indent === true; } catch (e) { return false; }
  }, null, { timeout: 4000 });
  await page.waitForTimeout(900);
  const frame = await viewerFrame(page);
  const indents = await frame.evaluate(() =>
    [...document.querySelectorAll('p')].map((p) => getComputedStyle(p).textIndent));
  // Openers stay flush (first-of-type / after-heading), later paragraphs indent.
  expect(indents.length).toBeGreaterThan(1);
  expect(indents[0]).toBe('0px');
  expect(indents.slice(1).some((v) => v !== '0px')).toBe(true);
  await page.evaluate(() => el('swIndent').click());
  await page.waitForFunction(() => !buildCSS().includes('text-indent:1.35em'), null, { timeout: 6000 });
});
