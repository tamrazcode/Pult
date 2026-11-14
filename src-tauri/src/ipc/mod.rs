//! Typed IPC surface (§4.3, M1 subset): threads, runs, providers, fs.
//! specta-generated bindings replace the hand-typed invoke wrappers once the
//! rc.29 API is verified against docs (DEVLOG M0.1 decision #2).

use std::sync::Arc;

use serde::Serialize;

use crate::events::Event;
use crate::runtime::{AgentRuntime, InstanceInfo, SendOutcome};
use crate::store::records::{ImageInput, QueueItem, RunRecord, ThreadRecord};
use crate::PultError;

/// `threads.get` payload: thread + its runs + full event transcript + the
/// message queue still waiting to auto-dispatch.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDetail {
    pub thread: ThreadRecord,
    pub runs: Vec<RunRecord>,
    pub events: Vec<Event>,
    pub queue: Vec<QueueItem>,
    /// The live run of this thread, if any. A DB run marked running WITHOUT
    /// this id is a zombie (the app restarted mid-run); the UI renders it as
    /// interrupted.
    pub active_run_id: Option<String>,
}

/// Monotonic counter so thread ids never collide within the same millisecond.
static THREAD_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Creates a thread. `workspace` pins the session cwd (must exist); with
/// `worktree` the thread instead works in a fresh `git worktree` of the
/// repo containing `workspace` (or the global root) — §8 M4 isolation.
#[tauri::command]
pub async fn threads_create(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    project_id: Option<String>,
    title: String,
    workspace: Option<String>,
    worktree: bool,
) -> Result<ThreadRecord, PultError> {
    let seq = THREAD_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let id = format!("th-{}-{seq}", crate::events::now_millis());
    let mut workspace_value = match workspace.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(ws) => {
            let path = std::path::PathBuf::from(ws);
            let canonical = path.canonicalize().map_err(|e| {
                PultError::internal(format!("workspace {} not found: {e}", path.display()))
            })?;
            Some(canonical.to_string_lossy().into_owned())
        }
        None => None,
    };
    let mut main_repo: Option<String> = None;
    let mut worktree_name: Option<String> = None;
    if worktree {
        let base = match &workspace_value {
            Some(ws) => std::path::PathBuf::from(ws),
            None => runtime.global_workspace_root()?,
        };
        let repo = crate::git::resolve_repo(&base).await?;
        let outcome = crate::git::worktree_create(&repo, &title).await?;
        worktree_name = Some(
            outcome
                .branch
                .strip_prefix("pult/")
                .unwrap_or(&outcome.branch)
                .to_string(),
        );
        main_repo = Some(repo.to_string_lossy().into_owned());
        workspace_value = Some(outcome.path);
    }
    let record = ThreadRecord {
        id,
        project_id,
        title: title.trim().to_string(),
        status: "draft".to_string(),
        pinned: false,
        created_at: crate::events::now_millis(),
        updated_at: crate::events::now_millis(),
        workspace: workspace_value,
        main_repo,
        worktree_name,
    };
    runtime.store().create_thread(&record)?;
    runtime.emit_thread_updated(&record.id);
    Ok(record)
}

#[tauri::command]
pub fn threads_list(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
) -> Result<Vec<ThreadRecord>, PultError> {
    runtime.store().list_threads()
}

#[tauri::command]
pub fn threads_get(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
) -> Result<ThreadDetail, PultError> {
    let thread = runtime.store().get_thread(&thread_id)?;
    let runs = runtime.store().list_runs(&thread_id)?;
    let mut events = Vec::new();
    for run in &runs {
        events.extend(runtime.store().load_events(&run.id)?);
    }
    let queue = runtime.store().list_queue(&thread_id)?;
    let active_run_id = runtime.active_run_for(&thread_id);
    Ok(ThreadDetail {
        thread,
        runs,
        events,
        queue,
        active_run_id,
    })
}

#[tauri::command]
pub fn threads_rename(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
    title: String,
) -> Result<(), PultError> {
    runtime.store().rename_thread(&thread_id, &title)?;
    runtime.emit_thread_updated(&thread_id);
    Ok(())
}

#[tauri::command]
pub fn threads_set_status(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
    status: String,
) -> Result<(), PultError> {
    runtime.store().set_thread_status(&thread_id, &status)?;
    runtime.emit_thread_updated(&thread_id);
    Ok(())
}

#[tauri::command]
pub fn threads_set_pinned(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
    pinned: bool,
) -> Result<(), PultError> {
    runtime.store().set_thread_pinned(&thread_id, pinned)?;
    runtime.emit_thread_updated(&thread_id);
    Ok(())
}

