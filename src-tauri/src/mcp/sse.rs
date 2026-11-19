//! Legacy MCP SSE transport: one long-lived `GET` event stream carries
//! `event: endpoint` and JSON-RPC replies, while requests are `POST`ed to the
//! advertised endpoint. Reconnects with exponential backoff.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use serde_json::Value;
use tokio::sync::{oneshot, Mutex as AsyncMutex};
use tokio::task::AbortHandle;

use super::transport::{await_reply, McpTransport, PendingRequests, SseDecoder, TransportFuture};

/// Bound on the SSE handshake only. The stream itself stays open for as long
/// as the server keeps sending: a client-wide timeout would kill it.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);

pub struct SseConfig {
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub pinned: Vec<SocketAddr>,
    pub allow_localhost: bool,
    pub timeout: Duration,
    pub label: String,
}

pub struct SseTransport {
    client: reqwest::Client,
    headers: BTreeMap<String, String>,
    endpoint: Arc<AsyncMutex<Option<String>>>,
    pending: Arc<PendingRequests>,
    closed: Arc<AtomicBool>,
    epoch: Arc<AtomicU64>,
    task: AbortHandle,
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
            .no_proxy();
        let client = if config.pinned.is_empty() {
            client
        } else {
            let host = reqwest::Url::parse(&config.url)
                .ok()
                .and_then(|url| url.host_str().map(str::to_string))
                .ok_or_else(|| "MCP URL has no host to pin".to_string())?;
            client.resolve_to_addrs(&host, &config.pinned)
        };
        let client = client
            .build()
            .map_err(|e| format!("create SSE MCP client: {e}"))?;
        let pending = Arc::new(PendingRequests::new());
        let endpoint = Arc::new(AsyncMutex::new(None));
        let closed = Arc::new(AtomicBool::new(false));
        let epoch = Arc::new(AtomicU64::new(0));
        let (ready_tx, ready_rx) = oneshot::channel();
        let loop_client = client.clone();
        let loop_headers = config.headers.clone();
        let loop_url = config.url.clone();
        let loop_pending = Arc::clone(&pending);
        let loop_endpoint = Arc::clone(&endpoint);
        let loop_closed = Arc::clone(&closed);
        let loop_epoch = Arc::clone(&epoch);
        let allow_localhost = config.allow_localhost;
        let task = tokio::spawn(async move {
            stream_loop(
                loop_client,
                loop_url,
                loop_headers,
                loop_pending,
                loop_endpoint,
                loop_closed,
                loop_epoch,
                allow_localhost,
                HANDSHAKE_TIMEOUT,
                Some(ready_tx),
            )
            .await;
        })
        .abort_handle();
        match tokio::time::timeout(config.timeout, ready_rx).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(error))) => {
                closed.store(true, Ordering::Relaxed);
                task.abort();
                return Err(error);
            }
            Ok(Err(_)) => {
                closed.store(true, Ordering::Relaxed);
                task.abort();
                return Err("SSE stream closed before the endpoint arrived".to_string());
            }
            Err(_) => {
                closed.store(true, Ordering::Relaxed);
                task.abort();
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
            epoch,
            task,
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
            self.task.abort();
            self.pending.fail_all("MCP SSE transport stopped");
            Ok(())
        })
    }

    fn session_epoch(&self) -> u64 {
        self.epoch.load(Ordering::Relaxed)
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
    epoch: Arc<AtomicU64>,
    allow_localhost: bool,
    handshake_timeout: Duration,
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
        // Only the handshake is bounded: once headers arrive the stream is an
        // unbounded `bytes_stream` and must keep running.
        let opened = tokio::time::timeout(handshake_timeout, builder.send()).await;
        match opened {
            Ok(Ok(response)) if response.status().is_success() => {
                backoff_seconds = 1;
                let mut stream = response.bytes_stream();
                let mut decoder = SseDecoder::default();
                while let Some(chunk) = stream.next().await {
                    let Ok(bytes) = chunk else { break };
                    for event in decoder.push(&bytes) {
                        if event.event.as_deref() == Some("endpoint") {
                            let Some(resolved) = resolve_endpoint(&url, event.data.trim()) else {
                                continue;
                            };
                            if !same_origin(&url, &resolved) {
                                tracing::warn!(target: "pult::mcp",
                                    endpoint = %resolved,
                                    "SSE endpoint rejected: different origin");
                                continue;
                            }
                            if let Err(error) =
                                super::security::validate_url(&resolved, allow_localhost).await
                            {
                                tracing::warn!(target: "pult::mcp", error = %error,
                                    endpoint = %resolved, "SSE endpoint rejected by SSRF rules");
                                continue;
                            }
                            *endpoint.lock().await = Some(resolved);
                            epoch.fetch_add(1, Ordering::Relaxed);
                            announced = true;
                            if let Some(sender) = ready.take() {
                                let _ = sender.send(Ok(()));
                            }
                        } else if let Ok(value) = serde_json::from_str::<Value>(&event.data) {
                            pending.complete(value);
                        }
                    }
                }
                pending.fail_all("MCP SSE stream closed");
            }
            Ok(Ok(response)) => {
                let status = response.status().as_u16();
                if let Some(sender) = ready.take() {
                    let _ = sender.send(Err(format!("MCP SSE server returned HTTP {status}")));
                } else {
                    tracing::warn!(target: "pult::mcp", status, "SSE reconnect rejected");
                }
            }
            Ok(Err(error)) => {
                if let Some(sender) = ready.take() {
                    let _ = sender.send(Err(format!("MCP SSE connection failed: {error}")));
                } else {
                    tracing::warn!(target: "pult::mcp", error = %error, "SSE stream dropped");
                }
            }
            Err(_) => {
                // A server that accepts the socket but never sends headers must
                // not hold connect() forever; an announced stream is untouched.
                if let Some(sender) = ready.take() {
                    let _ = sender.send(Err(format!(
                        "MCP SSE handshake timed out after {} ms",
                        handshake_timeout.as_millis()
                    )));
                } else {
                    tracing::warn!(target: "pult::mcp", "SSE stream handshake timed out");
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

/// A legacy SSE endpoint must stay on the origin that served the stream;
/// otherwise a hostile server could point POSTs (and secret headers) elsewhere.
fn same_origin(base: &str, endpoint: &str) -> bool {
    let (Ok(base), Ok(endpoint)) = (reqwest::Url::parse(base), reqwest::Url::parse(endpoint))
    else {
        return false;
    };
    base.scheme() == endpoint.scheme()
        && base.host_str() == endpoint.host_str()
        && base.port_or_known_default() == endpoint.port_or_known_default()
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
            pinned: Vec::new(),
            allow_localhost: true,
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
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            transport.task.is_finished(),
            "close must abort the SSE task"
        );
    }

    #[tokio::test]
    async fn handshake_timeout_fails_connect_instead_of_hanging() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!(
            "http://127.0.0.1:{}/sse",
            listener.local_addr().unwrap().port()
        );
        // Accept the socket, never answer: the handshake has to time out.
        let hold = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(10)).await;
            drop(stream);
        });
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .unwrap();
        let (ready_tx, ready_rx) = oneshot::channel();
        let task = tokio::spawn(stream_loop(
            client,
            url,
            BTreeMap::new(),
            Arc::new(PendingRequests::new()),
            Arc::new(AsyncMutex::new(None)),
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicU64::new(0)),
            true,
            Duration::from_millis(100),
            Some(ready_tx),
        ));
        let result = tokio::time::timeout(Duration::from_secs(5), ready_rx)
            .await
            .expect("handshake timeout must notify the ready sender")
            .expect("ready sender must outlive the failed handshake");
        assert!(
            result.unwrap_err().contains("handshake timed out"),
            "a hanging server must fail the handshake"
        );
        task.await.unwrap();
        hold.abort();
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

    #[test]
    fn rejects_cross_origin_endpoints() {
        assert!(same_origin("https://host/sse", "https://host/messages"));
        assert!(!same_origin("https://host/sse", "https://other/messages"));
        assert!(!same_origin("https://host/sse", "http://host/messages"));
        assert!(!same_origin(
            "https://host/sse",
            "http://127.0.0.1/messages"
        ));
        assert!(!same_origin("https://host/sse", "http://169.254.169.254/"));
    }
}
