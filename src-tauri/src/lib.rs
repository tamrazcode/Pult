//! pult core — local-first Agent Development Environment over ACP.
//! M1: ACP protocol layer, drivers, runtime orchestration, sqlite store, IPC.

pub mod browser;
pub mod config;
pub mod drivers;
pub mod events;
pub mod git;
pub mod http1;
pub mod ipc;
pub mod mcp;
pub mod orchestrator;
pub mod plugins;
pub mod processes;
pub mod protocol;
pub mod runtime;
pub mod store;
pub mod toolchain;
pub mod workspace;

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
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

/// Alt+Shift switches the Windows keyboard layout, but releasing Alt also
/// activates the native system menu; Windows then beeps on the next keypress
/// and the hidden title bar takes focus. Swallow only the bare-Alt menu
/// activation so Alt+Space, Alt+F4 and every other shortcut keep working.
#[cfg(windows)]
fn suppress_alt_system_menu(window: &tauri::WebviewWindow) {
    use std::sync::atomic::{AtomicIsize, Ordering};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_MENU;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, SetWindowLongPtrW, GWLP_WNDPROC, SC_KEYMENU, WM_SYSCOMMAND,
        WM_SYSKEYUP, WNDPROC,
    };

    static OLD_PROC: AtomicIsize = AtomicIsize::new(0);

    unsafe extern "system" fn guard(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if msg == WM_SYSKEYUP && wparam == VK_MENU as usize {
            return 0;
        }
        // `lparam == 0` is the bare-Alt release; Alt+Space passes VK_SPACE and
        // must keep opening the system menu.
        if msg == WM_SYSCOMMAND && (wparam & 0xFFF0) == SC_KEYMENU as usize && lparam == 0 {
            return 0;
        }
        let previous: WNDPROC = std::mem::transmute(OLD_PROC.load(Ordering::Relaxed));
        CallWindowProcW(previous, hwnd, msg, wparam, lparam)
    }

    let Ok(raw) = window.hwnd() else {
        return;
    };
    let hwnd = raw.0 as HWND;
    if OLD_PROC.load(Ordering::Relaxed) != 0 {
        return;
    }
    unsafe {
        let previous = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, guard as *const () as usize as isize);
        if previous != 0 {
            OLD_PROC.store(previous, Ordering::Relaxed);
        }
    }
}

