// Diagnoses in-app TTS audio: piper bytes -> blob -> Audio.play(), plus
// WebView2 speechSynthesis availability. Run: node tests/manual/probe_tts_audio.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const exe = process.argv[2] || 'src-tauri/target/release/app.exe';
if (!existsSync(exe)) { console.error('exe not found:', exe); process.exit(1); }
const port = '9342';
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
page.on('console', m => console.log('[console]', m.type(), m.text().slice(0, 200)));
await page.waitForTimeout(1500);

const state = await page.evaluate(async () => {
  const out = {};
  const inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  out.hasTauri = !!inv;
  try { out.piperStatus = await inv('tts_piper_status'); } catch (e) { out.piperStatus = 'ERR: ' + e; }

  // 1. Piper bytes -> blob -> Audio.play()
  try {
    const wav = await inv('tts_piper_speak', { text: 'Audio pipeline test.', rate: 1.0, voice: 'lessac' });
    const n = wav && (wav.byteLength ?? wav.length);
    out.piperBytes = n;
    const u8 = wav instanceof ArrayBuffer ? new Uint8Array(wav) : new Uint8Array(wav);
    // WAV sanity: RIFF header
    out.wavMagic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
    const blob = new Blob([u8], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const aud = new Audio(url);
    out.blobSize = blob.size;
    try {
      await aud.play();
      out.piperPlay = 'PLAYING';
      await new Promise(r => setTimeout(r, 500));
      out.playingAfter500ms = !aud.paused && !aud.ended;
      out.currentTime = aud.currentTime;
      aud.pause();
    } catch (e) {
      out.piperPlay = 'REJECTED: ' + e.name + ' ' + e.message;
    }
    URL.revokeObjectURL(url);
  } catch (e) { out.piperBytes = 'ERR: ' + e; }

  // 2. WebView2 speechSynthesis state
  out.hasSpeechSynthesis = 'speechSynthesis' in window;
  try {
    out.voiceCount = speechSynthesis.getVoices().length;
    out.voiceNames = speechSynthesis.getVoices().slice(0, 5).map(v => v.name);
  } catch (e) { out.voiceCount = 'ERR: ' + e; }
  return out;
});
console.log(JSON.stringify(state, null, 2));

await browser.close();
child.kill();
process.exit(0);
