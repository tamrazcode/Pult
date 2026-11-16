//! Store tests. Everything runs against `open_in_memory()` except the two
//! reopen tests, which use uniquely named files under `std::env::temp_dir()`.

use serde_json::json;

use super::*;
use crate::events::{Event, EventKind, PermissionOption, PlanEntry, PlanEntryStatus};

#[test]
fn migration_6_lineage_and_delegated_tasks_are_idempotent_and_orphaned() {
    let store = Store::open_in_memory().unwrap();
    let mut parent = thread("parent", 1);
    parent.status = "working".to_string();
    store.create_thread(&parent).unwrap();
    let mut child = thread("child", 2);
    child.parent_thread_id = Some("parent".to_string());
    child.parent_run_id = Some("parent-run".to_string());
    child.depth = 1;
    child.lineage_kind = Some("subagent".to_string());
    child.child_role = Some("coder".to_string());
    store.create_thread(&child).unwrap();
    store.create_run(&run("parent-run", "parent", 0)).unwrap();

    let loaded = store.get_thread("child").unwrap();
    assert_eq!(loaded.parent_thread_id.as_deref(), Some("parent"));
    assert_eq!(loaded.depth, 1);
    assert_eq!(loaded.child_role.as_deref(), Some("coder"));

    let task = DelegatedTaskRecord {
        id: "task-1".to_string(),
        parent_thread_id: "parent".to_string(),
        parent_run_id: "parent-run".to_string(),
        child_thread_id: "child".to_string(),
        child_run_id: None,
        client_request_id: Some("req-1".to_string()),
        title: "Implement".to_string(),
        prompt_summary: "Do the work".to_string(),
        role: Some("coder".to_string()),
        target_instance_id: "inst-2".to_string(),
        target_model: Some("model-2".to_string()),
        isolation: "shared".to_string(),
        permission_mode: "supervised".to_string(),
        status: "queued".to_string(),
        summary: None,
        error: None,
        started_at: 1_200,
        finished_at: None,
        usage_json: None,
    };
    let (first, deduplicated) = store.insert_or_get_delegated_task(&task).unwrap();
    assert!(!deduplicated);
    let (second, deduplicated) = store.insert_or_get_delegated_task(&task).unwrap();
    assert!(deduplicated);
    assert_eq!(first.id, second.id);
    assert_eq!(store.list_delegated_tasks("parent").unwrap().len(), 1);

    store
        .update_delegated_task_status(
            "task-1",
            &DelegatedTaskUpdate {
                status: "running",
                child_run_id: Some("child-run"),
                summary: None,
                error: None,
                usage_json: None,
                finished_at: None,
            },
        )
        .unwrap();
    assert_eq!(
        store.get_delegated_task("task-1").unwrap().status,
        "running"
    );

    store.reset_orphaned_run_states().unwrap();
    assert_eq!(
        store.get_delegated_task("task-1").unwrap().status,
        "orphaned"
    );
}

fn thread(id: &str, updated_at: i64) -> ThreadRecord {
    ThreadRecord {
        id: id.to_string(),
        project_id: None,
        title: format!("Thread {id}"),
        status: "idle".to_string(),
        pinned: false,
        created_at: 1_000,
        updated_at,
        workspace: None,
        main_repo: None,
        worktree_name: None,
        parent_thread_id: None,
        parent_run_id: None,
        depth: 0,
        lineage_kind: None,
        child_role: None,
    }
}

fn run(id: &str, thread_id: &str, idx: i64) -> RunRecord {
    RunRecord {
        id: id.to_string(),
        thread_id: thread_id.to_string(),
        idx,
        status: "running".to_string(),
        instance_id: "inst-1".to_string(),
        model: Some("test-model".to_string()),
        mode: Some("code".to_string()),
        effort: Some("high".to_string()),
        started_at: 1_100,
        stopped_at: None,
        stop_reason: None,
        error: None,
    }
}

/// A thread plus one run, so events satisfy the FK chain.
fn setup_run(store: &Store, run_id: &str) {
    let t = thread("t-1", 1_000);
    store.create_thread(&t).unwrap();
    store.create_run(&run(run_id, &t.id, 0)).unwrap();
}

/// Deterministic timestamp so round-trip equality never depends on the clock.
fn event(run_id: &str, seq: u64, kind: EventKind) -> Event {
    let mut event = Event::new(run_id, seq, kind);
    event.ts = 1_234_567_890;
    event
}

