//! Typed IPC surface (§4.3, M1 subset): threads, runs, providers, fs.
//! specta-generated bindings replace the hand-typed invoke wrappers once the
//! rc.29 API is verified against docs (DEVLOG M0.1 decision #2).

use std::sync::Arc;

use serde::Serialize;

use crate::events::Event;
use crate::runtime::{AgentRuntime, InstanceInfo, SendOutcome};
use crate::store::records::{ImageInput, ProjectRecord, QueueItem, RunRecord, ThreadRecord};
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
    /// Session mode the user picked for the next run (persisted setting).
    pub desired_mode: Option<String>,
    /// Session config picks for the next run (model, thought level, toggles).
    pub desired_config: crate::runtime::DesiredConfigMap,
}

/// Monotonic counter so thread ids never collide within the same millisecond.
static THREAD_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static PROJECT_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Creates a thread. `workspace` pins the session cwd (must exist); with
/// `worktree` the thread instead works in a fresh `git worktree` of the
/// repo containing `workspace` (or the global root) — §8 M4 isolation.
#[tauri::command]
pub async fn threads_create(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    project_id: Option<String>,
    title: String,
    workspace: Option<String>,
    worktree: Option<bool>,
) -> Result<ThreadRecord, PultError> {
    create_thread_with_runtime(runtime.inner(), project_id, title, workspace, worktree).await
}

/// Pure thread creation used by the IPC command and tests: resolves a
/// project's folder/worktree strategy, then persists the thread record.
pub(crate) async fn create_thread_with_runtime(
    runtime: &Arc<AgentRuntime>,
    project_id: Option<String>,
    title: String,
    workspace: Option<String>,
    worktree: Option<bool>,
) -> Result<ThreadRecord, PultError> {
    let project = match &project_id {
        Some(pid) => Some(runtime.store().get_project(pid).map_err(|_| {
            PultError::with_code("workspace.missing", format!("Project {pid} not found"))
        })?),
        None => None,
    };
    let seq = THREAD_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let id = format!("th-{}-{seq}", crate::events::now_millis());
    let mut workspace_value = match workspace.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(ws) => {
            let path = std::path::PathBuf::from(ws);
            if !path.is_absolute() {
                return Err(PultError::with_code(
                    "workspace.missing",
                    format!("Folder must be an absolute path: {ws}"),
                ));
            }
            let canonical = path.canonicalize().map_err(|e| {
                PultError::with_code(
                    "workspace.missing",
                    format!("Folder not found: {} ({e})", path.display()),
                )
            })?;
            Some(
                crate::runtime::clean_verbatim(canonical)
                    .to_string_lossy()
                    .into_owned(),
            )
        }
        None => None,
    };
    if workspace_value.is_none() {
        if let Some(project) = &project {
            let root = std::path::PathBuf::from(&project.root_path);
            if !root.is_absolute() || !root.is_dir() {
                return Err(PultError::with_code(
                    "workspace.missing",
                    format!("Project or thread folder not found: {}", project.root_path),
                ));
            }
            workspace_value = Some(
                crate::runtime::clean_verbatim(root)
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }
    let worktree = worktree.unwrap_or_else(|| {
        project
            .as_ref()
            .is_some_and(|p| p.worktree_strategy == "worktree")
    });
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
        workspace_value = Some(
            crate::runtime::clean_verbatim(std::path::PathBuf::from(outcome.path))
                .to_string_lossy()
                .into_owned(),
        );
    }
    // A project may be deleted while the worktree is being created: do not
    // persist a thread that the FK would reject, and clean the worktree.
    if let Some(pid) = &project_id {
        if runtime.store().get_project(pid).is_err() {
            if let (Some(repo), Some(name)) = (&main_repo, &worktree_name) {
                let _ = crate::git::worktree_remove(std::path::Path::new(repo), name).await;
            }
            return Err(PultError::with_code(
                "workspace.missing",
                format!("Project {pid} was deleted"),
            ));
        }
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
pub fn projects_list(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
) -> Result<Vec<ProjectRecord>, PultError> {
    runtime.store().list_projects()
}

#[tauri::command]
pub fn projects_create(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    name: String,
    root_path: String,
    color: Option<String>,
    worktree_strategy: Option<String>,
) -> Result<ProjectRecord, PultError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(PultError::internal("project name must not be empty"));
    }
    let path = std::path::PathBuf::from(root_path.trim());
    if !path.is_absolute() || !path.is_dir() {
        return Err(PultError::with_code(
            "workspace.missing",
            format!("Folder not found: {}", path.display()),
        ));
    }
    let canonical = path.canonicalize().map_err(|e| {
        PultError::with_code(
            "workspace.missing",
            format!("Folder not found: {} ({e})", path.display()),
        )
    })?;
    let canonical = crate::runtime::clean_verbatim(canonical);
    let strategy = worktree_strategy.unwrap_or_else(|| "root".to_string());
    if strategy != "root" && strategy != "worktree" {
        return Err(PultError::internal(
            "worktree strategy must be root or worktree",
        ));
    }
    let seq = PROJECT_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let project = ProjectRecord {
        id: format!("proj-{}-{seq}", crate::events::now_millis()),
        name: name.to_string(),
        root_path: canonical.to_string_lossy().into_owned(),
        color,
        worktree_strategy: strategy,
        pinned: false,
        created_at: crate::events::now_millis(),
    };
    runtime.store().create_project(&project)?;
    emit_projects(runtime.inner());
    Ok(project)
}

