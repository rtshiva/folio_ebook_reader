// One-shot: rewire EPUB-derived storage call sites from localStorage to StoreKV.
// Every replacement asserts its anchor.
const fs = require('fs');
let s = fs.readFileSync('src/index.html', 'utf8');
let applied = 0;
function rep(from, to, count) {
  let n = 0;
  while (s.includes(from)) {
    s = s.replace(from, to);
    n++;
    if (count && n >= count) break;
  }
  if (n < (count || 1)) { console.log('MISS (' + n + '/' + (count || 1) + '): ' + from.slice(0, 90)); process.exit(1); }
  applied += n;
}

// --- per-book typography ---
rep("localStorage.setItem('folio-typo:'+state.currentTitle,JSON.stringify(o));",
    "StoreKV.set('typo:'+state.currentTitle, o);");
rep("const raw=localStorage.getItem('folio-typo:'+title);",
    "const raw=StoreKV.get('typo:'+title);");
rep("    const parsed = JSON.parse(raw);",
    "      const parsed = (typeof raw === 'string') ? JSON.parse(raw) : raw;");

// --- stats ---
rep("if(statsCache) { try{ localStorage.setItem('folio-stats', JSON.stringify(statsCache)); }catch(e){} }",
    "if(statsCache) StoreKV.set('stats', statsCache);", 2);
rep("try{ statsCache = Object.assign({ min: 0, pages: 0, days: {} }, JSON.parse(localStorage.getItem('folio-stats') || '{}')); }",
    "try{ statsCache = Object.assign({ min: 0, pages: 0, days: {} }, StoreKV.get('stats') || {}); }");

// --- per-book stats (bstat) ---
rep("try{ localStorage.setItem('folio-bstat:'+bookStatTitle, JSON.stringify(bookStat)); }catch(e){}",
    "StoreKV.set('bstat:'+bookStatTitle, bookStat);", 2);
rep("try{ bookStat = Object.assign({ min: 0, days: {} }, JSON.parse(localStorage.getItem('folio-bstat:' + bookStatTitle) || '{}')); }",
    "try{ bookStat = StoreKV.get('bstat:' + bookStatTitle) || { min: 0, days: {} }; }");
rep("try{ bs = JSON.parse(localStorage.getItem('folio-bstat:' + t) || 'null'); }catch(e){ bs = null; }",
    "try{ bs = StoreKV.get('bstat:' + t) || null; }catch(e){ bs = null; }");

// --- reading positions: posKey prefix + raw string cfi + ctx JSON + fp ---
rep("state.posKey = 'folio-pos:'+initialTitle;", "state.posKey = 'pos:'+initialTitle;");
rep("state.posKey = 'folio-pos:'+realTitle;", "state.posKey = 'pos:'+realTitle;");
rep("try{ const saved=localStorage.getItem(state.posKey); if(saved) target=saved; }catch(e){}",
    "try{ const saved=StoreKV.get(state.posKey); if(saved) target=saved; }catch(e){}");
rep("const ctx = JSON.parse(localStorage.getItem(state.posKey + ':ctx') || 'null');",
    "const ctx = StoreKV.get(state.posKey + ':ctx') || null;");
rep("try{ localStorage.setItem(state.posKey, loc.start.cfi); }catch(e){}",
    "StoreKV.set(state.posKey, loc.start.cfi);");
rep("localStorage.setItem(state.posKey + ':ctx', JSON.stringify({",
    "StoreKV.set(state.posKey + ':ctx', {");
rep("if(fp.length >= 20) localStorage.setItem(state.posKey + ':fp', fp);",
    "if(fp.length >= 20) StoreKV.set(state.posKey + ':fp', fp);");
rep("else localStorage.removeItem(state.posKey + ':fp');",
    "else StoreKV.del(state.posKey + ':fp');");
rep("const fp = localStorage.getItem(state.posKey + ':fp');",
    "const fp = StoreKV.get(state.posKey + ':fp');");

// --- bookmarks ---
rep("try{ const r = JSON.parse(localStorage.getItem('folio-bookmarks')||'[]'); return Array.isArray(r) ? r : []; }catch(e){ return []; }",
    "try{ const r = StoreKV.get('bookmarks'); return Array.isArray(r) ? r : []; }catch(e){ return []; }");
rep("try{ localStorage.setItem('folio-bookmarks', JSON.stringify(allList)); }catch(e){}",
    "StoreKV.set('bookmarks', allList);");

// --- highlights ---
rep("try{ const r = JSON.parse(localStorage.getItem('folio-highlights')||'[]'); return Array.isArray(r) ? r : []; }catch(e){ return []; }",
    "try{ const r = StoreKV.get('highlights'); return Array.isArray(r) ? r : []; }catch(e){ return []; }");
rep("try{ localStorage.setItem('folio-highlights', JSON.stringify(list)); }catch(e){}",
    "StoreKV.set('highlights', list);");

// --- vocab ---
rep("key(){ return 'folio-vocab:' + (state.currentTitle || ''); },",
    "key(){ return 'vocab:' + (state.currentTitle || ''); },");
rep("try{ return JSON.parse(localStorage.getItem('folio-vocab:' + title) || '[]').length; }",
    "try{ const v = StoreKV.get('vocab:' + title); return Array.isArray(v) ? v.length : 0; }");
rep("try{ vocab = JSON.parse(localStorage.getItem('folio-vocab:' + title) || '[]'); }catch(e){}",
    "try{ vocab = StoreKV.get('vocab:' + title) || []; }catch(e){}", 2);

fs.writeFileSync('src/index.html', s);
console.log('call sites rewired:', applied);
