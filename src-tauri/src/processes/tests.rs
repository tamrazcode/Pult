use std::process::{Command, Stdio};
use std::time::Duration;

use super::registry::{ProcessMeta, ProcessRegistry};
use super::{global_registry, kill_process, process_tree};

#[test]
fn registry_keeps_role_and_owner_metadata() {
    let registry = ProcessRegistry::new();
    let meta = ProcessMeta::new("agent")
        .with_label("Claude")
        .with_thread("th-1")
        .with_run("run-1")
        .with_instance("claude");
    registry.register(4242, meta.clone());
    assert_eq!(registry.get(4242), Some(meta));
    registry.unregister(4242);
    assert!(registry.get(4242).is_none());
}

#[test]
fn tree_starts_with_this_process_and_is_not_killable() {
    let tree = process_tree();
    let root = tree.first().expect("pult-core node");
    assert_eq!(root.pid, std::process::id());
    assert_eq!(root.role, "core");
    assert!(!root.killable);
}

#[test]
fn kill_refuses_core_and_foreign_processes() {
    let error = kill_process(std::process::id()).unwrap_err();
    assert_eq!(error.code(), "processes.core");
    let error = kill_process(4_000_000_000).unwrap_err();
    assert_eq!(error.code(), "processes.not_managed");
}

#[test]
fn a_registered_child_is_visible_with_its_owner_and_can_be_killed() {
    #[cfg(windows)]
    let mut child = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        Command::new("cmd")
            .args(["/c", "ping -n 30 127.0.0.1 >nul"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn child")
    };
    #[cfg(not(windows))]
    let mut child = Command::new("sh")
        .args(["-c", "sleep 30"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn child");
    let pid = child.id();
    super::register_process(
        pid,
        ProcessMeta::new("terminal")
            .with_label("test terminal")
            .with_thread("th-test"),
    );
    std::thread::sleep(Duration::from_millis(250));

    let tree = process_tree();
    let node = find(&tree, pid).expect("registered child in tree");
    assert_eq!(node.role, "terminal");
    assert_eq!(node.label.as_deref(), Some("test terminal"));
    assert_eq!(node.thread_id.as_deref(), Some("th-test"));
    assert!(node.killable);

    kill_process(pid).expect("kill registered child");
    let _ = child.wait();
    assert!(global_registry().get(pid).is_none());
}

fn find(nodes: &[super::ProcessNode], pid: u32) -> Option<super::ProcessNode> {
    for node in nodes {
        if node.pid == pid {
            return Some(node.clone());
        }
        if let Some(found) = find(&node.children, pid) {
            return Some(found);
        }
    }
    None
}
