//! Runtime-level golden tests against the real mock agent: queue
//! auto-dispatch, resume, and the M3 callbacks (permission modes,
//! elicitation, terminals). These run through `AgentRuntime` (store + emit +
//! run loop), unlike `drivers/golden.rs` which drives `AcpConn` directly.
//!
//! `env_lock` guards the process-env mutations; it is deliberately held for
//! a whole test body (env reads happen inside sync dispatch calls), which
//! clippy's await-holding lint cannot see through.

#![allow(clippy::await_holding_lock)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::events::EventKind;
use crate::runtime::{AgentRuntime, EventSink};
use crate::store::records::ThreadRecord;
use crate::store::Store;

/// Both runtime tests mutate process env (PULT_MOCK_AGENT / PULT_WORKSPACE);
/// sends read env synchronously, so a short-held std mutex serializes them.
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// In-memory event sink: records emissions so tests can answer the
/// permission requests the runtime surfaces (the real UI answers those).
#[derive(Default)]
struct TestSink(
    Mutex<Vec<(String, serde_json::Value)>>,
    Mutex<Vec<crate::events::RunTiming>>,
);

impl EventSink for TestSink {
    fn emit(&self, event: &str, payload: serde_json::Value) -> Result<(), String> {
        self.0.lock().expect("sink lock").push((event.to_string(), payload));
        Ok(())
    }

    fn emit_run_timing(&self, timing: &crate::events::RunTiming) {
        self.1.lock().expect("timing lock").push(timing.clone());
    }

    fn notify(&self, title: &str, body: &str) {
        self.0
            .lock()
            .expect("sink lock")
            .push(("notify".to_string(), serde_json::json!({ "title": title, "body": body })));
    }
}

impl TestSink {
    fn timings(&self) -> Vec<crate::events::RunTiming> {
        self.1.lock().expect("timing lock").clone()
    }

    /// Drains every recorded permission request as
    /// (run_id, request_id, first offered option_id).
    fn take_permissions(&self) -> Vec<(String, String, String)> {
        let mut guard = self.0.lock().expect("sink lock");
        let mut out = Vec::new();
        guard.retain(|(event, payload)| {
            if event == "permission:request" {
                let run_id = payload["runId"].as_str().unwrap_or_default().to_string();
                let request_id = payload["requestId"].as_str().unwrap_or_default().to_string();
                let option_id = payload["options"]
                    .as_array()
                    .and_then(|o| o.first())
                    .and_then(|o| o["optionId"].as_str())
                    .unwrap_or_default()
                    .to_string();
                if !run_id.is_empty() && !request_id.is_empty() {
                    out.push((run_id, request_id, option_id));
                    return false;
                }
            }
            true
        });
        out
    }
}

fn mock_runtime() -> (Arc<AgentRuntime>, Arc<TestSink>) {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .try_init();
    let store = Arc::new(Store::open_in_memory().expect("in-memory store"));
    let sink = Arc::new(TestSink::default());
    let runtime = Arc::new(AgentRuntime::new(store, Arc::clone(&sink) as Arc<dyn EventSink>));
    (runtime, sink)
}

/// Background pump: answers every surfaced permission request with the first
/// offered option (mirrors the supervised UI pressing "Allow").
fn spawn_permission_pump(runtime: &Arc<AgentRuntime>, sink: &Arc<TestSink>) -> tokio::task::JoinHandle<()> {
    let runtime = Arc::clone(runtime);
    let sink = Arc::clone(sink);
    tokio::spawn(async move {
        loop {
            for (run_id, request_id, option_id) in sink.take_permissions() {
                let _ = runtime.respond_permission(&run_id, &request_id, Some(option_id));
            }
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    })
}

fn fixture_path() -> std::path::PathBuf {
    let mut candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("fixtures/mock-acp-agent.mjs"));
        candidates.push(cwd.join("../fixtures/mock-acp-agent.mjs"));
    }
    candidates.into_iter().find(|p| p.is_file()).expect("mock fixture present")
}



fn thread_record(id: &str) -> ThreadRecord {
    ThreadRecord {
        id: id.to_string(),
        project_id: None,
        title: "Runtime golden".to_string(),
        status: "draft".to_string(),
        pinned: false,
        created_at: crate::events::now_millis(),
        updated_at: crate::events::now_millis(),
        workspace: None,
        main_repo: None,
        worktree_name: None,
    }
}

/// Polls `f` until it returns true (or the timeout elapses).
async fn wait_for(timeout: Duration, mut f: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + timeout;
    while !f() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "condition not met within {timeout:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn kinds_of(runtime: &AgentRuntime, run_id: &str) -> Vec<EventKind> {
    runtime
        .store()
        .load_events(run_id)
        .expect("load events")
        .into_iter()
        .map(|e| e.kind)
        .collect()
}

