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
    let mut workspace_value = match workspace
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
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
                let _ = crate::git::worktree_remove(std::path::Path::new(repo), name, true).await;
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
        parent_thread_id: None,
        parent_run_id: None,
        depth: 0,
        lineage_kind: None,
        child_role: None,
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
        return Err(PultError::with_code(
            "project.empty_name",
            "project name must not be empty",
        ));
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
            return Err(PultError::with_code(
                "project.empty_name",
                "project name must not be empty",
            ));
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
    runtime
        .pool
        .invalidate_root(&crate::runtime::clean_verbatim(std::path::PathBuf::from(
            &project.root_path,
        )));
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
    // The whole history crosses one IPC call: per-payload caps alone still let
    // 10k medium events freeze the WebView. Trim the oldest payloads until the
    // serialized history fits.
    const TOTAL_BUDGET: usize = 16_000_000;
    const TRIM_BYTES: usize = 4_096;
    for event in events.iter_mut() {
        cap_event_payloads(event, MAX_BYTES);
    }
    let mut sizes: Vec<usize> = events
        .iter()
        .map(|event| {
            serde_json::to_string(event)
                .map(|text| text.len())
                .unwrap_or(0)
        })
        .collect();
    let mut total: usize = sizes.iter().sum();
    if total > TOTAL_BUDGET {
        for (index, event) in events.iter_mut().enumerate() {
            if total <= TOTAL_BUDGET {
                break;
            }
            cap_event_payloads(event, TRIM_BYTES);
            let after = serde_json::to_string(event)
                .map(|text| text.len())
                .unwrap_or(0);
            total = total.saturating_sub(sizes[index].saturating_sub(after));
            sizes[index] = after;
        }
    }
}

