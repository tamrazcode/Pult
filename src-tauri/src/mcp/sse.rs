//! Legacy MCP SSE transport: one long-lived `GET` event stream carries
//! `event: endpoint` and JSON-RPC replies, while requests are `POST`ed to the
//! advertised endpoint. Reconnects with exponential backoff.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use serde_json::Value;
use tokio::sync::{oneshot, Mutex as AsyncMutex};

use super::transport::{await_reply, McpTransport, PendingRequests, SseDecoder, TransportFuture};

pub struct SseConfig {
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub timeout: Duration,
    pub label: String,
}

pub struct SseTransport {
    client: reqwest::Client,
    headers: BTreeMap<String, String>,
    endpoint: Arc<AsyncMutex<Option<String>>>,
    pending: Arc<PendingRequests>,
    closed: Arc<AtomicBool>,
    timeout: Duration,
}

impl SseTransport {
    pub async fn connect(config: SseConfig) -> Result<Arc<Self>, String> {
        static INSTALL: std::sync::Once = std::sync::Once::new();
        INSTALL.call_once(|| {
            let _ = rustls::crypto::ring::default_provider().install_default();
        });
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("create SSE MCP client: {e}"))?;
        let pending = Arc::new(PendingRequests::new());
        let endpoint = Arc::new(AsyncMutex::new(None));
        let closed = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = oneshot::channel();
        let loop_client = client.clone();
        let loop_headers = config.headers.clone();
        let loop_url = config.url.clone();
        let loop_pending = Arc::clone(&pending);
        let loop_endpoint = Arc::clone(&endpoint);
        let loop_closed = Arc::clone(&closed);
        tokio::spawn(async move {
            stream_loop(
                loop_client,
                loop_url,
                loop_headers,
                loop_pending,
                loop_endpoint,
                loop_closed,
                Some(ready_tx),
            )
            .await;
        });
        match tokio::time::timeout(config.timeout, ready_rx).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(error))) => return Err(error),
            Ok(Err(_)) => return Err("SSE stream closed before the endpoint arrived".to_string()),
            Err(_) => {
                closed.store(true, Ordering::Relaxed);
                return Err(format!(
                    "SSE MCP server did not announce an endpoint within {} ms",
                    config.timeout.as_millis()
                ));
            }
        }
        Ok(Arc::new(Self {
            client,
            headers: config.headers,
            endpoint,
            pending,
            closed,
            timeout: config.timeout.max(Duration::from_millis(1)),
        }))
    }

    async fn post(&self, request: &Value) -> Result<(), String> {
        let endpoint = self
            .endpoint
            .lock()
            .await
            .clone()
            .ok_or_else(|| "MCP SSE transport is not connected".to_string())?;
        let mut builder = self
            .client
            .post(endpoint)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .timeout(self.timeout)
            .json(request);
        for (name, value) in &self.headers {
            builder = builder.header(name, value);
        }
        let response = builder
            .send()
            .await
            .map_err(|e| format!("MCP SSE POST failed: {e}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("MCP SSE POST returned HTTP {}", status.as_u16()));
        }
        Ok(())
    }
}

impl McpTransport for SseTransport {
    fn request<'a>(&'a self, mut request: Value) -> TransportFuture<'a, Value> {
        Box::pin(async move {
            let (id, receiver) = self.pending.prepare(&mut request)?;
            if let Err(error) = self.post(&request).await {
                self.pending.cancel(id);
                return Err(error);
            }
            await_reply(&self.pending, id, receiver, self.timeout).await
        })
    }

    fn notify<'a>(&'a self, notification: Value) -> TransportFuture<'a, ()> {
        Box::pin(async move { self.post(&notification).await })
    }

    fn close(&self) -> TransportFuture<'_, ()> {
        Box::pin(async move {
            self.closed.store(true, Ordering::Relaxed);
            self.pending.fail_all("MCP SSE transport stopped");
            Ok(())
        })
    }
}

