//! Bounded, offline English/Tagalog keyword aliases shared with the frontend.
//! These aid keyword lookup; they are not a general translation service.

use regex::Regex;
use rusqlite::{params, Connection};
use std::{collections::{HashMap, HashSet}, sync::LazyLock};
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

const MAX_QUERY_CHARS: usize = 512;
const MAX_QUERY_WORDS: usize = 24;
const MAX_QUERY_GROUPS: usize = 16;

pub fn normalize(text: &str) -> String {
    static NUMBER_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(^|[^\p{L}\p{N}])([0-9]{1,3})(\p{L})").unwrap());
    static WORD_NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\p{L})([0-9]+)($|[^\p{L}\p{N}])").unwrap());
    static SEPARATORS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}]+").unwrap());
    let folded: String = text.nfd().filter(|c| !is_combining_mark(*c)).flat_map(char::to_lowercase).collect();
    let numbered = NUMBER_WORD.replace_all(&folded, "$1$2 $3");
    let chapters = WORD_NUMBER.replace_all(&numbered, "$1 $2$3");
    SEPARATORS.replace_all(&chapters, " ").trim().to_string()
}

struct Vocabulary {
    aliases: HashMap<String, Vec<String>>,
    longest: usize,
}

static VOCABULARY: LazyLock<Vocabulary> = LazyLock::new(|| {
    let source: Vec<Vec<String>> = serde_json::from_str(include_str!("../../shared/search-aliases.json")).expect("valid search alias vocabulary");
    let mut aliases = HashMap::new();
    let mut longest = 1;
    for values in source {
        let mut group = Vec::new();
        for value in values {
            let normalized = normalize(&value);
            if !normalized.is_empty() && !group.contains(&normalized) {
                group.push(normalized);
            }
        }
        for value in &group {
            longest = longest.max(value.split_whitespace().count());
            aliases.insert(value.clone(), group.clone());
        }
    }
    Vocabulary { aliases, longest }
});

#[derive(Debug)]
struct Group {
    alternatives: Vec<String>,
    prefix: bool,
}

fn groups(query: &str) -> Vec<Group> {
    let bounded: String = query.chars().take(MAX_QUERY_CHARS).collect();
    let normalized = normalize(&bounded);
    let words: Vec<&str> = normalized.split_whitespace().take(MAX_QUERY_WORDS).collect();
    let mut groups = Vec::new();
    let mut at = 0;
    while at < words.len() && groups.len() < MAX_QUERY_GROUPS {
        let mut matched = false;
        for length in (1..=VOCABULARY.longest.min(words.len() - at)).rev() {
            let phrase = words[at..at + length].join(" ");
            if let Some(alternatives) = VOCABULARY.aliases.get(&phrase) {
                groups.push(Group { alternatives: alternatives.clone(), prefix: false });
                at += length;
                matched = true;
                break;
            }
        }
        if !matched {
            let word = words[at];
            at += 1;
            groups.push(Group {
                alternatives: vec![word.to_string()],
                prefix: at == words.len() && word.chars().count() >= 3 && word.chars().all(char::is_alphabetic),
            });
        }
    }
    // FTS phrases retain chapter/verse order instead of matching swapped numbers.
    static REFERENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b\d{1,3}\s*:\s*\d{1,3}(?:\s*[-–]\s*\d{1,3})?").unwrap());
    for reference in REFERENCE.find_iter(&bounded) {
        if groups.len() >= MAX_QUERY_GROUPS { break; }
        groups.push(Group { alternatives: vec![normalize(reference.as_str())], prefix: false });
    }
    groups
}

fn matches_group(normalized: &str, group: &Group) -> bool {
    let padded = format!(" {normalized} ");
    group.alternatives.iter().any(|alternative| {
        padded.contains(&format!(" {alternative} ")) || (group.prefix && normalized.split_whitespace().any(|word| word.starts_with(alternative)))
    })
}

fn fts_group(group: &Group) -> String {
    group.alternatives.iter().map(|value| format!("\"{}\"{}", value.replace('"', "\"\""), if group.prefix { "*" } else { "" })).collect::<Vec<_>>().join(" OR ")
}

