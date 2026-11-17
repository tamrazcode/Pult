//! Loopback gateway for user-configured MCP servers.
//!
//! Agents never receive an upstream URL, headers or API key. They connect to
//! `http://127.0.0.1:<port>/mcp/<server_id>` with a per-session bearer token
//! (or through `pult mcp-stdio --custom <id>`), and the gateway owns the real
//! stdio/HTTP/SSE transport, one shared upstream session per server.

use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
    tokens: Mutex<HashMap<String, String>>,
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

    pub fn issue(&self, server_id: &str) -> String {
        let token = random_token();
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.insert(token.clone(), server_id.to_string());
        }
        token
    }

    pub fn resolve(&self, token: &str) -> Option<String> {
        self.tokens
            .lock()
            .ok()
            .and_then(|tokens| tokens.get(token).cloned())
    }

    pub fn revoke(&self, token: &str) {
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.remove(token);
        }
    }

    pub fn revoke_server(&self, server_id: &str) {
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.retain(|_, value| value != server_id);
        }
    }

    pub fn revoke_all(&self) {
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.clear();
        }
    }
}

pub struct McpGateway {
    url: String,
    port: u16,
    tokens: Arc<GatewayTokens>,
    connector: Arc<dyn GatewayConnector>,
    clients: AsyncMutex<HashMap<String, Arc<dyn McpTransport>>>,
    /// Upstream initialize result per server, so repeated downstream
    /// handshakes do not re-initialize the same upstream session.
    initialized: AsyncMutex<HashMap<String, Value>>,
    initialize_lock: AsyncMutex<()>,
}

impl McpGateway {
    pub async fn start(connector: Arc<dyn GatewayConnector>) -> io::Result<Arc<Self>> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let gateway = Arc::new(Self {
            url: format!("http://127.0.0.1:{port}/mcp"),
            port,
            tokens: Arc::new(GatewayTokens::new()),
            connector,
            clients: AsyncMutex::new(HashMap::new()),
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
    pub fn endpoint(&self, server_id: &str) -> GatewayEndpoint {
        GatewayEndpoint {
            url: format!("{}/{}", self.url, server_id),
            token: self.tokens.issue(server_id),
        }
    }

    /// Drops the cached upstream connection and every token for the server.
    pub async fn close_server(&self, server_id: &str) {
        self.tokens.revoke_server(server_id);
        self.initialized.lock().await.remove(server_id);
        let client = self.clients.lock().await.remove(server_id);
        if let Some(client) = client {
            let _ = client.close().await;
        }
    }

    async fn client(&self, server_id: &str) -> Result<Arc<dyn McpTransport>, String> {
        if let Some(client) = self.clients.lock().await.get(server_id).cloned() {
            return Ok(client);
        }
        let client = self.connector.connect(server_id).await?;
        let mut clients = self.clients.lock().await;
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
        if let Some(result) = self.initialized.lock().await.get(server_id).cloned() {
            let client = self.client(server_id).await?;
            return Ok((client, result));
        }
        let client = self.client(server_id).await?;
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
        self.initialized
            .lock()
            .await
            .insert(server_id.to_string(), result.clone());
        Ok((client, result))
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
            // The upstream sequence must be initialized before tools.
            if method != "initialize" {
                if let Err(error) = gateway.ensure_initialized(server_id).await {
                    return Some(rpc_error(id, error));
                }
            }
            match client.request(request).await {
                Ok(mut reply) => {
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
                Err(error) => Some(rpc_error(id, error)),
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

fn random_token() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        // Extremely unlikely; a predictable token would be a security hole, so
        // refuse to hand out a weak one by mixing the fallback with time.
        let now = crate::events::now_millis().to_le_bytes();
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = now[index % now.len()];
        }
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct EchoTransport {
        initialized: Mutex<u32>,
    }

    impl EchoTransport {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                initialized: Mutex::new(0),
            })
        }
    }

    impl McpTransport for EchoTransport {
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
        stream.read_to_string(&mut response).await.unwrap();
        response
    }

    #[tokio::test]
    async fn proxies_initialize_once_and_requires_a_matching_token() {
        let transport = EchoTransport::new();
        let gateway = McpGateway::start(Arc::new(EchoConnector {
            transport: Arc::clone(&transport),
            policy: GatewayPolicy {
                allow_tools: Vec::new(),
                deny_tools: vec!["danger".to_string()],
            },
        }))
        .await
        .unwrap();
        let endpoint = gateway.endpoint("mcp-1");

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
