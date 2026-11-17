//! Shared plumbing for custom MCP transports: the async client trait, JSON-RPC
//! id correlation for line/stream protocols, and a bounded stderr ring.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::oneshot;

/// Boxed future used by the object-safe transport trait.
pub type TransportFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

/// One MCP server connection. `request` carries a JSON-RPC request (with `id`)
/// and resolves to the matching response; protocol errors stay in the response.
pub trait McpTransport: Send + Sync {
    fn request<'a>(&'a self, request: Value) -> TransportFuture<'a, Value>;
    fn notify<'a>(&'a self, notification: Value) -> TransportFuture<'a, ()>;
    fn close(&self) -> TransportFuture<'_, ()>;
    /// Last stderr lines (stdio servers); empty for HTTP/SSE.
    fn logs(&self) -> Vec<String> {
        Vec::new()
    }
}

/// Remembers the caller's JSON-RPC id while the upstream sees a unique one, so
/// concurrent sessions never collide and responses still reach their owner.
pub(crate) struct PendingRequests {
    next_id: AtomicI64,
    pending: Mutex<HashMap<i64, PendingEntry>>,
}

struct PendingEntry {
    original_id: Value,
    reply: oneshot::Sender<Value>,
}

impl PendingRequests {
    pub(crate) fn new() -> Self {
        Self {
            next_id: AtomicI64::new(1),
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// Rewrites `request.id` and returns the id plus the reply receiver.
    pub(crate) fn prepare(
        &self,
        request: &mut Value,
    ) -> Result<(i64, oneshot::Receiver<Value>), String> {
        let original_id = request
            .get("id")
            .cloned()
            .filter(|id| !id.is_null())
            .ok_or_else(|| "JSON-RPC request is missing an id".to_string())?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (reply, receiver) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| "pending request lock poisoned".to_string())?
            .insert(id, PendingEntry { original_id, reply });
        request["id"] = json!(id);
        Ok((id, receiver))
    }

    /// Routes an upstream response back to its caller and restores the id.
    pub(crate) fn complete(&self, mut response: Value) -> Option<i64> {
        let id = response.get("id")?.as_i64()?;
        let entry = self
            .pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&id))?;
        response["id"] = entry.original_id;
        let _ = entry.reply.send(response);
        Some(id)
    }

    pub(crate) fn cancel(&self, id: i64) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&id);
        }
    }

    pub(crate) fn fail_all(&self, message: &str) {
        let entries = self
            .pending
            .lock()
            .map(|mut pending| std::mem::take(&mut *pending))
            .unwrap_or_default();
        for (_, entry) in entries {
            let _ = entry.reply.send(json!({
                "jsonrpc": "2.0",
                "id": entry.original_id,
                "error": { "code": -32603, "message": message }
            }));
        }
    }
}

/// Waits for a pending reply with the configured timeout, cancelling the
/// correlation entry when the wait expires.
pub(crate) async fn await_reply(
    pending: &PendingRequests,
    id: i64,
    receiver: oneshot::Receiver<Value>,
    timeout: Duration,
) -> Result<Value, String> {
    match tokio::time::timeout(timeout, receiver).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) => Err("MCP server closed before replying".to_string()),
        Err(_) => {
            pending.cancel(id);
            Err(format!(
                "MCP request timed out after {} ms",
                timeout.as_millis()
            ))
        }
    }
}

/// Bounded stderr capture: newest lines win, total bytes stay under `limit`.
pub(crate) struct LogRing {
    limit: usize,
    bytes: Mutex<(usize, VecDeque<String>)>,
}

impl LogRing {
    pub(crate) fn new(limit: usize) -> Self {
        Self {
            limit,
            bytes: Mutex::new((0, VecDeque::new())),
        }
    }

    pub(crate) fn push(&self, line: String) {
        let mut guard = match self.bytes.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        let (bytes, lines) = &mut *guard;
        *bytes += line.len() + 1;
        lines.push_back(line);
        while *bytes > self.limit {
            if let Some(front) = lines.pop_front() {
                *bytes = bytes.saturating_sub(front.len() + 1);
            } else {
                *bytes = 0;
                break;
            }
        }
    }

    pub(crate) fn snapshot(&self) -> Vec<String> {
        self.bytes
            .lock()
            .map(|guard| guard.1.iter().cloned().collect())
            .unwrap_or_default()
    }
}

/// Reconnect backoff shared by long-lived stream transports.
/// Incremental `text/event-stream` decoder (handles CRLF and multi-line data).
#[derive(Default)]
pub(crate) struct SseDecoder {
    buffer: String,
}

#[derive(Debug, PartialEq)]
pub(crate) struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

impl SseDecoder {
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buffer.push_str(&String::from_utf8_lossy(chunk));
        self.buffer = self.buffer.replace("\r\n", "\n");
        // shortcut: a malicious server could stream one endless event; drop the
        // buffer instead of growing without bound. Per-event limits land with
        // the diagnostics manager if this proves too coarse.
        if self.buffer.len() > 4 * 1024 * 1024 {
            self.buffer.clear();
            return Vec::new();
        }
        let mut events = Vec::new();
        while let Some(index) = self.buffer.find("\n\n") {
            let block = self.buffer[..index].to_string();
            self.buffer.drain(..index + 2);
            if let Some(event) = parse_sse_block(&block) {
                events.push(event);
            }
        }
        events
    }
}

fn parse_sse_block(block: &str) -> Option<SseEvent> {
    let mut event = None;
    let mut data = Vec::new();
    for line in block.lines() {
        if let Some(value) = line.strip_prefix("event:") {
            event = Some(value.trim().to_string());
        } else if let Some(value) = line.strip_prefix("data:") {
            data.push(value.strip_prefix(' ').unwrap_or(value).to_string());
        }
    }
    if data.is_empty() {
        return None;
    }
    Some(SseEvent {
        event,
        data: data.join("\n"),
    })
}

/// Parses a complete SSE body (used for request-scoped POST responses).
pub(crate) fn parse_sse_events(text: &str) -> Vec<SseEvent> {
    text.replace("\r\n", "\n")
        .split("\n\n")
        .filter_map(parse_sse_block)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn correlates_ids_and_restores_the_caller_id() {
        let pending = PendingRequests::new();
        let mut request = json!({ "jsonrpc": "2.0", "id": "abc", "method": "ping" });
        let (id, _receiver) = pending.prepare(&mut request).unwrap();
        assert_eq!(request["id"], id);
        let response = json!({ "jsonrpc": "2.0", "id": id, "result": {} });
        assert!(pending.complete(response).is_some());
        // Second completion is a no-op: the entry is gone.
        assert!(pending
            .complete(json!({ "jsonrpc": "2.0", "id": id, "result": {} }))
            .is_none());
    }

    #[test]
    fn stderr_ring_keeps_newest_lines_under_the_limit() {
        let ring = LogRing::new(12);
        ring.push("first".to_string());
        ring.push("second".to_string());
        ring.push("third".to_string());
        let lines = ring.snapshot();
        assert!(lines.contains(&"third".to_string()));
        assert!(lines.iter().map(|line| line.len() + 1).sum::<usize>() <= 12);
    }

    #[test]
    fn decoder_handles_split_chunks_and_multiline_data() {
        let mut decoder = SseDecoder::default();
        assert!(decoder.push(b"event: message\ndata: {\"a\":").is_empty());
        let events = decoder.push(b"1}\n\n");
        assert_eq!(
            events,
            vec![SseEvent {
                event: Some("message".to_string()),
                data: "{\"a\":1}".to_string()
            }]
        );
    }
}
