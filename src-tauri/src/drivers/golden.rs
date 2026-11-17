//! Golden transcript tests against `fixtures/mock-acp-agent.mjs` (§5.8, §8 M1).
//! The mock is a plain Node script speaking full ACP over stdio; these tests
//! exercise the real driver stack: NDJSON codec → JSON-RPC → typed schema
//! types → projection.

#![cfg(test)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;

use super::acp::{AcpConn, AcpStreams, ClientReply, ClientRequest, DriverError, SpawnConfig};
use crate::events::EventKind;
use crate::protocol::jsonrpc::RpcError;
use crate::protocol::types::ContentBlock;

fn fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/mock-acp-agent.mjs")
}

fn mock_available() -> bool {
    fixture_path().is_file()
}

fn spawn_config(extra: &[(&str, &str)]) -> SpawnConfig {
    let mut env = std::collections::HashMap::new();
    for (key, value) in extra {
        env.insert((*key).to_string(), (*value).to_string());
    }
    SpawnConfig {
        command: "node".to_string(),
        args: vec![fixture_path().to_string_lossy().into_owned()],
        env,
        env_remove: Vec::new(),
        initialize_timeout: Duration::from_secs(60),
        cancel_meta: None,
        driver: "acp".to_string(),
        cwd: None,
    }
}

fn spawn_mock(extra: &[(&str, &str)]) -> (Arc<AcpConn>, AcpStreams) {
    let (conn, streams) = AcpConn::spawn(&spawn_config(extra)).expect("spawn mock agent");
    (Arc::new(conn), streams)
}

#[tokio::test]
async fn grok_initialize_times_out_at_configured_limit() {
    if !mock_available() {
        return;
    }
    let mut config = spawn_config(&[("MOCK_INIT_DELAY_MS", "500")]);
    config.initialize_timeout = Duration::from_millis(100);
    let (conn, _streams) = AcpConn::spawn(&config).expect("spawn mock agent");
    let err = conn
        .initialize()
        .await
        .expect_err("initialize must time out");
    assert!(
        matches!(err, DriverError::Timeout { ref method } if method == "initialize"),
        "expected an initialize timeout, got {err:?}"
    );
    conn.kill();
}

