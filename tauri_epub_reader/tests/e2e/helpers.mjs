// Shared helpers for the Folio e2e suite. The app is a single static file;
// every spec isolates via fresh() so persisted state never leaks between tests.

export async function fresh(page) {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.locator('#btnDemo').waitFor({ timeout: 9000 });
}

export async function openDemo(page) {
  await page.click('#btnDemo');
  await page.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 12000 });
}

export async function openDemoReady(page) {
  await openDemo(page);
  await page.waitForFunction(() => typeof LocEngine !== 'undefined' && LocEngine.ready(), null, { timeout: 12000 });
}

export async function badge(page) {
  return (await page.locator('#pageBadge').textContent()) || '';
}

export async function pct(page) {
  return (await page.locator('#pct').textContent()) || '';
}

export async function badgeWait(page, prev, timeout = 9000) {
  await page.waitForFunction((p) => {
    const b = document.getElementById('pageBadge');
    return b && b.textContent !== p;
  }, prev, { timeout });
  return badge(page);
}

// Frame object of the largest live chapter iframe inside #viewer.
// Uses page.frames() + frameElement() (stable APIs) instead of
// Locator.contentFrame(), which misbehaves on this Playwright version.
export async function viewerFrame(page) {
  await page.waitForFunction(
    () => document.querySelectorAll('#viewer iframe').length > 0, null, { timeout: 9000 });
  let best = null, area = 0;
  for (const fr of page.frames()) {
    if (fr === page.mainFrame()) continue;
    let h = null;
    try { h = await fr.frameElement(); } catch (e) { continue; }
    if (!h) continue;
    const info = await h.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, inViewer: !!(el.closest && el.closest('#viewer')) };
    }).catch(() => null);
    if (!info || !info.inViewer) continue;
    if (info.w * info.h > area) { area = info.w * info.h; best = fr; }
  }
  if (!best) throw new Error('chapter frame not accessible');
  return best;
}

// speechSynthesis + SpeechSynthesisUtterance mock. Records speak() texts in
// window.__speakCalls and ends every utterance after a tick — no audio
// hardware or voices needed. Install via page.addInitScript BEFORE goto.
export const SPEECH_MOCK = `
window.__speakCalls = [];
try {
  window.SpeechSynthesisUtterance = class {
    constructor(t){ this.text = t; this.rate = 1; this.pitch = 1; this.onend = null; this.onerror = null; }
  };
  Object.defineProperty(window, 'speechSynthesis', {
    value: {
      getVoices(){ return [{ name: 'T', lang: 'en-US', voiceURI: 't', localService: true, default: true }]; },
      speak(u){ window.__speakCalls.push(u.text); setTimeout(() => { try{ u.onend && u.onend(); }catch(e){} }, 5); },
      cancel(){}, pause(){}, resume(){},
      get speaking(){ return false; }, get pending(){ return false; }, get paused(){ return false; },
      onvoiceschanged: null, addEventListener(){}, removeEventListener(){}
    },
    configurable: true, writable: true
  });
} catch (e) {}
`;

// ---- minimal stored-zip EPUB builder (no dependencies) ----
const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_T[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const enc = new TextEncoder();
// A tiny but valid EPUB (stored entries only): enough for epub.js to parse,
// paginate, and relocate. Title 'B Test' so boot-open assertions are exact.
export function buildTestEpub() {
  const files = [
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml',
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
      '  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n' +
      '</container>'],
    ['OEBPS/content.opf',
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid">\n' +
      '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
      '<dc:identifier id="bid">urn:folio:test:b</dc:identifier>\n' +
      '<dc:title>B Test</dc:title><dc:creator>Tester</dc:creator><dc:language>en</dc:language>\n' +
      '</metadata>\n' +
      '<manifest><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>\n' +
      '<spine><itemref idref="ch1"/></spine>\n</package>'],
    ['OEBPS/ch1.xhtml',
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head><body>\n' +
      '<h1>One</h1><p>First paragraph with enough words to paginate and search.</p>\n' +
      '<p>Second paragraph, also with words for the index and the finder.</p>\n' +
      '<p>Third paragraph closes this tiny test chapter for relocation.</p>\n' +
      '</body></html>'],
  ];
  const chunks = [];
  const central = [];
  let offset = 0;
  const pushU16 = (v) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); chunks.push(b); };
  const pushU32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); chunks.push(b); };
  const pushStr = (s) => chunks.push(enc.encode(s));
  const pushBytes = (b) => chunks.push(b);
  const cpush = [];
  for (const [name, text] of files) {
    const nb = enc.encode(name);
    const db = typeof text === 'string' ? enc.encode(text) : text;
    const crc = crc32(db);
    const time = (12 << 11) | 0, date = ((2024 - 1980) << 9) | (1 << 5) | 1;
    pushU32(0x04034b50); pushU16(10); pushU16(0); pushU16(0);
    pushU16(time); pushU16(date); pushU32(crc); pushU32(db.length); pushU32(db.length);
    pushU16(nb.length); pushU16(0); pushStr(name); pushBytes(db);
    const c = [];
    const cu16 = (v) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); c.push(b); };
    const cu32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); c.push(b); };
    cu32(0x02014b50); cu16(10); cu16(10); cu16(0); cu16(0);
    cu16(time); cu16(date); cu32(crc); cu32(db.length); cu32(db.length);
    cu16(nb.length); cu16(0); cu16(0); cu16(0); cu16(0); cu32(0); cu32(offset);
    c.push(nb);
    cpush.push(c);
    offset += 30 + nb.length + db.length;
  }
  let cdSize = 0;
  for (const c of cpush) for (const b of c) { chunks.push(b); cdSize += b.length; }
  pushU32(0x06054b50); pushU16(0); pushU16(0);
  pushU16(files.length); pushU16(files.length);
  pushU32(cdSize); pushU32(offset); pushU16(0);
  let total = 0;
  for (const b of chunks) total += b.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const b of chunks) { out.set(b, p); p += b.length; }
  return out;
}

// addInitScript payload faking the Tauri backend for boot-open tests:
// get_initial_file -> fixed path, read_file_bytes -> the given epub bytes.
export function tauriBootScript(epubBytes) {
  return `window.__EPUB_BYTES = ${JSON.stringify([...epubBytes])};
window.__TAURI_INTERNALS__ = { invoke: async (cmd, args) => {
  if (cmd === 'get_initial_file') return 'C:/b.epub';
  if (cmd === 'read_file_bytes') return window.__EPUB_BYTES.slice();
  return null;
} };`;
}
