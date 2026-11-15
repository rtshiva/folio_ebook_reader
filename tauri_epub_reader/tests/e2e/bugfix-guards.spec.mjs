// Bugfix guards for the 2026-11-10..14 fix batch (commits de477a1, 893e8e3,
// fcbeebf). Each test replays one bug from that batch that no other spec
// pins; the expected values are derived from the live code at HEAD 6f5b526.
//
// Conventions (mirrors regression-guards.spec.mjs): every test isolates with
// fresh(); pure page-context unit tests run on the landing page without
// opening a book (top-level `function` declarations AND top-level
// `const`/`let` bindings of the single inline script are reachable from
// page.evaluate); openDemoReady is used only where a rendition context is
// required (BUG26). Persisted data is seeded/read through StoreKV
// (indexedDB folio-kv-db), except the folio-stats-lm / folio-bstat-lm:<title>
// mirrors whose localStorage merge behaviour is exactly what BUG10 pins.
//
// NOTE on BUG18: the sweep targets the book that FELL OUT of the 4-slot
// history (the flush unshifts the pending title first), so with seeded
// recents A..E and a flush for E, D is the swept orphan and E survives —
// the task brief's "E keys deleted" description did not match the code.
import { test, expect } from '@playwright/test';
import { fresh, openDemoReady, SPEECH_MOCK } from './helpers.mjs';

test('BUG1 validateSettings clamps out-of-range typography and never creates phantom keys (de477a1)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(() => {
    settings.size = 40; settings.letter = -30; settings.word = 400;
    validateSettings();
    const clamped = { size: settings.size, letter: settings.letter, word: settings.word };
    settings.size = 21; settings.letter = 5; settings.word = 10;
    validateSettings();
    const inRange = { size: settings.size, letter: settings.letter, word: settings.word };
    settings.size = '21'; // Number.isFinite('21') is false -> reset to default
    validateSettings();
    const stringCoerced = settings.size;
    return {
      clamped, inRange, stringCoerced,
      phantomFont: Object.prototype.hasOwnProperty.call(settings, 'fontSize'),
      phantomLetter: Object.prototype.hasOwnProperty.call(settings, 'letterSpacing'),
      phantomWord: Object.prototype.hasOwnProperty.call(settings, 'wordSpacing'),
    };
  });
  expect(r.clamped, 'size 40 (>28) / letter -30 (<-20) / word 400 (>300) clamp to DEFAULTS 19.5/0/0')
    .toEqual({ size: 19.5, letter: 0, word: 0 });
  expect(r.inRange, 'in-range values pass through untouched').toEqual({ size: 21, letter: 5, word: 10 });
  expect(r.stringCoerced, 'a string size is not Number.isFinite -> reset to 19.5').toBe(19.5);
  expect(r.phantomFont, 'no phantom fontSize key written').toBe(false);
  expect(r.phantomLetter, 'no phantom letterSpacing key written').toBe(false);
  expect(r.phantomWord, 'no phantom wordSpacing key written').toBe(false);
});

test('BUG2 validateSettings clamps measure and coerces boolean channels (893e8e3)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(() => {
    settings.measure = 0; validateSettings();
    const mZero = settings.measure;
    settings.measure = '50'; validateSettings();
    const mString = settings.measure;
    settings.measure = 50; validateSettings();
    const mOk = settings.measure;
    // The exact boolean-coercion key list from validateSettings (~line 2026).
    settings.lhAuto = '0';
    settings.lsAuto = '1';
    settings.wsAuto = 1;
    settings.marginAuto = 'true';
    settings.widthAuto = true;
    settings.dropCaps = 'yes';
    settings.indent = false;
    validateSettings();
    return {
      mZero, mString, mOk,
      lhAuto: settings.lhAuto, lsAuto: settings.lsAuto, wsAuto: settings.wsAuto,
      marginAuto: settings.marginAuto, widthAuto: settings.widthAuto,
      dropCaps: settings.dropCaps, indent: settings.indent,
    };
  });
  expect(r.mZero, 'measure 0 (<10) clamps to DEFAULTS.measure 34').toBe(34);
  expect(r.mString, 'measure "50" is not finite -> 34').toBe(34);
  expect(r.mOk, 'numeric in-range measure survives').toBe(50);
  expect(r.lhAuto, '"0" coerces to false').toBe(false);
  expect(r.lsAuto, '"1" coerces to true').toBe(true);
  expect(r.wsAuto, '1 coerces to true').toBe(true);
  expect(r.marginAuto, '"true" coerces to true').toBe(true);
  expect(r.widthAuto, 'real true stays true').toBe(true);
  expect(r.dropCaps, '"yes" coerces to false (strict allowlist, not truthiness)').toBe(false);
  expect(r.indent, 'real false stays false').toBe(false);
});

test('BUG3 sanitizeChapterHtml strips FORM, drops remote LINK, keeps safe local stylesheet (de477a1 + 893e8e3)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(() => ({
    form: sanitizeChapterHtml('<p>before</p><form action="https://evil.example"><input name="q"></form><p>after</p>'),
    evilLink: sanitizeChapterHtml('<link rel="stylesheet" href="https://evil.example/x.css"><p>keep</p>'),
    safeLink: sanitizeChapterHtml('<link rel="stylesheet" href="style.css"><p>keep</p>'),
    cacheLink: sanitizeChapterHtml('<link rel="stylesheet" href="folio-cache://abc/x.css"><p>keep</p>'),
    plain: sanitizeChapterHtml('<p>a</p>'),
  }));
  expect(r.form, 'FORM is a forbidden tag (phishing UI)').not.toContain('<form');
  expect(r.form).toContain('<p>before</p>');
  expect(r.form).toContain('<p>after</p>');
  expect(r.evilLink, 'remote stylesheet link is removed (tracking beacons)').not.toContain('<link');
  expect(r.evilLink).toContain('<p>keep</p>');
  expect(r.safeLink, 'relative packaged-book stylesheet survives').toContain('<link rel="stylesheet" href="style.css">');
  expect(r.cacheLink, 'folio-cache: stylesheet survives').toContain('folio-cache://abc/x.css');
  expect(r.plain, 'plain content preserved').toContain('<p>a</p>');
});

test('BUG4 sanitizers reach inside <template>.content (893e8e3 #43)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(() => {
    const tpl = sanitizeChapterHtml('<template><script>alert(1)</script><img src=x onerror=y><p>ok</p></template>');
    const nested = sanitizeChapterHtml('<template><template><script>a</script><b onmouseover=x>deep</b></template></template>');
    const div = document.createElement('div');
    div.innerHTML = '<template><script>alert(2)</script><img src=q onerror=z></template><p>live</p>';
    sanitizeDomNode(div);
    const inner = div.querySelector('template');
    return {
      tpl, nested,
      domScript: inner.content.querySelector('script'),
      domOnerror: inner.content.querySelector('img').getAttribute('onerror'),
      live: div.querySelector('p').textContent,
    };
  });
  expect(r.tpl, 'no script survives the template fragment').not.toContain('<script');
  expect(r.tpl, 'no on* handler survives').not.toContain('onerror');
  expect(r.tpl).toContain('<p>ok</p>');
  expect(r.nested, 'nested templates cleaned too').not.toContain('<script');
  expect(r.domScript, 'sanitizeDomNode: template.content has no script').toBeNull();
  expect(r.domOnerror, 'sanitizeDomNode: onerror stripped inside template').toBeNull();
  expect(r.live, 'live content untouched').toBe('live');
});

