//! Reads verses from an Excel file or a Google Sheet with Translation (or PET), Book, Chapter,
//! Verse and Content columns.
//!
//! Spreadsheets kept by hand carry slips, so each is either corrected in a way that cannot
//! change the meaning and reported, or left for the user to fix. The importer never guesses
//! a reference it cannot be sure of, and the original cell is kept beside the cleaned text.

use crate::books::{self, Book};
use calamine::{Data, Reader, Xlsx};
use regex::Regex;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::io::Cursor;
use std::sync::LazyLock;

const MAX_ROWS: usize = 100_000;

#[derive(Clone, Debug, Default)]
pub struct SheetRow {
    /// The row's number in the spreadsheet, as the user sees it.
    pub row: usize,
    pub translation: String,
    pub book: String,
    pub chapter: String,
    pub verse: String,
    pub content: String,
}

#[derive(Debug)]
pub struct ImportVerse {
    pub row: usize,
    pub canonical_key: String,
    pub book_id: u32,
    pub ref_printed: String,
    pub ref_en: String,
    pub ref_tl: String,
    pub version: String,
    pub language: &'static str,
    pub text: String,
    pub raw: String,
    pub note: String,
}

#[derive(Debug)]
pub struct Issue {
    pub row: usize,
    pub message: String,
}

#[derive(Debug, PartialEq)]
pub struct Fix {
    pub from: String,
    pub to: String,
    pub count: usize,
}

#[derive(Debug, Default)]
pub struct Plan {
    pub rows: usize,
    pub verses: Vec<ImportVerse>,
    /// Rows left out, for the user to fix in the file.
    pub problems: Vec<Issue>,
    /// Rows imported, with a note on the verse asking the user to check them.
    pub flagged: Vec<Issue>,
    pub book_fixes: Vec<Fix>,
    pub translation_fixes: Vec<Fix>,
    /// The same translation, reference and wording repeated in the file.
    pub duplicates: usize,
    /// More than one wording for the same translation and reference. All are kept.
    pub other_wordings: usize,
}

impl Plan {
    pub fn translations(&self) -> Vec<String> {
        self.verses.iter().map(|v| v.version.clone()).collect::<BTreeSet<_>>().into_iter().collect()
    }
}

fn cell_text(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        // Excel stores 12 as 12.0.
        Data::Float(f) if f.fract() == 0.0 => format!("{}", *f as i64),
        other => other.to_string().trim().to_string(),
    }
}

fn column_of(name: &str) -> Option<usize> {
    match name.trim().to_lowercase().as_str() {
        "pet" | "translation" | "version" | "salin" => Some(0),
        "book" | "aklat" => Some(1),
        "chapter" | "kabanata" => Some(2),
        "verse" | "talata" => Some(3),
        "content" | "text" | "nilalaman" => Some(4),
        _ => None,
    }
}

/// The rows below a header, if that header has every column needed. `first_row` is the
/// header's position counting from 0.
fn rows_under_header(table: impl IntoIterator<Item = Vec<String>>, first_row: usize) -> Result<Option<Vec<SheetRow>>, String> {
    let mut table = table.into_iter();
    let Some(header) = table.next() else { return Ok(None) };
    let mut positions = [None::<usize>; 5];
    for (index, cell) in header.iter().enumerate() {
        if let Some(column) = column_of(cell) {
            positions[column].get_or_insert(index);
        }
    }
    let [Some(translation), Some(book), Some(chapter), Some(verse), Some(content)] = positions else { return Ok(None) };
    let at = |cells: &[String], index: usize| cells.get(index).cloned().unwrap_or_default();
    let mut out = Vec::new();
    for (offset, cells) in table.enumerate() {
        if out.len() >= MAX_ROWS {
            return Err(format!("This file has more than {MAX_ROWS} rows."));
        }
        let row = SheetRow {
            // Spreadsheets count from 1, and the header is the row before the first.
            row: first_row + offset + 2,
            translation: at(&cells, translation),
            book: at(&cells, book),
            chapter: at(&cells, chapter),
            verse: at(&cells, verse),
            content: at(&cells, content),
        };
        if !(row.translation.is_empty() && row.book.is_empty() && row.chapter.is_empty() && row.verse.is_empty() && row.content.is_empty()) {
            out.push(row);
        }
    }
    Ok(Some(out))
}