/// Deletes a thread; worktree threads get their worktree removed first
/// (best-effort — the row goes either way, cleanup failures are logged).
#[tauri::command]
pub async fn threads_delete(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
) -> Result<(), PultError> {
    if let Ok(thread) = runtime.store().get_thread(&thread_id) {
        if let (Some(main_repo), Some(name)) = (&thread.main_repo, &thread.worktree_name) {
            if let Err(err) = crate::git::worktree_remove(std::path::Path::new(main_repo), name).await
            {
                tracing::warn!(target: "pult::ipc", thread_id = %thread_id,
                    error = %err, "worktree cleanup failed; deleting thread anyway");
            }
        }
    }
    runtime.store().delete_thread(&thread_id)?;
    Ok(())
}

/// Queue-aware send: starts a run, or stores the message in the thread's
/// queue while a run is active (auto-dispatched on `run_finished`). Async so
/// the command runs on the tokio worker — `dispatch` spawns the run task.
#[tauri::command]
pub async fn runs_dispatch(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
    text: String,
    images: Vec<ImageInput>,
    instance_id: String,
) -> Result<SendOutcome, PultError> {
    let thread = runtime.store().get_thread(&thread_id)?;
    runtime.send(&thread, &text, &images, &instance_id)
}

/// Removes one message from the thread's queue (composer row ✕).
#[tauri::command]
pub fn runs_queue_remove(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
    queue_id: String,
) -> Result<(), PultError> {
    runtime.store().remove_queue_item(&queue_id)?;
    runtime.emit_queue_updated(&thread_id);
    Ok(())
}

#[tauri::command]
pub async fn runs_cancel(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    run_id: String,
) -> Result<(), PultError> {
    runtime.cancel(&run_id)
}

#[tauri::command]
pub fn runs_respond_permission(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    run_id: String,
    request_id: String,
    option_id: Option<String>,
) -> Result<(), PultError> {
    runtime.respond_permission(&run_id, &request_id, option_id)
}

/// Answers a surfaced elicitation (§5.5): accept/decline/cancel + content.
#[tauri::command]
pub fn runs_respond_elicitation(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    run_id: String,
    request_id: String,
    action: String,
    content: Option<serde_json::Value>,
) -> Result<(), PultError> {
    let action = match action.as_str() {
        "accept" => crate::protocol::types::ElicitationAction::Accept,
        "decline" => crate::protocol::types::ElicitationAction::Decline,
        "cancel" => crate::protocol::types::ElicitationAction::Cancel,
        other => {
            return Err(crate::PultError::internal(format!(
                "unknown elicitation action: {other}"
            )))
        }
    };
    runtime.respond_elicitation(&run_id, &request_id, action, content)
}

/// Switches the thread's permission mode (§5.7 pill; also stored as default).
#[tauri::command]
pub fn runs_set_permission_mode(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
    mode: String,
) -> Result<(), PultError> {
    let mode: crate::runtime::permissions::PermissionMode = serde_json::from_value(
        serde_json::Value::String(mode),
    )
    .map_err(|e| crate::PultError::internal(format!("unknown permission mode: {e}")))?;
    runtime.set_permission_mode(&thread_id, mode)
}

#[tauri::command]
pub fn providers_instances_list(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
) -> Result<Vec<InstanceInfo>, PultError> {
    Ok(runtime.instances())
}

/// Known agent CLIs found on PATH (§4.3 providers.detectInstalled, M6).
#[tauri::command]
pub fn providers_detect_installed() -> Result<Vec<crate::config::DetectedAgent>, PultError> {
    Ok(crate::config::detect_installed())
}

/// Rewrites the agent matrix (settings UI): validates, persists to
/// config.toml, and swaps the live registry.
#[tauri::command]
pub fn providers_instances_save(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    instances: Vec<crate::config::InstanceSpec>,
) -> Result<(), PultError> {
    runtime.set_instances(instances)
}

/// Switches the active run's session mode (§5.4; the agent echoes a
/// mode_change update that the timeline renders). Async: set_mode spawns on
/// the tokio runtime, and sync commands would run on the main thread.
#[tauri::command]
pub async fn runs_set_mode(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
    mode_id: String,
) -> Result<(), PultError> {
    runtime.set_mode(&thread_id, &mode_id)
}

/// Diagnostics (§8 M6): last raw protocol frames of the instance's live
/// connection. No live session → typed error.
#[tauri::command]
pub fn diagnostics_frames(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    instance_id: String,
) -> Result<Vec<String>, PultError> {
    runtime.diagnostics_frames(&instance_id)
}

/// Reads one JSON setting (§4.5: theme, keybindings, notifications, …).
#[tauri::command]
pub fn settings_get(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    key: String,
) -> Result<Option<serde_json::Value>, PultError> {
    runtime.store().get_setting(&key)
}

