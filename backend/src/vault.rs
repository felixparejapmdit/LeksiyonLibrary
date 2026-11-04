//! Encryption at rest. Everything saved to disk goes through this module.
//!
//! - The database and PDFs are sealed with AES-256-GCM, so reading them needs the key
//!   and any change to the file is detected.
//! - The key is random and stored wrapped by Windows DPAPI, which ties it to this
//!   Windows account on this PC. Copying the data folder elsewhere yields nothing.
//! - SQLite runs in memory and is saved as a sealed snapshot, so no plaintext database,
//!   journal or temporary file ever reaches the disk.
//!
//! Losing the key file, the Windows profile or the PC makes this data unreadable by
//! design. Passphrase-protected backups (see `backup.rs`) are the way to recover.

use crate::db;
use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng, Payload},
    Aes256Gcm, Nonce,
};
use rusqlite::Connection;
use std::io::Write;
use std::path::{Path, PathBuf};

const MAGIC: &[u8] = b"LVENC1\0";
const NONCE_LEN: usize = 12;
const KEY_FILE: &str = "vault.key";
const DB_FILE: &str = "vault.db.enc";
const DB_PREVIOUS: &str = "vault.db.enc.previous";
const DB_AAD: &[u8] = b"lesson-vault:database";
const LEGACY_DB: &str = "lesson-vault.sqlite3";
const LEGACY_TABLES: &[&str] = &["users", "folders", "lessons", "verses", "lesson_verses", "lectures", "lecture_verses", "ai_prompts_log"];

pub struct Vault {
    dir: PathBuf,
    cipher: Aes256Gcm,
}

fn seal(cipher: &Aes256Gcm, aad: &[u8], plain: &[u8]) -> Result<Vec<u8>, String> {
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let body = cipher.encrypt(&nonce, Payload { msg: plain, aad }).map_err(|_| "encryption failed".to_string())?;
    let mut out = Vec::with_capacity(MAGIC.len() + NONCE_LEN + body.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&body);
    Ok(out)
}

fn unseal(cipher: &Aes256Gcm, aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>, String> {
    let rest = sealed.strip_prefix(MAGIC).ok_or("not an encrypted Lesson Vault file")?;
    if rest.len() < NONCE_LEN {
        return Err("the encrypted file is damaged".into());
    }
    let (nonce, body) = rest.split_at(NONCE_LEN);
    cipher
        .decrypt(Nonce::from_slice(nonce), Payload { msg: body, aad })
        .map_err(|_| "the encrypted file is damaged or was changed".to_string())
}

/// Writes through a temporary file and renames it, so a crash leaves the old file whole.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    // Antivirus can hold a new file open for a moment on Windows.
    let mut attempt = 0;
    loop {
        match std::fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(_) if attempt < 5 => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => return Err(e),
        }
    }
}

/// Best effort: on an SSD the old blocks may survive until the drive reuses them.
fn wipe_file(path: &Path) -> std::io::Result<()> {
    if let Ok(meta) = std::fs::metadata(path) {
        if let Ok(mut file) = std::fs::OpenOptions::new().write(true).open(path) {
            let _ = file.write_all(&vec![0u8; meta.len() as usize]);
            let _ = file.sync_all();
        }
        std::fs::remove_file(path)?;
    }
    Ok(())
}

