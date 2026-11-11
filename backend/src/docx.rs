//! Reads WordprocessingML locally. The original DOCX stays unchanged in the vault;
//! these logical pages feed the same lesson parser as PDF text does.

use quick_xml::{events::{BytesStart, Event}, Reader};
use std::io::{Cursor, Read};

const MAX_ENTRIES: usize = 2_000;
const MAX_EXPANDED_BYTES: u64 = 128 * 1024 * 1024;
const MAX_XML_BYTES: u64 = 16 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 16 * 1024 * 1024;
const MAX_PAGES: usize = 2_000;
const WORD_NS: &[u8] = b"http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const STRICT_WORD_NS: &[u8] = b"http://purl.oclc.org/ooxml/wordprocessingml/main";
const CORRUPT: &str = "This file could not be opened as a DOCX document.";
const TOO_LARGE: &str = "This DOCX expands to too much content. Use a smaller document.";

pub fn format_from_name(name: &str) -> &'static str {
    if name.to_ascii_lowercase().ends_with(".docx") { "docx" } else { "pdf" }
}

pub fn content_type(name: &str) -> &'static str {
    if format_from_name(name) == "docx" {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    } else { "application/pdf" }
}

fn read_part(archive: &mut zip::ZipArchive<Cursor<&[u8]>>, name: &str) -> Result<Vec<u8>, String> {
    let entry = archive.by_name(name).map_err(|_| CORRUPT.to_string())?;
    if entry.size() > MAX_XML_BYTES { return Err(TOO_LARGE.into()); }
    let mut bytes = Vec::new();
    entry.take(MAX_XML_BYTES + 1).read_to_end(&mut bytes).map_err(|_| CORRUPT.to_string())?;
    if bytes.len() as u64 > MAX_XML_BYTES { return Err(TOO_LARGE.into()); }
    Ok(bytes)
}

fn attr(element: &BytesStart<'_>, name: &[u8], decoder: quick_xml::encoding::Decoder) -> Result<Option<String>, String> {
    for attribute in element.attributes() {
        let attribute = attribute.map_err(|_| CORRUPT.to_string())?;
        if attribute.key.local_name().as_ref() == name {
            return attribute.decode_and_unescape_value(decoder).map(|v| Some(v.into_owned())).map_err(|_| CORRUPT.to_string());
        }
    }
    Ok(None)
}

fn valid_content_types(xml: &[u8]) -> Result<bool, String> {
    let mut reader = Reader::from_reader(xml);
    let mut valid = false;
    loop {
        match reader.read_event().map_err(|_| CORRUPT.to_string())? {
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == b"Override" => {
                if attr(&e, b"PartName", reader.decoder())?.as_deref() == Some("/word/document.xml")
                    && attr(&e, b"ContentType", reader.decoder())?.as_deref() == Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml") {
                    valid = true;
                }
            }
            Event::DocType(_) => return Err(CORRUPT.into()),
            Event::Eof => return Ok(valid),
            _ => {}
        }
    }
}

#[derive(Default)]
struct TextPages {
    pages: Vec<String>,
    current: String,
    pending_break: bool,
    text_bytes: usize,
}

impl TextPages {
    fn append(&mut self, text: &str) -> Result<(), String> {
        self.text_bytes = self.text_bytes.checked_add(text.len()).ok_or_else(|| TOO_LARGE.to_string())?;
        if self.text_bytes > MAX_TEXT_BYTES { return Err(TOO_LARGE.into()); }
        if self.pending_break && !text.trim().is_empty() {
            if !self.current.trim().is_empty() {
                self.pages.push(std::mem::take(&mut self.current));
                if self.pages.len() >= MAX_PAGES { return Err(TOO_LARGE.into()); }
            }
            self.pending_break = false;
        }
        self.current.push_str(text);
        Ok(())
    }

    fn finish(mut self) -> Vec<String> {
        if !self.current.trim().is_empty() || self.pages.is_empty() { self.pages.push(self.current); }
        self.pages
    }
}

