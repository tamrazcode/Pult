//! Persistence layer (§5): a single sqlite connection (bundled SQLite, WAL
//! journaling, foreign keys ON) behind a `std::sync::Mutex`. Storage calls are
//! short and synchronous; the async runtime wraps them in `spawn_blocking`.
//!
//! Layout: `records` (IPC-facing structs), `migrations` (schema versions),
//! `threads` / `runs` / `events` (per-entity methods), and the `Store` handle
//! itself plus session refs and settings here.

mod events;
mod migrations;
mod queue;
pub mod records;
mod runs;
mod threads;
#[cfg(test)]
mod tests;

pub use records::{RunRecord, ThreadRecord};

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::{params, Connection};

use crate::PultError;

/// Sqlite-backed store. One mutex-guarded connection: calls are short, so a
/// mutex beats a connection pool. `Store` is `Send + Sync` and cheap to share.
pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    /// Opens (creating if missing) the database at `path`, creates parent
    /// directories, applies any pending migrations, and returns the handle.
    pub fn open(path: &Path) -> Result<Self, PultError> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    PultError::store(format!("create db directory {}: {e}", parent.display()))
                })?;
            }
        }
        let conn = Connection::open(path)
            .map_err(|e| PultError::store(format!("open db at {}: {e}", path.display())))?;
        Self::init(conn)
    }

    /// Unnamed in-memory database (tests, ephemeral use).
    pub fn open_in_memory() -> Result<Self, PultError> {
        let conn = Connection::open_in_memory()
            .map_err(|e| PultError::store(format!("open in-memory db: {e}")))?;
        Self::init(conn)
    }

    fn init(mut conn: Connection) -> Result<Self, PultError> {
        configure(&conn)?;
        migrations::run(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Runs `f` with exclusive access to the connection; the one lock/poison
    /// path shared by every storage method.
    pub(crate) fn with_conn<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, PultError>,
    ) -> Result<T, PultError> {
        let conn = self.lock()?;
        f(&conn)
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>, PultError> {
        self.conn
            .lock()
            .map_err(|_| PultError::store("store connection mutex poisoned"))
    }
}

/// Per-connection pragmas: WAL journaling, FK enforcement (drives the thread →
/// run → event cascade deletes), and NORMAL sync (durable under WAL, much
/// faster than FULL). In-memory databases report "memory" for journal_mode;
/// that is expected and harmless.
fn configure(conn: &Connection) -> Result<(), PultError> {
    // journal_mode assignment returns the effective mode; query it to consume
    // the row instead of tripping "execute returned results".
    let _mode: String = conn
        .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))
        .map_err(|e| sql("pragma journal_mode", e))?;
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;")
        .map_err(|e| sql("pragma foreign_keys/synchronous", e))?;
    Ok(())
}

// ---- provider session refs --------------------------------------------------

impl Store {
    /// Remembers which remote (driver-side) session belongs to a
    /// (thread, instance) pair; a later upsert replaces the previous value.
    pub fn upsert_session_ref(
        &self,
        thread_id: &str,
        instance_id: &str,
        remote_session_id: &str,
    ) -> Result<(), PultError> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO provider_session_refs (thread_id, instance_id, remote_session_id)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(thread_id, instance_id)
                 DO UPDATE SET remote_session_id = excluded.remote_session_id",
                params![thread_id, instance_id, remote_session_id],
            )
            .map_err(|e| sql("upsert_session_ref upsert", e))?;
            Ok(())
        })
    }

    /// The remote session id recorded for (thread, instance), if any.
    pub fn get_session_ref(
        &self,
        thread_id: &str,
        instance_id: &str,
    ) -> Result<Option<String>, PultError> {
        self.with_conn(|conn| {
            match conn.query_row(
                "SELECT remote_session_id FROM provider_session_refs
                 WHERE thread_id = ?1 AND instance_id = ?2",
                [thread_id, instance_id],
                |row| row.get(0),
            ) {
                Ok(remote) => Ok(Some(remote)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(sql("get_session_ref select", e)),
            }
        })
    }
}

// ---- settings ---------------------------------------------------------------

impl Store {
    /// Reads a JSON setting; `None` when unset.
    pub fn get_setting(&self, key: &str) -> Result<Option<serde_json::Value>, PultError> {
        self.with_conn(|conn| {
            match conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
                row.get::<_, String>(0)
            }) {
                Ok(raw) => serde_json::from_str(&raw)
                    .map(Some)
                    .map_err(|e| PultError::store(format!("get_setting decode '{key}': {e}"))),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(sql("get_setting select", e)),
            }
        })
    }

    /// Writes a JSON setting of any shape, replacing any previous value.
    pub fn set_setting(&self, key: &str, value: &serde_json::Value) -> Result<(), PultError> {
        let raw = serde_json::to_string(value)
            .map_err(|e| PultError::store(format!("set_setting encode '{key}': {e}")))?;
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, raw],
            )
            .map_err(|e| sql("set_setting upsert", e))?;
            Ok(())
        })
    }
}

/// Maps a rusqlite error into `PultError::Store`, prefixed with the SQL action
/// that failed (e.g. "append_event insert").
pub(crate) fn sql(action: &str, err: rusqlite::Error) -> PultError {
    PultError::store(format!("{action}: {err}"))
}
