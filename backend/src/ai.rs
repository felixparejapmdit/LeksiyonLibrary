//! Retrieval and AI notes.
//!
//! Guardrail: the model never supplies scripture. Retrieval is plain full-text
//! ranking over stored verses. The model only sees numbered candidates and may
//! return a short note per candidate number; verse text shown to the user is
//! always read from the database by id. Nothing in this module writes to the
//! verses table.
//!
//! The speaker and context shown beside a verse are the model's reading, not
//! facts from the library, and are always labelled that way in the interface.

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

pub fn query_terms(input: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    input
        .split(|c: char| !c.is_alphanumeric() && c != '-')
        .map(|w| w.trim_matches('-').to_lowercase())
        .filter(|w| w.chars().count() >= 3 && !STOPWORDS.contains(&w.as_str()))
        .filter(|w| seen.insert(w.clone()))
        .take(24)
        .collect()
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
            *scores.entry(key).or_default() += 3.0 * -bm;
        }
    }
    // Verses cited by lessons about the same topic are a weaker signal.
    {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT v.canonical_key, bm25(lessons_fts)
             FROM lessons_fts JOIN lessons l ON l.seq = lessons_fts.rowid
             JOIN lesson_verses lv ON lv.lesson_id = l.id JOIN verses v ON v.id = lv.verse_id
             WHERE lessons_fts MATCH ?1 AND l.user_id = ?2",
        )?;
        let rows = stmt.query_map(params![q, user_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))?;
        for row in rows {
            let (key, bm) = row?;
            *scores.entry(key).or_default() += 0.5 * -bm;
        }
    }

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
    }))
}

/// Combines keyword and meaning results, ranking well in either list counting for more
/// than the raw scores, which are not comparable with each other.
pub fn merge_meaning(conn: &Connection, user_id: &str, keyword: Vec<Suggestion>, meaning: &[(String, f32)], limit: usize) -> rusqlite::Result<Vec<Suggestion>> {
    const DAMPING: f64 = 60.0;
    let mut fused: HashMap<String, f64> = HashMap::new();
    for (i, s) in keyword.iter().enumerate() {
        *fused.entry(s.canonical_key.clone()).or_default() += 1.0 / (DAMPING + i as f64 + 1.0);
    }
    for (i, (key, _)) in meaning.iter().enumerate() {
        *fused.entry(key.clone()).or_default() += 1.0 / (DAMPING + i as f64 + 1.0);
    }
    let mut order: Vec<(String, f64)> = fused.into_iter().collect();
    order.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    order.truncate(limit);
    let mut by_key: HashMap<String, Suggestion> = keyword.into_iter().map(|s| (s.canonical_key.clone(), s)).collect();
    let mut out = Vec::new();
    for (key, score) in order {
        match by_key.remove(&key) {
            Some(s) => out.push(s),
            None => out.extend(build_suggestion(conn, user_id, &key, score, &[], true)?),
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

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct VerseContext {
    pub speaker: String,
    pub context: String,
}

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

/// Validates the speaker and context the same way as notes, and also discards any
/// that cite a verse: the model may describe a passage but not add references.
pub fn sanitize_context(reply: &Value, candidates: &[Candidate]) -> HashMap<String, VerseContext> {
    let mut out = HashMap::new();
    let Some(items) = reply.get("notes").and_then(|n| n.as_array()) else {
        return out;
    };
    let clean = |item: &Value, field: &str, verse: &str, max: usize| -> Option<String> {
        let text = item.get(field)?.as_str()?.trim();
        let rejected = text.is_empty()
            || QUOTED.is_match(text)
            || reproduces_scripture(text, verse)
            || !crate::parser::find_references(text).is_empty();
        (!rejected).then(|| text.chars().take(max).collect())
    };
    for item in items {
        let Some(num) = item.get("candidate").and_then(candidate_number) else {
            continue;
        };
        let Some((key, _, verse)) = num.checked_sub(1).and_then(|i| candidates.get(i as usize)) else {
            continue;
        };
        let speaker = clean(item, "speaker", verse, MAX_SPEAKER_CHARS);
        let context = clean(item, "context", verse, MAX_NOTE_CHARS);
        if speaker.is_some() || context.is_some() {
            out.insert(key.clone(), VerseContext { speaker: speaker.unwrap_or_default(), context: context.unwrap_or_default() });
        }
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

pub struct NotesResult {
    pub notes: HashMap<String, String>,
    pub context: HashMap<String, VerseContext>,
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
        {\"notes\":[{\"candidate\":<number>,\"speaker\":\"<who is speaking>\",\"context\":\"<one short sentence>\",\"note\":\"<one short sentence>\"}]}. \
        For each candidate: speaker names who is speaking in the verse, or says \"Not stated\" if the passage does not make it clear; \
        context says who is being addressed and what is happening at that point in the book; note explains why the candidate fits the \
        issue and objective. If you are unsure, say so rather than guessing. Never quote, paraphrase, translate or rewrite scripture. \
        Never add verses or references. Use only the candidate numbers given.";
    let user = format!("Issue: {issue}\nObjective: {objective}\n\n{list}");
    let resp = client
        .post(format!("{}/api/chat", base_url.trim_end_matches('/')))
        .json(&json!({
            "model": model,
            "stream": false,
            "format": "json",
            "options": { "temperature": 0.1 },
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
    Ok(NotesResult { notes: sanitize_notes(&parsed, candidates), context: sanitize_context(&parsed, candidates), model: model.to_string() })
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
    fn valid_speaker_and_context_are_kept() {
        let reply = json!({"notes": [{"candidate": 1, "speaker": "King David", "context": "David is praying after God's promise.", "note": "Fits."}]});
        let c = sanitize_context(&reply, &cands());
        assert_eq!(c["10.7:24"], VerseContext { speaker: "King David".into(), context: "David is praying after God's promise.".into() });
    }

    #[test]
    fn context_cannot_quote_scripture_cite_verses_or_use_unknown_candidates() {
        let reply = json!({"notes": [
            {"candidate": 1, "speaker": "David", "context": "It says \"the sample verse one speaks of a people kept safe\"."},
            {"candidate": 2, "speaker": "Paul", "context": "As John 3:16 also teaches."},
            {"candidate": 9, "speaker": "Nobody", "context": "Invented."},
            {"candidate": 0, "speaker": "Nobody", "context": "Invented."}
        ]});
        let c = sanitize_context(&reply, &cands());
        assert_eq!(c["10.7:24"].context, "");
        assert_eq!(c["45.9:4"].context, "");
        assert_eq!(c["45.9:4"].speaker, "Paul");
        assert_eq!(c.len(), 2);
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
        let merged = merge_meaning(&c, "u", keyword.clone(), &[("1.1:3".to_string(), 0.9), (keyword[0].canonical_key.clone(), 0.8)], 5).unwrap();
        assert_eq!(merged[0].canonical_key, keyword[0].canonical_key, "found both ways ranks first");
        let added = merged.iter().find(|s| s.canonical_key == "1.1:3").unwrap();
        assert!(added.meaning && added.matched_terms.is_empty());
        assert!(!merged[0].meaning);
        assert!(merge_meaning(&c, "u", vec![], &[("1.1:3".to_string(), 0.9)], 5).unwrap().len() == 1);
        assert_eq!(merge_meaning(&c, "u", keyword, &[("1.1:3".to_string(), 0.9)], 1).unwrap().len(), 1);
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