/// DOCX page markers are optional. Adjacent explicit/rendered markers represent
/// one boundary, and unsaved automatic Word pagination is not guessed.
fn text_pages(xml: &[u8], root_name: &[u8]) -> Result<Vec<String>, String> {
    let mut reader = Reader::from_reader(xml);
    let mut out = TextPages::default();
    let mut stack = Vec::<Vec<u8>>::new();
    let mut root_seen = false;
    let mut text_depth = None;
    let mut skip_depth = None;
    let mut section_break = false;
    let mut break_after_paragraph = false;
    loop {
        match reader.read_event().map_err(|_| CORRUPT.to_string())? {
            event @ (Event::Start(_) | Event::Empty(_)) => {
                let empty = matches!(&event, Event::Empty(_));
                let e = match event { Event::Start(e) | Event::Empty(e) => e, _ => unreachable!() };
                let name = e.local_name().as_ref().to_vec();
                if !root_seen {
                    if name != root_name || !e.attributes().any(|a| a.is_ok_and(|a| a.key.as_ref().starts_with(b"xmlns") && (a.value.as_ref() == WORD_NS || a.value.as_ref() == STRICT_WORD_NS))) {
                        return Err(CORRUPT.into());
                    }
                    root_seen = true;
                }
                let depth = stack.len() + 1;
                if depth > 128 { return Err(TOO_LARGE.into()); }
                if skip_depth.is_none() && [b"del".as_slice(), b"moveFrom", b"Fallback"].contains(&name.as_slice()) && !empty {
                    skip_depth = Some(depth);
                }
                if skip_depth.is_none() {
                    match name.as_slice() {
                        b"t" if !empty => text_depth = Some(depth),
                        b"tab" => out.append("\t")?,
                        b"cr" => out.append("\n")?,
                        b"br" => {
                            if attr(&e, b"type", reader.decoder())?.as_deref() == Some("page") { out.pending_break = true; }
                            else { out.append("\n")?; }
                        }
                        b"lastRenderedPageBreak" => out.pending_break = true,
                        b"pageBreakBefore" => {
                            if !matches!(attr(&e, b"val", reader.decoder())?.as_deref(), Some("0" | "false" | "off")) { out.pending_break = true; }
                        }
                        b"sectPr" => section_break = stack.iter().any(|n| n == b"pPr"),
                        b"type" if section_break => {
                            if matches!(attr(&e, b"val", reader.decoder())?.as_deref(), Some("continuous")) { section_break = false; }
                        }
                        _ => {}
                    }
                }
                if !empty { stack.push(name); }
            }
            Event::End(e) => {
                let name = e.local_name();
                let depth = stack.len();
                if stack.last().is_none_or(|n| n.as_slice() != name.as_ref()) { return Err(CORRUPT.into()); }
                if skip_depth == Some(depth) { skip_depth = None; }
                else if skip_depth.is_none() {
                    if text_depth == Some(depth) { text_depth = None; }
                    if name.as_ref() == b"sectPr" && section_break { break_after_paragraph = true; section_break = false; }
                    if name.as_ref() == b"p" {
                        out.append("\n")?;
                        if break_after_paragraph { out.pending_break = true; break_after_paragraph = false; }
                    }
                }
                stack.pop();
            }
            Event::Text(text) if text_depth.is_some() && skip_depth.is_none() => out.append(&text.unescape().map_err(|_| CORRUPT.to_string())?)?,
            Event::CData(text) if text_depth.is_some() && skip_depth.is_none() => out.append(&text.decode().map_err(|_| CORRUPT.to_string())?)?,
            Event::DocType(_) => return Err(CORRUPT.into()),
            Event::Eof => {
                if !root_seen || !stack.is_empty() { return Err(CORRUPT.into()); }
                return Ok(out.finish());
            }
            _ => {}
        }
    }
}

