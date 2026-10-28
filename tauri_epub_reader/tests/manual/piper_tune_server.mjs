// Piper tuning bench: local server + browser page for A/B-testing synthesis
// settings without rebuilding the app. Uses --output_file temp files ONLY
// (piper's Windows stdout is text-mode and corrupts WAV bytes into static).
// The multi-engine experiment (chatterbox/nano/qwen) moved to
// F:/Siva_f/ebook_reader_glm53flash/voice_testing/tts_bench.mjs.
//
// Usage:   node tests/manual/piper_tune_server.mjs [port]
// Then:    http://127.0.0.1:8787
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIPER = path.join(ROOT, 'bin', 'piper', 'piper', 'piper.exe');
const MODELS = path.join(ROOT, 'bin', 'piper', 'models');
const PORT = Number(process.argv[2]) || 8787;

const voices = readdirSync(MODELS)
  .filter(f => f.endsWith('.onnx') && existsSync(path.join(MODELS, f + '.json')))
  .map(f => {
    const id = f.replace(/\.onnx$/, '');
    let meta = {};
    try { meta = JSON.parse(readFileSync(path.join(MODELS, f + '.json'), 'utf8')); } catch {}
    return { id, label: `${id} (${meta.audio?.quality ?? '?'})`, file: f };
  });
console.log('piper voices:', voices.map(v => v.id).join(', '));

const workDir = mkdtempSync(path.join(tmpdir(), 'piper-tune-'));
let seq = 0;

