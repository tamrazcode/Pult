//! `stdio` MCP transport: a direct child process speaking newline-delimited
//! JSON-RPC. No shell string is ever built; `.cmd`/`.bat` shims are resolved and
//! executed by the platform's normal command handling.

use std::collections::BTreeMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex as AsyncMutex;

use super::security::{redact_values, MAX_LOG_LINE, MAX_MESSAGE_BYTES};
use super::transport::{await_reply, LogRing, McpTransport, PendingRequests, TransportFuture};

const STDERR_LIMIT: usize = 256 * 1024;

pub struct StdioConfig {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    /// Plain env plus resolved secret values; never surfaced back to the UI.
    pub env: BTreeMap<String, String>,
    /// Exact secret values, scrubbed from stdout/stderr before logging.
    pub secret_values: Vec<String>,
    pub timeout: Duration,
    pub label: String,
}

pub struct StdioTransport {
    child: Mutex<Option<Child>>,
    stdin: AsyncMutex<ChildStdin>,
    pending: Arc<PendingRequests>,
    logs: Arc<LogRing>,
    timeout: Duration,
}

impl StdioTransport {
    pub fn spawn(config: StdioConfig) -> Result<Arc<Self>, String> {
        let mut command = config.command.clone();
        if !Path::new(&command).is_absolute() {
            if let Some(resolved) = crate::config::resolve_command(&command) {
                command = resolved.to_string_lossy().into_owned();
            }
        }
        let mut cmd = Command::new(&command);
        cmd.args(&config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(cwd) = config.cwd.as_deref() {
            cmd.current_dir(cwd);
        }
        cmd.envs(&config.env);
        // Pult's own bearer tokens must never reach a user-supplied process.
        cmd.env_remove("PULT_MCP_TOKEN")
            .env_remove("PULT_MCP_URL")
            .env_remove("PULT_MCP_STDIO_BIN");
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to start `{command}`: {e}"))?;
        if let Some(pid) = child.id() {
            crate::processes::register_process(
                pid,
                crate::processes::ProcessMeta::new("mcp").with_label(&config.label),
            );
        }
        let pid = child.id();
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "MCP server stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "MCP server stdout unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "MCP server stderr unavailable".to_string())?;

        let pending = Arc::new(PendingRequests::new());
        let logs = Arc::new(LogRing::new(STDERR_LIMIT));
        let reader_pending = Arc::clone(&pending);
        let reader_logs = Arc::clone(&logs);
        let reader_secrets = config.secret_values.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout);
            while let Ok(Some((line, truncated))) =
                next_line_capped(&mut lines, MAX_MESSAGE_BYTES).await
            {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                if truncated {
                    reader_logs.push("dropped an oversized MCP message".to_string());
                    continue;
                }
                match serde_json::from_str::<Value>(line) {
                    Ok(value) => {
                        if value.get("id").is_some() {
                            reader_pending.complete(value);
                        }
                    }
                    Err(_) => reader_logs.push(format!(
                        "stdout: {}",
                        redact_values(&super::security::redact(line), &reader_secrets)
                    )),
                }
            }
            reader_pending.fail_all("MCP server stdout closed");
            reader_logs.push("stdout closed".to_string());
            if let Some(pid) = pid {
                crate::processes::unregister_process(pid);
            }
        });
        let stderr_logs = Arc::clone(&logs);
        let stderr_secrets = config.secret_values.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr);
            while let Ok(Some((line, _truncated))) =
                next_line_capped(&mut lines, MAX_LOG_LINE).await
            {
                stderr_logs.push(redact_values(
                    &super::security::redact(&line),
                    &stderr_secrets,
                ));
            }
        });

        Ok(Arc::new(Self {
            child: Mutex::new(Some(child)),
            stdin: AsyncMutex::new(stdin),
            pending,
            logs,
            timeout: config.timeout.max(Duration::from_millis(1)),
        }))
    }

    async fn write_line(&self, value: &Value) -> Result<(), String> {
        let mut line =
            serde_json::to_string(value).map_err(|e| format!("encode MCP message: {e}"))?;
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("write MCP message: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("flush MCP message: {e}"))
    }
}

impl McpTransport for StdioTransport {
    fn request<'a>(&'a self, mut request: Value) -> TransportFuture<'a, Value> {
        Box::pin(async move {
            let (id, receiver) = self.pending.prepare(&mut request)?;
            if let Err(error) = self.write_line(&request).await {
                self.pending.cancel(id);
                return Err(error);
            }
            await_reply(&self.pending, id, receiver, self.timeout).await
        })
    }

    fn notify<'a>(&'a self, notification: Value) -> TransportFuture<'a, ()> {
        Box::pin(async move { self.write_line(&notification).await })
    }

    fn close(&self) -> TransportFuture<'_, ()> {
        Box::pin(async move {
            self.pending.fail_all("MCP server stopped");
            let child = self.child.lock().ok().and_then(|mut slot| slot.take());
            if let Some(mut child) = child {
                #[cfg(windows)]
                {
                    if let Some(pid) = child.id() {
                        let _ = Command::new("taskkill")
                            .args(["/PID", &pid.to_string(), "/T", "/F"])
                            .stdin(Stdio::null())
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .status()
                            .await;
                    }
                }
                if let Some(pid) = child.id() {
                    crate::processes::unregister_process(pid);
                }
                let _ = child.start_kill();
                let _ = child.wait().await;
            }
            Ok(())
        })
    }

    fn logs(&self) -> Vec<String> {
        self.logs.snapshot()
    }
}

