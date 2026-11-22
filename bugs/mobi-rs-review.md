# Code review — `src-tauri/src/mobi.rs` (MOBI/AZW3 parser)

> Read-only review of the full file (2,049 lines incl. test module), Nov 12 2026.
> Offsets cross-checked against KindleUnpack `mobi_header.py` and the MobileRead
> wiki (they agree). **No code was changed.**
>
> A second, independent review of this same file exists at
> [`bugs_found.md`](bugs_found.md) — it corroborates H1/H3/M3/L3 and adds
> further findings (EXTH UTF-8 decoding, `src = ` whitespace handling,
> `sanitize_html_tag` gaps). Its #2 cites the trailing-flags field as
> rec0 `0xF0`/`mobi[224]` (MobileRead 4-byte field) while this file uses the
> KindleUnpack u16 at rec0 `0xF2`/`mobi[226]`; both agree `mobi[242]` is wrong.

**Offset convention:** the file slices `mobi = &rec0[16..]` (after the `MOBI`
magic). The authoritative MOBI header layout is **record-0-relative**:

| Field | rec0 offset | `mobi[]`-relative |
|---|---|---|
| First Non-book index | `0x50` (80) | 64 |
| Full Name offset / len | `0x54` / `0x58` (84 / 88) | 68 / 72 |
| Input / Output Language | `0x60` / `0x64` | 80 / 84 |
| Min Version | `0x68` (104) | 88 |
| First Image index | `0x6C` (108) | 92 |
| EXTH flags | `0x80` (128) | 112 |
| Trailing-entry flags | `0xF2` (242) | 226 |

---

## High

### H1. Four MOBI header fields read from wrong offsets — EXTH never parsed, title falls back to the 31-byte PDB name
**Lines:** 168–172, 174–178, 180–190, 192–196 (use: 280, 638, 695–700)

```rust
168: let first_image_index = ...  u32::from_be_bytes([mobi[64..68]])   // actually First Non-book
174: let exth_flags       = ...  u32::from_be_bytes([mobi[80..84]])   // actually Input Language
180: let title_offset     = ...  u32::from_be_bytes([mobi[84..88]])   // actually Output Language
186: let title_len        = ...  u32::from_be_bytes([mobi[88..92]])   // actually Min Version
192: let first_non_book_index = ... u32::from_be_bytes([mobi[112..116]]) // actually EXTH flags
```

All four read the wrong words. Because `exth_flags` is really Input Language
(0 for normal books), the `exth_flags & 0x40` test at line 280 **never fires**,
so the EXTH header is never parsed: author, publisher, description, ISBN,
language, updated-title, and cover offset are silently never extracted. The
title silently falls back to the truncated 31-byte PDB name (line 638). No
error, no panic — pure wrong output. **The unit tests pass only because
`lib.rs:1913–1915` writes the synthetic fixture with these same wrong offsets**
(see "Test-fixture note" below).

### H2. KF8 boundary read from the wrong field — AZW3 / hybrid detection is dead code
**Lines:** 204–213 (read), 609–627 (use)

```rust
205: let val = u32::from_be_bytes([mobi[192], mobi[193], mobi[194], mobi[195]]);
```

`mobi[192..196]` = rec0[208..212] — the **FLIS record offset** field (`0xD0`)
in both the mobi6 and mobi8 header tables, not the KF8 Boundary Offset. Since
that value points at a FLIS record, the `b_rec.starts_with(b"BOUNDARY")` check
(line 612) never matches. Real KF8 boundary is EXTH record 121
(`Mobi8-Boundary-Section`) or a `BOUNDARY` record scan. Effect: hybrid .mobi
files silently decode their KF7 half (works by accident); pure AZW3 files get
parsed as MOBI7 — compounding H3 into text-decode failures/garbage.

### H3. Trailing-entry flags read from wrong offset *and* gated wrong — trailing bytes not stripped on real v5/v6 records
**Lines:** 198–202 (read/use: 650, PalmDOC decode errors)

