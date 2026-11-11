//! Retrieval and AI notes.
//!
//! Guardrail: the model never supplies scripture. Retrieval is plain full-text
//! ranking over stored verses. The model only sees numbered candidates and may
//! return a short note per candidate number; verse text shown to the user is
//! always read from the database by id. Nothing in this module writes to the
//! verses table.
//!
//! The speaker, the chapter, book, and historical and political context shown beside a verse,
//! and their Tagalog wording, are the model's reading, not facts from the library, and are
//! labelled that way until the user reviews them.

use regex::Regex;
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

const STOPWORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "how", "i", "in", "is", "it",
    "of", "on", "or", "our", "should", "so", "that", "the", "their", "them", "they", "this", "to", "us",
    "was", "we", "what", "when", "who", "why", "will", "with", "you", "your", "ako", "ang", "at", "ay",
    "ba", "bakit", "dapat", "din", "ito", "iyon", "ka", "kaya", "kung", "lamang", "mga", "na", "nang",
    "natin", "ng", "ni", "nila", "pa", "paano", "sa", "si", "siya", "tayo", "upang", "want", "teach",
    "help", "understand", "his", "him", "her", "she", "must", "have", "has", "had", "not", "all", "can",
    "been", "were", "which", "there", "these", "those", "into", "than", "then", "nila", "kanila", "niya",
    "kaniya", "kanilang", "kaniyang", "ating", "aming", "inyong", "iyong", "may", "mga",
];

/// The words of a text that carry its meaning, each once, in order.
pub fn content_words(input: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    input
        .split(|c: char| !c.is_alphanumeric() && c != '-')
        .map(|w| w.trim_matches('-').to_lowercase())
        .filter(|w| w.chars().count() >= 3 && !STOPWORDS.contains(&w.as_str()))
        .filter(|w| seen.insert(w.clone()))
        .collect()
}

pub fn query_terms(input: &str) -> Vec<String> {
    let mut terms = content_words(input);
    terms.truncate(24);
    terms
}

/// Builds a safe FTS5 MATCH expression from free text.
pub fn fts_query(terms: &[String], op: &str) -> String {
    terms
        .iter()
        .map(|t| format!("\"{}\"*", t.replace('"', "")))
        .collect::<Vec<_>>()
        .join(&format!(" {op} "))
}

#[derive(Serialize, Clone)]
pub struct Suggestion {
    pub canonical_key: String,
    pub ref_en: String,
    pub ref_tl: String,
    pub score: f64,
    pub matched_terms: Vec<String>,
    pub verse_ids: Vec<String>,
    /// Found because it means something similar, not because it shares words.
    pub meaning: bool,
    /// The lessons, and the part of each, where it was found for this objective or topic.
    pub from_lessons: Vec<crate::outline::LessonMatch>,
}

pub fn retrieve(conn: &Connection, user_id: &str, issue: &str, objective: &str, limit: usize) -> rusqlite::Result<Vec<Suggestion>> {
    let terms = query_terms(&format!("{issue} {objective}"));
    if terms.is_empty() {
        return Ok(vec![]);
    }
    let q = fts_query(&terms, "OR");
    let mut scores: HashMap<String, f64> = HashMap::new();

    // Verses whose own text matches carry the most weight.
    {
        let mut stmt = conn.prepare(
            "SELECT v.canonical_key, bm25(verses_fts) FROM verses_fts JOIN verses v ON v.seq = verses_fts.rowid
             WHERE verses_fts MATCH ?1 AND v.user_id = ?2",
        )?;
        let rows = stmt.query_map(params![q, user_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))?;
        for row in rows {
            let (key, bm) = row?;
            // The best wording counts, so a verse held in many translations does not outrank
            // one held in a single translation merely for being repeated.
            let score = scores.entry(key).or_default();
            *score = score.max(3.0 * -bm);
        }
    }
    // Which lessons a verse belongs with is decided by the lesson's parts: see outline.rs.

    let mut ranked: Vec<(String, f64)> = scores.into_iter().collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    ranked.truncate(limit);

    let mut out = Vec::new();
    for (key, score) in ranked {
        if let Some(s) = build_suggestion(conn, user_id, &key, score, &terms, false)? {
            out.push(s);
        }
    }
    Ok(out)
}

