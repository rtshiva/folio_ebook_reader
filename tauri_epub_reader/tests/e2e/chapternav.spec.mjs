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

test('CN3 chapter jumps resolve relative hrefs when nav document is in a subfolder (EPUB 3)', async ({ page }) => {
  await fresh(page);
  await openDemo(page);
  await page.waitForFunction(() => !state.loading, null, { timeout: 12000 });
  await page.evaluate(async () => {
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip');
    zip.file('META-INF/container.xml',
      '<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    zip.file('OPS/xhtml/c1.xhtml',
      '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ch1</title></head><body><h1 id="sec1">Chapter 1</h1><p>Body 1 content that fills space nicely.</p></body></html>');
    zip.file('OPS/xhtml/c2.xhtml',
      '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ch2</title></head><body><h1 id="sec2">Chapter 2</h1><p>Body 2 content that fills space nicely.</p></body></html>');
    zip.file('OPS/xhtml/nav.xhtml',
      '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Nav</title></head><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol>' +
      '<li><a href="c1.xhtml#sec1">Chapter One</a></li>' +
      '<li><a href="c2.xhtml#sec2">Chapter Two</a></li>' +
      '</ol></nav></body></html>');
    zip.file('OPS/package.opf',
      '<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bid">urn:folio:nested</dc:identifier><dc:title>Nested Nav</dc:title><dc:language>en</dc:language></metadata>' +
      '<manifest><item id="nav" href="xhtml/nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' +
      '<item id="c1" href="xhtml/c1.xhtml" media-type="application/xhtml+xml"/>' +
      '<item id="c2" href="xhtml/c2.xhtml" media-type="application/xhtml+xml"/></manifest>' +
      '<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>');
    const b = await zip.generateAsync({ type: 'arraybuffer' });
    await openBuffer(b, 'Nested Nav');
  });
  await page.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 12000 });
  await page.waitForFunction(() => tocItems && tocItems.length === 2, null, { timeout: 12000 });

  const hrefs = await page.evaluate(() => tocItems.map(t => t.href));
  expect(hrefs[0]).toBe('xhtml/c1.xhtml#sec1');
  expect(hrefs[1]).toBe('xhtml/c2.xhtml#sec2');

  await page.locator('#chLabelNext').click();
  await page.waitForFunction(() => tocCurIdx === 1, null, { timeout: 9000 });
  expect(await page.evaluate(() => document.getElementById('chapter').textContent)).toBe('Chapter Two');
});

