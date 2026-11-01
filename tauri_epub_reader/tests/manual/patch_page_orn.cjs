// One-shot (CRLF-tolerant): replace the inline-SVG PAGE_ORN block with the
// window.PAGE_ART consumer.
const fs = require('fs');
let s = fs.readFileSync('src/index.html', 'utf8');
const start = s.indexOf('const PAGE_ORN = {');
const tail = s.indexOf("v('bottom') + '</div>';");
if (start < 0 || tail < 0) { console.log('ANCHOR FAIL', start, tail); process.exit(1); }
// swallow the closing brace of pageOrnMarkup right after the tail
const brace = s.indexOf('}', tail);
const end = brace + 1;
const nl = s.indexOf('\n', end);
const repl = `/* Page corner art (per-chapter margin ornaments), sourced from Vecteezy
   free downloads (see assets/ornaments/VECTEEZY-LICENSE.txt): 12 gold
   corner frames for the chapter opening, a gold headpiece above the
   opening, and a small fleuron for every continuation page. Raster PNG
   data URIs from assets/ornaments/page-art.js (window.PAGE_ART) — file
   URLs would break inside book/blob chapter bases, and the gold pieces
   keep their baked gradients as direct backgrounds. The .opening class on
   the wrapper (relocation page state) picks grand vs continuation. */
const PAGE_ORN = {
  keys: Object.keys(window.PAGE_ART || {}).filter(k => k.indexOf('gold-') === 0)
};
function pageOrnVariant(idx){
  const s = 'c' + String(idx == null ? 0 : idx);
  let h = 0;
  for(let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % Math.max(1, PAGE_ORN.keys.length);
}
function pageOrnMarkup(idx){
  if(!settings.pageOrnaments || !window.PAGE_ART || !PAGE_ORN.keys.length) return '';
  const ug = "url('" + PAGE_ART[PAGE_ORN.keys[pageOrnVariant(idx)]] + "')";
  const uh = "url('" + PAGE_ART['head-large'] + "')";
  const us = "url('" + PAGE_ART['head-small'] + "')";
  const g = p => '<span class="folio-pg ' + p + '" style="background-image:' + ug + '"></span>';
  return '<div id="folio-pcs" style="position:fixed;inset:0;pointer-events:none;z-index:1">' +
    g('tl') + g('tr') + g('bl') + g('br') +
    '<span class="folio-ph grand" style="background:#c9a45c;mask-image:' + uh + ';-webkit-mask-image:' + uh + '"></span>' +
    '<span class="folio-ph simple" style="background:#c9a45c;mask-image:' + us + ';-webkit-mask-image:' + us + '"></span>' +
    '</div>';
}` + s.slice(nl);
s = s.slice(0, start) + repl;
fs.writeFileSync('src/index.html', s);
console.log('PAGE_ORN block replaced (crlf-aware), brace at', brace);
