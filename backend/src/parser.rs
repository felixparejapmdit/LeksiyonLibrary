//! Turns per-page lesson text (from a PDF text layer or OCR) into structured
//! metadata and verse records. It never invents text: anything it cannot find
//! is left empty, and all extracted verses start out as unverified.

use crate::books;
use regex::Regex;
use std::sync::LazyLock;

#[derive(Debug, Clone, Default)]
pub struct ParsedVerse {
    pub canonical_key: String,
    pub book_id: u32,
    pub ref_printed: String,
    pub ref_en: String,
    pub ref_tl: String,
    pub version: String,
    pub text: String,
    pub raw: String,
    pub page: u32,
    /// The part of the lesson the verse is printed in: 0 before the lesson proper, 1 the
    /// beginning (Pasimula), 2 for I., 3 for II. and so on, `CONCLUSION` for the conclusion.
    /// Objective n of a lesson is taught in section n.
    pub section: u32,
    /// The question the verse answers, when the section asks one before it.
    pub question: String,
    /// The language of the verse's own wording, which can differ from the lesson's: a
    /// lesson may print a verse in English followed by its Tagalog translation.
    pub language: String,
}

pub const CONCLUSION: u32 = 99;

/// A headed part of the lesson and the questions it asks.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Section {
    pub number: u32,
    pub heading: String,
    pub questions: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ParsedLesson {
    pub title: String,
    pub category: String,
    pub language: String,
    pub lesson_date: Option<String>,
    pub date_label: String,
    pub year: Option<i32>,
    pub location: String,
    pub local_congregation: String,
    pub district: String,
    pub author: String,
    pub code: String,
    pub issue: String,
    pub objectives: Vec<String>,
    pub content: String,
    pub verses: Vec<ParsedVerse>,
    pub outline: Vec<Section>,
    /// Lines that cite a verse whose book could not be read, such as a scan's "Xyq: 4:9 ABC".
    /// Their verses are left out rather than guessed, and the user is told so they can add them.
    pub unread: Vec<Unread>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Unread {
    pub page: u32,
    pub text: String,
}

macro_rules! re {
    ($name:ident, $pat:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($pat).unwrap());
    };
}