fn build_suggestion(conn: &Connection, user_id: &str, key: &str, score: f64, terms: &[String], meaning: bool) -> rusqlite::Result<Option<Suggestion>> {
    let mut stmt = conn.prepare_cached("SELECT id, ref_en, ref_tl, text FROM verses WHERE user_id = ?1 AND canonical_key = ?2 ORDER BY language DESC, seq")?;
    let rows: Vec<(String, String, String, String)> = stmt
        .query_map(params![user_id, key], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<Result<_, _>>()?;
    let Some(first) = rows.first() else { return Ok(None) };
    let haystack = rows.iter().map(|r| r.3.to_lowercase()).collect::<Vec<_>>().join(" ");
    Ok(Some(Suggestion {
        canonical_key: key.to_string(),
        ref_en: first.1.clone(),
        ref_tl: first.2.clone(),
        score: (score * 100.0).round() / 100.0,
        matched_terms: terms.iter().filter(|t| haystack.contains(t.as_str())).cloned().collect(),
        verse_ids: rows.iter().map(|r| r.0.clone()).collect(),
        meaning,
        from_lessons: vec![],
    }))
}

/// Combines the matching lesson parts with keyword and meaning results, leaving out verses
/// already shown. Ranking well in any list counts for more than the raw scores, which are not
/// comparable with each other. A close match with a lesson's part counts for up to three
/// times a keyword match, because the lesson itself chose that verse for that purpose.
pub fn fuse(
    conn: &Connection,
    user_id: &str,
    lessons: Vec<crate::outline::LessonHit>,
    keyword: Vec<Suggestion>,
    meaning: &[(String, f32)],
    exclude: &HashSet<String>,
    limit: usize,
) -> rusqlite::Result<Vec<Suggestion>> {
    const DAMPING: f64 = 60.0;
    let mut fused: HashMap<String, f64> = HashMap::new();
    let lists: [Vec<(String, f64)>; 3] = [
        lessons.iter().map(|h| (h.canonical_key.clone(), 1.0 + 2.0 * h.score.min(1.0))).collect(),
        keyword.iter().map(|s| (s.canonical_key.clone(), 1.0)).collect(),
        meaning.iter().map(|(k, _)| (k.clone(), 1.0)).collect(),
    ];
    for list in lists {
        for (rank, (key, weight)) in list.into_iter().filter(|(k, _)| !exclude.contains(k)).enumerate() {
            *fused.entry(key).or_default() += weight / (DAMPING + rank as f64 + 1.0);
        }
    }
    let mut order: Vec<(String, f64)> = fused.into_iter().collect();
    order.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    order.truncate(limit);
    let mut by_key: HashMap<String, Suggestion> = keyword.into_iter().map(|s| (s.canonical_key.clone(), s)).collect();
    let mut sources: HashMap<String, Vec<crate::outline::LessonMatch>> = lessons.into_iter().map(|h| (h.canonical_key, h.sources)).collect();
    let in_meaning: HashSet<&String> = meaning.iter().map(|(k, _)| k).collect();
    let mut out = Vec::new();
    for (key, score) in order {
        let found = match by_key.remove(&key) {
            Some(s) => Some(s),
            None => build_suggestion(conn, user_id, &key, score, &[], in_meaning.contains(&key) && !sources.contains_key(&key))?,
        };
        if let Some(mut s) = found {
            s.from_lessons = sources.remove(&key).unwrap_or_default();
            out.push(s);
        }
    }
    Ok(out)
}

/// Verses for one objective. Matches on the objective's own words come first, so
/// each objective gets its own verses; the issue's words only fill remaining places.
/// A shorter list is returned rather than padding it with verses that do not match.
pub fn retrieve_for_objective(conn: &Connection, user_id: &str, issue: &str, objective: &str, count: usize) -> rusqlite::Result<Vec<Suggestion>> {
    let mut out = retrieve(conn, user_id, "", objective, count)?;
    if out.len() < count {
        for s in retrieve(conn, user_id, issue, objective, count)? {
            if out.len() < count && !out.iter().any(|o| o.canonical_key == s.canonical_key) {
                out.push(s);
            }
        }
    }
    Ok(out)
}

static QUOTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"["“”'‘’]([^"“”]{20,})["“”]"#).unwrap());

const MAX_NOTE_CHARS: usize = 240;
const MAX_SPEAKER_CHARS: usize = 80;

/// One candidate shown to the model: canonical key, printed reference, verse text.
pub type Candidate = (String, String, String);

/// Validates the model's reply. Unknown candidates, quoted passages and notes
/// that reproduce stored verse wording are discarded, not repaired.
pub fn sanitize_notes(reply: &Value, candidates: &[Candidate]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Some(items) = reply.get("notes").and_then(|n| n.as_array()) else {
        return out;
    };
    for item in items {
        let Some(num) = item.get("candidate").and_then(candidate_number) else {
            continue;
        };
        let Some(note) = item.get("note").and_then(|n| n.as_str()) else {
            continue;
        };
        if num == 0 {
            continue;
        }
        let Some((key, _, verse_text)) = candidates.get(num as usize - 1) else {
            continue;
        };
        let note = note.trim();
        if note.is_empty() || QUOTED.is_match(note) || reproduces_scripture(note, verse_text) {
            continue;
        }
        let clipped: String = note.chars().take(MAX_NOTE_CHARS).collect();
        out.insert(key.clone(), clipped);
    }
    out
}

fn candidate_number(c: &Value) -> Option<u64> {
    c.as_u64().or_else(|| c.as_str().and_then(|s| s.trim_start_matches('V').parse().ok()))
}

/// True when the note shares a run of six or more words with the verse.
fn reproduces_scripture(note: &str, verse: &str) -> bool {
    let words = |s: &str| -> Vec<String> {
        s.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(|w| w.to_lowercase()).collect()
    };
    let verse_words = words(verse);
    let note_words = words(note);
    if note_words.len() < 6 || verse_words.len() < 6 {
        return false;
    }
    let shingles: HashSet<&[String]> = verse_words.windows(6).collect();
    note_words.windows(6).any(|w| shingles.contains(w))
}

/// A book or chapter whose background is wanted.
pub struct ScopeRequest {
    pub scope: String,
    pub label: String,
}

/// "60.2:9-10" is book 60, chapter 2.
fn parse_key(key: &str) -> Option<(u32, &str)> {
    let (book, rest) = key.split_once('.')?;
    let chapter = rest.split(':').next()?;
    (!chapter.is_empty()).then_some(())?;
    Some((book.parse().ok()?, chapter))
}

/// The books and chapters of these verses that are not already in `known`, each once.
pub fn scope_requests(keys: &[String], known: &HashSet<String>) -> Vec<ScopeRequest> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut add = |scope: String, label: String| {
        if !known.contains(&scope) && seen.insert(scope.clone()) {
            out.push(ScopeRequest { scope, label });
        }
    };
    for key in keys {
        let Some((book_id, chapter)) = parse_key(key) else { continue };
        let Some(book) = crate::books::by_id(book_id) else { continue };
        add(format!("chapter:{book_id}.{chapter}"), format!("chapter {chapter} of the book of {}", book.en));
        add(format!("book:{book_id}"), format!("the book of {}", book.en));
        add(format!("history:{book_id}"), format!("the historical and political setting of the book of {}", book.en));
    }
    out
}

