//! PID → role/owner metadata. Rows may outlive the OS process; the tree only
//! shows PIDs that are still live descendants, and kill requires a live row.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProcessMeta {
    pub role: String,
    pub label: Option<String>,
    pub thread_id: Option<String>,
    pub run_id: Option<String>,
    pub instance_id: Option<String>,
    /// OS start time (epoch seconds), filled by `register`. A reused PID with a
    /// different start time is a different process and is never killable.
    pub started_at: Option<u64>,
}

impl ProcessMeta {
    pub fn new(role: impl Into<String>) -> Self {
        Self {
            role: role.into(),
            ..Self::default()
        }
    }

    pub fn with_label(mut self, label: impl Into<String>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn with_thread(mut self, thread_id: impl Into<String>) -> Self {
        self.thread_id = Some(thread_id.into());
        self
    }

    pub fn with_run(mut self, run_id: impl Into<String>) -> Self {
        self.run_id = Some(run_id.into());
        self
    }

    pub fn with_instance(mut self, instance_id: impl Into<String>) -> Self {
        self.instance_id = Some(instance_id.into());
        self
    }
}

#[derive(Default)]
pub struct ProcessRegistry {
    entries: Mutex<HashMap<u32, ProcessMeta>>,
}

impl std::fmt::Debug for ProcessRegistry {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProcessRegistry")
            .field(
                "entries",
                &self.entries.lock().map(|e| e.len()).unwrap_or(0),
            )
            .finish()
    }
}

impl ProcessRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, pid: u32, mut meta: ProcessMeta) {
        if meta.started_at.is_none() {
            meta.started_at = Some(process_start_time(pid));
        }
        if let Ok(mut entries) = self.entries.lock() {
            entries.insert(pid, meta);
        }
    }

    pub fn unregister(&self, pid: u32) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(&pid);
        }
    }

    pub fn get(&self, pid: u32) -> Option<ProcessMeta> {
        self.entries
            .lock()
            .ok()
            .and_then(|entries| entries.get(&pid).cloned())
    }

    pub fn all(&self) -> Vec<(u32, ProcessMeta)> {
        self.entries
            .lock()
            .map(|entries| {
                entries
                    .iter()
                    .map(|(pid, meta)| (*pid, meta.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }
}

static GLOBAL: OnceLock<ProcessRegistry> = OnceLock::new();

fn process_start_time(pid: u32) -> u64 {
    let mut system = sysinfo::System::new();
    let targets = [sysinfo::Pid::from_u32(pid)];
    system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&targets), false);
    system
        .process(targets[0])
        .map(|process| process.start_time())
        .unwrap_or(0)
}

pub(crate) fn global() -> &'static ProcessRegistry {
    GLOBAL.get_or_init(ProcessRegistry::new)
}

pub fn register_process(pid: u32, meta: ProcessMeta) {
    global().register(pid, meta);
}

pub fn unregister_process(pid: u32) {
    global().unregister(pid);
}

/// Test/UI seam: the registry behind the global helpers.
pub fn global_registry() -> &'static ProcessRegistry {
    global()
}