test('BUG5 StoreKV.init is single-flight: two callers share one promise and one indexedDB.open (fcbeebf S1)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(async () => {
    // Boot already ran init(); reset the flags so this test owns the next open.
    StoreKV.ready = false; StoreKV.failed = false; StoreKV.initPromise = null;
    let opens = 0;
    const realOpen = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args) { opens++; return realOpen.apply(this, args); };
    const a = StoreKV.init();
    const b = StoreKV.init();
    const sameObj = a === b;
    await a;
    const readyAfter = StoreKV.ready;
    IDBFactory.prototype.open = realOpen;
    return { sameObj, opens, readyAfter };
  });
  expect(r.sameObj, 'concurrent init() calls return the same promise').toBe(true);
  expect(r.opens, 'exactly one indexedDB.open for both callers').toBe(1);
  expect(r.readyAfter, 'init completes and flips ready').toBe(true);
});

test('BUG6 migrateTarget keeps folio-locs: prefixed, strips folio- elsewhere (fcbeebf S3)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(() => ({
    locs: StoreKV.migrateTarget('folio-locs:The Time Machine'),
    dict: StoreKV.migrateTarget('folio-dict:test'),
    typo: StoreKV.migrateTarget('folio-typo:T'),
    pos: StoreKV.migrateTarget('folio-pos:T'),
    vocab: StoreKV.migrateTarget('folio-vocab:T'),
    bstat: StoreKV.migrateTarget('folio-bstat:T'),
  }));
  expect(r.locs, 'LocEngine reads/writes the full folio-locs:<title> key').toBe('folio-locs:The Time Machine');
  expect(r.dict).toBe('dict:test');
  expect(r.typo).toBe('typo:T');
  expect(r.pos).toBe('pos:T');
  expect(r.vocab).toBe('vocab:T');
  expect(r.bstat).toBe('bstat:T');
});

test('BUG7 migrateLegacy keeps the localStorage copy when the IDB put fails (fcbeebf S2)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(async () => {
    localStorage.setItem('folio-typo:T', JSON.stringify({ size: 21 }));
    localStorage.setItem('folio-dict:x', JSON.stringify(['alpha']));
    localStorage.setItem('folio-bstat:B', JSON.stringify({ min: 2 }));
    localStorage.setItem('folio-locs:L', JSON.stringify({ cfi: 'e1' }));
    const realPut = StoreKV.idbPut;
    StoreKV.idbPut = async () => false;
    await StoreKV.migrateLegacy();
    const keptAfterFailedPut = {
      typo: localStorage.getItem('folio-typo:T'),
      dict: localStorage.getItem('folio-dict:x'),
      bstat: localStorage.getItem('folio-bstat:B'),
      locs: localStorage.getItem('folio-locs:L'),
    };
    StoreKV.idbPut = realPut;
    await StoreKV.migrateLegacy();
    await StoreKV.hydrate(); // boot chain: migrate -> hydrate fills the mirror
    const afterOk = {
      typoKey: localStorage.getItem('folio-typo:T'),
      dictKey: localStorage.getItem('folio-dict:x'),
      typoVal: StoreKV.get('typo:T'),
      dictVal: StoreKV.get('dict:x'),
      locsVal: StoreKV.get('folio-locs:L'),
      bstatVal: StoreKV.get('bstat:B'),
    };
    return { keptAfterFailedPut, afterOk };
  });
  expect(r.keptAfterFailedPut.typo, 'put-failure guard: typo key NOT dropped').toBe(JSON.stringify({ size: 21 }));
  expect(r.keptAfterFailedPut.dict).toBe(JSON.stringify(['alpha']));
  expect(r.keptAfterFailedPut.bstat).toBe(JSON.stringify({ min: 2 }));
  expect(r.keptAfterFailedPut.locs).toBe(JSON.stringify({ cfi: 'e1' }));
  expect(r.afterOk.typoKey, 'successful migration removes the legacy copy').toBeNull();
  expect(r.afterOk.dictKey).toBeNull();
  expect(r.afterOk.typoVal).toEqual({ size: 21 });
  expect(r.afterOk.dictVal).toEqual(['alpha']);
  expect(r.afterOk.locsVal, 'folio-locs keeps its prefix through migration').toEqual({ cfi: 'e1' });
  expect(r.afterOk.bstatVal).toEqual({ min: 2 });
});

test('BUG8 hydrate keeps pre-init mem writes and re-persists them over the stored copy (fcbeebf S4)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(async () => {
    await StoreKV.idbPut('stats', { min: 1, pages: 2, days: {} }); // stale stored copy
    StoreKV.mem.set('stats', { min: 5, pages: 9, days: {} });      // pre-init write
    await StoreKV.hydrate();
    const memWins = StoreKV.get('stats');
    const persisted = await StoreKV.idbGet('stats');
    StoreKV.mem.delete('stats');
    await StoreKV.hydrate(); // no mem entry now: valid IDB shape is adopted
    const adopted = StoreKV.get('stats');
    return {
      memMin: memWins ? memWins.min : null,
      idbMin: persisted ? persisted.min : null,
      adoptedMin: adopted ? adopted.min : null,
      adoptedPages: adopted ? adopted.pages : null,
    };
  });
  expect(r.memMin, 'a write that landed before hydrate wins over the stored copy').toBe(5);
  expect(r.idbMin, 'and is re-persisted to IDB').toBe(5);
  expect(r.adoptedMin, 'with no mem entry the valid IDB shape is adopted').toBe(5);
  expect(r.adoptedPages).toBe(9);
});

test('BUG9 saveStatsSoon persists through StoreKV, never raw localStorage folio-stats (fcbeebf S5)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(async () => {
    statsCache = { min: 9, pages: 1, days: {} };
    saveStatsSoon(); // 2000ms debounce
    await new Promise((res) => setTimeout(res, 2300));
    const kv = StoreKV.get('stats');
    let idb = null;
    try { idb = await StoreKV.idbGet('stats'); } catch (e) {}
    return { kvMin: kv ? kv.min : null, idbMin: idb ? idb.min : null, legacyLs: localStorage.getItem('folio-stats') };
  });
  expect(r.kvMin, 'debounced flush wrote the stats record via StoreKV').toBe(9);
  expect(r.idbMin, 'record persisted into IDB').toBe(9);
  expect(r.legacyLs, 'no raw localStorage folio-stats write (it re-migrated stale copies)').toBeNull();
});

test('BUG10 loadStats/loadBookStat adopt the unload mirror only when its _ts wins (893e8e3 #47)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(async () => {
    await StoreKV.set('stats', { _ts: 100, min: 5 });
    localStorage.setItem('folio-stats-lm', JSON.stringify({ min: 9, _ts: 200 }));
    loadStats();
    const mirrorWins = { min: statsCache.min, ts: statsCache._ts };
    localStorage.setItem('folio-stats-lm', JSON.stringify({ min: 7, _ts: 50 }));
    loadStats();
    const olderMirrorIgnored = { min: statsCache.min };
    localStorage.setItem('folio-stats-lm', '{broken');
    loadStats();
    const malformedMirrorIgnored = { min: statsCache.min };
    await StoreKV.set('bstat:Dune', { _ts: 10, min: 3, days: { d1: 1 } });
    localStorage.setItem('folio-bstat-lm:Dune', JSON.stringify({ min: 8, _ts: 99 }));
    loadBookStat('Dune');
    const bstat = { min: bookStat.min, ts: bookStat._ts, hasDays: !!bookStat.days };
    localStorage.removeItem('folio-stats-lm');
    localStorage.removeItem('folio-bstat-lm:Dune');
    return { mirrorWins, olderMirrorIgnored, malformedMirrorIgnored, bstat };
  });
  expect(r.mirrorWins.min, 'fresher mirror _ts wins over the IDB record').toBe(9);
  expect(r.mirrorWins.ts, 'mirror _ts is deleted from the merged cache').toBeUndefined();
  expect(r.olderMirrorIgnored.min, 'older mirror loses -> IDB value stands').toBe(5);
  expect(r.malformedMirrorIgnored.min, 'malformed mirror JSON -> IDB value stands').toBe(5);
  expect(r.bstat.min, 'bstat mirror merge mirrors the stats behaviour').toBe(8);
  expect(r.bstat.ts, 'bstat mirror _ts deleted after merge').toBeUndefined();
  expect(r.bstat.hasDays, 'merged bstat keeps a days map').toBe(true);
});

