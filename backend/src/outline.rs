//! The parts of a lesson, and how Lesson Library verses are matched to what a lecture needs.
//!
//! A lesson teaches objective n in part n: its first objective in the beginning (Pasimula),
//! the second in I., the third in II., and so on. Each part asks questions, with verses under
//! them. So a lesson's verse is suggested for an objective only when the part it is printed in
//! matches that objective, judged by the lesson's own objective for the part, the part's
//! heading and its questions. Every lesson is searched, so one objective can draw verses from
//! several lessons. An issue or topic on its own is matched against whole lessons instead,
//! and the verses then come from across the lesson.
//!
//! Matching is by words only, and only verses stored in the vault are ever returned.

use crate::ai::content_words;
use crate::parser::{self, ParsedVerse, Section, CONCLUSION};
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};

/// Words found in nearly every objective ("so that the brethren understand ...") that say
/// nothing about what it is about.
const FILLER: &[&str] = &[
    "maunawaan", "mauunawaan", "maipaunawa", "ipaunawa", "malaman", "matutuhan", "matutunan", "maipaalam",
    "ipaalam", "makilala", "kapatid", "kapatiran", "layunin", "lahat", "understand", "know", "learn", "realize",
    "brethren", "brother", "brothers", "sister", "sisters", "members", "member", "objective", "lesson", "leksiyon",
];

/// Share of the objective's weight a part must cover to count as a match.
const MIN_MATCH: f64 = 0.34;
/// Each part of a lesson teaches its own objective, so within one lesson only the part that
/// matches best counts, and any part that matches nearly as well.
const NEAR_BEST: f64 = 0.75;
/// Lessons a suggestion lists as its sources, best match first.
const MAX_SOURCES: usize = 3;

/// Where in the Lesson Library a suggested verse was found.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct LessonMatch {
    pub lesson_id: String,
    pub title: String,
    pub file_name: String,
    /// The part of the lesson: see `parser::ParsedVerse::section`. -1 when not known.
    pub section: i64,
    /// The lesson's own objective for that part, when it has one.
    pub objective: String,
    pub question: String,
}

pub struct LessonHit {
    pub canonical_key: String,
    pub score: f64,
    pub sources: Vec<LessonMatch>,
}

