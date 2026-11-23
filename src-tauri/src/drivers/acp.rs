//! Universal ACP driver: one spawned agent process, NDJSON JSON-RPC over
//! stdio (§5.1–5.5). Wire messages are parsed by `protocol/` and normalized
//! into app `Event`s. Client-side requests from the agent (fs, permission,
//! elicitation) are forwarded to the runtime over a channel — the runtime
//! owns policy (sandbox, permission modes, UI surfacing, §4.4).

use futures::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};
use tokio_util::codec::{FramedRead, FramedWrite};

use crate::events::EventKind;
use crate::protocol::codec::NdjsonCodec;

/// Windows: suppress the console window a GUI parent would otherwise pop for
/// every console-subsystem child (agents, npm shims).
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
use crate::protocol::jsonrpc::{
    parse_incoming, Incoming, InvalidMessage, Outgoing, RequestId, RpcError, ERR_AUTH_REQUIRED,
    ERR_INTERNAL, ERR_INVALID_PARAMS, ERR_METHOD_NOT_FOUND, ERR_RESOURCE_NOT_FOUND,
};
use crate::protocol::types::{
    AuthenticateParams, AuthenticateResult, CancelParams, ClientCapabilities, ConfigOptionValue,
    ContentBlock, CreateElicitationParams, CreateTerminalParams, ElicitationAction,
    ElicitationResult, Implementation, InitializeParams, InitializeResult, LoadSessionParams,
    LoadSessionResult, NewSessionParams, NewSessionResult, PromptParams, PromptResult,
    ReadTextFileParams, RequestPermissionOutcome, RequestPermissionOutcomeKind,
    RequestPermissionParams, SessionNotification, SessionUpdate, SetConfigOptionParams,
    SetConfigOptionResult, SetModeParams, SteerParams, SteerResult, TerminalRefParams,
    ToolCallStatus, ToolCallUpdateData, ToolKind, WriteTextFileParams,
};
use crate::protocol::LATEST_PROTOCOL_VERSION;

/// How the runtime launches a driver.
#[derive(Debug, Clone)]
pub struct SpawnConfig {
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    /// Variables inherited from Pult's own process that must not leak into the
    /// agent (a nested Claude session breaks sign-in and session ids).
    pub env_remove: Vec<String>,
    /// Handshake budget; Grok's cold ACP start takes 9–14s.
    pub initialize_timeout: std::time::Duration,
    /// Provider-specific `session/cancel` `_meta` (Grok: ctrl_c trigger).
    pub cancel_meta: Option<serde_json::Value>,
    /// Driver id from the instance spec (`acp`, `pi_rpc`, `mock`).
    pub driver: String,
    /// Working directory for the agent process (the thread's workspace).
    pub cwd: Option<std::path::PathBuf>,
}

/// A client-side request from the agent, handed to the runtime for policy.
/// The runtime answers through [`AcpConn::respond_client`] with the same
/// `request_id`.
#[derive(Debug)]
pub enum ClientRequest {
    Permission {
        request_id: RequestId,
        params: RequestPermissionParams,
    },
    ReadFile {
        request_id: RequestId,
        params: ReadTextFileParams,
    },
    WriteFile {
        request_id: RequestId,
        params: WriteTextFileParams,
    },
    Elicitation {
        request_id: RequestId,
        params: CreateElicitationParams,
    },
    TerminalCreate {
        request_id: RequestId,
        params: CreateTerminalParams,
    },
    TerminalOutput {
        request_id: RequestId,
        params: TerminalRefParams,
    },
    TerminalWait {
        request_id: RequestId,
        params: TerminalRefParams,
    },
    TerminalKill {
        request_id: RequestId,
        params: TerminalRefParams,
    },
    TerminalRelease {
        request_id: RequestId,
        params: TerminalRefParams,
    },
}

/// The runtime's answer to a client-side request.
pub type ClientReply = Result<Value, RpcError>;

