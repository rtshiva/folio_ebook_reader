// Tests which URL forms reach the folio-cache protocol handler inside the
// packaged WebView2: fetch vs XHR vs img, across scheme/host spellings.
// Usage: node tests/manual/probe_exe_cdp.mjs <cdpPort> --urls
import { chromium } from 'playwright';

const port = process.argv[2] || '9333';
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = browser.contexts()[0].pages()[0];

const results = await page.evaluate(async () => {
  const hash = String(state.book.url).match(/folio-cache:\/\/([^/]+)\//)[1];
  const rel = 'META-INF/container.xml';
  const forms = [
    ['custom', `folio-cache://${hash}/${rel}`],
    ['http-dot', `http://folio-cache./${hash}/${rel}`],
    ['http-localhost', `http://folio-cache.localhost/${hash}/${rel}`],
    ['http-hostpath', `http://folio-cache.local/${hash}/${rel}`],
    ['https-localhost', `https://folio-cache.localhost/${hash}/${rel}`],
    ['custom-pathhost', `folio-cache://localhost/${hash}/${rel}`],
  ];
  const out = [];
  for (const [name, url] of forms) {
    const row = { name, url };
    try { const r = await fetch(url); row.fetch = r.status + ' ' + (r.headers.get('content-type') || ''); }
    catch (e) { row.fetch = 'ERR ' + e.message.slice(0, 60); }
    row.xhr = await new Promise((res) => {
      try {
        const x = new XMLHttpRequest();
        x.open('GET', url);
        x.onload = () => res(x.status + ' len=' + x.responseText.length);
        x.onerror = () => res('XHR ERR');
        x.ontimeout = () => res('timeout');
        setTimeout(() => res('pending'), 4000);
        x.send();
      } catch (e) { res('THROW ' + e.message.slice(0, 60)); }
    });
    row.img = await new Promise((res) => {
      const im = new Image();
      im.onload = () => res('loaded');
      im.onerror = () => res('error');
      im.src = url;
      setTimeout(() => res('pending'), 4000);
    });
    out.push(row);
  }
  return out;
});
for (const r of results) console.log(JSON.stringify(r));
await browser.close();