```rust
198: let extra_flags = if mobi.len() >= 244 && header_len >= 244 {
199:     u16::from_be_bytes([mobi[242], mobi[243]])
```

Two independent errors:

1. **Wrong offset:** the field lives at rec0[242..244] = `mobi[226..228]`
   (KindleUnpack: `unpack_from('>H', header, 0xF2)`). The code reads
   `mobi[242..244]` = rec0[258..260] — 16 bytes past the field, i.e. garbage
   from the header tail.
2. **Wrong gate:** should be `header_len >= 228 (0xE4)` plus a
   `file_version >= 5` check. Requiring `header_len >= 244` excludes the
   ubiquitous 232-byte (0xE8) headers — every kindlegen hybrid KF7 part and
   every v5/v6 file.

Result: `extra_flags = 0` → `strip_trailing_entries` (650) strips nothing →
multibyte-overlap / TBS bytes stay in the stream →
`decompress_palmdoc_capped` errors (`"Unexpected EOF in literal run"`,
`"Invalid backreference distance"`) or garbage text. AZW3 and kindlegen hybrid
books fail to open with a confusing message.

### H4. Garbage `first_non_book_index` truncates the image scan silently
**Lines:** 192–196 (source), 695–700 (use), 703 (loop bound)

Per H1, `first_non_book_index` is really the EXTH-flags word — typically
`0x40` (64), `0x41`, or larger bit combinations. When that value exceeds
`first_image_index` (books whose image records start early), `max_img`
becomes the *flag value* and the extraction loop at line 703 stops at record
~64 instead of the end of the image run. Image-heavy books silently lose
images. Wrong output, no diagnostic.

---

## Medium

### M1. Unbounded `find_tag_end` after the bounded close-tag search → O(n²) CPU DoS
**Lines:** 1670–1676 (`<script`), 1719–1723 (`<iframe`/`<object`/`<embed`)

```rust
1671: if let Some(close_idx) = ci_find(&text[i..win_end], "</script") {
1672:     if let Some(end_gt) = find_tag_end(&text[i + close_idx..]) {
```

The 893e8e3 fix bounded `ci_find` to a 64 KB window (the comment at 1665–1669
documents exactly this DoS class), but the subsequent
`find_tag_end(&text[i + close_idx..])` scans to the **end of the whole
remaining text** (up to the 256 MB budget) for a `>`, with no window. A
document stuffed with `</script` / `</iframe` sequences and no `>` after them
makes every tag trigger a full linear scan of the remainder → O(n²); a few-MB
.mobi expanding to the cap effectively hangs `book_open`. The bounded variant
`find_tag_end_bounded` already exists and is used at 1678 — these two call
sites are the remaining siblings of that fix.

### M2. `filepos` byte offsets invalidated by the encoding conversion — anchors/links land at wrong positions
**Lines:** 683–687 (conversion) vs 1205–1234 (`collect_filepos_targets`) / 1388–1435 (anchor insert)

```rust
683: let html_text = if active_mobi_hdr.encoding == 1252 {
684:     cp1252_to_utf8(&uncompressed_text_bytes)
```

`filepos="N"` values are byte offsets into the **original uncompressed record
bytes**. `cp1252_to_utf8` expands each 0x80–0x9F byte to 2–3 UTF-8 bytes, and
`from_utf8_lossy` inserts replacement chars, so every byte offset after the
first converted byte shifts. The anchor insertion (1420–1434) applies the raw
numeric offsets directly to the converted string. For cp1252 books, every
internal link and TOC target after the first non-ASCII character points at the
wrong location (mid-word, wrong chapter, or clamped to chapter end at 1422).
UTF-8 (65001) books are 1:1 and unaffected.

### M3. `recindex` mapping drifts when an image record is unrecognized; cover heuristic compounds it
**Lines:** 703–733 (mapping), 711–717, 782–786 (cover)

```rust
711: let rel_1 = (rec_idx - first_img) + 1;
```