const COLUMNS_NEEDED: &str = "This file needs a sheet with these columns in its first row: Translation (or PET), Book, Chapter, Verse and Content.";

/// The rows of the first sheet that has the expected columns.
pub fn read_workbook(bytes: &[u8]) -> Result<Vec<SheetRow>, String> {
    if !bytes.starts_with(b"PK") {
        return Err("That is not an .xlsx file. In Excel, use Save As and choose Excel Workbook (.xlsx).".into());
    }
    let mut workbook: Xlsx<_> = Xlsx::new(Cursor::new(bytes)).map_err(|_| "This Excel file could not be read. It may be damaged.".to_string())?;
    for name in workbook.sheet_names() {
        let Ok(range) = workbook.worksheet_range(&name) else { continue };
        let first_row = range.start().map_or(0, |(row, _)| row as usize);
        let table = range.rows().map(|cells| cells.iter().map(cell_text).collect::<Vec<_>>());
        if let Some(rows) = rows_under_header(table, first_row)? {
            return Ok(rows);
        }
    }
    Err(COLUMNS_NEEDED.into())
}

/// The rows of a sheet downloaded as CSV. Verse text can run over several lines.
pub fn read_csv(bytes: &[u8]) -> Result<Vec<SheetRow>, String> {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let mut reader = csv::ReaderBuilder::new().has_headers(false).flexible(true).from_reader(bytes);
    let mut table = Vec::new();
    for record in reader.records() {
        let record = record.map_err(|_| "This sheet could not be read.".to_string())?;
        table.push(record.iter().map(str::to_string).collect::<Vec<_>>());
    }
    rows_under_header(table, 0)?.ok_or_else(|| COLUMNS_NEEDED.into())
}

static SHEET_LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/spreadsheets/d/([A-Za-z0-9_-]{20,})").unwrap());
static SHEET_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{20,}$").unwrap());
static GID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[?#&]gid=(\d+)").unwrap());

/// Works out the spreadsheet and tab from what the user entered: a link, a spreadsheet's
/// ID, or the gid alone, which means a tab of the spreadsheet used last. Only letters,
/// digits, "-" and "_" can come out, so this cannot steer the download anywhere else.
pub fn sheet_address(input: &str, remembered: Option<&str>) -> Result<(String, String), String> {
    let input = input.trim();
    if !input.is_empty() && input.len() <= 18 && input.chars().all(|c| c.is_ascii_digit()) {
        return match remembered {
            Some(id) => Ok((id.to_string(), input.to_string())),
            None => Err("A gid only names one tab of a spreadsheet. Paste the whole Google Sheets link the first time. After that, the gid alone is enough.".into()),
        };
    }
    let id = match SHEET_LINK.captures(input) {
        Some(c) => c[1].to_string(),
        None if SHEET_ID.is_match(input) => input.to_string(),
        None => return Err("That is not a Google Sheets link. It should look like docs.google.com/spreadsheets/d/.../edit?gid=0".into()),
    };
    // A link with no tab named opens the first tab, whose gid is 0 unless it was replaced.
    let gid = GID.captures(input).map_or_else(|| "0".to_string(), |c| c[1].to_string());
    Ok((id, gid))
}

static SERIES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(III|II|I|3|2|1)\s+(.+)$").unwrap());
static VERSE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(\d+)\s*(\([a-z]\)|[a-z])?$").unwrap());
static LEADING_NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d+)\s*(.?)").unwrap());
static SPACED_YEAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\S+)\s+(\d{4})$").unwrap());
static TRAILING_YEAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(.*?)(\d{4})$").unwrap());

/// Misspellings that can only mean one book.
const SPELLINGS: &[(&str, &str)] = &[("mathew", "Matthew"), ("malaciah", "Malachi"), ("king", "Kings"), ("corinthian", "Corinthians"), ("thessalonian", "Thessalonians")];
/// Books that need their number. Without it, the name could be any of them.
const NEEDS_NUMBER: &[&str] = &["samuel", "kings", "king", "chronicles", "corinthians", "corinthian", "thessalonians", "thessalonian", "timothy", "peter"];

