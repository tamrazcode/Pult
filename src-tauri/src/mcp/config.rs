//! Custom MCP server configuration: validation, secret separation and the
//! IPC-facing view that never carries plaintext secrets.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::events::now_millis;
use crate::store::Store;
use crate::PultError;

use super::secrets::mask_secret;

pub const RESERVED_NAMES: [&str; 3] = ["pult_orchestrator", "pult", "orchestrator"];
pub const DEFAULT_TIMEOUT_MS: i64 = 30_000;
pub const MIN_TIMEOUT_MS: i64 = 1_000;
pub const MAX_TIMEOUT_MS: i64 = 120_000;
const MAX_NAME_CHARS: usize = 64;

static SERVER_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Fully-qualified secret key → plaintext awaiting encryption.
type SecretValues = Vec<(String, String)>;

/// Transport as persisted: secret *names* only, values live in `SecretStore`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TransportConfig {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
        #[serde(default, rename = "secretEnvKeys")]
        secret_env_keys: Vec<String>,
    },
    Http {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
        #[serde(default, rename = "secretHeaderKeys")]
        secret_header_keys: Vec<String>,
    },
    Sse {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
        #[serde(default, rename = "secretHeaderKeys")]
        secret_header_keys: Vec<String>,
    },
}

impl TransportConfig {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Stdio { .. } => "stdio",
            Self::Http { .. } => "http",
            Self::Sse { .. } => "sse",
        }
    }

    fn secret_keys(&self) -> Vec<&str> {
        match self {
            Self::Stdio {
                secret_env_keys, ..
            } => secret_env_keys.iter().map(String::as_str).collect(),
            Self::Http {
                secret_header_keys, ..
            }
            | Self::Sse {
                secret_header_keys, ..
            } => secret_header_keys.iter().map(String::as_str).collect(),
        }
    }
}

