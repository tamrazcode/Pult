//! Background shell jobs started by an agent through `run_background`.
//!
//! Pult owns the process, caps its output, and wakes the owning thread when
//! the command ends. State is in memory only: the job object kills the child
//! tree when Pult exits, so there is nothing to resume after a restart.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::process::{Child, Command};

use crate::events::now_millis;
use crate::runtime::AgentRuntime;

pub const MAX_CMD_BYTES: usize = 16_384;
pub const MAX_LABEL_CHARS: usize = 120;
pub const OUTPUT_TAIL_BYTES: usize = 4_096;
pub const DEFAULT_TIMEOUT_SEC: u64 = 1_800;
pub const MAX_TIMEOUT_SEC: u64 = 3_600;
pub const MAX_CONCURRENT_PER_THREAD: usize = 2;
pub const MAX_CONCURRENT_GLOBAL: usize = 32;
const MAX_HISTORY_PER_THREAD: usize = 16;
const PIPE_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Running,
    Completed,
    Failed,
    TimedOut,
    Cancelled,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::TimedOut => "timed_out",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::Running)
    }

    /// Cancelled by hand means the agent already knows; no wake.
    pub fn wakes_thread(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::TimedOut)
    }
}

#[derive(Debug, Clone, Copy)]
enum StopReason {
    Cancel,
}

#[derive(Default)]
struct OutputTail {
    buffer: Vec<u8>,
    truncated: bool,
}

impl OutputTail {
    fn push(&mut self, chunk: &[u8]) {
        self.buffer.extend_from_slice(chunk);
        if self.buffer.len() <= OUTPUT_TAIL_BYTES {
            return;
        }
        let mut cut = self.buffer.len() - OUTPUT_TAIL_BYTES;
        while cut < self.buffer.len() && (self.buffer[cut] & 0b1100_0000) == 0b1000_0000 {
            cut += 1;
        }
        self.buffer.drain(..cut);
        self.truncated = true;
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.buffer).into_owned()
    }
}

struct BackgroundJob {
    id: String,
    thread_id: String,
    run_id: String,
    label: String,
    cmd: String,
    cwd: String,
    pid: Option<u32>,
    status: Status,
    exit_code: Option<i32>,
    timeout_sec: u64,
    started_at: i64,
    finished_at: Option<i64>,
    notified_at: Option<i64>,
    tail: Arc<Mutex<OutputTail>>,
    cancel_tx: Option<tokio::sync::oneshot::Sender<StopReason>>,
}

/// Everything the tool layer validates before a job is created.
pub struct JobSpec {
    pub thread_id: String,
    pub run_id: String,
    pub label: String,
    pub cmd: String,
    pub cwd: PathBuf,
    pub timeout_sec: u64,
}

/// A finished job copied out of the registry for the wake prompt.
pub struct FinishedJob {
    pub id: String,
    pub label: String,
    pub cmd: String,
    pub cwd: String,
    pub status: Status,
    pub exit_code: Option<i32>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub output: String,
    pub truncated: bool,
}

#[derive(Default)]
pub struct BackgroundJobs {
    jobs: Mutex<HashMap<String, BackgroundJob>>,
    seq: AtomicU64,
}

