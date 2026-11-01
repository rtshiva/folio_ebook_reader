//! MOBI / AZW / AZW3 unpacker and EPUB converter for Folio Reader.
//!
//! Converts DRM-free Mobipocket (MOBI 6/7) and Kindle Format 8 (KF8/AZW3)
//! files into standard OEBPS / XHTML packages stored in the Folio cache directory,
//! allowing `epub.js` to render them seamlessly with zero frontend overhead.

use crate::{BookManifest, ManifestFile};
use std::collections::HashMap;
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

pub fn parse_exth_and_metadata(
    rec0: &[u8],
    mobi_hdr: &MobiHeader,
    fallback_title: &str,
) -> ExtractedMetadata {
    let mut meta = ExtractedMetadata {
        title: fallback_title.to_string(),
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
        && mobi_hdr.title_offset + mobi_hdr.title_len <= rec0.len()
    {
        let raw_title = &rec0[mobi_hdr.title_offset..mobi_hdr.title_offset + mobi_hdr.title_len];
        let t = if mobi_hdr.encoding == 1252 {
            cp1252_to_utf8(raw_title)
        } else {
            String::from_utf8_lossy(raw_title).to_string()
        };
        let trimmed = t.trim();
        if !trimmed.is_empty() {
            meta.title = trimmed.to_string();
        }
    }

    // EXTH header begins immediately after the MOBI header
    if (mobi_hdr.exth_flags & 0x40) != 0 {
        let exth_start = 16 + mobi_hdr.header_len;
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
                        let a = String::from_utf8_lossy(r_data).trim().to_string();
                        if !a.is_empty() {
                            meta.author = a;
                        }
                    }
                    101 => {
                        // Publisher
                        meta.publisher = Some(String::from_utf8_lossy(r_data).trim().to_string());
                    }
                    103 => {
                        // Description
                        meta.description = Some(String::from_utf8_lossy(r_data).trim().to_string());
                    }
                    104 => {
                        // ISBN
                        meta.isbn = Some(String::from_utf8_lossy(r_data).trim().to_string());
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
                        let t = String::from_utf8_lossy(r_data).trim().to_string();
                        if !t.is_empty() {
                            meta.title = t;
                        }
                    }
                    524 => {
                        // Language
                        let l = String::from_utf8_lossy(r_data).trim().to_string();
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
    if (flags & 1) != 0 {
        if data.len() > num {
            let last_byte = data[data.len() - num - 1];
            num = num.saturating_add(((last_byte & 0x03) as usize) + 1);
        }
    }
    num
}

/// Strips the trailing entry sequence from a compressed MOBI text record.
pub fn strip_trailing_entries<'a>(data: &'a [u8], flags: u16) -> &'a [u8] {
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
    let mut out = Vec::with_capacity(data.len() * 2);
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
                // PalmDOC LZ77 compression
                let chunk = decompress_palmdoc(stripped)?;
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
            &ch.body
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
            if let Some(tag_end_rel) = html[i..].find('>') {
                let tag_end = i + tag_end_rel + 1;
                let tag_str = &html[i..tag_end];
                let tag_lower = tag_str.to_lowercase();

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
                        let self_closed = format!("{}/>", &tag_str[..tag_str.len() - 1].trim_end());
                        out.push_str(&self_closed);
                        i = tag_end;
                        continue;
                    }
                }
            }
        }
        let next_tag = html[i + 1..].find('<').map(|p| i + 1 + p).unwrap_or(html.len());
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
    let lower = tag.to_lowercase();
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
            if let Ok(num) = usize::from_str_radix(&digits, 10)
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
                        while let Some(q) = chars.next() {
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
        let clean_lower = clean.to_lowercase();
        let final_tag = if let Some(src_pos) = clean_lower.find("src=") {
            let quote = clean[src_pos + 4..].chars().next().unwrap_or('"');
            let end_quote = clean[src_pos + 5..]
                .find(if quote == '\'' { '\'' } else { '"' })
                .map(|p| src_pos + 5 + p + 1)
                .unwrap_or(clean.len().saturating_sub(1));
            format!("{}src=\"{}\"{}", &clean[..src_pos], new_src, &clean[end_quote..])
        } else {
            let insert_pos = clean.rfind('>').unwrap_or(clean.len());
            let trimmed = clean[..insert_pos].trim_end_matches('/');
            format!("{} src=\"{}\"/>", trimmed.trim_end(), new_src)
        };

        if !final_tag.ends_with("/>") && final_tag.ends_with('>') {
            format!("{}/>", &final_tag[..final_tag.len() - 1].trim_end())
        } else {
            final_tag
        }
    } else if !tag.ends_with("/>") && tag.ends_with('>') {
        format!("{}/>", &tag[..tag.len() - 1].trim_end())
    } else {
        tag.to_string()
    }
}

