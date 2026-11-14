//! JSON-RPC 2.0 envelope handling over the NDJSON codec.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// JSON-RPC error codes used by ACP (`$defs/ErrorCode` of the pinned schema,
/// plus the agent-defined range below -32000 is treated as opaque data).
pub const ERR_PARSE: i64 = -32700;
pub const ERR_INVALID_REQUEST: i64 = -32600;
pub const ERR_METHOD_NOT_FOUND: i64 = -32601;
pub const ERR_INVALID_PARAMS: i64 = -32602;
pub const ERR_INTERNAL: i64 = -32603;
pub const ERR_CANCELLED: i64 = -32800;
pub const ERR_AUTH_REQUIRED: i64 = -32000;
pub const ERR_RESOURCE_NOT_FOUND: i64 = -32002;

/// JSON-RPC request/response id (string or number, `$defs/RequestId`-shaped).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Num(i64),
    Str(String),
}

/// A JSON-RPC error object (`{ code, message, data? }`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, thiserror::Error)]
#[error("rpc error {code}: {message}")]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn method_not_found(method: &str) -> Self {
        Self::new(
            ERR_METHOD_NOT_FOUND,
            format!("method not found: {method}"),
        )
    }
}

/// A message received from the peer, classified per JSON-RPC 2.0.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    /// Peer → us request (has `method` + `id`); must be answered.
    Request {
        id: RequestId,
        method: String,
        params: Value,
    },
    /// Peer → us notification (has `method`, no `id`); never answered.
    Notification { method: String, params: Value },
    /// Response to one of OUR requests (has `id` + `result`/`error`).
    Response {
        id: RequestId,
        result: Result<Value, RpcError>,
    },
}

/// Classification failure: the value is not a valid JSON-RPC message.
/// Callers log and drop — one bad message never kills the stream (§4.4).
#[derive(Debug, thiserror::Error)]
#[error("not a JSON-RPC 2.0 message: {0}")]
pub struct InvalidMessage(pub Value);

/// Compact diagnostic context for a failed parse (kept small: the raw value
/// can be huge; the first 400 chars plus the serde error are enough).
fn jsonrpc_error_context(value: &Value, err: &serde_json::Error) -> Value {
    let head = serde_json::to_string(value)
        .unwrap_or_else(|_| "<unserializable>".to_string());
    let head = head.chars().take(400).collect::<String>();
    serde_json::json!({ "head": head, "error": err.to_string() })
}

pub fn parse_incoming(value: Value) -> Result<Incoming, InvalidMessage> {
    if let Some(method) = value.get("method").and_then(Value::as_str).map(str::to_string) {
        let params = value.get("params").cloned().unwrap_or(Value::Null);
        let id_value = value.get("id").cloned();
        let id = match id_value {
            Some(id) => Some(
                serde_json::from_value::<RequestId>(id)
                    .map_err(|_| InvalidMessage(value))?,
            ),
            None => None,
        };
        return match id {
            Some(id) => Ok(Incoming::Request { id, method, params }),
            None => Ok(Incoming::Notification { method, params }),
        };
    }
    parse_response(value)
}

fn parse_response(value: Value) -> Result<Incoming, InvalidMessage> {
    let Some(id_value) = value.get("id").cloned() else {
        return Err(InvalidMessage(value));
    };
    let err_value = value.get("error").cloned();
    let result_value = value.get("result").cloned();
    let id: RequestId = serde_json::from_value(id_value)
        .map_err(|e| InvalidMessage(jsonrpc_error_context(&value, &e)))?;
    let result = if let Some(err) = err_value {
        let err: RpcError =
            serde_json::from_value(err).map_err(|e| InvalidMessage(jsonrpc_error_context(&value, &e)))?;
        Err(err)
    } else if let Some(res) = result_value {
        Ok(res)
    } else {
        return Err(InvalidMessage(value));
    };
    Ok(Incoming::Response { id, result })
}

