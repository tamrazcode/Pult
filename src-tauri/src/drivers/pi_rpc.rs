//! Native Pi driver (`pi --mode rpc`).
//!
//! Pi speaks strict JSONL over stdio: commands carry an optional `id`, responses
//! echo it, and session events stream beside responses. LF is the ONLY record
//! separator; U+2028/U+2029 are legal inside JSON strings, which is why the
//! shared byte-oriented NDJSON codec is used instead of a line reader.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::AsyncBufReadExt;
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};
use tokio_util::codec::{FramedRead, FramedWrite};

use super::acp::{DriverError, SpawnConfig};
use crate::events::EventKind;
use crate::protocol::codec::NdjsonCodec;
use crate::protocol::jsonrpc::{InvalidMessage, RequestId, RpcError};
use crate::protocol::types::{
    AgentCapabilities, AuthMethod, AuthenticateResult, ContentBlock, Implementation,
    InitializeResult, LoadSessionResult, NewSessionResult, PromptCapabilities, PromptResult,
    StopReason,
};
use crate::protocol::LATEST_PROTOCOL_VERSION;

/// Launch flags Pult controls; user-supplied values would break the protocol.
const RESERVED_ARGS: [&str; 7] = [
    "--mode",
    "--rpc",
    "-e",
    "--extension",
    "--print",
    "--resume",
    "-p",
];

pub fn validate_launch_args(args: &[String]) -> Result<(), String> {
    for arg in args {
        let flag = arg.split('=').next().unwrap_or(arg);
        if RESERVED_ARGS.contains(&flag) {
            return Err(format!(
                "launch argument {flag} is reserved by Pult's Pi RPC driver"
            ));
        }
    }
    Ok(())
}

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, DriverError>>>>>;

/// Pi RPC has no equivalent of this ACP operation: an explicit error is honest,
/// a fake `Ok` would make the runtime report a setting that never landed.
fn unsupported<T>(feature: &str) -> Result<T, DriverError> {
    Err(DriverError::Rpc(RpcError::new(
        -32601,
        format!("Pi RPC does not support {feature}"),
    )))
}

/// A turn whose process disappeared after a cancel was requested ended
/// cancelled; the same EOF without a cancel is a hangup.
fn eof_error(aborted: bool) -> Option<DriverError> {
    (!aborted).then(|| DriverError::HungUp {
        method: "prompt".to_string(),
    })
}

fn same_dir(left: &std::path::Path, right: &std::path::Path) -> bool {
    left == right
        || matches!(
            (left.canonicalize(), right.canonicalize()),
            (Ok(left), Ok(right)) if left == right
        )
}

pub struct PiRpcConn {
    child: Arc<Mutex<Child>>,
    stdin_tx: mpsc::Sender<Value>,
    pending: Pending,
    next_id: Arc<AtomicI64>,
    frames: Arc<Mutex<std::collections::VecDeque<String>>>,
    dead: Arc<AtomicBool>,
    killed: Arc<AtomicBool>,
    aborted: Arc<AtomicBool>,
    turn_done: Arc<Mutex<Option<oneshot::Sender<StopReason>>>>,
    turn_failed: Arc<AtomicBool>,
    /// Directory the process was launched in: Pi sessions cannot switch cwd.
    cwd: Option<std::path::PathBuf>,
    _client_tx: mpsc::UnboundedSender<super::acp::ClientRequest>,
}

pub struct PiRpcStreams {
    pub events_rx: mpsc::UnboundedReceiver<EventKind>,
    pub client_requests_rx: mpsc::UnboundedReceiver<super::acp::ClientRequest>,
}

