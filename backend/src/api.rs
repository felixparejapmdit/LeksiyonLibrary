use crate::{ai, backup, export, outline, parser, semantic, verse_import, AppState};
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
use std::{collections::{HashMap, HashSet}, sync::Arc};

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

const LESSON_COLS: &str = "l.id, l.title, l.category, l.language, l.lesson_date, l.date_label, l.year, l.location, l.author, l.code, l.file_name, l.byte_size, l.page_count, l.source_kind, l.issue, l.objectives, l.created_at, l.folder_id, l.needs_check";

fn lesson_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let objectives: String = r.get(15)?;
    Ok(json!({
        "id": r.get::<_, String>(0)?, "title": r.get::<_, String>(1)?, "category": r.get::<_, String>(2)?,
        "language": r.get::<_, String>(3)?, "lesson_date": r.get::<_, Option<String>>(4)?, "date_label": r.get::<_, String>(5)?,
        "year": r.get::<_, Option<i64>>(6)?, "location": r.get::<_, String>(7)?, "author": r.get::<_, String>(8)?,
        "code": r.get::<_, String>(9)?, "file_name": r.get::<_, String>(10)?, "byte_size": r.get::<_, i64>(11)?,
        "page_count": r.get::<_, i64>(12)?, "source_kind": r.get::<_, String>(13)?, "issue": r.get::<_, String>(14)?,
        "objectives": serde_json::from_str::<Value>(&objectives).unwrap_or(json!([])), "created_at": r.get::<_, String>(16)?,
        "folder_id": r.get::<_, Option<String>>(17)?, "needs_check": r.get::<_, i64>(18)? != 0,
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
    // Pastoral visits have their own upload: everything added there is one.
    let mut pastoral = false;
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
            "category" => pastoral = field.text().await.unwrap_or_default() == "pastoral",
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
    let mut parsed = parser::parse(&pages, &safe_name);
    if pastoral {
        parsed.category = "pastoral".into();
    }
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
            "INSERT INTO lessons (id,user_id,title,category,language,lesson_date,date_label,year,location,author,code,file_name,sha256,byte_size,page_count,source_kind,content,issue,objectives,created_at,needs_check,outline)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,1,?21)",
            params![id2, uid, parsed.title, parsed.category, parsed.language, parsed.lesson_date, parsed.date_label, parsed.year, parsed.location, parsed.author, parsed.code, safe_name, sha, byte_size, page_count, source_kind, parsed.content, parsed.issue, json!(parsed.objectives).to_string(), ts, json!(parsed.outline).to_string()],
        )?;
        for (ordinal, v) in parsed.verses.iter().enumerate() {
            let existing: Option<String> = tx
                .query_row(
                    "SELECT id FROM verses WHERE user_id=?1 AND canonical_key=?2 AND version=?3 AND language=?4 AND ocr_raw=?5",
                    params![uid, v.canonical_key, v.version, v.language, v.raw],
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
                        params![vid, uid, v.canonical_key, v.book_id, v.ref_printed, v.ref_en, v.ref_tl, v.version, v.language, v.text, sha_hex(v.text.as_bytes()), v.raw, ts],
                    )?;
                    vid
                }
            };
            tx.execute(
                "INSERT INTO lesson_verses (id,user_id,lesson_id,verse_id,page,ordinal,section,question) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![new_id(), uid, id2, verse_id, v.page, ordinal as i64, v.section, v.question],
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
    /// Set once the user has compared what was read with the PDF.
    checked: Option<bool>,
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
        if let Some(v) = b.checked {
            tx.execute("UPDATE lessons SET needs_check=?1 WHERE id=?2", params![!v as i64, id])?;
        }
        tx.commit()?;
        Ok(c.query_row(&format!("SELECT {LESSON_COLS} FROM lessons l WHERE l.id = ?1"), [&id], lesson_row)?)
    })
    .await?;
    Ok(Json(row))
}

/// Keeps verified scripture, imported verses and verses a lecture uses; removes unverified
/// extractions that no lesson cites any more.
fn remove_uncited_scans(c: &Connection, user_id: &str) -> rusqlite::Result<usize> {
    c.execute(
        "DELETE FROM verses WHERE user_id=?1 AND status='unverified' AND import_source=''
         AND id NOT IN (SELECT verse_id FROM lesson_verses WHERE user_id=?1)
         AND id NOT IN (SELECT verse_id FROM lecture_verses WHERE user_id=?1)",
        [user_id],
    )
}

async fn delete_lesson(State(s): State<S>, u: User, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let id2 = id.clone();
    with_db(&s, move |c| {
        let n = c.execute("DELETE FROM lessons WHERE id=?1 AND user_id=?2", params![id2, u.id])?;
        if n == 0 {
            return Err(ApiError::not_found());
        }
        remove_uncited_scans(c, &u.id)?;
        Ok(())
    })
    .await?;
    s.vault.remove_pdf(&id);
    Ok(Json(json!({ "ok": true })))
}

