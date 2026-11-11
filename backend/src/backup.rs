//! Backup, restore and reset for one user's data.
//!
//! A backup is the only copy that can leave this PC, so it is sealed with a passphrase
//! the user chooses: AES-256-GCM, with the key derived by Argon2id.

use crate::vault::Vault;
use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use argon2::Argon2;
use rusqlite::{types::ValueRef, Connection};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read, Write};
use zip::write::SimpleFileOptions;

const TABLES: &[&str] = &["folders", "lessons", "verses", "lesson_verses", "lesson_verse_comparisons", "lectures", "lecture_verses", "verse_context", "scripture_context", "context_tagalog", "import_rows_to_fix"];
const MAX_MANIFEST_BYTES: u64 = 256 * 1024 * 1024;
const MAX_PDF_BYTES: u64 = 128 * 1024 * 1024;

pub const MIN_PASSPHRASE_CHARS: usize = 12;
const BACKUP_MAGIC: &[u8] = b"LVBAK1\0";
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;

fn backup_cipher(passphrase: &str, salt: &[u8]) -> Result<Aes256Gcm, String> {
    let mut key = [0u8; 32];
    Argon2::default().hash_password_into(passphrase.as_bytes(), salt, &mut key).map_err(|_| "Could not derive the backup key.".to_string())?;
    Aes256Gcm::new_from_slice(&key).map_err(|_| "Could not derive the backup key.".to_string())
}

pub fn encrypt(archive: &[u8], passphrase: &str) -> Result<Vec<u8>, String> {
    let salt = Aes256Gcm::generate_key(&mut OsRng);
    let salt = &salt[..SALT_LEN];
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let body = backup_cipher(passphrase, salt)?.encrypt(&nonce, archive).map_err(|_| "Could not encrypt the backup.".to_string())?;
    let mut out = Vec::with_capacity(BACKUP_MAGIC.len() + SALT_LEN + NONCE_LEN + body.len());
    out.extend_from_slice(BACKUP_MAGIC);
    out.extend_from_slice(salt);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&body);
    Ok(out)
}

/// Opens an encrypted backup. Older unencrypted zip backups are still accepted, so
/// nothing already saved becomes unusable.
pub fn decrypt(file: &[u8], passphrase: &str) -> Result<Vec<u8>, String> {
    let Some(rest) = file.strip_prefix(BACKUP_MAGIC) else {
        return if file.starts_with(b"PK") { Ok(file.to_vec()) } else { Err("This file is not a valid backup archive.".into()) };
    };
    if rest.len() < SALT_LEN + NONCE_LEN {
        return Err("This backup is damaged.".into());
    }
    let (salt, rest) = rest.split_at(SALT_LEN);
    let (nonce, body) = rest.split_at(NONCE_LEN);
    backup_cipher(passphrase, salt)?
        .decrypt(Nonce::from_slice(nonce), body)
        .map_err(|_| "Wrong passphrase, or this backup is damaged.".to_string())
}

fn sha_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

fn dump_table(conn: &Connection, table: &str, user_id: &str) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = conn.prepare(&format!("SELECT * FROM {table} WHERE user_id = ?1"))?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let rows = stmt.query_map([user_id], |r| {
        let mut m = Map::new();
        for (i, name) in names.iter().enumerate() {
            if name == "seq" || name == "user_id" {
                continue;
            }
            let v = match r.get_ref(i)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => json!(n),
                ValueRef::Real(f) => json!(f),
                ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
                ValueRef::Blob(_) => Value::Null,
            };
            m.insert(name.clone(), v);
        }
        Ok(Value::Object(m))
    })?;
    rows.collect()
}