#[allow(clippy::too_many_arguments)]
async fn stream_loop(
    client: reqwest::Client,
    url: String,
    headers: BTreeMap<String, String>,
    pending: Arc<PendingRequests>,
    endpoint: Arc<AsyncMutex<Option<String>>>,
    closed: Arc<AtomicBool>,
    mut ready: Option<oneshot::Sender<Result<(), String>>>,
) {
    let mut backoff_seconds = 1u64;
    let mut announced = false;
    while !closed.load(Ordering::Relaxed) {
        let mut builder = client
            .get(&url)
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .header(reqwest::header::CACHE_CONTROL, "no-store");
        for (name, value) in &headers {
            builder = builder.header(name, value);
        }
        let opened = builder.send().await;
        match opened {
            Ok(response) if response.status().is_success() => {
                backoff_seconds = 1;
                let mut stream = response.bytes_stream();
                let mut decoder = SseDecoder::default();
                while let Some(chunk) = stream.next().await {
                    let Ok(bytes) = chunk else { break };
                    for event in decoder.push(&bytes) {
                        if event.event.as_deref() == Some("endpoint") {
                            if let Some(resolved) = resolve_endpoint(&url, event.data.trim()) {
                                *endpoint.lock().await = Some(resolved);
                                announced = true;
                                if let Some(sender) = ready.take() {
                                    let _ = sender.send(Ok(()));
                                }
                            }
                        } else if let Ok(value) = serde_json::from_str::<Value>(&event.data) {
                            pending.complete(value);
                        }
                    }
                }
                pending.fail_all("MCP SSE stream closed");
            }
            Ok(response) => {
                let status = response.status().as_u16();
                if let Some(sender) = ready.take() {
                    let _ = sender.send(Err(format!("MCP SSE server returned HTTP {status}")));
                } else {
                    tracing::warn!(target: "pult::mcp", status, "SSE reconnect rejected");
                }
            }
            Err(error) => {
                if let Some(sender) = ready.take() {
                    let _ = sender.send(Err(format!("MCP SSE connection failed: {error}")));
                } else {
                    tracing::warn!(target: "pult::mcp", error = %error, "SSE stream dropped");
                }
            }
        }
        if !announced && ready.is_none() {
            // First attempt failed and the caller was told; stop instead of
            // burning retries on a config that was never usable.
            return;
        }
        let delay = backoff_seconds.min(30);
        backoff_seconds = (backoff_seconds * 2).min(30);
        tokio::time::sleep(Duration::from_secs(delay)).await;
    }
}

/// Resolves a relative `endpoint` event against the SSE URL.
fn resolve_endpoint(base: &str, data: &str) -> Option<String> {
    if data.starts_with("http://") || data.starts_with("https://") {
        return Some(data.to_string());
    }
    let base = reqwest::Url::parse(base).ok()?;
    base.join(data).ok().map(|url| url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http1::read_request;
    use serde_json::json;
    use std::sync::Mutex;
    use tokio::io::{AsyncWriteExt, WriteHalf};
    use tokio::net::{TcpListener, TcpStream};

    #[tokio::test]
    async fn follows_the_endpoint_event_and_matches_replies_by_id() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let sse_url = format!("http://127.0.0.1:{port}/sse");
        let shared_for_server: Arc<Mutex<Option<WriteHalf<TcpStream>>>> =
            Arc::new(Mutex::new(None));
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = read_request(&mut stream, 1 << 20).await.unwrap().unwrap();
            assert_eq!(request.method, "GET");
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
            stream
                .write_all(b"event: endpoint\ndata: /messages?session=abc\n\n")
                .await
                .unwrap();
            stream.flush().await.unwrap();
            let (read_half, write_half) = tokio::io::split(stream);
            *shared_for_server.lock().unwrap() = Some(write_half);
            drop(read_half);

            let (mut post, _) = listener.accept().await.unwrap();
            let request = read_request(&mut post, 1 << 20).await.unwrap().unwrap();
            assert_eq!(request.method, "POST");
            assert!(request.path.starts_with("/messages?session=abc"));
            let body: Value = serde_json::from_slice(&request.body).unwrap();
            let id = body["id"].clone();
            post.write_all(
                b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
            let event = format!(
                "event: message\ndata: {{\"jsonrpc\":\"2.0\",\"id\":{},\"result\":{{\"ok\":true}}}}\n\n",
                id
            );
            let writer = shared_for_server.lock().unwrap().take();
            if let Some(mut writer) = writer {
                writer.write_all(event.as_bytes()).await.unwrap();
                writer.flush().await.unwrap();
            }
        });

        let transport = SseTransport::connect(SseConfig {
            url: sse_url,
            headers: BTreeMap::new(),
            timeout: Duration::from_secs(10),
            label: "mock".to_string(),
        })
        .await
        .unwrap();
        let reply = transport
            .request(json!({ "jsonrpc": "2.0", "id": "abc", "method": "tools/list" }))
            .await
            .unwrap();
        assert_eq!(reply["id"], "abc");
        assert_eq!(reply["result"]["ok"], true);
        transport.close().await.unwrap();
    }

    #[test]
    fn resolves_relative_and_absolute_endpoints() {
        assert_eq!(
            resolve_endpoint("https://host/sse", "/messages?x=1").as_deref(),
            Some("https://host/messages?x=1")
        );
        assert_eq!(
            resolve_endpoint("https://host/sse", "https://other/messages").as_deref(),
            Some("https://other/messages")
        );
    }
}
