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
  needs_check INTEGER NOT NULL DEFAULT 0,
  outline TEXT NOT NULL DEFAULT '',
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
  import_source TEXT NOT NULL DEFAULT '',
  UNIQUE (user_id, canonical_key, version, language, ocr_raw)
);
CREATE INDEX IF NOT EXISTS verses_user ON verses(user_id, canonical_key);

CREATE TABLE IF NOT EXISTS lesson_verses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  verse_id TEXT NOT NULL REFERENCES verses(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  section INTEGER NOT NULL DEFAULT -1,
  question TEXT NOT NULL DEFAULT ''
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
  ordinal INTEGER NOT NULL,
  objective TEXT NOT NULL DEFAULT ''
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
  reviewed_at TEXT,
  PRIMARY KEY (user_id, canonical_key)
);

-- Background on a whole book or chapter, kept once and shared by all its verses.
-- scope is 'book:60', 'history:60' or 'chapter:60.2'.
CREATE TABLE IF NOT EXISTS scripture_context (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  context TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  reviewed_at TEXT,
  PRIMARY KEY (user_id, scope)
);

-- Tagalog wording of a context. item is a scope above, or 'speaker:<key>' or 'note:<key>'.
-- Reviewed separately: an AI translation of text the user reviewed is still the AI's.
CREATE TABLE IF NOT EXISTS context_tagalog (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item TEXT NOT NULL,
  text TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  reviewed_at TEXT,
  PRIMARY KEY (user_id, item)
);

-- Numbers that represent each verse's meaning. Rebuildable, so not part of backups.
CREATE TABLE IF NOT EXISTS verse_embeddings (
  verse_id TEXT PRIMARY KEY REFERENCES verses(id) ON DELETE CASCADE,
  text_sha TEXT NOT NULL,
  model TEXT NOT NULL,
  vector BLOB NOT NULL
);

-- Rows an import left out, kept whole so the user can fix them here. Removed once fixed.
CREATE TABLE IF NOT EXISTS import_rows_to_fix (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  row_number INTEGER NOT NULL,
  translation TEXT NOT NULL DEFAULT '',
  book TEXT NOT NULL DEFAULT '',
  chapter TEXT NOT NULL DEFAULT '',
  verse TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
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

/// Creates missing tables, and adds columns that older vaults do not have yet.
pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(SCHEMA)?;
    for (table, column, definition) in [
        ("lecture_verses", "objective", "TEXT NOT NULL DEFAULT ''"),
        ("verse_context", "reviewed_at", "TEXT"),
        ("verses", "import_source", "TEXT NOT NULL DEFAULT ''"),
        // Lessons already in a vault were added before this check existed, so they start as checked.
        ("lessons", "needs_check", "INTEGER NOT NULL DEFAULT 0"),
        // Empty until the lesson's parts are read; see outline::backfill.
        ("lessons", "outline", "TEXT NOT NULL DEFAULT ''"),
        ("lesson_verses", "section", "INTEGER NOT NULL DEFAULT -1"),
        ("lesson_verses", "question", "TEXT NOT NULL DEFAULT ''"),
    ] {
        let present: bool = conn.query_row(&format!("SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1)"), [column], |r| r.get(0))?;
        if !present {
            conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition};"))?;
        }
    }
    // Verse-level context from the AI gave way to chapter and book context. Anything the
    // user reviewed or wrote is theirs, and stays.
    conn.execute("UPDATE verse_context SET context = '' WHERE reviewed_at IS NULL AND context <> ''", [])?;
    // Teaching history was removed from the app.
    conn.execute_batch("DROP TABLE IF EXISTS teachings;")?;
    // Importing from Google Sheets was removed: the spreadsheet it remembered is forgotten.
    conn.execute("DELETE FROM app_settings WHERE key='import_sheet_id'", [])?;
    crate::verse_import::repair_leading_numbers(conn)?;
    crate::outline::backfill(conn)?;
    Ok(())
}

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
    fn older_vaults_gain_the_new_columns_without_losing_data() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE lecture_verses (id TEXT PRIMARY KEY, user_id TEXT, lecture_id TEXT, verse_id TEXT, ordinal INTEGER);
                         INSERT INTO lecture_verses VALUES ('a','u','l','v',0);
                         CREATE TABLE verse_context (user_id TEXT, canonical_key TEXT, speaker TEXT, context TEXT, model TEXT, updated_at TEXT);").unwrap();
        init(&c).unwrap();
        init(&c).unwrap();
        let objective: String = c.query_row("SELECT objective FROM lecture_verses WHERE id='a'", [], |r| r.get(0)).unwrap();
        assert_eq!(objective, "");
        c.query_row("SELECT reviewed_at FROM verse_context", [], |_| Ok(())).unwrap_err();
        c.execute("INSERT INTO verse_context (user_id,canonical_key,speaker,context,model,updated_at,reviewed_at) VALUES ('u','k','','','','now','now')", []).unwrap();
    }

    #[test]
    fn lessons_in_an_older_vault_start_as_checked() {
        let c = Connection::open_in_memory().unwrap();
        let old = SCHEMA.replace("\r\n", "\n").replace("  needs_check INTEGER NOT NULL DEFAULT 0,\n", "");
        assert_ne!(old, SCHEMA.replace("\r\n", "\n"), "the column was taken out");
        c.execute_batch(&old).unwrap();
        c.execute_batch(
            "INSERT INTO users VALUES ('u','a@b.c','x','now');
             INSERT INTO lessons (id,user_id,title,category,language,file_name,sha256,byte_size,page_count,source_kind,content,created_at)
             VALUES ('l','u','T','weekend','en','f','s',1,1,'text','body','now');",
        )
        .unwrap();
        init(&c).unwrap();
        let needs: i64 = c.query_row("SELECT needs_check FROM lessons WHERE id='l'", [], |r| r.get(0)).unwrap();
        assert_eq!(needs, 0);
    }

    #[test]
    fn older_vaults_gain_the_import_column_and_keep_their_verses() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(&SCHEMA.replace("\r\n", "\n").replace("  import_source TEXT NOT NULL DEFAULT '',\n", "")).unwrap();
        c.execute_batch(
            "INSERT INTO users VALUES ('u','a@b.c','x','now');
             INSERT INTO verses (id,user_id,canonical_key,book_id,ref_printed,ref_en,ref_tl,version,language,text,text_sha256,ocr_raw,status,created_at)
             VALUES ('v','u','10.7:24',10,'r','r','r','ESV','en','kept','h','raw','unverified','now');",
        )
        .unwrap();
        init(&c).unwrap();
        init(&c).unwrap();
        let (text, source): (String, String) = c.query_row("SELECT text, import_source FROM verses", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((text.as_str(), source.as_str()), ("kept", ""));
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