#[tokio::test]
async fn queued_message_auto_dispatches_after_run_finished() {
    // The env lock guards the process-env writes and the env reads inside the
    // sync dispatch calls; it is scoped so no await point holds it.
    struct Setup {
        runtime: Arc<AgentRuntime>,
        sink: Arc<TestSink>,
        first: crate::runtime::SendOutcome,
        second: crate::runtime::SendOutcome,
        sandbox: std::path::PathBuf,
    }
    let setup = {
        let _env = env_lock();
        let sandbox = std::env::temp_dir().join("pult-m2-queue");
        let _ = std::fs::remove_dir_all(&sandbox);
        std::env::set_var("PULT_MOCK_AGENT", fixture_path());
        std::env::set_var("PULT_WORKSPACE", &sandbox);

        let (runtime, sink) = mock_runtime();
        let thread = thread_record("th-queue");
        runtime.store().create_thread(&thread).expect("create thread");
        // First message starts a run; the second lands in the backend queue.
        let first = runtime.send(&thread, "first", &[], "mock").expect("send 1");
        let second = runtime.send(&thread, "second", &[], "mock").expect("send 2");
        Setup {
            runtime,
            sink,
            first,
            second,
            sandbox,
        }
    };
    let Setup {
        runtime,
        sink,
        first,
        second,
        sandbox,
    } = setup;
    let pump = spawn_permission_pump(&runtime, &sink);
    let run1 = first.run.expect("immediate run");
    assert!(second.queued, "second message must queue while run 1 is active");
    assert!(second.run.is_none());
    assert!(!second.queue_id.as_deref().unwrap_or_default().is_empty());
    assert_eq!(runtime.store().list_queue("th-queue").unwrap().len(), 1);

    // run_finished pops the queue and dispatches a fresh run automatically.
    wait_for(Duration::from_secs(8), || {
        runtime
            .store()
            .list_runs("th-queue")
            .map(|runs| runs.len() >= 2)
            .unwrap_or(false)
    })
    .await;
    let runs = runtime.store().list_runs("th-queue").unwrap();
    let run2 = runs.iter().find(|r| r.id != run1.id).expect("run 2").clone();

    let run2_kinds = kinds_of(&runtime, &run2.id);
    assert!(
        run2_kinds.iter().any(|k| matches!(k, EventKind::UserMessage { text, .. } if text == "second")),
        "queued text must open run 2; got {run2_kinds:?}"
    );
    assert!(
        runtime.store().list_queue("th-queue").unwrap().is_empty(),
        "queue must drain after auto-dispatch"
    );
    wait_for(Duration::from_secs(8), || {
        runtime
            .store()
            .list_runs("th-queue")
            .map(|runs| runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;
    pump.abort();

    let _ = std::fs::remove_dir_all(&sandbox);
}

#[tokio::test]
async fn resume_session_load_drops_replayed_transcript_but_keeps_commands() {
    struct Setup {
        runtime: Arc<AgentRuntime>,
        sink: Arc<TestSink>,
        first: crate::runtime::SendOutcome,
        sandbox: std::path::PathBuf,
        thread: ThreadRecord,
    }
    let setup = {
        let _env = env_lock();
        let sandbox = std::env::temp_dir().join("pult-m2-resume");
        let _ = std::fs::remove_dir_all(&sandbox);
        std::env::set_var("PULT_MOCK_AGENT", fixture_path());
        std::env::set_var("PULT_WORKSPACE", &sandbox);

        let (runtime, sink) = mock_runtime();
        let thread = thread_record("th-resume");
        runtime.store().create_thread(&thread).expect("create thread");
        let first = runtime.send(&thread, "hello mock", &[], "mock").expect("send 1");
        Setup {
            runtime,
            sink,
            first,
            sandbox,
            thread,
        }
    };
    let Setup {
        runtime,
        sink,
        first,
        sandbox,
        thread,
    } = setup;
    let pump = spawn_permission_pump(&runtime, &sink);
    let _run1 = first.run.expect("immediate run");
    wait_for(Duration::from_secs(8), || {
        runtime
            .store()
            .list_runs("th-resume")
            .map(|runs| runs.first().map(|r| r.status == "finished").unwrap_or(false))
            .unwrap_or(false)
    })
    .await;
    let session_ref = runtime
        .store()
        .get_session_ref("th-resume", "mock")
        .expect("session ref read")
        .expect("session ref stored");
    assert!(session_ref.starts_with("mock-session"));

    // A fresh process has no memory of session 1; the runtime resumes it via
    // session/load and the mock replays the earlier transcript. The env lock
    // covers the sync dispatch; the pump holds no env dependency.
    let second = runtime.send(&thread, "second prompt", &[], "mock").expect("send 2");
    let run2 = second.run.expect("immediate run 2");
    wait_for(Duration::from_secs(8), || {
        runtime
            .store()
            .list_runs("th-resume")
            .map(|runs| runs.len() >= 2 && runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;
    let run2_kinds = kinds_of(&runtime, &run2.id);
    assert!(
        !run2_kinds.iter().any(|k| matches!(k, EventKind::AgentMessageDelta { delta }
            if delta.contains("(replayed) earlier agent reply"))),
        "session/load replay must not duplicate the prior transcript; got {run2_kinds:?}"
    );
    assert!(
        !run2_kinds.iter().any(|k| matches!(k, EventKind::UserMessage { text, .. }
            if text.contains("(replayed) earlier user message"))),
        "replayed user message must be dropped; got {run2_kinds:?}"
    );
    assert!(
        run2_kinds.iter().any(|k| matches!(k, EventKind::CommandsUpdate { commands }
            if commands.iter().any(|c| c.name == "replayed-command"))),
        "replayed session metadata (commands) must survive the drain; got {run2_kinds:?}"
    );
    assert!(
        run2_kinds.iter().any(|k| matches!(k, EventKind::UserMessage { text, .. } if text == "second prompt")),
        "run 2 must carry its own user message; got {run2_kinds:?}"
    );
    let thread_updates: Vec<_> = sink
        .0
        .lock()
        .expect("sink lock")
        .iter()
        .filter(|(event, _)| event == "thread:update")
        .cloned()
        .collect();
    assert!(
        thread_updates
            .iter()
            .any(|(_, payload)| payload["thread"]["title"].as_str() == Some("(replayed) prior title")),
        "replayed session_info_update must apply persistence side effects and emit thread:update; got {thread_updates:?}"
    );
    pump.abort();

    let _ = std::fs::remove_dir_all(&sandbox);
}

/// Polls the sink for one surfaced request of `event` and returns
/// (run_id, request_id); drains the entry.
async fn wait_request(sink: &TestSink, event: &str, timeout: Duration) -> (String, String) {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        {
            let mut guard = sink.0.lock().expect("sink lock");
            let mut taken: Option<(String, String)> = None;
            guard.retain(|(kind, payload)| {
                if taken.is_none() && kind == event {
                    taken = Some((
                        payload["runId"].as_str().unwrap_or_default().to_string(),
                        payload["requestId"].as_str().unwrap_or_default().to_string(),
                    ));
                    return false;
                }
                true
            });
            if let Some(pair) = taken {
                return pair;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "{event} not surfaced within {timeout:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn sink_events(sink: &TestSink) -> Vec<(String, serde_json::Value)> {
    sink.0.lock().expect("sink lock").clone()
}

/// Elicitation round-trip (§5.5): the modal surfaces, the UI accepts with
/// content, the agent's reply echoes the picked value.
#[tokio::test]
async fn elicitation_round_trip_reaches_the_agent() {
    let _env = env_lock();
    let sandbox = std::env::temp_dir().join("pult-m3-elicitation");
    let _ = std::fs::remove_dir_all(&sandbox);
    std::env::set_var("PULT_MOCK_AGENT", fixture_path());
    std::env::set_var("PULT_WORKSPACE", &sandbox);

    let (runtime, sink) = mock_runtime();
    let pump = spawn_permission_pump(&runtime, &sink);
    let thread = thread_record("th-eli");
    runtime.store().create_thread(&thread).expect("create thread");
    let sent = runtime.send(&thread, "please ask me a question", &[], "mock").expect("send");
    let run = sent.run.expect("immediate run");

    let (run_id, request_id) =
        wait_request(&sink, "elicitation:request", Duration::from_secs(8)).await;
    assert_eq!(run_id, run.id);
    runtime
        .respond_elicitation(
            &run_id,
            &request_id,
            crate::protocol::types::ElicitationAction::Accept,
            Some(serde_json::json!({ "color": "red" })),
        )
        .expect("elicitation answer");

    wait_for(Duration::from_secs(10), || {
        runtime
            .store()
            .list_runs("th-eli")
            .map(|runs| runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;
    pump.abort();

    let kinds = kinds_of(&runtime, &run.id);
    assert!(
        kinds.iter().any(|k| matches!(k, EventKind::ElicitationRequest { message, .. } if message == "Pick a color")),
        "elicitation request must be in the transcript; got {kinds:?}"
    );
    assert!(
        kinds.iter().any(|k| matches!(k, EventKind::AgentMessageDelta { delta }
            if delta.contains("you picked") && delta.contains("red"))),
        "the accepted content must reach the agent echo; got {kinds:?}"
    );
    let _ = std::fs::remove_dir_all(&sandbox);
}

/// Terminal callbacks (§5.5): create → output ring → wait_for_exit → release.
#[tokio::test]
async fn terminal_callbacks_run_and_report() {
    let _env = env_lock();
    let sandbox = std::env::temp_dir().join("pult-m3-terminal");
    let _ = std::fs::remove_dir_all(&sandbox);
    std::env::set_var("PULT_MOCK_AGENT", fixture_path());
    std::env::set_var("PULT_WORKSPACE", &sandbox);

    let (runtime, sink) = mock_runtime();
    let pump = spawn_permission_pump(&runtime, &sink);
    let thread = thread_record("th-term");
    runtime.store().create_thread(&thread).expect("create thread");
    let sent = runtime.send(&thread, "run a terminal command for me", &[], "mock").expect("send");
    let run = sent.run.expect("immediate run");

    wait_for(Duration::from_secs(12), || {
        runtime
            .store()
            .list_runs("th-term")
            .map(|runs| runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;
    pump.abort();

    let kinds = kinds_of(&runtime, &run.id);
    assert!(
        kinds.iter().any(|k| matches!(k, EventKind::AgentMessageDelta { delta }
            if delta.contains("mock-term-ok") && delta.contains("exitCode:0"))),
        "terminal echo with exit code expected; got {kinds:?}"
    );
    let _ = std::fs::remove_dir_all(&sandbox);
}

/// auto_edit resolves an edit-kind request without the UI (§8 M3 acceptance:
/// assert via the event log). Every resolution still leaves a trace row.
#[tokio::test]
async fn auto_edit_resolves_edits_without_ui_prompt() {
    let _env = env_lock();
    let sandbox = std::env::temp_dir().join("pult-m3-autoedit");
    let _ = std::fs::remove_dir_all(&sandbox);
    std::env::set_var("PULT_MOCK_AGENT", fixture_path());
    std::env::set_var("PULT_WORKSPACE", &sandbox);

    let (runtime, sink) = mock_runtime();
    let thread = thread_record("th-auto");
    runtime.store().create_thread(&thread).expect("create thread");
    runtime
        .set_permission_mode("th-auto", crate::runtime::permissions::PermissionMode::AutoEdit)
        .expect("set mode");
    let sent = runtime.send(&thread, "hello mock", &[], "mock").expect("send");
    let run = sent.run.expect("immediate run");

    wait_for(Duration::from_secs(10), || {
        runtime
            .store()
            .list_runs("th-auto")
            .map(|runs| runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;

    let kinds = kinds_of(&runtime, &run.id);
    assert!(
        !sink_events(&sink).iter().any(|(e, _)| e == "permission:request"),
        "auto_edit must resolve the edit without surfacing it"
    );
    assert!(
        kinds.iter().any(|k| matches!(k, EventKind::ApprovalResponse { option_id: Some(o), auto, .. }
            if *auto && o == "mock-allow")),
        "the event log must carry the auto-resolved trace row; got {kinds:?}"
    );
    assert!(
        kinds.iter().any(|k| matches!(k, EventKind::RunFinished { stop_reason, .. } if stop_reason == "end_turn")),
        "the turn must complete normally; got {kinds:?}"
    );
    let _ = std::fs::remove_dir_all(&sandbox);
}

/// reject_once round-trips and the run still completes (the mock skips the
/// write when rejected).
#[tokio::test]
async fn reject_once_round_trip_completes_the_turn() {
    let _env = env_lock();
    let sandbox = std::env::temp_dir().join("pult-m3-reject");
    let _ = std::fs::remove_dir_all(&sandbox);
    std::env::set_var("PULT_MOCK_AGENT", fixture_path());
    std::env::set_var("PULT_WORKSPACE", &sandbox);

    let (runtime, sink) = mock_runtime();
    let thread = thread_record("th-reject");
    runtime.store().create_thread(&thread).expect("create thread");
    let sent = runtime.send(&thread, "hello mock", &[], "mock").expect("send");
    let run = sent.run.expect("immediate run");

    let (run_id, request_id) =
        wait_request(&sink, "permission:request", Duration::from_secs(8)).await;
    runtime
        .respond_permission(&run_id, &request_id, Some("mock-reject".to_string()))
        .expect("reject");

    wait_for(Duration::from_secs(10), || {
        runtime
            .store()
            .list_runs("th-reject")
            .map(|runs| runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;

    let kinds = kinds_of(&runtime, &run.id);
    assert!(
        kinds.iter().any(|k| matches!(k, EventKind::ApprovalResponse { option_id: Some(o), auto, .. }
            if !*auto && o == "mock-reject")),
        "the user's rejection must be logged; got {kinds:?}"
    );
    assert!(
        kinds.iter().any(|k| matches!(k, EventKind::RunFinished { stop_reason, .. } if stop_reason == "end_turn")),
        "the mock completes the turn after a rejection; got {kinds:?}"
    );
    let _ = std::fs::remove_dir_all(&sandbox);
}

/// allow_always is remembered per (instance, tool class): the next turn under
/// supervised resolves without surfacing (the remembered chip's backend).
#[tokio::test]
async fn allow_always_is_remembered_for_next_turn() {
    let _env = env_lock();
    let sandbox = std::env::temp_dir().join("pult-m3-remember");
    let _ = std::fs::remove_dir_all(&sandbox);
    std::env::set_var("PULT_MOCK_AGENT", fixture_path());
    std::env::set_var("PULT_WORKSPACE", &sandbox);

    let started = std::time::Instant::now();
    eprintln!("[remember] t+{:?} starting", started.elapsed());
    let (runtime, sink) = mock_runtime();
    let thread = thread_record("th-remember");
    runtime.store().create_thread(&thread).expect("create thread");

    // Turn 1: answer with the allow_always option.
    let first = runtime.send(&thread, "hello mock", &[], "mock").expect("send 1");
    let run1 = first.run.expect("immediate run 1");
    eprintln!("[remember] t+{:?} run1 dispatched", started.elapsed());
    let requested = wait_request(&sink, "permission:request", Duration::from_secs(8)).await;
    let (run_id, request_id) = requested;
    eprintln!("[remember] t+{:?} surfaced for run {run_id}", started.elapsed());
    runtime
        .respond_permission(&run_id, &request_id, Some("mock-allow-always".to_string()))
        .expect("allow always");
    wait_for(Duration::from_secs(10), || {
        runtime
            .store()
            .list_runs("th-remember")
            .map(|runs| runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;
    let _ = run1;

    // Turn 2: the remembered decision auto-resolves before surfacing.
    eprintln!("[remember] t+{:?} turn1 settled", started.elapsed());
    let second = runtime.send(&thread, "second turn", &[], "mock").expect("send 2");
    let run2 = second.run.expect("immediate run 2");
    eprintln!("[remember] t+{:?} run2 dispatched", started.elapsed());
    wait_for(Duration::from_secs(10), || {
        runtime
            .store()
            .list_runs("th-remember")
            .map(|runs| runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;

    let kinds = kinds_of(&runtime, &run2.id);
    assert!(
        kinds.iter().any(|k| matches!(k, EventKind::ApprovalResponse { option_id: Some(o), auto, .. }
            if *auto && o == "mock-allow-always")),
        "the remembered decision must auto-resolve; got {kinds:?}"
    );
    assert!(
        !sink_events(&sink).iter().any(|(e, payload)| e == "permission:request"
            && payload["runId"].as_str() == Some(run2.id.as_str())),
        "turn 2 must not surface the request again"
    );
    let _ = std::fs::remove_dir_all(&sandbox);
}

use crate::runtime::write_file_sandboxed;

/// The fs sandbox rejects `../` escapes with the typed resource error
/// (§8 M3 acceptance).
#[test]
fn sandbox_rejects_parent_directory_escapes() {
    use crate::protocol::jsonrpc::ERR_RESOURCE_NOT_FOUND;
    let root = std::env::temp_dir().join("pult-m3-sandbox");
    std::fs::create_dir_all(&root).unwrap();
    let params = crate::protocol::types::WriteTextFileParams {
        session_id: "s1".into(),
        path: "../escape.txt".into(),
        content: "nope".into(),
        meta: None,
    };
    let (reply, change) = write_file_sandboxed(&root, &params);
    assert!(reply.is_err(), "relative ../ must be rejected");
    assert_eq!(reply.unwrap_err().code, ERR_RESOURCE_NOT_FOUND);
    assert!(change.is_none());

    let params = crate::protocol::types::WriteTextFileParams {
        session_id: "s1".into(),
        path: "/../escape.txt".into(),
        content: "nope".into(),
        meta: None,
    };
    let (reply, _) = write_file_sandboxed(&root, &params);
    assert!(reply.is_err(), "rooted ../ must be rejected");
}

/// A mode picked while idle is remembered and applied before the next run's
/// prompt (connection-per-run means there was no live session to switch).
#[tokio::test]
async fn set_mode_before_run_persists_and_applies_on_next_mock_run() {
    let (runtime, sink, run_id) = {
        let _env = env_lock();
        let sandbox = std::env::temp_dir().join("pult-m9-mode");
        let _ = std::fs::remove_dir_all(&sandbox);
        std::env::set_var("PULT_MOCK_AGENT", fixture_path());
        std::env::set_var("PULT_WORKSPACE", &sandbox);

        let (runtime, sink) = mock_runtime();
        let thread = thread_record("th-mode");
        runtime.store().create_thread(&thread).expect("create thread");
        runtime
            .set_mode("th-mode", "architect")
            .expect("idle mode pick must be accepted");
        assert_eq!(runtime.desired_mode("th-mode").as_deref(), Some("architect"));

        let run = runtime.dispatch(&thread, "plan it", &[], "mock").expect("dispatch");
        assert_eq!(run.mode.as_deref(), Some("architect"));
        (runtime, sink, run.id)
    };
    let pump = spawn_permission_pump(&runtime, &sink);

    wait_for(Duration::from_secs(8), || {
        runtime
            .store()
            .list_runs("th-mode")
            .map(|runs| runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;
    pump.abort();

    let kinds = kinds_of(&runtime, &run_id);
    assert!(
        kinds
            .iter()
            .any(|k| matches!(k, EventKind::ModeChange { mode_id } if mode_id == "architect")),
        "the agent's echo of the applied mode must be recorded; got {kinds:?}"
    );
}

/// Deleting a thread mid-run must not strand the runtime's in-memory state:
/// the DB rows are gone, so finalize must clean up regardless.
#[tokio::test]
async fn deleting_a_thread_mid_run_releases_runtime_state() {
    let (runtime, sink) = {
        let _env = env_lock();
        let sandbox = std::env::temp_dir().join("pult-m9-delete");
        let _ = std::fs::remove_dir_all(&sandbox);
        std::env::set_var("PULT_MOCK_AGENT", fixture_path());
        std::env::set_var("PULT_WORKSPACE", &sandbox);

        let (runtime, sink) = mock_runtime();
        let thread = thread_record("th-delete");
        runtime.store().create_thread(&thread).expect("create thread");
        runtime.dispatch(&thread, "slow", &[], "mock").expect("dispatch");
        runtime.store().delete_thread("th-delete").expect("delete thread");
        (runtime, sink)
    };
    let pump = spawn_permission_pump(&runtime, &sink);

    wait_for(Duration::from_secs(8), || runtime.active_run_for("th-delete").is_none()).await;
    pump.abort();
}

/// §5.4: preflight caches session config options alongside modes, so pickers
/// are usable before the first prompt.
#[tokio::test]
async fn preflight_caches_modes_and_config_options() {
    let report = {
        let _env = env_lock();
        std::env::set_var("PULT_MOCK_AGENT", fixture_path());
        let (runtime, _sink) = mock_runtime();
        let report = runtime.preflight("mock").await.expect("preflight");
        let info = runtime
            .instances()
            .into_iter()
            .find(|i| i.id == "mock")
            .expect("mock instance");
        assert_eq!(info.config_options.len(), 3);
        report
    };
    assert_eq!(report.config_options.len(), 3);
}

/// A pick made while idle is remembered and applied to the next run; the run
/// record names the actual model/effort.
#[tokio::test]
async fn set_config_option_before_run_persists_and_applies_on_next_mock_run() {
    use crate::protocol::types::ConfigOptionValue;
    let (runtime, sink, run_id) = {
        let _env = env_lock();
        let sandbox = std::env::temp_dir().join("pult-m10-config");
        let _ = std::fs::remove_dir_all(&sandbox);
        std::env::set_var("PULT_MOCK_AGENT", fixture_path());
        std::env::set_var("PULT_WORKSPACE", &sandbox);

        let (runtime, sink) = mock_runtime();
        let thread = thread_record("th-config");
        runtime.store().create_thread(&thread).expect("create thread");
        runtime
            .set_config_option("th-config", "model", ConfigOptionValue::String("mock-pro".into()))
            .await
            .expect("idle model pick");
        runtime
            .set_config_option(
                "th-config",
                "thought_level",
                ConfigOptionValue::String("high".into()),
            )
            .await
            .expect("idle thought pick");
        assert_eq!(
            runtime.desired_config("th-config").len(),
            2,
            "both picks must persist"
        );
        let run = runtime.dispatch(&thread, "configured", &[], "mock").expect("dispatch");
        assert_eq!(run.model.as_deref(), Some("mock-pro"));
        assert_eq!(run.effort.as_deref(), Some("high"));
        (runtime, sink, run.id)
    };
    let pump = spawn_permission_pump(&runtime, &sink);
    wait_for(Duration::from_secs(8), || {
        runtime
            .store()
            .list_runs("th-config")
            .map(|runs| runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;
    pump.abort();

    let kinds = kinds_of(&runtime, &run_id);
    let applied = kinds.iter().any(|k| match k {
        EventKind::ConfigOptions { options } => {
            let model = options.iter().find(|o| o.id == "model");
            let thought = options.iter().find(|o| o.id == "thought_level");
            let model_ok = model.is_some_and(|o| matches!(
                &o.kind,
                crate::protocol::types::SessionConfigOptionKind::Select { current_value, .. }
                    if current_value == "mock-pro"
            ));
            let thought_ok = thought.is_some_and(|o| matches!(
                &o.kind,
                crate::protocol::types::SessionConfigOptionKind::Select { current_value, .. }
                    if current_value == "high"
            ));
            model_ok && thought_ok
        }
        _ => false,
    });
    assert!(applied, "applied picks must be echoed as config options; got {kinds:?}");
}

/// A stale/unknown pick must be ignored: the prompt still runs to end_turn.
#[tokio::test]
async fn invalid_desired_config_does_not_fail_prompt() {
    use crate::protocol::types::ConfigOptionValue;
    let (runtime, sink, run_id) = {
        let _env = env_lock();
        let sandbox = std::env::temp_dir().join("pult-m10-config-bad");
        let _ = std::fs::remove_dir_all(&sandbox);
        std::env::set_var("PULT_MOCK_AGENT", fixture_path());
        std::env::set_var("PULT_WORKSPACE", &sandbox);

        let (runtime, sink) = mock_runtime();
        let thread = thread_record("th-bad-config");
        runtime.store().create_thread(&thread).expect("create thread");
        runtime
            .set_config_option(
                "th-bad-config",
                "model",
                ConfigOptionValue::String("nonexistent".into()),
            )
            .await
            .expect("persist stale pick");
        let run = runtime.dispatch(&thread, "still works", &[], "mock").expect("dispatch");
        (runtime, sink, run.id)
    };
    let pump = spawn_permission_pump(&runtime, &sink);
    wait_for(Duration::from_secs(8), || {
        runtime
            .store()
            .list_runs("th-bad-config")
            .map(|runs| runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;
    pump.abort();

    let runs = runtime.store().list_runs("th-bad-config").unwrap();
    let run = runs.iter().find(|r| r.id == run_id).expect("run");
    assert_eq!(run.status, "finished", "a bad pick must not fail the turn");
}

/// Picking a config option while the run is live must not race the run's
/// event sequence: the run finishes and the new value is echoed.
#[tokio::test]
async fn set_config_option_during_a_live_run_keeps_the_run_healthy() {
    use crate::protocol::types::{ConfigOptionValue, SessionConfigOptionKind};
    let (runtime, sink, run_id) = {
        let _env = env_lock();
        let sandbox = std::env::temp_dir().join("pult-m10-live-config");
        let _ = std::fs::remove_dir_all(&sandbox);
        std::env::set_var("PULT_MOCK_AGENT", fixture_path());
        std::env::set_var("PULT_WORKSPACE", &sandbox);

        let (runtime, sink) = mock_runtime();
        let thread = thread_record("th-live-config");
        runtime.store().create_thread(&thread).expect("create thread");
        let run = runtime.dispatch(&thread, "slow turn", &[], "mock").expect("dispatch");
        runtime
            .set_config_option(
                "th-live-config",
                "model",
                ConfigOptionValue::String("mock-pro".into()),
            )
            .await
            .expect("live pick");
        (runtime, sink, run.id)
    };
    let pump = spawn_permission_pump(&runtime, &sink);
    wait_for(Duration::from_secs(10), || {
        runtime
            .store()
            .list_runs("th-live-config")
            .map(|runs| runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;
    pump.abort();

    let runs = runtime.store().list_runs("th-live-config").unwrap();
    let run = runs.iter().find(|r| r.id == run_id).expect("run");
    assert_eq!(run.status, "finished", "live config pick must not fail the run");
    let kinds = kinds_of(&runtime, &run_id);
    assert!(kinds.iter().any(|k| matches!(
        k,
        EventKind::ConfigOptions { options }
            if options.iter().any(|o| o.id == "model" && matches!(
                &o.kind,
                SessionConfigOptionKind::Select { current_value, .. } if current_value == "mock-pro"
            ))
    )));
}

#[test]
fn config_apply_order_puts_model_before_dependent_options() {
    let mut ids = vec!["web_search", "thought_level", "model"];
    ids.sort_by_key(|id| super::config_apply_order(id));
    assert_eq!(ids, vec!["model", "thought_level", "web_search"]);
}


/// Auth scenarios are per-instance env (no process-env races with other tests).
fn auth_runtime(env: &[(&str, &str)]) -> (Arc<AgentRuntime>, Arc<TestSink>) {
    let (runtime, sink) = mock_runtime();
    let spec = crate::config::InstanceSpec {
        id: "mock".to_string(),
        display_name: "Mock Auth".to_string(),
        driver: "mock".to_string(),
        command: String::new(),
        args: Vec::new(),
        enabled: true,
        env: env
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect(),
    };
    runtime.set_instances_in_memory(vec![spec]);
    (runtime, sink)
}

#[tokio::test]
async fn preflight_caches_auth_methods_and_marks_needs_auth() {
    let (runtime, _sink) = auth_runtime(&[("MOCK_AUTH_REQUIRED", "1")]);
    let report = runtime.preflight("mock").await.expect("preflight");
    assert!(report.auth_required);
    assert_eq!(report.auth_methods.len(), 1);
    assert_eq!(report.auth_methods[0].id.as_deref(), Some("mock-token"));
    let info = runtime
        .instances()
        .into_iter()
        .find(|i| i.id == "mock")
        .expect("mock instance");
    assert_eq!(info.status, "needs_auth");
    assert_eq!(info.auth_methods.len(), 1);
}

#[tokio::test]
async fn authenticate_succeeds_clears_needs_auth_and_warms_config() {
    let state = std::env::temp_dir().join(format!(
        "pult-m11-auth-{}.state",
        crate::events::now_millis()
    ));
    let _ = std::fs::remove_file(&state);
    let state_str = state.to_string_lossy().into_owned();
    let (runtime, sink) = auth_runtime(&[
        ("MOCK_AUTH_REQUIRED", "1"),
        ("MOCK_AUTH_STATE_FILE", state_str.as_str()),
    ]);
    let before = runtime.preflight("mock").await.expect("preflight");
    assert!(before.auth_required);
    let report = runtime
        .authenticate("mock", "mock-token")
        .await
        .expect("authenticate");
    assert!(!report.auth_required);
    assert!(!report.config_options.is_empty());
    let info = runtime
        .instances()
        .into_iter()
        .find(|i| i.id == "mock")
        .expect("mock instance");
    assert_eq!(info.status, "stopped");

    let sandbox = std::env::temp_dir().join(format!(
        "pult-m11-auth-ws-{}",
        crate::events::now_millis()
    ));
    let _ = std::fs::create_dir_all(&sandbox);
    let mut thread = thread_record("th-authed");
    thread.workspace = Some(sandbox.to_string_lossy().into_owned());
    runtime.store().create_thread(&thread).expect("thread");
    runtime.dispatch(&thread, "hello", &[], "mock").expect("dispatch");
    let pump = spawn_permission_pump(&runtime, &sink);
    wait_for(Duration::from_secs(8), || {
        runtime
            .store()
            .list_runs("th-authed")
            .map(|runs| runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;
    pump.abort();
    assert_eq!(
        runtime.store().list_runs("th-authed").unwrap()[0].status,
        "finished"
    );
    let _ = std::fs::remove_file(&state);
    let _ = std::fs::remove_dir_all(&sandbox);
}

#[tokio::test]
async fn authenticate_still_needs_sign_in_when_probe_keeps_failing() {
    let (runtime, _sink) = auth_runtime(&[
        ("MOCK_AUTH_REQUIRED", "1"),
        ("MOCK_AUTH_STILL_REQUIRED", "1"),
    ]);
    runtime.preflight("mock").await.expect("preflight");
    let report = runtime
        .authenticate("mock", "mock-token")
        .await
        .expect("authenticate");
    assert!(report.auth_required);
    let info = runtime
        .instances()
        .into_iter()
        .find(|i| i.id == "mock")
        .expect("mock instance");
    assert_eq!(info.status, "needs_auth");
}

#[tokio::test]
async fn authenticate_failure_errors_and_terminal_methods_are_rejected() {
    {
        let (runtime, _sink) = auth_runtime(&[
            ("MOCK_AUTH_REQUIRED", "1"),
            ("MOCK_AUTH_FAIL", "1"),
        ]);
        runtime.preflight("mock").await.expect("preflight");
        assert!(runtime.authenticate("mock", "mock-token").await.is_err());
    }
    {
        let (runtime, _sink) = auth_runtime(&[("MOCK_AUTH_TERMINAL", "1")]);
        let report = runtime.preflight("mock").await.expect("preflight");
        let terminal = report
            .auth_methods
            .iter()
            .find(|m| m.is_terminal())
            .expect("terminal method");
        assert_eq!(terminal.args, vec!["--login".to_string()]);
        assert!(runtime
            .authenticate("mock", terminal.id.as_deref().unwrap_or_default())
            .await
            .is_err());
    }
}

#[tokio::test]
async fn mock_run_emits_timing_with_first_delta() {
    let (runtime, sink, run_id) = {
        let _env = env_lock();
        let sandbox = std::env::temp_dir().join("pult-v2-timing");
        let _ = std::fs::remove_dir_all(&sandbox);
        std::env::set_var("PULT_MOCK_AGENT", fixture_path());
        std::env::set_var("PULT_WORKSPACE", &sandbox);
        let (runtime, sink) = mock_runtime();
        let thread = thread_record("th-timing");
        runtime.store().create_thread(&thread).expect("thread");
        let run = runtime.dispatch(&thread, "time it", &[], "mock").expect("dispatch");
        (runtime, sink, run.id)
    };
    let pump = spawn_permission_pump(&runtime, &sink);
    wait_for(Duration::from_secs(8), || {
        runtime
            .store()
            .list_runs("th-timing")
            .map(|runs| runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;
    pump.abort();
    let timings = sink.timings();
    assert_eq!(timings.len(), 1, "one timing per finished turn");
    assert_eq!(timings[0].run_id, run_id);
    assert!(!timings[0].pooled);
    assert!(timings[0].handshake_ms > 0, "handshake is measured");
    assert!(timings[0].first_delta_ms.is_some(), "first delta is measured");
}

fn mock_spec_with_env(env: &[(&str, &str)]) -> crate::config::InstanceSpec {
    let mut spec = crate::config::mock_spec();
    spec.env = env
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect();
    spec
}

fn read_pid_lines(path: &std::path::Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

struct HomeEnvGuard {
    userprofile: Option<std::ffi::OsString>,
    home: Option<std::ffi::OsString>,
}

impl HomeEnvGuard {
    fn redirect(dir: &std::path::Path) -> Self {
        let guard = Self {
            userprofile: std::env::var_os("USERPROFILE"),
            home: std::env::var_os("HOME"),
        };
        std::env::set_var("USERPROFILE", dir);
        std::env::set_var("HOME", dir);
        guard
    }
}

impl Drop for HomeEnvGuard {
    fn drop(&mut self) {
        match &self.userprofile {
            Some(v) => std::env::set_var("USERPROFILE", v),
            None => std::env::remove_var("USERPROFILE"),
        }
        match &self.home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
    }
}

#[tokio::test]
async fn sequential_dispatches_on_same_thread_reuse_pooled_process() {
    let _env = env_lock();
    let sandbox =
        std::env::temp_dir().join(format!("pult-pool-seq-{}", crate::events::now_millis()));
    let _ = std::fs::remove_dir_all(&sandbox);
    std::fs::create_dir_all(&sandbox).unwrap();
    let spawn_log = sandbox.join("spawns.log");
    let spawn_log_str = spawn_log.to_string_lossy().into_owned();

    std::env::set_var("PULT_MOCK_AGENT", fixture_path());
    std::env::set_var("PULT_WORKSPACE", &sandbox);

    let (runtime, sink) = mock_runtime();
    runtime.set_instances_in_memory(vec![mock_spec_with_env(&[(
        "MOCK_SPAWN_LOG",
        spawn_log_str.as_str(),
    )])]);
    let mut thread = thread_record("th-pool-seq");
    thread.workspace = Some(sandbox.to_string_lossy().into_owned());
    runtime
        .store()
        .create_thread(&thread)
        .expect("create thread");

    let pump = spawn_permission_pump(&runtime, &sink);

    let first = runtime
        .send(&thread, "first turn", &[], "mock")
        .expect("send 1");
    let run1 = first.run.expect("run 1");
    wait_for(Duration::from_secs(8), || {
        runtime
            .store()
            .list_runs("th-pool-seq")
            .map(|runs| {
                runs.iter()
                    .any(|r| r.id == run1.id && r.status != "running")
            })
            .unwrap_or(false)
    })
    .await;

    let second = runtime
        .send(&thread, "second turn", &[], "mock")
        .expect("send 2");
    let run2 = second.run.expect("run 2");
    wait_for(Duration::from_secs(8), || {
        runtime
            .store()
            .list_runs("th-pool-seq")
            .map(|runs| runs.len() >= 2 && runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;
    pump.abort();

    let runs = runtime.store().list_runs("th-pool-seq").unwrap();
    assert_eq!(
        runs.iter().find(|r| r.id == run1.id).unwrap().status,
        "finished"
    );
    assert_eq!(
        runs.iter().find(|r| r.id == run2.id).unwrap().status,
        "finished"
    );

    let pids = read_pid_lines(&spawn_log);
    assert_eq!(
        pids.len(),
        1,
        "two sequential turns on the same thread must reuse 1 spawned process; got {pids:?}"
    );
    assert_eq!(runtime.pool.stats().idle, 1);

    let _ = std::fs::remove_dir_all(&sandbox);
}

#[tokio::test]
async fn cancelling_run_kills_process_and_leaves_pool_empty() {
    let _env = env_lock();
    let sandbox =
        std::env::temp_dir().join(format!("pult-pool-cancel-{}", crate::events::now_millis()));
    let _ = std::fs::remove_dir_all(&sandbox);
    std::fs::create_dir_all(&sandbox).unwrap();
    let spawn_log = sandbox.join("spawns.log");
    let spawn_log_str = spawn_log.to_string_lossy().into_owned();

    std::env::set_var("PULT_MOCK_AGENT", fixture_path());
    std::env::set_var("PULT_WORKSPACE", &sandbox);

    let (runtime, sink) = mock_runtime();
    runtime.set_instances_in_memory(vec![mock_spec_with_env(&[
        ("MOCK_SLOW_TURN", "1"),
        ("MOCK_SPAWN_LOG", spawn_log_str.as_str()),
    ])]);
    let mut thread = thread_record("th-pool-cancel");
    thread.workspace = Some(sandbox.to_string_lossy().into_owned());
    runtime
        .store()
        .create_thread(&thread)
        .expect("create thread");

    let sent = runtime
        .send(&thread, "cancel me", &[], "mock")
        .expect("send");
    let run = sent.run.expect("run");

    // Wait until the session handshake is complete and the turn is running.
    wait_for(Duration::from_secs(8), || {
        sink_events(&sink)
            .iter()
            .any(|(ev, payload)| ev == "agent:process" && payload["kind"] == "running")
    })
    .await;

    runtime.cancel(&run.id).expect("cancel");

    wait_for(Duration::from_secs(8), || {
        runtime.active_run_for("th-pool-cancel").is_none()
            && runtime
                .store()
                .list_runs("th-pool-cancel")
                .map(|runs| runs.iter().all(|r| r.status != "running"))
                .unwrap_or(false)
    })
    .await;

    let runs = runtime.store().list_runs("th-pool-cancel").unwrap();
    assert_eq!(runs[0].status, "cancelled");
    assert_eq!(runtime.pool.stats().idle, 0);

    let _ = std::fs::remove_dir_all(&sandbox);
}

#[tokio::test]
async fn two_threads_keep_independent_sessions() {
    let _env = env_lock();
    let sandbox =
        std::env::temp_dir().join(format!("pult-pool-multi-{}", crate::events::now_millis()));
    let _ = std::fs::remove_dir_all(&sandbox);
    std::fs::create_dir_all(&sandbox).unwrap();
    let spawn_log = sandbox.join("spawns.log");
    let spawn_log_str = spawn_log.to_string_lossy().into_owned();

    std::env::set_var("PULT_MOCK_AGENT", fixture_path());
    std::env::set_var("PULT_WORKSPACE", &sandbox);

    let (runtime, sink) = mock_runtime();
    runtime.set_instances_in_memory(vec![mock_spec_with_env(&[(
        "MOCK_SPAWN_LOG",
        spawn_log_str.as_str(),
    )])]);
    let mut thread_a = thread_record("th-pool-a");
    thread_a.workspace = Some(sandbox.to_string_lossy().into_owned());
    let mut thread_b = thread_record("th-pool-b");
    thread_b.workspace = Some(sandbox.to_string_lossy().into_owned());
    runtime.store().create_thread(&thread_a).expect("thread A");
    runtime.store().create_thread(&thread_b).expect("thread B");

    let pump = spawn_permission_pump(&runtime, &sink);

    let run_a1 = runtime
        .send(&thread_a, "alpha-one", &[], "mock")
        .unwrap()
        .run
        .unwrap();
    wait_for(Duration::from_secs(8), || {
        runtime
            .store()
            .list_runs("th-pool-a")
            .map(|runs| {
                runs.iter()
                    .any(|r| r.id == run_a1.id && r.status != "running")
            })
            .unwrap_or(false)
    })
    .await;

    let run_b1 = runtime
        .send(&thread_b, "beta-one", &[], "mock")
        .unwrap()
        .run
        .unwrap();
    wait_for(Duration::from_secs(8), || {
        runtime
            .store()
            .list_runs("th-pool-b")
            .map(|runs| {
                runs.iter()
                    .any(|r| r.id == run_b1.id && r.status != "running")
            })
            .unwrap_or(false)
    })
    .await;

    // Resume each thread on its own pooled process without spawning extra PIDs.
    let run_a2 = runtime
        .send(&thread_a, "alpha-two", &[], "mock")
        .unwrap()
        .run
        .unwrap();
    wait_for(Duration::from_secs(8), || {
        runtime
            .store()
            .list_runs("th-pool-a")
            .map(|runs| runs.len() >= 2 && runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;

    let run_b2 = runtime
        .send(&thread_b, "beta-two", &[], "mock")
        .unwrap()
        .run
        .unwrap();
    wait_for(Duration::from_secs(8), || {
        runtime
            .store()
            .list_runs("th-pool-b")
            .map(|runs| runs.len() >= 2 && runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;
    pump.abort();

    for tid in ["th-pool-a", "th-pool-b"] {
        let runs = runtime.store().list_runs(tid).unwrap();
        assert_eq!(runs.len(), 2);
        assert!(runs.iter().all(|r| r.status == "finished"));
    }

    let pids = read_pid_lines(&spawn_log);
    assert_eq!(
        pids.len(),
        2,
        "two threads must spawn two independent processes; got {pids:?}"
    );
    assert_ne!(pids[0], pids[1]);
    assert_eq!(runtime.pool.stats().idle, 2);

    let a2_text: String = kinds_of(&runtime, &run_a2.id)
        .into_iter()
        .filter_map(|k| match k {
            EventKind::AgentMessageDelta { delta } => Some(delta),
            _ => None,
        })
        .collect();
    assert!(
        a2_text.contains("alpha-two"),
        "expected a2 output to contain 'alpha-two', got: {a2_text:?}"
    );
    assert!(
        !a2_text.contains("beta-"),
        "expected a2 output not to contain 'beta-', got: {a2_text:?}"
    );

    let b2_text: String = kinds_of(&runtime, &run_b2.id)
        .into_iter()
        .filter_map(|k| match k {
            EventKind::AgentMessageDelta { delta } => Some(delta),
            _ => None,
        })
        .collect();
    assert!(
        b2_text.contains("beta-two"),
        "expected b2 output to contain 'beta-two', got: {b2_text:?}"
    );
    assert!(
        !b2_text.contains("alpha-"),
        "expected b2 output not to contain 'alpha-', got: {b2_text:?}"
    );

    let _ = std::fs::remove_dir_all(&sandbox);
}

#[tokio::test]
async fn set_instances_invalidates_pooled_entries_for_instance() {
    let _env = env_lock();
    let sandbox =
        std::env::temp_dir().join(format!("pult-pool-setinst-{}", crate::events::now_millis()));
    let _ = std::fs::remove_dir_all(&sandbox);
    std::fs::create_dir_all(&sandbox).unwrap();
    let _home = HomeEnvGuard::redirect(&sandbox);

    std::env::set_var("PULT_MOCK_AGENT", fixture_path());
    std::env::set_var("PULT_WORKSPACE", &sandbox);

    let (runtime, sink) = mock_runtime();
    let mut thread = thread_record("th-pool-inval");
    thread.workspace = Some(sandbox.to_string_lossy().into_owned());
    runtime
        .store()
        .create_thread(&thread)
        .expect("create thread");

    let pump = spawn_permission_pump(&runtime, &sink);
    let sent = runtime.send(&thread, "park me", &[], "mock").expect("send");
    let run = sent.run.expect("run");

    wait_for(Duration::from_secs(8), || {
        runtime
            .store()
            .list_runs("th-pool-inval")
            .map(|runs| runs.iter().any(|r| r.id == run.id && r.status != "running"))
            .unwrap_or(false)
    })
    .await;
    pump.abort();

    assert_eq!(
        runtime.pool.stats().idle,
        1,
        "completed turn must park entry in pool"
    );

    let mut updated = crate::config::mock_spec();
    updated.display_name = "Mock updated".to_string();
    runtime.set_instances(vec![updated]).expect("set_instances");

    assert_eq!(
        runtime.pool.stats().idle,
        0,
        "set_instances must invalidate pooled entries for that instance"
    );

    let _ = std::fs::remove_dir_all(&sandbox);
}

#[tokio::test]
async fn pooled_turn_reapplies_dependent_config_after_model_change() {
    use crate::protocol::types::ConfigOptionValue;

    let _env = env_lock();
    let sandbox = std::env::temp_dir().join(format!(
        "pult-pool-reapply-{}",
        crate::events::now_millis()
    ));
    let _ = std::fs::remove_dir_all(&sandbox);
    std::fs::create_dir_all(&sandbox).unwrap();
    let spawn_log = sandbox.join("spawns.log");
    let spawn_log_str = spawn_log.to_string_lossy().into_owned();

    std::env::set_var("PULT_MOCK_AGENT", fixture_path());
    std::env::set_var("PULT_WORKSPACE", &sandbox);

    let (runtime, sink) = mock_runtime();
    runtime.set_instances_in_memory(vec![mock_spec_with_env(&[(
        "MOCK_SPAWN_LOG",
        spawn_log_str.as_str(),
    )])]);
    let mut thread = thread_record("th-pool-reapply");
    thread.workspace = Some(sandbox.to_string_lossy().into_owned());
    runtime
        .store()
        .create_thread(&thread)
        .expect("create thread");

    let pump = spawn_permission_pump(&runtime, &sink);

    runtime
        .set_config_option(
            &thread.id,
            "model",
            ConfigOptionValue::String("mock-fast".into()),
        )
        .await
        .expect("set model mock-fast");
    runtime
        .set_config_option(
            &thread.id,
            "thought_level",
            ConfigOptionValue::String("high".into()),
        )
        .await
        .expect("set thought_level high");

    let first = runtime
        .send(&thread, "first turn", &[], "mock")
        .expect("send 1");
    let run1 = first.run.expect("run 1");
    wait_for(Duration::from_secs(8), || {
        runtime
            .store()
            .list_runs(&thread.id)
            .map(|runs| {
                runs.iter()
                    .any(|r| r.id == run1.id && r.status != "running")
            })
            .unwrap_or(false)
    })
    .await;
    assert_eq!(runtime.pool.stats().idle, 1);

    runtime
        .set_config_option(
            &thread.id,
            "model",
            ConfigOptionValue::String("mock-v1".into()),
        )
        .await
        .expect("set model mock-v1");

    let second = runtime
        .send(&thread, "second turn", &[], "mock")
        .expect("send 2");
    let run2 = second.run.expect("run 2");
    wait_for(Duration::from_secs(8), || {
        runtime
            .store()
            .list_runs(&thread.id)
            .map(|runs| runs.len() >= 2 && runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;
    pump.abort();

    let pids = read_pid_lines(&spawn_log);
    assert_eq!(
        pids.len(),
        1,
        "second turn must reuse the pooled process; got {pids:?}"
    );

    let run2_kinds = kinds_of(&runtime, &run2.id);
    assert!(
        run2_kinds
            .iter()
            .any(|k| matches!(k, EventKind::Notice { message, .. } if message.contains("thought_level"))),
        "run 2 must re-attempt thought_level after model change to mock-v1 and surface its rejection notice; got {run2_kinds:?}"
    );

    let _ = std::fs::remove_dir_all(&sandbox);
}

#[test]
fn caps_change_event_is_emitted_only_on_actual_change() {
    use crate::protocol::types::{AgentCapabilities, PromptCapabilities, SessionMode};

    let (runtime, sink) = mock_runtime();
    let caps = AgentCapabilities {
        load_session: true,
        prompt_capabilities: PromptCapabilities {
            image: true,
            ..Default::default()
        },
        ..Default::default()
    };

    runtime.cache_capabilities("mock", &caps, vec![], vec![]);
    runtime.cache_capabilities("mock", &caps, vec![], vec![]);

    let caps_events: Vec<_> = sink_events(&sink)
        .into_iter()
        .filter(|(ev, _)| ev == "agent:caps")
        .collect();
    assert_eq!(caps_events.len(), 1);

    let modes = vec![SessionMode {
        id: "architect".to_string(),
        name: "Architect".to_string(),
        description: None,
        meta: None,
    }];
    runtime.cache_capabilities("mock", &caps, modes, vec![]);

    let caps_events: Vec<_> = sink_events(&sink)
        .into_iter()
        .filter(|(ev, _)| ev == "agent:caps")
        .collect();
    assert_eq!(caps_events.len(), 2);
    assert_eq!(caps_events[1].1["instanceId"].as_str(), Some("mock"));
}

#[tokio::test]
async fn workspace_missing_fails_dispatch_without_fallback() {
    use crate::store::records::ProjectRecord;

    let _env = env_lock();
    let tag = crate::events::now_millis();
    let global_sandbox = std::env::temp_dir().join(format!("pult-ws-missing-global-{tag}"));
    let deleted_ws = std::env::temp_dir().join(format!("pult-ws-missing-dir-{tag}"));
    let deleted_proj_dir = std::env::temp_dir().join(format!("pult-ws-missing-proj-{tag}"));

    let _ = std::fs::remove_dir_all(&global_sandbox);
    let _ = std::fs::remove_dir_all(&deleted_ws);
    let _ = std::fs::remove_dir_all(&deleted_proj_dir);
    std::fs::create_dir_all(&global_sandbox).unwrap();
    std::fs::create_dir_all(&deleted_ws).unwrap();
    std::fs::create_dir_all(&deleted_proj_dir).unwrap();

    let spawn_log = global_sandbox.join("spawns.log");
    let spawn_log_str = spawn_log.to_string_lossy().into_owned();

    std::env::set_var("PULT_MOCK_AGENT", fixture_path());
    std::env::set_var("PULT_WORKSPACE", &global_sandbox);

    let (runtime, _sink) = mock_runtime();
    runtime.set_instances_in_memory(vec![mock_spec_with_env(&[(
        "MOCK_SPAWN_LOG",
        spawn_log_str.as_str(),
    )])]);

    // Case 1: Thread with explicit workspace pointing to a deleted directory.
    let mut thread_ws = thread_record("th-ws-missing");
    thread_ws.workspace = Some(deleted_ws.to_string_lossy().into_owned());
    runtime.store().create_thread(&thread_ws).expect("create thread_ws");
    std::fs::remove_dir_all(&deleted_ws).unwrap();

    match runtime.dispatch(&thread_ws, "hello", &[], "mock") {
        Err(err) => {
            assert!(
                matches!(&err, crate::PultError::Internal { code, .. } if code == "workspace.missing"),
                "expected workspace.missing error code, got: {err:?}"
            );
        }
        Ok(run) => {
            wait_for(Duration::from_secs(5), || {
                runtime
                    .store()
                    .list_runs(&thread_ws.id)
                    .map(|runs| runs.iter().any(|r| r.id == run.id && r.status != "running"))
                    .unwrap_or(false)
            })
            .await;
            let runs = runtime.store().list_runs(&thread_ws.id).unwrap();
            let finished = runs.iter().find(|r| r.id == run.id).expect("run");
            assert_eq!(finished.status, "failed", "missing workspace must fail run, not succeed in global root");
            let err_text = finished.error.as_deref().unwrap_or("");
            assert!(
                err_text.contains("workspace.missing") || err_text.contains("not found"),
                "expected workspace.missing/not found error detail, got: {err_text:?}"
            );
        }
    }
    assert!(
        !spawn_log.exists(),
        "agent must NOT be spawned in global root when thread workspace is missing"
    );

    // Case 2: Thread with project_id (workspace: None) whose project root_path was deleted.
    runtime
        .store()
        .create_project(&ProjectRecord {
            id: "proj-deleted-dir".to_string(),
            name: "DeletedDirProj".to_string(),
            root_path: deleted_proj_dir.to_string_lossy().into_owned(),
            color: None,
            worktree_strategy: "root".to_string(),
            pinned: false,
            created_at: tag,
        })
        .expect("create project");
    let mut thread_proj = thread_record("th-proj-ws-missing");
    thread_proj.project_id = Some("proj-deleted-dir".to_string());
    thread_proj.workspace = None;
    runtime.store().create_thread(&thread_proj).expect("create thread_proj");
    std::fs::remove_dir_all(&deleted_proj_dir).unwrap();

    match runtime.dispatch(&thread_proj, "hello", &[], "mock") {
        Err(err) => {
            assert!(
                matches!(&err, crate::PultError::Internal { code, .. } if code == "workspace.missing"),
                "expected workspace.missing error code for missing project root_path, got: {err:?}"
            );
        }
        Ok(run) => {
            wait_for(Duration::from_secs(5), || {
                runtime
                    .store()
                    .list_runs(&thread_proj.id)
                    .map(|runs| runs.iter().any(|r| r.id == run.id && r.status != "running"))
                    .unwrap_or(false)
            })
            .await;
            let runs = runtime.store().list_runs(&thread_proj.id).unwrap();
            let finished = runs.iter().find(|r| r.id == run.id).expect("run");
            assert_eq!(finished.status, "failed", "missing project root_path must fail run, not succeed in global root");
            let err_text = finished.error.as_deref().unwrap_or("");
            assert!(
                err_text.contains("workspace.missing") || err_text.contains("not found"),
                "expected workspace.missing/not found error detail, got: {err_text:?}"
            );
        }
    }
    assert!(
        !spawn_log.exists(),
        "agent must NOT be spawned in global root when project root_path is missing"
    );

    let _ = std::fs::remove_dir_all(&global_sandbox);
}

#[test]
fn session_config_value_valid_accepts_only_advertised_values() {
    use crate::protocol::types::{
        ConfigOptionValue, SessionConfigOption, SessionConfigOptionKind,
        SessionConfigSelectGroup, SessionConfigSelectOption, SessionConfigSelectOptions,
    };

    let options = vec![
        SessionConfigOption {
            id: "model".to_string(),
            name: "Model".to_string(),
            description: None,
            category: Some("model".to_string()),
            meta: None,
            kind: SessionConfigOptionKind::Select {
                current_value: "gpt-5".to_string(),
                options: SessionConfigSelectOptions::Grouped(vec![SessionConfigSelectGroup {
                    group: "primary".to_string(),
                    name: "Primary".to_string(),
                    options: vec![
                        SessionConfigSelectOption {
                            value: "gpt-5".to_string(),
                            name: "GPT-5".to_string(),
                            description: None,
                            meta: None,
                        },
                        SessionConfigSelectOption {
                            value: "o3".to_string(),
                            name: "o3".to_string(),
                            description: None,
                            meta: None,
                        },
                    ],
                    meta: None,
                }]),
            },
        },
        SessionConfigOption {
            id: "reasoning_effort".to_string(),
            name: "Reasoning effort".to_string(),
            description: None,
            category: Some("reasoning".to_string()),
            meta: None,
            kind: SessionConfigOptionKind::Select {
                current_value: "medium".to_string(),
                options: SessionConfigSelectOptions::Flat(vec![
                    SessionConfigSelectOption {
                        value: "low".to_string(),
                        name: "Low".to_string(),
                        description: None,
                        meta: None,
                    },
                    SessionConfigSelectOption {
                        value: "medium".to_string(),
                        name: "Medium".to_string(),
                        description: None,
                        meta: None,
                    },
                ]),
            },
        },
        SessionConfigOption {
            id: "web_search".to_string(),
            name: "Web search".to_string(),
            description: None,
            category: Some("other".to_string()),
            meta: None,
            kind: SessionConfigOptionKind::Boolean {
                current_value: false,
            },
        },
    ];

    assert!(super::session_config_value_valid(
        &options,
        "model",
        &ConfigOptionValue::String("o3".into()),
    ));
    assert!(!super::session_config_value_valid(
        &options,
        "model",
        &ConfigOptionValue::String("claude-sonnet-4".into()),
    ));
    assert!(!super::session_config_value_valid(
        &options,
        "model",
        &ConfigOptionValue::Bool(true),
    ));

    assert!(super::session_config_value_valid(
        &options,
        "reasoning_effort",
        &ConfigOptionValue::String("low".into()),
    ));
    assert!(!super::session_config_value_valid(
        &options,
        "reasoning_effort",
        &ConfigOptionValue::String("high".into()),
    ));
    assert!(!super::session_config_value_valid(
        &options,
        "reasoning_effort",
        &ConfigOptionValue::Bool(false),
    ));

    assert!(super::session_config_value_valid(
        &options,
        "web_search",
        &ConfigOptionValue::Bool(true),
    ));
    assert!(!super::session_config_value_valid(
        &options,
        "web_search",
        &ConfigOptionValue::String("true".into()),
    ));

    assert!(!super::session_config_value_valid(
        &options,
        "unknown_id",
        &ConfigOptionValue::String("anything".into()),
    ));
    assert!(!super::session_config_value_valid(
        &options,
        "unknown_id",
        &ConfigOptionValue::Bool(true),
    ));
}

#[test]
fn clear_stale_provider_config_keeps_only_values_the_new_instance_advertises() {
    use crate::protocol::types::{
        AgentCapabilities, ConfigOptionValue, SessionConfigOption, SessionConfigOptionKind,
        SessionConfigSelectOption, SessionConfigSelectOptions,
    };

    let (runtime, _sink) = mock_runtime();
    let thread = thread_record("th");
    runtime.store().create_thread(&thread).expect("create thread");

    let mut seed = super::DesiredConfigMap::new();
    seed.insert("model".to_string(), ConfigOptionValue::String("gpt-5".into()));
    seed.insert(
        "thinking_level".to_string(),
        ConfigOptionValue::String("high".into()),
    );
    seed.insert("effort".to_string(), ConfigOptionValue::String("max".into()));
    seed.insert("web_search".to_string(), ConfigOptionValue::Bool(true));
    runtime
        .merge_desired_config("th", &seed)
        .expect("seed desired config");

    runtime.cache_capabilities("inst-b", &AgentCapabilities::default(), vec![], vec![]);
    runtime.update_cached_config_options(
        "inst-b",
        vec![
            SessionConfigOption {
                id: "model".to_string(),
                name: "Model".to_string(),
                description: None,
                category: Some("model".to_string()),
                meta: None,
                kind: SessionConfigOptionKind::Select {
                    current_value: "gpt-5".to_string(),
                    options: SessionConfigSelectOptions::Flat(vec![
                        SessionConfigSelectOption {
                            value: "gpt-5".to_string(),
                            name: "GPT-5".to_string(),
                            description: None,
                            meta: None,
                        },
                        SessionConfigSelectOption {
                            value: "o3".to_string(),
                            name: "o3".to_string(),
                            description: None,
                            meta: None,
                        },
                    ]),
                },
            },
            SessionConfigOption {
                id: "reasoning_effort".to_string(),
                name: "Reasoning effort".to_string(),
                description: None,
                category: Some("reasoning".to_string()),
                meta: None,
                kind: SessionConfigOptionKind::Select {
                    current_value: "medium".to_string(),
                    options: SessionConfigSelectOptions::Flat(vec![
                        SessionConfigSelectOption {
                            value: "low".to_string(),
                            name: "Low".to_string(),
                            description: None,
                            meta: None,
                        },
                        SessionConfigSelectOption {
                            value: "medium".to_string(),
                            name: "Medium".to_string(),
                            description: None,
                            meta: None,
                        },
                    ]),
                },
            },
            SessionConfigOption {
                id: "web_search".to_string(),
                name: "Web search".to_string(),
                description: None,
                category: Some("other".to_string()),
                meta: None,
                kind: SessionConfigOptionKind::Boolean {
                    current_value: false,
                },
            },
        ],
    );

    runtime
        .clear_stale_provider_config("th", "inst-b")
        .expect("clear against inst-b");

    let after_b = runtime.desired_config("th");
    assert_eq!(
        after_b.get("model"),
        Some(&ConfigOptionValue::String("gpt-5".into()))
    );
    assert!(!after_b.contains_key("thinking_level"));
    assert!(!after_b.contains_key("effort"));
    assert_eq!(
        after_b.get("web_search"),
        Some(&ConfigOptionValue::Bool(true))
    );

    runtime
        .clear_stale_provider_config("th", "inst-c")
        .expect("clear against uncached inst-c");
    assert_eq!(runtime.desired_config("th"), after_b);
}

#[tokio::test]
async fn invalid_model_value_is_not_sent_to_the_mock_agent() {
    use crate::protocol::types::ConfigOptionValue;

    let (runtime, sink, sandbox, run_id) = {
        let _env = env_lock();
        let sandbox = std::env::temp_dir().join(format!(
            "pult-invalid-model-{}",
            crate::events::now_millis()
        ));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        std::env::set_var("PULT_MOCK_AGENT", fixture_path());
        std::env::set_var("PULT_WORKSPACE", &sandbox);

        let (runtime, sink) = mock_runtime();
        let mut thread = thread_record("th-invalid-model");
        thread.workspace = Some(sandbox.to_string_lossy().into_owned());
        runtime.store().create_thread(&thread).expect("create thread");

        runtime
            .set_config_option(
                "th-invalid-model",
                "model",
                ConfigOptionValue::String("model-a-only".into()),
            )
            .await
            .expect("persist invalid model");
        runtime
            .set_config_option(
                "th-invalid-model",
                "thinking_level",
                ConfigOptionValue::String("high".into()),
            )
            .await
            .expect("persist thinking_level");

        let run = runtime
            .dispatch(&thread, "hello", &[], "mock")
            .expect("dispatch");
        (runtime, sink, sandbox, run.id)
    };

    let pump = spawn_permission_pump(&runtime, &sink);
    wait_for(Duration::from_secs(8), || {
        runtime
            .store()
            .list_runs("th-invalid-model")
            .map(|runs| runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;
    pump.abort();

    let runs = runtime.store().list_runs("th-invalid-model").unwrap();
    let run = runs.iter().find(|r| r.id == run_id).expect("run");
    assert_eq!(run.status, "finished", "run must stay healthy");

    let kinds = kinds_of(&runtime, &run_id);
    assert!(
        !kinds.iter().any(|k| matches!(
            k,
            EventKind::Notice { message, .. }
                if message.contains("model-a-only") || message.contains("The agent rejected model")
        )),
        "invalid model must not be sent to agent; got {kinds:?}"
    );
    assert!(kinds.iter().any(|k| matches!(
        k,
        EventKind::RunFinished { stop_reason, error: None } if stop_reason == "end_turn"
    )));

    let _ = std::fs::remove_dir_all(&sandbox);
}

#[tokio::test]
async fn dispatch_records_effort_for_thinking_level_and_effort_ids() {
    use crate::protocol::types::ConfigOptionValue;

    let (runtime, sink, sandbox, run1, run2) = {
        let _env = env_lock();
        let sandbox = std::env::temp_dir().join(format!(
            "pult-effort-ids-{}",
            crate::events::now_millis()
        ));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        std::env::set_var("PULT_MOCK_AGENT", fixture_path());
        std::env::set_var("PULT_WORKSPACE", &sandbox);

        let (runtime, sink) = mock_runtime();

        let mut thread1 = thread_record("th-effort-thinking");
        thread1.workspace = Some(sandbox.to_string_lossy().into_owned());
        runtime
            .store()
            .create_thread(&thread1)
            .expect("create thread 1");
        runtime
            .set_config_option(
                "th-effort-thinking",
                "thinking_level",
                ConfigOptionValue::String("high".into()),
            )
            .await
            .expect("set thinking_level");
        let run1 = runtime
            .dispatch(&thread1, "one", &[], "mock")
            .expect("dispatch 1");

        let mut thread2 = thread_record("th-effort-max");
        thread2.workspace = Some(sandbox.to_string_lossy().into_owned());
        runtime
            .store()
            .create_thread(&thread2)
            .expect("create thread 2");
        runtime
            .set_config_option(
                "th-effort-max",
                "effort",
                ConfigOptionValue::String("max".into()),
            )
            .await
            .expect("set effort");
        let run2 = runtime
            .dispatch(&thread2, "two", &[], "mock")
            .expect("dispatch 2");

        (runtime, sink, sandbox, run1, run2)
    };

    let pump = spawn_permission_pump(&runtime, &sink);
    wait_for(Duration::from_secs(8), || {
        let done1 = runtime
            .store()
            .list_runs("th-effort-thinking")
            .map(|runs| runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false);
        let done2 = runtime
            .store()
            .list_runs("th-effort-max")
            .map(|runs| runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false);
        done1 && done2
    })
    .await;
    pump.abort();

    assert_eq!(run1.effort.as_deref(), Some("high"));
    assert_eq!(run2.effort.as_deref(), Some("max"));

    let _ = std::fs::remove_dir_all(&sandbox);
}