const MAX_SCOPE_CHARS: usize = 600;

const SPEAKER_SYSTEM: &str = "Reply with JSON only, shaped as {\"speaker\":\"<name>\"}. Name the person speaking in this Bible verse, \
    such as the author or someone being quoted. Give a person, never the name of the book. If the passage does not make it clear, say \"Not stated\".";

const SCOPE_SYSTEM: &str = "You give a Bible teacher brief background. Reply with JSON only, shaped as {\"context\":\"<two or three short sentences>\"}. \
    For a book: who wrote it, who it was written to, and why. \
    For a chapter: who is being addressed, what happens or is discussed in that chapter, and its main point. \
    For a historical and political setting: the period, which nation or empire held power, who ruled, and the circumstances of the people at that time. Leave out any date or ruler you are unsure of. \
    Be specific to that item, and do not describe the whole book when asked about one chapter. \
    State only what is widely accepted, and if you are unsure, say so rather than guessing. \
    Never quote scripture, and never cite chapter and verse numbers.";

/// Discards text that quotes scripture or cites a verse.
fn clean_text(text: &str, max: usize) -> Option<String> {
    let text = text.trim();
    let rejected = text.is_empty() || QUOTED.is_match(text) || !crate::parser::find_references(text).is_empty();
    (!rejected).then(|| whole_sentences(text, max))
}