#[tokio::test]
async fn cancel_carries_provider_meta() {
    if !mock_available() {
        return;
    }
    let log = sandbox_dir("cancel-meta").join("cancel.log");
    let log_path = log.to_string_lossy().into_owned();
    let mut config = spawn_config(&[("MOCK_CANCEL_LOG", log_path.as_str())]);
    config.cancel_meta = Some(serde_json::json!({ "cancelTrigger": "ctrl_c" }));
    let (conn, _streams) = AcpConn::spawn(&config).expect("spawn mock agent");
    conn.cancel("session-1").await.expect("cancel");

    let mut raw = String::new();
    for _ in 0..100 {
        if let Ok(text) = std::fs::read_to_string(&log) {
            if !text.trim().is_empty() {
                raw = text;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let line = raw.lines().next().expect("cancel log line");
    let value: serde_json::Value = serde_json::from_str(line).expect("cancel json");
    assert_eq!(value["_meta"]["cancelTrigger"], "ctrl_c");
    conn.kill();
}

fn sandbox_dir(tag: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("pult-golden-{tag}-{}", crate::events::now_millis()));
    std::fs::create_dir_all(&dir).expect("sandbox dir");
    dir
}

/// Answer client-side requests the way the runtime would (fs rooted at the
/// sandbox, permissions auto-allowed, elicitation cancelled).
async fn answer_client_requests(
    conn: Arc<AcpConn>,
    mut rx: mpsc::UnboundedReceiver<ClientRequest>,
    sandbox: PathBuf,
) {
    while let Some(request) = rx.recv().await {
        eprintln!("[golden] client request: {request:?}");
        match request {
            ClientRequest::Permission { request_id, params } => {
                // pick the first option the agent offered
                let option_id = params.options.first().map(|o| o.option_id.clone());
                let _ = conn
                    .respond_client(request_id, permission_reply_for(option_id))
                    .await;
            }
            ClientRequest::ReadFile { request_id, params } => {
                let rel = params.path.trim_start_matches(['/', '\\']);
                let content = std::fs::read_to_string(sandbox.join(rel))
                    .unwrap_or_else(|_| "fn main() {}".to_string());
                let _ = conn
                    .respond_client(
                        request_id,
                        serde_json::to_value(crate::protocol::types::ReadTextFileResult {
                            content,
                        })
                        .map_err(|e| RpcError::new(-32603, e.to_string())),
                    )
                    .await;
            }
            ClientRequest::WriteFile { request_id, params } => {
                let rel = params.path.trim_start_matches(['/', '\\']);
                let target = sandbox.join(rel);
                if let Some(parent) = target.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let write_ok = std::fs::write(&target, &params.content).is_ok();
                let _ = conn
                    .respond_client(
                        request_id,
                        if write_ok {
                            Ok(serde_json::json!({}))
                        } else {
                            Err(RpcError::new(-32002, "sandbox write failed"))
                        },
                    )
                    .await;
            }
            ClientRequest::TerminalCreate { request_id, .. }
            | ClientRequest::TerminalOutput { request_id, .. }
            | ClientRequest::TerminalWait { request_id, .. }
            | ClientRequest::TerminalKill { request_id, .. }
            | ClientRequest::TerminalRelease { request_id, .. } => {
                let _ = conn
                    .respond_client(
                        request_id,
                        Err(crate::protocol::jsonrpc::RpcError::new(
                            -32601,
                            "not in driver golden",
                        )),
                    )
                    .await;
            }
            ClientRequest::Elicitation { request_id, .. } => {
                let _ = conn
                    .respond_client(
                        request_id,
                        serde_json::to_value(crate::protocol::types::ElicitationResult {
                            action: crate::protocol::types::ElicitationAction::Cancel,
                            content: None,
                        })
                        .map_err(|e| RpcError::new(-32603, e.to_string())),
                    )
                    .await;
            }
        }
    }
}

fn permission_reply_for(option_id: Option<String>) -> ClientReply {
    use crate::protocol::types::{RequestPermissionOutcome, RequestPermissionOutcomeKind};
    serde_json::to_value(RequestPermissionOutcome {
        outcome: match option_id {
            Some(option_id) => RequestPermissionOutcomeKind::Selected { option_id },
            None => RequestPermissionOutcomeKind::Cancelled,
        },
    })
    .map_err(|e| RpcError::new(-32603, e.to_string()))
}

/// Happy path: handshake → session → a full turn with thought, plan, tool
/// lifecycle, permission round-trip, fs round-trip, streamed echo, notice —
/// finishing with `stopReason: end_turn`.
#[tokio::test]
async fn golden_happy_path_streams_expected_events() {
    if !mock_available() {
        panic!("fixtures/mock-acp-agent.mjs missing — build the mock agent fixture first");
    }
    // Surface the mock's stderr (the driver pumps it at debug level).
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new("debug"))
        .with_writer(std::io::stderr)
        .try_init();
    let sandbox = sandbox_dir("happy");
    let (conn, streams) = spawn_mock(&[]);
    let conn = Arc::new(conn);
    let crate::drivers::acp::AcpStreams {
        events_rx,
        client_requests_rx,
    } = streams;
    let answer_task = tokio::spawn(answer_client_requests(
        Arc::clone(&conn),
        client_requests_rx,
        sandbox.clone(),
    ));

    // Handshake (§5.2).
    let init = conn.initialize().await.expect("initialize");
    assert_eq!(init.protocol_version, 1);
    assert_eq!(
        init.agent_info.as_ref().map(|i| i.name.as_str()),
        Some("mock-acp-agent")
    );
    assert!(init.agent_capabilities.load_session);

    // Session (§5.3).
    let session = conn
        .new_session(&sandbox.to_string_lossy())
        .await
        .expect("session/new");
    assert!(session.session_id.starts_with("mock-session"));
    let modes = session.modes.expect("mock advertises modes");
    assert_eq!(modes.current_mode_id, "code");
    assert_eq!(modes.available_modes.len(), 2);

    // Turn (§5.4): collect events while the prompt is in flight.
    let mut events = events_rx;
    let mut kinds: Vec<EventKind> = Vec::new();
    let prompt_fut = conn.prompt(&session.session_id, vec![ContentBlock::text("hello mock")]);
    tokio::pin!(prompt_fut);
    let mut saw_streamed_event = false;
    let stop = loop {
        tokio::select! {
            Some(kind) = events.recv() => {
                saw_streamed_event = true;
                kinds.push(kind)
            }
            result = &mut prompt_fut => {
                // select! may pick the resolved response even though the
                // mock's last notification (notice) is ready on the channel
                // too — drain the tail before asserting on the kinds.
                while let Ok(Some(kind)) =
                    tokio::time::timeout(Duration::from_millis(300), events.recv()).await
                {
                    kinds.push(kind);
                }
                break result.expect("prompt response");
            }
        }
    };
    assert_eq!(
        stop.stop_reason,
        crate::protocol::types::StopReason::EndTurn
    );
    assert!(saw_streamed_event, "at least one streamed event");

    let has = |kinds: &[EventKind], f: &dyn Fn(&EventKind) -> bool| kinds.iter().any(f);
    let thought = has(&kinds, &|k| {
        matches!(k, EventKind::AgentThoughtDelta { .. })
    });
    let plan = has(
        &kinds,
        &|k| matches!(k, EventKind::Plan { entries, .. } if entries.len() == 3),
    );
    let tool_read = has(
        &kinds,
        &|k| matches!(k, EventKind::ToolCall { kind, .. } if kind == "read"),
    );
    let tool_update = has(
        &kinds,
        &|k| matches!(k, EventKind::ToolCallUpdate { status: Some(s), .. } if s == "completed"),
    );
    let echoed_text: String = kinds
        .iter()
        .filter_map(|k| match k {
            EventKind::AgentMessageDelta { delta } => Some(delta.as_str()),
            _ => None,
        })
        .collect();
    let echoed = echoed_text.contains("hello");
    let notice = has(&kinds, &|k| matches!(k, EventKind::Notice { .. }));
    assert!(thought, "expected a thought chunk; got {kinds:?}");
    assert!(plan, "expected a 3-entry plan; got {kinds:?}");
    assert!(tool_read, "expected a read tool call; got {kinds:?}");
    assert!(tool_update, "expected tool completion; got {kinds:?}");
    assert!(echoed, "expected the prompt echoed back; got {kinds:?}");
    assert!(notice, "expected a notice; got {kinds:?}");
    // M2 session-state events: slash commands, usage, thread auto-rename.
    let commands = kinds.iter().any(|k| {
        matches!(k, EventKind::CommandsUpdate { commands }
            if commands.iter().any(|c| c.name == "mock-echo"))
    });
    assert!(commands, "expected available commands; got {kinds:?}");
    assert!(
        has(
            &kinds,
            &|k| matches!(k, EventKind::SessionInfo { title: Some(t) }
            if t.starts_with("Echo turn"))
        ),
        "expected session_info auto-rename; got {kinds:?}"
    );
    assert!(
        has(&kinds, &|k| matches!(k, EventKind::Usage { detail }
            if detail["size"].as_u64() == Some(200_000))),
        "expected a usage update; got {kinds:?}"
    );

    // fs/write_text_file round-trip: the mock asked us to write this file.
    let written = sandbox.join("repo/src/mock-out.txt");
    assert!(
        written.exists(),
        "mock fs write did not land in the sandbox"
    );

    conn.kill();
    answer_task.abort();
    let _ = std::fs::remove_dir_all(&sandbox);
}

/// §8 latency budget: send → first streamed echo must complete within 200ms on
/// an idle host. Kept ignored so loaded CI/local test runs stay deterministic.
#[tokio::test]
#[ignore = "timing budget: run explicitly on an idle host"]
async fn golden_first_echo_latency_budget() {
    if !mock_available() {
        panic!("fixtures/mock-acp-agent.mjs missing — build the mock agent fixture first");
    }
    let sandbox = sandbox_dir("latency");
    let (conn, streams) = spawn_mock(&[]);
    let conn = Arc::new(conn);
    let crate::drivers::acp::AcpStreams {
        mut events_rx,
        client_requests_rx,
    } = streams;
    let answer_task = tokio::spawn(answer_client_requests(
        Arc::clone(&conn),
        client_requests_rx,
        sandbox.clone(),
    ));

    conn.initialize().await.expect("initialize");
    let session = conn
        .new_session(&sandbox.to_string_lossy())
        .await
        .expect("session/new");

    // The clock starts at the first poll — when the request goes on the wire —
    // so process spawn is excluded; the §8 budget covers send → first echo.
    let prompt_fut = conn.prompt(&session.session_id, vec![ContentBlock::text("hello mock")]);
    tokio::pin!(prompt_fut);
    let mut first_echo: Option<Duration> = None;
    let clock = tokio::time::Instant::now();
    let stop = loop {
        tokio::select! {
            Some(_kind) = events_rx.recv() => {
                if first_echo.is_none() {
                    first_echo = Some(clock.elapsed());
                }
            }
            result = &mut prompt_fut => {
                while let Ok(Some(_)) =
                    tokio::time::timeout(Duration::from_millis(300), events_rx.recv()).await
                {}
                break result.expect("prompt response");
            }
        }
    };
    assert_eq!(
        stop.stop_reason,
        crate::protocol::types::StopReason::EndTurn
    );
    let first_echo = first_echo.expect("at least one streamed event");
    assert!(
        first_echo < Duration::from_millis(200),
        "first echo {first_echo:?} exceeds the §8 budget (50ms target, spawn excluded)"
    );

    conn.kill();
    answer_task.abort();
    let _ = std::fs::remove_dir_all(&sandbox);
}

/// Cancel mid-turn (§5.3): prompt response arrives with stopReason cancelled.
#[tokio::test]
async fn golden_cancel_mid_turn_returns_cancelled() {
    if !mock_available() {
        panic!("fixtures/mock-acp-agent.mjs missing");
    }
    let sandbox = sandbox_dir("cancel");
    let (conn, streams) = spawn_mock(&[("MOCK_SLOW_TURN", "1")]);
    let conn = Arc::new(conn);
    let crate::drivers::acp::AcpStreams {
        events_rx,
        client_requests_rx,
    } = streams;
    let answer_task = tokio::spawn(answer_client_requests(
        Arc::clone(&conn),
        client_requests_rx,
        sandbox.clone(),
    ));

    conn.initialize().await.expect("initialize");
    let session = conn
        .new_session(&sandbox.to_string_lossy())
        .await
        .expect("session/new");

    let mut events = events_rx;
    let prompt_fut = conn.prompt(&session.session_id, vec![ContentBlock::text("cancel me")]);
    tokio::pin!(prompt_fut);
    // The prompt request goes out on the first poll inside the loop below;
    // schedule the cancel so it lands mid-turn.
    let cancel_conn = Arc::clone(&conn);
    let cancel_session = session.session_id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(600)).await;
        let _ = cancel_conn.cancel(&cancel_session).await;
    });

    let stop = loop {
        tokio::select! {
            Some(_kind) = events.recv() => {}
            result = &mut prompt_fut => break result.expect("prompt response"),
        }
    };
    assert_eq!(
        stop.stop_reason,
        crate::protocol::types::StopReason::Cancelled,
        "expected cancelled stop reason"
    );

    conn.kill();
    answer_task.abort();
    let _ = std::fs::remove_dir_all(&sandbox);
}