impl PiRpcConn {
    pub fn spawn(config: &SpawnConfig) -> Result<(Self, PiRpcStreams), DriverError> {
        validate_launch_args(&config.args)
            .map_err(|message| DriverError::Protocol(InvalidMessage(Value::String(message))))?;
        let mut command = config.command.clone();
        if !std::path::Path::new(&command).is_absolute() {
            if let Some(resolved) = crate::config::resolve_command_in(
                &command,
                config.env.get("PATH").map(String::as_str),
            ) {
                command = resolved.to_string_lossy().into_owned();
            }
        }
        let mut args = config.args.clone();
        // Pult owns the RPC mode flag. `pi` is the command users configure;
        // test doubles (node) keep their own argv.
        let command_name = std::path::Path::new(&config.command)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if command_name == "pi" && !args.iter().any(|arg| arg == "--mode") {
            args.splice(0..0, ["--mode".to_string(), "rpc".to_string()]);
        }
        let is_shim = std::path::Path::new(&command)
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"));
        let mut cmd = if is_shim {
            let mut c = Command::new("cmd");
            c.arg("/c").arg(&command).args(&args);
            c
        } else {
            let mut c = Command::new(&command);
            c.args(&args);
            c
        };
        #[cfg(windows)]
        {
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        if let Some(cwd) = &config.cwd {
            cmd.current_dir(cwd);
        }
        for key in &config.env_remove {
            cmd.env_remove(key);
        }
        let mut child = cmd
            .envs(&config.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|source| DriverError::Spawn {
                command: config.command.clone(),
                source,
            })?;
        if let Some(pid) = child.id() {
            crate::processes::job::adopt(pid);
        }
        let child_stdin = child.stdin.take().expect("stdin piped");
        let child_stdout = child.stdout.take().expect("stdout piped");
        let child_stderr = child.stderr.take().expect("stderr piped");
        let child = Arc::new(Mutex::new(child));

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (stdin_tx, mut stdin_rx) = mpsc::channel::<Value>(128);
        let (events_tx, events_rx) = mpsc::unbounded_channel::<EventKind>();
        let (client_tx, client_requests_rx) = mpsc::unbounded_channel();
        let frames: Arc<Mutex<std::collections::VecDeque<String>>> =
            Arc::new(Mutex::new(std::collections::VecDeque::new()));
        let dead = Arc::new(AtomicBool::new(false));
        let aborted = Arc::new(AtomicBool::new(false));
        let turn_failed = Arc::new(AtomicBool::new(false));
        let turn_done: Arc<Mutex<Option<oneshot::Sender<StopReason>>>> = Arc::new(Mutex::new(None));

        {
            let mut framed = FramedWrite::new(child_stdin, NdjsonCodec::new());
            tokio::spawn(async move {
                while let Some(value) = stdin_rx.recv().await {
                    if framed.send(value).await.is_err() {
                        break;
                    }
                }
            });
        }

        {
            let mut stderr = tokio::io::BufReader::new(child_stderr);
            tokio::spawn(async move {
                let mut line = String::new();
                loop {
                    match stderr.read_line(&mut line).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let trimmed = line.trim_end();
                            if !trimmed.is_empty() {
                                tracing::debug!(target: "pult::agent_stderr", "{trimmed}");
                            }
                            line.clear();
                        }
                    }
                }
            });
        }

