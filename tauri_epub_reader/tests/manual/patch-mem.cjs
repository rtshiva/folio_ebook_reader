// one-off: update memory records for the desk-left batch
const fs = require('fs');
const mi = 'C:/Users/Siva/.zcode/cli/memories/projects/ebook_reader_glm53flash-8434f77c896147a7/memory/MEMORY.md';
let s = fs.readFileSync(mi, 'utf8');
s = s.replace(/e29dc41e… verified both sides/, '47b8c607… verified both sides (desk-left design: leaf canvas transparent, body paints right half only)');
fs.writeFileSync(mi, s);

const g = 'C:/Users/Siva/.zcode/cli/memories/projects/ebook_reader_glm53flash-8434f77c896147a7/memory/folio-epubjs-integration-gotchas.md';
let t = fs.readFileSync(g, 'utf8');
const anchor = '**Why:** these are invisible in code review';
const g23 = [
  '22. **html background-color:transparent does NOT make the iframe canvas transparent — CSS canvas propagation repaints the whole viewport with the BODY\'s paper** (found 2026-11-22 finishing the desk-left cover design): with html\'s background cleared, the canvas takes the body\'s background (full-width, shifted right) and paints BOTH halves cream again — every computed style reads transparent while the screenshot shows paper. Block propagation by giving html a background-IMAGE (even a fully transparent one): background:transparent linear-gradient(transparent,transparent) !important — background-image != none stops body-to-canvas propagation, so the canvas stays clear on the left (the desk shows through the transparent #viewer) while the shifted body paints only its own box. Note: elementFromPoint walked an all-transparent DOM chain while the pixels were paper — computed styles and screenshot pixels can disagree exactly via canvas propagation; probe BOTH together.',
  '',
].join('\n');
t = t.replace(anchor, g23 + anchor);
fs.writeFileSync(g, t);
console.log('memory updated:', s.includes('47b8c607'), t.includes('canvas propagation'));