test('BUG11 VocabLog.key resolves through getActiveTitle, not raw currentTitle (de477a1 #12)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(() => {
    const landing = VocabLog.key();
    state.currentTitle = 'Untitled';
    const untitled = VocabLog.key();
    state.currentTitle = 'The Time Machine';
    const real = VocabLog.key();
    state.currentTitle = '';
    return { landing, untitled, real };
  });
  expect(r.landing, 'empty title falls back to "Folio"').toBe('vocab:Folio');
  expect(r.untitled, '"Untitled" falls back to "Folio" (no phantom key split)').toBe('vocab:Folio');
  expect(r.real, 'real metadata title keys the vocab record').toBe('vocab:The Time Machine');
});

test('BUG12 warmth is not part of the buildCSS cache hash (de477a1 #14)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(() => {
    const a = buildCSS();
    const h1 = _cssHash;
    settings.warmth = 60;
    const b = buildCSS();
    const h2 = _cssHash;
    const c = buildCSS(); // unchanged settings: identical string via the cache
    settings.warmth = 0;
    return { same: a === b && b === c, hashStable: h1 === h2 };
  });
  expect(r.same, 'warmth change does not alter the injected chapter CSS').toBe(true);
  expect(r.hashStable, 'warmth must not enter the buildCSS hash (cache must not churn)').toBe(true);
});

test('BUG13 sameBookFile basename fallback + chapterFor returns the toc label (893e8e3 #21)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(() => {
    const cases = {
      identical: sameBookFile('text/part1/ch1.xhtml', 'text/part1/ch1.xhtml'),
      fragment: sameBookFile('text/part1/ch1.xhtml#anchor', 'text/part1/ch1.xhtml'),
      basename: sameBookFile('text/part1/ch1.xhtml', 'text/part2/ch1.xhtml'),
      backslash: sameBookFile('Text\\Part1\\Ch1.XHTML', './text/part1/ch1.xhtml'),
      different: sameBookFile('text/part1/ch1.xhtml', 'text/part1/ch2.xhtml'),
      emptyA: sameBookFile('', 'text/part1/ch1.xhtml'),
      emptyB: sameBookFile('text/part1/ch1.xhtml', ''),
    };
    tocItems = [{ href: 'text/part2/ch1.xhtml', label: 'B' }];
    const ch = chapterFor('text/part1/ch1.xhtml');
    tocItems = [];
    return { ...cases, ch };
  });
  expect(r.identical).toBe(true);
  expect(r.fragment, 'fragment stripped before comparing').toBe(true);
  expect(r.basename, 'EPUBs reuse basenames across folders: basename fallback matches').toBe(true);
  expect(r.backslash, 'backslashes, ./ prefix and case normalize').toBe(true);
  expect(r.different, 'different basenames never match').toBe(false);
  expect(r.emptyA, 'empty operand -> false').toBe(false);
  expect(r.emptyB).toBe(false);
  expect(r.ch, 'chapterFor resolves the label through the same matcher').toBe('B');
});

test('BUG14 bookIdentifier regex replay: cache URL hash wins, file path falls back (fcbeebf S6)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(() => {
    // Replay of openBuffer's inline identifier extraction (~line 3528) — the
    // extraction cannot be reached without a real open, so the exact regexes
    // are replayed here against the same inputs.
    const fromUrl = (url) => {
      const m = url.match(/(?:folio-cache\.localhost|folio-cache:)\/+([a-f0-9_]+)/i);
      return m ? RegExp.$1 : null;
    };
    const fallback = (filePath) => filePath ? filePath.replace(/[^a-zA-Z0-9_-]/g, '_') : null;
    return {
      http: fromUrl('http://folio-cache.localhost/deadbeef42/'),
      scheme: fromUrl('folio-cache://abc_123/'),
      nonCache: fromUrl('https://example.com/book.epub'),
      filePath: fallback('C:\\Books\\X.epub'),
    };
  });
  expect(r.http, 'http folio-cache.localhost form yields the hash').toBe('deadbeef42');
  expect(r.scheme, 'literal folio-cache:// form yields the hash').toBe('abc_123');
  expect(r.nonCache, 'non-cache URLs do not match').toBeNull();
  expect(r.filePath, 'non-cache opens key off the sanitized file path').toBe('C__Books_X_epub');
});

test('BUG15 exportBookData flattens and escapes user text in the Markdown clipboard payload (893e8e3 #14)', async ({ page }) => {
  await fresh(page);
  const md = await page.evaluate(async () => {
    StoreKV.set('highlights', [{
      id: 'hl_md1', bookTitle: currentBookKey(), cfi: 'epubcfi(md)', color: 'yellow',
      note: '> fake quote', chapter: 'C', snippet: '# fake heading', date: 'Nov 1',
    }]);
    let captured = null;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t) => { captured = t; } },
    });
    await exportBookData(); // no __TAURI__ in the harness -> clipboard path
    return captured;
  });
  expect(md, 'clipboard export captured').toBeTruthy();
  expect(md.startsWith('# Folio'), 'document header intact').toBe(true);
  expect(md).toContain('## Highlights');
  expect(md).toContain('\\# fake heading', 'leading # in user text escaped with backslash');
  expect(md).toContain('\\> fake quote', 'leading > in user note escaped with backslash');
  expect(md).not.toMatch(/^# fake/m, 'user text never starts its own heading line');
  expect(md).not.toMatch(/^> fake/m, 'user text never starts its own quote line');
});

test('BUG16 flushRelocCold fires the parked cold pass exactly once (893e8e3 #25)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(() => {
    const calls = [];
    window.onRelocatedCold = (...args) => { calls.push(args); };
    _relocColdArgs = [{ start: { cfi: 'c1' } }, 0.5, 'Ch', { a: 1 }];
    _relocColdTimer = 1;
    state.posKey = 'pos:T:x';
    flushRelocCold();
    const first = {
      count: calls.length,
      loc: calls[0] ? calls[0][0] : null,
      frac: calls[0] ? calls[0][1] : null,
      ch: calls[0] ? calls[0][2] : null,
      d: calls[0] ? calls[0][3] : null,
      timer: _relocColdTimer,
      parked: _relocColdArgs,
    };
    flushRelocCold(); // parked args now null: no second invocation
    const afterSecond = calls.length;
    _relocColdArgs = [{ start: { cfi: 'c2' } }, 0.4, 'Ch2', {}];
    state.posKey = null;
    flushRelocCold(); // no posKey: spy must NOT fire (args still dropped)
    const afterNullPosKey = calls.length;
    state.posKey = null; _relocColdArgs = null; _relocColdTimer = 0;
    return { first, afterSecond, afterNullPosKey };
  });
  expect(r.first.count, 'cold pass flushed once on close/quit').toBe(1);
  expect(r.first.loc).toEqual({ start: { cfi: 'c1' } });
  expect(r.first.frac).toBe(0.5);
  expect(r.first.ch).toBe('Ch');
  expect(r.first.d).toEqual({ a: 1 });
  expect(r.first.timer, 'timer cleared to 0').toBe(0);
  expect(r.first.parked, 'parked args consumed').toBeNull();
  expect(r.afterSecond, 'second flush is a no-op').toBe(1);
  expect(r.afterNullPosKey, 'no posKey -> cold pass not invoked').toBe(1);
});

