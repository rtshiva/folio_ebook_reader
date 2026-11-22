// One-off patcher: the Dbg diagnostics ring — module, call sites, UI, wiring.
// Every patch asserts its anchor; any miss aborts before writing.
const fs = require('fs');
const p = 'src/index.html';
let s = fs.readFileSync(p, 'utf8');
let applied = 0;
const CRLF = s.includes('\r\n');
const A = (t) => CRLF ? t.split('\n').join('\r\n') : t;
function patch(name, anchor, replacement) {
  if (replacement === undefined) { console.log('anchor only ok:', name); applied++; return; }
  anchor = A(anchor); replacement = A(replacement);
  const lfA = anchor.split('
').join('
');
  const lfR = replacement.split('
').join('
');
  if (s.includes(replacement) || s.includes(lfR)) { console.log('skip (already applied):', name); return; }
  if (!s.includes(anchor)) anchor = lfA;
  if (!s.includes(anchor)) { console.log('MISS:', name); process.exitCode = 1; return; }
  s = s.replace(anchor, replacement);
  applied++;
  console.log('ok:', name);
}

// 1. buildflag script tag (before the app's inline scripts)
patch('buildflag script tag',
  '<script src="vendor/fonts/fonts-inline.js"></script>',
  '<script src="vendor/fonts/fonts-inline.js"></script>\n    <script src="./__buildflag.js"></script>');

// 2. settings UI: toggle + copy button after the per-monitor toggle
patch('debug settings UI',
  `      <label class="sw"><input type="checkbox" id="swMonitorLayout"><span class="tr"></span>
        <span class="tx"><b>Per-monitor layout</b><small>Remember text size, spread and margins for each monitor.</small></span></label>`,
  `      <label class="sw"><input type="checkbox" id="swMonitorLayout"><span class="tr"></span>
        <span class="tx"><b>Per-monitor layout</b><small>Remember text size, spread and margins for each monitor.</small></span></label>
      <label class="sw"><input type="checkbox" id="swDebugLog"><span class="tr"></span>
        <span class="tx"><b>Debug logging</b><small>Keep a diagnostics ring (events + screenshots at flips and chapter transitions). Copy it with Ctrl+Shift+D. Off in release builds.</small></span></label>
      <div style="margin-top:8px"><button class="chip" id="btnCopyDbg" type="button">Copy debug diagnostics</button></div>`);

// 3. DEFAULTS
patch('DEFAULTS debugLog',
  `  rrTheme:'royal-maroon', rrOrnaments:true, rrFrame:true
};`,
  `  rrTheme:'royal-maroon', rrOrnaments:true, rrFrame:true,
  debugLog:false
};`);

// 4. boolean validation list
patch('validate boolean list',
  "'monitorLayout','themeAuto','rrOrnaments','rrFrame'].forEach(k => {",
  "'monitorLayout','themeAuto','rrOrnaments','rrFrame','debugLog'].forEach(k => {");

// 5. the Dbg module
patch('Dbg module',
  `let settings = {...DEFAULTS};`,
  `let settings = {...DEFAULTS};
/* ---------------- debug diagnostics ring (Dbg) ----------------
   Grounded in the bugs it exists for: the flip flicker (two cache pipelines,
   last write wins), the canvas-propagation paper (computed styles lied while
   pixels told the truth), the 1000-char location grid skipping covers, the
   stale-binary trap. Gated twice — settings.debugLog (explicit user toggle,
   never auto-enabled) AND __FOLIO_RELEASE_BUILD__ (the build script stamps
   release builds; the ring is force-off there). When on: a capped event
   ring + screenshots taken AT event time (flips, leaf transitions — after
   the fact nothing shows a flicker) + console error/warn capture. Dump =
   Copy debug diagnostics / Ctrl+Shift+D. */
const Dbg = {
  MAX: 600, SHOT_MAX: 6, SHOT_MIN_MS: 500,
  ring: [], shots: [], lastShot: 0, t0: 0,
  _totals: new Map(),
  get on(){ return !!settings.debugLog && !window.__FOLIO_RELEASE_BUILD__; },
  log(tag, msg, data){
    if(!this.on) return;
    if(!this.t0) this.t0 = Date.now();
    this.ring.push({ t: Date.now() - this.t0, tag, msg: String(msg), d: data || null });
    if(this.ring.length > this.MAX) this.ring.splice(0, this.ring.length - this.MAX);
  },
  /* Event-time capture: PrintWindow via the Rust command, downscaled and
     JPEG-encoded here. Fire-and-forget; rate-limited; capped ring. */
  shot(tag){
    if(!this.on) return;
    const now = Date.now();
    if(now - this.lastShot < this.SHOT_MIN_MS) return;
    this.lastShot = now;
    if(!window.__TAURI_INTERNALS__) return;
    try{
      const inv = window.__TAURI_INTERNALS__.invoke;
      Promise.resolve().then(() => inv('debug_capture_window')).then((r) => {
        if(!r || !r.b64 || !r.w) return;
        const bin = atob(r.b64);
        const raw = new Uint8Array(bin.length);
        for(let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
        const tmp = document.createElement('canvas');
        tmp.width = r.w; tmp.height = r.h;
        const tctx = tmp.getContext('2d');
        const im = tctx.createImageData(r.w, r.h);
        for(let i = 0; i < raw.length; i += 4){
          im.data[i] = raw[i + 2]; im.data[i + 1] = raw[i + 1]; im.data[i + 2] = raw[i]; im.data[i + 3] = 255;
        }
        tctx.putImageData(im, 0, 0);
        const scale = Math.min(1, 820 / r.w);
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(r.w * scale));
        cv.height = Math.max(1, Math.round(r.h * scale));
        cv.getContext('2d').drawImage(tmp, 0, 0, cv.width, cv.height);
        const url = cv.toDataURL('image/jpeg', 0.55);
        if(!this.t0) this.t0 = now;
        this.shots.push({ t: now - this.t0, tag, url });
        if(this.shots.length > this.SHOT_MAX) this.shots.shift();
        this.log('SHOT', tag, { ms: now - this.t0 });
      }).catch(() => {});
    }catch(e){}
  },
  initConsole(){
    if(this.__conInit) return; this.__conInit = true;
    ['error', 'warn'].forEach((k) => {
      const orig = console[k].bind(console);
      console[k] = (...args) => {
        if(this.on){
          const txt = args.map(a => { try{ return typeof a === 'string' ? a : JSON.stringify(a).slice(0, 240); }catch(e){ return String(a); } }).join(' ');
          this.log('CONSOLE.' + k, txt.slice(0, 400));
        }
        orig(...args);
      };
    });
  },
  dump(){
    const lines = [];
    lines.push('=== Folio debug diagnostics ===');
    lines.push('build: ' + (window.__FOLIO_BUILD_ID__ || 'dev') + ' | release: ' + (!!window.__FOLIO_RELEASE_BUILD__ || false));
    try{
      const loc = state.rendition ? state.rendition.currentLocation() : null;
      const d0 = loc && loc.start ? loc.start.displayed : null;
      lines.push('state: ' + JSON.stringify({
        title: getActiveTitle(), idx: loc ? loc.start.index : null,
        disp: d0, spread: !!state.spreadOn, locsReady: LocEngine.ready(),
        tocLen: tocItems.length, chNavIdx: chNavIdx,
        spread_setting: settings.spread, turnFx: settings.turnFx,
        recents: getRecents().length,
        cacheHtmls: pageCache.chapterHtmls.size, cacheMetrics: pageCache.chapterMetrics.size,
        viewerCls: el('viewer').className, ring: this.ring.length, shots: this.shots.length,
      }));
    }catch(e){ lines.push('state: (error: ' + e + ')'); }
    for(const e of this.ring) lines.push('[+' + e.t + 'ms ' + e.tag + '] ' + e.msg + (e.d ? ' ' + JSON.stringify(e.d) : ''));
    for(const sh of this.shots) lines.push('[SHOT +' + sh.t + 'ms ' + sh.tag + '] ' + sh.url);
    return lines.join('\n');
  },
  copyDump(){
    try{
      const text = this.dump();
      navigator.clipboard.writeText(text).then(
        () => toast('Debug diagnostics copied (' + this.ring.length + ' events, ' + this.shots.length + ' shots)'),
        () => toast('Clipboard write failed — see console'));
      console.log('[dbg dump]\\n' + text.split('\\n').filter(l => !l.startsWith('[SHOT')).join('\\n'));
    }catch(e){ toast('Dump failed: ' + e); }
  },
  clear(){ this.ring.length = 0; this.shots.length = 0; this.t0 = Date.now(); }
};
Dbg.initConsole();
Dbg.log('INIT', 'build ' + (window.__FOLIO_BUILD_ID__ || 'dev') + ', release=' + (!!window.__FOLIO_RELEASE_BUILD__));`);

// 6. Ctrl+Shift+D in onKey (before the dialog handling — modifier combo)
patch('onKey Ctrl+Shift+D',
  `function onKey(e){
  const openDialog = (document.activeElement && document.activeElement.closest && document.activeElement.closest('#sheet.open, #toc.open, #searchDrawer.open, #helpOverlay.show, aside[role="dialog"], div[role="dialog"]'))`,
  `function onKey(e){
  if(e.ctrlKey && e.shiftKey && !e.altKey && (e.key === 'D' || e.key === 'd')){
    e.preventDefault();
    Dbg.copyDump();
    return;
  }
  const openDialog = (document.activeElement && document.activeElement.closest && document.activeElement.closest('#sheet.open, #toc.open, #searchDrawer.open, #helpOverlay.show, aside[role="dialog"], div[role="dialog"]'))`);

// 7. settings UI wiring (checked sync near swMonitorLayout.checked)
patch('swDebugLog sync',
  `  el('swMonitorLayout').checked=settings.monitorLayout !== false;`,
  `  el('swMonitorLayout').checked=settings.monitorLayout !== false;
  el('swDebugLog').checked=settings.debugLog === true;
  el('swDebugLog').disabled = !!window.__FOLIO_RELEASE_BUILD__;`);

// 8. swDebugLog listener (after swMonitorLayout listener)
patch('swDebugLog listener',
  `el('swMonitorLayout').addEventListener('change',e=>{
  settings.monitorLayout=e.target.checked; save();
  if(settings.monitorLayout) detectMonitor(true);   // adopt the current monitor's store now
});`,
  `el('swMonitorLayout').addEventListener('change',e=>{
  settings.monitorLayout=e.target.checked; save();
  if(settings.monitorLayout) detectMonitor(true);   // adopt the current monitor's store now
});
el('swDebugLog').addEventListener('change',e=>{
  settings.debugLog=e.target.checked; save();
  if(settings.debugLog){ Dbg.clear(); Dbg.log('INIT','debug logging enabled'); }
  else Dbg.clear();
});
const btnCopyDbg = el('btnCopyDbg');
if(btnCopyDbg) btnCopyDbg.addEventListener('click', () => Dbg.copyDump());`);

// 9. relocation hot pass: event + section-total ratchet alert
patch('RELOC hot',
  `  updateChapterNav();
  const chTitle = refreshChapterTitle(loc);`,
  `  updateChapterNav();
  const chTitle = refreshChapterTitle(loc);
  Dbg.log('RELOC', 'hot', { idx: loc.start.index, page: d ? d.page : null, total: d ? d.total : null, frac: +frac.toFixed(4) });
  if(d && d.total){
    const lastT = Dbg._totals.get(loc.start.index);
    if(lastT !== undefined && lastT !== d.total) Dbg.log('RELOC.TOTAL', 'displayed total changed', { idx: loc.start.index, from: lastT, to: d.total });
    Dbg._totals.set(loc.start.index, d.total);
  }`);

// 10. cold pass: event + leaf gate decisions + viewer toggle
patch('cold pass event',
  `function onRelocatedCold(loc, frac, chTitle, d){
  markTocCurrent(loc.start.href, loc.start.cfi);
  StoreKV.set(state.posKey, loc.start.cfi);`,
  `function onRelocatedCold(loc, frac, chTitle, d){
  markTocCurrent(loc.start.href, loc.start.cfi);
  StoreKV.set(state.posKey, loc.start.cfi);
  Dbg.log('RELOC', 'cold', { idx: loc.start.index, page: d ? d.page : null, total: d ? d.total : null });`);

patch('leaf gate log',
  `    const vEl0 = el('viewer');
    if(vEl0) vEl0.classList.toggle('folio-first-leaf', vLeaf);`,
  `    const vEl0 = el('viewer');
    if(vEl0) vEl0.classList.toggle('folio-first-leaf', vLeaf);
    Dbg.log('LEAF', 'gate', { want: vLeaf, idx: loc.start.index, total: d ? d.total : null, spread: !!state.spreadOn });
    if(vLeaf !== vEl0.classList.contains('folio-first-leaf')) Dbg.log('LEAF', 'viewer class mismatch after gate', { want: vLeaf });`);

// 11. onContent early class + shot
patch('leaf early log',
  `    if(siL === 0 && state.spreadOn && d.documentElement){
      d.documentElement.classList.add('folio-first-leaf');
      // the viewer's paper background must yield in the same frame the doc's
      // canvas turns transparent, or the left half flashes paper
      const vEl = el('viewer');
      if(vEl) vEl.classList.add('folio-first-leaf');
    }`,
  `    if(siL === 0 && state.spreadOn && d.documentElement){
      d.documentElement.classList.add('folio-first-leaf');
      // the viewer's paper background must yield in the same frame the doc's
      // canvas turns transparent, or the left half flashes paper
      const vEl = el('viewer');
      if(vEl) vEl.classList.add('folio-first-leaf');
      Dbg.log('LEAF', 'early class (pre-paint)', { si: siL });
      Dbg.shot('leaf-early');
    }`);

// 12. captureNow cache write
patch('CACHE capture',
  `      const si = (contents && typeof contents.sectionIndex === 'number') ? contents.sectionIndex : undefined;
      if(typeof pageCache !== 'undefined') pageCache.setChapterHtml(cleanHtml, si);`,
  `      const si = (contents && typeof contents.sectionIndex === 'number') ? contents.sectionIndex : undefined;
      if(typeof pageCache !== 'undefined') pageCache.setChapterHtml(cleanHtml, si);
      Dbg.log('CACHE', 'capture', { si, bytes: cleanHtml.length, hasLeaf: cleanHtml.includes('folio-first-leaf') });`);

// 13. preload cache write + warm frame
patch('CACHE preload',
  `              const cleanHtml = '<!DOCTYPE html>' + sanitizeChapterHtml(sectionDoc.documentElement.outerHTML);
              this.chapterHtmls.set(spineIndex, cleanHtml);
              // Feature 6: pre-render the neighbor chapter off-screen — fonts,
              // CSS and column layout warm before the reader ever crosses.
              this.warmFrame(spineIndex, cleanHtml);`,
  `              const cleanHtml = '<!DOCTYPE html>' + sanitizeChapterHtml(sectionDoc.documentElement.outerHTML);
              this.chapterHtmls.set(spineIndex, cleanHtml);
              // Feature 6: pre-render the neighbor chapter off-screen — fonts,
              // CSS and column layout warm before the reader ever crosses.
              this.warmFrame(spineIndex, cleanHtml);
              Dbg.log('CACHE', 'preload (OVERWRITES capture)', { si: spineIndex, bytes: cleanHtml.length, hasLeaf: cleanHtml.includes('folio-first-leaf') });`);

// 14. buildCSS bake
patch('CSS bake',
  `  if(hash === _cssHash) return _cssCache;
  _cssHash = hash;`,
  `  if(hash === _cssHash) return _cssCache;
  _cssHash = hash;
  Dbg.log('CSS', 'bake', { slot: state.spreadOn ? Math.round(((el('viewer')||{getBoundingClientRect:()=>({width:0})}).getBoundingClientRect().width) / 2) : 0, spread: !!state.spreadOn });`);

// 15. recreateRendition
patch('GEO recreate',
  `async function recreateRendition(){`,
  `async function recreateRendition(){
  Dbg.log('GEO', 'recreate', { spread: !!state.spreadOn, mw: effWidth(), inner: innerWidth + 'x' + innerHeight });`);

//  16. rail seek
patch('RAIL seek',
  `function railSeekCommit(f){
  if(!state.rendition || !state.book) return;`,
  `function railSeekCommit(f){
  if(!state.rendition || !state.book) return;
  Dbg.log('RAIL', 'seek', { f: +f.toFixed(4), locsReady: LocEngine.ready() });`);

//  17. LocEngine attach + generation
patch('LOCS attach',
  `    try{
      state.book.locations._locations = d.locations.slice();
      state.book.locations.total = d.locations.length;
        this.data = d;
        return true;`,
  `    try{
      state.book.locations._locations = d.locations.slice();
      state.book.locations.total = d.locations.length;
      this.data = d;
      Dbg.log('LOCS', 'attach', { total: d.total, spineLen: d.spineLen });
      return true;`);

patch('LOCS gen',
  `            this.store(this.data);
            this.refreshUI();`,
  `            this.store(this.data);
            this.refreshUI();
            Dbg.log('LOCS', 'generated', { total: this.data.total });`);

//  18. leaf persistence
patch('LEAF persist',
  `  saveRecentBook(bTitle, bAuthor, Math.round(frac * 100), loc.start.cfi, state.currentFilePath, chLeft, chNext);`,
  `  Dbg.log('LEAF', 'persist', { chLeft, chNext: chNext ? chNext.slice(0, 24) : null, idx: loc.start.index });
  saveRecentBook(bTitle, bAuthor, Math.round(frac * 100), loc.start.cfi, state.currentFilePath, chLeft, chNext);`);

// 19. _flushRecentBook
patch('PERSIST flush',
  `function _flushRecentBook(){
  const p = _recentPending; if(!p) return; _recentPending = null;`,
  `function _flushRecentBook(){
  const p = _recentPending; if(!p) return; _recentPending = null;
  Dbg.log('PERSIST', 'flush', { title: p.title, pct: p.pct, chLeft: p.chLeft });`);

//  20. playTurnFx start/end
patch('SNAP start',
  `async function playTurnFx(dir, fx){
  const snapInfo = snapshotPage();`,
  `async function playTurnFx(dir, fx){
  const snapInfo = snapshotPage();
  Dbg.log('SNAP', 'start', { dir, fx, idx: snapInfo && snapInfo.spineIndex });
  Dbg.shot('flip-start');`);

// 21. populateSnap leaf bg
patch('SNAP bg',
  `  const leafBack = /<html[^>]*class="[^"]*folio-first-leaf/.test(html);
  const leafBg = leafBack ? 'transparent' : 'var(--page)';`,
  `  const leafBack = /<html[^>]*class="[^"]*folio-first-leaf/.test(html);
  const leafBg = leafBack ? 'transparent' : 'var(--page)';
  Dbg.log('SNAP', 'populate', { leafBack, bytes: html.length });`);

//  22. turn() pre-toggle
patch('LEAF pre-toggle',
  `    const vElT = el('viewer');
    if(vElT && leafTarget) vElT.classList.add('folio-first-leaf');
  }catch(e){}`,
  `    const vElT = el('viewer');
    if(vElT && leafTarget) vElT.classList.add('folio-first-leaf');
    Dbg.log('LEAF', 'pre-toggle', { leafTarget, curIdx, dir });
  }catch(e){}`);

//  23. state-reading (open done) — the openBuffer success path at 3360
patch('OPEN done',
  `    body.classList.add('state-reading');`,
  `    body.classList.add('state-reading');
    Dbg.log('OPEN', 'done', { title: getActiveTitle(), ms: performance.now() | 0 });
    Dbg.shot('open-done');`);

// 24. closeBook + totals reset
patch('closeBook',
  `async function closeBook(){
  flushRelocCold(); // last page turn's position must survive the close`,
  `async function closeBook(){
  Dbg.log('OPEN', 'close', { title: getActiveTitle() });
  Dbg._totals.clear();
  flushRelocCold(); // last page turn's position must survive the close`,
);

fs.writeFileSync(p, s);
console.log('applied patches:', applied);