fn cap_event_payloads(event: &mut crate::events::Event, max: usize) {
    fn cap_value(slot: &mut Option<serde_json::Value>, max: usize) {
        let Some(value) = slot else { return };
        let Ok(text) = serde_json::to_string(value) else {
            return;
        };
        if text.len() > max {
            *slot = Some(serde_json::json!({
                "truncated": true,
                "bytes": text.len(),
                "note": "large historical payload omitted",
            }));
        }
    }
    match &mut event.kind {
        crate::events::EventKind::ToolCall { raw_input, .. } => cap_value(raw_input, max),
        crate::events::EventKind::ToolCallUpdate {
            content,
            raw_output,
            ..
        } => {
            cap_value(content, max);
            cap_value(raw_output, max);
        }
        crate::events::EventKind::AgentMessageDelta { delta } => {
            if delta.len() > max {
                *delta = "\n\n_(large generated payload omitted)_\n\n".to_string();
            }
        }
        crate::events::EventKind::AgentThoughtDelta { delta } => {
            if delta.len() > max {
                *delta = "_(large thought payload omitted)_".to_string();
            }
        }
        crate::events::EventKind::UserMessage { images, .. } => {
            images.retain(|image| image.data.len() <= max);
        }
        crate::events::EventKind::FileChanged { diff, .. } if diff.len() > max => {
            *diff = "_(diff too large to display)_".to_string();
        }
        _ => {}
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

/// Uncommitted state of a thread's worktree (None when it has no worktree).
#[tauri::command]
pub async fn threads_worktree_status(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
) -> Result<Option<crate::git::WorktreeDirtyStatus>, PultError> {
    let thread = runtime.store().get_thread(&thread_id)?;
    let Some((repo, name)) = thread
        .main_repo
        .as_deref()
        .zip(thread.worktree_name.as_deref())
    else {
        return Ok(None);
    };
    let path = std::path::Path::new(repo)
        .join(".pult")
        .join("worktrees")
        .join(name);
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(crate::git::worktree_dirty_status(&path).await?))
}

/// Deletes a thread. `worktree_mode`: `"keep"` leaves the worktree on disk,
/// `"force_remove"` discards its files, omitted/`"safe"` refuses to delete a
/// dirty worktree (the row is kept so the files stay reachable).
#[tauri::command]
pub async fn threads_delete(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
    worktree_mode: Option<String>,
) -> Result<(), PultError> {
    runtime.begin_delete_thread(&thread_id);
    let result = threads_delete_inner(&runtime, &thread_id, worktree_mode.as_deref()).await;
    runtime.finish_delete_thread(&thread_id);
    result
}

async fn threads_delete_inner(
    runtime: &Arc<AgentRuntime>,
    thread_id: &str,
    worktree_mode: Option<&str>,
) -> Result<(), PultError> {
    // Stop a live run and let it release the process before touching the
    // worktree: Windows refuses to remove directories still held open.
    runtime.orchestrator.cancel_subtree(thread_id, true);
    // Parked child sessions (and their bearers) belong to this tree too.
    let descendants = runtime.orchestrator.descendant_thread_ids(thread_id);
    for child in &descendants {
        runtime.pool.invalidate_thread(child);
    }
    if let Some(run_id) = runtime.active_run_for(thread_id) {
        let _ = runtime.cancel(&run_id);
        for _ in 0..40 {
            if runtime.active_run_for(thread_id).is_none() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        // Still wedged: take the process down so the worktree can be removed.
        if runtime.active_run_for(thread_id).is_some() {
            runtime.kill_run(&run_id);
            for _ in 0..20 {
                if runtime.active_run_for(thread_id).is_none() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }
    }
    runtime.pool.invalidate_thread(thread_id);
    // Panel shells are children of pult, not of the agent: without this they
    // keep the worktree open and the directory removal below fails.
    runtime.ptys().kill_thread(thread_id);
    if worktree_mode != Some("keep") {
        let parent_worktree = runtime
            .store()
            .get_thread(thread_id)
            .ok()
            .and_then(|thread| thread.worktree_name);
        // Child worktrees are separate checkouts: deleting the parent row
        // would otherwise strand them on disk with no handle in the UI.
        // `shared` children point at the parent's worktree and are skipped.
        for child in &descendants {
            let Ok(thread) = runtime.store().get_thread(child) else {
                continue;
            };
            if thread.worktree_name == parent_worktree {
                continue;
            }
            if let (Some(main_repo), Some(name)) = (&thread.main_repo, &thread.worktree_name) {
                let force = worktree_mode == Some("force_remove");
                if let Err(err) =
                    crate::git::worktree_remove(std::path::Path::new(main_repo), name, force).await
                {
                    if err.code() == "git.worktree_dirty" {
                        return Err(err);
                    }
                    tracing::warn!(target: "pult::ipc", thread_id = %child,
                        error = %err, "child worktree cleanup failed; deleting anyway");
                }
            }
        }
        if let Ok(thread) = runtime.store().get_thread(thread_id) {
            // A `shared` child has no worktree of its own: its name matches
            // the parent's. Deleting the child must not delete the parent.
            let shared_with_parent = thread
                .parent_thread_id
                .as_deref()
                .and_then(|parent_id| runtime.store().get_thread(parent_id).ok())
                .is_some_and(|parent| parent.worktree_name == thread.worktree_name);
            if !shared_with_parent {
                if let (Some(main_repo), Some(name)) = (&thread.main_repo, &thread.worktree_name) {
                    let force = worktree_mode == Some("force_remove");
                    if let Err(err) =
                        crate::git::worktree_remove(std::path::Path::new(main_repo), name, force)
                            .await
                    {
                        // Never delete the row while the user's worktree files remain:
                        // the thread is the only handle back to them.
                        if err.code() == "git.worktree_dirty" {
                            return Err(err);
                        }
                        tracing::warn!(target: "pult::ipc", thread_id = %thread_id,
                        error = %err, "worktree cleanup failed; deleting thread anyway");
                    }
                }
            }
        }
    }
    runtime.store().delete_thread(thread_id)?;
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
    runtime.clear_stale_provider_config(&thread_id, &instance_id)?;
    let mode = mode
        .map(|mode| mode.trim().to_string())
        .filter(|mode| !mode.is_empty());
    let config = config_options.unwrap_or_default();
    runtime.send(
        &thread,
        &text,
        &images,
        &instance_id,
        mode.as_deref(),
        &config,
    )
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
pub fn runs_queue_update(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
    queue_id: String,
    text: String,
) -> Result<(), PultError> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err(PultError::with_code(
            "queue.empty_message",
            "queue message cannot be empty",
        ));
    }
    runtime.store().update_queue_item_text(&queue_id, &text)?;
    runtime.emit_queue_updated(&thread_id);
    Ok(())
}

#[tauri::command]
pub fn runs_queue_reorder(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
    queue_ids: Vec<String>,
) -> Result<(), PultError> {
    runtime
        .store()
        .reorder_queue_items(&thread_id, &queue_ids)?;
    runtime.emit_queue_updated(&thread_id);
    Ok(())
}

#[tauri::command]
pub async fn runs_queue_steer(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
    queue_id: String,
) -> Result<(), PultError> {
    runtime.steer(&thread_id, &queue_id)
}

#[tauri::command]
pub async fn runs_cancel(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    run_id: String,
    force: Option<bool>,
) -> Result<(), PultError> {
    runtime.cancel_with_force(&run_id, force.unwrap_or(false))
}

/// Persisted allow_always decisions, for the Settings revoke list.
#[tauri::command]
pub fn permissions_remembered_list(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
) -> Vec<crate::runtime::RememberedPermission> {
    runtime.list_remembered_permissions()
}

/// Revokes remembered permissions; omitted filters clear everything.
#[tauri::command]
pub fn permissions_remembered_clear(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    workspace: Option<String>,
    instance_id: Option<String>,
    tool_kind: Option<String>,
) -> Result<(), PultError> {
    runtime.clear_remembered_permission(
        workspace.as_deref(),
        instance_id.as_deref(),
        tool_kind.as_deref(),
    )
}

/// config.toml read/parse failure (None when the file is healthy/missing).
#[tauri::command]
pub fn providers_config_status(runtime: tauri::State<'_, Arc<AgentRuntime>>) -> Option<String> {
    runtime.config_error()
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
    let mode: crate::runtime::permissions::PermissionMode =
        serde_json::from_value(serde_json::Value::String(mode))
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

/// Installs a known provider CLI globally through npm (fixed package map).
#[tauri::command]
pub async fn providers_install(provider: String) -> Result<String, PultError> {
    let package = match provider.as_str() {
        "claude-code" | "claude" => "@anthropic-ai/claude-code",
        "codex" => "@openai/codex",
        "gemini-cli" | "gemini" => "@google/gemini-cli",
        _ => {
            return Err(PultError::with_code(
                "provider.install_unsupported",
                format!("no automatic installer for {provider}"),
            ));
        }
    };
    #[cfg(windows)]
    let mut command = {
        let mut command = tokio::process::Command::new("cmd.exe");
        command.args(["/d", "/s", "/c", &format!("npm install -g {package}")]);
        command.creation_flags(0x0800_0000);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = tokio::process::Command::new("npm");
        command.args(["install", "-g", package]);
        command
    };
    let output = tokio::time::timeout(std::time::Duration::from_secs(600), command.output())
        .await
        .map_err(|_| PultError::with_code("provider.install_timeout", "npm install timed out"))?
        .map_err(|e| PultError::internal(format!("npm install failed to start: {e}")))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(PultError::with_code(
            "provider.install_failed",
            format!("npm install {package} failed:\n{stderr}\n{stdout}"),
        ));
    }
    Ok(format!("{stdout}\n{stderr}").trim().to_string())
}

/// Opens the provider's interactive login in a visible terminal (Claude now).
#[tauri::command]
pub fn providers_login(provider: String) -> Result<(), PultError> {
    if provider != "claude" && provider != "claude-code" {
        return Err(PultError::with_code(
            "provider.login_unsupported",
            format!("no interactive login helper for {provider}"),
        ));
    }
    #[cfg(windows)]
    {
        std::process::Command::new("cmd.exe")
            .args([
                "/d",
                "/s",
                "/c",
                "start",
                "cmd.exe",
                "/k",
                "claude auth login",
            ])
            .spawn()
            .map_err(|e| PultError::internal(format!("could not open Claude login: {e}")))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err(PultError::with_code(
            "provider.login_terminal",
            "run `claude auth login` in a terminal",
        ))
    }
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

#[tauri::command]
pub fn diagnostics_process_tree() -> Result<Vec<crate::processes::ProcessNode>, PultError> {
    Ok(crate::processes::process_tree())
}

#[tauri::command]
pub fn diagnostics_kill_process(pid: u32) -> Result<(), PultError> {
    crate::processes::kill_process(pid)
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
pub async fn providers_preflight(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
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
    let root = match workspace
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
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
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data.as_bytes())
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
        return Err(PultError::with_code("url.empty", "empty URL"));
    }
    if trimmed.len() > 2048 {
        return Err(PultError::with_code("url.too_long", "URL is too long"));
    }
    if trimmed
        .chars()
        .any(|c| c.is_control() || c.is_whitespace() || c == '"' || c == '\'')
    {
        return Err(PultError::internal(
            "URL contains whitespace, quotes or control characters",
        ));
    }
    let lower = trimmed.to_ascii_lowercase();
    let rest = if let Some(rest) = lower.strip_prefix("https://") {
        rest
    } else if let Some(rest) = lower.strip_prefix("http://") {
        rest
    } else {
        return Err(PultError::internal(
            "only http(s) links can be opened in the browser",
        ));
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() || host.starts_with(':') {
        return Err(PultError::with_code("url.no_host", "URL has no host"));
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
        // explorer.exe launches the default browser without cmd/PowerShell
        // mangling query strings or percent escapes.
        let mut command = std::process::Command::new("explorer.exe");
        command.arg(url);
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
pub fn open_in_editor(path: String, editor: Option<String>) -> Result<(), PultError> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err(PultError::with_code(
            "editor.empty_path",
            "empty editor path",
        ));
    }
    if raw.starts_with("\\\\") || raw.starts_with("//") {
        return Err(PultError::with_code(
            "editor.unc_blocked",
            "UNC paths are not allowed",
        ));
    }
    let target = std::path::Path::new(raw)
        .canonicalize()
        .map_err(|e| PultError::internal(format!("editor path not found: {e}")))?;
    let target = crate::runtime::clean_verbatim(target);

    // Allowlisted editors only; no user-provided executable names.
    let requested = editor.as_deref().unwrap_or("").to_ascii_lowercase();
    let editors: &[&str] = match requested.as_str() {
        "zed" => &["zed"],
        "vscode" => &["code", "cursor"],
        "antigravity" => &["antigravity", "agy"],
        "explorer" => &[],
        _ => &["zed", "code", "cursor"],
    };
    for name in editors {
        let Some(command) = crate::config::resolve_command(name) else {
            continue;
        };
        if std::process::Command::new(command)
            .arg(&target)
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
    }

    #[cfg(target_os = "windows")]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new("explorer.exe");
        if requested == "explorer" && target.is_file() {
            // Explorer needs /select,"path" as one raw token; normal arg
            // quoting puts the quote before /select.
            command.raw_arg(format!("/select,\"{}\"", target.display()));
        } else {
            command.arg(&target);
        }
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

const TREE_IGNORE: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    ".next",
    ".cache",
    ".superpowers",
];

const MAX_TREE_ENTRIES: usize = 2000;
const MAX_TREE_DEPTH: usize = 6;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTree {
    pub entries: Vec<WorkspaceEntry>,
    pub truncated: bool,
}

fn ignored(name: &str) -> bool {
    TREE_IGNORE.contains(&name)
}

/// Directory probes are bounded so a deep tree cannot stall the tree command.
const MAX_PROBE_DIRS: usize = 512;

/// True when a cut subtree still contains a file the user would see.
fn has_visible_content(dir: &std::path::Path) -> bool {
    has_visible_content_with_budget(dir, MAX_PROBE_DIRS)
}

/// Iterative probe; exhausting the budget counts as visible, since the tree is
/// truncated either way and a false negative would hide the notice.
fn has_visible_content_with_budget(dir: &std::path::Path, max_dirs: usize) -> bool {
    let mut stack = vec![dir.to_path_buf()];
    let mut visited = 0usize;
    while let Some(current) = stack.pop() {
        if visited >= max_dirs {
            return true;
        }
        visited += 1;
        let Ok(read) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if ignored(&name) {
                continue;
            }
            match entry.file_type() {
                Ok(kind) if kind.is_file() => return true,
                Ok(kind) if kind.is_dir() => stack.push(entry.path()),
                _ => {}
            }
        }
    }
    false
}

fn walk_workspace(root: &std::path::Path) -> Result<WorkspaceTree, PultError> {
    walk_workspace_with_limits(root, MAX_TREE_ENTRIES, MAX_TREE_DEPTH)
}

fn walk_workspace_with_limits(
    root: &std::path::Path,
    max_entries: usize,
    max_depth: usize,
) -> Result<WorkspaceTree, PultError> {
    let mut out = Vec::new();
    let mut truncated = false;
    #[allow(clippy::too_many_arguments)]
    fn visit(
        root: &std::path::Path,
        dir: &std::path::Path,
        depth: usize,
        max_entries: usize,
        max_depth: usize,
        out: &mut Vec<WorkspaceEntry>,
        truncated: &mut bool,
    ) {
        if *truncated {
            return;
        }
        if depth > max_depth {
            *truncated = has_visible_content(dir);
            return;
        }
        let Ok(read) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = read.flatten().collect();
        entries.sort_by_key(|entry| {
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            (!is_dir, entry.file_name().to_string_lossy().to_lowercase())
        });
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            if ignored(&name) {
                continue;
            }
            if out.len() >= max_entries {
                *truncated = true;
                return;
            }
            let path = entry.path();
            let rel = path.strip_prefix(root).unwrap_or(&path);
            let rel = rel.to_string_lossy().replace('\\', "/");
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(WorkspaceEntry {
                path: rel,
                name,
                is_dir,
                size,
            });
            if is_dir {
                visit(
                    root,
                    &path,
                    depth + 1,
                    max_entries,
                    max_depth,
                    out,
                    truncated,
                );
            }
        }
    }
    visit(
        root,
        root,
        1,
        max_entries,
        max_depth,
        &mut out,
        &mut truncated,
    );
    Ok(WorkspaceTree {
        entries: out,
        truncated,
    })
}

/// Lists a thread workspace (flattened, ignored build dirs, capped).
#[tauri::command]
pub async fn workspace_tree(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
) -> Result<WorkspaceTree, PultError> {
    let runtime = runtime.inner().clone();
    tokio::task::spawn_blocking(move || {
        let thread = runtime.store().get_thread(&thread_id)?;
        let root = runtime.workspace_root_for(&thread)?;
        walk_workspace(&root)
    })
    .await
    .map_err(|e| PultError::internal(format!("workspace tree failed: {e}")))?
}

/// Absolute root used for threads without a project (`PULT_WORKSPACE` or `~/pult-workspace`).
#[tauri::command]
pub fn workspace_global_root(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
) -> Result<String, PultError> {
    runtime
        .global_workspace_root()
        .map(|root| root.to_string_lossy().into_owned())
}

/// Reads a UTF-8 text file from the thread workspace for the Files preview.
#[tauri::command]
pub async fn workspace_read_text(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
    path: String,
) -> Result<String, PultError> {
    let runtime = runtime.inner().clone();
    tokio::task::spawn_blocking(move || {
        let thread = runtime.store().get_thread(&thread_id)?;
        let root = runtime.workspace_root_for(&thread)?;
        let base = root
            .canonicalize()
            .map_err(|e| PultError::internal(format!("workspace: {e}")))?;
        if path.starts_with("\\\\")
            || path.starts_with("//")
            || std::path::Path::new(&path).is_absolute()
        {
            return Err(PultError::with_code(
                "workspace.path_escapes",
                "path escapes workspace",
            ));
        }
        let target = base.join(&path);
        let target = target
            .canonicalize()
            .map_err(|e| PultError::internal(format!("file not found: {e}")))?;
        if !target.starts_with(&base) || !target.is_file() {
            return Err(PultError::with_code(
                "workspace.path_escapes",
                "path escapes workspace",
            ));
        }
        let meta = std::fs::metadata(&target)
            .map_err(|e| PultError::internal(format!("file not readable: {e}")))?;
        if meta.len() > 512 * 1024 {
            return Err(PultError::with_code(
                "file.too_large",
                "file is too large to preview (max 512 KB)",
            ));
        }
        let bytes = std::fs::read(&target)
            .map_err(|e| PultError::internal(format!("file not readable: {e}")))?;
        if bytes.contains(&0) {
            return Err(PultError::with_code(
                "file.binary",
                "binary file cannot be previewed as text",
            ));
        }
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })
    .await
    .map_err(|e| PultError::internal(format!("read text failed: {e}")))?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUpdate {
    pub instance_id: String,
    pub display_name: String,
    pub package: Option<String>,
    pub current: Option<String>,
    pub latest: Option<String>,
    pub managed: bool,
}

fn npm_command(args: &[&str]) -> std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new("cmd");
        command.args(["/c", "npm"]);
        command.args(args);
        command.creation_flags(0x0800_0000);
        command
    }
    #[cfg(not(windows))]
    {
        let mut command = std::process::Command::new("npm");
        command.args(args);
        command
    }
}

