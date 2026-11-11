// Install a side-vine pair into src/assets/ornaments/page-art.js as keys
// <keyBase>-l / <keyBase>-r (upsert: existing entries under the same base are
// replaced). Usage:
//   node tests/manual/install_vine_pair.cjs <left.svg> <right.svg> [keyBase]
// keyBase defaults to 'vine-01' (the main side-vine pair).
//
// Storage convention: files are stored in DISPLAY orientation and the RIGHT
// file is wrapped pre-mirrored (<g transform="translate(W 0) scale(-1 1)">,
// W = viewBox width) because .folio-vine.right in index.html applies a CSS
// scaleX(-1) — baked mirror + CSS flip cancel out, so the art shows exactly
// as authored. If the supplied right file is already author-pre-mirrored
// (one top-level translate(W 0) scale(-1 1) group wrapping all content),
// that group is unwrapped first so the flip is not applied twice.
//
// viewBox: .folio-vine uses background-size:100% 100%, so ANY viewBox works
// (it stretches to the 180/1200 element box; organic art tolerates it). The
// installer warns when the aspect differs from the slot.
//
// The SVGs go through a strict security scan — they end up as data URIs in
// the shipped app's CSS backgrounds, so scripts, handlers, external refs,
// and anything that makes whitespace-collapsing unsafe are rejected.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const [leftPath, rightPath] = process.argv.slice(2);
const keyBase = process.argv[4] || 'vine-01';
if(!leftPath || !rightPath){
  console.error('usage: node tests/manual/install_vine_pair.cjs <left.svg> <right.svg> [keyBase]');
  process.exit(1);
}
if(!/^[a-z0-9-]+$/i.test(keyBase)) throw new Error('bad keyBase: ' + keyBase);

