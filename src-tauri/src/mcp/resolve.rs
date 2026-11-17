//! Which custom MCP servers one ACP session gets: scope layers, project/thread
//! bindings, provider allow-lists and name de-duplication.

use std::collections::HashSet;

use crate::store::records::ThreadRecord;
use crate::store::{McpBinding, Store};
use crate::PultError;

use super::config::CustomMcpServer;

/// Resolves enabled servers for one thread/instance pair.
///
/// Layer order is global → project → thread; later copies of the same server id
/// replace earlier ones. Bindings apply afterwards (`exclude` removes,
/// `include` forces a server in even if its scope would not match). The result
/// never contains Pult's own `pult_orchestrator`; the runtime prepends it.
pub fn resolve_for_thread(
    store: &Store,
    thread: &ThreadRecord,
    instance_id: &str,
) -> Result<Vec<CustomMcpServer>, PultError> {
    let mut selected: Vec<CustomMcpServer> = Vec::new();
    for server in store.list_custom_mcp_servers()? {
        if scope_matches(&server, thread) {
            upsert(&mut selected, server, instance_id);
        }
    }

    if let Some(project_id) = thread.project_id.as_deref() {
        for binding in store.list_mcp_bindings("project", project_id)? {
            apply_binding(store, &mut selected, &binding, instance_id)?;
        }
    }
    for binding in store.list_mcp_bindings("thread", &thread.id)? {
        apply_binding(store, &mut selected, &binding, instance_id)?;
    }

    // A project or thread include can surface the same display name from two
    // rows; the first (broadest) scope wins.
    let mut names = HashSet::new();
    selected.retain(|server| names.insert(server.name.trim().to_ascii_lowercase()));
    selected.sort_by_key(|server| server.name.to_ascii_lowercase());
    Ok(selected)
}

fn apply_binding(
    store: &Store,
    selected: &mut Vec<CustomMcpServer>,
    binding: &McpBinding,
    instance_id: &str,
) -> Result<(), PultError> {
    match binding.mode.as_str() {
        "exclude" => selected.retain(|server| server.id != binding.server_id),
        "include" if !selected.iter().any(|server| server.id == binding.server_id) => {
            if let Ok(server) = store.get_custom_mcp_server(&binding.server_id) {
                upsert(selected, server, instance_id);
            }
        }
        _ => {}
    }
    Ok(())
}

fn upsert(selected: &mut Vec<CustomMcpServer>, server: CustomMcpServer, instance_id: &str) {
    if !server.enabled {
        return;
    }
    if !server.provider_ids.is_empty() && !server.provider_ids.iter().any(|id| id == instance_id) {
        return;
    }
    if let Some(existing) = selected.iter_mut().find(|item| item.id == server.id) {
        *existing = server;
    } else {
        selected.push(server);
    }
}