Per spec, `recindex="N"` addresses record `first_image_index + N − 1` by
**record number**. The map is built by enumerating records and only inserting
ones whose magic matches `detect_image_format`; a gap record (unrecognized
image format, audio/font record) is skipped **without reserving its slot**, so
all subsequent recindexes shift by one and the wrong images display from that
point on. Likewise, EXTH 201 `coveroffset` is defined relative to the first
image record, but lines 782–786 match it against the *extracted-image*
enumeration index (`idx == cov_off || idx + 1 == cov_off`), which diverges
whenever gaps exist. (Note: EXTH is currently never parsed at all per H1, so
the cover path is doubly dead.)

### M4. Peak memory ~4–6× the 256 MB text budget from a small crafted file
**Lines:** 646, 658/668, 683–687, 988–1030, 1414–1443

The 256 MB decompression cap itself is sound, but the pipeline then holds
simultaneously: `uncompressed_text_bytes` (≤256 MB), the `html_text` conversion
copy, `rewritten_html`, per-chapter `body_str` clones, and the
`prefix_cross_chapter_links` / `String::with_capacity(html.len() + 1024)`
outputs. A ~2 MB .mobi expanding to the cap transiently commits well over
1 GB in the desktop process. Bounded (not an uncontrolled bomb), but worth
streamlining given concurrent book opens (see lib-rs-review M-4).

### M5. Bare `&` / malformed entities survive to disk; correctness depends on serve-time repair
**Lines:** 1773–1775 (`clean_chapter_body`), 1025 (`rewrite_images_and_links`)

```rust
1774: let next_tag = text[nb..].find('<').map(|p| nb + p).unwrap_or(text.len());
1775: out.push_str(&text[i..next_tag]);
```

`clean_chapter_body` escapes stray `<` (the fix9 change) but copies raw text
ranges containing bare `&`, `&foobar;`, `&#;` etc. into the XHTML, which is
invalid XML. Chapters are written to disk un-repaired; validity currently
depends entirely on `lib.rs::xml_response_body` / `fix_entities`
(lib.rs:1000–1009) repairing at serve time. Any future consumer reading the
cached files directly hits a fatal XML parse error and a blank chapter — this
is the surviving sibling of the fix9 `<` escape. `escape_xml` (529–542) covers
only titles/OPF fields.

---

## Low

### L1. Theoretical overflow on 32-bit targets
**Lines:** 281–282, 297, 316 — `exth_start = 16usize.saturating_add(header_len)`
can reach ~2³² on 32-bit `usize`; `exth_start + 12` (282) and `curr + r_len`
(316) then wrap and can pass their bounds checks → slice panic. Unreachable on
the shipped 64-bit Windows target; all other arithmetic (line 53
`78 + num_records * 8`, 645, 1422) is safe even on 32-bit.

### L2. `uncompressed_len` and `record_count` never validated
**Lines:** 122–123 (parse), 641–680 (use) — the decoded total is never
cross-checked against the PalmDOC header's `uncompressed_len` (122), so
truncated/corrupt text passes with no diagnostic. A bogus `record_count`
silently truncates via `text_end = (text_start + record_count).min(len)` (645)
or pulls in trailing non-text records. Wrong output undetected; no panic.

### L3. `cp1252_to_utf8` maps undefined cp1252 bytes via `b as char`
**Lines:** 492–526 — bytes 0x81, 0x8D, 0x8F, 0x90, 0x9D are undefined in
cp1252 but fall through to the `_ => b as char` arm (523), producing U+0081
etc. control codepoints instead of U+FFFD. Cosmetic mojibake.

### L4. Non-1252/65001 encodings silently decoded as UTF-8
**Lines:** 268, 683 — any encoding other than 65001 (e.g. cp1250) is decoded
with UTF-8 lossy semantics, producing mojibake with no warning.

### L5. `escape_xml` passes XML-invalid control characters through
**Lines:** 529–542 — a title/author containing 0x00–0x08/0x0B/0x0C (reachable
from arbitrary rec0 bytes via lossy conversion) yields a `content.opf` /
`toc.ncx` that is invalid XML and fails to parse downstream. `fix_entities`
repairs entities but not raw control chars.

