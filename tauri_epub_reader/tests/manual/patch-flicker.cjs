// one-off: add frame dumping to flicker-probe.mjs
const fs = require('fs');
const p = 'tests/manual/flicker-probe.mjs';
let s = fs.readFileSync(p, 'utf8');
const anchor = "console.log('   timeline:', rows.filter((r, i) => i % 3 === 0 || r.L > 0.2 || r.R > 0.2)";
const idx = s.indexOf(anchor);
if(idx === -1){ console.log('ANCHOR NOT FOUND'); process.exit(1); }
const lineEnd = s.indexOf('\n', s.indexOf(".join(' | ')", idx));
const dump = [
  "  const tag = label.replace(/[^A-Z]/g, '') || 'X';",
  "  frames.slice(0, 3).forEach((f, i) => require('fs').writeFileSync('tests/manual/fp-' + tag + '-' + i + '.png', Buffer.from(f.data, 'base64')));",
  "  if(frames.length) require('fs').writeFileSync('tests/manual/fp-' + tag + '-last.png', Buffer.from(frames[frames.length - 1].data, 'base64'));"
].join('\n');
s = s.slice(0, lineEnd + 1) + dump + '\n' + s.slice(lineEnd + 1);
fs.writeFileSync(p, s);
console.log('patched ok');
