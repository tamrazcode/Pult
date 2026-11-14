//! Terminal callbacks (§5.5): the client runs processes on the agent's
//! behalf — `terminal/create`, `output` (polled against a per-terminal ring
//! buffer), `wait_for_exit`, `kill`, `release`. Output truncation keeps char
//! boundaries; the visible PTY panel (xterm.js) mirrors these in M5.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};

use crate::protocol::jsonrpc::{RpcError, ERR_INTERNAL, ERR_RESOURCE_NOT_FOUND};
use crate::protocol::types::{TerminalExitStatus, TerminalOutputResult};

/// Default retained output when the agent did not cap it.
const DEFAULT_RING_BYTES: u64 = 1 << 20; // 1 MiB

struct TerminalState {
    child: Child,
    /// Combined stdout+stderr bytes, truncated from the front on the cap.
    buffer: Vec<u8>,
    /// True once the buffer was truncated (the agent should know).
    truncated: bool,
    byte_cap: u64,
    exit: Option<TerminalExitStatus>,
}

type SharedState = Arc<Mutex<TerminalState>>;

/// Shared registry; one entry per live terminal.
#[derive(Default)]
pub struct TerminalRegistry {
    inner: Mutex<HashMap<String, SharedState>>,
    next_id: std::sync::atomic::AtomicU64,
}

/// Typed failure for terminal operations (JSON-RPC `-32002`-style resource
/// errors mirror the fs layer).
fn term_error(message: impl Into<String>) -> crate::drivers::acp::ClientReply {
    Err(RpcError::new(ERR_RESOURCE_NOT_FOUND, message))
}

/// Windows: agent-run shells are console apps; the GUI parent must not pop
/// console windows for them.
#[cfg(windows)]
fn hide_console(cmd: &mut Command) {
    cmd.creation_flags(0x0800_0000);
}
#[cfg(not(windows))]
fn hide_console(_cmd: &mut Command) {}

impl TerminalRegistry {
    /// Spawns the process and starts pumping output into the ring. `cwd` is
    /// sandbox-checked by the caller.
    pub fn create(
        &self,
        command: &str,
        args: &[String],
        cwd: Option<&PathBuf>,
        env: &[(String, String)],
        byte_cap: Option<u64>,
    ) -> crate::drivers::acp::ClientReply {
        let mut cmd = Command::new(command);
        hide_console(&mut cmd);
        cmd.args(args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        for (name, value) in env {
            cmd.env(name, value);
        }
        let child = match cmd.spawn() {
            Ok(child) => child,
            Err(e) => return term_error(format!("terminal spawn {command}: {e}")),
        };

        let cap = byte_cap.unwrap_or(DEFAULT_RING_BYTES).max(1024);
        let terminal_id = format!(
            "term-{}-{}",
            crate::events::now_millis(),
            self.next_id
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let state: SharedState = Arc::new(Mutex::new(TerminalState {
            child,
            buffer: Vec::new(),
            truncated: false,
            byte_cap: cap,
            exit: None,
        }));

        // Two pumps fold stdout+stderr into one ring; pipes are taken before
        // the state goes behind the shared lock.
        {
            let mut guard = state.lock().expect("terminal lock");
            let stdout = guard.child.stdout.take();
            let stderr = guard.child.stderr.take();
            drop(guard);
            let readers: Vec<Box<dyn tokio::io::AsyncRead + Unpin + Send>> = [
                stdout.map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
                stderr.map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
            ]
            .into_iter()
            .flatten()
            .collect();
            for pipe in readers {
                let state = Arc::clone(&state);
                tokio::spawn(async move {
                    let mut pipe = pipe;
                    let mut chunk = [0u8; 8192];
                    loop {
                        match pipe.read(&mut chunk).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                let mut guard = state.lock().expect("terminal lock");
                                guard.buffer.extend_from_slice(&chunk[..n]);
                                truncate_to_cap(&mut guard);
                            }
                        }
                    }
                });
            }
        }

        self.inner
            .lock()
            .expect("terminal registry lock")
            .insert(terminal_id.clone(), state);
        Ok(serde_json::to_value(crate::protocol::types::CreateTerminalResult {
            terminal_id,
        })
        .unwrap_or_default())
    }

    fn state_for(&self, terminal_id: &str) -> Option<SharedState> {
        self.inner
            .lock()
            .expect("terminal registry lock")
            .get(terminal_id)
            .cloned()
    }

    /// `terminal/output` — current ring contents + exit status when finished.
    pub fn output(&self, terminal_id: &str) -> crate::drivers::acp::ClientReply {
        let Some(state) = self.state_for(terminal_id) else {
            return term_error(format!("unknown terminal: {terminal_id}"));
        };
        let guard = state.lock().expect("terminal lock");
        let output = String::from_utf8_lossy(&guard.buffer).into_owned();
        serde_json::to_value(TerminalOutputResult {
            output,
            truncated: guard.truncated,
            exit_status: guard.exit.clone(),
        })
        .map_err(|e| RpcError::new(ERR_INTERNAL, e.to_string()))
    }

