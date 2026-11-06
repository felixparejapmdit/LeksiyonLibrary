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
    pub historical_context: String,
    pub reviewed: bool,
    /// Context is in Tagalog, so its labels are too.
    pub tagalog: bool,
}

const ENGLISH_LABELS: &[&str] = &["Speaker", "Verse note", "Chapter context", "Book context", "Historical and political context"];
const TAGALOG_LABELS: &[&str] = &["Nagsasalita", "Tala sa talata", "Konteksto ng kabanata", "Konteksto ng aklat", "Kontekstong pangkasaysayan at pampulitika"];
const TAGALOG_AI_WARNING: &str = "Konteksto mula sa AI, hindi Kasulatan. Suriin bago gamitin.";

fn escape(text: &str) -> String {
    // Characters that XML 1.0 forbids would make Word refuse the whole file.
    text.chars()
        .filter(|c| matches!(c, '\t' | '\n' | '\r') || *c >= ' ')
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[derive(Clone, Copy, Default)]
struct Look {
    size: u32,
    bold: bool,
    italic: bool,
    caps: bool,
    center: bool,
    indent: u32,
    hanging: u32,
    before: u32,
    after: u32,
    serif: bool,
}

fn paragraph(text: &str, look: Look) -> String {
    let font = if look.serif { r#"<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:cs="Georgia"/>"# } else { "" };
    let style = format!(
        "{font}{}{}{}<w:sz w:val=\"{}\"/>",
        if look.bold { "<w:b/>" } else { "" },
        if look.italic { "<w:i/>" } else { "" },
        if look.caps { "<w:caps/>" } else { "" },
        look.size
    );
    let jc = if look.center { r#"<w:jc w:val="center"/>"# } else { "" };
    let ind = if look.indent > 0 || look.hanging > 0 { format!("<w:ind w:left=\"{}\" w:hanging=\"{}\"/>", look.indent, look.hanging) } else { String::new() };
    format!(
        "<w:p><w:pPr><w:spacing w:before=\"{}\" w:after=\"{}\"/>{ind}{jc}</w:pPr><w:r><w:rPr>{style}</w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
        look.before,
        look.after,
        escape(text)
    )
}

fn roman(mut n: usize) -> String {
    let mut out = String::new();
    for (value, digits) in [(10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")] {
        while n >= value {
            out += digits;
            n -= value;
        }
    }
    out
}

fn letter(i: usize) -> String {
    if i < 26 {
        ((b'A' + i as u8) as char).to_string()
    } else {
        format!("{}{}", (b'A' + (i / 26 - 1) as u8) as char, (b'A' + (i % 26) as u8) as char)
    }
}

/// The outline of a lecture, laid out like the lesson PDFs: the title, the issue and the
/// objectives, then a part for each objective. As in a lesson, the first objective is taught
/// in the Introduction (Pasimula), the second in part I., the third in II., and so on, and
/// the verses of a part are lettered A., B., C.
pub fn document(title: &str, issue: &str, objective: &str, items: &[Item], tagalog: bool, with_context: bool) -> String {
    let (issue_word, objectives_word, intro_word, other_word) = if tagalog { ("Isyu", "Mga Layunin", "Pasimula", "Iba pang talata") } else { ("Issue", "Objectives", "Introduction", "Other verses") };
    let base = Look { size: 24, serif: true, after: 60, ..Look::default() };
    let mut body = paragraph(title.trim(), Look { size: 32, bold: true, caps: true, center: true, after: 360, ..base });
    if !issue.trim().is_empty() {
        body += &paragraph(issue_word, Look { bold: true, caps: true, before: 120, ..base });
        body += &paragraph(issue.trim(), Look { after: 200, ..base });
    }
    let objectives: Vec<&str> = objective.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    if !objectives.is_empty() {
        body += &paragraph(objectives_word, Look { bold: true, caps: true, before: 120, ..base });
        for (i, o) in objectives.iter().enumerate() {
            body += &paragraph(&format!("{}.\t{o}", i + 1), Look { indent: 360, hanging: 360, ..base });
        }
    }
    // Parts in the order of the objectives; one no longer listed keeps a part of its own.
    let mut order: Vec<&str> = objectives.clone();
    for item in items {
        if !item.objective.is_empty() && !order.contains(&item.objective.as_str()) {
            order.push(&item.objective);
        }
    }
    let mut parts: Vec<(String, Vec<&Item>)> = order
        .iter()
        .enumerate()
        .map(|(i, o)| {
            let label = if i == 0 { format!("{intro_word}: {o}") } else { format!("{}. {o}", roman(i)) };
            (label, items.iter().filter(|x| x.objective == *o).collect())
        })
        .collect();
    let loose: Vec<&Item> = items.iter().filter(|x| x.objective.is_empty()).collect();
    if !loose.is_empty() {
        parts.push((if order.is_empty() { String::new() } else { other_word.to_string() }, loose));
    }
    for (label, verses) in parts {
        if !label.is_empty() {
            body += &paragraph(&label, Look { bold: true, caps: true, before: 320, after: 160, ..base });
        }
        for (i, item) in verses.iter().enumerate() {
            let version = if item.version.is_empty() { String::new() } else { format!(" {}", item.version) };
            body += &paragraph(&format!("{}.\t{}{version}", letter(i), item.reference), Look { bold: true, italic: true, indent: 720, hanging: 360, before: 120, ..base });
            body += &paragraph(&item.text, Look { size: 23, serif: false, indent: 720, after: 100, ..base });
            if !with_context {
                continue;
            }
            let labels = if item.tagalog { TAGALOG_LABELS } else { ENGLISH_LABELS };
            let lines: Vec<String> = [&item.speaker, &item.verse_note, &item.chapter_context, &item.book_context, &item.historical_context]
                .into_iter()
                .zip(labels)
                .filter(|(text, _)| !text.is_empty())
                .map(|(text, name)| format!("{name}: {text}"))
                .collect();
            if !lines.is_empty() {
                let note = Look { size: 19, italic: true, indent: 720, after: 40, ..base };
                if !item.reviewed {
                    let warning = if item.tagalog { TAGALOG_AI_WARNING } else { "AI context, not scripture. Review before use." };
                    body += &paragraph(warning, Look { bold: true, ..note });
                }
                for line in &lines {
                    body += &paragraph(line, note);
                }
                body += &paragraph("", Look { size: 12, after: 120, ..base });
            }
        }
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1247" w:bottom="1134" w:left="1247" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>"#
    )
}

pub fn docx(title: &str, issue: &str, objective: &str, items: &[Item], tagalog: bool, with_context: bool) -> Result<Vec<u8>, String> {
    const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#;
    const RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#;
    let mut buf = Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(&mut buf);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let doc = document(title, issue, objective, items, tagalog, with_context);
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
        Item { objective: objective.into(), reference: reference.into(), version: "ESV".into(), text: "Text & <more>".into(), speaker: "Paul".into(), verse_note: String::new(), chapter_context: "A chapter.".into(), book_context: "A letter.".into(), historical_context: "Under Rome.".into(), reviewed, tagalog: false }
    }

    #[test]
    fn the_outline_follows_a_lesson_title_issue_objectives_then_parts() {
        let doc = document("T", "I", "One\nTwo", &[item("One", "A 1:1", false), item("One", "A 1:2", false), item("Two", "A 1:3", false)], false, true);
        let at = |s: &str| doc.find(s).unwrap_or_else(|| panic!("{s} missing"));
        assert!(at(">T<") < at(">Issue<") && at(">Issue<") < at(">Objectives<"));
        assert!(at(">1.\tOne<") < at(">2.\tTwo<"));
        // The first objective is taught in the Introduction, the second in part I.
        assert!(at(">Objectives<") < at(">Introduction: One<"));
        assert!(at(">Introduction: One<") < at(">A.\tA 1:1 ESV<"));
        assert!(at(">B.\tA 1:2 ESV<") < at(">I. Two<"));
        assert!(at(">I. Two<") < at(">A.\tA 1:3 ESV<"));
        assert!(doc.contains("Chapter context: A chapter."));
    }

    #[test]
    fn context_is_left_out_unless_asked_for_and_headings_follow_the_language() {
        let doc = document("T", "I", "One", &[item("One", "A 1:1", false)], true, false);
        assert!(doc.contains(">Isyu<") && doc.contains(">Mga Layunin<") && doc.contains(">Pasimula: One<"));
        assert!(!doc.contains("A chapter.") && !doc.contains("Paul"));
        let loose = document("T", "", "", &[item("", "A 1:1", false)], false, false);
        assert!(!loose.contains("Other verses") && loose.contains(">A.\tA 1:1 ESV<"));
        assert_eq!(roman(4), "IV");
        assert_eq!(letter(27), "AB");
    }

    #[test]
    fn xml_is_escaped_and_forbidden_characters_removed() {
        let mut i = item("", "A 1:1", true);
        i.text = "a & b < c \u{0001}d".into();
        let doc = document("T & U", "", "", &[i], false, true);
        assert!(doc.contains("a &amp; b &lt; c d"));
        assert!(doc.contains("T &amp; U"));
    }

    #[test]
    fn unreviewed_context_stays_labelled_as_ai() {
        assert!(document("T", "", "", &[item("", "A 1:1", false)], false, true).contains("AI context, not scripture"));
        let reviewed = document("T", "", "", &[item("", "A 1:1", true)], false, true);
        assert!(!reviewed.contains("AI context"));
        assert!(reviewed.contains("Speaker: Paul"));
        assert!(reviewed.contains("Chapter context: A chapter."));
        assert!(reviewed.contains("Book context: A letter."));
        assert!(reviewed.contains("Historical and political context: Under Rome."));
    }

    #[test]
    fn tagalog_context_gets_tagalog_labels_and_keeps_its_warning() {
        let mut i = item("", "A 1:1", false);
        i.tagalog = true;
        let doc = document("T", "", "", &[i], false, true);
        assert!(doc.contains("Konteksto mula sa AI, hindi Kasulatan"));
        assert!(doc.contains("Konteksto ng kabanata: A chapter."));
        assert!(doc.contains("Kontekstong pangkasaysayan at pampulitika: Under Rome."));
        assert!(!doc.contains("Book context"));
    }

    #[test]
    fn the_file_is_a_word_package() {
        let bytes = docx("T", "", "", &[item("", "A 1:1", true)], false, true).unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        for name in ["[Content_Types].xml", "_rels/.rels", "word/document.xml"] {
            assert!(archive.by_name(name).is_ok(), "{name}");
        }
    }
}
