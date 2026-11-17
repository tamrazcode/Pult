//! Isolated `mcp_test_connection` probe: own transport, `initialize` +
//! `tools/list`, then close. Never touches the gateway or warm sessions.

use std::time::Instant;

use serde::Serialize;
use serde_json::{json, Value};

use crate::store::Store;

use super::config::CustomMcpServer;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeTool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub ok: bool,
    pub server_info: Option<Value>,
    pub protocol_version: Option<String>,
    pub tools: Vec<ProbeTool>,
    pub latency_ms: u64,
    pub error: Option<String>,
}

/// Probes one stored server and records the result on its health row.
pub async fn test_connection(store: &Store, server: &CustomMcpServer) -> ProbeResult {
    let started = Instant::now();
    let result = probe(store, server).await;
    let mut result = result;
    result.latency_ms = started.elapsed().as_millis() as u64;
    let tools_json = result
        .tools
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name,
                "description": tool.description,
                "inputSchema": tool.input_schema
            })
        })
        .collect::<Vec<_>>();
    let status = if result.ok { "connected" } else { "error" };
    let _ = store.set_custom_mcp_health(
        &server.id,
        status,
        result.error.as_deref(),
        Some(result.latency_ms as i64),
        Some(&tools_json),
    );
    result
}

async fn probe(store: &Store, server: &CustomMcpServer) -> ProbeResult {
    let failed = |error: String, latency_ms: u64| ProbeResult {
        ok: false,
        server_info: None,
        protocol_version: None,
        tools: Vec::new(),
        latency_ms,
        error: Some(error),
    };
    let transport = match super::connect_custom(store, server).await {
        Ok(transport) => transport,
        Err(error) => return failed(error, 0),
    };
    let initialize = transport
        .request(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "Pult", "version": env!("CARGO_PKG_VERSION") }
            }
        }))
        .await;
    let reply = match initialize {
        Ok(reply) => reply,
        Err(error) => {
            let _ = transport.close().await;
            return failed(error, 0);
        }
    };
    if let Some(error) = reply.get("error") {
        let _ = transport.close().await;
        return failed(format!("initialize failed: {error}"), 0);
    }
    let _ = transport
        .notify(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
        .await;

    let tools_reply = transport
        .request(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }))
        .await;
    let _ = transport.close().await;
    let tools_reply = match tools_reply {
        Ok(reply) => reply,
        Err(error) => return failed(error, 0),
    };
    if let Some(error) = tools_reply.get("error") {
        return failed(format!("tools/list failed: {error}"), 0);
    }
    let result = &tools_reply["result"];
    let tools = result["tools"]
        .as_array()
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| {
                    let name = tool.get("name").and_then(Value::as_str)?;
                    let description = tool
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let description = description.chars().take(2_000).collect::<String>();
                    Some(ProbeTool {
                        name: name.to_string(),
                        description,
                        input_schema: tool
                            .get("inputSchema")
                            .cloned()
                            .unwrap_or_else(|| json!({ "type": "object" })),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    ProbeResult {
        ok: true,
        server_info: reply
            .get("result")
            .and_then(|r| r.get("serverInfo"))
            .cloned(),
        protocol_version: reply
            .get("result")
            .and_then(|r| r.get("protocolVersion"))
            .and_then(Value::as_str)
            .map(str::to_string),
        tools,
        latency_ms: 0,
        error: None,
    }
}