/// Something the parser took for a verse but is not one, found while checking a lesson.
async fn remove_lesson_verse(State(s): State<S>, u: User, Path((id, verse_id)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    with_db(&s, move |c| {
        let n = c.execute("DELETE FROM lesson_verses WHERE user_id=?1 AND lesson_id=?2 AND verse_id=?3", params![u.id, id, verse_id])?;
        if n == 0 {
            return Err(ApiError::not_found());
        }
        remove_uncited_scans(c, &u.id)?;
        Ok(Json(json!({ "ok": true })))
    })
    .await
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
        let mut st = c.prepare("SELECT lv.verse_id, lv.lesson_id, lv.page, lv.section, lv.question, l.category = 'pastoral' FROM lesson_verses lv JOIN lessons l ON l.id = lv.lesson_id WHERE lv.user_id=?1 ORDER BY lv.ordinal")?;
        for row in st.query_map([user_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, String>(4)?, r.get::<_, bool>(5)?)))? {
            let (v, l, p, section, question, pastoral) = row?;
            let list = sources.entry(v).or_default();
            // Printed twice in one lesson, it is listed once, where it first appears.
            if !list.iter().any(|x| x["lesson_id"] == l.as_str()) {
                list.push(json!({ "lesson_id": l, "page": p, "section": section, "question": question, "pastoral": pastoral }));
            }
        }
    }
    let mut st = c.prepare(
        "SELECT id, canonical_key, book_id, ref_printed, ref_en, ref_tl, version, language, text, ocr_raw, status, verified_at, ref_note, import_source
         FROM verses WHERE user_id=?1 ORDER BY book_id, canonical_key, language DESC, seq",
    )?;
    let rows = st.query_map([user_id], |r| {
        Ok(json!({
            "id": r.get::<_, String>(0)?, "canonical_key": r.get::<_, String>(1)?, "book_id": r.get::<_, i64>(2)?,
            "ref_printed": r.get::<_, String>(3)?, "ref_en": r.get::<_, String>(4)?, "ref_tl": r.get::<_, String>(5)?,
            "version": r.get::<_, String>(6)?, "language": r.get::<_, String>(7)?, "text": r.get::<_, String>(8)?,
            "ocr_raw": r.get::<_, String>(9)?, "status": r.get::<_, String>(10)?, "verified_at": r.get::<_, Option<String>>(11)?,
            "ref_note": r.get::<_, String>(12)?, "import_source": r.get::<_, String>(13)?,
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

// ---------- Importing verses ----------

const MAX_WORKBOOK: usize = 32 * 1024 * 1024;
const SHEET_SETTING: &str = "import_sheet_id";

fn with_counts(fixes: &[verse_import::Fix]) -> Vec<Value> {
    fixes.iter().map(|f| json!({ "from": f.from, "to": f.to, "count": f.count })).collect()
}

fn import_verse(c: &Connection, user_id: &str, v: &verse_import::ImportVerse, source: &str, ts: &str) -> rusqlite::Result<()> {
    c.execute(
        "INSERT INTO verses (id,user_id,canonical_key,book_id,ref_printed,ref_en,ref_tl,version,language,text,text_sha256,ocr_raw,status,ref_note,created_at,import_source)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'unverified',?13,?14,?15)",
        params![new_id(), user_id, v.canonical_key, v.book_id, v.ref_printed, v.ref_en, v.ref_tl, v.version, v.language, v.text, sha_hex(v.text.as_bytes()), v.raw, v.note, ts, format!("{source}, row {}", v.row)],
    )?;
    Ok(())
}

fn verse_in_vault(c: &Connection, user_id: &str, v: &verse_import::ImportVerse) -> rusqlite::Result<bool> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM verses WHERE user_id=?1 AND canonical_key=?2 AND version=?3 AND language=?4 AND (ocr_raw=?5 OR text=?6))",
        params![user_id, v.canonical_key, v.version, v.language, v.raw, v.text],
        |r| r.get(0),
    )
}

/// Whether a left-out row needs no fixing, because it was fixed here or in the sheet, or the
/// sheet also has it under a complete reference: the same translation, chapter, verse and words.
fn row_in_vault(c: &Connection, user_id: &str, translation: &str, chapter: &str, verse: &str, content: &str) -> rusqlite::Result<bool> {
    let (text, reference) = match verse_import::row_text(verse, content) {
        Some((text, number)) => (text, format!("%.{}:{number}", chapter.trim())),
        None => (String::new(), String::new()),
    };
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM verses WHERE user_id=?1 AND version=?2 AND (ocr_raw=?3 OR (text=?4 AND canonical_key LIKE ?5)))",
        params![user_id, translation, content, text, reference],
        |r| r.get(0),
    )
}