/// Reads one line with a hard byte cap. Oversized lines are consumed up to the
/// newline but only the first `max` bytes are returned, so a hostile server
/// cannot allocate unbounded memory.
async fn next_line_capped<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    max: usize,
) -> std::io::Result<Option<(String, bool)>> {
    let mut out = Vec::new();
    let mut truncated = false;
    loop {
        let buffer = reader.fill_buf().await?;
        if buffer.is_empty() {
            return if out.is_empty() && !truncated {
                Ok(None)
            } else {
                Ok(Some((
                    String::from_utf8_lossy(&out).into_owned(),
                    truncated,
                )))
            };
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let data_len = newline.unwrap_or(buffer.len());
        let used = data_len + usize::from(newline.is_some());
        let room = max.saturating_sub(out.len());
        if data_len <= room {
            out.extend_from_slice(&buffer[..data_len]);
        } else {
            out.extend_from_slice(&buffer[..room]);
            truncated = true;
        }
        reader.consume(used);
        if newline.is_some() {
            return Ok(Some((
                String::from_utf8_lossy(&out).into_owned(),
                truncated,
            )));
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use base64::Engine;
    use serde_json::json;

    fn mock_config() -> StdioConfig {
        let script = r#"
$ErrorActionPreference = 'Stop'
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $msg = $line | ConvertFrom-Json
  if ($msg.method -eq 'initialize') {
    $reply = @{ jsonrpc='2.0'; id=$msg.id; result=@{ protocolVersion='2025-06-18'; capabilities=@{}; serverInfo=@{ name='mock'; version='1.0' } } }
  } elseif ($msg.method -eq 'tools/list') {
    $reply = @{ jsonrpc='2.0'; id=$msg.id; result=@{ tools=@(@{ name='echo'; description='Echo'; inputSchema=@{ type='object' } }) } }
  } elseif ($msg.method -eq 'tools/call') {
    $text = [string]$msg.params.arguments.text
    $reply = @{ jsonrpc='2.0'; id=$msg.id; result=@{ content=@(@{ type='text'; text=$text }); isError=$false } }
  } else {
    $reply = @{ jsonrpc='2.0'; id=$msg.id; error=@{ code=-32601; message='method not found' } }
  }
  $reply | ConvertTo-Json -Compress -Depth 20
  [Console]::Out.Flush()
}
"#;
        let utf16: Vec<u8> = script
            .encode_utf16()
            .flat_map(|unit| unit.to_le_bytes())
            .collect();
        StdioConfig {
            command: "powershell.exe".to_string(),
            args: vec![
                "-NoProfile".to_string(),
                "-NonInteractive".to_string(),
                "-EncodedCommand".to_string(),
                base64::engine::general_purpose::STANDARD.encode(utf16),
            ],
            cwd: None,
            env: BTreeMap::new(),
            secret_values: Vec::new(),
            timeout: Duration::from_secs(20),
            label: "mock".to_string(),
        }
    }

    #[tokio::test]
    async fn round_trips_requests_and_keeps_callers_ids() {
        let transport = StdioTransport::spawn(mock_config()).unwrap();
        let init = transport
            .request(json!({
                "jsonrpc": "2.0", "id": "init-1", "method": "initialize", "params": {}
            }))
            .await
            .unwrap();
        assert_eq!(init["id"], "init-1");
        assert_eq!(init["result"]["serverInfo"]["name"], "mock");

        transport
            .notify(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .await
            .unwrap();

        let (tools, call) = tokio::join!(
            transport.request(json!({
                "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}
            })),
            transport.request(json!({
                "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": { "name": "echo", "arguments": { "text": "hello" } }
            }))
        );
        assert_eq!(tools.unwrap()["result"]["tools"][0]["name"], "echo");
        assert_eq!(call.unwrap()["result"]["content"][0]["text"], "hello");
        transport.close().await.unwrap();
    }

    #[tokio::test]
    async fn bounds_oversized_lines_without_allocating_them() {
        let data = [b'a'; 64];
        let mut reader = tokio::io::BufReader::new(&data[..]);
        let (line, truncated) = super::next_line_capped(&mut reader, 8)
            .await
            .unwrap()
            .expect("line");
        assert!(truncated);
        assert_eq!(line, "aaaaaaaa");
    }

    #[tokio::test]
    async fn unknown_command_fails_loudly() {
        let error = StdioTransport::spawn(StdioConfig {
            command: "pult-definitely-missing-binary".to_string(),
            args: Vec::new(),
            cwd: None,
            env: BTreeMap::new(),
            secret_values: Vec::new(),
            timeout: Duration::from_secs(2),
            label: "missing".to_string(),
        })
        .err()
        .expect("spawn must fail");
        assert!(error.contains("failed to start"), "{error}");
    }
}
