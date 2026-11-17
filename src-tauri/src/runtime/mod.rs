//! AgentRuntime (В§4.4): run orchestration, permission policy, event fan-out
//! (persist + emit to the UI), and the fs sandbox for client callbacks.
//!
//! M1 simplifications (DEVLOG): one ACP connection per RUN (spawn on dispatch,
//! kill on finish вЂ” the mock agent is single-session; pooling lands in M6);
//! supervised permission policy only (auto modes + tests land in M3); one
//! implicit workspace project (projects UI comes later).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::sync::mpsc;

use crate::drivers::acp::{
    elicitation_reply, fs_error, permission_reply, AcpConn, ClientReply, ClientRequest, SpawnConfig,
};
use crate::events::{
    now_millis, AgentCapsPayload, Event, EventKind, PermissionOption as AppPermissionOption,
    RunEventsPayload, RunTiming,
};
use crate::protocol::jsonrpc::{RequestId, RpcError, ERR_RESOURCE_NOT_FOUND};
use crate::protocol::types::{
    AgentCapabilities, ConfigOptionValue, CreateElicitationParams, CreateTerminalParams,
    ElicitationAction, ReadTextFileParams, ReadTextFileResult, RequestPermissionParams,
    SessionConfigOption, WriteTextFileParams,
};
use crate::runtime::permissions::PermissionMode;
use crate::runtime::terminals::TerminalRegistry;
use crate::store::records::{ImageInput, QueueItem, RunRecord, ThreadRecord};
use crate::store::Store;

/// Event fan-out seam: the production sink is the Tauri app handle; tests
/// record emissions in memory. Payloads are serialized once here. `notify`
/// posts an OS notification when the window is unfocused (В§5.5); the focus
/// check lives in the sink implementation.
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: &str, payload: serde_json::Value) -> Result<(), String>;
    fn notify(&self, title: &str, body: &str);
    /// In-memory turn telemetry (not persisted).
    fn emit_run_timing(&self, _timing: &crate::events::RunTiming) {}
}

impl<R: tauri::Runtime> EventSink for tauri::AppHandle<R> {
    fn emit(&self, event: &str, payload: serde_json::Value) -> Result<(), String> {
        tauri::Emitter::emit(self, event, payload).map_err(|e| e.to_string())
    }

    fn emit_run_timing(&self, timing: &crate::events::RunTiming) {
        let _ = tauri::Emitter::emit(self, "run:timing", timing);
    }

    fn notify(&self, title: &str, body: &str) {
        use tauri::Manager;
        use tauri_plugin_notification::NotificationExt;
        let Some(window) = self.get_webview_window("main") else {
            return;
        };
        // Only bother the user when the window is not focused.
        if window.is_focused().unwrap_or(true) {
            return;
        }
        let _ = window
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show();
    }
}

/// Per-thread session config picks, keyed by config option id.
pub type DesiredConfigMap = HashMap<String, ConfigOptionValue>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceInfo {
    pub id: String,
    pub display_name: String,
    /// Disabled providers stay configured but never spawn (T3-style toggle).
    pub enabled: bool,
    pub driver: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    /// Secret env names with `hasValue` + mask; raw values never cross IPC.
    pub secret_env: Vec<SecretEnvMeta>,
    pub status: String,
    /// From the last initialize this instance answered: images in prompts.
    pub prompt_image: bool,
    /// From the last initialize: `session/load` supported (resume path).
    pub load_session: bool,
    /// Session modes the agent advertised (M6 picker; empty until known).
    pub modes: Vec<crate::protocol::types::SessionMode>,
    /// Session config options (model, thought level, toggles) from the cache.
    pub config_options: Vec<SessionConfigOption>,
    /// Auth methods advertised at the last handshake.
    pub auth_methods: Vec<crate::protocol::types::AuthMethod>,
    /// A hint explaining why the agent still needs sign-in.
    pub auth_hint: Option<String>,
}

/// Masked secret env entry shown in Settings.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretEnvMeta {
    pub key: String,
    pub has_value: bool,
    pub masked: Option<String>,
}

/// Capabilities observed during a run's handshake, cached per instance so the
/// UI can gate composer features before the first dispatch.
#[derive(Debug, Clone, PartialEq)]
struct CachedCaps {
    prompt_image: bool,
    load_session: bool,
    /// Session modes the agent advertised at the last handshake (M6 picker).
    modes: Vec<crate::protocol::types::SessionMode>,
    /// Session config options from the last handshake or update.
    config_options: Vec<SessionConfigOption>,
    /// Auth state observed at the last preflight/handshake.
    auth_methods: Vec<crate::protocol::types::AuthMethod>,
    auth_required: bool,
    auth_hint: Option<String>,
}

impl CachedCaps {
    fn payload(&self, instance_id: &str) -> AgentCapsPayload {
        AgentCapsPayload {
            instance_id: instance_id.to_string(),
            prompt_image: self.prompt_image,
            load_session: self.load_session,
            modes: self.modes.clone(),
            config_options: self.config_options.clone(),
            auth_methods: self.auth_methods.clone(),
            auth_hint: self.auth_hint.clone(),
        }
    }
}