/// Which self-updater a configured agent has (no package replacement).
fn update_kind(instance: &crate::config::InstanceSpec) -> Option<&'static str> {
    let haystack = format!(
        "{} {} {}",
        instance.id, instance.display_name, instance.command
    )
    .to_ascii_lowercase();
    if haystack.contains("codex") {
        Some("codex")
    } else if haystack.contains("opencode") {
        Some("opencode")
    } else {
        None
    }
}

fn run_cli(program: &str, args: &[&str]) -> Result<std::process::Output, String> {
    let Some(resolved) = crate::config::resolve_command(program) else {
        return Err(format!("{program} not found on PATH"));
    };
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new("cmd");
        command.args(["/d", "/c"]).arg(&resolved).args(args);
        command.creation_flags(0x0800_0000);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = std::process::Command::new(&resolved);
        command.args(args);
        command
    };
    command
        .output()
        .map_err(|e| format!("{program} failed: {e}"))
}

fn cli_version(program: &str) -> Option<String> {
    let output = run_cli(program, &["--version"]).ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.split_whitespace()
        .last()
        .map(|value| value.trim_start_matches('v').to_string())
}

fn npm_latest(package: &str) -> Option<String> {
    let output = npm_command(&["view", package, "version"]).output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn opencode_latest() -> Option<String> {
    let output = std::process::Command::new("curl")
        .args([
            "-L",
            "-s",
            "-H",
            "User-Agent: pult",
            "https://api.github.com/repos/sst/opencode/releases/latest",
        ])
        .output()
        .ok()?;
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    value
        .get("tag_name")?
        .as_str()
        .map(|tag| tag.trim_start_matches('v').to_string())
}

/// Checks the CLI's own update source; never reinstalls packages.
#[tauri::command]
pub async fn providers_update_check(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
) -> Result<Vec<ProviderUpdate>, PultError> {
    let instances = runtime.instances_spec();
    tokio::task::spawn_blocking(move || {
        let mut updates = Vec::new();
        for instance in instances {
            let Some(kind) = update_kind(&instance) else {
                continue;
            };
            let (current, latest, package) = match kind {
                "codex" => (
                    cli_version("codex"),
                    npm_latest("@openai/codex"),
                    "@openai/codex",
                ),
                "opencode" => (cli_version("opencode"), opencode_latest(), "opencode"),
                _ => continue,
            };
            if latest.is_none() || current == latest {
                continue;
            }
            updates.push(ProviderUpdate {
                instance_id: instance.id,
                display_name: instance.display_name,
                package: Some(package.to_string()),
                current,
                latest,
                managed: true,
            });
        }
        Ok(updates)
    })
    .await
    .map_err(|e| PultError::internal(format!("update check failed: {e}")))?
}

/// Runs the provider's own updater (`codex update` / `opencode upgrade`).
#[tauri::command]
pub async fn providers_update_install(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    instance_id: String,
) -> Result<(), PultError> {
    let instances = runtime.instances_spec();
    let instance = instances
        .iter()
        .find(|instance| instance.id == instance_id)
        .ok_or_else(|| PultError::with_code("provider.unknown", "unknown instance"))?
        .clone();
    tokio::task::spawn_blocking(move || {
        let kind = update_kind(&instance).ok_or_else(|| {
            PultError::with_code(
                "provider.managed_externally",
                "this provider is managed externally",
            )
        })?;
        let args: &[&str] = match kind {
            "codex" => &["update"],
            "opencode" => &["upgrade"],
            _ => {
                return Err(PultError::with_code(
                    "provider.managed_externally",
                    "this provider is managed externally",
                ))
            }
        };
        let output = run_cli(kind, args).map_err(PultError::internal)?;
        if !output.status.success() {
            return Err(PultError::internal(format!(
                "{} update failed: {}",
                kind,
                String::from_utf8_lossy(&output.stderr)
            )));
        }
        Ok(())
    })
    .await
    .map_err(|e| PultError::internal(format!("update install failed: {e}")))?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTarget {
    pub kind: String,
    pub target: String,
}

fn validate_browser_target(target: &str) -> Result<BrowserTarget, PultError> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return Err(PultError::with_code("url.empty", "empty browser target"));
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        validate_external_url(trimmed)?;
        return Ok(BrowserTarget {
            kind: "url".to_string(),
            target: trimmed.to_string(),
        });
    }
    if lower.starts_with("javascript:")
        || lower.starts_with("data:")
        || lower.starts_with("vbscript:")
        || lower.starts_with("file:")
        || trimmed.starts_with("\\\\")
        || trimmed.starts_with("//")
        || std::path::Path::new(trimmed).is_absolute()
        || trimmed.split(['/', '\\']).any(|part| part == "..")
        || !(lower.ends_with(".html") || lower.ends_with(".htm"))
    {
        return Err(PultError::internal(
            "only http(s) URLs or workspace HTML files can be previewed",
        ));
    }
    Ok(BrowserTarget {
        kind: "file".to_string(),
        target: trimmed.to_string(),
    })
}

