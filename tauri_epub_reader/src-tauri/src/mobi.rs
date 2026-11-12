//! MOBI / AZW / AZW3 unpacker and EPUB converter for Folio Reader.
//!
//! Converts DRM-free Mobipocket (MOBI 6/7) and Kindle Format 8 (KF8/AZW3)
//! files into standard OEBPS / XHTML packages stored in the Folio cache directory,
//! allowing `epub.js` to render them seamlessly with zero frontend overhead.

use crate::{BookManifest, ManifestFile};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::Path;
use std::time::SystemTime;

/// Represents a single Palm Database record slice.
#[derive(Debug, Clone)]
pub struct PdbRecord<'a> {
    pub offset: usize,
    pub attributes: u8,
    pub unique_id: u32,
    pub data: &'a [u8],
}

/// In-memory representation of a Palm Database (.pdb / .prc / .mobi).
pub struct PalmDatabase<'a> {
    pub name: String,
    pub attributes: u16,
    pub version: u16,
    pub db_type: [u8; 4],
    pub creator: [u8; 4],
    pub records: Vec<PdbRecord<'a>>,
}

impl<'a> PalmDatabase<'a> {
    pub fn parse(data: &'a [u8]) -> Result<Self, String> {
        if data.len() < 78 {
            return Err("File too small to be a valid Palm Database (header < 78 bytes)".to_string());
        }

        // PDB Name (bytes 0..32, null-padded ASCII)
        let name_bytes = &data[0..32];
        let name_end = name_bytes.iter().position(|&b| b == 0).unwrap_or(32);
        let name = String::from_utf8_lossy(&name_bytes[..name_end]).trim().to_string();

        let attributes = u16::from_be_bytes([data[32], data[33]]);
        let version = u16::from_be_bytes([data[34], data[35]]);

        let mut db_type = [0u8; 4];
        db_type.copy_from_slice(&data[60..64]);

        let mut creator = [0u8; 4];
        creator.copy_from_slice(&data[64..68]);

        let num_records = u16::from_be_bytes([data[76], data[77]]) as usize;
        let record_list_end = 78 + num_records * 8;
        if data.len() < record_list_end {
            return Err("Unexpected EOF reading Palm Database record list".to_string());
        }

        // Parse record info list
        let mut raw_records = Vec::with_capacity(num_records);
        for i in 0..num_records {
            let offset_pos = 78 + i * 8;
            let offset = u32::from_be_bytes([
                data[offset_pos],
                data[offset_pos + 1],
                data[offset_pos + 2],
                data[offset_pos + 3],
            ]) as usize;
            let attributes = data[offset_pos + 4];
            let unique_id = ((data[offset_pos + 5] as u32) << 16)
                | ((data[offset_pos + 6] as u32) << 8)
                | (data[offset_pos + 7] as u32);
            raw_records.push((offset, attributes, unique_id));
        }

        let mut records = Vec::with_capacity(num_records);
        for i in 0..num_records {
            let (offset, attributes, unique_id) = raw_records[i];
            if offset > data.len() {
                return Err(format!("Record {} offset {} exceeds file size", i, offset));
            }
            let next_offset = if i + 1 < num_records {
                raw_records[i + 1].0.min(data.len())
            } else {
                data.len()
            };
            let end = next_offset.max(offset);
            records.push(PdbRecord {
                offset,
                attributes,
                unique_id,
                data: &data[offset..end],
            });
        }

        Ok(PalmDatabase {
            name,
            attributes,
            version,
            db_type,
            creator,
            records,
        })
    }
}

/// PalmDOC Header metadata.
#[derive(Debug, Clone)]
pub struct PalmDocHeader {
    pub compression: u16,
    pub uncompressed_len: u32,
    pub record_count: usize,
    pub record_size: u16,
    pub encryption_type: u16,
}

impl PalmDocHeader {
    pub fn parse(data: &[u8]) -> Result<Self, String> {
        if data.len() < 16 {
            return Err("Record 0 is too short for a PalmDOC header (< 16 bytes)".to_string());
        }
        let compression = u16::from_be_bytes([data[0], data[1]]);
        let uncompressed_len = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);
        let record_count = u16::from_be_bytes([data[8], data[9]]) as usize;
        let record_size = u16::from_be_bytes([data[10], data[11]]);
        let encryption_type = u16::from_be_bytes([data[14], data[15]]);

        Ok(PalmDocHeader {
            compression,
            uncompressed_len,
            record_count,
            record_size,
            encryption_type,
        })
    }
}

/// MOBI Header metadata.
#[derive(Debug, Clone, Default)]
pub struct MobiHeader {
    pub header_len: usize,
    pub mobi_type: u32,
    pub encoding: u32,
    pub unique_id: u32,
    pub file_version: u32,
    pub first_image_index: usize,
    pub first_non_book_index: usize,
    pub exth_flags: u32,
    pub title_offset: usize,
    pub title_len: usize,
    pub extra_flags: u16,
    pub kf8_boundary_offset: Option<usize>,
}

impl MobiHeader {
    pub fn parse(data: &[u8]) -> Result<Option<Self>, String> {
        // MOBI header starts at offset 16 in Record 0
        if data.len() < 40 || &data[16..20] != b"MOBI" {
            return Ok(None);
        }

        let mobi = &data[16..];
        let header_len = u32::from_be_bytes([mobi[4], mobi[5], mobi[6], mobi[7]]) as usize;
        let mobi_type = u32::from_be_bytes([mobi[8], mobi[9], mobi[10], mobi[11]]);
        let encoding = u32::from_be_bytes([mobi[12], mobi[13], mobi[14], mobi[15]]);
        let unique_id = u32::from_be_bytes([mobi[16], mobi[17], mobi[18], mobi[19]]);
        let file_version = u32::from_be_bytes([mobi[20], mobi[21], mobi[22], mobi[23]]);

        let first_image_index = if mobi.len() >= 68 {
            u32::from_be_bytes([mobi[64], mobi[65], mobi[66], mobi[67]]) as usize
        } else {
            0
        };

        let exth_flags = if mobi.len() >= 84 {
            u32::from_be_bytes([mobi[80], mobi[81], mobi[82], mobi[83]])
        } else {
            0
        };

        let title_offset = if mobi.len() >= 88 {
            u32::from_be_bytes([mobi[84], mobi[85], mobi[86], mobi[87]]) as usize
        } else {
            0
        };

        let title_len = if mobi.len() >= 92 {
            u32::from_be_bytes([mobi[88], mobi[89], mobi[90], mobi[91]]) as usize
        } else {
            0
        };

        let first_non_book_index = if mobi.len() >= 116 {
            u32::from_be_bytes([mobi[112], mobi[113], mobi[114], mobi[115]]) as usize
        } else {
            0
        };

        let extra_flags = if mobi.len() >= 244 && header_len >= 244 {
            u16::from_be_bytes([mobi[242], mobi[243]])
        } else {
            0
        };

        let kf8_boundary_offset = if mobi.len() >= 196 && header_len >= 196 {
            let val = u32::from_be_bytes([mobi[192], mobi[193], mobi[194], mobi[195]]);
            if val != 0xFFFF_FFFF {
                Some(val as usize)
            } else {
                None
            }
        } else {
            None
        };

        Ok(Some(MobiHeader {
            header_len,
            mobi_type,
            encoding,
            unique_id,
            file_version,
            first_image_index,
            first_non_book_index,
            exth_flags,
            title_offset,
            title_len,
            extra_flags,
            kf8_boundary_offset,
        }))
    }
}

/// Extracted book metadata from MOBI and EXTH headers.
#[derive(Debug, Clone, Default)]
pub struct ExtractedMetadata {
    pub title: String,
    pub author: String,
    pub publisher: Option<String>,
    pub description: Option<String>,
    pub isbn: Option<String>,
    pub language: String,
    pub cover_offset: Option<usize>,
}

/// MOBI metadata strings (the record-0 title and every EXTH string record) are
/// NUL-padded to alignment boundaries. Rust's `str::trim` does NOT strip NUL
/// — it is not whitespace — so padding used to leak into the generated
/// content.opf / toc.ncx, where a literal U+0000 is a fatal XML error:
/// epub.js's packaging load rejected, the spine unpacked empty (`isOpen` never
/// became true), and every MOBI opened through the packaged exe hung forever
/// on "Loading contents…" (found 2026-11-13). Strip control characters, then
/// trim whitespace.
fn sanitize_meta_string(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).collect::<String>().trim().to_string()
}

