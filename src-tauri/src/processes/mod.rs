//! Process bookkeeping for Diagnostics ▸ Processes.
//!
//! Pult registers every child it spawns (agents, PTYs, MCP stdio, browser) with
//! a role and the owning thread/run. The tree itself comes from a live OS
//! snapshot, filtered to descendants of `pult-core`, so foreign processes never
//! appear and stale registry rows cannot be shown.

pub mod registry;
#[cfg(test)]
mod tests;

pub use registry::{
    global_registry, register_process, unregister_process, ProcessMeta, ProcessRegistry,
};

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use sysinfo::{Pid, ProcessStatus, ProcessesToUpdate, System};

use crate::PultError;

use registry::global;

const MAX_COMMAND_CHARS: usize = 240;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessNode {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub name: String,
    pub command: Option<String>,
    pub role: String,
    pub label: Option<String>,
    pub thread_id: Option<String>,
    pub run_id: Option<String>,
    pub instance_id: Option<String>,
    pub status: String,
    pub cpu_percent: Option<f32>,
    pub memory_bytes: Option<u64>,
    pub started_at: Option<u64>,
    pub killable: bool,
    pub children: Vec<ProcessNode>,
}

/// Descendants of this process, `pult-core` first. CPU% becomes meaningful on
/// the second call (the OS reports usage between two snapshots).
pub fn process_tree() -> Vec<ProcessNode> {
    let mut system = system_lock();
    system.refresh_processes(ProcessesToUpdate::All, true);
    let root = std::process::id();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, process) in system.processes() {
        if let Some(parent) = process.parent() {
            children
                .entry(parent.as_u32())
                .or_default()
                .push(pid.as_u32());
        }
    }
    build_node(&system, root, None, &children)
        .into_iter()
        .collect()
}

fn build_node(
    system: &System,
    pid: u32,
    parent: Option<u32>,
    children: &HashMap<u32, Vec<u32>>,
) -> Vec<ProcessNode> {
    let Some(process) = system.process(Pid::from_u32(pid)) else {
        return Vec::new();
    };
    let mut kids = Vec::new();
    if let Some(list) = children.get(&pid) {
        for child in list {
            kids.extend(build_node(system, *child, Some(pid), children));
        }
    }
    let name = process.name().to_string_lossy().into_owned();
    // A registry row only counts when the PID still has the start time we
    // recorded; otherwise the OS reused the PID for another process.
    let meta = global().get(pid).filter(|meta| {
        meta.started_at
            .is_none_or(|started| started.abs_diff(process.start_time()) <= 2)
    });
    let role = if pid == std::process::id() {
        "core".to_string()
    } else if let Some(meta) = &meta {
        meta.role.clone()
    } else if name.to_ascii_lowercase().contains("msedgewebview2") {
        "webview".to_string()
    } else {
        "other".to_string()
    };
    let command = {
        let parts: Vec<String> = process
            .cmd()
            .iter()
            .map(|part| part.to_string_lossy().into_owned())
            .collect();
        if parts.is_empty() {
            process
                .exe()
                .map(|path| path.to_string_lossy().into_owned())
        } else {
            Some(parts.join(" "))
        }
        .map(|line| {
            let redacted = crate::mcp::security::redact(&line);
            redacted.chars().take(MAX_COMMAND_CHARS).collect::<String>()
        })
    };
    let status = match process.status() {
        ProcessStatus::Sleep | ProcessStatus::Idle => "sleeping",
        ProcessStatus::Zombie | ProcessStatus::Dead => "exited",
        _ => "running",
    };
    let killable = matches!(
        role.as_str(),
        "agent" | "terminal" | "mcp" | "browser" | "tool"
    );
    vec![ProcessNode {
        pid,
        parent_pid: parent,
        name,
        command,
        role,
        label: meta.as_ref().and_then(|meta| meta.label.clone()),
        thread_id: meta.as_ref().and_then(|meta| meta.thread_id.clone()),
        run_id: meta.as_ref().and_then(|meta| meta.run_id.clone()),
        instance_id: meta.as_ref().and_then(|meta| meta.instance_id.clone()),
        status: status.to_string(),
        cpu_percent: Some((process.cpu_usage() * 10.0).round() / 10.0),
        memory_bytes: Some(process.memory()),
        started_at: Some(process.start_time()),
        killable,
        children: kids,
    }]
}

/// Kills one registered child tree. `core`/`webview`/unknown PIDs are refused.
pub fn kill_process(pid: u32) -> Result<(), PultError> {
    if pid == std::process::id() {
        return Err(PultError::with_code(
            "processes.core",
            "Pult's own process cannot be killed from Diagnostics",
        ));
    }
    let tree = process_tree();
    let node = find(&tree, pid).ok_or_else(|| {
        PultError::with_code(
            "processes.not_managed",
            "That process is not a descendant of Pult",
        )
    })?;
    if !node.killable {
        return Err(PultError::with_code(
            "processes.denied",
            format!(
                "Process {} ({}) is not a killable Pult child",
                node.pid, node.role
            ),
        ));
    }
    let child_of_core = node.parent_pid.is_some();
    if !child_of_core {
        return Err(PultError::with_code(
            "processes.core",
            "Refusing to kill Pult's root process",
        ));
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        use std::os::windows::process::CommandExt;
        let status = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|e| PultError::internal(format!("taskkill {pid}: {e}")))?;
        if !status.success() {
            return Err(PultError::internal(format!(
                "taskkill {pid} exited with {status}"
            )));
        }
    }
    #[cfg(not(windows))]
    {
        let status = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .map_err(|e| PultError::internal(format!("kill {pid}: {e}")))?;
        if !status.success() {
            return Err(PultError::internal(format!(
                "kill {pid} exited with {status}"
            )));
        }
    }
    unregister_process(pid);
    Ok(())
}

fn find(nodes: &[ProcessNode], pid: u32) -> Option<&ProcessNode> {
    for node in nodes {
        if node.pid == pid {
            return Some(node);
        }
        if let Some(found) = find(&node.children, pid) {
            return Some(found);
        }
    }
    None
}

fn system_lock() -> std::sync::MutexGuard<'static, System> {
    static SYSTEM: OnceLock<Mutex<System>> = OnceLock::new();
    SYSTEM
        .get_or_init(|| Mutex::new(System::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