/// One EventKind of every variant (13 kinds).
fn every_kind() -> Vec<EventKind> {
    vec![
        EventKind::UserMessage {
            text: "hello".to_string(),
            images: Vec::new(),
        },
        EventKind::AgentMessageDelta {
            delta: "hi ".to_string(),
        },
        EventKind::AgentThoughtDelta {
            delta: "thinking".to_string(),
        },
        EventKind::ToolCall {
            tool_call_id: "tc-1".to_string(),
            title: "Read file".to_string(),
            kind: "read".to_string(),
            status: "in_progress".to_string(),
            locations: vec!["/repo/src/main.rs".to_string()],
            raw_input: Some(json!({"path": "/repo/src/main.rs"})),
            meta: None,
        },
        EventKind::ToolCallUpdate {
            tool_call_id: "tc-1".to_string(),
            status: Some("completed".to_string()),
            content: Some(json!({"type": "text", "text": "done"})),
            raw_output: Some(json!({"bytes": 42})),
            meta: None,
        },
        EventKind::Plan {
            entries: vec![
                PlanEntry {
                    content: "step one".to_string(),
                    status: PlanEntryStatus::Completed,
                },
                PlanEntry {
                    content: "step two".to_string(),
                    status: PlanEntryStatus::InProgress,
                },
            ],
        },
        EventKind::ApprovalRequest {
            request_id: "req-1".to_string(),
            tool_call_id: Some("tc-1".to_string()),
            title: "Allow edit?".to_string(),
            options: vec![PermissionOption {
                option_id: "allow".to_string(),
                name: "Allow".to_string(),
                kind: "allow_once".to_string(),
            }],
        },
        EventKind::ApprovalResponse {
            request_id: "req-1".to_string(),
            option_id: Some("allow".to_string()),
            auto: false,
        },
        EventKind::ModeChange {
            mode_id: "code".to_string(),
        },
        EventKind::Notice {
            level: "warn".to_string(),
            message: "slow disk".to_string(),
        },
        EventKind::Compaction {
            status: Some("started".to_string()),
            compaction_id: None,
            summary_replace: None,
            summary_append: None,
        },
        EventKind::Usage {
            detail: json!({"inputTokens": 12, "outputTokens": 34}),
        },
        EventKind::RunFinished {
            stop_reason: "end_turn".to_string(),
            error: None,
        },
    ]
}

fn unique_temp_path(label: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "pult_store_{label}_{}_{}.db",
        std::process::id(),
        nanos
    ))
}

/// Removes the db plus its WAL side files, ignoring missing ones.
fn remove_db_files(path: &std::path::Path) {
    for suffix in ["", "-wal", "-shm"] {
        let mut file = path.as_os_str().to_os_string();
        file.push(suffix);
        let _ = std::fs::remove_file(&file);
    }
}

#[test]
fn round_trips_every_event_kind_losslessly() {
    let store = Store::open_in_memory().unwrap();
    setup_run(&store, "r-1");
    let events: Vec<Event> = every_kind()
        .into_iter()
        .enumerate()
        .map(|(seq, kind)| event("r-1", seq as u64, kind))
        .collect();
    for e in &events {
        store.append_event(e).unwrap();
    }
    let loaded = store.load_events("r-1").unwrap();
    assert_eq!(loaded.len(), 13);
    assert_eq!(loaded, events, "Vec<Event> must be exactly the original");
}

#[test]
fn next_seq_starts_at_zero_and_duplicates_are_rejected() {
    let store = Store::open_in_memory().unwrap();
    setup_run(&store, "r-1");
    assert_eq!(store.next_seq("r-1").unwrap(), 0);

    store
        .append_event(&event(
            "r-1",
            0,
            EventKind::UserMessage {
                text: "first".to_string(),
                images: Vec::new(),
            },
        ))
        .unwrap();
    assert_eq!(store.next_seq("r-1").unwrap(), 1);

    // A gap is allowed: next_seq tracks MAX(seq) + 1.
    store
        .append_event(&event(
            "r-1",
            5,
            EventKind::Notice {
                level: "info".to_string(),
                message: "gap ok".to_string(),
            },
        ))
        .unwrap();
    assert_eq!(store.next_seq("r-1").unwrap(), 6);

    // Duplicate (run_id, seq) must be an error, never a silent overwrite.
    let duplicate = store.append_event(&event(
        "r-1",
        0,
        EventKind::UserMessage {
            text: "overwritten?".to_string(),
            images: Vec::new(),
        },
    ));
    assert!(duplicate.is_err());
    let loaded = store.load_events("r-1").unwrap();
    assert_eq!(loaded.len(), 2);
    assert_eq!(
        loaded[0].kind,
        EventKind::UserMessage {
            text: "first".to_string(),
            images: Vec::new(),
        },
        "original event must survive"
    );
}

