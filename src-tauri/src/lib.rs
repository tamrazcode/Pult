//! pult core — local-first Agent Development Environment over ACP.
//! M1: ACP protocol layer, drivers, runtime orchestration, sqlite store, IPC.

pub mod browser;
pub mod config;
pub mod drivers;
pub mod events;
pub mod git;
pub mod ipc;
pub mod plugins;
pub mod protocol;
pub mod runtime;
pub mod store;
pub mod workspace;

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::Manager;
use thiserror::Error;

/// Typed error surfaced over IPC as `{ code, message }` (§4.3 contract).
#[derive(Debug, Error)]
pub enum PultError {
    #[error("{message}")]
    Internal { code: String, message: String },
    #[error("store: {message}")]
    Store { message: String },
    /// Git failures carry a typed code (`git.not_a_repo`, `git.no_remote`,
    /// `git.nothing_to_commit`, `git.gh_missing`, …) the UI branches on.
    #[error("git: {message}")]
    Git { code: String, message: String },
}

impl PultError {
    pub fn internal(message: impl Into<String>) -> Self {
        Self::Internal {
            code: "internal".to_string(),
            message: message.into(),
        }
    }

    pub fn store(message: impl Into<String>) -> Self {
        Self::Store {
            message: message.into(),
        }
    }

    /// Typed code for recoverable states the UI renders (e.g. auth_required).
    pub fn with_code(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Internal {
            code: code.into(),
            message: message.into(),
        }
    }

    /// Typed code the UI branches on (`git.worktree_dirty`, …).
    pub fn code(&self) -> &str {
        match self {
            Self::Internal { code, .. } => code,
            Self::Store { .. } => "store",
            Self::Git { code, .. } => code,
        }
    }
}

impl Serialize for PultError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let (code, message) = match self {
            PultError::Internal { code, message } => (code.as_str(), message.as_str()),
            PultError::Store { message } => ("store", message.as_str()),
            PultError::Git { code, message } => (code.as_str(), message.as_str()),
        };
        let mut s = serializer.serialize_struct("PultError", 2)?;
        s.serialize_field("code", &code)?;
        s.serialize_field("message", &message)?;
        s.end()
    }
}

/// Returns the running pult version (proves the IPC bridge end-to-end).
#[tauri::command]
fn app_version() -> Result<String, PultError> {
    Ok(env!("CARGO_PKG_VERSION").to_string())
}

/// `~/.pult` — config, db, and logs root (§4.5).
pub fn pult_home() -> PathBuf {
    runtime::home_dir_pub().join(".pult")
}

fn open_store() -> Result<Arc<store::Store>, PultError> {
    let dir = pult_home();
    std::fs::create_dir_all(&dir)
        .map_err(|e| PultError::store(format!("create {}: {e}", dir.display())))?;
    Ok(Arc::new(store::Store::open(&dir.join("pult.db"))?))
}

fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,tauri=warn,tao=warn,wry=warn"));
    tracing_subscriber::fmt().with_env_filter(filter).init();
}

#[cfg(windows)]
fn register_toast_app_id() {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let icon = exe.display().to_string();
    let _ = std::process::Command::new("reg")
        .args([
            "add",
            r"HKCU\Software\Classes\AppUserModelId\app.pult.desktop",
            "/v",
            "DisplayName",
            "/t",
            "REG_SZ",
            "/d",
            "Pult",
            "/f",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
    let _ = std::process::Command::new("reg")
        .args([
            "add",
            r"HKCU\Software\Classes\AppUserModelId\app.pult.desktop",
            "/v",
            "IconUri",
            "/t",
            "REG_SZ",
            "/d",
            &icon,
            "/f",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();
    tracing::info!("pult starting");

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        // Auto-update plumbing (M8): inert until a real endpoint + public key
        // are configured (see README "Updates"); nothing calls the updater at
        // startup, so placeholder config is harmless.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch must focus the existing window instead.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // SIZE + VISIBLE only while the user games: POSITION would
                // override the config's second-monitor placement and drag the
                // window back onto the primary screen on every relaunch.
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        .setup(|app| {
            #[cfg(windows)]
            register_toast_app_id();
            let store = open_store()?;
            let runtime: Arc<runtime::AgentRuntime> = Arc::new(runtime::AgentRuntime::new(
                store,
                Arc::new(app.handle().clone()) as Arc<dyn runtime::EventSink>,
            ));
            app.manage(runtime);
            app.manage(browser::BrowserState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            ipc::app_update_check,
            ipc::app_update_install,
            ipc::app_notify,
            plugins::plugins_list,
            plugins::plugins_set_enabled,
            ipc::threads_create,
            ipc::threads_list,
            ipc::projects_list,
            ipc::projects_create,
            ipc::projects_update,
            ipc::projects_delete,
            ipc::threads_get,
            ipc::threads_rename,
            ipc::threads_set_status,
            ipc::threads_set_pinned,
            ipc::threads_worktree_status,
            ipc::threads_delete,
            ipc::permissions_remembered_list,
            ipc::permissions_remembered_clear,
            ipc::providers_config_status,
            ipc::runs_dispatch,
            ipc::runs_cancel,
            ipc::runs_queue_remove,
            ipc::runs_queue_update,
            ipc::runs_queue_reorder,
            ipc::runs_queue_steer,
            ipc::runs_respond_permission,
            ipc::runs_respond_elicitation,
            ipc::runs_set_permission_mode,
            ipc::providers_instances_list,
            ipc::git_status,
            ipc::git_diff,
            ipc::git_diff_summary,
            ipc::git_diff_file,
            ipc::git_commit,
            ipc::git_push,
            ipc::git_pr_create,
            ipc::git_gh_available,
            ipc::git_checkpoint,
            ipc::terminal_pty_create,
            ipc::terminal_pty_write,
            ipc::terminal_pty_resize,
            ipc::terminal_pty_kill,
            ipc::terminal_pty_list,
            ipc::providers_detect_installed,
            ipc::providers_instances_save,
            ipc::workspace_files,
            ipc::workspace_tree,
            ipc::workspace_global_root,
            ipc::workspace_read_text,
            ipc::workspace_read_html,
            browser::browser_navigate,
            browser::browser_set_bounds,
            browser::browser_history,
            browser::browser_state,
            browser::browser_close,
            ipc::browser_validate_target,
            ipc::browser_check_frame_headers,
            ipc::open_external_url,
            ipc::open_in_editor,
            ipc::read_image_data_url,
            ipc::runs_set_mode,
            ipc::runs_set_config_option,
            ipc::diagnostics_frames,
            ipc::settings_get,
            ipc::settings_set,
            ipc::providers_preflight,
            ipc::providers_warmup,
            ipc::providers_update_check,
            ipc::providers_update_install,
            ipc::providers_authenticate,
            ipc::usage_report,
        ])
        .run(tauri::generate_context!())
        .expect("pult: failed to start tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pult_error_serializes_as_code_and_message() {
        let err = PultError::internal("boom");
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], "internal");
        assert_eq!(json["message"], "boom");
    }

    #[test]
    fn app_version_matches_cargo_pkg_version() {
        assert_eq!(app_version().unwrap(), env!("CARGO_PKG_VERSION"));
    }
}