pub fn parse_exth_and_metadata(
    rec0: &[u8],
    mobi_hdr: &MobiHeader,
    fallback_title: &str,
) -> ExtractedMetadata {
    let mut meta = ExtractedMetadata {
        title: sanitize_meta_string(fallback_title),
        author: "Unknown".to_string(),
        publisher: None,
        description: None,
        isbn: None,
        language: "en".to_string(),
        cover_offset: None,
    };

    // Extract title from Record 0 title_offset if present
    if mobi_hdr.title_offset > 0
        && mobi_hdr.title_len > 0
        && mobi_hdr
            .title_offset
            .checked_add(mobi_hdr.title_len)
            .is_some_and(|end| end <= rec0.len())
    {
        let raw_title = &rec0[mobi_hdr.title_offset..mobi_hdr.title_offset + mobi_hdr.title_len];
        let t = if mobi_hdr.encoding == 1252 {
            cp1252_to_utf8(raw_title)
        } else {
            String::from_utf8_lossy(raw_title).to_string()
        };
        let trimmed = sanitize_meta_string(&t);
        if !trimmed.is_empty() {
            meta.title = trimmed;
        }
    }

    // EXTH header begins immediately after the MOBI header
    if (mobi_hdr.exth_flags & 0x40) != 0 {
        let exth_start = 16usize.saturating_add(mobi_hdr.header_len);
        if exth_start + 12 <= rec0.len() && &rec0[exth_start..exth_start + 4] == b"EXTH" {
            let exth_len = u32::from_be_bytes([
                rec0[exth_start + 4],
                rec0[exth_start + 5],
                rec0[exth_start + 6],
                rec0[exth_start + 7],
            ]) as usize;
            let record_count = u32::from_be_bytes([
                rec0[exth_start + 8],
                rec0[exth_start + 9],
                rec0[exth_start + 10],
                rec0[exth_start + 11],
            ]) as usize;

            let mut curr = exth_start + 12;
            let exth_end = (exth_start + exth_len).min(rec0.len());

            for _ in 0..record_count {
                if curr + 8 > exth_end {
                    break;
                }
                let r_type = u32::from_be_bytes([
                    rec0[curr],
                    rec0[curr + 1],
                    rec0[curr + 2],
                    rec0[curr + 3],
                ]);
                let r_len = u32::from_be_bytes([
                    rec0[curr + 4],
                    rec0[curr + 5],
                    rec0[curr + 6],
                    rec0[curr + 7],
                ]) as usize;

                if r_len < 8 || curr + r_len > exth_end {
                    break;
                }

                let r_data = &rec0[curr + 8..curr + r_len];
                match r_type {
                    100 => {
                        // Author
                        let a = sanitize_meta_string(&String::from_utf8_lossy(r_data));
                        if !a.is_empty() {
                            meta.author = a;
                        }
                    }
                    101 => {
                        // Publisher
                        meta.publisher = Some(sanitize_meta_string(&String::from_utf8_lossy(r_data)));
                    }
                    103 => {
                        // Description
                        meta.description = Some(sanitize_meta_string(&String::from_utf8_lossy(r_data)));
                    }
                    104 => {
                        // ISBN
                        meta.isbn = Some(sanitize_meta_string(&String::from_utf8_lossy(r_data)));
                    }
                    201 => {
                        // Cover offset
                        if r_data.len() >= 4 {
                            let off = u32::from_be_bytes([
                                r_data[0],
                                r_data[1],
                                r_data[2],
                                r_data[3],
                            ]) as usize;
                            meta.cover_offset = Some(off);
                        }
                    }
                    503 => {
                        // Updated title
                        let t = sanitize_meta_string(&String::from_utf8_lossy(r_data));
                        if !t.is_empty() {
                            meta.title = t;
                        }
                    }
                    524 => {
                        // Language
                        let l = sanitize_meta_string(&String::from_utf8_lossy(r_data));
                        if !l.is_empty() {
                            meta.language = l;
                        }
                    }
                    _ => {}
                }

                curr += r_len;
            }
        }
    }

    meta
}

/// Helper to decode variable-length trailing entry sizes.
fn get_size_of_trailing_data_entry(data: &[u8]) -> usize {
    let mut bitpos = 0;
    let mut result = 0usize;
    let mut idx = data.len();
    if idx == 0 {
        return 0;
    }
    loop {
        let v = data[idx - 1] as usize;
        result |= (v & 0x7F) << bitpos;
        bitpos += 7;
        idx -= 1;
        if (v & 0x80) != 0 || bitpos >= 28 || idx == 0 {
            return result;
        }
    }
}

/// Computes the total trailing byte size from the end of a MOBI record.
pub fn get_size_of_trailing_data_entries(data: &[u8], flags: u16) -> usize {
    let mut num = 0usize;
    let mut testflags = flags >> 1;
    while testflags > 0 {
        if (testflags & 1) != 0 {
            if data.len() <= num {
                return num;
            }
            let sub = &data[..data.len() - num];
            num = num.saturating_add(get_size_of_trailing_data_entry(sub));
        }
        testflags >>= 1;
    }
    if (flags & 1) != 0
        && data.len() > num {
            let last_byte = data[data.len() - num - 1];
            num = num.saturating_add(((last_byte & 0x03) as usize) + 1);
        }
    num
}

/// Strips the trailing entry sequence from a compressed MOBI text record.
pub fn strip_trailing_entries(data: &[u8], flags: u16) -> &[u8] {
    if flags == 0 {
        return data;
    }
    let trail = get_size_of_trailing_data_entries(data, flags);
    if trail >= data.len() {
        &[]
    } else {
        &data[..data.len() - trail]
    }
}

/// Decompresses a single chunk of PalmDOC LZ77 compressed bytes.
pub fn decompress_palmdoc(data: &[u8]) -> Result<Vec<u8>, String> {
    decompress_palmdoc_capped(data, usize::MAX)
}

/// Same, but aborts the moment the output would exceed `max_out` bytes —
/// PalmDOC can expand ~5x per backreference, so checking only after the whole
/// chunk is decoded lets a crafted chunk force a multi-GB transient alloc.
pub fn decompress_palmdoc_capped(data: &[u8], max_out: usize) -> Result<Vec<u8>, String> {
    let headroom = max_out.min(data.len().saturating_mul(2)).min(8 * 1024 * 1024);
    let mut out = Vec::with_capacity(headroom);
    let mut i = 0;
    while i < data.len() {
        let b = data[i];
        i += 1;
        if b == 0x00 {
            out.push(0x00);
        } else if b <= 0x08 {
            let count = b as usize;
            if i + count > data.len() {
                return Err("PalmDOC LZ77: Unexpected EOF in literal run".to_string());
            }
            out.extend_from_slice(&data[i..i + count]);
            i += count;
        } else if b <= 0x7F {
            out.push(b);
        } else if b <= 0xBF {
            if i >= data.len() {
                return Err("PalmDOC LZ77: Unexpected EOF in backreference".to_string());
            }
            let c = data[i];
            i += 1;
            let compound = (((b as usize) & 0x3F) << 8) | (c as usize);
            let distance = compound >> 3;
            let length = (compound & 0x07) + 3;
            if distance == 0 || distance > out.len() {
                return Err(format!(
                    "PalmDOC LZ77: Invalid backreference distance: {} (out len {})",
                    distance,
                    out.len()
                ));
            }
            let start = out.len() - distance;
            for k in 0..length {
                let byte = out[start + k];
                out.push(byte);
            }
        } else {
            // 0xC0..=0xFF: space + (b ^ 0x80)
            out.push(b' ');
            out.push(b ^ 0x80);
        }
        if out.len() > max_out {
            return Err("PalmDOC LZ77: decompressed output exceeds budget".to_string());
        }
    }
    Ok(out)
}

/// Converts Windows-1252 encoded bytes to a UTF-8 String.
pub fn cp1252_to_utf8(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&b| match b {
            0x80 => '€',
            0x82 => '‚',
            0x83 => 'ƒ',
            0x84 => '„',
            0x85 => '…',
            0x86 => '†',
            0x87 => '‡',
            0x88 => 'ˆ',
            0x89 => '‰',
            0x8A => 'Š',
            0x8B => '‹',
            0x8C => 'Œ',
            0x8E => 'Ž',
            0x91 => '‘',
            0x92 => '’',
            0x93 => '“',
            0x94 => '”',
            0x95 => '•',
            0x96 => '–',
            0x97 => '—',
            0x98 => '˜',
            0x99 => '™',
            0x9A => 'š',
            0x9B => '›',
            0x9C => 'œ',
            0x9E => 'ž',
            0x9F => 'Ÿ',
            _ => b as char,
        })
        .collect()
}

/// Escape XML special characters.
fn escape_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

/// Represents an extracted image asset.
#[derive(Debug, Clone)]
pub struct ExtractedImage {
    pub filename: String,
    pub rel_path: String,
    pub mime: &'static str,
    pub bytes: Vec<u8>,
}

/// Detects the image format and file extension from magic bytes.
pub fn detect_image_format(data: &[u8]) -> Option<(&'static str, &'static str)> {
    if data.starts_with(b"\xFF\xD8\xFF") {
        Some(("jpg", "image/jpeg"))
    } else if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(("png", "image/png"))
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        Some(("gif", "image/gif"))
    } else if data.starts_with(b"BM") {
        Some(("bmp", "image/bmp"))
    } else if data.starts_with(b"<svg")
        || (data.starts_with(b"<?xml") && String::from_utf8_lossy(&data[..data.len().min(128)]).contains("<svg"))
    {
        Some(("svg", "image/svg+xml"))
    } else if data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        Some(("webp", "image/webp"))
    } else {
        None
    }
}

