use crate::{ai, backup, export, parser, semantic, AppState};
use axum::{
    body::Body,
    extract::{DefaultBodyLimit, FromRequestParts, Multipart, Path, Query, State},
    http::{header, request::Parts, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Arc};

pub(crate) type S = Arc<AppState>;

pub struct ApiError(StatusCode, String);

impl ApiError {
    pub(crate) fn message(&self) -> &str {
        &self.1
    }
    fn bad(msg: impl Into<String>) -> Self {
        Self(StatusCode::BAD_REQUEST, msg.into())
    }
    fn not_found() -> Self {
        Self(StatusCode::NOT_FOUND, "Not found.".into())
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}
impl From<rusqlite::Error> for ApiError {
    fn from(e: rusqlite::Error) -> Self {
        eprintln!("database error: {e}");
        if e.to_string().contains("immutable") {
            return Self(StatusCode::CONFLICT, "Verified scripture text cannot be changed.".into());
        }
        if e.to_string().contains("UNIQUE") {
            return Self(StatusCode::CONFLICT, "That reference already has this same verse text.".into());
        }
        Self(StatusCode::INTERNAL_SERVER_ERROR, "Database error.".into())
    }
}

type ApiResult<T> = Result<T, ApiError>;

/// Runs database work off the async runtime so requests never stall the server.
pub(crate) async fn with_db<T: Send + 'static>(
    state: &S,
    f: impl FnOnce(&mut Connection) -> ApiResult<T> + Send + 'static,
) -> ApiResult<T> {
    let state = state.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        let before = conn.total_changes();
        let result = f(&mut conn);
        // The database lives in memory; any change is sealed to disk before answering.
        if conn.total_changes() != before {
            state.vault.save_db(&conn).map_err(|e| {
                eprintln!("could not save the vault: {e}");
                ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not save your change to disk.".into())
            })?;
        }
        result
    })
    .await
    .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Internal error.".into()))?
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn sha_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

// ---------- Access ----------

/// The app has no sign-in: every request acts for the one local owner.
pub struct User {
    pub id: String,
}

impl FromRequestParts<S> for User {
    type Rejection = std::convert::Infallible;
    async fn from_request_parts(_parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        Ok(User { id: state.owner_id.clone() })
    }
}

/// With no sign-in, this is what keeps other websites out. A page open in the same
/// browser can otherwise send a form to 127.0.0.1 and upload or replace data, or use
/// DNS rebinding to read it. Only this app's own pages are allowed through.
fn request_is_from_this_app(host: Option<&str>, origin: Option<&str>, fetch_site: Option<&str>) -> bool {
    let Some(host) = host else { return false };
    let name = host.rsplit_once(':').filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit())).map_or(host, |(name, _)| name);
    if !["127.0.0.1", "localhost", "[::1]"].contains(&name) {
        return false;
    }
    if fetch_site == Some("cross-site") {
        return false;
    }
    origin.is_none_or(|o| o == format!("http://{host}"))
}

async fn only_this_app(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let headers = req.headers();
    let text = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    if request_is_from_this_app(text("host"), text("origin"), text("sec-fetch-site")) {
        next.run(req).await
    } else {
        ApiError(StatusCode::FORBIDDEN, "This request did not come from Lesson Vault.".into()).into_response()
    }
}

// ---------- Lessons ----------

const LESSON_COLS: &str = "l.id, l.title, l.category, l.language, l.lesson_date, l.date_label, l.year, l.location, l.author, l.code, l.file_name, l.byte_size, l.page_count, l.source_kind, l.issue, l.objectives, l.created_at, l.folder_id";

fn lesson_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let objectives: String = r.get(15)?;
    Ok(json!({
        "id": r.get::<_, String>(0)?, "title": r.get::<_, String>(1)?, "category": r.get::<_, String>(2)?,
        "language": r.get::<_, String>(3)?, "lesson_date": r.get::<_, Option<String>>(4)?, "date_label": r.get::<_, String>(5)?,
        "year": r.get::<_, Option<i64>>(6)?, "location": r.get::<_, String>(7)?, "author": r.get::<_, String>(8)?,
        "code": r.get::<_, String>(9)?, "file_name": r.get::<_, String>(10)?, "byte_size": r.get::<_, i64>(11)?,
        "page_count": r.get::<_, i64>(12)?, "source_kind": r.get::<_, String>(13)?, "issue": r.get::<_, String>(14)?,
        "objectives": serde_json::from_str::<Value>(&objectives).unwrap_or(json!([])), "created_at": r.get::<_, String>(16)?,
        "folder_id": r.get::<_, Option<String>>(17)?,
    }))
}

fn lessons_for(c: &Connection, user_id: &str) -> rusqlite::Result<Vec<Value>> {
    let mut keys: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut st = c.prepare(
            "SELECT lv.lesson_id, v.canonical_key FROM lesson_verses lv JOIN verses v ON v.id = lv.verse_id
             WHERE lv.user_id = ?1 ORDER BY lv.ordinal",
        )?;
        for row in st.query_map([user_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (l, k) = row?;
            keys.entry(l).or_default().push(k);
        }
    }
    let mut st = c.prepare(&format!("SELECT {LESSON_COLS} FROM lessons l WHERE l.user_id = ?1"))?;
    let rows = st.query_map([user_id], lesson_row)?;
    let mut out = Vec::new();
    for row in rows {
        let mut v = row?;
        let id = v["id"].as_str().unwrap_or_default().to_string();
        v["verse_keys"] = json!(keys.remove(&id).unwrap_or_default());
        out.push(v);
    }
    Ok(out)
}

async fn list_lessons(State(s): State<S>, u: User) -> ApiResult<Json<Value>> {
    let rows = with_db(&s, move |c| Ok(lessons_for(c, &u.id)?)).await?;
    Ok(Json(json!(rows)))
}

const MAX_PDF: usize = 64 * 1024 * 1024;

