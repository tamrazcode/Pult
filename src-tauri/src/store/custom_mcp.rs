//! SQLite rows for user-configured MCP servers.

use rusqlite::{params, OptionalExtension, Row};

use crate::events::now_millis;
use crate::mcp::config::CustomMcpServer;
use crate::PultError;

use super::secrets::{delete_secret_keys, delete_secrets_with_prefix, put_secret};
use super::{sql, Store};

const COLUMNS: &str = "id, name, enabled, transport_kind, transport_config_json, scope, \
    project_id, thread_id, provider_ids_json, tool_allowlist_json, tool_denylist_json, \
    timeout_ms, allow_localhost, last_status, last_error, last_latency_ms, last_checked_at, \
    tools_cache_json, created_at, updated_at";

impl Store {
    pub fn list_custom_mcp_servers(&self) -> Result<Vec<CustomMcpServer>, PultError> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {COLUMNS} FROM custom_mcp_servers ORDER BY name COLLATE NOCASE"
                ))
                .map_err(|e| sql("list custom mcp servers", e))?;
            let rows = stmt
                .query_map([], server_from_row)
                .map_err(|e| sql("list custom mcp servers", e))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| sql("list custom mcp servers row", e))
        })
    }

    pub fn get_custom_mcp_server(&self, id: &str) -> Result<CustomMcpServer, PultError> {
        self.with_conn(|conn| {
            conn.query_row(
                &format!("SELECT {COLUMNS} FROM custom_mcp_servers WHERE id = ?1"),
                params![id],
                server_from_row,
            )
            .optional()
            .map_err(|e| sql("get custom mcp server", e))?
            .ok_or_else(|| not_found(id))
        })
    }

    /// Case-insensitive name check; `except_id` lets an edit keep its own name.
    pub fn custom_mcp_name_taken(
        &self,
        name: &str,
        except_id: Option<&str>,
    ) -> Result<bool, PultError> {
        self.with_conn(|conn| {
            let found: Option<i64> = conn
                .query_row(
                    "SELECT 1 FROM custom_mcp_servers
                     WHERE lower(name) = lower(?1) AND id <> ?2",
                    params![name, except_id.unwrap_or("")],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| sql("check custom mcp server name", e))?;
            Ok(found.is_some())
        })
    }

    pub fn insert_custom_mcp_server(
        &self,
        server: &CustomMcpServer,
        secrets: &[(String, String)],
    ) -> Result<(), PultError> {
        let transport_json = serde_json::to_string(&server.transport)
            .map_err(|e| PultError::store(format!("encode mcp transport: {e}")))?;
        let tools_json = serde_json::to_string(&server.tools_cache)
            .map_err(|e| PultError::store(format!("encode mcp tools: {e}")))?;
        self.with_conn(|conn| {
            let tx = conn
                .unchecked_transaction()
                .map_err(|e| sql("begin mcp server insert", e))?;
            tx.execute(
                "INSERT INTO custom_mcp_servers (
                    id, name, enabled, transport_kind, transport_config_json, scope,
                    project_id, thread_id, provider_ids_json, tool_allowlist_json,
                    tool_denylist_json, timeout_ms, allow_localhost, last_status,
                    last_error, last_latency_ms, last_checked_at, tools_cache_json,
                    created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                           ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
                params![
                    server.id,
                    server.name,
                    server.enabled,
                    server.transport.kind(),
                    transport_json,
                    server.scope,
                    server.project_id,
                    server.thread_id,
                    encode_list(&server.provider_ids),
                    encode_list(&server.allow_tools),
                    encode_list(&server.deny_tools),
                    server.timeout_ms,
                    server.allow_localhost,
                    server.last_status,
                    server.last_error,
                    server.last_latency_ms,
                    server.last_checked_at,
                    tools_json,
                    server.created_at,
                    server.updated_at,
                ],
            )
            .map_err(|e| sql("insert custom mcp server", e))?;
            for (key, value) in secrets {
                let blob = self.seal_secret(value)?;
                put_secret(&tx, key, &blob)?;
            }
            tx.commit().map_err(|e| sql("commit mcp server insert", e))
        })
    }

    pub fn update_custom_mcp_server(
        &self,
        server: &CustomMcpServer,
        secrets: &[(String, String)],
        removed_secret_keys: &[String],
    ) -> Result<(), PultError> {
        let transport_json = serde_json::to_string(&server.transport)
            .map_err(|e| PultError::store(format!("encode mcp transport: {e}")))?;
        let tools_json = serde_json::to_string(&server.tools_cache)
            .map_err(|e| PultError::store(format!("encode mcp tools: {e}")))?;
        self.with_conn(|conn| {
            let tx = conn
                .unchecked_transaction()
                .map_err(|e| sql("begin mcp server update", e))?;
            let changed = tx
                .execute(
                    "UPDATE custom_mcp_servers SET
                        name = ?2, enabled = ?3, transport_kind = ?4,
                        transport_config_json = ?5, scope = ?6, project_id = ?7,
                        thread_id = ?8, provider_ids_json = ?9, tool_allowlist_json = ?10,
                        tool_denylist_json = ?11, timeout_ms = ?12, allow_localhost = ?13,
                        last_status = ?14, last_error = ?15, last_latency_ms = ?16,
                        last_checked_at = ?17, tools_cache_json = ?18, updated_at = ?19
                     WHERE id = ?1",
                    params![
                        server.id,
                        server.name,
                        server.enabled,
                        server.transport.kind(),
                        transport_json,
                        server.scope,
                        server.project_id,
                        server.thread_id,
                        encode_list(&server.provider_ids),
                        encode_list(&server.allow_tools),
                        encode_list(&server.deny_tools),
                        server.timeout_ms,
                        server.allow_localhost,
                        server.last_status,
                        server.last_error,
                        server.last_latency_ms,
                        server.last_checked_at,
                        tools_json,
                        server.updated_at,
                    ],
                )
                .map_err(|e| sql("update custom mcp server", e))?;
            if changed == 0 {
                return Err(not_found(&server.id));
            }
            delete_secret_keys(&tx, removed_secret_keys)?;
            for (key, value) in secrets {
                let blob = self.seal_secret(value)?;
                put_secret(&tx, key, &blob)?;
            }
            tx.commit().map_err(|e| sql("commit mcp server update", e))
        })
    }

    pub fn delete_custom_mcp_server(&self, id: &str) -> Result<(), PultError> {
        let prefix = format!("mcp:{id}:");
        self.with_conn(|conn| {
            let tx = conn
                .unchecked_transaction()
                .map_err(|e| sql("begin mcp server delete", e))?;
            let deleted = tx
                .execute("DELETE FROM custom_mcp_servers WHERE id = ?1", params![id])
                .map_err(|e| sql("delete custom mcp server", e))?;
            if deleted == 0 {
                return Err(not_found(id));
            }
            delete_secrets_with_prefix(&tx, &prefix)?;
            tx.commit().map_err(|e| sql("commit mcp server delete", e))
        })
    }

    /// Health cache writes from the probe/manager (T19). Never touches secrets
    /// or the user's transport config.
    pub fn set_custom_mcp_health(
        &self,
        id: &str,
        status: &str,
        error: Option<&str>,
        latency_ms: Option<i64>,
        tools: Option<&[serde_json::Value]>,
    ) -> Result<(), PultError> {
        let tools_json = tools
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| PultError::store(format!("encode mcp tools: {e}")))?;
        let now = now_millis();
        self.with_conn(|conn| {
            let changed = conn
                .execute(
                    "UPDATE custom_mcp_servers SET
                        last_status = ?2, last_error = ?3, last_latency_ms = ?4,
                        last_checked_at = ?5,
                        tools_cache_json = COALESCE(?6, tools_cache_json)
                     WHERE id = ?1",
                    params![id, status, error, latency_ms, now, tools_json],
                )
                .map_err(|e| sql("update mcp health", e))?;
            if changed == 0 {
                return Err(not_found(id));
            }
            Ok(())
        })
    }
}

