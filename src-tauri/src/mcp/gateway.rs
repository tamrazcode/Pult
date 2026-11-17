//! Loopback gateway for user-configured MCP servers.
//!
//! Agents never receive an upstream URL, headers or API key. They connect to
//! `http://127.0.0.1:<port>/mcp/<server_id>` with a per-session bearer token
//! (or through `pult mcp-stdio --custom <id>`), and the gateway owns the real
//! stdio/HTTP/SSE transport, one shared upstream session per server.

use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex as AsyncMutex;

use crate::http1::{read_request, respond, respond_json, HttpReadError};
use crate::mcp::transport::{McpTransport, TransportFuture};

const MAX_BODY: usize = 2 * 1024 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(30);
const PROTOCOL_VERSION: &str = "2025-06-18";

/// Per-server tool policy enforced by the gateway itself, so an upstream or an
/// agent cannot bypass it.
#[derive(Debug, Clone, Default)]
pub struct GatewayPolicy {
    pub allow_tools: Vec<String>,
    pub deny_tools: Vec<String>,
}

/// Opens the real upstream transport for a configured server.
pub trait GatewayConnector: Send + Sync {
    fn connect<'a>(&'a self, server_id: &'a str) -> TransportFuture<'a, Arc<dyn McpTransport>>;

    /// Current allow/deny lists; a missing row denies everything.
    fn policy(&self, _server_id: &str) -> GatewayPolicy {
        GatewayPolicy::default()
    }
}

/// One agent-facing endpoint: URL plus the bearer it must send.
#[derive(Debug, Clone)]
pub struct GatewayEndpoint {
    pub url: String,
    pub token: String,
}

pub struct GatewayTokens {
    tokens: Mutex<HashMap<String, TokenEntry>>,
}

struct TokenEntry {
    server_id: String,
    owner: Option<String>,
}

impl Default for GatewayTokens {
    fn default() -> Self {
        Self::new()
    }
}

impl GatewayTokens {
    pub fn new() -> Self {
        Self {
            tokens: Mutex::new(HashMap::new()),
        }
    }

    pub fn issue(&self, server_id: &str) -> Result<String, String> {
        self.issue_for(None, server_id)
    }

    /// Token bound to one ACP session so it can be revoked with that session.
    pub fn issue_for(&self, owner: Option<&str>, server_id: &str) -> Result<String, String> {
        let token = random_token()?;
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.insert(
                token.clone(),
                TokenEntry {
                    server_id: server_id.to_string(),
                    owner: owner.map(str::to_string),
                },
            );
        }
        Ok(token)
    }

    pub fn resolve(&self, token: &str) -> Option<String> {
        self.tokens
            .lock()
            .ok()
            .and_then(|tokens| tokens.get(token).map(|entry| entry.server_id.clone()))
    }

    pub fn revoke(&self, token: &str) {
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.remove(token);
        }
    }

    pub fn revoke_server(&self, server_id: &str) {
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.retain(|_, entry| entry.server_id != server_id);
        }
    }

    pub fn revoke_owner(&self, owner: &str) {
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.retain(|_, entry| entry.owner.as_deref() != Some(owner));
        }
    }

    pub fn revoke_all(&self) {
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.clear();
        }
    }
}

/// Cached initialize result, its epoch and the client it belongs to.
type Initialized = HashMap<String, (Value, u64, Weak<dyn McpTransport>)>;

pub struct McpGateway {
    url: String,
    port: u16,
    tokens: Arc<GatewayTokens>,
    connector: Arc<dyn GatewayConnector>,
    clients: AsyncMutex<HashMap<String, Arc<dyn McpTransport>>>,
    stats: AsyncMutex<HashMap<String, GatewayStats>>,
    /// Bumped by `close_server`; an in-flight connect from an older generation
    /// must not repopulate the cache.
    generations: AsyncMutex<HashMap<String, u64>>,
    /// Upstream initialize result per server, bound to the exact client and
    /// its epoch so a replacement transport never inherits it.
    initialized: AsyncMutex<Initialized>,
    initialize_lock: AsyncMutex<()>,
}

/// Per-server counters shown in Diagnostics.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStats {
    pub calls_total: u64,
    pub errors_total: u64,
    pub last_latency_ms: Option<u64>,
}

