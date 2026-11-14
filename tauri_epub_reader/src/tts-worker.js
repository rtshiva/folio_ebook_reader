// Web Worker for KittenTTS neural speech synthesis (ONNX Runtime Web in WASM)
if (typeof self !== 'undefined' && typeof self.window === 'undefined') {
  self.window = self;
}

let ttsInstance = null;
let loadPromise = null;
let activeRunId = 0;
const queue = [];
let isProcessing = false;

function float32ToWav(f32, sampleRate) {
  const sr = sampleRate || 24000;
  const buf = new ArrayBuffer(44 + f32.length * 2);
  const v = new DataView(buf);
  const wstr = (off, s2) => {
    for (let i = 0; i < s2.length; i++) v.setUint8(off + i, s2.charCodeAt(i));
  };
  wstr(0, 'RIFF'); v.setUint32(4, 36 + f32.length * 2, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  wstr(36, 'data'); v.setUint32(40, f32.length * 2, true);
  let o = 44;
  for (let i = 0; i < f32.length; i++, o += 2) {
    const s2 = Math.max(-1, Math.min(1, f32[i]));
    v.setInt16(o, s2 < 0 ? s2 * 0x8000 : s2 * 0x7FFF, true);
  }
  return new Uint8Array(buf);
}

async function getOrInitTTS() {
  if (ttsInstance) return ttsInstance;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const { KittenTTS } = await import('./vendor/kitten/kitten.bundle.js');
    const tts = await KittenTTS.from_pretrained('KittenML/kitten-tts-mini-0.8', { runtime: 'cpu' });
    ttsInstance = tts;
    return tts;
  })();
  return loadPromise;
}

async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;
  try {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) continue;
      const { id, text, voice, rate, runId, chunkId } = item;
      // Stale check before starting inference
      if (runId && runId < activeRunId) {
        self.postMessage({ type: 'GEN_DROPPED', id, runId, chunkId });
        continue;
      }
      try {
        const tts = await getOrInitTTS();
        const vKey = (voice || 'bella').trim();
        const cap = vKey.startsWith('expr-') ? vKey : (vKey.charAt(0).toUpperCase() + vKey.slice(1).toLowerCase());
        const speed = Math.min(2, Math.max(0.5, rate || 1));
        const audio = await tts.generate(text, { voice: cap, speed });

        // Stale check after inference finishes
        if (runId && runId < activeRunId) {
          self.postMessage({ type: 'GEN_DROPPED', id, runId, chunkId });
          continue;
        }

        let wavBytes = null;
        if (audio.encodeWAV) wavBytes = new Uint8Array(audio.encodeWAV());
        else if (audio.audio) wavBytes = float32ToWav(audio.audio, audio.sampleRate || 24000);
        else if (audio.toBlob) wavBytes = new Uint8Array(await (await audio.toBlob()).arrayBuffer());
        else throw new Error('Unrecognized audio output from KittenTTS');

        const buf = wavBytes.buffer;
        self.postMessage({ type: 'GEN_DONE', id, runId, chunkId, buffer: buf }, [buf]);
      } catch (err) {
        self.postMessage({ type: 'GEN_ERROR', id, runId, chunkId, error: err && err.message ? err.message : String(err) });
      }
    }
  } finally {
    isProcessing = false;
  }
}

self.onmessage = async (e) => {
  const data = e.data;
  if (!data) return;

  if (data.type === 'PING') {
    self.postMessage({
      type: 'PONG',
      crossOriginIsolated: typeof self.crossOriginIsolated !== 'undefined' ? self.crossOriginIsolated : false,
      sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined'
    });
    return;
  }

  if (data.type === 'INIT') {
    try {
      await getOrInitTTS();
      self.postMessage({ type: 'INIT_DONE', success: true });
    } catch (err) {
      self.postMessage({ type: 'INIT_FAIL', error: err && err.message ? err.message : String(err) });
    }
    return;
  }

  if (data.type === 'CANCEL') {
    activeRunId = data.runId || 0;
    queue.length = 0;
    return;
  }

  if (data.type === 'GENERATE') {
    const { id, text, voice, rate, runId, chunkId } = data;
    if (runId && runId < activeRunId) {
      self.postMessage({ type: 'GEN_DROPPED', id, runId, chunkId });
      return;
    }
    queue.push({ id, text, voice, rate, runId, chunkId });
    processQueue();
  }
};