/// Reads the parts of lessons stored before parts were recorded, from the text kept with them.
/// Verses are matched to the stored ones in order, by reference.
pub fn backfill(conn: &Connection) -> rusqlite::Result<usize> {
    let pending: Vec<(String, String, String)> = {
        let mut st = conn.prepare("SELECT id, content, file_name FROM lessons WHERE outline = ''")?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    for (id, content, file_name) in &pending {
        let parsed = parser::parse(std::slice::from_ref(content), file_name);
        let stored: Vec<(String, String)> = {
            let mut st = conn.prepare(
                "SELECT lv.id, v.canonical_key FROM lesson_verses lv JOIN verses v ON v.id = lv.verse_id WHERE lv.lesson_id = ?1 ORDER BY lv.ordinal, lv.rowid",
            )?;
            let rows = st.query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<Result<_, _>>()?
        };
        let keys: Vec<String> = stored.iter().map(|s| s.1.clone()).collect();
        let mut last: Option<&ParsedVerse> = None;
        for ((link, _), found) in stored.iter().zip(align(&keys, &parsed.verses)) {
            // A verse that cannot be found again sits in the same part as the one before it.
            if let Some(k) = found {
                last = Some(&parsed.verses[k]);
            }
            if let Some(v) = last {
                conn.execute("UPDATE lesson_verses SET section = ?1, question = ?2 WHERE id = ?3", params![v.section, v.question, link])?;
            }
        }
        conn.execute("UPDATE lessons SET outline = ?1 WHERE id = ?2", params![json!(parsed.outline).to_string(), id])?;
    }
    Ok(pending.len())
}

/// For each stored reference, the parsed verse it is, keeping their order. The book number
/// may have been corrected since, so chapter and verses alone are the fallback.
fn align(stored: &[String], parsed: &[ParsedVerse]) -> Vec<Option<usize>> {
    let place = |k: &str| k.split_once('.').map_or(k.to_string(), |x| x.1.to_string());
    let mut from = 0;
    stored
        .iter()
        .map(|key| {
            let found = (from..parsed.len())
                .find(|&k| parsed[k].canonical_key == *key)
                .or_else(|| (from..parsed.len()).find(|&k| place(&parsed[k].canonical_key) == place(key)));
            if let Some(k) = found {
                from = k + 1;
            }
            found
        })
        .collect()
}

fn words(text: &str) -> Vec<String> {
    content_words(text).into_iter().filter(|w| !FILLER.contains(&w.as_str())).collect()
}

/// Tagalog builds words around a root ("bantay", "pagbabantay", "binabantayan"), so a word
/// of five letters or more also matches a longer word containing it.
fn has(doc: &HashSet<String>, term: &str) -> bool {
    doc.contains(term)
        || doc.iter().any(|w| {
            let (short, long) = if w.chars().count() < term.chars().count() { (w.as_str(), term) } else { (term, w.as_str()) };
            short.chars().count() >= 5 && long.contains(short)
        })
}

/// How much of the query each document covers, rare words counting for more. A document
/// sharing a single word with a longer query does not count.
fn coverage(query: &[String], docs: &[HashSet<String>]) -> Vec<f64> {
    if query.is_empty() {
        return vec![0.0; docs.len()];
    }
    let n = docs.len() as f64;
    let weight: Vec<f64> = query
        .iter()
        .map(|t| (1.0 + n / docs.iter().filter(|d| has(d, t)).count().max(1) as f64).ln())
        .collect();
    let total: f64 = weight.iter().sum();
    let needed = query.len().min(2);
    docs.iter()
        .map(|d| {
            let hits: Vec<f64> = query.iter().zip(&weight).filter(|(t, _)| has(d, t)).map(|(_, w)| *w).collect();
            if hits.len() < needed { 0.0 } else { hits.iter().sum::<f64>() / total }
        })
        .collect()
}

struct Lesson {
    id: String,
    title: String,
    file_name: String,
    issue: String,
    objectives: Vec<String>,
    outline: Vec<Section>,
}

struct Verse {
    key: String,
    section: i64,
    question: String,
}

impl Lesson {
    fn part(&self, n: i64) -> Option<&Section> {
        self.outline.iter().find(|s| s.number as i64 == n)
    }
    fn objective(&self, n: i64) -> String {
        if n < 1 || n == CONCLUSION as i64 { return String::new() }
        self.objectives.get(n as usize - 1).cloned().unwrap_or_default()
    }
    fn whole(&self) -> String {
        let parts = self.outline.iter().map(|s| format!("{} {}", s.heading, s.questions.join(" "))).collect::<Vec<_>>().join(" ");
        format!("{} {} {} {parts}", self.title, self.issue, self.objectives.join(" "))
    }
    fn found(&self, v: &Verse) -> LessonMatch {
        LessonMatch {
            lesson_id: self.id.clone(),
            title: self.title.clone(),
            file_name: self.file_name.clone(),
            section: v.section,
            objective: self.objective(v.section),
            question: v.question.clone(),
        }
    }
}

fn load(conn: &Connection, user_id: &str) -> rusqlite::Result<(Vec<Lesson>, HashMap<String, Vec<Verse>>)> {
    let mut st = conn.prepare("SELECT id, title, file_name, issue, objectives, outline FROM lessons WHERE user_id = ?1 ORDER BY lesson_date DESC, id")?;
    let lessons = st
        .query_map([user_id], |r| {
            Ok(Lesson {
                id: r.get(0)?,
                title: r.get(1)?,
                file_name: r.get(2)?,
                issue: r.get(3)?,
                objectives: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or_default(),
                outline: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or_default(),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut st = conn.prepare(
        "SELECT lv.lesson_id, v.canonical_key, lv.section, lv.question FROM lesson_verses lv JOIN verses v ON v.id = lv.verse_id
         WHERE lv.user_id = ?1 ORDER BY lv.lesson_id, lv.ordinal, lv.rowid",
    )?;
    let mut verses: HashMap<String, Vec<Verse>> = HashMap::new();
    for row in st.query_map([user_id], |r| Ok((r.get::<_, String>(0)?, Verse { key: r.get(1)?, section: r.get(2)?, question: r.get(3)? })))? {
        let (lesson, v) = row?;
        let list = verses.entry(lesson).or_default();
        // The same reference twice in one lesson is one suggestion.
        if !list.iter().any(|x| x.key == v.key) {
            list.push(v);
        }
    }
    Ok((lessons, verses))
}

/// Stands for the whole of a lesson that has no objectives to divide it by.
const WHOLE_LESSON: i64 = i64::MIN;

/// Lesson Library verses for one objective, from the matching part of every lesson.
/// A lesson without objectives, such as one with only a topic and verses, cannot be divided
/// that way, so it is matched as a whole. The issue, when given, favours lessons about the
/// same issue.
pub fn for_objective(conn: &Connection, user_id: &str, issue: &str, objective: &str, limit: usize) -> rusqlite::Result<Vec<LessonHit>> {
    let query = words(objective);
    let (lessons, verses) = load(conn, user_id)?;
    // One document per part that teaches an objective.
    let mut parts: Vec<(usize, i64)> = Vec::new();
    let mut docs: Vec<HashSet<String>> = Vec::new();
    for (i, l) in lessons.iter().enumerate() {
        if l.objectives.is_empty() {
            parts.push((i, WHOLE_LESSON));
            docs.push(words(&l.whole()).into_iter().collect());
        }
        for n in 1..=l.objectives.len() as i64 {
            let (heading, questions) = l.part(n).map_or((String::new(), String::new()), |s| (s.heading.clone(), s.questions.join(" ")));
            parts.push((i, n));
            docs.push(words(&format!("{} {heading} {questions}", l.objective(n))).into_iter().collect());
        }
    }
    let scores = coverage(&query, &docs);
    let issue_terms = words(issue);
    let issue_docs: Vec<HashSet<String>> = lessons.iter().map(|l| words(&format!("{} {}", l.title, l.issue)).into_iter().collect()).collect();
    let issue_scores = coverage(&issue_terms, &issue_docs);

    let mut best: HashMap<usize, f64> = HashMap::new();
    for ((lesson, _), score) in parts.iter().zip(&scores) {
        let b = best.entry(*lesson).or_default();
        *b = b.max(*score);
    }
    let mut hits = Hits::default();
    for ((lesson, n), score) in parts.iter().zip(scores) {
        if score < MIN_MATCH || score < NEAR_BEST * best[lesson] {
            continue;
        }
        let l = &lessons[*lesson];
        let boosted = score * (1.0 + 0.5 * issue_scores[*lesson]);
        for v in verses.get(&l.id).into_iter().flatten().filter(|v| *n == WHOLE_LESSON || v.section == *n) {
            // Under the part, the verses answering a question that matches come first.
            let question: HashSet<String> = words(&v.question).into_iter().collect();
            let answers = query.iter().filter(|t| has(&question, t)).count() as f64 / query.len() as f64;
            hits.add(&v.key, boosted * (1.0 + 0.5 * answers), l.found(v));
        }
    }
    Ok(hits.ranked(limit))
}

/// Lesson Library verses for an issue or topic, from across every lesson that matches it.
/// Each lesson gives the first verse of each part before the second, so they span the lesson.
pub fn for_topic(conn: &Connection, user_id: &str, topic: &str, limit: usize) -> rusqlite::Result<Vec<LessonHit>> {
    let query = words(topic);
    let (lessons, verses) = load(conn, user_id)?;
    let docs: Vec<HashSet<String>> = lessons.iter().map(|l| words(&l.whole()).into_iter().collect()).collect();
    let mut hits = Hits::default();
    for (l, score) in lessons.iter().zip(coverage(&query, &docs)) {
        if score < MIN_MATCH {
            continue;
        }
        let list = verses.get(&l.id).map(Vec::as_slice).unwrap_or_default();
        let mut seen: HashMap<i64, usize> = HashMap::new();
        for v in list {
            let place = seen.entry(v.section).or_default();
            *place += 1;
            hits.add(&v.key, score / (1.0 + 0.01 * *place as f64), l.found(v));
        }
    }
    Ok(hits.ranked(limit))
}

#[derive(Default)]
struct Hits(HashMap<String, (f64, Vec<(f64, LessonMatch)>)>);

impl Hits {
    fn add(&mut self, key: &str, score: f64, from: LessonMatch) {
        let entry = self.0.entry(key.to_string()).or_insert((0.0, vec![]));
        entry.0 = entry.0.max(score);
        match entry.1.iter_mut().find(|(_, m)| m.lesson_id == from.lesson_id) {
            Some(existing) if existing.0 >= score => {}
            Some(existing) => *existing = (score, from),
            None => entry.1.push((score, from)),
        }
    }
    fn ranked(self, limit: usize) -> Vec<LessonHit> {
        let mut out: Vec<LessonHit> = self
            .0
            .into_iter()
            .map(|(key, (score, mut sources))| {
                sources.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.title.cmp(&b.1.title)));
                LessonHit { canonical_key: key, score, sources: sources.into_iter().take(MAX_SOURCES).map(|s| s.1).collect() }
            })
            .collect();
        out.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.canonical_key.cmp(&b.canonical_key)));
        out.truncate(limit);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Made-up lessons, as all test data must be: this repository is public.
    const WATCH: &str = "Isyu\nMarami ang nakakalimot magbantay.\nMga Layunin\n1. Maunawaan ang tawag sa pagbabantay.\n2. Makilala ang mga bantay na tapat.\n3. Malaman ang tungkulin ng bantay sa pintuan.\n4. Maitaguyod ang pagbabantay sa gabi.\nPANIMULA\nPambungad.\nPASIMULA:\nT. Ano ang tawag sa mga bantay?\nS. Sila ay tinawag ..... Juan 3:5 NIRV\nAng mga bantay ay gising.\nI. SINO ANG MGA BANTAY NA TAPAT\nT. Sino ang tapat?\nS. Ang tapat ..... Juan 3:6 NIRV\nAng ilaw ay hindi namamatay.\nT. Ano ang hawak na lampara ng tapat?\nS. Ang lampara ..... Juan 3:10 NIRV\nAng lampara ay laging may langis.\nII. ANO ANG TUNGKULIN NG BANTAY\nT. Saan sila nakatayo?\nS. Sa pintuan ..... Juan 3:7 NIRV\nAng bantay ay sumisigaw sa pintuan.\nIII. PAPAANO MAITATAGUYOD ANG PAGBABANTAY\nT. Kailan tayo magbabantay?\nS. Sa gabi ..... Juan 3:8 NIRV\nAng bantay ay hindi natutulog.\nKONKLUSYON\nWakas.";
    const HARVEST: &str = "Isyu\nAng ani ay napapabayaan.\nMga Layunin\n1. Maunawaan ang panahon ng ani.\n2. Makilala ang mga manggagawa sa bukid.\n3. Malaman kung sino ang mga bantay na tapat sa bukid.\nPANIMULA\nPambungad.\nPASIMULA:\nS. Ang ani ..... Marcos 4:1 NIRV\nAng ani ay malapit na.\nI. SINO ANG MGA MANGGAGAWA\nS. Ang manggagawa ..... Marcos 4:2 NIRV\nAng manggagawa ay masipag.\nII. SINO ANG BANTAY NA TAPAT SA BUKID\nT. Sino ang tapat na bantay ng bukid?\nS. Ang tapat ..... Marcos 4:3 NIRV\nAng bantay ng bukid ay gising.\nKONKLUSYON\nWakas.";

    fn vault() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(crate::db::SCHEMA).unwrap();
        c.execute("INSERT INTO users VALUES ('u','a@b.c','','now')", []).unwrap();
        add(&c, "watch", "2025_Wk01a.pdf", WATCH);
        add(&c, "harvest", "2025_Wk02a.pdf", HARVEST);
        c
    }

    fn add(c: &Connection, id: &str, file: &str, text: &str) {
        let p = parser::parse(&[text.to_string()], file);
        c.execute(
            "INSERT INTO lessons (id,user_id,title,category,language,file_name,sha256,byte_size,page_count,source_kind,content,issue,objectives,created_at,outline)
             VALUES (?1,'u',?7,'midweek','tl',?2,?1,1,1,'text',?3,?4,?5,'now',?6)",
            params![id, file, text, p.issue, json!(p.objectives).to_string(), json!(p.outline).to_string(), p.title],
        )
        .unwrap();
        for (i, v) in p.verses.iter().enumerate() {
            let vid = format!("{id}-{i}");
            c.execute(
                "INSERT INTO verses (id,user_id,canonical_key,book_id,ref_printed,ref_en,ref_tl,version,language,text,text_sha256,ocr_raw,status,created_at)
                 VALUES (?1,'u',?2,?3,?4,?4,?4,'NIRV','tl',?5,'h',?6,'unverified','now')",
                params![vid, v.canonical_key, v.book_id, v.ref_printed, v.text, v.raw],
            )
            .unwrap();
            c.execute(
                "INSERT INTO lesson_verses (id,user_id,lesson_id,verse_id,page,ordinal,section,question) VALUES (?1,'u',?2,?1,1,?3,?4,?5)",
                params![vid, id, i as i64, v.section, v.question],
            )
            .unwrap();
        }
    }

    fn keys(hits: &[LessonHit]) -> Vec<&str> {
        hits.iter().map(|h| h.canonical_key.as_str()).collect()
    }

    fn parts(c: &Connection) -> Vec<(i64, String)> {
        let mut st = c.prepare("SELECT section, question FROM lesson_verses ORDER BY lesson_id, ordinal").unwrap();
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<Result<_, _>>().unwrap()
    }

    #[test]
    fn an_objective_gets_the_verses_of_the_part_that_teaches_it_in_every_lesson() {
        let c = vault();
        let hits = for_objective(&c, "u", "", "Makilala ang mga bantay na tapat", 10).unwrap();
        // Part I of the first lesson (its second objective), and part II of the second (its third).
        let mut found = keys(&hits);
        found.sort();
        assert_eq!(found, vec!["41.4:3", "43.3:10", "43.3:6"]);
        let first = hits.iter().find(|h| h.canonical_key == "43.3:6").unwrap();
        assert_eq!(
            first.sources,
            vec![LessonMatch {
                lesson_id: "watch".into(),
                title: "2025 Wk01a".into(),
                file_name: "2025_Wk01a.pdf".into(),
                section: 2,
                objective: "Makilala ang mga bantay na tapat.".into(),
                question: "Sino ang tapat?".into(),
            }]
        );
        let other = hits.iter().find(|h| h.canonical_key == "41.4:3").unwrap();
        assert_eq!((other.sources[0].file_name.as_str(), other.sources[0].section), ("2025_Wk02a.pdf", 3));
    }

    #[test]
    fn within_one_lesson_only_the_part_that_matches_best_counts() {
        let c = vault();
        // Objective 3 of the first lesson, with a word of its objective 1 added.
        let hits = for_objective(&c, "u", "", "Malaman ang tungkulin ng bantay sa pintuan at ang tawag", 10).unwrap();
        assert_eq!(keys(&hits), vec!["43.3:7"]);
    }

    #[test]
    fn under_a_part_the_verse_answering_a_matching_question_comes_first() {
        let c = vault();
        let hits = for_objective(&c, "u", "", "Ang lampara ng mga bantay na tapat", 10).unwrap();
        let place = |k: &str| keys(&hits).iter().position(|x| *x == k).unwrap();
        assert!(place("43.3:10") < place("43.3:6"), "{:?}", keys(&hits));
    }

    #[test]
    fn the_issue_favours_lessons_about_the_same_issue() {
        let c = vault();
        let score = |issue: &str, key: &str| {
            for_objective(&c, "u", issue, "Makilala ang mga bantay na tapat", 10).unwrap().into_iter().find(|h| h.canonical_key == key).unwrap().score
        };
        assert!(score("ani napapabayaan", "41.4:3") > score("", "41.4:3"));
        assert_eq!(score("ani napapabayaan", "43.3:6"), score("", "43.3:6"));
    }

    #[test]
    fn an_objective_no_part_teaches_finds_nothing() {
        let c = vault();
        assert!(for_objective(&c, "u", "", "Ang pag-aawit ng papuri", 10).unwrap().is_empty());
        assert!(for_objective(&c, "u", "", "", 10).unwrap().is_empty());
        // One shared word with a longer objective is not enough.
        assert!(for_objective(&c, "u", "", "Ang bantay at ang ulan at hangin sa dagat", 10).unwrap().is_empty());
    }

    #[test]
    fn a_lesson_without_objectives_is_matched_as_a_whole() {
        let c = vault();
        add(&c, "plain", "plain.pdf", "Paksa: Zephyrword na aralin
Talata: Juan 3:5");
        let hits = for_objective(&c, "u", "", "Zephyrword", 5).unwrap();
        assert_eq!(keys(&hits), vec!["43.3:5"]);
        assert_eq!(hits[0].sources.iter().map(|s| s.file_name.as_str()).collect::<Vec<_>>(), vec!["plain.pdf"]);
    }

    #[test]
    fn a_topic_gets_verses_from_across_the_whole_lesson() {
        let c = vault();
        let hits = for_topic(&c, "u", "nakakalimot magbantay", 4).unwrap();
        // The first verse of each part comes before a second verse of any part.
        let mut found = keys(&hits);
        found.sort();
        assert_eq!(found, vec!["43.3:5", "43.3:6", "43.3:7", "43.3:8"]);
        assert!(hits.iter().all(|h| h.sources[0].file_name == "2025_Wk01a.pdf"));
        let sections: HashSet<i64> = hits.iter().map(|h| h.sources[0].section).collect();
        assert_eq!(sections, HashSet::from([1, 2, 3, 4]));
        assert!(for_topic(&c, "u", "pag-aawit ng papuri", 5).unwrap().is_empty());
    }

    #[test]
    fn lessons_stored_before_parts_existed_have_them_read() {
        let c = vault();
        let before = parts(&c);
        // A book number corrected since must not lose its place.
        c.execute_batch("UPDATE lessons SET outline = ''; UPDATE lesson_verses SET section = -1, question = ''; UPDATE verses SET canonical_key = '44.3:7' WHERE canonical_key = '43.3:7';").unwrap();
        assert_eq!(backfill(&c).unwrap(), 2);
        assert_eq!(parts(&c), before);
        assert_eq!(backfill(&c).unwrap(), 0, "read once");
        let outline: String = c.query_row("SELECT outline FROM lessons WHERE id = 'watch'", [], |r| r.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Vec<Section>>(&outline).unwrap().len(), 5);
    }

    #[test]
    fn related_words_match_but_short_ones_do_not_overreach() {
        let doc: HashSet<String> = ["pagbabantay".to_string(), "ani".to_string()].into();
        assert!(has(&doc, "bantay"));
        assert!(!has(&doc, "ban"));
        assert!(!has(&doc, "aniya"));
    }
}
