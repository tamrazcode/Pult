//! Claude/Cursor `mcpServers` JSON import and export. Export replaces every
//! secret with `${NAME}`; import moves credential-looking values into the
//! vault and skips name conflicts instead of overwriting user servers.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{json, Value};

use crate::store::Store;
use crate::PultError;

use super::config::{self, CustomMcpServerInput, SecretInput, TransportInput};
use super::security;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub name: String,
    /// `imported` or `skipped`.
    pub status: String,
    pub error: Option<String>,
}

/// Imports every entry of a `{ "mcpServers": { name: config } }` document.
pub async fn import_json(store: &Store, raw: &str) -> Result<Vec<ImportOutcome>, PultError> {
    let document: Value = serde_json::from_str(raw).map_err(|e| {
        PultError::with_code("mcp.invalid_json", format!("Import is not valid JSON: {e}"))
    })?;
    let servers = document
        .get("mcpServers")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            PultError::with_code(
                "mcp.invalid_json",
                "Import needs a top-level `mcpServers` object",
            )
        })?;

    let mut outcomes = Vec::new();
    for (name, entry) in servers {
        let outcome = import_one(store, name, entry).await;
        outcomes.push(outcome);
    }
    Ok(outcomes)
}

async fn import_one(store: &Store, name: &str, entry: &Value) -> ImportOutcome {
    let name = name.trim().to_string();
    let skipped = |error: String| ImportOutcome {
        name: name.clone(),
        status: "skipped".to_string(),
        error: Some(error),
    };
    if let Err(error) = config::validate_name(&name) {
        return skipped(error.to_string());
    }
    match store.custom_mcp_name_taken(&name, None) {
        Ok(true) => return skipped("a server with this name already exists".to_string()),
        Ok(false) => {}
        Err(error) => return skipped(error.to_string()),
    }
    let Some((transport, _loopback_ok)) = parse_transport(entry).await else {
        return skipped("entry has neither `command` nor a supported `url`".to_string());
    };
    let mut input: CustomMcpServerInput = match serde_json::from_value(json!({
        "name": name,
        "transport": { "kind": "stdio", "command": "unused" }
    })) {
        Ok(input) => input,
        Err(error) => return skipped(format!("could not build config: {error}")),
    };
    input.transport = transport;
    // Import is inert: nothing runs or connects until the user reviews the
    // entry, enables it, and separately allows loopback. `_loopback_ok` above
    // only decides whether a local URL is accepted by validation.
    input.enabled = false;
    input.allow_localhost = false;
    match config::create(store, input) {
        Ok(_) => ImportOutcome {
            name,
            status: "imported".to_string(),
            error: None,
        },
        Err(error) => skipped(error.to_string()),
    }
}

/// Returns the transport plus the `allow_localhost` flag it must be imported
/// with: only a loopback URL may reach a local address later.
async fn parse_transport(entry: &Value) -> Option<(TransportInput, bool)> {
    if let Some(command) = entry.get("command").and_then(Value::as_str) {
        let command = command.trim();
        if command.is_empty() {
            return None;
        }
        let args = string_array(entry.get("args"));
        let cwd = entry
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let (env, secret_env) = split_secrets(entry.get("env"));
        return Some((
            TransportInput::Stdio {
                command: command.to_string(),
                args,
                cwd,
                env,
                secret_env,
            },
            true,
        ));
    }
    let url = entry.get("url").and_then(Value::as_str)?.trim().to_string();
    let allow_localhost = is_loopback_url(&url);
    if security::validate_url(&url, allow_localhost).await.is_err() {
        return None;
    }
    let (headers, secret_headers) = split_secrets(entry.get("headers"));
    let kind = entry
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("http")
        .to_ascii_lowercase();
    if kind == "sse" || kind == "legacy-sse" {
        Some((
            TransportInput::Sse {
                url,
                headers,
                secret_headers,
            },
            allow_localhost,
        ))
    } else {
        Some((
            TransportInput::Http {
                url,
                headers,
                secret_headers,
            },
            allow_localhost,
        ))
    }
}

