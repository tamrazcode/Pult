//! Backend-owned message queue: texts (plus capability-gated images) waiting
//! for the thread's active run to finish. The runtime pops the head and
//! dispatches it automatically after `run_finished` (§4.2: one active run per
//! thread, queue behind it).

use rusqlite::{params, Row};

use crate::events::Event;
use crate::store::records::{QueueItem, RunRecord};
use crate::store::{sql, Store};
use crate::PultError;

impl Store {
    /// Appends a message to the thread's queue (FIFO by `created_at`, ties by
    /// insertion order).
    pub fn enqueue_queue_item(&self, item: &QueueItem) -> Result<(), PultError> {
        let images = serde_json::to_string(&item.images)
            .map_err(|e| PultError::store(format!("enqueue_queue_item encode images: {e}")))?;
        let config_options = serde_json::to_string(&item.config_options).map_err(|e| {
            PultError::store(format!("enqueue_queue_item encode config_options: {e}"))
        })?;
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO queue_items
                     (id, thread_id, instance_id, text, images, mode, config_options, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    item.id,
                    item.thread_id,
                    item.instance_id,
                    item.text,
                    images,
                    item.mode,
                    config_options,
                    item.created_at
                ],
            )
            .map_err(|e| sql("enqueue_queue_item insert", e))?;
            Ok(())
        })
    }

    /// The thread's unclaimed queued messages, oldest first.
    pub fn list_queue(&self, thread_id: &str) -> Result<Vec<QueueItem>, PultError> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, thread_id, instance_id, text, images, mode, config_options,
                            created_at
                     FROM queue_items WHERE thread_id = ?1 AND claiming_run_id IS NULL
                     ORDER BY created_at ASC, rowid ASC",
                )
                .map_err(|e| sql("list_queue prepare", e))?;
            let rows = stmt
                .query_map(params![thread_id], queue_item_row)
                .map_err(|e| sql("list_queue query", e))?;
            let mut items = Vec::new();
            for row in rows {
                items.push(row.map_err(|e| sql("list_queue row", e))?);
            }
            Ok(items)
        })
    }

    /// Removes one queued message (user cancelled it from the composer).
    pub fn remove_queue_item(&self, item_id: &str) -> Result<(), PultError> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM queue_items WHERE id = ?1", params![item_id])
                .map_err(|e| sql("remove_queue_item delete", e))?;
            Ok(())
        })
    }

    /// Replaces the text of one queued message (inline edit).
    pub fn update_queue_item_text(&self, item_id: &str, text: &str) -> Result<(), PultError> {
        self.with_conn(|conn| {
            let changed = conn
                .execute(
                    "UPDATE queue_items SET text = ?1 WHERE id = ?2",
                    params![text, item_id],
                )
                .map_err(|e| sql("update_queue_item_text update", e))?;
            if changed == 0 {
                return Err(PultError::with_code(
                    "queue.item_not_found",
                    "queue item not found",
                ));
            }
            Ok(())
        })
    }

    /// Rewrites the whole queue order; `created_at` becomes the position.
    pub fn reorder_queue_items(&self, thread_id: &str, ids: &[String]) -> Result<(), PultError> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare("SELECT id FROM queue_items WHERE thread_id = ?1")
                .map_err(|e| sql("reorder_queue_items select", e))?;
            let current: Vec<String> = stmt
                .query_map(params![thread_id], |row| row.get(0))
                .map_err(|e| sql("reorder_queue_items query", e))?
                .collect::<Result<_, _>>()
                .map_err(|e| sql("reorder_queue_items row", e))?;
            let mut seen = std::collections::HashSet::new();
            if current.len() != ids.len()
                || ids
                    .iter()
                    .any(|id| !current.contains(id) || !seen.insert(id.as_str()))
            {
                return Err(PultError::with_code(
                    "queue.order_mismatch",
                    "queue order does not match the queue",
                ));
            }

            conn.execute("BEGIN IMMEDIATE", [])
                .map_err(|e| sql("reorder_queue_items begin", e))?;
            for (index, id) in ids.iter().enumerate() {
                if let Err(err) = conn.execute(
                    "UPDATE queue_items SET created_at = ?1 WHERE id = ?2 AND thread_id = ?3",
                    params![index as i64, id, thread_id],
                ) {
                    let _ = conn.execute("ROLLBACK", []);
                    return Err(sql("reorder_queue_items update", err));
                }
            }
            conn.execute("COMMIT", [])
                .map_err(|e| sql("reorder_queue_items commit", e))?;
            Ok(())
        })
    }

    /// Moves one item ahead of the rest so auto-dispatch picks it first.
    pub fn move_queue_item_to_head(&self, thread_id: &str, item_id: &str) -> Result<(), PultError> {
        self.with_conn(|conn| {
            let changed = conn
                .execute(
                    "UPDATE queue_items
                     SET created_at = (
                         SELECT COALESCE(MIN(created_at), 0) - 1
                         FROM queue_items WHERE thread_id = ?1
                     )
                     WHERE id = ?2 AND thread_id = ?1",
                    params![thread_id, item_id],
                )
                .map_err(|e| sql("move_queue_item_to_head update", e))?;
            if changed == 0 {
                return Err(PultError::with_code(
                    "queue.item_not_found",
                    "queue item not found",
                ));
            }
            Ok(())
        })
    }

    /// Pops the oldest queued message for a thread, if any (auto-dispatch).
    /// One DELETE…RETURNING statement: two concurrent dispatchers can never
    /// pop the same row (which would run the same message twice).
    pub fn pop_queue_head(&self, thread_id: &str) -> Result<Option<QueueItem>, PultError> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "DELETE FROM queue_items
                     WHERE id IN (
                         SELECT id FROM queue_items WHERE thread_id = ?1
                         ORDER BY created_at ASC, rowid ASC LIMIT 1
                     )
                     RETURNING id, thread_id, instance_id, text, images, mode, config_options,
                               created_at",
                )
                .map_err(|e| sql("pop_queue_head prepare", e))?;
            let mut rows = stmt
                .query(params![thread_id])
                .map_err(|e| sql("pop_queue_head query", e))?;
            let Some(row) = rows.next().map_err(|e| sql("pop_queue_head row", e))? else {
                return Ok(None);
            };
            Ok(Some(
                queue_item_row(row).map_err(|e| sql("pop_queue_head row", e))?,
            ))
        })
    }

    /// Claims the oldest unclaimed queued message for a thread by stamping
    /// `claim_token` on it, without deleting it. A second claim while the
    /// first is unreleased returns `None`, so two dispatchers cannot run the
    /// same message twice; the row only leaves the queue in
    /// [`Store::commit_claimed_queue_run`].
    pub fn claim_queue_head(
        &self,
        thread_id: &str,
        claim_token: &str,
    ) -> Result<Option<QueueItem>, PultError> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "UPDATE queue_items SET claiming_run_id = ?2
                     WHERE id = (
                         SELECT id FROM queue_items
                         WHERE thread_id = ?1 AND claiming_run_id IS NULL
                         ORDER BY created_at ASC, rowid ASC LIMIT 1
                     )
                       AND claiming_run_id IS NULL
                     RETURNING id, thread_id, instance_id, text, images, mode, config_options,
                               created_at",
                )
                .map_err(|e| sql("claim_queue_head prepare", e))?;
            let mut rows = stmt
                .query(params![thread_id, claim_token])
                .map_err(|e| sql("claim_queue_head query", e))?;
            let Some(row) = rows.next().map_err(|e| sql("claim_queue_head row", e))? else {
                return Ok(None);
            };
            Ok(Some(
                queue_item_row(row).map_err(|e| sql("claim_queue_head row", e))?,
            ))
        })
    }

    /// Drops a claim so the row shows up in `list_queue` again (dispatch
    /// failed before the run committed).
    pub fn release_queue_claim(&self, queue_id: &str) -> Result<(), PultError> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE queue_items SET claiming_run_id = NULL WHERE id = ?1",
                params![queue_id],
            )
            .map_err(|e| sql("release_queue_claim update", e))?;
            Ok(())
        })
    }

    /// Commits a claimed queue item: inserts the run, its first event, marks
    /// the thread working, and deletes the queue row in ONE transaction. Any
    /// failure rolls all of them back, so the message survives a failed
    /// dispatch and the thread is never left "working" without a run.
    pub fn commit_claimed_queue_run(
        &self,
        queue_id: &str,
        run: &RunRecord,
        user_event: &Event,
    ) -> Result<(), PultError> {
        let (kind, payload) = encode_event(user_event)?;
        let now = crate::events::now_millis();
        self.with_conn(|conn| {
            conn.execute("BEGIN IMMEDIATE", [])
                .map_err(|e| sql("commit_claimed_queue_run begin", e))?;
            let write = (|| -> Result<(), PultError> {
                conn.execute(
                    "UPDATE threads SET status = 'working', updated_at = ?1 WHERE id = ?2",
                    params![now, run.thread_id],
                )
                .map_err(|e| sql("commit_claimed_queue_run thread status", e))?;
                conn.execute(
                    "INSERT INTO runs (id, thread_id, idx, status, instance_id, model, mode, effort,
                                       started_at, stopped_at, stop_reason, error)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                    params![
                        run.id,
                        run.thread_id,
                        run.idx,
                        run.status,
                        run.instance_id,
                        run.model,
                        run.mode,
                        run.effort,
                        run.started_at,
                        run.stopped_at,
                        run.stop_reason,
                        run.error,
                    ],
                )
                .map_err(|e| sql("commit_claimed_queue_run insert run", e))?;
                conn.execute(
                    "INSERT INTO events (id, run_id, seq, ts, kind, payload)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        user_event.id,
                        user_event.run_id,
                        user_event.seq as i64,
                        user_event.ts,
                        kind,
                        payload
                    ],
                )
                .map_err(|e| sql("commit_claimed_queue_run insert event", e))?;
                conn.execute("DELETE FROM queue_items WHERE id = ?1", params![queue_id])
                    .map_err(|e| sql("commit_claimed_queue_run delete queue row", e))?;
                Ok(())
            })();
            match write {
                Ok(()) => conn
                    .execute("COMMIT", [])
                    .map(|_| ())
                    .map_err(|e| sql("commit_claimed_queue_run commit", e)),
                Err(err) => {
                    let _ = conn.execute("ROLLBACK", []);
                    Err(err)
                }
            }
        })
    }

    /// Commits a steered message the provider already accepted: the user
    /// event and the queue-row delete land in ONE transaction, with the seq
    /// assigned inside it. A failure must not put the row back in the queue
    /// (that would deliver the same message twice).
    pub fn commit_steered_queue_message(
        &self,
        queue_id: &str,
        run_id: &str,
        kind: crate::events::EventKind,
    ) -> Result<Event, PultError> {
        self.with_conn(|conn| {
            conn.execute("BEGIN IMMEDIATE", [])
                .map_err(|e| sql("commit_steered_queue_message begin", e))?;
            let write = (|| -> Result<Event, PultError> {
                let seq: i64 = conn
                    .query_row(
                        "SELECT COALESCE(MAX(seq) + 1, 0) FROM events WHERE run_id = ?1",
                        params![run_id],
                        |row| row.get(0),
                    )
                    .map_err(|e| sql("commit_steered_queue_message seq", e))?;
                let event = Event::new(run_id, seq as u64, kind.clone());
                let (tag, payload) = encode_event(&event)?;
                conn.execute(
                    "INSERT INTO events (id, run_id, seq, ts, kind, payload)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        event.id,
                        event.run_id,
                        event.seq as i64,
                        event.ts,
                        tag,
                        payload
                    ],
                )
                .map_err(|e| sql("commit_steered_queue_message insert event", e))?;
                conn.execute("DELETE FROM queue_items WHERE id = ?1", params![queue_id])
                    .map_err(|e| sql("commit_steered_queue_message delete queue row", e))?;
                Ok(event)
            })();
            match write {
                Ok(event) => conn
                    .execute("COMMIT", [])
                    .map(|_| event)
                    .map_err(|e| sql("commit_steered_queue_message commit", e)),
                Err(err) => {
                    let _ = conn.execute("ROLLBACK", []);
                    Err(err)
                }
            }
        })
    }
}

