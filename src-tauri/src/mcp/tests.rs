use serde_json::json;

use crate::mcp::config::{self, CustomMcpServerInput};
use crate::store::records::ProjectRecord;
use crate::store::Store;

fn input(value: serde_json::Value) -> CustomMcpServerInput {
    serde_json::from_value(value).expect("valid MCP server input")
}

fn stdio(name: &str, secret_env: serde_json::Value) -> CustomMcpServerInput {
    input(json!({
        "name": name,
        "transport": {
            "kind": "stdio",
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
            "env": { "LOG_LEVEL": "debug" },
            "secretEnv": secret_env,
        }
    }))
}

fn error_code(error: crate::PultError) -> String {
    error.code().to_string()
}

fn project_record(id: &str) -> ProjectRecord {
    ProjectRecord {
        id: id.to_string(),
        name: "Project".to_string(),
        root_path: std::env::temp_dir().to_string_lossy().into_owned(),
        color: None,
        worktree_strategy: "root".to_string(),
        pinned: false,
        created_at: 1,
    }
}

#[test]
fn reserved_names_are_rejected_case_insensitively() {
    for reserved in ["pult_orchestrator", " PULT ", "Orchestrator"] {
        let error = config::validate_name(reserved).unwrap_err();
        assert_eq!(error_code(error), "mcp.reserved_name", "{reserved}");
    }
    assert_eq!(
        config::validate_name("  Filesystem  ").unwrap(),
        "Filesystem"
    );
    assert_eq!(
        error_code(config::validate_name("   ").unwrap_err()),
        "mcp.empty_name"
    );
}

#[test]
fn duplicate_names_are_case_insensitive() {
    let store = Store::open_in_memory().unwrap();
    config::create(&store, stdio("Files", json!([]))).unwrap();
    let error = config::create(&store, stdio(" files ", json!([]))).unwrap_err();
    assert_eq!(error_code(error), "mcp.duplicate_name");
    assert_eq!(config::list(&store).unwrap().len(), 1);
}

#[test]
fn secrets_never_reach_sqlite_or_the_ipc_view() {
    let store = Store::open_in_memory().unwrap();
    let created = config::create(
        &store,
        stdio(
            "Files",
            json!([{ "key": "API_TOKEN", "value": "sk-live-123456" }]),
        ),
    )
    .unwrap();

    let (raw_config, raw_blob): (String, Vec<u8>) = store
        .with_conn(|conn| {
            let raw: String = conn
                .query_row(
                    "SELECT transport_config_json FROM custom_mcp_servers WHERE id = ?1",
                    [&created.id],
                    |row| row.get(0),
                )
                .unwrap();
            let blob: Vec<u8> = conn
                .query_row(
                    "SELECT value FROM app_secrets WHERE key = ?1",
                    [format!("mcp:{}:env:API_TOKEN", created.id)],
                    |row| row.get(0),
                )
                .unwrap();
            Ok((raw, blob))
        })
        .unwrap();
    assert!(!raw_config.contains("sk-live-123456"));
    assert!(!raw_blob
        .windows(b"sk-live".len())
        .any(|window| window == b"sk-live"));

    let view = serde_json::to_value(config::get(&store, &created.id).unwrap()).unwrap();
    let serialized = view.to_string();
    assert!(!serialized.contains("sk-live-123456"));
    assert_eq!(view["transport"]["secretEnvKeys"][0]["key"], "API_TOKEN");
    assert_eq!(view["transport"]["secretEnvKeys"][0]["hasValue"], true);
    assert_eq!(view["transport"]["secretEnvKeys"][0]["masked"], "••••3456");
    assert_eq!(
        store
            .get_secret(&format!("mcp:{}:env:API_TOKEN", created.id))
            .unwrap()
            .as_deref(),
        Some("sk-live-123456")
    );
}

#[test]
fn update_keeps_untouched_secrets_and_deletes_removed_ones() {
    let store = Store::open_in_memory().unwrap();
    let created = config::create(
        &store,
        stdio("Files", json!([{ "key": "API_TOKEN", "value": "sk-old" }])),
    )
    .unwrap();
    let secret_key = format!("mcp:{}:env:API_TOKEN", created.id);

    let kept = config::update(
        &store,
        &created.id,
        stdio("Files", json!([{ "key": "API_TOKEN" }])),
    )
    .unwrap();
    assert_eq!(
        store.get_secret(&secret_key).unwrap().as_deref(),
        Some("sk-old")
    );
    match &kept.transport {
        config::TransportView::Stdio {
            secret_env_keys, ..
        } => {
            assert!(secret_env_keys[0].has_value);
            assert_eq!(secret_env_keys[0].masked.as_deref(), Some("••••-old"));
        }
        other => panic!("unexpected transport: {other:?}"),
    }

    let cleared = config::update(&store, &created.id, stdio("Files", json!([]))).unwrap();
    match &cleared.transport {
        config::TransportView::Stdio {
            secret_env_keys, ..
        } => assert!(secret_env_keys.is_empty()),
        other => panic!("unexpected transport: {other:?}"),
    }
    assert!(store.get_secret(&secret_key).unwrap().is_none());
}