#[tauri::command]
pub fn browser_validate_target(target: String) -> Result<BrowserTarget, PultError> {
    validate_browser_target(&target)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedCheck {
    pub embeddable: bool,
    pub reason: Option<String>,
}

#[tauri::command]
pub async fn browser_check_frame_headers(url: String) -> Result<EmbedCheck, PultError> {
    tokio::task::spawn_blocking(move || check_frame_headers(&url))
        .await
        .map_err(|e| PultError::internal(format!("header check failed: {e}")))?
}

fn parse_frame_headers(raw: &str) -> EmbedCheck {
    let headers = raw.replace("\r\n", "\n").to_ascii_lowercase();
    // Follow redirects and inspect the final response block only.
    let final_block = headers
        .split("\n\n")
        .filter(|block| !block.is_empty())
        .last()
        .unwrap_or("");
    let xfo = final_block
        .lines()
        .find(|line| line.starts_with("x-frame-options:"))
        .unwrap_or("");
    if xfo.contains("deny") || xfo.contains("sameorigin") {
        return EmbedCheck {
            embeddable: false,
            reason: Some("Blocked by X-Frame-Options".to_string()),
        };
    }
    let csp = final_block
        .lines()
        .find(|line| {
            line.starts_with("content-security-policy:") && line.contains("frame-ancestors")
        })
        .unwrap_or("");
    let mut allowed = true;
    if !csp.is_empty() {
        let directive = csp
            .split("frame-ancestors")
            .nth(1)
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim();
        allowed = directive.split_whitespace().any(|token| token == "*");
    }
    if !allowed {
        return EmbedCheck {
            embeddable: false,
            reason: Some("Blocked by Content-Security-Policy frame-ancestors".to_string()),
        };
    }
    EmbedCheck {
        embeddable: true,
        reason: None,
    }
}

fn check_frame_headers(url: &str) -> Result<EmbedCheck, PultError> {
    validate_external_url(url)?;
    let output = std::process::Command::new("curl")
        .args(["-sIL", "--max-time", "5", url])
        .output();
    let Ok(output) = output else {
        return Ok(EmbedCheck {
            embeddable: true,
            reason: None,
        });
    };
    Ok(parse_frame_headers(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

/// Reads an HTML file from the thread workspace for the browser surface.
#[tauri::command]
pub async fn workspace_read_html(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
    path: String,
) -> Result<String, PultError> {
    workspace_read_text(runtime, thread_id, path).await
}

/// Pult's own update, distinct from provider/agent updates.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub current_version: String,
    pub version: String,
    pub body: Option<String>,
}

fn updater_for(app: &tauri::AppHandle) -> Result<tauri_plugin_updater::Updater, PultError> {
    use tauri_plugin_updater::UpdaterExt;

    let mut builder = app.updater_builder();
    let override_endpoint = std::env::var("PULT_UPDATE_ENDPOINT")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if let Some(endpoint) = override_endpoint {
        let url = endpoint
            .parse()
            .map_err(|e| PultError::internal(format!("bad update endpoint: {e}")))?;
        builder = builder
            .endpoints(vec![url])
            .map_err(|e| PultError::internal(format!("bad update endpoint: {e}")))?;
    } else if let Ok(config) = serde_json::to_value(&app.config().plugins) {
        let endpoint = config
            .get("updater")
            .and_then(|value| value.get("endpoints"))
            .and_then(|value| value.get(0))
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if endpoint.contains("OWNER") || endpoint.contains("releases.pult.local") {
            return Err(PultError::with_code(
                "updater.unconfigured",
                "set the GitHub releases endpoint or PULT_UPDATE_ENDPOINT",
            ));
        }
    }
    builder
        .build()
        .map_err(|e| PultError::internal(format!("updater unavailable: {e}")))
}

#[tauri::command]
pub async fn app_update_check(app: tauri::AppHandle) -> Result<Option<AppUpdateInfo>, PultError> {
    let updater = updater_for(&app)?;
    let update = updater
        .check()
        .await
        .map_err(|e| PultError::internal(format!("update check failed: {e}")))?;
    Ok(update.map(|update| AppUpdateInfo {
        current_version: update.current_version,
        version: update.version,
        body: update.body,
    }))
}

#[tauri::command]
pub async fn app_update_install(app: tauri::AppHandle) -> Result<(), PultError> {
    use tauri::Emitter;

    let updater = updater_for(&app)?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|e| PultError::internal(format!("update check failed: {e}")))?
    else {
        return Ok(());
    };
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now() - std::time::Duration::from_secs(1);
    let progress_app = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                if last_emit.elapsed() >= std::time::Duration::from_millis(50) {
                    last_emit = std::time::Instant::now();
                    let _ = progress_app.emit(
                        "app:updateProgress",
                        serde_json::json!({ "downloaded": downloaded, "total": total }),
                    );
                }
            },
            || {},
        )
        .await
        .map_err(|e| PultError::internal(format!("update install failed: {e}")))?;
    app.restart();
}

