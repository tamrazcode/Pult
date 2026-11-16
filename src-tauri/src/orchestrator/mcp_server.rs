//! Loopback Streamable-HTTP endpoint for the orchestration tools.
//!
//! Only `POST /mcp` is served. Every request needs a bearer token issued for a
//! live ACP session, so a token that outlived its session is useless even if a
//! stale agent process still holds it.

use std::io;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::orchestrator::{
    is_read_only_tool, tool_specs, McpScope, McpTokenRegistry, OrchestratorHost,
    ORCHESTRATOR_TOOL_NAMES,
};

pub const ORCHESTRATOR_SERVER_NAME: &str = "pult_orchestrator";
const MAX_BODY: usize = 1024 * 1024;
const MAX_HEADERS: usize = 16 * 1024;
/// Reading a request must be prompt; tool execution may legitimately wait
/// (`wait_tasks` up to 240 s), so it is never wrapped in this timeout.
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// Bound loopback server. Dropping it stops nothing by itself; the accept loop
/// lives for the process, like the app-owned orchestrator it serves.
pub struct OrchestratorMcpServer {
    url: String,
    port: u16,
}

impl OrchestratorMcpServer {
    pub async fn start(
        host: Arc<dyn OrchestratorHost>,
        registry: Arc<McpTokenRegistry>,
    ) -> io::Result<Arc<Self>> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let server = Arc::new(Self {
            url: format!("http://127.0.0.1:{port}/mcp"),
            port,
        });
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let host = Arc::clone(&host);
                let registry = Arc::clone(&registry);
                tokio::spawn(async move {
                    let _ = serve(stream, host, registry).await;
                });
            }
        });
        Ok(server)
    }

    /// Full MCP endpoint URL (`http://127.0.0.1:<port>/mcp`).
    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

async fn serve(
    mut stream: TcpStream,
    host: Arc<dyn OrchestratorHost>,
    registry: Arc<McpTokenRegistry>,
) -> io::Result<()> {
    let request = match tokio::time::timeout(READ_TIMEOUT, read_request(&mut stream)).await {
        Ok(Ok(Some(request))) => request,
        Ok(Ok(None)) => return Ok(()),
        Ok(Err(Failure::TooLarge)) => {
            return respond(&mut stream, 413, "text/plain", b"request too large").await
        }
        Ok(Err(Failure::Io(error))) => return Err(error),
        Err(_) => return respond(&mut stream, 408, "text/plain", b"request timed out").await,
    };

    if request.method != "POST" {
        return respond(&mut stream, 405, "text/plain", b"method not allowed").await;
    }
    if request.path != "/mcp" {
        return respond(&mut stream, 404, "text/plain", b"not found").await;
    }
    let Some(scope) = authorized(&request, &registry) else {
        return respond(&mut stream, 401, "text/plain", b"unauthorized").await;
    };

    let body = String::from_utf8_lossy(&request.body);
    let Ok(payload) = serde_json::from_str::<Value>(&body) else {
        let reply = rpc_error(Value::Null, -32700, "parse error");
        return respond_json(&mut stream, &reply).await;
    };

    let reply = match payload {
        Value::Array(requests) => {
            let mut responses = Vec::new();
            for item in requests {
                if let Some(response) = handle_rpc(&host, &scope, item).await {
                    responses.push(response);
                }
            }
            if responses.is_empty() {
                return respond(&mut stream, 202, "text/plain", b"").await;
            }
            Value::Array(responses)
        }
        item => match handle_rpc(&host, &scope, item).await {
            Some(response) => response,
            None => return respond(&mut stream, 202, "text/plain", b"").await,
        },
    };
    respond_json(&mut stream, &reply).await
}

struct HttpRequest {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

enum Failure {
    Io(io::Error),
    TooLarge,
}

impl From<io::Error> for Failure {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

async fn read_request(stream: &mut TcpStream) -> Result<Option<HttpRequest>, Failure> {
    let mut buffer = Vec::with_capacity(4096);
    let header_end = loop {
        if let Some(index) = find_bytes(&buffer, b"\r\n\r\n") {
            break index;
        }
        if buffer.len() > MAX_HEADERS {
            return Err(Failure::TooLarge);
        }
        let mut chunk = [0u8; 2048];
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Ok(None);
        }
        buffer.extend_from_slice(&chunk[..read]);
    };