impl McpGateway {
    pub async fn start(
        connector: Arc<dyn GatewayConnector>,
        tokens: Arc<GatewayTokens>,
    ) -> io::Result<Arc<Self>> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let gateway = Arc::new(Self {
            url: format!("http://127.0.0.1:{port}/mcp"),
            port,
            tokens,
            connector,
            clients: AsyncMutex::new(HashMap::new()),
            stats: AsyncMutex::new(HashMap::new()),
            generations: AsyncMutex::new(HashMap::new()),
            initialized: AsyncMutex::new(HashMap::new()),
            initialize_lock: AsyncMutex::new(()),
        });
        let serving = Arc::clone(&gateway);
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let gateway = Arc::clone(&serving);
                tokio::spawn(async move {
                    let _ = serve(stream, gateway).await;
                });
            }
        });
        Ok(gateway)
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn tokens(&self) -> Arc<GatewayTokens> {
        Arc::clone(&self.tokens)
    }

    /// Issues a fresh bearer token for one agent session.
    pub fn endpoint(&self, server_id: &str) -> Result<GatewayEndpoint, String> {
        self.endpoint_for(None, server_id)
    }

    pub fn endpoint_for(
        &self,
        owner: Option<&str>,
        server_id: &str,
    ) -> Result<GatewayEndpoint, String> {
        Ok(GatewayEndpoint {
            url: format!("{}/{}", self.url, server_id),
            token: self.tokens.issue_for(owner, server_id)?,
        })
    }

    /// Drops the cached upstream connection and every token for the server.
    pub async fn close_server(&self, server_id: &str) {
        self.bump_generation(server_id).await;
        self.tokens.revoke_server(server_id);
        self.drop_client(server_id).await;
    }

    async fn bump_generation(&self, server_id: &str) {
        let mut generations = self.generations.lock().await;
        *generations.entry(server_id.to_string()).or_insert(0) += 1;
    }

    async fn generation(&self, server_id: &str) -> u64 {
        *self.generations.lock().await.get(server_id).unwrap_or(&0)
    }

    /// Drops just the upstream connection (failure recovery). Agent tokens
    /// stay valid, so the next call reconnects transparently.
    pub async fn drop_client(&self, server_id: &str) {
        self.initialized.lock().await.remove(server_id);
        let client = self.clients.lock().await.remove(server_id);
        if let Some(client) = client {
            let _ = client.close().await;
        }
    }

    pub async fn logs(&self, server_id: &str) -> Vec<String> {
        self.clients
            .lock()
            .await
            .get(server_id)
            .map(|client| client.logs())
            .unwrap_or_default()
    }

    pub async fn stats(&self, server_id: &str) -> GatewayStats {
        self.stats
            .lock()
            .await
            .get(server_id)
            .cloned()
            .unwrap_or_default()
    }

    async fn record_call(&self, server_id: &str, started: Instant, failed: bool) {
        let mut stats = self.stats.lock().await;
        let entry = stats.entry(server_id.to_string()).or_default();
        entry.calls_total += 1;
        if failed {
            entry.errors_total += 1;
        }
        entry.last_latency_ms = Some(started.elapsed().as_millis() as u64);
    }

    async fn client(&self, server_id: &str) -> Result<Arc<dyn McpTransport>, String> {
        if let Some(client) = self.clients.lock().await.get(server_id).cloned() {
            return Ok(client);
        }
        let generation = self.generation(server_id).await;
        let client = self.connector.connect(server_id).await?;
        let mut clients = self.clients.lock().await;
        if self.generation(server_id).await != generation {
            drop(clients);
            let _ = client.close().await;
            return Err("MCP configuration changed while connecting; retry the call".to_string());
        }
        match clients.get(server_id).cloned() {
            Some(existing) => {
                drop(clients);
                let _ = client.close().await;
                Ok(existing)
            }
            None => {
                clients.insert(server_id.to_string(), Arc::clone(&client));
                Ok(client)
            }
        }
    }

    async fn ensure_initialized(
        &self,
        server_id: &str,
    ) -> Result<(Arc<dyn McpTransport>, Value), String> {
        let _serial = self.initialize_lock.lock().await;
        // Capture the generation before touching the client cache: a close
        // between these steps must not let an old client adopt the new state.
        let generation = self.generation(server_id).await;
        let client = self.client(server_id).await?;
        let client_ref = Arc::downgrade(&client);
        let epoch = client.session_epoch();
        let cached = {
            let initialized = self.initialized.lock().await;
            initialized.get(server_id).cloned()
        };
        if let Some((result, cached_epoch, cached_client)) = cached {
            if cached_epoch == epoch && Weak::ptr_eq(&cached_client, &client_ref) {
                return Ok((client, result));
            }
            self.initialized.lock().await.remove(server_id);
        }
        let reply = client
            .request(json!({
                "jsonrpc": "2.0",
                "id": 0,
                "method": "initialize",
                "params": {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {
                        "name": "Pult",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }
            }))
            .await?;
        if let Some(error) = reply.get("error") {
            return Err(format!("MCP initialize failed: {error}"));
        }
        let result = reply.get("result").cloned().unwrap_or_else(|| json!({}));
        client
            .notify(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .await?;
        // Hold `initialized` across the check and the insert: `close_server`
        // bumps the generation, then clears this map, so it either waits for
        // this insert or invalidates it afterwards.
        let mut initialized = self.initialized.lock().await;
        let current = self.clients.lock().await.get(server_id).cloned();
        let same_client = current
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &client));
        if self.generation(server_id).await != generation
            || client.session_epoch() != epoch
            || !same_client
        {
            drop(initialized);
            self.evict_client_if_same(server_id, &client).await;
            return Err("MCP session changed during initialization; retry the call".to_string());
        }
        initialized.insert(server_id.to_string(), (result.clone(), epoch, client_ref));
        drop(initialized);
        Ok((client, result))
    }

    async fn evict_client_if_same(&self, server_id: &str, client: &Arc<dyn McpTransport>) {
        let removed = {
            let mut clients = self.clients.lock().await;
            if clients
                .get(server_id)
                .is_some_and(|current| Arc::ptr_eq(current, client))
            {
                clients.remove(server_id)
            } else {
                None
            }
        };
        if let Some(removed) = removed {
            let mut initialized = self.initialized.lock().await;
            let stale_init = initialized.get(server_id).is_some_and(|(_, _, owner)| {
                owner
                    .upgrade()
                    .is_some_and(|owner| Arc::ptr_eq(&owner, client))
            });
            if stale_init {
                initialized.remove(server_id);
            }
            drop(initialized);
            let _ = removed.close().await;
        }
    }
}