test('BUG17 flushPerBookType mirrors every TYPO_KEYS channel under typo:<title> (893e8e3 #26)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(() => {
    const realSet = StoreKV.set;
    const writes = [];
    StoreKV.set = function (k, v) { writes.push({ k, v }); return realSet.apply(this, arguments); };
    settings.perBookType = true;
    state.currentTitle = 'Dune';
    flushPerBookType();
    const typoWrite = writes.find((w) => w.k === 'typo:Dune');
    const mirrored = typoWrite ? Object.keys(typoWrite.v) : [];
    const typoVal = typoWrite ? typoWrite.v : null;
    settings.perBookType = false;
    flushPerBookType();
    const writesAfterOff = writes.length;
    settings.perBookType = true;
    state.currentTitle = 'Untitled';
    flushPerBookType();
    const writesAfterUntitled = writes.length;
    StoreKV.set = realSet;
    settings.perBookType = false;
    state.currentTitle = '';
    return { mirrored, typoVal, writesAfterOff, writesAfterUntitled, appTypoKeys: TYPO_KEYS };
  });
  expect(r.mirrored, 'the mirrored record carries every TYPO_KEYS entry, same order')
    .toEqual(r.appTypoKeys);
  expect(r.mirrored).toContain('indent');
  expect(r.mirrored).toContain('oldstyle');
  expect(r.typoVal).toBeTruthy();
  expect(r.writesAfterOff, 'feature off -> no write').toBe(1);
  expect(r.writesAfterUntitled, '"Untitled" -> no write').toBe(1);
});

test('BUG18 _flushRecentBook sweeps the orphan that fell out of 4-slot history (fcbeebf S8 + 893e8e3 #29)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(async () => {
    const titles = ['A', 'B', 'C', 'D', 'E'];
    localStorage.setItem('folio-recents', JSON.stringify(titles.map((t) => ({ title: t }))));
    for (const t of titles) {
      StoreKV.set('thumb:' + t, 'thumb-data');
      StoreKV.set('typo:' + t, { size: 19.5 });
      StoreKV.set('bstat:' + t, { min: 1, days: {} });
      StoreKV.set('vocab:' + t, []);
      StoreKV.set('folio-locs:' + t, { cfi: 'e' });
      StoreKV.set('dict:' + t, 'def');
      StoreKV.set('pos:' + t + ':h1', { cfi: 'e' });
      StoreKV.set('pos:' + t + ':h2', { cfi: 'e2' });
    }
    await new Promise((res) => setTimeout(res, 250)); // let the async idbPuts land
    _recentPending = { title: 'E', author: 'Auth E', pct: 5, cfi: null, filePath: null };
    _flushRecentBook();
    const recents = JSON.parse(localStorage.getItem('folio-recents') || '[]').map((x) => x.title);
    const intact = {};
    for (const t of titles) {
      intact[t] = ['thumb:', 'typo:', 'bstat:', 'vocab:', 'folio-locs:', 'dict:']
        .every((p) => StoreKV.get(p + t) !== undefined) &&
        StoreKV.get('pos:' + t + ':h1') !== undefined &&
        StoreKV.get('pos:' + t + ':h2') !== undefined;
    }
    return { recents, intact };
  });
  expect(r.recents, 'history clamps to 4: E newest first, D fell out').toEqual(['E', 'A', 'B', 'C']);
  expect(r.intact.D, 'swept orphan D lost every record, including the pos:<t>:* mem sweep').toBe(false);
  expect(r.intact.A && r.intact.B && r.intact.C, 'kept books keep every record').toBe(true);
  expect(r.intact.E, 'the pending title E survives (it is IN the new history)').toBe(true);
});

test('BUG19 Highlights openPop installs one capture closer, hidePop tears it down (de477a1 #7)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(async () => {
    StoreKV.set('highlights', [{
      id: 'hl_pop1', bookTitle: currentBookKey(), cfi: 'epubcfi(p)', color: 'yellow',
      note: '', chapter: 'C', snippet: 's', date: '',
    }]);
    const origAdd = document.addEventListener.bind(document);
    const origRem = document.removeEventListener.bind(document);
    const live = [];
    let addedCapture = 0, removedCapture = 0;
    document.addEventListener = function (t, f, o) {
      if (t === 'pointerdown' && o === true) { addedCapture++; live.push({ f, isLive: true }); }
      return origAdd(t, f, o);
    };
    document.removeEventListener = function (t, f, o) {
      if (t === 'pointerdown' && o === true) {
        removedCapture++;
        const rec = live.find((x) => x.f === f && x.isLive);
        if (rec) rec.isLive = false;
      }
      return origRem(t, f, o);
    };
    Highlights.openPop('hl_pop1', { clientX: 10, clientY: 10 });
    await new Promise((res) => setTimeout(res, 30)); // closer installs on a 0ms timer
    const afterOpen = {
      addedCapture,
      liveCount: live.filter((x) => x.isLive).length,
      closerSet: !!Highlights._popCloser,
    };
    Highlights.hidePop();
    const afterHide = {
      removedCapture,
      liveCount: live.filter((x) => x.isLive).length,
      closerNull: Highlights._popCloser === null,
    };
    for (let i = 0; i < 3; i++) {
      Highlights.openPop('hl_pop1', { clientX: 12, clientY: 12 });
      await new Promise((res) => setTimeout(res, 10));
      Highlights.hidePop();
    }
    return {
      afterOpen, afterHide,
      finalLive: live.filter((x) => x.isLive).length,
      addedCapture, removedCapture,
    };
  });
  expect(r.afterOpen.addedCapture, 'exactly one capture pointerdown closer per open').toBe(1);
  expect(r.afterOpen.liveCount).toBe(1);
  expect(r.afterOpen.closerSet).toBe(true);
  expect(r.afterHide.removedCapture, 'hidePop removes the closer').toBe(1);
  expect(r.afterHide.liveCount).toBe(0);
  expect(r.afterHide.closerNull, '_popCloser reset to null').toBe(true);
  expect(r.finalLive, '3 open/hide cycles -> zero live closers').toBe(0);
  expect(r.addedCapture, 'adds and removes stay balanced (no stacking)').toBe(r.removedCapture);
});

