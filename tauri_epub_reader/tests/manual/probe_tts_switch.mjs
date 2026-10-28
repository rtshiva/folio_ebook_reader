// Repro of the concurrent-voice bug: start read-aloud, switch voice mid-read
// (including during the inter-sentence gap), count concurrent playing sources.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const exe = 'src-tauri/target/release/app.exe';
const port = '9346';
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
await page.waitForTimeout(1500);

await page.evaluate(() => {
  window.__srcLog = [];
  const origStart = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...a) {
    const e = { t: Date.now(), dur: this.buffer ? this.buffer.duration : 0, ended: false };
    window.__srcLog.push(e);
    this.onended = ((orig) => () => { e.ended = true; orig && orig.call(this); })(this.onended);
    return origStart.apply(this, a);
  };
  const oNext = TTS.speakNext.bind(TTS);
  TTS.speakNext = function (...a) {
    window.__srcLog.push({ t: Date.now(), dur: -1, ended: false, note: 'speakNext si=' + TTS.si + ' gen=' + TTS.gen + ' voice=' + TTS.voice });
    return oNext(...a);
  };
  const oPlay = TTS.playWav.bind(TTS);
  TTS.playWav = function (buf, gu) {
    const e = { t: Date.now(), dur: -2, ended: false, note: 'playWav gu=' + gu };
    window.__srcLog.push(e);
    return oPlay(buf, gu).then(r => { e.note += '->' + (r ? 'started' : 'discarded'); return r; });
  };
});

await page.keyboard.press('r');
await page.waitForTimeout(2500);           // mid sentence 1
await page.evaluate(() => TTS.setVoice('lessac'));   // switch mid-speech
await page.waitForTimeout(400);
// hit the gap window too: wait until srcDone then switch again
await page.waitForFunction(() => TTS.srcDone === true, null, { timeout: 20000 }).catch(() => {});
await page.evaluate(() => TTS.setVoice('bryce'));    // switch during the gap
await page.waitForTimeout(14000);

const out = await page.evaluate(() => {
  let overlaps = 0;
  for (let i = 0; i < window.__srcLog.length; i++) {
    const a = window.__srcLog[i];
    const aEnd = a.t + a.dur * 1000;
    for (let j = i + 1; j < window.__srcLog.length; j++) {
      const b = window.__srcLog[j];
      if (b.t < aEnd) overlaps++;
    }
  }
  return {
    state: { active: TTS.active, paused: TTS.paused, gen: TTS.gen, si: TTS.si,
             srcDone: TTS.srcDone, ctxState: TTS.ttsCtx && TTS.ttsCtx.state,
             voice: TTS.voice, sents: TTS.sents.length },
    sources: window.__srcLog.map(s => ({ t: s.t, dur: +s.dur.toFixed(2), ended: s.ended, note: s.note || '' })),
    overlaps,
  };
});
console.log(JSON.stringify(out, null, 2));
console.log(out.overlaps === 0 ? 'PASS: no concurrent sources' : 'FAIL: overlapping sources detected');

await browser.close();
child.kill();
process.exit(0);
