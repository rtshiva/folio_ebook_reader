// Builds a synthetic EPUB whose TOC packs 4 entries per spine file
// (fragment anchors), like most real books, then saves it to %TEMP%.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require2 = createRequire(import.meta.url);
const JSZip = require2(path.join(path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'src', 'vendor', 'jszip.min.js'));

const zip = new JSZip();

const chapter = (id, n) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${n}</title></head>
<body><h1 id="s1">Chapter ${n} — part one</h1><p>${('Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima. ').repeat(40)}</p>
<h2 id="s2">Chapter ${n} — part two</h2><p>${('The quick brown fox jumps over the lazy dog while calm waves roll under amber skies. ').repeat(40)}</p>
<h2 id="s3">Chapter ${n} — part three</h2><p>${('Pack my box with five dozen liquor jugs; how vexingly quick daft zebras jump far. ').repeat(40)}</p>
<h2 id="s4">Chapter ${n} — part four</h2><p>${('Sphinx of black quartz judge my vow for the night is long and the road is longer still. ').repeat(40)}</p>
</body></html>`;

const files = ['ch1.xhtml', 'ch2.xhtml'];
files.forEach((f, i) => zip.file(`OEBPS/text/${f}`, chapter(f, i + 1)));

zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);

let manifest = '', spine = '', navLis = '', ncxPoints = '';
const items = [];
files.forEach((f, i) => {
  ['s1', 's2', 's3', 's4'].forEach((s, j) => {
    const n = i * 4 + j + 1;
    items.push({ id: `c${n}`, href: `text/${f}#${s}`, label: `Chapter ${n} — part ${j + 1}` });
  });
  manifest += `<item id="c${i + 1}" href="text/${f}" media-type="application/xhtml+xml"/>`;
  spine += `<itemref idref="c${i + 1}"/>`;
});
items.forEach((it, i) => {
  navLis += `<li><a href="${it.href}">${it.label}</a></li>`;
  ncxPoints += `<navPoint id="np${i + 1}" playOrder="${i + 1}"><navLabel><text>${it.label}</text></navLabel><content src="${it.href}"/></navPoint>`;
});

zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:multi-anchor-test</dc:identifier>
<dc:title>Multi Anchor Test</dc:title><dc:creator>Probe</dc:creator><meta property="dcterms:modified">2026-09-30T00:00:00Z</meta></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>${manifest}</manifest>
<spine toc="ncx">${spine}</spine></package>`);

zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Nav</title></head>
<body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol>${navLis}</ol></nav></body></html>`);

zip.file('OEBPS/toc.ncx', `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:multi-anchor-test"/></head>
<docTitle><text>Multi Anchor Test</text></docTitle><navMap>${ncxPoints}</navMap></ncx>`);

const out = process.argv[2] || path.join(process.env.TEMP || '/tmp', 'multi_anchor.epub');
const buf = await zip.generateAsync({ type: 'nodebuffer' });
writeFileSync(out, buf);
console.log('wrote', out, buf.length, 'bytes,', items.length, 'toc entries /', files.length, 'spine files');