impl BackgroundJobs {
    /// Validate limits, spawn the shell, and hand the child to a monitor task.
    pub fn start(
        self: &Arc<Self>,
        runtime: &Arc<AgentRuntime>,
        spec: JobSpec,
    ) -> Result<Value, String> {
        let id = format!(
            "bg-{}-{}",
            now_millis(),
            self.seq.fetch_add(1, Ordering::Relaxed)
        );
        let tail = Arc::new(Mutex::new(OutputTail::default()));
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
        {
            let mut jobs = self.jobs.lock().expect("bg jobs lock poisoned");
            let per_thread = jobs
                .values()
                .filter(|job| job.thread_id == spec.thread_id && job.status == Status::Running)
                .count();
            if per_thread >= MAX_CONCURRENT_PER_THREAD {
                return Err(format!(
                    "bg.concurrency_limit: this thread already runs {per_thread} background commands"
                ));
            }
            let global = jobs
                .values()
                .filter(|job| job.status == Status::Running)
                .count();
            if global >= MAX_CONCURRENT_GLOBAL {
                return Err(format!(
                    "bg.concurrency_limit: Pult already runs {global} background commands"
                ));
            }
            jobs.insert(
                id.clone(),
                BackgroundJob {
                    id: id.clone(),
                    thread_id: spec.thread_id.clone(),
                    run_id: spec.run_id.clone(),
                    label: spec.label.clone(),
                    cmd: spec.cmd.clone(),
                    cwd: spec.cwd.to_string_lossy().into_owned(),
                    pid: None,
                    status: Status::Running,
                    exit_code: None,
                    timeout_sec: spec.timeout_sec,
                    started_at: now_millis(),
                    finished_at: None,
                    notified_at: None,
                    tail: Arc::clone(&tail),
                    cancel_tx: Some(cancel_tx),
                },
            );
        }

        let mut command = shell_command(&spec.cmd);
        command
            .current_dir(&spec.cwd)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        {
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                self.jobs
                    .lock()
                    .expect("bg jobs lock poisoned")
                    .remove(&id);
                return Err(format!("bg.spawn_failed: {error}"));
            }
        };
        let pid = child.id();
        if let Some(pid) = pid {
            crate::processes::job::adopt(pid);
            crate::processes::register_process(
                pid,
                crate::processes::ProcessMeta::new("tool")
                    .with_label(&spec.label)
                    .with_thread(&spec.thread_id)
                    .with_run(&spec.run_id),
            );
        }
        {
            let mut jobs = self.jobs.lock().expect("bg jobs lock poisoned");
            if let Some(job) = jobs.get_mut(&id) {
                job.pid = pid;
            }
        }
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let runtime = Arc::clone(runtime);
        let jobs = Arc::clone(self);
        let thread_id = spec.thread_id.clone();
        let monitor_id = id.clone();
        let timeout = Duration::from_secs(spec.timeout_sec);
        tokio::spawn(async move {
            let mut cancel_rx = cancel_rx;
            let outcome = monitor(
                &jobs,
                &monitor_id,
                &thread_id,
                &mut child,
                stdout,
                stderr,
                tail,
                &mut cancel_rx,
                timeout,
            )
            .await;
            if let Some(pid) = pid {
                crate::processes::unregister_process(pid);
            }
            if outcome.wakes_thread() {
                runtime.orchestrator.wake_parent_if_idle(&thread_id);
            }
        });