/// A store that cannot be opened is recoverable. The app used to abort setup,
/// which flashed a window and exited with code 101 without telling the user
/// anything; now a native dialog explains the failure and offers to move the
/// broken database aside and restart.
fn report_store_failure(app: &tauri::AppHandle, error: &PultError) {
    // Nothing in the window can work without the store, so do not leave a
    // half-loaded shell behind the dialog.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    let message = format!(
        "Pult cannot open its database.\n\n{error}\n\nThe database lives in {}.\n\n\
         Recreating moves it aside as pult.db.broken-<timestamp> and starts with an empty \
         history. Nothing else is deleted.",
        pult_home().display()
    );
    let handle = app.clone();
    app.dialog()
        .message(message)
        .title("Pult — database problem")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Recreate database".to_string(),
            "Quit".to_string(),
        ))
        .show(move |recreate| {
            if !recreate {
                handle.exit(0);
                return;
            }
            match store::recovery::move_broken_db_aside(&pult_home()) {
                Ok(_) => handle.restart(),
                Err(err) => {
                    let inner = handle.clone();
                    handle
                        .dialog()
                        .message(format!("Could not move the database aside: {err}"))
                        .title("Pult — database problem")
                        .kind(MessageDialogKind::Error)
                        .show(move |_| inner.exit(1));
                }
            }
        });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `pult mcp-stdio` must never create a window or a Tauri runtime.
    if let Some(code) = orchestrator::stdio::handle_cli() {
        std::process::exit(code);
    }
    init_tracing();
    tracing::info!("pult starting");

    let app = tauri::Builder::default()
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
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                suppress_alt_system_menu(&window);
            }

            let store = match open_store() {
                Ok(store) => store,
                Err(error) => {
                    report_store_failure(app.handle(), &error);
                    return Ok(());
                }
            };
            let runtime: Arc<runtime::AgentRuntime> = Arc::new(runtime::AgentRuntime::new(
                store,
                Arc::new(app.handle().clone()) as Arc<dyn runtime::EventSink>,
            ));
            runtime.attach_orchestrator();
            // Startup is non-blocking: the window opens immediately and both
            // loopback MCP servers come up in the background. Early runs wait
            // on the runtime gate, so no `recv_timeout` here.
            runtime.readiness.defer();
            let gateway_store = Arc::clone(runtime.store());
            let gateway_tokens = Arc::clone(&runtime.gateway_tokens);
            let engine = Arc::clone(&runtime.orchestrator);
            let registry = Arc::clone(&runtime.mcp_registry);
            let startup_runtime = Arc::clone(&runtime);
            let health_store = Arc::clone(runtime.store());
            tauri::async_runtime::spawn(async move {
                let gateway = async {
                    match crate::mcp::gateway::McpGateway::start(
                        Arc::new(crate::mcp::StoreConnector::new(gateway_store)),
                        gateway_tokens,
                    )
                    .await
                    {
                        Ok(gateway) => {
                            let _ = startup_runtime.gateway.set(gateway);
                        }
                        Err(error) => tracing::error!(target: "pult::mcp", error = %error,
                            "custom MCP gateway did not start; user MCP servers are unavailable"),
                    }
                };
                let host = Arc::new(orchestrator::engine::RuntimeHost {
                    engine: Arc::clone(&engine),
                });
                let orchestration = async {
                    match orchestrator::OrchestratorMcpServer::start(host, registry).await {
                        Ok(server) => engine.set_server(server),
                        Err(error) => tracing::error!(target: "pult::orchestrator", error = %error,
                            "orchestration MCP server did not start; delegation is unavailable"),
                    }
                };
                tokio::join!(gateway, orchestration);
                // Open the gate on every outcome: a server that failed to start
                // must never leave early runs waiting forever.
                startup_runtime.readiness.mark_ready();
            });
            tauri::async_runtime::spawn(async move {
                crate::mcp::manager::check_all(health_store).await;
            });
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
            ipc::runs_pending_elicitations,
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
            ipc::git_checkpoints_list,
            ipc::git_checkpoint_diff,
            ipc::git_checkpoint_diff_file,
            ipc::git_checkpoint_restore,
            ipc::terminal_pty_create,
            ipc::terminal_pty_write,
            ipc::terminal_pty_resize,
            ipc::terminal_pty_kill,
            ipc::terminal_pty_list,
            ipc::providers_detect_installed,
            ipc::providers_install,
            ipc::providers_login,
            ipc::orchestrator_tasks_list,
            ipc::orchestrator_cancel_task,
            ipc::orchestrator_cancel_all,
            ipc::orchestrator_retry_task,
            ipc::orchestrator_steer_task,
            ipc::mcp_list_servers,
            ipc::mcp_get_server,
            ipc::mcp_create_server,
            ipc::mcp_update_server,
            ipc::mcp_delete_server,
            ipc::mcp_set_server_enabled,
            ipc::mcp_test_connection,
            ipc::mcp_reconnect_server,
            ipc::mcp_server_logs,
            ipc::mcp_server_stats,
            ipc::mcp_check_all,
            ipc::mcp_import_json,
            ipc::mcp_export_json,
            ipc::mcp_list_bindings,
            ipc::mcp_set_binding,
            ipc::mcp_active_for_thread,
            ipc::providers_instances_save,
            ipc::providers_model_prefs_list,
            ipc::providers_model_prefs_get,
            ipc::providers_model_prefs_set,
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
            ipc::attachments_save_image,
            ipc::attachments_save_text,
            ipc::attachments_check_paths,
            ipc::attachments_pick_files,
            ipc::attachments_read_dropped,
            ipc::runs_set_mode,
            ipc::runs_set_config_option,
            ipc::diagnostics_frames,
            ipc::diagnostics_process_tree,
            ipc::diagnostics_kill_process,
            ipc::settings_get,
            ipc::settings_set,
            ipc::providers_preflight,
            ipc::providers_warmup,
            ipc::providers_update_check,
            ipc::providers_update_install,
            ipc::providers_authenticate,
            ipc::usage_report,
        ])
        .build(tauri::generate_context!())
        .expect("pult: failed to build tauri application");
    app.run(|handle, event| {
        // Destructors never run on this exit path, so the agents Pult spawned
        // are killed here or they outlive the app as orphans.
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(runtime) = handle.try_state::<Arc<runtime::AgentRuntime>>() {
                runtime.shutdown_agents();
            }
        }
    });
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