test('BUG20 Footnotes.close tears down the show() closer; a stale closer never fires (de477a1 #8)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(() => {
    const origAdd = document.addEventListener.bind(document);
    const origRem = document.removeEventListener.bind(document);
    const recs = [];
    document.addEventListener = function (t, f, o) {
      if (t === 'pointerdown' && o === true) {
        const rec = { f, runs: 0, isLive: true };
        rec.wrapped = (ev) => { rec.runs++; return f.call(this, ev); };
        recs.push(rec);
        return origAdd(t, rec.wrapped, o);
      }
      return origAdd(t, f, o);
    };
    document.removeEventListener = function (t, f, o) {
      if (t === 'pointerdown' && o === true) {
        const rec = recs.find((x) => x.f === f && x.isLive);
        if (rec) { rec.isLive = false; return origRem(t, rec.wrapped, o); }
      }
      return origRem(t, f, o);
    };
    const doc = new DOMParser().parseFromString('<div><p>fn text</p></div>', 'text/html');
    Footnotes.show(doc.body.firstChild, 200, 200);
    const closer = Footnotes._closer;
    const afterShow = {
      closerSet: !!closer,
      registered: recs.some((x) => x.f === closer && x.isLive),
    };
    Footnotes.close();
    const closerRec = recs.find((x) => x.f === closer);
    const afterClose = {
      closerNull: Footnotes._closer === null,
      unregistered: closerRec ? !closerRec.isLive : false,
    };
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    return { afterShow, afterClose, staleRuns: closerRec ? closerRec.runs : -1 };
  });
  expect(r.afterShow.closerSet, 'show() installs a capture closer').toBe(true);
  expect(r.afterShow.registered).toBe(true);
  expect(r.afterClose.closerNull, 'close() clears _closer').toBe(true);
  expect(r.afterClose.unregistered, 'listener actually removed').toBe(true);
  expect(r.staleRuns, 'a later outside pointerdown must not hit the stale closer').toBe(0);
});

test('BUG21 fnPop delegated link guard: strict scheme allowlist, fragment scroll (fcbeebf S7)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(() => {
    const div = document.createElement('div');
    div.innerHTML = '<a id="a-js" href="javascript:window.__evil=true">js</a>' +
      '<a id="a-web" href="https://example.com">web</a>' +
      '<a id="a-frag" href="#frag">jump</a><p id="frag">target</p>' +
      '<a id="a-data" href="data:text/html,<b>x</b>">data</a>';
    Footnotes.show(div, 200, 200);
    const opens = [];
    window.open = (u, t, f) => { opens.push([u, t, f]); return null; };
    const click = (sel) => {
      const a = document.querySelector('#fnPop ' + sel);
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
      a.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    const clicks = {};
    // sanitizeDomNode already stripped javascript:/data: hrefs at import time
    // (the anchor survives, its href does not) — the guard still prevents the
    // default on the bare anchor and never opens.
    clicks.jsStripped = click('#a-js');
    clicks.dataStripped = click('#a-data');
    clicks.jsStrippedHrefless = document.querySelector('#fnPop #a-js').getAttribute('href') === null;
    clicks.web = click('#a-web');
    const fragTarget = document.querySelector('#fnPop #frag');
    const scrolls = [];
    fragTarget.scrollIntoView = (o) => { scrolls.push(o); };
    clicks.frag = click('#a-frag');
    // The guard's own scheme drop (URL-parse branch): inject an anchor with a
    // live javascript: href straight into the popup, past the import sanitizer.
    const late = document.createElement('a');
    late.id = 'a-late';
    late.href = 'javascript:window.__evil=true';
    document.querySelector('#fnPop .fn-body').appendChild(late);
    clicks.jsLate = click('#a-late');
    return { clicks, opens, scrolls, evil: window.__evil === true };
  });
  expect(r.clicks.jsStripped, 'stripped javascript: anchor click default prevented').toBe(true);
  expect(r.clicks.jsStrippedHrefless, 'sanitizeDomNode removed the javascript: href at import').toBe(true);
  expect(r.clicks.dataStripped, 'stripped data: anchor click default prevented').toBe(true);
  expect(r.evil, 'javascript: handler never evaluated').toBe(false);
  expect(r.opens, 'exactly the https anchor reaches window.open')
    .toEqual([['https://example.com/', '_blank', 'noopener,noreferrer']]);
  expect(r.clicks.frag, 'fragment click prevented (no navigation)').toBe(true);
  expect(r.scrolls, 'in-popup fragment scrolls to the target').toEqual([{ behavior: 'smooth' }]);
  expect(r.clicks.jsLate, 'live javascript: href dropped by the guard allowlist').toBe(true);
  expect(r.opens.length, 'frag and javascript: never open a window').toBe(1);
});

test('BUG22 TTS.setEngine toasts once per real switch; supported() is speech-only (de477a1 #2/#3)', async ({ page }) => {
  await page.addInitScript(SPEECH_MOCK);
  await fresh(page);
  const r = await page.evaluate(() => {
    const toasts = [];
    const origToast = window.toast;
    window.toast = (m) => { toasts.push(String(m || '')); return origToast(m); };
    KittenRunner.ready = () => true; // no worker spawn during the test
    const supportedWithMock = TTS.supported();
    TTS.setEngine('kitten');
    const engineToasts1 = toasts.filter((t) => t.startsWith('Read aloud engine')).length;
    const engineAfter = TTS.engine;
    const before = toasts.length;
    TTS.setEngine('kitten');
    const repeatToasts = toasts.length - before;
    // supported purity: PAGE_ART must not rescue a missing speech engine
    window.PAGE_ART = {};
    const desc = Object.getOwnPropertyDescriptor(window, 'speechSynthesis');
    delete window.speechSynthesis;
    const supportedNoSpeech = TTS.supported();
    Object.defineProperty(window, 'speechSynthesis', desc);
    const supportedRestored = TTS.supported();
    return { supportedWithMock, engineToasts1, engineAfter, repeatToasts, supportedNoSpeech, supportedRestored };
  });
  expect(r.supportedWithMock, 'mocked speech capability -> supported').toBe(true);
  expect(r.engineToasts1, 'system->kitten shows exactly one engine toast').toBe(1);
  expect(r.engineAfter).toBe('kitten');
  expect(r.repeatToasts, 'same-engine setEngine early-returns silently').toBe(0);
  expect(r.supportedNoSpeech, 'no speechSynthesis -> unsupported even with PAGE_ART present').toBe(false);
  expect(r.supportedRestored).toBe(true);
});

test('BUG23 TTS micro-state: pause clears gap timer, nudgeRate respects _loading, previewVoice refuses while active (893e8e3)', async ({ page }) => {
  await page.addInitScript(SPEECH_MOCK);
  await fresh(page);
  const r = await page.evaluate(async () => {
    const out = {};
    const toasts = [];
    const origToast = window.toast;
    window.toast = (m) => { toasts.push(String(m || '')); return origToast(m); };
    // (a) pause kills the pending inter-sentence gap timer
    let gapFired = 0;
    TTS.active = true; TTS.paused = false;
    TTS.gapT = setTimeout(() => { gapFired++; }, 300);
    TTS.pause();
    await new Promise((res) => setTimeout(res, 500));
    out.gapFired = gapFired;
    out.pausedFlag = TTS.paused;
    TTS.active = false; TTS.paused = false;
    // (b) nudgeRate during _loading: rate updates, no gen bump, no speakNext
    const realSpeakNext = TTS.speakNext;
    let speakNextCalls = 0;
    TTS.speakNext = function () { speakNextCalls++; return realSpeakNext.apply(this, arguments); };
    TTS.active = true; TTS.paused = false; TTS._loading = true;
    const genBefore = TTS.gen;
    TTS.nudgeRate(0.1);
    out.rateAfterNudge = TTS.rate;
    out.genUnchanged = TTS.gen === genBefore;
    out.speakNextDuringLoad = speakNextCalls;
    TTS._loading = false; TTS.active = false;
    // (c) previewVoice while narration is active refuses without speaking
    TTS.active = true;
    await TTS.previewVoice('bella');
    out.previewSpeakCalls = window.__speakCalls.length;
    out.previewRefusalToast = toasts.some((t) => t.startsWith('Stop read aloud first'));
    TTS.active = false;
    TTS.speakNext = realSpeakNext;
    TTS.rate = 1;
    return out;
  });
  expect(r.gapFired, 'pause must clear the pending gap timer (no double-advance)').toBe(0);
  expect(r.pausedFlag).toBe(true);
  expect(r.rateAfterNudge, 'the speed itself still applies (picked up at speak time)').toBe(1.1);
  expect(r.genUnchanged, '_loading guard: no gen invalidation').toBe(true);
  expect(r.speakNextDuringLoad, '_loading guard: no speakNext into stale sents').toBe(0);
  expect(r.previewSpeakCalls, 'preview over active narration never speaks').toBe(0);
  expect(r.previewRefusalToast).toBe(true);
});