        {
            let pending = Arc::clone(&pending);
            let frames = Arc::clone(&frames);
            let dead = Arc::clone(&dead);
            let aborted = Arc::clone(&aborted);
            let turn_failed = Arc::clone(&turn_failed);
            let turn_done = Arc::clone(&turn_done);
            tokio::spawn(async move {
                let mut framed = FramedRead::new(child_stdout, NdjsonCodec::new());
                while let Some(Ok(value)) = framed.next().await {
                    let summary = value["type"].as_str().unwrap_or("?").to_string();
                    if frames
                        .lock()
                        .map(|mut f| {
                            f.push_back(format!("← {summary}"));
                            if f.len() > 60 {
                                f.pop_front();
                            }
                        })
                        .is_err()
                    {
                        break;
                    }
                    if value["type"] == "response" {
                        let Some(id) = value["id"].as_str() else {
                            continue;
                        };
                        let sender = pending.lock().ok().and_then(|mut map| map.remove(id));
                        if let Some(sender) = sender {
                            let success = value["success"].as_bool().unwrap_or(true);
                            let result = if success {
                                Ok(value["data"].clone())
                            } else {
                                Err(DriverError::Rpc(RpcError::new(
                                    -32000,
                                    value["error"].as_str().unwrap_or("pi command failed"),
                                )))
                            };
                            let _ = sender.send(result);
                        }
                        continue;
                    }
                    match value["type"].as_str() {
                        Some("agent_end") => {
                            let cancelled = value["aborted"].as_bool().unwrap_or(false)
                                || aborted.load(Ordering::Relaxed);
                            let stop = if cancelled {
                                StopReason::Cancelled
                            } else {
                                StopReason::EndTurn
                            };
                            if let Some(sender) = turn_done.lock().ok().and_then(|mut s| s.take()) {
                                let _ = sender.send(stop);
                            }
                        }
                        Some("message_update") => {
                            let update = &value["assistantMessageEvent"];
                            match update["type"].as_str() {
                                Some("text_delta") => {
                                    if let Some(delta) = update["delta"].as_str() {
                                        let _ = events_tx.send(EventKind::AgentMessageDelta {
                                            delta: delta.to_string(),
                                        });
                                    }
                                }
                                Some("thinking_delta") => {
                                    if let Some(delta) = update["delta"].as_str() {
                                        let _ = events_tx.send(EventKind::AgentThoughtDelta {
                                            delta: delta.to_string(),
                                            started_at: None,
                                        });
                                    }
                                }
                                Some("error") => {
                                    let reason = update["reason"]
                                        .as_str()
                                        .unwrap_or("Pi stream error")
                                        .to_string();
                                    let _ = events_tx.send(EventKind::Notice {
                                        level: "error".to_string(),
                                        message: reason,
                                    });
                                }
                                _ => {}
                            }
                        }
                        Some("tool_execution_start") => {
                            let _ = events_tx.send(EventKind::ToolCall {
                                tool_call_id: value["toolCallId"]
                                    .as_str()
                                    .unwrap_or_default()
                                    .to_string(),
                                title: value["toolName"].as_str().unwrap_or("tool").to_string(),
                                kind: "other".to_string(),
                                status: "in_progress".to_string(),
                                locations: Vec::new(),
                                raw_input: Some(value["args"].clone()).filter(|v| !v.is_null()),
                                meta: None,
                            });
                        }
                        Some("tool_execution_update") => {
                            let _ = events_tx.send(EventKind::ToolCallUpdate {
                                tool_call_id: value["toolCallId"]
                                    .as_str()
                                    .unwrap_or_default()
                                    .to_string(),
                                status: Some("in_progress".to_string()),
                                content: Some(value["partialResult"].clone()),
                                raw_output: None,
                                meta: None,
                            });
                        }
                        Some("tool_execution_end") => {
                            let failed = value["isError"].as_bool().unwrap_or(false);
                            let _ = events_tx.send(EventKind::ToolCallUpdate {
                                tool_call_id: value["toolCallId"]
                                    .as_str()
                                    .unwrap_or_default()
                                    .to_string(),
                                status: Some(
                                    if failed { "failed" } else { "completed" }.to_string(),
                                ),
                                content: Some(value["result"].clone()),
                                raw_output: Some(value["result"].clone()),
                                meta: None,
                            });
                        }
                        Some("extension_ui_request") => {
                            // Pi extensions can ask the UI for input; the native
                            // driver ships chat/tool streaming first, so surface
                            // the request instead of silently dropping it.
                            let _ = events_tx.send(EventKind::Notice {
                                level: "warning".to_string(),
                                message: value["message"]
                                    .as_str()
                                    .unwrap_or("Pi extension requested input")
                                    .to_string(),
                            });
                        }
                        _ => {}
                    }
                }
                dead.store(true, Ordering::Relaxed);
                turn_failed.store(true, Ordering::Relaxed);
                let waiting: Vec<_> = pending
                    .lock()
                    .expect("pending lock poisoned")
                    .drain()
                    .collect();
                for (_, sender) in waiting {
                    let _ = sender.send(Err(DriverError::HungUp {
                        method: "pi".to_string(),
                    }));
                }
                if let Some(sender) = turn_done.lock().ok().and_then(|mut s| s.take()) {
                    let _ = sender.send(StopReason::Cancelled);
                }
            });
        }