async fn upload_lesson(State(s): State<S>, u: User, mut mp: Multipart) -> ApiResult<Json<Value>> {
    let (mut file, mut file_name, mut pages, mut source_kind) = (None::<Vec<u8>>, String::new(), Vec::<String>::new(), "text".to_string());
    while let Some(field) = mp.next_field().await.map_err(|_| ApiError::bad("The upload could not be read."))? {
        match field.name().unwrap_or_default() {
            "file" => {
                file_name = field.file_name().unwrap_or("lesson.pdf").to_string();
                file = Some(field.bytes().await.map_err(|_| ApiError::bad("The upload could not be read; the file may be too large."))?.to_vec());
            }
            "pages" => {
                let raw = field.text().await.map_err(|_| ApiError::bad("Extracted text could not be read."))?;
                pages = serde_json::from_str(&raw).map_err(|_| ApiError::bad("Extracted text is malformed."))?;
            }
            "source_kind" => source_kind = field.text().await.unwrap_or_default(),
            _ => {}
        }
    }
    let file = file.ok_or_else(|| ApiError::bad("No PDF was provided."))?;
    if file.len() > MAX_PDF {
        return Err(ApiError(StatusCode::PAYLOAD_TOO_LARGE, "PDFs are limited to 64 MB.".into()));
    }
    if !file.starts_with(b"%PDF-") {
        return Err(ApiError(StatusCode::UNSUPPORTED_MEDIA_TYPE, "That file is not a PDF.".into()));
    }
    if source_kind != "ocr" {
        source_kind = "text".into();
    }
    let safe_name: String = std::path::Path::new(&file_name.replace('\\', "/"))
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "lesson.pdf".into());
    let sha = sha_hex(&file);
    let parsed = parser::parse(&pages, &safe_name);
    let id = new_id();
    let byte_size = file.len() as i64;
    let (state, target) = (s.clone(), id.clone());
    tokio::task::spawn_blocking(move || state.vault.write_pdf(&target, &file))
        .await
        .ok()
        .and_then(|written| written.ok())
        .ok_or_else(|| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not store the PDF.".into()))?;

    let (id2, uid, page_count) = (id.clone(), u.id.clone(), pages.len() as i64);
    let result = with_db(&s, move |c| {
        let dup: Option<String> = c.query_row("SELECT title FROM lessons WHERE user_id = ?1 AND sha256 = ?2", params![uid, sha], |r| r.get(0)).optional()?;
        if let Some(title) = dup {
            return Err(ApiError(StatusCode::CONFLICT, format!("This PDF is already in your vault as \"{title}\".")));
        }
        let tx = c.transaction()?;
        let ts = now();
        tx.execute(
            "INSERT INTO lessons (id,user_id,title,category,language,lesson_date,date_label,year,location,author,code,file_name,sha256,byte_size,page_count,source_kind,content,issue,objectives,created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)",
            params![id2, uid, parsed.title, parsed.category, parsed.language, parsed.lesson_date, parsed.date_label, parsed.year, parsed.location, parsed.author, parsed.code, safe_name, sha, byte_size, page_count, source_kind, parsed.content, parsed.issue, json!(parsed.objectives).to_string(), ts],
        )?;
        for (ordinal, v) in parsed.verses.iter().enumerate() {
            let existing: Option<String> = tx
                .query_row(
                    "SELECT id FROM verses WHERE user_id=?1 AND canonical_key=?2 AND version=?3 AND language=?4 AND ocr_raw=?5",
                    params![uid, v.canonical_key, v.version, parsed.language, v.raw],
                    |r| r.get(0),
                )
                .optional()?;
            let verse_id = match existing {
                Some(e) => e,
                None => {
                    let vid = new_id();
                    tx.execute(
                        "INSERT INTO verses (id,user_id,canonical_key,book_id,ref_printed,ref_en,ref_tl,version,language,text,text_sha256,ocr_raw,status,created_at)
                         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'unverified',?13)",
                        params![vid, uid, v.canonical_key, v.book_id, v.ref_printed, v.ref_en, v.ref_tl, v.version, parsed.language, v.text, sha_hex(v.text.as_bytes()), v.raw, ts],
                    )?;
                    vid
                }
            };
            tx.execute(
                "INSERT INTO lesson_verses VALUES (?1,?2,?3,?4,?5,?6)",
                params![new_id(), uid, id2, verse_id, v.page, ordinal as i64],
            )?;
        }
        reconcile_with_pair(&tx, &uid, &id2)?;
        tx.commit()?;
        let lesson = c.query_row(&format!("SELECT {LESSON_COLS} FROM lessons l WHERE l.id = ?1"), [&id2], lesson_row)?;
        Ok(json!({ "lesson": lesson, "verse_count": parsed.verses.len() }))
    })
    .await;
    if result.is_err() {
        s.vault.remove_pdf(&id);
    } else {
        semantic::kick(s.clone());
    }
    result.map(Json)
}

const RECONCILED_NOTE: &str = "Book number was cross-checked against the paired Tagalog/English lesson. Please confirm it.";