test('BUG24 Highlights.add dedupes same-CFI records; remove() rebuilds the rendition (893e8e3 #11/#12)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(() => {
    const cfi = 'epubcfi(test-dedupe)';
    Highlights.add(cfi, 'yellow', 'snip A');
    Highlights.add(cfi, 'green');
    const store = StoreKV.get('highlights');
    const afterAdd = { len: store.length, color: store[0].color, snippet: store[0].snippet };
    const id = store[0].id;
    const realApply = Highlights.applyToRendition;
    let applyCalls = 0;
    Highlights.applyToRendition = function () { applyCalls++; return realApply.apply(this, arguments); };
    Highlights.remove(id);
    Highlights.applyToRendition = realApply;
    const storeAfter = StoreKV.get('highlights');
    return { afterAdd, applyCalls, gone: !storeAfter.some((h) => h.id === id), lenAfter: storeAfter.length };
  });
  expect(r.afterAdd.len, 'same-CFI re-highlight recolors, never duplicates').toBe(1);
  expect(r.afterAdd.color, 'second color wins').toBe('green');
  expect(r.afterAdd.snippet, 'first snippet survives the recolor').toBe('snip A');
  expect(r.applyCalls, 'remove() always rebuilds the marks').toBeGreaterThan(0);
  expect(r.gone, 'record gone from the store').toBe(true);
  expect(r.lenAfter).toBe(0);
  await page.evaluate(() => StoreKV.del('highlights')); // restore the store
});

test('BUG25 jumpToTocIndex ignores mid-turn jumps; applySpread queues toggles while busy (893e8e3 #22/#34)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(async () => {
    const out = {};
    tocItems = [{ href: 'text/c1.xhtml', label: 'C1' }];
    let displayCalls = 0;
    state.rendition = { display: async () => { displayCalls++; }, currentLocation: () => null };
    state.turning = true;
    await jumpToTocIndex(0);
    out.displayAfterTurning = displayCalls;
    state.turning = false;
    await jumpToTocIndex(0);
    out.displayAfterSettle = displayCalls;
    state.rendition = null; tocItems = []; state.turning = false;
    // applySpread: a toggle during the in-flight recreate is queued
    state.book = {};
    let destroyed = 0;
    state.rendition = { display: async () => {}, destroy() { destroyed++; } };
    state.spreadOn = false;
    spreadBusy = true;
    await applySpread();
    out.pendingDuringBusy = state.spreadPending;
    out.recreatingDuringBusy = state.recreating;
    out.destroyedDuringBusy = destroyed;
    spreadBusy = false; state.spreadPending = false; state.spreadOn = false;
    state.book = null; state.rendition = null;
    document.body.classList.remove('spread');
    return out;
  });
  expect(r.displayAfterTurning, 'mid-turn jump ignored before touching the rendition').toBe(0);
  expect(r.displayAfterSettle, 'same jump lands once the turn settles').toBe(1);
  expect(r.pendingDuringBusy, 'toggle during recreate is queued (spreadPending), not dropped').toBe(true);
  expect(r.recreatingDuringBusy, 'no second recreate started while busy').toBe(false);
  expect(r.destroyedDuringBusy, 'live rendition untouched while busy').toBe(0);
});

test('BUG26 doSearch token discipline: loser never renders, book switch mid-search never renders (893e8e3 #17/#18)', async ({ page }) => {
  await fresh(page);
  await openDemoReady(page);
  const r = await page.evaluate(async () => {
    const renders = [];
    const realRender = window.renderSearchResults;
    window.renderSearchResults = function (matches, q) { renders.push(q); };
    const p1 = doSearch('alpha'); // kicked, not awaited
    await doSearch('a'); // 1-char query: bumps the token and kills the in-flight search
    await p1;
    const rendersAfterTokenKill = renders.slice();
    const realBook = state.book;
    const p2 = doSearch('beta');
    state.book = {}; // book switched mid-search
    await p2;
    state.book = realBook;
    const rendersAfterBookSwitch = renders.slice();
    await doSearch('the'); // positive control: a completed search renders once
    window.renderSearchResults = realRender;
    return { rendersAfterTokenKill, rendersAfterBookSwitch, positive: renders.slice() };
  });
  expect(r.rendersAfterTokenKill, 'loser of the token race must never render').toEqual([]);
  expect(r.rendersAfterBookSwitch, 'book switched mid-search must never render').toEqual([]);
  expect(r.positive, 'the winning search renders exactly once').toEqual(['the']);
});

// ---- BUG27-BUG34: guards for the 2026-11-14 batch (commits 07a92cf,
// adbac83, f947210, 6f5b526, cd5d9d5), expected values derived from the
// live code at HEAD 6f5b526. Same conventions as BUG1-26 above.

test('BUG27 isSafeStylesheetUrl verdict table: relative/cache/blob hosts pass, script and protocol-relative refused (07a92cf)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(() => ({
    relative: isSafeStylesheetUrl('OEBPS/css/style.css'),
    remote: isSafeStylesheetUrl('https://cdn.attacker.example/x.css'),
    cacheHost: isSafeStylesheetUrl('https://folio-cache.localhost/abc/st.css'),
    protocolRelative: isSafeStylesheetUrl('//attacker.example/x.css'),
    js: isSafeStylesheetUrl('javascript:alert(1)'),
    vbs: isSafeStylesheetUrl('vbscript:evil'),
    dataHtml: isSafeStylesheetUrl('data:text/html,<script>'),
    dataCss: isSafeStylesheetUrl('data:text/css,body{}'),
    blob: isSafeStylesheetUrl('blob:https://tauri.localhost/9c2f'),
    cacheScheme: isSafeStylesheetUrl('folio-cache://abc/x.css'),
    tauriHost: isSafeStylesheetUrl('https://tauri.localhost/x.css'),
    nullHref: isSafeStylesheetUrl(null),
    emptyHref: isSafeStylesheetUrl(''),
  }));
  expect(r.relative, 'relative packaged-book path: no scheme -> safe').toBe(true);
  expect(r.remote, 'remote https host outside the localhost allowlist -> unsafe').toBe(false);
  expect(r.cacheHost, 'folio-cache.localhost is on the https host allowlist').toBe(true);
  expect(r.protocolRelative, '// skips the scheme check entirely -> always refused').toBe(false);
  expect(r.js, 'javascript: refused by the first-pass guard').toBe(false);
  expect(r.vbs, 'vbscript: refused by the same guard').toBe(false);
  expect(r.dataHtml, 'data:text/html refused (only data:text/css is exempt)').toBe(false);
  expect(r.dataCss, 'data:text/css stylesheet survives').toBe(true);
  expect(r.blob, 'blob: prefix is exempt').toBe(true);
  expect(r.cacheScheme, 'folio-cache: scheme is exempt').toBe(true);
  expect(r.tauriHost, 'tauri.localhost host allowlisted').toBe(true);
  expect(r.nullHref, 'null -> false').toBe(false);
  expect(r.emptyHref, 'empty string -> false').toBe(false);
});

