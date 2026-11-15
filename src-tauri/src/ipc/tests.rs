use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use super::{cap_ui_event_payloads, threads_delete_inner};
use crate::events::{now_millis, Event, EventKind};
use crate::runtime::{AgentRuntime, EventSink};
use crate::store::records::ThreadRecord;
use crate::store::Store;

static SEQ: AtomicU64 = AtomicU64::new(0);

struct NoopSink;

impl EventSink for NoopSink {
    fn emit(&self, _event: &str, _payload: serde_json::Value) -> Result<(), String> {
        Ok(())
    }

    fn notify(&self, _title: &str, _body: &str) {}
}

struct TempRepo(PathBuf);

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn git_sync(dir: &Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .expect("git spawn");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn init_repo() -> TempRepo {
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("pult-ipc-wt-test-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("mkdir repo");
    git_sync(&dir, &["init", "-q", "-b", "main"]);
    git_sync(&dir, &["config", "user.email", "t@t"]);
    git_sync(&dir, &["config", "user.name", "t"]);
    git_sync(&dir, &["config", "core.autocrlf", "false"]);
    std::fs::write(dir.join("tracked.txt"), "base\n").expect("write tracked");
    git_sync(&dir, &["add", "."]);
    git_sync(&dir, &["commit", "-q", "-m", "base"]);
    let info_dir = dir.join(".git").join("info");
    std::fs::create_dir_all(&info_dir).expect("mkdir .git/info");
    std::fs::write(info_dir.join("exclude"), ".pult/\n").expect("write exclude");
    TempRepo(dir)
}

fn add_worktree(repo: &Path, name: &str) -> PathBuf {
    let wt_dir = repo.join(".pult").join("worktrees").join(name);
    std::fs::create_dir_all(wt_dir.parent().unwrap()).expect("mkdir worktrees");
    let branch = format!("pult/{name}");
    let wt_str = wt_dir.to_string_lossy().into_owned();
    git_sync(repo, &["worktree", "add", "-q", "-b", &branch, &wt_str]);
    wt_dir
}

fn seed_worktree_thread(
    runtime: &AgentRuntime,
    id: &str,
    repo: &Path,
    wt_name: &str,
    wt_dir: &Path,
) {
    let now = now_millis();
    let record = ThreadRecord {
        id: id.to_string(),
        project_id: None,
        title: format!("Thread {id}"),
        status: "draft".to_string(),
        pinned: false,
        created_at: now,
        updated_at: now,
        workspace: Some(wt_dir.to_string_lossy().into_owned()),
        main_repo: Some(repo.to_string_lossy().into_owned()),
        worktree_name: Some(wt_name.to_string()),
    };
    runtime.store().create_thread(&record).expect("create thread");
}

#[tokio::test]
async fn threads_delete_refuses_dirty_worktree_without_force_and_preserves_thread_row() {
    let repo = init_repo();
    let store = Arc::new(Store::open_in_memory().expect("in-memory store"));
    let runtime = Arc::new(AgentRuntime::new(store, Arc::new(NoopSink)));

    // Safe mode refuses dirty worktree; keep mode drops row while leaving dir intact.
    let wt_keep_name = "wt-keep";
    let wt_keep_dir = add_worktree(&repo.0, wt_keep_name);
    let untracked_keep = wt_keep_dir.join("draft.txt");
    std::fs::write(&untracked_keep, "keep me\n").expect("write untracked");
    seed_worktree_thread(&runtime, "th-keep", &repo.0, wt_keep_name, &wt_keep_dir);

    let err = threads_delete_inner(&runtime, "th-keep", Some("safe"))
        .await
        .expect_err("safe mode must refuse dirty worktree");
    assert_eq!(err.code(), "git.worktree_dirty");
    assert!(
        runtime.store().get_thread("th-keep").is_ok(),
        "thread row must still exist after refused safe delete"
    );
    assert!(
        untracked_keep.exists(),
        "untracked file must still exist after refused safe delete"
    );

    threads_delete_inner(&runtime, "th-keep", Some("keep"))
        .await
        .expect("keep mode must delete thread row without touching worktree");
    assert!(
        runtime.store().get_thread("th-keep").is_err(),
        "thread row must be deleted in keep mode"
    );
    assert!(wt_keep_dir.exists(), "worktree dir must still exist in keep mode");
    assert!(untracked_keep.exists(), "untracked file must still exist in keep mode");

    // force_remove deletes both the thread row and the dirty worktree directory.
    let wt_force_name = "wt-force";
    let wt_force_dir = add_worktree(&repo.0, wt_force_name);
    std::fs::write(wt_force_dir.join("discard.txt"), "discard me\n").expect("write untracked");
    seed_worktree_thread(&runtime, "th-force", &repo.0, wt_force_name, &wt_force_dir);

    threads_delete_inner(&runtime, "th-force", Some("force_remove"))
        .await
        .expect("force_remove must delete dirty worktree");
    assert!(
        runtime.store().get_thread("th-force").is_err(),
        "thread row must be deleted in force_remove mode"
    );
    assert!(
        !wt_force_dir.exists(),
        "worktree dir must be removed in force_remove mode"
    );
}

#[test]
fn cap_ui_event_payloads_enforces_total_history_budget() {
    let mut events: Vec<Event> = (0..20)
        .map(|i| {
            Event::new(
                "run-1",
                i,
                EventKind::ToolCall {
                    tool_call_id: format!("tc-{i}"),
                    title: "Read".to_string(),
                    kind: "read".to_string(),
                    status: "completed".to_string(),
                    locations: Vec::new(),
                    raw_input: Some(serde_json::json!({ "data": "A".repeat(1_500_000) })),
                },
            )
        })
        .collect();

    cap_ui_event_payloads(&mut events);

    let serialized_len = serde_json::to_string(&events)
        .expect("serialize capped events")
        .len();
    assert!(
        serialized_len < 16_000_000,
        "expected total serialized JSON < 16_000_000, got {serialized_len}"
    );
    match &events[0].kind {
        EventKind::ToolCall { raw_input, .. } => {
            assert_eq!(raw_input.as_ref().expect("truncated oldest")["truncated"], true);
        }
        other => panic!("unexpected kind: {other:?}"),
    }
    match &events[19].kind {
        EventKind::ToolCall { raw_input, .. } => {
            assert!(raw_input.as_ref().expect("newest payload")["truncated"].is_null());
        }
        other => panic!("unexpected kind: {other:?}"),
    }
}