/// One persisted server row (not the IPC shape).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomMcpServer {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub transport: TransportConfig,
    pub scope: String,
    pub project_id: Option<String>,
    pub thread_id: Option<String>,
    pub provider_ids: Vec<String>,
    pub allow_tools: Vec<String>,
    pub deny_tools: Vec<String>,
    pub timeout_ms: i64,
    pub allow_localhost: bool,
    pub last_status: Option<String>,
    pub last_error: Option<String>,
    pub last_latency_ms: Option<i64>,
    pub last_checked_at: Option<i64>,
    pub tools_cache: Vec<serde_json::Value>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A secret the UI may see: name, whether a value exists, and a mask.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretRef {
    pub key: String,
    pub has_value: bool,
    pub masked: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TransportView {
    Stdio {
        command: String,
        args: Vec<String>,
        cwd: Option<String>,
        env: BTreeMap<String, String>,
        #[serde(rename = "secretEnvKeys")]
        secret_env_keys: Vec<SecretRef>,
    },
    Http {
        url: String,
        headers: BTreeMap<String, String>,
        #[serde(rename = "secretHeaderKeys")]
        secret_header_keys: Vec<SecretRef>,
    },
    Sse {
        url: String,
        headers: BTreeMap<String, String>,
        #[serde(rename = "secretHeaderKeys")]
        secret_header_keys: Vec<SecretRef>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomMcpServerView {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub transport: TransportView,
    pub scope: String,
    pub project_id: Option<String>,
    pub thread_id: Option<String>,
    pub provider_ids: Vec<String>,
    pub allow_tools: Vec<String>,
    pub deny_tools: Vec<String>,
    pub timeout_ms: i64,
    pub allow_localhost: bool,
    pub status: String,
    pub last_error: Option<String>,
    pub last_latency_ms: Option<i64>,
    pub last_checked_at: Option<i64>,
    pub tools_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A secret value supplied on create/update. `value: None` keeps the stored
/// value (a blank field in the edit modal means "unchanged").
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretInput {
    pub key: String,
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TransportInput {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
        #[serde(default, rename = "secretEnv")]
        secret_env: Vec<SecretInput>,
    },
    Http {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
        #[serde(default, rename = "secretHeaders")]
        secret_headers: Vec<SecretInput>,
    },
    Sse {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
        #[serde(default, rename = "secretHeaders")]
        secret_headers: Vec<SecretInput>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomMcpServerInput {
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub transport: TransportInput,
    #[serde(default = "default_scope")]
    pub scope: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub provider_ids: Vec<String>,
    #[serde(default)]
    pub allow_tools: Vec<String>,
    #[serde(default)]
    pub deny_tools: Vec<String>,
    #[serde(default = "default_timeout")]
    pub timeout_ms: i64,
    #[serde(default = "default_true")]
    pub allow_localhost: bool,
}

fn default_true() -> bool {
    true
}

fn default_timeout() -> i64 {
    DEFAULT_TIMEOUT_MS
}

fn default_scope() -> String {
    "global".to_string()
}

/// Validates a display name and blocks Pult's own orchestration server.
pub fn validate_name(raw: &str) -> Result<String, PultError> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(PultError::with_code(
            "mcp.empty_name",
            "MCP server name must not be empty",
        ));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(PultError::with_code(
            "mcp.name_too_long",
            format!("MCP server name must be at most {MAX_NAME_CHARS} characters"),
        ));
    }
    if name.chars().any(char::is_control) {
        return Err(PultError::with_code(
            "mcp.invalid_name",
            "MCP server name must not contain control characters",
        ));
    }
    let lowered = name.to_ascii_lowercase();
    if RESERVED_NAMES.contains(&lowered.as_str()) {
        return Err(PultError::with_code(
            "mcp.reserved_name",
            format!("`{name}` is reserved for Pult's built-in orchestrator"),
        ));
    }
    Ok(name.to_string())
}

fn server_id() -> String {
    let seq = SERVER_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("mcp-{}-{seq}", now_millis())
}

/// Creates a server and its secrets atomically, then returns the safe view.
pub fn create(
    store: &Store,
    input: CustomMcpServerInput,
) -> Result<CustomMcpServerView, PultError> {
    let id = server_id();
    let now = now_millis();
    let prepared = prepare(store, &id, input, now)?;
    if store.custom_mcp_name_taken(&prepared.server.name, None)? {
        return Err(duplicate_name(&prepared.server.name));
    }
    store.insert_custom_mcp_server(&prepared.server, &prepared.secret_values)?;
    view(store, &prepared.server)
}

/// Replaces the config. Secrets absent from the new transport are deleted;
/// secrets without a new value keep the stored one.
pub fn update(
    store: &Store,
    id: &str,
    input: CustomMcpServerInput,
) -> Result<CustomMcpServerView, PultError> {
    let existing = store.get_custom_mcp_server(id)?;
    let now = now_millis();
    let prepared = prepare(store, id, input, now)?;
    if store.custom_mcp_name_taken(&prepared.server.name, Some(id))? {
        return Err(duplicate_name(&prepared.server.name));
    }
    let mut server = prepared.server;
    server.created_at = existing.created_at;
    // A config edit invalidates any cached health/tools until the next probe.
    server.last_status = None;
    server.last_error = None;
    server.last_latency_ms = None;
    server.last_checked_at = None;
    server.tools_cache.clear();

    let removed: Vec<String> = existing
        .transport
        .secret_keys()
        .into_iter()
        .filter(|key| !server.transport.secret_keys().contains(key))
        .map(|key| secret_store_key(id, &existing.transport, key))
        .collect();
    store.update_custom_mcp_server(&server, &prepared.secret_values, &removed)?;
    view(store, &server)
}

pub fn list(store: &Store) -> Result<Vec<CustomMcpServerView>, PultError> {
    store
        .list_custom_mcp_servers()?
        .iter()
        .map(|server| view(store, server))
        .collect()
}

pub fn get(store: &Store, id: &str) -> Result<CustomMcpServerView, PultError> {
    let server = store.get_custom_mcp_server(id)?;
    view(store, &server)
}

pub fn delete(store: &Store, id: &str) -> Result<(), PultError> {
    store.delete_custom_mcp_server(id)
}

pub fn set_enabled(
    store: &Store,
    id: &str,
    enabled: bool,
) -> Result<CustomMcpServerView, PultError> {
    let mut server = store.get_custom_mcp_server(id)?;
    if server.enabled != enabled {
        server.enabled = enabled;
        server.updated_at = now_millis();
        store.update_custom_mcp_server(&server, &[], &[])?;
    }
    view(store, &server)
}

struct Prepared {
    server: CustomMcpServer,
    /// Fully-qualified secret key → plaintext to store now.
    secret_values: SecretValues,
}

fn prepare(
    store: &Store,
    id: &str,
    input: CustomMcpServerInput,
    now: i64,
) -> Result<Prepared, PultError> {
    let name = validate_name(&input.name)?;
    let scope = input.scope.trim().to_ascii_lowercase();
    let (project_id, thread_id) = match scope.as_str() {
        "global" => (None, None),
        "project" => {
            let project = input
                .project_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    PultError::with_code(
                        "mcp.invalid_scope",
                        "Project-scoped MCP servers need a project id",
                    )
                })?;
            if store.get_project(project).is_err() {
                return Err(PultError::with_code(
                    "mcp.invalid_scope",
                    format!("Project `{project}` was not found"),
                ));
            }
            (Some(project.to_string()), None)
        }
        "thread" => {
            let thread = input
                .thread_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    PultError::with_code(
                        "mcp.invalid_scope",
                        "Thread-scoped MCP servers need a thread id",
                    )
                })?;
            if store.get_thread(thread).is_err() {
                return Err(PultError::with_code(
                    "mcp.invalid_scope",
                    format!("Thread `{thread}` was not found"),
                ));
            }
            (input.project_id.clone(), Some(thread.to_string()))
        }
        other => {
            return Err(PultError::with_code(
                "mcp.invalid_scope",
                format!("Unknown MCP scope `{other}`"),
            ))
        }
    };

    let (transport, secret_values) = prepare_transport(id, input.transport)?;
    let server = CustomMcpServer {
        id: id.to_string(),
        name,
        enabled: input.enabled,
        transport,
        scope,
        project_id,
        thread_id,
        provider_ids: dedupe(input.provider_ids),
        allow_tools: dedupe(input.allow_tools),
        deny_tools: dedupe(input.deny_tools),
        timeout_ms: input.timeout_ms.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
        allow_localhost: input.allow_localhost,
        last_status: None,
        last_error: None,
        last_latency_ms: None,
        last_checked_at: None,
        tools_cache: Vec::new(),
        created_at: now,
        updated_at: now,
    };
    Ok(Prepared {
        server,
        secret_values,
    })
}