/// A term may be in metadata and another in the PDF's body. Each term therefore
/// matches either owner-scoped FTS content or the owner's current metadata; all
/// groups must match. No schema migration or rewritten lesson text is needed.
pub fn lesson_ids(conn: &Connection, user_id: &str, query: &str) -> rusqlite::Result<Vec<String>> {
    let groups = groups(query);
    if groups.is_empty() {
        return Ok(Vec::new());
    }
    let mut content_hits = Vec::new();
    let mut fts = conn.prepare(
        "SELECT l.id FROM lessons_fts JOIN lessons l ON l.seq=lessons_fts.rowid
         WHERE lessons_fts MATCH ?1 AND l.user_id=?2",
    )?;
    for group in &groups {
        let hits = fts.query_map(params![fts_group(group), user_id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<HashSet<_>>>()?;
        content_hits.push(hits);
    }
    let mut metadata = conn.prepare(
        "SELECT id, title || ' ' || code || ' ' || location || ' ' || local_congregation || ' ' || district || ' ' || author || ' ' || file_name || ' ' ||
         coalesce(lesson_date,'') || ' ' || date_label || ' ' || issue || ' ' || objectives
         FROM lessons WHERE user_id=?1 ORDER BY coalesce(lesson_date,created_at) DESC, seq DESC",
    )?;
    let rows = metadata.query_map([user_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut found = Vec::new();
    for row in rows {
        let (id, fields) = row?;
        let normalized = normalize(&fields);
        let mut score = 0;
        let matched = groups.iter().enumerate().all(|(index, group)| {
            if matches_group(&normalized, group) {
                score += 2;
                true
            } else if content_hits[index].contains(&id) {
                score += 1;
                true
            } else {
                false
            }
        });
        if matched {
            found.push((id, score));
        }
    }
    found.sort_by(|a, b| b.1.cmp(&a.1));
    // The client already holds the lesson catalogue and paginates its results.
    // Return every matching ID so year/language filters cannot hide later hits.
    Ok(found.into_iter().map(|(id, _)| id).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_matches_remain_available_for_client_filters_and_pagination() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::SCHEMA).unwrap();
        conn.execute("INSERT INTO users VALUES ('u','a@b.c','','now')", []).unwrap();
        let tx = conn.transaction().unwrap();
        for index in 0..205 {
            tx.execute(
                "INSERT INTO lessons (id,user_id,title,category,language,file_name,sha256,byte_size,page_count,source_kind,content,created_at)
                 VALUES (?1,'u','Search catalogue','weekend','en',?1,?1,1,1,'text','A fulltextmark for every record.','now')",
                [format!("lesson-{index}")],
            ).unwrap();
        }
        tx.commit().unwrap();
        assert_eq!(lesson_ids(&conn, "u", "fulltextmark").unwrap().len(), 205);
    }

    fn matches(text: &str, query: &str) -> bool {
        let terms = groups(query);
        !terms.is_empty() && terms.iter().all(|group| matches_group(&normalize(text), group))
    }

    #[test]
    fn keyword_aliases_are_bilingual_bounded_and_do_not_match_inside_words() {
        assert!(matches("Pag-ibig ng Diyos at paglilingkod", "love of God service"));
        assert!(matches("Faith and service", "pananampalataya at paglilingkod"));
        assert!(matches("II Kings 5:15", "II Hari5:15"));
        assert!(matches("I Hari 5:15", "1 Kings 5:15"));
        assert!(!matches("I Hari 5:15", "II Kings 5:15"));
        assert!(!matches("Genesis 8:6", "Genesis 6:8"));
        assert!(matches("Awit ng mga Awit", "Song of Solomon"));
        assert!(matches("Distrito: CALOOCÁN-NORTH", "caloocan north"));
        assert!(matches("8Subalit gising ang mga bantay", "subalit"));
        assert!(!matches("faithful service", "faith"));
        assert!(!matches("gloves", "love"));
        assert!(matches("Zephyrword gathering", "zephy"));
        assert!(!matches("12345", "123"));
        assert!(groups(&"unknown ".repeat(100)).len() <= MAX_QUERY_GROUPS);
    }

    #[test]
    fn metadata_and_pdf_content_can_match_different_terms_without_crossing_owners() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::SCHEMA).unwrap();
        conn.execute_batch("INSERT INTO users VALUES ('u','a@b.c','','now'),('other','other@b.c','','now');").unwrap();
        for (id, owner, title, content, local, district) in [
            ("a", "u", "A faithful watch", "Faith grows with service. II Kings 5:15", "DEPARO", "CALOOCAN NORTH"),
            ("b", "u", "Pag-ibig ng Diyos", "Paglilingkod at pag-asa", "Sample Local", "Sample District"),
            ("c", "other", "A faithful watch", "Faith grows with service. II Kings 5:15", "DEPARO", "CALOOCAN NORTH"),
        ] {
            conn.execute(
                "INSERT INTO lessons (id,user_id,title,category,language,file_name,sha256,byte_size,page_count,source_kind,content,local_congregation,district,created_at)
                 VALUES (?1,?2,?3,'pastoral','tl',?1,?1,1,1,'text',?4,?5,?6,'now')",
                params![id, owner, title, content, local, district],
            ).unwrap();
        }
        assert_eq!(lesson_ids(&conn, "u", "deparo pananampalataya").unwrap(), ["a"]);
        assert_eq!(lesson_ids(&conn, "u", "II Hari 5:15").unwrap(), ["a"]);
        assert_eq!(lesson_ids(&conn, "u", "love of god hope").unwrap(), ["b"]);
        assert!(lesson_ids(&conn, "u", "I Hari 5:15").unwrap().is_empty());
        assert!(lesson_ids(&conn, "nobody", "faith").unwrap().is_empty());
        assert!(lesson_ids(&conn, "u", "\" OR * NOT {faith}; DROP TABLE users;").unwrap().is_empty());
        assert!(lesson_ids(&conn, "u", "***").unwrap().is_empty());
        conn.execute("UPDATE lessons SET local_congregation='Corrected Place',district='New District' WHERE id='a'", []).unwrap();
        assert_eq!(lesson_ids(&conn, "u", "corrected faith").unwrap(), ["a"]);
        assert!(lesson_ids(&conn, "u", "deparo faith").unwrap().is_empty());
        let users: i64 = conn.query_row("SELECT count(*) FROM users", [], |r| r.get(0)).unwrap();
        assert_eq!(users, 2);
    }
}