        let jobs = self.jobs.lock().expect("bg jobs lock poisoned");
        let job = jobs.get(&id).ok_or("bg.spawn_failed: job vanished")?;
        Ok(json!({ "job": job_json(job, false) }))
    }

    /// Status for one job, or a list for the thread. `None` when the job is
    /// unknown or belongs to another thread.
    pub fn snapshot(&self, thread_id: &str, job_id: &str) -> Option<Value> {
        let jobs = self.jobs.lock().expect("bg jobs lock poisoned");
        jobs.get(job_id)
            .filter(|job| job.thread_id == thread_id)
            .map(|job| job_json(job, true))
    }

    pub fn list(&self, thread_id: &str) -> Vec<Value> {
        let jobs = self.jobs.lock().expect("bg jobs lock poisoned");
        let mut list: Vec<Value> = jobs
            .values()
            .filter(|job| job.thread_id == thread_id)
            .map(|job| job_json(job, false))
            .collect();
        list.sort_by(|a, b| b["startedAt"].as_i64().cmp(&a["startedAt"].as_i64()));
        list
    }

    /// A running job was polled with its output inside an active run: the
    /// agent has the result, so the later idle wake must not repeat it.
    pub fn mark_notified(&self, thread_id: &str, job_ids: &[String]) {
        let now = now_millis();
        let mut jobs = self.jobs.lock().expect("bg jobs lock poisoned");
        for id in job_ids {
            if let Some(job) = jobs.get_mut(id) {
                if job.thread_id == thread_id && job.status.is_terminal() {
                    job.notified_at = Some(now);
                }
            }
        }
        prune(&mut jobs, thread_id);
    }

    pub fn cancel(&self, thread_id: &str, job_id: &str) -> Result<(bool, Option<Value>), String> {
        let now = now_millis();
        let mut jobs = self.jobs.lock().expect("bg jobs lock poisoned");
        let Some(job) = jobs.get_mut(job_id) else {
            return Err("bg.not_found: unknown job".to_string());
        };
        if job.thread_id != thread_id {
            return Err("bg.not_found: unknown job".to_string());
        }
        if job.status != Status::Running {
            return Ok((false, Some(job_json(job, false))));
        }
        job.status = Status::Cancelled;
        job.finished_at = Some(now);
        job.notified_at = Some(now);
        if let Some(cancel) = job.cancel_tx.take() {
            let _ = cancel.send(StopReason::Cancel);
        }
        Ok((true, Some(job_json(job, false))))
    }

    /// Stop/delete: no wake and no leaked shell when the thread goes away.
    pub fn cancel_thread(&self, thread_id: &str) {
        let now = now_millis();
        let mut jobs = self.jobs.lock().expect("bg jobs lock poisoned");
        for job in jobs.values_mut() {
            if job.thread_id != thread_id || job.status != Status::Running {
                continue;
            }
            job.status = Status::Cancelled;
            job.finished_at = Some(now);
            job.notified_at = Some(now);
            if let Some(cancel) = job.cancel_tx.take() {
                let _ = cancel.send(StopReason::Cancel);
            }
        }
    }

    /// Terminal jobs that still owe the thread exactly one wake.
    pub fn finished_unnotified(&self, thread_id: &str) -> Vec<FinishedJob> {
        let jobs = self.jobs.lock().expect("bg jobs lock poisoned");
        jobs.values()
            .filter(|job| job.thread_id == thread_id)
            .filter(|job| job.status.wakes_thread() && job.notified_at.is_none())
            .map(|job| {
                let tail = job.tail.lock().expect("bg output lock poisoned");
                FinishedJob {
                    id: job.id.clone(),
                    label: job.label.clone(),
                    cmd: job.cmd.clone(),
                    cwd: job.cwd.clone(),
                    status: job.status,
                    exit_code: job.exit_code,
                    started_at: job.started_at,
                    finished_at: job.finished_at,
                    output: tail.text(),
                    truncated: tail.truncated,
                }
            })
            .collect()
    }

    pub fn mark_jobs_notified(&self, thread_id: &str, job_ids: &[String]) {
        self.mark_notified(thread_id, job_ids);
    }
}

fn shell_command(cmd: &str) -> Command {
    #[cfg(windows)]
    {
        let mut command = Command::new("cmd");
        // `cmd /s /c "..."` executes the inner text verbatim; `arg` would
        // escape inner quotes as `\"`, which cmd.exe does not understand.
        command
            .args(["/d", "/s", "/c"])
            .raw_arg(format!("\"{cmd}\""));
        command
    }
    #[cfg(not(windows))]
    {
        let mut command = Command::new("sh");
        command.args(["-c", cmd]);
        command.process_group(0);
        command
    }
}

