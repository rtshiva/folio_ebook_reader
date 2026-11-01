// Vecteezy ornament extraction v2: transform-aware. Renders each SVG at
// native size, walks every shape, bakes its CTM + computed paint onto a
// flattened <path>, classifies by canvas-space bbox center (watermark strip
// excluded), and precision-reduces per piece for data-URI embedding.
const { chromium } = require('playwright');
const fs = require('fs');
const path = 'F:/Siva_f/ebook_reader_glm53flash/';

const JOBS = [
  { file: 'vecteezy_page-border-line-vectors_95547.svg', name: 'corner', cols: 3, rows: 2, waterMinY: 880 },
  { file: 'vecteezy_floral-ornament-vectors_87406.svg', name: 'floral', cols: 3, rows: 2, waterMinY: 600 },
  { file: 'vecteezy_free-floral-ornamental-border-vectors_81749.svg', name: 'head', cols: 1, rows: 2, waterMinY: 99999 },
];

(async () => {
  const browser = await chromium.launch();
  const out = {};
  for (const job of JOBS) {
    const svg = fs.readFileSync(path + job.file, 'utf8');
    const vbm = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    const W = Math.ceil(+vbm[1]), H = Math.ceil(+vbm[2]);
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    await page.setContent('<body style="margin:0">' + svg + '</body>');
    await page.waitForTimeout(150);
    const pieces = await page.evaluate((job) => {
      const svgEl = document.querySelector('svg');
      const shapes = svgEl.querySelectorAll('path,circle,rect,polygon,ellipse,line');
      const cellW = svgEl.viewBox.baseVal.width / job.cols;
      const cellH = svgEl.viewBox.baseVal.height / job.rows;
      const cells = {};
      shapes.forEach((sh) => {
        if (sh.closest('text')) return;
        const r = sh.getBoundingClientRect();
        if (r.width < 0.5 && r.height < 0.5) return;
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (cy > job.waterMinY) return; // watermark strip
        const col = Math.min(job.cols - 1, Math.max(0, Math.floor(cx / cellW)));
        const row = Math.min(job.rows - 1, Math.max(0, Math.floor(cy / cellH)));
        const key = row * job.cols + col;
        const ctm = sh.getCTM(); // shape user space -> svg viewport space
        const cs = getComputedStyle(sh);
        const d = sh.getAttribute('d') ||
          (sh.tagName.toLowerCase() === 'circle' ? null : null);
        let shapeHtml;
        if (d) {
          shapeHtml = '<path d="' + d + '" transform="matrix(' +
            [ctm.a, ctm.b, ctm.c, ctm.d, ctm.e, ctm.f].map((n) => +n.toFixed(3)).join(' ') + ')"/>';
        } else {
          shapeHtml = sh.outerHTML.replace(/^<(\w+)/, '<$1 data-keep="1"');
        }
        const b = cells[key] = cells[key] || { items: [], minx: 1e9, miny: 1e9, maxx: -1e9, maxy: -1e9 };
        // intersect the shape rect with its cell region so one stray
        // background path can't balloon the piece's viewBox
        const cellL = col * cellW, cellT = row * cellH;
        const ix = Math.max(r.left, cellL), iy = Math.max(r.top, cellT);
        const ixx = Math.min(r.right, cellL + cellW), iyy = Math.min(r.bottom, cellT + cellH);
        if (ixx - ix < 0.5 || iyy - iy < 0.5) return;
        b.items.push({ shapeHtml,
          fill: cs.fill, stroke: cs.stroke, sw: cs.strokeWidth, op: cs.opacity,
          minx: ix, miny: iy, maxx: ixx, maxy: iyy });
        const it = b.items[b.items.length - 1];
        b.minx = Math.min(b.minx, it.minx); b.miny = Math.min(b.miny, it.miny);
        b.maxx = Math.max(b.maxx, it.maxx); b.maxy = Math.max(b.maxy, it.maxy);
      });
      const pad = 3;
      const out = {};
      Object.keys(cells).sort((a, b) => a - b).forEach((k) => {
        const c = cells[k];
        if (!c.items.length) return;
        const vx = Math.max(0, c.minx - pad), vy = Math.max(0, c.miny - pad);
        const vw = c.maxx - vx + pad, vh = c.maxy - vy + pad;
        const body = c.items.map((it) => {
          let h = it.shapeHtml;
          const paint = 'fill="' + it.fill + '" stroke="' + it.stroke +
            '" stroke-width="' + it.sw + '" opacity="' + it.op + '"';
          if (/data-keep/.test(h)) h = h.replace('data-keep="1"', paint);
          else h = h.replace('/>', ' ' + paint + '/>');
          return h;
        }).join('');
        out['p' + k] = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' +
          [vx.toFixed(1), vy.toFixed(1), vw.toFixed(1), vh.toFixed(1)].join(' ') + '">' + body + '</svg>';
      });
      return out;
    }, job);
    Object.keys(pieces).forEach((k) => {
      out[job.name + '-' + k] = pieces[k];
      console.log(job.name + '-' + k, ':', pieces[k].length, 'bytes');
    });
    await page.close();
  }
  fs.writeFileSync(path + 'tauri_epub_reader/tests/manual/orn-extracted.json', JSON.stringify(out));
  await browser.close();
  console.log('TOTAL pieces:', Object.keys(out).length);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