#[tauri::command]
pub fn projects_update(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    id: String,
    name: Option<String>,
    color: Option<String>,
    worktree_strategy: Option<String>,
    pinned: Option<bool>,
) -> Result<ProjectRecord, PultError> {
    if let Some(name) = name.as_deref() {
        if name.trim().is_empty() {
            return Err(PultError::internal("project name must not be empty"));
        }
    }
    if let Some(strategy) = worktree_strategy.as_deref() {
        if strategy != "root" && strategy != "worktree" {
            return Err(PultError::internal(
                "worktree strategy must be root or worktree",
            ));
        }
    }
    let project = runtime.store().update_project(
        &id,
        name.as_deref(),
        color.as_deref(),
        worktree_strategy.as_deref(),
        pinned,
    )?;
    emit_projects(runtime.inner());
    Ok(project)
}

#[tauri::command]
pub fn projects_delete(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    id: String,
) -> Result<(), PultError> {
    let project = runtime.store().get_project(&id)?;
    let affected: Vec<String> = runtime
        .store()
        .list_threads()?
        .into_iter()
        .filter(|thread| thread.project_id.as_deref() == Some(id.as_str()))
        .map(|thread| thread.id)
        .collect();
    runtime.store().delete_project(&id)?;
    runtime.pool.invalidate_root(&crate::runtime::clean_verbatim(
        std::path::PathBuf::from(&project.root_path),
    ));
    emit_projects(runtime.inner());
    for thread_id in affected {
        runtime.emit_thread_updated(&thread_id);
    }
    Ok(())
}

/// One snapshot event keeps the sidebar consistent for create/update/delete.
fn emit_projects(runtime: &AgentRuntime) {
    if let Ok(projects) = runtime.store().list_projects() {
        runtime.emit("projects:update", &projects);
    }
}

#[tauri::command]
pub fn threads_list(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
) -> Result<Vec<ThreadRecord>, PultError> {
    runtime.store().list_threads()
}

/// Historical event payloads can carry multi-megabyte tool output. Cap what
/// crosses the IPC boundary; the row itself stays in SQLite.
fn cap_ui_event_payloads(events: &mut [crate::events::Event]) {
    const MAX_BYTES: usize = 2_000_000;
    fn cap_value(slot: &mut Option<serde_json::Value>) {
        let Some(value) = slot else { return };
        let Ok(text) = serde_json::to_string(value) else {
            return;
        };
        if text.len() > MAX_BYTES {
            *slot = Some(serde_json::json!({
                "truncated": true,
                "bytes": text.len(),
                "note": "large historical payload omitted",
            }));
        }
    }
    for event in events {
        match &mut event.kind {
            crate::events::EventKind::ToolCall { raw_input, .. } => cap_value(raw_input),
            crate::events::EventKind::ToolCallUpdate {
                content, raw_output, ..
            } => {
                cap_value(content);
                cap_value(raw_output);
            }
            crate::events::EventKind::AgentMessageDelta { delta } => {
                if delta.len() > MAX_BYTES {
                    *delta = "\n\n_(large generated payload omitted)_\n\n".to_string();
                }
            }
            crate::events::EventKind::FileChanged { diff, .. } if diff.len() > MAX_BYTES => {
                *diff = "_(diff too large to display)_".to_string();
            }
            _ => {}
        }
    }
}