async fn serve(mut stream: TcpStream, gateway: Arc<McpGateway>) -> io::Result<()> {
    let request =
        match tokio::time::timeout(READ_TIMEOUT, read_request(&mut stream, MAX_BODY)).await {
            Ok(Ok(Some(request))) => request,
            Ok(Ok(None)) => return Ok(()),
            Ok(Err(HttpReadError::TooLarge)) => {
                return respond(&mut stream, 413, "text/plain", b"request too large").await
            }
            Ok(Err(HttpReadError::Io(error))) => return Err(error),
            Err(_) => return respond(&mut stream, 408, "text/plain", b"request timed out").await,
        };
    if request.method != "POST" {
        // Server-initiated messages are not proxied; every reply travels on the
        // POST that asked for it.
        return respond(&mut stream, 405, "text/plain", b"method not allowed").await;
    }
    let Some(server_id) = request
        .path
        .strip_prefix("/mcp/")
        .filter(|id| !id.is_empty() && !id.contains('/'))
    else {
        return respond(&mut stream, 404, "text/plain", b"not found").await;
    };
    let authorized = request
        .header("authorization")
        .and_then(|header| {
            header
                .strip_prefix("Bearer ")
                .or_else(|| header.strip_prefix("bearer "))
        })
        .map(str::trim)
        .and_then(|token| gateway.tokens.resolve(token));
    if authorized.as_deref() != Some(server_id) {
        return respond(&mut stream, 401, "text/plain", b"unauthorized").await;
    }

    let Ok(payload) = serde_json::from_slice::<Value>(&request.body) else {
        return respond_json(
            &mut stream,
            &json!({
                "jsonrpc": "2.0", "id": null,
                "error": { "code": -32700, "message": "parse error" }
            }),
        )
        .await;
    };
    let reply = match payload {
        Value::Array(items) => {
            let mut replies = Vec::new();
            for item in items {
                if let Some(reply) = handle_rpc(&gateway, server_id, item).await {
                    replies.push(reply);
                }
            }
            if replies.is_empty() {
                return respond(&mut stream, 202, "text/plain", b"").await;
            }
            Value::Array(replies)
        }
        item => match handle_rpc(&gateway, server_id, item).await {
            Some(reply) => reply,
            None => return respond(&mut stream, 202, "text/plain", b"").await,
        },
    };
    respond_json(&mut stream, &reply).await
}

