//! User-facing PTY terminals (§4.3 `terminal.create/write/resize/kill`, M5):
//! real pseudo-terminals via ConPTY (portable-pty) so TUIs render, streamed
//! to the UI as coalesced `terminal:pty` events (§4.3 16–32 ms batching).
//! These are the *panel* terminals; the ACP `terminal/*` callbacks keep their
//! own pipe-based registry in `terminals.rs`.
//!
//! Restart policy: PTYs are children of the pult process — an app restart
//! ends them by definition. The registry is memory-only and the UI surfaces
//! that as "the terminal ended with the app" (clean restart policy, §8 M5).

use std::collections::HashMap;
use std::io::{Read, Write as IoWrite};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::PultError;

/// Output coalescing window (§4.3: never one event per chunk).
const FLUSH_INTERVAL_MS: u64 = 24;
/// PTY read chunk size — larger reads just split across chunks naturally.
const READ_CHUNK: usize = 8192;

/// Per-terminal state shared between the registry and IPC handlers.
struct PtyState {
    thread_id: String,
    title: String,
    writer: Option<Box<dyn IoWrite + Send>>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// Exit code once the wait task observed it (None while running).
    exit: Option<i32>,
    killed: bool,
}

/// One message from the reader thread to the coalescing task.
enum PtyMessage {
    Data(Vec<u8>),
    /// Reader hit EOF (output pipe closed) — the child may still be exiting.
    ReaderEof,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PtyInfo {
    pub terminal_id: String,
    pub thread_id: String,
    pub title: String,
    pub exit: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOutputPayload {
    pub terminal_id: String,
    pub thread_id: String,
    /// Base64 of raw PTY bytes (survives multi-byte splits losslessly).
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyCreateParams {
    pub thread_id: String,
    /// Working directory (the thread workspace, sandbox-checked upstream).
    pub cwd: PathBuf,
    /// Overrides the default shell (`powershell -NoLogo`); argv[0] is the
    /// program, the rest are arguments.
    pub command: Option<Vec<String>>,
    pub rows: u16,
    pub cols: u16,
}

pub struct PtyRegistry {
    inner: Mutex<HashMap<String, Arc<Mutex<PtyState>>>>,
    sink: Arc<dyn crate::runtime::EventSink>,
    next_id: std::sync::atomic::AtomicU64,
}

/// Shell used when the caller did not name one. Windows has no `$SHELL`.
fn default_shell() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        ("powershell".to_string(), vec!["-NoLogo".to_string()])
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "/bin/sh".to_string());
        (shell, Vec::new())
    }
}