#[derive(Debug, thiserror::Error)]
pub enum DriverError {
    #[error("spawn {command}: {source}")]
    Spawn {
        command: String,
        source: std::io::Error,
    },
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("protocol: {0}")]
    Protocol(#[from] InvalidMessage),
    #[error("serialize: {0}")]
    Serialize(#[from] serde_json::Error),
    #[error("agent hung up before responding to {method}")]
    HungUp { method: String },
    #[error("request {method} timed out")]
    Timeout { method: String },
    #[error("{0}")]
    Rpc(#[from] RpcError),
    #[error("driver already shut down")]
    Closed,
}

impl DriverError {
    /// Only the agent's auth-required error means "sign in", not any RPC error.
    pub fn is_auth_required(&self) -> bool {
        matches!(self, DriverError::Rpc(err) if err.code == ERR_AUTH_REQUIRED)
    }
}

type PendingMap = Arc<Mutex<HashMap<RequestId, oneshot::Sender<ClientReply>>>>;

/// One connected agent process. The event and client-request receivers are
/// NOT part of the struct: `spawn` returns them separately so exactly one
/// owner (the run loop) can consume them without Arc coordination.
pub struct AcpConn {
    child: Arc<Mutex<Child>>,
    stdin_tx: mpsc::Sender<Outgoing>,
    pending: PendingMap,
    next_id: Arc<AtomicI64>,
    /// Diagnostics ring (M6): last raw protocol frames, newest last, for the
    /// diagnostics panel ("last raw frames", §8 M6).
    frames: Arc<Mutex<std::collections::VecDeque<String>>>,
    /// The stdout loop saw EOF — the agent process is gone (M7 error states).
    dead: Arc<AtomicBool>,
    /// pult itself called kill(): distinguishes our shutdown from a crash.
    killed: Arc<AtomicBool>,
    initialize_timeout: std::time::Duration,
    cancel_meta: Option<serde_json::Value>,
}

/// Ring cap for the diagnostics frame log.
const FRAME_RING: usize = 60;

fn record_frame(
    ring: &Arc<Mutex<std::collections::VecDeque<String>>>,
    direction: &str,
    summary: String,
) {
    let mut guard = ring.lock().expect("frames lock poisoned");
    // Frames can carry multibyte text; byte truncation would panic mid-char.
    let line: String = format!("{direction} {summary}").chars().take(600).collect();
    guard.push_back(line);
    if guard.len() > FRAME_RING {
        guard.pop_front();
    }
}

pub struct AcpStreams {
    /// Normalized app events (session/update projections); the runtime stamps
    /// run_id/seq/ts when persisting.
    pub events_rx: mpsc::UnboundedReceiver<EventKind>,
    /// Client-side requests waiting for runtime policy decisions.
    pub client_requests_rx: mpsc::UnboundedReceiver<ClientRequest>,
}

impl AcpConn {
    /// Snapshot of the diagnostics ring, oldest first.
    pub fn diagnostics_frames(&self) -> Vec<String> {
        self.frames
            .lock()
            .expect("frames lock poisoned")
            .iter()
            .cloned()
            .collect()
    }

    /// OS pid of the agent process, when it is still running.
    pub fn pid(&self) -> Option<u32> {
        self.child.lock().ok().and_then(|child| child.id())
    }
}

impl AcpConn {
    /// Spawn the agent process and start pumping its streams.
    pub fn spawn(config: &SpawnConfig) -> Result<(Self, AcpStreams), DriverError> {
        // Resolve bare names against PATH honoring PATHEXT: `opencode` on
        // Windows is an `opencode.cmd` shim, and CreateProcess only finds
        // `.exe` implicitly — "program not found" without this.
        let mut command = config.command.clone();
        let args = config.args.clone();
        if !std::path::Path::new(&command).is_absolute() {
            if let Some(resolved) = crate::config::resolve_command(&command) {
                command = resolved.to_string_lossy().into_owned();
            }
        }
        // `.cmd`/`.bat` shims cannot start directly — route through cmd.exe.
        let is_shim = std::path::Path::new(&command)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
            .unwrap_or(false);
        let mut cmd = if is_shim {
            let mut c = Command::new("cmd");
            c.arg("/c").arg(&command).args(&args);
            c
        } else {
            let mut c = Command::new(&command);
            c.args(&args);
            c
        };
        // The app is a GUI process: without CREATE_NO_WINDOW every agent spawn
        // pops a visible console window (the cascade the user saw).
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        for key in &config.env_remove {
            cmd.env_remove(key);
        }
        let mut child = cmd
            .envs(&config.env)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|source| DriverError::Spawn {
                command: config.command.clone(),
                source,
            })?;

        let child_stdin = child.stdin.take().expect("stdin piped just above");
        let child_stdout = child.stdout.take().expect("stdout piped just above");
        let child_stderr = child.stderr.take().expect("stderr piped just above");
        let child = Arc::new(Mutex::new(child));

        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (stdin_tx, mut stdin_rx) = mpsc::channel::<Outgoing>(128);
        let (events_tx, events_rx) = mpsc::unbounded_channel::<EventKind>();
        let (client_tx, client_requests_rx) = mpsc::unbounded_channel::<ClientRequest>();
        let frames: Arc<Mutex<std::collections::VecDeque<String>>> =
            Arc::new(Mutex::new(std::collections::VecDeque::new()));
        let dead = Arc::new(AtomicBool::new(false));

        // stdin writer: serialize outgoing messages through the codec.
        {
            let mut framed = FramedWrite::new(child_stdin, NdjsonCodec::new());
            let frames = Arc::clone(&frames);
            tokio::spawn(async move {
                while let Some(msg) = stdin_rx.recv().await {
                    match &msg {
                        Outgoing::Request { method, .. } => {
                            record_frame(&frames, "→", format!("{method} (request)"));
                        }
                        Outgoing::Notification { method, .. } => {
                            record_frame(&frames, "→", format!("{method} (notification)"));
                        }
                        _ => {}
                    }
                    if framed.send(msg.to_value()).await.is_err() {
                        break; // agent is gone; pending requests will time out / hang up
                    }
                }
            });
        }

        // stderr pump: diagnostics only, never interleaved with the stream (§5.1).
        {
            use tokio::io::AsyncBufReadExt;
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

        // stdout reader: classify messages, resolve pending, project updates.
        {
            let pending = Arc::clone(&pending);
            let stdin_tx = stdin_tx.clone();
            let frames = Arc::clone(&frames);
            let dead = Arc::clone(&dead);
            tokio::spawn(async move {
                let mut framed = FramedRead::new(child_stdout, NdjsonCodec::new());
                while let Some(Ok(value)) = framed.next().await {
                    let incoming = match parse_incoming(value) {
                        Ok(incoming) => incoming,
                        Err(InvalidMessage(bad)) => {
                            record_frame(
                                &frames,
                                "←",
                                format!(
                                    "unclassifiable: {}",
                                    serde_json::to_string(&bad).unwrap_or_default()
                                ),
                            );
                            tracing::warn!(target: "pult::protocol",
                                head = %serde_json::to_string(&bad).unwrap_or_default(),
                                "unclassifiable message dropped");
                            continue;
                        }
                    };
                    match incoming {
                        Incoming::Request { id, method, params } => {
                            record_frame(&frames, "←", format!("{method} (client request)"));
                            handle_client_request(id, method, params, &client_tx, &stdin_tx).await;
                        }
                        Incoming::Notification { method, params } => {
                            record_frame(&frames, "←", format!("{method} (notification)"));
                            if method == "session/update" {
                                match serde_json::from_value::<SessionNotification>(params) {
                                    Ok(note) => {
                                        for kind in project_update(note.update) {
                                            let _ = events_tx.send(kind);
                                        }
                                    }
                                    Err(err) => tracing::warn!(target: "pult::protocol",
                                        error = %err,
                                        "session/update failed to parse against pinned schema"),
                                }
                            } else {
                                tracing::debug!(target: "pult::protocol",
                                    method = %method, "unknown notification ignored");
                            }
                        }
                        Incoming::Response { id, result } => {
                            if let Some(sender) =
                                pending.lock().expect("pending lock poisoned").remove(&id)
                            {
                                let _ = sender.send(result);
                            }
                        }
                    }
                }
                // Agent hung up: fail every pending request.
                dead.store(true, Ordering::Relaxed);
                let waiting: Vec<_> = pending
                    .lock()
                    .expect("pending lock poisoned")
                    .drain()
                    .collect();
                for (_, sender) in waiting {
                    let _ = sender.send(Err(RpcError::new(ERR_INTERNAL, "agent process exited")));
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
                initialize_timeout: config.initialize_timeout,
                cancel_meta: config.cancel_meta.clone(),
            },
            AcpStreams {
                events_rx,
                client_requests_rx,
            },
        ))
    }

    fn next_request_id(&self) -> RequestId {
        RequestId::Num(self.next_id.fetch_add(1, Ordering::Relaxed))
    }

    async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: std::time::Duration,
    ) -> Result<Value, DriverError> {
        if self.is_dead() {
            return Err(DriverError::HungUp {
                method: method.to_string(),
            });
        }
        let id = self.next_request_id();
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .expect("pending lock poisoned")
            .insert(id.clone(), tx);
        if self
            .stdin_tx
            .send(Outgoing::Request {
                id: id.clone(),
                method: method.to_string(),
                params,
            })
            .await
            .is_err()
        {
            // Nobody will answer: do not leave the oneshot in the map.
            self.pending
                .lock()
                .expect("pending lock poisoned")
                .remove(&id);
            return Err(DriverError::HungUp {
                method: method.to_string(),
            });
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result.map_err(DriverError::Rpc),
            Ok(Err(_recv)) => Err(DriverError::HungUp {
                method: method.to_string(),
            }),
            Err(_elapsed) => {
                self.pending
                    .lock()
                    .expect("pending lock poisoned")
                    .remove(&id);
                Err(DriverError::Timeout {
                    method: method.to_string(),
                })
            }
        }
    }

    /// §5.2 handshake. Returns the negotiated capabilities + auth methods.
    pub async fn initialize(&self) -> Result<InitializeResult, DriverError> {
        let params = InitializeParams {
            protocol_version: LATEST_PROTOCOL_VERSION,
            client_capabilities: ClientCapabilities::pult_v1(),
            client_info: Implementation::new("pult", env!("CARGO_PKG_VERSION")),
        };
        let value = self
            .request(
                "initialize",
                serde_json::to_value(params)?,
                self.initialize_timeout,
            )
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    /// §5.3 session/new.
    /// `authenticate` (agent-managed methods only; terminal methods are run by
    /// the caller as a separate process and never sent here).
    pub async fn authenticate(&self, method_id: &str) -> Result<AuthenticateResult, DriverError> {
        let value = self
            .request(
                "authenticate",
                serde_json::to_value(AuthenticateParams {
                    method_id: method_id.to_string(),
                })?,
                std::time::Duration::from_secs(120),
            )
            .await?;
        let parsed: Option<AuthenticateResult> = serde_json::from_value(value)?;
        Ok(parsed.unwrap_or_default())
    }

    pub async fn new_session(&self, cwd: &str) -> Result<NewSessionResult, DriverError> {
        self.new_session_with_mcp(cwd, Vec::new()).await
    }

    pub async fn new_session_with_mcp(
        &self,
        cwd: &str,
        mcp_servers: Vec<crate::protocol::types::McpServer>,
    ) -> Result<NewSessionResult, DriverError> {
        let params = NewSessionParams {
            cwd: cwd.to_string(),
            mcp_servers,
        };
        let value = self
            .request(
                "session/new",
                serde_json::to_value(params)?,
                std::time::Duration::from_secs(30),
            )
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    /// §5.3 resume via session/load (capability-gated by the caller).
    pub async fn load_session(
        &self,
        session_id: &str,
        cwd: &str,
    ) -> Result<LoadSessionResult, DriverError> {
        self.load_session_with_mcp(session_id, cwd, Vec::new())
            .await
    }

    pub async fn load_session_with_mcp(
        &self,
        session_id: &str,
        cwd: &str,
        mcp_servers: Vec<crate::protocol::types::McpServer>,
    ) -> Result<LoadSessionResult, DriverError> {
        let params = LoadSessionParams {
            session_id: session_id.to_string(),
            cwd: cwd.to_string(),
            mcp_servers,
        };
        let value = self
            .request(
                "session/load",
                serde_json::to_value(params)?,
                std::time::Duration::from_secs(30),
            )
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    /// §5.4 prompt turn. Streaming updates arrive on `events_rx` while this
    /// future waits for the final `{ stopReason }`. The prompt is a full
    /// content-block list (text + capability-gated images, §5.4).
    pub async fn prompt(
        &self,
        session_id: &str,
        content: Vec<ContentBlock>,
    ) -> Result<PromptResult, DriverError> {
        let params = PromptParams {
            session_id: session_id.to_string(),
            prompt: content,
        };
        let value = self
            .request(
                "session/prompt",
                serde_json::to_value(params)?,
                // A prompt legitimately streams for as long as the agent works;
                // a 10-minute cap marked long turns as crashed mid-run. The turn
                // still ends on end_turn, Stop, or the process dying, so this is
                // only a guard against a wedged CLI.
                std::time::Duration::from_secs(24 * 60 * 60),
            )
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    /// Live steering (`_session/steering`, pult extension): adds a message to
    /// the turn that is already running instead of cancelling it. Agents that
    /// do not implement it answer method-not-found.
    pub async fn steer(
        &self,
        session_id: &str,
        content: Vec<ContentBlock>,
    ) -> Result<SteerResult, DriverError> {
        let params = SteerParams {
            session_id: session_id.to_string(),
            prompt: content,
            meta: Some(serde_json::json!({
                "steering": { "idleBehavior": "promptRequired" }
            })),
        };
        let value = self
            .request(
                "_session/steering",
                serde_json::to_value(params)?,
                std::time::Duration::from_secs(30),
            )
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    /// §5.3 cancel — a notification; no response expected.
    pub async fn cancel(&self, session_id: &str) -> Result<(), DriverError> {
        self.stdin_tx
            .send(Outgoing::Notification {
                method: "session/cancel".to_string(),
                params: serde_json::to_value(CancelParams {
                    session_id: session_id.to_string(),
                    meta: self.cancel_meta.clone(),
                })?,
            })
            .await
            .map_err(|_| DriverError::HungUp {
                method: "session/cancel".to_string(),
            })
    }

    /// §5.3 mode switch.
    pub async fn set_mode(&self, session_id: &str, mode_id: &str) -> Result<Value, DriverError> {
        self.request(
            "session/set_mode",
            serde_json::to_value(SetModeParams {
                session_id: session_id.to_string(),
                mode_id: mode_id.to_string(),
            })?,
            std::time::Duration::from_secs(15),
        )
        .await
    }

    /// §5.4 config option switch (`session/set_config_option`).
    pub async fn set_config_option(
        &self,
        session_id: &str,
        config_id: &str,
        value: ConfigOptionValue,
    ) -> Result<SetConfigOptionResult, DriverError> {
        let value = self
            .request(
                "session/set_config_option",
                serde_json::to_value(SetConfigOptionParams::new(session_id, config_id, value))?,
                std::time::Duration::from_secs(15),
            )
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    /// Answer a pending client-side request (permission/fs/elicitation).
    pub async fn respond_client(
        &self,
        request_id: RequestId,
        reply: ClientReply,
    ) -> Result<(), DriverError> {
        let outgoing = match reply {
            Ok(result) => Outgoing::ResponseOk {
                id: request_id,
                result,
            },
            Err(error) => Outgoing::ResponseErr {
                id: request_id,
                error,
            },
        };
        let result = self
            .stdin_tx
            .send(outgoing)
            .await
            .map_err(|_| DriverError::HungUp {
                method: "client response".to_string(),
            });
        result
    }

    /// Terminate the agent process. On Windows a `.cmd`/`.bat` shim runs the
    /// real agent as a grandchild, so killing only cmd.exe orphans it (and its
    /// pipes/worktree locks): take the whole tree down.
    pub fn kill(&self) {
        self.killed.store(true, Ordering::Relaxed);
        if let Ok(mut child) = self.child.lock() {
            // Already exited: no tree left to kill (and the pid may be reused).
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
                    // Wait for taskkill: dropping the Child (kill_on_drop) or
                    // start_kill() before it walks the tree would orphan the
                    // shim's grandchildren. The child lock keeps it alive here.
                    let tree_gone = std::process::Command::new("taskkill")
                        .args(["/PID", &pid.to_string(), "/T", "/F"])
                        .creation_flags(CREATE_NO_WINDOW)
                        .stdin(std::process::Stdio::null())
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
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

    /// True once the stdout reader saw EOF: the agent process is gone.
    pub fn is_dead(&self) -> bool {
        self.dead.load(Ordering::Relaxed)
    }

    /// True when the agent's stdout ended on its own and pult did not kill
    /// it - i.e. the process crashed mid-run (M7 agent-crash error state).
    pub fn died_on_own(&self) -> bool {
        self.dead.load(Ordering::Relaxed) && !self.killed.load(Ordering::Relaxed)
    }
}

async fn handle_client_request(
    id: RequestId,
    method: String,
    params: Value,
    client_tx: &mpsc::UnboundedSender<ClientRequest>,
    stdin_tx: &mpsc::Sender<Outgoing>,
) {
    let parsed: Option<ClientRequest> = match method.as_str() {
        "session/request_permission" => serde_json::from_value::<RequestPermissionParams>(params)
            .ok()
            .map(|params| ClientRequest::Permission {
                request_id: id.clone(),
                params,
            }),
        "fs/read_text_file" => serde_json::from_value::<ReadTextFileParams>(params)
            .ok()
            .map(|params| ClientRequest::ReadFile {
                request_id: id.clone(),
                params,
            }),
        "fs/write_text_file" => serde_json::from_value::<WriteTextFileParams>(params)
            .ok()
            .map(|params| ClientRequest::WriteFile {
                request_id: id.clone(),
                params,
            }),
        "elicitation/create" => serde_json::from_value::<CreateElicitationParams>(params)
            .ok()
            .map(|params| ClientRequest::Elicitation {
                request_id: id.clone(),
                params,
            }),
        "terminal/create" => serde_json::from_value::<CreateTerminalParams>(params)
            .ok()
            .map(|params| ClientRequest::TerminalCreate {
                request_id: id.clone(),
                params,
            }),
        "terminal/output" => serde_json::from_value::<TerminalRefParams>(params)
            .ok()
            .map(|params| ClientRequest::TerminalOutput {
                request_id: id.clone(),
                params,
            }),
        "terminal/wait_for_exit" => serde_json::from_value::<TerminalRefParams>(params)
            .ok()
            .map(|params| ClientRequest::TerminalWait {
                request_id: id.clone(),
                params,
            }),
        "terminal/kill" => serde_json::from_value::<TerminalRefParams>(params)
            .ok()
            .map(|params| ClientRequest::TerminalKill {
                request_id: id.clone(),
                params,
            }),
        "terminal/release" => serde_json::from_value::<TerminalRefParams>(params)
            .ok()
            .map(|params| ClientRequest::TerminalRelease {
                request_id: id.clone(),
                params,
            }),
        _ => None,
    };
    match parsed {
        Some(request) => {
            // The runtime answers later via `respond_client` with this id.
            let _ = client_tx.send(request);
        }
        None => {
            let error = RpcError::new(
                ERR_METHOD_NOT_FOUND,
                format!("unknown client method: {method}"),
            );
            let _ = stdin_tx.send(Outgoing::ResponseErr { id, error }).await;
        }
    }
}

pub fn tool_kind_str(kind: ToolKind) -> &'static str {
    match kind {
        ToolKind::Read => "read",
        ToolKind::Edit => "edit",
        ToolKind::Delete => "delete",
        ToolKind::Move => "move",
        ToolKind::Search => "search",
        ToolKind::Execute => "execute",
        ToolKind::Think => "think",
        ToolKind::Fetch => "fetch",
        ToolKind::SwitchMode => "switch_mode",
        ToolKind::Other => "other",
    }
}

fn tool_status_str(status: ToolCallStatus) -> &'static str {
    match status {
        ToolCallStatus::Pending => "pending",
        ToolCallStatus::InProgress => "in_progress",
        ToolCallStatus::Completed => "completed",
        ToolCallStatus::Failed => "failed",
    }
}

/// Wire → app projection (§5.4 table). Unknown/unsupported variants are
/// logged, never crash; wire content that is not text is skipped for M1.
pub fn project_update(update: SessionUpdate) -> Vec<EventKind> {
    match update {
        SessionUpdate::UserMessageChunk { content } => text_of(&content)
            .map(|text| {
                vec![EventKind::UserMessage {
                    text,
                    images: Vec::new(),
                }]
            })
            .unwrap_or_default(),
        SessionUpdate::AgentMessageChunk { content } => match &content {
            // Agents that return generated images as content blocks (imagegen)
            // become a Markdown data URL so the transcript renders them inline.
            // Multi-megabyte payloads must not block IPC/SQLite: cap them.
            ContentBlock::Image { data, mime_type } => {
                const MAX_INLINE_IMAGE_BYTES: usize = 2_000_000;
                if data.len() > MAX_INLINE_IMAGE_BYTES {
                    vec![EventKind::Notice {
                        level: "warning".to_string(),
                        message: "Generated image is too large to preview".to_string(),
                    }]
                } else {
                    vec![EventKind::AgentMessageDelta {
                        delta: format!(
                            "\n\n![generated image](data:{mime_type};base64,{data})\n\n"
                        ),
                    }]
                }
            }
            _ => text_of(&content)
                .map(|delta| vec![EventKind::AgentMessageDelta { delta }])
                .unwrap_or_default(),
        },
        SessionUpdate::AgentThoughtChunk { content } => text_of(&content)
            .map(|delta| vec![EventKind::AgentThoughtDelta { delta }])
            .unwrap_or_default(),
        SessionUpdate::ToolCall {
            tool_call_id,
            title,
            kind,
            status,
            locations,
            raw_input,
            meta,
            ..
        } => vec![EventKind::ToolCall {
            tool_call_id,
            title,
            kind: kind.map(tool_kind_str).unwrap_or("other").to_string(),
            status: status.map(tool_status_str).unwrap_or("pending").to_string(),
            locations: locations
                .unwrap_or_default()
                .into_iter()
                .map(|l| l.path)
                .collect(),
            raw_input: cap_tool_payload(raw_input),
            meta: cap_tool_payload(meta),
        }],
        SessionUpdate::ToolCallUpdate {
            tool_call_id,
            status,
            content,
            raw_output,
            meta,
            ..
        } => vec![EventKind::ToolCallUpdate {
            tool_call_id,
            status: status.map(|s| tool_status_str(s).to_string()),
            content: cap_tool_payload(content.map(|c| serde_json::to_value(c).unwrap_or_default())),
            raw_output: cap_tool_payload(raw_output),
            meta: cap_tool_payload(meta),
        }],
        SessionUpdate::Plan { entries } => vec![EventKind::Plan {
            entries: entries
                .into_iter()
                .map(|e| crate::events::PlanEntry {
                    content: e.content,
                    status: match e.status {
                        crate::protocol::types::PlanEntryStatus::Pending => {
                            crate::events::PlanEntryStatus::Pending
                        }
                        crate::protocol::types::PlanEntryStatus::InProgress => {
                            crate::events::PlanEntryStatus::InProgress
                        }
                        crate::protocol::types::PlanEntryStatus::Completed => {
                            crate::events::PlanEntryStatus::Completed
                        }
                    },
                })
                .collect(),
        }],
        SessionUpdate::CurrentModeUpdate {
            current_mode_id, ..
        } => {
            vec![EventKind::ModeChange {
                mode_id: current_mode_id,
            }]
        }
        SessionUpdate::Notice {
            severity,
            title,
            content,
            ..
        } => vec![EventKind::Notice {
            level: severity.unwrap_or_else(|| "info".to_string()),
            message: {
                let mut message = title.unwrap_or_default();
                if let Some(text) = content.as_ref().and_then(|c| {
                    serde_json::from_value::<ContentBlock>(c.clone())
                        .ok()
                        .and_then(|b| text_of(&b))
                }) {
                    if !message.is_empty() {
                        message.push_str(": ");
                    }
                    message.push_str(&text);
                }
                message
            },
        }],
        SessionUpdate::AvailableCommandsUpdate {
            available_commands, ..
        } => vec![EventKind::CommandsUpdate {
            commands: available_commands
                .into_iter()
                .map(|c| crate::events::CommandInfo {
                    name: c.name,
                    description: c.description.unwrap_or_default(),
                    input: c.input,
                })
                .collect(),
        }],
        SessionUpdate::SessionInfoUpdate { title, .. } => vec![EventKind::SessionInfo { title }],
        SessionUpdate::ConfigOptionUpdate { config_options, .. } => {
            vec![EventKind::ConfigOptions {
                options: config_options,
            }]
        }
        SessionUpdate::CompactionUpdate {
            compaction_id,
            status,
            summary,
            ..
        } => vec![EventKind::Compaction {
            status: Some(status.unwrap_or_else(|| "in_progress".to_string())),
            compaction_id: Some(compaction_id),
            // `summary` is a full-replacement patch: concrete blocks replace,
            // `[]`/null clear. Text blocks join; non-text blocks are skipped.
            summary_replace: summary.as_ref().map(summary_text),
            summary_append: None,
        }],
        SessionUpdate::CompactionSummaryChunk {
            compaction_id,
            content,
            ..
        } => vec![EventKind::Compaction {
            status: None,
            compaction_id: Some(compaction_id),
            summary_replace: None,
            summary_append: Some(text_blocks_of(std::slice::from_ref(&content))),
        }],
        SessionUpdate::UsageUpdate {
            used, size, cost, ..
        } => {
            vec![EventKind::Usage {
                detail: serde_json::json!({ "used": used, "size": size, "cost": cost }),
            }]
        }
    }
}

/// Tool payloads can carry generated images/base64. Keep IPC and SQLite
/// responsive by replacing multi-megabyte tool blobs with a short marker.
fn cap_tool_payload(value: Option<Value>) -> Option<Value> {
    const MAX_BYTES: usize = 2_000_000;
    let value = value?;
    match serde_json::to_string(&value) {
        Ok(text) if text.len() > MAX_BYTES => Some(serde_json::json!({
            "truncated": true,
            "bytes": text.len(),
            "note": "large tool payload omitted",
        })),
        _ => Some(value),
    }
}

/// Joined text of every text content block (compaction summaries are
/// user-displayable content; non-text blocks have no timeline rendering yet).
fn text_blocks_of(blocks: &[ContentBlock]) -> String {
    blocks
        .iter()
        .filter_map(text_of)
        .collect::<Vec<_>>()
        .join("")
}

/// Raw `summary` patch value → replacement text. An array of text blocks
/// joins; anything unparseable contributes nothing (clear semantics stay
/// visible as an empty replacement string).
fn summary_text(raw: &Value) -> String {
    match serde_json::from_value::<Vec<ContentBlock>>(raw.clone()) {
        Ok(blocks) => text_blocks_of(&blocks),
        Err(_) => String::new(),
    }
}

fn text_of(block: &ContentBlock) -> Option<String> {
    match block {
        ContentBlock::Text { text } => Some(text.clone()),
        _ => None,
    }
}

/// Convenience: the runtime answers permission requests with this shape.
pub fn permission_reply(option_id: Option<String>) -> ClientReply {
    let outcome = match option_id {
        Some(option_id) => RequestPermissionOutcome {
            outcome: RequestPermissionOutcomeKind::Selected { option_id },
        },
        None => RequestPermissionOutcome {
            outcome: RequestPermissionOutcomeKind::Cancelled,
        },
    };
    serde_json::to_value(outcome).map_err(|e| RpcError::new(ERR_INTERNAL, e.to_string()))
}

/// Convenience: build the elicitation reply from the UI's action + content.
pub fn elicitation_reply(action: ElicitationAction, content: Option<Value>) -> ClientReply {
    serde_json::to_value(ElicitationResult { action, content })
        .map_err(|e| RpcError::new(ERR_INTERNAL, e.to_string()))
}

/// Convenience: fs errors must be typed resource errors (§5.5).
pub fn fs_error(message: impl Into<String>) -> RpcError {
    RpcError::new(ERR_RESOURCE_NOT_FOUND, message)
}

/// Convenience: invalid fs params (defensive; schema parsing already guards).
pub fn invalid_params(message: impl Into<String>) -> RpcError {
    RpcError::new(ERR_INVALID_PARAMS, message)
}

/// Shape-check helper used by tests and the runtime: a permission request
/// payload can be re-serialized into the update data it describes.
pub fn tool_call_summary(data: &ToolCallUpdateData) -> String {
    data.title
        .clone()
        .unwrap_or_else(|| data.tool_call_id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::types as wire;
    use serde_json::json;

    #[test]
    fn record_frame_truncates_multibyte_on_a_char_boundary() {
        let ring: Arc<Mutex<std::collections::VecDeque<String>>> =
            Arc::new(Mutex::new(std::collections::VecDeque::new()));
        record_frame(&ring, "←", "ж".repeat(400)); // 800 bytes, 400 chars
        let frames = ring.lock().expect("ring lock");
        let line = frames.back().expect("frame recorded");
        assert!(line.chars().count() <= 600);
        assert!(line.starts_with("← "));
        assert!(!line.contains('\u{FFFD}'), "no broken characters");
    }

    #[test]
    fn oversized_tool_payload_is_truncated() {
        let big = json!({"data": "A".repeat(2_000_001)});
        let capped = cap_tool_payload(Some(big)).expect("capped payload");
        assert_eq!(capped["truncated"], true);
        let small = cap_tool_payload(Some(json!({"ok": true}))).expect("small payload");
        assert_eq!(small["ok"], true);
    }

    #[test]
    fn oversized_generated_image_becomes_a_notice() {
        let update = wire::SessionUpdate::AgentMessageChunk {
            content: wire::ContentBlock::Image {
                data: "A".repeat(2_000_001),
                mime_type: "image/png".into(),
            },
        };
        let projected = project_update(update);
        assert!(matches!(
            projected.as_slice(),
            [EventKind::Notice { level, message }]
                if level == "warning" && message.contains("too large")
        ));
    }

    #[test]
    fn projection_maps_all_ui_visible_variants() {
        use crate::protocol::types as wire;

        let cases: Vec<(wire::SessionUpdate, EventKind)> = vec![
            (
                wire::SessionUpdate::AgentMessageChunk {
                    content: ContentBlock::text("hello"),
                },
                EventKind::AgentMessageDelta {
                    delta: "hello".into(),
                },
            ),
            (
                wire::SessionUpdate::AgentThoughtChunk {
                    content: ContentBlock::text("thinking"),
                },
                EventKind::AgentThoughtDelta {
                    delta: "thinking".into(),
                },
            ),
            (
                wire::SessionUpdate::ToolCall {
                    tool_call_id: "t1".into(),
                    title: "Read file".into(),
                    name: None,
                    kind: Some(wire::ToolKind::Read),
                    status: Some(wire::ToolCallStatus::InProgress),
                    content: None,
                    locations: Some(vec![wire::ToolCallLocation {
                        path: "/repo/src/main.rs".into(),
                        line: Some(3),
                        meta: None,
                    }]),
                    raw_input: Some(json!({"path": "/repo/src/main.rs"})),
                    raw_output: None,
                    meta: None,
                },
                EventKind::ToolCall {
                    tool_call_id: "t1".into(),
                    title: "Read file".into(),
                    kind: "read".into(),
                    status: "in_progress".into(),
                    locations: vec!["/repo/src/main.rs".into()],
                    raw_input: Some(json!({"path": "/repo/src/main.rs"})),
                    meta: None,
                },
            ),
            (
                wire::SessionUpdate::CurrentModeUpdate {
                    current_mode_id: "architect".into(),
                    meta: None,
                },
                EventKind::ModeChange {
                    mode_id: "architect".into(),
                },
            ),
            (
                wire::SessionUpdate::Notice {
                    severity: Some("warning".into()),
                    title: Some("Heads up".into()),
                    content: None,
                    meta: None,
                },
                EventKind::Notice {
                    level: "warning".into(),
                    message: "Heads up".into(),
                },
            ),
        ];
        for (wire_update, expected) in cases {
            assert_eq!(project_update(wire_update), vec![expected]);
        }
    }

    #[test]
    fn projection_defaults_tool_status_to_pending() {
        let update = SessionUpdate::ToolCall {
            tool_call_id: "t9".into(),
            title: "Unknown tool".into(),
            name: None,
            kind: Some(wire_fallback_kind()),
            status: None,
            content: None,
            locations: None,
            raw_input: None,
            raw_output: None,
            meta: None,
        };
        let projected = project_update(update);
        match &projected[..] {
            [EventKind::ToolCall { status, kind, .. }] => {
                assert_eq!(status, "pending");
                assert_eq!(kind, "other");
            }
            other => panic!("wrong projection: {other:?}"),
        }
    }

    #[test]
    fn tool_call_meta_passes_through_for_native_subagents() {
        let update = SessionUpdate::ToolCall {
            tool_call_id: "t-meta".into(),
            title: "Task".into(),
            name: Some("Task".into()),
            kind: Some(wire_fallback_kind()),
            status: Some(wire::ToolCallStatus::InProgress),
            content: None,
            locations: None,
            raw_input: Some(json!({ "prompt": "review" })),
            raw_output: None,
            meta: Some(json!({ "parentToolUseId": "tu-1" })),
        };
        match &project_update(update)[..] {
            [EventKind::ToolCall { meta, .. }] => {
                assert_eq!(
                    meta.as_ref().and_then(|value| value.get("parentToolUseId")),
                    Some(&json!("tu-1"))
                );
            }
            other => panic!("wrong projection: {other:?}"),
        }
    }

    fn wire_fallback_kind() -> crate::protocol::types::ToolKind {
        crate::protocol::types::ToolKind::Other
    }

    #[test]
    fn permission_reply_shape() {
        let reply = permission_reply(Some("allow".into())).unwrap();
        assert_eq!(
            reply,
            json!({"outcome": {"outcome": "selected", "optionId": "allow"}})
        );
        let reply = permission_reply(None).unwrap();
        assert_eq!(reply, json!({"outcome": {"outcome": "cancelled"}}));
    }

    #[test]
    fn projection_maps_m2_session_state_variants() {
        use crate::protocol::types as wire;

        let commands = project_update(wire::SessionUpdate::AvailableCommandsUpdate {
            available_commands: vec![wire::AvailableCommand {
                name: "mock-echo".into(),
                description: Some("Echo the prompt".into()),
                input: None,
                meta: None,
            }],
            meta: None,
        });
        match &commands[..] {
            [EventKind::CommandsUpdate { commands }] => {
                assert_eq!(commands[0].name, "mock-echo");
                assert_eq!(commands[0].description, "Echo the prompt");
            }
            other => panic!("wrong commands projection: {other:?}"),
        }

        let info = project_update(wire::SessionUpdate::SessionInfoUpdate {
            title: Some("Echo turn".into()),
            updated_at: None,
            meta: None,
        });
        assert_eq!(
            info,
            vec![EventKind::SessionInfo {
                title: Some("Echo turn".into())
            }]
        );

        let config = project_update(wire::SessionUpdate::ConfigOptionUpdate {
            config_options: vec![wire::SessionConfigOption {
                id: "model".into(),
                name: "Model".into(),
                description: None,
                category: Some("model".into()),
                meta: None,
                kind: wire::SessionConfigOptionKind::Select {
                    current_value: "m1".into(),
                    options: wire::SessionConfigSelectOptions::Flat(vec![
                        wire::SessionConfigSelectOption {
                            value: "m1".into(),
                            name: "M1".into(),
                            description: None,
                            meta: None,
                        },
                    ]),
                },
            }],
        });
        match &config[..] {
            [EventKind::ConfigOptions { options }] => {
                assert_eq!(options[0].id, "model");
            }
            other => panic!("wrong config projection: {other:?}"),
        }
    }

    #[test]
    fn projection_maps_compaction_lifecycle() {
        use crate::protocol::types as wire;

        let update = project_update(wire::SessionUpdate::CompactionUpdate {
            compaction_id: "c1".into(),
            status: Some("completed".into()),
            summary: Some(json!([{ "type": "text", "text": "Summary so far" }])),
            error: None,
            meta: None,
        });
        assert_eq!(
            update,
            vec![EventKind::Compaction {
                status: Some("completed".into()),
                compaction_id: Some("c1".into()),
                summary_replace: Some("Summary so far".into()),
                summary_append: None,
            }]
        );

        let chunk = project_update(wire::SessionUpdate::CompactionSummaryChunk {
            compaction_id: "c1".into(),
            content: ContentBlock::text(" more"),
            meta: None,
        });
        assert_eq!(
            chunk,
            vec![EventKind::Compaction {
                status: None,
                compaction_id: Some("c1".into()),
                summary_replace: None,
                summary_append: Some(" more".into()),
            }]
        );
    }

    #[test]
    fn prompt_content_includes_images() {
        // The runtime builds the content list from user text + image chips;
        // here we just verify the wire shape serializes per the schema.
        let params = PromptParams {
            session_id: "s1".into(),
            prompt: vec![
                ContentBlock::text("what is this?"),
                ContentBlock::Image {
                    data: "aGk=".into(),
                    mime_type: "image/png".into(),
                },
            ],
        };
        let v = serde_json::to_value(&params).unwrap();
        assert_eq!(v["prompt"][1]["type"], "image");
        assert_eq!(v["prompt"][1]["mimeType"], "image/png");
    }
}

#[cfg(test)]
mod auth_tests {
    use super::*;
    use crate::protocol::jsonrpc::{RpcError, ERR_AUTH_REQUIRED};

    #[test]
    fn is_auth_required_matches_only_minus_32000() {
        assert!(
            DriverError::Rpc(RpcError::new(ERR_AUTH_REQUIRED, "auth required")).is_auth_required()
        );
        assert!(!DriverError::Rpc(RpcError::new(-32602, "invalid params")).is_auth_required());
        assert!(!DriverError::HungUp {
            method: "session/new".into()
        }
        .is_auth_required());
        assert!(!DriverError::Timeout {
            method: "session/new".into()
        }
        .is_auth_required());
    }
}