#[test]
fn thread_lifecycle_rename_status_pin_list_and_cascade_delete() {
    let store = Store::open_in_memory().unwrap();
    // Inserted out of recency order on purpose.
    store.create_thread(&thread("t-a", 300)).unwrap();
    store.create_thread(&thread("t-c", 100)).unwrap();
    store.create_thread(&thread("t-b", 200)).unwrap();

    store.rename_thread("t-a", "Renamed").unwrap();
    store.set_thread_status("t-a", "active").unwrap();
    store.set_thread_pinned("t-a", true).unwrap();

    let got = store.get_thread("t-a").unwrap();
    assert_eq!(got.title, "Renamed");
    assert_eq!(got.status, "active");
    assert!(got.pinned);
    assert!(got.updated_at > 300, "rename/status bump updated_at");

    let listed = store.list_threads().unwrap();
    let ids: Vec<&str> = listed.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids, vec!["t-a", "t-b", "t-c"], "ordered by updated_at DESC");

    // Cascade material on t-b: a run, an event, and a session ref.
    store.create_run(&run("r-1", "t-b", 0)).unwrap();
    store
        .append_event(&event(
            "r-1",
            0,
            EventKind::UserMessage {
                text: "x".to_string(),
                images: Vec::new(),
            },
        ))
        .unwrap();
    store
        .upsert_session_ref("t-b", "inst-1", "remote-1")
        .unwrap();
    assert_eq!(store.next_seq("r-1").unwrap(), 1);

    store.delete_thread("t-b").unwrap();
    assert!(store.get_thread("t-b").is_err(), "thread deleted");
    assert_eq!(store.next_seq("r-1").unwrap(), 0, "events cascaded");
    assert!(store.load_events("r-1").unwrap().is_empty());
    // Runs cascaded too: re-inserting the same run id would violate the PK
    // if the old row had survived.
    store.create_run(&run("r-1", "t-a", 0)).unwrap();
    assert!(
        store.get_session_ref("t-b", "inst-1").unwrap().is_none(),
        "session refs cleared with the thread"
    );
}

#[test]
fn run_lifecycle_finish_sets_terminal_fields() {
    let store = Store::open_in_memory().unwrap();
    store.create_thread(&thread("t-1", 1_000)).unwrap();
    store.create_run(&run("r-1", "t-1", 0)).unwrap();

    let read_run = |store: &Store| {
        store
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT status, stopped_at, stop_reason FROM runs WHERE id = 'r-1'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<i64>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .map_err(|e| sql("test read run", e))
            })
            .unwrap()
    };

    assert_eq!(read_run(&store), ("running".to_string(), None, None));
    store
        .finish_run("r-1", 5_000, "completed", Some("end_turn"), None)
        .unwrap();
    assert_eq!(
        read_run(&store),
        (
            "completed".to_string(),
            Some(5_000),
            Some("end_turn".to_string())
        )
    );
    assert!(
        store
            .finish_run("missing", 1, "failed", None, None)
            .is_err(),
        "finishing an unknown run errors"
    );
}

#[test]
fn session_ref_upsert_replaces_previous_value() {
    let store = Store::open_in_memory().unwrap();
    store.create_thread(&thread("t-1", 1_000)).unwrap();
    assert_eq!(store.get_session_ref("t-1", "inst-1").unwrap(), None);

    store
        .upsert_session_ref("t-1", "inst-1", "remote-a")
        .unwrap();
    assert_eq!(
        store.get_session_ref("t-1", "inst-1").unwrap().as_deref(),
        Some("remote-a")
    );
    store
        .upsert_session_ref("t-1", "inst-1", "remote-b")
        .unwrap();
    assert_eq!(
        store.get_session_ref("t-1", "inst-1").unwrap().as_deref(),
        Some("remote-b"),
        "upsert replaced the previous ref"
    );

    // A distinct instance keeps its own ref.
    store
        .upsert_session_ref("t-1", "inst-2", "remote-c")
        .unwrap();
    assert_eq!(
        store.get_session_ref("t-1", "inst-1").unwrap().as_deref(),
        Some("remote-b")
    );
    assert_eq!(
        store.get_session_ref("t-1", "inst-2").unwrap().as_deref(),
        Some("remote-c")
    );
}

#[test]
fn settings_round_trip_json() {
    let store = Store::open_in_memory().unwrap();
    assert_eq!(store.get_setting("missing").unwrap(), None);

    let object = json!({"theme": "dark", "zoom": 1.5, "flags": [true, false]});
    store.set_setting("ui", &object).unwrap();
    store.set_setting("name", &json!("pult")).unwrap();
    store.set_setting("count", &json!(7)).unwrap();

    assert_eq!(store.get_setting("ui").unwrap(), Some(object));
    assert_eq!(store.get_setting("name").unwrap(), Some(json!("pult")));
    assert_eq!(store.get_setting("count").unwrap(), Some(json!(7)));

    store.set_setting("count", &json!(8)).unwrap();
    assert_eq!(store.get_setting("count").unwrap(), Some(json!(8)));
}

#[test]
fn export_thread_jsonl_orders_by_run_idx_then_seq() {
    let store = Store::open_in_memory().unwrap();
    store.create_thread(&thread("t-1", 1_000)).unwrap();
    // Create the idx=1 run BEFORE the idx=0 run so the ordering cannot come
    // from insertion order.
    store.create_run(&run("r-2", "t-1", 1)).unwrap();
    store.create_run(&run("r-1", "t-1", 0)).unwrap();
    store
        .append_event(&event(
            "r-2",
            0,
            EventKind::AgentMessageDelta {
                delta: "b0".to_string(),
            },
        ))
        .unwrap();
    store
        .append_event(&event(
            "r-2",
            1,
            EventKind::AgentMessageDelta {
                delta: "b1".to_string(),
            },
        ))
        .unwrap();
    store
        .append_event(&event(
            "r-1",
            0,
            EventKind::AgentMessageDelta {
                delta: "a0".to_string(),
            },
        ))
        .unwrap();
    store
        .append_event(&event(
            "r-1",
            1,
            EventKind::AgentMessageDelta {
                delta: "a1".to_string(),
            },
        ))
        .unwrap();

    let jsonl = store.export_thread_jsonl("t-1").unwrap();
    let lines: Vec<&str> = jsonl.split('\n').collect();
    assert_eq!(lines.len(), 4);

    // Each line parses as a full Event.
    let parsed: Vec<Event> = lines
        .iter()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let ids: Vec<&str> = parsed.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(ids, vec!["r-1-0", "r-1-1", "r-2-0", "r-2-1"]);

    let deltas: Vec<&str> = parsed
        .iter()
        .map(|e| match &e.kind {
            EventKind::AgentMessageDelta { delta } => delta.as_str(),
            other => panic!("unexpected kind: {other:?}"),
        })
        .collect();
    assert_eq!(deltas, vec!["a0", "a1", "b0", "b1"]);

    // Unknown threads export as empty output.
    assert_eq!(store.export_thread_jsonl("nope").unwrap(), "");
}

