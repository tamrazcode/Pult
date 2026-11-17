//! Streamable HTTP MCP transport: JSON or SSE responses, `Mcp-Session-Id`
//! continuity, and no redirect following (redirect policy is a security
//! decision made in `mcp::security`).

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;

use super::transport::{parse_sse_events, McpTransport, TransportFuture};

const MAX_ERROR_BODY: usize = 8 * 1024;

pub struct HttpConfig {
    pub url: String,
    /// Plain headers plus resolved secrets; never surfaced back to the UI.
    pub headers: BTreeMap<String, String>,
    pub timeout: Duration,
    pub label: String,
}

pub struct HttpTransport {
    client: reqwest::Client,
    url: String,
    headers: BTreeMap<String, String>,
    session: Mutex<Option<String>>,
    timeout: Duration,
}

impl HttpTransport {
    pub fn connect(config: HttpConfig) -> Result<Self, String> {
        // reqwest is built with `rustls-no-provider` (same as the updater);
        // install ring once before the first client exists.
        static INSTALL: std::sync::Once = std::sync::Once::new();
        INSTALL.call_once(|| {
            let _ = rustls::crypto::ring::default_provider().install_default();
        });
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("create HTTP MCP client: {e}"))?;
        Ok(Self {
            client,
            url: config.url,
            headers: config.headers,
            session: Mutex::new(None),
            timeout: config.timeout.max(Duration::from_millis(1)),
        })
    }

    fn builder(&self, request: &Value) -> reqwest::RequestBuilder {
        let mut builder = self
            .client
            .post(&self.url)
            .header(
                reqwest::header::ACCEPT,
                "application/json, text/event-stream",
            )
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .timeout(self.timeout)
            .json(request);
        for (name, value) in &self.headers {
            builder = builder.header(name, value);
        }
        if let Some(session) = self.session.lock().ok().and_then(|slot| slot.clone()) {
            builder = builder.header("Mcp-Session-Id", session);
        }
        builder
    }

    fn remember_session(&self, response: &reqwest::Response) {
        let Some(value) = response
            .headers()
            .get("mcp-session-id")
            .and_then(|value| value.to_str().ok())
        else {
            return;
        };
        if let Ok(mut slot) = self.session.lock() {
            *slot = Some(value.to_string());
        }
    }

    async fn send(&self, request: &Value) -> Result<reqwest::Response, String> {
        let response = self
            .builder(request)
            .send()
            .await
            .map_err(|e| format!("MCP HTTP request failed: {e}"))?;
        self.remember_session(&response);
        let status = response.status();
        if !status.is_success() {
            let body = response
                .bytes()
                .await
                .map(|bytes| {
                    String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_ERROR_BODY)]).to_string()
                })
                .unwrap_or_default();
            return Err(format!(
                "MCP HTTP {} from server{}",
                status.as_u16(),
                if body.trim().is_empty() {
                    String::new()
                } else {
                    format!(": {}", super::security::redact(body.trim()))
                }
            ));
        }
        Ok(response)
    }
}

impl McpTransport for HttpTransport {
    fn request<'a>(&'a self, request: Value) -> TransportFuture<'a, Value> {
        Box::pin(async move {
            let id = request.get("id").cloned();
            let response = self.send(&request).await?;
            let is_sse = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(|value| value.contains("text/event-stream"))
                .unwrap_or(false);
            let body = tokio::time::timeout(self.timeout, response.bytes())
                .await
                .map_err(|_| {
                    format!(
                        "MCP response timed out after {} ms",
                        self.timeout.as_millis()
                    )
                })?
                .map_err(|e| format!("read MCP response: {e}"))?;
            if body.len() > super::security::MAX_MESSAGE_BYTES {
                return Err(format!(
                    "MCP response exceeds {} bytes",
                    super::security::MAX_MESSAGE_BYTES
                ));
            }
            let body = String::from_utf8_lossy(&body).into_owned();
            if is_sse {
                for event in parse_sse_events(&body) {
                    let Ok(value) = serde_json::from_str::<Value>(&event.data) else {
                        continue;
                    };
                    if id.as_ref().is_none_or(|id| value.get("id") == Some(id)) {
                        return Ok(value);
                    }
                }
                return Err("MCP server ended the stream without a response".to_string());
            }
            serde_json::from_str(&body).map_err(|e| format!("decode MCP response: {e}"))
        })
    }

    fn notify<'a>(&'a self, notification: Value) -> TransportFuture<'a, ()> {
        Box::pin(async move {
            self.send(&notification).await?;
            Ok(())
        })
    }

    fn close(&self) -> TransportFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http1::read_request;
    use serde_json::json;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    async fn write_response(
        stream: &mut tokio::net::TcpStream,
        content_type: &str,
        session: Option<&str>,
        body: &str,
    ) {
        let session_header = session
            .map(|session| format!("Mcp-Session-Id: {session}\r\n"))
            .unwrap_or_default();
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\n{session_header}Content-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(head.as_bytes()).await.unwrap();
        stream.write_all(body.as_bytes()).await.unwrap();
    }

    async fn mock_server() -> String {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = read_request(&mut stream, 1 << 20).await.unwrap().unwrap();
            assert!(request.header("mcp-session-id").is_none());
            let body = json!({
                "jsonrpc": "2.0", "id": 1, "result": { "protocolVersion": "2025-06-18" }
            })
            .to_string();
            write_response(&mut stream, "application/json", Some("sess-1"), &body).await;

            let (mut stream, _) = listener.accept().await.unwrap();
            let request = read_request(&mut stream, 1 << 20).await.unwrap().unwrap();
            assert_eq!(request.header("mcp-session-id"), Some("sess-1"));
            let body =
                "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"ok\":true}}\n\n";
            write_response(&mut stream, "text/event-stream", None, body).await;
        });
        format!("http://127.0.0.1:{port}/mcp")
    }

    #[tokio::test]
    async fn keeps_the_upstream_session_and_reads_json_then_sse() {
        let url = mock_server().await;
        let transport = HttpTransport::connect(HttpConfig {
            url,
            headers: BTreeMap::new(),
            timeout: Duration::from_secs(10),
            label: "mock".to_string(),
        })
        .unwrap();
        let init = transport
            .request(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }))
            .await
            .unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
        let call = transport
            .request(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call" }))
            .await
            .unwrap();
        assert_eq!(call["result"]["ok"], true);
    }

    #[tokio::test]
    async fn http_errors_surface_the_status() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let _ = read_request(&mut stream, 1 << 20).await;
            stream
                .write_all(
                    b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnope",
                )
                .await
                .unwrap();
        });
        let transport = HttpTransport::connect(HttpConfig {
            url: format!("http://127.0.0.1:{port}/mcp"),
            headers: BTreeMap::new(),
            timeout: Duration::from_secs(5),
            label: "mock".to_string(),
        })
        .unwrap();
        let error = transport
            .request(json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }))
            .await
            .unwrap_err();
        assert!(error.contains("401"), "{error}");
    }
}