/// MOCK_BAD_JSON: garbage lines on stdout never break the stream (§4.4).
#[tokio::test]
async fn golden_bad_json_lines_are_skipped() {
    if !mock_available() {
        panic!("fixtures/mock-acp-agent.mjs missing");
    }
    let sandbox = sandbox_dir("badjson");
    let (conn, streams) = spawn_mock(&[("MOCK_BAD_JSON", "1")]);
    let conn = Arc::new(conn);
    let crate::drivers::acp::AcpStreams {
        mut events_rx,
        client_requests_rx,
    } = streams;
    let answer_task = tokio::spawn(answer_client_requests(
        Arc::clone(&conn),
        client_requests_rx,
        sandbox.clone(),
    ));

    // If the codec died on the garbage line, this handshake would hang/err.
    conn.initialize()
        .await
        .expect("initialize survived bad json");
    let session = conn
        .new_session(&sandbox.to_string_lossy())
        .await
        .expect("session/new");
    let stop = conn
        .prompt(&session.session_id, vec![ContentBlock::text("still alive")])
        .await
        .expect("prompt survived bad json");
    assert_eq!(
        stop.stop_reason,
        crate::protocol::types::StopReason::EndTurn
    );
    let _ = events_rx.try_recv(); // events flowed too

    conn.kill();
    answer_task.abort();
    let _ = std::fs::remove_dir_all(&sandbox);
}