#[test]
fn data_survives_reopen() {
    let path = unique_temp_path("reopen");
    {
        let store = Store::open(&path).unwrap();
        store.create_thread(&thread("t-1", 1_000)).unwrap();
        store.create_run(&run("r-1", "t-1", 0)).unwrap();
        store
            .append_event(&event(
                "r-1",
                0,
                EventKind::UserMessage {
                    text: "persist".to_string(),
                    images: Vec::new(),
                },
            ))
            .unwrap();
        store.set_setting("k", &json!({"v": 1})).unwrap();
        store
            .upsert_session_ref("t-1", "inst-1", "remote-1")
            .unwrap();
    }

    let reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.get_thread("t-1").unwrap().title, "Thread t-1");
    let events = reopened.load_events("r-1").unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0].kind,
        EventKind::UserMessage {
            text: "persist".to_string(),
            images: Vec::new(),
        }
    );
    assert_eq!(reopened.get_setting("k").unwrap(), Some(json!({"v": 1})));
    assert_eq!(
        reopened
            .get_session_ref("t-1", "inst-1")
            .unwrap()
            .as_deref(),
        Some("remote-1")
    );
    drop(reopened);

    remove_db_files(&path);
    assert!(!path.exists(), "temp db cleaned up");
}

#[test]
fn reopening_runs_migrations_once() {
    let path = unique_temp_path("migrations");

    let first = Store::open(&path).unwrap();
    first.create_thread(&thread("t-1", 1_000)).unwrap();
    let version: i64 = first
        .with_conn(|conn| {
            conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .map_err(|e| sql("read user_version", e))
        })
        .unwrap();
    assert_eq!(version, 7, "migrations applied through v7");
    drop(first);

    let second = Store::open(&path).unwrap();
    assert!(second.get_thread("t-1").is_ok(), "data intact after reopen");
    let versions: i64 = second
        .with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name IN ('threads', 'runs', 'events',
                     'projects', 'provider_session_refs', 'settings')",
                [],
                |row| row.get(0),
            )
            .map_err(|e| sql("count schema tables", e))
        })
        .unwrap();
    assert_eq!(versions, 6, "exactly one of each table, no duplication");
    drop(second);

    remove_db_files(&path);
}

#[test]
fn boot_resets_orphaned_run_states_without_touching_updated_at() {
    let store = Store::open_in_memory().unwrap();
    let mut working = thread("t-work", 5_000);
    working.status = "working".to_string();
    let mut waiting = thread("t-wait", 4_000);
    waiting.status = "waiting".to_string();
    let mut settled = thread("t-settled", 3_000);
    settled.status = "settled".to_string();
    store.create_thread(&working).unwrap();
    store.create_thread(&waiting).unwrap();
    store.create_thread(&settled).unwrap();

    let changed = store.reset_orphaned_run_states().unwrap();
    assert_eq!(changed, 2, "working + waiting reset, others untouched");

    let w = store.get_thread("t-work").unwrap();
    assert_eq!(w.status, "draft");
    assert_eq!(w.updated_at, 5_000, "updated_at not rewritten");
    let s = store.get_thread("t-settled").unwrap();
    assert_eq!(s.status, "settled");

    // Idempotent: a second boot finds nothing to reset.
    assert_eq!(store.reset_orphaned_run_states().unwrap(), 0);
}

#[test]
fn append_events_batch_is_atomic_and_inserts_all() {
    let store = Store::open_in_memory().unwrap();
    setup_run(&store, "r-1");

    let batch: Vec<Event> = (0..100u64)
        .map(|seq| {
            event(
                "r-1",
                seq,
                EventKind::AgentMessageDelta {
                    delta: format!("chunk-{seq}"),
                },
            )
        })
        .collect();
    store.append_events_batch(&batch).unwrap();

    let loaded = store.load_events("r-1").unwrap();
    assert_eq!(loaded.len(), 100);
    assert_eq!(loaded, batch);

    // Empty batch should succeed as a no-op.
    store.append_events_batch(&[]).unwrap();

    // A batch whose middle event duplicates an existing (run_id, seq) must
    // error and roll back the entire transaction so none of it is inserted.
    let mut dup = event(
        "r-1",
        50,
        EventKind::Notice {
            level: "info".to_string(),
            message: "duplicate".to_string(),
        },
    );
    dup.id = "r-1-dup-50".to_string();
    let bad_batch = vec![
        event(
            "r-1",
            100,
            EventKind::Notice {
                level: "info".to_string(),
                message: "before conflict".to_string(),
            },
        ),
        dup,
        event(
            "r-1",
            101,
            EventKind::Notice {
                level: "info".to_string(),
                message: "after conflict".to_string(),
            },
        ),
    ];
    assert!(store.append_events_batch(&bad_batch).is_err());

    let after_rollback = store.load_events("r-1").unwrap();
    assert_eq!(after_rollback.len(), 100);
    assert_eq!(after_rollback, batch);
}

