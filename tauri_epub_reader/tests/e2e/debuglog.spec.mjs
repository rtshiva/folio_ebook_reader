// Debug diagnostics ring (Dbg) regression net: off by default, explicit-only,
// ring + dump work when enabled, console capture, build-flag semantics.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { fresh, openDemoReady } from './helpers.mjs';

test('DBG1 ring is empty while the toggle is off (zero overhead default)', async ({ page }) => {
  await fresh(page);
  await openDemoReady(page);
  await page.evaluate(() => turn(1));
  await page.waitForTimeout(900);
  const r = await page.evaluate(() => ({
    on: Dbg.on,
    ring: Dbg.ring.length,
    shots: Dbg.shots.length,
  }));
  expect(r.on, 'debug ring off by default').toBe(false);
  expect(r.ring, 'no events collected while off').toBe(0);
  expect(r.shots, 'no screenshots while off').toBe(0);
});

test('DBG2 enabling the toggle collects events; dump carries build id + entries', async ({ page }) => {
  await fresh(page);
  await page.evaluate(() => { settings.debugLog = true; save(); });
  await openDemoReady(page);
  await page.evaluate(() => turn(1));
  await page.waitForTimeout(1000); // relocation hot+cold passes
  const r = await page.evaluate(() => {
    const dump = Dbg.dump();
    return {
      on: Dbg.on,
      ring: Dbg.ring.length,
      tags: [...new Set(Dbg.ring.map(e => e.tag))],
      hasRelocHot: Dbg.ring.some(e => e.tag === 'RELOC' && e.msg === 'hot'),
      hasRelocCold: Dbg.ring.some(e => e.tag === 'RELOC' && e.msg === 'cold'),
      hasSnapStart: Dbg.ring.some(e => e.tag === 'SNAP' && e.msg === 'start'),
      hasCacheCapture: Dbg.ring.some(e => e.tag === 'CACHE' && e.msg === 'capture'),
      dumpHasBuild: dump.includes('build: dbg-') || dump.includes('build: dev'),
      dumpHasState: dump.includes('state: '),
      dumpHasEntries: dump.includes('[+'),
      shots: Dbg.shots.length, // dev server has no __TAURI_INTERNALS__ — must stay empty, not crash
    };
  });
  expect(r.on, 'ring on after explicit toggle').toBe(true);
  expect(r.ring, 'events collected while on').toBeGreaterThan(0);
  expect(r.hasRelocHot && r.hasRelocCold, 'relocation lifecycle logged').toBe(true);
  expect(r.hasSnapStart, 'flip start logged').toBe(true);
  expect(r.hasCacheCapture, 'cache writes logged with source').toBe(true);
  expect(r.dumpHasBuild && r.dumpHasState && r.dumpHasEntries, 'dump = build id + state + entries').toBe(true);
  expect(r.shots, 'screenshot capture no-ops safely without Tauri IPC').toBe(0);
});

test('DBG3 console error/warn captured into the ring', async ({ page }) => {
  await fresh(page);
  await page.evaluate(() => { settings.debugLog = true; save(); });
  await openDemoReady(page);
  await page.evaluate(() => { console.warn('dbg-probe-warning'); console.error('dbg-probe-error'); });
  const found = await page.evaluate(() => ({
    warn: Dbg.ring.some(e => e.tag === 'CONSOLE.warn' && e.msg.includes('dbg-probe-warning')),
    error: Dbg.ring.some(e => e.tag === 'CONSOLE.error' && e.msg.includes('dbg-probe-error')),
  }));
  expect(found.warn && found.error, 'console warn/error captured').toBe(true);
});

test('DBG4 build flag: in-tree default is debug; validateSettings coerces booleans', async ({ page }) => {
  // the committed flag file must never default to release
  const flag = readFileSync(new URL('../../src/__buildflag.js', import.meta.url), 'utf8');
  expect(flag, 'in-tree build flag default is a debug build').toContain('__FOLIO_RELEASE_BUILD__ = false');
  await fresh(page);
  await page.evaluate(() => { settings.debugLog = 'true'; save(); }); // pre-coercion string via the real save path
  await page.waitForTimeout(400); // debounced write must land before reload
  await page.reload();
  const coerced = await page.evaluate(() => ({ debugLog: settings.debugLog, type: typeof settings.debugLog }));
  expect(coerced.debugLog, 'string "true" coerced to boolean').toBe(true);
  expect(coerced.type, 'coerced to real boolean').toBe('boolean');
});
