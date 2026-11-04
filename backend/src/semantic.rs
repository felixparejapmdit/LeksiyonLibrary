//! Search by meaning, using an embedding model on this PC.
//!
//! Each verse is turned into a list of numbers that represents its meaning, stored in
//! the encrypted database. A query is compared against those numbers, so a verse can be
//! found without sharing any words with the query. This only ever decides which stored
//! verses to show; it never produces or changes verse text. If the model is unavailable
//! the app falls back to keyword matching and says so.

use crate::api::{with_db, ApiError, S};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::time::Duration;

/// Below this, a verse is not considered related. Measured on real lessons with bge-m3, in
/// Tagalog and English: the best match for related questions scored 0.60 or more, and
/// unrelated questions never passed 0.41. A different model would need measuring again.
const MIN_SIMILARITY: f32 = 0.50;
const BATCH: i64 = 16;
const MAX_TEXT_CHARS: usize = 1000;

async fn embed(s: &S, inputs: Vec<String>, timeout: Duration) -> Result<Vec<Vec<f32>>, String> {
    let count = inputs.len();
    let resp = s
        .http
        .post(format!("{}/api/embed", s.config.ollama_url.trim_end_matches('/')))
        .timeout(timeout)
        .json(&json!({ "model": s.config.embed_model, "input": inputs }))
        .send()
        .await
        .map_err(|e| format!("embedding service unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("embedding service returned {}", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| format!("unreadable embedding response: {e}"))?;
    let vectors: Vec<Vec<f32>> = body["embeddings"]
        .as_array()
        .ok_or("embedding response had no embeddings")?
        .iter()
        .map(|v| v.as_array().map(|n| n.iter().filter_map(|x| x.as_f64()).map(|x| x as f32).collect()).unwrap_or_default())
        .collect();
    if vectors.len() != count {
        return Err("embedding response had the wrong length".into());
    }
    Ok(vectors)
}

/// The query's vector, or None if the model cannot answer soon enough. Callers then use
/// keyword matching alone.
pub async fn embed_query(s: &S, text: &str) -> Option<Vec<f32>> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    match embed(s, vec![text.to_string()], Duration::from_secs(20)).await {
        Ok(mut v) => v.pop().filter(|x| !x.is_empty()),
        Err(e) => {
            eprintln!("search by meaning unavailable: {e}");
            None
        }
    }
}

fn encode(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

fn decode(bytes: &[u8]) -> Vec<f32> {
    bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let norm = |v: &[f32]| v.iter().map(|x| x * x).sum::<f32>().sqrt();
    let denom = norm(a) * norm(b);
    if denom == 0.0 { 0.0 } else { dot / denom }
}

/// Stored verses most related to the query, by reference, best first.
pub fn rank(conn: &Connection, user_id: &str, model: &str, query: &[f32], limit: usize) -> rusqlite::Result<Vec<(String, f32)>> {
    let mut st = conn.prepare(
        "SELECT v.canonical_key, e.vector FROM verse_embeddings e JOIN verses v ON v.id = e.verse_id
         WHERE v.user_id = ?1 AND e.model = ?2 AND e.text_sha = v.text_sha256",
    )?;
    let mut best: HashMap<String, f32> = HashMap::new();
    let rows = st.query_map(params![user_id, model], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?)))?;
    for row in rows {
        let (key, bytes) = row?;
        let score = cosine(query, &decode(&bytes));
        let entry = best.entry(key).or_insert(f32::MIN);
        *entry = entry.max(score);
    }
    let mut ranked: Vec<(String, f32)> = best.into_iter().filter(|(_, score)| *score >= MIN_SIMILARITY).collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    ranked.truncate(limit);
    Ok(ranked)
}

/// Starts indexing any verse that is new or changed, unless that is already running.
pub fn kick(s: S) {
    if s.indexing.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        if let Err(e) = index_pending(&s).await {
            eprintln!("search by meaning could not index verses: {e}");
        }
        s.indexing.store(false, Ordering::SeqCst);
    });
}