#[allow(clippy::too_many_arguments)]
async fn monitor(
    jobs: &Arc<BackgroundJobs>,
    id: &str,
    thread_id: &str,
    child: &mut Child,
    stdout: Option<tokio::process::ChildStdout>,
    stderr: Option<tokio::process::ChildStderr>,
    tail: Arc<Mutex<OutputTail>>,
    cancel_rx: &mut tokio::sync::oneshot::Receiver<StopReason>,
    timeout: Duration,
) -> Status {
    let stdout_task = stdout.map(|pipe| tokio::spawn(read_pipe(pipe, Arc::clone(&tail))));
    let stderr_task = stderr.map(|pipe| tokio::spawn(read_pipe(pipe, Arc::clone(&tail))));
    let pid = child.id();
    let (status, exit_code) = tokio::select! {
        waited = child.wait() => match waited {
            Ok(status) => (if status.success() { Status::Completed } else { Status::Failed }, status.code()),
            Err(_) => (Status::Failed, None),
        },
        _ = tokio::time::sleep(timeout) => {
            kill_tree(pid, child).await;
            (Status::TimedOut, None)
        }
        _ = cancel_rx => {
            kill_tree(pid, child).await;
            (Status::Cancelled, None)
        }
    };
    for task in [stdout_task, stderr_task].into_iter().flatten() {
        let _ = tokio::time::timeout(PIPE_DRAIN_TIMEOUT, task).await;
    }
    let mut final_status = status;
    {
        let mut jobs = jobs.jobs.lock().expect("bg jobs lock poisoned");
        if let Some(job) = jobs.get_mut(id) {
            job.finished_at = Some(now_millis());
            job.exit_code = exit_code;
            job.cancel_tx = None;
            // A manual cancel may have won the race; keep its ledger entry.
            if job.status == Status::Running {
                job.status = status;
            }
            final_status = job.status;
        }
        prune(&mut jobs, thread_id);
    }
    final_status
}

async fn read_pipe<R>(mut pipe: R, tail: Arc<Mutex<OutputTail>>)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    use tokio::io::AsyncReadExt;
    let mut buffer = [0u8; 8192];
    loop {
        match pipe.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => tail
                .lock()
                .expect("bg output lock poisoned")
                .push(&buffer[..read]),
        }
    }
}

async fn kill_tree(pid: Option<u32>, child: &mut Child) {
    if let Some(pid) = pid {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let _ = tokio::task::spawn_blocking(move || {
                std::process::Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
            })
            .await;
        }
        #[cfg(not(windows))]
        {
            let _ = std::process::Command::new("kill")
                .args(["-KILL", &format!("-{pid}")])
                .status();
        }
    }
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
}

fn job_json(job: &BackgroundJob, include_output: bool) -> Value {
    let mut value = json!({
        "jobId": job.id,
        "threadId": job.thread_id,
        "runId": job.run_id,
        "label": job.label,
        "cmd": job.cmd,
        "cwd": job.cwd,
        "status": job.status.as_str(),
        "pid": job.pid,
        "exitCode": job.exit_code,
        "timeoutSec": job.timeout_sec,
        "startedAt": job.started_at,
        "finishedAt": job.finished_at,
        "durationMs": job.finished_at.map(|finished| finished - job.started_at),
    });
    if include_output {
        let tail = job.tail.lock().expect("bg output lock poisoned");
        value["outputTail"] = Value::String(tail.text());
        value["truncated"] = Value::Bool(tail.truncated);
    }
    value
}

fn prune(jobs: &mut HashMap<String, BackgroundJob>, thread_id: &str) {
    let mut finished: Vec<(i64, String)> = jobs
        .values()
        .filter(|job| job.thread_id == thread_id)
        .filter(|job| job.status.is_terminal() && job.notified_at.is_some())
        .map(|job| (job.started_at, job.id.clone()))
        .collect();
    if finished.len() <= MAX_HISTORY_PER_THREAD {
        return;
    }
    finished.sort_by_key(|(started, _)| *started);
    let remove = finished.len() - MAX_HISTORY_PER_THREAD;
    for (_, id) in finished.into_iter().take(remove) {
        jobs.remove(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_tail_keeps_the_newest_bytes_on_a_utf8_boundary() {
        let mut tail = OutputTail::default();
        tail.push(&vec![b'a'; OUTPUT_TAIL_BYTES]);
        tail.push("Привет".as_bytes());
        assert!(tail.truncated);
        assert!(tail.buffer.len() <= OUTPUT_TAIL_BYTES);
        let text = tail.text();
        assert!(text.ends_with("Привет"));
        assert!(!text.contains('\u{FFFD}'));
    }

    #[test]
    fn only_uncancelled_terminal_jobs_wake() {
        assert!(Status::Completed.wakes_thread());
        assert!(Status::Failed.wakes_thread());
        assert!(Status::TimedOut.wakes_thread());
        assert!(!Status::Cancelled.wakes_thread());
        assert!(!Status::Running.wakes_thread());
    }
}