/// MOCK_CRASH_MID_TURN: the run must surface a typed failure, not hang.
#[tokio::test]
async fn golden_crash_mid_turn_surfaces_error() {
    if !mock_available() {
        panic!("fixtures/mock-acp-agent.mjs missing");
    }
    let sandbox = sandbox_dir("crash");
    let (conn, streams) = spawn_mock(&[("MOCK_CRASH_MID_TURN", "1")]);
    let conn = Arc::new(conn);
    let crate::drivers::acp::AcpStreams {
        events_rx,
        client_requests_rx,
    } = streams;
    let answer_task = tokio::spawn(answer_client_requests(
        Arc::clone(&conn),
        client_requests_rx,
        sandbox.clone(),
    ));

    conn.initialize().await.expect("initialize");
    let session = conn
        .new_session(&sandbox.to_string_lossy())
        .await
        .expect("session/new");
    let mut events = events_rx;
    let mut saw_event = false;
    let result = loop {
        tokio::select! {
            Some(_kind) = events.recv() => { saw_event = true; }
            result = conn.prompt(&session.session_id, vec![ContentBlock::text("crash please")]) => break result,
        }
    };
    assert!(
        saw_event,
        "at least one update should arrive before the crash"
    );
    assert!(
        matches!(
            result,
            Err(DriverError::Rpc(_)) | Err(DriverError::HungUp { .. })
        ),
        "expected a typed failure, got {result:?}"
    );

    conn.kill();
    answer_task.abort();
    let _ = std::fs::remove_dir_all(&sandbox);
}