### L6. `in_recindex` is set and never reset
**Lines:** 1096–1129 — in `rewrite_img_tag`'s removal loop, `in_recindex = true`
(1104) is never cleared, so a second `recindex="..."` attribute in the same tag
is copied verbatim instead of removed.

### L7. Substring search matches inside attribute values
**Lines:** 1042–1043, 1058–1059, 1076–1077, 1169–1170 —
`lower.find("recindex=")` / `"kindle:embed:"` / `"src="` / `"filepos="` match
inside other attribute values (e.g. `alt="my recindex=2 shot"`), triggering
rewrites on value text and corrupting the tag.

### L8. `decompress_palmdoc` exports an uncapped public wrapper
**Lines:** 433–435 — `decompress_palmdoc_capped(data, usize::MAX)`. Currently
only tests use it, but any future production caller silently bypasses the
decompression-bomb budget. API footgun, not an active bug.

### L9. EXTH length not rounded to a 4-byte boundary
**Lines:** 296–371 — KindleUnpack rounds EXTH length up (`((len+3)>>2)<<2`);
this code uses the raw `exth_len`. Harmless conformance drift (pad bytes are
never reached because the record loop is bounded by `exth_end`).

### L10. HUFF/CDIC rejected outright (by design)
**Lines:** 670–675 — no HUFF/CDIC table-bounds bugs exist, but many older
kindlegen AZW files use compression 17480 and get a hard error. Honest failure
mode; a functional limitation rather than a defect.

---

## Panic audit (completeness check for the 97fed4e non-ASCII panic fix)

The fix is **complete for panics on 64-bit targets**. Verified safe:

- **PalmDOC overlapping back-reference copy (474–478):**
  `let byte = out[start + k]; out.push(byte);` — the index is always
  `< current len` (`start + k = L − distance + k < L + k`, push grows the vec
  each iteration), and `distance == 0 || distance > out.len()` (467) rejects
  bad refs. No panic, correct LZ77 semantics.
- All byte-offset header reads (`mobi[64..]`, `mobi[242..]`, EXTH at
  282/297/300–320, title at 260–267, trailing multibyte at 411–413, PDB table
  at 61–91) are bounds-checked or clamped — reading garbage fields (H1–H3),
  but never panicking.
- Every HTML scanner advances via `next_boundary`, ASCII-anchored finds, or
  `to_ascii_lowercase` (length-preserving); no offset drift; tag scans
  windowed except the two M1 call sites.
- The PalmDOC `while i < data.len()` loop always advances (literal runs
  checked at 451, backrefs consume 2 bytes, every token ≥ 1 byte) — no
  infinite loop. Termination of `get_size_of_trailing_data_entry` (386–394),
  the `sanitize_html_tag` attribute loop (1524–1600), and all rewrite loops
  verified.

What remains broken is not panic-shaped: the wrong-offset family (H1–H4), the
two unbounded `find_tag_end` calls (M1), and the silent wrong-output issues.

---

## Test-fixture note

`lib.rs:1913–1915` writes the synthetic MOBI fixture with the **same wrong
offsets** the parser reads (`mobi_hdr[64..68]` = first-image-index "2",
`mobi_hdr[80..84]` = EXTH flag `0x40`, `mobi_hdr[112..116]` = first-non-book "3").
The tests are self-consistent but **not spec-conformant** — a spec-correct
fixture (fields at rec0-relative `0x54/0x58/0x6C/0x80`, trail flags at `0xF2`)
would fail immediately. This is why the previous 61-finding hunt (893e8e3)
never surfaced H1–H4: the tests validate the parser against itself.

## Suggested priorities

1. **H1 + H3** — real-world MOBI/AZW3 books mis-parse (EXTH, title, trailing bytes)
2. **H2** — AZW3 files decode as MOBI7
3. **M1** — unbounded scan is the direct sibling of the DoS fixed in 893e8e3
4. **M2** — cp1252 filepos anchors land wrong
5. Fix `lib.rs` test fixture **after** the offsets, so the tests validate against the spec
