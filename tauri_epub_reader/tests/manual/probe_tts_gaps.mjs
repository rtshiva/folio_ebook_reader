// Measures real inter-sentence gaps in the live read-aloud flow:
// for each sentence end, how long until the next sentence starts.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const exe = 'src-tauri/target/release/app.exe';
const port = '9347';
const child = spawn(path.resolve(exe), [], {
  cwd: path.dirname(path.resolve(exe)),
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
  stdio: 'ignore',
});
let browser;
for (let i = 0; i < 30 && !browser; i++) {
  await new Promise(r => setTimeout(r, 500));
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
}
if (!browser) { console.error('no CDP'); child.kill(); process.exit(1); }
const page = browser.contexts()[0].pages()[0];
await page.waitForTimeout(1500);
await page.click('#btnDemo');
await page.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 15000 });
await page.waitForTimeout(1000);

await page.evaluate(() => {
  window.__ev = [];
  const origStart = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function () {
    const e = { t: Date.now(), kind: 'start', dur: this.buffer ? this.buffer.duration : 0 };
    window.__ev.push(e);
    const old = this.onended;
    this.onended = () => { window.__ev.push({ t: Date.now(), kind: 'end' }); old && old.call(this); };
    return origStart.apply(this, arguments);
  };
});

await page.keyboard.press('r');
await page.waitForTimeout(45000);

const gaps = await page.evaluate(() => {
  const ev = window.__ev;
  const out = [];
  for (let i = 0; i < ev.length; i++) {
    if (ev[i].kind === 'end') {
      const nx = ev.slice(i + 1).find(e => e.kind === 'start');
      if (nx) out.push({ endedAt: ev[i].t, nextStartAfterMs: nx.t - ev[i].t, nextDur: +nx.dur.toFixed(2) });
    }
  }
  const coldStart = ev.length && ev[0].kind === 'start' ? 'first clip at +0ms of log' : '?';
  return { clips: ev.filter(e => e.kind === 'start').length, transitions: out, coldStart };
});
console.log(JSON.stringify(gaps, null, 2));

await browser.close();
child.kill();
process.exit(0);