/// MOCK_HANG: a stuck agent must be killable and detectable (timeout policy
/// is enforced by callers; here we prove the prompt never resolves on its own).
#[tokio::test]
async fn golden_hang_never_resolves_and_is_killable() {
    if !mock_available() {
        panic!("fixtures/mock-acp-agent.mjs missing");
    }
    let sandbox = sandbox_dir("hang");
    let (conn, streams) = spawn_mock(&[("MOCK_HANG", "1")]);
    let conn = Arc::new(conn);
    let crate::drivers::acp::AcpStreams {
        events_rx: _,
        client_requests_rx,
    } = streams;
    let answer_task = tokio::spawn(answer_client_requests(
        Arc::clone(&conn),
        client_requests_rx,
        sandbox.clone(),
    ));

    conn.initialize().await.expect("initialize");
    let session = conn
        .new_session(&sandbox.to_string_lossy())
        .await
        .expect("session/new");
    let prompt_fut = conn.prompt(&session.session_id, vec![ContentBlock::text("hang please")]);
    tokio::pin!(prompt_fut);
    let outcome = tokio::time::timeout(Duration::from_millis(1500), &mut prompt_fut).await;
    assert!(outcome.is_err(), "hung mock must not resolve the prompt");
    conn.kill();

    // After the kill the pending prompt fails instead of hanging forever.
    let result = prompt_fut.await;
    assert!(
        result.is_err(),
        "prompt should fail once the process is killed"
    );

    answer_task.abort();
    let _ = std::fs::remove_dir_all(&sandbox);
}

/// Image round-trip (M2): promptCapabilities.image lets the prompt carry an
/// image content block; the mock echoes a marker describing it.
#[tokio::test]
async fn golden_image_prompt_round_trips() {
    if !mock_available() {
        panic!("fixtures/mock-acp-agent.mjs missing");
    }
    let sandbox = sandbox_dir("image");
    let (conn, streams) = spawn_mock(&[]);
    let conn = Arc::new(conn);
    let crate::drivers::acp::AcpStreams {
        mut events_rx,
        client_requests_rx,
    } = streams;
    let answer_task = tokio::spawn(answer_client_requests(
        Arc::clone(&conn),
        client_requests_rx,
        sandbox.clone(),
    ));

    conn.initialize().await.expect("initialize");
    let session = conn
        .new_session(&sandbox.to_string_lossy())
        .await
        .expect("session/new");
    let mut kinds: Vec<EventKind> = Vec::new();
    let prompt_fut = conn.prompt(
        &session.session_id,
        vec![
            ContentBlock::text("what is in the chip?"),
            ContentBlock::Image {
                data: "aGk=".into(),
                mime_type: "image/png".into(),
            },
        ],
    );
    tokio::pin!(prompt_fut);
    let stop = loop {
        tokio::select! {
            Some(kind) = events_rx.recv() => kinds.push(kind),
            result = &mut prompt_fut => break result.expect("prompt response"),
        }
    };
    assert_eq!(
        stop.stop_reason,
        crate::protocol::types::StopReason::EndTurn
    );
    let echoed: String = kinds
        .iter()
        .filter_map(|k| match k {
            EventKind::AgentMessageDelta { delta } => Some(delta.as_str()),
            _ => None,
        })
        .collect();
    assert!(
        echoed.contains("[image image/png 4b]"),
        "expected image marker in the echo; got {echoed:?}"
    );

    conn.kill();
    answer_task.abort();
    let _ = std::fs::remove_dir_all(&sandbox);
}