#[tauri::command]
pub async fn threads_get(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
) -> Result<ThreadDetail, PultError> {
    let runtime = runtime.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<ThreadDetail, PultError> {
        let thread = runtime.store().get_thread(&thread_id)?;
        // Read the live-run id before the runs so a run finishing between the two
        // reads never looks like a zombie from a previous session.
        let active_run_id = runtime.active_run_for(&thread_id);
        let desired_mode = runtime.desired_mode(&thread_id);
        let desired_config = runtime.desired_config(&thread_id);
        let runs = runtime.store().list_runs(&thread_id)?;
        let mut events = runtime.store().load_thread_events(&thread_id)?;
        // Historical rows may predate the live payload caps (multi-MB tool
        // output / base64 images). Truncate before crossing IPC: opening such a
        // thread must never freeze the WebView.
        cap_ui_event_payloads(&mut events);
        let queue = runtime.store().list_queue(&thread_id)?;
        Ok(ThreadDetail {
            thread,
            runs,
            events,
            queue,
            active_run_id,
            desired_mode,
            desired_config,
        })
    })
    .await
    .map_err(|e| PultError::internal(format!("threads_get: {e}")))?
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
    // Stop a live run and let it release the process before touching the
    // worktree: Windows refuses to remove directories still held open.
    if let Some(run_id) = runtime.active_run_for(&thread_id) {
        let _ = runtime.cancel(&run_id);
        for _ in 0..40 {
            if runtime.active_run_for(&thread_id).is_none() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        // Still wedged: take the process down so the worktree can be removed.
        if runtime.active_run_for(&thread_id).is_some() {
            runtime.kill_run(&run_id);
            for _ in 0..20 {
                if runtime.active_run_for(&thread_id).is_none() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }
    }
    runtime.pool.invalidate_thread(&thread_id);
    // Panel shells are children of pult, not of the agent: without this they
    // keep the worktree open and the directory removal below fails.
    runtime.ptys().kill_thread(&thread_id);
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
    let _ = runtime
        .store()
        .delete_setting(&format!("thread_mode:{thread_id}"));
    let _ = runtime
        .store()
        .delete_setting(&format!("thread_config:{thread_id}"));
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
    mode: Option<String>,
    config_options: Option<crate::runtime::DesiredConfigMap>,
) -> Result<SendOutcome, PultError> {
    let thread = runtime.store().get_thread(&thread_id)?;
    if let Some(mode) = mode.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
        runtime.set_mode(&thread_id, mode)?;
    }
    runtime.clear_stale_provider_config(&thread_id, &instance_id)?;
    if let Some(config) = config_options.as_ref().filter(|c| !c.is_empty()) {
        runtime.merge_desired_config(&thread_id, config)?;
    }
    runtime.send(&thread, &text, &images, &instance_id)
}

