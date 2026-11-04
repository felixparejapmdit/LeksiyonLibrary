//! SQLite schema. Scripture immutability is enforced here with triggers, so it
//! holds regardless of which code path attempts a write.

use rusqlite::{Connection, OptionalExtension};

pub const SCHEMA: &str = r#"
PRAGMA temp_store = MEMORY;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS lessons (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('midweek','weekend','pastoral')),
  language TEXT NOT NULL CHECK (language IN ('en','tl')),
  lesson_date TEXT,
  date_label TEXT NOT NULL DEFAULT '',
  year INTEGER,
  location TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  page_count INTEGER NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('text','ocr')),
  content TEXT NOT NULL,
  issue TEXT NOT NULL DEFAULT '',
  objectives TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE (user_id, sha256)
);
CREATE INDEX IF NOT EXISTS lessons_user ON lessons(user_id);

CREATE TABLE IF NOT EXISTS verses (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  canonical_key TEXT NOT NULL,
  book_id INTEGER NOT NULL,
  ref_printed TEXT NOT NULL,
  ref_en TEXT NOT NULL,
  ref_tl TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL CHECK (language IN ('en','tl')),
  text TEXT NOT NULL,
  text_sha256 TEXT NOT NULL,
  ocr_raw TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unverified','verified')),
  ref_note TEXT NOT NULL DEFAULT '',
  verified_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, canonical_key, version, language, ocr_raw)
);
CREATE INDEX IF NOT EXISTS verses_user ON verses(user_id, canonical_key);