/// Reads a local raster image the agent referenced and returns a data URL.
/// Capped and restricted to common raster formats; remote URLs are not fetched.
#[tauri::command]
pub fn app_notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), PultError> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| PultError::internal(format!("notification failed: {e}")))
}

#[tauri::command]
pub async fn read_image_data_url(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    path: String,
    thread_id: Option<String>,
) -> Result<String, PultError> {
    // Full access already lets the agent read these files itself; the display
    // restriction exists to protect supervised/auto threads, not to hide the
    // agent's own screenshots.
    let full_access = thread_id
        .as_deref()
        .map(|id| {
            runtime.permission_mode_for(id)
                == crate::runtime::permissions::PermissionMode::FullAccess
        })
        .unwrap_or(false);
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(threads) = runtime.store().list_threads() {
        roots.extend(
            threads
                .into_iter()
                .filter_map(|thread| thread.workspace.map(Into::into)),
        );
    }
    if let Ok(projects) = runtime.store().list_projects() {
        roots.extend(projects.into_iter().map(|project| project.root_path.into()));
    }
    if let Ok(global) = runtime.global_workspace_root() {
        roots.push(global);
    }
    roots.push(crate::pult_home());
    tokio::task::spawn_blocking(move || {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        // Never touch UNC paths: canonicalize would open an SMB connection.
        if path.starts_with("\\\\") || path.starts_with("//") {
            return Err(PultError::with_code(
                "image.unc_blocked",
                "network image paths are not allowed",
            ));
        }
        let canonical = std::path::PathBuf::from(&path)
            .canonicalize()
            .map_err(|e| PultError::internal(format!("image not found: {path} ({e})")))?;
        let allowed = roots
            .iter()
            .filter_map(|root| root.canonicalize().ok())
            .any(|root| canonical.starts_with(root));
        if !allowed && !full_access {
            return Err(PultError::internal(
                "image is outside the project/thread workspace",
            ));
        }
        let meta = std::fs::metadata(&canonical)
            .map_err(|e| PultError::internal(format!("image not readable: {e}")))?;
        if !meta.is_file() || meta.len() > 8 * 1024 * 1024 {
            return Err(PultError::with_code(
                "image.too_large",
                "image must be a file up to 8 MB",
            ));
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
            _ => {
                return Err(PultError::with_code(
                    "image.unsupported_type",
                    "unsupported image type",
                ))
            }
        };
        let bytes = std::fs::read(&canonical)
            .map_err(|e| PultError::internal(format!("image read failed: {e}")))?;
        Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
    })
    .await
    .map_err(|e| PultError::internal(format!("image read task failed: {e}")))?
}

