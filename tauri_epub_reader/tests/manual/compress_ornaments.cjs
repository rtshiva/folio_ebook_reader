// Compress extracted pieces (dedupe paints into classes, drop identity
// transforms, 1-decimal d) + render a contact sheet for visual verification.
const { chromium } = require('playwright');
const fs = require('fs');
const p = __dirname.replace(/\/g, '/') + '/';

const raw = JSON.parse(fs.readFileSync(p + 'orn-extracted.json', 'utf8'));
const out = {};
for (const [name, svg] of Object.entries(raw)) {
  let s = svg.replace(/<\/g>/g, '</g>');
  // collect shapes
  const shapes = [...s.matchAll(/<(path|circle|rect|polygon|ellipse|line)\b[^>]*>/g)];
  const paints = new Map();
  s = s.replace(/(<(?:path|circle|rect|polygon|ellipse|line)\b[^>]*?)fill="([^"]+)" stroke="([^"]+)" stroke-width="([^"]+)" opacity="([^"]+)"([^>]*>)/g,
    (m, pre, fill, stroke, sw, op, post) => {
      if (op === '1') op = '';
      const key = fill + '|' + stroke + '|' + sw + (op ? '|' + op : '');
      if (!paints.has(key)) paints.set(key, 'k' + paints.size);
      const cls = paints.get(key);
      let attrs = pre.replace(/ transform="matrix\(1 0 0 1 0 0\)"/, '');
      // 1-decimal all long decimals in d
      attrs = attrs.replace(/d="([^"]+)"/, (mm, d) => 'd="' + d.replace(/-?\d+\.\d{2,}/g, (n) => (+n).toFixed(1)) + '"');
      return attrs.slice(0, -1) + ' class="' + cls + '">';
    });
  let style = '<style>';
  for (const [key, cls] of paints) {
    const [fill, stroke, sw, op] = key.split('|');
    style += '.' + cls + '{fill:' + fill + ';stroke:' + stroke + ';stroke-width:' + sw + ';' + (op ? 'opacity:' + op + ';' : '') + '}';
  }
  style += '</style>';
  s = s.replace(/(<svg[^>]*>)/, '$1' + style);
  out[name] = s;
  console.log(name, s.length, 'bytes');
}
fs.writeFileSync(p + 'orn-final.json', JSON.stringify(out));
console.log('total', Object.values(out).reduce((a, s) => a + s.length, 0), 'bytes');

// contact sheet
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const names = Object.keys(out);
  const cells = names.map((n, i) =>
    '<div style="border:1px solid #ccc;padding:4px"><div style="font:10px sans-serif">' + n + '</div>' +
    '<div style="width:200px;height:120px;display:grid;place-items:center">' + out[n] + '</div></div>').join('');
  await page.setContent('<body style="margin:0;background:#fff"><div style="display:flex;flex-wrap:wrap">' + cells + '</div></body>');
  await page.waitForTimeout(300);
  await page.screenshot({ path: p + 'shots/pageorn/contact-sheet.png', fullPage: true });
  await browser.close();
  console.log('sheet done');
})();
