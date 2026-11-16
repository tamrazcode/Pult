//! Ciphertext rows for user secrets (`app_secrets`). Plaintext never reaches
//! SQLite; `mcp::secrets::Secrets` seals before every write.

use rusqlite::{params, Connection, OptionalExtension};

use crate::events::now_millis;
use crate::PultError;

use super::{sql, Store};

impl Store {
    /// Seals and stores one secret. Used by custom MCP config code and, later,
    /// provider env secrets.
    pub fn set_secret(&self, key: &str, value: &str) -> Result<(), PultError> {
        let blob = self.seal_secret(value)?;
        self.with_conn(|conn| put_secret(conn, key, &blob))
    }

    /// Plaintext for internal use only. Callers must never hand it to the UI.
    pub fn get_secret(&self, key: &str) -> Result<Option<String>, PultError> {
        let blob = self.with_conn(|conn| get_secret_blob(conn, key))?;
        blob.map(|blob| self.unseal_secret(&blob)).transpose()
    }

    pub fn delete_secret(&self, key: &str) -> Result<(), PultError> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM app_secrets WHERE key = ?1", params![key])
                .map_err(|e| sql("delete secret", e))?;
            Ok(())
        })
    }

    /// Removes every secret whose key starts with `prefix` (server deletion).
    pub fn delete_secrets_with_prefix(&self, prefix: &str) -> Result<(), PultError> {
        self.with_conn(|conn| delete_secrets_with_prefix(conn, prefix))
    }

    pub(crate) fn seal_secret(&self, value: &str) -> Result<Vec<u8>, PultError> {
        self.secrets.seal(value)
    }

    pub(crate) fn unseal_secret(&self, blob: &[u8]) -> Result<String, PultError> {
        self.secrets.open(blob)
    }
}

pub(crate) fn put_secret(conn: &Connection, key: &str, blob: &[u8]) -> Result<(), PultError> {
    conn.execute(
        "INSERT INTO app_secrets (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, blob, now_millis()],
    )
    .map_err(|e| sql("upsert secret", e))?;
    Ok(())
}

pub(crate) fn get_secret_blob(conn: &Connection, key: &str) -> Result<Option<Vec<u8>>, PultError> {
    conn.query_row(
        "SELECT value FROM app_secrets WHERE key = ?1",
        params![key],
        |row| row.get::<_, Vec<u8>>(0),
    )
    .optional()
    .map_err(|e| sql("read secret", e))
}

pub(crate) fn delete_secrets_with_prefix(conn: &Connection, prefix: &str) -> Result<(), PultError> {
    conn.execute(
        "DELETE FROM app_secrets WHERE key LIKE ?1",
        params![format!("{prefix}%")],
    )
    .map_err(|e| sql("delete secrets by prefix", e))?;
    Ok(())
}

pub(crate) fn delete_secret_keys(conn: &Connection, keys: &[String]) -> Result<(), PultError> {
    for key in keys {
        conn.execute("DELETE FROM app_secrets WHERE key = ?1", params![key])
            .map_err(|e| sql("delete secret", e))?;
    }
    Ok(())
}