/// OCR misreads series numerals ("II" as "I" or "1") far more often than it
/// invents them. When the Tagalog and English editions of a lesson cite the same
/// chapter and verses in sibling books, the higher number is taken and the
/// reference is flagged for review. Verse text is never touched; verified verses
/// are never touched at all.
fn reconcile_with_pair(tx: &Connection, user_id: &str, lesson_id: &str) -> rusqlite::Result<()> {
    let (date, category, language): (Option<String>, String, String) =
        tx.query_row("SELECT lesson_date, category, language FROM lessons WHERE id=?1", [lesson_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    let Some(date) = date else { return Ok(()) };
    type Row = (String, u32, String, String);
    let load = |sql: &str, p: &[&dyn rusqlite::ToSql]| -> rusqlite::Result<Vec<Row>> {
        let mut st = tx.prepare(sql)?;
        let rows = st.query_map(p, |r| {
            let key: String = r.get(1)?;
            let rest = key.split_once('.').map(|x| x.1.to_string()).unwrap_or_default();
            Ok((r.get::<_, String>(0)?, r.get::<_, u32>(2)?, rest, r.get::<_, String>(3)?))
        })?;
        rows.collect()
    };
    let mine = load(
        "SELECT v.id, v.canonical_key, v.book_id, v.status FROM lesson_verses lv JOIN verses v ON v.id=lv.verse_id WHERE lv.lesson_id=?1",
        &[&lesson_id],
    )?;
    let theirs = load(
        "SELECT v.id, v.canonical_key, v.book_id, v.status FROM lessons l JOIN lesson_verses lv ON lv.lesson_id=l.id JOIN verses v ON v.id=lv.verse_id
         WHERE l.user_id=?1 AND l.lesson_date=?2 AND l.category=?3 AND l.language<>?4",
        &[&user_id, &date, &category, &language],
    )?;
    for a in &mine {
        if theirs.iter().any(|b| b.1 == a.1 && b.2 == a.2) {
            continue;
        }
        let Some(b) = theirs.iter().find(|b| b.2 == a.2 && crate::books::same_series(a.1, b.1)) else { continue };
        let (loser, winner_book) = if a.1 > b.1 { (b, a.1) } else { (a, b.1) };
        if loser.3 != "unverified" {
            continue;
        }
        let Some(book) = crate::books::by_id(winner_book) else { continue };
        let ref_en = format!("{} {}", book.en, loser.2.replace(',', " & "));
        let ref_tl = format!("{} {}", book.tl, loser.2.replace(',', " at "));
        tx.execute(
            "UPDATE OR IGNORE verses SET canonical_key=?1, book_id=?2, ref_en=?3, ref_tl=?4,
             ref_printed=CASE language WHEN 'tl' THEN ?4 ELSE ?3 END, ref_note=?5 WHERE id=?6 AND status='unverified'",
            params![format!("{winner_book}.{}", loser.2), winner_book, ref_en, ref_tl, RECONCILED_NOTE, loser.0],
        )?;
    }
    Ok(())
}

#[derive(Deserialize)]
struct LessonPatch {
    title: Option<String>,
    category: Option<String>,
    language: Option<String>,
    lesson_date: Option<String>,
    location: Option<String>,
    author: Option<String>,
    folder_id: Option<String>,
    issue: Option<String>,
    objectives: Option<Vec<String>>,
}

async fn patch_lesson(State(s): State<S>, u: User, Path(id): Path<String>, Json(b): Json<LessonPatch>) -> ApiResult<Json<Value>> {
    if let Some(t) = &b.title {
        if t.trim().is_empty() {
            return Err(ApiError::bad("Title cannot be empty."));
        }
    }
    if let Some(c) = &b.category {
        if !["midweek", "weekend", "pastoral"].contains(&c.as_str()) {
            return Err(ApiError::bad("Unknown category."));
        }
    }
    if let Some(l) = &b.language {
        if !["en", "tl"].contains(&l.as_str()) {
            return Err(ApiError::bad("Unknown language."));
        }
    }
    let row = with_db(&s, move |c| {
        let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM lessons WHERE id=?1 AND user_id=?2)", params![id, u.id], |r| r.get(0))?;
        if !exists {
            return Err(ApiError::not_found());
        }
        if let Some(fid) = b.folder_id.as_deref().filter(|f| !f.is_empty()) {
            let ok: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM folders WHERE id=?1 AND user_id=?2)", params![fid, u.id], |r| r.get(0))?;
            if !ok {
                return Err(ApiError::bad("Unknown folder."));
            }
        }
        let tx = c.transaction()?;
        if let Some(v) = b.title { tx.execute("UPDATE lessons SET title=?1 WHERE id=?2", params![v.trim(), id])?; }
        if let Some(v) = b.category { tx.execute("UPDATE lessons SET category=?1 WHERE id=?2", params![v, id])?; }
        if let Some(v) = b.language { tx.execute("UPDATE lessons SET language=?1 WHERE id=?2", params![v, id])?; }
        if let Some(v) = b.location { tx.execute("UPDATE lessons SET location=?1 WHERE id=?2", params![v.trim(), id])?; }
        if let Some(v) = b.author { tx.execute("UPDATE lessons SET author=?1 WHERE id=?2", params![v.trim(), id])?; }
        if let Some(v) = b.issue { tx.execute("UPDATE lessons SET issue=?1 WHERE id=?2", params![v.trim(), id])?; }
        if let Some(v) = b.objectives {
            let cleaned: Vec<&str> = v.iter().map(|o| o.trim()).filter(|o| !o.is_empty()).collect();
            tx.execute("UPDATE lessons SET objectives=?1 WHERE id=?2", params![json!(cleaned).to_string(), id])?;
        }
        if let Some(v) = b.lesson_date {
            let d = v.trim();
            if d.is_empty() {
                tx.execute("UPDATE lessons SET lesson_date=NULL, year=NULL WHERE id=?1", [&id])?;
            } else {
                if chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").is_err() {
                    return Err(ApiError::bad("Date must be YYYY-MM-DD."));
                }
                tx.execute("UPDATE lessons SET lesson_date=?1, year=?2, date_label='' WHERE id=?3", params![d, d[..4].parse::<i64>().unwrap_or(0), id])?;
            }
        }
        if let Some(v) = b.folder_id {
            let f = if v.is_empty() { None } else { Some(v) };
            tx.execute("UPDATE lessons SET folder_id=?1 WHERE id=?2", params![f, id])?;
        }
        tx.commit()?;
        Ok(c.query_row(&format!("SELECT {LESSON_COLS} FROM lessons l WHERE l.id = ?1"), [&id], lesson_row)?)
    })
    .await?;
    Ok(Json(row))
}

async fn delete_lesson(State(s): State<S>, u: User, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let id2 = id.clone();
    with_db(&s, move |c| {
        let n = c.execute("DELETE FROM lessons WHERE id=?1 AND user_id=?2", params![id2, u.id])?;
        if n == 0 {
            return Err(ApiError::not_found());
        }
        // Keep verified scripture; remove unverified extractions no lesson cites any more.
        c.execute(
            "DELETE FROM verses WHERE user_id=?1 AND status='unverified'
             AND id NOT IN (SELECT verse_id FROM lesson_verses WHERE user_id=?1)
             AND id NOT IN (SELECT verse_id FROM lecture_verses WHERE user_id=?1)",
            [&u.id],
        )?;
        Ok(())
    })
    .await?;
    s.vault.remove_pdf(&id);
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct FileQuery {
    download: Option<u8>,
}

async fn lesson_file(State(s): State<S>, u: User, Path(id): Path<String>, Query(q): Query<FileQuery>) -> ApiResult<Response> {
    let id2 = id.clone();
    let name: String = with_db(&s, move |c| {
        c.query_row("SELECT file_name FROM lessons WHERE id=?1 AND user_id=?2", params![id2, u.id], |r| r.get(0))
            .optional()?
            .ok_or_else(ApiError::not_found)
    })
    .await?;
    let (state, target) = (s.clone(), id.clone());
    let bytes = tokio::task::spawn_blocking(move || state.vault.read_pdf(&target))
        .await
        .ok()
        .and_then(|read| read.ok())
        .ok_or_else(ApiError::not_found)?;
    let ascii: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || "._- ".contains(c) { c } else { '_' }).collect();
    let disposition = format!("{}; filename=\"{ascii}\"", if q.download == Some(1) { "attachment" } else { "inline" });
    Response::builder()
        .header(header::CONTENT_TYPE, "application/pdf")
        .header(header::CONTENT_DISPOSITION, disposition)
        .body(Body::from(bytes))
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Could not send file.".into()))
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
}

