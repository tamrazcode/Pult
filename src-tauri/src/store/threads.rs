//! Thread record CRUD.

use rusqlite::{params, Row};

use crate::events::now_millis;
use crate::PultError;

use super::records::ThreadRecord;
use super::{sql, Store};

const THREAD_COLUMNS: &str =
    "id, project_id, title, status, pinned, created_at, updated_at, workspace, main_repo, worktree_name, parent_thread_id, parent_run_id, depth, lineage_kind, child_role";

impl Store {
    pub fn create_thread(&self, record: &ThreadRecord) -> Result<(), PultError> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO threads (id, project_id, title, status, pinned, created_at, updated_at, workspace, main_repo, worktree_name, parent_thread_id, parent_run_id, depth, lineage_kind, child_role)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                params![
                    record.id,
                    record.project_id,
                    record.title,
                    record.status,
                    i64::from(record.pinned),
                    record.created_at,
                    record.updated_at,
                    record.workspace,
                    record.main_repo,
                    record.worktree_name,
                    record.parent_thread_id,
                    record.parent_run_id,
                    record.depth,
                    record.lineage_kind,
                    record.child_role,
                ],
            )
            .map_err(|e| sql("create_thread insert", e))?;
            Ok(())
        })
    }

    /// All threads, most recently active first (`updated_at` DESC).
    pub fn list_threads(&self) -> Result<Vec<ThreadRecord>, PultError> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {THREAD_COLUMNS} FROM threads ORDER BY updated_at DESC, created_at DESC"
                ))
                .map_err(|e| sql("list_threads prepare", e))?;
            let rows = stmt
                .query_map([], thread_from_row)
                .map_err(|e| sql("list_threads query", e))?;
            let mut threads = Vec::new();
            for row in rows {
                threads.push(row.map_err(|e| sql("list_threads row", e))?);
            }
            Ok(threads)
        })
    }

    /// One thread; missing ids are an error.
    pub fn get_thread(&self, id: &str) -> Result<ThreadRecord, PultError> {
        self.with_conn(|conn| {
            conn.query_row(
                &format!("SELECT {THREAD_COLUMNS} FROM threads WHERE id = ?1"),
                [id],
                thread_from_row,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    PultError::store(format!("get_thread: thread not found: {id}"))
                }
                other => sql("get_thread query", other),
            })
        })
    }

    pub fn rename_thread(&self, id: &str, title: &str) -> Result<(), PultError> {
        self.update_thread("rename_thread", "title = ?1", title, id, true)
    }

    pub fn set_thread_status(&self, id: &str, status: &str) -> Result<(), PultError> {
        self.update_thread("set_thread_status", "status = ?1", status, id, true)
    }

    /// Runs live only as long as the app process, so threads stuck in a
    /// run-state (`working`/`waiting`) after a restart are orphans — reset
    /// them to drafts at boot instead of showing dead spinners (M6 gap).
    /// Cosmetic: `updated_at` stays untouched (no history rewrite, no
    /// reshuffle of the recency-ordered list).
    pub fn reset_orphaned_run_states(&self) -> Result<usize, PultError> {
        self.with_conn(|conn| {
            let changed = conn
                .execute(
                    "UPDATE threads SET status = 'draft'
                     WHERE status IN ('working', 'waiting')",
                    [],
                )
                .map_err(|e| sql("reset_orphaned_run_states update", e))?;
            // A run cannot survive the process: an interrupted run must be
            // terminal at boot, not a zombie spinner over the same transcript.
            conn.execute(
                "UPDATE runs
                 SET status = 'failed',
                     stopped_at = COALESCE(stopped_at, ?1),
                     stop_reason = COALESCE(stop_reason, 'failed'),
                     error = COALESCE(error, 'pult restarted while this run was active')
                 WHERE status IN ('running', 'queued')",
                params![now_millis()],
            )
            .map_err(|e| sql("reset_orphaned_run_states runs", e))?;
            // A crash between claim and commit leaves the row claimed forever;
            // unclaiming it puts the queued message back in the queue.
            conn.execute(
                "UPDATE queue_items SET claiming_run_id = NULL
                 WHERE claiming_run_id IS NOT NULL",
                [],
            )
            .map_err(|e| sql("reset_orphaned_run_states clear claims", e))?;
            conn.execute(
                "UPDATE delegated_tasks
                 SET status = 'orphaned', finished_at = COALESCE(finished_at, ?1)
                 WHERE status IN ('queued', 'running', 'waiting_approval', 'waiting_input')",
                params![now_millis()],
            )
            .map_err(|e| sql("reset_orphaned_run_states delegated_tasks", e))?;
            Ok(changed)
        })
    }

    /// Pinning is list organization, not activity, so it does not bump
    /// `updated_at` (that would reshuffle the recency-ordered list).
    pub fn set_thread_pinned(&self, id: &str, pinned: bool) -> Result<(), PultError> {
        self.update_thread(
            "set_thread_pinned",
            "pinned = ?1",
            i64::from(pinned),
            id,
            false,
        )
    }

    /// Deletes the thread. Runs and events cascade via foreign keys; session
    /// refs carry no FK, so they are cleared explicitly.
    pub fn delete_thread(&self, id: &str) -> Result<(), PultError> {
        self.with_conn(|conn| {
            let deleted = conn
                .execute("DELETE FROM threads WHERE id = ?1", [id])
                .map_err(|e| sql("delete_thread delete", e))?;
            if deleted == 0 {
                return Err(PultError::store(format!(
                    "delete_thread: thread not found: {id}"
                )));
            }
            conn.execute(
                "DELETE FROM provider_session_refs WHERE thread_id = ?1",
                [id],
            )
            .map_err(|e| sql("delete_thread clear session refs", e))?;
            Ok(())
        })
    }

    /// Shared single-column thread update; `bump_updated_at` refreshes the
    /// recency timestamp (used by rename and status changes).
    fn update_thread<V: rusqlite::ToSql>(
        &self,
        action: &str,
        assignment: &'static str,
        value: V,
        id: &str,
        bump_updated_at: bool,
    ) -> Result<(), PultError> {
        self.with_conn(|conn| {
            let updated = if bump_updated_at {
                let query =
                    format!("UPDATE threads SET {assignment}, updated_at = ?2 WHERE id = ?3");
                conn.execute(&query, params![value, now_millis(), id])
            } else {
                let query = format!("UPDATE threads SET {assignment} WHERE id = ?2");
                conn.execute(&query, params![value, id])
            }
            .map_err(|e| sql(action, e))?;
            if updated == 0 {
                return Err(PultError::store(format!(
                    "{action}: thread not found: {id}"
                )));
            }
            Ok(())
        })
    }
}

fn thread_from_row(row: &Row<'_>) -> rusqlite::Result<ThreadRecord> {
    Ok(ThreadRecord {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        title: row.get("title")?,
        status: row.get("status")?,
        pinned: row.get::<_, i64>("pinned")? != 0,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        workspace: row.get("workspace")?,
        main_repo: row.get("main_repo")?,
        worktree_name: row.get("worktree_name")?,
        parent_thread_id: row.get("parent_thread_id")?,
        parent_run_id: row.get("parent_run_id")?,
        depth: row.get("depth")?,
        lineage_kind: row.get("lineage_kind")?,
        child_role: row.get("child_role")?,
    })
}
