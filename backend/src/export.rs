//! Word export of a lecture. Verse text always comes from the database, never from the
//! request, and AI context stays labelled until the user has reviewed it.

use std::io::{Cursor, Write};
use zip::write::SimpleFileOptions;

pub struct Item {
    pub objective: String,
    pub reference: String,
    pub version: String,
    pub text: String,
    pub speaker: String,
    pub verse_note: String,
    pub chapter_context: String,
    pub book_context: String,
    pub reviewed: bool,
}

fn escape(text: &str) -> String {
    // Characters that XML 1.0 forbids would make Word refuse the whole file.
    text.chars()
        .filter(|c| matches!(c, '\t' | '\n' | '\r') || *c >= ' ')
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn paragraph(text: &str, size_half_points: u32, bold: bool, italic: bool, space_after: u32) -> String {
    let style = format!("{}{}<w:sz w:val=\"{size_half_points}\"/>", if bold { "<w:b/>" } else { "" }, if italic { "<w:i/>" } else { "" });
    format!(
        "<w:p><w:pPr><w:spacing w:after=\"{space_after}\"/></w:pPr><w:r><w:rPr>{style}</w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
        escape(text)
    )
}

pub fn document(title: &str, issue: &str, objective: &str, items: &[Item]) -> String {
    let mut body = paragraph(title, 36, true, false, 200);
    if !issue.trim().is_empty() {
        body += &paragraph(&format!("Issue: {}", issue.trim()), 22, false, false, 200);
    }
    // Objectives that head a group below need not be listed twice.
    let grouped = items.iter().any(|i| !i.objective.is_empty());
    if !objective.trim().is_empty() && !grouped {
        body += &paragraph(&format!("Objective: {}", objective.trim()), 22, false, false, 200);
    }
    let mut current = "";
    for item in items {
        if item.objective != current && !item.objective.is_empty() {
            body += &paragraph(&item.objective, 26, true, false, 120);
        }
        current = &item.objective;
        let version = if item.version.is_empty() { String::new() } else { format!(" ({})", item.version) };
        body += &paragraph(&format!("{}{version}", item.reference), 24, true, false, 60);
        body += &paragraph(&item.text, 24, false, false, 80);
        let lines: Vec<String> = [
            ("Speaker", &item.speaker),
            ("Verse note", &item.verse_note),
            ("Chapter context", &item.chapter_context),
            ("Book context", &item.book_context),
        ]
        .iter()
        .filter(|(_, text)| !text.is_empty())
        .map(|(name, text)| format!("{name}: {text}"))
        .collect();
        if !lines.is_empty() {
            if !item.reviewed {
                body += &paragraph("AI context, not scripture. Review before use.", 20, true, true, 40);
            }
            for line in &lines {
                body += &paragraph(line, 20, false, true, 40);
            }
            body += &paragraph("", 12, false, false, 120);
        }
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>"#
    )
}

pub fn docx(title: &str, issue: &str, objective: &str, items: &[Item]) -> Result<Vec<u8>, String> {
    const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#;
    const RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#;
    let mut buf = Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(&mut buf);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let doc = document(title, issue, objective, items);
    for (name, content) in [("[Content_Types].xml", CONTENT_TYPES), ("_rels/.rels", RELS), ("word/document.xml", doc.as_str())] {
        zip.start_file(name, opts).map_err(|e| e.to_string())?;
        zip.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(buf.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(objective: &str, reference: &str, reviewed: bool) -> Item {
        Item { objective: objective.into(), reference: reference.into(), version: "ESV".into(), text: "Text & <more>".into(), speaker: "Paul".into(), verse_note: String::new(), chapter_context: "A chapter.".into(), book_context: "A letter.".into(), reviewed }
    }

    #[test]
    fn verses_are_grouped_once_under_each_objective() {
        let doc = document("T", "I", "One\nTwo", &[item("One", "A 1:1", false), item("One", "A 1:2", false), item("Two", "A 1:3", false)]);
        assert_eq!(doc.matches(">One<").count(), 1);
        assert_eq!(doc.matches(">Two<").count(), 1);
        assert!(doc.find(">One<").unwrap() < doc.find("A 1:2").unwrap());
        assert!(doc.find("A 1:2").unwrap() < doc.find(">Two<").unwrap());
        assert!(!doc.contains("Objective: One"));
    }

    #[test]
    fn xml_is_escaped_and_forbidden_characters_removed() {
        let mut i = item("", "A 1:1", true);
        i.text = "a & b < c \u{0001}d".into();
        let doc = document("T & U", "", "", &[i]);
        assert!(doc.contains("a &amp; b &lt; c d"));
        assert!(doc.contains("T &amp; U"));
    }

    #[test]
    fn unreviewed_context_stays_labelled_as_ai() {
        assert!(document("T", "", "", &[item("", "A 1:1", false)]).contains("AI context, not scripture"));
        let reviewed = document("T", "", "", &[item("", "A 1:1", true)]);
        assert!(!reviewed.contains("AI context"));
        assert!(reviewed.contains("Speaker: Paul"));
        assert!(reviewed.contains("Chapter context: A chapter."));
        assert!(reviewed.contains("Book context: A letter."));
    }

    #[test]
    fn the_file_is_a_word_package() {
        let bytes = docx("T", "", "", &[item("", "A 1:1", true)]).unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        for name in ["[Content_Types].xml", "_rels/.rels", "word/document.xml"] {
            assert!(archive.by_name(name).is_ok(), "{name}");
        }
    }
}