#[test]
fn load_thread_events_orders_across_runs() {
    let store = Store::open_in_memory().unwrap();
    store.create_thread(&thread("t-1", 1_000)).unwrap();
    store.create_thread(&thread("t-other", 1_000)).unwrap();

    // Create idx=1 before idx=0 and interleave seq inserts so order cannot
    // come from insertion order.
    store.create_run(&run("r-2", "t-1", 1)).unwrap();
    store.create_run(&run("r-1", "t-1", 0)).unwrap();
    store.create_run(&run("r-other", "t-other", 0)).unwrap();

    store
        .append_events_batch(&[
            event(
                "r-2",
                2,
                EventKind::AgentMessageDelta {
                    delta: "r2-2".to_string(),
                },
            ),
            event(
                "r-1",
                1,
                EventKind::AgentMessageDelta {
                    delta: "r1-1".to_string(),
                },
            ),
            event(
                "r-other",
                0,
                EventKind::Notice {
                    level: "info".to_string(),
                    message: "other".to_string(),
                },
            ),
            event(
                "r-2",
                0,
                EventKind::UserMessage {
                    text: "r2-0".to_string(),
                    images: Vec::new(),
                },
            ),
            event(
                "r-1",
                0,
                EventKind::UserMessage {
                    text: "r1-0".to_string(),
                    images: Vec::new(),
                },
            ),
            event(
                "r-2",
                1,
                EventKind::AgentMessageDelta {
                    delta: "r2-1".to_string(),
                },
            ),
        ])
        .unwrap();

    let loaded = store.load_thread_events("t-1").unwrap();
    let ids: Vec<&str> = loaded.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(ids, vec!["r-1-0", "r-1-1", "r-2-0", "r-2-1", "r-2-2"]);
    assert!(store
        .load_thread_events("missing-thread")
        .unwrap()
        .is_empty());
}

#[test]
fn migration_v3_to_v4_preserves_threads_and_adds_projects_pinned() {
    let path = unique_temp_path("migration_v3_to_v4");
    remove_db_files(&path);

    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys = ON;
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
                updated_at INTEGER NOT NULL,
                workspace TEXT,
                main_repo TEXT,
                worktree_name TEXT
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
                stop_reason TEXT,
                error TEXT
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
            CREATE TABLE queue_items (
                id TEXT PRIMARY KEY,
                thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                instance_id TEXT NOT NULL,
                text TEXT NOT NULL,
                images TEXT NOT NULL DEFAULT '[]',
                created_at INTEGER NOT NULL
            );
            PRAGMA user_version = 3;
            "#,
        )
        .unwrap();

        conn.execute(
            "INSERT INTO projects (id, name, root_path, color, worktree_strategy, created_at)
             VALUES ('p-1', 'Pult', '/tmp/pult', '#346bf1', 'root', 1000)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO threads (id, project_id, title, status, pinned, created_at, updated_at, workspace)
             VALUES ('t-1', 'p-1', 'Existing thread', 'draft', 0, 1000, 2000, '/tmp/pult')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO queue_items (id, thread_id, instance_id, text, images, created_at)
             VALUES ('q-1', 't-1', 'inst-1', 'queued v3', '[]', 1500)",
            [],
        )
        .unwrap();
    }

    let store = Store::open(&path).unwrap();

    let version: i64 = store
        .with_conn(|conn| {
            conn.query_row("PRAGMA user_version", [], |row| row.get(0))
                .map_err(|e| sql("read user_version", e))
        })
        .unwrap();
    assert_eq!(version, 7, "migrations v4-v7 should bump user_version to 7");

    let has_pinned_col: bool = store
        .with_conn(|conn| {
            let mut stmt = conn
                .prepare("PRAGMA table_info(projects)")
                .map_err(|e| sql("pragma table_info", e))?;
            let cols = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|e| sql("pragma table_info rows", e))?;
            for col in cols {
                if col.map_err(|e| sql("col name", e))? == "pinned" {
                    return Ok(true);
                }
            }
            Ok(false)
        })
        .unwrap();
    assert!(
        has_pinned_col,
        "projects.pinned column must exist after v4 migration"
    );

    let queue_cols: Vec<String> = store
        .with_conn(|conn| {
            let mut stmt = conn
                .prepare("PRAGMA table_info(queue_items)")
                .map_err(|e| sql("pragma table_info queue_items", e))?;
            let cols = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|e| sql("pragma table_info queue_items rows", e))?;
            let mut out = Vec::new();
            for col in cols {
                out.push(col.map_err(|e| sql("queue col name", e))?);
            }
            Ok(out)
        })
        .unwrap();
    for expected in ["mode", "config_options", "claiming_run_id"] {
        assert!(
            queue_cols.iter().any(|c| c == expected),
            "queue_items.{expected} column must exist after v5 migration; got {queue_cols:?}"
        );
    }

    let raw_pinned: i64 = store
        .with_conn(|conn| {
            conn.query_row("SELECT pinned FROM projects WHERE id = 'p-1'", [], |row| {
                row.get(0)
            })
            .map_err(|e| sql("read project pinned", e))
        })
        .unwrap();
    assert_eq!(raw_pinned, 0, "projects.pinned must default to 0");

    let proj = store.get_project("p-1").unwrap();
    assert_eq!(proj.name, "Pult");
    assert!(!proj.pinned);

    let preserved = store.get_thread("t-1").unwrap();
    assert_eq!(preserved.project_id.as_deref(), Some("p-1"));
    assert_eq!(preserved.title, "Existing thread");
    assert_eq!(preserved.workspace.as_deref(), Some("/tmp/pult"));
    assert_eq!(preserved.updated_at, 2_000);

    let queued = store.list_queue("t-1").unwrap();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].id, "q-1");
    assert_eq!(queued[0].mode, None);
    assert!(queued[0].config_options.is_empty());

    drop(store);
    remove_db_files(&path);
}