/// Switches one session config option (model, thought level, toggle). Applies
/// to the live run and is remembered for the next one.
#[tauri::command]
pub async fn runs_set_config_option(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
    config_id: String,
    value: crate::protocol::types::ConfigOptionValue,
) -> Result<(), PultError> {
    runtime
        .set_config_option(&thread_id, &config_id, value)
        .await
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

#[tauri::command]
pub async fn providers_warmup(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    instance_id: String,
    workspace: Option<String>,
) -> Result<(), PultError> {
    runtime.warmup(&instance_id, workspace.as_deref()).await
}

/// One-click connect check (§4.3): spawn the agent, handshake, cache caps,
/// shut down. No prompt — free and session-safe.
#[tauri::command]
pub async fn providers_preflight(    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    instance_id: String,
) -> Result<crate::runtime::PreflightReport, PultError> {
    runtime.preflight(&instance_id).await
}

/// Usage insights: latest ACP usage snapshot per run, grouped honestly.
#[tauri::command]
pub async fn usage_report(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
) -> Result<crate::store::usage::UsageReport, PultError> {
    let store = Arc::clone(runtime.store());
    tokio::task::spawn_blocking(move || store.usage_report())
        .await
        .map_err(|e| PultError::internal(format!("usage query failed: {e}")))?
}
/// One-click sign-in: authenticate an agent-managed method, then re-probe the
/// session. Terminal methods are rejected by the runtime.
#[tauri::command]
pub async fn providers_authenticate(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    instance_id: String,
    method_id: String,
) -> Result<crate::runtime::PreflightReport, PultError> {
    runtime.authenticate(&instance_id, &method_id).await
}

/// Workspace files for composer `@` mentions: relative POSIX paths, filtered
/// by `query`, capped in count and walk size. The walk runs off the async
/// thread so a huge repo never stalls the IPC worker.
#[tauri::command]
pub async fn workspace_files(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: Option<String>,
    workspace: Option<String>,
    query: Option<String>,
) -> Result<Vec<String>, PultError> {
    let root = match workspace.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(ws) => std::path::PathBuf::from(ws)
            .canonicalize()
            .map_err(|e| PultError::internal(format!("workspace {ws} not found: {e}")))?,
        None => match thread_id.as_deref() {
            Some(id) => thread_git_dir(&runtime, id)?
                .canonicalize()
                .map_err(|e| PultError::internal(format!("workspace not found: {e}")))?,
            None => runtime.global_workspace_root()?,
        },
    };
    let query = query.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        crate::workspace::list_workspace_files(&root, &query, crate::workspace::MAX_RESULTS)
    })
    .await
    .map_err(|e| PultError::internal(format!("workspace walk failed: {e}")))?
}

/// Resolves the directory git operations run against for a thread: its
/// pinned workspace (worktree threads), else the global root.
fn thread_git_dir(
    runtime: &AgentRuntime,
    thread_id: &str,
) -> Result<std::path::PathBuf, PultError> {
    let thread = runtime.store().get_thread(thread_id)?;
    runtime.workspace_root_for(&thread)
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

/// Metadata-only diff rows for the panel (patch bodies load per file).
#[tauri::command]
pub async fn git_diff_summary(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
    base: Option<String>,
) -> Result<crate::git::GitDiffSummary, PultError> {
    let dir = thread_git_dir(&runtime, &thread_id)?;
    crate::git::diff_summary(&dir, base.as_deref()).await
}

/// One file's byte-exact patch, fetched when its row expands.
#[tauri::command]
pub async fn git_diff_file(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
    path: String,
    base: Option<String>,
) -> Result<crate::git::DiffFile, PultError> {
    let dir = thread_git_dir(&runtime, &thread_id)?;
    crate::git::diff_file(&dir, &path, base.as_deref()).await
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

/// External links (elicitation URL mode, PR links) may only be http(s). The
/// URL is passed as a single argv element, never through a shell.
pub fn validate_external_url(url: &str) -> Result<(), PultError> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err(PultError::internal("empty URL"));
    }
    if trimmed.len() > 2048 {
        return Err(PultError::internal("URL is too long"));
    }
    if trimmed.chars().any(|c| c.is_control() || c.is_whitespace() || c == '"' || c == '\'') {
        return Err(PultError::internal(
            "URL contains whitespace, quotes or control characters",
        ));
    }
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(PultError::internal(
            "only http(s) links can be opened in the browser",
        ));
    }
    Ok(())
}

/// Opens an http(s) link in the system browser (no in-app webview, no shell).
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), PultError> {
    validate_external_url(&url)?;
    let url = url.trim();
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("rundll32.exe");
        command.arg("url.dll,FileProtocolHandler").arg(url);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(url);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(url);
        command
    };
    command
        .spawn()
        .map_err(|e| PultError::internal(format!("could not open the browser: {e}")))?;
    Ok(())
}

