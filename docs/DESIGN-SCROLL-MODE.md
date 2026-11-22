# DESIGN — Scoped Scroll Mode (chapter-bounded glide)

Status: **PROPOSED 2026-11-22 — awaiting approval. No code written.**
Scope decision from the user: implement after the jump-back / shelf-legibility batch;
the Rust-side pagination service (P2.5) stays queued behind this.

## 1. Goal

A reading mode where wheel / drag / trackpad input **glides** through the current
chapter's pages as one continuous motion, snapping to a page when the gesture
ends — instead of one discrete fold-flip per wheel notch. Chapter boundaries stay
paginated (auto-advance at the end, exactly one boundary event). This delivers the
"continuous scroll" feel readers ask for without forking epub.js or the turn engine.

## 2. Engine analysis (why this is feasible)

The app runs epub.js `manager:'default'` (index.html:3501): **one view per
chapter**, the chapter body is paginated into CSS columns inside that single
iframe, and "page N of M" is a column offset (`loc.start.displayed.page/total`).
Adjacent pages therefore already exist as laid-out columns in the live iframe —
gliding is an interpolation of the column offset, not a new rendering pipeline.

What already exists and will be reused:

| Existing piece | Role in scroll mode |
|---|---|
| `turn(dir)` (9192) | stays the boundary primitive (chapter advance, keyboard) |
| `railSeek` + `railDeparture` (13203) | arbitrary-offset positioning already works; glide is a smooth version of it |
| `nextRelocated` (registered BEFORE display) | boundary relocations keep the hot/cold reloc contract |
| Neighbor-chapter pre-render (X7 warm frames) | boundary advance stays pre-warmed |
| `AutoScroll` (middle-click) | becomes the native consumer of the glide controller |
| reduced-motion contract (F11) | scroll mode degrades to snap-only (no momentum) |

## 3. UX spec

- **Setting**: `settings.scroll = 'off' | 'on'` (default `off` for this release),
  toggle in the Typography sheet next to spread; per-book preference memory
  follows the existing `perBookType` path.
- **Wheel / trackpad**: accumulated delta drives a velocity; rAF loop glides the
  column offset; when input stops, damped settle to the nearest page (existing
  damped-spring constants reused for feel parity with the fold drag).
- **Drag**: pointer drag pans the offset directly (paper follows the finger);
  release velocity decides forward/backward snap. The fold compositor is **not**
  engaged in scroll mode — the page simply translates (crossfade only at
  chapter boundaries).
- **Keyboard**: `←`/`→`/`Space` still snap one page (same as today, no fold FX in
  scroll mode — or fold FX if it proves cheap; decide at implementation).
- **Chapter boundary**: at the last page, continued input auto-advances to the
  next chapter (one `display()` + relocation, paginated boundary), and vice versa.
  No cross-chapter glide.
- **Spread mode**: allowed; one glide step = one spread (2-column seat), matching
  the existing spread=2-column steps invariant.
- **Ornaments / corner art / EdgeStacks / page-anchored chrome**: update at
  **snap only**, driven by the same snap event that fires the relocation. During
  motion they freeze (they are page-anchored by design; per-frame updates would
  thrash — see gotcha #21 on paint-only transforms and overlay ratchet).
- **Reading strip / timeLeft / pos pill**: updated at snap (relocated-derived).
- **RELOC events**: `nextRelocated` / relocated handlers fire **only at snaps**.
  Gliding must not emit relocations per frame (RELOC drives the page cache,
  stats, chapter nav — gotcha: relocated events carry pre-pagination locs).
- **TTS**: sentence advance at page end uses the boundary primitive (one snap
  per page), so read-aloud pacing is unchanged.
- **Reduced motion**: no momentum; wheel maps to one-page snaps.

## 4. Implementation sketch

1. `Glide` controller (~150 lines, modeled on the EdgeStacks/snap discipline):
   state `{offsetPx, target, velocity, raf}`, input hooks swapped in when
   `settings.scroll === 'on'` (wheel branch at 9081-9092 gets a Glide path
   before `turn()`), pointer drag hooks beside the existing drag physics.
2. Offset application: **paint-only transform on the view root** (gotcha #21 —
   never touch layout-affecting properties; the paginated iframe is already
   overflow-windowed). Gliding between page N and N+1 = translateX between the
   two column offsets; page margins keep riding the epub gap (side inset =
   gap/2 invariant holds — the offset math must use the *seated* page width,
   not `effWidth()`).
3. Snap: pick nearest offset, damped spring, on settle → the normal turn/seek
   commit path (same one `railSeek` uses) so page cache, RELOC, stats all see
   exactly one canonical event per snap.
4. Chapter boundary: at `displayed.page >= total` with residual velocity →
   `turn(1)` (chapter advance through the existing guarded path); else stop.
5. Settings plumbing: sheet toggle (`swScroll`), per-book memory, e2e seed.

## 5. Risks / known gotchas

- **#21 inline `!important` body styles from epub.js** beat stylesheet
  `!important` — offset transforms must ride the same paint-only transform
  channel the shift-pages mechanism uses, or scrollWidth inflation breaks seats.
- **#22 canvas propagation**: the gliding transform must not re-trigger the
  iframe canvas repaint; same no-op-gradient contract as the opening leaf.
- **Ornament overlay ratchet**: overlay boxes must stay clamped/zero-size
  during motion (Nov 1 regression class) — they freeze at snap, which also
  protects this.
- **D11-class flakiness**: glide tests must drive deterministic settle (the
  harness sets velocity directly, not wheel notches).
- **`content-visibility` idea stays skipped** (roadmap P0.5) — unrelated but
  tempting; pagination-correctness risk unchanged.

## 6. Test plan

`scrollmode.spec.mjs`: SC1 wheel glide settles at next page (badge changes,
one relocated event), SC2 drag velocity direction decides snap, SC3 boundary
auto-advance fires exactly one relocation, SC4 reduced-motion = snap-only,
SC5 spread mode glides by spread, SC6 ornaments/strip update only at snap,
SC7 setting round-trips per-book. Debug ring: `GLIDE` tag (start/snap/boundary).

## 7. Effort estimate

Controller + wiring ≈ 1 focused batch (~300-400 lines incl. spec), no Rust
changes, no epub.js fork. Biggest uncertainty: drag-parallel with the existing
pointer machinery (re-entrancy guard must distinguish fold-drag from glide-drag).

---

# Appendix — Rust-side pagination service (P2.5) — design sketch, deferred

The roadmap's biggest ceiling: move pagination out of WebView2 entirely. Sketch
of the shape it must take, recorded now so the scroll-mode work doesn't paint us
into a corner:

1. **Who lays out?** Rust cannot measure styled text without a text shaper +
   font stack (rustybuzz + fontdb, essentially a mini layout engine). The
   realistic v1: Rust computes **approximate page boundaries** (character ranges)
   from cached chapter text using the same metrics the `LocEngine` grid uses,
   then WebView2 **verifies/corrects** them lazily per page during normal
   rendering (epub.js stays the source of truth for CFIs; Rust only predicts).
2. **What it buys**: instant first paint of "page N of M" for every chapter
   (no `locations.generate()`), instant rail seek targets, and the data
   foundation for true continuous scroll later.
3. **What it must not do**: feed wrong CFI boundaries into bookmarks/highlights
   — predictions are hints, never persisted as CFIs until epub.js confirms.
4. **Sequencing**: the scroll-mode offset math (Section 4.2) should be written
   against an injectable "page geometry provider" so P2.5 can slot in later
   without a second rework.

Open question for P2.5 (for a future pass): whether the verification pass can be
batched during idle warm frames rather than on demand.
