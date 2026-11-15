//! Backend-owned message queue: texts (plus capability-gated images) waiting
//! for the thread's active run to finish. The runtime pops the head and
//! dispatches it automatically after `run_finished` (§4.2: one active run per
//! thread, queue behind it).

use rusqlite::params;

use crate::store::records::QueueItem;
use crate::store::{sql, Store};
use crate::PultError;

impl Store {
    /// Appends a message to the thread's queue (FIFO by `created_at`, ties by
    /// insertion order).
    pub fn enqueue_queue_item(&self, item: &QueueItem) -> Result<(), PultError> {
        let images = serde_json::to_string(&item.images)
            .map_err(|e| PultError::store(format!("enqueue_queue_item encode images: {e}")))?;
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO queue_items (id, thread_id, instance_id, text, images, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    item.id,
                    item.thread_id,
                    item.instance_id,
                    item.text,
                    images,
                    item.created_at
                ],
            )
            .map_err(|e| sql("enqueue_queue_item insert", e))?;
            Ok(())
        })
    }

    /// The thread's queued messages, oldest first.
    pub fn list_queue(&self, thread_id: &str) -> Result<Vec<QueueItem>, PultError> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, thread_id, instance_id, text, images, created_at
                     FROM queue_items WHERE thread_id = ?1
                     ORDER BY created_at ASC, rowid ASC",
                )
                .map_err(|e| sql("list_queue prepare", e))?;
            let rows = stmt
                .query_map(params![thread_id], |row| {
                    let raw: String = row.get(4)?;
                    Ok(QueueItem {
                        id: row.get(0)?,
                        thread_id: row.get(1)?,
                        instance_id: row.get(2)?,
                        text: row.get(3)?,
                        images: serde_json::from_str(&raw).unwrap_or_default(),
                        created_at: row.get(5)?,
                    })
                })
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
                     RETURNING id, thread_id, instance_id, text, images, created_at",
                )
                .map_err(|e| sql("pop_queue_head prepare", e))?;
            let mut rows = stmt
                .query(params![thread_id])
                .map_err(|e| sql("pop_queue_head query", e))?;
            let Some(row) = rows.next().map_err(|e| sql("pop_queue_head row", e))? else {
                return Ok(None);
            };
            let raw: String = row.get(4).map_err(|e| sql("pop_queue_head images", e))?;
            Ok(Some(QueueItem {
                id: row.get(0).map_err(|e| sql("pop_queue_head id", e))?,
                thread_id: row
                    .get(1)
                    .map_err(|e| sql("pop_queue_head thread_id", e))?,
                instance_id: row
                    .get(2)
                    .map_err(|e| sql("pop_queue_head instance_id", e))?,
                text: row.get(3).map_err(|e| sql("pop_queue_head text", e))?,
                images: serde_json::from_str(&raw).unwrap_or_default(),
                created_at: row
                    .get(5)
                    .map_err(|e| sql("pop_queue_head created_at", e))?,
            }))
        })
    }
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
            }],
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
                })
                .unwrap();
        }
        store.enqueue_queue_item(&item("q1", "t1", "first", 10)).unwrap();
        store.enqueue_queue_item(&item("q2", "t1", "second", 20)).unwrap();
        store.enqueue_queue_item(&item("q3", "t2", "other thread", 5)).unwrap();

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
}