impl Vault {
    /// Opens the vault in `dir`, creating a key only if there is no encrypted data yet.
    /// An existing vault with a missing key is refused: a new key would orphan the data.
    pub fn open(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir.join("files")).map_err(|e| format!("cannot create the data folder: {e}"))?;
        let key_path = dir.join(KEY_FILE);
        let key: Vec<u8> = if key_path.exists() {
            let wrapped = std::fs::read(&key_path).map_err(|e| format!("cannot read the vault key: {e}"))?;
            dpapi::unprotect(&wrapped).map_err(|_| {
                "This vault can only be opened by the Windows account and PC that created it. On another PC, restore a passphrase-protected backup instead.".to_string()
            })?
        } else if Self::has_encrypted_data(dir) {
            return Err("The vault key file (vault.key) is missing, so this data cannot be opened. Restore it, or start with an empty data folder and restore a passphrase-protected backup.".into());
        } else {
            let fresh = Aes256Gcm::generate_key(&mut OsRng).to_vec();
            let wrapped = dpapi::protect(&fresh)?;
            write_atomic(&key_path, &wrapped).map_err(|e| format!("cannot save the vault key: {e}"))?;
            fresh
        };
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "the vault key is invalid".to_string())?;
        Ok(Self { dir: dir.to_path_buf(), cipher })
    }

    fn has_encrypted_data(dir: &Path) -> bool {
        dir.join(DB_FILE).exists()
            || dir.join(DB_PREVIOUS).exists()
            || std::fs::read_dir(dir.join("files")).is_ok_and(|mut files| files.any(|f| f.is_ok_and(|f| f.file_name().to_string_lossy().ends_with(".enc"))))
    }

    fn pdf_path(&self, id: &str) -> PathBuf {
        self.dir.join("files").join(format!("{id}.pdf.enc"))
    }

    pub fn write_pdf(&self, id: &str, plain: &[u8]) -> Result<(), String> {
        let sealed = seal(&self.cipher, format!("lesson-vault:pdf:{id}").as_bytes(), plain)?;
        write_atomic(&self.pdf_path(id), &sealed).map_err(|e| e.to_string())
    }

    pub fn read_pdf(&self, id: &str) -> Result<Vec<u8>, String> {
        let sealed = std::fs::read(self.pdf_path(id)).map_err(|e| e.to_string())?;
        unseal(&self.cipher, format!("lesson-vault:pdf:{id}").as_bytes(), &sealed)
    }

    pub fn remove_pdf(&self, id: &str) {
        let _ = std::fs::remove_file(self.pdf_path(id));
    }

    /// Seals the whole database. The previous save is kept, also sealed, in case the
    /// drive damages the newest one.
    pub fn save_db(&self, conn: &Connection) -> Result<(), String> {
        let image = conn.serialize("main").map_err(|e| e.to_string())?;
        let sealed = seal(&self.cipher, DB_AAD, &image)?;
        let current = self.dir.join(DB_FILE);
        let tmp = self.dir.join("vault.db.new");
        write_atomic(&tmp, &sealed).map_err(|e| e.to_string())?;
        if current.exists() {
            std::fs::rename(&current, self.dir.join(DB_PREVIOUS)).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, &current).map_err(|e| e.to_string())
    }

    fn read_db_file(&self, path: &Path) -> Result<Connection, String> {
        let sealed = std::fs::read(path).map_err(|e| e.to_string())?;
        let image = unseal(&self.cipher, DB_AAD, &sealed)?;
        Self::from_image(&image)
    }

    fn from_image(image: &[u8]) -> Result<Connection, String> {
        let mut conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        conn.deserialize_read_exact("main", image, image.len(), false).map_err(|e| e.to_string())?;
        let check: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).map_err(|e| e.to_string())?;
        if check != "ok" {
            return Err(format!("the database failed its integrity check: {check}"));
        }
        Ok(conn)
    }

    /// Loads the database, first encrypting any data left from before encryption existed.
    pub fn load_database(&self) -> Result<Connection, String> {
        let current = self.dir.join(DB_FILE);
        let previous = self.dir.join(DB_PREVIOUS);
        let legacy = self.dir.join(LEGACY_DB);
        let conn = if current.exists() {
            match self.read_db_file(&current) {
                Ok(c) => c,
                Err(e) if previous.exists() => {
                    eprintln!("The newest database save could not be read ({e}); using the previous save.");
                    self.read_db_file(&previous)?
                }
                Err(e) => return Err(e),
            }
        } else if previous.exists() {
            self.read_db_file(&previous)?
        } else if legacy.exists() {
            self.import_legacy_db(&legacy)?
        } else {
            Connection::open_in_memory().map_err(|e| e.to_string())?
        };
        db::init(&conn).map_err(|e| e.to_string())?;
        self.save_db(&conn)?;
        self.encrypt_legacy_pdfs()?;
        for name in [LEGACY_DB, "lesson-vault.sqlite3-wal", "lesson-vault.sqlite3-shm"] {
            wipe_file(&self.dir.join(name)).map_err(|e| format!("could not remove the old unencrypted {name}: {e}"))?;
        }
        Ok(conn)
    }

    /// The plaintext file is only removed by the caller, after this copy reads back identical.
    fn import_legacy_db(&self, legacy: &Path) -> Result<Connection, String> {
        println!("Encrypting your existing database. This happens once.");
        let old = Connection::open(legacy).map_err(|e| e.to_string())?;
        old.execute_batch("PRAGMA journal_mode = DELETE;").map_err(|e| e.to_string())?;
        let image = old.serialize("main").map_err(|e| e.to_string())?.to_vec();
        let copy = Self::from_image(&image)?;
        self.save_db(&copy)?;
        let reread = self.read_db_file(&self.dir.join(DB_FILE))?;
        for table in LEGACY_TABLES {
            let count = |c: &Connection| -> Result<i64, String> { c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0)).map_err(|e| e.to_string()) };
            let (before, after) = (count(&old)?, count(&reread)?);
            if before != after {
                let _ = std::fs::remove_file(self.dir.join(DB_FILE));
                return Err(format!("encrypting the database failed a check on {table} ({before} rows became {after}); nothing was removed"));
            }
        }
        Ok(reread)
    }

    fn encrypt_legacy_pdfs(&self) -> Result<(), String> {
        let files = self.dir.join("files");
        let entries = std::fs::read_dir(&files).map_err(|e| e.to_string())?;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(id) = name.strip_suffix(".pdf") else { continue };
            let plain = std::fs::read(entry.path()).map_err(|e| e.to_string())?;
            self.write_pdf(id, &plain)?;
            if self.read_pdf(id)? != plain {
                return Err(format!("encrypting {name} failed its check; the original was kept"));
            }
            wipe_file(&entry.path()).map_err(|e| format!("could not remove the old unencrypted {name}: {e}"))?;
        }
        Ok(())
    }
}