/// Saves the plan's verses, and keeps the rows left out so they can be fixed in the app. With
/// `commit` false it only reports what would happen. All of it goes into the vault's
/// database, so it is sealed with everything else.
async fn apply_import(s: &S, user_id: String, plan: verse_import::Plan, source: String, commit: bool) -> ApiResult<Value> {
    let report = with_db(s, move |c| {
        let tx = c.transaction()?;
        let (mut added, mut existing) = (0_i64, 0_i64);
        let ts = now();
        for v in &plan.verses {
            if verse_in_vault(&tx, &user_id, v)? {
                existing += 1;
                continue;
            }
            added += 1;
            if commit {
                import_verse(&tx, &user_id, v, &source, &ts)?;
            }
        }
        let mut problems = Vec::new();
        for issue in &plan.problems {
            let Some(row) = &issue.sheet_row else { continue };
            if !row_in_vault(&tx, &user_id, &row.translation, &row.chapter, &row.verse, &row.content)? {
                problems.push(issue);
            }
        }
        if commit {
            // The sheet is the latest word on its own rows, so a row fixed there stops being listed.
            tx.execute("DELETE FROM import_rows_to_fix WHERE user_id=?1 AND source=?2", params![user_id, source])?;
            for issue in &problems {
                let Some(row) = &issue.sheet_row else { continue };
                tx.execute(
                    "INSERT INTO import_rows_to_fix (id,user_id,source,row_number,translation,book,chapter,verse,content,message,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                    params![new_id(), user_id, source, row.row as i64, row.translation, row.book, row.chapter, row.verse, row.content, issue.message, ts],
                )?;
            }
            // Rows kept from another source may be settled by this import too.
            let waiting: Vec<(String, String, String, String, String)> = {
                let mut st = tx.prepare("SELECT id,translation,chapter,verse,content FROM import_rows_to_fix WHERE user_id=?1")?;
                let rows = st.query_map([&user_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?;
                rows.collect::<rusqlite::Result<_>>()?
            };
            for (id, translation, chapter, verse, content) in waiting {
                if row_in_vault(&tx, &user_id, &translation, &chapter, &verse, &content)? {
                    tx.execute("DELETE FROM import_rows_to_fix WHERE id=?1", [&id])?;
                }
            }
            tx.commit()?;
        }
        let issues = |list: &[verse_import::Issue]| list.iter().map(|i| json!({ "row": i.row, "message": i.message })).collect::<Vec<_>>();
        Ok(json!({
            "file": source,
            "committed": commit,
            "rows": plan.rows,
            "new_verses": added,
            "already_in_vault": existing,
            "duplicates_in_file": plan.duplicates,
            "other_wordings": plan.other_wordings,
            "tagalog": plan.verses.iter().filter(|v| v.language == "tl").count(),
            "english": plan.verses.iter().filter(|v| v.language == "en").count(),
            "translations": plan.translations(),
            "book_fixes": with_counts(&plan.book_fixes),
            "translation_fixes": with_counts(&plan.translation_fixes),
            "number_fixes": issues(&plan.number_fixes),
            "problems": problems.iter().map(|i| json!({ "row": i.row, "message": i.message })).collect::<Vec<_>>(),
            "flagged": issues(&plan.flagged),
        }))
    })
    .await?;
    if commit {
        semantic::kick(s.clone());
    }
    Ok(report)
}

fn rows_to_fix(c: &Connection, user_id: &str) -> rusqlite::Result<Vec<Value>> {
    let mut st = c.prepare("SELECT id,source,row_number,translation,book,chapter,verse,content,message FROM import_rows_to_fix WHERE user_id=?1 ORDER BY source,row_number")?;
    let rows = st.query_map([user_id], |r| {
        let book: String = r.get(4)?;
        Ok(json!({
            "id": r.get::<_, String>(0)?, "source": r.get::<_, String>(1)?, "row": r.get::<_, i64>(2)?,
            "translation": r.get::<_, String>(3)?, "chapter": r.get::<_, String>(5)?, "verse": r.get::<_, String>(6)?,
            "content": r.get::<_, String>(7)?, "message": r.get::<_, String>(8)?,
            "choices": verse_import::book_choices(&book), "book": book,
        }))
    })?;
    rows.collect()
}

async fn list_rows_to_fix(State(s): State<S>, u: User) -> ApiResult<Json<Value>> {
    let rows = with_db(&s, move |c| Ok(rows_to_fix(c, &u.id)?)).await?;
    Ok(Json(json!(rows)))
}

#[derive(Deserialize)]
struct FixRowBody {
    translation: String,
    book: String,
    chapter: String,
    verse: String,
    content: String,
}

/// Takes the user's correction through the same checks as the sheet itself. A row that still
/// has a problem stays on the list, and nothing is saved.
async fn fix_row(State(s): State<S>, u: User, Path(id): Path<String>, Json(b): Json<FixRowBody>) -> ApiResult<Json<Value>> {
    let rows = with_db(&s, move |c| {
        let found: Option<(String, i64)> = c
            .query_row("SELECT source,row_number FROM import_rows_to_fix WHERE id=?1 AND user_id=?2", params![id, u.id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        let Some((source, row)) = found else { return Err(ApiError::not_found()) };
        let sheet_row = verse_import::SheetRow { row: row as usize, translation: b.translation, book: b.book, chapter: b.chapter, verse: b.verse, content: b.content };
        let plan = verse_import::plan(&[sheet_row]);
        if let Some(problem) = plan.problems.first() {
            return Err(ApiError::bad(problem.message.clone()));
        }
        let tx = c.transaction()?;
        for v in &plan.verses {
            if !verse_in_vault(&tx, &u.id, v)? {
                import_verse(&tx, &u.id, v, &source, &now())?;
            }
        }
        tx.execute("DELETE FROM import_rows_to_fix WHERE id=?1", [&id])?;
        tx.commit()?;
        Ok(rows_to_fix(c, &u.id)?)
    })
    .await?;
    semantic::kick(s.clone());
    Ok(Json(json!(rows)))
}

async fn dismiss_row(State(s): State<S>, u: User, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let rows = with_db(&s, move |c| {
        if c.execute("DELETE FROM import_rows_to_fix WHERE id=?1 AND user_id=?2", params![id, u.id])? == 0 {
            return Err(ApiError::not_found());
        }
        Ok(rows_to_fix(c, &u.id)?)
    })
    .await?;
    Ok(Json(json!(rows)))
}

/// Reads an Excel file. It is only ever held in memory, and is not kept.
async fn import_verses(State(s): State<S>, u: User, mut mp: Multipart) -> ApiResult<Json<Value>> {
    let (mut file, mut file_name, mut commit) = (None::<Vec<u8>>, String::new(), false);
    while let Some(field) = mp.next_field().await.map_err(|_| ApiError::bad("The file could not be read."))? {
        match field.name().unwrap_or_default() {
            "file" => {
                file_name = field.file_name().unwrap_or("verses.xlsx").to_string();
                file = Some(field.bytes().await.map_err(|_| ApiError::bad("The file could not be read; it may be too large."))?.to_vec());
            }
            "commit" => commit = field.text().await.unwrap_or_default() == "1",
            _ => {}
        }
    }
    let file = file.ok_or_else(|| ApiError::bad("No file was provided."))?;
    if file.len() > MAX_WORKBOOK {
        return Err(ApiError(StatusCode::PAYLOAD_TOO_LARGE, "Excel files are limited to 32 MB.".into()));
    }
    let safe_name = std::path::Path::new(&file_name.replace('\\', "/"))
        .file_name()
        .map_or_else(|| "verses.xlsx".to_string(), |n| n.to_string_lossy().to_string());
    let plan = tokio::task::spawn_blocking(move || verse_import::read_workbook(&file).map(|rows| verse_import::plan(&rows)))
        .await
        .map_err(|_| ApiError::bad("The file could not be read."))?
        .map_err(|e| ApiError(StatusCode::UNSUPPORTED_MEDIA_TYPE, e))?;
    Ok(Json(apply_import(&s, u.id, plan, safe_name, commit).await?))
}

#[derive(Deserialize)]
struct SheetBody {
    /// A link to the sheet, a spreadsheet ID, or the gid of a tab of the last one used.
    sheet: String,
    #[serde(default)]
    commit: bool,
}

/// Downloads one tab from Google. This is the only thing the app ever sends outside this
/// computer, and only when asked. The request carries nothing but the sheet's own ID, so
/// no vault data leaves, and the address is built here, so it can only ever go to Google.
async fn download_sheet(base_url: &str, id: &str, gid: &str) -> Result<Vec<u8>, ApiError> {
    const NOT_SHARED: &str = "Google would not share this sheet without signing in. In Google Sheets, choose Share, then General access: Anyone with the link, Viewer. Or download it as .xlsx and use the file option, which keeps it private.";
    let failed = |e: reqwest::Error| {
        eprintln!("Google Sheets download failed: {e}");
        ApiError(StatusCode::BAD_GATEWAY, "Could not reach Google. Check your internet connection and try again.".into())
    };
    // Its own client: the app's usual one ignores proxies and gives up quickly, because it
    // only talks to this computer.
    let client = reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(20)).timeout(std::time::Duration::from_secs(120)).build().map_err(failed)?;
    let url = format!("{}/spreadsheets/d/{id}/export?format=csv&gid={gid}", base_url.trim_end_matches('/'));
    let mut response = client.get(url).send().await.map_err(failed)?;
    match response.status() {
        status if status.is_success() => {}
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => return Err(ApiError::bad(NOT_SHARED)),
        StatusCode::NOT_FOUND => return Err(ApiError::bad("Google could not find that spreadsheet. Check the link.")),
        StatusCode::BAD_REQUEST => return Err(ApiError::bad("Google could not find that tab. Check the gid.")),
        status => {
            eprintln!("Google Sheets answered {status}");
            return Err(ApiError(StatusCode::BAD_GATEWAY, "Google could not provide this sheet right now. Try again shortly.".into()));
        }
    }
    // A private sheet answers with a sign-in page, not an error.
    let is_csv = response.headers().get(header::CONTENT_TYPE).and_then(|t| t.to_str().ok()).is_some_and(|t| t.starts_with("text/csv"));
    if !is_csv {
        return Err(ApiError::bad(NOT_SHARED));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(failed)? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_WORKBOOK {
            return Err(ApiError(StatusCode::PAYLOAD_TOO_LARGE, "That sheet is larger than 32 MB.".into()));
        }
    }
    Ok(body)
}

async fn import_google_sheet(State(s): State<S>, u: User, Json(b): Json<SheetBody>) -> ApiResult<Json<Value>> {
    let remembered: Option<String> = with_db(&s, |c| {
        Ok(c.query_row("SELECT value FROM app_settings WHERE key=?1", [SHEET_SETTING], |r| r.get(0)).optional()?)
    })
    .await?;
    let (id, gid) = verse_import::sheet_address(&b.sheet, remembered.as_deref()).map_err(ApiError::bad)?;
    let body = download_sheet(&s.config.sheets_url, &id, &gid).await?;
    let plan = tokio::task::spawn_blocking(move || verse_import::read_csv(&body).map(|rows| verse_import::plan(&rows)))
        .await
        .map_err(|_| ApiError::bad("The sheet could not be read."))?
        .map_err(ApiError::bad)?;
    with_db(&s, move |c| {
        c.execute("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)", params![SHEET_SETTING, id])?;
        Ok(())
    })
    .await?;
    Ok(Json(apply_import(&s, u.id, plan, "Google Sheet".to_string(), b.commit).await?))
}

/// Undoes an import. Verses the user has verified, or that a lesson or saved lecture uses,
/// are kept, so this can never take anything out of their work.
async fn remove_imported(State(s): State<S>, u: User) -> ApiResult<Json<Value>> {
    let report = with_db(&s, move |c| {
        let removed = c.execute(
            "DELETE FROM verses WHERE user_id=?1 AND import_source<>'' AND status='unverified'
             AND id NOT IN (SELECT verse_id FROM lecture_verses WHERE user_id=?1)
             AND id NOT IN (SELECT verse_id FROM lesson_verses WHERE user_id=?1)",
            [&u.id],
        )?;
        c.execute("DELETE FROM import_rows_to_fix WHERE user_id=?1", [&u.id])?;
        let kept: i64 = c.query_row("SELECT count(*) FROM verses WHERE user_id=?1 AND import_source<>''", [&u.id], |r| r.get(0))?;
        Ok(json!({ "removed": removed, "kept": kept }))
    })
    .await?;
    Ok(Json(report))
}

// ---------- AI ----------

#[derive(Deserialize)]
struct SuggestBody {
    issue: String,
    objective: String,
    /// Verses wanted for this one objective (3 to 5). Absent means best matches overall.
    count: Option<usize>,
    /// Verses already shown, by canonical key, when more are asked for.
    #[serde(default)]
    exclude: Vec<String>,
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
        let exclude: HashSet<String> = b.exclude.iter().take(500).cloned().collect();
        // Enough of each list to still fill the places once the verses already shown are left out.
        let wanted = limit + exclude.len();
        let (keyword, lessons) = match b.count {
            // For one objective, lessons give the verses of their part that teaches the same thing.
            Some(_) if !b.objective.trim().is_empty() => (
                ai::retrieve_for_objective(c, &u.id, &b.issue, &b.objective, wanted)?,
                outline::for_objective(c, &u.id, &b.issue, &b.objective, wanted)?,
            ),
            // For an issue or topic alone, they give verses from across each matching lesson.
            _ => (
                ai::retrieve(c, &u.id, &b.issue, &b.objective, wanted)?,
                outline::for_topic(c, &u.id, &format!("{} {}", b.issue, b.objective), wanted)?,
            ),
        };
        let related = match &vector {
            Some(v) => semantic::rank(c, &u.id, &embed_model, v, wanted)?,
            None => vec![],
        };
        let suggestions = ai::fuse(c, &u.id, lessons, keyword, &related, &exclude, limit)?;
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

/// Finds the speaker of any of these verses without one. Each is kept, and each answer is
/// saved as it arrives, so an interrupted run loses nothing. Failing here costs only the
/// speakers: the notes already written are still returned.
async fn fill_speakers(s: &S, user_id: &str, candidates: &[ai::Candidate]) -> ApiResult<serde_json::Map<String, Value>> {
    let owner = user_id.to_string();
    let mut known = with_db(s, move |c| Ok(contexts_for(c, &owner)?)).await?;
    for (key, reference, _) in candidates {
        // An entry the user reviewed stays as it is, even with no speaker.
        if known.get(key).is_some_and(|k| k["reviewed"] == true || k["speaker"].as_str().is_some_and(|x| !x.is_empty())) {
            continue;
        }
        let found = match ai::request_speaker(&s.http, &s.config.ollama_url, &s.config.ollama_model, reference).await {
            Ok(found) => found,
            Err(e) => {
                eprintln!("AI speaker unavailable: {e}");
                break;
            }
        };
        let Some(speaker) = found else { continue };
        let (owner, key, model) = (user_id.to_string(), key.clone(), s.config.ollama_model.clone());
        known = with_db(s, move |c| {
            c.execute(
                "INSERT INTO verse_context (user_id, canonical_key, speaker, context, model, updated_at) VALUES (?1,?2,?3,'',?4,?5)
                 ON CONFLICT (user_id, canonical_key) DO UPDATE SET speaker = excluded.speaker, model = excluded.model, updated_at = excluded.updated_at
                 WHERE verse_context.reviewed_at IS NULL",
                params![owner, key, speaker, model, now()],
            )?;
            Ok(contexts_for(c, &owner)?)
        })
        .await?;
    }
    Ok(known)
}

/// Writes background for any book or chapter of these verses that has none yet. Each is
/// written once and shared, so later searches are quicker, and saved as it arrives.
async fn fill_scripture_context(s: &S, user_id: &str, keys: &[String]) -> ApiResult<serde_json::Map<String, Value>> {
    let owner = user_id.to_string();
    let mut known = with_db(s, move |c| Ok(scripture_for(c, &owner)?)).await?;
    for request in ai::scope_requests(keys, &known.keys().cloned().collect()) {
        let written = match ai::request_scope(&s.http, &s.config.ollama_url, &s.config.ollama_model, &request.label).await {
            Ok(written) => written,
            Err(e) => {
                eprintln!("AI context unavailable: {e}");
                break;
            }
        };
        let Some(text) = written else { continue };
        let (owner, model) = (user_id.to_string(), s.config.ollama_model.clone());
        known = with_db(s, move |c| {
            // A review made in the meantime wins over what the AI just wrote.
            c.execute(
                "INSERT INTO scripture_context (user_id, scope, context, model, updated_at) VALUES (?1,?2,?3,?4,?5)
                 ON CONFLICT (user_id, scope) DO NOTHING",
                params![owner, request.scope, text, model, now()],
            )?;
            Ok(scripture_for(c, &owner)?)
        })
        .await?;
    }
    Ok(known)
}

fn scripture_for(c: &Connection, user_id: &str) -> rusqlite::Result<serde_json::Map<String, Value>> {
    let mut st = c.prepare("SELECT scope, context, reviewed_at FROM scripture_context WHERE user_id=?1")?;
    let rows = st.query_map([user_id], |r| {
        Ok((r.get::<_, String>(0)?, json!({ "context": r.get::<_, String>(1)?, "reviewed": r.get::<_, Option<String>>(2)?.is_some() })))
    })?;
    rows.collect()
}

async fn list_scripture_context(State(s): State<S>, u: User) -> ApiResult<Json<Value>> {
    let rows = with_db(&s, move |c| Ok(scripture_for(c, &u.id)?)).await?;
    Ok(Json(Value::Object(rows)))
}

#[derive(Deserialize)]
struct ScriptureContextBody {
    scope: String,
    context: String,
}

fn valid_scope(scope: &str) -> bool {
    let id = if let Some(book) = scope.strip_prefix("book:").or_else(|| scope.strip_prefix("history:")) {
        book
    } else if let Some(chapter) = scope.strip_prefix("chapter:") {
        match chapter.split_once('.') {
            Some((book, number)) if !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()) => book,
            _ => return false,
        }
    } else {
        return false;
    };
    id.parse().ok().and_then(crate::books::by_id).is_some()
}

fn tagalog_for(c: &Connection, user_id: &str) -> rusqlite::Result<serde_json::Map<String, Value>> {
    let mut st = c.prepare("SELECT item, text, reviewed_at FROM context_tagalog WHERE user_id=?1")?;
    let rows = st.query_map([user_id], |r| {
        Ok((r.get::<_, String>(0)?, json!({ "text": r.get::<_, String>(1)?, "reviewed": r.get::<_, Option<String>>(2)?.is_some() })))
    })?;
    rows.collect()
}

/// The English this item's Tagalog translates. Empty when there is none yet.
fn english_of(c: &Connection, user_id: &str, item: &str) -> rusqlite::Result<String> {
    let found: Option<String> = if let Some(key) = item.strip_prefix("speaker:") {
        c.query_row("SELECT speaker FROM verse_context WHERE user_id=?1 AND canonical_key=?2", params![user_id, key], |r| r.get(0)).optional()?
    } else if let Some(key) = item.strip_prefix("note:") {
        c.query_row("SELECT context FROM verse_context WHERE user_id=?1 AND canonical_key=?2", params![user_id, key], |r| r.get(0)).optional()?
    } else {
        c.query_row("SELECT context FROM scripture_context WHERE user_id=?1 AND scope=?2", params![user_id, item], |r| r.get(0)).optional()?
    };
    Ok(found.unwrap_or_default())
}

fn valid_tagalog_item(c: &Connection, user_id: &str, item: &str) -> rusqlite::Result<bool> {
    match item.strip_prefix("speaker:").or_else(|| item.strip_prefix("note:")) {
        Some(key) => c.query_row("SELECT EXISTS(SELECT 1 FROM verses WHERE user_id=?1 AND canonical_key=?2)", params![user_id, key], |r| r.get(0)),
        None => Ok(valid_scope(item)),
    }
}

/// When the English changes, a machine translation of the old wording is out of date. The
/// user's own Tagalog is theirs to change.
fn forget_stale_translation(c: &Connection, user_id: &str, item: &str, new_english: &str) -> rusqlite::Result<()> {
    if english_of(c, user_id, item)? != new_english {
        c.execute("DELETE FROM context_tagalog WHERE user_id=?1 AND item=?2 AND reviewed_at IS NULL", params![user_id, item])?;
    }
    Ok(())
}

async fn list_context_tagalog(State(s): State<S>, u: User) -> ApiResult<Json<Value>> {
    let rows = with_db(&s, move |c| Ok(tagalog_for(c, &u.id)?)).await?;
    Ok(Json(Value::Object(rows)))
}

#[derive(Deserialize)]
struct TagalogBody {
    item: String,
    text: String,
}

/// The user's Tagalog wording, marked reviewed. Clearing it lets the AI translate again.
async fn save_context_tagalog(State(s): State<S>, u: User, Json(b): Json<TagalogBody>) -> ApiResult<Json<Value>> {
    let text = b.text.trim().to_string();
    if text.chars().count() > 8000 {
        return Err(ApiError::bad("That text is too long."));
    }
    let rows = with_db(&s, move |c| {
        if !valid_tagalog_item(c, &u.id, &b.item)? {
            return Err(ApiError::bad("Unknown context."));
        }
        if text.is_empty() {
            c.execute("DELETE FROM context_tagalog WHERE user_id=?1 AND item=?2", params![u.id, b.item])?;
        } else {
            c.execute(
                "INSERT INTO context_tagalog (user_id, item, text, updated_at, reviewed_at) VALUES (?1,?2,?3,?4,?4)
                 ON CONFLICT (user_id, item) DO UPDATE SET text=excluded.text, model='', updated_at=excluded.updated_at, reviewed_at=excluded.reviewed_at",
                params![u.id, b.item, text, now()],
            )?;
        }
        Ok(tagalog_for(c, &u.id)?)
    })
    .await?;
    Ok(Json(Value::Object(rows)))
}

#[derive(Deserialize)]
struct TranslateBody {
    item: String,
}

/// Translates one context, reading its English here so only what the vault holds is sent.
/// Done one at a time and only when asked for, because each takes the local model a while.
async fn translate_context(State(s): State<S>, u: User, Json(b): Json<TranslateBody>) -> ApiResult<Json<Value>> {
    let (owner, item) = (u.id.clone(), b.item.clone());
    let (english, known) = with_db(&s, move |c| {
        if !valid_tagalog_item(c, &owner, &item)? {
            return Err(ApiError::bad("Unknown context."));
        }
        let known: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM context_tagalog WHERE user_id=?1 AND item=?2)", params![owner, item], |r| r.get(0))?;
        Ok((english_of(c, &owner, &item)?, known))
    })
    .await?;
    let mut available = true;
    if !known && !english.trim().is_empty() {
        let translated = if english.trim().eq_ignore_ascii_case("not stated") {
            Ok(Some("Hindi nakasaad".to_string()))
        } else {
            ai::request_tagalog(&s.http, &s.config.ollama_url, &s.config.ollama_model, &english).await
        };
        match translated {
            Ok(Some(text)) => {
                let (owner, item, model) = (u.id.clone(), b.item, s.config.ollama_model.clone());
                with_db(&s, move |c| {
                    // A review made in the meantime wins over what the AI just wrote.
                    c.execute(
                        "INSERT INTO context_tagalog (user_id, item, text, model, updated_at) VALUES (?1,?2,?3,?4,?5) ON CONFLICT (user_id, item) DO NOTHING",
                        params![owner, item, text, model, now()],
                    )?;
                    Ok(())
                })
                .await?;
            }
            Ok(None) => {}
            Err(e) => {
                eprintln!("AI translation unavailable: {e}");
                available = false;
            }
        }
    }
    let rows = with_db(&s, move |c| Ok(tagalog_for(c, &u.id)?)).await?;
    Ok(Json(json!({ "available": available, "tagalog": rows })))
}

#[derive(Deserialize)]
struct TranslateTextBody {
    text: String,
}

/// An AI note lasts only as long as the suggestions it belongs to, so neither it nor its
/// translation is stored.
async fn translate_text(State(s): State<S>, _u: User, Json(b): Json<TranslateTextBody>) -> ApiResult<Json<Value>> {
    if b.text.chars().count() > 1000 {
        return Err(ApiError::bad("That text is too long."));
    }
    match ai::request_tagalog(&s.http, &s.config.ollama_url, &s.config.ollama_model, &b.text).await {
        Ok(text) => Ok(Json(json!({ "available": true, "text": text }))),
        Err(e) => {
            eprintln!("AI translation unavailable: {e}");
            Ok(Json(json!({ "available": false, "text": null })))
        }
    }
}

/// The user's wording replaces the AI's for every verse in that book or chapter, and later
/// AI runs leave it alone. Clearing it lets the AI write it again.
async fn save_scripture_context(State(s): State<S>, u: User, Json(b): Json<ScriptureContextBody>) -> ApiResult<Json<Value>> {
    if !valid_scope(&b.scope) {
        return Err(ApiError::bad("Unknown book or chapter."));
    }
    let text = b.context.trim().to_string();
    if text.chars().count() > 4000 {
        return Err(ApiError::bad("That text is too long."));
    }
    let rows = with_db(&s, move |c| {
        forget_stale_translation(c, &u.id, &b.scope, &text)?;
        if text.is_empty() {
            c.execute("DELETE FROM scripture_context WHERE user_id=?1 AND scope=?2", params![u.id, b.scope])?;
        } else {
            c.execute(
                "INSERT INTO scripture_context (user_id, scope, context, updated_at, reviewed_at) VALUES (?1,?2,?3,?4,?4)
                 ON CONFLICT (user_id, scope) DO UPDATE SET context=excluded.context, updated_at=excluded.updated_at, reviewed_at=excluded.reviewed_at",
                params![u.id, b.scope, text, now()],
            )?;
        }
        Ok(scripture_for(c, &u.id)?)
    })
    .await?;
    Ok(Json(Value::Object(rows)))
}

async fn ai_notes(State(s): State<S>, u: User, Json(b): Json<NotesBody>) -> ApiResult<Json<Value>> {
    let u_id = u.id.clone();
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
        return Ok(Json(json!({ "available": true, "notes": {}, "context": {}, "scripture": {} })));
    }
    match ai::request_notes(&s.http, &s.config.ollama_url, &s.config.ollama_model, &issue, &objective, &candidates).await {
        Ok(r) => {
            let saved = fill_speakers(&s, &u_id, &candidates).await?;
            let keys: Vec<String> = candidates.iter().map(|x| x.0.clone()).collect();
            let scripture = fill_scripture_context(&s, &u_id, &keys).await?;
            Ok(Json(json!({ "available": true, "notes": r.notes, "context": saved, "scripture": scripture, "model": r.model })))
        }
        Err(e) => {
            eprintln!("AI notes unavailable: {e}");
            Ok(Json(json!({ "available": false, "notes": {}, "context": {}, "scripture": {} })))
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
        forget_stale_translation(c, &u.id, &format!("speaker:{}", b.canonical_key), &speaker)?;
        forget_stale_translation(c, &u.id, &format!("note:{}", b.canonical_key), &context)?;
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

async fn status(State(s): State<S>, _u: User) -> ApiResult<Json<Value>> {
    let (last, sheet): (Option<String>, Option<String>) = with_db(&s, |c| {
        let setting = |key: &str| c.query_row("SELECT value FROM app_settings WHERE key=?1", [key], |r| r.get(0)).optional();
        Ok((setting("last_backup_at")?, setting(SHEET_SETTING)?))
    })
    .await?;
    Ok(Json(json!({ "last_backup_at": last, "has_saved_sheet": sheet.is_some() })))
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
    /// "tl" for Tagalog context, wherever a translation exists.
    #[serde(default)]
    context_language: String,
}

/// Verse text and context are read from the database here, so an export can only ever
/// contain what the vault holds.
async fn export_lecture(State(s): State<S>, u: User, Json(b): Json<ExportBody>) -> ApiResult<Response> {
    if b.title.trim().is_empty() {
        return Err(ApiError::bad("Give the lecture a title."));
    }
    let title = b.title.trim().to_string();
    let (doc_title, issue, objective) = (title.clone(), b.issue, b.objective);
    let tagalog = b.context_language == "tl";
    let items = with_db(&s, move |c| {
        let mut items = Vec::new();
        // The wording to show and whether the user reviewed that wording.
        let shown = |item: String, english: Option<(String, bool)>| -> rusqlite::Result<(String, bool)> {
            let translated: Option<(String, bool)> = if tagalog {
                c.query_row(
                    "SELECT text, reviewed_at IS NOT NULL FROM context_tagalog WHERE user_id=?1 AND item=?2",
                    params![u.id, item],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?
            } else {
                None
            };
            Ok(translated.or(english).filter(|x| !x.0.is_empty()).unwrap_or((String::new(), true)))
        };
        for (i, id) in b.verse_ids.iter().enumerate() {
            let row = c
                .query_row(
                    "SELECT v.ref_printed, v.version, v.text, COALESCE(x.speaker,''), COALESCE(x.context,''), x.canonical_key IS NULL OR x.reviewed_at IS NOT NULL, v.canonical_key
                     FROM verses v LEFT JOIN verse_context x ON x.user_id = v.user_id AND x.canonical_key = v.canonical_key
                     WHERE v.id=?1 AND v.user_id=?2",
                    params![id, u.id],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?, r.get::<_, bool>(5)?, r.get::<_, String>(6)?)),
                )
                .optional()?;
            let Some((reference, version, text, speaker, verse_note, verse_reviewed, key)) = row else {
                return Err(ApiError::bad("A selected verse no longer exists."));
            };
            let (book, rest) = key.split_once('.').unwrap_or((key.as_str(), ""));
            let chapter_number = rest.split(':').next().unwrap_or_default();
            let scope = |name: String| -> rusqlite::Result<Option<(String, bool)>> {
                c.query_row(
                    "SELECT context, reviewed_at IS NOT NULL FROM scripture_context WHERE user_id=?1 AND scope=?2",
                    params![u.id, name],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
            };
            let chapter_item = format!("chapter:{book}.{chapter_number}");
            let (book_item, history_item) = (format!("book:{book}"), format!("history:{book}"));
            let chapter = shown(chapter_item.clone(), scope(chapter_item)?)?;
            let whole_book = shown(book_item.clone(), scope(book_item)?)?;
            let history = shown(history_item.clone(), scope(history_item)?)?;
            let speaker = shown(format!("speaker:{key}"), Some((speaker, verse_reviewed)))?;
            let verse_note = shown(format!("note:{key}"), Some((verse_note, verse_reviewed)))?;
            let reviewed = [&chapter, &whole_book, &history, &speaker, &verse_note].iter().all(|x| x.1);
            items.push(export::Item {
                objective: b.verse_objectives.get(i).map_or(String::new(), |o| o.trim().to_string()),
                reference,
                version,
                text,
                speaker: speaker.0,
                verse_note: verse_note.0,
                chapter_context: chapter.0,
                book_context: whole_book.0,
                historical_context: history.0,
                reviewed,
                tagalog,
            });
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
    let count = with_db(&s, move |c| {
        let count = backup::restore(c, &state.vault, &u.id, &archive).map_err(ApiError::bad)?;
        // A backup made before lessons' parts were recorded has them read now.
        outline::backfill(c)?;
        Ok(count)
    })
    .await?;
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
        })?;
        c.execute("DELETE FROM app_settings WHERE key=?1", [SHEET_SETTING])?;
        Ok(())
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
        .route("/lessons/{id}/verses/{verse_id}", axum::routing::delete(remove_lesson_verse))
        .route("/search", get(search))
        .route("/search/meaning", get(search_meaning))
        .route("/status", get(status))
        .route("/lectures/export", post(export_lecture))
        .route("/folders", get(list_folders).post(create_folder))
        .route("/folders/{id}", axum::routing::delete(delete_folder))
        .route("/verses", get(list_verses))
        .route("/verses/import", post(import_verses).delete(remove_imported).layer(DefaultBodyLimit::max(MAX_WORKBOOK + 1024 * 1024)))
        .route("/verses/import/google", post(import_google_sheet))
        .route("/verses/import/rows", get(list_rows_to_fix))
        .route("/verses/import/rows/{id}", post(fix_row).delete(dismiss_row))
        .route("/verses/{id}", axum::routing::patch(correct_verse))
        .route("/verses/{id}/verify", post(verify_verse))
        .route("/verse-context", get(list_verse_context).post(save_verse_context))
        .route("/scripture-context", get(list_scripture_context).post(save_scripture_context))
        .route("/context-tagalog", get(list_context_tagalog).post(save_context_tagalog))
        .route("/ai/translate", post(translate_context))
        .route("/ai/translate-text", post(translate_text))
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

    #[test]
    fn deleting_a_lesson_keeps_imported_verses() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::init(&c).unwrap();
        c.execute_batch(
            "INSERT INTO users VALUES ('u','a@b.c','x','now');
             INSERT INTO verses (id,user_id,canonical_key,book_id,ref_printed,ref_en,ref_tl,version,language,text,text_sha256,ocr_raw,status,created_at,import_source)
             VALUES ('sheet','u','43.3:16',43,'r','r','r','ESV','en','t','h','raw','unverified','now','Sheet.xlsx, row 2'),
                    ('scan','u','43.3:17',43,'r','r','r','ESV','en','t','h','raw','unverified','now',''),
                    ('kept','u','43.3:18',43,'r','r','r','ESV','en','t','h','raw','verified','now','');",
        )
        .unwrap();
        assert_eq!(super::remove_uncited_scans(&c, "u").unwrap(), 1);
        let left: Vec<String> = c.prepare("SELECT id FROM verses ORDER BY id").unwrap().query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(left, ["kept", "sheet"], "only the scan no lesson cites goes");
    }
}

