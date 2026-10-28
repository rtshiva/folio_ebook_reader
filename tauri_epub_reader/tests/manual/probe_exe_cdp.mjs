// Attaches to the packaged Folio exe's WebView2 via CDP and dumps:
// reader state, console errors, and failed network requests.
// Usage: node tests/manual/probe_exe_cdp.mjs [cdpPort]
import { chromium } from 'playwright';

const port = process.argv[2] || '9333';
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = browser.contexts()[0];
const page = ctx.pages()[0];
console.log('page url:', page.url());

page.on('console', (m) => console.log('[console]', m.type(), m.text()));
page.on('requestfailed', (r) => console.log('[reqfail]', r.url().slice(0, 120), r.failure()?.errorText));

const state = await page.evaluate(async () => {
  const out = {};
  out.bodyClasses = document.body.className;
  out.hasTauri = !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
  out.loadingVisible = !document.getElementById('loader')?.classList.contains('hide');
  out.loaderMsg = document.getElementById('loaderMsg')?.textContent || '';
  out.tocListHtml = (document.getElementById('tocList')?.innerHTML || '').slice(0, 200);
  out.bookTitle = document.getElementById('bookTitle')?.textContent || '';
  out.rendition = !!state?.rendition;
  out.bookUrl = state?.book?.url ? String(state.book.url) : null;
  out.viewerIframes = document.querySelectorAll('#viewer iframe').length;
  out.pageBadge = document.getElementById('pageBadge')?.textContent || '';
  // try a direct fetch through the cache protocol
  try {
    const r = await fetch(out.bookUrl ? out.bookUrl.replace(/\/$/, '') + '/META-INF/container.xml' : 'about:blank');
    out.containerFetch = r.status + ' ' + r.headers.get('content-type');
  } catch (e) { out.containerFetch = 'FETCH ERR: ' + e.message; }
  return out;
});
console.log(JSON.stringify(state, null, 2));

await page.screenshot({ path: 'tests/e2e/artifacts/exe_probe.png' }).catch(() => {});
await browser.close();