function readSvg(p){
  // Strip an XML prolog if present, then trim.
  const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').replace(/<\?xml[\s\S]*?\?>\s*/, '').trim();
  if(!/^<svg[\s>]/.test(raw)) throw new Error(p + ': does not start with <svg>');
  if((raw.match(/<svg[\s>]/g) || []).length !== 1) throw new Error(p + ': multiple <svg> roots');
  if(!raw.endsWith('</svg>')) throw new Error(p + ': does not end with </svg>');
  const vb = /viewBox="([^"]+)"/.exec(raw);
  if(!vb) throw new Error(p + ': missing viewBox');
  const dims = vb[1].split(/[\s,]+/).map(Number);
  if(dims.length !== 4 || dims.some(n => !Number.isFinite(n)) || dims[2] <= 0 || dims[3] <= 0){
    throw new Error(p + ': bad viewBox ' + vb[1]);
  }
  const aspect = dims[2] / dims[3];
  const slotAspect = 180 / 1200;
  if(Math.abs(aspect - slotAspect) / slotAspect > 0.02){
    console.warn('note: ' + path.basename(p) + ' aspect ' + aspect.toFixed(4) +
      ' differs from the 180/1200 slot — it will stretch (background-size:100% 100%)');
  }
  const rejects = [
    [/<script/i, 'script tag'],
    [/\son[a-z]+\s*=/i, 'event handler'],
    [/javascript:/i, 'javascript: URL'],
    [/foreignObject/i, 'foreignObject'],
    [/<image[\s>]/i, 'embedded <image>'],
    [/href\s*=\s*["']?(?:https?:|\/\/)/i, 'external href'],
    [/<!\[CDATA\[/, 'CDATA section'],
    [/<style[\s>]/i, '<style> (whitespace collapse would be unsafe)'],
    [/<text[\s>]/i, '<text> (whitespace collapse would be unsafe)'],
  ];
  for(const [pat, label] of rejects){
    if(pat.test(raw)) throw new Error(p + ': REJECTED — ' + label);
  }
  return { svg: raw, vbW: dims[2], vbH: dims[3] };
}

// Comments out; whitespace BETWEEN tags out (attribute values untouched —
// readers reject <style>/<text> above, so no whitespace-significant nodes).
function minify(svg){
  return svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r/g, '')
    .replace(/>\s*\n\s*</g, '><')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n+/g, '')
    .trim();
}

/* Right files arrive in one of two orientations:
   - display orientation: wrap with the standard mirror group;
   - author-pre-mirrored: exactly one top-level <g transform="translate(W 0)
     scale(-1 1)"> around all content — strip it (restores display
     orientation), then wrap with our own mirror group in the same pass. */
function toStorageRight(svg, vbW){
  const openEnd = svg.indexOf('>');
  let inner = svg.slice(openEnd + 1, svg.length - '</svg>'.length);
  // The author's mirror group may be the sole content or may follow the
  // <defs> block — unwrap whichever form wraps the rendered content, then
  // re-wrap with the standard mirror so the CSS flip on .folio-vine.right
  // shows the art exactly as authored.
  const mirrorRe = new RegExp('^<g transform="translate\\(' + vbW + ' 0\\) scale\\(-1 1\\)">([\\s\\S]*)</g>$');
  const whole = mirrorRe.exec(inner);
  if(whole){
    inner = whole[1];
  } else {
    const defsEnd = inner.indexOf('</defs>');
    if(defsEnd >= 0){
      const head = inner.slice(0, defsEnd + '</defs>'.length);
      const afterDefs = mirrorRe.exec(inner.slice(head.length));
      if(afterDefs) inner = head + afterDefs[1];
    }
  }
  return svg.slice(0, openEnd + 1) + '<g transform="translate(' + vbW + ' 0) scale(-1 1)">' + inner + '</g></svg>';
}

function encode(svg){
  // Full data URI (entries always store the complete URI, prefix included).
  // encodeURIComponent leaves apostrophes intact and the URI is placed
  // inside url('...') in index.html — escape them explicitly.
  return 'data:image/svg+xml,' + encodeURIComponent(svg).replace(/'/g, '%27');
}

const L = readSvg(path.resolve(leftPath));
const R = readSvg(path.resolve(rightPath));
const left = minify(L.svg);
const right = toStorageRight(minify(R.svg), R.vbW);

const artPath = path.join(ROOT, 'src', 'assets', 'ornaments', 'page-art.js');
let art = fs.readFileSync(artPath, 'utf8');
// Upsert: splice out any existing entries under this key base first.
for(const k of [keyBase + '-l', keyBase + '-r']){
  const ki = art.indexOf("'" + k + "'");
  if(ki < 0) continue;
  const start = art.lastIndexOf('\n', ki);
  const endEq = art.indexOf(':', ki);
  const end = art.indexOf("',", endEq);
  if(end < 0) throw new Error('malformed existing entry for ' + k);
  art = art.slice(0, start) + art.slice(end + 2);
}
// Insert the new pair before the closing "};".
const close = art.lastIndexOf('};');
if(close < 0) throw new Error('page-art.js: closing }; not found');
art = art.slice(0, close).replace(/,\s*$/, '') +
  ",\n  '" + keyBase + "-l': '" + encode(left) + "'," +
  "\n  '" + keyBase + "-r': '" + encode(right) + "',\n};\n";
fs.writeFileSync(artPath, art);

// Round-trip validation: the rewritten file must load and carry the pair,
// byte-identical after decode, prefix intact, mirror group on the right.
for(const k of Object.keys(require.cache)) delete require.cache[k];
global.window = {};
require(artPath);
const dec = u => {
  if(!/^data:image\/svg\+xml,/.test(u)) throw new Error("stored '" + keyBase + "' is missing the data:image/svg+xml, prefix: " + u.slice(0, 60));
  return decodeURIComponent(u.replace(/^data:image\/svg\+xml,/, ''));
};
const keys = Object.keys(global.window.PAGE_ART);
if(dec(global.window.PAGE_ART[keyBase + '-l']) !== left) throw new Error('left round-trip mismatch');
const rDec = dec(global.window.PAGE_ART[keyBase + '-r']);
if(rDec !== right) throw new Error('right round-trip mismatch');
if(!rDec.includes('<g transform="translate(' + R.vbW + ' 0) scale(-1 1)">')) throw new Error('right mirror group missing');
// Double-mirror guard: exactly ONE mirror group may remain on the right.
if((rDec.match(/scale\(-1 1\)/g) || []).length !== 1) throw new Error('right file has ' +
  (rDec.match(/scale\(-1 1\)/g) || []).length + ' mirror groups — double-mirror?');
console.log('installed [' + keyBase + '-l, ' + keyBase + '-r]: left ' + left.length + 'B raw, right ' + right.length +
  'B raw (mirrored), page-art.js now ' + fs.statSync(artPath).size + 'B');