pub fn create(conn: &Connection, vault: &Vault, user_id: &str) -> Result<Vec<u8>, String> {
    let mut tables = Map::new();
    for t in TABLES {
        tables.insert((*t).to_string(), Value::Array(dump_table(conn, t, user_id).map_err(|e| e.to_string())?));
    }
    let manifest = json!({ "format": "lesson-vault-backup", "version": 1, "tables": tables });

    let mut buf = Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(&mut buf);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("manifest.json", opts).map_err(|e| e.to_string())?;
    zip.write_all(manifest.to_string().as_bytes()).map_err(|e| e.to_string())?;
    if let Some(lessons) = manifest.pointer("/tables/lessons").and_then(|l| l.as_array()) {
        for l in lessons {
            let id = l["id"].as_str().unwrap_or_default();
            let bytes = vault.read_pdf(id)?;
            zip.start_file(format!("files/{id}.pdf"), opts).map_err(|e| e.to_string())?;
            zip.write_all(&bytes).map_err(|e| e.to_string())?;
        }
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(buf.into_inner())
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn read_limited(entry: impl Read, limit: u64) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    entry.take(limit + 1).read_to_end(&mut out).map_err(|e| e.to_string())?;
    if out.len() as u64 > limit {
        return Err("Backup contains an entry that is too large.".into());
    }
    Ok(out)
}

/// Removes every row and file owned by the user.
pub fn wipe(conn: &mut Connection, vault: &Vault, user_id: &str) -> Result<(), String> {
    let ids: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM lessons WHERE user_id = ?1").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([user_id], |r| r.get(0)).map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for t in TABLES.iter().rev() {
        tx.execute(&format!("DELETE FROM {t} WHERE user_id = ?1"), [user_id]).map_err(|e| e.to_string())?;
    }
    tx.execute("DELETE FROM ai_prompts_log WHERE user_id = ?1", [user_id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    for id in ids {
        vault.remove_pdf(&id);
    }
    Ok(())
}

/// Validates the entire archive before changing anything. Scripture hashes and
/// PDF hashes must match, so a tampered backup is rejected rather than imported.
pub fn restore(conn: &mut Connection, vault: &Vault, user_id: &str, archive: &[u8]) -> Result<usize, String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(archive)).map_err(|_| "This file is not a valid backup archive.".to_string())?;
    let manifest: Value = {
        let entry = zip.by_name("manifest.json").map_err(|_| "Backup has no manifest.".to_string())?;
        serde_json::from_slice(&read_limited(entry, MAX_MANIFEST_BYTES)?).map_err(|_| "Backup manifest is corrupt.".to_string())?
    };
    if manifest["format"] != "lesson-vault-backup" || manifest["version"] != 1 {
        return Err("Unsupported backup format.".into());
    }
    let empty = vec![];
    let lessons = manifest.pointer("/tables/lessons").and_then(|l| l.as_array()).unwrap_or(&empty);

    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    for l in lessons {
        let id = l["id"].as_str().unwrap_or_default();
        if !is_uuid(id) {
            return Err("Backup contains an invalid lesson id.".into());
        }
        let entry = zip.by_name(&format!("files/{id}.pdf")).map_err(|_| format!("Backup is missing the document for lesson {id}."))?;
        let bytes = read_limited(entry, MAX_PDF_BYTES)?;
        if sha_hex(&bytes) != l["sha256"].as_str().unwrap_or_default() {
            return Err(format!("Document checksum mismatch for lesson {id}; backup rejected."));
        }
        files.push((id.to_string(), bytes));
    }
    let verses = manifest.pointer("/tables/verses").and_then(|l| l.as_array()).unwrap_or(&empty);
    for v in verses {
        if sha_hex(v["text"].as_str().unwrap_or_default().as_bytes()) != v["text_sha256"].as_str().unwrap_or_default() {
            return Err("Scripture checksum mismatch; backup rejected to protect official text.".into());
        }
    }

    // Only columns that exist in the schema are accepted, keeping names out of user control.
    let columns = |c: &Connection, t: &str| -> Result<Vec<String>, String> {
        let mut stmt = c.prepare(&format!("PRAGMA table_info({t})")).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(1)).map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    };

    let old_ids: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM lessons WHERE user_id = ?1").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([user_id], |r| r.get(0)).map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for t in TABLES.iter().rev() {
        tx.execute(&format!("DELETE FROM {t} WHERE user_id = ?1"), [user_id]).map_err(|e| e.to_string())?;
    }
    for t in TABLES {
        let allowed = columns(&tx, t)?;
        let rows = manifest.pointer(&format!("/tables/{t}")).and_then(|r| r.as_array()).unwrap_or(&empty);
        for row in rows {
            let Some(obj) = row.as_object() else { return Err("Backup row is malformed.".into()) };
            let mut names = vec!["user_id".to_string()];
            let mut values: Vec<rusqlite::types::Value> = vec![rusqlite::types::Value::Text(user_id.to_string())];
            for col in &allowed {
                if col == "user_id" || col == "seq" {
                    continue;
                }
                if let Some(v) = obj.get(col) {
                    names.push(col.clone());
                    values.push(match v {
                        Value::Null => rusqlite::types::Value::Null,
                        Value::Number(n) => rusqlite::types::Value::Integer(n.as_i64().unwrap_or(0)),
                        Value::String(s) => rusqlite::types::Value::Text(s.clone()),
                        _ => return Err("Backup row has an unsupported value.".into()),
                    });
                }
            }
            let marks = vec!["?"; names.len()].join(",");
            let sql = format!("INSERT INTO {t} ({}) VALUES ({marks})", names.join(","));
            tx.execute(&sql, rusqlite::params_from_iter(values)).map_err(|e| {
                if e.to_string().contains("UNIQUE") {
                    "This backup belongs to another account on this server and cannot be restored here.".to_string()
                } else {
                    format!("Could not restore backup: {e}")
                }
            })?;
        }
    }
    if lessons.iter().any(|l| l.get("local_congregation").is_none() || l.get("district").is_none()) {
        crate::db::backfill_pastoral_metadata(&tx).map_err(|e| e.to_string())?;
    }
    for (id, bytes) in &files {
        vault.write_pdf(id, bytes)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    let kept: std::collections::HashSet<&str> = files.iter().map(|(id, _)| id.as_str()).collect();
    for id in old_ids.iter().filter(|i| !kept.contains(i.as_str())) {
        vault.remove_pdf(id);
    }
    Ok(files.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASS: &str = "a long enough passphrase";

    #[test]
    fn a_backup_reveals_nothing_and_needs_the_passphrase() {
        let sealed = encrypt(b"PK secret zephyrword lesson", PASS).unwrap();
        assert!(!sealed.windows(10).any(|w| w == b"zephyrword"));
        assert_eq!(decrypt(&sealed, PASS).unwrap(), b"PK secret zephyrword lesson");
        assert!(decrypt(&sealed, "a different passphrase").unwrap_err().contains("Wrong passphrase"));
    }

    #[test]
    fn a_changed_backup_is_rejected() {
        let mut sealed = encrypt(b"PK contents", PASS).unwrap();
        *sealed.last_mut().unwrap() ^= 1;
        assert!(decrypt(&sealed, PASS).is_err());
    }

    #[test]
    fn older_unencrypted_backups_still_open_and_junk_does_not() {
        assert_eq!(decrypt(b"PK old zip", "").unwrap(), b"PK old zip");
        assert!(decrypt(b"not a backup", "").unwrap_err().contains("not a valid backup"));
    }
}