/// §5.4 config pickers: session/new advertises model, thought level and a
/// boolean toggle; set_config_option updates them and rejects bad values.
#[tokio::test]
async fn golden_config_options_new_session_and_set_config_option() {
    use crate::protocol::types::{
        ConfigOptionValue, SessionConfigOptionKind, SessionConfigSelectOptions,
    };
    if !mock_available() {
        panic!("fixtures/mock-acp-agent.mjs missing");
    }
    let (conn, _streams) = spawn_mock(&[]);
    conn.initialize().await.expect("initialize");
    let session = conn.new_session(".").await.expect("new session");

    let ids: Vec<&str> = session
        .config_options
        .iter()
        .map(|o| o.id.as_str())
        .collect();
    assert_eq!(ids, vec!["model", "thought_level", "web_search"]);
    match &session.config_options[0].kind {
        SessionConfigOptionKind::Select {
            current_value,
            options,
        } => {
            assert_eq!(current_value, "mock-fast");
            assert!(matches!(options, SessionConfigSelectOptions::Grouped(g) if g.len() == 2));
        }
        other => panic!("model must be a select: {other:?}"),
    }

    let updated = conn
        .set_config_option(
            &session.session_id,
            "thought_level",
            ConfigOptionValue::String("high".into()),
        )
        .await
        .expect("set thought level");
    let thought = updated
        .config_options
        .iter()
        .find(|o| o.id == "thought_level")
        .expect("thought option");
    assert!(matches!(
        thought.kind,
        SessionConfigOptionKind::Select { ref current_value, .. } if current_value == "high"
    ));

    let toggled = conn
        .set_config_option(
            &session.session_id,
            "web_search",
            ConfigOptionValue::Bool(true),
        )
        .await
        .expect("set boolean");
    let search = toggled
        .config_options
        .iter()
        .find(|o| o.id == "web_search")
        .expect("search option");
    assert!(matches!(
        search.kind,
        SessionConfigOptionKind::Boolean {
            current_value: true
        }
    ));

    let bad = conn
        .set_config_option(
            &session.session_id,
            "thought_level",
            ConfigOptionValue::String("bogus".into()),
        )
        .await;
    match bad {
        Err(DriverError::Rpc(err)) => assert_eq!(err.code, -32602),
        other => panic!("expected -32602, got {other:?}"),
    }
    conn.kill();
}

#[tokio::test]
async fn golden_authenticate_unblocks_new_session() {
    if !mock_available() {
        panic!("fixtures/mock-acp-agent.mjs missing");
    }
    let (conn, _streams) = spawn_mock(&[("MOCK_AUTH_REQUIRED", "1")]);
    let init = conn.initialize().await.expect("initialize");
    assert_eq!(init.auth_methods.len(), 1);
    assert!(init.auth_methods[0].is_agent());
    assert_eq!(init.auth_methods[0].id.as_deref(), Some("mock-token"));

    let err = conn.new_session(".").await.expect_err("locked before auth");
    assert!(err.is_auth_required(), "only -32000 means sign-in: {err:?}");

    conn.authenticate("mock-token").await.expect("authenticate");
    let session = conn.new_session(".").await.expect("unblocked session");
    assert!(session.session_id.starts_with("mock-session-"));
    conn.kill();
}

#[tokio::test]
async fn golden_authenticate_failure_keeps_session_locked() {
    if !mock_available() {
        panic!("fixtures/mock-acp-agent.mjs missing");
    }
    let (conn, _streams) = spawn_mock(&[("MOCK_AUTH_REQUIRED", "1"), ("MOCK_AUTH_FAIL", "1")]);
    conn.initialize().await.expect("initialize");
    let err = conn
        .authenticate("mock-token")
        .await
        .expect_err("auth must fail");
    match err {
        DriverError::Rpc(rpc) => assert_eq!(rpc.code, -32603),
        other => panic!("expected -32603, got {other:?}"),
    }
    let still = conn.new_session(".").await.expect_err("still locked");
    assert!(still.is_auth_required());
    conn.kill();
}
