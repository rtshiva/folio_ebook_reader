// Decisive test: decode the piper blob with the app's own audio decoder and
// stats-check the decoded PCM. If decodeAudioData output is clean, the render
// path is fine; if it's garbage, WebView2's WAV decode is the bug.
// Usage: node tests/manual/probe_tts_decode.mjs [exePath]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const exe = process.argv[2] || 'src-tauri/target/release/app.exe';
const port = '9345';
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

const out = await page.evaluate(async () => {
  const inv = window.__TAURI_INTERNALS__.invoke;
  const wav = await inv('tts_piper_speak', { text: 'The decoder check, sentence two, with a longer phrase for statistics.', rate: 1.0, voice: 'bryce' });
  const buf = wav instanceof ArrayBuffer ? wav : new Uint8Array(wav).buffer;
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(buf.slice(0));
    const ch = decoded.getChannelData(0);
    const n = ch.length;
    let sumSq = 0, peak = 0, zc = 0;
    for (let i = 0; i < n; i++) {
      const s = ch[i]; sumSq += s * s;
      const a = Math.abs(s); if (a > peak) peak = a;
      if (i > 0 && ((s >= 0) !== (ch[i - 1] >= 0))) zc++;
    }
    // envelope variance in 50ms windows: speech has pauses, noise is uniform
    const win = Math.floor(decoded.sampleRate * 0.05);
    const wins = [];
    for (let w = 0; w + win <= n; w += win) {
      let s2 = 0;
      for (let i = w; i < w + win; i++) s2 += ch[i] * ch[i];
      wins.push(Math.sqrt(s2 / win));
    }
    const mean = wins.reduce((a, b) => a + b, 0) / wins.length;
    const sd = Math.sqrt(wins.reduce((a, b) => a + (b - mean) * (b - mean), 0) / wins.length);
    return {
      decoded: {
        sampleRate: decoded.sampleRate,
        channels: decoded.numberOfChannels,
        duration: +decoded.duration.toFixed(2),
        rms: +Math.sqrt(sumSq / n).toFixed(4),
        peak: +peak.toFixed(3),
        zcr: +(zc / (n - 1)).toFixed(4),
        envelopeCV: +(sd / mean).toFixed(3),
      },
      verdict: (zc / (n - 1)) < 0.4 && (sd / mean) > 0.3 ? 'decoded PCM is structured speech' : 'decoded PCM looks like noise',
    };
  } catch (e) {
    return { decodeError: String(e) };
  } finally { ctx.close(); }
});
console.log(JSON.stringify(out, null, 2));

await browser.close();
child.kill();
process.exit(0);
