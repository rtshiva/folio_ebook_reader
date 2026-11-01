// KittenTTS live probe: model install (progress events), Bella/Jasper
// generation to WAV bytes, engine switch, and a full TTS round on the
// kitten engine. Run: node tests/manual/probe_kitten.cjs (needs src/ on :8124)
const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/sourcemapp?ing/i.test(m.text())) console.log('CONSOLE-ERR', m.text().slice(0, 120)); });

  await page.goto('http://127.0.0.1:8124/');
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('folio-settings', JSON.stringify({ themeAuto: false, rrTheme: 'match' }));
    localStorage.setItem('folio-coach-done', '1');
  });
  await page.reload();
  await page.locator('#btnDemo').waitFor({ timeout: 9000 });
  await page.click('#btnDemo');
  await page.waitForFunction(() => typeof LocEngine !== 'undefined' && LocEngine.ready(), null, { timeout: 20000 });
  await page.waitForTimeout(600);

  // 1. switch to the kitten engine via the settings UI
  await page.keyboard.press('s');
  await page.waitForFunction(() => document.body.classList.contains('sheet-open'));
  await page.evaluate(() => { document.querySelector('#engineSeg [data-engine="kitten"]').click(); });
  const engine = await page.evaluate(() => TTS.engine);
  console.log('1. engine:', engine);

  // 2. install (download ~92MB) with progress
  let lastPct = -1;
  const t0 = Date.now();
  await page.evaluate(() => TTS.kittenInstall());
  await page.waitForFunction(() => KittenRunner.ready(), null, { timeout: 600000 });
  console.log('2. installed in', Math.round((Date.now() - t0) / 1000) + 's, progress reached', await page.evaluate(() => KittenRunner.progress()));

  // 3. generate Bella + Jasper samples to real WAV bytes
  for (const voice of ['bella', 'jasper']) {
    const r = await page.evaluate(async (v) => {
      const bytes = await KittenRunner.generate('Hello, this is ' + v + ' reading the Time Machine aloud.', v);
      return { len: bytes.length, riff: bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 };
    }, voice);
    console.log('3.', voice, '→', r.len, 'bytes WAV,', r.riff ? 'RIFF OK' : 'BAD HEADER');
  }

  // 4. engine switch mid-book: toggle TTS on kitten, turn, verify highlight moves
  await page.evaluate(() => { TTS.setVoice('bella'); TTS.toggle(); });
  await page.waitForFunction(() => TTS.active && TTS.sents.length > 0, null, { timeout: 15000 });
  await page.waitForTimeout(2500); // let a sentence generate + play
  const mid = await page.evaluate(() => ({ active: TTS.active, si: TTS.si, hl: !!TTS.hl }));
  console.log('4. mid-read:', JSON.stringify(mid));
  await page.evaluate(() => TTS.stop(true));

  // 5. system engine still works (mock-free: real speechSynthesis may be silent — just check no crash)
  await page.evaluate(() => TTS.setEngine('system'));
  await page.evaluate(() => TTS.toggle());
  await page.waitForTimeout(1200);
  const sys = await page.evaluate(() => ({ active: TTS.active, engine: TTS.engine }));
  console.log('5. system engine:', JSON.stringify(sys));
  await page.evaluate(() => TTS.stop(true));

  console.log('PROBE COMPLETE');
  await browser.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
