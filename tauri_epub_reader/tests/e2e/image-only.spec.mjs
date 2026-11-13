import { test, expect } from '@playwright/test';
import { fresh } from './helpers.mjs';

test.describe('image-only full-height pages', () => {
  test('cover image and back page fill full height in single and spread mode without distortion', async ({ page }) => {
    await fresh(page);

    await page.evaluate(async () => {
      // 1. Cover image: 400x600 (portrait)
      const c1 = document.createElement('canvas');
      c1.width = 400; c1.height = 600;
      const ctx1 = c1.getContext('2d');
      ctx1.fillStyle = '#1e3799'; ctx1.fillRect(0, 0, 400, 600);
      const covBlob = await new Promise(r => c1.toBlob(r, 'image/png'));
      const covBuf = await covBlob.arrayBuffer();

      // 2. Small divider: 24x24
      const c2 = document.createElement('canvas');
      c2.width = 24; c2.height = 24;
      const ctx2 = c2.getContext('2d');
      ctx2.fillStyle = '#eb2f06'; ctx2.fillRect(0, 0, 24, 24);
      const divBlob = await new Promise(r => c2.toBlob(r, 'image/png'));
      const divBuf = await divBlob.arrayBuffer();

      // 3. Back cover image: 450x600
      const c3 = document.createElement('canvas');
      c3.width = 450; c3.height = 600;
      const ctx3 = c3.getContext('2d');
      ctx3.fillStyle = '#079992'; ctx3.fillRect(0, 0, 450, 600);
      const backBlob = await new Promise(r => c3.toBlob(r, 'image/png'));
      const backBuf = await backBlob.arrayBuffer();

      const zip = new JSZip();
      zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
      zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);

      zip.file('OEBPS/cov.png', covBuf);
      zip.file('OEBPS/div.png', divBuf);
      zip.file('OEBPS/back.png', backBuf);

      // Spine 0: Cover (nested galley > wrapper > img)
      zip.file('OEBPS/cov.xhtml', `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Cover</title></head>
<body>
  <div class="galley">
    <div class="cover-wrapper">
      <img src="cov.png" alt="Cover Image" />
    </div>
  </div>
</body>
</html>`);

      // Spine 1: Dedication (small ornament + text)
      zip.file('OEBPS/ded.xhtml', `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Dedication</title></head>
<body>
  <div class="dedication">
    <p>To curious minds everywhere.</p>
    <p><img src="div.png" width="24" height="24" alt="divider" /></p>
  </div>
</body>
</html>`);

      // Spine 2: Chapter 1 (heading + standard paragraphs)
      zip.file('OEBPS/ch1.xhtml', `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 1</title></head>
<body>
  <h1>Chapter 1</h1>
  <p>The journey begins with a single step into the unknown.</p>
</body>
</html>`);

      // Spine 3: SVG Title Plate (SVG with preserveAspectRatio="none" which should be normalized)
      zip.file('OEBPS/titleplate.xhtml', `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Title Plate</title></head>
<body>
  <div class="title-container">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 600" width="100%" height="100%" preserveAspectRatio="none">
      <image width="400" height="600" href="cov.png" preserveAspectRatio="none"/>
    </svg>
  </div>
</body>
</html>`);

      // Spine 4: Back Cover (naked body > img)
      zip.file('OEBPS/back.xhtml', `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Back Cover</title></head>
<body>
  <img src="back.png" alt="Back Cover" />
</body>
</html>`);

      zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:test:imageonly-fullheight</dc:identifier>
    <dc:title>Image Only Test</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="s0" href="cov.xhtml" media-type="application/xhtml+xml"/>
    <item id="s1" href="ded.xhtml" media-type="application/xhtml+xml"/>
    <item id="s2" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="s3" href="titleplate.xhtml" media-type="application/xhtml+xml"/>
    <item id="s4" href="back.xhtml" media-type="application/xhtml+xml"/>
    <item id="i0" href="cov.png" media-type="image/png"/>
    <item id="i1" href="div.png" media-type="image/png"/>
    <item id="i2" href="back.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="s0"/>
    <itemref idref="s1"/>
    <itemref idref="s2"/>
    <itemref idref="s3"/>
    <itemref idref="s4"/>
  </spine>
</package>`);

      const epBuf = await zip.generateAsync({ type: 'arraybuffer' });
      await openBuffer(epBuf, 'Image Only Test');
    });

    await page.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 12000 });
    await page.waitForTimeout(600);

    // 1. Verify Cover (Spine 0)
    const covMetrics = await page.evaluate(() => {
      const frame = document.querySelector('#viewer iframe');
      const doc = frame.contentDocument;
      const img = doc.querySelector('img');
      const vH = el('viewer').getBoundingClientRect().height;
      const vW = el('viewer').getBoundingClientRect().width;
      const isImgOnly = doc.body.classList.contains('folio-image-only');
      const imgRect = img.getBoundingClientRect();
      return {
        isImgOnly,
        vH,
        vW,
        scrollW: doc.body.scrollWidth,
        imgH: imgRect.height,
        imgW: imgRect.width,
        imgTop: imgRect.top,
        imgLeft: imgRect.left
      };
    });

    expect(covMetrics.isImgOnly).toBe(true);
    // Height fits the full viewport height!
    expect(Math.abs(covMetrics.imgH - covMetrics.vH)).toBeLessThanOrEqual(2);
    // Aspect ratio preserved (400:600 = 2/3)
    const expectedW = (400 / 600) * covMetrics.vH;
    expect(Math.abs(covMetrics.imgW - expectedW)).toBeLessThanOrEqual(2);
    // Zero multi-column horizontal overflow: scrollWidth === viewer width
    expect(covMetrics.scrollW).toBeLessThanOrEqual(covMetrics.vW + 2);

    // 2. Test Dedication (Spine 1): MUST NOT be treated as image-only!
    await page.evaluate(async () => {
      await state.rendition.display(state.book.spine.get(1).href);
    });
    await page.waitForTimeout(600);

    const dedMetrics = await page.evaluate(() => {
      const frame = document.querySelector('#viewer iframe');
      const doc = frame.contentDocument;
      return {
        isImgOnly: doc.body.classList.contains('folio-image-only'),
        hasText: (doc.body.innerText || '').includes('curious minds')
      };
    });
    expect(dedMetrics.isImgOnly).toBe(false);
    expect(dedMetrics.hasText).toBe(true);

    // 3. Test Chapter 1 (Spine 2): MUST NOT be treated as image-only!
    await page.evaluate(async () => {
      await state.rendition.display(state.book.spine.get(2).href);
    });
    await page.waitForTimeout(600);

    const ch1Metrics = await page.evaluate(() => {
      const frame = document.querySelector('#viewer iframe');
      const doc = frame.contentDocument;
      return {
        isImgOnly: doc.body.classList.contains('folio-image-only'),
        hasHeading: !!doc.querySelector('h1')
      };
    });
    expect(ch1Metrics.isImgOnly).toBe(false);
    expect(ch1Metrics.hasHeading).toBe(true);

    // 4. Test SVG Title Plate (Spine 3): Normalized and full height
    await page.evaluate(async () => {
      await state.rendition.display(state.book.spine.get(3).href);
    });
    await page.waitForTimeout(600);

    const svgMetrics = await page.evaluate(() => {
      const frame = document.querySelector('#viewer iframe');
      const doc = frame.contentDocument;
      const svg = doc.querySelector('svg');
      const vH = el('viewer').getBoundingClientRect().height;
      const pRatio = svg.getAttribute('preserveAspectRatio');
      const svgRect = svg.getBoundingClientRect();
      return {
        isImgOnly: doc.body.classList.contains('folio-image-only'),
        vH,
        pRatio,
        svgH: svgRect.height,
        svgW: svgRect.width
      };
    });
    expect(svgMetrics.isImgOnly).toBe(true);
    expect(svgMetrics.pRatio).toBe('xMidYMid meet');
    expect(Math.abs(svgMetrics.svgH - svgMetrics.vH)).toBeLessThanOrEqual(2);

    // 5. Test Back Cover (Spine 4): Direct body > img wrapped and full height
    await page.evaluate(async () => {
      await state.rendition.display(state.book.spine.get(4).href);
    });
    await page.waitForTimeout(600);

    const backMetrics = await page.evaluate(() => {
      const frame = document.querySelector('#viewer iframe');
      const doc = frame.contentDocument;
      const img = doc.querySelector('img');
      const wrap = doc.querySelector('.folio-image-wrapper');
      const vH = el('viewer').getBoundingClientRect().height;
      const imgRect = img.getBoundingClientRect();
      return {
        isImgOnly: doc.body.classList.contains('folio-image-only'),
        hasWrapper: !!wrap,
        vH,
        imgH: imgRect.height
      };
    });
    expect(backMetrics.isImgOnly).toBe(true);
    expect(backMetrics.hasWrapper).toBe(true);
    expect(Math.abs(backMetrics.imgH - backMetrics.vH)).toBeLessThanOrEqual(2);

    // 6. Test Two-Page Spread Mode behavior
    // Ensure cover stays in Column 1 and does not cross gutter
    await page.evaluate(async () => {
      settings.spread = 'on';
      save();
      await relayout();
      await state.rendition.display(state.book.spine.get(0).href);
    });
    await page.waitForTimeout(800);

    const spreadMetrics = await page.evaluate(() => {
      const frame = document.querySelector('#viewer iframe');
      const doc = frame.contentDocument;
      const img = doc.querySelector('img');
      const vW = el('viewer').getBoundingClientRect().width;
      const vH = el('viewer').getBoundingClientRect().height;
      const halfW = vW / 2;
      const imgRect = img.getBoundingClientRect();
      return {
        isSpread: !!state.spreadOn,
        vW,
        vH,
        halfW,
        imgRight: imgRect.left + imgRect.width,
        imgH: imgRect.height,
        scrollW: doc.body.scrollWidth
      };
    });

    expect(spreadMetrics.isSpread).toBe(true);
    // In spread mode, height is full height
    expect(Math.abs(spreadMetrics.imgH - spreadMetrics.vH)).toBeLessThanOrEqual(2);
    // Image stays strictly inside left page (Column 1), before half width gutter
    expect(spreadMetrics.imgRight).toBeLessThanOrEqual(spreadMetrics.halfW);
    // scrollWidth does not spill into extra phantom spreads
    expect(spreadMetrics.scrollW).toBeLessThanOrEqual(spreadMetrics.vW + 2);
  });
});