/// One queue row in SELECT order (see the column list in the queries above).
fn queue_item_row(row: &Row<'_>) -> rusqlite::Result<QueueItem> {
    let images: String = row.get(4)?;
    let config_options: String = row.get(6)?;
    Ok(QueueItem {
        id: row.get(0)?,
        thread_id: row.get(1)?,
        instance_id: row.get(2)?,
        text: row.get(3)?,
        images: serde_json::from_str(&images).unwrap_or_default(),
        mode: row.get(5)?,
        config_options: serde_json::from_str(&config_options).unwrap_or_default(),
        created_at: row.get(7)?,
    })
}

/// Splits an `EventKind` into its stored columns (serde tag + payload JSON),
/// mirroring `store::events::split_kind` for the transactional insert.
fn encode_event(event: &Event) -> Result<(String, String), PultError> {
    let value = serde_json::to_value(&event.kind).map_err(|e| {
        PultError::store(format!(
            "commit_claimed_queue_run encode kind ({}): {e}",
            event.id
        ))
    })?;
    let kind = value["kind"]
        .as_str()
        .ok_or_else(|| {
            PultError::store(format!(
                "commit_claimed_queue_run: event {} has no kind tag",
                event.id
            ))
        })?
        .to_string();
    let payload = serde_json::to_string(value.get("payload").unwrap_or(&serde_json::Value::Null))
        .map_err(|e| {
        PultError::store(format!(
            "commit_claimed_queue_run encode payload ({}): {e}",
            event.id
        ))
    })?;
    Ok((kind, payload))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::records::ImageInput;

    fn item(id: &str, thread: &str, text: &str, created_at: i64) -> QueueItem {
        QueueItem {
            id: id.to_string(),
            thread_id: thread.to_string(),
            instance_id: "mock".to_string(),
            text: text.to_string(),
            images: vec![ImageInput {
                data: "aGk=".to_string(),
                mime_type: "image/png".to_string(),
                name: None,
            }],
            mode: None,
            config_options: Default::default(),
            created_at,
        }
    }

    #[test]
    fn queue_fifo_round_trip() {
        use crate::store::records::ThreadRecord;
        let store = Store::open_in_memory().unwrap();
        for id in ["t1", "t2"] {
            store
                .create_thread(&ThreadRecord {
                    id: id.to_string(),
                    project_id: None,
                    title: id.to_string(),
                    status: "draft".to_string(),
                    pinned: false,
                    created_at: 0,
                    updated_at: 0,
                    workspace: None,
                    main_repo: None,
                    worktree_name: None,
                    parent_thread_id: None,
                    parent_run_id: None,
                    depth: 0,
                    lineage_kind: None,
                    child_role: None,
                })
                .unwrap();
        }
        store
            .enqueue_queue_item(&item("q1", "t1", "first", 10))
            .unwrap();
        store
            .enqueue_queue_item(&item("q2", "t1", "second", 20))
            .unwrap();
        store
            .enqueue_queue_item(&item("q3", "t2", "other thread", 5))
            .unwrap();

        let listed = store.list_queue("t1").unwrap();
        assert_eq!(
            listed.iter().map(|i| i.text.as_str()).collect::<Vec<_>>(),
            vec!["first", "second"]
        );
        assert_eq!(listed[0].images.len(), 1);
        assert_eq!(listed[0].images[0].mime_type, "image/png");

        let head = store.pop_queue_head("t1").unwrap().unwrap();
        assert_eq!(head.text, "first");
        assert!(store.pop_queue_head("t1").unwrap().unwrap().text == "second");
        assert!(store.pop_queue_head("t1").unwrap().is_none());

        store.remove_queue_item("q3").unwrap();
        assert!(store.list_queue("t2").unwrap().is_empty());
    }

    #[test]
    fn update_queue_item_text_updates_only_target_row_and_errors_on_unknown_id() {
        use crate::store::records::ThreadRecord;
        let store = Store::open_in_memory().unwrap();
        store
            .create_thread(&ThreadRecord {
                id: "t1".to_string(),
                project_id: None,
                title: "t1".to_string(),
                status: "draft".to_string(),
                pinned: false,
                created_at: 0,
                updated_at: 0,
                workspace: None,
                main_repo: None,
                worktree_name: None,
                parent_thread_id: None,
                parent_run_id: None,
                depth: 0,
                lineage_kind: None,
                child_role: None,
            })
            .unwrap();
        store
            .enqueue_queue_item(&item("q1", "t1", "first", 10))
            .unwrap();
        store
            .enqueue_queue_item(&item("q2", "t1", "second", 20))
            .unwrap();

        store.update_queue_item_text("q1", "first updated").unwrap();
        let listed = store.list_queue("t1").unwrap();
        assert_eq!(
            listed.iter().map(|i| i.text.as_str()).collect::<Vec<_>>(),
            vec!["first updated", "second"]
        );

        assert!(store.update_queue_item_text("missing-q", "nope").is_err());
    }

    #[test]
    fn reorder_queue_items_changes_order_and_errors_on_unknown_id() {
        use crate::store::records::ThreadRecord;
        let store = Store::open_in_memory().unwrap();
        store
            .create_thread(&ThreadRecord {
                id: "t1".to_string(),
                project_id: None,
                title: "t1".to_string(),
                status: "draft".to_string(),
                pinned: false,
                created_at: 0,
                updated_at: 0,
                workspace: None,
                main_repo: None,
                worktree_name: None,
                parent_thread_id: None,
                parent_run_id: None,
                depth: 0,
                lineage_kind: None,
                child_role: None,
            })
            .unwrap();
        store
            .enqueue_queue_item(&item("q1", "t1", "first", 10))
            .unwrap();
        store
            .enqueue_queue_item(&item("q2", "t1", "second", 20))
            .unwrap();

        store
            .reorder_queue_items("t1", &["q2".to_string(), "q1".to_string()])
            .unwrap();
        let listed = store.list_queue("t1").unwrap();
        assert_eq!(
            listed.iter().map(|i| i.text.as_str()).collect::<Vec<_>>(),
            vec!["second", "first"]
        );
        assert_eq!(store.pop_queue_head("t1").unwrap().unwrap().id, "q2");

        assert!(store
            .reorder_queue_items("t1", &["q1".to_string(), "missing-q".to_string()])
            .is_err());
    }

    #[test]
    fn move_queue_item_to_head_puts_item_first_and_errors_on_unknown_id() {
        use crate::store::records::ThreadRecord;
        let store = Store::open_in_memory().unwrap();
        store
            .create_thread(&ThreadRecord {
                id: "t1".to_string(),
                project_id: None,
                title: "t1".to_string(),
                status: "draft".to_string(),
                pinned: false,
                created_at: 0,
                updated_at: 0,
                workspace: None,
                main_repo: None,
                worktree_name: None,
                parent_thread_id: None,
                parent_run_id: None,
                depth: 0,
                lineage_kind: None,
                child_role: None,
            })
            .unwrap();
        store
            .enqueue_queue_item(&item("q1", "t1", "first", 10))
            .unwrap();
        store
            .enqueue_queue_item(&item("q2", "t1", "second", 20))
            .unwrap();
        store
            .enqueue_queue_item(&item("q3", "t1", "third", 30))
            .unwrap();

        store.move_queue_item_to_head("t1", "q3").unwrap();
        let listed = store.list_queue("t1").unwrap();
        assert_eq!(
            listed.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
            vec!["q3", "q1", "q2"]
        );

        assert!(store.move_queue_item_to_head("t1", "missing-q").is_err());
    }
}
