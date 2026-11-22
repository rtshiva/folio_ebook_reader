// One-off: dedupe the double-applied Dbg patches (LF variant from run 1),
// then the fixed LOCS attach patch applies via the updated patcher.
const fs = require('fs');
const p = 'src/index.html';
let s = fs.readFileSync(p, 'utf8');
let removed = 0;

function removeLFBlock(startMarker, endMarker, label) {
  // find the copy whose block contains a bare \n (LF-only insertion)
  let idx = -1, from = 0;
  const hits = [];
  while ((idx = s.indexOf(startMarker, from)) !== -1) {
    hits.push(idx);
    from = idx + 1;
  }
  if (hits.length < 2) { console.log('dupe', label, 'count', hits.length, '— nothing to dedupe'); return; }
  for (const i of hits) {
    const end = s.indexOf(endMarker, i);
    if (end === -1) continue;
    const block = s.slice(i, end + endMarker.length);
    if (/\n[^\r]/.test(block.replace(/\r\n/g, '\u0000')) || /(^|[^\r])\n/.test(block)) {
      s = s.slice(0, i) + s.slice(end + endMarker.length);
      removed++;
      console.log('removed LF dup of', label);
      return;
    }
  }
  console.log('dupe', label, '— no LF variant found (inspect manually)');
}

removeLFBlock('<script src="./__buildflag.js"></script>', '<script src="./__buildflag.js"></script>', 'buildflag');
removeLFBlock('const Dbg = {', "Dbg.log('INIT', 'build ', ", 'Dbg module');
removeLFBlock("el('swDebugLog').checked=", "el('swDebugLog').disabled", 'swDebugLog sync');
removeLFBlock("Dbg.log('GEO', 'recreate'", ", inner: innerWidth + 'x' + innerHeight });", 'GEO recreate');
removeLFBlock("Dbg.log('LEAF', 'persist'", ", idx: loc.start.index });", 'LEAF persist');
removeLFBlock("Dbg.log('OPEN', 'done'", ", ms: performance.now() | 0 });", 'OPEN done');
// validate boolean list — single-line, no dupe possible; verify:
console.log('validate list count:', (s.match(/'rrFrame','debugLog'\]/g) || []).length);

fs.writeFileSync(p, s);
console.log('removed blocks:', removed);