/// Result of the queue-aware send: either a fresh run or a queue slot.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SendOutcome {
    pub run: Option<RunRecord>,
    pub queued: bool,
    pub queue_id: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct QueueUpdatedPayload {
    pub thread_id: String,
    pub items: Vec<QueueItem>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ElicitationRequestPayload {
    pub run_id: String,
    pub request_id: String,
    pub message: String,
    /// Raw elicitation/create detail: mode, requestedSchema | url, scope.
    pub detail: serde_json::Value,
}

/// What the UI (or the policy) answered for one surfaced client request.
#[derive(Debug, Clone)]
pub enum AnswerPayload {
    /// Permission option id, or None to cancel.
    Permission { option_id: Option<String> },
    /// Elicitation action + optional form content.
    Elicitation {
        action: ElicitationAction,
        content: Option<serde_json::Value>,
    },
    /// Live config option switch; applied by the run loop (single event writer).
    ConfigOption {
        config_id: String,
        value: ConfigOptionValue,
    },
}

/// A permission request parked in the pending set, awaiting the UI.
#[derive(Debug)]
struct PendingPermission {
    wire_id: RequestId,
    /// ACP ToolKind of the pending tool call (the remembered key class).
    tool_kind: String,
    /// optionId в†’ ACP kind, for remembered-decision bookkeeping.
    option_kinds: HashMap<String, String>,
}

/// A surfaced elicitation awaiting the UI's answer.
#[derive(Debug)]
struct PendingElicitation {
    wire_id: RequestId,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunEventPayload {
    pub run_id: String,
    pub event: Event,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunStartedPayload {
    pub run: RunRecord,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestPayload {
    pub run_id: String,
    pub request_id: String,
    pub title: String,
    pub options: Vec<AppPermissionOption>,
}

/// One persisted allow_always decision, scoped to a workspace.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RememberedPermission {
    pub workspace: String,
    pub instance_id: String,
    pub tool_kind: String,
    pub option_id: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ThreadUpdatedPayload {
    pub thread: ThreadRecord,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProcessEventPayload {
    pub instance_id: String,
    pub kind: String,
    pub detail: Option<String>,
}

struct RunState {
    conn: Arc<AcpConn>,
    session_id: String,
    /// Terminal ownership token for this live connection.
    owner_token: String,
    /// Which configured instance owns this run (diagnostics, M6).
    instance_id: String,
}

/// Pre-initialized agent connection for the selected provider. `session/new`
/// still runs on first use, but the slow CLI startup + initialize are paid
/// while the user is reading the empty state instead of on the first send.
struct WarmConn {
    conn: Arc<AcpConn>,
    events_rx: mpsc::UnboundedReceiver<EventKind>,
    client_requests_rx: mpsc::UnboundedReceiver<ClientRequest>,
    init: crate::protocol::types::InitializeResult,
    root: PathBuf,
    spawn_sig: crate::runtime::pool::SpawnSig,
    created: std::time::Instant,
}

/// Clears the in-flight marker even when warmup fails or the app navigates on.
struct WarmGuard {
    runtime: Arc<AgentRuntime>,
    instance_id: String,
}

impl Drop for WarmGuard {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.runtime.inner.lock() {
            inner.warming.remove(&self.instance_id);
        }
    }
}

struct Inner {
    /// Active runs: run_id в†’ live connection/session.
    runs: HashMap<String, RunState>,
    /// Per-run queue the IPC layer pushes UI answers into.
    answer_queues: HashMap<String, mpsc::UnboundedSender<(String, AnswerPayload)>>,
    /// thread_id в†’ active run_id (В§4.2: at most one active run per thread).
    threads_working: HashMap<String, String>,
    /// Threads being deleted: no new runs and no queue drain while present.
    deleting_threads: std::collections::HashSet<String>,
    /// Runs whose Stop was pressed (grace timer or force kill in flight).
    cancelling_runs: std::collections::HashSet<String>,
    /// instance_id в†’ capabilities observed at the last handshake.
    capabilities: HashMap<String, CachedCaps>,
    /// thread_id в†’ permission mode override (settings default otherwise).
    permission_modes: HashMap<String, PermissionMode>,
    /// Terminal callbacks registry (В§5.5); survives runs for M5 reattach.
    terminals: Arc<TerminalRegistry>,
    /// User-facing PTY terminals (M5 panel): ConPTY-backed, event-streamed.
    ptys: Arc<crate::runtime::ptys::PtyRegistry>,
    /// Pre-initialized agent processes (selected provider) ready for a session.
    warm: HashMap<String, WarmConn>,
    /// Providers whose warmup is currently in flight (no duplicate spawns).
    warming: std::collections::HashSet<String>,
    /// The agent matrix (В§4.5 config.toml instances; mock fallback).
    instances: Vec<crate::config::InstanceSpec>,
    /// Read/parse failure of config.toml; surfaced in Settings instead of
    /// looking like a normal empty install.
    config_error: Option<String>,
}

pub struct AgentRuntime {
    store: Arc<Store>,
    sink: Arc<dyn EventSink>,
    inner: Mutex<Inner>,
    /// Warm processes/sessions parked after a successful turn.
    pub pool: crate::runtime::pool::IdlePool,
    /// App-owned orchestration tools and task log.
    pub orchestrator: Arc<crate::orchestrator::engine::OrchestratorEngine>,
    /// Bearer tokens for the orchestrator MCP server.
    pub mcp_registry: Arc<crate::orchestrator::McpTokenRegistry>,
    /// Bearer tokens for user MCP gateway endpoints, per ACP session.
    pub gateway_tokens: Arc<crate::mcp::gateway::GatewayTokens>,
    /// Loopback gateway for user MCP servers; set once at boot.
    pub gateway: std::sync::OnceLock<Arc<crate::mcp::gateway::McpGateway>>,
    /// Bumped on any custom MCP config change; warm sessions from an older
    /// generation are discarded instead of serving a stale server list.
    pub mcp_generation: std::sync::atomic::AtomicU64,
}

/// `canonicalize()` returns verbatim `\\?\C:\...` paths; agents validate cwd
/// and reject the prefix (opencode answers -32602 "cwd must be an absolute
/// path"). Strip it; UNC verbatim form maps back to `\\server\share`.
pub(crate) fn clean_verbatim(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    PathBuf::from(s.replace(r"\\?\", ""))
}

pub(crate) fn provider_secret_key(instance_id: &str, key: &str) -> String {
    format!("provider:{instance_id}:{key}")
}

/// Merges plain and vault-backed env. Missing secrets fail before spawning so
/// the UI can point at the exact variable instead of an opaque auth error.
fn merged_env(
    store: &crate::store::Store,
    spec: &crate::config::InstanceSpec,
) -> Result<HashMap<String, String>, crate::PultError> {
    let mut env: HashMap<String, String> = spec
        .env
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    for key in &spec.secret_env_keys {
        let value = store
            .get_secret(&provider_secret_key(&spec.id, key))
            .map_err(|error| {
                crate::PultError::with_code(
                    "provider.secret_missing",
                    format!("secret {key} for {} could not be read: {error}", spec.id),
                )
            })?
            .ok_or_else(|| {
                crate::PultError::with_code(
                    "provider.secret_missing",
                    format!("set secret {key} for {} in Settings → Providers", spec.id),
                )
            })?;
        env.insert(key.clone(), value);
    }
    Ok(env)
}

fn looks_secret_env(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    upper.contains("TOKEN")
        || upper.contains("SECRET")
        || upper.contains("PASSWORD")
        || upper.contains("API_KEY")
        || upper.contains("APIKEY")
        || upper.ends_with("_KEY")
}

/// One-time startup migration: values already sitting in config.toml under a
/// credential-looking name move into the vault and the file is rewritten.
fn migrate_plaintext_env(
    store: &crate::store::Store,
    mut specs: Vec<crate::config::InstanceSpec>,
) -> Vec<crate::config::InstanceSpec> {
    let mut changed = false;
    for spec in &mut specs {
        let keys: Vec<String> = spec.env.keys().cloned().collect();
        for key in keys {
            if !looks_secret_env(&key) || spec.secret_env_keys.contains(&key) {
                continue;
            }
            if let Some(value) = spec.env.remove(&key) {
                if !value.is_empty() {
                    if let Err(error) =
                        store.set_secret(&provider_secret_key(&spec.id, &key), &value)
                    {
                        tracing::warn!(target: "pult::runtime", error = %error,
                            instance = %spec.id, key = %key, "provider secret migration failed");
                        continue;
                    }
                }
                spec.secret_env_keys.push(key);
                changed = true;
            }
        }
    }
    if changed {
        if let Err(error) = crate::config::save_instances(&crate::pult_home(), &specs) {
            tracing::warn!(target: "pult::runtime", error = %error,
                "provider secret migration could not rewrite config.toml");
        }
    }
    specs
}

/// Binary agents run for the stdio MCP bridge (`pult mcp-stdio`).
fn mcp_stdio_binary() -> String {
    std::env::var("PULT_MCP_STDIO_BIN")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .map(|path| path.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| "pult-core".to_string())
}

/// Stable key for workspace-scoped settings (remembered permissions).
fn workspace_key(root: &Path) -> String {
    clean_verbatim(root.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

impl AgentRuntime {
    pub fn new(store: Arc<Store>, sink: Arc<dyn EventSink>) -> Self {
        // Runs live only as long as the process: threads left in a run-state
        // by a previous shutdown are orphans вЂ” make them drafts at boot.
        match store.reset_orphaned_run_states() {
            Ok(0) => {}
            Ok(n) => {
                tracing::info!(target: "pult::runtime", count = n, "reset orphaned run states at boot")
            }
            Err(err) => {
                tracing::warn!(target: "pult::runtime", error = %err, "orphaned run-state reset failed")
            }
        }
        let home = crate::pult_home();
        let (instances, config_error) = match crate::config::load_instances_checked(&home) {
            Ok(instances) => (migrate_plaintext_env(&store, instances), None),
            Err(err) => {
                tracing::error!(target: "pult::runtime", error = %err,
                    "config.toml could not be read; no agents are available until it is fixed");
                (Vec::new(), Some(err))
            }
        };
        let terminals = Arc::new(TerminalRegistry::default());
        let pool_terminals = Arc::clone(&terminals);
        let orchestrator = Arc::new(crate::orchestrator::engine::OrchestratorEngine::new(
            Arc::clone(&store),
        ));
        let mcp_registry = Arc::new(crate::orchestrator::McpTokenRegistry::new());
        let gateway_tokens = Arc::new(crate::mcp::gateway::GatewayTokens::new());
        Self {
            store,
            sink: Arc::clone(&sink),
            inner: Mutex::new(Inner {
                runs: HashMap::new(),
                answer_queues: HashMap::new(),
                threads_working: HashMap::new(),
                deleting_threads: std::collections::HashSet::new(),
                cancelling_runs: std::collections::HashSet::new(),
                capabilities: HashMap::new(),
                permission_modes: HashMap::new(),
                terminals,
                ptys: Arc::new(crate::runtime::ptys::PtyRegistry::new(sink)),
                warm: HashMap::new(),
                warming: std::collections::HashSet::new(),
                instances,
                config_error,
            }),
            pool: crate::runtime::pool::IdlePool::with_terminals(pool_terminals)
                .with_mcp_registry(Arc::clone(&mcp_registry))
                .with_gateway_tokens(Arc::clone(&gateway_tokens)),
            orchestrator,
            mcp_registry,
            gateway_tokens,
            gateway: std::sync::OnceLock::new(),
            mcp_generation: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// Connects the engine back to this runtime. Called once at boot, after
    /// the runtime is behind an `Arc`.
    pub fn attach_orchestrator(self: &Arc<Self>) {
        self.orchestrator.attach(self);
    }

    /// Drops the upstream connection and every agent token after a custom MCP
    /// edit. Warm sessions are invalidated because their `session/new` already
    /// carried the old server list.
    pub async fn custom_mcp_changed(&self, server_id: &str) {
        self.bump_mcp_generation();
        if let Some(gateway) = self.gateway.get() {
            gateway.close_server(server_id).await;
        }
    }

    /// Generation-only invalidation for bulk changes (JSON import) that touch
    /// several servers at once.
    pub fn bump_mcp_generation(&self) {
        self.mcp_generation
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.pool.invalidate_all();
    }

    /// Spawns and initializes the selected provider in the background so the
    /// first turn skips the slow CLI startup/handshake (Codex cold start ~11 s).
    pub async fn warmup(
        self: &Arc<Self>,
        instance_id: &str,
        workspace: Option<&str>,
    ) -> Result<(), crate::PultError> {
        let spawn_config = self.spawn_config_for(instance_id)?;
        let root =
            match workspace.map(str::trim).filter(|value| !value.is_empty()) {
                Some(path) => {
                    let path = PathBuf::from(path);
                    if !path.is_dir() {
                        return Err(crate::PultError::with_code(
                            "workspace.missing",
                            format!("Project or thread folder not found: {}", path.display()),
                        ));
                    }
                    clean_verbatim(path.canonicalize().map_err(|e| {
                        crate::PultError::internal(format!("warmup workspace: {e}"))
                    })?)
                }
                None => self.workspace_root()?,
            };
        let spawn_sig = crate::runtime::pool::SpawnSig {
            command: spawn_config.command.clone(),
            args: spawn_config.args.clone(),
            env: spawn_config
                .env
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        };
        {
            let mut inner = self.inner.lock().expect("runtime lock poisoned");
            if let Some(existing) = inner.warm.get(instance_id) {
                if existing.root == root
                    && existing.spawn_sig == spawn_sig
                    && !existing.conn.is_dead()
                    && existing.created.elapsed() < std::time::Duration::from_secs(600)
                {
                    return Ok(());
                }
            }
            // Project/provider switches can fire several warmup requests while a
            // cold Codex start is still in flight: one spawn is enough.
            if !inner.warming.insert(instance_id.to_string()) {
                return Ok(());
            }
        }
        let _guard = WarmGuard {
            runtime: Arc::clone(self),
            instance_id: instance_id.to_string(),
        };
        let (conn, streams) = AcpConn::spawn(&spawn_config)
            .map_err(|e| crate::PultError::internal(format!("warmup spawn: {e}")))?;
        let pid = conn.pid();
        let conn = Arc::new(conn);
        if let Some(pid) = pid {
            crate::processes::register_process(
                pid,
                crate::processes::ProcessMeta::new("agent")
                    .with_label(instance_id)
                    .with_instance(instance_id),
            );
        }
        let init = conn
            .initialize()
            .await
            .map_err(|e| crate::PultError::internal(format!("warmup initialize: {e}")))?;
        if conn.is_dead() {
            conn.kill();
            return Err(crate::PultError::with_code(
                "provider.warmup_failed",
                "warmup agent exited",
            ));
        }
        let warm = WarmConn {
            conn: Arc::clone(&conn),
            events_rx: streams.events_rx,
            client_requests_rx: streams.client_requests_rx,
            init,
            root,
            spawn_sig,
            created: std::time::Instant::now(),
        };
        let replaced = {
            let mut inner = self.inner.lock().expect("runtime lock poisoned");
            inner.warm.insert(instance_id.to_string(), warm)
        };
        if let Some(old) = replaced {
            old.conn.kill();
        }
        Ok(())
    }

    /// Takes the matching warm connection, discarding stale or mismatched ones.
    fn take_warm(
        &self,
        instance_id: &str,
        root: &Path,
        spawn_sig: &crate::runtime::pool::SpawnSig,
    ) -> Option<WarmConn> {
        let warm = {
            let mut inner = self.inner.lock().expect("runtime lock poisoned");
            inner.warm.remove(instance_id)
        }?;
        let stale = warm.root != root
            || &warm.spawn_sig != spawn_sig
            || warm.conn.is_dead()
            || warm.created.elapsed() > std::time::Duration::from_secs(600);
        if stale {
            warm.conn.kill();
            return None;
        }
        Some(warm)
    }

    /// User PTY terminal registry (M5 terminal panel).
    pub fn ptys(&self) -> Arc<crate::runtime::ptys::PtyRegistry> {
        Arc::clone(&self.inner.lock().expect("runtime lock poisoned").ptys)
    }

    pub fn store(&self) -> &Arc<Store> {
        &self.store
    }

    /// Raw configured instances (update checks need command/args).
    pub fn instances_spec(&self) -> Vec<crate::config::InstanceSpec> {
        self.inner
            .lock()
            .expect("runtime lock poisoned")
            .instances
            .clone()
    }

    /// MCP servers for one ACP session: always the app-owned orchestrator,
    /// spoken over HTTP when the agent advertises it, else through the stdio
    /// bridge. The token is bound to this connection and revoked with it.
    pub fn mcp_servers_for(
        &self,
        thread_id: &str,
        instance_id: &str,
        owner_token: &str,
        http_capable: bool,
    ) -> (Vec<crate::protocol::types::McpServer>, Option<String>) {
        let Some(server) = self.orchestrator.server() else {
            return (Vec::new(), None);
        };
        let depth = self
            .store
            .get_thread(thread_id)
            .map(|thread| thread.depth.clamp(0, u8::MAX as i64) as u8)
            .unwrap_or(0);
        let scope = crate::orchestrator::McpScope {
            owner_token: owner_token.to_string(),
            thread_id: thread_id.to_string(),
            depth,
            can_orchestrate: depth < crate::orchestrator::instructions::MAX_DEPTH,
        };
        let token = self.mcp_registry.issue(scope);
        let entry = if http_capable {
            crate::protocol::types::McpServer::Http {
                extra: serde_json::json!({
                    "name": crate::orchestrator::ORCHESTRATOR_SERVER_NAME,
                    "url": server.url(),
                    "headers": [{
                        "name": "Authorization",
                        "value": format!("Bearer {token}")
                    }]
                }),
            }
        } else {
            let binary = std::env::var("PULT_MCP_STDIO_BIN")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    std::env::current_exe()
                        .ok()
                        .map(|path| path.to_string_lossy().into_owned())
                })
                .unwrap_or_else(|| "pult-core".to_string());
            crate::protocol::types::McpServer::Stdio {
                extra: serde_json::json!({
                    "name": crate::orchestrator::ORCHESTRATOR_SERVER_NAME,
                    "command": binary,
                    "args": ["mcp-stdio"],
                    "env": [
                        { "name": "PULT_MCP_URL", "value": server.url() },
                        { "name": "PULT_MCP_TOKEN", "value": token }
                    ]
                }),
            }
        };
        let mut servers = vec![entry];
        let Some(gateway) = self.gateway.get() else {
            return (servers, Some(token));
        };
        let thread = match self.store.get_thread(thread_id) {
            Ok(thread) => thread,
            Err(error) => {
                tracing::warn!(target: "pult::mcp", error = %error,
                    "custom MCP servers skipped: thread lookup failed");
                return (servers, Some(token));
            }
        };
        let resolved =
            match crate::mcp::resolve::resolve_for_thread(&self.store, &thread, instance_id) {
                Ok(resolved) => resolved,
                Err(error) => {
                    tracing::warn!(target: "pult::mcp", error = %error,
                        "custom MCP servers skipped: resolution failed");
                    return (servers, Some(token));
                }
            };
        let binary = mcp_stdio_binary();
        for custom in resolved {
            let endpoint = match gateway.endpoint_for(Some(owner_token), &custom.id) {
                Ok(endpoint) => endpoint,
                Err(error) => {
                    tracing::warn!(target: "pult::mcp", error = %error,
                        server = %custom.name, "custom MCP endpoint skipped");
                    continue;
                }
            };
            let entry = if http_capable {
                crate::protocol::types::McpServer::Http {
                    extra: serde_json::json!({
                        "name": custom.name,
                        "url": endpoint.url,
                        "headers": [{
                            "name": "Authorization",
                            "value": format!("Bearer {}", endpoint.token)
                        }]
                    }),
                }
            } else {
                crate::protocol::types::McpServer::Stdio {
                    extra: serde_json::json!({
                        "name": custom.name,
                        "command": binary,
                        "args": ["mcp-stdio", "--custom", custom.id],
                        "env": [
                            { "name": "PULT_MCP_URL", "value": endpoint.url },
                            { "name": "PULT_MCP_TOKEN", "value": endpoint.token }
                        ]
                    }),
                }
            };
            servers.push(entry);
        }
        (servers, Some(token))
    }

    /// Agent matrix projection (§4.3): configured instances + capabilities
    /// from the last handshake each completed (empty until the first run).
    pub fn instances(&self) -> Vec<InstanceInfo> {
        let inner = self.inner.lock().expect("runtime lock poisoned");
        inner
            .instances
            .iter()
            .map(|spec| {
                let caps = inner
                    .capabilities
                    .get(&spec.id)
                    .cloned()
                    .unwrap_or(CachedCaps {
                        prompt_image: false,
                        load_session: false,
                        modes: Vec::new(),
                        config_options: Vec::new(),
                        auth_methods: Vec::new(),
                        auth_required: false,
                        auth_hint: None,
                    });
                InstanceInfo {
                    id: spec.id.clone(),
                    display_name: spec.display_name.clone(),
                    enabled: spec.enabled,
                    driver: spec.driver.clone(),
                    command: spec.command.clone(),
                    args: spec.args.clone(),
                    env: spec
                        .env
                        .iter()
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect(),
                    secret_env: spec
                        .secret_env_keys
                        .iter()
                        .map(|key| {
                            let full = provider_secret_key(&spec.id, key);
                            match self.store.get_secret(&full) {
                                Ok(Some(value)) => SecretEnvMeta {
                                    key: key.clone(),
                                    has_value: true,
                                    masked: Some(crate::mcp::secrets::mask_secret(&value)),
                                },
                                _ => SecretEnvMeta {
                                    key: key.clone(),
                                    has_value: false,
                                    masked: None,
                                },
                            }
                        })
                        .collect(),
                    status: if caps.auth_required {
                        "needs_auth".to_string()
                    } else {
                        "stopped".to_string()
                    },
                    prompt_image: caps.prompt_image,
                    load_session: caps.load_session,
                    modes: caps.modes,
                    config_options: caps.config_options,
                    auth_methods: caps.auth_methods,
                    auth_hint: caps.auth_hint,
                }
            })
            .collect()
    }

    /// Test seam: swap the registry without writing `config.toml`.
    #[cfg(test)]
    pub fn set_instances_in_memory(&self, specs: Vec<crate::config::InstanceSpec>) {
        self.inner.lock().expect("runtime lock poisoned").instances = specs;
    }

    /// Spawn configuration for an instance (M6): `"mock"` resolves the
    /// fixtures script at spawn time; `"acp"` runs the configured argv.
    fn spawn_config_for(&self, instance_id: &str) -> Result<SpawnConfig, crate::PultError> {
        let spec = {
            let inner = self.inner.lock().expect("runtime lock poisoned");
            inner
                .instances
                .iter()
                .find(|i| i.id == instance_id)
                .cloned()
        };
        let Some(spec) = spec else {
            return Err(crate::PultError::internal(format!(
                "unknown instance {instance_id}"
            )));
        };
        if !spec.enabled {
            return Err(crate::PultError::internal(format!(
                "provider {instance_id} is disabled вЂ” turn it on in Settings в–ё Providers"
            )));
        }
        let env = merged_env(&self.store, &spec)?;
        match spec.driver.as_str() {
            "mock" => {
                let mut config = mock_spawn_config().ok_or_else(|| {
                    crate::PultError::internal(
                        "mock agent script not found (fixtures/mock-acp-agent.mjs)",
                    )
                })?;
                // Per-instance env wins: lets tests (and users) scope mock
                // scenarios without touching the process environment.
                config.env.extend(env);
                Ok(config)
            }
            "acp" => Ok(SpawnConfig {
                command: spec.command.clone(),
                args: spec.args.clone(),
                env,
            }),
            other => Err(crate::PultError::internal(format!(
                "unknown driver {other:?} for instance {instance_id}"
            ))),
        }
    }

    /// Rewrites the agent matrix (settings UI save): validates ids, writes
    /// config.toml, and swaps the live registry.
    pub fn set_instances(
        &self,
        specs: Vec<crate::config::InstanceSpec>,
    ) -> Result<(), crate::PultError> {
        let previous = {
            let inner = self.inner.lock().expect("runtime lock poisoned");
            inner.instances.clone()
        };
        let mut cleaned = Vec::with_capacity(specs.len());
        for mut spec in specs {
            if spec.id.trim().is_empty() {
                return Err(crate::PultError::with_code(
                    "provider.invalid_id",
                    "instance id must not be empty",
                ));
            }
            if spec.driver != "acp" && spec.driver != "mock" {
                return Err(crate::PultError::internal(format!(
                    "unknown driver {:?} (acp | mock)",
                    spec.driver
                )));
            }
            if spec.driver == "acp" && spec.command.trim().is_empty() {
                return Err(crate::PultError::internal(format!(
                    "instance {:?} needs a command",
                    spec.id
                )));
            }
            // Secret values move to the vault before config.toml is written;
            // only names stay in the file.
            for key in spec.env.keys().cloned().collect::<Vec<_>>() {
                if looks_secret_env(&key) && !spec.secret_env_keys.contains(&key) {
                    spec.secret_env_keys.push(key);
                }
            }
            let mut keys = Vec::new();
            let mut seen = std::collections::HashSet::new();
            for raw in std::mem::take(&mut spec.secret_env_keys) {
                let key = raw.trim().to_string();
                if key.is_empty() {
                    continue;
                }
                if key.chars().any(|c| c.is_control() || c == '=') {
                    return Err(crate::PultError::with_code(
                        "provider.invalid_secret_key",
                        format!("invalid secret env name {key:?}"),
                    ));
                }
                if !seen.insert(key.clone()) {
                    continue;
                }
                if let Some(value) = spec.env.remove(&key) {
                    if !value.is_empty() {
                        self.store
                            .set_secret(&provider_secret_key(&spec.id, &key), &value)?;
                    }
                }
                keys.push(key);
            }
            spec.secret_env_keys = keys;
            if let Some(old) = previous.iter().find(|old| old.id == spec.id) {
                for key in &old.secret_env_keys {
                    if !spec.secret_env_keys.contains(key) {
                        let _ = self
                            .store
                            .delete_secret(&provider_secret_key(&spec.id, key));
                    }
                }
            }
            cleaned.push(spec);
        }
        for old in &previous {
            if !cleaned.iter().any(|spec| spec.id == old.id) {
                let _ = self
                    .store
                    .delete_secrets_with_prefix(&format!("provider:{}:", old.id));
            }
        }
        crate::config::save_instances(&crate::pult_home(), &cleaned)?;
        // Warm processes are stale for every removed or saved instance.
        let old_ids: Vec<String> = previous.iter().map(|spec| spec.id.clone()).collect();
        for id in old_ids.iter().chain(cleaned.iter().map(|spec| &spec.id)) {
            self.pool.invalidate_instance(id);
        }
        {
            let mut inner = self.inner.lock().expect("runtime lock poisoned");
            inner.instances = cleaned;
            // A successful save replaces the broken file we complained about.
            inner.config_error = None;
        }
        Ok(())
    }

    /// Last config.toml read/parse failure, if any (Settings banner).
    pub fn config_error(&self) -> Option<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.config_error.clone())
    }

    /// Diagnostics (В§8 M6): last raw protocol frames from any live run of
    /// this instance; no live session в†’ typed error.
    pub fn diagnostics_frames(&self, instance_id: &str) -> Result<Vec<String>, crate::PultError> {
        let inner = self.inner.lock().expect("runtime lock poisoned");
        for state in inner.runs.values() {
            if state.instance_id == instance_id {
                return Ok(state.conn.diagnostics_frames());
            }
        }
        Err(crate::PultError::internal(format!(
            "no live session for {instance_id} вЂ” frames appear while a run is active"
        )))
    }

    /// Switches the session mode (В§5.4 session/set_mode). The choice is
    /// remembered even when no run is live (connection-per-run): the next
    /// dispatch applies it before its first prompt.
    pub fn set_mode(&self, thread_id: &str, mode_id: &str) -> Result<(), crate::PultError> {
        self.store.set_setting(
            &format!("thread_mode:{thread_id}"),
            &serde_json::Value::String(mode_id.to_string()),
        )?;
        let Some(run_id) = self.active_run_for(thread_id) else {
            return Ok(());
        };
        let (conn, session_id) = {
            let inner = self.inner.lock().expect("runtime lock poisoned");
            match inner.runs.get(&run_id) {
                Some(state) => (Arc::clone(&state.conn), state.session_id.clone()),
                None => {
                    return Err(crate::PultError::internal(format!(
                        "run {run_id} is not active"
                    )))
                }
            }
        };
        let mode_id = mode_id.to_string();
        // Sync commands run on the main thread вЂ” reach the reactor through a
        // handle instead of panicking outside the tokio context.
        let handle = tokio::runtime::Handle::try_current().map_err(|_| {
            crate::PultError::internal("no tokio runtime вЂ” cannot reach the agent process")
        })?;
        handle.spawn(async move {
            if let Err(err) = conn.set_mode(&session_id, &mode_id).await {
                tracing::warn!(target: "pult::runtime", error = %err, "set_mode failed");
            }
        });
        Ok(())
    }

    /// The mode the user picked for this thread, applied to the next run.
    pub fn desired_mode(&self, thread_id: &str) -> Option<String> {
        self.store
            .get_setting(&format!("thread_mode:{thread_id}"))
            .ok()
            .flatten()
            .and_then(|value| value.as_str().map(str::to_string))
    }

    /// Session config picks for this thread (model, thought level, toggles).
    pub fn desired_config(&self, thread_id: &str) -> DesiredConfigMap {
        self.store
            .get_setting(&format!("thread_config:{thread_id}"))
            .ok()
            .flatten()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default()
    }

    fn save_desired_config(
        &self,
        thread_id: &str,
        config: &DesiredConfigMap,
    ) -> Result<(), crate::PultError> {
        let value = serde_json::to_value(config)
            .map_err(|e| crate::PultError::store(format!("config encode: {e}")))?;
        self.store
            .set_setting(&format!("thread_config:{thread_id}"), &value)
    }

    /// Merges a draft's picks into a thread (first send from `/chat`).
    pub fn merge_desired_config(
        &self,
        thread_id: &str,
        patch: &DesiredConfigMap,
    ) -> Result<(), crate::PultError> {
        let mut config = self.desired_config(thread_id);
        config.extend(patch.clone());
        self.save_desired_config(thread_id, &config)
    }

    /// Applies a config option now (live run) and remembers it for the next
    /// run. The run loop is the single event writer, so a mid-run switch is
    /// queued to it instead of racing its sequence counter.
    pub async fn set_config_option(
        &self,
        thread_id: &str,
        config_id: &str,
        value: ConfigOptionValue,
    ) -> Result<(), crate::PultError> {
        let mut config = self.desired_config(thread_id);
        config.insert(config_id.to_string(), value.clone());
        self.save_desired_config(thread_id, &config)?;

        let Some(run_id) = self.active_run_for(thread_id) else {
            return Ok(());
        };
        let tx = {
            let inner = self.inner.lock().expect("runtime lock poisoned");
            inner.answer_queues.get(&run_id).cloned()
        };
        if let Some(tx) = tx {
            let _ = tx.send((
                config_id.to_string(),
                AnswerPayload::ConfigOption {
                    config_id: config_id.to_string(),
                    value,
                },
            ));
        }
        Ok(())
    }

    /// Queue-aware send (В§6.1 composer semantics): if the thread is working,
    /// the message is stored and auto-dispatches when the active run ends;
    /// otherwise it starts a run immediately.
    #[allow(clippy::too_many_arguments)]
    pub fn send(
        self: &Arc<Self>,
        thread: &ThreadRecord,
        text: &str,
        images: &[ImageInput],
        instance_id: &str,
        mode: Option<&str>,
        config: &DesiredConfigMap,
    ) -> Result<SendOutcome, crate::PultError> {
        if self.thread_deleting(&thread.id) {
            return Err(crate::PultError::with_code(
                "thread.deleting",
                "thread is being deleted",
            ));
        }
        // Snapshot the effective settings for THIS message: desired picks plus
        // the ones the composer sent with it.
        let mut snapshot = self.desired_config(&thread.id);
        for (id, value) in config {
            snapshot.insert(id.clone(), value.clone());
        }
        let mode = mode.map(str::to_string);
        let active = {
            let inner = self.inner.lock().expect("runtime lock poisoned");
            inner.threads_working.get(&thread.id).cloned()
        };
        if active.is_none() {
            match self.dispatch_with(
                thread,
                text,
                images,
                instance_id,
                mode.clone(),
                Some(snapshot.clone()),
                None,
            ) {
                Ok(run) => {
                    // Persist the picker state only after this message owns the
                    // thread; a queued message must not rewrite the active run.
                    if let Some(mode) = &mode {
                        let key = format!("thread_mode:{}", thread.id);
                        let _ = self
                            .store
                            .set_setting(&key, &serde_json::Value::String(mode.clone()));
                    }
                    self.save_desired_config(&thread.id, &snapshot)?;
                    return Ok(SendOutcome {
                        run: Some(run),
                        queued: false,
                        queue_id: None,
                    });
                }
                // Lost the race to a concurrent send: queue behind its run
                // instead of refusing the message.
                Err(err) if is_thread_busy(&err) => {
                    tracing::debug!(target: "pult::runtime", error = %err,
                        "send raced with dispatch; queueing instead");
                }
                Err(err) => return Err(err),
            }
        }
        let item = QueueItem {
            id: new_row_id("q", &thread.id),
            thread_id: thread.id.clone(),
            instance_id: instance_id.to_string(),
            text: text.to_string(),
            images: images.to_vec(),
            mode,
            config_options: snapshot.into_iter().collect(),
            created_at: now_millis(),
        };
        self.store.enqueue_queue_item(&item)?;
        self.emit_queue_updated(&thread.id);
        // The active run may have finished between the check above and this
        // insert: nobody would drain that queue, so start it here.
        if self.active_run_for(&thread.id).is_none() {
            self.auto_dispatch_queue(&thread.id);
        }
        Ok(SendOutcome {
            run: None,
            queued: true,
            queue_id: Some(item.id),
        })
    }

    /// The thread's live run id, if any (В§4.2: at most one active run).
    /// True once the spawned turn has registered its live connection. Stop
    /// before that point is a no-op, so callers that must cancel reliably wait.
    pub fn live_run_registered(&self, run_id: &str) -> bool {
        self.inner
            .lock()
            .expect("runtime lock poisoned")
            .runs
            .contains_key(run_id)
    }

    pub fn active_run_for(&self, thread_id: &str) -> Option<String> {
        self.inner
            .lock()
            .expect("runtime lock poisoned")
            .threads_working
            .get(thread_id)
            .cloned()
    }

    /// Marks a thread as being deleted: no new runs, no queue drain.
    pub fn begin_delete_thread(&self, thread_id: &str) {
        self.inner
            .lock()
            .expect("runtime lock poisoned")
            .deleting_threads
            .insert(thread_id.to_string());
    }

    pub fn finish_delete_thread(&self, thread_id: &str) {
        self.inner
            .lock()
            .expect("runtime lock poisoned")
            .deleting_threads
            .remove(thread_id);
    }

    fn thread_deleting(&self, thread_id: &str) -> bool {
        self.inner
            .lock()
            .expect("runtime lock poisoned")
            .deleting_threads
            .contains(thread_id)
    }

    /// Sends a queued message now: move it ahead of the queue and cancel the
    /// active run so the queue drain picks it next. Best-effort cancel.
    pub fn steer(
        self: &Arc<Self>,
        thread_id: &str,
        queue_id: &str,
    ) -> Result<(), crate::PultError> {
        self.store.move_queue_item_to_head(thread_id, queue_id)?;
        self.emit_queue_updated(thread_id);
        if let Some(run_id) = self.active_run_for(thread_id) {
            if let Err(err) = self.cancel(&run_id) {
                tracing::warn!(target: "pult::runtime", error = %err, "steer cancel failed; retrying");
                // The run may still be finishing its handshake, so its live
                // connection is not registered yet. Retry off the caller.
                let runtime = self.clone();
                let thread_id = thread_id.to_string();
                tokio::spawn(async move {
                    for _ in 0..100 {
                        if runtime.active_run_for(&thread_id).is_none() {
                            runtime.auto_dispatch_queue(&thread_id);
                            return;
                        }
                        if runtime.cancel(&run_id).is_ok() {
                            return;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                    tracing::warn!(target: "pult::runtime", "steer could not cancel the active run");
                });
            }
        } else {
            self.auto_dispatch_queue(thread_id);
        }
        Ok(())
    }

    /// Pushes the thread's current queue to the UI ("queue:update").
    pub fn emit_queue_updated(&self, thread_id: &str) {
        let items = self.store.list_queue(thread_id).unwrap_or_default();
        self.emit(
            "queue:update",
            &QueueUpdatedPayload {
                thread_id: thread_id.to_string(),
                items,
            },
        );
    }

    /// Remembers handshake capabilities per instance for composer gating and
    /// the M6 mode picker (modes come from the session handshake). An empty
    /// mode list preserves the previously cached one вЂ” resumes that carry no
    /// advertised list must not blind the picker.
    fn cache_capabilities(
        &self,
        instance_id: &str,
        caps: &AgentCapabilities,
        modes: Vec<crate::protocol::types::SessionMode>,
        config_options: Vec<SessionConfigOption>,
    ) {
        let cached;
        let changed;
        {
            let mut inner = self.inner.lock().expect("runtime lock poisoned");
            let previous = inner.capabilities.get(instance_id).cloned();
            let modes = if modes.is_empty() {
                previous
                    .as_ref()
                    .map(|c| c.modes.clone())
                    .unwrap_or_default()
            } else {
                modes
            };
            let config_options = if config_options.is_empty() {
                previous
                    .as_ref()
                    .map(|c| c.config_options.clone())
                    .unwrap_or_default()
            } else {
                config_options
            };
            cached = CachedCaps {
                prompt_image: caps.prompt_capabilities.image,
                load_session: caps.load_session,
                modes,
                config_options,
                auth_methods: previous
                    .as_ref()
                    .map(|c| c.auth_methods.clone())
                    .unwrap_or_default(),
                auth_required: previous.as_ref().map(|c| c.auth_required).unwrap_or(false),
                auth_hint: previous.as_ref().and_then(|c| c.auth_hint.clone()),
            };
            changed = previous.as_ref() != Some(&cached);
            inner
                .capabilities
                .insert(instance_id.to_string(), cached.clone());
        }
        if changed {
            self.emit("agent:caps", &cached.payload(instance_id));
        }
    }

    /// Records the auth state observed at preflight/authenticate/session start.
    fn cache_auth_state(
        &self,
        instance_id: &str,
        auth_methods: Vec<crate::protocol::types::AuthMethod>,
        auth_required: bool,
        auth_hint: Option<String>,
    ) {
        let cached;
        let changed;
        {
            let mut inner = self.inner.lock().expect("runtime lock poisoned");
            let before = inner.capabilities.get(instance_id).cloned();
            let caps = inner
                .capabilities
                .entry(instance_id.to_string())
                .or_insert(CachedCaps {
                    prompt_image: false,
                    load_session: false,
                    modes: Vec::new(),
                    config_options: Vec::new(),
                    auth_methods: Vec::new(),
                    auth_required: false,
                    auth_hint: None,
                });
            if !auth_methods.is_empty() {
                caps.auth_methods = auth_methods;
            } else {
                caps.auth_methods.clear();
            }
            caps.auth_required = auth_required;
            caps.auth_hint = auth_hint;
            cached = caps.clone();
            changed = before.as_ref() != Some(&cached);
        }
        if changed {
            self.emit("agent:caps", &cached.payload(instance_id));
        }
    }

    /// Ids advertised by the agent at the last handshake. `None` means the
    /// agent exposes no config options (or none are cached yet) and stale
    /// picks cannot be validated.
    fn config_option_ids(&self, instance_id: &str) -> Option<std::collections::HashSet<String>> {
        let inner = self.inner.lock().expect("runtime lock poisoned");
        inner.capabilities.get(instance_id).map(|caps| {
            caps.config_options
                .iter()
                .map(|option| option.id.clone())
                .collect()
        })
    }

    /// The last advertised option set, cloned so callers can validate without
    /// holding the runtime lock across awaits.
    fn config_options_for(&self, instance_id: &str) -> Option<Vec<SessionConfigOption>> {
        let inner = self.inner.lock().expect("runtime lock poisoned");
        inner
            .capabilities
            .get(instance_id)
            .map(|caps| caps.config_options.clone())
    }

    /// Keeps only persisted picks the newly selected provider advertises.
    /// No cached options means no safe judgement: leave the picks untouched
    /// so a pick made before the first handshake is never lost.
    pub fn clear_stale_provider_config(
        &self,
        thread_id: &str,
        instance_id: &str,
    ) -> Result<(), crate::PultError> {
        let Some(options) = self.config_options_for(instance_id) else {
            return Ok(());
        };
        let config = self.desired_config(thread_id);
        if config.is_empty() {
            return Ok(());
        }
        let filtered: DesiredConfigMap = config
            .iter()
            .filter(|(id, value)| session_config_value_valid(&options, id, value))
            .map(|(id, value)| (id.clone(), value.clone()))
            .collect();
        self.save_desired_config(thread_id, &filtered)
    }

    /// Applies the same advertised-value filter used by the run loop.
    fn filter_config_for_instance(
        &self,
        instance_id: &str,
        config: &DesiredConfigMap,
    ) -> DesiredConfigMap {
        match self.config_options_for(instance_id) {
            Some(options) => config
                .iter()
                .filter(|(id, value)| session_config_value_valid(&options, id, value))
                .map(|(id, value)| (id.clone(), value.clone()))
                .collect(),
            None => config.clone(),
        }
    }

    /// Replaces the cached config options from a `set_config_option` reply or
    /// a live `config_option_update`.
    fn update_cached_config_options(
        &self,
        instance_id: &str,
        config_options: Vec<SessionConfigOption>,
    ) {
        let cached = {
            let mut inner = self.inner.lock().expect("runtime lock poisoned");
            match inner.capabilities.get_mut(instance_id) {
                Some(caps) if caps.config_options != config_options => {
                    caps.config_options = config_options;
                    Some(caps.clone())
                }
                _ => None,
            }
        };
        if let Some(cached) = cached {
            self.emit("agent:caps", &cached.payload(instance_id));
        }
    }

    /// Start a run (В§4.2): registers the run, persists the user message, and
    /// hands the turn to a background task. Returns the created run. Callers
    /// that must respect an active run use [`AgentRuntime::send`].
    pub fn dispatch(
        self: &Arc<Self>,
        thread: &ThreadRecord,
        text: &str,
        images: &[ImageInput],
        instance_id: &str,
    ) -> Result<RunRecord, crate::PultError> {
        self.dispatch_with(thread, text, images, instance_id, None, None, None)
    }

    /// `dispatch` with optional per-message settings. A queued message carries
    /// the mode/config it was written with, so later picker changes cannot
    /// rewrite it. `claim_queue_id` makes the run row, the user message and the
    /// queue-row delete one transaction (C09).
    #[allow(clippy::too_many_arguments)]
    fn dispatch_with(
        self: &Arc<Self>,
        thread: &ThreadRecord,
        text: &str,
        images: &[ImageInput],
        instance_id: &str,
        mode_override: Option<String>,
        config_override: Option<DesiredConfigMap>,
        claim_queue_id: Option<&str>,
    ) -> Result<RunRecord, crate::PultError> {
        if self.thread_deleting(&thread.id) {
            return Err(crate::PultError::with_code(
                "thread.deleting",
                "thread is being deleted",
            ));
        }
        let spawn_config = self.spawn_config_for(instance_id)?;
        // Resolve the folder before creating the run so a missing workspace is
        // an immediate typed error, not a failed run record.
        let root = self.workspace_root_for(thread)?;

        let desired = match config_override {
            Some(config) => config,
            None => self.desired_config(&thread.id),
        };
        let effective_config = self.filter_config_for_instance(instance_id, &desired);
        let model = desired_string(&effective_config, "model");
        let effort = effort_id_order()
            .iter()
            .find_map(|id| desired_string(&effective_config, id));
        let run = RunRecord {
            id: new_row_id("run", &thread.id),
            thread_id: thread.id.clone(),
            idx: self.store.run_count(&thread.id)? as i64,
            status: "running".to_string(),
            instance_id: instance_id.to_string(),
            model,
            mode: mode_override.or_else(|| self.desired_mode(&thread.id)),
            effort,
            started_at: now_millis(),
            stopped_at: None,
            stop_reason: None,
            error: None,
        };
        let user_event = Event::new(
            run.id.clone(),
            self.store.next_seq(&run.id)?,
            EventKind::UserMessage {
                text: text.to_string(),
                images: images.to_vec(),
            },
        );
        // Register before the DB write so a threads_get landing in between
        // sees the run as live instead of a zombie. Check-and-insert under one
        // lock: two concurrent dispatches must not both start a run.
        {
            let mut inner = self.inner.lock().expect("runtime lock poisoned");
            if inner.deleting_threads.contains(&thread.id) {
                return Err(crate::PultError::with_code(
                    "thread.deleting",
                    "thread is being deleted",
                ));
            }
            if inner.threads_working.contains_key(&thread.id) {
                return Err(crate::PultError::with_code(
                    "thread.busy",
                    "thread already has an active run; queue instead",
                ));
            }
            inner
                .threads_working
                .insert(thread.id.clone(), run.id.clone());
        }
        if let Some(queue_id) = claim_queue_id {
            if let Err(err) = self
                .store
                .commit_claimed_queue_run(queue_id, &run, &user_event)
            {
                self.rollback_run(&run.id, &thread.id);
                return Err(err);
            }
        } else {
            if let Err(err) = self.store.create_run(&run) {
                self.rollback_run(&run.id, &thread.id);
                return Err(err);
            }
            if let Err(err) = self.store.append_event(&user_event) {
                return Err(self.abort_run_start(&run, &thread.id, err));
            }
        }

        let (answers_tx, answers_rx) = mpsc::unbounded_channel::<(String, AnswerPayload)>();

        {
            let mut inner = self.inner.lock().expect("runtime lock poisoned");
            inner.answer_queues.insert(run.id.clone(), answers_tx);
        }
        if let Err(err) = self.set_thread_status(&thread.id, "working") {
            return Err(self.abort_run_start(&run, &thread.id, err));
        }
        // Covers backend-created runs too (queue auto-dispatch): the UI
        // registers the record so the timeline can select it. Emitted after
        // every fallible step so a failed start never leaves a ghost run.
        self.emit("run:started", &RunStartedPayload { run: run.clone() });
        self.emit_run_event(&run.id, &user_event);

        let this = Arc::clone(self);
        let run_id = run.id.clone();
        let thread_id = thread.id.clone();
        let instance_id = instance_id.to_string();
        let text = text.to_string();
        let prompt_images = images.to_vec();
        let mode = run.mode.clone();
        let config = effective_config;
        tokio::spawn(async move {
            let outcome = run_turn(RunTask {
                runtime: this,
                spawn_config,
                run_id,
                thread_id,
                instance_id,
                root,
                text,
                images: prompt_images,
                mode,
                config,
                answers_rx,
            })
            .await;
            if let Err(err) = outcome {
                tracing::error!(target: "pult::runtime", error = %err, "run task failed");
            }
        });

        Ok(run)
    }

    /// Removes a run's in-memory registration after it failed to start.
    fn rollback_run(&self, run_id: &str, thread_id: &str) {
        let mut inner = self.inner.lock().expect("runtime lock poisoned");
        inner.runs.remove(run_id);
        inner.answer_queues.remove(run_id);
        inner.threads_working.remove(thread_id);
    }

    /// Roll back a start that failed after the run row was written; the row is
    /// marked failed so a restart does not adopt a ghost "running" run.
    fn abort_run_start(
        &self,
        run: &RunRecord,
        thread_id: &str,
        err: crate::PultError,
    ) -> crate::PultError {
        self.rollback_run(&run.id, thread_id);
        let _ = self.store.finish_run(
            &run.id,
            now_millis(),
            "failed",
            Some("failed"),
            Some(&err.to_string()),
        );
        err
    }

    /// Stop button / Esc: cancel the active run's prompt turn (В§5.3).
    pub fn cancel(self: &Arc<Self>, run_id: &str) -> Result<(), crate::PultError> {
        self.cancel_with_force(run_id, false)
    }

    /// Stop with escalation: the cancel notification is advisory, so a run
    /// that ignores it (hung CLI) is killed after a grace period. `force`
    /// skips the grace period entirely.
    pub fn cancel_with_force(
        self: &Arc<Self>,
        run_id: &str,
        force: bool,
    ) -> Result<(), crate::PultError> {
        let (conn, session_id, thread_id, owner_token) = {
            let mut inner = self.inner.lock().expect("runtime lock poisoned");
            let Some(state) = inner.runs.get(run_id) else {
                return Err(crate::PultError::internal(format!(
                    "run {run_id} is not active"
                )));
            };
            let state = (
                Arc::clone(&state.conn),
                state.session_id.clone(),
                state.owner_token.clone(),
            );
            let thread_id = inner
                .threads_working
                .iter()
                .find(|(_, id)| id.as_str() == run_id)
                .map(|(thread, _)| thread.clone())
                .unwrap_or_default();
            inner.cancelling_runs.insert(run_id.to_string());
            (state.0, state.1, thread_id, state.2)
        };
        self.emit(
            "run:cancelling",
            &serde_json::json!({ "runId": run_id, "threadId": thread_id }),
        );
        // Stop cascades: no child or grandchild outlives the run that asked.
        self.orchestrator.cancel_subtree(&thread_id, force);
        if force {
            conn.kill();
            let terminals = {
                let inner = self.inner.lock().expect("runtime lock poisoned");
                Arc::clone(&inner.terminals)
            };
            terminals.release_owner(&owner_token);
            return Ok(());
        }
        let handle = tokio::runtime::Handle::try_current().map_err(|_| {
            crate::PultError::internal("no tokio runtime - cannot reach the agent process")
        })?;
        handle.spawn(async move {
            if let Err(err) = conn.cancel(&session_id).await {
                tracing::warn!(target: "pult::runtime", error = %err, "cancel failed");
            }
        });
        let runtime = Arc::clone(self);
        let grace_run = run_id.to_string();
        handle.spawn(async move {
            let grace_ms = std::env::var("PULT_CANCEL_GRACE_MS")
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(5_000);
            tokio::time::sleep(std::time::Duration::from_millis(grace_ms)).await;
            let still_active = {
                let inner = runtime.inner.lock().expect("runtime lock poisoned");
                inner.cancelling_runs.contains(&grace_run) && inner.runs.contains_key(&grace_run)
            };
            if still_active {
                tracing::warn!(target: "pult::runtime", run_id = %grace_run,
                    "agent ignored cancel; force-killing the run");
                runtime.kill_run(&grace_run);
            }
        });
        Ok(())
    }

    /// Force-kills a run's agent process (thread delete: a wedged agent may
    /// ignore `session/cancel` and keep its worktree files open).
    pub fn kill_run(&self, run_id: &str) {
        let found = {
            let inner = self.inner.lock().expect("runtime lock poisoned");
            inner
                .runs
                .get(run_id)
                .map(|state| (Arc::clone(&state.conn), state.owner_token.clone()))
        };
        if let Some((conn, owner_token)) = found {
            conn.kill();
            // The process is gone: its terminals are unreachable.
            let terminals = {
                let inner = self.inner.lock().expect("runtime lock poisoned");
                Arc::clone(&inner.terminals)
            };
            terminals.release_owner(&owner_token);
        }
    }

    /// Route a permission answer from the UI into the run's queue.
    pub fn respond_permission(
        &self,
        run_id: &str,
        request_id: &str,
        option_id: Option<String>,
    ) -> Result<(), crate::PultError> {
        self.push_answer(run_id, request_id, AnswerPayload::Permission { option_id })
    }

    /// Route an elicitation answer (accept/decline/cancel + content).
    pub fn respond_elicitation(
        &self,
        run_id: &str,
        request_id: &str,
        action: ElicitationAction,
        content: Option<serde_json::Value>,
    ) -> Result<(), crate::PultError> {
        self.push_answer(
            run_id,
            request_id,
            AnswerPayload::Elicitation { action, content },
        )
    }

    fn push_answer(
        &self,
        run_id: &str,
        request_id: &str,
        payload: AnswerPayload,
    ) -> Result<(), crate::PultError> {
        let tx = {
            let inner = self.inner.lock().expect("runtime lock poisoned");
            inner.answer_queues.get(run_id).cloned()
        };
        // The run loop owns the pending maps; an unknown key is silently
        // dropped by the answers arm (e.g. a stale UI answer after the
        // policy already resolved the request locally).
        match tx {
            Some(tx) => {
                tx.send((request_id.to_string(), payload)).map_err(|_| {
                    crate::PultError::with_code("run.finished", "run already finished")
                })?;
                Ok(())
            }
            None => Err(crate::PultError::internal(format!(
                "run {run_id} is not active"
            ))),
        }
    }

    /// Permission mode for a thread: override, else the settings default.
    pub fn permission_mode_for(&self, thread_id: &str) -> PermissionMode {
        {
            let inner = self.inner.lock().expect("runtime lock poisoned");
            if let Some(mode) = inner.permission_modes.get(thread_id) {
                return *mode;
            }
        }
        self.store
            .get_setting("permission_mode")
            .ok()
            .flatten()
            .and_then(|v| PermissionMode::from_settings_value(&v))
            .unwrap_or_else(PermissionMode::default_mode)
    }

    /// Per-thread permission mode override ("pill" in the composer chrome).
    pub fn set_permission_mode(
        &self,
        thread_id: &str,
        mode: PermissionMode,
    ) -> Result<(), crate::PultError> {
        self.inner
            .lock()
            .expect("runtime lock poisoned")
            .permission_modes
            .insert(thread_id.to_string(), mode);
        // The chosen mode also becomes the default for new threads (В§5.7).
        self.store.set_setting(
            "permission_mode",
            &serde_json::to_value(mode).unwrap_or_default(),
        )?;
        Ok(())
    }

    /// Child-thread ceiling: does not touch the global default, so a subagent
    /// cannot silently change the user's mode for new chats.
    pub fn set_thread_permission_mode(&self, thread_id: &str, mode: PermissionMode) {
        self.inner
            .lock()
            .expect("runtime lock poisoned")
            .permission_modes
            .insert(thread_id.to_string(), mode);
    }

    /// Remembered allow_always decision per (workspace, instance, tool class)
    /// (В§5.5). A permission granted in one project must not leak into another;
    /// legacy unscoped entries are ignored (they fall back to asking).
    fn remembered_for(
        &self,
        workspace: &str,
        instance_id: &str,
        tool_kind: &str,
    ) -> Option<String> {
        let value = self
            .store
            .get_setting("remembered_permissions")
            .ok()
            .flatten()?;
        Some(
            value
                .get(workspace)?
                .get(instance_id)?
                .get(tool_kind)?
                .as_str()?
                .to_string(),
        )
    }

    fn remember_decision(
        &self,
        workspace: &str,
        instance_id: &str,
        tool_kind: &str,
        option_id: &str,
    ) {
        let mut map = self
            .store
            .get_setting("remembered_permissions")
            .ok()
            .flatten()
            .unwrap_or(serde_json::json!({}));
        map[workspace][instance_id][tool_kind] = serde_json::Value::String(option_id.to_string());
        if let Err(err) = self.store.set_setting("remembered_permissions", &map) {
            tracing::warn!(target: "pult::runtime", error = %err, "remembered decision not saved");
        }
    }

    /// Flat view for Settings в–ё General (revoke list).
    pub fn list_remembered_permissions(&self) -> Vec<RememberedPermission> {
        let Some(value) = self
            .store
            .get_setting("remembered_permissions")
            .ok()
            .flatten()
        else {
            return Vec::new();
        };
        let Some(workspaces) = value.as_object() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for (workspace, instances) in workspaces {
            let Some(instances) = instances.as_object() else {
                continue;
            };
            for (instance_id, kinds) in instances {
                let Some(kinds) = kinds.as_object() else {
                    continue;
                };
                for (tool_kind, option_id) in kinds {
                    let Some(option_id) = option_id.as_str() else {
                        continue;
                    };
                    out.push(RememberedPermission {
                        workspace: workspace.clone(),
                        instance_id: instance_id.clone(),
                        tool_kind: tool_kind.clone(),
                        option_id: option_id.to_string(),
                    });
                }
            }
        }
        out
    }

    /// Revokes remembered decisions matching the filters; `None` matches all.
    pub fn clear_remembered_permission(
        &self,
        workspace: Option<&str>,
        instance_id: Option<&str>,
        tool_kind: Option<&str>,
    ) -> Result<(), crate::PultError> {
        let Some(value) = self.store.get_setting("remembered_permissions")? else {
            return Ok(());
        };
        let Some(workspaces) = value.as_object() else {
            return Ok(());
        };
        // Delete the leaves that match ALL given filters; keep everything else.
        // Filters are hierarchical: a tool-kind filter never reaches another
        // workspace or instance.
        let mut next = serde_json::Map::new();
        for (ws, instances) in workspaces {
            if workspace.is_some_and(|wanted| wanted != ws) {
                next.insert(ws.clone(), instances.clone());
                continue;
            }
            let Some(instances) = instances.as_object() else {
                continue;
            };
            let mut next_instances = serde_json::Map::new();
            for (instance, kinds) in instances {
                if instance_id.is_some_and(|wanted| wanted != instance) {
                    next_instances.insert(instance.clone(), kinds.clone());
                    continue;
                }
                let Some(kinds) = kinds.as_object() else {
                    continue;
                };
                let mut next_kinds = serde_json::Map::new();
                for (kind, option) in kinds {
                    if tool_kind.is_some_and(|wanted| wanted != kind) {
                        next_kinds.insert(kind.clone(), option.clone());
                    }
                }
                if !next_kinds.is_empty() {
                    next_instances.insert(instance.clone(), serde_json::Value::Object(next_kinds));
                }
            }
            if !next_instances.is_empty() {
                next.insert(ws.clone(), serde_json::Value::Object(next_instances));
            }
        }
        self.store
            .set_setting("remembered_permissions", &serde_json::Value::Object(next))
    }

    fn set_thread_status(&self, thread_id: &str, status: &str) -> Result<(), crate::PultError> {
        self.store.set_thread_status(thread_id, status)?;
        self.emit_thread_updated(thread_id);
        Ok(())
    }

    /// Pushes the current thread state to the UI ("thread:update").
    pub fn emit_thread_updated(&self, thread_id: &str) {
        if let Ok(thread) = self.store.get_thread(thread_id) {
            self.emit("thread:update", &ThreadUpdatedPayload { thread });
        }
    }

    /// Persistence/cache side effects of session-metadata events. Applied both
    /// in the live turn loop and when a session/load replay is drained.
    fn apply_session_metadata(&self, thread_id: &str, instance_id: &str, kind: &EventKind) {
        if let EventKind::ConfigOptions { options } = kind {
            self.update_cached_config_options(instance_id, options.clone());
        }
        // Agent-chosen session titles rename the thread live (session_info_update).
        if let EventKind::SessionInfo { title: Some(title) } = kind {
            if !title.trim().is_empty() {
                if let Err(err) = self.store.rename_thread(thread_id, title) {
                    tracing::warn!(target: "pult::runtime",
                        error = %err, "session title rename failed");
                }
                self.emit_thread_updated(thread_id);
            }
        }
    }

    fn emit_run_event(&self, run_id: &str, event: &Event) {
        self.emit(
            "run:event",
            &RunEventPayload {
                run_id: run_id.to_string(),
                event: event.clone(),
            },
        );
    }

    /// One IPC round-trip for a whole coalesced batch (streaming hot path).
    fn emit_run_events(&self, run_id: &str, events: &[Event]) {
        if events.is_empty() {
            return;
        }
        self.emit(
            "run:events",
            &RunEventsPayload {
                run_id: run_id.to_string(),
                events: events.to_vec(),
            },
        );
    }

    /// Single fan-out point: serialize + hand to the sink.
    pub(crate) fn emit(&self, event: &str, payload: &impl Serialize) {
        let value = serde_json::to_value(payload).unwrap_or(serde_json::Value::Null);
        let _ = self.sink.emit(event, value);
    }

    /// OS notification seam (the sink decides whether the window cares).
    fn sink_notify(&self, title: &str, body: &str) {
        self.sink.notify(title, body);
    }

    /// M1 workspace root: PULT_WORKSPACE override or ~/pult-workspace.
    fn workspace_root(&self) -> Result<PathBuf, crate::PultError> {
        let root = default_workspace_root();
        std::fs::create_dir_all(&root)
            .map_err(|e| crate::PultError::internal(format!("workspace root: {e}")))?;
        root.canonicalize()
            .map_err(|e| crate::PultError::internal(format!("workspace root: {e}")))
    }

    /// Global fallback root for callers that create threads before choosing
    /// a workspace (threads_create with worktree=true and no explicit dir).
    pub fn global_workspace_root(&self) -> Result<PathBuf, crate::PultError> {
        self.workspace_root().map(clean_verbatim)
    }

    /// Session cwd for a thread: its explicit workspace (worktree threads
    /// pin theirs at creation), else its project's folder, else the global
    /// root. A missing folder is an explicit error, never a silent fallback.
    pub(crate) fn workspace_root_for(
        &self,
        thread: &ThreadRecord,
    ) -> Result<PathBuf, crate::PultError> {
        if let Some(ws) = thread
            .workspace
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let path = PathBuf::from(ws);
            if !path.is_absolute() || !path.is_dir() {
                return Err(crate::PultError::with_code(
                    "workspace.missing",
                    format!("Project or thread folder not found: {ws}"),
                ));
            }
            return Ok(clean_verbatim(path));
        }
        if let Some(project_id) = &thread.project_id {
            let project = self.store.get_project(project_id).map_err(|_| {
                crate::PultError::with_code(
                    "workspace.missing",
                    format!("Project or thread folder not found: project {project_id}"),
                )
            })?;
            let path = PathBuf::from(&project.root_path);
            if !path.is_absolute() || !path.is_dir() {
                return Err(crate::PultError::with_code(
                    "workspace.missing",
                    format!("Project or thread folder not found: {}", project.root_path),
                ));
            }
            return Ok(clean_verbatim(path));
        }
        let root = self.workspace_root()?;
        Ok(clean_verbatim(root))
    }

    /// Writes a hidden `refs/pult/checkpoints/<run_id>` ref so any run's
    /// resulting tree stays recoverable (В§4.4; the rollback UI stays out of
    /// scope, the data does not). Best-effort: skips non-repo workspaces.
    fn spawn_checkpoint(self: &Arc<Self>, thread: &ThreadRecord, run_id: &str) {
        let Some(workspace) = thread.workspace.clone() else {
            return;
        };
        let run_id = run_id.to_string();
        tokio::spawn(async move {
            if let Err(err) = crate::git::checkpoint(Path::new(&workspace), &run_id).await {
                tracing::info!(target: "pult::runtime", run_id = %run_id,
                    error = %err, "checkpoint skipped");
            }
        });
    }
}

fn default_workspace_root() -> PathBuf {
    if let Ok(root) = std::env::var("PULT_WORKSPACE") {
        return PathBuf::from(root);
    }
    home_dir_pub().join("pult-workspace")
}

/// Home directory helper shared with `lib.rs` (db/config paths live in `~/.pult`).
pub fn home_dir_pub() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn mock_spawn_config() -> Option<SpawnConfig> {
    let script = mock_agent_script()?;
    let mut env = HashMap::new();
    for key in [
        "MOCK_DELAY_MS",
        "MOCK_SLOW_TURN",
        "MOCK_BAD_JSON",
        "MOCK_CRASH_MID_TURN",
        "MOCK_HANG",
        "MOCK_AUTH_REQUIRED",
        "MOCK_AUTH_FAIL",
        "MOCK_AUTH_STILL_REQUIRED",
        "MOCK_AUTH_TERMINAL",
        "MOCK_AUTH_STATE_FILE",
    ] {
        if let Ok(value) = std::env::var(key) {
            env.insert(key.to_string(), value);
        }
    }
    Some(SpawnConfig {
        command: "node".to_string(),
        args: vec![script.to_string_lossy().into_owned()],
        env,
    })
}

fn mock_agent_script() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("PULT_MOCK_AGENT") {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("fixtures/mock-acp-agent.mjs"));
        candidates.push(cwd.join("../fixtures/mock-acp-agent.mjs"));
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// Everything one prompt turn needs; keeps run_turn's arity clippy-clean.
struct RunTask {
    runtime: Arc<AgentRuntime>,
    spawn_config: SpawnConfig,
    run_id: String,
    thread_id: String,
    instance_id: String,
    root: PathBuf,
    text: String,
    images: Vec<ImageInput>,
    /// Mode picked before the run started; applied right after the session.
    mode: Option<String>,
    /// Config options picked for this thread; applied before the prompt.
    config: DesiredConfigMap,
    answers_rx: mpsc::UnboundedReceiver<(String, AnswerPayload)>,
}

/// Persists one coalesced batch in a single transaction, then fans it out as
/// one `run:events` IPC message. Empty batches are free.
fn persist_event_batch(
    runtime: &AgentRuntime,
    run_id: &str,
    events: Vec<Event>,
) -> Result<(), crate::PultError> {
    if events.is_empty() {
        return Ok(());
    }
    runtime.store.append_events_batch(&events)?;
    runtime.emit_run_events(run_id, &events);
    Ok(())
}

/// Applies one projected agent event to the run: first-delta timing, coalesced
/// persistence, and session metadata. Shared by the select loop and the
/// post-prompt drain, which picks up events the select did not get to.
#[allow(clippy::too_many_arguments)]
fn apply_session_event(
    runtime: &AgentRuntime,
    run_id: &str,
    thread_id: &str,
    instance_id: &str,
    timing: &mut RunTiming,
    batcher: &mut crate::runtime::batch::EventBatcher,
    applied_config: &mut DesiredConfigMap,
    prompt_started: std::time::Instant,
    kind: EventKind,
) -> Result<(), String> {
    if timing.first_delta_ms.is_none()
        && matches!(
            &kind,
            EventKind::AgentMessageDelta { .. } | EventKind::AgentThoughtDelta { .. }
        )
    {
        timing.first_delta_ms = Some(prompt_started.elapsed().as_millis() as u64);
    }
    let metadata = matches!(
        &kind,
        EventKind::ConfigOptions { .. } | EventKind::SessionInfo { title: Some(_) }
    )
    .then(|| kind.clone());
    let flushed = batcher.push(kind);
    persist_event_batch(runtime, run_id, flushed).map_err(|err| format!("store: {err}"))?;
    if let Some(kind) = metadata {
        if let EventKind::ConfigOptions { options } = &kind {
            sync_applied_config(applied_config, options);
        }
        runtime.apply_session_metadata(thread_id, instance_id, &kind);
    }
    Ok(())
}

/// `dispatch` refused because another run won the thread (queue instead).
fn is_thread_busy(err: &crate::PultError) -> bool {
    matches!(err, crate::PultError::Internal { code, .. } if code == "thread.busy")
}

/// Unique row id: wall clock plus a process-local counter, so two sends in the
/// same millisecond do not collide on a primary key.
fn new_row_id(prefix: &str, thread_id: &str) -> String {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{prefix}-{}-{seq}-{thread_id}", now_millis())
}

/// Drive one prompt turn: consume projected events + client-side requests
/// while the prompt response is pending, then finalize the run.
async fn run_turn(task: RunTask) -> Result<(), crate::PultError> {
    let RunTask {
        runtime,
        spawn_config,
        run_id,
        thread_id,
        instance_id,
        root,
        text,
        images,
        mode,
        config,
        mut answers_rx,
    } = task;
    let turn_started = std::time::Instant::now();
    let mut timing = RunTiming {
        run_id: run_id.clone(),
        thread_id: thread_id.clone(),
        instance_id: instance_id.clone(),
        pooled: false,
        spawn_ms: 0,
        handshake_ms: 0,
        session_ms: 0,
        config_ms: 0,
        prompt_ms: 0,
        first_delta_ms: None,
        total_ms: 0,
    };
    let emit_process = |kind: &str, detail: Option<String>| {
        runtime.emit(
            "agent:process",
            &ProcessEventPayload {
                instance_id: instance_id.clone(),
                kind: kind.to_string(),
                detail,
            },
        );
    };

    emit_process("starting", None);
    let spawn_sig = crate::runtime::pool::SpawnSig {
        command: spawn_config.command.clone(),
        args: spawn_config.args.clone(),
        env: spawn_config
            .env
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
    };
    // Warm process from a previous turn of this thread: skip spawn, initialize,
    // and session/new|load; re-send only the settings that changed.
    let pooled = runtime.pool.take_matching_generation(
        &thread_id,
        &instance_id,
        &root,
        &spawn_sig,
        runtime
            .mcp_generation
            .load(std::sync::atomic::Ordering::Relaxed),
    );

    let conn: Arc<AcpConn>;
    let mut events_rx: mpsc::UnboundedReceiver<EventKind>;
    let mut client_requests_rx: mpsc::UnboundedReceiver<ClientRequest>;
    let session_id: String;
    // Terminals are owned by the connection, not by the ACP session id.
    let owner_token: String;
    let mut applied_config: DesiredConfigMap;
    let mcp_token: Option<String>;
    let session_context_ready: bool;
    let session_has_orchestrator: bool;
    let session_mcp_generation: u64;
    let mut context_reset_reason: Option<String> = None;
    let mut replayed_metadata = Vec::new();
    let mut preinit: Option<crate::protocol::types::InitializeResult> = None;
    let warm = if pooled.is_none() {
        runtime.take_warm(&instance_id, &root, &spawn_sig)
    } else {
        None
    };

    if let Some(entry) = pooled {
        timing.pooled = true;
        let entry_mcp_generation = entry.mcp_generation;
        let crate::runtime::pool::IdleConn {
            conn: pooled_conn,
            events_rx: mut pooled_events,
            client_requests_rx: pooled_requests,
            session_id: pooled_session,
            owner_token: pooled_owner,
            applied_config: pooled_config,
            mcp_token: pooled_token,
            ..
        } = entry;
        // Anything buffered after the previous prompt completed is stale.
        while pooled_events.try_recv().is_ok() {}
        conn = pooled_conn;
        events_rx = pooled_events;
        client_requests_rx = pooled_requests;
        session_id = pooled_session;
        owner_token = pooled_owner;
        applied_config = pooled_config;
        mcp_token = pooled_token;
        session_mcp_generation = entry_mcp_generation;
        // A parked session already got the instructions on its first prompt.
        session_context_ready = true;
        session_has_orchestrator = mcp_token.is_some();
        {
            let mut guard = runtime.inner.lock().expect("runtime lock poisoned");
            guard.runs.insert(
                run_id.clone(),
                RunState {
                    conn: Arc::clone(&conn),
                    session_id: session_id.clone(),
                    owner_token: owner_token.clone(),
                    instance_id: instance_id.clone(),
                },
            );
        }
        emit_process("running", None);
    } else {
        // Warm process (if any) already finished spawn + initialize.
        let (spawn_conn, spawn_events, spawn_requests) = if let Some(warm) = warm {
            preinit = Some(warm.init);
            (warm.conn, warm.events_rx, warm.client_requests_rx)
        } else {
            // The receivers come back separately: the run loop owns them exclusively,
            // while the connection itself is shared through an Arc.
            let spawn_started = std::time::Instant::now();
            let (conn_raw, streams) = match AcpConn::spawn(&spawn_config) {
                Ok(parts) => parts,
                Err(err) => {
                    let msg = err.to_string();
                    emit_process("crashed", Some(msg.clone()));
                    runtime.finalize_run(&run_id, &thread_id, "failed", "failed", Some(msg))?;
                    return Ok(());
                }
            };
            let crate::drivers::acp::AcpStreams {
                events_rx: spawned_events,
                client_requests_rx: spawned_requests,
            } = streams;
            timing.spawn_ms = spawn_started.elapsed().as_millis() as u64;
            emit_process("spawned", None);
            if let Some(pid) = conn_raw.pid() {
                crate::processes::register_process(
                    pid,
                    crate::processes::ProcessMeta::new("agent")
                        .with_label(instance_id.clone())
                        .with_thread(thread_id.clone())
                        .with_run(run_id.clone())
                        .with_instance(instance_id.clone()),
                );
            }
            (Arc::new(conn_raw), spawned_events, spawned_requests)
        };
        conn = spawn_conn;
        events_rx = spawn_events;
        client_requests_rx = spawn_requests;
        applied_config = DesiredConfigMap::new();
        owner_token = {
            let inner = runtime.inner.lock().expect("runtime lock poisoned");
            inner.terminals.new_owner_token()
        };

        {
            let mut guard = runtime.inner.lock().expect("runtime lock poisoned");
            guard.runs.insert(
                run_id.clone(),
                RunState {
                    conn: Arc::clone(&conn),
                    session_id: String::new(),
                    owner_token: owner_token.clone(),
                    instance_id: instance_id.clone(),
                },
            );
        }

        let resolved = match resolve_session(
            &conn,
            &runtime,
            &thread_id,
            &instance_id,
            &owner_token,
            &run_id,
            &root,
            preinit.take(),
        )
        .await
        {
            Ok(resolved) => resolved,
            Err(err) => {
                let died = conn.died_on_own();
                let auth_required = matches!(
                    &err,
                    crate::PultError::Internal { code, .. } if code == "auth_required"
                );
                conn.kill();
                // The session never opened: its bearer and terminals must die
                // with the attempt, not linger until app shutdown.
                runtime.mcp_registry.revoke(&owner_token);
                runtime.gateway_tokens.revoke_owner(&owner_token);
                if died {
                    emit_process("crashed", Some(err.to_string()));
                } else if !auth_required {
                    emit_process("exited", None);
                }
                runtime.finalize_run(
                    &run_id,
                    &thread_id,
                    "failed",
                    "failed",
                    Some(err.to_string()),
                )?;
                return Ok(());
            }
        };
        timing.handshake_ms = resolved.handshake_ms;
        timing.session_ms = resolved.session_ms;
        session_id = resolved.session_id;
        context_reset_reason = resolved.context_reset_reason;
        mcp_token = resolved.mcp_token;
        session_mcp_generation = resolved.mcp_generation;
        // A resumed session keeps the context it was given before.
        session_context_ready = resolved.resumed;
        session_has_orchestrator = mcp_token.is_some();
        // A resumed session re-announces the prior transcript while `session/load`
        // is in flight. Persisting that replay would duplicate history in this
        // run: drop transcript items, keep session metadata.
        if resolved.resumed {
            while let Ok(kind) = events_rx.try_recv() {
                if matches!(
                    kind,
                    EventKind::CommandsUpdate { .. }
                        | EventKind::ConfigOptions { .. }
                        | EventKind::ModeChange { .. }
                        | EventKind::SessionInfo { .. }
                ) {
                    replayed_metadata.push(kind);
                }
            }
        }
        {
            let mut guard = runtime.inner.lock().expect("runtime lock poisoned");
            if let Some(state) = guard.runs.get_mut(&run_id) {
                state.session_id = session_id.clone();
            }
        }
        emit_process("running", None);
    }

    // A mode picked before this run existed is applied before the prompt; a
    // rejecting agent must not kill the send. Modes are re-sent every turn:
    // live mode changes are not observable here, and one round-trip is cheap.
    if let Some(mode_id) = mode.as_deref() {
        if let Err(err) = conn.set_mode(&session_id, mode_id).await {
            tracing::warn!(target: "pult::runtime",
                mode = %mode_id, error = %err, "desired mode was not applied");
        }
    }

    let terminals: Arc<TerminalRegistry> = {
        let inner = runtime.inner.lock().expect("runtime lock poisoned");
        Arc::clone(&inner.terminals)
    };
    let mut next_seq = runtime.store.next_seq(&run_id)?;
    for kind in replayed_metadata {
        let event = Event::new(run_id.clone(), next_seq, kind);
        next_seq += 1;
        let _ = runtime.store.append_event(&event);
        runtime.emit_run_event(&run_id, &event);
        runtime.apply_session_metadata(&thread_id, &instance_id, &event.kind);
    }
    // Visible, persisted warning: the transcript on screen is NOT the agent's
    // context for this run (load failed, no load support, or agent switch).
    if let Some(message) = context_reset_reason {
        let event = Event::new(
            run_id.clone(),
            next_seq,
            EventKind::Notice {
                level: "warning".to_string(),
                message,
            },
        );
        next_seq += 1;
        let _ = runtime.store.append_event(&event);
        runtime.emit_run_event(&run_id, &event);
    }
    // Hot-path batching: deltas coalesce, barriers and the 40 ms tick flush.
    let mut batcher = crate::runtime::batch::EventBatcher::new(run_id.clone(), next_seq);

    // Apply the thread's config picks to this fresh session, then tell the
    // timeline about the effective option set. A rejecting agent never kills
    // the prompt (В§5.4: stale picks must degrade, not fail). `model` goes
    // first because agents narrow dependent options (thought level) when the
    // model changes.
    let advertised_config = runtime.config_option_ids(&instance_id);
    let cached_config = runtime.config_options_for(&instance_id);
    let mut picks: Vec<(String, ConfigOptionValue)> = config
        .into_iter()
        .filter(|(id, _)| {
            advertised_config
                .as_ref()
                .is_none_or(|ids| ids.contains(id))
        })
        .filter(|(id, value)| {
            cached_config
                .as_ref()
                .is_none_or(|options| session_config_value_valid(options, id, value))
        })
        .collect();
    picks.sort_by_key(|(id, _)| config_apply_order(id));
    let config_started = std::time::Instant::now();
    for (config_id, value) in picks {
        // Compare at apply time: an earlier pick may have narrowed dependents.
        if applied_config.get(&config_id) == Some(&value) {
            continue;
        }
        match conn.set_config_option(&session_id, &config_id, value).await {
            Ok(result) => {
                sync_applied_config(&mut applied_config, &result.config_options);
                runtime.update_cached_config_options(&instance_id, result.config_options.clone());
                let flushed = batcher.push(EventKind::ConfigOptions {
                    options: result.config_options,
                });
                let _ = persist_event_batch(&runtime, &run_id, flushed);
            }
            Err(err) => {
                tracing::warn!(target: "pult::runtime",
                    config = %config_id, error = %err, "desired config was not applied");
                let flushed = batcher.push(EventKind::Notice {
                    level: "warning".to_string(),
                    message: format!("The agent rejected {config_id}: {err}"),
                });
                let _ = persist_event_batch(&runtime, &run_id, flushed);
            }
        }
    }
    timing.config_ms = config_started.elapsed().as_millis() as u64;
    let mut pending_permissions: HashMap<String, PendingPermission> = HashMap::new();
    let mut pending_elicitations: HashMap<String, PendingElicitation> = HashMap::new();
    let mut failure: Option<String> = None;
    // Assigned on every break path before the post-loop read.
    let mut stop_reason: Option<String>;

    let mut content = Vec::with_capacity(2 + images.len());
    // Wire-only block: the transcript still shows just the user's message.
    // Never glued before a slash command - the adapter must parse it first.
    if session_has_orchestrator && !session_context_ready && !text.trim_start().starts_with('/') {
        if let Ok(thread_record) = runtime.store.get_thread(&thread_id) {
            if let Some(block) = crate::orchestrator::instructions::prompt_context(&thread_record) {
                content.push(crate::protocol::types::ContentBlock::text(block));
            }
        }
    }
    content.push(crate::protocol::types::ContentBlock::text(text.clone()));
    for image in &images {
        content.push(crate::protocol::types::ContentBlock::Image {
            data: image.data.clone(),
            mime_type: image.mime_type.clone(),
        });
    }
    let prompt_started = std::time::Instant::now();
    let prompt_fut = conn.prompt(&session_id, content);
    tokio::pin!(prompt_fut);
    let mut batch_tick = tokio::time::interval_at(
        tokio::time::Instant::now() + crate::runtime::batch::BATCH_WINDOW,
        crate::runtime::batch::BATCH_WINDOW,
    );

    loop {
        tokio::select! {
            _ = batch_tick.tick() => {
                match persist_event_batch(&runtime, &run_id, batcher.flush_now()) {
                    Ok(()) => {}
                    Err(err) => {
                        failure = Some(format!("store: {err}"));
                        stop_reason = Some("failed".to_string());
                        break;
                    }
                }
            }
            answer = answers_rx.recv() => {
                if let Some((request_id, payload)) = answer {
                    match payload {
                        AnswerPayload::Permission { option_id } => {
                            if let Some(pending) = pending_permissions.remove(&request_id) {
                                runtime
                                    .orchestrator
                                    .mark_child_status(&thread_id, "running");
                                let flushed = batcher.push(EventKind::ApprovalResponse {
                                    request_id: request_id.clone(),
                                    option_id: option_id.clone(),
                                    auto: false,
                                });
                                let _ = persist_event_batch(&runtime, &run_id, flushed);
                                // Remember allow_always per (instance, tool class).
                                if let Some(option_id) = &option_id {
                                    if let Some(kind) =
                                        pending.option_kinds.get(option_id).cloned()
                                    {
                                        if crate::runtime::permissions::is_rememberable(&kind) {
                                            runtime.remember_decision(
                                                &workspace_key(&root),
                                                &instance_id,
                                                &pending.tool_kind,
                                                option_id,
                                            );
                                        }
                                    }
                                }
                                // Reply with the ORIGINAL wire id, not the key.
                                let _ = conn
                                    .respond_client(pending.wire_id, permission_reply(option_id))
                                    .await;
                            }
                        }
                        AnswerPayload::Elicitation { action, content } => {
                            if let Some(pending) = pending_elicitations.remove(&request_id) {
                                runtime
                                    .orchestrator
                                    .mark_child_status(&thread_id, "running");
                                let _ = conn
                                    .respond_client(
                                        pending.wire_id,
                                        elicitation_reply(action, content),
                                    )
                                    .await;
                            }
                        }
                        AnswerPayload::ConfigOption { config_id, value } => {
                            if let Some(options) = runtime.config_options_for(&instance_id) {
                                if !session_config_value_valid(&options, &config_id, &value) {
                                    tracing::warn!(target: "pult::runtime",
                                        config = %config_id, "live config value is no longer advertised");
                                    let flushed = batcher.push(EventKind::Notice {
                                        level: "warning".to_string(),
                                        message: format!(
                                            "The agent no longer offers {config_id}={value:?}"
                                        ),
                                    });
                                    let _ = persist_event_batch(&runtime, &run_id, flushed);
                                    continue;
                                }
                            }
                            match conn
                                .set_config_option(&session_id, &config_id, value)
                                .await
                            {
                                Ok(result) => {
                                    sync_applied_config(&mut applied_config, &result.config_options);
                                    runtime.update_cached_config_options(
                                        &instance_id,
                                        result.config_options.clone(),
                                    );
                                    let flushed = batcher.push(EventKind::ConfigOptions {
                                        options: result.config_options,
                                    });
                                    let _ = persist_event_batch(&runtime, &run_id, flushed);
                                }
                                Err(err) => {
                                    tracing::warn!(target: "pult::runtime",
                                        config = %config_id, error = %err,
                                        "live config option was not applied");
                                    let flushed = batcher.push(EventKind::Notice {
                                        level: "warning".to_string(),
                                        message: format!(
                                            "The agent rejected {config_id}: {err}"
                                        ),
                                    });
                                    let _ = persist_event_batch(&runtime, &run_id, flushed);
                                }
                            }
                        }
                    }
                }
            }
            kind = events_rx.recv() => {
                if let Some(kind) = kind {
                    if let Err(err) = apply_session_event(
                        &runtime, &run_id, &thread_id, &instance_id, &mut timing,
                        &mut batcher, &mut applied_config, prompt_started, kind,
                    ) {
                        failure = Some(err);
                        stop_reason = Some("failed".to_string());
                        break;
                    }
                }
            }
            request = client_requests_rx.recv() => {
                if let Some(request) = request {
                    match request {
                        ClientRequest::Permission { request_id, params } => {
                            if let Err(err) = handle_permission_request(
                                &runtime, &conn, &run_id, &thread_id, &instance_id,
                                &root, &mut batcher, &mut pending_permissions,
                                &request_id, params,
                            )
                            .await
                            {
                                failure = Some(format!("permission: {err}"));
                                stop_reason = Some("failed".to_string());
                                break;
                            }
                            if pending_permissions.contains_key(&request_id_key(&request_id)) {
                                runtime
                                    .orchestrator
                                    .mark_child_status(&thread_id, "waiting_approval");
                            }
                        }
                        ClientRequest::ReadFile { request_id, params } => {
                            let reply = read_file_sandboxed(&root, &params);
                            let _ = conn.respond_client(request_id, reply).await;
                        }
                        ClientRequest::WriteFile { request_id, params } => {
                            let (reply, change) = write_file_sandboxed(&root, &params);
                            if let Some((path, diff, added, removed)) = change {
                                let flushed = batcher.push(EventKind::FileChanged {
                                    path,
                                    diff,
                                    added,
                                    removed,
                                });
                                let _ = persist_event_batch(&runtime, &run_id, flushed);
                            }
                            let _ = conn.respond_client(request_id, reply).await;
                        }
                        ClientRequest::Elicitation { request_id, params } => {
                            if let Err(err) = surface_elicitation(
                                &runtime, &run_id, &mut batcher,
                                &mut pending_elicitations, &request_id, params,
                            ) {
                                failure = Some(format!("elicitation: {err}"));
                                stop_reason = Some("failed".to_string());
                                break;
                            }
                            runtime
                                .orchestrator
                                .mark_child_status(&thread_id, "waiting_input");
                        }
                        ClientRequest::TerminalCreate { request_id, params } => {
                            let reply = handle_terminal_create(
                                &terminals,
                                &owner_token,
                                &root,
                                &params,
                            );
                            let _ = conn.respond_client(request_id, reply).await;
                        }
                        ClientRequest::TerminalOutput { request_id, params } => {
                            let reply = terminals.output(&params.terminal_id, &owner_token);
                            let _ = conn.respond_client(request_id, reply).await;
                        }
                        ClientRequest::TerminalWait { request_id, params } => {
                            // Answer from a detached task: waiting must not
                            // stall the event stream (В§9 no blocking lanes).
                            let conn = Arc::clone(&conn);
                            let terminals = Arc::clone(&terminals);
                            let owner = owner_token.clone();
                            tokio::spawn(async move {
                                let reply =
                                    terminals.wait_for_exit(&params.terminal_id, &owner).await;
                                let _ = conn.respond_client(request_id, reply).await;
                            });
                        }
                        ClientRequest::TerminalKill { request_id, params } => {
                            let reply = terminals.kill(&params.terminal_id, &owner_token);
                            let _ = conn.respond_client(request_id, reply).await;
                        }
                        ClientRequest::TerminalRelease { request_id, params } => {
                            let reply = terminals.release(&params.terminal_id, &owner_token);
                            let _ = conn.respond_client(request_id, reply).await;
                        }
                    }
                }
            }
            result = &mut prompt_fut => {
                timing.prompt_ms = prompt_started.elapsed().as_millis() as u64;
                match result {
                    Ok(prompt) => {
                        stop_reason = Some(
                            serde_json::to_value(prompt.stop_reason)
                                .ok()
                                .and_then(|v| v.as_str().map(str::to_string))
                                .unwrap_or_else(|| "end_turn".to_string()),
                        );
                    }
                    Err(err) => {
                        // A deliberate Stop kills the process; that is a
                        // cancellation, not an agent failure.
                        let cancelled = runtime
                            .inner
                            .lock()
                            .expect("runtime lock poisoned")
                            .cancelling_runs
                            .contains(&run_id);
                        if cancelled {
                            stop_reason = Some("cancelled".to_string());
                        } else {
                            failure = Some(err.to_string());
                            stop_reason = Some("failed".to_string());
                        }
                    }
                }
                break;
            }
        }
    }

    // The prompt reply can win the select while the turn's last notifications
    // are still queued; they belong to this run, not to the next pooled turn.
    if failure.is_none() {
        while let Ok(kind) = events_rx.try_recv() {
            if let Err(err) = apply_session_event(
                &runtime,
                &run_id,
                &thread_id,
                &instance_id,
                &mut timing,
                &mut batcher,
                &mut applied_config,
                prompt_started,
                kind,
            ) {
                failure = Some(err);
                stop_reason = Some("failed".to_string());
                break;
            }
        }
    }

    // The buffered tail must land (and get lower seq) before run_finished.
    if let Err(err) = persist_event_batch(&runtime, &run_id, batcher.flush_now()) {
        failure = Some(format!("store: {err}"));
        stop_reason = Some("failed".to_string());
    }
    let final_reason = stop_reason.unwrap_or_else(|| "failed".to_string());
    let status = match final_reason.as_str() {
        "cancelled" => "cancelled",
        "failed" => "failed",
        _ => "finished",
    };
    // The agent dying mid-run is a designed error state (В§8 M7): check before
    // our own kill() so a crash is not mistaken for a normal shutdown.
    let crashed_mid_run = conn.died_on_own();
    // Park a healthy session for the next turn of this thread; cancel, crash,
    // failure, or a deleted thread must tear the process down instead.
    let can_park = !crashed_mid_run
        && failure.is_none()
        && !conn.is_dead()
        && matches!(
            final_reason.as_str(),
            "end_turn" | "max_tokens" | "max_turn_requests"
        )
        && runtime.store.get_thread(&thread_id).is_ok();
    if can_park {
        runtime.pool.park(
            thread_id.clone(),
            crate::runtime::pool::IdleConn {
                conn: Arc::clone(&conn),
                events_rx,
                client_requests_rx,
                session_id: session_id.clone(),
                owner_token: owner_token.clone(),
                instance_id: instance_id.clone(),
                root: root.clone(),
                spawn_sig,
                applied_config,
                // Re-applied next turn: live mode changes are not tracked here.
                applied_mode: None,
                // The token stays valid while the ACP connection lives; the
                // pool revokes it when this entry is killed or evicted.
                mcp_token,
                instructions_injected: false,
                compaction_epoch: 0,
                mcp_generation: session_mcp_generation,
                last_used: std::time::Instant::now(),
            },
        );
        // Close the delete/park race: deletion may have committed between the
        // existence check above and the insert.
        if runtime.store.get_thread(&thread_id).is_err() {
            runtime.pool.invalidate_thread(&thread_id);
        }
    } else {
        conn.kill();
        // The agent process is gone, so its terminals and bearer are dead too.
        runtime.mcp_registry.revoke(&owner_token);
        runtime.gateway_tokens.revoke_owner(&owner_token);
        // The agent process is gone, so its terminals are unreachable: kill
        // their children instead of leaking orphaned processes.
        terminals.release_owner(&owner_token);
    }
    if crashed_mid_run {
        emit_process("crashed", failure.clone());
    } else {
        // Idle now (pooled or killed): clear the "running" dot without a
        // providers_instances_list round-trip.
        emit_process("exited", None);
    }
    runtime.finalize_run(&run_id, &thread_id, status, &final_reason, failure)?;
    timing.total_ms = turn_started.elapsed().as_millis() as u64;
    runtime.sink.emit_run_timing(&timing);
    Ok(())
}

impl AgentRuntime {
    fn finalize_run(
        self: &Arc<Self>,
        run_id: &str,
        thread_id: &str,
        status: &str,
        stop_reason: &str,
        failure: Option<String>,
    ) -> Result<(), crate::PultError> {
        let finished = Event::new(
            run_id.to_string(),
            // A deleted thread/run must still release the runtime state below.
            self.store.next_seq(run_id).unwrap_or(0),
            EventKind::RunFinished {
                stop_reason: stop_reason.to_string(),
                error: failure.clone(),
            },
        );
        match self.store.append_event(&finished) {
            Ok(()) => self.emit_run_event(run_id, &finished),
            Err(err) => tracing::warn!(target: "pult::runtime",
                error = %err, "run_finished not persisted (thread removed?)"),
        }
        let _ = self.store.finish_run(
            run_id,
            now_millis(),
            status,
            Some(stop_reason),
            failure.as_deref(),
        );
        // Child runs settle their delegated-task row and wake `wait_tasks`.
        self.orchestrator.finish_child_run(
            thread_id,
            run_id,
            status,
            stop_reason,
            failure.as_deref(),
        );
        if let Some(detail) = &failure {
            tracing::warn!(target: "pult::runtime", detail = %detail, "run ended with failure");
        }
        let deleting = {
            let mut guard = self.inner.lock().expect("runtime lock poisoned");
            guard.runs.remove(run_id);
            guard.answer_queues.remove(run_id);
            guard.threads_working.remove(thread_id);
            guard.cancelling_runs.remove(run_id);
            guard.deleting_threads.contains(thread_id)
        };
        // The run is over either way; a refused delete leaves a usable thread,
        // so the UI must see the settled status before the delete attempt.
        let _ = self.store.set_thread_status(thread_id, "settled");
        self.emit_thread_updated(thread_id);
        if deleting {
            // The thread is going away: never start its next queued message.
            return Ok(());
        }
        if let Ok(thread) = self.store.get_thread(thread_id) {
            self.spawn_checkpoint(&thread, run_id);
        }
        // Queue auto-dispatch: the oldest queued message starts its own run
        // now that the thread is free (В§6.1 queue semantics).
        self.auto_dispatch_queue(thread_id);
        Ok(())
    }
}

impl AgentRuntime {
    /// Claims the queue head and dispatches it, if the thread has one queued.
    /// The claim is atomic (two dispatchers cannot run the same row) and the
    /// run row + user event + queue delete commit in one transaction (C09).
    /// Best-effort: a dispatch error releases the claim, the message is kept.
    fn auto_dispatch_queue(self: &Arc<Self>, thread_id: &str) {
        if self.thread_deleting(thread_id) {
            return;
        }
        let claim = new_row_id("claim", thread_id);
        match self.store.claim_queue_head(thread_id, &claim) {
            Ok(Some(item)) => {
                let thread = match self.store.get_thread(thread_id) {
                    Ok(thread) => thread,
                    Err(err) => {
                        tracing::error!(target: "pult::runtime",
                            error = %err, "queue dispatch: thread vanished");
                        let _ = self.store.release_queue_claim(&item.id);
                        return;
                    }
                };
                match self.dispatch_with(
                    &thread,
                    &item.text,
                    &item.images,
                    &item.instance_id,
                    item.mode.clone(),
                    Some(item.config_options.clone().into_iter().collect()),
                    Some(&item.id),
                ) {
                    Ok(run) => {
                        // A queued steer becomes the task's new live run.
                        self.orchestrator.attach_child_run(thread_id, &run.id);
                    }
                    Err(err) => {
                        tracing::error!(target: "pult::runtime",
                            error = %err, "queue auto-dispatch failed");
                        // A failed dispatch must not eat the user's message.
                        let _ = self.store.release_queue_claim(&item.id);
                        // A concurrent run won the thread: its finalize drains
                        // the queue, unless it already ended in this gap.
                        if is_thread_busy(&err) && self.active_run_for(thread_id).is_none() {
                            self.auto_dispatch_queue(thread_id);
                        } else if !is_thread_busy(&err) {
                            // A queued steer whose next run cannot start must
                            // close the subagent card instead of hanging.
                            self.orchestrator
                                .mark_dispatch_failed(thread_id, &err.to_string());
                        }
                    }
                }
                self.emit_queue_updated(thread_id);
            }
            Ok(None) => {}
            Err(err) => {
                tracing::warn!(target: "pult::runtime", error = %err, "queue claim failed");
            }
        }
    }
}

/// Result of a one-click connect check (В§4.3 providers surface).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightReport {
    pub instance_id: String,
    pub agent_name: String,
    pub agent_version: Option<String>,
    pub load_session: bool,
    pub prompt_image: bool,
    /// Real auth state: a probe `session/new` succeeded (T3-style
    /// "Authenticated"), not just advertised auth methods.
    pub auth_required: bool,
    /// Detail when the probe failed (shown under "Needs sign-in").
    pub auth_hint: Option<String>,
    /// Session config options observed on the probe session (pickers warm).
    pub config_options: Vec<SessionConfigOption>,
    /// Auth methods advertised at the handshake (sign-in actions).
    pub auth_methods: Vec<crate::protocol::types::AuthMethod>,
}

impl AgentRuntime {
    /// Shared `session/new` for the result path: only -32000 flips the
    /// provider to Needs sign-in and gets the typed `auth_required` code.
    async fn open_session(
        &self,
        conn: &AcpConn,
        cwd: &str,
        instance_id: &str,
        methods: &[crate::protocol::types::AuthMethod],
        mcp_servers: &[crate::protocol::types::McpServer],
    ) -> Result<crate::protocol::types::NewSessionResult, crate::PultError> {
        match conn.new_session_with_mcp(cwd, mcp_servers.to_vec()).await {
            Ok(session) => {
                self.cache_auth_state(instance_id, methods.to_vec(), false, None);
                Ok(session)
            }
            Err(err) if err.is_auth_required() => {
                let hint = err.to_string();
                self.cache_auth_state(instance_id, methods.to_vec(), true, Some(hint.clone()));
                self.emit(
                    "agent:process",
                    &ProcessEventPayload {
                        instance_id: instance_id.to_string(),
                        kind: "needs_auth".to_string(),
                        detail: Some(hint.clone()),
                    },
                );
                Err(crate::PultError::with_code("auth_required", hint))
            }
            Err(err) => Err(crate::PultError::internal(err.to_string())),
        }
    }

    /// One-click connect check: spawn the agent, complete the initialize
    /// handshake, cache its capabilities, shut it down. No prompt is sent, so
    /// the check costs nothing and never touches a session вЂ” this is what the
    /// "Connect" button runs so the user never wires commands by hand.
    pub async fn preflight(&self, instance_id: &str) -> Result<PreflightReport, crate::PultError> {
        let spec = {
            let inner = self.inner.lock().expect("runtime lock poisoned");
            inner
                .instances
                .iter()
                .find(|i| i.id == instance_id)
                .cloned()
        }
        .ok_or_else(|| crate::PultError::internal(format!("unknown instance: {instance_id}")))?;
        if !spec.enabled {
            return Err(crate::PultError::internal(format!(
                "provider {instance_id} is disabled вЂ” turn it on in Settings в–ё Providers"
            )));
        }
        let spawn_config = self.spawn_config_for(instance_id)?;
        let (conn, _streams) = crate::drivers::acp::AcpConn::spawn(&spawn_config).map_err(|e| {
            crate::PultError::internal(format!("{} failed to start: {e}", spec.display_name))
        })?;
        if let Some(pid) = conn.pid() {
            crate::processes::register_process(
                pid,
                crate::processes::ProcessMeta::new("agent")
                    .with_label(&spec.display_name)
                    .with_instance(instance_id),
            );
        }
        let init = conn.initialize().await.map_err(|e| {
            conn.kill();
            crate::PultError::internal(format!(
                "{} did not answer the handshake: {e}",
                spec.display_name
            ))
        })?;
        // Auth is real only if a session can actually be created: authMethods
        // advertise SUPPORTED methods, not a missing login (T3 semantics).
        // The probe runs in a temp cwd and sends no prompt вЂ” free and safe.
        let probe_cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let (auth_required, auth_hint, config_options) = match conn.new_session(&probe_cwd).await {
            Ok(session) => (false, None, session.config_options),
            Err(err) if err.is_auth_required() => (true, Some(err.to_string()), Vec::new()),
            Err(err) => {
                conn.kill();
                return Err(crate::PultError::internal(format!(
                    "{} session probe failed: {err}",
                    spec.display_name
                )));
            }
        };
        // Capabilities cached here feed the composer gating immediately.
        self.cache_capabilities(
            instance_id,
            &init.agent_capabilities,
            Vec::new(),
            config_options.clone(),
        );
        self.cache_auth_state(
            instance_id,
            init.auth_methods.clone(),
            auth_required,
            auth_hint.clone(),
        );
        if auth_required {
            self.emit(
                "agent:process",
                &ProcessEventPayload {
                    instance_id: instance_id.to_string(),
                    kind: "needs_auth".to_string(),
                    detail: auth_hint.clone(),
                },
            );
        }
        conn.kill();
        Ok(PreflightReport {
            instance_id: instance_id.to_string(),
            agent_name: init
                .agent_info
                .as_ref()
                .map(|i| i.name.clone())
                .unwrap_or_else(|| spec.display_name.clone()),
            agent_version: init.agent_info.as_ref().and_then(|i| i.version.clone()),
            load_session: init.agent_capabilities.load_session,
            prompt_image: init.agent_capabilities.prompt_capabilities.image,
            auth_required,
            auth_hint,
            config_options,
            auth_methods: init.auth_methods.clone(),
        })
    }

    /// Runs an agent-managed sign-in: initialize в†’ authenticate(method) в†’
    /// fresh `session/new` probe в†’ kill. The second probe is the only honest
    /// proof: an agent may answer `{}` and still keep sessions locked.
    pub async fn authenticate(
        &self,
        instance_id: &str,
        method_id: &str,
    ) -> Result<PreflightReport, crate::PultError> {
        if method_id.trim().is_empty() {
            return Err(crate::PultError::with_code(
                "provider.auth_method_missing",
                "auth method id is empty",
            ));
        }
        let (spec, cached_methods) = {
            let inner = self.inner.lock().expect("runtime lock poisoned");
            let spec = inner
                .instances
                .iter()
                .find(|i| i.id == instance_id)
                .cloned()
                .ok_or_else(|| {
                    crate::PultError::internal(format!("unknown instance: {instance_id}"))
                })?;
            let methods = inner
                .capabilities
                .get(instance_id)
                .map(|c| c.auth_methods.clone())
                .unwrap_or_default();
            (spec, methods)
        };
        if !spec.enabled {
            return Err(crate::PultError::internal(format!(
                "provider {instance_id} is disabled вЂ” turn it on in Settings в–ё Providers"
            )));
        }
        if !cached_methods.is_empty() {
            match cached_methods
                .iter()
                .find(|m| m.id.as_deref() == Some(method_id))
            {
                Some(method) if !method.is_agent() => {
                    return Err(crate::PultError::internal(
                        "terminal sign-in runs the agent CLI outside pult; use Copy command",
                    ));
                }
                Some(_) => {}
                None => {
                    return Err(crate::PultError::internal(format!(
                        "unknown auth method: {method_id}"
                    )));
                }
            }
        }

        let spawn_config = self.spawn_config_for(instance_id)?;
        let (conn, _streams) = crate::drivers::acp::AcpConn::spawn(&spawn_config).map_err(|e| {
            crate::PultError::internal(format!("{} failed to start: {e}", spec.display_name))
        })?;
        if let Some(pid) = conn.pid() {
            crate::processes::register_process(
                pid,
                crate::processes::ProcessMeta::new("agent")
                    .with_label(&spec.display_name)
                    .with_instance(instance_id),
            );
        }
        let init = conn.initialize().await.map_err(|e| {
            conn.kill();
            crate::PultError::internal(format!(
                "{} did not answer the handshake: {e}",
                spec.display_name
            ))
        })?;
        match init
            .auth_methods
            .iter()
            .find(|m| m.id.as_deref() == Some(method_id))
        {
            Some(method) if !method.is_agent() => {
                conn.kill();
                return Err(crate::PultError::internal(
                    "terminal sign-in runs the agent CLI outside pult; use Copy command",
                ));
            }
            Some(_) => {}
            None => {
                conn.kill();
                return Err(crate::PultError::internal(format!(
                    "{} did not advertise auth method {method_id}",
                    spec.display_name
                )));
            }
        }
        if let Err(err) = conn.authenticate(method_id).await {
            conn.kill();
            return Err(crate::PultError::internal(format!(
                "{} sign-in failed: {err}",
                spec.display_name
            )));
        }

        let probe_cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let (auth_required, auth_hint, config_options) = match conn.new_session(&probe_cwd).await {
            Ok(session) => (false, None, session.config_options),
            Err(err) if err.is_auth_required() => (true, Some(err.to_string()), Vec::new()),
            Err(err) => {
                conn.kill();
                return Err(crate::PultError::internal(format!(
                    "{} session probe after sign-in failed: {err}",
                    spec.display_name
                )));
            }
        };
        self.cache_capabilities(
            instance_id,
            &init.agent_capabilities,
            Vec::new(),
            config_options.clone(),
        );
        self.cache_auth_state(
            instance_id,
            init.auth_methods.clone(),
            auth_required,
            auth_hint.clone(),
        );
        if auth_required {
            self.emit(
                "agent:process",
                &ProcessEventPayload {
                    instance_id: instance_id.to_string(),
                    kind: "needs_auth".to_string(),
                    detail: auth_hint.clone(),
                },
            );
        }
        conn.kill();
        Ok(PreflightReport {
            instance_id: instance_id.to_string(),
            agent_name: init
                .agent_info
                .as_ref()
                .map(|i| i.name.clone())
                .unwrap_or_else(|| spec.display_name.clone()),
            agent_version: init.agent_info.as_ref().and_then(|i| i.version.clone()),
            load_session: init.agent_capabilities.load_session,
            prompt_image: init.agent_capabilities.prompt_capabilities.image,
            auth_required,
            auth_hint,
            config_options,
            auth_methods: init.auth_methods.clone(),
        })
    }
}

pub(crate) struct ResolvedSession {
    pub session_id: String,
    pub resumed: bool,
    /// Bearer issued for this session's orchestrator MCP entry.
    pub mcp_token: Option<String>,
    /// Set when the UI history and the agent's context can no longer match.
    pub context_reset_reason: Option<String>,
    /// MCP configuration generation this session was opened under.
    pub mcp_generation: u64,
    pub handshake_ms: u64,
    pub session_ms: u64,
}

#[allow(clippy::too_many_arguments)]
async fn resolve_session(
    conn: &AcpConn,
    runtime: &AgentRuntime,
    thread_id: &str,
    instance_id: &str,
    owner_token: &str,
    current_run_id: &str,
    root: &Path,
    preinit: Option<crate::protocol::types::InitializeResult>,
) -> Result<ResolvedSession, crate::PultError> {
    let t_handshake = std::time::Instant::now();
    let init = match preinit {
        Some(init) => init,
        None => conn
            .initialize()
            .await
            .map_err(|e| crate::PultError::internal(e.to_string()))?,
    };
    let handshake_ms = t_handshake.elapsed().as_millis() as u64;
    let t_session = std::time::Instant::now();
    let mut resumed = false;
    tracing::info!(target: "pult::runtime",
        agent = %init.agent_info.as_ref().map(|i| i.name.clone()).unwrap_or_default(),
        load_session = init.agent_capabilities.load_session,
        "agent initialized");
    let cwd = root.to_string_lossy().into_owned();
    // Orchestration is injected per session: HTTP when the agent says it can
    // speak it, otherwise the stdio bridge. A missing server (tests) is fine.
    let http_mcp = init
        .agent_capabilities
        .mcp_capabilities
        .as_ref()
        .and_then(|caps| caps.get("http"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    // Capture before resolving: a config edit during session creation must
    // leave this session stamped with the old generation.
    let mcp_generation = runtime
        .mcp_generation
        .load(std::sync::atomic::Ordering::Relaxed);
    let (mcp_servers, mcp_token) =
        runtime.mcp_servers_for(thread_id, instance_id, owner_token, http_mcp);
    // A SQLite failure is not "no previous session": surface it instead of
    // silently starting fresh.
    let session_ref = runtime.store.get_session_ref(thread_id, instance_id)?;
    let previous_instance = runtime.store.list_runs(thread_id).ok().and_then(|runs| {
        // This run's own row already exists: the previous agent is the last
        // row that is not the current run.
        runs.into_iter()
            .rev()
            .find(|run| run.id != current_run_id)
            .map(|run| run.instance_id)
    });
    let mut context_reset_reason = None;
    let session = match session_ref {
        Some(remote) if init.agent_capabilities.load_session => {
            match conn
                .load_session_with_mcp(&remote, &cwd, mcp_servers.clone())
                .await
            {
                Ok(loaded) => {
                    resumed = true;
                    tracing::info!(target: "pult::runtime",
                        session = %remote, "resumed session via session/load");
                    runtime.cache_auth_state(instance_id, init.auth_methods.clone(), false, None);
                    runtime.cache_capabilities(
                        instance_id,
                        &init.agent_capabilities,
                        loaded.modes.as_ref().map(collect_modes).unwrap_or_default(),
                        loaded.config_options.clone(),
                    );
                    remote
                }
                Err(err) => {
                    tracing::warn!(target: "pult::runtime",
                        error = %err, "session/load failed; starting a new session");
                    context_reset_reason = Some(
                        "The previous session could not be resumed вЂ” this run starts with fresh agent context."
                            .to_string(),
                    );
                    let fresh = runtime
                        .open_session(conn, &cwd, instance_id, &init.auth_methods, &mcp_servers)
                        .await?;
                    let _ =
                        runtime
                            .store
                            .upsert_session_ref(thread_id, instance_id, &fresh.session_id);
                    runtime.cache_capabilities(
                        instance_id,
                        &init.agent_capabilities,
                        fresh.modes.as_ref().map(collect_modes).unwrap_or_default(),
                        fresh.config_options.clone(),
                    );
                    fresh.session_id
                }
            }
        }
        Some(_) => {
            // The agent advertises no session/load: the visible history is
            // not its context, so say so instead of pretending to continue.
            context_reset_reason = Some(
                "This agent cannot resume sessions вЂ” this run starts with fresh agent context."
                    .to_string(),
            );
            let fresh = runtime
                .open_session(conn, &cwd, instance_id, &init.auth_methods, &mcp_servers)
                .await?;
            let _ = runtime
                .store
                .upsert_session_ref(thread_id, instance_id, &fresh.session_id);
            runtime.cache_capabilities(
                instance_id,
                &init.agent_capabilities,
                fresh.modes.as_ref().map(collect_modes).unwrap_or_default(),
                fresh.config_options.clone(),
            );
            fresh.session_id
        }
        None => {
            if previous_instance
                .as_deref()
                .is_some_and(|previous| previous != instance_id)
            {
                context_reset_reason = Some(
                    "Switched agent вЂ” this run starts without the previous agent's context."
                        .to_string(),
                );
            }
            let fresh = runtime
                .open_session(conn, &cwd, instance_id, &init.auth_methods, &mcp_servers)
                .await?;
            let _ = runtime
                .store
                .upsert_session_ref(thread_id, instance_id, &fresh.session_id);
            runtime.cache_capabilities(
                instance_id,
                &init.agent_capabilities,
                fresh.modes.as_ref().map(collect_modes).unwrap_or_default(),
                fresh.config_options.clone(),
            );
            fresh.session_id
        }
    };
    Ok(ResolvedSession {
        session_id: session,
        resumed,
        mcp_token,
        context_reset_reason,
        mcp_generation,
        handshake_ms,
        session_ms: t_session.elapsed().as_millis() as u64,
    })
}

/// M6: the mode picker works from the advertised mode list.
fn collect_modes(
    state: &crate::protocol::types::SessionModeState,
) -> Vec<crate::protocol::types::SessionMode> {
    state.available_modes.clone()
}

/// String value of a desired config option (booleans never become model/effort).
fn desired_string(config: &DesiredConfigMap, id: &str) -> Option<String> {
    match config.get(id) {
        Some(ConfigOptionValue::String(value)) => Some(value.clone()),
        _ => None,
    }
}

/// Every id agents have used for the reasoning/thought level.
fn effort_id_order() -> &'static [&'static str] {
    &[
        "thought_level",
        "thinking_level",
        "reasoning_effort",
        "effort",
        "reasoning",
    ]
}

/// True when the value is one the option actually advertises right now.
fn session_config_value_valid(
    options: &[SessionConfigOption],
    id: &str,
    value: &ConfigOptionValue,
) -> bool {
    let Some(option) = options.iter().find(|option| option.id == id) else {
        return false;
    };
    match (&option.kind, value) {
        (
            crate::protocol::types::SessionConfigOptionKind::Select { options, .. },
            ConfigOptionValue::String(value),
        ) => match options {
            crate::protocol::types::SessionConfigSelectOptions::Flat(items) => {
                items.iter().any(|item| &item.value == value)
            }
            crate::protocol::types::SessionConfigSelectOptions::Grouped(groups) => groups
                .iter()
                .flat_map(|group| group.options.iter())
                .any(|item| &item.value == value),
        },
        (
            crate::protocol::types::SessionConfigOptionKind::Boolean { .. },
            ConfigOptionValue::Bool(_),
        ) => true,
        _ => false,
    }
}

/// Application order: `model` first (agents narrow dependent options when it
/// changes), then thought level, then the rest.
fn config_apply_order(id: &str) -> u8 {
    match id {
        "model" => 0,
        "thought_level" | "thinking_level" | "reasoning_effort" | "effort" | "reasoning" => 1,
        _ => 2,
    }
}

/// Mirrors the agent's effective option values into the parked-session
/// bookkeeping, so a pooled turn only re-sends values that really differ.
/// Crucially, applying `model` may narrow/reset dependent options; syncing
/// here makes the next pick in the same loop see the new current value.
fn sync_applied_config(applied: &mut DesiredConfigMap, options: &[SessionConfigOption]) {
    for option in options {
        let value = match &option.kind {
            crate::protocol::types::SessionConfigOptionKind::Select { current_value, .. } => {
                ConfigOptionValue::String(current_value.clone())
            }
            crate::protocol::types::SessionConfigOptionKind::Boolean { current_value } => {
                ConfigOptionValue::Bool(*current_value)
            }
        };
        applied.insert(option.id.clone(), value);
    }
}

/// Permission policy + surfacing (В§5.5): the mode may auto-resolve before
/// the UI ever sees the request; every auto resolution is traced (never
/// silent). Surfaced requests park in `pending_permissions`.
#[allow(clippy::too_many_arguments)]
async fn handle_permission_request(
    runtime: &AgentRuntime,
    conn: &AcpConn,
    run_id: &str,
    thread_id: &str,
    instance_id: &str,
    root: &Path,
    batcher: &mut crate::runtime::batch::EventBatcher,
    pending: &mut HashMap<String, PendingPermission>,
    request_id: &RequestId,
    params: RequestPermissionParams,
) -> Result<(), crate::PultError> {
    let request_key = request_id_key(request_id);
    let tool_kind: String = params
        .tool_call
        .kind
        .map(crate::drivers::acp::tool_kind_str)
        .unwrap_or("other")
        .to_string();
    let paths: Vec<String> = params
        .tool_call
        .locations
        .iter()
        .flatten()
        .map(|l| l.path.clone())
        .collect();
    let options: Vec<crate::runtime::permissions::PolicyOption> = params
        .options
        .iter()
        .map(|o| crate::runtime::permissions::PolicyOption {
            option_id: o.option_id.clone(),
            kind: o.kind.clone(),
        })
        .collect();
    let remembered = runtime.remembered_for(&workspace_key(root), instance_id, &tool_kind);
    let decision = crate::runtime::permissions::resolve(
        runtime.permission_mode_for(thread_id),
        root,
        &crate::runtime::permissions::PolicyRequest {
            tool_kind: &tool_kind,
            paths: &paths,
            options: &options,
            remembered: remembered.as_deref(),
        },
    );
    if let crate::runtime::permissions::PolicyDecision::AutoResolve(option_id) = decision {
        // Trace row in the event log: never silent (В§5.5).
        let flushed = batcher.push(EventKind::ApprovalResponse {
            request_id: request_key,
            option_id: Some(option_id.clone()),
            auto: true,
        });
        persist_event_batch(runtime, run_id, flushed)?;
        let _ = conn
            .respond_client(request_id.clone(), permission_reply(Some(option_id)))
            .await;
        return Ok(());
    }
    surface_permission(runtime, run_id, batcher, pending, request_id, params)
}

/// ACP ToolKind string of the permission's tool call (""other"" when absent).
fn tool_kind_from_call(params: &RequestPermissionParams) -> String {
    params
        .tool_call
        .kind
        .map(crate::drivers::acp::tool_kind_str)
        .unwrap_or("other")
        .to_string()
}

/// Surface a permission request to the UI: transcript event + fan-out.
fn surface_permission(
    runtime: &AgentRuntime,
    run_id: &str,
    batcher: &mut crate::runtime::batch::EventBatcher,
    pending: &mut HashMap<String, PendingPermission>,
    request_id: &RequestId,
    params: RequestPermissionParams,
) -> Result<(), crate::PultError> {
    let request_key = request_id_key(request_id);
    let mut option_kinds = HashMap::new();
    for option in &params.options {
        option_kinds.insert(option.option_id.clone(), option.kind.clone());
    }
    pending.insert(
        request_key.clone(),
        PendingPermission {
            wire_id: request_id.clone(),
            tool_kind: tool_kind_from_call(&params),
            option_kinds,
        },
    );

    let title = params
        .tool_call
        .title
        .clone()
        .unwrap_or_else(|| "Permission needed".to_string());
    let options: Vec<AppPermissionOption> = params
        .options
        .iter()
        .map(|o| AppPermissionOption {
            option_id: o.option_id.clone(),
            name: o.name.clone(),
            kind: o.kind.clone(),
        })
        .collect();
    let flushed = batcher.push(EventKind::ApprovalRequest {
        request_id: request_key.clone(),
        tool_call_id: Some(params.tool_call.tool_call_id.clone()),
        title: title.clone(),
        options: options.clone(),
    });
    persist_event_batch(runtime, run_id, flushed)?;
    runtime.emit(
        "permission:request",
        &PermissionRequestPayload {
            run_id: run_id.to_string(),
            request_id: request_key.clone(),
            title,
            options,
        },
    );
    notify_if_unfocused(runtime, "Approval needed", &request_key);
    Ok(())
}

/// Elicitation (В§5.5): surface for the modal; the run parks until answered.
fn surface_elicitation(
    runtime: &AgentRuntime,
    run_id: &str,
    batcher: &mut crate::runtime::batch::EventBatcher,
    pending: &mut HashMap<String, PendingElicitation>,
    request_id: &RequestId,
    params: CreateElicitationParams,
) -> Result<(), crate::PultError> {
    let request_key = request_id_key(request_id);
    pending.insert(
        request_key.clone(),
        PendingElicitation {
            wire_id: request_id.clone(),
        },
    );
    let flushed = batcher.push(EventKind::ElicitationRequest {
        message: params.message.clone(),
        detail: params.detail.clone(),
    });
    persist_event_batch(runtime, run_id, flushed)?;
    runtime.emit(
        "elicitation:request",
        &ElicitationRequestPayload {
            run_id: run_id.to_string(),
            request_id: request_key,
            message: params.message.clone(),
            detail: params.detail.clone(),
        },
    );
    notify_if_unfocused(runtime, "Agent needs input", "elicitation");
    Ok(())
}

/// OS notification when the window is not focused (В§5.5); the focus check
/// lives in the AppHandle EventSink impl.
fn notify_if_unfocused(runtime: &AgentRuntime, title: &str, body: &str) {
    runtime.sink_notify(title, body);
}

/// `terminal/create` handler: sandbox-checked cwd + spawn (В§5.5).
fn handle_terminal_create(
    terminals: &TerminalRegistry,
    owner_token: &str,
    root: &Path,
    params: &CreateTerminalParams,
) -> ClientReply {
    // No cwd means "the project": inheriting the app's cwd would run the tool
    // outside the user's workspace.
    let cwd = match &params.cwd {
        Some(raw) => safe_path(root, raw)?,
        None => root.to_path_buf(),
    };
    let env: Vec<(String, String)> = params
        .env
        .iter()
        .map(|e| (e.name.clone(), e.value.clone()))
        .collect();
    terminals.create(
        owner_token,
        &params.command,
        &params.args,
        Some(&cwd),
        &env,
        params.output_byte_limit,
    )
}

fn request_id_key(id: &RequestId) -> String {
    match id {
        RequestId::Num(n) => format!("n{n}"),
        RequestId::Str(s) => format!("s{s}"),
    }
}

fn read_file_sandboxed(root: &Path, params: &ReadTextFileParams) -> ClientReply {
    let path = safe_path(root, &params.path)?;
    let content =
        std::fs::read_to_string(&path).map_err(|e| fs_error(format!("{}: {e}", params.path)))?;
    let mut lines: Vec<&str> = content.lines().collect();
    if let Some(line) = params.line {
        let start = line.saturating_sub(1) as usize;
        if start >= lines.len() {
            lines.clear();
        } else {
            lines = lines.split_off(start);
        }
    }
    if let Some(limit) = params.limit {
        lines.truncate(limit as usize);
    }
    serde_json::to_value(ReadTextFileResult {
        content: lines.join("\n"),
    })
    .map_err(|e| fs_error(e.to_string()))
}

/// `fs/write_text_file`: sandboxed write plus the computed diff (В§5.4) вЂ”
/// the fs layer attaches old-vs-new to the thread's "Changed files".
fn write_file_sandboxed(
    root: &Path,
    params: &WriteTextFileParams,
) -> (ClientReply, Option<(String, String, u64, u64)>) {
    let path = match safe_path(root, &params.path) {
        Ok(path) => path,
        Err(err) => return (Err(err), None),
    };
    let old = std::fs::read_to_string(&path).unwrap_or_default();
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return (Err(fs_error(format!("{}: {e}", params.path))), None);
        }
    }
    if let Err(e) = std::fs::write(&path, &params.content) {
        return (Err(fs_error(format!("{}: {e}", params.path))), None);
    }
    let shown_path = params.path.trim_start_matches(['/', '\\']).to_string();
    let diff = unified_diff(&shown_path, &old, &params.content);
    let (added, removed) = diff_stats(&diff);
    let change = (shown_path, diff, added, removed);
    (Ok(serde_json::json!({})), Some(change))
}

/// Unified diff of oldв†’new (3 context lines, same header style as git).
fn unified_diff(path: &str, old: &str, new: &str) -> String {
    similar::TextDiff::from_lines(old, new)
        .unified_diff()
        .context_radius(3)
        .header(&format!("a/{path}"), &format!("b/{path}"))
        .to_string()
}

/// Count +added/-removed lines from a unified diff body.
fn diff_stats(diff: &str) -> (u64, u64) {
    let mut added = 0u64;
    let mut removed = 0u64;
    for line in diff.lines() {
        match line.chars().next() {
            Some('+') if !line.starts_with("+++") => added += 1,
            Some('-') if !line.starts_with("---") => removed += 1,
            _ => {}
        }
    }
    (added, removed)
}

/// Reject paths escaping the workspace root (В§5.5: -32002-style typed error).
fn safe_path(root: &Path, raw: &str) -> Result<PathBuf, RpcError> {
    let escape = || {
        RpcError::new(
            ERR_RESOURCE_NOT_FOUND,
            format!("path escapes workspace: {raw}"),
        )
    };
    let candidate = Path::new(raw);
    // Rootless POSIX-style paths (/repo/src/main.rs) from an agent whose cwd
    // is the workspace resolve against the workspace root; drive/UNC paths
    // are taken as-is and must stay inside the root (checked below).
    let joined = match candidate.components().next() {
        Some(std::path::Component::Prefix(_)) => candidate.to_path_buf(),
        Some(std::path::Component::RootDir) => {
            let rest: PathBuf = candidate.components().skip(1).collect();
            root.join(rest)
        }
        _ => root.join(candidate),
    };
    for component in joined.components() {
        if component == std::path::Component::ParentDir {
            return Err(escape());
        }
    }
    // Compare canonical against canonical: `canonicalize()` returns verbatim
    // `\?\вЂ¦` paths, and mixing that with a clean root makes `starts_with`
    // fail spuriously ("path escapes workspace" for `.`).
    let base = root.canonicalize().map_err(|_| escape())?;
    // New files and symlinked parents do not canonicalize themselves, so walk
    // up to the nearest existing ancestor: an absolute path outside the root
    // (`C:\evil.txt`) or a symlink pointing out of it must still be rejected.
    let mut ancestor = joined.as_path();
    loop {
        match ancestor.canonicalize() {
            Ok(real) if real.starts_with(&base) => break,
            Ok(_) => return Err(escape()),
            Err(_) => match ancestor.parent() {
                Some(parent) => ancestor = parent,
                None => return Err(escape()),
            },
        }
    }
    Ok(joined)
}

pub mod batch;
pub mod permissions;
pub mod pool;
pub mod ptys;
pub mod terminals;
#[cfg(test)]
mod tests;