test('BUG28 sanitizeChapterHtml drops non-stylesheet LINK plus the BASE/META forbidden tags (07a92cf)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(() => ({
    preload: sanitizeChapterHtml('<link rel="preload" href="a.js"><p>keep</p>'),
    icon: sanitizeChapterHtml('<link rel="icon" href="f.png"><p>keep</p>'),
    base: sanitizeChapterHtml('<base href="https://evil.example/"><p>keep</p>'),
    metaRefresh: sanitizeChapterHtml('<meta http-equiv="refresh" content="0;url=https://evil.example"><p>keep</p>'),
  }));
  expect(r.preload, 'rel !== stylesheet -> link removed even with a safe href').not.toContain('<link');
  expect(r.preload).toContain('<p>keep</p>');
  expect(r.icon, 'rel="icon" is not a stylesheet').not.toContain('<link');
  expect(r.base, 'BASE is in FORBIDDEN_TAGS (href rebasing)').not.toContain('<base');
  expect(r.metaRefresh, 'META is in FORBIDDEN_TAGS (http-equiv refresh)').not.toContain('<meta');
});

test('BUG29 fitUnderneath quantizes the backward-flip seat and honors cached chapter metrics (adbac83)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(() => {
    // Stub instance without the constructor: only the fields fitUnderneath
    // reads. The snap document's getElementById -> null makes the internal
    // syncSnapOrnaments a no-op; contentDocument.fonts is absent so the
    // font-recheck promise chain is skipped; apply() succeeds on the first
    // call, so the rAF retry loop never starts and the call is synchronous.
    const stub = (w) => Object.assign(Object.create(PageTurnCompositor.prototype), {
      underSnap: { style: {}, contentDocument: { body: { scrollWidth: w }, getElementById: () => null } },
      vRect: { width: 800 },
      isSpread: false,
      adjacentInfo: { spineIndex: 91 },
      backSnap: null,
      root: null,
    });
    const spreadStub = (w) => {
      const c = stub(w);
      c.isSpread = true;
      c.spineX = 400;
      c.backSnap = { style: {}, contentDocument: { getElementById: () => null } };
      return c;
    };
    const out = {};
    // (1) w=1604, vw=800: epsilon quantizer ceil((1604-6)/800)=2 steps ->
    // seat at -(2-1)*800 = -800, never -1600 (the phantom blank spread).
    pageCache.clear();
    const c1 = stub(1604);
    c1.fitUnderneath();
    out.w1604 = {
      left: c1.underSnap.style.left,
      width: c1.underSnap.style.width,
      base: c1.underSnap.__baseRelLeft,
      flipReady: c1.flipReady,
      metrics: pageCache.getChapterMetrics(91),
    };
    // (2) one-column chapter (w=800): exactly one step -> seat 0.
    pageCache.clear();
    const c2 = stub(800);
    c2.fitUnderneath();
    out.w800 = { left: c2.underSnap.style.left, width: c2.underSnap.style.width };
    // (3) cached fast path: known metrics short-circuit the quantizer for
    // any w — a fresh 900px chapter would quantize to -800, cache says -2400.
    pageCache.clear();
    pageCache.setChapterMetrics(91, { vWidth: 800, isSpread: false, lastSpreadLeft: -2400, fWidth: 3200 });
    const c3 = stub(900);
    c3.fitUnderneath();
    const m3 = pageCache.getChapterMetrics(91);
    out.cached = {
      left: c3.underSnap.style.left,
      width: c3.underSnap.style.width,
      metricsUntouched: m3 === null ? false : (m3.lastSpreadLeft === -2400 && m3.fWidth === 3200 && m3.totalPages === undefined),
    };
    // (4) spread mode: backSnap (right leaf) mirrors the seat shifted by spineX.
    pageCache.clear();
    const c4 = spreadStub(1604);
    c4.fitUnderneath();
    out.spread = {
      underLeft: c4.underSnap.style.left,
      backLeft: c4.backSnap.style.left,
      backWidth: c4.backSnap.style.width,
      backBase: c4.backSnap.__baseRelLeft,
    };
    // (5) a cached SINGLE-page shape must not leak into spread mode: the
    // fast-path isSpread match fails and the quantizer re-seats (-800).
    pageCache.clear();
    pageCache.setChapterMetrics(91, { vWidth: 800, isSpread: false, lastSpreadLeft: -2400, fWidth: 3200 });
    const c5 = spreadStub(1604);
    c5.fitUnderneath();
    out.spreadIgnoresSingleCache = c5.underSnap.style.left;
    pageCache.clear();
    return out;
  });
  expect(r.w1604.left, 'quantized seat -800px, NOT -1600px (epsilon kills the phantom blank spread)').toBe('-800px');
  expect(r.w1604.width, 'seat width = max(w, steps*vw) = max(1604, 1600)').toBe('1604px');
  expect(r.w1604.base).toBe(-800);
  expect(r.w1604.flipReady, 'apply() succeeds first try -> synchronous flipReady').toBe(true);
  expect(r.w1604.metrics, 'quantized run persists the exact metrics shape for spine 91').toEqual({
    totalPages: 2, totalSteps: 2, lastSpreadLeft: -800, fWidth: 1604, vWidth: 800, isSpread: false,
  });
  expect(r.w800.left, 'single-column chapter seats at 0').toBe('0px');
  expect(r.w800.width).toBe('800px');
  expect(r.cached.left, 'cached lastSpreadLeft wins over the quantizer (-2400, not -800)').toBe('-2400px');
  expect(r.cached.width, 'seat width = max(w, cached fWidth) = 3200').toBe('3200px');
  expect(r.cached.metricsUntouched, 'fast path does NOT rewrite the stored metrics').toBe(true);
  expect(r.spread.underLeft, 'spread underSnap seats like the single case').toBe('-800px');
  expect(r.spread.backLeft, 'backSnap left = targetRel - spineX (-800 - 400)').toBe('-1200px');
  expect(r.spread.backWidth, 'backSnap width mirrors totalWidth').toBe('1604px');
  expect(r.spread.backBase).toBe(-800);
  expect(r.spreadIgnoresSingleCache, 'single-page cached metrics ignored when isSpread mismatches').toBe('-800px');
});

test('BUG30 moveGuide seats the guide via transform only (f947210)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(() => {
    const g = el('guide');
    const topBefore = g.style.top;
    moveGuide(500);
    const t500 = g.style.transform;
    const topMid = g.style.top;
    moveGuide(0);
    const t0 = g.style.transform;
    const topAfter = g.style.top;
    return { topBefore, t500, topMid, t0, topAfter };
  });
  expect(r.t500, 'moveGuide(500) -> translateY(458px) (pointer minus the 42px handle offset)').toBe('translateY(458px)');
  expect(r.t0, 'moveGuide(0) -> translateY(-42px)').toBe('translateY(-42px)');
  expect(r.topBefore, 'no inline top to begin with').toBe('');
  expect(r.topMid === '' && r.topAfter === '', 'moveGuide never writes style.top (transform-only)').toBe(true);
});

