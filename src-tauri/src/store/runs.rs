//! Run record persistence.

use rusqlite::params;

use crate::PultError;

use super::records::RunRecord;
use super::{sql, Store};

impl Store {
    /// Inserts a run; the parent thread must exist (FK enforced).
    pub fn create_run(&self, record: &RunRecord) -> Result<(), PultError> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO runs (id, thread_id, idx, status, instance_id, model, mode, effort,
                                   started_at, stopped_at, stop_reason, error)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    record.id,
                    record.thread_id,
                    record.idx,
                    record.status,
                    record.instance_id,
                    record.model,
                    record.mode,
                    record.effort,
                    record.started_at,
                    record.stopped_at,
                    record.stop_reason,
                    record.error,
                ],
            )
            .map_err(|e| sql("create_run insert", e))?;
            Ok(())
        })
    }

    /// Marks a run terminal: sets `stopped_at`, `status`, `stop_reason`, and
    /// the failure `error` detail (crash diagnostics). Missing run ids are an
    /// error.
    #[allow(clippy::too_many_arguments)]
    pub fn finish_run(
        &self,
        run_id: &str,
        stopped_at_ms: i64,
        status: &str,
        stop_reason: Option<&str>,
        error: Option<&str>,
    ) -> Result<(), PultError> {
        self.with_conn(|conn| {
            let updated = conn
                .execute(
                    "UPDATE runs SET stopped_at = ?2, status = ?3, stop_reason = ?4,
                                     error = ?5 WHERE id = ?1",
                    params![run_id, stopped_at_ms, status, stop_reason, error],
                )
                .map_err(|e| sql("finish_run update", e))?;
            if updated == 0 {
                return Err(PultError::store(format!("finish_run: run not found: {run_id}")));
            }
            Ok(())
        })
    }

    /// All runs of a thread, ordered by idx (§4.2: runs are numbered per thread).
    pub fn list_runs(&self, thread_id: &str) -> Result<Vec<RunRecord>, PultError> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, thread_id, idx, status, instance_id, model, mode, effort,
                            started_at, stopped_at, stop_reason, error
                     FROM runs WHERE thread_id = ?1 ORDER BY idx ASC",
                )
                .map_err(|e| sql("list_runs prepare", e))?;
            let rows = stmt
                .query_map(params![thread_id], |row| {
                    Ok(RunRecord {
                        id: row.get(0)?,
                        thread_id: row.get(1)?,
                        idx: row.get(2)?,
                        status: row.get(3)?,
                        instance_id: row.get(4)?,
                        model: row.get(5)?,
                        mode: row.get(6)?,
                        effort: row.get(7)?,
                        started_at: row.get(8)?,
                        stopped_at: row.get(9)?,
                        stop_reason: row.get(10)?,
                        error: row.get(11)?,
                    })
                })
                .map_err(|e| sql("list_runs query", e))?;
            let mut runs = Vec::new();
            for row in rows {
                runs.push(row.map_err(|e| sql("list_runs row", e))?);
            }
            Ok(runs)
        })
    }

    /// Number of runs a thread has (for assigning the next run's idx).
    pub fn run_count(&self, thread_id: &str) -> Result<u64, PultError> {
        self.with_conn(|conn| {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM runs WHERE thread_id = ?1",
                    params![thread_id],
                    |row| row.get(0),
                )
                .map_err(|e| sql("run_count query", e))?;
            Ok(count.max(0) as u64)
        })
    }
}