impl PtyRegistry {
    pub fn new(sink: Arc<dyn crate::runtime::EventSink>) -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            sink,
            next_id: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// Spawns a PTY running `command` (or the default shell) in `cwd` and
    /// starts the output pump: reader thread → channel → coalescing task.
    ///
    /// ConPTY note: on session start the child's console emits `\x1b[6n` (a
    /// cursor-position report request) and stalls until the terminal side
    /// answers. The REAL terminal (xterm.js) replies through `terminal_pty_
    /// write` with truthful coordinates — the backend never forges it.
    pub fn create(&self, params: &PtyCreateParams) -> Result<PtyInfo, PultError> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: params.rows.max(2),
                cols: params.cols.max(8),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PultError::internal(format!("openpty: {e}")))?;

        let (program, args) = match &params.command {
            Some(argv) if !argv.is_empty() => (argv[0].clone(), argv[1..].to_vec()),
            _ => default_shell(),
        };
        let mut cmd = CommandBuilder::new(&program);
        cmd.args(&args);
        // canonicalize() yields `\\?\C:\…` on Windows; PowerShell would show
        // the ugly `FileSystem::\\?\…` location, so strip the prefix back to
        // a plain path for the child's cwd.
        let cwd_plain = params.cwd.to_string_lossy();
        let cwd_plain = cwd_plain.strip_prefix(r"\\?\").unwrap_or(&cwd_plain);
        cmd.cwd(PathBuf::from(cwd_plain));
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| PultError::internal(format!("pty spawn {program}: {e}")))?;
        // ConPTY keeps handles in the slave; drop our end after spawn.
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| PultError::internal(format!("pty reader: {e}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| PultError::internal(format!("pty writer: {e}")))?;

        let terminal_id = format!(
            "pty-{}-{}",
            crate::events::now_millis(),
            self.next_id
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let title = if args.is_empty() {
            program.clone()
        } else {
            format!("{program} {}", args.join(" "))
        };
        let state = Arc::new(Mutex::new(PtyState {
            thread_id: params.thread_id.clone(),
            title: title.trim().to_string(),
            writer: Some(writer),
            master: pair.master,
            child,
            exit: None,
            killed: false,
        }));
        self.inner
            .lock()
            .expect("pty registry lock poisoned")
            .insert(terminal_id.clone(), Arc::clone(&state));

        // Reader thread (blocking std Read — portable-pty provides no async
        // reader) feeds a channel; a coalescing task batches into events.
        let (tx, mut rx) = mpsc::unbounded_channel::<PtyMessage>();
        let pump_tx = tx.clone();
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = vec![0u8; READ_CHUNK];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if pump_tx.send(PtyMessage::Data(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = pump_tx.send(PtyMessage::ReaderEof);
        });

        // Coalescer: fold chunks for FLUSH_INTERVAL_MS, emit one event, and
        // poll the child exit on the same tick — `try_wait` is a cheap
        // syscall and brief lock holds never block write/resize/kill.
        let emit_state = Arc::clone(&state);
        let sink = Arc::clone(&self.sink);
        let emit_thread_id = params.thread_id.clone();
        let emit_terminal_id = terminal_id.clone();
        tokio::spawn(async move {
            let mut pending: Vec<u8> = Vec::new();
            let mut ticker =
                tokio::time::interval(tokio::time::Duration::from_millis(FLUSH_INTERVAL_MS));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            ticker.tick().await; // first tick fires immediately
            let mut eof_since: Option<std::time::Instant> = None;
            loop {
                tokio::select! {
                    msg = rx.recv() => {
                        match msg {
                            Some(PtyMessage::Data(chunk)) => pending.extend_from_slice(&chunk),
                            Some(PtyMessage::ReaderEof) => {
                                if !pending.is_empty() {
                                    flush(&sink, &emit_terminal_id, &emit_thread_id, &mut pending);
                                }
                                eof_since = Some(std::time::Instant::now());
                            }
                            None => break,
                        }
                    }
                    _ = ticker.tick() => {
                        if !pending.is_empty() {
                            flush(&sink, &emit_terminal_id, &emit_thread_id, &mut pending);
                        }
                        if try_record_exit(&emit_state) {
                            sink.emit("terminal:ptyExit", exit_payload(&emit_state, &emit_terminal_id, &emit_thread_id)).ok();
                            break;
                        }
                        // EOF but no exit observed (lost process): finalize
                        // after a grace period so the UI is not stuck.
                        if eof_since
                            .map(|t| t.elapsed() > std::time::Duration::from_secs(2))
                            .unwrap_or(false)
                        {
                            record_exit(&emit_state, None);
                            sink.emit("terminal:ptyExit", exit_payload(&emit_state, &emit_terminal_id, &emit_thread_id)).ok();
                            break;
                        }
                    }
                }
            }
        });

        Ok(PtyInfo {
            terminal_id,
            thread_id: params.thread_id.clone(),
            title,
            exit: None,
        })
    }

    /// Writes raw user input into the PTY (xterm.js `onData`).
    pub fn write(&self, terminal_id: &str, data: &[u8]) -> Result<(), PultError> {
        let state = self.get(terminal_id)?;
        let mut guard = state.lock().expect("pty lock poisoned");
        let Some(writer) = guard.writer.as_mut() else {
            return Err(PultError::with_code(
                "terminal.input_closed",
                "terminal input closed",
            ));
        };
        writer
            .write_all(data)
            .and_then(|_| writer.flush())
            .map_err(|e| PultError::internal(format!("pty write: {e}")))
    }

    pub fn resize(&self, terminal_id: &str, rows: u16, cols: u16) -> Result<(), PultError> {
        let state = self.get(terminal_id)?;
        let guard = state.lock().expect("pty lock poisoned");
        guard
            .master
            .resize(PtySize {
                rows: rows.max(2),
                cols: cols.max(8),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PultError::internal(format!("pty resize: {e}")))
    }

    /// Kills the terminal (stop button); the exit event follows from the
    /// wait task.
    pub fn kill(&self, terminal_id: &str) -> Result<(), PultError> {
        let state = self.get(terminal_id)?;
        {
            let mut guard = state.lock().expect("pty lock poisoned");
            guard.killed = true;
            let _ = guard.child.kill();
        }
        Ok(())
    }

    /// All live terminals for a thread, oldest first (creation order).
    pub fn list_for_thread(&self, thread_id: &str) -> Vec<PtyInfo> {
        self.inner
            .lock()
            .expect("pty registry lock poisoned")
            .iter()
            .filter(|(_, s)| s.lock().expect("pty lock poisoned").thread_id == thread_id)
            .map(|(id, s)| {
                let guard = s.lock().expect("pty lock poisoned");
                PtyInfo {
                    terminal_id: id.clone(),
                    thread_id: guard.thread_id.clone(),
                    title: guard.title.clone(),
                    exit: guard.exit,
                }
            })
            .collect()
    }

    pub fn info(&self, terminal_id: &str) -> Result<PtyInfo, PultError> {
        let state = self.get(terminal_id)?;
        let guard = state.lock().expect("pty lock poisoned");
        Ok(PtyInfo {
            terminal_id: terminal_id.to_string(),
            thread_id: guard.thread_id.clone(),
            title: guard.title.clone(),
            exit: guard.exit,
        })
    }

    /// Kills and forgets every terminal owned by a thread (thread deleted):
    /// child processes must die before the worktree directory can be removed.
    pub fn kill_thread(&self, thread_id: &str) {
        let states: Vec<Arc<Mutex<PtyState>>> = {
            let mut inner = self.inner.lock().expect("pty registry lock poisoned");
            let ids: Vec<String> = inner
                .iter()
                .filter(|(_, s)| s.lock().expect("pty lock poisoned").thread_id == thread_id)
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter().filter_map(|id| inner.remove(&id)).collect()
        };
        for state in states {
            let mut guard = state.lock().expect("pty lock poisoned");
            guard.killed = true;
            let _ = guard.child.kill();
        }
    }

    fn get(&self, terminal_id: &str) -> Result<Arc<Mutex<PtyState>>, PultError> {
        self.inner
            .lock()
            .expect("pty registry lock poisoned")
            .get(terminal_id)
            .cloned()
            .ok_or_else(|| PultError::internal(format!("unknown terminal: {terminal_id}")))
    }
}

fn flush(
    sink: &Arc<dyn crate::runtime::EventSink>,
    terminal_id: &str,
    thread_id: &str,
    pending: &mut Vec<u8>,
) {
    let data = base64::engine::general_purpose::STANDARD.encode(&*pending);
    pending.clear();
    let payload = serde_json::to_value(PtyOutputPayload {
        terminal_id: terminal_id.to_string(),
        thread_id: thread_id.to_string(),
        data,
    })
    .unwrap_or(serde_json::Value::Null);
    let _ = sink.emit("terminal:pty", payload);
}

fn record_exit(state: &Arc<Mutex<PtyState>>, code: Option<i32>) {
    let mut guard = state.lock().expect("pty lock poisoned");
    guard.exit.get_or_insert(code.unwrap_or(-1));
    guard.writer = None;
}

/// Polls the child exit; returns true (and records the code) once it ended.
fn try_record_exit(state: &Arc<Mutex<PtyState>>) -> bool {
    let mut guard = state.lock().expect("pty lock poisoned");
    if guard.exit.is_some() {
        return true;
    }
    match guard.child.try_wait() {
        Ok(Some(status)) => {
            guard.exit = Some(status.exit_code() as i32);
            guard.writer = None;
            true
        }
        Ok(None) => false,
        Err(_) => {
            guard.exit = Some(-1);
            guard.writer = None;
            true
        }
    }
}

fn exit_of(state: &Arc<Mutex<PtyState>>) -> Option<i32> {
    state.lock().expect("pty lock poisoned").exit
}

fn exit_payload(
    state: &Arc<Mutex<PtyState>>,
    terminal_id: &str,
    thread_id: &str,
) -> serde_json::Value {
    serde_json::json!({
        "terminalId": terminal_id,
        "threadId": thread_id,
        "exitCode": exit_of(state),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct RecordingSink {
        events: Mutex<Vec<(String, serde_json::Value)>>,
    }
    impl RecordingSink {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                events: Mutex::new(Vec::new()),
            })
        }
        fn combined_output(&self, terminal_id: &str) -> String {
            let events = self.events.lock().expect("sink events poisoned");
            let decoded: Vec<String> = events
                .iter()
                .filter(|(event, payload)| {
                    event == "terminal:pty" && payload["terminalId"].as_str() == Some(terminal_id)
                })
                .filter_map(|(_, payload)| {
                    base64::engine::general_purpose::STANDARD
                        .decode(payload["data"].as_str()?)
                        .ok()
                })
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                .collect();
            decoded.join("")
        }
        fn saw_exit(&self, terminal_id: &str) -> bool {
            self.events
                .lock()
                .expect("sink events poisoned")
                .iter()
                .any(|(event, payload)| {
                    event == "terminal:ptyExit"
                        && payload["terminalId"].as_str() == Some(terminal_id)
                })
        }
    }
    impl crate::runtime::EventSink for RecordingSink {
        fn emit(&self, event: &str, payload: serde_json::Value) -> Result<(), String> {
            self.events
                .lock()
                .expect("sink events poisoned")
                .push((event.to_string(), payload));
            Ok(())
        }
        fn notify(&self, _title: &str, _body: &str) {}
    }

    fn params(cwd: &std::path::Path, command: Vec<String>) -> PtyCreateParams {
        PtyCreateParams {
            thread_id: "th-test".to_string(),
            cwd: cwd.to_path_buf(),
            command: Some(command),
            rows: 24,
            cols: 80,
        }
    }

    #[tokio::test]
    async fn pty_round_trip_output_exit_and_input_write() {
        let sink = RecordingSink::new();
        let registry = PtyRegistry::new(Arc::clone(&sink) as Arc<dyn crate::runtime::EventSink>);
        let cwd = std::env::temp_dir();
        let info = registry
            .create(&params(
                &cwd,
                vec![
                    "cmd".to_string(),
                    "/c".to_string(),
                    // Give ConPTY's renderer time to receive the CPR answer
                    // before the child prints and exits; an instant echo can
                    // be dropped while the renderer is still blocked.
                    "ping -n 2 127.0.0.1 >nul & echo pty-round-trip-marker".to_string(),
                ],
            ))
            .unwrap();
        // ConPTY blocks its renderer until the terminal side answers the
        // cursor-position report it emits on session start. The REAL
        // terminal answers via xterm.js `onData` → terminal_pty_write with
        // truthful coordinates; the test plays the same role over the
        // public API.
        let mut saw_marker = false;
        let mut answered_cpr = false;
        for _ in 0..200 {
            let out = sink.combined_output(&info.terminal_id);
            if !answered_cpr && out.contains("\x1b[6n") {
                registry
                    .write(&info.terminal_id, b"\x1b[1;1R")
                    .expect("CPR answer");
                answered_cpr = true;
            }
            if registry.info(&info.terminal_id).unwrap().exit.is_some() {
                // The process can exit before the output pump drains its last
                // chunk; give the sink a bounded grace period to catch up.
                for _ in 0..40 {
                    if sink
                        .combined_output(&info.terminal_id)
                        .contains("pty-round-trip-marker")
                    {
                        saw_marker = true;
                        break;
                    }
                    tokio::time::sleep(tokio::time::Duration::from_millis(25)).await;
                }
                break;
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        }
        assert!(
            saw_marker,
            "echoed marker must arrive through the sink; got {:?} (exit: {:?})",
            sink.combined_output(&info.terminal_id),
            registry.info(&info.terminal_id).unwrap().exit,
        );
        assert!(sink.saw_exit(&info.terminal_id), "exit event emitted");
        // Writing to the (now closed) input is a typed error.
        let err = registry
            .write(&info.terminal_id, b"ls\r")
            .expect_err("closed input");
        assert!(err.to_string().contains("input closed"));

        // A live interactive shell accepts input and echoes it back (it also
        // starts with a CPR handshake — answer before typing).
        let live = registry
            .create(&params(&cwd, vec!["cmd".to_string()]))
            .unwrap();
        let mut live_ok = false;
        let mut live_cpr = false;
        for _ in 0..200 {
            let out = sink.combined_output(&live.terminal_id);
            if !live_cpr && out.contains("\x1b[6n") {
                registry.write(&live.terminal_id, b"\x1b[1;1R").unwrap();
                live_cpr = true;
                tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
                registry
                    .write(&live.terminal_id, b"echo live-input-ok\r\n")
                    .unwrap();
            }
            if sink
                .combined_output(&live.terminal_id)
                .contains("live-input-ok")
            {
                live_ok = true;
                break;
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        }
        registry.kill(&live.terminal_id).unwrap();
        assert!(live_ok, "interactive input echoed back through the PTY");
        // Bookkeeping: list shows both, kill recorded an exit.
        for _ in 0..50 {
            if registry.info(&live.terminal_id).unwrap().exit.is_some() {
                break;
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        }
        let list = registry.list_for_thread("th-test");
        assert_eq!(list.len(), 2);
        assert!(registry.info(&live.terminal_id).unwrap().exit.is_some());
    }

    #[tokio::test]
    async fn resize_and_unknown_terminal_errors() {
        let sink = RecordingSink::new();
        let registry = PtyRegistry::new(Arc::clone(&sink) as Arc<dyn crate::runtime::EventSink>);
        let err = registry
            .write("pty-nope", b"hi")
            .expect_err("unknown terminal");
        assert!(err.to_string().contains("unknown terminal"));
        let err = registry.resize("pty-nope", 10, 10).expect_err("unknown");
        assert!(err.to_string().contains("unknown terminal"));
        let live = registry
            .create(&params(&std::env::temp_dir(), vec!["cmd".to_string()]))
            .unwrap();
        registry.resize(&live.terminal_id, 30, 120).unwrap();
        registry.kill(&live.terminal_id).unwrap();
    }

    #[test]
    fn default_shell_matches_target_os() {
        #[cfg(windows)]
        {
            let (program, args) = default_shell();
            assert_eq!(program, "powershell");
            assert_eq!(args, vec!["-NoLogo".to_string()]);
        }
        #[cfg(not(windows))]
        {
            let prev = std::env::var_os("SHELL");
            std::env::set_var("SHELL", "/bin/zsh");
            assert_eq!(default_shell(), ("/bin/zsh".to_string(), Vec::new()));
            std::env::remove_var("SHELL");
            assert_eq!(default_shell(), ("/bin/sh".to_string(), Vec::new()));
            match prev {
                Some(v) => std::env::set_var("SHELL", v),
                None => std::env::remove_var("SHELL"),
            }
        }
    }
}
