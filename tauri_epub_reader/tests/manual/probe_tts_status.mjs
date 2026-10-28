// Launches the packaged exe with WebView2 CDP and reports TTS engine state.
// Usage: node tests/manual/probe_tts_status.mjs [exePath]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const exe = process.argv[2]
  || 'src-tauri/target/release/app.exe';
if (!existsSync(exe)) {
  console.error('exe not found:', exe);
  process.exit(1);
}
const port = '9341';
const child = spawn(path.resolve(exe), [], {
  cwd: path.dirname(path.resolve(exe)),
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  },
  stdio: 'ignore',
});
console.log('launched', exe, 'pid', child.pid);

let browser;
for (let i = 0; i < 30 && !browser; i++) {
  await new Promise(r => setTimeout(r, 500));
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
}
if (!browser) { console.error('could not attach CDP'); child.kill(); process.exit(1); }

const page = browser.contexts()[0].pages()[0];
await page.waitForTimeout(1500);

const state = await page.evaluate(async () => {
  const out = {};
  out.hasTauri = !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
  try {
    out.piperStatus = await window.__TAURI_INTERNALS__.invoke('tts_piper_status');
  } catch (e) { out.piperStatus = 'INVOKE ERR: ' + e; }
  try {
    out.piperVoices = await window.__TAURI_INTERNALS__.invoke('tts_piper_voices');
  } catch (e) { out.piperVoices = 'INVOKE ERR: ' + e; }
  // Synthesize the same text with each voice; distinct sizes imply distinct models.
  for (const v of ['lessac', 'bryce']) {
    try {
      const wav = await window.__TAURI_INTERNALS__.invoke('tts_piper_speak', {
        text: 'This is the narrator voice test.', rate: 1.0, voice: v,
      });
      out['speak_' + v] = (wav && (wav.byteLength ?? wav.length)) + ' bytes';
    } catch (e) { out['speak_' + v] = 'ERR: ' + e; }
  }
  out.ttsPiperAvailable = (typeof TTS !== 'undefined') ? TTS.piperAvailable : 'no TTS obj';
  out.ttsVoice = (typeof TTS !== 'undefined') ? TTS.voice : null;
  return out;
});
console.log(JSON.stringify(state, null, 2));

await browser.close();
child.kill();
process.exit(0);