async fn search(State(s): State<S>, u: User, Query(q): Query<SearchQuery>) -> ApiResult<Json<Value>> {
    let terms: Vec<String> = q.q.split(|c: char| !c.is_alphanumeric() && c != '-').map(|w| w.trim_matches('-').to_lowercase()).filter(|w| !w.is_empty()).take(16).collect();
    if terms.is_empty() {
        return Ok(Json(json!({ "lesson_ids": [] })));
    }
    let query = ai::fts_query(&terms, "AND");
    let ids = with_db(&s, move |c| {
        let mut st = c.prepare(
            "SELECT l.id FROM lessons_fts JOIN lessons l ON l.seq = lessons_fts.rowid
             WHERE lessons_fts MATCH ?1 AND l.user_id = ?2 ORDER BY bm25(lessons_fts) LIMIT 200",
        )?;
        let rows = st.query_map(params![query, u.id], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
    .await?;
    Ok(Json(json!({ "lesson_ids": ids })))
}

// ---------- Folders ----------

async fn list_folders(State(s): State<S>, u: User) -> ApiResult<Json<Value>> {
    let rows = with_db(&s, move |c| {
        let mut st = c.prepare("SELECT id, name FROM folders WHERE user_id=?1 ORDER BY name")?;
        let rows = st.query_map([&u.id], |r| Ok(json!({ "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)? })))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
    .await?;
    Ok(Json(json!(rows)))
}

#[derive(Deserialize)]
struct FolderBody {
    name: String,
}

async fn create_folder(State(s): State<S>, u: User, Json(b): Json<FolderBody>) -> ApiResult<Json<Value>> {
    let name = b.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 60 {
        return Err(ApiError::bad("Folder names must be 1 to 60 characters."));
    }
    let row = with_db(&s, move |c| {
        let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM folders WHERE user_id=?1 AND name=?2)", params![u.id, name], |r| r.get(0))?;
        if exists {
            return Err(ApiError(StatusCode::CONFLICT, "A folder with this name already exists.".into()));
        }
        let id = new_id();
        c.execute("INSERT INTO folders VALUES (?1,?2,?3,?4)", params![id, u.id, name, now()])?;
        Ok(json!({ "id": id, "name": name }))
    })
    .await?;
    Ok(Json(row))
}

async fn delete_folder(State(s): State<S>, u: User, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    with_db(&s, move |c| {
        if c.execute("DELETE FROM folders WHERE id=?1 AND user_id=?2", params![id, u.id])? == 0 {
            return Err(ApiError::not_found());
        }
        Ok(())
    })
    .await?;
    Ok(Json(json!({ "ok": true })))
}

// ---------- Verses ----------

fn verses_for(c: &Connection, user_id: &str) -> rusqlite::Result<Vec<Value>> {
    let mut sources: HashMap<String, Vec<Value>> = HashMap::new();
    {
        let mut st = c.prepare("SELECT lv.verse_id, lv.lesson_id, lv.page FROM lesson_verses lv WHERE lv.user_id=?1")?;
        for row in st.query_map([user_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))? {
            let (v, l, p) = row?;
            sources.entry(v).or_default().push(json!({ "lesson_id": l, "page": p }));
        }
    }
    let mut st = c.prepare(
        "SELECT id, canonical_key, book_id, ref_printed, ref_en, ref_tl, version, language, text, ocr_raw, status, verified_at, ref_note
         FROM verses WHERE user_id=?1 ORDER BY book_id, canonical_key, language DESC, seq",
    )?;
    let rows = st.query_map([user_id], |r| {
        Ok(json!({
            "id": r.get::<_, String>(0)?, "canonical_key": r.get::<_, String>(1)?, "book_id": r.get::<_, i64>(2)?,
            "ref_printed": r.get::<_, String>(3)?, "ref_en": r.get::<_, String>(4)?, "ref_tl": r.get::<_, String>(5)?,
            "version": r.get::<_, String>(6)?, "language": r.get::<_, String>(7)?, "text": r.get::<_, String>(8)?,
            "ocr_raw": r.get::<_, String>(9)?, "status": r.get::<_, String>(10)?, "verified_at": r.get::<_, Option<String>>(11)?,
            "ref_note": r.get::<_, String>(12)?,
        }))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let mut v = row?;
        let id = v["id"].as_str().unwrap_or_default().to_string();
        v["sources"] = json!(sources.remove(&id).unwrap_or_default());
        out.push(v);
    }
    Ok(out)
}

async fn list_verses(State(s): State<S>, u: User) -> ApiResult<Json<Value>> {
    let rows = with_db(&s, move |c| Ok(verses_for(c, &u.id)?)).await?;
    Ok(Json(json!(rows)))
}

fn one_verse(c: &Connection, user_id: &str, id: &str) -> ApiResult<Value> {
    verses_for(c, user_id)?.into_iter().find(|v| v["id"] == id).ok_or_else(ApiError::not_found)
}

#[derive(Deserialize)]
struct VersePatch {
    text: Option<String>,
    reference: Option<String>,
}

async fn correct_verse(State(s): State<S>, u: User, Path(id): Path<String>, Json(b): Json<VersePatch>) -> ApiResult<Json<Value>> {
    let text = b.text.map(|t| t.trim().to_string());
    if text.as_deref() == Some("") {
        return Err(ApiError::bad("Verse text cannot be empty."));
    }
    let reference = match b.reference.as_deref().map(str::trim) {
        Some(raw) => {
            let found = parser::find_references(raw);
            match found.as_slice() {
                [one] if one.end == raw.len() => Some(one.clone()),
                _ => return Err(ApiError::bad("That reference was not recognized. Try a form like II Kings 2:1.")),
            }
        }
        None => None,
    };
    let row = with_db(&s, move |c| {
        let owned: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM verses WHERE id=?1 AND user_id=?2)", params![id, u.id], |r| r.get(0))?;
        if !owned {
            return Err(ApiError::not_found());
        }
        let current: (String, String) = c.query_row("SELECT text, canonical_key FROM verses WHERE id=?1", [&id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let tx = c.transaction()?;
        if let Some(text) = text.filter(|t| *t != current.0) {
            tx.execute("UPDATE verses SET text=?1, text_sha256=?2 WHERE id=?3", params![text, sha_hex(text.as_bytes()), id])?;
        }
        if let Some(r) = reference.filter(|r| r.canonical_key != current.1) {
            tx.execute(
                "UPDATE verses SET canonical_key=?1, book_id=?2, ref_printed=?3, ref_en=?4, ref_tl=?5, ref_note='' WHERE id=?6",
                params![r.canonical_key, r.book_id, r.printed, r.en, r.tl, id],
            )?;
        }
        tx.commit()?;
        one_verse(c, &u.id, &id)
    })
    .await?;
    semantic::kick(s.clone());
    Ok(Json(row))
}

async fn verify_verse(State(s): State<S>, u: User, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let row = with_db(&s, move |c| {
        let text: Option<String> = c.query_row("SELECT text FROM verses WHERE id=?1 AND user_id=?2", params![id, u.id], |r| r.get(0)).optional()?;
        let text = text.ok_or_else(ApiError::not_found)?;
        if text.trim().is_empty() {
            return Err(ApiError::bad("This reference has no text to verify."));
        }
        c.execute(
            "UPDATE verses SET status='verified', verified_at=COALESCE(verified_at, ?1) WHERE id=?2 AND user_id=?3",
            params![now(), id, u.id],
        )?;
        one_verse(c, &u.id, &id)
    })
    .await?;
    Ok(Json(row))
}

// ---------- AI ----------

#[derive(Deserialize)]
struct SuggestBody {
    issue: String,
    objective: String,
    /// Verses wanted for this one objective (3 to 5). Absent means best matches overall.
    count: Option<usize>,
}

fn contexts_for(c: &Connection, user_id: &str) -> rusqlite::Result<serde_json::Map<String, Value>> {
    let mut st = c.prepare("SELECT canonical_key, speaker, context, reviewed_at FROM verse_context WHERE user_id=?1")?;
    let rows = st.query_map([user_id], |r| {
        Ok((r.get::<_, String>(0)?, json!({ "speaker": r.get::<_, String>(1)?, "context": r.get::<_, String>(2)?, "reviewed": r.get::<_, Option<String>>(3)?.is_some() })))
    })?;
    rows.collect()
}

async fn ai_suggest(State(s): State<S>, u: User, Json(b): Json<SuggestBody>) -> ApiResult<Json<Value>> {
    if b.issue.trim().is_empty() && b.objective.trim().is_empty() {
        return Err(ApiError::bad("Enter an issue or an objective first."));
    }
    let query = if b.count.is_some() && !b.objective.trim().is_empty() { b.objective.clone() } else { format!("{} {}", b.issue, b.objective) };
    let vector = semantic::embed_query(&s, &query).await;
    semantic::kick(s.clone());
    let model = s.config.ollama_model.clone();
    let embed_model = s.config.embed_model.clone();
    let res = with_db(&s, move |c| {
        let limit = b.count.map_or(8, |n| n.clamp(3, 5));
        let keyword = match b.count {
            Some(_) => ai::retrieve_for_objective(c, &u.id, &b.issue, &b.objective, limit)?,
            None => ai::retrieve(c, &u.id, &b.issue, &b.objective, limit)?,
        };
        let related = match &vector {
            Some(v) => semantic::rank(c, &u.id, &embed_model, v, limit)?,
            None => vec![],
        };
        let suggestions = ai::merge_meaning(c, &u.id, keyword, &related, limit)?;
        let id = new_id();
        let ids: Vec<&String> = suggestions.iter().flat_map(|x| x.verse_ids.iter()).collect();
        c.execute(
            "INSERT INTO ai_prompts_log VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![id, u.id, b.issue, b.objective, json!(ids).to_string(), model, now()],
        )?;
        Ok(json!({ "log_id": id, "suggestions": suggestions, "meaning": vector.is_some() }))
    })
    .await?;
    Ok(Json(res))
}

#[derive(Deserialize)]
struct NotesBody {
    log_id: String,
}

async fn ai_notes(State(s): State<S>, u: User, Json(b): Json<NotesBody>) -> ApiResult<Json<Value>> {
    let owner = u.id.clone();
    let (issue, objective, candidates) = with_db(&s, move |c| {
        let row: Option<(String, String, String)> = c
            .query_row(
                "SELECT input_issue, input_objective, suggested_verse_ids FROM ai_prompts_log WHERE id=?1 AND user_id=?2",
                params![b.log_id, u.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let (issue, objective, ids) = row.ok_or_else(ApiError::not_found)?;
        let ids: Vec<String> = serde_json::from_str(&ids).unwrap_or_default();
        let mut candidates: Vec<ai::Candidate> = Vec::new();
        for id in ids {
            let row: Option<(String, String, String, String)> = c
                .query_row("SELECT canonical_key, ref_en, text, language FROM verses WHERE id=?1 AND user_id=?2", params![id, u.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                .optional()?;
            if let Some((key, reference, text, language)) = row {
                match candidates.iter_mut().find(|x| x.0 == key) {
                    // One entry per reference, preferring the English wording for the model.
                    Some(existing) if language == "en" => existing.2 = text,
                    Some(_) => {}
                    None => candidates.push((key, reference, text)),
                }
            }
        }
        Ok((issue, objective, candidates))
    })
    .await?;
    if candidates.is_empty() {
        return Ok(Json(json!({ "available": true, "notes": {}, "context": {} })));
    }
    match ai::request_notes(&s.http, &s.config.ollama_url, &s.config.ollama_model, &issue, &objective, &candidates).await {
        Ok(r) => {
            // Kept, so a saved lecture still shows it and it need not be written again.
            let (context, model) = (r.context.clone(), r.model.clone());
            let stored = with_db(&s, move |c| {
                let tx = c.transaction()?;
                for (key, v) in &context {
                    tx.execute(
                        "INSERT INTO verse_context (user_id, canonical_key, speaker, context, model, updated_at) VALUES (?1,?2,?3,?4,?5,?6)
                         ON CONFLICT (user_id, canonical_key) DO UPDATE SET
                           speaker = CASE WHEN excluded.speaker <> '' THEN excluded.speaker ELSE speaker END,
                           context = CASE WHEN excluded.context <> '' THEN excluded.context ELSE context END,
                           model = excluded.model, updated_at = excluded.updated_at
                         WHERE verse_context.reviewed_at IS NULL",
                        params![owner, key, v.speaker, v.context, model, now()],
                    )?;
                }
                tx.commit()?;
                Ok(contexts_for(c, &owner)?)
            })
            .await
            .map(|saved| (saved, r.notes, r.model));
            let (saved, notes, used) = stored?;
            Ok(Json(json!({ "available": true, "notes": notes, "context": saved, "model": used })))
        }
        Err(e) => {
            eprintln!("AI notes unavailable: {e}");
            Ok(Json(json!({ "available": false, "notes": {}, "context": {} })))
        }
    }
}

async fn list_verse_context(State(s): State<S>, u: User) -> ApiResult<Json<Value>> {
    let rows = with_db(&s, move |c| {
        Ok(contexts_for(c, &u.id)?)
    })
    .await?;
    Ok(Json(Value::Object(rows)))
}

#[derive(Deserialize)]
struct ContextBody {
    canonical_key: String,
    speaker: String,
    context: String,
}

/// The user's own wording replaces the AI's and is marked reviewed, so later AI runs leave
/// it alone. Clearing both fields removes it, letting the AI suggest again.
async fn save_verse_context(State(s): State<S>, u: User, Json(b): Json<ContextBody>) -> ApiResult<Json<Value>> {
    let (speaker, context) = (b.speaker.trim().to_string(), b.context.trim().to_string());
    if speaker.chars().count() > 200 || context.chars().count() > 2000 {
        return Err(ApiError::bad("That text is too long."));
    }
    let rows = with_db(&s, move |c| {
        let known: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM verses WHERE user_id=?1 AND canonical_key=?2)", params![u.id, b.canonical_key], |r| r.get(0))?;
        if !known {
            return Err(ApiError::not_found());
        }
        if speaker.is_empty() && context.is_empty() {
            c.execute("DELETE FROM verse_context WHERE user_id=?1 AND canonical_key=?2", params![u.id, b.canonical_key])?;
        } else {
            c.execute(
                "INSERT INTO verse_context (user_id, canonical_key, speaker, context, model, updated_at, reviewed_at) VALUES (?1,?2,?3,?4,'',?5,?5)
                 ON CONFLICT (user_id, canonical_key) DO UPDATE SET speaker=excluded.speaker, context=excluded.context, updated_at=excluded.updated_at, reviewed_at=excluded.reviewed_at",
                params![u.id, b.canonical_key, speaker, context, now()],
            )?;
        }
        Ok(contexts_for(c, &u.id)?)
    })
    .await?;
    Ok(Json(Value::Object(rows)))
}

#[derive(Deserialize)]
struct MeaningQuery {
    q: String,
}

/// Verses related in meaning, or `available: false` when the model cannot answer.
async fn search_meaning(State(s): State<S>, u: User, Query(q): Query<MeaningQuery>) -> ApiResult<Json<Value>> {
    semantic::kick(s.clone());
    let Some(vector) = semantic::embed_query(&s, &q.q).await else {
        return Ok(Json(json!({ "available": false, "keys": [] })));
    };
    let model = s.config.embed_model.clone();
    let keys = with_db(&s, move |c| Ok(semantic::rank(c, &u.id, &model, &vector, 20)?)).await?;
    Ok(Json(json!({ "available": true, "keys": keys.into_iter().map(|k| k.0).collect::<Vec<_>>() })))
}

// ---------- Teaching history ----------

fn teachings_for(c: &Connection, user_id: &str) -> rusqlite::Result<Vec<Value>> {
    let mut st = c.prepare("SELECT id, lesson_id, taught_on, place, notes FROM teachings WHERE user_id=?1 ORDER BY taught_on DESC, created_at DESC")?;
    let rows = st.query_map([user_id], |r| {
        Ok(json!({ "id": r.get::<_, String>(0)?, "lesson_id": r.get::<_, String>(1)?, "taught_on": r.get::<_, String>(2)?, "place": r.get::<_, String>(3)?, "notes": r.get::<_, String>(4)? }))
    })?;
    rows.collect()
}

async fn list_teachings(State(s): State<S>, u: User) -> ApiResult<Json<Value>> {
    let rows = with_db(&s, move |c| Ok(teachings_for(c, &u.id)?)).await?;
    Ok(Json(json!(rows)))
}

#[derive(Deserialize)]
struct TeachingBody {
    lesson_id: String,
    taught_on: String,
    place: String,
    notes: String,
}

async fn add_teaching(State(s): State<S>, u: User, Json(b): Json<TeachingBody>) -> ApiResult<Json<Value>> {
    if chrono::NaiveDate::parse_from_str(b.taught_on.trim(), "%Y-%m-%d").is_err() {
        return Err(ApiError::bad("Date must be YYYY-MM-DD."));
    }
    let rows = with_db(&s, move |c| {
        let owned: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM lessons WHERE id=?1 AND user_id=?2)", params![b.lesson_id, u.id], |r| r.get(0))?;
        if !owned {
            return Err(ApiError::not_found());
        }
        c.execute(
            "INSERT INTO teachings (id,user_id,lesson_id,taught_on,place,notes,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![new_id(), u.id, b.lesson_id, b.taught_on.trim(), b.place.trim(), b.notes.trim(), now()],
        )?;
        Ok(teachings_for(c, &u.id)?)
    })
    .await?;
    Ok(Json(json!(rows)))
}

async fn delete_teaching(State(s): State<S>, u: User, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let rows = with_db(&s, move |c| {
        if c.execute("DELETE FROM teachings WHERE id=?1 AND user_id=?2", params![id, u.id])? == 0 {
            return Err(ApiError::not_found());
        }
        Ok(teachings_for(c, &u.id)?)
    })
    .await?;
    Ok(Json(json!(rows)))
}

async fn status(State(s): State<S>, _u: User) -> ApiResult<Json<Value>> {
    let last: Option<String> = with_db(&s, |c| {
        Ok(c.query_row("SELECT value FROM app_settings WHERE key='last_backup_at'", [], |r| r.get(0)).optional()?)
    })
    .await?;
    Ok(Json(json!({ "last_backup_at": last })))
}

async fn ai_status(State(s): State<S>, _u: User) -> Json<Value> {
    let url = format!("{}/api/tags", s.config.ollama_url.trim_end_matches('/'));
    // Ollama can take several seconds to answer its first request after idling.
    let resp = s.http.get(url).timeout(std::time::Duration::from_secs(15)).send().await;
    let model = s.config.ollama_model.clone();
    match resp {
        Ok(r) if r.status().is_success() => {
            let body: Value = r.json().await.unwrap_or(json!({}));
            let names: Vec<&str> = body["models"].as_array().map(|m| m.iter().filter_map(|x| x["name"].as_str()).collect()).unwrap_or_default();
            let installed = names.contains(&model.as_str());
            let embed = &s.config.embed_model;
            let meaning = names.iter().any(|n| n == embed || n.strip_suffix(":latest") == Some(embed.as_str()));
            Json(json!({ "available": installed, "reachable": true, "model": model, "meaning": meaning }))
        }
        _ => Json(json!({ "available": false, "reachable": false, "model": model, "meaning": false })),
    }
}

// ---------- Lectures ----------

fn lectures_for(c: &Connection, user_id: &str) -> rusqlite::Result<Vec<Value>> {
    let mut st = c.prepare("SELECT id, title, issue, objective, created_at, updated_at FROM lectures WHERE user_id=?1 ORDER BY updated_at DESC, id")?;
    let rows: Vec<(String, String, String, String, String, String)> = st
        .query_map([user_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?
        .collect::<Result<_, _>>()?;
    let mut vs = c.prepare("SELECT verse_id, objective FROM lecture_verses WHERE lecture_id=?1 ORDER BY ordinal")?;
    let mut out = Vec::new();
    for (id, title, issue, objective, created_at, updated_at) in rows {
        let verses: Vec<(String, String)> = vs.query_map([&id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
        let (verse_ids, verse_objectives): (Vec<String>, Vec<String>) = verses.into_iter().unzip();
        out.push(json!({ "id": id, "title": title, "issue": issue, "objective": objective, "created_at": created_at, "updated_at": updated_at, "verse_ids": verse_ids, "verse_objectives": verse_objectives }));
    }
    Ok(out)
}

async fn list_lectures(State(s): State<S>, u: User) -> ApiResult<Json<Value>> {
    let rows = with_db(&s, move |c| Ok(lectures_for(c, &u.id)?)).await?;
    Ok(Json(json!(rows)))
}

#[derive(Deserialize)]
struct LectureBody {
    id: Option<String>,
    title: String,
    issue: String,
    objective: String,
    verse_ids: Vec<String>,
    /// The objective each verse was chosen for, in the same order. Empty when ungrouped.
    #[serde(default)]
    verse_objectives: Vec<String>,
}

async fn save_lecture(State(s): State<S>, u: User, Json(b): Json<LectureBody>) -> ApiResult<Json<Value>> {
    if b.title.trim().is_empty() {
        return Err(ApiError::bad("Give the lecture a title."));
    }
    let row = with_db(&s, move |c| {
        let tx = c.transaction()?;
        let ts = now();
        let id = match b.id {
            Some(id) => {
                let n = tx.execute(
                    "UPDATE lectures SET title=?1, issue=?2, objective=?3, updated_at=?4 WHERE id=?5 AND user_id=?6",
                    params![b.title.trim(), b.issue, b.objective, ts, id, u.id],
                )?;
                if n == 0 {
                    return Err(ApiError::not_found());
                }
                tx.execute("DELETE FROM lecture_verses WHERE lecture_id=?1", [&id])?;
                id
            }
            None => {
                let id = new_id();
                tx.execute("INSERT INTO lectures VALUES (?1,?2,?3,?4,?5,?6,?6)", params![id, u.id, b.title.trim(), b.issue, b.objective, ts])?;
                id
            }
        };
        for (i, vid) in b.verse_ids.iter().enumerate() {
            let owned: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM verses WHERE id=?1 AND user_id=?2)", params![vid, u.id], |r| r.get(0))?;
            if !owned {
                return Err(ApiError::bad("A selected verse no longer exists."));
            }
            let objective = b.verse_objectives.get(i).map_or("", |o| o.trim());
            tx.execute(
                "INSERT INTO lecture_verses (id,user_id,lecture_id,verse_id,ordinal,objective) VALUES (?1,?2,?3,?4,?5,?6)",
                params![new_id(), u.id, id, vid, i as i64, objective],
            )?;
        }
        tx.commit()?;
        lectures_for(c, &u.id)?.into_iter().find(|l| l["id"] == id.as_str()).ok_or_else(ApiError::not_found)
    })
    .await?;
    Ok(Json(row))
}

#[derive(Deserialize)]
struct ExportBody {
    title: String,
    issue: String,
    objective: String,
    verse_ids: Vec<String>,
    #[serde(default)]
    verse_objectives: Vec<String>,
}

/// Verse text and context are read from the database here, so an export can only ever
/// contain what the vault holds.
async fn export_lecture(State(s): State<S>, u: User, Json(b): Json<ExportBody>) -> ApiResult<Response> {
    if b.title.trim().is_empty() {
        return Err(ApiError::bad("Give the lecture a title."));
    }
    let title = b.title.trim().to_string();
    let (doc_title, issue, objective) = (title.clone(), b.issue, b.objective);
    let items = with_db(&s, move |c| {
        let mut items = Vec::new();
        for (i, id) in b.verse_ids.iter().enumerate() {
            let row = c
                .query_row(
                    "SELECT v.ref_printed, v.version, v.text, COALESCE(x.speaker,''), COALESCE(x.context,''), x.reviewed_at IS NOT NULL
                     FROM verses v LEFT JOIN verse_context x ON x.user_id = v.user_id AND x.canonical_key = v.canonical_key
                     WHERE v.id=?1 AND v.user_id=?2",
                    params![id, u.id],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?, r.get::<_, bool>(5)?)),
                )
                .optional()?;
            let Some((reference, version, text, speaker, context, reviewed)) = row else {
                return Err(ApiError::bad("A selected verse no longer exists."));
            };
            items.push(export::Item { objective: b.verse_objectives.get(i).map_or(String::new(), |o| o.trim().to_string()), reference, version, text, speaker, context, reviewed });
        }
        Ok(items)
    })
    .await?;
    let bytes = export::docx(&doc_title, &issue, &objective, &items).map_err(|e| {
        eprintln!("export failed: {e}");
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Export failed.".into())
    })?;
    let safe: String = title.chars().map(|c| if c.is_ascii_alphanumeric() || " -_".contains(c) { c } else { '_' }).collect();
    Response::builder()
        .header(header::CONTENT_TYPE, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        .header(header::CONTENT_DISPOSITION, format!("attachment; filename=\"{safe}.docx\""))
        .body(Body::from(bytes))
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Export failed.".into()))
}

async fn delete_lecture(State(s): State<S>, u: User, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    with_db(&s, move |c| {
        if c.execute("DELETE FROM lectures WHERE id=?1 AND user_id=?2", params![id, u.id])? == 0 {
            return Err(ApiError::not_found());
        }
        Ok(())
    })
    .await?;
    Ok(Json(json!({ "ok": true })))
}

// ---------- Backup ----------

#[derive(Deserialize)]
struct BackupBody {
    passphrase: String,
}

async fn post_backup(State(s): State<S>, u: User, Json(b): Json<BackupBody>) -> ApiResult<Response> {
    if b.passphrase.chars().count() < backup::MIN_PASSPHRASE_CHARS {
        return Err(ApiError::bad(format!("The passphrase must be at least {} characters.", backup::MIN_PASSPHRASE_CHARS)));
    }
    let state = s.clone();
    let archive = with_db(&s, move |c| {
        let archive = backup::create(c, &state.vault, &u.id).map_err(|e| {
            eprintln!("backup failed: {e}");
            ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Backup failed.".into())
        })?;
        c.execute("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('last_backup_at', ?1)", [now()])?;
        Ok(archive)
    })
    .await?;
    let bytes = tokio::task::spawn_blocking(move || backup::encrypt(&archive, &b.passphrase))
        .await
        .ok()
        .and_then(|sealed| sealed.ok())
        .ok_or_else(|| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Backup failed.".into()))?;
    let name = format!("lesson-vault-backup-{}.lvbackup", chrono::Utc::now().format("%Y%m%d-%H%M%S"));
    Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_DISPOSITION, format!("attachment; filename=\"{name}\""))
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(bytes))
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Backup failed.".into()))
}

async fn post_restore(State(s): State<S>, u: User, mut mp: Multipart) -> ApiResult<Json<Value>> {
    let (mut archive, mut passphrase) = (None, String::new());
    while let Some(f) = mp.next_field().await.map_err(|_| ApiError::bad("The backup could not be read."))? {
        match f.name() {
            Some("file") => archive = Some(f.bytes().await.map_err(|_| ApiError::bad("The backup could not be read; it may be too large."))?),
            Some("passphrase") => passphrase = f.text().await.unwrap_or_default(),
            _ => {}
        }
    }
    let archive = archive.ok_or_else(|| ApiError::bad("No backup file was provided."))?;
    let archive = tokio::task::spawn_blocking(move || backup::decrypt(&archive, &passphrase))
        .await
        .map_err(|_| ApiError::bad("The backup could not be read."))?
        .map_err(ApiError::bad)?;
    let state = s.clone();
    let count = with_db(&s, move |c| backup::restore(c, &state.vault, &u.id, &archive).map_err(ApiError::bad)).await?;
    semantic::kick(s.clone());
    Ok(Json(json!({ "ok": true, "lessons": count })))
}

#[derive(Deserialize)]
struct ResetBody {
    confirm: String,
}

async fn post_reset(State(s): State<S>, u: User, Json(b): Json<ResetBody>) -> ApiResult<Json<Value>> {
    if b.confirm != "RESET" {
        return Err(ApiError::bad("Reset was not confirmed."));
    }
    let state = s.clone();
    with_db(&s, move |c| {
        backup::wipe(c, &state.vault, &u.id).map_err(|e| {
            eprintln!("reset failed: {e}");
            ApiError(StatusCode::INTERNAL_SERVER_ERROR, "Reset failed.".into())
        })
    })
    .await?;
    Ok(Json(json!({ "ok": true })))
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "app": "lesson-vault" }))
}

async fn api_not_found() -> ApiError {
    ApiError::not_found()
}

/// Content-hashed build output can be cached forever; this is what makes route
/// changes and reloads instant.
pub async fn cache_hashed_assets(uri: axum::http::Uri, mut res: Response) -> Response {
    let path = uri.path();
    if path.starts_with("/assets/") && res.status().is_success() {
        res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable"));
    } else if path.starts_with("/ocr/") && res.status().is_success() {
        res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=604800"));
    }
    res
}

pub fn router(state: S) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        .route("/lessons", get(list_lessons).post(upload_lesson).layer(DefaultBodyLimit::max(MAX_PDF + 32 * 1024 * 1024)))
        .route("/lessons/{id}", axum::routing::patch(patch_lesson).delete(delete_lesson))
        .route("/lessons/{id}/file", get(lesson_file))
        .route("/search", get(search))
        .route("/search/meaning", get(search_meaning))
        .route("/status", get(status))
        .route("/teachings", get(list_teachings).post(add_teaching))
        .route("/teachings/{id}", axum::routing::delete(delete_teaching))
        .route("/lectures/export", post(export_lecture))
        .route("/folders", get(list_folders).post(create_folder))
        .route("/folders/{id}", axum::routing::delete(delete_folder))
        .route("/verses", get(list_verses))
        .route("/verses/{id}", axum::routing::patch(correct_verse))
        .route("/verses/{id}/verify", post(verify_verse))
        .route("/verse-context", get(list_verse_context).post(save_verse_context))
        .route("/ai/status", get(ai_status))
        .route("/ai/suggest", post(ai_suggest))
        .route("/ai/notes", post(ai_notes))
        .route("/lectures", get(list_lectures).post(save_lecture))
        .route("/lectures/{id}", axum::routing::delete(delete_lecture))
        .route("/backup", post(post_backup))
        .route("/restore", post(post_restore).layer(DefaultBodyLimit::max(1024 * 1024 * 1024)))
        .route("/reset", post(post_reset))
        .fallback(api_not_found)
        .layer(axum::middleware::from_fn(only_this_app))
        // Lesson content must not be left in the browser's disk cache.
        .layer(tower_http::set_header::SetResponseHeaderLayer::overriding(header::CACHE_CONTROL, HeaderValue::from_static("no-store")));
    Router::new().nest("/api", api).with_state(state)
}

#[cfg(test)]
mod tests {
    use super::request_is_from_this_app as allowed;

    #[test]
    fn the_apps_own_requests_are_allowed() {
        assert!(allowed(Some("127.0.0.1:47319"), None, None));
        assert!(allowed(Some("127.0.0.1:47319"), Some("http://127.0.0.1:47319"), Some("same-origin")));
        assert!(allowed(Some("localhost:47319"), Some("http://localhost:47319"), None));
        assert!(allowed(Some("[::1]:47319"), None, None));
    }

    #[test]
    fn other_websites_are_refused() {
        assert!(!allowed(Some("127.0.0.1:47319"), Some("https://evil.example"), Some("cross-site")));
        assert!(!allowed(Some("127.0.0.1:47319"), Some("https://evil.example"), None));
        assert!(!allowed(Some("127.0.0.1:47319"), Some("null"), None));
        assert!(!allowed(Some("127.0.0.1:47319"), None, Some("cross-site")));
        // Another app on this computer, on a different port.
        assert!(!allowed(Some("127.0.0.1:47319"), Some("http://127.0.0.1:3000"), Some("same-site")));
    }

    #[test]
    fn dns_rebinding_is_refused() {
        assert!(!allowed(Some("evil.example:47319"), None, None));
        assert!(!allowed(Some("evil.example"), Some("http://evil.example"), Some("same-origin")));
        assert!(!allowed(Some("127.0.0.1.evil.example:47319"), None, None));
        assert!(!allowed(None, None, None));
    }
}

