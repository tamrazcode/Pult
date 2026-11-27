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
        ("http", "https://user:password@example.com/mcp"),
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

async fn mock_mcp_http(requests: usize) -> u16 {
    use crate::http1::read_request;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        for _ in 0..requests {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = read_request(&mut stream, 1 << 20).await.unwrap().unwrap();
            let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
            let method = body["method"].as_str().unwrap_or_default();
            let has_id = body.get("id").is_some_and(|id| !id.is_null());
            let (status, payload) = if !has_id {
                (202, String::new())
            } else {
                let result = if method == "initialize" {
                    json!({
                        "protocolVersion": "2025-06-18",
                        "capabilities": {},
                        "serverInfo": { "name": "mock", "version": "1.0" }
                    })
                } else {
                    json!({ "tools": [{
                        "name": "echo",
                        "description": "Echo text",
                        "inputSchema": { "type": "object" }
                    }]})
                };
                (
                    200,
                    json!({ "jsonrpc": "2.0", "id": body["id"], "result": result }).to_string(),
                )
            };
            let head = format!(
                "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                payload.len()
            );
            stream.write_all(head.as_bytes()).await.unwrap();
            stream.write_all(payload.as_bytes()).await.unwrap();
        }
    });
    port
}

#[tokio::test]
async fn probe_initializes_lists_tools_and_records_health() {
    let port = mock_mcp_http(3).await;
    let store = Store::open_in_memory().unwrap();
    let created = config::create(
        &store,
        input(json!({
            "name": "Probe HTTP",
            "timeoutMs": 5000,
            "transport": {
                "kind": "http",
                "url": format!("http://127.0.0.1:{port}/mcp")
            }
        })),
    )
    .unwrap();
    let server = store.get_custom_mcp_server(&created.id).unwrap();
    let result = super::probe::test_connection(&store, &server).await;
    assert!(result.ok, "{:?}", result.error);
    assert_eq!(result.protocol_version.as_deref(), Some("2025-06-18"));
    assert_eq!(result.server_info.as_ref().unwrap()["name"], "mock");
    assert_eq!(result.tools.len(), 1);
    assert_eq!(result.tools[0].name, "echo");
    assert_eq!(result.tools[0].description, "Echo text");

    let stored = store.get_custom_mcp_server(&created.id).unwrap();
    assert_eq!(stored.last_status.as_deref(), Some("connected"));
    assert_eq!(stored.tools_cache.len(), 1);
    assert!(stored.last_latency_ms.is_some());
}

#[tokio::test]
async fn probe_failure_records_an_error_without_panicking() {
    use tokio::net::TcpListener;
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let store = Store::open_in_memory().unwrap();
    let created = config::create(
        &store,
        input(json!({
            "name": "Probe down",
            "timeoutMs": 1000,
            "transport": {
                "kind": "http",
                "url": format!("http://127.0.0.1:{port}/mcp")
            }
        })),
    )
    .unwrap();
    let server = store.get_custom_mcp_server(&created.id).unwrap();
    let result = super::probe::test_connection(&store, &server).await;
    assert!(!result.ok);
    assert!(result.error.is_some());
    let stored = store.get_custom_mcp_server(&created.id).unwrap();
    assert_eq!(stored.last_status.as_deref(), Some("error"));
    assert!(stored.last_error.is_some());
}

#[tokio::test]
async fn gateway_bridges_a_real_stdio_server_with_secrets_and_deny_list() {
    use crate::mcp::gateway::{GatewayTokens, McpGateway};
    use crate::mcp::StoreConnector;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    if crate::config::which("node").is_none() {
        eprintln!("skipping gateway stdio test: node is not available");
        return;
    }
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures/mcp-mock.mjs")
        .canonicalize()
        .expect("fixture exists");
    // Node's module loader chokes on a Windows verbatim path (`\\?\D:\...`).
    let fixture = crate::runtime::clean_verbatim(fixture);
    let store = Arc::new(Store::open_in_memory().unwrap());
    let created = config::create(
        &store,
        input(json!({
            "name": "Mock stdio",
            "denyTools": ["delete_*"],
            "timeoutMs": 20000,
            "transport": {
                "kind": "stdio",
                "command": "node",
                "args": [fixture.to_string_lossy()],
                "secretEnv": [{ "key": "API_TOKEN", "value": "sk-gateway-token" }]
            }
        })),
    )
    .unwrap();
    let gateway = McpGateway::start(
        Arc::new(StoreConnector::new(Arc::clone(&store))),
        Arc::new(GatewayTokens::new()),
    )
    .await
    .unwrap();
    let endpoint = gateway
        .endpoint_for(Some("owner"), &created.id)
        .expect("gateway token");

    async fn post(url: &str, token: &str, body: serde_json::Value) -> String {
        let parsed = reqwest::Url::parse(url).unwrap();
        let mut stream = TcpStream::connect((parsed.host_str().unwrap(), parsed.port().unwrap()))
            .await
            .unwrap();
        let body = body.to_string();
        let head = format!(
            "POST {} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            parsed.path(),
            parsed.host_str().unwrap(),
            body.len()
        );
        stream.write_all(head.as_bytes()).await.unwrap();
        stream.write_all(body.as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    }

    let init = post(
        &endpoint.url,
        &endpoint.token,
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }),
    )
    .await;
    if !init.contains("pult-mock-mcp") {
        let logs = gateway.logs(&created.id).await;
        panic!(
            "{init}\nfixture={}\nnode={:?}\nlogs={logs:?}",
            fixture.display(),
            crate::config::which("node")
        );
    }

    let tools = post(
        &endpoint.url,
        &endpoint.token,
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
    )
    .await;
    assert!(tools.contains("\"name\":\"echo\""), "{tools}");
    assert!(!tools.contains("delete_everything"), "{tools}");

    let secret = post(
        &endpoint.url,
        &endpoint.token,
        json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "whoami", "arguments": {} }
        }),
    )
    .await;
    assert!(secret.contains("sk-gateway-token"), "{secret}");
    assert!(secret.contains("pult/untrusted"), "{secret}");

    let blocked = post(
        &endpoint.url,
        &endpoint.token,
        json!({
            "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": { "name": "delete_everything", "arguments": {} }
        }),
    )
    .await;
    assert!(blocked.contains("-32602"), "{blocked}");

    // Diagnostics Reconnect drops the cached transport but keeps the token;
    // the next call must connect and handshake again.
    gateway.drop_client(&created.id).await;
    let reconnected = post(
        &endpoint.url,
        &endpoint.token,
        json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/list" }),
    )
    .await;
    assert!(reconnected.contains("\"name\":\"echo\""), "{reconnected}");
    gateway.close_server(&created.id).await;
}