#[tauri::command]
pub fn orchestrator_tasks_list(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
) -> Result<Vec<crate::store::records::DelegatedTaskRecord>, PultError> {
    runtime.store().list_delegated_tasks(&thread_id)
}

#[tauri::command]
pub fn orchestrator_cancel_task(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    task_id: String,
    force: Option<bool>,
) -> Result<serde_json::Value, PultError> {
    runtime
        .orchestrator
        .cancel_task_admin(&task_id, force.unwrap_or(false))
        .map_err(PultError::internal)
}

/// Stop button on the parent chat: children and grandchildren go first.
#[tauri::command]
pub fn orchestrator_cancel_all(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
    force: Option<bool>,
) -> Result<(), PultError> {
    runtime
        .orchestrator
        .cancel_subtree(&thread_id, force.unwrap_or(false));
    Ok(())
}

#[tauri::command]
pub fn orchestrator_retry_task(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    task_id: String,
) -> Result<serde_json::Value, PultError> {
    runtime
        .orchestrator
        .retry_task(&task_id)
        .map_err(PultError::internal)
}

#[tauri::command]
pub fn orchestrator_steer_task(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    task_id: String,
    message: String,
) -> Result<serde_json::Value, PultError> {
    runtime
        .orchestrator
        .steer_task_admin(&task_id, &message)
        .map_err(PultError::internal)
}

