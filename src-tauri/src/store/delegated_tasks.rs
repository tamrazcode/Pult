//! App-owned delegated tasks (orchestration subagents).

use rusqlite::{params, Row};

use crate::PultError;

use super::records::DelegatedTaskRecord;
use super::{sql, Store};

const TASK_COLUMNS: &str = "id, parent_thread_id, parent_run_id, child_thread_id, child_run_id, \
    client_request_id, title, prompt_summary, role, target_instance_id, target_model, isolation, \
    permission_mode, status, summary, error, started_at, finished_at, usage_json";

/// Mutable fields of a delegated task's terminal/progress patch.
pub struct DelegatedTaskUpdate<'a> {
    pub status: &'a str,
    pub child_run_id: Option<&'a str>,
    pub summary: Option<&'a str>,
    pub error: Option<&'a str>,
    pub usage_json: Option<&'a str>,
    pub finished_at: Option<i64>,
}

impl Store {
    /// Inserts a task, or returns the existing row for the same
    /// `(parent_thread_id, client_request_id)` pair (idempotent delegation).
    pub fn insert_or_get_delegated_task(
        &self,
        task: &DelegatedTaskRecord,
    ) -> Result<(DelegatedTaskRecord, bool), PultError> {
        self.with_conn(|conn| {
            if let Some(client_request_id) = task.client_request_id.as_deref() {
                let existing = conn.query_row(
                    &format!(
                        "SELECT {TASK_COLUMNS} FROM delegated_tasks
                         WHERE parent_thread_id = ?1 AND client_request_id = ?2"
                    ),
                    params![task.parent_thread_id, client_request_id],
                    task_from_row,
                );
                match existing {
                    Ok(found) => return Ok((found, true)),
                    Err(rusqlite::Error::QueryReturnedNoRows) => {}
                    Err(e) => return Err(sql("delegated_tasks idempotency lookup", e)),
                }
            }
            conn.execute(
                "INSERT INTO delegated_tasks (
                    id, parent_thread_id, parent_run_id, child_thread_id, child_run_id,
                    client_request_id, title, prompt_summary, role, target_instance_id,
                    target_model, isolation, permission_mode, status, summary, error,
                    started_at, finished_at, usage_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
                params![
                    task.id,
                    task.parent_thread_id,
                    task.parent_run_id,
                    task.child_thread_id,
                    task.child_run_id,
                    task.client_request_id,
                    task.title,
                    task.prompt_summary,
                    task.role,
                    task.target_instance_id,
                    task.target_model,
                    task.isolation,
                    task.permission_mode,
                    task.status,
                    task.summary,
                    task.error,
                    task.started_at,
                    task.finished_at,
                    task.usage_json,
                ],
            )
            .map_err(|e| sql("delegated_tasks insert", e))?;
            Ok((task.clone(), false))
        })
    }

    /// Re-arms a finished task for a follow-up run in the same child thread.
    pub fn restart_delegated_task(
        &self,
        id: &str,
        child_run_id: &str,
        started_at: i64,
    ) -> Result<(), PultError> {
        self.with_conn(|conn| {
            let updated = conn
                .execute(
                    "UPDATE delegated_tasks SET status = 'running', child_run_id = ?1,
                        summary = NULL, error = NULL, finished_at = NULL, started_at = ?2
                     WHERE id = ?3",
                    params![child_run_id, started_at, id],
                )
                .map_err(|e| sql("delegated_tasks restart", e))?;
            if updated == 0 {
                return Err(PultError::store(format!(
                    "restart_delegated_task: not found: {id}"
                )));
            }
            Ok(())
        })
    }