/// Helper to rewrite an `<a filepos="...">` link into `<a href="#filepos_...">`.
fn rewrite_a_tag(tag: &str) -> String {
    let lower = tag.to_lowercase();
    if let Some(pos) = lower.find("filepos=") {
        let rest = &tag[pos + 8..];
        let digits: String = rest
            .chars()
            .skip_while(|&c| c == '"' || c == '\'')
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if !digits.is_empty() {
            let end_pos = pos + 8 + rest.find(|c: char| c == '"' || c == '\'' || c.is_ascii_whitespace() || c == '>').unwrap_or(0);
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

/// Splits raw HTML into chapters and cleans up tags.
pub fn split_into_chapters(html: &str) -> Vec<ChapterChunk> {
    let mut parts: Vec<&str> = Vec::new();
    let lower = html.to_lowercase();
    let mut last_end = 0usize;

    // Scan for pagebreak markers
    let mut i = 0usize;
    while i < html.len() {
        if lower[i..].starts_with("<mbp:pagebreak")
            || lower[i..].starts_with("<pagebreak")
            || lower[i..].starts_with("<div style=\"page-break-before:always\"")
        {
            if let Some(close) = html[i..].find('>') {
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
        i += 1;
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
            if lower[pos..].starts_with("<h1") || lower[pos..].starts_with("<h2") {
                if pos > sub_last && (pos - sub_last) > 30 * 1024 {
                    let chunk = html[sub_last..pos].trim();
                    if !chunk.is_empty() {
                        sub_parts.push(chunk);
                    }
                    sub_last = pos;
                }
            }
            pos += 1;
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

    let mut result = Vec::with_capacity(parts.len());
    for (idx, &part) in parts.iter().enumerate() {
        let title = extract_chapter_title(part, idx + 1);
        let cleaned_body = clean_chapter_body(part);
        result.push(ChapterChunk {
            title,
            body: cleaned_body,
        });
    }

    result
}

/// Extracts a chapter title from the first heading tag or defaults to Chapter N.
fn extract_chapter_title(text: &str, num: usize) -> String {
    let lower = text.to_lowercase();
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
    let lower = tag.to_lowercase();
    if !lower.contains(" on")
        && !lower.contains("javascript:")
        && !lower.contains("vbscript:")
        && !lower.contains("data:text/html")
    {
        return tag.to_string();
    }
    let is_self_closing = tag.ends_with("/>");
    let inner = if is_self_closing {
        &tag[1..tag.len() - 2]
    } else {
        &tag[1..tag.len() - 1]
    };
    let tag_name = inner.split_whitespace().next().unwrap_or("");
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
        let attr_name = &trimmed[..name_end];
        let after_name = trimmed[name_end..].trim_start();
        if after_name.starts_with('=') {
            let after_eq = after_name[1..].trim_start();
            if after_eq.starts_with('"') {
                let val_end = after_eq[1..].find('"').map(|idx| idx + 2).unwrap_or(after_eq.len());
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
            } else if after_eq.starts_with('\'') {
                let val_end = after_eq[1..].find('\'').map(|idx| idx + 2).unwrap_or(after_eq.len());
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

/// Cleans legacy Mobipocket tags and repairs void tags for XML compliance,
/// while stripping scripts, dangerous embeds, and event handlers.
fn clean_chapter_body(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 128);
    let mut i = 0usize;

    while i < text.len() {
        if text[i..].starts_with('<') {
            let lower_rem = text[i..].to_lowercase();
            // Completely strip script tags and their inner content
            if lower_rem.starts_with("<script") {
                if let Some(close_idx) = lower_rem.find("</script") {
                    if let Some(end_gt) = text[i + close_idx..].find('>') {
                        i = i + close_idx + end_gt + 1;
                        continue;
                    }
                }
                break;
            }
            // Completely strip iframe, object, embed tags
            let mut stripped_tag = false;
            for dangerous_tag in &["<iframe", "<object", "<embed"] {
                if lower_rem.starts_with(dangerous_tag) {
                    let close_tag = format!("</{}", &dangerous_tag[1..]);
                    if let Some(close_idx) = lower_rem.find(&close_tag) {
                        if let Some(end_gt) = text[i + close_idx..].find('>') {
                            i = i + close_idx + end_gt + 1;
                            stripped_tag = true;
                            break;
                        }
                    } else if let Some(self_close) = text[i..].find('>') {
                        i = i + self_close + 1;
                        stripped_tag = true;
                        break;
                    }
                }
            }
            if stripped_tag {
                continue;
            }

            if let Some(close) = text[i..].find('>') {
                let tag_end = i + close + 1;
                let tag = &text[i..tag_end];
                let tag_lower = tag.to_lowercase();

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
                    let repaired = format!("{}/>", &tag[..tag.len() - 1].trim_end());
                    out.push_str(&sanitize_html_tag(&repaired));
                    i = tag_end;
                    continue;
                }

                out.push_str(&sanitize_html_tag(tag));
                i = tag_end;
                continue;
            }
        }

        let next_tag = text[i + 1..].find('<').map(|p| i + 1 + p).unwrap_or(text.len());
        out.push_str(&text[i..next_tag]);
        i = next_tag;
    }

    out
}
