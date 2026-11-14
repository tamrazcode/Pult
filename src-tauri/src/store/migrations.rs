//! Schema migrations keyed off `PRAGMA user_version`. Each migration runs at
//! most once, inside its own transaction, then bumps the version — so a crash
//! mid-migration rolls back cleanly and retries on the next open.

use rusqlite::Connection;

use crate::PultError;

use super::sql;

type MigrationFn = fn(&Connection) -> Result<(), PultError>;

/// Ordered list: entry `i` upgrades the schema from version `i` to `i + 1`.
const MIGRATIONS: &[MigrationFn] = &[migration_1, migration_2, migration_3, migration_4];

/// Applies every migration newer than the stored `user_version`.
pub(super) fn run(conn: &mut Connection) -> Result<(), PultError> {
    let current: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| sql("read user_version", e))?;
    for (index, migration) in MIGRATIONS.iter().enumerate() {
        let version = (index + 1) as i64;
        if version <= current {
            continue;
        }
        let tx = conn
            .transaction()
            .map_err(|e| sql("begin migration transaction", e))?;
        migration(&tx).map_err(|e| PultError::store(format!("migration {version} failed: {e}")))?;
        tx.pragma_update(None, "user_version", version)
            .map_err(|e| sql("bump user_version", e))?;
        tx.commit().map_err(|e| sql("commit migration", e))?;
    }
    Ok(())
}

/// Version 1: initial schema — projects, threads, runs, the append-only event
/// log, provider session refs, and JSON settings. Cascade deletes are enforced
/// by the foreign keys (threads → runs → events) at the connection level.
fn migration_1(conn: &Connection) -> Result<(), PultError> {
    conn.execute_batch(
        r#"
        CREATE TABLE projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            root_path TEXT NOT NULL,
            color TEXT,
            worktree_strategy TEXT NOT NULL DEFAULT 'root',
            created_at INTEGER NOT NULL
        );

        CREATE TABLE threads (
            id TEXT PRIMARY KEY,
            project_id TEXT NULL REFERENCES projects(id) ON DELETE SET NULL,
            title TEXT NOT NULL,
            status TEXT NOT NULL,
            pinned INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE runs (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
            idx INTEGER NOT NULL,
            status TEXT NOT NULL,
            instance_id TEXT NOT NULL,
            model TEXT,
            mode TEXT,
            effort TEXT,
            started_at INTEGER NOT NULL,
            stopped_at INTEGER,
            stop_reason TEXT
        );

        CREATE TABLE events (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL,
            ts INTEGER NOT NULL,
            kind TEXT NOT NULL,
            payload TEXT NOT NULL,
            UNIQUE(run_id, seq)
        );

        CREATE TABLE provider_session_refs (
            thread_id TEXT NOT NULL,
            instance_id TEXT NOT NULL,
            remote_session_id TEXT NOT NULL,
            PRIMARY KEY(thread_id, instance_id)
        );

        CREATE TABLE settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE INDEX idx_runs_thread_idx ON runs(thread_id, idx);
        CREATE INDEX idx_threads_updated_at ON threads(updated_at);
        "#,
    )
    .map_err(|e| sql("migration 1: create tables", e))
}

/// Version 2 (M2): the backend-owned message queue (a queued text dispatches
/// automatically once the thread's active run finishes) and a persisted
/// failure message on runs (crash diagnostics surface in the UI).
fn migration_2(conn: &Connection) -> Result<(), PultError> {
    conn.execute_batch(
        r#"
        ALTER TABLE runs ADD COLUMN error TEXT;

        CREATE TABLE queue_items (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
            instance_id TEXT NOT NULL,
            text TEXT NOT NULL,
            images TEXT NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL
        );

        CREATE INDEX idx_queue_items_thread ON queue_items(thread_id, created_at);
        "#,
    )
    .map_err(|e| sql("migration 2: queue_items + runs.error", e))
}

/// Version 3 (M4): per-thread workspaces — `workspace` is the cwd given to
/// agent sessions (falls back to the global root when NULL), and the
/// worktree pair records a thread pinned to `git worktree` under its repo
/// (`.pult/worktrees/<name>`), for isolation and cleanup on delete.
fn migration_3(conn: &Connection) -> Result<(), PultError> {
    conn.execute_batch(
        r#"
        ALTER TABLE threads ADD COLUMN workspace TEXT;
        ALTER TABLE threads ADD COLUMN main_repo TEXT;
        ALTER TABLE threads ADD COLUMN worktree_name TEXT;
        "#,
    )
    .map_err(|e| sql("migration 3: thread workspaces", e))
}

/// Version 4 (v2): starred projects for the T3-style sidebar.
fn migration_4(conn: &Connection) -> Result<(), PultError> {
    conn.execute_batch(
        r#"
        ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
        "#,
    )
    .map_err(|e| sql("migration 4: projects.pinned", e))
}