#[test]
fn projects_crud_ordering_partial_update_and_delete() {
    use crate::store::records::ProjectRecord;

    let store = Store::open_in_memory().unwrap();
    let p_alpha = ProjectRecord {
        id: "p-alpha".to_string(),
        name: "Alpha".to_string(),
        root_path: "/tmp/alpha".to_string(),
        color: Some("#10b981".to_string()),
        worktree_strategy: "root".to_string(),
        pinned: false,
        created_at: 1_000,
    };
    let p_beta = ProjectRecord {
        id: "p-beta".to_string(),
        name: "Beta".to_string(),
        root_path: "/tmp/beta".to_string(),
        color: None,
        worktree_strategy: "root".to_string(),
        pinned: false,
        created_at: 2_000,
    };
    let p_pinned = ProjectRecord {
        id: "p-pinned".to_string(),
        name: "Zeta".to_string(),
        root_path: "/tmp/zeta".to_string(),
        color: Some("#346bf1".to_string()),
        worktree_strategy: "worktree".to_string(),
        pinned: true,
        created_at: 500,
    };

    store.create_project(&p_alpha).unwrap();
    store.create_project(&p_beta).unwrap();
    store.create_project(&p_pinned).unwrap();

    assert_eq!(store.get_project("p-alpha").unwrap(), p_alpha);

    let listed = store.list_projects().unwrap();
    assert_eq!(listed.len(), 3);
    assert_eq!(
        listed[0].id, "p-pinned",
        "pinned project must sort before unpinned projects regardless of name/created_at"
    );

    // Partial update: only name + color
    let updated = store
        .update_project(
            "p-alpha",
            Some("Alpha Renamed"),
            Some("#ef4444"),
            None,
            None,
        )
        .unwrap();
    assert_eq!(updated.name, "Alpha Renamed");
    assert_eq!(updated.color.as_deref(), Some("#ef4444"));
    assert_eq!(updated.worktree_strategy, "root");
    assert!(!updated.pinned);

    // Partial update: only worktree_strategy + pinned
    let updated2 = store
        .update_project("p-alpha", None, None, Some("worktree"), Some(true))
        .unwrap();
    assert_eq!(updated2.name, "Alpha Renamed");
    assert_eq!(updated2.color.as_deref(), Some("#ef4444"));
    assert_eq!(updated2.worktree_strategy, "worktree");
    assert!(updated2.pinned);

    let fetched = store.get_project("p-alpha").unwrap();
    assert_eq!(fetched, updated2);

    store.delete_project("p-beta").unwrap();
    assert!(
        store.get_project("p-beta").is_err(),
        "deleted project must error on get_project"
    );
    assert_eq!(store.list_projects().unwrap().len(), 2);
}

#[test]
fn delete_project_nulls_thread_project_id_without_deleting_thread() {
    use crate::store::records::ProjectRecord;

    let store = Store::open_in_memory().unwrap();
    let project = ProjectRecord {
        id: "p-del".to_string(),
        name: "Disposable".to_string(),
        root_path: "/tmp/disposable".to_string(),
        color: None,
        worktree_strategy: "root".to_string(),
        pinned: false,
        created_at: 1_000,
    };
    store.create_project(&project).unwrap();

    let mut th = thread("t-proj", 2_000);
    th.project_id = Some("p-del".to_string());
    th.workspace = Some("/tmp/disposable".to_string());
    store.create_thread(&th).unwrap();

    store.delete_project("p-del").unwrap();

    assert!(store.get_project("p-del").is_err());
    let surviving = store.get_thread("t-proj").unwrap();
    assert_eq!(surviving.id, "t-proj");
    assert_eq!(
        surviving.project_id, None,
        "deleting project must NULL out thread.project_id"
    );
    assert_eq!(surviving.workspace.as_deref(), Some("/tmp/disposable"));
}