    /// `terminal/wait_for_exit` — polls `try_wait` so the terminal lock is
    /// never held across an await (kill stays responsive).
    pub async fn wait_for_exit(&self, terminal_id: &str) -> crate::drivers::acp::ClientReply {
        let Some(state) = self.state_for(terminal_id) else {
            return term_error(format!("unknown terminal: {terminal_id}"));
        };
        let exit = loop {
            {
                let mut guard = state.lock().expect("terminal lock");
                if let Some(exit) = guard.exit.clone() {
                    break exit;
                }
                if let Ok(Some(status)) = guard.child.try_wait() {
                    let exit = TerminalExitStatus {
                        exit_code: status.code().map(|c| u32::try_from(c).unwrap_or(u32::MAX)),
                        signal: None, // signals are a unix notion; Windows reports none
                    };
                    guard.exit = Some(exit.clone());
                    break exit;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        };
        serde_json::to_value(crate::protocol::types::WaitForTerminalExitResult {
            exit_code: exit.exit_code,
            signal: exit.signal,
        })
        .map_err(|e| RpcError::new(ERR_INTERNAL, e.to_string()))
    }

    /// `terminal/kill` — terminate without releasing the entry.
    pub fn kill(&self, terminal_id: &str) -> crate::drivers::acp::ClientReply {
        let Some(state) = self.state_for(terminal_id) else {
            return term_error(format!("unknown terminal: {terminal_id}"));
        };
        let mut guard = state.lock().expect("terminal lock");
        let _ = guard.child.start_kill();
        Ok(serde_json::json!({}))
    }

    /// `terminal/release` — kill and free the registry entry.
    pub fn release(&self, terminal_id: &str) -> crate::drivers::acp::ClientReply {
        let released = self
            .inner
            .lock()
            .expect("terminal registry lock")
            .remove(terminal_id);
        match released {
            Some(state) => {
                let mut guard = state.lock().expect("terminal lock");
                let _ = guard.child.start_kill();
                Ok(serde_json::json!({}))
            }
            None => term_error(format!("unknown terminal: {terminal_id}")),
        }
    }

    /// Drops every terminal (run teardown: the agent process is gone).
    pub fn release_all(&self) {
        let mut guard = self.inner.lock().expect("terminal registry lock");
        for (_, state) in guard.drain() {
            let mut entry = state.lock().expect("terminal lock");
            let _ = entry.child.start_kill();
        }
    }
}

/// Trim the ring from the front, keeping a char boundary. Truncation must
/// never split a multi-byte character (§5.5 "character boundary").
fn truncate_to_cap(state: &mut TerminalState) {
    let excess = state.buffer.len() as i128 - state.byte_cap as i128;
    if excess <= 0 {
        return;
    }
    let drop_bytes = (excess as usize).min(state.buffer.len());
    let mut cut = drop_bytes;
    while cut < state.buffer.len() && (state.buffer[cut] & 0b1100_0000) == 0b1000_0000 {
        cut += 1; // skip continuation bytes of a split character
    }
    state.buffer.drain(..cut);
    state.truncated = true;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_state(buffer: Vec<u8>, cap: u64) -> TerminalState {
        let mut cmd = Command::new("cmd");
        hide_console(&mut cmd);
        TerminalState {
            child: {
                let mut cmd = cmd;
                cmd.args(["/c", "echo hi"]);
                tokio::runtime::Runtime::new()
                    .unwrap()
                    .block_on(async { cmd.spawn().unwrap() })
            },
            buffer,
            truncated: false,
            byte_cap: cap,
            exit: None,
        }
    }

    #[test]
    fn truncation_respects_char_boundaries() {
        // "привет" is 12 bytes of multibyte UTF-8; a 5-byte cap must cut on
        // a character boundary (drop whole leading chars, keep the rest).
        let mut state = make_state("привет".as_bytes().to_vec(), 5);
        truncate_to_cap(&mut state);
        assert!(state.truncated);
        let lossy = String::from_utf8_lossy(&state.buffer).into_owned();
        assert_eq!(lossy.chars().last(), Some('т'));
        assert_eq!(state.buffer.len(), 4); // 5 dropped → 1 continuation byte skipped
    }

    #[test]
    fn under_cap_is_untouched() {
        let mut state = make_state(b"hello".to_vec(), 64);
        truncate_to_cap(&mut state);
        assert!(!state.truncated);
        assert_eq!(state.buffer, b"hello");
    }

    #[tokio::test]
    async fn create_output_wait_kill_round_trip() {
        let registry = TerminalRegistry::default();
        let created = registry
            .create(
                "cmd",
                &["/c".into(), "echo hi".into()],
                None,
                &[],
                None,
            )
            .expect("terminal created");
        let terminal_id = created["terminalId"].as_str().expect("terminalId").to_string();

        // wait_for_exit resolves with a 0 exit code; output sees the echo.
        let waited = registry.wait_for_exit(&terminal_id).await.expect("wait");
        assert_eq!(waited["exitCode"], 0);
        let out = registry.output(&terminal_id).expect("output");
        let text = out["output"].as_str().expect("output text");
        assert!(
            text.trim().contains("hi"),
            "expected the echo in output, got {text:?}"
        );

        let released = registry.release(&terminal_id).expect("release");
        assert_eq!(released, serde_json::json!({}));
        let err = registry.output(&terminal_id).unwrap_err();
        assert_eq!(err.code, ERR_RESOURCE_NOT_FOUND);
    }

    #[test]
    fn unknown_terminal_is_a_typed_resource_error() {
        let registry = TerminalRegistry::default();
        let err = registry.output("nope").unwrap_err();
        assert_eq!(err.code, ERR_RESOURCE_NOT_FOUND);
    }
}