pub fn extract(bytes: &[u8]) -> Result<Vec<String>, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| CORRUPT.to_string())?;
    if archive.len() > MAX_ENTRIES { return Err(TOO_LARGE.into()); }
    let mut expanded = 0u64;
    let mut ancillary = Vec::new();
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|_| CORRUPT.to_string())?;
        expanded = expanded.checked_add(entry.size()).ok_or_else(|| TOO_LARGE.to_string())?;
        if expanded > MAX_EXPANDED_BYTES { return Err(TOO_LARGE.into()); }
        let name = entry.name();
        if (name.starts_with("word/header") || name.starts_with("word/footer")) && name.ends_with(".xml") {
            ancillary.push(name.to_string());
        }
    }
    if !valid_content_types(&read_part(&mut archive, "[Content_Types].xml")?)? { return Err(CORRUPT.into()); }
    let mut pages = text_pages(&read_part(&mut archive, "word/document.xml")?, b"document")?;
    if pages.iter().all(|p| p.trim().is_empty()) {
        return Err("No readable text was found in this DOCX. Save an image-only document as a PDF so it can be read with OCR.".into());
    }
    // The signed location/date can live in a real footer rather than the body.
    // Include each distinct header/footer once without repeating it on every page.
    ancillary.sort();
    let mut seen = std::collections::HashSet::new();
    let mut extra_bytes = 0usize;
    for name in ancillary {
        let kind = if name.starts_with("word/header") { b"hdr".as_slice() } else { b"ftr".as_slice() };
        let text = text_pages(&read_part(&mut archive, &name)?, kind)?.join("\n");
        let text = text.trim();
        extra_bytes += text.len();
        if extra_bytes > MAX_TEXT_BYTES { return Err(TOO_LARGE.into()); }
        if !text.is_empty() && seen.insert(text.to_string()) {
            if kind == b"hdr" { pages[0] = format!("{text}\n{}", pages[0]); }
            else if let Some(last) = pages.last_mut() { last.push('\n'); last.push_str(text); }
        }
    }
    Ok(pages)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn package(body: &str, extras: &[(&str, &str)]) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut bytes);
            let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            let types = r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#;
            let doc = format!(r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>"#);
            for (name, text) in [("[Content_Types].xml", types), ("word/document.xml", doc.as_str())].into_iter().chain(extras.iter().copied()) {
                zip.start_file(name, opts).unwrap(); zip.write_all(text.as_bytes()).unwrap();
            }
            zip.finish().unwrap();
        }
        bytes.into_inner()
    }

    #[test]
    fn joins_split_runs_and_preserves_entities_paragraphs_tables_and_superscript_digits() {
        let file = package(r#"<w:p><w:r><w:t>Paksa: Sample</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Genesis 6:8 T4T</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>8</w:t></w:r><w:r><w:t xml:space="preserve">The watchmen &amp; </w:t></w:r><w:r><w:t>the people.</w:t><w:tab/><w:t>A&#x2019;s</w:t><w:br/><w:t>Next line.</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"#, &[]);
        assert_eq!(extract(&file).unwrap(), vec!["Paksa: Sample\nGenesis 6:8 T4T\n8The watchmen & the people.\tA’s\nNext line.\n"]);
    }

    #[test]
    fn honors_saved_breaks_without_false_properties_or_adjacent_marker_duplicates() {
        let file = package(r#"<w:p><w:pPr><w:pageBreakBefore w:val="0"/></w:pPr><w:r><w:t>First</w:t><w:br w:type="page"/><w:lastRenderedPageBreak/><w:t>Second</w:t></w:r></w:p><w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>Third</w:t></w:r></w:p>"#, &[]);
        assert_eq!(extract(&file).unwrap(), vec!["First", "Second\n", "Third\n"]);
    }

    #[test]
    fn excludes_deleted_and_field_instruction_text_and_reads_header_footer_once() {
        let file = package(r#"<w:p><w:r><w:instrText>HYPERLINK external</w:instrText><w:t>Visible</w:t></w:r><w:del><w:r><w:t>Deleted</w:t></w:r></w:del><w:r><w:t> text.</w:t></w:r></w:p>"#, &[
            ("word/header1.xml", r#"<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Sample Heading</w:t></w:r></w:p></w:hdr>"#),
            ("word/footer1.xml", r#"<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>SAMPLE LOCAL, SAMPLE DISTRICT</w:t></w:r></w:p></w:ftr>"#),
        ]);
        assert_eq!(extract(&file).unwrap(), vec!["Sample Heading\nVisible text.\n\nSAMPLE LOCAL, SAMPLE DISTRICT"]);
    }

    #[test]
    fn rejects_corrupt_archives_invalid_xml_and_image_only_documents() {
        assert!(extract(b"not a zip").is_err());
        assert!(extract(&package("<w:p><w:r>", &[])).is_err());
        assert!(extract(&package("<w:p/>", &[])).unwrap_err().contains("No readable text"));
        assert!(extract(&package(r#"<!DOCTYPE x [<!ENTITY y SYSTEM "file:///secret">]><w:p><w:r><w:t>&y;</w:t></w:r></w:p>"#, &[])).is_err());
    }

    #[test]
    fn rejects_oversized_xml_and_deeply_nested_documents() {
        let huge = "x".repeat(MAX_XML_BYTES as usize + 1);
        assert!(extract(&package(&huge, &[])).unwrap_err().contains("too much content"));
        let nested = format!("{}<w:p><w:r><w:t>Text</w:t></w:r></w:p>{}", "<w:sdt>".repeat(130), "</w:sdt>".repeat(130));
        assert!(extract(&package(&nested, &[])).unwrap_err().contains("too much content"));
    }

    #[test]
    fn format_uses_final_extension_and_correct_mime_type() {
        assert_eq!(format_from_name("Sample.pdf.DOCX"), "docx");
        assert_eq!(format_from_name("Sample.docx.pdf"), "pdf");
        assert!(content_type("Sample.docx").ends_with("wordprocessingml.document"));
        assert_eq!(content_type("Sample.pdf"), "application/pdf");
    }

}