/// Shortens long text at the end of a sentence, never partway through one.
fn whole_sentences(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let clipped: String = text.chars().take(max).collect();
    match clipped.rfind(". ") {
        Some(end) => clipped[..=end].to_string(),
        None => clipped,
    }
}

/// A speaker must be a person. Small models tend to answer with the book's name.
fn clean_speaker(speaker: &str, reference: &str) -> Option<String> {
    let speaker = clean_text(speaker, MAX_SPEAKER_CHARS)?;
    (!reference.to_lowercase().starts_with(&speaker.to_lowercase())).then_some(speaker)
}

/**
 * Threads the local model may use: all but two of this computer's cores, so the app, the
 * PDF viewer and OCR stay smooth while the AI writes. Always at least one.
 */
pub fn model_threads() -> usize {
    std::thread::available_parallelism().map_or(2, |n| n.get()).saturating_sub(2).max(1)
}

async fn ask_json(client: &reqwest::Client, base_url: &str, model: &str, system: &str, user: &str) -> Result<Value, String> {
    let resp = client
        .post(format!("{}/api/chat", base_url.trim_end_matches('/')))
        .json(&json!({
            "model": model,
            "stream": false,
            "format": "json",
            "options": { "temperature": 0.1, "num_thread": model_threads() },
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user }
            ]
        }))
        .send()
        .await
        .map_err(|e| format!("AI service unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("AI service returned {}", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| format!("Unreadable AI response: {e}"))?;
    let content = body.pointer("/message/content").and_then(|c| c.as_str()).unwrap_or("");
    serde_json::from_str(content).map_err(|_| "AI response was not valid JSON".to_string())
}

/// Asked one at a time: measured on the real model, this named every speaker correctly,
/// where asking about several verses at once returned book names.
pub async fn request_speaker(client: &reqwest::Client, base_url: &str, model: &str, reference: &str) -> Result<Option<String>, String> {
    let reply = ask_json(client, base_url, model, SPEAKER_SYSTEM, &format!("Verse: {reference}")).await?;
    Ok(reply.get("speaker").and_then(|c| c.as_str()).and_then(|s| clean_speaker(s, reference)))
}

/// Asked one at a time: measured on the real model, asking about several at once blended
/// them, so that a chapter was described by another book's themes.
pub async fn request_scope(client: &reqwest::Client, base_url: &str, model: &str, label: &str) -> Result<Option<String>, String> {
    let reply = ask_json(client, base_url, model, SCOPE_SYSTEM, &format!("Background on: {label}")).await?;
    Ok(reply.get("context").and_then(|c| c.as_str()).and_then(|t| clean_text(t, MAX_SCOPE_CHARS)))
}

const TRANSLATE_SYSTEM: &str = "Translate the user's text into Tagalog (Filipino). Reply with JSON only, shaped as {\"tagalog\":\"<translation>\"}. \
    Translate everything, keep the meaning exactly, and add nothing. Use the Tagalog Bible names of people and books, \
    such as Pablo for Paul, Pedro for Peter and Colosas for Colossians. \
    Use this library's exact book names: I Kings is I Hari, and II Kings is II Hari. \
    Never call these books I Reyes or II Reyes. Keep I Hari and II Hari unchanged if already present.";

const MAX_TRANSLATION_CHARS: usize = 8000;

static REYES_BOOK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(II|I|2|1)\.?\s+(?:Mga\s+)?Reyes\b").unwrap());

/// The model sometimes substitutes Spanish book names for the library's Tagalog names.
/// Apply this only to AI context, never scripture or the user's reviewed wording.
pub fn canonical_tagalog_book_names(text: &str) -> String {
    REYES_BOOK.replace_all(text, |captures: &regex::Captures<'_>| {
        let id = match captures[1].to_ascii_uppercase().as_str() {
            "I" | "1" => 11,
            "II" | "2" => 12,
            _ => unreachable!(),
        };
        crate::books::by_id(id).unwrap().tl
    }).into_owned()
}

/// A translation is kept only if it reads as Tagalog: small models often answer in English.
/// Names are too short to tell, so they pass.
fn clean_translation(reply: &str, source: &str) -> Option<String> {
    let text = clean_text(&canonical_tagalog_book_names(reply), MAX_TRANSLATION_CHARS)?;
    let short = text.split_whitespace().count() <= 3;
    (short || (crate::language::is_tagalog(&text) && text != source.trim())).then_some(text)
}