CREATE TABLE IF NOT EXISTS lesson_verses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  verse_id TEXT NOT NULL REFERENCES verses(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  ordinal INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lesson_verses_lesson ON lesson_verses(lesson_id);
CREATE INDEX IF NOT EXISTS lesson_verses_verse ON lesson_verses(verse_id);

CREATE TABLE IF NOT EXISTS lectures (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  issue TEXT NOT NULL DEFAULT '',
  objective TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lecture_verses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lecture_id TEXT NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  verse_id TEXT NOT NULL REFERENCES verses(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_prompts_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  input_issue TEXT NOT NULL,
  input_objective TEXT NOT NULL,
  suggested_verse_ids TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  timestamp TEXT NOT NULL
);

-- The AI's reading of a verse. Deliberately separate from the verses table, so it can
-- never touch scripture text.
CREATE TABLE IF NOT EXISTS verse_context (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  canonical_key TEXT NOT NULL,
  speaker TEXT NOT NULL DEFAULT '',
  context TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, canonical_key)
);

-- Full-text indexes
CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts USING fts5(title, content, issue, objectives, tokenize = 'unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE IF NOT EXISTS verses_fts USING fts5(text, ref_en, ref_tl, version, tokenize = 'unicode61 remove_diacritics 2');

CREATE TRIGGER IF NOT EXISTS lessons_fts_ai AFTER INSERT ON lessons BEGIN
  INSERT INTO lessons_fts(rowid, title, content, issue, objectives) VALUES (new.seq, new.title, new.content, new.issue, new.objectives);
END;
CREATE TRIGGER IF NOT EXISTS lessons_fts_ad AFTER DELETE ON lessons BEGIN
  DELETE FROM lessons_fts WHERE rowid = old.seq;
END;
CREATE TRIGGER IF NOT EXISTS lessons_fts_au AFTER UPDATE OF title ON lessons BEGIN
  UPDATE lessons_fts SET title = new.title WHERE rowid = new.seq;
END;
CREATE TRIGGER IF NOT EXISTS lessons_fts_summary_au AFTER UPDATE OF issue, objectives ON lessons BEGIN
  UPDATE lessons_fts SET issue = new.issue, objectives = new.objectives WHERE rowid = new.seq;
END;
CREATE TRIGGER IF NOT EXISTS verses_fts_ai AFTER INSERT ON verses BEGIN
  INSERT INTO verses_fts(rowid, text, ref_en, ref_tl, version) VALUES (new.seq, new.text, new.ref_en, new.ref_tl, new.version);
END;
CREATE TRIGGER IF NOT EXISTS verses_fts_ad AFTER DELETE ON verses BEGIN
  DELETE FROM verses_fts WHERE rowid = old.seq;
END;
CREATE TRIGGER IF NOT EXISTS verses_fts_au AFTER UPDATE OF text, ref_en, ref_tl ON verses BEGIN
  UPDATE verses_fts SET text = new.text, ref_en = new.ref_en, ref_tl = new.ref_tl WHERE rowid = new.seq;
END;

-- Zero-Modification Policy
CREATE TRIGGER IF NOT EXISTS verses_verified_text_locked BEFORE UPDATE OF text, text_sha256, version, canonical_key, book_id, ref_printed, ref_en, ref_tl, language ON verses
WHEN OLD.status = 'verified'
BEGIN
  SELECT RAISE(ABORT, 'verified scripture text is immutable');
END;
CREATE TRIGGER IF NOT EXISTS verses_ocr_raw_locked BEFORE UPDATE OF ocr_raw ON verses
BEGIN
  SELECT RAISE(ABORT, 'original extracted text is immutable');
END;
CREATE TRIGGER IF NOT EXISTS verses_status_one_way BEFORE UPDATE OF status ON verses
WHEN OLD.status = 'verified' AND NEW.status <> 'verified'
BEGIN
  SELECT RAISE(ABORT, 'verification cannot be revoked');
END;
"#;

/// The single owner of this vault. An existing vault keeps its earliest account, so
/// everything already saved stays visible; a new vault gets a local placeholder.
pub fn local_owner(conn: &Connection) -> rusqlite::Result<String> {
    let existing = conn.query_row("SELECT id FROM users ORDER BY created_at, id LIMIT 1", [], |r| r.get(0)).optional()?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    conn.execute("INSERT INTO users VALUES (?1, 'owner@lesson-vault.invalid', '', ?2)", [&id, &now])?;
    Ok(id)
}


#[cfg(test)]
mod tests {
    use super::*;

    fn seed() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c.execute_batch(
            "INSERT INTO users VALUES ('u','a@b.c','x','now');
             INSERT INTO verses (id,user_id,canonical_key,book_id,ref_printed,ref_en,ref_tl,version,language,text,text_sha256,ocr_raw,status,created_at)
             VALUES ('v','u','10.7:24',10,'II Sam. 7:24','II Samuel 7:24','II Samuel 7:24','ESV','en','original','h','raw','unverified','now');",
        )
        .unwrap();
        c
    }

    #[test]
    fn edited_issue_and_objectives_are_searchable() {
        let c = seed();
        c.execute(
            "INSERT INTO lessons (id,user_id,title,category,language,file_name,sha256,byte_size,page_count,source_kind,content,issue,objectives,created_at)
             VALUES ('l','u','T','weekend','en','f','s',1,1,'text','body','old words','[]','now')",
            [],
        )
        .unwrap();
        c.execute("UPDATE lessons SET issue='zephyr', objectives='[\"quasar\"]' WHERE id='l'", []).unwrap();
        let hits = |q: &str| -> i64 { c.query_row("SELECT count(*) FROM lessons_fts WHERE lessons_fts MATCH ?1", [q], |r| r.get(0)).unwrap() };
        assert_eq!(hits("zephyr"), 1);
        assert_eq!(hits("quasar"), 1);
        assert_eq!(hits("old"), 0);
    }

    #[test]
    fn the_owner_is_the_existing_account_or_a_new_placeholder() {
        let existing = seed();
        assert_eq!(local_owner(&existing).unwrap(), "u");

        let fresh = Connection::open_in_memory().unwrap();
        fresh.execute_batch(SCHEMA).unwrap();
        let first = local_owner(&fresh).unwrap();
        assert_eq!(local_owner(&fresh).unwrap(), first);
    }

    #[test]
    fn unverified_text_can_be_corrected_but_raw_cannot() {
        let c = seed();
        c.execute("UPDATE verses SET text='fixed' WHERE id='v'", []).unwrap();
        assert!(c.execute("UPDATE verses SET ocr_raw='changed' WHERE id='v'", []).is_err());
    }

    #[test]
    fn verified_text_is_immutable_at_database_level() {
        let c = seed();
        c.execute("UPDATE verses SET status='verified' WHERE id='v'", []).unwrap();
        let err = c.execute("UPDATE verses SET text='tampered' WHERE id='v'", []).unwrap_err();
        assert!(err.to_string().contains("immutable"));
        assert!(c.execute("UPDATE verses SET version='KJV' WHERE id='v'", []).is_err());
        assert!(c.execute("UPDATE verses SET status='unverified' WHERE id='v'", []).is_err());
        let t: String = c.query_row("SELECT text FROM verses WHERE id='v'", [], |r| r.get(0)).unwrap();
        assert_eq!(t, "original");
    }
}
