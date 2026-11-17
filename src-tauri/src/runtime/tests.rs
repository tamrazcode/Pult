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
    ENV_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
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
        self.0
            .lock()
            .expect("sink lock")
            .push((event.to_string(), payload));
        Ok(())
    }

    fn emit_run_timing(&self, timing: &crate::events::RunTiming) {
        self.1.lock().expect("timing lock").push(timing.clone());
    }

    fn notify(&self, title: &str, body: &str) {
        self.0.lock().expect("sink lock").push((
            "notify".to_string(),
            serde_json::json!({ "title": title, "body": body }),
        ));
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
                let request_id = payload["requestId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string();
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
    let runtime = Arc::new(AgentRuntime::new(
        store,
        Arc::clone(&sink) as Arc<dyn EventSink>,
    ));
    runtime.set_instances_in_memory(vec![crate::config::mock_spec()]);
    (runtime, sink)
}

/// Background pump: answers every surfaced permission request with the first
/// offered option (mirrors the supervised UI pressing "Allow").
fn spawn_permission_pump(
    runtime: &Arc<AgentRuntime>,
    sink: &Arc<TestSink>,
) -> tokio::task::JoinHandle<()> {
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
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .expect("mock fixture present")
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
        parent_thread_id: None,
        parent_run_id: None,
        depth: 0,
        lineage_kind: None,
        child_role: None,
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
async fn orchestrator_delegates_and_waits_for_a_child_task() {
    let _env = env_lock();
    let (runtime, sink) = mock_runtime();
    runtime.attach_orchestrator();
    runtime
        .store()
        .create_thread(&thread_record("th-root"))
        .unwrap();
    let root = runtime.store().get_thread("th-root").unwrap();
    let _pump = spawn_permission_pump(&runtime, &sink);
    let parent_run = runtime
        .dispatch(&root, "coordinate the work", &[], "mock")
        .unwrap();

    let scope = crate::orchestrator::McpScope {
        owner_token: "owner-root".to_string(),
        thread_id: "th-root".to_string(),
        depth: 0,
        can_orchestrate: true,
    };
    let started = runtime
        .orchestrator
        .call_tool(
            &scope,
            Some(&parent_run.id),
            "delegate_task",
            &serde_json::json!({
                "title": "Independent check",
                "task": "Say what you checked in one sentence.",
                "role": "test"
            }),
        )
        .await
        .expect("delegate_task succeeds");
    let task_id = started["task"]["taskId"].as_str().unwrap().to_string();
    let child_thread_id = started["task"]["childThreadId"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(started["task"]["targetInstanceId"], "mock");

    let waited = runtime
        .orchestrator
        .call_tool(
            &scope,
            None,
            "wait_tasks",
            &serde_json::json!({ "taskIds": [task_id], "timeoutSec": 30 }),
        )
        .await
        .expect("wait_tasks returns");
    assert_eq!(waited["timedOut"], false);
    let mut status = waited["tasks"][0]["status"].as_str().unwrap().to_string();
    if matches!(status.as_str(), "waiting_approval" | "waiting_input") {
        wait_for(Duration::from_secs(30), || {
            runtime
                .store
                .get_delegated_task(&task_id)
                .map(|task| matches!(task.status.as_str(), "completed" | "failed"))
                .unwrap_or(false)
        })
        .await;
        status = runtime.store.get_delegated_task(&task_id).unwrap().status;
    }
    assert!(
        matches!(status.as_str(), "completed" | "failed"),
        "unexpected task status {status}"
    );

    let child = runtime.store().get_thread(&child_thread_id).unwrap();
    assert_eq!(child.parent_thread_id.as_deref(), Some("th-root"));
    assert_eq!(child.depth, 1);
    assert_eq!(child.child_role.as_deref(), Some("test"));
}

#[tokio::test]
async fn orchestrator_cancel_stops_a_blocked_child_run() {
    let _env = env_lock();
    let (runtime, _sink) = mock_runtime();
    runtime.attach_orchestrator();
    runtime.set_instances_in_memory(vec![mock_spec_with_env(&[("MOCK_HANG", "1")])]);
    runtime
        .store()
        .create_thread(&thread_record("th-root-cancel"))
        .unwrap();
    let root = runtime.store().get_thread("th-root-cancel").unwrap();
    let parent_run = runtime.dispatch(&root, "coordinate", &[], "mock").unwrap();
    let scope = crate::orchestrator::McpScope {
        owner_token: "owner-root".to_string(),
        thread_id: "th-root-cancel".to_string(),
        depth: 0,
        can_orchestrate: true,
    };
    let started = runtime
        .orchestrator
        .call_tool(
            &scope,
            Some(&parent_run.id),
            "delegate_task",
            &serde_json::json!({ "title": "Blocked child", "task": "edit the file" }),
        )
        .await
        .expect("delegate_task succeeds");
    let task_id = started["task"]["taskId"].as_str().unwrap().to_string();
    let child_thread_id = started["task"]["childThreadId"]
        .as_str()
        .unwrap()
        .to_string();
    let child_run_id = started["task"]["childRunId"].as_str().unwrap().to_string();
    wait_for(Duration::from_secs(10), || {
        runtime.live_run_registered(&child_run_id)
    })
    .await;

    let cancelled = runtime
        .orchestrator
        .cancel_task_admin(&task_id, true)
        .expect("cancel succeeds");
    assert_eq!(cancelled["cancelled"], true);
    let task = runtime.store().get_delegated_task(&task_id).unwrap();
    assert_eq!(task.status, "cancelled");
    wait_for(Duration::from_secs(10), || {
        runtime.active_run_for(&child_thread_id).is_none()
    })
    .await;
}

#[tokio::test]
async fn queue_auto_dispatch_failure_keeps_the_message() {
    let (runtime, _sink) = mock_runtime();
    let thread = thread_record("th-queue-fail");
    runtime
        .store()
        .create_thread(&thread)
        .expect("create thread");
    let item = crate::store::records::QueueItem {
        id: "q-fail".to_string(),
        thread_id: thread.id.clone(),
        instance_id: "missing-instance".to_string(),
        text: "keep me".to_string(),
        images: Vec::new(),
        mode: None,
        config_options: Default::default(),
        created_at: 1,
    };
    runtime.store().enqueue_queue_item(&item).expect("enqueue");

    runtime.auto_dispatch_queue(&thread.id);

    let queue = runtime.store().list_queue(&thread.id).expect("list queue");
    assert_eq!(queue.len(), 1, "a failed dispatch must not eat the message");
    assert_eq!(queue[0].text, "keep me");
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
        runtime
            .store()
            .create_thread(&thread)
            .expect("create thread");
        // First message starts a run; the second lands in the backend queue.
        let first = runtime
            .send(&thread, "first", &[], "mock", None, &Default::default())
            .expect("send 1");
        let second = runtime
            .send(&thread, "second", &[], "mock", None, &Default::default())
            .expect("send 2");
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
    assert!(
        second.queued,
        "second message must queue while run 1 is active"
    );
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
    let run2 = runs
        .iter()
        .find(|r| r.id != run1.id)
        .expect("run 2")
        .clone();

    let run2_kinds = kinds_of(&runtime, &run2.id);
    assert!(
        run2_kinds
            .iter()
            .any(|k| matches!(k, EventKind::UserMessage { text, .. } if text == "second")),
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
        runtime
            .store()
            .create_thread(&thread)
            .expect("create thread");
        let first = runtime
            .send(
                &thread,
                "hello mock",
                &[],
                "mock",
                None,
                &Default::default(),
            )
            .expect("send 1");
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
            .map(|runs| {
                runs.first()
                    .map(|r| r.status == "finished")
                    .unwrap_or(false)
            })
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
    let second = runtime
        .send(
            &thread,
            "second prompt",
            &[],
            "mock",
            None,
            &Default::default(),
        )
        .expect("send 2");
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
        !run2_kinds
            .iter()
            .any(|k| matches!(k, EventKind::AgentMessageDelta { delta }
            if delta.contains("(replayed) earlier agent reply"))),
        "session/load replay must not duplicate the prior transcript; got {run2_kinds:?}"
    );
    assert!(
        !run2_kinds
            .iter()
            .any(|k| matches!(k, EventKind::UserMessage { text, .. }
            if text.contains("(replayed) earlier user message"))),
        "replayed user message must be dropped; got {run2_kinds:?}"
    );
    assert!(
        run2_kinds
            .iter()
            .any(|k| matches!(k, EventKind::CommandsUpdate { commands }
            if commands.iter().any(|c| c.name == "replayed-command"))),
        "replayed session metadata (commands) must survive the drain; got {run2_kinds:?}"
    );
    assert!(
        run2_kinds
            .iter()
            .any(|k| matches!(k, EventKind::UserMessage { text, .. } if text == "second prompt")),
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
                        payload["requestId"]
                            .as_str()
                            .unwrap_or_default()
                            .to_string(),
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
    runtime
        .store()
        .create_thread(&thread)
        .expect("create thread");
    let sent = runtime
        .send(
            &thread,
            "please ask me a question",
            &[],
            "mock",
            None,
            &Default::default(),
        )
        .expect("send");
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
        kinds
            .iter()
            .any(|k| matches!(k, EventKind::AgentMessageDelta { delta }
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
    runtime
        .store()
        .create_thread(&thread)
        .expect("create thread");
    let sent = runtime
        .send(
            &thread,
            "run a terminal command for me",
            &[],
            "mock",
            None,
            &Default::default(),
        )
        .expect("send");
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
        kinds
            .iter()
            .any(|k| matches!(k, EventKind::AgentMessageDelta { delta }
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
    runtime
        .store()
        .create_thread(&thread)
        .expect("create thread");
    runtime
        .set_permission_mode(
            "th-auto",
            crate::runtime::permissions::PermissionMode::AutoEdit,
        )
        .expect("set mode");
    let sent = runtime
        .send(
            &thread,
            "hello mock",
            &[],
            "mock",
            None,
            &Default::default(),
        )
        .expect("send");
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
        !sink_events(&sink)
            .iter()
            .any(|(e, _)| e == "permission:request"),
        "auto_edit must resolve the edit without surfacing it"
    );
    assert!(
        kinds.iter().any(
            |k| matches!(k, EventKind::ApprovalResponse { option_id: Some(o), auto, .. }
            if *auto && o == "mock-allow")
        ),
        "the event log must carry the auto-resolved trace row; got {kinds:?}"
    );
    assert!(
        kinds.iter().any(
            |k| matches!(k, EventKind::RunFinished { stop_reason, .. } if stop_reason == "end_turn")
        ),
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
    runtime
        .store()
        .create_thread(&thread)
        .expect("create thread");
    let sent = runtime
        .send(
            &thread,
            "hello mock",
            &[],
            "mock",
            None,
            &Default::default(),
        )
        .expect("send");
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
        kinds.iter().any(
            |k| matches!(k, EventKind::ApprovalResponse { option_id: Some(o), auto, .. }
            if !*auto && o == "mock-reject")
        ),
        "the user's rejection must be logged; got {kinds:?}"
    );
    assert!(
        kinds.iter().any(
            |k| matches!(k, EventKind::RunFinished { stop_reason, .. } if stop_reason == "end_turn")
        ),
        "the mock completes the turn after a rejection; got {kinds:?}"
    );
    let _ = std::fs::remove_dir_all(&sandbox);
}

/// allow_always is remembered per (workspace, instance, tool class): Turn 1
/// approves under supervised, Turn 2 in workspace A (non-supervised) uses
/// the remembered option without surfacing, and workspace B still asks.
#[tokio::test]
async fn allow_always_is_remembered_for_next_turn() {
    use crate::runtime::permissions::PermissionMode;

    let _env = env_lock();
    let tag = crate::events::now_millis();
    let ws_a = std::env::temp_dir().join(format!("pult-m3-remember-a-{tag}"));
    let ws_b = std::env::temp_dir().join(format!("pult-m3-remember-b-{tag}"));
    let _ = std::fs::remove_dir_all(&ws_a);
    let _ = std::fs::remove_dir_all(&ws_b);
    std::fs::create_dir_all(&ws_a).unwrap();
    std::fs::create_dir_all(&ws_b).unwrap();
    let ws_a_str = super::clean_verbatim(ws_a.canonicalize().unwrap())
        .to_string_lossy()
        .into_owned();
    let ws_b_str = super::clean_verbatim(ws_b.canonicalize().unwrap())
        .to_string_lossy()
        .into_owned();
    std::env::set_var("PULT_MOCK_AGENT", fixture_path());
    std::env::set_var("PULT_WORKSPACE", &ws_a);

    let started = std::time::Instant::now();
    eprintln!("[remember] t+{:?} starting", started.elapsed());
    let (runtime, sink) = mock_runtime();
    let mut thread_a = thread_record("th-remember-a");
    thread_a.workspace = Some(ws_a_str.clone());
    let mut thread_b = thread_record("th-remember-b");
    thread_b.workspace = Some(ws_b_str.clone());
    runtime
        .store()
        .create_thread(&thread_a)
        .expect("create thread A");
    runtime
        .store()
        .create_thread(&thread_b)
        .expect("create thread B");
    runtime
        .set_permission_mode(&thread_a.id, PermissionMode::Supervised)
        .expect("mode A supervised");

    // Turn 1 in workspace A (Supervised): answer with the allow_always option.
    let first = runtime
        .send(
            &thread_a,
            "hello mock",
            &[],
            "mock",
            None,
            &Default::default(),
        )
        .expect("send 1");
    let run1 = first.run.expect("immediate run 1");
    eprintln!("[remember] t+{:?} run1 dispatched", started.elapsed());
    let (run_id, request_id) =
        wait_request(&sink, "permission:request", Duration::from_secs(8)).await;
    assert_eq!(run_id, run1.id);
    eprintln!(
        "[remember] t+{:?} surfaced for run {run_id}",
        started.elapsed()
    );
    runtime
        .respond_permission(&run_id, &request_id, Some("mock-allow-always".to_string()))
        .expect("allow always");
    wait_for(Duration::from_secs(10), || {
        runtime
            .store()
            .list_runs(&thread_a.id)
            .map(|runs| runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;

    assert_eq!(
        runtime.remembered_for(&ws_a_str, "mock", "edit").as_deref(),
        Some("mock-allow-always"),
        "allow_always must be remembered for workspace A"
    );
    assert!(
        runtime.remembered_for(&ws_b_str, "mock", "edit").is_none(),
        "remembered permission for workspace A must not apply to workspace B"
    );

    // Turn 2 in workspace A (AutoEdit): the remembered decision auto-resolves
    // with mock-allow-always (rather than AutoEdit's default allow_once) without surfacing.
    eprintln!("[remember] t+{:?} turn1 settled", started.elapsed());
    runtime
        .set_permission_mode(&thread_a.id, PermissionMode::AutoEdit)
        .expect("mode A auto_edit");
    let second = runtime
        .send(
            &thread_a,
            "second turn",
            &[],
            "mock",
            None,
            &Default::default(),
        )
        .expect("send 2");
    let run2 = second.run.expect("immediate run 2");
    eprintln!("[remember] t+{:?} run2 dispatched", started.elapsed());
    wait_for(Duration::from_secs(10), || {
        runtime
            .store()
            .list_runs(&thread_a.id)
            .map(|runs| runs.len() >= 2 && runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;

    let kinds = kinds_of(&runtime, &run2.id);
    assert!(
        kinds.iter().any(
            |k| matches!(k, EventKind::ApprovalResponse { option_id: Some(o), auto, .. }
            if *auto && o == "mock-allow-always")
        ),
        "the remembered decision must auto-resolve in workspace A; got {kinds:?}"
    );
    assert!(
        !sink_events(&sink)
            .iter()
            .any(|(e, payload)| e == "permission:request"
                && payload["runId"].as_str() == Some(run2.id.as_str())),
        "turn 2 in workspace A must not surface the request again"
    );

    // Workspace B: must NOT use workspace A's remembered decision (Ask).
    runtime
        .set_permission_mode(&thread_b.id, PermissionMode::Supervised)
        .expect("mode B supervised");
    let third = runtime
        .send(
            &thread_b,
            "turn in B",
            &[],
            "mock",
            None,
            &Default::default(),
        )
        .expect("send B");
    let run_b = third.run.expect("immediate run B");
    let (b_run_id, b_request_id) =
        wait_request(&sink, "permission:request", Duration::from_secs(8)).await;
    assert_eq!(
        b_run_id, run_b.id,
        "workspace B must surface permission request (Ask)"
    );
    runtime
        .respond_permission(&b_run_id, &b_request_id, Some("mock-allow".to_string()))
        .expect("allow in B");
    wait_for(Duration::from_secs(10), || {
        runtime
            .store()
            .list_runs(&thread_b.id)
            .map(|runs| runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;

    let b_kinds = kinds_of(&runtime, &run_b.id);
    assert!(
        b_kinds.iter().any(
            |k| matches!(k, EventKind::ApprovalResponse { option_id: Some(o), auto, .. }
            if !*auto && o == "mock-allow")
        ),
        "workspace B must ask instead of applying workspace A's remembered allow; got {b_kinds:?}"
    );

    let _ = std::fs::remove_dir_all(&ws_a);
    let _ = std::fs::remove_dir_all(&ws_b);
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

/// A drive-qualified path outside the root must be rejected even though the
/// file does not exist yet (canonicalizing it alone would fail open).
#[cfg(windows)]
#[test]
fn sandbox_rejects_absolute_paths_outside_root() {
    use crate::protocol::jsonrpc::ERR_RESOURCE_NOT_FOUND;
    let root =
        std::env::temp_dir().join(format!("pult-sandbox-abs-{}", crate::events::now_millis()));
    std::fs::create_dir_all(&root).unwrap();
    let outside = std::env::temp_dir().join("pult-outside-write.txt");
    let _ = std::fs::remove_file(&outside);
    let params = crate::protocol::types::WriteTextFileParams {
        session_id: "s1".into(),
        path: outside.to_string_lossy().into_owned(),
        content: "nope".into(),
        meta: None,
    };
    let (reply, change) = write_file_sandboxed(&root, &params);
    assert_eq!(reply.unwrap_err().code, ERR_RESOURCE_NOT_FOUND);
    assert!(change.is_none());
    assert!(!outside.exists(), "outside file must not be created");

    // A new nested file inside the root is still writable.
    let inside = root.join("nested").join("new.txt");
    let params = crate::protocol::types::WriteTextFileParams {
        session_id: "s1".into(),
        path: inside.to_string_lossy().into_owned(),
        content: "ok".into(),
        meta: None,
    };
    let (reply, change) = write_file_sandboxed(&root, &params);
    assert!(reply.is_ok());
    assert!(change.is_some());
    assert!(inside.exists());
    let _ = std::fs::remove_dir_all(&root);
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
        runtime
            .store()
            .create_thread(&thread)
            .expect("create thread");
        runtime
            .set_mode("th-mode", "architect")
            .expect("idle mode pick must be accepted");
        assert_eq!(
            runtime.desired_mode("th-mode").as_deref(),
            Some("architect")
        );

        let run = runtime
            .dispatch(&thread, "plan it", &[], "mock")
            .expect("dispatch");
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
        runtime
            .store()
            .create_thread(&thread)
            .expect("create thread");
        runtime
            .dispatch(&thread, "slow", &[], "mock")
            .expect("dispatch");
        runtime
            .store()
            .delete_thread("th-delete")
            .expect("delete thread");
        (runtime, sink)
    };
    let pump = spawn_permission_pump(&runtime, &sink);

    wait_for(Duration::from_secs(8), || {
        runtime.active_run_for("th-delete").is_none()
    })
    .await;
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
        runtime
            .store()
            .create_thread(&thread)
            .expect("create thread");
        runtime
            .set_config_option(
                "th-config",
                "model",
                ConfigOptionValue::String("mock-pro".into()),
            )
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
        let run = runtime
            .dispatch(&thread, "configured", &[], "mock")
            .expect("dispatch");
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
    let applied =
        kinds.iter().any(|k| match k {
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
    assert!(
        applied,
        "applied picks must be echoed as config options; got {kinds:?}"
    );
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
        runtime
            .store()
            .create_thread(&thread)
            .expect("create thread");
        runtime
            .set_config_option(
                "th-bad-config",
                "model",
                ConfigOptionValue::String("nonexistent".into()),
            )
            .await
            .expect("persist stale pick");
        let run = runtime
            .dispatch(&thread, "still works", &[], "mock")
            .expect("dispatch");
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
        runtime
            .store()
            .create_thread(&thread)
            .expect("create thread");
        let run = runtime
            .dispatch(&thread, "slow turn", &[], "mock")
            .expect("dispatch");
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
    assert_eq!(
        run.status, "finished",
        "live config pick must not fail the run"
    );
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
        secret_env_keys: Vec::new(),
        home_path: None,
        shadow_home_path: None,
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

    let sandbox =
        std::env::temp_dir().join(format!("pult-m11-auth-ws-{}", crate::events::now_millis()));
    let _ = std::fs::create_dir_all(&sandbox);
    let mut thread = thread_record("th-authed");
    thread.workspace = Some(sandbox.to_string_lossy().into_owned());
    runtime.store().create_thread(&thread).expect("thread");
    runtime
        .dispatch(&thread, "hello", &[], "mock")
        .expect("dispatch");
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
        let (runtime, _sink) =
            auth_runtime(&[("MOCK_AUTH_REQUIRED", "1"), ("MOCK_AUTH_FAIL", "1")]);
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
        let run = runtime
            .dispatch(&thread, "time it", &[], "mock")
            .expect("dispatch");
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
    assert!(
        timings[0].first_delta_ms.is_some(),
        "first delta is measured"
    );
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
        .send(
            &thread,
            "first turn",
            &[],
            "mock",
            None,
            &Default::default(),
        )
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
        .send(
            &thread,
            "second turn",
            &[],
            "mock",
            None,
            &Default::default(),
        )
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
        .send(&thread, "cancel me", &[], "mock", None, &Default::default())
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
        .send(
            &thread_a,
            "alpha-one",
            &[],
            "mock",
            None,
            &Default::default(),
        )
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
        .send(
            &thread_b,
            "beta-one",
            &[],
            "mock",
            None,
            &Default::default(),
        )
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
        .send(
            &thread_a,
            "alpha-two",
            &[],
            "mock",
            None,
            &Default::default(),
        )
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
        .send(
            &thread_b,
            "beta-two",
            &[],
            "mock",
            None,
            &Default::default(),
        )
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
    let sent = runtime
        .send(&thread, "park me", &[], "mock", None, &Default::default())
        .expect("send");
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
    let sandbox =
        std::env::temp_dir().join(format!("pult-pool-reapply-{}", crate::events::now_millis()));
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
        .send(
            &thread,
            "first turn",
            &[],
            "mock",
            None,
            &Default::default(),
        )
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
        .send(
            &thread,
            "second turn",
            &[],
            "mock",
            None,
            &Default::default(),
        )
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
    runtime
        .store()
        .create_thread(&thread_ws)
        .expect("create thread_ws");
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
            assert_eq!(
                finished.status, "failed",
                "missing workspace must fail run, not succeed in global root"
            );
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
    runtime
        .store()
        .create_thread(&thread_proj)
        .expect("create thread_proj");
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
            assert_eq!(
                finished.status, "failed",
                "missing project root_path must fail run, not succeed in global root"
            );
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
        ConfigOptionValue, SessionConfigOption, SessionConfigOptionKind, SessionConfigSelectGroup,
        SessionConfigSelectOption, SessionConfigSelectOptions,
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
    runtime
        .store()
        .create_thread(&thread)
        .expect("create thread");

    let mut seed = super::DesiredConfigMap::new();
    seed.insert(
        "model".to_string(),
        ConfigOptionValue::String("gpt-5".into()),
    );
    seed.insert(
        "thinking_level".to_string(),
        ConfigOptionValue::String("high".into()),
    );
    seed.insert(
        "effort".to_string(),
        ConfigOptionValue::String("max".into()),
    );
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
        runtime
            .store()
            .create_thread(&thread)
            .expect("create thread");

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
        let sandbox =
            std::env::temp_dir().join(format!("pult-effort-ids-{}", crate::events::now_millis()));
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

#[tokio::test]
async fn steer_queue_item_cancels_active_run_and_starts_next() {
    let (runtime, sink, sandbox, run1, q2_id) = {
        let _env = env_lock();
        let sandbox =
            std::env::temp_dir().join(format!("pult-queue-steer-{}", crate::events::now_millis()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        std::env::set_var("PULT_MOCK_AGENT", fixture_path());
        std::env::set_var("PULT_WORKSPACE", &sandbox);

        let (runtime, sink) = mock_runtime();
        runtime.set_instances_in_memory(vec![mock_spec_with_env(&[("MOCK_DELAY_MS", "200")])]);

        let mut thread = thread_record("th-steer");
        thread.workspace = Some(sandbox.to_string_lossy().into_owned());
        runtime
            .store()
            .create_thread(&thread)
            .expect("create thread");

        let first = runtime
            .send(
                &thread,
                "active run",
                &[],
                "mock",
                None,
                &Default::default(),
            )
            .expect("send 1");
        let run1 = first.run.expect("immediate run 1");
        let second = runtime
            .send(
                &thread,
                "queued first",
                &[],
                "mock",
                None,
                &Default::default(),
            )
            .expect("send 2");
        let third = runtime
            .send(
                &thread,
                "steered item",
                &[],
                "mock",
                None,
                &Default::default(),
            )
            .expect("send 3");
        assert!(second.queued);
        assert!(third.queued);
        let q2_id = third.queue_id.expect("q2 id");
        (runtime, sink, sandbox, run1, q2_id)
    };

    let pump = spawn_permission_pump(&runtime, &sink);
    // Wait until run 1 has registered its live connection and started streaming.
    wait_for(Duration::from_secs(5), || {
        runtime
            .store()
            .load_events(&run1.id)
            .map(|events| {
                events
                    .iter()
                    .any(|e| matches!(e.kind, EventKind::AgentThoughtDelta { .. }))
            })
            .unwrap_or(false)
    })
    .await;

    runtime.steer("th-steer", &q2_id).expect("steer");

    wait_for(Duration::from_secs(15), || {
        runtime
            .store()
            .list_runs("th-steer")
            .map(|runs| runs.len() >= 3 && runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;
    pump.abort();

    let runs = runtime.store().list_runs("th-steer").unwrap();
    let cancelled_run1 = runs.iter().find(|r| r.id == run1.id).expect("run 1");
    assert_eq!(cancelled_run1.status, "cancelled");

    let run2 = runs.iter().find(|r| r.idx == 1).expect("run 2");
    let run2_kinds = kinds_of(&runtime, &run2.id);
    assert!(
        run2_kinds
            .iter()
            .any(|k| matches!(k, EventKind::UserMessage { text, .. } if text == "steered item")),
        "steered item must dispatch next after cancelling active run; got {run2_kinds:?}"
    );

    let _ = std::fs::remove_dir_all(&sandbox);
}

#[tokio::test]
async fn terminal_without_cwd_runs_in_thread_workspace_including_spaces() {
    use crate::protocol::types::CreateTerminalParams;
    use crate::runtime::terminals::TerminalRegistry;

    let tag = crate::events::now_millis();
    let root_with_space = std::env::temp_dir().join(format!("pult ws space {tag}"));
    std::fs::create_dir_all(&root_with_space).expect("create workspace with spaces");
    let canonical_root =
        super::clean_verbatim(root_with_space.canonicalize().expect("canonicalize"));

    let registry = TerminalRegistry::default();
    let owner = registry.new_owner_token();

    #[cfg(windows)]
    let (command, args) = ("cmd".to_string(), vec!["/c".to_string(), "cd".to_string()]);
    #[cfg(not(windows))]
    let (command, args) = ("sh".to_string(), vec!["-c".to_string(), "pwd".to_string()]);

    let params = CreateTerminalParams {
        session_id: "sess-cwd".to_string(),
        command,
        args,
        cwd: None,
        env: Vec::new(),
        output_byte_limit: None,
        meta: None,
    };

    let created = super::handle_terminal_create(&registry, &owner, &canonical_root, &params)
        .expect("terminal created");
    let terminal_id = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let out = loop {
        let out = registry.output(&terminal_id, &owner).expect("output");
        if out.get("exitStatus").and_then(|v| v.as_object()).is_some() {
            break out;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for terminal exitStatus: {out:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };

    assert_eq!(out["exitStatus"]["exitCode"], 0);
    let stdout = out["output"].as_str().expect("output text");
    let expected = canonical_root.to_string_lossy();
    assert!(
        stdout.to_lowercase().contains(&expected.to_lowercase()),
        "expected stdout {stdout:?} to contain workspace root {expected:?}"
    );
    let _ = registry.release(&terminal_id, &owner);
    let _ = std::fs::remove_dir_all(&root_with_space);
}

#[tokio::test]
async fn resolve_session_emits_notice_on_load_failure() {
    let (runtime, sink, sandbox, thread, run) = {
        let _env = env_lock();
        let sandbox = std::env::temp_dir().join(format!(
            "pult-load-fail-notice-{}",
            crate::events::now_millis()
        ));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        std::env::set_var("PULT_MOCK_AGENT", fixture_path());
        std::env::set_var("PULT_WORKSPACE", &sandbox);

        let (runtime, sink) = mock_runtime();
        runtime.set_instances_in_memory(vec![mock_spec_with_env(&[("MOCK_REJECT_LOAD", "1")])]);

        let mut thread = thread_record("th-load-fail-notice");
        thread.workspace = Some(sandbox.to_string_lossy().into_owned());
        runtime
            .store()
            .create_thread(&thread)
            .expect("create thread");
        runtime
            .store()
            .upsert_session_ref(&thread.id, "mock", "stale-session-ref")
            .expect("seed session_ref");

        let run = runtime
            .dispatch(&thread, "hello after reset", &[], "mock")
            .expect("dispatch");
        (runtime, sink, sandbox, thread, run)
    };

    let pump = spawn_permission_pump(&runtime, &sink);
    wait_for(Duration::from_secs(8), || {
        runtime
            .store()
            .list_runs(&thread.id)
            .map(|runs| runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;
    pump.abort();

    let events = runtime.store().load_events(&run.id).expect("load events");
    let notice_idx = events
        .iter()
        .position(|e| matches!(&e.kind, EventKind::Notice { level, .. } if level == "warning"));
    let msg_idx = events
        .iter()
        .position(|e| matches!(&e.kind, EventKind::AgentMessageDelta { .. }));
    assert!(
        notice_idx.is_some(),
        "expected persisted warning Notice event on session/load failure; got {events:?}"
    );
    assert!(
        msg_idx.is_some(),
        "expected AgentMessageDelta event; got {events:?}"
    );
    assert!(
        notice_idx.unwrap() < msg_idx.unwrap(),
        "warning Notice must appear before first AgentMessageDelta; got {events:?}"
    );

    let _ = std::fs::remove_dir_all(&sandbox);
}

#[tokio::test]
async fn remembered_permission_is_scoped_to_workspace_and_respects_supervised() {
    use crate::runtime::permissions::PermissionMode;

    let tag = crate::events::now_millis();
    let ws_a = std::env::temp_dir().join(format!("pult-perm-scope-a-{tag}"));
    let ws_b = std::env::temp_dir().join(format!("pult-perm-scope-b-{tag}"));
    let _ = std::fs::remove_dir_all(&ws_a);
    let _ = std::fs::remove_dir_all(&ws_b);
    std::fs::create_dir_all(&ws_a).unwrap();
    std::fs::create_dir_all(&ws_b).unwrap();
    let ws_a_str = super::clean_verbatim(ws_a.canonicalize().unwrap())
        .to_string_lossy()
        .into_owned();
    let ws_b_str = super::clean_verbatim(ws_b.canonicalize().unwrap())
        .to_string_lossy()
        .into_owned();

    let (runtime, sink, thread_a, thread_b, run_a1) = {
        let _env = env_lock();
        std::env::set_var("PULT_MOCK_AGENT", fixture_path());
        std::env::set_var("PULT_WORKSPACE", &ws_a);

        let (runtime, sink) = mock_runtime();
        let mut thread_a = thread_record("th-perm-a");
        thread_a.workspace = Some(ws_a_str.clone());
        let mut thread_b = thread_record("th-perm-b");
        thread_b.workspace = Some(ws_b_str.clone());
        runtime.store().create_thread(&thread_a).expect("thread A");
        runtime.store().create_thread(&thread_b).expect("thread B");
        runtime
            .set_permission_mode(&thread_a.id, PermissionMode::Supervised)
            .expect("mode A supervised");
        runtime
            .set_permission_mode(&thread_b.id, PermissionMode::Supervised)
            .expect("mode B supervised");

        let run_a1 = runtime
            .dispatch(&thread_a, "turn a1", &[], "mock")
            .expect("dispatch a1");
        (runtime, sink, thread_a, thread_b, run_a1)
    };

    let (req_run, req_id) = wait_request(&sink, "permission:request", Duration::from_secs(8)).await;
    assert_eq!(req_run, run_a1.id);
    runtime
        .respond_permission(&req_run, &req_id, Some("mock-allow-always".to_string()))
        .expect("allow always in A");
    wait_for(Duration::from_secs(8), || {
        runtime
            .store()
            .list_runs(&thread_a.id)
            .map(|runs| runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;

    assert_eq!(
        runtime.remembered_for(&ws_a_str, "mock", "edit").as_deref(),
        Some("mock-allow-always"),
        "allow_always must be remembered for workspace A"
    );
    assert!(
        runtime.remembered_for(&ws_b_str, "mock", "edit").is_none(),
        "remembered permission from workspace A must not leak to workspace B"
    );

    // Workspace B must Ask.
    let run_b = {
        let _env = env_lock();
        runtime
            .dispatch(&thread_b, "turn b1", &[], "mock")
            .expect("dispatch b1")
    };
    let (b_req_run, b_req_id) =
        wait_request(&sink, "permission:request", Duration::from_secs(8)).await;
    assert_eq!(
        b_req_run, run_b.id,
        "workspace B must surface permission request (Ask)"
    );
    runtime
        .respond_permission(&b_req_run, &b_req_id, Some("mock-allow".to_string()))
        .expect("allow in B");
    wait_for(Duration::from_secs(8), || {
        runtime
            .store()
            .list_runs(&thread_b.id)
            .map(|runs| runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;
    let b_kinds = kinds_of(&runtime, &run_b.id);
    assert!(
        b_kinds
            .iter()
            .any(|k| matches!(k, EventKind::ApprovalResponse { auto, .. } if !*auto)),
        "workspace B must not auto-resolve using workspace A's remembered decision; got {b_kinds:?}"
    );

    // Supervised mode in workspace A must still Ask despite remembered allow_always.
    runtime
        .set_permission_mode(&thread_a.id, PermissionMode::Supervised)
        .expect("keep A supervised");
    let run_a2 = {
        let _env = env_lock();
        runtime
            .dispatch(&thread_a, "turn a2", &[], "mock")
            .expect("dispatch a2")
    };
    let (a2_req_run, a2_req_id) =
        wait_request(&sink, "permission:request", Duration::from_secs(8)).await;
    assert_eq!(
        a2_req_run, run_a2.id,
        "Supervised in workspace A must surface permission request (Ask)"
    );
    runtime
        .respond_permission(&a2_req_run, &a2_req_id, Some("mock-allow".to_string()))
        .expect("allow in A2");
    wait_for(Duration::from_secs(8), || {
        runtime
            .store()
            .list_runs(&thread_a.id)
            .map(|runs| runs.len() >= 2 && runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;
    let a2_kinds = kinds_of(&runtime, &run_a2.id);
    assert!(
        a2_kinds
            .iter()
            .any(|k| matches!(k, EventKind::ApprovalResponse { auto, .. } if !*auto)),
        "Supervised in A must not auto-resolve via remembered decision; got {a2_kinds:?}"
    );

    let _ = std::fs::remove_dir_all(&ws_a);
    let _ = std::fs::remove_dir_all(&ws_b);
}

#[test]
fn corrupt_config_toml_populates_config_error() {
    let _env = env_lock();
    let sandbox = std::env::temp_dir().join(format!(
        "pult-corrupt-config-{}",
        crate::events::now_millis()
    ));
    let _ = std::fs::remove_dir_all(&sandbox);
    let pult_dir = sandbox.join(".pult");
    std::fs::create_dir_all(&pult_dir).unwrap();
    std::fs::write(pult_dir.join("config.toml"), "instances = [unterminated").unwrap();

    let _home = HomeEnvGuard::redirect(&sandbox);
    let store = Arc::new(Store::open_in_memory().expect("in-memory store"));
    let sink = Arc::new(TestSink::default());
    let runtime = AgentRuntime::new(store, sink);

    let err = runtime.config_error();
    assert!(
        err.as_deref().is_some_and(|s| !s.is_empty()),
        "malformed config.toml must populate config_error(); got {err:?}"
    );
    assert!(
        runtime.instances().is_empty(),
        "malformed config.toml must not fall back to mock"
    );

    let _ = std::fs::remove_dir_all(&sandbox);
}

#[test]
fn empty_config_starts_with_zero_instances_without_mock_fallback() {
    let _env = env_lock();
    let sandbox =
        std::env::temp_dir().join(format!("pult-empty-config-{}", crate::events::now_millis()));
    let _ = std::fs::remove_dir_all(&sandbox);
    std::fs::create_dir_all(sandbox.join(".pult")).unwrap();

    let _home = HomeEnvGuard::redirect(&sandbox);
    let store = Arc::new(Store::open_in_memory().expect("in-memory store"));
    let sink = Arc::new(TestSink::default());
    let runtime = AgentRuntime::new(store, sink);

    assert!(runtime.config_error().is_none());
    assert!(
        runtime.instances().is_empty(),
        "empty config must start with zero instances without mock fallback"
    );

    let _ = std::fs::remove_dir_all(&sandbox);
}

#[tokio::test]
async fn deleting_thread_prevents_finalize_run_from_dispatching_queued_message() {
    let (runtime, sink, sandbox, thread, run_a) = {
        let _env = env_lock();
        let sandbox =
            std::env::temp_dir().join(format!("pult-delete-guard-{}", crate::events::now_millis()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        std::env::set_var("PULT_MOCK_AGENT", fixture_path());
        std::env::set_var("PULT_WORKSPACE", &sandbox);

        let (runtime, sink) = mock_runtime();
        let mut thread = thread_record("th-del-guard");
        thread.workspace = Some(sandbox.to_string_lossy().into_owned());
        runtime
            .store()
            .create_thread(&thread)
            .expect("create thread");

        let first = runtime
            .send(&thread, "run A", &[], "mock", None, &Default::default())
            .expect("send A");
        let run_a = first.run.expect("run A");
        let second = runtime
            .send(&thread, "queued B", &[], "mock", None, &Default::default())
            .expect("send B");
        assert!(second.queued, "message B must queue behind active run A");
        (runtime, sink, sandbox, thread, run_a)
    };

    // Wait until run A parks on permission so we deterministically mark deletion before finalize_run.
    let (req_run, req_id) = wait_request(&sink, "permission:request", Duration::from_secs(8)).await;
    assert_eq!(req_run, run_a.id);

    runtime.begin_delete_thread(&thread.id);
    runtime
        .respond_permission(&req_run, &req_id, Some("mock-allow".to_string()))
        .expect("allow run A");

    wait_for(Duration::from_secs(8), || {
        runtime.active_run_for(&thread.id).is_none()
            && runtime
                .store()
                .list_runs(&thread.id)
                .map(|runs| runs.iter().all(|r| r.status != "running"))
                .unwrap_or(false)
    })
    .await;

    let runs = runtime.store().list_runs(&thread.id).expect("list runs");
    assert_eq!(
        runs.len(),
        1,
        "begin_delete_thread must prevent finalize_run from dispatching queued message B; got {runs:?}"
    );
    let queue = runtime.store().list_queue(&thread.id).expect("list queue");
    assert_eq!(
        queue.len(),
        1,
        "queued message B must remain in queue while thread is deleting"
    );
    assert_eq!(queue[0].text, "queued B");

    runtime.finish_delete_thread(&thread.id);
    let _ = std::fs::remove_dir_all(&sandbox);
}

#[tokio::test]
async fn queued_messages_keep_per_message_model_and_mode_without_mutating_active_run() {
    use crate::protocol::types::{ConfigOptionValue, SessionConfigOptionKind};
    use crate::runtime::DesiredConfigMap;

    let (runtime, sink, sandbox, thread, run_a) = {
        let _env = env_lock();
        let sandbox = std::env::temp_dir().join(format!(
            "pult-queue-snapshot-{}",
            crate::events::now_millis()
        ));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        std::env::set_var("PULT_MOCK_AGENT", fixture_path());
        std::env::set_var("PULT_WORKSPACE", &sandbox);

        let (runtime, sink) = mock_runtime();
        let mut thread = thread_record("th-queue-snap");
        thread.workspace = Some(sandbox.to_string_lossy().into_owned());
        runtime
            .store()
            .create_thread(&thread)
            .expect("create thread");

        let mut cfg_a = DesiredConfigMap::new();
        cfg_a.insert(
            "model".to_string(),
            ConfigOptionValue::String("mock-fast".into()),
        );
        let first = runtime
            .send(&thread, "msg A", &[], "mock", Some("code"), &cfg_a)
            .expect("send A");
        let run_a = first.run.expect("run A");
        (runtime, sink, sandbox, thread, run_a)
    };

    // Wait until run A has applied its own config/mode and parked on permission.
    let (req_run, req_id) = wait_request(&sink, "permission:request", Duration::from_secs(8)).await;
    assert_eq!(req_run, run_a.id);

    let mut cfg_b = DesiredConfigMap::new();
    cfg_b.insert(
        "model".to_string(),
        ConfigOptionValue::String("mock-pro".into()),
    );
    let out_b = runtime
        .send(&thread, "msg B", &[], "mock", Some("architect"), &cfg_b)
        .expect("send B");
    assert!(out_b.queued);

    let mut cfg_c = DesiredConfigMap::new();
    cfg_c.insert(
        "model".to_string(),
        ConfigOptionValue::String("mock-v1".into()),
    );
    let out_c = runtime
        .send(&thread, "msg C", &[], "mock", Some("code"), &cfg_c)
        .expect("send C");
    assert!(out_c.queued);

    // Queuing B and C must not mutate active run A's desired_config/mode.
    assert_eq!(
        runtime.desired_config(&thread.id).get("model"),
        Some(&ConfigOptionValue::String("mock-fast".into()))
    );
    assert_eq!(runtime.desired_mode(&thread.id).as_deref(), Some("code"));

    let pump = spawn_permission_pump(&runtime, &sink);
    runtime
        .respond_permission(&req_run, &req_id, Some("mock-allow".to_string()))
        .expect("allow run A");

    wait_for(Duration::from_secs(15), || {
        runtime
            .store()
            .list_runs(&thread.id)
            .map(|runs| runs.len() == 3 && runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;
    pump.abort();

    let runs = runtime.store().list_runs(&thread.id).expect("list runs");
    assert_eq!(runs.len(), 3);
    assert_eq!(runs[0].id, run_a.id);
    assert_eq!(runs[0].model.as_deref(), Some("mock-fast"));
    assert_eq!(runs[0].mode.as_deref(), Some("code"));

    assert_eq!(runs[1].model.as_deref(), Some("mock-pro"));
    assert_eq!(runs[1].mode.as_deref(), Some("architect"));

    assert_eq!(runs[2].model.as_deref(), Some("mock-v1"));
    assert_eq!(runs[2].mode.as_deref(), Some("code"));

    // Verify run A never received B/C's mode or model updates while running.
    let run_a_kinds = kinds_of(&runtime, &runs[0].id);
    assert!(
        !run_a_kinds
            .iter()
            .any(|k| matches!(k, EventKind::ModeChange { mode_id } if mode_id == "architect")),
        "active run A must not receive queued B's mode; got {run_a_kinds:?}"
    );
    assert!(
        !run_a_kinds.iter().any(|k| matches!(
            k,
            EventKind::ConfigOptions { options }
                if options.iter().any(|o| o.id == "model" && matches!(
                    &o.kind,
                    SessionConfigOptionKind::Select { current_value, .. }
                        if current_value == "mock-pro" || current_value == "mock-v1"
                ))
        )),
        "active run A must not receive queued B/C's model config; got {run_a_kinds:?}"
    );

    let _ = std::fs::remove_dir_all(&sandbox);
}

#[tokio::test]
async fn cancel_escalates_to_kill_when_agent_ignores_cancel() {
    struct GraceEnvGuard(Option<std::ffi::OsString>);
    impl Drop for GraceEnvGuard {
        fn drop(&mut self) {
            match &self.0 {
                Some(v) => std::env::set_var("PULT_CANCEL_GRACE_MS", v),
                None => std::env::remove_var("PULT_CANCEL_GRACE_MS"),
            }
        }
    }

    let _env = env_lock();
    let _grace = GraceEnvGuard(std::env::var_os("PULT_CANCEL_GRACE_MS"));
    std::env::set_var("PULT_CANCEL_GRACE_MS", "80");

    let sandbox = std::env::temp_dir().join(format!(
        "pult-cancel-escalate-{}",
        crate::events::now_millis()
    ));
    let _ = std::fs::remove_dir_all(&sandbox);
    std::fs::create_dir_all(&sandbox).unwrap();
    std::env::set_var("PULT_MOCK_AGENT", fixture_path());
    std::env::set_var("PULT_WORKSPACE", &sandbox);

    let (runtime, sink) = mock_runtime();
    runtime.set_instances_in_memory(vec![mock_spec_with_env(&[("MOCK_HANG", "1")])]);
    let mut thread = thread_record("th-cancel-escalate");
    thread.workspace = Some(sandbox.to_string_lossy().into_owned());
    runtime
        .store()
        .create_thread(&thread)
        .expect("create thread");

    let run = runtime
        .dispatch(&thread, "hang forever", &[], "mock")
        .expect("dispatch");

    wait_for(Duration::from_secs(8), || {
        sink_events(&sink)
            .iter()
            .any(|(ev, payload)| ev == "agent:process" && payload["kind"] == "running")
    })
    .await;

    let cancel_started = std::time::Instant::now();
    runtime
        .cancel_with_force(&run.id, false)
        .expect("cancel_with_force");

    wait_for(Duration::from_secs(3), || {
        runtime.active_run_for(&thread.id).is_none()
            && runtime
                .store()
                .list_runs(&thread.id)
                .map(|runs| {
                    runs.iter()
                        .any(|r| r.id == run.id && r.status == "cancelled")
                })
                .unwrap_or(false)
    })
    .await;

    assert!(
        cancel_started.elapsed() < Duration::from_secs(3),
        "cancel escalation took too long: {:?}",
        cancel_started.elapsed()
    );
    let runs = runtime.store().list_runs(&thread.id).expect("list runs");
    assert_eq!(runs[0].status, "cancelled");
    assert_eq!(runtime.pool.stats().idle, 0);

    let _ = std::fs::remove_dir_all(&sandbox);
}

#[test]
fn remembered_permission_clear_removes_only_matching_entries() {
    use crate::runtime::RememberedPermission;

    let (runtime, _sink) = mock_runtime();
    runtime.remember_decision("/ws/a", "inst1", "edit", "allow-a1");
    runtime.remember_decision("/ws/a", "inst2", "edit", "allow-a2");
    runtime.remember_decision("/ws/b", "inst1", "edit", "allow-b1");

    assert_eq!(runtime.list_remembered_permissions().len(), 3);

    runtime
        .clear_remembered_permission(Some("/ws/a"), None, Some("edit"))
        .expect("clear A/edit");

    let remaining = runtime.list_remembered_permissions();
    assert_eq!(
        remaining,
        vec![RememberedPermission {
            workspace: "/ws/b".to_string(),
            instance_id: "inst1".to_string(),
            tool_kind: "edit".to_string(),
            option_id: "allow-b1".to_string(),
        }],
        "only workspace A + tool_kind edit entries must be removed; got {remaining:?}"
    );
    assert!(runtime.remembered_for("/ws/a", "inst1", "edit").is_none());
    assert!(runtime.remembered_for("/ws/a", "inst2", "edit").is_none());
    assert_eq!(
        runtime.remembered_for("/ws/b", "inst1", "edit").as_deref(),
        Some("allow-b1")
    );

    runtime
        .clear_remembered_permission(None, None, None)
        .expect("clear all");
    assert!(
        runtime.list_remembered_permissions().is_empty(),
        "clear all must empty remembered permissions"
    );
}

#[tokio::test]
async fn provider_switch_emits_context_reset_notice() {
    let (runtime, sink, sandbox, thread) = {
        let _env = env_lock();
        let sandbox = std::env::temp_dir().join(format!(
            "pult-provider-switch-{}",
            crate::events::now_millis()
        ));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        std::env::set_var("PULT_MOCK_AGENT", fixture_path());
        std::env::set_var("PULT_WORKSPACE", &sandbox);

        let (runtime, sink) = mock_runtime();
        let mut spec_a = crate::config::mock_spec();
        spec_a.id = "mock-a".to_string();
        spec_a.display_name = "Mock A".to_string();
        let spec_b = crate::config::InstanceSpec {
            id: "mock-b".to_string(),
            display_name: "Mock B".to_string(),
            driver: "mock".to_string(),
            command: "node".to_string(),
            args: Vec::new(),
            secret_env_keys: Vec::new(),
            home_path: None,
            shadow_home_path: None,
            env: Default::default(),
            enabled: true,
        };
        runtime.set_instances_in_memory(vec![spec_a, spec_b]);

        let mut thread = thread_record("th-provider-switch");
        thread.workspace = Some(sandbox.to_string_lossy().into_owned());
        runtime
            .store()
            .create_thread(&thread)
            .expect("create thread");

        let _run1 = runtime
            .dispatch(&thread, "hello mock A", &[], "mock-a")
            .expect("dispatch A");
        (runtime, sink, sandbox, thread)
    };

    let pump = spawn_permission_pump(&runtime, &sink);
    wait_for(Duration::from_secs(8), || {
        runtime
            .store()
            .list_runs(&thread.id)
            .map(|runs| runs.len() == 1 && runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;

    let run2 = {
        let _env = env_lock();
        runtime
            .dispatch(&thread, "hello mock B", &[], "mock-b")
            .expect("dispatch B")
    };
    wait_for(Duration::from_secs(8), || {
        runtime
            .store()
            .list_runs(&thread.id)
            .map(|runs| runs.len() == 2 && runs.iter().all(|r| r.status != "running"))
            .unwrap_or(false)
    })
    .await;
    pump.abort();

    let events = runtime
        .store()
        .load_events(&run2.id)
        .expect("load run2 events");
    let notice_idx = events.iter().position(|e| {
        matches!(
            &e.kind,
            EventKind::Notice { level, message }
                if level == "warning" && message.contains("Switched agent")
        )
    });
    let msg_idx = events
        .iter()
        .position(|e| matches!(&e.kind, EventKind::AgentMessageDelta { .. }));
    assert!(
        notice_idx.is_some(),
        "expected persisted warning Notice on provider switch; got {events:?}"
    );
    assert!(
        msg_idx.is_some(),
        "expected AgentMessageDelta in second run; got {events:?}"
    );
    assert!(
        notice_idx.unwrap() < msg_idx.unwrap(),
        "warning Notice must precede first AgentMessageDelta; got {events:?}"
    );

    let _ = std::fs::remove_dir_all(&sandbox);
}

#[test]
fn provider_home_paths_map_to_the_provider_env_var() {
    let store = crate::store::Store::open_in_memory().unwrap();
    let mut claude = crate::config::mock_spec();
    claude.id = "claude-code".to_string();
    claude.command = "npx".to_string();
    claude.home_path = Some("C:\\claude-home".to_string());
    let env = super::merged_env(&store, &claude).unwrap();
    assert_eq!(
        env.get("CLAUDE_CONFIG_DIR").map(String::as_str),
        Some("C:\\claude-home")
    );

    let mut codex = crate::config::mock_spec();
    codex.id = "codex".to_string();
    codex.command = "npx".to_string();
    codex.home_path = Some("C:\\codex-home".to_string());
    codex.shadow_home_path = Some("C:\\codex-shadow".to_string());
    let env = super::merged_env(&store, &codex).unwrap();
    assert_eq!(
        env.get("CODEX_HOME").map(String::as_str),
        Some("C:\\codex-shadow")
    );
}

#[test]
fn shadow_home_is_created_and_shares_auth_json() {
    let base = std::env::temp_dir().join(format!(
        "pult-shadow-{}-{}",
        std::process::id(),
        crate::events::now_millis()
    ));
    let home = base.join("home");
    let shadow = base.join("shadow");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(home.join("auth.json"), "token-123").unwrap();

    let mut spec = crate::config::mock_spec();
    spec.id = "codex".to_string();
    spec.home_path = Some(home.to_string_lossy().into_owned());
    spec.shadow_home_path = Some(format!("  {}  ", shadow.display()));
    super::prepare_shadow_home(&spec);

    let shared = shadow.join("auth.json");
    assert!(
        shared.is_file(),
        "auth.json should exist in the shadow home"
    );
    assert_eq!(std::fs::read_to_string(&shared).unwrap(), "token-123");

    // Idempotent: a second spawn keeps the existing file.
    super::prepare_shadow_home(&spec);
    assert_eq!(std::fs::read_to_string(&shared).unwrap(), "token-123");
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn claude_spawn_strips_nested_session_env() {
    let mut claude = crate::config::mock_spec();
    claude.id = "claude-code".to_string();
    claude.command = "npx".to_string();
    assert_eq!(
        super::nested_session_env(&claude),
        vec![
            "CLAUDECODE".to_string(),
            "CLAUDE_CODE_SESSION_ID".to_string(),
            "ELECTRON_RUN_AS_NODE".to_string(),
        ]
    );

    let mut codex = crate::config::mock_spec();
    codex.id = "codex".to_string();
    codex.command = "npx".to_string();
    assert!(super::nested_session_env(&codex).is_empty());
}

#[test]
fn startup_migration_moves_plaintext_credentials_without_touching_plain_env() {
    let store = crate::store::Store::open_in_memory().unwrap();
    let mut spec = crate::config::mock_spec();
    spec.env.insert(
        "ANTHROPIC_API_KEY".to_string(),
        "sk-migrate-1234".to_string(),
    );
    spec.env
        .insert("LOG_LEVEL".to_string(), "debug".to_string());
    let (specs, changed) = super::move_plaintext_env(&store, vec![spec]);
    assert!(changed);
    let spec = &specs[0];
    assert!(!spec.env.contains_key("ANTHROPIC_API_KEY"));
    assert_eq!(spec.env.get("LOG_LEVEL").map(String::as_str), Some("debug"));
    assert_eq!(spec.secret_env_keys, vec!["ANTHROPIC_API_KEY".to_string()]);
    assert_eq!(
        store
            .get_secret("provider:mock:ANTHROPIC_API_KEY")
            .unwrap()
            .as_deref(),
        Some("sk-migrate-1234")
    );
}

#[tokio::test]
async fn provider_secret_env_is_masked_and_merged_into_the_spawn_env() {
    let (runtime, _sink) = mock_runtime();
    let mut spec = crate::config::mock_spec();
    spec.secret_env_keys = vec!["API_TOKEN".to_string()];
    runtime
        .store()
        .set_secret("provider:mock:API_TOKEN", "sk-provider-1234")
        .unwrap();
    runtime.set_instances_in_memory(vec![spec]);

    let info = runtime.instances().remove(0);
    assert!(!info.env.contains_key("API_TOKEN"));
    assert_eq!(info.secret_env.len(), 1);
    assert!(info.secret_env[0].has_value);
    assert_eq!(info.secret_env[0].masked.as_deref(), Some("••••1234"));

    let config = runtime.spawn_config_for("mock").expect("spawn config");
    assert_eq!(
        config.env.get("API_TOKEN").map(String::as_str),
        Some("sk-provider-1234")
    );
}

#[tokio::test]
async fn a_missing_provider_secret_fails_before_spawn() {
    let (runtime, _sink) = mock_runtime();
    let mut spec = crate::config::mock_spec();
    spec.secret_env_keys = vec!["API_TOKEN".to_string()];
    runtime.set_instances_in_memory(vec![spec]);
    let error = match runtime.spawn_config_for("mock") {
        Ok(_) => panic!("missing secret must fail"),
        Err(error) => error,
    };
    assert_eq!(error.code(), "provider.secret_missing");
}

#[tokio::test]
async fn custom_mcp_servers_follow_the_orchestrator_and_honor_scope() {
    let (runtime, _sink) = mock_runtime();
    let store = Arc::clone(runtime.store());
    runtime.attach_orchestrator();
    let thread = ThreadRecord {
        id: "th-mcp".to_string(),
        project_id: None,
        title: "MCP".to_string(),
        status: "draft".to_string(),
        pinned: false,
        created_at: 1,
        updated_at: 1,
        workspace: None,
        main_repo: None,
        worktree_name: None,
        parent_thread_id: None,
        parent_run_id: None,
        depth: 0,
        lineage_kind: None,
        child_role: None,
    };
    store.create_thread(&thread).unwrap();
    let input = |value: serde_json::Value| {
        serde_json::from_value::<crate::mcp::config::CustomMcpServerInput>(value).unwrap()
    };
    crate::mcp::config::create(
        &store,
        input(serde_json::json!({
            "name": "Files",
            "transport": { "kind": "stdio", "command": "npx" }
        })),
    )
    .unwrap();
    crate::mcp::config::create(
        &store,
        input(serde_json::json!({
            "name": "Claude only",
            "providerIds": ["claude"],
            "transport": { "kind": "stdio", "command": "npx" }
        })),
    )
    .unwrap();

    let host = Arc::new(crate::orchestrator::engine::RuntimeHost {
        engine: Arc::clone(&runtime.orchestrator),
    });
    let server =
        crate::orchestrator::OrchestratorMcpServer::start(host, Arc::clone(&runtime.mcp_registry))
            .await
            .unwrap();
    runtime.orchestrator.set_server(server);
    let gateway = crate::mcp::gateway::McpGateway::start(
        Arc::new(crate::mcp::StoreConnector::new(Arc::clone(&store))),
        Arc::clone(&runtime.gateway_tokens),
    )
    .await
    .unwrap();
    assert!(runtime.gateway.set(gateway).is_ok());

    let names = |http_capable: bool| {
        runtime
            .mcp_servers_for(&thread.id, "mock", "owner-1", http_capable)
            .0
            .iter()
            .map(|server| {
                serde_json::to_value(server).unwrap()["name"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect::<Vec<_>>()
    };
    // Orchestrator first; the provider-filtered server never enters this
    // session because the mock instance is not `claude`.
    assert_eq!(names(false), vec!["pult_orchestrator", "Files"]);
    assert_eq!(names(true), vec!["pult_orchestrator", "Files"]);

    let stdio = runtime
        .mcp_servers_for(&thread.id, "mock", "owner-1", false)
        .0;
    let custom = serde_json::to_value(&stdio[1]).unwrap();
    assert_eq!(custom["type"], "stdio");
    assert_eq!(custom["args"][1], "--custom");
    let http = runtime
        .mcp_servers_for(&thread.id, "mock", "owner-1", true)
        .0;
    let custom_http = serde_json::to_value(&http[1]).unwrap();
    assert_eq!(custom_http["type"], "http");
    assert!(custom_http["url"]
        .as_str()
        .unwrap()
        .starts_with("http://127.0.0.1:"));
}
