//! Recovery for an unreadable database.
//!
//! A corrupt `pult.db` (or an unwritable home) used to abort setup, so the app
//! flashed a window and died with exit 101 and no explanation. The user can now
//! move the broken file aside and start over; nothing else is touched.

use std::path::{Path, PathBuf};

/// Name the broken database is moved to, stamped with unix seconds.
pub fn broken_name(stamp: u64) -> String {
    format!("pult.db.broken-{stamp}")
}

/// Moves `pult.db` and its `-wal`/`-shm` siblings aside as
/// `pult.db.broken-<unix seconds>`.
///
/// Returns the path the database was moved to, or `None` when there was no
/// database file (nothing to recover from). The `-wal`/`-shm` files travel with
/// it: leaving them behind would let sqlite attach a stale log to the fresh
/// database.
pub fn move_broken_db_aside(dir: &Path) -> std::io::Result<Option<PathBuf>> {
    let db = dir.join("pult.db");
    if !db.exists() {
        return Ok(None);
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let name = broken_name(stamp);
    let target = dir.join(&name);
    std::fs::rename(&db, &target)?;
    for suffix in ["-wal", "-shm"] {
        let from = dir.join(format!("pult.db{suffix}"));
        if from.exists() {
            std::fs::rename(&from, dir.join(format!("{name}{suffix}")))?;
        }
    }
    Ok(Some(target))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pult-recovery-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn moves_the_database_and_its_siblings_aside() {
        let dir = scratch("moves");
        std::fs::write(dir.join("pult.db"), b"not a database").expect("db");
        std::fs::write(dir.join("pult.db-wal"), b"wal").expect("wal");
        std::fs::write(dir.join("pult.db-shm"), b"shm").expect("shm");

        let moved = move_broken_db_aside(&dir)
            .expect("recovery runs")
            .expect("database moved");

        assert!(!dir.join("pult.db").exists());
        assert!(!dir.join("pult.db-wal").exists());
        assert!(!dir.join("pult.db-shm").exists());
        assert_eq!(std::fs::read(&moved).expect("moved file"), b"not a database");
        let name = moved
            .file_name()
            .expect("file name")
            .to_string_lossy()
            .to_string();
        assert!(name.starts_with("pult.db.broken-"), "got {name}");
        assert!(dir.join(format!("{name}-wal")).exists());
        assert!(dir.join(format!("{name}-shm")).exists());

        // A fresh database opens in the same directory.
        crate::store::Store::open(&dir.join("pult.db")).expect("fresh database");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_database_is_not_an_error() {
        let dir = scratch("missing");
        assert!(move_broken_db_aside(&dir)
            .expect("recovery runs")
            .is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_database_fails_then_recovers() {
        let dir = scratch("corrupt");
        let path = dir.join("pult.db");
        std::fs::write(&path, vec![0x7f_u8; 4096]).expect("corrupt file");
        assert!(
            crate::store::Store::open(&path).is_err(),
            "a garbage file must not open as a database"
        );

        move_broken_db_aside(&dir).expect("recovery runs");
        crate::store::Store::open(&path).expect("fresh database after recovery");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