    let head = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next().unwrap_or_default().split_whitespace();
    let method = request_line.next().unwrap_or_default().to_string();
    let path = request_line.next().unwrap_or_default().to_string();
    let mut headers = Vec::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_string(), value.trim().to_string()));
        }
    }

    let content_length = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > MAX_BODY {
        return Err(Failure::TooLarge);
    }

    let mut body = buffer[(header_end + 4)..].to_vec();
    while body.len() < content_length {
        let mut chunk = [0u8; 8192];
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(content_length);

    Ok(Some(HttpRequest {
        method,
        path,
        headers,
        body,
    }))
}

fn authorized(request: &HttpRequest, registry: &McpTokenRegistry) -> Option<McpScope> {
    let header = request
        .headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
        .map(|(_, value)| value.as_str())?;
    let token = header
        .strip_prefix("Bearer ")
        .or_else(|| header.strip_prefix("bearer "))
        .or_else(|| header.strip_prefix("BEARER "))?
        .trim();
    registry.resolve(token)
}

async fn handle_rpc(
    host: &Arc<dyn OrchestratorHost>,
    scope: &McpScope,
    request: Value,
) -> Option<Value> {
    // Notifications (`notifications/initialized`) never get a reply.
    let id = request.get("id").cloned()?;
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();

    let result = match method {
        "initialize" => {
            let requested = request
                .get("params")
                .and_then(|params| params.get("protocolVersion"))
                .and_then(Value::as_str)
                .unwrap_or("2025-06-18");
            Ok(json!({
                "protocolVersion": requested,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": {
                    "name": ORCHESTRATOR_SERVER_NAME,
                    "version": env!("CARGO_PKG_VERSION")
                }
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_specs() })),
        "tools/call" => return Some(call_tool(host, scope, id, &request).await),
        other => Err((-32601, format!("method not found: {other}"))),
    };

    Some(match result {
        Ok(value) => json!({ "jsonrpc": "2.0", "id": id, "result": value }),
        Err((code, message)) => rpc_error(id, code, &message),
    })
}

async fn call_tool(
    host: &Arc<dyn OrchestratorHost>,
    scope: &McpScope,
    id: Value,
    request: &Value,
) -> Value {
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !ORCHESTRATOR_TOOL_NAMES.contains(&name) {
        return rpc_error(id, -32602, &format!("unknown tool: {name}"));
    }
    if !is_read_only_tool(name) && !scope.can_orchestrate {
        return rpc_error(id, -32003, "orchestration is not allowed for this thread");
    }
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !arguments.is_object() {
        return rpc_error(id, -32602, "tool arguments must be an object");
    }

    let run_id = host.active_run_id(&scope.thread_id);
    if !is_read_only_tool(name) && run_id.is_none() {
        return rpc_error(id, -32004, "no active run for this thread");
    }

    match host
        .call_tool(scope, run_id.as_deref(), name, &arguments)
        .await
    {
        Ok(value) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": tool_content(&value.to_string(), false)
        }),
        Err(message) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": tool_content(&message, true)
        }),
    }
}

fn tool_content(text: &str, is_error: bool) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error
    })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}

async fn respond_json(stream: &mut TcpStream, value: &Value) -> io::Result<()> {
    respond(
        stream,
        200,
        "application/json",
        value.to_string().as_bytes(),
    )
    .await
}

