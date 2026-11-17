//! User-configured external MCP servers: config, secrets, transports and the
//! loopback gateway agents actually connect to.

pub mod config;
pub mod gateway;
pub mod http;
pub mod manager;
pub mod probe;
pub mod resolve;
pub mod secrets;
pub mod security;
pub mod sse;
pub mod stdio;
pub mod transport;

#[cfg(test)]
mod tests;

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use crate::store::Store;

use self::config::{CustomMcpServer, TransportConfig};
use self::gateway::{GatewayConnector, GatewayPolicy};
use self::transport::{McpTransport, TransportFuture};

/// Builds the real upstream transport for one stored server, resolving secret
/// values from the vault only here. Agents never see these values.
pub(crate) async fn connect_custom(
    store: &Store,
    server: &CustomMcpServer,
) -> Result<Arc<dyn McpTransport>, String> {
    let timeout = Duration::from_millis(server.timeout_ms.clamp(1_000, 120_000) as u64);
    match &server.transport {
        TransportConfig::Stdio {
            command,
            args,
            cwd,
            env,
            secret_env_keys,
        } => {
            let mut env: BTreeMap<String, String> = env.clone();
            for key in secret_env_keys {
                let full = config::secret_store_key_for("env", &server.id, key);
                let value = store
                    .get_secret(&full)
                    .map_err(|error| error.to_string())?
                    .ok_or_else(|| format!("MCP secret `{key}` is not set"))?;
                env.insert(key.clone(), value);
            }
            stdio::StdioTransport::spawn(stdio::StdioConfig {
                command: command.clone(),
                args: args.clone(),
                cwd: cwd.clone(),
                env,
                timeout,
                label: server.name.clone(),
            })
            .map(|transport| transport as Arc<dyn McpTransport>)
        }
        TransportConfig::Http {
            url,
            headers,
            secret_header_keys,
        } => {
            security::validate_url(url, server.allow_localhost).await?;
            let headers = resolve_headers(store, server, headers, secret_header_keys)?;
            http::HttpTransport::connect(http::HttpConfig {
                url: url.clone(),
                headers,
                timeout,
                label: server.name.clone(),
            })
            .map(|transport| Arc::new(transport) as Arc<dyn McpTransport>)
        }
        TransportConfig::Sse {
            url,
            headers,
            secret_header_keys,
        } => {
            security::validate_url(url, server.allow_localhost).await?;
            let headers = resolve_headers(store, server, headers, secret_header_keys)?;
            sse::SseTransport::connect(sse::SseConfig {
                url: url.clone(),
                headers,
                timeout,
                label: server.name.clone(),
            })
            .await
            .map(|transport| transport as Arc<dyn McpTransport>)
        }
    }
}

fn resolve_headers(
    store: &Store,
    server: &CustomMcpServer,
    plain: &BTreeMap<String, String>,
    secret_keys: &[String],
) -> Result<BTreeMap<String, String>, String> {
    let mut headers = plain.clone();
    for key in secret_keys {
        let full = config::secret_store_key_for("header", &server.id, key);
        let value = store
            .get_secret(&full)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("MCP secret `{key}` is not set"))?;
        headers.insert(key.clone(), value);
    }
    Ok(headers)
}

/// Connector used by the app gateway: reads the config row, then connects.
pub struct StoreConnector {
    store: Arc<Store>,
}

impl StoreConnector {
    pub fn new(store: Arc<Store>) -> Self {
        Self { store }
    }
}

impl GatewayConnector for StoreConnector {
    fn connect<'a>(&'a self, server_id: &'a str) -> TransportFuture<'a, Arc<dyn McpTransport>> {
        Box::pin(async move {
            let server = self
                .store
                .get_custom_mcp_server(server_id)
                .map_err(|error| error.to_string())?;
            if !server.enabled {
                return Err(format!("MCP server `{}` is disabled", server.name));
            }
            connect_custom(&self.store, &server).await
        })
    }

    fn policy(&self, server_id: &str) -> GatewayPolicy {
        match self.store.get_custom_mcp_server(server_id) {
            Ok(server) => GatewayPolicy {
                allow_tools: server.allow_tools,
                deny_tools: server.deny_tools,
            },
            // A row vanished between connect and call: permit nothing.
            Err(_) => GatewayPolicy {
                allow_tools: Vec::new(),
                deny_tools: vec!["*".to_string()],
            },
        }
    }
}