    pub fn get_delegated_task(&self, id: &str) -> Result<DelegatedTaskRecord, PultError> {
        self.with_conn(|conn| {
            conn.query_row(
                &format!("SELECT {TASK_COLUMNS} FROM delegated_tasks WHERE id = ?1"),
                [id],
                task_from_row,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    PultError::store(format!("get_delegated_task: not found: {id}"))
                }
                other => sql("delegated_tasks get", other),
            })
        })
    }

    pub fn list_delegated_tasks(
        &self,
        parent_thread_id: &str,
    ) -> Result<Vec<DelegatedTaskRecord>, PultError> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {TASK_COLUMNS} FROM delegated_tasks
                     WHERE parent_thread_id = ?1 ORDER BY started_at ASC, id ASC"
                ))
                .map_err(|e| sql("delegated_tasks list prepare", e))?;
            let rows = stmt
                .query_map([parent_thread_id], task_from_row)
                .map_err(|e| sql("delegated_tasks list", e))?;
            let mut tasks = Vec::new();
            for row in rows {
                tasks.push(row.map_err(|e| sql("delegated_tasks list row", e))?);
            }
            Ok(tasks)
        })
    }

    /// Task owning a live child run (used by the runtime finalizer).
    pub fn find_delegated_task_by_child_run(
        &self,
        child_run_id: &str,
    ) -> Result<Option<DelegatedTaskRecord>, PultError> {
        self.with_conn(|conn| {
            conn.query_row(
                &format!(
                    "SELECT {TASK_COLUMNS} FROM delegated_tasks WHERE child_run_id = ?1
                     ORDER BY started_at DESC LIMIT 1"
                ),
                [child_run_id],
                task_from_row,
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(sql("delegated_tasks by child run", other)),
            })
        })
    }

    /// Task owning a child thread (used when a run finishes before the
    /// engine could persist its run id).
    pub fn find_delegated_task_by_child_thread(
        &self,
        child_thread_id: &str,
    ) -> Result<Option<DelegatedTaskRecord>, PultError> {
        self.with_conn(|conn| {
            conn.query_row(
                &format!(
                    "SELECT {TASK_COLUMNS} FROM delegated_tasks WHERE child_thread_id = ?1
                     ORDER BY started_at DESC LIMIT 1"
                ),
                [child_thread_id],
                task_from_row,
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(sql("delegated_tasks by child thread", other)),
            })
        })
    }

    /// Tasks delegated directly from one parent thread.
    pub fn list_child_delegated_tasks(
        &self,
        parent_thread_id: &str,
    ) -> Result<Vec<DelegatedTaskRecord>, PultError> {
        self.list_delegated_tasks(parent_thread_id)
    }

    /// Status/finish patch used by the runtime finalizer and the orphan sweep.
    pub fn update_delegated_task_status(
        &self,
        id: &str,
        update: &DelegatedTaskUpdate<'_>,
    ) -> Result<(), PultError> {
        self.with_conn(|conn| {
            let updated = conn
                .execute(
                    "UPDATE delegated_tasks SET
                        status = ?1,
                        child_run_id = COALESCE(?2, child_run_id),
                        summary = COALESCE(?3, summary),
                        error = COALESCE(?4, error),
                        usage_json = COALESCE(?5, usage_json),
                        finished_at = COALESCE(?6, finished_at)
                     WHERE id = ?7",
                    params![
                        update.status,
                        update.child_run_id,
                        update.summary,
                        update.error,
                        update.usage_json,
                        update.finished_at,
                        id
                    ],
                )
                .map_err(|e| sql("delegated_tasks update", e))?;
            if updated == 0 {
                return Err(PultError::store(format!(
                    "update_delegated_task_status: not found: {id}"
                )));
            }
            Ok(())
        })
    }
}

fn task_from_row(row: &Row<'_>) -> rusqlite::Result<DelegatedTaskRecord> {
    Ok(DelegatedTaskRecord {
        id: row.get("id")?,
        parent_thread_id: row.get("parent_thread_id")?,
        parent_run_id: row.get("parent_run_id")?,
        child_thread_id: row.get("child_thread_id")?,
        child_run_id: row.get("child_run_id")?,
        client_request_id: row.get("client_request_id")?,
        title: row.get("title")?,
        prompt_summary: row.get("prompt_summary")?,
        role: row.get("role")?,
        target_instance_id: row.get("target_instance_id")?,
        target_model: row.get("target_model")?,
        isolation: row.get("isolation")?,
        permission_mode: row.get("permission_mode")?,
        status: row.get("status")?,
        summary: row.get("summary")?,
        error: row.get("error")?,
        started_at: row.get("started_at")?,
        finished_at: row.get("finished_at")?,
        usage_json: row.get("usage_json")?,
    })
}