function synthesizePiper(voiceFile, params, text) {
  return new Promise((resolve, reject) => {
    const outFile = path.join(workDir, `t${seq++}.wav`);
    const args = [
      '--model', path.join(MODELS, voiceFile),
      '--output_file', outFile,
      '--length_scale', String(params.len),
      '--noise_scale', String(params.noise),
      '--noise_w', String(params.noisew),
      '--sentence_silence', String(params.sil),
    ];
    const p = spawn(PIPER, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    const errs = [];
    p.stderr.on('data', d => { if (errs.join('').length < 2000) errs.push(String(d)); });
    p.stdin.on('error', () => {});
    p.stdin.end(text + '\n');
    p.on('close', code => {
      try {
        if (code !== 0) return reject(new Error('piper exit ' + code + ': ' + errs.join('')));
        resolve(readFileSync(outFile));
      } finally { try { rmSync(outFile); } catch {} }
    });
    p.on('error', reject);
  });
}

const num = (u, k, def, lo, hi) => {
  const v = Number(u.searchParams.get(k));
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
};

createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/voices') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(voices));
  }
  if (u.pathname === '/tts') {
    const text = (u.searchParams.get('text') || '').slice(0, 2000).trim();
    if (!text) { res.writeHead(400); return res.end('empty text'); }
    const voice = voices.find(v => v.id === u.searchParams.get('voice')) || voices[0];
    const params = {
      len: num(u, 'len', 1.0, 0.5, 2.0),
      noise: num(u, 'noise', 0.667, 0.05, 1.5),
      noisew: num(u, 'noisew', 0.8, 0.05, 1.5),
      sil: num(u, 'sil', 0, 0, 1.5),
    };
    const t0 = Date.now();
    try {
      const wav = await synthesizePiper(voice.file, params, text);
      console.log(`piper ${voice.id} len=${params.len} noise=${params.noise} noisew=${params.noisew} sil=${params.sil} -> ${wav.length}B in ${Date.now() - t0}ms`);
      res.writeHead(200, { 'content-type': 'audio/wav', 'x-synth-ms': Date.now() - t0 });
      return res.end(wav);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      return res.end(String(e.message || e));
    }
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Piper tuning bench -> http://127.0.0.1:${PORT}`);
  console.log('temp dir:', workDir);
});

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Piper Tuning Bench</title>
<style>
  :root { color-scheme: dark; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 860px; margin: 24px auto; padding: 0 16px; background: #16181d; color: #dde2ea; }
  h1 { font-size: 20px; } h1 span { color: #7fb; font-weight: 400; font-size: 14px; }
  .row { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; margin: 10px 0; }
  label { min-width: 170px; color: #9aa3b2; }
  input[type=range] { flex: 1; min-width: 220px; }
  .val { min-width: 56px; text-align: right; font-variant-numeric: tabular-nums; color: #7fb; }
  select, textarea, button { background: #22262e; color: #dde2ea; border: 1px solid #3a4150; border-radius: 6px; padding: 6px 10px; }
  textarea { width: 100%; box-sizing: border-box; min-height: 84px; font: inherit; }
  button { cursor: pointer; } button.primary { background: #1a9955; border-color: #1a9955; color: #fff; font-weight: 600; padding: 8px 22px; }
  .preset { font-size: 13px; color: #9aa3b2; }
  audio { width: 100%; margin-top: 8px; }
  .meta { color: #778; font-size: 13px; min-height: 20px; }
  fieldset { border: 1px solid #3a4150; border-radius: 8px; margin: 14px 0; }
</style></head><body>
<h1>Piper Tuning Bench <span>· settings apply instantly, nothing persists</span></h1>

<fieldset><legend>Text</legend>
  <textarea id="text">The quick brown fox jumps over the lazy dog. Listen to how the pauses breathe between sentences, and whether each word lands clearly. One, two, three — and away we go!</textarea>
</fieldset>

<fieldset><legend>Voice</legend>
  <div class="row"><label>Voice model</label><select id="voice"></select><span class="val" id="voiceInfo"></span></div>
</fieldset>

<fieldset><legend>Synthesis knobs</legend>
  <div class="row"><label>length_scale (pace)</label><input type="range" id="len" min="0.6" max="1.6" step="0.01" value="1.0"><span class="val" id="lenV"></span></div>
  <div class="row"><label>noise_scale (pitch var)</label><input type="range" id="noise" min="0.05" max="1.2" step="0.01" value="0.667"><span class="val" id="noiseV"></span></div>
  <div class="row"><label>noise_w (phoneme width)</label><input type="range" id="noisew" min="0.05" max="1.5" step="0.01" value="0.8"><span class="val" id="noisewV"></span></div>
  <div class="row"><label>sentence_silence (gap s)</label><input type="range" id="sil" min="0" max="1.0" step="0.01" value="0"><span class="val" id="silV"></span></div>
  <div class="row">
    <button class="preset" data-p="1.0,0.667,0.8,0">Folio current (1.0 / 0.667 / 0.8 / 0)</button>
    <button class="preset" data-p="1.05,0.667,0.8,0.45">Recommended (1.05 / 0.667 / 0.8 / 0.45)</button>
    <button class="preset" data-p="0.95,0.5,0.7,0.3">Crisp (0.95 / 0.5 / 0.7 / 0.3)</button>
  </div>
</fieldset>

<div class="row">
  <button class="primary" id="go">▶ Speak</button>
  <span class="meta" id="meta"></span>
</div>
<audio id="player" controls></audio>

<script>
const $ = id => document.getElementById(id);
// Per-voice slider defaults (user-tuned); voices without an entry use GLOBAL_DEFAULTS.
const GLOBAL_DEFAULTS = { len: '1.0', noise: '0.667', noisew: '0.8', sil: '0' };
const VOICE_DEFAULTS = {
  'en_US-lessac-high': { len: '1.44', noise: '0.67', noisew: '0.71', sil: '0.56' },
  'en_US-ryan-high': { len: '1.46', noise: '0.71', noisew: '0.8', sil: '0.71' },
};
function applyVoiceDefaults(voiceId) {
  const d = VOICE_DEFAULTS[voiceId] || GLOBAL_DEFAULTS;
  for (const [k, v] of Object.entries(d)) { $(k).value = v; $(k + 'V').textContent = v; }
}
for (const k of ['len','noise','noisew','sil']) {
  $(k).addEventListener('input', () => $(k + 'V').textContent = $(k).value);
  $(k + 'V').textContent = $(k).value;
}
fetch('/voices').then(r => r.json()).then(vs => {
  $('voice').innerHTML = vs.map(v => '<option value="' + v.id + '">' + v.label + '</option>').join('');
  applyVoiceDefaults($('voice').value);
});
$('voice').addEventListener('change', () => applyVoiceDefaults($('voice').value));

document.querySelectorAll('.preset').forEach(b => b.addEventListener('click', () => {
  const [len, noise, noisew, sil] = b.dataset.p.split(',');
  for (const [k, v] of [['len',len],['noise',noise],['noisew',noisew],['sil',sil]]) { $(k).value = v; $(k + 'V').textContent = v; }
}));

let busy = false;
$('go').addEventListener('click', async () => {
  if (busy) return; busy = true; $('go').textContent = '…synthesizing';
  const q = new URLSearchParams({
    voice: $('voice').value, text: $('text').value,
    len: $('len').value, noise: $('noise').value, noisew: $('noisew').value, sil: $('sil').value,
  });
  const t0 = performance.now();
  try {
    const r = await fetch('/tts?' + q);
    if (!r.ok) throw new Error(await r.text());
    const blob = await r.blob();
    $('player').src = URL.createObjectURL(blob);
    $('player').play();
    $('meta').textContent = blob.size.toLocaleString() + ' bytes · server synth ' + r.headers.get('x-synth-ms') + ' ms · roundtrip ' + Math.round(performance.now() - t0) + ' ms';
  } catch (e) { $('meta').textContent = 'error: ' + e.message; }
  busy = false; $('go').textContent = '▶ Speak';
});
</script></body></html>`;