async fn handle_rpc(gateway: &Arc<McpGateway>, server_id: &str, request: Value) -> Option<Value> {
    let id = request.get("id").cloned();
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if method == "notifications/initialized" || method.starts_with("notifications/") {
        return None;
    }
    let id = id.filter(|id| !id.is_null())?;
    match method.as_str() {
        "initialize" => match gateway.ensure_initialized(server_id).await {
            Ok((_, result)) => Some(json!({ "jsonrpc": "2.0", "id": id, "result": result })),
            Err(error) => Some(rpc_error(id, error)),
        },
        "ping" => Some(json!({ "jsonrpc": "2.0", "id": id, "result": {} })),
        _ => {
            let policy = gateway.connector.policy(server_id);
            if method == "tools/call" {
                let tool = request
                    .get("params")
                    .and_then(|params| params.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if !crate::mcp::security::tool_allowed(
                    &tool,
                    &policy.allow_tools,
                    &policy.deny_tools,
                ) {
                    return Some(rpc_error_code(
                        id,
                        -32602,
                        format!("MCP tool `{tool}` is blocked by this server's policy"),
                    ));
                }
            }
            let client = match gateway.client(server_id).await {
                Ok(client) => client,
                Err(error) => return Some(rpc_error(id, error)),
            };
            let started = Instant::now();
            // The upstream sequence must be initialized before tools.
            if method != "initialize" {
                if let Err(error) = gateway.ensure_initialized(server_id).await {
                    return Some(rpc_error(id, error));
                }
            }
            match client.request(request).await {
                Ok(mut reply) => {
                    gateway.record_call(server_id, started, false).await;
                    if method == "tools/list" {
                        crate::mcp::security::filter_tool_list(
                            &mut reply,
                            &policy.allow_tools,
                            &policy.deny_tools,
                        );
                    }
                    if method == "tools/call" {
                        crate::mcp::security::mark_untrusted(&mut reply);
                    }
                    Some(reply)
                }
                Err(error) => {
                    gateway.record_call(server_id, started, true).await;
                    gateway.drop_client(server_id).await;
                    Some(rpc_error(id, error))
                }
            }
        }
    }
}

fn rpc_error(id: Value, message: impl Into<String>) -> Value {
    rpc_error_code(id, -32603, message)
}

fn rpc_error_code(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message.into() }
    })
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|e| format!("secure randomness unavailable for MCP gateway token: {e}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct EchoTransport {
        initialized: Mutex<u32>,
        epoch: std::sync::atomic::AtomicU64,
    }

    impl EchoTransport {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                initialized: Mutex::new(0),
                epoch: std::sync::atomic::AtomicU64::new(0),
            })
        }

        fn bump_epoch(&self) {
            self.epoch
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }

    impl McpTransport for EchoTransport {
        fn session_epoch(&self) -> u64 {
            self.epoch.load(std::sync::atomic::Ordering::Relaxed)
        }
        fn request<'a>(&'a self, request: Value) -> TransportFuture<'a, Value> {
            Box::pin(async move {
                let method = request["method"].as_str().unwrap_or("");
                let id = request["id"].clone();
                if method == "initialize" {
                    *self.initialized.lock().unwrap() += 1;
                    return Ok(json!({
                        "jsonrpc": "2.0", "id": id,
                        "result": {
                            "protocolVersion": "2025-06-18",
                            "capabilities": { "tools": {} },
                            "serverInfo": { "name": "echo", "version": "1" }
                        }
                    }));
                }
                if method == "tools/list" {
                    return Ok(json!({
                        "jsonrpc": "2.0", "id": id,
                        "result": { "tools": [
                            { "name": "ok", "inputSchema": { "type": "object" } },
                            { "name": "danger", "inputSchema": { "type": "object" } }
                        ]}
                    }));
                }
                Ok(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "ok": true, "method": method }
                }))
            })
        }

        fn notify<'a>(&'a self, _notification: Value) -> TransportFuture<'a, ()> {
            Box::pin(async { Ok(()) })
        }

        fn close(&self) -> TransportFuture<'_, ()> {
            Box::pin(async { Ok(()) })
        }
    }

    struct EchoConnector {
        transport: Arc<EchoTransport>,
        policy: GatewayPolicy,
    }

    impl GatewayConnector for EchoConnector {
        fn connect<'a>(
            &'a self,
            _server_id: &'a str,
        ) -> TransportFuture<'a, Arc<dyn McpTransport>> {
            let transport = Arc::clone(&self.transport) as Arc<dyn McpTransport>;
            Box::pin(async move { Ok(transport) })
        }

        fn policy(&self, _server_id: &str) -> GatewayPolicy {
            self.policy.clone()
        }
    }

    async fn post(url: &str, token: &str, body: Value) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let parsed = reqwest::Url::parse(url).unwrap();
        let host = parsed.host_str().unwrap();
        let port = parsed.port().unwrap();
        let path = parsed.path();
        let mut stream = TcpStream::connect((host, port)).await.unwrap();
        let body = body.to_string();
        let head = format!(
            "POST {path} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(head.as_bytes()).await.unwrap();
        stream.write_all(body.as_bytes()).await.unwrap();
        let mut response = String::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            stream.read_to_string(&mut response),
        )
        .await
        .expect("gateway reply timeout")
        .unwrap();
        response
    }

    #[tokio::test]
    async fn proxies_initialize_once_and_requires_a_matching_token() {
        let transport = EchoTransport::new();
        let gateway = McpGateway::start(
            Arc::new(EchoConnector {
                transport: Arc::clone(&transport),
                policy: GatewayPolicy {
                    allow_tools: Vec::new(),
                    deny_tools: vec!["danger".to_string()],
                },
            }),
            Arc::new(GatewayTokens::new()),
        )
        .await
        .unwrap();
        let endpoint = gateway.endpoint("mcp-1").unwrap();

        let init = post(
            &endpoint.url,
            &endpoint.token,
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }),
        )
        .await;
        assert!(init.contains("\"name\":\"echo\""), "{init}");
        let second = post(
            &endpoint.url,
            &endpoint.token,
            json!({ "jsonrpc": "2.0", "id": 2, "method": "initialize", "params": {} }),
        )
        .await;
        assert!(second.contains("\"name\":\"echo\""), "{second}");
        assert_eq!(*transport.initialized.lock().unwrap(), 1);

        // A reconnect bumps the upstream epoch: the next call must re-run the
        // handshake instead of using the cached initialize result.
        transport.bump_epoch();
        let after_reconnect = post(
            &endpoint.url,
            &endpoint.token,
            json!({ "jsonrpc": "2.0", "id": 30, "method": "tools/list" }),
        )
        .await;
        assert!(
            after_reconnect.contains("\"name\":\"ok\""),
            "{after_reconnect}"
        );
        assert_eq!(*transport.initialized.lock().unwrap(), 2);

        let tools = post(
            &endpoint.url,
            &endpoint.token,
            json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" }),
        )
        .await;
        assert!(tools.contains("\"name\":\"ok\""), "{tools}");
        assert!(!tools.contains("\"name\":\"danger\""), "{tools}");

        let blocked = post(
            &endpoint.url,
            &endpoint.token,
            json!({
                "jsonrpc": "2.0", "id": 4, "method": "tools/call",
                "params": { "name": "danger", "arguments": {} }
            }),
        )
        .await;
        assert!(blocked.contains("-32602"), "{blocked}");
        assert!(!blocked.contains("\"result\""), "{blocked}");

        let allowed = post(
            &endpoint.url,
            &endpoint.token,
            json!({
                "jsonrpc": "2.0", "id": 5, "method": "tools/call",
                "params": { "name": "ok", "arguments": {} }
            }),
        )
        .await;
        assert!(allowed.contains("pult/untrusted"), "{allowed}");

        let unauthorized = post(
            &endpoint.url,
            "nope",
            json!({ "jsonrpc": "2.0", "id": 6, "method": "tools/list" }),
        )
        .await;
        assert!(unauthorized.starts_with("HTTP/1.1 401"), "{unauthorized}");
    }
}