fn prepare_transport(
    id: &str,
    input: TransportInput,
) -> Result<(TransportConfig, SecretValues), PultError> {
    match input {
        TransportInput::Stdio {
            command,
            args,
            cwd,
            env,
            secret_env,
        } => {
            let command = command.trim();
            if command.is_empty() {
                return Err(PultError::with_code(
                    "mcp.invalid_transport",
                    "stdio MCP servers need a command",
                ));
            }
            let env = clean_map(env, "environment variable")?;
            let (secret_env_keys, secret_values) = clean_secrets(id, "env", secret_env, &env)?;
            Ok((
                TransportConfig::Stdio {
                    command: command.to_string(),
                    args,
                    cwd: cwd
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty()),
                    env,
                    secret_env_keys,
                },
                secret_values,
            ))
        }
        TransportInput::Http {
            url,
            headers,
            secret_headers,
        } => {
            let url = clean_url(&url)?;
            let headers = clean_map(headers, "header")?;
            let (secret_header_keys, secret_values) =
                clean_secrets(id, "header", secret_headers, &headers)?;
            Ok((
                TransportConfig::Http {
                    url,
                    headers,
                    secret_header_keys,
                },
                secret_values,
            ))
        }
        TransportInput::Sse {
            url,
            headers,
            secret_headers,
        } => {
            let url = clean_url(&url)?;
            let headers = clean_map(headers, "header")?;
            let (secret_header_keys, secret_values) =
                clean_secrets(id, "header", secret_headers, &headers)?;
            Ok((
                TransportConfig::Sse {
                    url,
                    headers,
                    secret_header_keys,
                },
                secret_values,
            ))
        }
    }
}

fn clean_url(raw: &str) -> Result<String, PultError> {
    let url = raw.trim();
    let lowered = url.to_ascii_lowercase();
    if !(lowered.starts_with("https://") || lowered.starts_with("http://")) {
        return Err(PultError::with_code(
            "mcp.invalid_url",
            "MCP server URL must start with https:// or http://",
        ));
    }
    Ok(url.to_string())
}

fn clean_map(
    map: BTreeMap<String, String>,
    what: &str,
) -> Result<BTreeMap<String, String>, PultError> {
    let mut out = BTreeMap::new();
    for (key, value) in map {
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        if key.chars().any(char::is_control) {
            return Err(PultError::with_code(
                "mcp.invalid_transport",
                format!("MCP {what} name contains control characters"),
            ));
        }
        out.insert(key.to_string(), value);
    }
    Ok(out)
}