re!(LEAD_NOISE, r#"^(?:[.,;:'"”“’‘|_~\-—]+\s+)+"#);
re!(LEAD_S, r#"^[sS]\s+(?:[A-Z0-9'“”])"#);
re!(TRAIL_NOISE, r#"(?:\s+[.,;:'"”’|_~\-—*]+)+$"#);
re!(
    DATE_LINE,
    r"(?i)^(?:day/day|[a-z]+day/[a-z]+day|[a-z]+/[a-z]+)\s*:\s*\S.*$"
);
re!(
    HEADER_LINE,
    r"(?i)^(?:teacher.?s guide|gabay sa tagapagturo|page \d+|pahina \d+)\b"
);
re!(
    DATE_PARTS,
    r"([A-Za-z]+)\s+(\d{1,2})(?:\s*/\s*\d{1,2})?,\s*(\d{4})"
);
re!(STRAY_PREFIX, r"^[A-Za-z@]\s+");
re!(LEADER, r"\.{3,}");
re!(LABEL_START, r"^(?:\d+|[SA])\.\s+\S");
re!(
    REFERENCE,
    r"(?x)
    (?P<num>(?:\b(?:III|Ill|lll|II|Il|IL|ll|IT|11|I|1|2|3)|[\[|])\s*)?
    (?P<book>[A-Za-z]+(?:\s+ng\s+mga\s+Awit)?)
    [.,]?\s*
    (?P<ch>\d{1,3}):
    (?P<vs>\d{1,3}(?:\s?\([a-z]\)|[a-z]\b)?(?:\s*-\s*\d{1,3}(?:\s?\([a-z]\)|[a-z]\b)?)?
       (?:\s*(?:,|&|\bat\b|\band\b)\s*\d{1,3}(?:\s?\([a-z]\)|[a-z]\b)?(?:\s*-\s*\d{1,3}(?:\s?\([a-z]\)|[a-z]\b)?)?)*)"
);
re!(TALATA, r"(?i)^(?:talata|verse|scripture)\s*:\s*");
re!(
    BULLET,
    r"^(?:[-.,|]\s+)?(?:B®|HB|BE|HM|BB|MM|B|E|M|m|H|W|@|■|▪|•|®|©)\s*[_]?\s+\S"
);
re!(
    STOP_LINE,
    r"(?i)^(?:[TSQA]\.\s|\d+\.\s|[IVX]+\.\s+[A-Z]{2}|(?:konklusyon|conclusion|pasimula|introduction)\s*(?::.*)?$|\(aawitin|\(sing)"
);
// The signature block at the end of a lesson: "LINGGO: ENERO 10, 2021 BY:".
re!(SIGNATURE, r"(?i)(?:\bby\s*:\s*$|^by\s*:|^[a-z]+\s*:\s*[a-z]+\s+\d{1,2}(?:/\d{1,2})?,\s*\d{4})");
re!(
    CITATION,
    r"(?i)^(?:\(?(?:the\s+)?holy bible\b|\((?:the|holy)\b.*\b(?:bible|testament)\b)"
);
re!(VERSION_HINT, r"(?i)\b(?:version|bible|translation|edition|bersiyon|biblia)\b");
re!(VERSION_CODE, r"^[A-Z][A-Z0-9]{1,5}\d{0,4}$");
// A version printed alone after a reference standing on its own line, such as "Lamsa".
re!(VERSION_WORD, r"^[A-Z][A-Za-z0-9]{1,6}\d{0,4}$");
// A citation whose book is unreadable: a word ending in a stop, then chapter:verse and a version.
re!(UNREAD_CITATION, r"(\S+[.:,])\s*(\d{1,3})\s*:\s*(\d{1,3}[a-z]?(?:\s*-\s*\d{1,3})?)\s+([A-Z][A-Z0-9]{1,7})\s*$");
re!(DATE_PREFIX, r"^(\d{4})(\d{2})(\d{2})_");
re!(FOOTER_DATE, r"(?i)^(?:lunes|martes|miyerkules|huwebes|biyernes|sabado|linggo|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s*:\s*([a-z]+)\s+(\d{1,2})(?:\s*/\s*\d{1,2})?,\s*(\d{4})(?:\s+(by\s*:.*))?\s*$");
re!(LOCATION_PART, r"^[\p{L}\p{N}][\p{L}\p{N}\s.'’()&/\-]*$");
re!(ISSUE_MARK, r"(?i)^(?:isyu|issu[ea]|lssue)\s*:?$");
re!(OBJECTIVE_MARK, r"(?i)^(?:mga\s+layunin|objectives?)\s*:?$");
re!(INTRO_MARK, r"(?i)^(?:panimula|exordium)\s*:?$");
re!(PAKSA, r"(?i)^(?:paksa|topic|subject)\s*:\s*(.+)$");
re!(NUMBERED, r#"^[”"'.]*(\d+)\.\s+(.*)$"#);
re!(WEEK_CODE, r"(?i)(\d{4})_wk(\d{1,2})([ab])");
re!(PV_NAME, r"^(\d{4})(\d{2})(\d{2})_([^_]+)_(.+)$");
re!(
    AUTHOR_NAME,
    r"\b([A-Z][A-Z]+(?:\s+[A-Z]\.)?\s+[A-Z][A-Z]+(?:\s+(?:JR|SR|III)\.?)?)\s*$"
);
re!(BY_LINE, r"(?i)^by\s*:\s*(.+)$");
re!(BEGIN_MARK, r"(?i)^(?:pasimula|introduction|simula|beginning)\s*(?::\s*(.*))?$");
re!(ROMAN_HEAD, r"^(IX|IV|VI{0,3}|I{1,3}|X)\s*\.\s+(\S.*)$");
re!(CONCLUSION_MARK, r"(?i)^(?:konklusyon|conclusion|pangwakas)\s*(?::\s*(.*))?$");
re!(QUESTION, r"^[QT]\s*\.\s+(\S.*)$");
re!(ANSWER, r"^[AS]\s*\.\s+\S");

const MAX_OUTLINE_CHARS: usize = 240;

fn roman_value(s: &str) -> u32 {
    let mut total = 0i32;
    let digits: Vec<i32> = s.chars().map(|c| match c { 'I' => 1, 'V' => 5, 'X' => 10, _ => 0 }).collect();
    for (i, d) in digits.iter().enumerate() {
        if digits.get(i + 1).is_some_and(|n| n > d) { total -= d } else { total += d }
    }
    total.max(0) as u32
}

fn clip(s: &str) -> String {
    s.chars().take(MAX_OUTLINE_CHARS).collect::<String>().trim().to_string()
}

/// A heading or question with the lines that continue it, when printed over more than one line.
/// Headings are printed in capitals, so only a line in capitals continues one.
fn with_continuation(lines: &[(u32, String)], from: usize, first: &str, capitals_only: bool) -> String {
    let mut out = first.trim().to_string();
    for (_, next) in lines.iter().skip(from).take(2) {
        let letters: Vec<char> = next.chars().filter(|c| c.is_alphabetic()).collect();
        let capitals = letters.iter().filter(|c| c.is_uppercase()).count() * 10 >= letters.len() * 8;
        if out.ends_with('?') || (capitals_only && !capitals) || is_verse_terminator(next) || citation_ref(next).is_some() || ANSWER.is_match(next) || BEGIN_MARK.is_match(next) || ROMAN_HEAD.is_match(next) {
            break;
        }
        out.push(' ');
        out.push_str(next);
    }
    out
}

/// A line opening a new part of the lesson, as (section number, heading).
fn section_start(line: &str, current: u32) -> Option<(u32, String)> {
    if current == CONCLUSION {
        return None;
    }
    if let Some(c) = CONCLUSION_MARK.captures(line) {
        return Some((CONCLUSION, c.get(1).map_or("", |m| m.as_str()).trim().to_string()));
    }
    if let Some(c) = BEGIN_MARK.captures(line) {
        // Said again later, it is a word in the lesson, not a new part.
        return (current == 0).then(|| (1, c.get(1).map_or("", |m| m.as_str()).trim().to_string()));
    }
    let c = ROMAN_HEAD.captures(line)?;
    if citation_ref(line).is_some() {
        return None;
    }
    // After the first heading the parts go in order: OCR often misreads III as II.
    let number = if current == 0 { roman_value(&c[1]) + 1 } else { current + 1 };
    Some((number, c[2].trim().to_string()))
}

/// Known translations: every alias maps to a canonical short code.
static VERSIONS: &[(&str, &[&str])] = &[
    ("ESV", &["esv", "english standard version"]),
    ("NIRV", &["nirv", "new international reader's version", "new international readers version"]),
    ("GNT", &["gnt", "gnb", "good news bible", "good news translation"]),
    ("ETRV1999", &["etrv1999", "easy-to-read version 1999 edition", "easy-to-read 1999 edition"]),
    ("ETRV", &["etrv", "easy-to-read version"]),
    ("EXB", &["exb", "expanded bible", "the expanded bible"]),
    ("LDB", &["ldb", "last days bible"]),
    ("NLV", &["nlv", "new life version"]),
    ("AMP", &["amp", "amplified bible", "the amplified bible"]),
    ("MB2012", &["mb2012", "magandang balita 2012"]),
    ("KJV", &["kjv", "king james version"]),
    ("NKJV", &["nkjv", "new king james version"]),
    ("NIV", &["niv", "new international version"]),
    ("NLT", &["nlt", "new living translation"]),
    ("ISV", &["isv", "international standard version"]),
];

/// The printed code T4T is sometimes read as TAT. Apply only this known OCR slip
/// when displaying older records, including verified ones whose stored metadata is locked.
/// Other user-supplied translation codes keep their own spelling.
pub fn correct_version_code(raw: &str) -> String {
    if raw.trim().eq_ignore_ascii_case("TAT") || raw.trim().eq_ignore_ascii_case("T4T") {
        "T4T".to_string()
    } else {
        raw.to_string()
    }
}

pub fn normalize_version(raw: &str) -> String {
    let cleaned = correct_version_code(&raw.trim().trim_matches(|c: char| ",.;:".contains(c)).replace('’', "'"));
    let lower = cleaned.to_lowercase();
    if lower.is_empty() {
        return String::new();
    }
    for (code, aliases) in VERSIONS {
        if aliases.iter().any(|a| *a == lower) {
            return (*code).to_string();
        }
    }
    // An unknown code may be printed in capitals or not ("LAMSA", "Lamsa"): one spelling keeps them together.
    if VERSION_WORD.is_match(&cleaned) {
        return cleaned.to_uppercase();
    }
    cleaned
}

fn clean_line(line: &str) -> String {
    let mut s = line.trim().to_string();
    loop {
        let before = s.len();
        s = LEAD_NOISE.replace(&s, "").to_string();
        if LEAD_S.is_match(&s) {
            s = s[1..].trim_start().to_string();
        }
        s = TRAIL_NOISE.replace(&s, "").to_string();
        if s.len() == before {
            break;
        }
    }
    s.trim().to_string()
}

fn is_noise(line: &str) -> bool {
    !line.is_empty() && line.chars().filter(|c| c.is_alphanumeric()).count() == 0
}

#[derive(Debug, Clone)]
pub struct Reference {
    pub canonical_key: String,
    pub book_id: u32,
    pub printed: String,
    pub en: String,
    pub tl: String,
    pub end: usize,
}

fn normalize_segments(vs: &str) -> String {
    let lowered = vs.to_lowercase();
    let unified = Regex::new(r"\s*(?:,|&|\bat\b|\band\b)\s*").unwrap().replace_all(&lowered, ",");
    unified.replace(' ', "")
}

fn pretty_segments(key_segments: &str, joiner: &str) -> String {
    key_segments.split(',').collect::<Vec<_>>().join(joiner)
}

/// Finds the scripture references in a piece of text.
pub fn find_references(text: &str) -> Vec<Reference> {
    let mut out = Vec::new();
    for m in REFERENCE.captures_iter(text) {
        let whole = m.get(0).unwrap();
        let raw_num = m.name("num").map(|n| n.as_str());
        let raw_book = m.name("book").unwrap().as_str();
        let (num, name) = split_series(raw_num, raw_book);
        // A stray mark misread as a numeral before a book that has no series.
        let Some(book) = books::find(num, &name).or_else(|| num.and_then(|_| books::find(None, &name))) else {
            continue;
        };
        let chapter = &m["ch"];
        let segments = normalize_segments(&m["vs"]);
        out.push(Reference {
            canonical_key: format!("{}.{}:{}", book.id, chapter, segments),
            book_id: book.id,
            printed: whole.as_str().trim().to_string(),
            en: format!("{} {}:{}", book.en, chapter, pretty_segments(&segments, " & ")),
            tl: format!("{} {}:{}", book.tl, chapter, pretty_segments(&segments, " at ")),
            end: whole.end(),
        });
    }
    out
}

/// Resolves series numbers, including the OCR run-together form "IPed." while
/// leaving real names such as "Isa." intact.
fn split_series(raw_num: Option<&str>, raw_book: &str) -> (Option<u32>, String) {
    // OCR reads II as "Il", "IL", "ll", "IT" or "11", III as "Ill", and I as "[" or "|".
    let to_num = |s: &str| match s.trim() {
        "I" | "1" | "[" | "|" => Some(1),
        "II" | "Il" | "IL" | "ll" | "IT" | "11" | "2" => Some(2),
        "III" | "Ill" | "lll" | "3" => Some(3),
        _ => None,
    };
    if let Some(n) = raw_num {
        let spaced = n.ends_with(char::is_whitespace);
        let digit = n.trim().chars().all(|c| c.is_ascii_digit());
        let rest_upper = raw_book.chars().next().is_some_and(|c| c.is_uppercase());
        if spaced || digit || rest_upper {
            return (to_num(n), raw_book.to_string());
        }
        return (None, format!("{}{}", n.trim(), raw_book));
    }
    (None, raw_book.to_string())
}

fn is_version_continuation(line: &str) -> bool {
    let words = line.split_whitespace().count();
    words <= 7 && (VERSION_HINT.is_match(line) || VERSION_CODE.is_match(line.trim()))
}

fn is_verse_terminator(line: &str) -> bool {
    BULLET.is_match(line) || STOP_LINE.is_match(line) || CITATION.is_match(line) || SIGNATURE.is_match(line)
}

/// A line ending in chapter:verse and a version, whose book is not one this app knows. Times
/// such as "10:30 AM" are not citations.
fn unread_citation(line: &str) -> Option<String> {
    let c = UNREAD_CITATION.captures(line)?;
    if ["AM", "PM", "NN"].contains(&&c[4]) || !find_references(line).is_empty() {
        return None;
    }
    Some(line[c.get(1)?.start()..].trim().to_string())
}

/// A line that cites a verse printed underneath it: "label ..... II Sam. 7:24 ESV".
fn citation_ref(line: &str) -> Option<(Reference, String)> {
    let leader_end = LEADER.find_iter(line).last().map(|m| m.end());
    let talata = TALATA.find(line).map(|m| m.end());
    let start = match (leader_end, talata) {
        (Some(e), _) => e,
        (None, Some(e)) => e,
        (None, None) => {
            let refs = find_references(line);
            // OCR can garble the dot leader, but a numbered or answer label
            // ending in a reference is still a citation line.
            if LABEL_START.is_match(line) {
                if let Some(last) = refs.last() {
                    let rest = line[last.end..].trim();
                    if rest.is_empty() || is_version_continuation(rest) {
                        return Some((last.clone(), rest.to_string()));
                    }
                }
            }
            // Bare line: only accept when the reference opens the line.
            let first = refs.first()?;
            if !line.starts_with(&first.printed) {
                return None;
            }
            let rest = line[first.end..].trim();
            let is_version_only = rest.is_empty() || is_version_continuation(rest) || VERSION_WORD.is_match(rest);
            return is_version_only.then(|| (first.clone(), rest.to_string()));
        }
    };
    let tail = &line[start..];
    let refs = find_references(tail);
    let last = refs.last()?;
    let rest = tail[last.end..].trim().to_string();
    Some((last.clone(), rest))
}

fn join_verse_lines(lines: &[String]) -> String {
    let mut out = String::new();
    for l in lines {
        if out.ends_with('-') && out.len() > 1 && l.chars().next().is_some_and(|c| c.is_alphabetic()) {
            out.push_str(l);
        } else {
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(l);
        }
    }
    out
}

fn smart_title(raw: &str) -> String {
    let letters: Vec<char> = raw.chars().filter(|c| c.is_alphabetic()).collect();
    let uppercase = letters.iter().filter(|c| c.is_uppercase()).count();
    if letters.is_empty() || uppercase * 10 < letters.len() * 8 {
        return raw.trim().to_string();
    }
    const SMALL: &[&str] = &[
        "a", "an", "and", "as", "at", "by", "in", "is", "of", "on", "or",
        "the", "to", "ang", "ay", "kaya", "mga", "na", "ng", "ni", "pa", "sa", "ito",
    ];
    raw.split_whitespace()
        .enumerate()
        .map(|(i, w)| {
            let lower = w.to_lowercase();
            if i > 0 && SMALL.contains(&lower.as_str()) {
                return lower;
            }
            let mut cs = lower.chars();
            match cs.next() {
                Some(c) => c.to_uppercase().collect::<String>() + cs.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn month_number(name: &str) -> Option<u32> {
    const MONTHS: &[(&[&str], u32)] = &[
        (&["january", "enero"], 1),
        (&["february", "pebrero"], 2),
        (&["march", "marso"], 3),
        (&["april", "abril"], 4),
        (&["may", "mayo"], 5),
        (&["june", "hunyo"], 6),
        (&["july", "hulyo"], 7),
        (&["august", "agosto"], 8),
        (&["september", "setyembre"], 9),
        (&["october", "oktubre"], 10),
        (&["november", "nobyembre"], 11),
        (&["december", "disyembre"], 12),
    ];
    let lower = name.to_lowercase();
    MONTHS.iter().find(|(names, _)| names.contains(&lower.as_str())).map(|(_, n)| *n)
}

/// The two names are kept separately, while the original location remains useful for older
/// filenames and screens. Only an unambiguous pair is accepted; prose and dates are not places.
pub fn split_location(location: &str) -> Option<(String, String)> {
    let (local, district) = location.split_once(',')?;
    let clean = |part: &str| part.split_whitespace().collect::<Vec<_>>().join(" ");
    let (local, district) = (clean(local), clean(district));
    if [&local, &district].iter().any(|part| {
        part.chars().count() > 120 || part.chars().filter(|c| c.is_alphabetic()).count() < 2 || !LOCATION_PART.is_match(part)
    }) {
        return None;
    }
    Some((title_name(&local), title_name(&district)))
}

#[derive(Default)]
struct FooterMetadata {
    date: Option<String>,
    year: Option<i32>,
    date_label: String,
    location: Option<(String, String)>,
}

/// Pastoral visit footers print the local and district immediately after the date on the
/// last written page. Do not pick up comma-separated prose elsewhere in the lesson.
fn footer_metadata(pages: &[String]) -> FooterMetadata {
    let Some(page) = pages.iter().rev().find(|p| p.chars().any(char::is_alphanumeric)) else { return FooterMetadata::default() };
    let lines: Vec<String> = page.lines().map(clean_line).filter(|l| !l.is_empty() && !is_noise(l)).collect();
    for i in (lines.len().saturating_sub(20)..lines.len()).rev() {
        let Some(c) = FOOTER_DATE.captures(&lines[i]) else { continue };
        let (Some(month), Ok(day), Ok(year)) = (month_number(&c[1]), c[2].parse::<u32>(), c[3].parse::<i32>()) else { continue };
        if !(1900..=2200).contains(&year) || chrono::NaiveDate::from_ymd_opt(year, month, day).is_none() {
            continue;
        }
        // A comma in an author's name after "BY:" is not a congregation/district pair.
        let location = c.get(4).is_none().then(|| lines.get(i + 1)).flatten().and_then(|next| {
            split_location(next).or_else(|| {
                if next.trim_end().ends_with(',') {
                    lines.get(i + 2).and_then(|district| split_location(&format!("{next} {district}")))
                } else {
                    None
                }
            })
        });
        return FooterMetadata { date: Some(format!("{year:04}-{month:02}-{day:02}")), year: Some(year), date_label: lines[i].clone(), location };
    }
    FooterMetadata::default()
}

/// Small words that only one of the two languages uses, counted to tell them apart.
const EN_WORDS: &[&str] = &[
    "the", "of", "and", "to", "that", "is", "we", "god", "for", "with", "you", "your", "will", "be", "are", "they", "in",
    "not", "shall", "he", "his", "who", "from", "have", "but", "this",
];
const TL_WORDS: &[&str] = &[
    "ang", "ng", "sa", "mga", "na", "ay", "natin", "diyos", "kaya", "kayo", "ako", "siya", "hindi", "ninyo", "nila", "ito",
    "upang", "kung", "nang", "inyong", "kanilang", "subalit", "ating",
];

fn word_counts(lines: &[String]) -> (usize, usize) {
    let (mut en, mut tl) = (0, 0);
    for line in lines {
        for w in line.split(|c: char| !c.is_alphabetic()) {
            let w = w.to_lowercase();
            if EN_WORDS.contains(&w.as_str()) {
                en += 1;
            } else if TL_WORDS.contains(&w.as_str()) {
                tl += 1;
            }
        }
    }
    (en, tl)
}

/// The language of some lines, when it is clear: three in four of their small words are
/// English or Tagalog. A bracketed English gloss in a Tagalog verse does not change it.
fn clear_language(lines: &[String]) -> Option<&'static str> {
    let (en, tl) = word_counts(lines);
    let total = en + tl;
    if total < 4 {
        return None;
    }
    if en * 4 >= total * 3 {
        Some("en")
    } else if tl * 4 >= total * 3 {
        Some("tl")
    } else {
        None
    }
}

/// A verse printed in one language and then translated into the other is two verses: the
/// lines are split where the language changes, if both parts are clearly in their language.
fn split_by_language(lines: &[String]) -> Vec<(Option<&'static str>, Vec<String>)> {
    let lean: Vec<i64> = lines.iter().map(|l| { let (en, tl) = word_counts(std::slice::from_ref(l)); en as i64 - tl as i64 }).collect();
    let best = (1..lines.len()).max_by_key(|&k| (lean[..k].iter().sum::<i64>() - lean[k..].iter().sum::<i64>()).abs());
    if let Some(k) = best {
        let (first, second) = (clear_language(&lines[..k]), clear_language(&lines[k..]));
        if let (Some(a), Some(b)) = (first, second) {
            if a != b {
                return vec![(first, lines[..k].to_vec()), (second, lines[k..].to_vec())];
            }
        }
    }
    vec![(clear_language(lines), lines.to_vec())]
}

fn detect_language(text: &str) -> String {
    const TL: &[&str] = &["ang", "ng", "sa", "mga", "na", "ay", "at", "natin", "diyos", "kaya"];
    const EN: &[&str] = &["the", "of", "and", "to", "that", "is", "we", "god", "for", "with"];
    let (mut tl, mut en) = (0, 0);
    for w in text.split(|c: char| !c.is_alphabetic()) {
        let w = w.to_lowercase();
        if TL.contains(&w.as_str()) {
            tl += 1;
        } else if EN.contains(&w.as_str()) {
            en += 1;
        }
    }
    if tl > en { "tl".into() } else { "en".into() }
}

pub fn parse(pages: &[String], file_name: &str) -> ParsedLesson {
    let mut lesson = ParsedLesson { category: String::new(), ..Default::default() };
    let without_docx = if file_name.to_ascii_lowercase().ends_with(".docx") { &file_name[..file_name.len() - 5] } else { file_name };
    let stem = if without_docx.to_ascii_lowercase().ends_with(".pdf") { &without_docx[..without_docx.len() - 4] } else { without_docx };

    let mut lines: Vec<(u32, String)> = Vec::new();
    for (idx, page) in pages.iter().enumerate() {
        let mut header_zone = true;
        let mut seen = 0;
        for raw in page.lines() {
            let line = clean_line(raw);
            if line.is_empty() || is_noise(&line) {
                continue;
            }
            seen += 1;
            if header_zone && seen <= 4 {
                // Scanner specks are often read as a stray letter before the header.
                let probe = STRAY_PREFIX.replace(&line, "").to_string();
                if DATE_LINE.is_match(&probe) && DATE_PARTS.is_match(&probe) || probe.to_lowercase().starts_with("day/day") {
                    if lesson.date_label.is_empty() {
                        lesson.date_label = probe;
                    }
                    continue;
                }
                if HEADER_LINE.is_match(&probe) {
                    continue;
                }
            }
            header_zone = false;
            lines.push((idx as u32 + 1, line));
        }
    }

    lesson.content = pages.join("\n\n");
    lesson.language = detect_language(&lesson.content);

    let footer = footer_metadata(pages);
    if lesson.date_label.is_empty() {
        lesson.date_label = footer.date_label.clone();
        lesson.lesson_date = footer.date;
        lesson.year = footer.year;
    }

    // Date.
    if let Some(c) = DATE_PARTS.captures(&lesson.date_label) {
        if let Some(mon) = month_number(&c[1]) {
            let day: u32 = c[2].parse().unwrap_or(1);
            let year: i32 = c[3].parse().unwrap_or(0);
            lesson.lesson_date = Some(format!("{year:04}-{mon:02}-{day:02}"));
            lesson.year = Some(year);
        }
    }

    // Category from the printed day names.
    let label = lesson.date_label.to_lowercase();
    if label.contains("saturday") || label.contains("sunday") || label.contains("sabado") || label.contains("linggo") {
        lesson.category = "weekend".into();
    } else if label.contains("wednesday") || label.contains("thursday") || label.contains("miyerkules") || label.contains("huwebes") {
        lesson.category = "midweek".into();
    }

    // Naming conventions: 2026_Wk30b and 20150425_Sampleville, Testland_Title.
    if let Some(c) = WEEK_CODE.captures(stem) {
        lesson.code = format!("{}_Wk{}{}", &c[1], &c[2], c[3].to_lowercase());
        if lesson.year.is_none() {
            lesson.year = c[1].parse().ok();
        }
        if lesson.category.is_empty() {
            lesson.category = if c[3].eq_ignore_ascii_case("a") { "midweek".into() } else { "weekend".into() };
        }
    }
    if let Some(c) = PV_NAME.captures(stem) {
        lesson.category = "pastoral".into();
        lesson.location = c[4].trim().to_string();
        lesson.code = stem.to_string();
        if lesson.lesson_date.is_none() {
            lesson.lesson_date = Some(format!("{}-{}-{}", &c[1], &c[2], &c[3]));
            lesson.year = c[1].parse().ok();
        }
    }
    if let Some((local, district)) = footer.location.or_else(|| split_location(&lesson.location)) {
        lesson.location = format!("{local}, {district}");
        lesson.local_congregation = local;
        lesson.district = district;
        lesson.category = "pastoral".into();
    }
    // A file named from its date, such as 20210110_Sample Visit.
    if let (None, Some(c)) = (&lesson.lesson_date, DATE_PREFIX.captures(stem)) {
        let (year, month, day) = (c[1].parse::<i32>().unwrap_or(0), c[2].parse::<u32>().unwrap_or(0), c[3].parse::<u32>().unwrap_or(0));
        if (1900..=2200).contains(&year) && (1..=12).contains(&month) && (1..=31).contains(&day) {
            lesson.lesson_date = Some(format!("{year:04}-{month:02}-{day:02}"));
            lesson.year = Some(year);
        }
    }
    if lesson.content.to_lowercase().contains("pastoral visit") {
        lesson.category = "pastoral".into();
    }
    if lesson.category.is_empty() {
        lesson.category = "weekend".into();
    }

    // Title, issue, objectives.
    let issue_at = lines.iter().position(|(_, l)| ISSUE_MARK.is_match(l));
    let obj_at = lines.iter().position(|(_, l)| OBJECTIVE_MARK.is_match(l));
    let intro_at = lines.iter().position(|(_, l)| INTRO_MARK.is_match(l));
    let begin_at = lines.iter().position(|(_, l)| BEGIN_MARK.is_match(l));

    let paksa = lines.iter().find_map(|(_, l)| PAKSA.captures(l).map(|c| c[1].trim().to_string()));
    lesson.title = if let Some(p) = paksa {
        smart_title(&p)
    } else if let Some(i) = issue_at.filter(|i| *i > 0 && *i <= 5) {
        smart_title(&lines[..i].iter().map(|(_, l)| l.as_str()).collect::<Vec<_>>().join(" "))
    } else if let Some(b) = begin_at.filter(|b| *b > 0 && *b <= 3 && issue_at.is_none()) {
        // A lesson without an issue, such as a pastoral visit, opens with its title and then the beginning.
        smart_title(&lines[..b].iter().map(|(_, l)| l.as_str()).collect::<Vec<_>>().join(" "))
    } else if let Some(c) = PV_NAME.captures(stem) {
        c[5].trim().to_string()
    } else {
        stem.replace('_', " ")
    };

    if let (Some(i), Some(o)) = (issue_at, obj_at) {
        if o > i {
            lesson.issue = join_verse_lines(&lines[i + 1..o].iter().map(|(_, l)| l.clone()).collect::<Vec<_>>());
        }
    }
    if let (Some(o), Some(end)) = (obj_at, intro_at) {
        if end > o {
            let mut items: Vec<String> = Vec::new();
            for (_, l) in &lines[o + 1..end] {
                if let Some(c) = NUMBERED.captures(l) {
                    items.push(c[2].to_string());
                } else if let Some(last) = items.last_mut() {
                    last.push(' ');
                    last.push_str(l);
                }
            }
            lesson.objectives = items;
        }
    }

    // Author from the signature block near the end.
    for (i, (_, l)) in lines.iter().enumerate().rev() {
        if let Some(c) = BY_LINE.captures(l) {
            lesson.author = c[1].trim().to_string();
            break;
        }
        if l.trim_end().ends_with("BY:") {
            if let Some((_, next)) = lines.get(i + 1) {
                if let Some(c) = AUTHOR_NAME.captures(next) {
                    lesson.author = title_name(&c[1]);
                }
            }
            break;
        }
    }

    // Verses, and the part of the lesson and question each one is printed under.
    // Headings are looked for only after the objectives, which are numbered too.
    let outline_from = obj_at.map_or(0, |o| o + 1);
    let (mut section, mut question) = (0u32, String::new());
    let mut i = 0;
    while i < lines.len() {
        let (page, line) = &lines[i];
        if i >= outline_from {
            if let Some((number, heading)) = section_start(line, section) {
                // "PASIMULA:" alone on its line is followed by its question, printed in capitals.
                let heading = with_continuation(&lines, i + 1, &heading, true);
                section = number;
                question.clear();
                lesson.outline.push(Section { number, heading: clip(&heading), questions: vec![] });
                i += 1;
                continue;
            }
            if let Some(c) = QUESTION.captures(line) {
                question = clip(&with_continuation(&lines, i + 1, &c[1], false));
                if lesson.outline.last().is_none_or(|s| s.number != section) {
                    lesson.outline.push(Section { number: section, ..Default::default() });
                }
                if let Some(s) = lesson.outline.last_mut() {
                    s.questions.push(question.clone());
                }
            }
        }
        let Some((reference, rest)) = citation_ref(line) else {
            if let Some(m) = unread_citation(line) {
                lesson.unread.push(Unread { page: *page, text: m });
            }
            i += 1;
            continue;
        };
        i += 1;
        let mut version_raw = rest;
        if let Some((_, next)) = lines.get(i) {
            if citation_ref(next).is_none() && is_version_continuation(next) && !is_verse_terminator(next) {
                if !version_raw.is_empty() {
                    version_raw.push(' ');
                }
                version_raw.push_str(next);
                i += 1;
            }
        }
        let is_talata = TALATA.is_match(line);
        let mut collected: Vec<String> = Vec::new();
        if !is_talata {
            while let Some((_, next)) = lines.get(i) {
                if is_verse_terminator(next) || citation_ref(next).is_some() {
                    break;
                }
                collected.push(next.clone());
                i += 1;
            }
        }
        let version = normalize_version(&version_raw);
        for (language, part) in split_by_language(&collected) {
            lesson.verses.push(ParsedVerse {
                canonical_key: reference.canonical_key.clone(),
                book_id: reference.book_id,
                ref_printed: reference.printed.clone(),
                ref_en: reference.en.clone(),
                ref_tl: reference.tl.clone(),
                version: version.clone(),
                raw: part.join("\n"),
                text: join_verse_lines(&part),
                page: *page,
                section,
                question: question.clone(),
                language: language.map_or_else(|| lesson.language.clone(), str::to_string),
            });
        }
    }

    lesson
}

fn title_name(raw: &str) -> String {
    raw.split_whitespace()
        .map(|w| {
            if w.len() <= 2 && w.ends_with('.') {
                return w.to_string();
            }
            let mut cs = w.to_lowercase().chars().collect::<Vec<_>>();
            if let Some(c) = cs.first_mut() {
                *c = c.to_uppercase().next().unwrap_or(*c);
            }
            cs.into_iter().collect()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real sample lessons are sensitive, so their text and what they should parse to
    /// live in a private folder outside the repository. Without it these tests are skipped.
    fn sample(prefix: &str) -> Option<(Vec<String>, serde_json::Value)> {
        let dir = std::env::var("LV_SAMPLES").unwrap_or_else(|_| format!("{}/../../LeksiyonLibrary-private", env!("CARGO_MANIFEST_DIR")));
        let pages = (1..=6)
            .map(|i| std::fs::read_to_string(format!("{dir}/fixtures/{prefix}_{i}.txt")).ok())
            .collect::<Option<Vec<_>>>()?;
        let expected = serde_json::from_str(&std::fs::read_to_string(format!("{dir}/samples.json")).ok()?).ok()?;
        Some((pages, expected))
    }

    fn text<'a>(v: &'a serde_json::Value, key: &str) -> &'a str {
        v[key].as_str().unwrap_or_else(|| panic!("samples.json is missing {key}"))
    }

    #[test]
    fn references_cover_ocr_and_tagalog_forms() {
        let cases = [
            ("II Sam. 7:24", "10.7:24"),
            ("II Hari 5:15", "12.5:15"),
            ("IPed. 2:9-10", "60.2:9-10"),
            ("PS, 138:7-8 & 2", "19.138:7-8,2"),
            ("Awit 138:7-8 at 2", "19.138:7-8,2"),
            ("Isa. 65:17-19", "23.65:17-19"),
            ("Apoc. 14:10-11(a)", "66.14:10-11(a)"),
            ("Juan 15:16", "43.15:16"),
            ("Mat. 24:36 at 44", "40.24:36,44"),
            ("I Tesalonica 5:1-6", "52.5:1-6"),
            ("2 Timoteo 3:1-5", "55.3:1-5"),
            ("Efeso 4:1-3", "49.4:1-3"),
            ("I Cor. 15:58", "46.15:58"),
        ];
        for (input, key) in cases {
            let found = find_references(input);
            assert_eq!(found.len(), 1, "no reference in {input}");
            assert_eq!(found[0].canonical_key, key, "wrong key for {input}");
        }
    }

    #[test]
    fn citation_survives_a_garbled_leader() {
        let page = "1. What we should do xsuccessuusnussuoursna: PS, 138:7-8 & 2 AMP\nThough I walk in trouble.\nB Next point here".to_string();
        let l = parse(&[page], "x.pdf");
        assert_eq!(l.verses.len(), 1);
        assert_eq!(l.verses[0].canonical_key, "19.138:7-8,2");
        assert_eq!(l.verses[0].version, "AMP");
        assert_eq!(l.verses[0].text, "Though I walk in trouble.");
    }

    #[test]
    fn prose_ending_in_a_reference_is_not_a_citation() {
        let page = "The Bible says so plainly in the book of Juan 15:16\nMore prose follows here".to_string();
        assert!(parse(&[page], "x.pdf").verses.is_empty());
    }

    #[test]
    fn t4t_is_recognized_in_citations_and_its_known_ocr_alias_is_corrected() {
        for code in ["T4T", "TAT"] {
            for citation in [format!("II Cor. 4:18 {code}"), format!("II Cor. 4:18\n{code}"), format!("1. Ang hindi nakikita ........ II Cor. 4:18 {code}")] {
                let page = format!("ANG HALIMBAWA\nPASIMULA:\n{citation}\nAng mga bagay na hindi nakikita ay walang hanggan.");
                let lesson = parse(&[page], "20210213_Sample.pdf");
                assert_eq!(lesson.verses.len(), 1, "{citation}");
                let verse = &lesson.verses[0];
                assert_eq!(verse.canonical_key, "47.4:18", "{citation}");
                assert_eq!(verse.version, "T4T", "{citation}");
                assert_eq!(verse.text, "Ang mga bagay na hindi nakikita ay walang hanggan.", "the code must not enter scripture text: {citation}");
            }
        }
        assert_eq!(normalize_version(" t4t. "), "T4T");
        assert_eq!(correct_version_code("TATI"), "TATI", "only the exact OCR alias is corrected");
        assert_eq!(correct_version_code("GNB"), "GNB", "other translations keep their own code");
    }

    #[test]
    fn non_books_are_not_references() {
        assert!(find_references("Meeting at 10:30 today").is_empty());
        assert!(find_references("Ratio 3:1").is_empty());
    }

    #[test]
    fn english_sample_metadata_and_verses() {
        let Some((pages, all)) = sample("en") else { return };
        let want = &all["en"];
        let l = parse(&pages, "sample-en.pdf");
        assert_eq!(l.language, "en");
        assert_eq!(l.category, text(&all, "category"));
        assert_eq!(l.lesson_date.as_deref(), Some(text(&all, "lessonDate")));
        assert!(l.title.starts_with(text(want, "row")), "{}", l.title);
        assert_eq!(l.objectives.len(), 4);
        assert!(l.issue.starts_with(text(want, "issueStart")), "{}", l.issue);
        assert_eq!(l.author, text(&all, "author"));
        let keys: Vec<&str> = l.verses.iter().map(|v| v.canonical_key.as_str()).collect();
        let want_keys: Vec<&str> = all["verseKeys"].as_array().unwrap().iter().map(|k| k.as_str().unwrap()).collect();
        assert_eq!(keys, want_keys);
        let versions: Vec<&str> = l.verses.iter().map(|v| v.version.as_str()).collect();
        let want_versions: Vec<&str> = want["versions"].as_array().unwrap().iter().map(|k| k.as_str().unwrap()).collect();
        assert_eq!(versions, want_versions);
        assert!(l.verses[0].text.starts_with(text(want, "firstVerseStart")), "{}", l.verses[0].text);
        assert!(l.verses[0].text.ends_with(text(want, "firstVerseEnd")), "{}", l.verses[0].text);
        // The verse text crosses a page break and must exclude the running header.
        assert!(l.verses[1].text.starts_with(text(want, "secondVerseStart")), "{}", l.verses[1].text);
        assert!(l.verses[1].text.ends_with(text(want, "secondVerseEnd")), "{}", l.verses[1].text);
        assert_sections_follow_the_objectives(&l);
        for v in &l.verses {
            assert!(!v.text.is_empty(), "empty text for {}", v.ref_printed);
            assert!(v.text.len() < 1200, "runaway capture for {}: {}", v.ref_printed, v.text);
            assert!(!v.text.contains("Holy Bible") && !v.text.contains("Publish") && !v.text.contains("Nashville"), "citation leaked into {}", v.ref_printed);
        }
    }

    #[test]
    fn tagalog_sample_metadata_and_verses() {
        let Some((pages, all)) = sample("tl") else { return };
        let want = &all["tl"];
        let l = parse(&pages, "sample-tl.pdf");
        assert_eq!(l.language, "tl");
        assert_eq!(l.category, text(&all, "category"));
        assert_eq!(l.lesson_date.as_deref(), Some(text(&all, "lessonDate")));
        assert!(l.title.starts_with(text(want, "row")), "{}", l.title);
        assert_eq!(l.objectives.len(), 4);
        let keys: Vec<&str> = l.verses.iter().map(|v| v.canonical_key.as_str()).collect();
        let want_keys: Vec<&str> = all["verseKeys"].as_array().unwrap().iter().map(|k| k.as_str().unwrap()).collect();
        assert_eq!(keys, want_keys);
        for (i, version) in want["versions"].as_object().unwrap() {
            assert_eq!(l.verses[i.parse::<usize>().unwrap()].version, version.as_str().unwrap());
        }
        assert!(l.verses[0].text.starts_with(text(want, "firstVerseStart")), "{}", l.verses[0].text);
        assert!(l.verses[0].text.ends_with(text(want, "firstVerseEnd")), "{}", l.verses[0].text);
        assert_sections_follow_the_objectives(&l);
        for v in &l.verses {
            assert!(!v.text.is_empty(), "empty text for {}", v.ref_printed);
            assert!(v.text.len() < 1200, "runaway capture for {}: {}", v.ref_printed, v.text);
        }
    }

    /// The sample lessons teach objective n in part n: the beginning, then I., II. and III.
    fn assert_sections_follow_the_objectives(l: &ParsedLesson) {
        let numbers: Vec<u32> = l.outline.iter().map(|s| s.number).collect();
        for n in 1..=l.objectives.len() as u32 {
            assert!(numbers.contains(&n), "part {n} not found: {numbers:?}");
            assert!(l.verses.iter().any(|v| v.section == n), "no verse in part {n}");
        }
        let order: Vec<u32> = l.verses.iter().map(|v| v.section).collect();
        assert!(order.windows(2).all(|w| w[0] <= w[1]), "parts out of order: {order:?}");
        assert!(l.outline.iter().filter(|s| (1..=4).contains(&s.number)).all(|s| s.number == 1 || !s.heading.is_empty()), "a numbered part has no heading");
    }

    #[test]
    fn outline_format_extracts_references_without_inventing_text() {
        let page = "HALIMBAWA\nPaksa: Ang Halimbawa ng Pagbabantay\nI. Tanong: Bakit?\n1. Aponte: Sapagkat\nTalata: 1 Tesalonica 5:1-6\nTalata: Mateo 24:42-44 MB2012\n".to_string();
        let l = parse(&[page], "2025_Wk42a.pdf");
        assert_eq!(l.code, "2025_Wk42a");
        assert_eq!(l.category, "midweek");
        assert_eq!(l.title, "Ang Halimbawa ng Pagbabantay");
        assert_eq!(l.verses.len(), 2);
        assert_eq!(l.verses[0].canonical_key, "52.5:1-6");
        assert_eq!(l.verses[0].text, "");
        assert_eq!(l.verses[1].version, "MB2012");
    }

    /// A made-up lesson laid out like the real ones: four objectives, an opening, the beginning,
    /// then parts I to III with questions, the last one misread by OCR as a second II.
    fn outlined_lesson() -> String {
        [
            "Isyu", "Ang pagbabantay ay nakakalimutan ng marami.",
            "Mga Layunin", "1. Maunawaan ang tawag sa pagbabantay.", "2. Makilala ang mga bantay na tapat.",
            "3. Malaman ang tungkulin ng bantay.", "4. Maitaguyod ang pagbabantay sa gabi.",
            "PANIMULA", "Isang pambungad na salita.",
            "PASIMULA:", "T. Ano ang tawag sa mga bantay?", "S. Sila ay tinawag ..... Juan 3:5 NIRV", "Ang mga bantay ay gising sa magdamag.",
            "I. SINO ANG MGA BANTAY NA TAPAT", "SA BAYAN NG DIYOS",
            "T. Sino ang tapat", "na bantay ayon sa aklat?", "S. Ang tapat ..... Juan 3:6 NIRV", "Ang ilaw ng lampara ay hindi namamatay.",
            "II. ANO ANG TUNGKULIN NG BANTAY", "Prose that follows the heading.",
            "Juan 3:7 NIRV", "Ang bantay ay sumisigaw sa pintuan.",
            "II. PAPAANO MAITATAGUYOD ANG PAGBABANTAY",
            "T. Paano tayo magbabantay?", "S. Sa gabi ..... Juan 3:8 NIRV", "Ang bantay ay hindi natutulog.",
            "KONKLUSYON", "Juan 3:9 NIRV", "Ang wakas ng bantay.",
        ]
        .join("\n")
    }

    #[test]
    fn each_verse_knows_the_part_of_the_lesson_and_the_question_it_is_under() {
        let l = parse(&[outlined_lesson()], "x.pdf");
        assert_eq!(l.objectives.len(), 4);
        let parts: Vec<(&str, u32, &str)> = l.verses.iter().map(|v| (v.canonical_key.as_str(), v.section, v.question.as_str())).collect();
        assert_eq!(
            parts,
            vec![
                ("43.3:5", 1, "Ano ang tawag sa mga bantay?"),
                ("43.3:6", 2, "Sino ang tapat na bantay ayon sa aklat?"),
                ("43.3:7", 3, ""),
                ("43.3:8", 4, "Paano tayo magbabantay?"),
                ("43.3:9", CONCLUSION, ""),
            ]
        );
        let numbers: Vec<u32> = l.outline.iter().map(|s| s.number).collect();
        assert_eq!(numbers, vec![1, 2, 3, 4, CONCLUSION]);
        assert_eq!(l.outline[1].heading, "SINO ANG MGA BANTAY NA TAPAT SA BAYAN NG DIYOS");
        assert_eq!(l.outline[2].heading, "ANO ANG TUNGKULIN NG BANTAY", "prose is not part of a heading");
        assert_eq!(l.outline[0].questions, vec!["Ano ang tawag sa mga bantay?"]);
        assert_eq!(l.verses[0].text, "Ang mga bantay ay gising sa magdamag.");
    }

    #[test]
    fn a_lesson_without_the_beginning_heading_starts_at_its_numeral() {
        let page = "I. THE FIRST PART\nJuan 3:5 NIRV\nSome words.\nII. THE SECOND PART\nJuan 3:6 NIRV\nMore words.".to_string();
        let sections: Vec<u32> = parse(&[page], "x.pdf").verses.iter().map(|v| v.section).collect();
        assert_eq!(sections, vec![2, 3]);
    }

    /// A made-up pastoral visit laid out like the real ones, as read by OCR: a title, the
    /// beginning, numbered points citing verses, a verse printed in English and then in
    /// Tagalog, and the signature followed by noise from a blank page.
    fn pastoral_visit() -> Vec<String> {
        vec![
            [
                "ANG HALIMBAWA NG MGA BANTAY", "PASIMULA:", "ANO ANG DAPAT GAWIN NG MGA BANTAY?",
                "1. Ang dapat gawin ..........Il Tim. 3:1-5 TPTB",
                "'But you need to be aware that the watchmen will be awake and they will not sleep.",
                "They will be faithful to the people of God with all of their strength.",
                "'Subalit kailangan ninyong malaman na ang mga bantay ay gising at hindi sila natutulog.",
                "Sila ay tapat sa mga tao ng Diyos sa kanilang buong lakas.",
                "2. Ang aral ..........Filip. 2:12a at 13 AMP",
                "Ang mga bantay ay hindi natutulog sa gabi (spiritual maturity) at sila ay laging handa.",
                "pasimula pa lamang ay gising na ang mga bantay sa pintuan.",
                "Gawa 20:28 Lamsa",
                "Ingatan ninyo ang inyong sarili at ang mga bantay sa pintuan.",
            ]
            .join("\n"),
            [
                "I. ANO ANG TUNGKULIN NG BANTAY?",
                "1. Ang tungkulin .... [ Sam. 12:22 NABRE",
                "Ang bantay ay laging nagbabantay at siya ay hindi napapagod sa kaniyang gawain.",
                "LINGGO: ENERO 10, 2021 BY:",
                "Garbled noise ng the at sa the of mga",
            ]
            .join("\n"),
        ]
    }

    #[test]
    fn a_pastoral_visit_is_read_with_each_verse_in_its_own_language() {
        let l = parse(&pastoral_visit(), "20210110_Sample Visit.pdf");
        assert_eq!(l.title, "Ang Halimbawa ng mga Bantay");
        assert_eq!(l.lesson_date.as_deref(), Some("2021-01-10"));
        let read: Vec<(&str, &str, &str, u32)> = l.verses.iter().map(|v| (v.canonical_key.as_str(), v.language.as_str(), v.version.as_str(), v.section)).collect();
        assert_eq!(
            read,
            vec![
                ("55.3:1-5", "en", "TPTB", 1),
                ("55.3:1-5", "tl", "TPTB", 1),
                ("50.2:12a,13", "tl", "AMP", 1),
                ("44.20:28", "tl", "LAMSA", 1),
                ("9.12:22", "tl", "NABRE", 2),
            ]
        );
        assert!(l.verses[0].text.starts_with("'But you need") && l.verses[0].text.ends_with("their strength."), "{}", l.verses[0].text);
        assert!(l.verses[1].text.starts_with("'Subalit") && l.verses[1].text.ends_with("buong lakas."), "{}", l.verses[1].text);
        assert!(l.verses[2].text.ends_with("sa pintuan."), "an ordinary word is not a heading: {}", l.verses[2].text);
        assert!(l.verses[4].text.ends_with("kaniyang gawain."), "the signature ends the verse: {}", l.verses[4].text);
    }

    #[test]
    fn a_citation_whose_book_cannot_be_read_is_reported_not_guessed() {
        let page = [
            "ANG MGA BANTAY",
            "1. Ang dapat gawin ..........Juan 3:5 NIRV",
            "Ang mga bantay ay gising sa gabi.",
            "2. Ang aral wnmsoee oom]) Xyq: 4:9 ABC",
            "Ang tagapag-ingat ay hindi natutulog.",
            "Ang pulong ay sa 10:30 AM.",
        ]
        .join("\n");
        let lesson = parse(&[page], "20210110_Sample.pdf");
        assert_eq!(lesson.verses.len(), 1);
        assert!(!lesson.verses[0].text.contains("tagapag-ingat"), "the unread verse is not added to the one before it");
        assert_eq!(lesson.unread.len(), 1, "{:?}", lesson.unread);
        assert_eq!((lesson.unread[0].page, lesson.unread[0].text.as_str()), (1, "Xyq: 4:9 ABC"));
    }

    #[test]
    fn ocr_misreadings_of_references_are_understood() {
        let cases = [
            ("Il Tim. 3:1-5", "55.3:1-5"),
            ("IT Sam. 22:20", "10.22:20"),
            ("11 Sam, 22:5-7", "10.22:5-7"),
            ("[ Sam. 12:22", "9.12:22"),
            ("I Cor. 5:12a at 13", "46.5:12a,13"),
            ("Isa. 58:8-9 (a) at 11", "23.58:8-9(a),11"),
            ("Filip. 2:12", "50.2:12"),
            ("IL COL 1:5", "51.1:5"),
        ];
        for (input, key) in cases {
            let found = find_references(input);
            assert_eq!(found.first().map(|r| r.canonical_key.as_str()), Some(key), "{input}");
        }
        assert!(find_references("Ilog 3:4").is_empty());
    }

    #[test]
    fn roman_numerals() {
        assert_eq!([("I", 1), ("II", 2), ("III", 3), ("IV", 4), ("V", 5), ("VI", 6), ("IX", 9), ("X", 10)].map(|(r, _)| roman_value(r)), [1, 2, 3, 4, 5, 6, 9, 10]);
    }

    #[test]
    fn pastoral_file_name_convention() {
        let l = parse(
            &["Some body text with the words of the lesson".to_string()],
            "20150425_Sampleville, Testland_Ang Halimbawa ng Tungkulin.pdf",
        );
        assert_eq!(l.category, "pastoral");
        assert_eq!(l.location, "Sampleville, Testland");
        assert_eq!(l.lesson_date.as_deref(), Some("2015-04-25"));
        assert_eq!(l.title, "Ang Halimbawa ng Tungkulin");
    }

    #[test]
    fn pastoral_footer_supplies_separate_places_and_a_valid_date() {
        let lesson = parse(&[
            "Paksa: Ang Halimbawa\nPASIMULA:\nJuan 3:5 NIRV\nAng bantay ay gising.".into(),
            "Juan 3:6 NIRV\nAng bantay ay handa.\nSABADO: ABRIL 4, 2026\nDEPARO, CALOOCAN NORTH".into(),
        ], "sample-visit.pdf");
        assert_eq!(lesson.local_congregation, "Deparo");
        assert_eq!(lesson.district, "Caloocan North");
        assert_eq!(lesson.location, "Deparo, Caloocan North");
        assert_eq!(lesson.lesson_date.as_deref(), Some("2026-04-04"));
        assert_eq!(lesson.year, Some(2026));
        assert_eq!(lesson.category, "pastoral");
        assert_eq!(lesson.verses.len(), 2);
        assert_eq!(lesson.verses[1].text, "Ang bantay ay handa.");
    }

    #[test]
    fn pastoral_footer_accepts_wrapped_names_and_ignores_trailing_blank_pages() {
        let lesson = parse(&[
            "Paksa: Halimbawa\nSATURDAY: APRIL 4, 2026\nDEPARO,\nCALOOCAN NORTH".into(),
            " \n\n".into(),
        ], "20250101_Sample.pdf");
        assert_eq!(lesson.local_congregation, "Deparo");
        assert_eq!(lesson.district, "Caloocan North");
        assert_eq!(lesson.lesson_date.as_deref(), Some("2026-04-04"), "the printed date takes precedence over a filename date");
    }

    #[test]
    fn a_location_is_not_guessed_from_body_prose_or_an_invalid_footer() {
        for pages in [
            vec!["SABADO: ABRIL 4, 2026\nDEPARO, CALOOCAN NORTH".into(), "The actual last page.".into()],
            vec!["Paksa: Halimbawa\nDEPARO, CALOOCAN NORTH\nThere is no date footer here.".into()],
            vec!["Paksa: Halimbawa\nSABADO: PEBRERO 31, 2026\nDEPARO, CALOOCAN NORTH".into()],
            vec!["Paksa: Halimbawa\nSABADO: ABRIL 4, 2026\nBY: AN AUTHOR\nDEPARO, CALOOCAN NORTH".into()],
            vec!["Paksa: Halimbawa\nSABADO: ABRIL 4, 2026 BY:\nAN AUTHOR, JR.".into()],
        ] {
            let lesson = parse(&pages, "sample.pdf");
            assert!(lesson.local_congregation.is_empty(), "{:?}", pages);
            assert!(lesson.district.is_empty(), "{:?}", pages);
        }
        assert!(split_location("Local, District, Country").is_none());
        assert!(split_location("Local, April 4: 2026").is_none());
    }
}