// ---- user MCP servers -------------------------------------------------------

#[tauri::command]
pub fn mcp_list_servers(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
) -> Result<Vec<crate::mcp::config::CustomMcpServerView>, PultError> {
    crate::mcp::config::list(runtime.store())
}

#[tauri::command]
pub fn mcp_get_server(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    id: String,
) -> Result<crate::mcp::config::CustomMcpServerView, PultError> {
    crate::mcp::config::get(runtime.store(), &id)
}

#[tauri::command]
pub async fn mcp_create_server(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    input: crate::mcp::config::CustomMcpServerInput,
) -> Result<crate::mcp::config::CustomMcpServerView, PultError> {
    let runtime = runtime.inner().clone();
    let server = crate::mcp::config::create(runtime.store(), input)?;
    runtime.custom_mcp_changed(&server.id).await;
    Ok(server)
}

#[tauri::command]
pub async fn mcp_update_server(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    id: String,
    input: crate::mcp::config::CustomMcpServerInput,
) -> Result<crate::mcp::config::CustomMcpServerView, PultError> {
    let runtime = runtime.inner().clone();
    let server = crate::mcp::config::update(runtime.store(), &id, input)?;
    runtime.custom_mcp_changed(&server.id).await;
    Ok(server)
}

#[tauri::command]
pub async fn mcp_delete_server(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    id: String,
) -> Result<(), PultError> {
    let runtime = runtime.inner().clone();
    crate::mcp::config::delete(runtime.store(), &id)?;
    runtime.custom_mcp_changed(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn mcp_set_server_enabled(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    id: String,
    enabled: bool,
) -> Result<crate::mcp::config::CustomMcpServerView, PultError> {
    let runtime = runtime.inner().clone();
    let server = crate::mcp::config::set_enabled(runtime.store(), &id, enabled)?;
    runtime.custom_mcp_changed(&id).await;
    Ok(server)
}

#[tauri::command]
pub async fn mcp_test_connection(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    id: String,
) -> Result<crate::mcp::probe::ProbeResult, PultError> {
    let runtime = runtime.inner().clone();
    let server = runtime.store().get_custom_mcp_server(&id)?;
    let result = crate::mcp::probe::test_connection(runtime.store(), &server).await;
    if !result.ok {
        if let Some(gateway) = runtime.gateway.get() {
            gateway.drop_client(&id).await;
        }
    }
    Ok(result)
}

/// Drops the cached upstream (tokens stay valid for live sessions) and probes
/// a fresh connection, so Diagnostics can recover a crashed server.
#[tauri::command]
pub async fn mcp_reconnect_server(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    id: String,
) -> Result<crate::mcp::probe::ProbeResult, PultError> {
    let runtime = runtime.inner().clone();
    let server = runtime.store().get_custom_mcp_server(&id)?;
    if let Some(gateway) = runtime.gateway.get() {
        gateway.drop_client(&id).await;
    }
    let result = crate::mcp::probe::test_connection(runtime.store(), &server).await;
    if !result.ok {
        if let Some(gateway) = runtime.gateway.get() {
            gateway.drop_client(&id).await;
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn mcp_server_logs(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    id: String,
) -> Result<Vec<String>, PultError> {
    Ok(match runtime.gateway.get() {
        Some(gateway) => gateway.logs(&id).await,
        None => Vec::new(),
    })
}

#[tauri::command]
pub async fn mcp_server_stats(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    id: String,
) -> Result<crate::mcp::gateway::GatewayStats, PultError> {
    Ok(match runtime.gateway.get() {
        Some(gateway) => gateway.stats(&id).await,
        None => Default::default(),
    })
}

#[tauri::command]
pub async fn mcp_check_all(runtime: tauri::State<'_, Arc<AgentRuntime>>) -> Result<(), PultError> {
    let runtime = runtime.inner().clone();
    crate::mcp::manager::check_all(Arc::clone(runtime.store())).await;
    Ok(())
}

#[tauri::command]
pub async fn mcp_import_json(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    json: String,
) -> Result<Vec<crate::mcp::import_export::ImportOutcome>, PultError> {
    let runtime = runtime.inner().clone();
    let outcomes = crate::mcp::import_export::import_json(runtime.store(), &json).await?;
    if outcomes.iter().any(|outcome| outcome.status == "imported") {
        runtime.bump_mcp_generation();
    }
    Ok(outcomes)
}

#[tauri::command]
pub fn mcp_export_json(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    ids: Vec<String>,
) -> Result<String, PultError> {
    crate::mcp::import_export::export_json(runtime.store(), &ids)
}

#[tauri::command]
pub fn mcp_list_bindings(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    scope_type: String,
    scope_id: String,
) -> Result<Vec<crate::store::McpBinding>, PultError> {
    runtime.store().list_mcp_bindings(&scope_type, &scope_id)
}

#[tauri::command]
pub async fn mcp_set_binding(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    scope_type: String,
    scope_id: String,
    server_id: String,
    mode: Option<String>,
) -> Result<(), PultError> {
    let runtime = runtime.inner().clone();
    runtime
        .store()
        .set_mcp_binding(&scope_type, &scope_id, &server_id, mode.as_deref())?;
    runtime.custom_mcp_changed(&server_id).await;
    Ok(())
}

#[tauri::command]
pub fn mcp_active_for_thread(
    runtime: tauri::State<'_, Arc<AgentRuntime>>,
    thread_id: String,
    instance_id: String,
) -> Result<Vec<crate::mcp::config::CustomMcpServerView>, PultError> {
    let store = runtime.store();
    let thread = store.get_thread(&thread_id)?;
    let servers = crate::mcp::resolve::resolve_for_thread(store, &thread, &instance_id)?;
    servers
        .iter()
        .map(|server| crate::mcp::config::view(store, server))
        .collect()
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
mod update_tests {
    use super::update_kind;
    use crate::config::InstanceSpec;

    fn spec(id: &str, name: &str, command: &str) -> InstanceSpec {
        InstanceSpec {
            id: id.into(),
            display_name: name.into(),
            driver: "acp".into(),
            command: command.into(),
            args: Vec::new(),
            env: Default::default(),
            enabled: true,
        }
    }

    #[test]
    fn detects_self_updating_clis() {
        assert_eq!(update_kind(&spec("codex", "Codex", "codex")), Some("codex"));
        assert_eq!(
            update_kind(&spec("opencode", "OpenCode", "opencode")),
            Some("opencode")
        );
        assert_eq!(update_kind(&spec("mock", "Mock", "node")), None);
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
                meta: None,
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

#[cfg(test)]
mod workspace_tree_tests;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod security_regression_tests {
    use super::{open_in_editor, parse_frame_headers};

    #[test]
    fn open_in_editor_rejects_unc_paths_before_filesystem_lookup() {
        let err = open_in_editor("//server/share".to_string(), None)
            .expect_err("expected UNC forward-slash path to be rejected");
        assert!(
            err.to_string().contains("UNC paths are not allowed"),
            "got: {err}"
        );

        let err_backslash = open_in_editor("\\\\server\\share".to_string(), None)
            .expect_err("expected UNC backslash path to be rejected");
        assert!(
            err_backslash
                .to_string()
                .contains("UNC paths are not allowed"),
            "got: {err_backslash}"
        );
    }

    #[test]
    fn parse_frame_headers_blocks_x_frame_options_deny_and_sameorigin() {
        let deny = parse_frame_headers("HTTP/1.1 200 OK\r\nX-Frame-Options: DENY\r\n\r\n");
        assert!(!deny.embeddable);
        assert!(deny
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("X-Frame-Options"));

        let sameorigin =
            parse_frame_headers("HTTP/1.1 200 OK\r\nX-Frame-Options: SameOrigin\r\n\r\n");
        assert!(!sameorigin.embeddable);
        assert!(sameorigin
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("X-Frame-Options"));
    }

    #[test]
    fn parse_frame_headers_checks_csp_frame_ancestors_on_final_response_block_only() {
        let blocked_csp = parse_frame_headers(
            "HTTP/1.1 200 OK\r\nContent-Security-Policy: default-src 'self'; frame-ancestors 'none'\r\n\r\n",
        );
        assert!(!blocked_csp.embeddable);
        assert!(blocked_csp
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("frame-ancestors"));

        let wildcard_csp = parse_frame_headers(
            "HTTP/1.1 200 OK\r\nContent-Security-Policy: frame-ancestors *\r\n\r\n",
        );
        assert!(wildcard_csp.embeddable);

        let redirect_then_ok = parse_frame_headers(
            "HTTP/1.1 302 Found\r\nX-Frame-Options: DENY\r\nContent-Security-Policy: frame-ancestors 'none'\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n",
        );
        assert!(redirect_then_ok.embeddable);

        let ok_then_blocked = parse_frame_headers(
            "HTTP/1.1 302 Found\r\nLocation: https://example.com\r\n\r\nHTTP/1.1 200 OK\r\nContent-Security-Policy: frame-ancestors 'self'\r\n\r\n",
        );
        assert!(!ok_then_blocked.embeddable);
    }

    #[test]
    fn parse_frame_headers_treats_host_wildcard_frame_ancestors_as_blocked() {
        let host_wildcard = parse_frame_headers(
            "HTTP/1.1 200 OK\r\nContent-Security-Policy: frame-ancestors *.example.com\r\n\r\n",
        );
        assert!(!host_wildcard.embeddable);
        assert!(host_wildcard
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("frame-ancestors"));

        let wildcard = parse_frame_headers(
            "HTTP/1.1 200 OK\r\nContent-Security-Policy: frame-ancestors *\r\n\r\n",
        );
        assert!(wildcard.embeddable);
    }
}
