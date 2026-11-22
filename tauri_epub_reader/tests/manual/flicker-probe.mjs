// Flicker probe: screencast frames during book open; classify which page
// (left/right half of the viewer) holds visible content per frame. A flicker
// = a contentOnLeft frame arriving AFTER the first contentOnRight frame.
// Runs the demo (text title page) and a built image-cover book.
import { chromium } from 'playwright';
import { writeFileSync as fsWriteFileSync } from 'fs';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });

async function setup() {
  await page.goto('http://127.0.0.1:8127/');
  await page.evaluate(() => {
    localStorage.clear();
    try { indexedDB.deleteDatabase('folio-kv-db'); } catch(e) {}
  });
  await page.reload();
  await page.locator('#btnDemo').waitFor({ timeout: 9000 });
  await page.evaluate(() => { settings.themeAuto = false; save(); }); // pin paper theme
}

async function screencast(run) {
  const client = await page.context().newCDPSession(page);
  const frames = [];
  client.on('Page.screencastFrame', async (ev) => {
    frames.push({ data: ev.data, ts: ev.metadata.timestamp });
    try { await client.send('Page.screencastFrameAck', { sessionId: ev.sessionId }); } catch(e) {}
  });
  await client.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  await run();
  await page.waitForTimeout(1600);
  await client.send('Page.stopScreencast').catch(() => {});
  try { await client.detach(); } catch(e) {}
  return frames;
}

async function analyze(frames, label) {
  if(!frames.length){ console.log(`\n== ${label}: NO FRAMES captured`); return; }
  const t0 = frames[0].ts;
  let firstRight = -1;
  const flickers = [];
  const rows = [];
  for(const f of frames){
    const frac = await page.evaluate(async (dataUrl) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const v = document.getElementById('viewer').getBoundingClientRect();
      const sx = cv.width / innerWidth, sy = cv.height / innerHeight;
      const cy = Math.round((v.top + v.height * 0.5) * sy);
      const pr = ctx.getImageData(Math.round((v.left + 8) * sx), cy, 1, 1).data;
      const box = (fx) => {
        const cx = Math.round((v.left + v.width * fx) * sx);
        const w = Math.round(60 * sx), h = Math.round(80 * sy);
        const d = ctx.getImageData(cx - w, cy - h, w * 2, h * 2).data;
        let sum = 0, tot = 0;
        for(let i = 0; i < d.length; i += 4){
          sum += Math.abs(d[i] - pr[0]) + Math.abs(d[i+1] - pr[1]) + Math.abs(d[i+2] - pr[2]);
          tot++;
        }
        return sum / tot / 3;
      };
      return { L: box(0.25), R: box(0.75) };
    }, 'data:image/png;base64,' + f.data);
    const row = { t: Math.round((f.ts - t0) * 1000), L: +frac.L.toFixed(2), R: +frac.R.toFixed(2) };
    rows.push(row);
    const onLeft = row.L > 9 && row.L > row.R + 4;
    const onRight = row.R > 9 && row.R > row.L + 4;
    if(onRight && firstRight === -1) firstRight = row.t;
    if(onLeft && firstRight !== -1 && row.t > firstRight) flickers.push(row);
  }
  console.log(`\n== ${label}: ${frames.length} frames, first contentOnRight at t=${firstRight}ms`);
  if(flickers.length){
    console.log('   FLICKER frames (content on LEFT after right was seen):');
    flickers.forEach(r => console.log('   ', JSON.stringify(r)));
  } else {
    console.log('   no flicker: no contentOnLeft frame after the first contentOnRight');
  }
  console.log('   timeline:', rows.filter((r, i) => i % 3 === 0 || r.L > 0.2 || r.R > 0.2)
    .slice(-30).map(r => `${r.t}ms L${r.L} R${r.R}`).join(' | '));
  const tag = label.replace(/[^A-Z]/g, '') || 'X';
  frames.slice(0, 3).forEach((f, i) => fsWriteFileSync('tests/manual/fp-' + tag + '-' + i + '.png', Buffer.from(f.data, 'base64')));
  if(frames.length) fsWriteFileSync('tests/manual/fp-' + tag + '-last.png', Buffer.from(frames[frames.length - 1].data, 'base64'));
}

// ---- run 1: demo (text title page) ----
await setup();
const demoFrames = await screencast(async () => {
  await page.click('#btnDemo');
  await page.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 15000 });
});
await analyze(demoFrames, 'DEMO (text title)');

// ---- run 2: image-cover book ----
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
    zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
    zip.file('OEBPS/cov.png', covBuf);
    zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?>
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
</package>`);
    zip.file('OEBPS/cov.xhtml', `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Cover</title></head>
<body>
  <div class="galley"><div class="cover-wrapper"><img src="cov.png" alt="Cover"/></div></div>
</body>
</html>`);
    zip.file('OEBPS/ch1.xhtml', `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter</title></head>
<body>
  ${(new Array(60).fill(0)).map((_, i) => `<p>Paragraph ${i} — the time traveller expounded a recondite matter to us with a certain zest and his grey eyes shone and twinkled while pale fingers pressed the soft radiance.</p>`).join('\n')}
</body>
</html>`);
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    await openBuffer(buf, 'Image Cover Test');
  });
  await page.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 15000 });
});
await analyze(coverFrames, 'IMAGE COVER');

await browser.close();
console.log('\ndone');