        Ok((
            Self {
                child,
                stdin_tx,
                pending,
                next_id: Arc::new(AtomicI64::new(1)),
                frames,
                dead,
                killed: Arc::new(AtomicBool::new(false)),
                aborted,
                turn_done,
                turn_failed,
                cwd: config.cwd.clone(),
                _client_tx: client_tx,
            },
            PiRpcStreams {
                events_rx,
                client_requests_rx,
            },
        ))
    }

    async fn request(
        &self,
        command: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, DriverError> {
        let id = format!("pult-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        if self.is_dead() {
            return Err(DriverError::HungUp {
                method: command.to_string(),
            });
        }
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .expect("pending lock poisoned")
            .insert(id.clone(), tx);
        let mut payload = json!({ "id": id, "type": command });
        if let Value::Object(fields) = params {
            for (key, value) in fields {
                payload[&key] = value;
            }
        }
        if self.stdin_tx.send(payload).await.is_err() {
            self.pending
                .lock()
                .expect("pending lock poisoned")
                .remove(&id);
            return Err(DriverError::HungUp {
                method: command.to_string(),
            });
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                self.pending
                    .lock()
                    .expect("pending lock poisoned")
                    .remove(&id);
                Err(DriverError::Closed)
            }
            Err(_) => {
                self.pending
                    .lock()
                    .expect("pending lock poisoned")
                    .remove(&id);
                Err(DriverError::Timeout {
                    method: command.to_string(),
                })
            }
        }
    }

    pub async fn initialize(&self) -> Result<InitializeResult, DriverError> {
        let state = self
            .request("get_state", json!({}), Duration::from_secs(30))
            .await?;
        let version = state["model"]["id"]
            .as_str()
            .unwrap_or(env!("CARGO_PKG_VERSION"));
        Ok(InitializeResult {
            protocol_version: LATEST_PROTOCOL_VERSION,
            agent_capabilities: AgentCapabilities {
                prompt_capabilities: PromptCapabilities {
                    image: true,
                    ..Default::default()
                },
                ..Default::default()
            },
            auth_methods: Vec::<AuthMethod>::new(),
            agent_info: Some(Implementation::new("pi", version)),
            meta: None,
        })
    }

    pub async fn new_session_with_mcp(
        &self,
        cwd: &str,
        mcp_servers: Vec<crate::protocol::types::McpServer>,
    ) -> Result<NewSessionResult, DriverError> {
        if !mcp_servers.is_empty() {
            return unsupported("per-session MCP servers (configure them in Pi settings)");
        }
        if let Some(spawn_cwd) = &self.cwd {
            if !same_dir(std::path::Path::new(cwd), spawn_cwd) {
                return Err(DriverError::Rpc(RpcError::new(
                    -32602,
                    format!(
                        "Pi runs in {}; a session cannot switch cwd to {cwd}",
                        spawn_cwd.display()
                    ),
                )));
            }
        }
        self.request("new_session", json!({}), Duration::from_secs(30))
            .await?;
        let state = self
            .request("get_state", json!({}), Duration::from_secs(30))
            .await?;
        Ok(NewSessionResult {
            session_id: state["sessionId"]
                .as_str()
                .unwrap_or("pi-session")
                .to_string(),
            modes: None,
            config_options: Vec::new(),
            meta: None,
        })
    }

    pub async fn load_session_with_mcp(
        &self,
        _session_id: &str,
        _cwd: &str,
        _mcp_servers: Vec<crate::protocol::types::McpServer>,
    ) -> Result<LoadSessionResult, DriverError> {
        unsupported("session/load (Pi sessions resume inside the Pi CLI)")
    }

    pub async fn prompt(
        &self,
        _session_id: &str,
        content: Vec<ContentBlock>,
    ) -> Result<PromptResult, DriverError> {
        let mut message = String::new();
        let mut images = Vec::new();
        for block in content {
            match block {
                ContentBlock::Text { text } => message.push_str(&text),
                ContentBlock::Image { data, mime_type } => images.push(json!({
                    "type": "image",
                    "data": data,
                    "mimeType": mime_type,
                })),
                _ => {}
            }
        }
        let (tx, rx) = oneshot::channel();
        *self.turn_done.lock().expect("turn lock poisoned") = Some(tx);
        self.aborted.store(false, Ordering::Relaxed);
        self.turn_failed.store(false, Ordering::Relaxed);
        let mut params = json!({ "message": message });
        if !images.is_empty() {
            params["images"] = Value::Array(images);
        }
        if let Err(error) = self
            .request("prompt", params, Duration::from_secs(30))
            .await
        {
            self.turn_done.lock().expect("turn lock poisoned").take();
            // The process may have died while answering an abort: that is the
            // cancellation the caller asked for, not a crash.
            if self.aborted.load(Ordering::Relaxed) {
                return Ok(PromptResult {
                    stop_reason: StopReason::Cancelled,
                    meta: None,
                });
            }
            return Err(error);
        }
        let result = match tokio::time::timeout(Duration::from_secs(600), rx).await {
            Ok(Ok(stop_reason)) => Ok(PromptResult {
                stop_reason,
                meta: None,
            }),
            Ok(Err(_)) => Err(DriverError::Closed),
            Err(_) => Err(DriverError::Timeout {
                method: "prompt".to_string(),
            }),
        };
        if self.turn_failed.swap(false, Ordering::Relaxed) {
            if let Some(error) = eof_error(self.aborted.load(Ordering::Relaxed)) {
                return Err(error);
            }
        }
        result
    }

    pub async fn cancel(&self, _session_id: &str) -> Result<(), DriverError> {
        self.aborted.store(true, Ordering::Relaxed);
        self.request("abort", json!({}), Duration::from_secs(30))
            .await
            .map(|_| ())
    }

    pub async fn steer(
        &self,
        _session_id: &str,
        _content: Vec<ContentBlock>,
    ) -> Result<crate::protocol::types::SteerResult, DriverError> {
        unsupported("live steering (_session/steering)")
    }

    pub async fn set_mode(&self, _session_id: &str, _mode_id: &str) -> Result<Value, DriverError> {
        unsupported("ACP session modes")
    }

    pub async fn set_config_option(
        &self,
        _session_id: &str,
        _config_id: &str,
        _value: crate::protocol::types::ConfigOptionValue,
    ) -> Result<crate::protocol::types::SetConfigOptionResult, DriverError> {
        unsupported("ACP config options")
    }

    pub async fn authenticate(&self, _method_id: &str) -> Result<AuthenticateResult, DriverError> {
        unsupported("ACP authentication methods (sign in with the Pi CLI)")
    }

    pub async fn respond_client(
        &self,
        _id: RequestId,
        _reply: super::acp::ClientReply,
    ) -> Result<(), DriverError> {
        unsupported("client requests (Pi RPC never sends them)")
    }

    pub fn diagnostics_frames(&self) -> Vec<String> {
        self.frames
            .lock()
            .map(|frames| frames.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn pid(&self) -> Option<u32> {
        self.child.lock().ok().and_then(|child| child.id())
    }

    pub fn is_dead(&self) -> bool {
        self.dead.load(Ordering::Relaxed)
    }

    pub fn died_on_own(&self) -> bool {
        self.is_dead() && !self.killed.load(Ordering::Relaxed)
    }

    pub fn kill(&self) {
        self.killed.store(true, Ordering::Relaxed);
        if let Ok(mut child) = self.child.lock() {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            if let Some(pid) = child.id() {
                crate::processes::unregister_process(pid);
            }
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                if let Some(pid) = child.id() {
                    let tree_gone = std::process::Command::new("taskkill")
                        .args(["/PID", &pid.to_string(), "/T", "/F"])
                        .creation_flags(0x0800_0000)
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                        .map(|status| status.success())
                        .unwrap_or(false);
                    if tree_gone {
                        return;
                    }
                }
            }
            let _ = child.start_kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_path() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/mock-pi-rpc.mjs")
    }

    fn mock_config() -> SpawnConfig {
        SpawnConfig {
            command: "node".to_string(),
            args: vec![fixture_path().to_string_lossy().into_owned()],
            env: std::collections::HashMap::new(),
            env_remove: Vec::new(),
            initialize_timeout: Duration::from_secs(60),
            cancel_meta: None,
            driver: "pi_rpc".to_string(),
            cwd: None,
        }
    }

    #[test]
    fn reserved_launch_args_are_rejected() {
        for flag in ["--mode", "--extension=/tmp/x.mjs", "-e", "--print"] {
            let args = vec![flag.to_string()];
            assert!(
                validate_launch_args(&args).is_err(),
                "{flag} must be reserved"
            );
        }
        assert!(validate_launch_args(&["--model".to_string(), "x".to_string()]).is_ok());
    }

    #[test]
    fn eof_after_an_abort_is_a_cancellation_not_a_hangup() {
        assert!(
            eof_error(true).is_none(),
            "a requested cancel must not be reported as HungUp"
        );
        assert!(matches!(eof_error(false), Some(DriverError::HungUp { .. })));
    }

    #[tokio::test]
    async fn pi_session_rejects_cwd_switches_and_per_session_mcp_servers() {
        if !fixture_path().is_file() {
            return;
        }
        let cwd = std::env::temp_dir();
        let mut config = mock_config();
        config.cwd = Some(cwd.clone());
        let (conn, _streams) = PiRpcConn::spawn(&config).expect("spawn mock pi");
        let session = conn
            .new_session_with_mcp(&cwd.to_string_lossy(), Vec::new())
            .await
            .expect("the spawn cwd is fine");
        assert_eq!(session.session_id, "pi-mock");

        let server = crate::protocol::types::McpServer::Stdio {
            extra: json!({ "name": "pult_orchestrator" }),
        };
        assert!(
            conn.new_session_with_mcp(&cwd.to_string_lossy(), vec![server])
                .await
                .is_err(),
            "Pi cannot take per-session MCP servers"
        );
        assert!(
            conn.new_session_with_mcp("C:\\pult-other-cwd", Vec::new())
                .await
                .is_err(),
            "Pi cannot switch a session cwd"
        );
        conn.kill();
    }

    #[tokio::test]
    async fn unsupported_operations_report_an_error_instead_of_fake_success() {
        if !fixture_path().is_file() {
            return;
        }
        let (conn, _streams) = PiRpcConn::spawn(&mock_config()).expect("spawn mock pi");
        assert!(conn.set_mode("pi-mock", "architect").await.is_err());
        assert!(conn
            .set_config_option(
                "pi-mock",
                "thought_level",
                crate::protocol::types::ConfigOptionValue::String("high".into()),
            )
            .await
            .is_err());
        assert!(conn.authenticate("any").await.is_err());
        assert!(conn
            .load_session_with_mcp("pi-mock", ".", Vec::new())
            .await
            .is_err());
        conn.kill();
    }

    #[tokio::test]
    async fn pi_turn_streams_unicode_safe_text_and_tools() {
        if !fixture_path().is_file() {
            return;
        }
        let (conn, streams) = PiRpcConn::spawn(&mock_config()).expect("spawn mock pi");
        let init = conn.initialize().await.expect("initialize");
        assert_eq!(
            init.agent_info.as_ref().map(|info| info.name.as_str()),
            Some("pi")
        );

        let session = conn
            .new_session_with_mcp(".", Vec::new())
            .await
            .expect("session");
        assert_eq!(session.session_id, "pi-mock");

        let result = conn
            .prompt(
                &session.session_id,
                vec![ContentBlock::Text {
                    text: "hi".to_string(),
                }],
            )
            .await
            .expect("prompt");
        assert!(matches!(result.stop_reason, StopReason::EndTurn));

        let mut text = String::new();
        let mut thought = false;
        let mut tool = false;
        let mut events = streams.events_rx;
        while let Ok(event) = events.try_recv() {
            match event {
                EventKind::AgentMessageDelta { delta } => text.push_str(&delta),
                EventKind::AgentThoughtDelta { .. } => thought = true,
                EventKind::ToolCall { .. } => tool = true,
                _ => {}
            }
        }
        assert_eq!(text, "Hello\u{2028}line\u{2029}para");
        assert!(thought, "thinking deltas must map to thought rows");
        assert!(tool, "tool execution must map to a tool row");
        conn.kill();
    }
}