#[tokio::test]
async fn threads_create_defaults_workspace_and_worktree_from_project() {
    use crate::runtime::{AgentRuntime, EventSink};
    use crate::store::records::ProjectRecord;
    use std::sync::Arc;

    struct NullSink;
    impl EventSink for NullSink {
        fn emit(&self, _event: &str, _payload: serde_json::Value) -> Result<(), String> {
            Ok(())
        }
        fn notify(&self, _title: &str, _body: &str) {}
    }

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root_dir =
        std::env::temp_dir().join(format!("pult_proj_root_{}_{}", std::process::id(), nanos));
    let wt_repo_dir =
        std::env::temp_dir().join(format!("pult_proj_wt_{}_{}", std::process::id(), nanos));
    std::fs::create_dir_all(&root_dir).unwrap();
    std::fs::create_dir_all(&wt_repo_dir).unwrap();

    // Initialize a real git repo for the worktree_strategy = "worktree" project.
    for args in [
        &["init", "-q", "-b", "main"][..],
        &["config", "user.email", "t@t"][..],
        &["config", "user.name", "t"][..],
    ] {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(&wt_repo_dir)
            .output()
            .expect("git init/config");
        assert!(out.status.success(), "git {args:?} failed");
    }
    std::fs::write(wt_repo_dir.join("README.md"), "hello\n").unwrap();
    for args in [&["add", "."][..], &["commit", "-q", "-m", "init"][..]] {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(&wt_repo_dir)
            .output()
            .expect("git add/commit");
        assert!(out.status.success(), "git {args:?} failed");
    }

    let store = Arc::new(Store::open_in_memory().unwrap());
    let runtime = Arc::new(AgentRuntime::new(Arc::clone(&store), Arc::new(NullSink)));

    let root_canon = root_dir
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let wt_canon = wt_repo_dir
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .into_owned();

    store
        .create_project(&ProjectRecord {
            id: "proj-root".to_string(),
            name: "RootProj".to_string(),
            root_path: root_canon.clone(),
            color: None,
            worktree_strategy: "root".to_string(),
            pinned: false,
            created_at: 1_000,
        })
        .unwrap();
    store
        .create_project(&ProjectRecord {
            id: "proj-wt".to_string(),
            name: "WtProj".to_string(),
            root_path: wt_canon.clone(),
            color: None,
            worktree_strategy: "worktree".to_string(),
            pinned: false,
            created_at: 2_000,
        })
        .unwrap();

    // 1. Project with worktree_strategy = "root" and no explicit workspace/worktree override:
    let t_root = crate::ipc::create_thread_with_runtime(
        &runtime,
        Some("proj-root".to_string()),
        "Root thread".to_string(),
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(t_root.project_id.as_deref(), Some("proj-root"));
    assert_eq!(
        std::fs::canonicalize(t_root.workspace.as_deref().unwrap()).unwrap(),
        std::fs::canonicalize(&root_canon).unwrap(),
        "thread created with project_id must default workspace to project.root_path"
    );
    assert!(t_root.main_repo.is_none());
    assert!(t_root.worktree_name.is_none());

    // 2. Project with worktree_strategy = "worktree" and no explicit worktree override:
    let t_wt = crate::ipc::create_thread_with_runtime(
        &runtime,
        Some("proj-wt".to_string()),
        "Worktree thread".to_string(),
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(t_wt.project_id.as_deref(), Some("proj-wt"));
    assert!(
        t_wt.worktree_name.is_some(),
        "must create worktree when project.worktree_strategy == 'worktree'"
    );
    assert_eq!(
        std::fs::canonicalize(t_wt.main_repo.as_deref().unwrap()).unwrap(),
        std::fs::canonicalize(&wt_canon).unwrap()
    );
    let wt_ws = std::fs::canonicalize(t_wt.workspace.as_deref().unwrap()).unwrap();
    assert!(wt_ws.is_dir());
    assert_ne!(wt_ws, std::fs::canonicalize(&wt_canon).unwrap());

    // 3. Explicit caller override worktree = Some(false) overrides project.worktree_strategy:
    let t_override = crate::ipc::create_thread_with_runtime(
        &runtime,
        Some("proj-wt".to_string()),
        "Override thread".to_string(),
        None,
        Some(false),
    )
    .await
    .unwrap();
    assert!(t_override.worktree_name.is_none());
    assert!(t_override.main_repo.is_none());
    assert_eq!(
        std::fs::canonicalize(t_override.workspace.as_deref().unwrap()).unwrap(),
        std::fs::canonicalize(&wt_canon).unwrap()
    );

    let _ = std::fs::remove_dir_all(&root_dir);
    let _ = std::fs::remove_dir_all(&wt_repo_dir);
}

#[test]
fn queue_item_persists_mode_and_config_snapshot_and_recovers_orphaned_claim() {
    use crate::protocol::types::ConfigOptionValue;
    use crate::store::records::QueueItem;
    use std::collections::BTreeMap;

    let path = unique_temp_path("queue_claim_recovery");
    remove_db_files(&path);

    let mut config_options = BTreeMap::new();
    config_options.insert(
        "model".to_string(),
        ConfigOptionValue::String("gpt-5".to_string()),
    );

    let item = QueueItem {
        id: "q-1".to_string(),
        thread_id: "t-1".to_string(),
        instance_id: "inst-1".to_string(),
        text: "queued with snapshot".to_string(),
        images: Vec::new(),
        mode: Some("plan".to_string()),
        config_options: config_options.clone(),
        created_at: 1_000,
    };

    {
        let store = Store::open(&path).unwrap();
        store.create_thread(&thread("t-1", 1_000)).unwrap();
        store.enqueue_queue_item(&item).unwrap();

        let listed = store.list_queue("t-1").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].mode.as_deref(), Some("plan"));
        assert_eq!(listed[0].config_options, config_options);

        let claimed = store
            .claim_queue_head("t-1", "claim-token-1")
            .unwrap()
            .expect("head should be claimed");
        assert_eq!(claimed.id, "q-1");
        assert_eq!(claimed.mode.as_deref(), Some("plan"));
        assert_eq!(claimed.config_options, config_options);
        assert!(store.list_queue("t-1").unwrap().is_empty());
        assert!(store
            .claim_queue_head("t-1", "claim-token-2")
            .unwrap()
            .is_none());

        store.release_queue_claim("q-1").unwrap();
        assert_eq!(store.list_queue("t-1").unwrap().len(), 1);

        let reclaimed = store
            .claim_queue_head("t-1", "claim-token-3")
            .unwrap()
            .expect("head should be reclaimed after release");
        assert_eq!(reclaimed.id, "q-1");
    }

    // Reopen and simulate boot recovery before commit_claimed_queue_run ran.
    let reopened = Store::open(&path).unwrap();
    reopened.reset_orphaned_run_states().unwrap();

    let recovered = reopened.list_queue("t-1").unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].id, "q-1");
    assert_eq!(recovered[0].mode.as_deref(), Some("plan"));
    assert_eq!(recovered[0].config_options, config_options);

    drop(reopened);
    remove_db_files(&path);
}

