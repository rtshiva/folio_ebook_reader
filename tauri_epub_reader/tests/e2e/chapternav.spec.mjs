// Chapter-nav regression: on books whose TOC packs several sections per
// spine file (fragment anchors), Next/Previous chapter jumps must advance
// the running header, pos pill and TOC highlight together — relocated CFIs
// carry no id assertion on same-file jumps, so anything resolving by base
// file or CFI bracket alone sticks to the file's first TOC entry.
import { test, expect } from '@playwright/test';
import { fresh, openDemo } from './helpers.mjs';

const LABELS = ['Part 1', 'Part 2', 'Part 3', 'Part 4', 'Part 5', 'Part 6', 'Part 7', 'Part 8'];

async function openMultiAnchorBook(page) {
  await fresh(page);
  await openDemo(page);
  await page.waitForFunction(() => !state.loading, null, { timeout: 12000 });
  await page.evaluate(async (labels) => {
    const para = (s) => s.repeat(40);
    const chapter = (n) => '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ch' + n + '</title></head><body>' +
      '<h1 id="s1">File ' + n + ' — one</h1><p>' + para('Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima. ') + '</p>' +
      '<h2 id="s2">File ' + n + ' — two</h2><p>' + para('The quick brown fox jumps over the lazy dog while calm waves roll under amber skies. ') + '</p>' +
      '<h2 id="s3">File ' + n + ' — three</h2><p>' + para('Pack my box with five dozen liquor jugs; how vexingly quick daft zebras jump far. ') + '</p>' +
      '<h2 id="s4">File ' + n + ' — four</h2><p>' + para('Sphinx of black quartz judge my vow for the night is long and the road is longer still. ') + '</p>' +
      '</body></html>';
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip');
    zip.file('META-INF/container.xml',
      '<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    zip.file('OEBPS/text/ch1.xhtml', chapter(1));
    zip.file('OEBPS/text/ch2.xhtml', chapter(2));
    let manifest = '', spine = '', lis = '', points = '';
    for (let f = 1; f <= 2; f++) {
      manifest += '<item id="c' + f + '" href="text/ch' + f + '.xhtml" media-type="application/xhtml+xml"/>';
      spine += '<itemref idref="c' + f + '"/>';
      for (let s = 1; s <= 4; s++) {
        const n = (f - 1) * 4 + s;
        lis += '<li><a href="text/ch' + f + '.xhtml#s' + s + '">' + labels[n - 1] + '</a></li>';
        points += '<navPoint id="np' + n + '" playOrder="' + n + '"><navLabel><text>' + labels[n - 1] + '</text></navLabel><content src="text/ch' + f + '.xhtml#s' + s + '"/></navPoint>';
      }
    }
    zip.file('OEBPS/nav.xhtml',
      '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Nav</title></head><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol>' + lis + '</ol></nav></body></html>');
    zip.file('OEBPS/toc.ncx',
      '<?xml version="1.0" encoding="utf-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:folio:multi"/></head><docTitle><text>Multi</text></docTitle><navMap>' + points + '</navMap></ncx>');
    zip.file('OEBPS/content.opf',
      '<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bid">urn:folio:multi</dc:identifier><dc:title>Multi Anchor</dc:title><dc:creator>Tester</dc:creator><dc:language>en</dc:language><meta property="dcterms:modified">2026-09-30T00:00:00Z</meta></metadata>' +
      '<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' + manifest + '</manifest>' +
      '<spine toc="ncx">' + spine + '</spine></package>');
    const b = await zip.generateAsync({ type: 'arraybuffer' });
    await openBuffer(b, 'Multi Anchor');
  }, LABELS);
  await page.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 12000 });
  await page.waitForFunction(() => tocItems && tocItems.length === 8, null, { timeout: 12000 });
  await page.waitForTimeout(800);
}

test('CN1 next-chapter pill keeps header/pill/TOC in step on multi-anchor files', async ({ page }) => {
  await openMultiAnchorBook(page);

  // Same-file anchor jumps: header and tocCurIdx must track every click
  for (let k = 1; k <= 3; k++) {
    await page.locator('#chLabelNext').click();
    await page.waitForFunction((n) => tocCurIdx === n, k, { timeout: 9000 });
    const st = await page.evaluate(() => ({
      header: document.getElementById('chapter').textContent,
      pill: document.getElementById('posPillCh').textContent,
      nav: chNavIdx,
    }));
    expect(st.header).toBe(LABELS[k]);
    expect(st.pill).toBe(LABELS[k]);
    expect(st.nav).toBe(k);
  }

  // Cross-file jump
  await page.locator('#chLabelNext').click();
  await page.waitForFunction(() => tocCurIdx === 4, null, { timeout: 9000 });
  expect(await page.evaluate(() => document.getElementById('chapter').textContent)).toBe(LABELS[4]);

  // Rapid clicks to the end: every click advances, then the pill disables
  for (let k = 5; k <= 7; k++) {
    await page.locator('#chLabelNext').click();
    await page.waitForFunction((n) => tocCurIdx === n, k, { timeout: 9000 });
  }
  await page.waitForFunction(() => document.getElementById('chLabelNext').classList.contains('disabled'), null, { timeout: 9000 });
  const end = await page.evaluate(() => ({
    header: document.getElementById('chapter').textContent,
    cur: tocCurIdx,
  }));
  expect(end.header).toBe(LABELS[7]);
  expect(end.cur).toBe(7);

  // Previous walks back through anchors too
  await page.locator('#chLabelPrev').click();
  await page.waitForFunction(() => tocCurIdx === 6, null, { timeout: 9000 });
  expect(await page.evaluate(() => document.getElementById('chapter').textContent)).toBe(LABELS[6]);
});

test('CN2 keyboard ] / [ match the pill behavior on multi-anchor files', async ({ page }) => {
  await openMultiAnchorBook(page);
  await page.keyboard.press(']');
  await page.waitForFunction(() => tocCurIdx === 1, null, { timeout: 9000 });
  expect(await page.evaluate(() => document.getElementById('chapter').textContent)).toBe(LABELS[1]);
  await page.keyboard.press('[');
  await page.waitForFunction(() => tocCurIdx === 0, null, { timeout: 9000 });
  expect(await page.evaluate(() => document.getElementById('chapter').textContent)).toBe(LABELS[0]);
});