fn scope_matches(server: &CustomMcpServer, thread: &ThreadRecord) -> bool {
    match server.scope.as_str() {
        "global" => true,
        "project" => thread.project_id.is_some() && server.project_id == thread.project_id,
        "thread" => server.thread_id.as_deref() == Some(thread.id.as_str()),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::mcp::config;
    use crate::store::records::{ProjectRecord, ThreadRecord};
    use crate::store::Store;

    fn project(id: &str) -> ProjectRecord {
        ProjectRecord {
            id: id.to_string(),
            name: id.to_string(),
            root_path: std::env::temp_dir().to_string_lossy().into_owned(),
            color: None,
            worktree_strategy: "root".to_string(),
            pinned: false,
            created_at: 1,
        }
    }

    fn thread(id: &str, project_id: Option<&str>) -> ThreadRecord {
        ThreadRecord {
            id: id.to_string(),
            project_id: project_id.map(str::to_string),
            title: id.to_string(),
            status: "draft".to_string(),
            pinned: false,
            created_at: 1,
            updated_at: 1,
            workspace: None,
            main_repo: None,
            worktree_name: None,
            parent_thread_id: None,
            parent_run_id: None,
            depth: 0,
            lineage_kind: None,
            child_role: None,
        }
    }

    fn input(value: serde_json::Value) -> config::CustomMcpServerInput {
        serde_json::from_value(value).expect("valid mcp input")
    }

    fn server(
        name: &str,
        scope: &str,
        project: Option<&str>,
        thread: Option<&str>,
    ) -> config::CustomMcpServerInput {
        input(json!({
            "name": name,
            "scope": scope,
            "projectId": project,
            "threadId": thread,
            "transport": { "kind": "stdio", "command": "npx" }
        }))
    }

    #[test]
    fn layers_scopes_bindings_and_providers() {
        let store = Store::open_in_memory().unwrap();
        store.create_project(&project("prj-a")).unwrap();
        store.create_project(&project("prj-b")).unwrap();
        store.create_thread(&thread("th-1", Some("prj-a"))).unwrap();
        store.create_thread(&thread("th-2", Some("prj-a"))).unwrap();

        config::create(&store, server("Global", "global", None, None)).unwrap();
        config::create(&store, server("Project A", "project", Some("prj-a"), None)).unwrap();
        config::create(&store, server("Project B", "project", Some("prj-b"), None)).unwrap();
        config::create(&store, server("Thread 1", "thread", None, Some("th-1"))).unwrap();
        let disabled = config::create(&store, server("Disabled", "global", None, None)).unwrap();
        config::set_enabled(&store, &disabled.id, false).unwrap();
        let mut provider_only = server("Claude Only", "global", None, None);
        provider_only.provider_ids = vec!["claude".to_string()];
        config::create(&store, provider_only).unwrap();
        let mut codex_only = server("Codex Only", "global", None, None);
        codex_only.provider_ids = vec!["codex".to_string()];
        config::create(&store, codex_only).unwrap();

        let thread_one = store.get_thread("th-1").unwrap();
        let names = |instance: &str| -> Vec<String> {
            super::resolve_for_thread(&store, &thread_one, instance)
                .unwrap()
                .into_iter()
                .map(|server| server.name)
                .collect()
        };
        assert_eq!(
            names("claude"),
            vec!["Claude Only", "Global", "Project A", "Thread 1"]
        );
        assert_eq!(
            names("codex"),
            vec!["Codex Only", "Global", "Project A", "Thread 1"]
        );

        let global = store
            .list_custom_mcp_servers()
            .unwrap()
            .into_iter()
            .find(|server| server.name == "Global")
            .unwrap();
        store
            .set_mcp_binding("thread", "th-1", &global.id, Some("exclude"))
            .unwrap();
        assert!(!names("claude").contains(&"Global".to_string()));

        let project_b = store
            .list_custom_mcp_servers()
            .unwrap()
            .into_iter()
            .find(|server| server.name == "Project B")
            .unwrap();
        store
            .set_mcp_binding("project", "prj-a", &project_b.id, Some("include"))
            .unwrap();
        let with_b = names("claude");
        assert!(with_b.contains(&"Project B".to_string()), "{with_b:?}");

        // Bindings only affect their own scope: a sibling thread is untouched.
        let thread_two = store.get_thread("th-2").unwrap();
        let other = super::resolve_for_thread(&store, &thread_two, "claude").unwrap();
        assert!(other.iter().any(|server| server.name == "Global"));
    }

    #[test]
    fn binding_modes_are_validated() {
        let store = Store::open_in_memory().unwrap();
        let error = store
            .set_mcp_binding("thread", "th-1", "mcp-1", Some("maybe"))
            .unwrap_err();
        assert_eq!(error.code(), "mcp.invalid_binding");
        let error = store
            .set_mcp_binding("global", "x", "mcp-1", Some("include"))
            .unwrap_err();
        assert_eq!(error.code(), "mcp.invalid_scope");
    }
}