/// Outgoing messages we serialize (always valid JSON-RPC 2.0).
#[derive(Debug, Clone, PartialEq)]
pub enum Outgoing {
    Request {
        id: RequestId,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    ResponseOk {
        id: RequestId,
        result: Value,
    },
    ResponseErr {
        id: RequestId,
        error: RpcError,
    },
}

impl Outgoing {
    pub fn to_value(&self) -> Value {
        match self {
            Outgoing::Request { id, method, params } => serde_json::json!({
                "jsonrpc": "2.0", "id": id, "method": method, "params": params,
            }),
            Outgoing::Notification { method, params } => serde_json::json!({
                "jsonrpc": "2.0", "method": method, "params": params,
            }),
            Outgoing::ResponseOk { id, result } => serde_json::json!({
                "jsonrpc": "2.0", "id": id, "result": result,
            }),
            Outgoing::ResponseErr { id, error } => serde_json::json!({
                "jsonrpc": "2.0", "id": id, "error": error,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_agent_request_notification_and_response() {
        let req = parse_incoming(json!({
            "jsonrpc": "2.0", "id": "agent-1", "method": "fs/read_text_file",
            "params": { "sessionId": "s1", "path": "/repo/a.rs" }
        }))
        .unwrap();
        match req {
            Incoming::Request { id, method, params } => {
                assert_eq!(id, RequestId::Str("agent-1".into()));
                assert_eq!(method, "fs/read_text_file");
                assert_eq!(params["path"], "/repo/a.rs");
            }
            other => panic!("wrong: {other:?}"),
        }

        let notif = parse_incoming(json!({
            "jsonrpc": "2.0", "method": "session/update",
            "params": { "sessionId": "s1", "update": { "sessionUpdate": "plan", "entries": [] } }
        }))
        .unwrap();
        assert!(matches!(notif, Incoming::Notification { .. }));

        let ok = parse_incoming(json!({
            "jsonrpc": "2.0", "id": 7, "result": { "stopReason": "end_turn" }
        }))
        .unwrap();
        match ok {
            Incoming::Response { id, result } => {
                assert_eq!(id, RequestId::Num(7));
                assert_eq!(result.unwrap()["stopReason"], "end_turn");
            }
            other => panic!("wrong: {other:?}"),
        }

        let err = parse_incoming(json!({
            "jsonrpc": "2.0", "id": 8,
            "error": { "code": -32000, "message": "auth required" }
        }))
        .unwrap();
        match err {
            Incoming::Response { result, .. } => {
                assert_eq!(result.unwrap_err().code, ERR_AUTH_REQUIRED);
            }
            other => panic!("wrong: {other:?}"),
        }
    }

    #[test]
    fn garbage_is_invalid_not_a_crash() {
        for v in [
            json!(null),
            json!({ "foo": 1 }),
            json!({ "method": "x", "id": { "bad": true } }),
            json!({ "id": 3 }),
        ] {
            assert!(parse_incoming(v.clone()).is_err(), "should reject {v}");
        }
    }

    #[test]
    fn outgoing_round_trips_through_parse() {
        let out = Outgoing::Request {
            id: RequestId::Num(1),
            method: "session/prompt".into(),
            params: json!({ "sessionId": "s", "prompt": [{ "type": "text", "text": "hi" }] }),
        };
        let incoming = parse_incoming(out.to_value()).unwrap();
        match incoming {
            Incoming::Request { id, method, params } => {
                assert_eq!(id, RequestId::Num(1));
                assert_eq!(method, "session/prompt");
                assert_eq!(params["prompt"][0]["type"], "text");
            }
            other => panic!("wrong: {other:?}"),
        }

        let notif = Outgoing::Notification {
            method: "session/cancel".into(),
            params: json!({ "sessionId": "s" }),
        };
        assert!(matches!(
            parse_incoming(notif.to_value()).unwrap(),
            Incoming::Notification { .. }
        ));

        let resp = Outgoing::ResponseErr {
            id: RequestId::Str("agent-9".into()),
            error: RpcError::new(ERR_INVALID_PARAMS, "bad"),
        };
        match parse_incoming(resp.to_value()).unwrap() {
            Incoming::Response { id, result } => {
                assert_eq!(id, RequestId::Str("agent-9".into()));
                assert_eq!(result.unwrap_err().code, ERR_INVALID_PARAMS);
            }
            other => panic!("wrong: {other:?}"),
        }
    }
}
