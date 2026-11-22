// Verify the diagnostics ring end-to-end in the real exe.
// argv[2]: path to the exe under test. Never browser.close().
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import * as fsmod from 'fs';

const exe = process.argv[2];
const proc = spawn(exe, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9333' },
  stdio: 'ignore',
});
let browser = null;
for(let i = 0; i < 40 && !browser; i++){
  await new Promise(r => setTimeout(r, 500));
  try { browser = await chromium.connectOverCDP('http://127.0.0.1:9333'); } catch(e) {}
}
if(!browser){ console.log('CDP attach failed'); proc.kill(); process.exit(1); }
const ctx = browser.contexts()[0];
const page = ctx.pages()[0] || await ctx.newPage();
await page.waitForFunction(() => !!document.body, null, { timeout: 15000 });

// enable the toggle explicitly (debug build only — release forces off)
await page.evaluate(() => { settings.debugLog = true; save(); });
await page.reload();
await page.waitForFunction(() => !!document.body, null, { timeout: 15000 });
await page.waitForTimeout(800);

const gate = await page.evaluate(() => ({ on: Dbg.on, release: !!window.__FOLIO_RELEASE_BUILD__, build: window.__FOLIO_BUILD_ID__ }));
console.log('GATE:', JSON.stringify(gate));

// open a real book + flip (if the debug build; release still exercises the gate)
if(gate.on){
  await page.evaluate(async () => {
    await openEpubPath('G:/books/The_Butchers_Masquerade__Dunge_-_Matt_Dinniman.epub');
  }).catch(e => console.log('open err:', String(e).slice(0, 120)));
  await page.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(900);
  await page.evaluate(() => { try { turn(1); } catch(e) {} });
  await page.waitForTimeout(1400);
  const res = await page.evaluate(() => {
    const dump = Dbg.dump();
    return {
      ring: Dbg.ring.length, shots: Dbg.shots.length,
      tags: [...new Set(Dbg.ring.map(e => e.tag))],
      dumpHead: dump.split('\n').slice(0, 4).join(' | '),
      shot0: Dbg.shots[0] ? { tag: Dbg.shots[0].tag, urlLen: Dbg.shots[0].url.length, head: Dbg.shots[0].url.slice(0, 30) } : null,
      shot0Full: Dbg.shots[0] ? Dbg.shots[0].url : null,
      entries: Dbg.ring.slice(-12).map(e => '[+' + e.t + ' ' + e.tag + '] ' + e.msg),
    };
  });
  console.log('RING:', res.ring, 'SHOTS:', res.shots, 'TAGS:', JSON.stringify(res.tags));
  console.log('DUMP HEAD:', res.dumpHead);
  console.log('SHOT0:', JSON.stringify(res.shot0 || null));
  console.log('ENTRIES:', JSON.stringify(res.entries));
  if(res.shot0Full) fsmod.writeFileSync('tests/manual/dbg-shot0.png', Buffer.from(res.shot0Full.split(',')[1], 'base64'));
} else {
  // release build: flip anyway and confirm the ring stays empty
  await page.evaluate(async () => {
    await openEpubPath('G:/books/The_Butchers_Masquerade__Dunge_-_Matt_Dinniman.epub');
  }).catch(() => {});
  await page.waitForFunction(() => document.body.classList.contains('state-reading'), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(900);
  await page.evaluate(() => { try { turn(1); } catch(e) {} });
  await page.waitForTimeout(1200);
  const r2 = await page.evaluate(() => ({ on: Dbg.on, ring: Dbg.ring.length }));
  console.log('RELEASE GATE:', JSON.stringify(r2));
}

await page.evaluate(() => { try { closeBook(); } catch(e) {} }).catch(() => {});
proc.kill();
console.log('done');
