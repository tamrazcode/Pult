//! Append-only event log persistence and thread JSONL export.
//!
//! Column mapping: `id`/`run_id`/`seq`/`ts` are stored directly; `kind` holds
//! the serde enum tag (e.g. "tool_call") and `payload` the JSON of the payload
//! value. Reconstruction reassembles the tagged JSON and deserializes through
//! serde, so round-trips are lossless.

use rusqlite::{params, Row};
use serde_json::json;

use crate::events::Event;
use crate::PultError;

use super::{sql, Store};

/// Raw columns of one stored event, in SELECT order.
type EventRow = (String, String, i64, i64, String, String);

impl Store {
    /// Appends an event. A duplicate (run_id, seq) is an error — the log is
    /// append-only and never overwritten.
    pub fn append_event(&self, event: &Event) -> Result<(), PultError> {
        let (kind, payload) = split_kind(event)?;
        self.with_conn(|conn| {
            match conn.execute(
                "INSERT INTO events (id, run_id, seq, ts, kind, payload)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![event.id, event.run_id, event.seq as i64, event.ts, kind, payload],
            ) {
                Ok(_) => Ok(()),
                Err(e) if is_unique_violation(&e) => Err(PultError::store(format!(
                    "append_event: duplicate (run_id, seq) = ({}, {})",
                    event.run_id, event.seq
                ))),
                Err(e) => Err(sql("append_event insert", e)),
            }
        })
    }

    /// The next per-run sequence number: MAX(seq) + 1, or 0 for an empty run.
    pub fn next_seq(&self, run_id: &str) -> Result<u64, PultError> {
        self.with_conn(|conn| {
            let next: i64 = conn
                .query_row(
                    "SELECT COALESCE(MAX(seq), -1) + 1 FROM events WHERE run_id = ?1",
                    [run_id],
                    |row| row.get(0),
                )
                .map_err(|e| sql("next_seq select", e))?;
            Ok(next as u64)
        })
    }

    /// Every event of one run, ordered by `seq`.
    pub fn load_events(&self, run_id: &str) -> Result<Vec<Event>, PultError> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, run_id, seq, ts, kind, payload FROM events
                     WHERE run_id = ?1 ORDER BY seq ASC",
                )
                .map_err(|e| sql("load_events prepare", e))?;
            let rows = stmt
                .query_map([run_id], event_row)
                .map_err(|e| sql("load_events query", e))?;
            read_events(rows, "load_events row")
        })
    }

    /// One JSON object per line — the full `Event` serialization — for every
    /// event across the thread's runs, ordered by run `idx` then `seq`.
    /// Unknown threads export as an empty string.
    pub fn export_thread_jsonl(&self, thread_id: &str) -> Result<String, PultError> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT e.id, e.run_id, e.seq, e.ts, e.kind, e.payload
                     FROM events AS e JOIN runs AS r ON r.id = e.run_id
                     WHERE r.thread_id = ?1
                     ORDER BY r.idx ASC, e.seq ASC",
                )
                .map_err(|e| sql("export_thread_jsonl prepare", e))?;
            let rows = stmt
                .query_map([thread_id], event_row)
                .map_err(|e| sql("export_thread_jsonl query", e))?;
            let events = read_events(rows, "export_thread_jsonl row")?;
            let mut lines = Vec::with_capacity(events.len());
            for event in &events {
                let line = serde_json::to_string(event)
                    .map_err(|e| PultError::store(format!("export_thread_jsonl encode: {e}")))?;
                lines.push(line);
            }
            Ok(lines.join("\n"))
        })
    }
}

/// Splits an `EventKind` into its stored columns: the serde tag ("tool_call")
/// and the payload JSON.
fn split_kind(event: &Event) -> Result<(String, String), PultError> {
    let value = serde_json::to_value(&event.kind).map_err(|e| {
        PultError::store(format!("append_event encode kind (id {}): {e}", event.id))
    })?;
    let kind = value["kind"]
        .as_str()
        .ok_or_else(|| {
            PultError::store(format!("append_event: event {} has no kind tag", event.id))
        })?
        .to_string();
    let payload = serde_json::to_string(value.get("payload").unwrap_or(&serde_json::Value::Null))
        .map_err(|e| {
            PultError::store(format!("append_event encode payload (id {}): {e}", event.id))
        })?;
    Ok((kind, payload))
}

/// Duplicate (run_id, seq) or duplicate event id — both are append conflicts.
fn is_unique_violation(err: &rusqlite::Error) -> bool {
    matches!(
        err.sqlite_error_code(),
        Some(rusqlite::ErrorCode::ConstraintViolation)
    )
}

fn event_row(row: &Row<'_>) -> rusqlite::Result<EventRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
    ))
}

fn read_events(
    rows: impl Iterator<Item = rusqlite::Result<EventRow>>,
    action: &str,
) -> Result<Vec<Event>, PultError> {
    let mut events = Vec::new();
    for row in rows {
        let (id, run_id, seq, ts, kind, payload) = row.map_err(|e| sql(action, e))?;
        events.push(decode_event(id, run_id, seq, ts, &kind, &payload)?);
    }
    Ok(events)
}

/// Rebuilds an `Event` from stored columns: the kind tag and payload JSON are
/// merged with id/run_id/seq/ts into the tagged JSON shape and deserialized.
fn decode_event(
    id: String,
    run_id: String,
    seq: i64,
    ts: i64,
    kind: &str,
    payload: &str,
) -> Result<Event, PultError> {
    let payload: serde_json::Value = serde_json::from_str(payload)
        .map_err(|e| PultError::store(format!("decode event payload (id {id}): {e}")))?;
    serde_json::from_value(json!({
        "id": id,
        "runId": run_id,
        "seq": seq,
        "ts": ts,
        "kind": kind,
        "payload": payload,
    }))
    .map_err(|e| PultError::store(format!("decode event (id {id}): {e}")))
}