fn find_book(name: &str) -> Result<&'static Book, String> {
    let (number, rest) = match SERIES.captures(name) {
        Some(c) => {
            let number = match c[1].to_uppercase().as_str() {
                "I" | "1" => 1,
                "II" | "2" => 2,
                _ => 3,
            };
            (Some(number), c[2].to_string())
        }
        None => (None, name.to_string()),
    };
    let lower = rest.to_lowercase();
    let spelled = SPELLINGS.iter().find(|(wrong, _)| *wrong == lower).map_or(rest.as_str(), |(_, right)| right);
    if let Some(book) = books::find(number, spelled) {
        return Ok(book);
    }
    if number.is_none() && NEEDS_NUMBER.contains(&lower.as_str()) {
        return Err(format!("\"{name}\" could be more than one book. Add its number, such as I {name} or II {name}, then import the file again."));
    }
    Err(format!("The book \"{name}\" was not recognized."))
}

/// Removes characters that are invisible when displayed, which copying from web pages and
/// documents leaves behind.
fn strip_invisible(text: &str) -> String {
    text.chars().filter(|c| !matches!(*c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{FEFF}' | '\u{00AD}')).collect::<String>().trim().to_string()
}

/// Verse text often starts with its own number, as printed. It is removed when it is the
/// right number. A different one may mean the row's reference is wrong, so it stays visible
/// and the verse is flagged.
fn split_verse_number(text: &str, verse: &str, part: &str) -> (String, Option<String>) {
    let Some(c) = LEADING_NUMBER.captures(text) else { return (text.to_string(), None) };
    let next = c.get(2).map_or("", |m| m.as_str());
    // "12,000 men" begins with a number, but not a verse number.
    if next.starts_with([',', '.', ':']) {
        return (text.to_string(), None);
    }
    if &c[1] != verse {
        return (text.to_string(), Some(c[1].to_string()));
    }
    let rest = &text[c.get(1).unwrap().end()..];
    // Part of a verse can be printed with its letter too, as "18a" or "18(a)".
    let letter = part.trim_matches(['(', ')']);
    let rest = if letter.is_empty() {
        rest
    } else {
        rest.strip_prefix(part).or_else(|| rest.strip_prefix(&format!("({letter})"))).or_else(|| rest.strip_prefix(letter).filter(|after| after.starts_with(char::is_whitespace))).unwrap_or(rest)
    };
    (rest.trim_start().to_string(), None)
}

fn tally(fixes: BTreeMap<(String, String), usize>) -> Vec<Fix> {
    fixes.into_iter().map(|((from, to), count)| Fix { from, to, count }).collect()
}

pub fn plan(rows: &[SheetRow]) -> Plan {
    let mut plan = Plan { rows: rows.len(), ..Plan::default() };
    let (mut book_fixes, mut translation_fixes) = (BTreeMap::new(), BTreeMap::new());
    let (mut seen, mut wordings) = (HashSet::new(), HashSet::new());
    // The code as typed and as corrected, to spot Excel's drag-fill: copying AMP2015 down a
    // column counts it up as AMP2016, AMP2017 and so on.
    let mut previous: Option<(String, String)> = None;

    for row in rows {
        // The user's codes are kept as typed, apart from the slips fixed here.
        let version = SPACED_YEAR.replace(row.translation.trim(), "$1$2").to_string();
        let drag_filled = TRAILING_YEAR.captures(&version).and_then(|c| {
            let before = c[2].parse::<u32>().ok()?.checked_sub(1)?;
            let (typed_before, corrected) = previous.as_ref()?;
            (*typed_before == format!("{}{before:04}", &c[1])).then(|| corrected.clone())
        });
        let corrected = drag_filled.unwrap_or_else(|| version.clone());
        previous = Some((version, corrected.clone()));

        let mut problem = |message: String| plan.problems.push(Issue { row: row.row, message });
        if corrected.is_empty() {
            problem("This row has no translation.".into());
            continue;
        }
        let book = match find_book(row.book.trim()) {
            Ok(book) => book,
            Err(message) => {
                problem(message);
                continue;
            }
        };
        let chapter = row.chapter.trim();
        let verse = row.verse.trim();
        let parts = VERSE.captures(verse);
        let (Some(parts), true) = (parts, !chapter.is_empty() && chapter.chars().all(|c| c.is_ascii_digit()) && chapter != "0") else {
            problem(format!("The chapter and verse \"{chapter}:{verse}\" were not understood."));
            continue;
        };
        let number = parts[1].to_string();
        let part = parts.get(2).map_or("", |m| m.as_str());
        let cleaned = strip_invisible(&row.content);
        if cleaned.is_empty() {
            problem("This row has no text.".into());
            continue;
        }

        if corrected != row.translation.trim() {
            *translation_fixes.entry((row.translation.trim().to_string(), corrected.clone())).or_insert(0) += 1;
        }
        if row.book.trim() != book.en && row.book.trim() != book.tl {
            *book_fixes.entry((row.book.trim().to_string(), book.en.to_string())).or_insert(0) += 1;
        }

        let (text, other_number) = split_verse_number(&cleaned, &number, part);
        let detected = crate::language::detect(&text);
        let canonical_key = format!("{}.{chapter}:{number}", book.id);
        if !seen.insert((canonical_key.clone(), corrected.clone(), detected.language, text.clone())) {
            plan.duplicates += 1;
            continue;
        }
        if !wordings.insert((canonical_key.clone(), corrected.clone(), detected.language)) {
            plan.other_wordings += 1;
        }
        let mut notes = Vec::new();
        if let Some(found) = other_number {
            notes.push(format!("The text starts with the number {found}, but this row says verse {number}. Check the reference."));
        }
        if !detected.confident {
            notes.push(format!("The language could not be told for certain, so this was filed as {}. Please check it.", if detected.language == "tl" { "Tagalog" } else { "English" }));
        }
        let note = notes.join(" ");
        if !note.is_empty() {
            plan.flagged.push(Issue { row: row.row, message: note.clone() });
        }
        let reference = |name: &str| format!("{name} {chapter}:{number}");
        plan.verses.push(ImportVerse {
            row: row.row,
            canonical_key,
            book_id: book.id,
            ref_printed: format!("{}{part}", reference(book.en)),
            ref_en: reference(book.en),
            ref_tl: reference(book.tl),
            version: corrected,
            language: detected.language,
            text,
            raw: row.content.clone(),
            note,
        });
    }
    plan.book_fixes = tally(book_fixes);
    plan.translation_fixes = tally(translation_fixes);
    plan
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    const TAGALOG: &str = "Si Pablo ay nagturo sa mga tao at hindi siya natakot sa kanila.";
    const ENGLISH: &str = "So we continue to tell all of the people about the one who made them.";

    fn row(number: usize, translation: &str, book: &str, chapter: &str, verse: &str, content: &str) -> SheetRow {
        SheetRow { row: number, translation: translation.into(), book: book.into(), chapter: chapter.into(), verse: verse.into(), content: content.into() }
    }

    fn one(translation: &str, book: &str, chapter: &str, verse: &str, content: &str) -> Plan {
        plan(&[row(2, translation, book, chapter, verse, content)])
    }

    #[test]
    fn a_row_becomes_a_verse_with_the_same_keys_as_a_lesson_citation() {
        let p = one("MSG", "I Peter", "2", "9", &format!("9{TAGALOG}"));
        let v = &p.verses[0];
        let cited = &crate::parser::find_references("I Peter 2:9")[0];
        assert_eq!(v.canonical_key, cited.canonical_key);
        assert_eq!(v.ref_en, cited.en);
        assert_eq!(v.ref_tl, cited.tl);
        assert_eq!(v.version, "MSG");
        assert_eq!(v.language, "tl");
        assert_eq!(v.text, TAGALOG, "the printed verse number is not part of the text");
        assert_eq!(v.raw, format!("9{TAGALOG}"), "the cell is kept as it was");
        assert_eq!(v.note, "");
    }

    #[test]
    fn language_is_read_from_the_words_not_the_translation_code() {
        let p = plan(&[row(2, "MSG", "John", "1", "1", TAGALOG), row(3, "MSG", "John", "1", "1", ENGLISH)]);
        assert_eq!(p.verses[0].language, "tl");
        assert_eq!(p.verses[1].language, "en");
        assert_eq!(p.other_wordings, 0, "one in each language is not a second wording");
    }

    #[test]
    fn a_wrong_leading_number_is_kept_and_flagged() {
        let p = one("NIV", "John", "1", "5", &format!("12{TAGALOG}"));
        assert_eq!(p.verses[0].text, format!("12{TAGALOG}"));
        assert!(p.verses[0].note.contains("number 12"), "{}", p.verses[0].note);
        assert_eq!(p.flagged[0].row, 2);
    }

    #[test]
    fn a_number_that_is_part_of_the_sentence_stays() {
        let (text, other) = split_verse_number("12,000 men went up", "12", "");
        assert_eq!((text.as_str(), other), ("12,000 men went up", None));
    }

    #[test]
    fn invisible_characters_are_removed_from_the_text_only() {
        let content = format!("\u{202A}5{TAGALOG}\u{202C}");
        let p = one("NIV", "John", "1", "5", &content);
        assert_eq!(p.verses[0].text, TAGALOG);
        assert_eq!(p.verses[0].raw, content);
    }

    #[test]
    fn misspelled_book_names_are_corrected_and_reported() {
        for (typed, en) in [("Mathew", "Matthew"), ("Malaciah", "Malachi"), ("I King", "I Kings"), ("I Corinthian", "I Corinthians"), ("I TImothy", "I Timothy"), ("Revelations", "Revelation"), ("Psalm", "Psalms")] {
            let p = one("NIV", typed, "1", "1", TAGALOG);
            assert_eq!(p.verses[0].ref_en, format!("{en} 1:1"), "{typed}");
            assert_eq!(p.book_fixes, vec![Fix { from: typed.into(), to: en.into(), count: 1 }]);
        }
    }

    #[test]
    fn a_tagalog_book_name_is_understood() {
        let p = one("NET", "I Hari", "8", "61", TAGALOG);
        assert_eq!(p.verses[0].ref_en, "I Kings 8:61");
        assert!(p.book_fixes.is_empty(), "this is a correct name, not a slip");
    }

    #[test]
    fn a_book_missing_its_number_is_left_for_the_user() {
        for name in ["Peter", "Corinthians", "Timothy", "Kings", "Samuel"] {
            let p = one("TLB", name, "2", "1", TAGALOG);
            assert!(p.verses.is_empty(), "{name}");
            assert_eq!(p.problems[0].row, 2);
            assert!(p.problems[0].message.contains("could be more than one book"), "{}", p.problems[0].message);
        }
        assert_eq!(one("TLB", "John", "1", "1", TAGALOG).verses[0].ref_en, "John 1:1", "John alone is the Gospel");
    }

    #[test]
    fn an_unknown_book_or_unreadable_reference_is_left_out() {
        assert!(one("NIV", "Hezekiah", "1", "1", TAGALOG).problems[0].message.contains("not recognized"));
        for (chapter, verse) in [("x", "1"), ("0", "1"), ("", "1"), ("1", ""), ("1", "2-3")] {
            let p = one("NIV", "John", chapter, verse, TAGALOG);
            assert!(p.verses.is_empty(), "{chapter}:{verse}");
            assert!(p.problems[0].message.contains("not understood"));
        }
        assert!(one("", "John", "1", "1", TAGALOG).problems[0].message.contains("no translation"));
        assert!(one("NIV", "John", "1", "1", " \u{202A} ").problems[0].message.contains("no text"));
    }

    #[test]
    fn part_of_a_verse_keeps_its_letter_in_the_printed_reference() {
        let p = one("MSG", "Colossians", "1", "18(a)", &format!("18{TAGALOG}"));
        let v = &p.verses[0];
        assert_eq!(v.canonical_key, "51.1:18");
        assert_eq!(v.ref_printed, "Colossians 1:18(a)");
        assert_eq!(v.text, TAGALOG);
    }

    #[test]
    fn the_letter_printed_with_a_part_of_a_verse_is_not_left_in_the_text() {
        for printed in ["18a Ang simula", "18(a) Ang simula", "18 Ang simula"] {
            assert_eq!(split_verse_number(printed, "18", "(a)").0, "Ang simula", "{printed}");
        }
        assert_eq!(split_verse_number("18 at ang huli", "18", "(a)").0, "at ang huli", "a word that starts with the letter stays whole");
    }

    #[test]
    fn excel_drag_fill_of_a_translation_code_is_undone() {
        let rows: Vec<SheetRow> = ["AMP2015", "AMP2016", "AMP2017", "NIV", "KJV2000", "KJV2001"]
            .iter()
            .enumerate()
            .map(|(i, code)| row(i + 2, code, "John", "1", &(i + 1).to_string(), TAGALOG))
            .collect();
        let p = plan(&rows);
        let codes: Vec<&str> = p.verses.iter().map(|v| v.version.as_str()).collect();
        assert_eq!(codes, vec!["AMP2015", "AMP2015", "AMP2015", "NIV", "KJV2000", "KJV2000"]);
        assert_eq!(p.translation_fixes.len(), 3);
        assert_eq!(p.translations(), vec!["AMP2015", "KJV2000", "NIV"]);
    }

    #[test]
    fn a_year_is_not_changed_unless_the_row_above_counts_up_to_it() {
        let p = plan(&[row(2, "NIV", "John", "1", "1", TAGALOG), row(3, "NWT2013", "John", "1", "2", TAGALOG), row(4, "AMP2019", "John", "1", "3", TAGALOG)]);
        assert_eq!(p.verses[1].version, "NWT2013");
        assert_eq!(p.verses[2].version, "AMP2019");
        assert!(p.translation_fixes.is_empty());
    }

    #[test]
    fn a_translation_code_is_not_swapped_for_a_similar_one() {
        let p = one("GNB", "John", "1", "1", TAGALOG);
        assert_eq!(p.verses[0].version, "GNB");
        assert!(p.translation_fixes.is_empty());
    }

    #[test]
    fn a_space_before_the_year_is_the_same_translation() {
        let p = plan(&[row(2, "AMP 2015", "John", "1", "1", TAGALOG), row(3, "AMP2015", "John", "1", "2", TAGALOG)]);
        assert_eq!(p.translations(), vec!["AMP2015"]);
        assert_eq!(p.translation_fixes, vec![Fix { from: "AMP 2015".into(), to: "AMP2015".into(), count: 1 }]);
    }

    #[test]
    fn repeats_are_dropped_and_other_wordings_kept() {
        let other = "Ang mga tao ay nakinig sa kaniya at sila ay natuwa nang labis.";
        let p = plan(&[row(2, "NIV", "John", "1", "1", TAGALOG), row(3, "NIV", "John", "1", "1", &format!("1{TAGALOG}")), row(4, "NIV", "John", "1", "1", other)]);
        assert_eq!(p.verses.len(), 2);
        assert_eq!(p.duplicates, 1);
        assert_eq!(p.other_wordings, 1);
    }

    /// The smallest file Excel's format allows: a real zip with one sheet.
    fn workbook(sheets: &[(&str, &[&[&str]])]) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(&mut buf);
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let mut add = |name: String, body: String| {
            zip.start_file(name, opts).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        };
        add("[Content_Types].xml".into(), r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>"#.into());
        add("_rels/.rels".into(), r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#.into());
        let mut names = String::new();
        let mut links = String::new();
        for (i, (name, rows)) in sheets.iter().enumerate() {
            let n = i + 1;
            names += &format!(r#"<sheet name="{name}" sheetId="{n}" r:id="rId{n}"/>"#);
            links += &format!(r#"<Relationship Id="rId{n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{n}.xml"/>"#);
            let mut data = String::new();
            for (r, cells) in rows.iter().enumerate() {
                data += &format!(r#"<row r="{}">"#, r + 1);
                for (c, cell) in cells.iter().enumerate() {
                    let at = format!("{}{}", (b'A' + c as u8) as char, r + 1);
                    if cell.parse::<f64>().is_ok() {
                        data += &format!(r#"<c r="{at}"><v>{cell}</v></c>"#);
                    } else {
                        data += &format!(r#"<c r="{at}" t="inlineStr"><is><t>{cell}</t></is></c>"#);
                    }
                }
                data += "</row>";
            }
            add(format!("xl/worksheets/sheet{n}.xml"), format!(r#"<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{data}</sheetData></worksheet>"#));
        }
        add("xl/workbook.xml".into(), format!(r#"<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>{names}</sheets></workbook>"#));
        add("xl/_rels/workbook.xml.rels".into(), format!(r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{links}</Relationships>"#));
        zip.finish().unwrap();
        buf.into_inner()
    }

    #[test]
    fn the_right_sheet_and_columns_are_found_and_numbers_read_as_excel_stores_them() {
        let file = workbook(&[
            ("Notes", &[&["Some", "other"], &["sheet", "here"]]),
            ("Verses", &[&["PET", "Book", "Chapter", "Verse", "Content"], &["MSG", "Acts", "11.0", "25", "25Ang talata ay halimbawa"], &["", "", "", "", ""], &["CEV", "Acts", "2", "18(a)", "text"]]),
        ]);
        let rows = read_workbook(&file).unwrap();
        assert_eq!(rows.len(), 2, "the blank row is skipped");
        assert_eq!((rows[0].row, rows[0].translation.as_str(), rows[0].chapter.as_str(), rows[0].verse.as_str()), (2, "MSG", "11", "25"));
        assert_eq!((rows[1].row, rows[1].verse.as_str()), (4, "18(a)"), "row numbers match what the user sees in Excel");
    }

    #[test]
    fn columns_can_be_in_any_order_and_called_translation() {
        let file = workbook(&[("S", &[&["Content", "Verse", "Chapter", "Book", "Translation"], &["words", "3", "2", "John", "NIV"]])]);
        let rows = read_workbook(&file).unwrap();
        assert_eq!((rows[0].translation.as_str(), rows[0].book.as_str(), rows[0].verse.as_str(), rows[0].content.as_str()), ("NIV", "John", "3", "words"));
    }

    const SHEET: &str = "1abcDEFghiJKLmnoPQRstuVWXyz_0123456789-abcd";

    #[test]
    fn a_sheet_is_found_from_a_link_an_id_or_a_gid_alone() {
        let expect = |id: &str, gid: &str| Ok((id.to_string(), gid.to_string()));
        let link = format!("https://docs.google.com/spreadsheets/d/{SHEET}/edit?gid=123#gid=123");
        assert_eq!(sheet_address(&link, None), expect(SHEET, "123"));
        assert_eq!(sheet_address(&format!(" https://docs.google.com/spreadsheets/d/{SHEET}/edit#gid=7 "), Some("other")), expect(SHEET, "7"), "a new link replaces the saved one");
        assert_eq!(sheet_address(&format!("https://docs.google.com/spreadsheets/d/{SHEET}/edit"), None), expect(SHEET, "0"));
        assert_eq!(sheet_address(SHEET, None), expect(SHEET, "0"));
        assert_eq!(sheet_address("1945", Some(SHEET)), expect(SHEET, "1945"));
    }

    #[test]
    fn a_gid_alone_needs_a_spreadsheet_used_before() {
        assert!(sheet_address("0", None).unwrap_err().contains("whole Google Sheets link"));
    }

    #[test]
    fn nothing_but_a_sheet_id_can_reach_the_download_address() {
        for bad in ["", "hello", "https://evil.example/file.csv", "https://docs.google.com/document/d/abc/edit", "../../etc/passwd", "short/../id"] {
            assert!(sheet_address(bad, Some(SHEET)).unwrap_err().contains("not a Google Sheets link"), "{bad}");
        }
        let (id, gid) = sheet_address(&format!("https://docs.google.com/spreadsheets/d/{SHEET}@evil.example/edit?gid=1&x=2"), None).unwrap();
        assert_eq!((id.as_str(), gid.as_str()), (SHEET, "1"));
    }

    #[test]
    fn a_csv_download_reads_the_same_as_excel_with_text_over_several_lines() {
        let csv = "\u{FEFF}PET,Book,Chapter,Verse,Content\nMSG,Acts,11,25,\"25Ang talata, ay\nhalimbawa\"\n,,,,\nCEV,Acts,2,18(a),text\n";
        let rows = read_csv(csv.as_bytes()).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0].row, rows[0].translation.as_str(), rows[0].content.as_str()), (2, "MSG", "25Ang talata, ay\nhalimbawa"));
        assert_eq!((rows[1].row, rows[1].verse.as_str()), (4, "18(a)"));
        assert!(read_csv(b"Name,Age\nA,1\n").unwrap_err().contains("needs a sheet"));
    }

    #[test]
    fn a_file_without_the_columns_or_that_is_not_excel_is_refused() {
        assert!(read_workbook(&workbook(&[("S", &[&["Name", "Age"], &["A", "1"]])])).unwrap_err().contains("needs a sheet"));
        assert!(read_workbook(b"just some text").unwrap_err().contains("not an .xlsx"));
        assert!(read_workbook(b"PK not really a zip").unwrap_err().contains("could not be read"));
    }
}
