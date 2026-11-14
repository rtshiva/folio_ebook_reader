import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMultiChapterEpub } from './e2e/helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exe = join(root, 'src-tauri', 'target', 'release', 'app.exe');
const CDP = 'http://127.0.0.1:9392';

const fail = (msg) => { console.error('FAIL  ' + msg); process.exit(1); };
if (process.platform !== 'win32') fail('packaged smoke is Windows-only');

// Kill any stale app.exe
try {
  const { execSync } = await import('node:child_process');
  execSync('taskkill /F /IM app.exe /T 2>nul');
} catch {}

const dir = mkdtempSync(join(tmpdir(), 'folio-bench-'));
const epubPath = join(dir, 'Benchmark.epub');
writeFileSync(epubPath, Buffer.from(buildMultiChapterEpub('Benchmark Book', 5)));

console.log('Launching app.exe with CDP on port 9392…');
const child = spawn(exe, [epubPath], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9392 --enable-features=msWebView2EnableSharedArrayBuffer --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection' },
  stdio: 'ignore',
});

const cleanup = () => {
  try { child.kill(); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

let browser = null;
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try { browser = await chromium.connectOverCDP(CDP); break; } catch {}
}
if (!browser) fail('Could not connect to WebView2 via CDP');

const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('tauri.localhost')) || ctx.pages()[0];
if (!page) fail('No page found');

// Forward console logs to node process
page.on('console', msg => {
  console.log(`[WebView Console ${msg.type()}]`, msg.text());
});

console.log('Waiting for book to render…');
for (let i = 0; i < 15; i++) {
  await page.waitForTimeout(1000);
  const ready = await page.evaluate(() => document.body.classList.contains('state-reading')).catch(() => false);
  if (ready) break;
}

console.log('\n======================================================');
console.log('EXPERIMENT 3: Check WASM Threading & SIMD Status');
console.log('======================================================');
const exp3 = await page.evaluate(() => {
  return {
    crossOriginIsolated: window.crossOriginIsolated,
    sharedArrayBufferAvailable: typeof SharedArrayBuffer !== 'undefined',
    hardwareConcurrency: navigator.hardwareConcurrency,
    ortEnv: typeof ort !== 'undefined' ? ort.env.wasm : 'ort not global (bundled inside kitten.bundle.js)'
  };
});
console.log(JSON.stringify(exp3, null, 2));

console.log('\n======================================================');
console.log('EXPERIMENT 4: Main-Thread Jitter & Stop Latency Test');
console.log('======================================================');
const exp4 = await page.evaluate(async () => {
  let maxFrameDropMs = 0;
  let lastTick = performance.now();
  let running = true;

  function monitor() {
    if (!running) return;
    const now = performance.now();
    const delta = now - lastTick;
    if (delta > maxFrameDropMs) maxFrameDropMs = delta;
    lastTick = now;
    requestAnimationFrame(monitor);
  }
  requestAnimationFrame(monitor);

  await new Promise(r => setTimeout(r, 50));
  const t0 = performance.now();
  await KittenRunner.generate(
    "This sentence tests how long the browser main UI thread is completely frozen during neural speech synthesis.",
    TTS.voice || 'bella',
    1.0
  );
  running = false;
  return {
    totalGenTimeMs: Math.round(performance.now() - t0),
    longestUIUXFreezeMs: Math.round(maxFrameDropMs)
  };
});
console.log(JSON.stringify(exp4, null, 2));

console.log('\n======================================================');
console.log('EXPERIMENT 1: Measure Chunk Scaling & Real-Time Factor (RTF)');
console.log('======================================================');
console.log('Running warmup and chunk samples (this may take 10-30s if downloading model on cold start)…');
const exp1 = await page.evaluate(async () => {
  const voice = TTS.voice || 'bella';
  const rate = TTS.rate || 1.0;

  const samples = [
    { name: "1. Short Title (20 chars)", text: "Chapter One: The Beginning." },
    { name: "2. Single Sentence (~110 chars)", text: "The morning sun broke over the jagged peaks, casting long violet shadows across the silent valley below." },
    { name: "3. Two Sentences (~240 chars)", text: "The morning sun broke over the jagged peaks, casting long violet shadows across the silent valley below. Somewhere in the distance, a bell tolled three times, warning the villagers that the gates were about to close." },
    { name: "4. Current Default (~600 chars)", text: "The morning sun broke over the jagged peaks, casting long violet shadows across the silent valley below. Somewhere in the distance, a bell tolled three times, warning the villagers that the gates were about to close. He pulled his heavy woolen cloak tighter around his shoulders and quickened his pace along the cobblestone path. Every step felt heavier than the last, weighed down by the secret letter tucked inside his vest pocket. If the guards stopped him at the bridge, there would be no explaining the royal seal stamped in crimson wax." }
  ];

  // Warmup pass so model initialization isn't counted
  await KittenRunner.generate("Warmup.", voice, rate);

  const out = [];
  for (const s of samples) {
    const t0 = performance.now();
    const wav = await KittenRunner.generate(s.text, voice, rate);
    const genMs = performance.now() - t0;
    
    // 24kHz, 16-bit mono PCM (48,000 bytes/sec) + 44-byte WAV header
    const byteLength = wav ? (wav.byteLength || (wav.buffer && wav.buffer.byteLength) || 0) : 0;
    const audioSec = Math.max(0.1, (byteLength - 44) / 48000);
    const rtf = (genMs / 1000) / audioSec;

    out.push({
      Test: s.name,
      Chars: s.text.length,
      "Gen Time (ms)": Math.round(genMs),
      "Audio Len (s)": Number(audioSec.toFixed(2)),
      "RTF (Lower is better)": Number(rtf.toFixed(2))
    });
  }
  return out;
});
console.table(exp1);

console.log('\n======================================================');
console.log('EXPERIMENT 2: Diagnose the Inter-Passage Gap (Pipeline Tracer)');
console.log('======================================================');
await page.evaluate(() => {
  const origGen = KittenRunner.generate.bind(KittenRunner);
  let lastGenEnd = performance.now();

  KittenRunner.generate = async function(text, voice, speed, runId, chunkId) {
    const start = performance.now();
    const idleTimeSinceLastGen = Math.round(start - lastGenEnd);
    console.log(
      `[TTS Gen Start] Idle gap since last synth: ${idleTimeSinceLastGen}ms | Len: ${text.length} chars | "${text.slice(0, 35)}..."`
    );
    const res = await origGen(text, voice, speed, runId, chunkId);
    lastGenEnd = performance.now();
    console.log(
      `[TTS Gen Done]  Took: ${Math.round(lastGenEnd - start)}ms`
    );
    return res;
  };
  console.log("Pipeline tracer attached! Starting playback via TTS.toggle()…");
  TTS.setEngine('kitten');
  TTS.toggle();
});

console.log('Observing playback pipeline for 18 seconds…');
await page.waitForTimeout(18000);

console.log('Stopping TTS…');
await page.evaluate(() => {
  TTS.stop();
});

await page.waitForTimeout(1000);
console.log('\nAll experiments completed successfully.');
await browser.close();
cleanup();
process.exit(0);