fn clean_secrets(
    id: &str,
    section: &str,
    inputs: Vec<SecretInput>,
    plain: &BTreeMap<String, String>,
) -> Result<(Vec<String>, SecretValues), PultError> {
    let mut keys = Vec::new();
    let mut values = Vec::new();
    let mut seen = BTreeSet::new();
    for input in inputs {
        let key = input.key.trim().to_string();
        if key.is_empty() {
            continue;
        }
        if key.chars().any(char::is_control) || (section == "env" && key.contains('=')) {
            return Err(PultError::with_code(
                "mcp.invalid_secret",
                format!("Invalid secret {section} name `{key}`"),
            ));
        }
        if !seen.insert(key.clone()) {
            return Err(PultError::with_code(
                "mcp.duplicate_secret",
                format!("Secret `{key}` is listed twice"),
            ));
        }
        if plain.contains_key(&key) {
            return Err(PultError::with_code(
                "mcp.secret_conflict",
                format!("`{key}` cannot be both plain and secret"),
            ));
        }
        keys.push(key.clone());
        if let Some(value) = input.value.filter(|value| !value.is_empty()) {
            values.push((format!("mcp:{id}:{section}:{key}"), value));
        }
    }
    Ok((keys, values))
}

fn dedupe(values: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for value in values {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if seen.insert(value.to_string()) {
            out.push(value.to_string());
        }
    }
    out
}

fn secret_store_key(id: &str, transport: &TransportConfig, key: &str) -> String {
    let section = match transport {
        TransportConfig::Stdio { .. } => "env",
        TransportConfig::Http { .. } | TransportConfig::Sse { .. } => "header",
    };
    format!("mcp:{id}:{section}:{key}")
}

fn view(store: &Store, server: &CustomMcpServer) -> Result<CustomMcpServerView, PultError> {
    let secret_refs = |keys: &[String]| -> Vec<SecretRef> {
        keys.iter()
            .map(|key| {
                let full = secret_store_key(&server.id, &server.transport, key);
                match store.get_secret(&full) {
                    Ok(Some(value)) => SecretRef {
                        key: key.clone(),
                        has_value: true,
                        masked: Some(mask_secret(&value)),
                    },
                    Ok(None) => SecretRef {
                        key: key.clone(),
                        has_value: false,
                        masked: None,
                    },
                    Err(error) => {
                        // A missing/corrupt install key must not hide the whole
                        // list; the row surfaces as "no value" and Test
                        // Connection explains the failure.
                        tracing::warn!(
                            target: "pult::mcp",
                            server = %server.name,
                            key = %key,
                            error = %error,
                            "stored MCP secret could not be read"
                        );
                        SecretRef {
                            key: key.clone(),
                            has_value: false,
                            masked: None,
                        }
                    }
                }
            })
            .collect()
    };
    let transport = match &server.transport {
        TransportConfig::Stdio {
            command,
            args,
            cwd,
            env,
            secret_env_keys,
        } => TransportView::Stdio {
            command: command.clone(),
            args: args.clone(),
            cwd: cwd.clone(),
            env: env.clone(),
            secret_env_keys: secret_refs(secret_env_keys),
        },
        TransportConfig::Http {
            url,
            headers,
            secret_header_keys,
        } => TransportView::Http {
            url: url.clone(),
            headers: headers.clone(),
            secret_header_keys: secret_refs(secret_header_keys),
        },
        TransportConfig::Sse {
            url,
            headers,
            secret_header_keys,
        } => TransportView::Sse {
            url: url.clone(),
            headers: headers.clone(),
            secret_header_keys: secret_refs(secret_header_keys),
        },
    };
    let status = if server.enabled {
        server
            .last_status
            .clone()
            .unwrap_or_else(|| "unknown".to_string())
    } else {
        "disabled".to_string()
    };
    Ok(CustomMcpServerView {
        id: server.id.clone(),
        name: server.name.clone(),
        enabled: server.enabled,
        transport,
        scope: server.scope.clone(),
        project_id: server.project_id.clone(),
        thread_id: server.thread_id.clone(),
        provider_ids: server.provider_ids.clone(),
        allow_tools: server.allow_tools.clone(),
        deny_tools: server.deny_tools.clone(),
        timeout_ms: server.timeout_ms,
        allow_localhost: server.allow_localhost,
        status,
        last_error: server.last_error.clone(),
        last_latency_ms: server.last_latency_ms,
        last_checked_at: server.last_checked_at,
        tools_count: server.tools_cache.len() as i64,
        created_at: server.created_at,
        updated_at: server.updated_at,
    })
}

fn duplicate_name(name: &str) -> PultError {
    PultError::with_code(
        "mcp.duplicate_name",
        format!("An MCP server named `{name}` already exists"),
    )
}