#[test]
fn delete_removes_the_row_and_every_secret() {
    let store = Store::open_in_memory().unwrap();
    let created = config::create(
        &store,
        stdio("Files", json!([{ "key": "API_TOKEN", "value": "sk-old" }])),
    )
    .unwrap();
    let secret_key = format!("mcp:{}:env:API_TOKEN", created.id);
    config::delete(&store, &created.id).unwrap();

    assert_eq!(
        error_code(config::get(&store, &created.id).unwrap_err()),
        "mcp.not_found"
    );
    assert!(store.get_secret(&secret_key).unwrap().is_none());
    assert!(config::list(&store).unwrap().is_empty());
}

#[test]
fn scope_and_timeout_are_normalized() {
    let store = Store::open_in_memory().unwrap();
    let mut server = stdio("Global", json!([]));
    server.project_id = Some("prj".into());
    server.thread_id = Some("th".into());
    server.timeout_ms = 10;
    let created = config::create(&store, server).unwrap();
    assert_eq!(created.scope, "global");
    assert!(created.project_id.is_none());
    assert!(created.thread_id.is_none());
    assert_eq!(created.timeout_ms, config::MIN_TIMEOUT_MS);

    let mut project = stdio("Project", json!([]));
    project.scope = "project".into();
    project.project_id = Some("prj-missing".into());
    assert_eq!(
        error_code(config::create(&store, project).unwrap_err()),
        "mcp.invalid_scope"
    );

    store.create_project(&project_record("prj-1")).unwrap();
    let mut project = stdio("Project", json!([]));
    project.scope = "project".into();
    project.project_id = Some("prj-1".into());
    project.thread_id = Some("th-ignored".into());
    project.timeout_ms = 10_000_000;
    let created = config::create(&store, project).unwrap();
    assert_eq!(created.timeout_ms, config::MAX_TIMEOUT_MS);
    assert!(created.thread_id.is_none());
}

#[test]
fn a_name_cannot_be_plain_and_secret_at_once() {
    let store = Store::open_in_memory().unwrap();
    let error = config::create(
        &store,
        input(json!({
            "name": "Files",
            "transport": {
                "kind": "stdio",
                "command": "npx",
                "env": { "TOKEN": "plain" },
                "secretEnv": [{ "key": "TOKEN", "value": "secret" }]
            }
        })),
    )
    .unwrap_err();
    assert_eq!(error_code(error), "mcp.secret_conflict");
    assert!(config::list(&store).unwrap().is_empty());
}

#[test]
fn remote_transports_need_an_http_scheme() {
    let store = Store::open_in_memory().unwrap();
    for (kind, url) in [
        ("http", "file:///etc/passwd"),
        ("sse", "javascript:alert(1)"),
        ("http", "not a url"),
    ] {
        let error = config::create(
            &store,
            input(json!({
                "name": format!("Remote {kind} {url}"),
                "transport": { "kind": kind, "url": url }
            })),
        )
        .unwrap_err();
        assert_eq!(error_code(error), "mcp.invalid_url", "{url}");
    }
}

#[test]
fn http_secrets_are_stored_under_the_header_namespace() {
    let store = Store::open_in_memory().unwrap();
    let created = config::create(
        &store,
        input(json!({
            "name": "Remote",
            "scope": "global",
            "transport": {
                "kind": "http",
                "url": "https://mcp.example.com/mcp",
                "headers": { "Accept": "application/json" },
                "secretHeaders": [{ "key": "Authorization", "value": "Bearer abc12345" }]
            }
        })),
    )
    .unwrap();
    assert_eq!(
        store
            .get_secret(&format!("mcp:{}:header:Authorization", created.id))
            .unwrap()
            .as_deref(),
        Some("Bearer abc12345")
    );
    let serialized = serde_json::to_string(&created).unwrap();
    assert!(!serialized.contains("abc12345"));
    assert!(serialized.contains("••••2345"));
}

#[tokio::test]
async fn connecting_reports_a_secret_that_was_deleted() {
    let store = Store::open_in_memory().unwrap();
    let created = config::create(
        &store,
        stdio("Files", json!([{ "key": "API_TOKEN", "value": "sk-old" }])),
    )
    .unwrap();
    let server = store.get_custom_mcp_server(&created.id).unwrap();
    store
        .delete_secret(&format!("mcp:{}:env:API_TOKEN", created.id))
        .unwrap();
    let error = super::connect_custom(&store, &server)
        .await
        .err()
        .expect("missing secret must fail before spawning");
    assert!(error.contains("API_TOKEN"), "{error}");
}