async fn index_pending(s: &S) -> Result<(), String> {
    let db_error = |e: ApiError| format!("database: {}", e.message());
    loop {
        let (owner, model) = (s.owner_id.clone(), s.config.embed_model.clone());
        let pending: Vec<(String, String, String)> = with_db(s, move |c| {
            let mut st = c.prepare(
                "SELECT v.id, v.text, v.text_sha256 FROM verses v
                 LEFT JOIN verse_embeddings e ON e.verse_id = v.id AND e.model = ?2 AND e.text_sha = v.text_sha256
                 WHERE v.user_id = ?1 AND v.text <> '' AND e.verse_id IS NULL LIMIT ?3",
            )?;
            let rows = st.query_map(params![owner, model, BATCH], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await
        .map_err(db_error)?;
        if pending.is_empty() {
            return Ok(());
        }
        let inputs = pending.iter().map(|(_, text, _)| text.chars().take(MAX_TEXT_CHARS).collect()).collect();
        let vectors = embed(s, inputs, Duration::from_secs(180)).await?;
        let model = s.config.embed_model.clone();
        with_db(s, move |c| {
            let tx = c.transaction()?;
            for ((id, _, sha), vector) in pending.iter().zip(&vectors) {
                // The verse may have changed or gone while this was running.
                tx.execute(
                    "INSERT OR REPLACE INTO verse_embeddings (verse_id, text_sha, model, vector)
                     SELECT id, ?2, ?3, ?4 FROM verses WHERE id = ?1",
                    params![id, sha, model, encode(vector)],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
        .await
        .map_err(db_error)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::db::init(&c).unwrap();
        c.execute("INSERT INTO users VALUES ('u','a@b.c','','now')", []).unwrap();
        for (id, key, language, vector) in [("a", "1.1:1", "en", [1.0f32, 0.0]), ("b", "1.1:1", "tl", [0.0, 1.0]), ("c", "1.1:2", "en", [0.8, 0.6]), ("d", "1.1:3", "en", [-1.0, 0.0])] {
            c.execute(
                "INSERT INTO verses (id,user_id,canonical_key,book_id,ref_printed,ref_en,ref_tl,language,text,text_sha256,ocr_raw,status,created_at)
                 VALUES (?1,'u',?2,1,'r','r','r',?3,'t','sha',?1,'unverified','now')",
                params![id, key, language],
            )
            .unwrap();
            c.execute("INSERT INTO verse_embeddings VALUES (?1,'sha','m',?2)", params![id, encode(&vector)]).unwrap();
        }
        c
    }

    #[test]
    fn vectors_survive_being_stored() {
        assert_eq!(decode(&encode(&[0.5, -2.25])), vec![0.5, -2.25]);
    }

    #[test]
    fn the_closest_verse_ranks_first_and_unrelated_verses_are_left_out() {
        let c = library();
        let ranked = rank(&c, "u", "m", &[1.0, 0.0], 10).unwrap();
        let keys: Vec<&str> = ranked.iter().map(|r| r.0.as_str()).collect();
        assert_eq!(keys, vec!["1.1:1", "1.1:2"]);
    }

    #[test]
    fn either_language_can_match_a_reference() {
        let c = library();
        let ranked = rank(&c, "u", "m", &[0.0, 1.0], 1).unwrap();
        assert_eq!(ranked[0].0, "1.1:1");
    }

    #[test]
    fn a_stale_or_other_model_vector_is_ignored() {
        let c = library();
        assert!(rank(&c, "u", "other", &[1.0, 0.0], 10).unwrap().is_empty());
        c.execute("UPDATE verses SET text_sha256='changed'", []).unwrap();
        assert!(rank(&c, "u", "m", &[1.0, 0.0], 10).unwrap().is_empty());
    }

    #[test]
    fn deleting_a_verse_removes_its_vector() {
        let c = library();
        c.execute("DELETE FROM verses WHERE id='a'", []).unwrap();
        let n: i64 = c.query_row("SELECT count(*) FROM verse_embeddings", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 3);
    }
}
