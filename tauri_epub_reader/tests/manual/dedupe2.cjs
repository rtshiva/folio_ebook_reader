// One-off: remove second-of-adjacent duplicate insertions from the double patch run.
const fs = require('fs');
const p = 'src/index.html';
let lines = fs.readFileSync(p, 'utf8').split('\n');

function removeSecondAdjacency(marker, blockEndMarker) {
  const hits = [];
  lines.forEach((l, i) => { if (l.includes(marker)) hits.push(i); });
  if (hits.length !== 2) { console.log('dupe', marker.slice(0, 30), 'count', hits.length, '— inspect'); return; }
  const [a, b] = hits;
  if (b - a > 140) { console.log('dupe', marker.slice(0, 30), 'too far apart — inspect'); return; }
  // remove lines b .. (blockEnd line) — for single-line dupes b itself
  let end = b;
  if (blockEndMarker) {
    for (let i = b; i < lines.length && i <= b + 140; i++) {
      if (lines[i].includes(blockEndMarker)) { end = i; break; }
    }
  }
  lines.splice(b, end - b + 1);
  console.log('removed lines', b + 1, '..', end + 1, 'of', marker.slice(0, 30));
}

removeSecondAdjacency('<script src="./__buildflag.js"></script>', null);
removeSecondAdjacency('const Dbg = {', "Dbg.log('INIT'");
removeSecondAdjacency("Dbg.log('OPEN', 'done'", null);
removeSecondAdjacency("Dbg.log('GEO', 'recreate'", null);
removeSecondAdjacency("Dbg.log('LEAF', 'persist'", null);

fs.writeFileSync(p, lines.join('\n'));
console.log('done');