test('BUG31 search input debounces, 2-char input threshold, Enter bypasses and clears the timer (f947210)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(async () => {
    const orig = window.doSearch;
    window.__searchCalls = [];
    window.doSearch = function (...a) {
      window.__searchCalls.push(a[0]);
      return orig.apply(null, a);
    };
    const inp = el('searchInput');
    const type = (v) => { inp.value = v; inp.dispatchEvent(new Event('input', { bubbles: true })); };
    const enter = () => inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    try {
      // (1) 1-char input is below the <2 threshold: immediate clear call, never debounced.
      type('a');
      const after1 = window.__searchCalls.slice();
      await wait(450);
      const after1Settled = window.__searchCalls.slice();
      // (2) 2-char input passes the threshold and debounces (250ms).
      type('ab');
      await wait(100);
      const at100 = window.__searchCalls.slice();
      await wait(350);
      const at450 = window.__searchCalls.slice();
      // (3) emptying the field calls the clear path immediately.
      type('');
      const afterEmpty = window.__searchCalls.slice();
      // (4) Enter fires the query at once and kills the pending debounce timer.
      type('abcd'); // schedules doSearch('abcd') at +250ms
      enter();      // clearTimeout + immediate call
      const afterEnter = window.__searchCalls.slice();
      await wait(450);
      const afterEnterSettled = window.__searchCalls.slice();
      // (5) Enter below the threshold is a no-op beyond the input clear call.
      type('a');
      enter();
      const afterShortEnter = window.__searchCalls.slice();
      return { after1, after1Settled, at100, at450, afterEmpty, afterEnter, afterEnterSettled, afterShortEnter };
    } finally {
      window.doSearch = orig;
      window.__searchCalls = null;
    }
  });
  expect(r.after1, '1-char input -> immediate doSearch("") clear call').toEqual(['']);
  expect(r.after1Settled, 'below-threshold input never schedules a debounced query').toEqual(['']);
  expect(r.at100, '2-char input: nothing fires inside the 250ms debounce window').toEqual(['']);
  expect(r.at450, '2-char input fires exactly once once the debounce elapses').toEqual(['', 'ab']);
  expect(r.afterEmpty, 'empty input is an immediate clear call').toEqual(['', 'ab', '']);
  expect(r.afterEnter, 'Enter bypasses the debounce and fires at once').toEqual(['', 'ab', '', 'abcd']);
  expect(r.afterEnterSettled, 'Enter cleared the pending timer: no second call at +450ms').toEqual(['', 'ab', '', 'abcd']);
  expect(r.afterShortEnter, 'Enter with a <2-char value adds nothing beyond the input clear call').toEqual(['', 'ab', '', 'abcd', '']);
});

test('BUG32 PageSound caches the synthesized turn buffers (f947210)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(() => {
    const c = PageSound.getCtx(); // lazy AudioContext: fine headless, resume rejection is caught inside
    const play1 = PageSound.getPlayBuf(c);
    const play2 = PageSound.getPlayBuf(c);
    const mid1 = PageSound.getMidBuf(c);
    const mid2 = PageSound.getMidBuf(c);
    const out = {
      sampleRate: c.sampleRate,
      playCached: play1 === play2,
      midCached: mid1 === mid2,
      distinct: mid1 !== play1,
      playLen: play1.length,
      midLen: mid1.length,
      playChannels: play1.numberOfChannels,
      midChannels: mid1.numberOfChannels,
      playSampleRate: play1.sampleRate,
    };
    try { c.close(); } catch (e) {}
    PageSound.ctx = null; PageSound.playBuf = null; PageSound.midBuf = null;
    return out;
  });
  expect(r.playCached, 'getPlayBuf returns the same cached buffer on repeat calls').toBe(true);
  expect(r.midCached, 'getMidBuf returns the same cached buffer on repeat calls').toBe(true);
  expect(r.distinct, 'mid swish is a distinct buffer from the play swish').toBe(true);
  expect(r.playLen, 'play buffer = floor(sampleRate * 0.22)').toBe(Math.floor(r.sampleRate * 0.22));
  expect(r.midLen, 'mid buffer = floor(sampleRate * 0.12)').toBe(Math.floor(r.sampleRate * 0.12));
  expect(r.playChannels, 'mono play buffer').toBe(1);
  expect(r.midChannels, 'mono mid buffer').toBe(1);
  expect(r.playSampleRate, 'buffer inherits the context sample rate').toBe(r.sampleRate);
});

test('BUG33 TTS.stop resets the starvation counter and warned flag (6f5b526)', async ({ page }) => {
  await page.addInitScript(SPEECH_MOCK);
  await fresh(page);
  const r = await page.evaluate(() => {
    const toasts = [];
    const origToast = window.toast;
    window.toast = (m) => { toasts.push(String(m || '')); return origToast(m); };
    try {
      TTS.consecutiveStarveCount = 2; // as if two slow chunks warned already
      TTS._starveWarned = true;
      TTS.stop(true); // signature stop(silent): true suppresses the stop toast
      const after = {
        count: TTS.consecutiveStarveCount,
        warned: TTS._starveWarned,
        active: TTS.active,
        stoppedToasts: toasts.filter((t) => t.startsWith('Read aloud stopped')).length,
      };
      TTS.stop(true); // repeat stop stays clean
      const afterAgain = { count: TTS.consecutiveStarveCount, warned: TTS._starveWarned };
      return { after, afterAgain };
    } finally {
      window.toast = origToast;
      TTS.active = false; TTS.paused = false; TTS.stopped = true;
      TTS.consecutiveStarveCount = 0; TTS._starveWarned = false;
    }
  });
  expect(r.after.count, 'stop() zeroes the consecutive-starvation counter').toBe(0);
  expect(r.after.warned, 'stop() clears _starveWarned so a fresh session can warn again').toBe(false);
  expect(r.after.active, 'stop() deactivates narration').toBe(false);
  expect(r.after.stoppedToasts, 'silent stop emits no "Read aloud stopped" toast').toBe(0);
  expect(r.afterAgain.count, 'a repeat stop keeps the counter at zero').toBe(0);
  expect(r.afterAgain.warned).toBe(false);
});

test('BUG34 isImageOnlyDoc edges: icon filter, single-substantial-image rule, cover text allowance (cd5d9d5)', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(() => {
    const parse = (html) => new DOMParser().parseFromString(html, 'text/html');
    return {
      plainImg: isImageOnlyDoc(parse('<body><div><img width="400" height="600"></div></body>')),
      iconPlusText: isImageOnlyDoc(parse('<body><p>To curious minds.</p><img width="24" height="24"></body>')),
      twoSubstantial: isImageOnlyDoc(parse('<body><img width="400" height="600"><img width="300" height="500"></body>')),
      coverShortText: isImageOnlyDoc(parse('<body class="cover"><p>Chapter One</p><img width="500" height="700"></body>')),
      svgImage: isImageOnlyDoc(parse('<body><svg width="400" height="600"><image xlink:href="x"/></svg></body>')),
      coverLongText: isImageOnlyDoc(parse('<body class="cover"><p>A caption far longer than the thirty character allowance.</p><img width="500" height="700"></body>')),
      coverHeading: isImageOnlyDoc(parse('<body class="cover"><h1>Chapter One</h1><img width="500" height="700"></body>')),
      noImages: isImageOnlyDoc(parse('<body><p>To curious minds.</p></body>')),
    };
  });
  expect(r.plainImg, 'one substantial image, zero text -> image-only').toBe(true);
  expect(r.iconPlusText, 'only an icon-sized img (both dims <= 64) -> no substantial image -> false').toBe(false);
  expect(r.twoSubstantial, 'two substantial images -> false (exactly 1 required)').toBe(false);
  expect(r.coverShortText, 'short text (10 chars, whitespace-stripped) + cover class + no headings -> true').toBe(true);
  expect(r.svgImage, 'svg counts as the one substantial element; attr-only content is zero text').toBe(true);
  expect(r.coverLongText, 'cover class cannot rescue text beyond the 30-char allowance').toBe(false);
  expect(r.coverHeading, 'any heading/figcaption/table refutes even on a cover').toBe(false);
  expect(r.noImages, 'no images at all -> false').toBe(false);
});