pub async fn request_tagalog(client: &reqwest::Client, base_url: &str, model: &str, text: &str) -> Result<Option<String>, String> {
    let reply = ask_json(client, base_url, model, TRANSLATE_SYSTEM, &format!("Translate into Tagalog: {text}")).await?;
    Ok(reply.get("tagalog").and_then(|c| c.as_str()).and_then(|t| clean_translation(t, text)))
}

pub struct NotesResult {
    pub notes: HashMap<String, String>,
    pub model: String,
}

pub async fn request_notes(
    client: &reqwest::Client,
    base_url: &str,
    model: &str,
    issue: &str,
    objective: &str,
    candidates: &[Candidate],
) -> Result<NotesResult, String> {
    let list = candidates
        .iter()
        .enumerate()
        .map(|(i, (_, reference, text))| format!("Candidate {}: [{reference}] {}", i + 1, text.chars().take(400).collect::<String>()))
        .collect::<Vec<_>>()
        .join("\n");
    let system = "You help a minister choose among scripture candidates. Reply with JSON only, shaped as \
        {\"notes\":[{\"candidate\":<number>,\"note\":\"<one short sentence>\"}]}. Each note explains why that candidate fits the \
        issue and objective. If you are unsure, say so rather than guessing. Never quote, paraphrase, translate or rewrite scripture. \
        Never add verses or references. Use only the candidate numbers given.";
    let user = format!("Issue: {issue}\nObjective: {objective}\n\n{list}");
    let resp = client
        .post(format!("{}/api/chat", base_url.trim_end_matches('/')))
        .json(&json!({
            "model": model,
            "stream": false,
            "format": "json",
            "options": { "temperature": 0.1, "num_thread": model_threads() },
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user }
            ]
        }))
        .send()
        .await
        .map_err(|e| format!("AI service unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("AI service returned {}", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| format!("Unreadable AI response: {e}"))?;
    let content = body.pointer("/message/content").and_then(|c| c.as_str()).unwrap_or("");
    let parsed: Value = serde_json::from_str(content).map_err(|_| "AI response was not valid JSON".to_string())?;
    Ok(NotesResult { notes: sanitize_notes(&parsed, candidates), model: model.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cands() -> Vec<Candidate> {
        vec![
            ("10.7:24".into(), "II Samuel 7:24".into(), "The sample verse one speaks of a people kept safe for all time.".into()),
            ("45.9:4".into(), "Romans 9:4".into(), "Sample people live here; he taught them many good things to keep.".into()),
        ]
    }

    #[test]
    fn a_speaker_must_be_a_person_and_cannot_cite_or_quote() {
        assert_eq!(clean_speaker(" Peter ", "I Peter 2:9-10").as_deref(), Some("Peter"));
        assert_eq!(clean_speaker("Not stated", "I Peter 2:9-10").as_deref(), Some("Not stated"));
        assert_eq!(clean_speaker("I Peter", "I Peter 2:9-10"), None, "the book's name is not a person");
        assert_eq!(clean_speaker("colossians", "Colossians 3:12 & 15"), None);
        assert_eq!(clean_speaker("See John 3:16", "I Peter 2:9-10"), None);
        assert_eq!(clean_speaker("", "I Peter 2:9-10"), None);
    }

    #[test]
    fn each_book_and_chapter_is_asked_about_once_and_only_if_missing() {
        let keys = vec!["60.2:9-10".to_string(), "60.2:11".to_string(), "60.3:1".to_string(), "19.138:7-8,2".to_string(), "bad".to_string(), "999.1:1".to_string()];
        let requests = scope_requests(&keys, &HashSet::from(["book:19".to_string()]));
        let scopes: Vec<&str> = requests.iter().map(|r| r.scope.as_str()).collect();
        assert_eq!(scopes, vec!["chapter:60.2", "book:60", "history:60", "chapter:60.3", "chapter:19.138", "history:19"]);
        assert!(requests[0].label.starts_with("chapter 2 of the book of "), "{}", requests[0].label);
        assert!(requests[1].label.starts_with("the book of "), "{}", requests[1].label);
        assert!(requests[2].label.starts_with("the historical and political setting of the book of "), "{}", requests[2].label);
    }

    #[test]
    fn a_translation_must_read_as_tagalog_and_cannot_cite_verses() {
        let source = "The book was written to the church by the apostle.";
        assert!(clean_translation("Ang aklat ay isinulat para sa iglesia ng apostol.", source).is_some());
        assert_eq!(clean_translation(source, source), None, "an English reply is not a translation");
        assert_eq!(clean_translation("The letter was sent to all of the people.", source), None);
        assert_eq!(clean_translation("Pablo", "Paul").as_deref(), Some("Pablo"), "names are too short to judge");
        assert_eq!(clean_translation("Ayon sa Juan 3:16 ang aklat ay para sa mga tao.", source), None);
        assert_eq!(clean_translation("", source), None);
    }

    #[test]
    fn ai_tagalog_uses_the_librarys_kings_book_names() {
        let source = "The book of II Kings continues the history in I Kings.";
        assert_eq!(
            clean_translation("Ang aklat ng II Reyes ay nagpapatuloy sa kasaysayan ng I Reyes.", source).as_deref(),
            Some("Ang aklat ng II Hari ay nagpapatuloy sa kasaysayan ng I Hari."),
        );
        assert_eq!(canonical_tagalog_book_names("1 Reyes; 2 Reyes; ii. reyes; I Mga Reyes."), "I Hari; II Hari; II Hari; I Hari.");
        assert_eq!(canonical_tagalog_book_names("I Hari at II Hari; sinabi ni Reyes; II Reyeson."), "I Hari at II Hari; sinabi ni Reyes; II Reyeson.");
        assert_eq!(clean_translation("Ayon sa II Reyes 5:15 ay nagturo ang aklat.", source), None, "normalizing the name must not let citations through");
    }

    #[test]
    fn repeating_a_verse_in_more_translations_does_not_raise_its_rank() {
        let c = library();
        c.execute_batch("DELETE FROM verses;").unwrap();
        let add = |id: &str, key: &str, version: &str, text: &str| {
            c.execute(
                "INSERT INTO verses (id,user_id,canonical_key,book_id,ref_printed,ref_en,ref_tl,version,language,text,text_sha256,ocr_raw,status,created_at)
                 VALUES (?1,'u',?2,1,'r','r','r',?3,'en',?4,'h',?1,'unverified','now')",
                params![id, key, version, text],
            )
            .unwrap();
        };
        add("once", "1.1:1", "A", "election election election of people");
        for (i, version) in ["B", "C", "D", "E", "F"].iter().enumerate() {
            add(&format!("rep{i}"), "1.1:2", version, "the election of many other different people written in a longer verse here");
        }
        let found = retrieve(&c, "u", "", "election", 5).unwrap();
        assert_eq!(found[0].canonical_key, "1.1:1", "the closer match wins, not the more repeated one");
    }

    #[test]
    fn long_text_is_shortened_at_a_sentence_end() {
        assert_eq!(whole_sentences("One two. Three four five.", 100), "One two. Three four five.");
        assert_eq!(whole_sentences("One two. Three four five.", 15), "One two.");
        assert_eq!(whole_sentences("No sentence end here at all", 10), "No sentenc");
    }

    #[test]
    fn scripture_context_cannot_quote_or_cite_verses() {
        assert_eq!(clean_text(" A chapter about identity. ", MAX_SCOPE_CHARS).as_deref(), Some("A chapter about identity."));
        assert_eq!(clean_text("As John 3:16 teaches.", MAX_SCOPE_CHARS), None);
        assert_eq!(clean_text("It reads \"a long passage that is quoted from the text\".", MAX_SCOPE_CHARS), None);
        assert_eq!(clean_text("", MAX_SCOPE_CHARS), None);
        assert!(clean_text(&"word ".repeat(300), MAX_SCOPE_CHARS).unwrap().chars().count() <= MAX_SCOPE_CHARS);
    }

    fn library() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(crate::db::SCHEMA).unwrap();
        c.execute("INSERT INTO users VALUES ('u','a@b.c','','now')", []).unwrap();
        for (i, text) in ["election of the chosen people", "faithful service to God", "election and faithful service", "unrelated harvest words"].iter().enumerate() {
            c.execute(
                "INSERT INTO verses (id,user_id,canonical_key,book_id,ref_printed,ref_en,ref_tl,language,text,text_sha256,ocr_raw,status,created_at)
                 VALUES (?1,'u',?2,1,'r','r','r','en',?3,'h',?3,'unverified','now')",
                params![format!("v{i}"), format!("1.1:{i}"), text],
            )
            .unwrap();
        }
        c
    }

    #[test]
    fn objective_words_rank_first_and_the_issue_only_fills_remaining_places() {
        let c = library();
        let found = retrieve_for_objective(&c, "u", "election", "faithful service", 3).unwrap();
        let keys: Vec<&str> = found.iter().map(|s| s.canonical_key.as_str()).collect();
        assert_eq!(keys.len(), 3);
        assert!(keys[..2].contains(&"1.1:1") && keys[..2].contains(&"1.1:2"));
        assert_eq!(keys[2], "1.1:0");
    }

    #[test]
    fn meaning_results_join_keyword_results_and_are_marked() {
        let c = library();
        let keyword = retrieve(&c, "u", "", "election", 5).unwrap();
        assert!(keyword.iter().all(|s| !s.meaning));
        let merged = fuse(&c, "u", vec![], keyword.clone(), &[("1.1:3".to_string(), 0.9), (keyword[0].canonical_key.clone(), 0.8)], &HashSet::new(), 5).unwrap();
        assert_eq!(merged[0].canonical_key, keyword[0].canonical_key, "found both ways ranks first");
        let added = merged.iter().find(|s| s.canonical_key == "1.1:3").unwrap();
        assert!(added.meaning && added.matched_terms.is_empty());
        assert!(!merged[0].meaning);
        assert!(fuse(&c, "u", vec![], vec![], &[("1.1:3".to_string(), 0.9)], &HashSet::new(), 5).unwrap().len() == 1);
        assert_eq!(fuse(&c, "u", vec![], keyword, &[("1.1:3".to_string(), 0.9)], &HashSet::new(), 1).unwrap().len(), 1);
    }

    #[test]
    fn a_short_list_is_never_padded_with_verses_that_do_not_match() {
        let c = library();
        let found = retrieve_for_objective(&c, "u", "", "harvest", 5).unwrap();
        assert_eq!(found.len(), 1);
    }

    #[test]
    fn keeps_valid_notes_only() {
        let reply = json!({"notes": [
            {"candidate": 1, "note": "Shows that the election comes from God."},
            {"candidate": 2, "note": "Lists the blessings of being chosen."}
        ]});
        let n = sanitize_notes(&reply, &cands());
        assert_eq!(n.len(), 2);
        assert_eq!(n["10.7:24"], "Shows that the election comes from God.");
    }

    #[test]
    fn rejects_invented_candidates() {
        let reply = json!({"notes": [
            {"candidate": 3, "note": "John 3:16 is better."},
            {"candidate": 0, "note": "Zero."},
            {"candidate": "nope", "note": "Bad id."}
        ]});
        assert!(sanitize_notes(&reply, &cands()).is_empty());
    }

    #[test]
    fn rejects_quoted_or_reproduced_scripture() {
        let reply = json!({"notes": [
            {"candidate": 1, "note": "It says \"the sample verse one speaks of a people kept safe\"."},
            {"candidate": 2, "note": "Sample people live here he taught them, so this fits."}
        ]});
        assert!(sanitize_notes(&reply, &cands()).is_empty());
    }

    #[test]
    fn extra_fields_cannot_smuggle_text() {
        let reply = json!({"notes": [{"candidate": 1, "note": "Fits the topic.", "text": "Rewritten verse", "verse": "Altered"}]});
        let n = sanitize_notes(&reply, &cands());
        assert_eq!(n.len(), 1);
        assert_eq!(n["10.7:24"], "Fits the topic.");
    }

    #[test]
    fn pronouns_are_not_search_terms() {
        assert_eq!(query_terms("his election must be valued by him"), vec!["election", "valued"]);
    }

    #[test]
    fn long_notes_are_clipped() {
        let long = "word ".repeat(100);
        let n = sanitize_notes(&json!({"notes": [{"candidate": 1, "note": long}]}), &cands());
        assert!(n["10.7:24"].chars().count() <= MAX_NOTE_CHARS);
    }

    #[test]
    fn hostile_search_input_is_safe() {
        let terms = query_terms(r#"election" OR NOT * ) ( NEAR kahalalan"#);
        let q = fts_query(&terms, "OR");
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(crate::db::SCHEMA).unwrap();
        c.query_row("SELECT count(*) FROM verses_fts WHERE verses_fts MATCH ?1", [q], |r| r.get::<_, i64>(0)).unwrap();
    }
}
