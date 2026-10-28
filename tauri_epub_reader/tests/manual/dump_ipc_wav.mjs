// Dumps the WAV received via Tauri IPC to disk for byte-level analysis.
// Usage: node tests/manual/dump_ipc_wav.mjs [exePath]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

const exe = process.argv[2] || 'src-tauri/target/release/app.exe';
const port = '9343';
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
await page.waitForTimeout(1500);

const b64 = await page.evaluate(async () => {
  const inv = window.__TAURI_INTERNALS__.invoke;
  const wav = await inv('tts_piper_speak', {
    text: 'The quick brown fox jumps over the lazy dog.',
    rate: 1.0, voice: 'lessac',
  });
  const u8 = wav instanceof ArrayBuffer ? new Uint8Array(wav) : new Uint8Array(wav);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(bin);
});
writeFileSync('/tmp/piper_ipc.wav', Buffer.from(b64, 'base64'));
console.log('wrote /tmp/piper_ipc.wav');

await browser.close();
child.kill();
process.exit(0);