fn server_from_row(row: &Row<'_>) -> rusqlite::Result<CustomMcpServer> {
    let transport_json: String = row.get(4)?;
    let transport = serde_json::from_str(&transport_json).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let tools_json: Option<String> = row.get(17)?;
    let tools_cache = tools_json
        .as_deref()
        .and_then(|value| serde_json::from_str::<Vec<serde_json::Value>>(value).ok())
        .unwrap_or_default();
    Ok(CustomMcpServer {
        id: row.get(0)?,
        name: row.get(1)?,
        enabled: row.get(2)?,
        transport,
        scope: row.get(5)?,
        project_id: row.get(6)?,
        thread_id: row.get(7)?,
        provider_ids: decode_list(row.get::<_, String>(8)?),
        allow_tools: decode_list(row.get::<_, String>(9)?),
        deny_tools: decode_list(row.get::<_, String>(10)?),
        timeout_ms: row.get(11)?,
        allow_localhost: row.get(12)?,
        last_status: row.get(13)?,
        last_error: row.get(14)?,
        last_latency_ms: row.get(15)?,
        last_checked_at: row.get(16)?,
        tools_cache,
        created_at: row.get(18)?,
        updated_at: row.get(19)?,
    })
}

fn encode_list(values: &[String]) -> String {
    serde_json::to_string(values).unwrap_or_else(|_| "[]".to_string())
}

