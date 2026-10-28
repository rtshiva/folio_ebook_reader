// Spectral flatness per frame: speech has harmonic peaks (low flatness),
// white/colored noise is flat (flatness near 1.0). Also reports the dominant
// frequency trajectory, which for speech should be a smooth pitch contour.
// Usage: node tests/manual/spectral_check.mjs <file.wav>
import { readFileSync } from 'node:fs';

const path = process.argv[2];
const b = readFileSync(path);
let pos = 12, dataOff = -1, dataLen = 0, sampleRate = 0;
while (pos + 8 <= b.length) {
  const id = b.toString('ascii', pos, pos + 4);
  const sz = b.readUInt32LE(pos + 4);
  if (id === 'fmt ') sampleRate = b.readUInt32LE(pos + 12);
  else if (id === 'data') { dataOff = pos + 8; dataLen = sz; }
  pos += 8 + sz + (sz % 2);
}
const N = 1024;
const samples = [];
for (let i = 0; i + 2 <= Math.min(dataLen, 200000); i += 2) samples.push(b.readInt16LE(dataOff + i) / 32768);

// Hann-windowed DFT via naive Cooley-Tukey (N=1024, ~10 frames is plenty)
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const frames = [];
for (let f = 0; f + N < samples.length; f += N * 4) {
  const re = new Array(N).fill(0), im = new Array(N).fill(0);
  for (let i = 0; i < N; i++) re[i] = samples[f + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  fft(re, im);
  const mag = [];
  for (let k = 1; k < N / 2; k++) mag.push(Math.hypot(re[k], im[k]));
  // geometric/arithmetic mean ratio = spectral flatness
  let logSum = 0, sum = 0;
  for (const m of mag) { logSum += Math.log(m + 1e-12); sum += m; }
  const flatness = Math.exp(logSum / mag.length) / (sum / mag.length);
  let bestK = 1, bestM = 0;
  for (let k = 1; k < mag.length; k++) if (mag[k] > bestM) { bestM = mag[k]; bestK = k; }
  frames.push({ flatness: +flatness.toFixed(3), domHz: Math.round(bestK * sampleRate / N) });
}
console.log(JSON.stringify(frames));
const avgFlat = frames.reduce((a, f) => a + f.flatness, 0) / frames.length;
console.log('avg flatness:', avgFlat.toFixed(3), avgFlat > 0.35 ? '=> NOISE (flat spectrum)' : '=> structured/harmonic (speech)');
