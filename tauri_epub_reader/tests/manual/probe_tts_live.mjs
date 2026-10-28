// Runs the REAL read-aloud flow in the exe (demo book + R) and reports which
// engine path each sentence takes and what the audio element does.
// Usage: node tests/manual/probe_tts_live.mjs [exePath]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const exe = process.argv[2] || 'src-tauri/target/release/app.exe';
const port = '9344';
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
if (!browser) { console.error('could not attach CDP'); child.kill(); process.exit(1); }
const page = browser.contexts()[0].pages()[0];
const consoleMsgs = [];
page.on('console', m => consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 160)}`));
await page.waitForTimeout(1500);

await page.click('#btnDemo');
await page.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 15000 });
await page.waitForTimeout(2000);

// Instrument: watch WebAudio pipeline + webspeech fallbacks
await page.evaluate(() => {
  window.__ttsLog = [];
  const orig = TTS.speakWebSpeech.bind(TTS);
  TTS.speakWebSpeech = function (s, g) {
    window.__ttsLog.push('fallback-webspeech: ' + (s.text || '').slice(0, 40));
    return orig(s, g);
  };
  const origDecode = AudioContext.prototype.decodeAudioData;
  AudioContext.prototype.decodeAudioData = function (b, ...rest) {
    window.__ttsLog.push('decodeAudioData ' + b.byteLength + 'B');
    return origDecode.call(this, b, ...rest);
  };
  const origStart = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...args) {
    window.__ttsLog.push('bufferSource.start dur=' + (this.buffer ? this.buffer.duration.toFixed(2) : '?'));
    return origStart.apply(this, args);
  };
});

await page.keyboard.press('r');
await page.waitForTimeout(17000);

const report = await page.evaluate(() => {
  const ctx = TTS.ttsCtx;
  const src = TTS.srcNode;
  return {
    piperAvailable: TTS.piperAvailable,
    voice: TTS.voice,
    si: TTS.si,
    sentCount: TTS.sents.length,
    active: TTS.active,
    firstSents: TTS.sents.slice(0, 3).map(s => s.text.slice(0, 70)),
    webAudio: ctx ? {
      state: ctx.state,
      sampleRate: ctx.sampleRate,
      srcDone: TTS.srcDone,
      srcDuration: src && src.buffer ? +src.buffer.duration.toFixed(2) : null,
    } : null,
    synth: {
      speaking: speechSynthesis.speaking,
      pending: speechSynthesis.pending,
      voices: speechSynthesis.getVoices().length,
    },
    log: (window.__ttsLog || []).slice(0, 30),
  };
});
console.log(JSON.stringify(report, null, 2));
console.log('--- console messages during session ---');
console.log(consoleMsgs.slice(-25).join('\n') || '(none)');

await browser.close();
child.kill();
process.exit(0);