async fn respond(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> io::Result<()> {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.flush().await
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    struct FakeHost {
        active: Mutex<HashMap<String, String>>,
    }

    impl OrchestratorHost for FakeHost {
        fn active_run_id(&self, thread_id: &str) -> Option<String> {
            self.active.lock().unwrap().get(thread_id).cloned()
        }

        fn call_tool<'a>(
            &'a self,
            scope: &'a McpScope,
            run_id: Option<&'a str>,
            name: &'a str,
            arguments: &'a Value,
        ) -> crate::orchestrator::ToolFuture<'a> {
            Box::pin(async move {
                if arguments.get("fail").and_then(Value::as_bool) == Some(true) {
                    return Err("tool failed on purpose".to_string());
                }
                Ok(json!({
                    "tool": name,
                    "threadId": scope.thread_id,
                    "runId": run_id,
                }))
            })
        }
    }

    async fn fixture() -> (Arc<OrchestratorMcpServer>, String, String) {
        let host = Arc::new(FakeHost {
            active: Mutex::new(HashMap::from([("th-a".to_string(), "run-1".to_string())])),
        });
        let registry = Arc::new(McpTokenRegistry::new());
        let token = registry.issue(McpScope::new("owner-a", "th-a", 0));
        let idle = registry.issue(McpScope::new("owner-b", "th-b", 0));
        let server = OrchestratorMcpServer::start(host, registry).await.unwrap();
        (server, token, idle)
    }

    async fn send(
        server: &OrchestratorMcpServer,
        token: Option<&str>,
        method: &str,
        path: &str,
        body: &str,
    ) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", server.port()))
            .await
            .unwrap();
        let auth = token
            .map(|token| format!("Authorization: Bearer {token}\r\n"))
            .unwrap_or_default();
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: localhost\r\n{auth}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        String::from_utf8_lossy(&response).into_owned()
    }

    fn body_of(response: &str) -> Value {
        let (_, body) = response.split_once("\r\n\r\n").unwrap();
        serde_json::from_str(body).unwrap()
    }

    #[tokio::test]
    async fn rejects_missing_or_wrong_bearer_and_non_post() {
        let (server, token, _) = fixture().await;
        let initialize = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#;

        let missing = send(&server, None, "POST", "/mcp", initialize).await;
        assert!(missing.starts_with("HTTP/1.1 401"), "{missing}");
        assert!(missing.contains("Cache-Control: no-store"));

        let wrong = send(&server, Some("deadbeef"), "POST", "/mcp", initialize).await;
        assert!(wrong.starts_with("HTTP/1.1 401"), "{wrong}");

        let get = send(&server, Some(&token), "GET", "/mcp", "").await;
        assert!(get.starts_with("HTTP/1.1 405"), "{get}");

        let other_path = send(&server, Some(&token), "POST", "/other", initialize).await;
        assert!(other_path.starts_with("HTTP/1.1 404"), "{other_path}");
    }

    #[tokio::test]
    async fn initialize_and_tools_list_work_with_a_valid_token() {
        let (server, token, _) = fixture().await;
        let initialize = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#;

        let response = send(&server, Some(&token), "POST", "/mcp", initialize).await;
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        let body = body_of(&response);
        assert_eq!(
            body["result"]["serverInfo"]["name"],
            ORCHESTRATOR_SERVER_NAME
        );
        assert_eq!(
            body["result"]["capabilities"]["tools"]["listChanged"],
            false
        );

        let list = r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#;
        let response = send(&server, Some(&token), "POST", "/mcp", list).await;
        let body = body_of(&response);
        let names: Vec<&str> = body["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        for name in ORCHESTRATOR_TOOL_NAMES {
            assert!(names.contains(&name), "{name} missing from tools/list");
        }
    }

    #[tokio::test]
    async fn notifications_get_202_and_no_body() {
        let (server, token, _) = fixture().await;
        let notification = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        let response = send(&server, Some(&token), "POST", "/mcp", notification).await;
        assert!(response.starts_with("HTTP/1.1 202"), "{response}");
        assert!(response.ends_with("\r\n\r\n"), "{response:?}");
    }

    #[tokio::test]
    async fn write_tools_require_an_active_run_but_read_only_tools_do_not() {
        let (server, token, idle) = fixture().await;
        let delegate = r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"delegate_task","arguments":{"title":"t","task":"do it"}}}"#;
        let response = send(&server, Some(&token), "POST", "/mcp", delegate).await;
        let body = body_of(&response);
        assert_eq!(body["result"]["isError"], false);
        assert_eq!(
            serde_json::from_str::<Value>(body["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap()["runId"],
            "run-1"
        );

        let response = send(&server, Some(&idle), "POST", "/mcp", delegate).await;
        let body = body_of(&response);
        assert_eq!(body["error"]["code"], -32004);

        let capabilities = r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"orchestrator_capabilities","arguments":{}}}"#;
        let response = send(&server, Some(&idle), "POST", "/mcp", capabilities).await;
        let body = body_of(&response);
        assert_eq!(body["result"]["isError"], false);
    }

    #[tokio::test]
    async fn tool_failures_come_back_as_is_error_content() {
        let (server, token, _) = fixture().await;
        let call = r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"cancel_task","arguments":{"taskId":"x","fail":true}}}"#;
        let response = send(&server, Some(&token), "POST", "/mcp", call).await;
        let body = body_of(&response);
        assert_eq!(body["result"]["isError"], true);
        assert_eq!(
            body["result"]["content"][0]["text"],
            "tool failed on purpose"
        );
    }

    #[tokio::test]
    async fn oversized_declared_body_is_rejected_before_reading() {
        let (server, token, _) = fixture().await;
        let mut stream = TcpStream::connect(("127.0.0.1", server.port()))
            .await
            .unwrap();
        let request = format!(
            "POST /mcp HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\n\r\n",
            MAX_BODY + 1
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        let response = String::from_utf8_lossy(&response);
        assert!(response.starts_with("HTTP/1.1 413"), "{response}");
    }
}