/// Unpacks a DRM-free MOBI / AZW / AZW3 file directly into the given cache target directory.
pub fn unpack_mobi(
    mobi_path: &Path,
    target_dir: &Path,
    orig_path: &str,
    meta: &fs::Metadata,
    mtime_ms: u128,
) -> Result<BookManifest, String> {
    let raw_bytes = fs::read(mobi_path)
        .map_err(|e| format!("Cannot read MOBI file '{}': {}", mobi_path.display(), e))?;

    let pdb = PalmDatabase::parse(&raw_bytes)?;
    if pdb.records.is_empty() {
        return Err("MOBI file has no records".to_string());
    }

    // Record 0 contains the primary PalmDOC + MOBI headers
    let rec0 = pdb.records[0].data;
    let doc_hdr = PalmDocHeader::parse(rec0)?;
    if doc_hdr.encryption_type != 0 {
        return Err(
            "This MOBI/AZW file is DRM-protected and cannot be opened directly. Please use a DRM-free copy."
                .to_string(),
        );
    }

    let mobi_hdr = MobiHeader::parse(rec0)?
        .ok_or_else(|| "Record 0 is missing valid MOBI header identifier".to_string())?;

    // Check for KF8 (Kindle Format 8) in combo files
    let mut use_kf8 = false;
    let mut kf8_rec_0 = 0usize;
    let mut kf8_doc_hdr = doc_hdr.clone();
    let mut kf8_mobi_hdr = mobi_hdr.clone();

    if let Some(boundary_idx) = mobi_hdr.kf8_boundary_offset {
        if boundary_idx < pdb.records.len() {
            let b_rec = pdb.records[boundary_idx].data;
            if b_rec.starts_with(b"BOUNDARY") && boundary_idx + 1 < pdb.records.len() {
                let k0 = boundary_idx + 1;
                let k0_rec = pdb.records[k0].data;
                if let Ok(k_doc) = PalmDocHeader::parse(k0_rec) {
                    if k_doc.encryption_type == 0 {
                        if let Ok(Some(k_mobi)) = MobiHeader::parse(k0_rec) {
                            use_kf8 = true;
                            kf8_rec_0 = k0;
                            kf8_doc_hdr = k_doc;
                            kf8_mobi_hdr = k_mobi;
                        }
                    }
                }
            }
        }
    }

    let (active_rec_0_idx, active_doc_hdr, active_mobi_hdr) = if use_kf8 {
        (kf8_rec_0, &kf8_doc_hdr, &kf8_mobi_hdr)
    } else {
        (0usize, &doc_hdr, &mobi_hdr)
    };

    let metadata = parse_exth_and_metadata(
        pdb.records[active_rec_0_idx].data,
        active_mobi_hdr,
        &pdb.name,
    );

    // Decompress text records (bounded by 256 MB to guard against decompression bombs)
    const MAX_MOBI_TEXT_BYTES: usize = 256 * 1024 * 1024;
    const MAX_MOBI_IMAGE_TOTAL_BYTES: usize = 256 * 1024 * 1024;
    let text_start = active_rec_0_idx + 1;
    let text_end = (text_start + active_doc_hdr.record_count).min(pdb.records.len());
    let mut uncompressed_text_bytes = Vec::new();

    for r_idx in text_start..text_end {
        let raw_rec = pdb.records[r_idx].data;
        let stripped = strip_trailing_entries(raw_rec, active_mobi_hdr.extra_flags);

        match active_doc_hdr.compression {
            1 => {
                // No compression
                if uncompressed_text_bytes.len().saturating_add(stripped.len()) > MAX_MOBI_TEXT_BYTES {
                    return Err("MOBI text uncompressed size exceeds 256 MB limit".to_string());
                }
                uncompressed_text_bytes.extend_from_slice(stripped);
            }
            2 => {
                // PalmDOC LZ77 compression — cap each chunk at the remaining
                // global budget so one crafted chunk can't over-expand
                let budget = MAX_MOBI_TEXT_BYTES - uncompressed_text_bytes.len();
                let chunk = decompress_palmdoc_capped(stripped, budget)?;
                if uncompressed_text_bytes.len().saturating_add(chunk.len()) > MAX_MOBI_TEXT_BYTES {
                    return Err("MOBI text uncompressed size exceeds 256 MB limit".to_string());
                }
                uncompressed_text_bytes.extend_from_slice(&chunk);
            }
            17480 => {
                return Err(
                    "HUFF/CDIC compressed MOBI files are not supported. Please re-save with standard PalmDOC compression or convert to EPUB."
                        .to_string(),
                );
            }
            c => {
                return Err(format!("Unsupported MOBI compression type: {}", c));
            }
        }
    }

    // Convert raw text bytes into UTF-8 string
    let html_text = if active_mobi_hdr.encoding == 1252 {
        cp1252_to_utf8(&uncompressed_text_bytes)
    } else {
        String::from_utf8_lossy(&uncompressed_text_bytes).to_string()
    };

    // Extract image records
    let first_img = active_mobi_hdr.first_image_index;
    let mut extracted_images = Vec::new();
    let mut image_map_1based: HashMap<usize, String> = HashMap::new();
    let mut image_map_0based: HashMap<usize, String> = HashMap::new();

    if first_img > 0 && first_img < pdb.records.len() {
        let max_img = if active_mobi_hdr.first_non_book_index > first_img {
            active_mobi_hdr.first_non_book_index.min(pdb.records.len())
        } else {
            pdb.records.len()
        };

        let mut total_image_bytes = 0usize;
        for rec_idx in first_img..max_img {
            let rec_data = pdb.records[rec_idx].data;
            if let Some((ext, mime)) = detect_image_format(rec_data) {
                if total_image_bytes.saturating_add(rec_data.len()) > MAX_MOBI_IMAGE_TOTAL_BYTES {
                    log::warn!("MOBI image total size exceeded 256 MB; skipping remainder");
                    break;
                }
                total_image_bytes += rec_data.len();
                let rel_1 = (rec_idx - first_img) + 1;
                let rel_0 = rec_idx - first_img;
                let fname = format!("img_{:04}.{}", rel_1, ext);
                let rel_path = format!("images/{}", fname);

                image_map_1based.insert(rel_1, rel_path.clone());
                image_map_0based.insert(rel_0, rel_path.clone());

                extracted_images.push(ExtractedImage {
                    filename: fname,
                    rel_path,
                    mime,
                    bytes: rec_data.to_vec(),
                });
            } else if rec_data.starts_with(b"FLIS")
                || rec_data.starts_with(b"FCIS")
                || rec_data.starts_with(b"SRCS")
                || rec_data.starts_with(b"BOUNDARY")
            {
                // Reached control/boundary records; stop scanning images
                break;
            }
        }
    }

    // Rewrite image references in the HTML
    let rewritten_html = rewrite_images_and_links(
        &html_text,
        &image_map_1based,
        &image_map_0based,
    );

    // Split HTML into chapters and convert to valid XHTML
    let chapters = split_into_chapters(&rewritten_html);

    // Prepare target directory
    let meta_inf = target_dir.join("META-INF");
    let images_dir = target_dir.join("images");
    fs::create_dir_all(&meta_inf)
        .map_err(|e| format!("Cannot create META-INF dir: {}", e))?;
    fs::create_dir_all(&images_dir)
        .map_err(|e| format!("Cannot create images dir: {}", e))?;

    let mut manifest_files = Vec::new();

    // 1. Write container.xml
    let container_xml = r#"<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#;
    let container_path = meta_inf.join("container.xml");
    fs::write(&container_path, container_xml)
        .map_err(|e| format!("Cannot write container.xml: {}", e))?;
    manifest_files.push(ManifestFile {
        zip_path: "META-INF/container.xml".to_string(),
        size: container_xml.len() as u64,
    });

    // 2. Write extracted images
    let mut cover_item_id = None;
    for (idx, img) in extracted_images.iter().enumerate() {
        let p = images_dir.join(&img.filename);
        fs::write(&p, &img.bytes)
            .map_err(|e| format!("Cannot write image '{}': {}", p.display(), e))?;
        manifest_files.push(ManifestFile {
            zip_path: img.rel_path.clone(),
            size: img.bytes.len() as u64,
        });

        if let Some(cov_off) = metadata.cover_offset {
            if idx == cov_off || idx + 1 == cov_off {
                cover_item_id = Some(format!("img_{:04}", idx + 1));
            }
        }
    }

    // 3. Write chapter XHTML files
    let mut spine_items = Vec::new();
    let mut manifest_items = Vec::new();
    let mut nav_points = Vec::new();

    for (idx, ch) in chapters.iter().enumerate() {
        let ch_id = format!("ch_{:04}", idx + 1);
        let ch_filename = format!("{}.xhtml", ch_id);
        let ch_path = target_dir.join(&ch_filename);

        let ch_xhtml = format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8"/>
  <title>{}</title>
  <style>
    body {{ font-family: inherit; margin: 1em; }}
    img {{ max-width: 100%; height: auto; }}
  </style>
</head>
<body>
{}
</body>
</html>"#,
            escape_xml(&ch.title),
            ch.body
        );

        fs::write(&ch_path, &ch_xhtml)
            .map_err(|e| format!("Cannot write chapter '{}': {}", ch_path.display(), e))?;
        manifest_files.push(ManifestFile {
            zip_path: ch_filename.clone(),
            size: ch_xhtml.len() as u64,
        });

        spine_items.push(format!(r#"    <itemref idref="{}"/>"#, ch_id));
        manifest_items.push(format!(
            r#"    <item id="{}" href="{}" media-type="application/xhtml+xml"/>"#,
            ch_id, ch_filename
        ));

        let play_order = idx + 1;
        nav_points.push(format!(
            r#"    <navPoint id="nav_{}" playOrder="{}">
      <navLabel><text>{}</text></navLabel>
      <content src="{}"/>
    </navPoint>"#,
            play_order,
            play_order,
            escape_xml(&ch.title),
            ch_filename
        ));
    }

    // 4. Manifest entries for images
    for (idx, img) in extracted_images.iter().enumerate() {
        let img_id = format!("img_{:04}", idx + 1);
        manifest_items.push(format!(
            r#"    <item id="{}" href="{}" media-type="{}"/>"#,
            img_id, img.rel_path, img.mime
        ));
    }

    // Add ncx to manifest
    manifest_items.push(r#"    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>"#.to_string());

    // 5. Write toc.ncx
    let ncx_xml = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:folio:mobi:{}"/>
    <meta name="dtb:depth" content="1"/>
  </head>
  <docTitle><text>{}</text></docTitle>
  <docAuthor><text>{}</text></docAuthor>
  <navMap>
{}
  </navMap>
</ncx>"#,
        active_mobi_hdr.unique_id,
        escape_xml(&metadata.title),
        escape_xml(&metadata.author),
        nav_points.join("\n")
    );
    let ncx_path = target_dir.join("toc.ncx");
    fs::write(&ncx_path, &ncx_xml)
        .map_err(|e| format!("Cannot write toc.ncx: {}", e))?;
    manifest_files.push(ManifestFile {
        zip_path: "toc.ncx".to_string(),
        size: ncx_xml.len() as u64,
    });

    // 6. Write content.opf
    let cover_meta_tag = match &cover_item_id {
        Some(cid) => format!(r#"    <meta name="cover" content="{}"/>"#, cid),
        None => String::new(),
    };

    let opf_xml = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:folio:mobi:{}</dc:identifier>
    <dc:title>{}</dc:title>
    <dc:creator>{}</dc:creator>
    <dc:language>{}</dc:language>
{}
  </metadata>
  <manifest>
{}
  </manifest>
  <spine toc="ncx">
{}
  </spine>
</package>"#,
        active_mobi_hdr.unique_id,
        escape_xml(&metadata.title),
        escape_xml(&metadata.author),
        escape_xml(&metadata.language),
        cover_meta_tag,
        manifest_items.join("\n"),
        spine_items.join("\n")
    );
    let opf_path = target_dir.join("content.opf");
    fs::write(&opf_path, &opf_xml)
        .map_err(|e| format!("Cannot write content.opf: {}", e))?;
    manifest_files.push(ManifestFile {
        zip_path: "content.opf".to_string(),
        size: opf_xml.len() as u64,
    });

    // 7. Write manifest.json
    let book_manifest = BookManifest {
        path: orig_path.to_string(),
        len: meta.len(),
        mtime_ms,
        files: manifest_files,
    };
    let manifest_bytes = serde_json::to_vec_pretty(&book_manifest)
        .map_err(|e| format!("Cannot serialize manifest.json: {}", e))?;
    fs::write(target_dir.join("manifest.json"), manifest_bytes)
        .map_err(|e| format!("Cannot write manifest.json: {}", e))?;

    // Touch atime
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let _ = fs::write(target_dir.join("atime"), now.to_string());

    Ok(book_manifest)
}

/// Next char boundary at or after `i`. All byte-stepping over untrusted HTML
/// must advance through this helper — slicing a &str mid-UTF-8-char panics.
fn next_boundary(s: &str, mut i: usize) -> usize {
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// Case-insensitive ASCII prefix match at a char boundary. Tag markup is
/// ASCII, so `eq_ignore_ascii_case` (length-preserving) is always correct —
/// `to_lowercase()` is NOT length-preserving (`İ` → 3 bytes) and would shift
/// every offset taken from the folded copy relative to the original.
fn ci_starts_at(haystack: &str, at: usize, needle: &str) -> bool {
    let hb = haystack.as_bytes();
    let nb = needle.as_bytes();
    hb.len() >= at + nb.len() && hb[at..at + nb.len()].eq_ignore_ascii_case(nb)
}

/// Case-insensitive search for an ASCII substring without lowercasing the haystack.
fn ci_find(haystack: &str, needle: &str) -> Option<usize> {
    let hb = haystack.as_bytes();
    let nb = needle.as_bytes();
    if nb.is_empty() {
        return Some(0);
    }
    if hb.len() < nb.len() {
        return None;
    }
    for idx in 0..=hb.len() - nb.len() {
        if hb[idx..idx + nb.len()].eq_ignore_ascii_case(nb) {
            return Some(idx);
        }
    }
    None
}

/// Rewrites image tags and filepos links into standard XHTML paths and anchors.
pub fn rewrite_images_and_links(
    html: &str,
    img_map_1: &HashMap<usize, String>,
    img_map_0: &HashMap<usize, String>,
) -> String {
    let mut out = String::with_capacity(html.len() + 1024);
    let mut i = 0usize;

    while i < html.len() {
        if html[i..].starts_with('<') {
            // Quote-aware tag end (find_tag_end): a '>' inside a quoted
            // attribute ("Chapter 5 > notes") truncated the tag mid-value
            // and the recindex/src rewrite never saw it — broken image.
            // Bounded: an unterminated tag must not rescan to the text end.
            if let Some(tag_end_rel) = find_tag_end_bounded(&html[i..], 65536) {
                let tag_end = i + tag_end_rel + 1;
                let tag_str = &html[i..tag_end];
                let tag_lower = tag_str.to_ascii_lowercase();

                if tag_lower.starts_with("<img") || tag_lower.starts_with("<image") {
                    let rewritten = rewrite_img_tag(tag_str, img_map_1, img_map_0);
                    out.push_str(&rewritten);
                    i = tag_end;
                    continue;
                } else if tag_lower.starts_with("<a ") {
                    let rewritten = rewrite_a_tag(tag_str);
                    out.push_str(&rewritten);
                    i = tag_end;
                    continue;
                } else if tag_lower.starts_with("<br") || tag_lower.starts_with("<hr") {
                    // Ensure void tags are self-closed
                    if !tag_str.ends_with("/>") {
                        let self_closed = format!("{}/>", tag_str[..tag_str.len() - 1].trim_end());
                        out.push_str(&self_closed);
                        i = tag_end;
                        continue;
                    }
                }
            }
        }
        let nb = next_boundary(html, i + 1);
        let next_tag = html[nb..].find('<').map(|p| nb + p).unwrap_or(html.len());
        out.push_str(&html[i..next_tag]);
        i = next_tag;
    }

    out
}

/// Helper to rewrite a single `<img ...>` or `<image ...>` tag.
fn rewrite_img_tag(
    tag: &str,
    img_map_1: &HashMap<usize, String>,
    img_map_0: &HashMap<usize, String>,
) -> String {
    // Look for recindex="123"
    let lower = tag.to_ascii_lowercase();
    let mut target_img_path = None;

    if let Some(pos) = lower.find("recindex=") {
        let rest = &tag[pos + 9..];
        let digits: String = rest
            .chars()
            .skip_while(|&c| c == '"' || c == '\'')
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if let Ok(num) = digits.parse::<usize>() {
            if let Some(p) = img_map_1.get(&num).or_else(|| img_map_0.get(&num)) {
                target_img_path = Some(p.clone());
            }
        }
    }

    // Look for kindle:embed:0001
    if target_img_path.is_none() {
        if let Some(pos) = lower.find("kindle:embed:") {
            let rest = &tag[pos + 13..];
            let digits: String = rest
                .chars()
                .take_while(|c| c.is_ascii_hexdigit())
                .collect();
            if let Ok(num) = digits.parse::<usize>()
                .or_else(|_| usize::from_str_radix(&digits, 16))
            {
                if let Some(p) = img_map_1.get(&num).or_else(|| img_map_0.get(&num)) {
                    target_img_path = Some(p.clone());
                }
            }
        }
    }

    // Look for bare numeric src="1"
    if target_img_path.is_none() {
        if let Some(pos) = lower.find("src=") {
            let rest = &tag[pos + 4..];
            let digits: String = rest
                .chars()
                .skip_while(|&c| c == '"' || c == '\'')
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if !digits.is_empty() {
                if let Ok(num) = digits.parse::<usize>() {
                    if let Some(p) = img_map_1.get(&num).or_else(|| img_map_0.get(&num)) {
                        target_img_path = Some(p.clone());
                    }
                }
            }
        }
    }

    if let Some(new_src) = target_img_path {
        let mut clean = String::with_capacity(tag.len() + 32);
        // Remove old recindex attribute if present
        let mut in_recindex = false;
        let mut chars = tag.chars().peekable();
        while let Some(c) = chars.next() {
            if !in_recindex && (c == 'r' || c == 'R') {
                let check: String = std::iter::once(c)
                    .chain(chars.clone().take(8))
                    .collect();
                if check.to_lowercase() == "recindex=" {
                    in_recindex = true;
                    for _ in 0..8 {
                        chars.next();
                    }
                    // skip quote if any
                    let quote = chars.peek().copied();
                    if quote == Some('"') || quote == Some('\'') {
                        chars.next();
                        for q in chars.by_ref() {
                            if Some(q) == quote {
                                break;
                            }
                        }
                    } else {
                        while let Some(&d) = chars.peek() {
                            if d.is_ascii_whitespace() || d == '>' || d == '/' {
                                break;
                            }
                            chars.next();
                        }
                    }
                    continue;
                }
            }
            clean.push(c);
        }

        // Replace or add src
        let clean_lower = clean.to_ascii_lowercase();
        let final_tag = if let Some(src_pos) = clean_lower.find("src=") {
            let after_eq = &clean[src_pos + 4..];
            let (quote, val_start) = match after_eq.chars().next() {
                Some(c @ '"') | Some(c @ '\'') => (c, src_pos + 4 + c.len_utf8()),
                Some(_) => ('"', src_pos + 4), // unquoted
                None => return clean,          // nothing after src=
            };
            if val_start >= clean.len() {
                return clean;
            }
            let end_quote = clean[val_start..]
                .find(quote)
                .map(|p| val_start + p + quote.len_utf8())
                .unwrap_or(clean.len());
            format!("{}src=\"{}\"{}", &clean[..src_pos], new_src, &clean[end_quote..])
        } else {
            let insert_pos = clean.rfind('>').unwrap_or(clean.len());
            let trimmed = clean[..insert_pos].trim_end_matches('/');
            format!("{} src=\"{}\"/>", trimmed.trim_end(), new_src)
        };

        if !final_tag.ends_with("/>") && final_tag.ends_with('>') {
            format!("{}/>", final_tag[..final_tag.len() - 1].trim_end())
        } else {
            final_tag
        }
    } else if !tag.ends_with("/>") && tag.ends_with('>') {
        format!("{}/>", tag[..tag.len() - 1].trim_end())
    } else {
        tag.to_string()
    }
}

/// Helper to rewrite an `<a filepos="...">` link into `<a href="#filepos_...">`.
fn rewrite_a_tag(tag: &str) -> String {
    let lower = tag.to_ascii_lowercase();
    if let Some(pos) = lower.find("filepos=") {
        let rest = &tag[pos + 8..];
        let digits: String = rest
            .chars()
            .skip_while(|&c| c == '"' || c == '\'')
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if !digits.is_empty() {
            let quote = rest.chars().next();
            let end_offset = match quote {
                Some(q @ '"') | Some(q @ '\'') => {
                    let q_len = q.len_utf8();
                    rest[q_len..]
                        .find(q)
                        .map(|p| q_len + p + q_len)
                        .unwrap_or(rest.len())
                }
                _ => rest
                    .find(|c: char| c == '"' || c == '\'' || c.is_ascii_whitespace() || c == '>')
                    .unwrap_or(rest.len()),
            };
            let end_pos = pos + 8 + end_offset;
            return format!("{}href=\"#filepos_{}\"{}", &tag[..pos], digits, &tag[end_pos..]);
        }
    }
    tag.to_string()
}

/// Represents an extracted chapter chunk ready for XHTML packaging.
#[derive(Debug, Clone)]
pub struct ChapterChunk {
    pub title: String,
    pub body: String,
}

/// Collects all `filepos` target offsets referenced in HTML markup.
fn collect_filepos_targets(html: &str) -> BTreeSet<usize> {
    let mut targets = BTreeSet::new();
    let bytes = html.as_bytes();
    for needle in [b"filepos=".as_slice(), b"filepos_".as_slice()] {
        let mut i = 0;
        while i + needle.len() <= bytes.len() {
            if bytes[i..i + needle.len()].eq_ignore_ascii_case(needle) {
                let mut j = i + needle.len();
                while j < bytes.len() && (bytes[j] == b'"' || bytes[j] == b'\'') {
                    j += 1;
                }
                let start_digits = j;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
                if j > start_digits {
                    if let Ok(s) = std::str::from_utf8(&bytes[start_digits..j]) {
                        if let Ok(num) = s.parse::<usize>() {
                            targets.insert(num);
                        }
                    }
                }
                i = j;
            } else {
                i += 1;
            }
        }
    }
    targets
}

/// Rewrites `#filepos_N` and `filepos="N"` references into `ch_XXXX.xhtml#filepos_N` cross-chapter links.
/* True when `pos` sits inside a tag (nearest '<' is closer than the nearest
   '>'): filepos= rewrites must only touch markup, not prose like
   `<pre>see filepos=12345 for details</pre>`. */
fn in_tag_at(html: &str, pos: usize) -> bool {
    let last_lt = html[..pos].rfind('<');
    let last_gt = html[..pos].rfind('>');
    match (last_lt, last_gt) {
        (Some(lt), Some(gt)) => lt > gt,
        (Some(_), None) => true,
        _ => false,
    }
}

fn prefix_cross_chapter_links(html: &str, filepos_to_chapter: &HashMap<usize, String>) -> String {
    let mut out = String::with_capacity(html.len() + 256);
    let mut i = 0;
    while i < html.len() {
        if html[i..].starts_with("href=\"#filepos_") {
            let needle_len = "href=\"#filepos_".len();
            let val_start = i + needle_len;
            let digits: String = html[val_start..]
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if !digits.is_empty() && in_tag_at(html, i) {
                if let Ok(num) = digits.parse::<usize>() {
                    let ch_file = filepos_to_chapter.get(&num).map(|s| s.as_str()).unwrap_or("");
                    out.push_str("href=\"");
                    out.push_str(ch_file);
                    out.push_str("#filepos_");
                    out.push_str(&digits);
                    i = val_start + digits.len();
                    continue;
                }
            }
        } else if ci_starts_at(html, i, "filepos=") {
            let needle_len = "filepos=".len();
            let rest = &html[i + needle_len..];
            let digits: String = rest
                .chars()
                .skip_while(|&c| c == '"' || c == '\'')
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if !digits.is_empty() && in_tag_at(html, i) {
                if let Ok(num) = digits.parse::<usize>() {
                    let ch_file = filepos_to_chapter.get(&num).map(|s| s.as_str()).unwrap_or("");
                    out.push_str("href=\"");
                    out.push_str(ch_file);
                    out.push_str("#filepos_");
                    out.push_str(&digits);
                    out.push('"');
                    let quote = rest.chars().next();
                    let end_offset = match quote {
                        Some(q @ '"') | Some(q @ '\'') => {
                            let q_len = q.len_utf8();
                            rest[q_len..]
                                .find(q)
                                .map(|p| q_len + p + q_len)
                                .unwrap_or(rest.len())
                        }
                        _ => rest
                            .find(|c: char| c == '"' || c == '\'' || c.is_ascii_whitespace() || c == '>')
                            .unwrap_or(rest.len()),
                    };
                    i = i + needle_len + end_offset;
                    continue;
                }
            }
        }
        // `i` is always a char boundary here (ASCII-anchored advances), but
        // i + 1 can sit inside a multi-byte char when a rewrite lands right
        // before one (e.g. `<a href="#filepos_123你`) — slice from the next
        // boundary like the sibling scanners do.
        let scan_from = next_boundary(html, i + 1);
        let next_cand = html[scan_from..]
            .find(['h', 'H', 'f', 'F'])
            .map(|p| scan_from + p)
            .unwrap_or(html.len());
        let safe_end = next_boundary(html, next_cand);
        out.push_str(&html[i..safe_end]);
        i = safe_end;
    }
    out
}



/// Splits raw HTML into chapters and cleans up tags.
pub fn split_into_chapters(html: &str) -> Vec<ChapterChunk> {
    let mut parts: Vec<&str> = Vec::new();
    let mut last_end = 0usize;

    // Scan for pagebreak markers
    let mut i = 0usize;
    while i < html.len() {
        if ci_starts_at(html, i, "<mbp:pagebreak")
            || ci_starts_at(html, i, "<pagebreak")
            || ci_starts_at(html, i, "<div style=\"page-break-before:always\"")
        {
            if let Some(close) = find_tag_end_bounded(&html[i..], 65536) {
                let tag_end = i + close + 1;
                let chunk = html[last_end..i].trim();
                if !chunk.is_empty() {
                    parts.push(chunk);
                }
                last_end = tag_end;
                i = tag_end;
                continue;
            }
        }
        i = next_boundary(html, i + 1);
    }

    let remainder = html[last_end..].trim();
    if !remainder.is_empty() {
        parts.push(remainder);
    }

    // If no pagebreak tags exist, split large texts by headings if > 150 KB
    if parts.len() <= 1 && html.len() > 150 * 1024 {
        let mut sub_parts = Vec::new();
        let mut sub_last = 0usize;
        let mut pos = 0usize;
        while pos < html.len() {
            if (ci_starts_at(html, pos, "<h1") || ci_starts_at(html, pos, "<h2"))
                && pos > sub_last && (pos - sub_last) > 30 * 1024 {
                    let chunk = html[sub_last..pos].trim();
                    if !chunk.is_empty() {
                        sub_parts.push(chunk);
                    }
                    sub_last = pos;
                }
            pos = next_boundary(html, pos + 1);
        }
        let rem = html[sub_last..].trim();
        if !rem.is_empty() {
            sub_parts.push(rem);
        }
        if sub_parts.len() > 1 {
            parts = sub_parts;
        }
    }

    if parts.is_empty() {
        parts.push(html.trim());
    }

    let all_targets = collect_filepos_targets(html);
    let mut chapter_targets: Vec<Vec<usize>> = vec![Vec::new(); parts.len()];
    let mut filepos_to_chapter: HashMap<usize, String> = HashMap::new();

    for &target in &all_targets {
        let ch_idx = parts
            .iter()
            .position(|part| {
                let start = part.as_ptr() as usize - html.as_ptr() as usize;
                let end = start + part.len();
                target >= start && target < end
            })
            .unwrap_or_else(|| {
                if parts.is_empty() {
                    0
                } else {
                    let first_start = parts[0].as_ptr() as usize - html.as_ptr() as usize;
                    if target < first_start {
                        0
                    } else {
                        parts.len() - 1
                    }
                }
            });

        chapter_targets[ch_idx].push(target);
        filepos_to_chapter.insert(target, format!("ch_{:04}.xhtml", ch_idx + 1));
    }

    let mut result = Vec::with_capacity(parts.len());
    for (idx, &part) in parts.iter().enumerate() {
        let part_start = part.as_ptr() as usize - html.as_ptr() as usize;
        let mut tgts = chapter_targets[idx].clone();
        tgts.sort_unstable_by(|a, b| b.cmp(a));
        tgts.dedup();

        let mut body_str = part.to_string();
        for target in tgts {
            let rel_pos = target.saturating_sub(part_start).min(body_str.len());
            let safe_pos = next_boundary(&body_str, rel_pos);
            let insert_idx = if let Some(last_lt) = body_str[..safe_pos].rfind('<') {
                if last_lt < safe_pos && !body_str[last_lt..safe_pos].contains('>') {
                    body_str[safe_pos..].find('>').map(|gt| safe_pos + gt + 1).unwrap_or(safe_pos)
                } else {
                    safe_pos
                }
            } else {
                safe_pos
            };
            let anchor = format!("<span id=\"filepos_{}\"></span>", target);
            body_str.insert_str(insert_idx, &anchor);
        }

        let title = extract_chapter_title(&body_str, idx + 1);
        let cleaned_body = clean_chapter_body(&body_str);
        let final_body = prefix_cross_chapter_links(&cleaned_body, &filepos_to_chapter);
        result.push(ChapterChunk {
            title,
            body: final_body,
        });
    }

    result
}

/// Extracts a chapter title from the first heading tag or defaults to Chapter N.
fn extract_chapter_title(text: &str, num: usize) -> String {
    let lower = text.to_ascii_lowercase();
    for heading in ["<h1", "<h2", "<h3", "<b>"] {
        if let Some(pos) = lower.find(heading) {
            if let Some(tag_end) = text[pos..].find('>') {
                let content_start = pos + tag_end + 1;
                let close_tag = match heading {
                    "<h1" => "</h1>",
                    "<h2" => "</h2>",
                    "<h3" => "</h3>",
                    _ => "</b>",
                };
                if let Some(close_pos) = lower[content_start..].find(close_tag) {
                    let raw = &text[content_start..content_start + close_pos];
                    let plain: String = raw
                        .chars()
                        .filter(|&c| c != '<' && c != '>')
                        .collect();
                    let trimmed = plain.trim();
                    if !trimmed.is_empty() && trimmed.len() <= 100 {
                        return trimmed.to_string();
                    }
                }
            }
        }
    }
    format!("Chapter {}", num)
}

/// Sanitizes an HTML element tag by stripping inline event handlers (on*) and dangerous URI schemes.
fn sanitize_html_tag(tag: &str) -> String {
    let lower = tag.to_ascii_lowercase();
    {
        let needs_sanitize = lower.contains("javascript:")
            || lower.contains("vbscript:")
            || lower.contains("data:text/html");
        let has_event_handler = lower.contains("on")
            && {
                // Check if "on" appears as an attribute name (preceded by whitespace, /, or tag-start)
                let bytes = lower.as_bytes();
                let mut found = false;
                for i in 0..bytes.len().saturating_sub(2) {
                    if bytes[i + 1] == b'o' && bytes[i + 2] == b'n' {
                        let sep = bytes[i];
                        if sep == b' ' || sep == b'\t' || sep == b'\n' || sep == b'\r'
                            || sep == b'\x0c' || sep == b'/' || sep == b'<'
                        {
                            found = true;
                            break;
                        }
                    }
                }
                found
            };
        if !needs_sanitize && !has_event_handler {
            return tag.to_string();
        }
    }
    let is_self_closing = tag.ends_with("/>");
    let inner = if is_self_closing {
        &tag[1..tag.len() - 2]
    } else {
        &tag[1..tag.len() - 1]
    };
    let tag_name_end = inner
        .find(|c: char| c.is_whitespace() || c == '/' || c == '>')
        .unwrap_or(inner.len());
    let tag_name = &inner[..tag_name_end];
    if tag_name.is_empty() {
        return tag.to_string();
    }

    let mut clean_attrs = String::new();
    let mut rest = &inner[tag_name.len()..];
    while !rest.is_empty() {
        let trimmed = rest.trim_start();
        if trimmed.is_empty() {
            break;
        }
        let name_end = trimmed
            .find(|c: char| c.is_whitespace() || c == '=' || c == '/' || c == '>')
            .unwrap_or(trimmed.len());
        if name_end == 0 {
            // Skip non-attribute delimiter (e.g. '/' in self-closing tags)
            let next_idx = trimmed.char_indices().nth(1).map(|(i, _)| i).unwrap_or(trimmed.len());
            rest = &trimmed[next_idx..];
            continue;
        }
        let attr_name = &trimmed[..name_end];
        let after_name = trimmed[name_end..].trim_start();
        if let Some(stripped) = after_name.strip_prefix('=') {
            let after_eq = stripped.trim_start();
            if let Some(stripped_quote) = after_eq.strip_prefix('"') {
                let val_end = stripped_quote.find('"').map(|idx| idx + 2).unwrap_or(after_eq.len());
                let attr_val = &after_eq[..val_end];
                rest = &after_eq[val_end..];
                let attr_lower = attr_name.to_lowercase();
                let val_lower = attr_val.to_lowercase();
                if !attr_lower.starts_with("on")
                    && !val_lower.contains("javascript:")
                    && !val_lower.contains("vbscript:")
                    && !val_lower.contains("data:text/html")
                {
                    clean_attrs.push(' ');
                    clean_attrs.push_str(attr_name);
                    clean_attrs.push('=');
                    clean_attrs.push_str(attr_val);
                }
            } else if let Some(stripped_single) = after_eq.strip_prefix('\'') {
                let val_end = stripped_single.find('\'').map(|idx| idx + 2).unwrap_or(after_eq.len());
                let attr_val = &after_eq[..val_end];
                rest = &after_eq[val_end..];
                let attr_lower = attr_name.to_lowercase();
                let val_lower = attr_val.to_lowercase();
                if !attr_lower.starts_with("on")
                    && !val_lower.contains("javascript:")
                    && !val_lower.contains("vbscript:")
                    && !val_lower.contains("data:text/html")
                {
                    clean_attrs.push(' ');
                    clean_attrs.push_str(attr_name);
                    clean_attrs.push('=');
                    clean_attrs.push_str(attr_val);
                }
            } else {
                let val_end = after_eq
                    .find(|c: char| c.is_whitespace() || c == '/' || c == '>')
                    .unwrap_or(after_eq.len());
                let attr_val = &after_eq[..val_end];
                rest = &after_eq[val_end..];
                let attr_lower = attr_name.to_lowercase();
                let val_lower = attr_val.to_lowercase();
                if !attr_lower.starts_with("on")
                    && !val_lower.contains("javascript:")
                    && !val_lower.contains("vbscript:")
                    && !val_lower.contains("data:text/html")
                {
                    clean_attrs.push(' ');
                    clean_attrs.push_str(attr_name);
                    clean_attrs.push('=');
                    clean_attrs.push_str(attr_val);
                }
            }
        } else {
            rest = after_name;
            let attr_lower = attr_name.to_lowercase();
            if !attr_lower.starts_with("on") {
                clean_attrs.push(' ');
                clean_attrs.push_str(attr_name);
            }
        }
    }

    if is_self_closing {
        format!("<{}{}/>", tag_name, clean_attrs)
    } else {
        format!("<{}{}>", tag_name, clean_attrs)
    }
}

fn find_tag_end(text: &str) -> Option<usize> {
    let mut in_quote: Option<u8> = None;
    for (idx, b) in text.bytes().enumerate() {
        match (b, in_quote) {
            (b'"', None) => in_quote = Some(b'"'),
            (b'"', Some(b'"')) => in_quote = None,
            (b'\'', None) => in_quote = Some(b'\''),
            (b'\'', Some(b'\'')) => in_quote = None,
            (b'>', None) => return Some(idx),
            _ => {}
        }
    }
    None
}

/* find_tag_end bounded to a window: scanning an unterminated tag to the end
   of a 256MB text made every subsequent '<' a quadratic rescan (a crafted
   few-MB .mobi pinned a book_open worker for tens of minutes). */
fn find_tag_end_bounded(text: &str, limit: usize) -> Option<usize> {
    let win_end = next_boundary(text, limit.min(text.len()));
    find_tag_end(&text[..win_end])
}

/// Cleans legacy Mobipocket tags and repairs void tags for XML compliance,
/// while stripping scripts, dangerous embeds, and event handlers.
fn clean_chapter_body(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 128);
    let mut i = 0usize;

    while i < text.len() {
        if text[i..].starts_with('<') {
            // A '<' that isn't tag markup (e.g. "a < b > c" in prose) must be
            // escaped: chapters are served as application/xhtml+xml, where a
            // bare '<' is a fatal parse error and a bogus "<10" starts an
            // invalid tag name that blanks the whole chapter. Markup = next
            // char is a letter, '!', '/' or '?'.
            let is_markup = text[i + 1..].chars().next()
                .map(|c| c.is_ascii_alphabetic() || c == '!' || c == '/' || c == '?')
                .unwrap_or(false);
            if !is_markup {
                out.push_str("&lt;");
                i += 1;
                continue;
            }
            // Completely strip script tags and their inner content. The
            // boundary check keeps longer names (<scriptx>) out of the strip.
            if ci_starts_at(text, i, "<script") {
                let after = i + "<script".len();
                let bounded = after >= text.len() || {
                    match text[after..].chars().next() {
                        Some(c) => c.is_ascii_whitespace() || c == '/' || c == '>',
                        None => true,
                    }
                };
                if bounded {
                    // Bound the close-tag search: a document stuffed with
                    // unclosed <iframe/<script tags made ci_find quadratic
                    // over the whole remaining text (seconds of CPU inside
                    // book_open). 64KB window, then fall back to skipping
                    // this tag alone.
                    let win_end = next_boundary(text, (i + 65536).min(text.len()));
                    if let Some(close_idx) = ci_find(&text[i..win_end], "</script") {
                        // Bound the tag-end scan to the same window — an
                        // unbounded scan over the rest of the body is the
                        // quadratic-CPU shape 893e8e3 fixed elsewhere.
                        let close_abs = i + close_idx;
                        if let Some(end_gt) = find_tag_end(&text[close_abs..(close_abs + 65536).min(text.len())]) {
                            i = close_abs + end_gt + 1;
                            continue;
                        }
                    }
                    // Skip past unclosed "<script" tag rather than dropping the rest of the chapter
                    if let Some(open_gt) = find_tag_end_bounded(&text[i..], 65536) {
                        i += open_gt + 1;
                    } else {
                        i += "<script".len();
                    }
                    continue;
                }
            }
            // Strip <meta ...> (e.g. http-equiv=refresh navigation hijacks).
            // Void tag — no closing pair to look for. The extra boundary
            // check keeps longer tags like <metadata> untouched.
            if ci_starts_at(text, i, "<meta") {
                let after = i + "<meta".len();
                let bounded = after >= text.len() || {
                    match text[after..].chars().next() {
                        Some(c) => c.is_ascii_whitespace() || c == '/' || c == '>',
                        None => true,
                    }
                };
                if bounded {
                    match find_tag_end_bounded(&text[i..], 65536) {
                        Some(open_gt) => i += open_gt + 1,
                        None => i = after, // unterminated tag: skip the prefix
                    }
                    continue;
                }
            }
            // Completely strip iframe, object, embed tags. Boundary check:
            // <objects> must not match the <object prefix (its close-tag
            // search then ate everything up to a legitimate </object>).
            let mut stripped_tag = false;
            for dangerous_tag in &["<iframe", "<object", "<embed"] {
                if ci_starts_at(text, i, dangerous_tag) {
                    let after = i + dangerous_tag.len();
                    let bounded = after >= text.len() || {
                        match text[after..].chars().next() {
                            Some(c) => c.is_ascii_whitespace() || c == '/' || c == '>',
                            None => true,
                        }
                    };
                    if !bounded { continue; }
                    let win_end = next_boundary(text, (i + 65536).min(text.len()));
                    let close_tag = format!("</{}", &dangerous_tag[1..]);
                    if let Some(close_idx) = ci_find(&text[i..win_end], &close_tag) {
                        // Same-window bound (see the </script> site above).
                        let close_abs = i + close_idx;
                        if let Some(end_gt) = find_tag_end(&text[close_abs..(close_abs + 65536).min(text.len())]) {
                            i = close_abs + end_gt + 1;
                            stripped_tag = true;
                            break;
                        }
                    } else if let Some(self_close) = find_tag_end_bounded(&text[i..], 65536) {
                        i = i + self_close + 1;
                        stripped_tag = true;
                        break;
                    }
                }
            }
            if stripped_tag {
                continue;
            }

            if let Some(close) = find_tag_end_bounded(&text[i..], 65536) {
                let tag_end = i + close + 1;
                let tag = &text[i..tag_end];
                let tag_lower = tag.to_ascii_lowercase();

                // Strip mobipocket indexing and pagebreak tags
                if tag_lower.starts_with("<idx:")
                    || tag_lower.starts_with("</idx:")
                    || tag_lower.starts_with("<mbp:")
                    || tag_lower.starts_with("</mbp:")
                {
                    i = tag_end;
                    continue;
                }

                // Ensure void elements are self-closed
                if (tag_lower.starts_with("<br") || tag_lower.starts_with("<hr")) && !tag.ends_with("/>") {
                    let repaired = format!("{}/>", tag[..tag.len() - 1].trim_end());
                    out.push_str(&sanitize_html_tag(&repaired));
                    i = tag_end;
                    continue;
                }

                out.push_str(&sanitize_html_tag(tag));
                i = tag_end;
                continue;
            }
            // Unterminated tag (or >64KB of quoted run-on): pushing the raw
            // text put an unparseable tag into the XHTML and blanked the
            // chapter — escape the '<' and let the rest flow as text.
            out.push_str("&lt;");
            i += 1;
            continue;
        }

        let nb = next_boundary(text, i + 1);
        let next_tag = text[nb..].find('<').map(|p| nb + p).unwrap_or(text.len());
        out.push_str(&text[i..next_tag]);
        i = next_tag;
    }

    out
}

#[cfg(test)]
mod mobi_fix_tests {
    use super::*;

    #[test]
    fn test_fix1_sanitize_html_tag_no_infinite_loop() {
        // Trailing delimiter '/' in self-closing or malformed tags must not cause an infinite loop
        let res1 = sanitize_html_tag("<br />");
        assert!(res1.starts_with("<br"));

        let res2 = sanitize_html_tag("<hr/>");
        assert!(res2.starts_with("<hr"));

        let res3 = sanitize_html_tag("<img / >");
        assert!(res3.starts_with("<img"));

        let res4 = sanitize_html_tag("<div class=\"test\" / >");
        assert!(res4.contains("class=\"test\""));
    }

    #[test]
    fn test_fix2_sanitize_html_tag_xss_bypass() {
        // Event handlers separated by slash, tab, newline, carriage return, form feed
        let xss1 = sanitize_html_tag("<img/onerror=alert(1)>");
        assert!(
            !xss1.to_ascii_lowercase().contains("onerror"),
            "Failed to strip slash-separated onerror: {}",
            xss1
        );

        let xss2 = sanitize_html_tag("<div\tonclick=alert(1)>");
        assert!(
            !xss2.to_ascii_lowercase().contains("onclick"),
            "Failed to strip tab-separated onclick: {}",
            xss2
        );

        let xss3 = sanitize_html_tag("<a\nonload=alert(1)>");
        assert!(
            !xss3.to_ascii_lowercase().contains("onload"),
            "Failed to strip newline-separated onload: {}",
            xss3
        );

        let xss4 = sanitize_html_tag("<p\x0conerror=alert(1)>");
        assert!(
            !xss4.to_ascii_lowercase().contains("onerror"),
            "Failed to strip formfeed-separated onerror: {}",
            xss4
        );

        // Safe tags containing "on" in attribute or tag name must not be mangled
        let safe1 = sanitize_html_tag("<button type=\"button\">");
        assert!(safe1.contains("button"));

        let safe2 = sanitize_html_tag("<span font-weight=\"bold\">");
        assert!(safe2.contains("font-weight"));
    }

    #[test]
    fn test_fix3_rewrite_img_tag_safe_slice() {
        let map1 = HashMap::new();
        let map0 = HashMap::new();

        // Must not panic when src= has nothing or end-of-string
        let r1 = rewrite_img_tag("<img src=>", &map1, &map0);
        assert!(!r1.is_empty());

        let r2 = rewrite_img_tag("<img src=", &map1, &map0);
        assert!(!r2.is_empty());

        let r3 = rewrite_img_tag("<img src=\"", &map1, &map0);
        assert!(!r3.is_empty());

        // Multibyte UTF-8 before or inside tag
        let mut map_with_img = HashMap::new();
        map_with_img.insert(1, "images/img_0001.jpg".to_string());
        let r4 = rewrite_img_tag(
            "<img alt=\"Café cr\u{e8}me \u{4f60}\u{597d}\" recindex=\"1\">",
            &map_with_img,
            &map0,
        );
        assert!(r4.contains("src=\"images/img_0001.jpg\""));
    }

    #[test]
    fn test_fix4_filepos_anchors_and_cross_chapter_links() {
        // Multi-chapter HTML with filepos links pointing across chapters
        let ch1 = "<h1>Chapter 1</h1><p><a filepos=\"0000000060\">Go to Ch2</a></p>";
        let pagebreak = "<mbp:pagebreak/>";
        let ch2 = "<h1>Chapter 2</h1><p>Welcome to chapter 2 content.</p>";

        // Target offset points to start of Chapter 2
        let ch2_offset = ch1.len() + pagebreak.len();
        let full_html_with_exact_pos = format!(
            "<h1>Chapter 1</h1><p><a filepos=\"{:010}\">Go to Ch2</a></p>{}{}",
            ch2_offset, pagebreak, ch2
        );

        let chunks = split_into_chapters(&full_html_with_exact_pos);
        assert_eq!(chunks.len(), 2);

        // Ch1 should contain a cross-chapter link to ch_0002.xhtml#filepos_...
        assert!(
            chunks[0].body.contains("ch_0002.xhtml#filepos_"),
            "Ch1 missing cross-chapter link prefix: {}",
            chunks[0].body
        );

        // Ch2 should contain the matching anchor target <span id="filepos_...">
        assert!(
            chunks[1].body.contains("<span id=\"filepos_"),
            "Ch2 missing anchor target: {}",
            chunks[1].body
        );
    }

    #[test]
    fn test_fix5_rewrite_a_tag_no_attr_corruption() {
        // Quoted filepos attribute must not duplicate quote or digits
        let tag1 = "<a filepos=\"12345\" class=\"button\">";
        let rew1 = rewrite_a_tag(tag1);
        assert_eq!(rew1, "<a href=\"#filepos_12345\" class=\"button\">");

        let tag2 = "<a filepos='67890' id=\"link1\">";
        let rew2 = rewrite_a_tag(tag2);
        assert_eq!(rew2, "<a href=\"#filepos_67890\" id=\"link1\">");

        // Unquoted filepos attribute
        let tag3 = "<a filepos=54321 class=\"button\">";
        let rew3 = rewrite_a_tag(tag3);
        assert_eq!(rew3, "<a href=\"#filepos_54321\" class=\"button\">");

        let tag4 = "<a filepos=99999>";
        let rew4 = rewrite_a_tag(tag4);
        assert_eq!(rew4, "<a href=\"#filepos_99999\">");
    }

    #[test]
    fn test_fix6_clean_chapter_body_unclosed_script() {
        let input = "<h1>Title</h1><script>malicious_code();<p>Important paragraph after script</p>";
        let cleaned = clean_chapter_body(input);
        assert!(
            cleaned.contains("Important paragraph after script"),
            "Content following unclosed script was dropped: {}",
            cleaned
        );
        assert!(
            !cleaned.to_ascii_lowercase().contains("<script"),
            "Script tag was not stripped: {}",
            cleaned
        );
    }

    #[test]
    fn test_clean_chapter_body_quote_aware_tag_end() {
        let input = r#"<p><img alt="foo>bar" onerror="alert(1)">Hello</p>"#;
        let cleaned = clean_chapter_body(input);
        assert!(!cleaned.contains("onerror"), "onerror must be stripped: {}", cleaned);
        assert!(cleaned.contains(r#"alt="foo>bar""#), "alt attribute with > was truncated: {}", cleaned);
        assert!(cleaned.contains("Hello"), "tag body text missing: {}", cleaned);
    }

    #[test]
    fn test_clean_chapter_body_case_insensitive_dangerous_tags() {
        let input = "<IFRAME src=\"evil.com\"></IFRAME><OBJECT data=\"bad\"></OBJECT><EMBED src=\"x\"></EMBED><p>Safe</p>";
        let cleaned = clean_chapter_body(input);
        assert!(!cleaned.to_ascii_lowercase().contains("iframe"));
        assert!(!cleaned.to_ascii_lowercase().contains("object"));
        assert!(!cleaned.to_ascii_lowercase().contains("embed"));
        assert!(cleaned.contains("<p>Safe</p>"));
    }

    #[test]
    fn test_fix7_prefix_links_char_boundary_after_rewrite() {
        // Both rewrite branches can leave the cursor immediately before a
        // multi-byte char; the scanner used to slice html[i + 1..] there and
        // panic ("byte index is not a char boundary") on attacker-controlled
        // MOBI content.
        let mut map = HashMap::new();
        map.insert(123usize, "ch_0002.xhtml".to_string());

        // href="#filepos_" branch: digits end directly before 你
        let out1 = prefix_cross_chapter_links("<a href=\"#filepos_123你>", &map);
        assert!(
            out1.contains("href=\"ch_0002.xhtml#filepos_123"),
            "href branch not rewritten: {}",
            out1
        );
        assert!(out1.contains('你'), "multi-byte char dropped: {}", out1);

        // filepos=" branch: closing quote is followed directly by 你
        let out2 = prefix_cross_chapter_links("<a filepos=\"123\"你>", &map);
        assert!(
            out2.contains("href=\"ch_0002.xhtml#filepos_123\""),
            "filepos branch not rewritten: {}",
            out2
        );
        assert!(out2.contains('你'), "multi-byte char dropped: {}", out2);

        // Pure multi-byte text with no markers round-trips untouched.
        assert_eq!(prefix_cross_chapter_links("你好世界", &map), "你好世界");
    }

    #[test]
    fn test_fix8_clean_chapter_body_strips_meta_refresh() {
        let hijack = "<p>Start</p><meta http-equiv=\"refresh\" content=\"0;url=https://evil.example\"><p>End</p>";
        let cleaned = clean_chapter_body(hijack);
        assert!(!cleaned.to_ascii_lowercase().contains("meta"), "meta survived: {}", cleaned);
        assert!(!cleaned.to_ascii_lowercase().contains("evil.example"), "refresh target survived: {}", cleaned);
        assert!(cleaned.contains("<p>Start</p>"));
        assert!(cleaned.contains("<p>End</p>"));

        // Longer tags that merely start with "meta" must be left alone.
        let kept = clean_chapter_body("<metadata><dc:title>x</dc:title></metadata>");
        assert!(kept.contains("<metadata>"), "metadata tag was stripped: {}", kept);

        // Unterminated meta must not wedge the scanner or eat the chapter.
        let unterminated = clean_chapter_body("<p>a</p><meta http-equiv=\"refresh");
        assert!(unterminated.contains("<p>a</p>"), "chapter body lost: {}", unterminated);
        assert!(!unterminated.to_ascii_lowercase().contains("<meta"), "meta prefix survived: {}", unterminated);
    }

    #[test]
    fn test_fix9_clean_chapter_body_escapes_stray_lt() {
        // Prose '<' must become &lt; — served as XHTML, a bare '<' is a
        // fatal parse error that blanks the whole chapter.
        assert_eq!(clean_chapter_body("a < b > c"), "a &lt; b > c");
        let mixed = clean_chapter_body("i<10 <b>bold</b>");
        assert!(mixed.contains("i&lt;10 <b>bold</b>"), "bogus '<10' tag survived: {}", mixed);
        // Real markup still processed.
        assert_eq!(clean_chapter_body("<p>x</p>"), "<p>x</p>");
        // Longer tag names sharing a dangerous prefix are content, not markup.
        assert!(clean_chapter_body("<objects>1</objects>").contains("<objects>"));
        assert!(clean_chapter_body("<scripture>x</scripture>").contains("<scripture>"));
        // <objects> must not trigger the <object close-tag search that ate
        // everything up to a legitimate </object>.
        let mixed_obj = clean_chapter_body("<objects>a</objects><object>evil</object><p>keep</p>");
        assert!(mixed_obj.contains("<objects>a</objects>"), "objects content lost: {}", mixed_obj);
        assert!(!mixed_obj.contains("evil"), "object not stripped: {}", mixed_obj);
        // filepos= in prose stays prose; in markup it rewrites.
        let mut map = HashMap::new();
        map.insert(12345usize, "ch_0002.xhtml".to_string());
        let prose = prefix_cross_chapter_links("<pre>see filepos=12345 for details</pre>", &map);
        assert!(prose.contains("see filepos=12345"), "prose rewritten: {}", prose);
        let markup = prefix_cross_chapter_links("<a filepos=\"12345\">x</a>", &map);
        assert!(markup.contains("href=\"ch_0002.xhtml#filepos_12345\""), "markup not rewritten: {}", markup);
        // A quote '>' inside an img attribute must not truncate the tag —
        // the recindex rewrite still applies.
        let img = rewrite_images_and_links(
            "<img alt=\"Chapter 5 > notes\" recindex=\"1\">",
            &[(1usize, "images/img_0001.jpg".to_string())].into_iter().collect(),
            &HashMap::new(),
        );
        assert!(img.contains("src=\"images/img_0001.jpg\""), "recindex rewrite lost to quoted '>': {}", img);
        // 1600 unclosed iframes (quadratic ci_find) must stay fast — assert
        // completion and correctness; the window bound is the fix.
        let big: String = "<iframe src=x>".repeat(1600) + "<p>tail</p>";
        let cleaned = clean_chapter_body(&big);
        assert_eq!(cleaned, "<p>tail</p>");
        // Run-on unclosed tags (no '>' until far ahead) degrade to the
        // single-tag skip: the giant tag swallows up to the first '>'.
        let runon: String = "<iframe src=x".repeat(1600) + "<p>tail</p>";
        assert_eq!(clean_chapter_body(&runon), "tail</p>");
    }
}