/// Opens a project folder in the user's editor (Zed / VS Code / Cursor) or the
/// OS file manager. The path is canonicalized and passed as one argv element,
/// never through a shell. UNC paths are rejected before any SMB lookup.
#[tauri::command]
pub fn open_in_editor(path: String) -> Result<(), PultError> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err(PultError::internal("empty editor path"));
    }
    if raw.starts_with("\\\\") {
        return Err(PultError::internal("UNC paths are not allowed"));
    }
    let target = std::path::Path::new(raw)
        .canonicalize()
        .map_err(|e| PultError::internal(format!("editor path not found: {e}")))?;
    let target = crate::runtime::clean_verbatim(target);

    for editor in ["zed", "code", "cursor"] {
        let Some(command) = crate::config::resolve_command(editor) else {
            continue;
        };
        if std::process::Command::new(command).arg(&target).spawn().is_ok() {
            return Ok(());
        }
    }

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("explorer.exe");
        command.arg(&target);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(&target);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(&target);
        command
    };
    command
        .spawn()
        .map_err(|e| PultError::internal(format!("could not open the editor: {e}")))?;
    Ok(())
}

/// Reads a local raster image the agent referenced and returns a data URL.
/// Capped and restricted to common raster formats; remote URLs are not fetched.
#[tauri::command]
pub async fn read_image_data_url(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    path: String,
) -> Result<String, PultError> {
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(threads) = runtime.store().list_threads() {
        roots.extend(threads.into_iter().filter_map(|thread| thread.workspace.map(Into::into)));
    }
    if let Ok(projects) = runtime.store().list_projects() {
        roots.extend(projects.into_iter().map(|project| project.root_path.into()));
    }
    roots.push(crate::pult_home());
    tokio::task::spawn_blocking(move || {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        // Never touch UNC paths: canonicalize would open an SMB connection.
        if path.starts_with("\\\\") || path.starts_with("//") {
            return Err(PultError::internal("network image paths are not allowed"));
        }
        let canonical = std::path::PathBuf::from(&path)
            .canonicalize()
            .map_err(|e| PultError::internal(format!("image not found: {path} ({e})")))?;
        let allowed = roots
            .iter()
            .filter_map(|root| root.canonicalize().ok())
            .any(|root| canonical.starts_with(root));
        if !allowed {
            return Err(PultError::internal(
                "image is outside the project/thread workspace",
            ));
        }
        let meta = std::fs::metadata(&canonical)
            .map_err(|e| PultError::internal(format!("image not readable: {e}")))?;
        if !meta.is_file() || meta.len() > 8 * 1024 * 1024 {
            return Err(PultError::internal("image must be a file up to 8 MB"));
        }
        let mime = match canonical
            .extension()
            .and_then(|ext| ext.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("png") => "image/png",
            Some("jpg" | "jpeg") => "image/jpeg",
            Some("gif") => "image/gif",
            Some("webp") => "image/webp",
            _ => return Err(PultError::internal("unsupported image type")),
        };
        let bytes = std::fs::read(&canonical)
            .map_err(|e| PultError::internal(format!("image read failed: {e}")))?;
        Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
    })
    .await
    .map_err(|e| PultError::internal(format!("image read task failed: {e}")))?
}

#[cfg(test)]
mod external_url_tests {
    use super::validate_external_url;
    #[test]
    fn validate_external_url_allows_http_https_and_rejects_others() {
        assert!(validate_external_url("https://example.com/auth?a=1&b=2").is_ok());
        assert!(validate_external_url("  http://localhost:8080/callback  ").is_ok());
        assert!(validate_external_url("file:///C:/Windows").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
        assert!(validate_external_url("").is_err());
        assert!(validate_external_url("https://example.com/\nnext").is_err());
        assert!(validate_external_url("https://example.com/a b").is_err());
        assert!(validate_external_url("https://example.com/\"q\"").is_err());
    }
}

#[cfg(test)]
mod payload_cap_tests {
    use super::cap_ui_event_payloads;
    use crate::events::{Event, EventKind};

    #[test]
    fn caps_oversized_historical_payloads() {
        let mut events = vec![Event::new(
            "run-1".to_string(),
            1,
            EventKind::ToolCallUpdate {
                tool_call_id: "t".to_string(),
                status: Some("completed".to_string()),
                content: None,
                raw_output: Some(serde_json::json!({ "data": "A".repeat(2_000_001) })),
            },
        )];
        cap_ui_event_payloads(&mut events);
        match &events[0].kind {
            EventKind::ToolCallUpdate { raw_output, .. } => {
                assert_eq!(raw_output.as_ref().expect("payload")["truncated"], true);
            }
            other => panic!("unexpected kind: {other:?}"),
        }
    }
}
