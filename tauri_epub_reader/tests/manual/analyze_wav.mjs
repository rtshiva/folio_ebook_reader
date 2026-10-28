// WAV sanity stats: header fields, RMS, zero-crossing rate, peak.
// Usage: node tests/manual/analyze_wav.mjs <file.wav> [...]
import { readFileSync } from 'node:fs';

for (const path of process.argv.slice(2)) {
  const b = readFileSync(path);
  const out = { path, size: b.length };
  out.magic = b.toString('ascii', 0, 4);
  // find fmt chunk and data chunk
  let pos = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (pos + 8 <= b.length) {
    const id = b.toString('ascii', pos, pos + 4);
    const sz = b.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      fmt = {
        format: b.readUInt16LE(pos + 8),
        channels: b.readUInt16LE(pos + 10),
        sampleRate: b.readUInt32LE(pos + 12),
        bits: b.readUInt16LE(pos + 22),
      };
    } else if (id === 'data') { dataOff = pos + 8; dataLen = sz; }
    pos += 8 + sz + (sz % 2);
  }
  out.fmt = fmt; out.dataLen = dataLen;
  if (fmt && fmt.bits === 16 && dataOff > 0) {
    const n = Math.floor(dataLen / 2);
    let sumSq = 0, peak = 0, zc = 0, prev = 0;
    for (let i = 0; i < n; i++) {
      const s = b.readInt16LE(dataOff + i * 2);
      sumSq += s * s;
      const a = Math.abs(s); if (a > peak) peak = a;
      if (i > 0 && ((s >= 0) !== (prev >= 0))) zc++;
      prev = s;
    }
    const rms = Math.sqrt(sumSq / n);
    out.rms = Math.round(rms);
    out.peak = peak;
    out.zcr = +(zc / (n - 1)).toFixed(4);
    out.secs = +(n / fmt.sampleRate).toFixed(2);
    // speech: moderate RMS + low ZCR; white noise: high RMS-ish + ZCR ~0.5
    out.verdict = out.zcr > 0.4 ? 'LOOKS LIKE NOISE' : 'looks like speech';
  }
  console.log(JSON.stringify(out));
}