/// Windows Data Protection: only this Windows account on this PC can unwrap the key.
#[cfg(windows)]
mod dpapi {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};

    fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 }
    }

    fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        // SAFETY: on success Windows returned a buffer of cbData bytes for us to free.
        unsafe {
            let copy = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            LocalFree(out.pbData as _);
            copy
        }
    }

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
        let input = blob(plain);
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        // SAFETY: both blobs are valid for the call; optional arguments may be null.
        let ok = unsafe { CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) };
        if ok == 0 {
            return Err("Windows could not protect the vault key.".into());
        }
        Ok(take(out))
    }

    pub fn unprotect(wrapped: &[u8]) -> Result<Vec<u8>, String> {
        let input = blob(wrapped);
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        // SAFETY: as above.
        let ok = unsafe { CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) };
        if ok == 0 {
            return Err("Windows could not unlock the vault key.".into());
        }
        Ok(take(out))
    }
}

/// Without an operating-system key store, refusing to run is safer than storing the key
/// beside the data it protects.
#[cfg(not(windows))]
mod dpapi {
    const UNSUPPORTED: &str = "Lesson Vault's encryption currently needs Windows, which protects its key.";
    pub fn protect(_: &[u8]) -> Result<Vec<u8>, String> {
        Err(UNSUPPORTED.into())
    }
    pub fn unprotect(_: &[u8]) -> Result<Vec<u8>, String> {
        Err(UNSUPPORTED.into())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    const PDF: &[u8] = b"%PDF-1.4 a secret zephyrword lesson";

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lv-vault-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("files")).unwrap();
        dir
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    fn all_bytes(dir: &Path) -> Vec<u8> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            if entry.path().is_dir() {
                out.extend(all_bytes(&entry.path()));
            } else {
                out.extend(std::fs::read(entry.path()).unwrap());
            }
        }
        out
    }

    fn seeded(conn: &Connection) {
        conn.execute("INSERT INTO users VALUES ('u','zephyrword@b.c','','now')", []).unwrap();
    }

    #[test]
    fn nothing_readable_reaches_the_disk() {
        let dir = temp_dir();
        let vault = Vault::open(&dir).unwrap();
        let conn = vault.load_database().unwrap();
        seeded(&conn);
        vault.save_db(&conn).unwrap();
        vault.write_pdf("a", PDF).unwrap();

        let bytes = all_bytes(&dir);
        assert!(!contains(&bytes, b"zephyrword"));
        assert!(!contains(&bytes, b"%PDF"));
        assert!(!contains(&bytes, b"SQLite format 3"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn data_survives_a_restart() {
        let dir = temp_dir();
        let vault = Vault::open(&dir).unwrap();
        let conn = vault.load_database().unwrap();
        seeded(&conn);
        vault.save_db(&conn).unwrap();
        vault.write_pdf("a", PDF).unwrap();
        drop((conn, vault));

        let vault = Vault::open(&dir).unwrap();
        let conn = vault.load_database().unwrap();
        let email: String = conn.query_row("SELECT email FROM users", [], |r| r.get(0)).unwrap();
        assert_eq!(email, "zephyrword@b.c");
        assert_eq!(vault.read_pdf("a").unwrap(), PDF);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_changed_or_swapped_file_is_rejected() {
        let dir = temp_dir();
        let vault = Vault::open(&dir).unwrap();
        vault.write_pdf("a", PDF).unwrap();
        vault.write_pdf("b", b"%PDF other").unwrap();

        std::fs::copy(vault.pdf_path("b"), vault.pdf_path("a")).unwrap();
        assert!(vault.read_pdf("a").is_err(), "one lesson's file must not open as another's");

        let mut bytes = std::fs::read(vault.pdf_path("b")).unwrap();
        *bytes.last_mut().unwrap() ^= 1;
        std::fs::write(vault.pdf_path("b"), bytes).unwrap();
        assert!(vault.read_pdf("b").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_data_is_useless_without_this_pcs_key() {
        let dir = temp_dir();
        let vault = Vault::open(&dir).unwrap();
        let conn = vault.load_database().unwrap();
        vault.save_db(&conn).unwrap();
        drop((conn, vault));

        // A key wrapped for someone else cannot be unwrapped here.
        std::fs::write(dir.join(KEY_FILE), b"not a key this account can unwrap").unwrap();
        assert!(Vault::open(&dir).err().unwrap().contains("Windows account"));

        // A missing key must never quietly become a new key and orphan the data.
        std::fs::remove_file(dir.join(KEY_FILE)).unwrap();
        assert!(Vault::open(&dir).err().unwrap().contains("missing"));
        assert!(!dir.join(KEY_FILE).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_damaged_newest_save_falls_back_to_the_previous_one() {
        let dir = temp_dir();
        let vault = Vault::open(&dir).unwrap();
        let conn = vault.load_database().unwrap();
        seeded(&conn);
        vault.save_db(&conn).unwrap();
        vault.save_db(&conn).unwrap();
        std::fs::write(dir.join(DB_FILE), b"damaged").unwrap();

        let conn = vault.load_database().unwrap();
        let n: i64 = conn.query_row("SELECT count(*) FROM users", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn existing_unencrypted_data_is_encrypted_and_the_plaintext_removed() {
        let dir = temp_dir();
        {
            // Copied while open: the files a killed run leaves, with the data still in the log.
            let running = temp_dir();
            let old = Connection::open(running.join(LEGACY_DB)).unwrap();
            old.execute_batch("PRAGMA journal_mode = WAL;").unwrap();
            old.execute_batch(db::SCHEMA).unwrap();
            seeded(&old);
            for name in [LEGACY_DB, "lesson-vault.sqlite3-wal"] {
                std::fs::copy(running.join(name), dir.join(name)).unwrap();
            }
            assert!(std::fs::metadata(dir.join("lesson-vault.sqlite3-wal")).unwrap().len() > 0);
            drop(old);
            std::fs::remove_dir_all(&running).unwrap();
        }
        std::fs::write(dir.join("files").join("a.pdf"), PDF).unwrap();

        let vault = Vault::open(&dir).unwrap();
        let conn = vault.load_database().unwrap();
        let email: String = conn.query_row("SELECT email FROM users", [], |r| r.get(0)).unwrap();
        assert_eq!(email, "zephyrword@b.c");
        assert_eq!(vault.read_pdf("a").unwrap(), PDF);

        assert!(!dir.join(LEGACY_DB).exists());
        assert!(!dir.join("lesson-vault.sqlite3-wal").exists());
        assert!(!dir.join("files").join("a.pdf").exists());
        let bytes = all_bytes(&dir);
        assert!(!contains(&bytes, b"zephyrword"));
        assert!(!contains(&bytes, b"%PDF"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