test('CN4 transparent circular chapter buttons match page flip styling and spacing', async ({ page }) => {
  await openMultiAnchorBook(page);
  // Unclamp spread width so the desk margin is wide and arrows are live
  await page.evaluate(() => { settings.widthAuto = false; settings.widthSpread = 720; save(); relayout(); });
  await page.waitForFunction(() => !document.getElementById('stage').classList.contains('no-arrows'), null, { timeout: 9000 });
  await page.waitForTimeout(300);

  const prevBtn = page.locator('#chLabelPrev');
  const nextBtn = page.locator('#chLabelNext');

  // Both buttons have .arrow, .ch-arrow and .ch-nav-label
  await expect(prevBtn).toHaveClass(/arrow/);
  await expect(nextBtn).toHaveClass(/arrow/);
  await expect(prevBtn).toHaveClass(/ch-arrow/);
  await expect(nextBtn).toHaveClass(/ch-arrow/);

  // Verify exact same styling as page-turn arrow button (transparent background, matching border)
  const [bgNext, bgPage] = await Promise.all([
    nextBtn.evaluate(el => getComputedStyle(el).backgroundColor),
    page.locator('#btnNext').evaluate(el => getComputedStyle(el).backgroundColor),
  ]);
  expect(bgNext).toBe(bgPage);

  const [borderNext, borderPage] = await Promise.all([
    nextBtn.evaluate(el => getComputedStyle(el).borderColor),
    page.locator('#btnNext').evaluate(el => getComputedStyle(el).borderColor),
  ]);
  expect(borderNext).toBe(borderPage);

  // Measure button geometries: circular 46x46
  const geom = await page.evaluate(() => {
    const p = document.getElementById('chLabelPrev').getBoundingClientRect();
    const n = document.getElementById('chLabelNext').getBoundingClientRect();
    const bp = document.getElementById('btnPrev').getBoundingClientRect();
    const bn = document.getElementById('btnNext').getBoundingClientRect();
    return {
      p: { w: p.width, h: p.height, r: p.right, l: p.left },
      n: { w: n.width, h: n.height, r: n.right, l: n.left },
      bp: { w: bp.width, h: bp.height, r: bp.right, l: bp.left },
      bn: { w: bn.width, h: bn.height, r: bn.right, l: bn.left },
    };
  });

  expect(geom.p.w).toBeCloseTo(46, 1);
  expect(geom.p.h).toBeCloseTo(46, 1);
  expect(geom.n.w).toBeCloseTo(46, 1);
  expect(geom.n.h).toBeCloseTo(46, 1);

  // Double chevron SVGs present inside
  const prevPaths = await prevBtn.locator('svg path').count();
  const nextPaths = await nextBtn.locator('svg path').count();
  expect(prevPaths).toBe(2); // double chevron <<
  expect(nextPaths).toBe(2); // double chevron >>

  // Single chevron SVGs in page flip buttons
  expect(await page.locator('#btnPrev svg path').count()).toBe(1);
  expect(await page.locator('#btnNext svg path').count()).toBe(1);

  // Position: prev chapter is to the left of prev page; next chapter is to the right of next page
  expect(geom.p.r).toBeLessThanOrEqual(geom.bp.l);
  expect(geom.n.l).toBeGreaterThanOrEqual(geom.bn.r);

  // Initial state on start of book: previous chapter is disabled
  expect(await prevBtn.evaluate(el => el.classList.contains('disabled'))).toBe(true);
  expect(await nextBtn.evaluate(el => el.classList.contains('disabled'))).toBe(false);

  // Clicking next chapter moves to Part 2 and enables prev chapter
  await nextBtn.click();
  await page.waitForFunction(() => tocCurIdx === 1, null, { timeout: 9000 });
  expect(await prevBtn.evaluate(el => el.classList.contains('disabled'))).toBe(false);
});

test('CN5 chapter buttons automatically hide when window narrows and buttons approach each other', async ({ page }) => {
  await openMultiAnchorBook(page);
  // Wide viewport with 720px spread width: plenty of desk margin (> 200px)
  await page.setViewportSize({ width: 1360, height: 860 });
  await page.evaluate(() => { settings.widthAuto = false; settings.widthSpread = 720; save(); relayout(); });
  await page.waitForFunction(() => !document.getElementById('chNavRight').classList.contains('no-desk'), null, { timeout: 9000 });
  await page.waitForTimeout(300);

  // Both page arrow and chapter button are visible and have >= 20px clearance
  const rightState = await page.evaluate(() => {
    const bn = document.getElementById('btnNext').getBoundingClientRect();
    const cn = document.getElementById('chLabelNext').getBoundingClientRect();
    const panel = document.getElementById('chNavRight');
    return {
      gap: cn.left - bn.right,
      hasNoDesk: panel.classList.contains('no-desk'),
      chVis: getComputedStyle(document.getElementById('chLabelNext')).visibility,
    };
  });
  expect(rightState.hasNoDesk).toBe(false);
  expect(rightState.chVis).not.toBe('hidden');
  expect(rightState.gap).toBeGreaterThanOrEqual(20);

  // Shrink viewport width so desk margin narrows and buttons would crowd/overlap
  await page.setViewportSize({ width: 920, height: 860 });
  await page.waitForFunction(() => document.getElementById('chNavRight').classList.contains('no-desk'), null, { timeout: 9000 });

  // Chapter button is cleanly hidden via no-desk, preventing accidental chapter jumps
  const narrowState = await page.evaluate(() => ({
    hasNoDesk: document.getElementById('chNavRight').classList.contains('no-desk'),
    chVis: getComputedStyle(document.getElementById('chLabelNext')).visibility,
  }));
  expect(narrowState.hasNoDesk).toBe(true);
  expect(narrowState.chVis).toBe('hidden');

  // Widen viewport back: chapter button cleanly returns
  await page.setViewportSize({ width: 1360, height: 860 });
  await page.waitForFunction(() => !document.getElementById('chNavRight').classList.contains('no-desk'), null, { timeout: 9000 });
  const restoredVis = await page.evaluate(() => getComputedStyle(document.getElementById('chLabelNext')).visibility);
  expect(restoredVis).not.toBe('hidden');
});