/// Writes one JSON setting of any shape.
#[tauri::command]
pub fn settings_set(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    key: String,
    value: serde_json::Value,
) -> Result<(), PultError> {
    runtime.store().set_setting(&key, &value)
}

/// One-click connect check (§4.3): spawn the agent, handshake, cache caps,
/// shut down. No prompt — free and session-safe.
#[tauri::command]
pub async fn providers_preflight(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    instance_id: String,
) -> Result<crate::runtime::PreflightReport, PultError> {
    runtime.preflight(&instance_id).await
}

/// Resolves the directory git operations run against for a thread: its
/// pinned workspace (worktree threads), else the global root.
fn thread_git_dir(
    runtime: &AgentRuntime,
    thread_id: &str,
) -> Result<std::path::PathBuf, PultError> {
    let thread = runtime.store().get_thread(thread_id)?;
    match thread.workspace.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(ws) => Ok(std::path::PathBuf::from(ws)),
        None => runtime.global_workspace_root(),
    }
}

#[tauri::command]
pub async fn git_status(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
) -> Result<crate::git::GitStatus, PultError> {
    let dir = thread_git_dir(&runtime, &thread_id)?;
    crate::git::status(&dir).await
}

#[tauri::command]
pub async fn git_diff(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
    base: Option<String>,
) -> Result<crate::git::GitDiff, PultError> {
    let dir = thread_git_dir(&runtime, &thread_id)?;
    crate::git::diff(&dir, base.as_deref()).await
}

#[tauri::command]
pub async fn git_commit(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
    message: String,
) -> Result<crate::git::CommitOutcome, PultError> {
    let dir = thread_git_dir(&runtime, &thread_id)?;
    crate::git::commit(&dir, &message).await
}

#[tauri::command]
pub async fn git_push(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
) -> Result<crate::git::PushOutcome, PultError> {
    let dir = thread_git_dir(&runtime, &thread_id)?;
    crate::git::push(&dir).await
}

#[tauri::command]
pub async fn git_pr_create(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
    title: String,
    body: String,
) -> Result<crate::git::PrOutcome, PultError> {
    let dir = thread_git_dir(&runtime, &thread_id)?;
    crate::git::pr_create(&dir, &title, &body).await
}

/// Whether `gh` is callable — the PR button explains itself when it is not.
#[tauri::command]
pub async fn git_gh_available() -> Result<bool, PultError> {
    Ok(crate::git::gh_available().await)
}

/// Manual checkpoint trigger (auto ones fire on run finish, §4.4).
#[tauri::command]
pub async fn git_checkpoint(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
    run_id: String,
) -> Result<String, PultError> {
    let dir = thread_git_dir(&runtime, &thread_id)?;
    crate::git::checkpoint(&dir, &run_id).await
}

// ---- PTY terminals (M5) ----

/// Spawns a PTY in the thread workspace (default shell: powershell -NoLogo).
#[tauri::command]
pub async fn terminal_pty_create(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
    command: Option<Vec<String>>,
    rows: Option<u16>,
    cols: Option<u16>,
) -> Result<crate::runtime::ptys::PtyInfo, PultError> {
    let cwd = thread_git_dir(&runtime, &thread_id)?;
    let params = crate::runtime::ptys::PtyCreateParams {
        thread_id,
        cwd,
        command,
        rows: rows.unwrap_or(24),
        cols: cols.unwrap_or(80),
    };
    runtime.ptys().create(&params)
}

#[tauri::command]
pub async fn terminal_pty_write(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    terminal_id: String,
    data: String,
) -> Result<(), PultError> {
    // Input arrives base64-encoded so arbitrary bytes (arrow keys, pastes)
    // survive the JSON bridge.
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        data.as_bytes(),
    )
    .map_err(|e| PultError::internal(format!("terminal input: {e}")))?;
    runtime.ptys().write(&terminal_id, &bytes)
}

#[tauri::command]
pub async fn terminal_pty_resize(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    terminal_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), PultError> {
    runtime.ptys().resize(&terminal_id, rows, cols)
}

#[tauri::command]
pub async fn terminal_pty_kill(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    terminal_id: String,
) -> Result<(), PultError> {
    runtime.ptys().kill(&terminal_id)
}

#[tauri::command]
pub fn terminal_pty_list(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
) -> Result<Vec<crate::runtime::ptys::PtyInfo>, PultError> {
    Ok(runtime.ptys().list_for_thread(&thread_id))
}

use crate::runtime::ThreadUpdatedPayload as _UnusedImport;
// (kept as a compile-time re-export check of the payload type used in events)
#[allow(unused_imports)]
use _UnusedImport as _;
