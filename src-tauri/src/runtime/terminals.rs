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
    /// Connection that created this terminal: released when that agent goes
    /// away. A token, not the ACP session id — two processes may collide.
    owner_token: String,
    /// Combined stdout+stderr bytes, truncated from the front on the cap.
    buffer: Vec<u8>,
    /// True once the buffer was truncated (the agent should know).
    truncated: bool,
    byte_cap: u64,
    exit: Option<TerminalExitStatus>,
    /// Pipe pumps still running; the exit is only final once they drained.
    pipes_left: usize,
}

type SharedState = Arc<Mutex<TerminalState>>;

/// Shared registry; one entry per live terminal.
#[derive(Default)]
pub struct TerminalRegistry {
    inner: Mutex<HashMap<String, SharedState>>,
    next_id: std::sync::atomic::AtomicU64,
    next_owner: std::sync::atomic::AtomicU64,
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
    /// Mints a token that owns the terminals of one live agent connection.
    /// Unique per connection even when remote ACP session ids collide.
    pub fn new_owner_token(&self) -> String {
        format!(
            "owner-{}-{}",
            crate::events::now_millis(),
            self.next_owner
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        )
    }

    /// Spawns the process and starts pumping output into the ring. `cwd` is
    /// sandbox-checked by the caller.
    pub fn create(
        &self,
        owner_token: &str,
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
            owner_token: owner_token.to_string(),
            buffer: Vec::new(),
            truncated: false,
            byte_cap: cap,
            exit: None,
            pipes_left: 0,
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
            state.lock().expect("terminal lock").pipes_left = readers.len();
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
                    let mut guard = state.lock().expect("terminal lock");
                    guard.pipes_left = guard.pipes_left.saturating_sub(1);
                });
            }
        }

        self.inner
            .lock()
            .expect("terminal registry lock")
            .insert(terminal_id.clone(), state);
        Ok(
            serde_json::to_value(crate::protocol::types::CreateTerminalResult { terminal_id })
                .unwrap_or_default(),
        )
    }

    /// Entry for a terminal the caller owns. Foreign ids look exactly like
    /// unknown ones: no probing other sessions' terminals.
    fn state_for(&self, terminal_id: &str, owner_token: &str) -> Option<SharedState> {
        let state = self
            .inner
            .lock()
            .expect("terminal registry lock")
            .get(terminal_id)
            .cloned()?;
        let owned = state.lock().expect("terminal lock").owner_token == owner_token;
        owned.then_some(state)
    }

    /// `terminal/output` — current ring contents + exit status when finished.
    /// Polls `try_wait` too: an agent that only polls output still learns that
    /// the command exited. The status is reported once the pipes are drained,
    /// so the first `exitStatus` never precedes the last bytes.
    pub fn output(&self, terminal_id: &str, owner_token: &str) -> crate::drivers::acp::ClientReply {
        let Some(state) = self.state_for(terminal_id, owner_token) else {
            return term_error(format!("unknown terminal: {terminal_id}"));
        };
        let mut guard = state.lock().expect("terminal lock");
        poll_exit(&mut guard);
        let exit_status = if guard.pipes_left == 0 {
            guard.exit.clone()
        } else {
            None
        };
        serde_json::to_value(TerminalOutputResult {
            output: String::from_utf8_lossy(&guard.buffer).into_owned(),
            truncated: guard.truncated,
            exit_status,
        })
        .map_err(|e| RpcError::new(ERR_INTERNAL, e.to_string()))
    }

    /// `terminal/wait_for_exit` — polls `try_wait` so the terminal lock is
    /// never held across an await (kill stays responsive).
    pub async fn wait_for_exit(
        &self,
        terminal_id: &str,
        owner_token: &str,
    ) -> crate::drivers::acp::ClientReply {
        let Some(state) = self.state_for(terminal_id, owner_token) else {
            return term_error(format!("unknown terminal: {terminal_id}"));
        };
        let exit = loop {
            {
                let mut guard = state.lock().expect("terminal lock");
                poll_exit(&mut guard);
                if let Some(exit) = guard.exit.clone() {
                    break exit;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        };
        // The process is gone but its pipes may still hold the tail; drain them
        // so `output` after `wait_for_exit` returns the whole transcript.
        let drain_until = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < drain_until {
            if state.lock().expect("terminal lock").pipes_left == 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        serde_json::to_value(crate::protocol::types::WaitForTerminalExitResult {
            exit_code: exit.exit_code,
            signal: exit.signal,
        })
        .map_err(|e| RpcError::new(ERR_INTERNAL, e.to_string()))
    }

    /// `terminal/kill` — terminate without releasing the entry.
    pub fn kill(&self, terminal_id: &str, owner_token: &str) -> crate::drivers::acp::ClientReply {
        let Some(state) = self.state_for(terminal_id, owner_token) else {
            return term_error(format!("unknown terminal: {terminal_id}"));
        };
        let mut guard = state.lock().expect("terminal lock");
        let _ = guard.child.start_kill();
        Ok(serde_json::json!({}))
    }

    /// `terminal/release` — kill and free the registry entry.
    pub fn release(
        &self,
        terminal_id: &str,
        owner_token: &str,
    ) -> crate::drivers::acp::ClientReply {
        let mut guard = self.inner.lock().expect("terminal registry lock");
        let owned = guard
            .get(terminal_id)
            .map(|state| state.lock().expect("terminal lock").owner_token == owner_token)
            .unwrap_or(false);
        if !owned {
            return term_error(format!("unknown terminal: {terminal_id}"));
        }
        match guard.remove(terminal_id) {
            Some(state) => {
                let mut entry = state.lock().expect("terminal lock");
                let _ = entry.child.start_kill();
                Ok(serde_json::json!({}))
            }
            None => term_error(format!("unknown terminal: {terminal_id}")),
        }
    }

    /// Drops every terminal owned by a connection (the agent is gone).
    pub fn release_owner(&self, owner_token: &str) {
        let mut guard = self.inner.lock().expect("terminal registry lock");
        let ids: Vec<String> = guard
            .iter()
            .filter(|(_, state)| state.lock().expect("terminal lock").owner_token == owner_token)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(state) = guard.remove(&id) {
                let mut entry = state.lock().expect("terminal lock");
                let _ = entry.child.start_kill();
            }
        }
    }
}

/// Records the child's exit once, without ever holding the lock across an
/// await. Shared by `output` and `wait_for_exit`.
fn poll_exit(state: &mut TerminalState) -> Option<TerminalExitStatus> {
    if state.exit.is_none() {
        if let Ok(Some(status)) = state.child.try_wait() {
            state.exit = Some(TerminalExitStatus {
                exit_code: status.code().map(|c| u32::try_from(c).unwrap_or(u32::MAX)),
                signal: None, // signals are a unix notion; Windows reports none
            });
        }
    }
    state.exit.clone()
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
            owner_token: "owner-test".to_string(),
            buffer,
            truncated: false,
            byte_cap: cap,
            exit: None,
            pipes_left: 0,
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
        let owner = registry.new_owner_token();
        let created = registry
            .create(
                &owner,
                "cmd",
                &["/c".into(), "echo hi".into()],
                None,
                &[],
                None,
            )
            .expect("terminal created");
        let terminal_id = created["terminalId"]
            .as_str()
            .expect("terminalId")
            .to_string();

        // wait_for_exit resolves with a 0 exit code; output sees the echo.
        let waited = registry
            .wait_for_exit(&terminal_id, &owner)
            .await
            .expect("wait");
        assert_eq!(waited["exitCode"], 0);
        let out = registry.output(&terminal_id, &owner).expect("output");
        let text = out["output"].as_str().expect("output text");
        assert!(
            text.trim().contains("hi"),
            "expected the echo in output, got {text:?}"
        );

        let released = registry.release(&terminal_id, &owner).expect("release");
        assert_eq!(released, serde_json::json!({}));
        let err = registry.output(&terminal_id, &owner).unwrap_err();
        assert_eq!(err.code, ERR_RESOURCE_NOT_FOUND);
    }

    #[test]
    fn unknown_terminal_is_a_typed_resource_error() {
        let registry = TerminalRegistry::default();
        let owner = registry.new_owner_token();
        let err = registry.output("nope", &owner).unwrap_err();
        assert_eq!(err.code, ERR_RESOURCE_NOT_FOUND);
    }

    #[tokio::test]
    async fn release_owner_drops_only_that_owners_terminals() {
        let registry = TerminalRegistry::default();
        let token_a = registry.new_owner_token();
        let token_b = registry.new_owner_token();
        let make = |owner: &str| {
            registry
                .create(
                    owner,
                    "cmd",
                    &["/c".into(), "ping -n 10 127.0.0.1 >nul".into()],
                    None,
                    &[],
                    None,
                )
                .expect("terminal created")["terminalId"]
                .as_str()
                .unwrap()
                .to_string()
        };
        let mine = make(&token_a);
        let other = make(&token_b);

        registry.release_owner(&token_a);
        assert_eq!(
            registry.output(&mine, &token_a).unwrap_err().code,
            ERR_RESOURCE_NOT_FOUND
        );
        assert!(
            registry.output(&other, &token_b).is_ok(),
            "other owner keeps its terminal"
        );
        registry.release_owner(&token_b);
    }

    #[tokio::test]
    async fn terminal_owner_isolation_blocks_foreign_access_and_colliding_session_ids() {
        let registry = TerminalRegistry::default();
        let token_a = registry.new_owner_token();
        let token_b = registry.new_owner_token();
        assert_ne!(token_a, token_b);

        #[cfg(windows)]
        let (cmd, args) = ("cmd", vec!["/c".into(), "ping -n 10 127.0.0.1 >nul".into()]);
        #[cfg(not(windows))]
        let (cmd, args) = ("sh", vec!["-c".into(), "sleep 10".into()]);

        let term_a = registry
            .create(&token_a, cmd, &args, None, &[], None)
            .expect("terminal A created")["terminalId"]
            .as_str()
            .expect("terminalId A")
            .to_string();
        let term_b = registry
            .create(&token_b, cmd, &args, None, &[], None)
            .expect("terminal B created")["terminalId"]
            .as_str()
            .expect("terminalId B")
            .to_string();

        for err in [
            registry.output(&term_a, &token_b).unwrap_err(),
            registry.wait_for_exit(&term_a, &token_b).await.unwrap_err(),
            registry.kill(&term_a, &token_b).unwrap_err(),
            registry.release(&term_a, &token_b).unwrap_err(),
        ] {
            assert_eq!(err.code, ERR_RESOURCE_NOT_FOUND);
            assert!(
                err.message.starts_with("unknown terminal"),
                "expected 'unknown terminal...', got {:?}",
                err.message
            );
        }

        assert!(registry.output(&term_a, &token_a).is_ok());

        registry.release_owner(&token_a);
        let err = registry.output(&term_a, &token_a).unwrap_err();
        assert_eq!(err.code, ERR_RESOURCE_NOT_FOUND);
        assert!(err.message.starts_with("unknown terminal"));

        assert!(
            registry.output(&term_b, &token_b).is_ok(),
            "release_owner(token_a) must leave owner B's terminal alive"
        );
        registry.release_owner(&token_b);
    }

    #[tokio::test]
    async fn output_polls_exit_status_without_wait_for_exit() {
        let registry = TerminalRegistry::default();
        let token = registry.new_owner_token();

        #[cfg(windows)]
        let (cmd, args) = ("cmd", vec!["/c".into(), "echo ok".into()]);
        #[cfg(not(windows))]
        let (cmd, args) = ("sh", vec!["-c".into(), "echo ok".into()]);

        let created = registry
            .create(&token, cmd, &args, None, &[], None)
            .expect("terminal created");
        let terminal_id = created["terminalId"]
            .as_str()
            .expect("terminalId")
            .to_string();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let out = loop {
            let out = registry.output(&terminal_id, &token).expect("output");
            if out.get("exitStatus").and_then(|v| v.as_object()).is_some() {
                break out;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for output() to poll exitStatus: {out:?}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        };

        assert_eq!(out["exitStatus"]["exitCode"], 0);
        let text = out["output"].as_str().expect("output text");
        assert!(text.contains("ok"), "expected 'ok' in output, got {text:?}");
        registry.release(&terminal_id, &token).expect("release");
    }
}