#[test]
fn commit_claimed_queue_run_atomically_persists_run_event_and_deletes_queue_row() {
    use crate::store::records::QueueItem;
    use std::collections::BTreeMap;

    let store = Store::open_in_memory().unwrap();
    store.create_thread(&thread("t-1", 1_000)).unwrap();

    let item = QueueItem {
        id: "q-1".to_string(),
        thread_id: "t-1".to_string(),
        instance_id: "inst-1".to_string(),
        text: "commit me".to_string(),
        images: Vec::new(),
        mode: Some("code".to_string()),
        config_options: BTreeMap::new(),
        created_at: 1_000,
    };
    store.enqueue_queue_item(&item).unwrap();
    let claimed = store
        .claim_queue_head("t-1", "r-1")
        .unwrap()
        .expect("claimed head");
    assert_eq!(claimed.id, "q-1");

    let r1 = run("r-1", "t-1", 0);
    let ev1 = event(
        "r-1",
        0,
        EventKind::UserMessage {
            text: "commit me".to_string(),
            images: Vec::new(),
        },
    );
    store.commit_claimed_queue_run("q-1", &r1, &ev1).unwrap();

    assert_eq!(store.list_runs("t-1").unwrap(), vec![r1]);
    assert_eq!(store.load_events("r-1").unwrap(), vec![ev1]);
    assert!(store.list_queue("t-1").unwrap().is_empty());
    let raw_count: i64 = store
        .with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM queue_items WHERE id = 'q-1'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| sql("count queue_items", e))
        })
        .unwrap();
    assert_eq!(raw_count, 0);

    // Rollback check: if event insert fails (FK on missing run_id), run + queue delete roll back together.
    let item2 = QueueItem {
        id: "q-2".to_string(),
        thread_id: "t-1".to_string(),
        instance_id: "inst-1".to_string(),
        text: "rollback me".to_string(),
        images: Vec::new(),
        mode: None,
        config_options: BTreeMap::new(),
        created_at: 2_000,
    };
    store.enqueue_queue_item(&item2).unwrap();
    store.claim_queue_head("t-1", "r-2").unwrap().unwrap();

    let r2 = run("r-2", "t-1", 1);
    let bad_ev = event(
        "missing-run-fk",
        0,
        EventKind::UserMessage {
            text: "should fail".to_string(),
            images: Vec::new(),
        },
    );
    assert!(store.commit_claimed_queue_run("q-2", &r2, &bad_ev).is_err());
    assert_eq!(
        store.list_runs("t-1").unwrap().len(),
        1,
        "r-2 must roll back"
    );
    let raw_q2: i64 = store
        .with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM queue_items WHERE id = 'q-2'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| sql("count q-2", e))
        })
        .unwrap();
    assert_eq!(raw_q2, 1, "q-2 must remain on rollback");
}