fn decode_list(raw: String) -> Vec<String> {
    serde_json::from_str(&raw).unwrap_or_default()
}

fn not_found(id: &str) -> PultError {
    PultError::with_code("mcp.not_found", format!("MCP server `{id}` was not found"))
}

/// Per-project/thread include/exclude override for a server.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpBinding {
    pub server_id: String,
    pub mode: String,
}

impl Store {
    pub fn list_mcp_bindings(
        &self,
        scope_type: &str,
        scope_id: &str,
    ) -> Result<Vec<McpBinding>, PultError> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT server_id, mode FROM mcp_server_bindings
                     WHERE scope_type = ?1 AND scope_id = ?2 ORDER BY server_id",
                )
                .map_err(|e| sql("list mcp bindings", e))?;
            let rows = stmt
                .query_map(params![scope_type, scope_id], |row| {
                    Ok(McpBinding {
                        server_id: row.get(0)?,
                        mode: row.get(1)?,
                    })
                })
                .map_err(|e| sql("list mcp bindings", e))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| sql("list mcp bindings row", e))
        })
    }

    /// Upserts a binding (`include`/`exclude`); `None` deletes it.
    pub fn set_mcp_binding(
        &self,
        scope_type: &str,
        scope_id: &str,
        server_id: &str,
        mode: Option<&str>,
    ) -> Result<(), PultError> {
        if !matches!(scope_type, "project" | "thread") {
            return Err(PultError::with_code(
                "mcp.invalid_scope",
                "MCP bindings only exist for projects and threads",
            ));
        }
        if let Some(mode) = mode {
            if !matches!(mode, "include" | "exclude") {
                return Err(PultError::with_code(
                    "mcp.invalid_binding",
                    "MCP binding mode must be `include` or `exclude`",
                ));
            }
        }
        self.with_conn(|conn| {
            match mode {
                Some(mode) => conn
                    .execute(
                        "INSERT INTO mcp_server_bindings
                            (scope_type, scope_id, server_id, mode, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5)
                         ON CONFLICT(scope_type, scope_id, server_id)
                         DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at",
                        params![scope_type, scope_id, server_id, mode, now_millis()],
                    )
                    .map_err(|e| sql("upsert mcp binding", e))?,
                None => conn
                    .execute(
                        "DELETE FROM mcp_server_bindings
                         WHERE scope_type = ?1 AND scope_id = ?2 AND server_id = ?3",
                        params![scope_type, scope_id, server_id],
                    )
                    .map_err(|e| sql("delete mcp binding", e))?,
            };
            Ok(())
        })
    }
}
