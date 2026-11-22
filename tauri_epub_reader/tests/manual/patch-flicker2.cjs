// one-off: fix probe book (valid XHTML, separate cover file) + mean-color classifier
const fs = require('fs');
const p = 'tests/manual/flicker-probe.mjs';
let s = fs.readFileSync(p, 'utf8');

// 1. classifier: mean color distance instead of sparse-ink fraction
s = s.replace(
  "      let non = 0, tot = 0;\n        for(let i = 0; i < d.length; i += 4){\n          const dd = Math.abs(d[i] - pr[0]) + Math.abs(d[i+1] - pr[1]) + Math.abs(d[i+2] - pr[2]);\n          if(dd > 60) non++;\n          tot++;\n        }\n        return non / tot;",
  "      let sum = 0, tot = 0;\n        for(let i = 0; i < d.length; i += 4){\n          sum += Math.abs(d[i] - pr[0]) + Math.abs(d[i+1] - pr[1]) + Math.abs(d[i+2] - pr[2]);\n          tot++;\n        }\n        return sum / tot / 3;"
);
s = s.replace("const onLeft = row.L > 0.25 && row.R < 0.2;", "const onLeft = row.L > 14 && row.R < 8;");
s = s.replace("const onRight = row.R > 0.25 && row.L < 0.2;", "const onRight = row.R > 14 && row.L < 8;");
s = s.replace("firstRight = row.t;", "firstRight = row.t;");

// 2. rebuilt image-cover run: valid XHTML, cover as its own 1-page spine file
const start = s.indexOf("// ---- run 2: image-cover book ----");
const endMark = "await analyze(coverFrames, 'IMAGE COVER');";
const end = s.indexOf(endMark) + endMark.length;
const replacement = `// ---- run 2: image-cover book ----
await page.evaluate(() => closeBook());
await page.waitForTimeout(400);
const coverFrames = await screencast(async () => {
  await page.evaluate(async () => {
    const c1 = document.createElement('canvas');
    c1.width = 400; c1.height = 600;
    const ctx1 = c1.getContext('2d');
    ctx1.fillStyle = '#1e3799'; ctx1.fillRect(0, 0, 400, 600);
    ctx1.fillStyle = '#f7f1e3'; ctx1.font = '700 48px serif';
    ctx1.fillText('TEST', 90, 300);
    const covBuf = await (await new Promise(r => c1.toBlob(r, 'image/png'))).arrayBuffer();
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml', \`<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>\`);
    zip.file('OEBPS/cov.png', covBuf);
    zip.file('OEBPS/content.opf', \`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">test-cover-book</dc:identifier>
    <dc:title>Image Cover Test</dc:title>
    <dc:creator>Probe</dc:creator>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="cov" href="cov.png" media-type="image/png"/>
    <item id="covp" href="cov.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="covp"/><itemref idref="c1"/></spine>
</package>\`);
    zip.file('OEBPS/cov.xhtml', \`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Cover</title></head>
<body>
  <div class="galley"><div class="cover-wrapper"><img src="cov.png" alt="Cover"/></div></div>
</body>
</html>\`);
    zip.file('OEBPS/ch1.xhtml', \`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter</title></head>
<body>
  \${(new Array(60).fill(0)).map((_, i) => \`<p>Paragraph \${i} — the time traveller expounded a recondite matter to us with a certain zest and his grey eyes shone and twinkled while pale fingers pressed the soft radiance.</p>\`).join('\\n')}
</body>
</html>\`);
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    await openBuffer(buf, 'Image Cover Test');
  });
  await page.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 15000 });
});
await analyze(coverFrames, 'IMAGE COVER');`;
s = s.slice(0, start) + replacement + s.slice(end);
fs.writeFileSync(p, s);
console.log('patched ok');
