// Raster ornament extraction: renders sources at 2x, crops grid cells /
// regions to transparent PNGs, emits base64 data URIs into page-art.json.
// PNG crops (not vector surgery) — pixel-perfect fidelity to the source art.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path').resolve(__dirname, '../..').replace(/\\/g, '/') + '/';
const SRC = (f) => path + f;

(async () => {
  const browser = await chromium.launch();
  const out = {};

  // ---- 1. gold corner frame set (3000x3000, 6x6 grid of ~500px cells) ----
  {
    const svg = fs.readFileSync(SRC('vecteezy_gold-vector-illustration-of-decorative-corner-frame-set_35437823.svg'), 'utf8');
    const page = await browser.newPage({ viewport: { width: 1500, height: 1500 } });
    await page.setContent('<body style="margin:0">' +
      svg.replace('<svg ', '<svg style="width:1500px;height:1500px;display:block" ') + '</body>');
    await page.waitForTimeout(600);
    // 6x6 grid, cell 250 CSS px; capture at 2x for crispness
    const cell = 250;
    const picks = [[0,0],[0,1],[0,4],[1,0],[1,2],[2,2],[3,1],[3,2],[5,1],[5,2],[5,4],[5,5]];
    for (const [r, c] of picks) {
      const clip = { x: c * cell, y: r * cell, width: cell, height: cell };
      const buf = await page.screenshot({ clip, omitBackground: true });
      out['gold-' + r + '-' + c] = 'data:image/png;base64,' + buf.toString('base64');
    }
    await page.close();
    console.log('gold cells:', picks.length);
  }

  // ---- 2. headpieces (399x233): top small + bottom large, at 2x ----
  {
    const svg = fs.readFileSync(SRC('vecteezy_free-floral-ornamental-border-vectors_81749.svg'), 'utf8');
    const page = await browser.newPage({ viewport: { width: 798, height: 466 } });
    await page.setContent('<body style="margin:0">' +
      svg.replace('<svg ', '<svg style="width:798px;height:466px;display:block" ') + '</body>');
    await page.waitForTimeout(300);
    // viewBox 399x233 at 2x: top headpiece y~52-214, bottom y~246-332 (2x of 26-107 / 123-166)
    out['head-large'] = 'data:image/png;base64,' + (await page.screenshot({
      clip: { x: 100, y: 240, width: 600, height: 100 }, omitBackground: true })).toString('base64');
    out['head-small'] = 'data:image/png;base64,' + (await page.screenshot({
      clip: { x: 180, y: 40, width: 440, height: 180 }, omitBackground: true })).toString('base64');
    await page.close();
    console.log('headpieces done');
  }

  // ---- 3. leaves pattern (1400x980): strip the background rects, crop a
  // seamless slice of the 2nd swatch for the tinted running pattern ----
  {
    const svg = fs.readFileSync(SRC('vecteezy_free-leaves-pattern-vector_101169.svg'), 'utf8');
    const page = await browser.newPage({ viewport: { width: 1400, height: 980 } });
    await page.setContent('<body style="margin:0">' + svg + '</body>');
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      // drop the four full-height background rectangles (largest-area shapes)
      const shapes = [...document.querySelectorAll('svg *')].filter((el) => {
        const b = el.getBoundingClientRect();
        return b.width > 200 && b.height > 800;
      });
      shapes.forEach((el) => el.remove());
    });
    await page.waitForTimeout(200);
    // swatch 2 spans x 245-490; take a 245x160 slice at y 300 (2x: 490,600,490x320)
    const buf = await page.screenshot({
      clip: { x: 245, y: 290, width: 245, height: 170 }, omitBackground: true });
    out['leaf-tile'] = 'data:image/png;base64,' + buf.toString('base64');
    await page.close();
    console.log('leaf tile done');
  }

  fs.writeFileSync('tests/manual/page-art.json', JSON.stringify(out));
  const total = Object.values(out).reduce((a, s) => a + s.length, 0);
  console.log('pieces:', Object.keys(out).length, 'total data:', Math.round(total / 1024) + 'KB');
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