/// `true` for 127.0.0.0/8, `::1` and `localhost` / `localhost.` — the only
/// hosts an imported server may ever be allowed to reach locally.
fn is_loopback_url(raw: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(raw) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.');
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

fn split_secrets(value: Option<&Value>) -> (BTreeMap<String, String>, Vec<SecretInput>) {
    let mut plain = BTreeMap::new();
    let mut secret = Vec::new();
    let Some(map) = value.and_then(Value::as_object) else {
        return (plain, secret);
    };
    for (key, value) in map {
        let Some(value) = value.as_str() else {
            continue;
        };
        if !looks_secret(key) {
            plain.insert(key.clone(), value.to_string());
            continue;
        }
        // Claude/Cursor templates leave `${VAR}`; resolve from the environment
        // when possible, otherwise ask the user to fill the secret in.
        let resolved = placeholder_name(value)
            .and_then(|name| std::env::var(name).ok())
            .or_else(|| {
                if placeholder_name(value).is_some() {
                    None
                } else {
                    Some(value.to_string())
                }
            });
        secret.push(SecretInput {
            key: key.clone(),
            value: resolved,
        });
    }
    (plain, secret)
}

fn placeholder_name(value: &str) -> Option<&str> {
    let inner = value.strip_prefix("${")?.strip_suffix('}')?;
    (!inner.is_empty()).then_some(inner)
}

fn looks_secret(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    ["TOKEN", "KEY", "SECRET", "PASSWORD", "AUTH", "API"]
        .iter()
        .any(|marker| upper.contains(marker))
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Exports the selected servers (all when `ids` is empty) with placeholders
/// instead of secrets.
pub fn export_json(store: &Store, ids: &[String]) -> Result<String, PultError> {
    let mut servers = serde_json::Map::new();
    for server in store.list_custom_mcp_servers()? {
        if !ids.is_empty() && !ids.iter().any(|id| id == &server.id) {
            continue;
        }
        let config = match &server.transport {
            config::TransportConfig::Stdio {
                command,
                args,
                cwd,
                env,
                secret_env_keys,
            } => {
                let mut env_out: BTreeMap<String, String> = env.clone();
                for key in secret_env_keys {
                    env_out.insert(key.clone(), format!("${{{key}}}"));
                }
                let mut value = json!({ "command": command, "args": args });
                if let Some(cwd) = cwd {
                    value["cwd"] = json!(cwd);
                }
                if !env_out.is_empty() {
                    value["env"] = json!(env_out);
                }
                value
            }
            config::TransportConfig::Http {
                url,
                headers,
                secret_header_keys,
            }
            | config::TransportConfig::Sse {
                url,
                headers,
                secret_header_keys,
            } => {
                let mut headers_out: BTreeMap<String, String> = headers.clone();
                for key in secret_header_keys {
                    headers_out.insert(key.clone(), format!("${{{key}}}"));
                }
                let kind = if matches!(&server.transport, config::TransportConfig::Sse { .. }) {
                    "sse"
                } else {
                    "http"
                };
                let mut value = json!({ "url": url, "type": kind });
                if !headers_out.is_empty() {
                    value["headers"] = json!(headers_out);
                }
                value
            }
        };
        servers.insert(server.name, config);
    }
    serde_json::to_string_pretty(&json!({ "mcpServers": servers }))
        .map_err(|e| PultError::internal(format!("encode MCP export: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(value: Value) -> CustomMcpServerInput {
        serde_json::from_value(value).unwrap()
    }

    #[tokio::test]
    async fn imports_stdio_and_moves_secret_looking_env_into_the_vault() {
        let store = Store::open_in_memory().unwrap();
        let outcomes = import_json(
            &store,
            &json!({
                "mcpServers": {
                    "filesystem": {
                        "command": "npx",
                        "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
                        "env": { "LOG_LEVEL": "debug", "API_TOKEN": "sk-import-123456" }
                    }
                }
            })
            .to_string(),
        )
        .await
        .unwrap();
        assert_eq!(outcomes[0].status, "imported", "{:?}", outcomes[0]);
        let server = store.list_custom_mcp_servers().unwrap().remove(0);
        assert_eq!(server.name, "filesystem");
        let config::TransportConfig::Stdio {
            env,
            secret_env_keys,
            ..
        } = &server.transport
        else {
            panic!("expected stdio");
        };
        assert_eq!(env.get("LOG_LEVEL").map(String::as_str), Some("debug"));
        assert!(!env.contains_key("API_TOKEN"));
        assert_eq!(secret_env_keys, &vec!["API_TOKEN".to_string()]);
        assert_eq!(
            store
                .get_secret(&format!("mcp:{}:env:API_TOKEN", server.id))
                .unwrap()
                .as_deref(),
            Some("sk-import-123456")
        );
    }

    #[tokio::test]
    async fn import_is_inert_and_never_grants_loopback() {
        let store = Store::open_in_memory().unwrap();
        // Public IP literal on purpose: no DNS lookup inside the test.
        let outcomes = import_json(
            &store,
            &json!({
                "mcpServers": {
                    "local": { "url": "http://127.0.0.1:8123/mcp" },
                    "remote": { "url": "https://1.1.1.1/mcp" }
                }
            })
            .to_string(),
        )
        .await
        .unwrap();
        assert!(
            outcomes.iter().all(|outcome| outcome.status == "imported"),
            "{outcomes:?}"
        );
        let servers = store.list_custom_mcp_servers().unwrap();
        let by_name = |name: &str| {
            servers
                .iter()
                .find(|server| server.name == name)
                .unwrap_or_else(|| panic!("{name} was not imported"))
        };
        // Imported entries do not start and cannot reach loopback until the
        // user enables them and allows localhost explicitly.
        for name in ["local", "remote"] {
            assert!(!by_name(name).enabled, "{name} must import disabled");
            assert!(!by_name(name).allow_localhost, "{name} must not allow loopback");
        }
    }

    #[test]
    fn loopback_urls_only_cover_local_hosts() {
        assert!(is_loopback_url("http://127.0.0.1:9000/mcp"));
        assert!(is_loopback_url("http://127.1.2.3/mcp"));
        assert!(is_loopback_url("http://[::1]:9000/mcp"));
        assert!(is_loopback_url("http://localhost:9000/mcp"));
        assert!(is_loopback_url("http://localhost.:9000/mcp"));
        assert!(!is_loopback_url("https://1.1.1.1/mcp"));
        assert!(!is_loopback_url("http://192.168.1.10:9000/mcp"));
        assert!(!is_loopback_url("not a url"));
    }

    #[tokio::test]
    async fn export_replaces_secrets_with_placeholders() {
        let store = Store::open_in_memory().unwrap();
        config::create(
            &store,
            input(json!({
                "name": "Remote",
                "transport": {
                    "kind": "http",
                    "url": "https://mcp.example.com/mcp",
                    "headers": { "Accept": "application/json" },
                    "secretHeaders": [{ "key": "Authorization", "value": "Bearer super-secret" }]
                }
            })),
        )
        .unwrap();
        let exported = export_json(&store, &[]).unwrap();
        assert!(!exported.contains("super-secret"), "{exported}");
        assert!(exported.contains("${Authorization}"), "{exported}");
        assert!(exported.contains("\"Accept\": \"application/json\""));
    }

    #[tokio::test]
    async fn import_skips_conflicts_and_blocked_urls() {
        let store = Store::open_in_memory().unwrap();
        config::create(
            &store,
            input(json!({
                "name": "Existing",
                "transport": { "kind": "stdio", "command": "npx" }
            })),
        )
        .unwrap();
        let outcomes = import_json(
            &store,
            &json!({
                "mcpServers": {
                    "Existing": { "command": "npx" },
                    "metadata": { "url": "https://169.254.169.254/latest/meta-data" },
                    "ok": { "url": "https://example.com/mcp" }
                }
            })
            .to_string(),
        )
        .await
        .unwrap();
        let status = |name: &str| {
            outcomes
                .iter()
                .find(|outcome| outcome.name == name)
                .map(|outcome| outcome.status.clone())
                .unwrap()
        };
        assert_eq!(status("Existing"), "skipped");
        assert_eq!(status("metadata"), "skipped");
        assert_eq!(status("ok"), "imported");
    }
}
