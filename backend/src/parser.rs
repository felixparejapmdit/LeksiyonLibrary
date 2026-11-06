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
    pub author: String,
    pub code: String,
    pub issue: String,
    pub objectives: Vec<String>,
    pub content: String,
    pub verses: Vec<ParsedVerse>,
    pub outline: Vec<Section>,
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
    (?P<num>\b(?:III|II|I|1|2|3)\s*)?
    (?P<book>[A-Za-z]+(?:\s+ng\s+mga\s+Awit)?)
    [.,]?\s*
    (?P<ch>\d{1,3}):
    (?P<vs>\d{1,3}(?:\([a-z]\))?(?:\s*-\s*\d{1,3}(?:\([a-z]\))?)?
       (?:\s*(?:,|&|\bat\b|\band\b)\s*\d{1,3}(?:\([a-z]\))?(?:\s*-\s*\d{1,3}(?:\([a-z]\))?)?)*)"
);
re!(TALATA, r"(?i)^(?:talata|verse|scripture)\s*:\s*");
re!(
    BULLET,
    r"^(?:[-.,|]\s+)?(?:B®|HB|BE|HM|BB|MM|B|E|M|m|H|W|@|■|▪|•|®|©)\s*[_]?\s+\S"
);
re!(
    STOP_LINE,
    r"(?i)^(?:[TSQA]\.\s|\d+\.\s|[IVX]+\.\s+[A-Z]{2}|konklusyon\b|conclusion\b|pasimula\b|introduction\b|\(aawitin|\(sing)"
);
re!(
    CITATION,
    r"(?i)^(?:\(?(?:the\s+)?holy bible\b|\((?:the|holy)\b.*\b(?:bible|testament)\b)"
);
re!(VERSION_HINT, r"(?i)\b(?:version|bible|translation|edition|bersiyon|biblia)\b");
re!(VERSION_CODE, r"^[A-Z]{2,6}\d{0,4}$");
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
re!(CONCLUSION_MARK, r"(?i)^(?:konklusyon|conclusion|pangwakas)\b\s*:?\s*(.*)$");
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
        return Some((CONCLUSION, c[1].trim().to_string()));
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

pub fn normalize_version(raw: &str) -> String {
    let cleaned = raw.trim().trim_matches(|c: char| ",.;:".contains(c)).replace('’', "'");
    let lower = cleaned.to_lowercase();
    if lower.is_empty() {
        return String::new();
    }
    for (code, aliases) in VERSIONS {
        if aliases.iter().any(|a| *a == lower) {
            return (*code).to_string();
        }
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
        let Some(book) = books::find(num, &name) else {
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
    let to_num = |s: &str| match s.trim() {
        "I" | "1" => Some(1),
        "II" | "2" => Some(2),
        "III" | "3" => Some(3),
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
    BULLET.is_match(line) || STOP_LINE.is_match(line) || CITATION.is_match(line)
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
            let is_version_only = rest.is_empty() || is_version_continuation(rest);
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
    let stem = file_name.strip_suffix(".pdf").or(file_name.strip_suffix(".PDF")).unwrap_or(file_name);

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

    let paksa = lines.iter().find_map(|(_, l)| PAKSA.captures(l).map(|c| c[1].trim().to_string()));
    lesson.title = if let Some(p) = paksa {
        smart_title(&p)
    } else if let Some(i) = issue_at.filter(|i| *i > 0 && *i <= 5) {
        smart_title(&lines[..i].iter().map(|(_, l)| l.as_str()).collect::<Vec<_>>().join(" "))
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
                // A heading on its own line ("PASIMULA:") has nothing to continue.
                let heading = if heading.is_empty() { heading } else { with_continuation(&lines, i + 1, &heading, true) };
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
        lesson.verses.push(ParsedVerse {
            canonical_key: reference.canonical_key,
            book_id: reference.book_id,
            ref_printed: reference.printed,
            ref_en: reference.en,
            ref_tl: reference.tl,
            version: normalize_version(&version_raw),
            raw: collected.join("\n"),
            text: join_verse_lines(&collected),
            page: *page,
            section,
            question: question.clone(),
        });
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
}
