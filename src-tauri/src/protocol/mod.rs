//! Wire-level ACP protocol layer.
//!
//! Ground truth: `protocol/acp-schema.json` — pinned ACP schema **v1.31.0**
//! (downloaded from agentclientprotocol releases, `schema-v1.31.0`; meta in
//! `protocol/acp-meta.json`, `version: 1`). Nothing in this module may invent
//! a wire shape: every struct mirrors a `$defs` entry of that schema.
//!
//! Layers:
//! - [`codec`] — NDJSON framing (one JSON value per `\n`-terminated line).
//! - [`jsonrpc`] — JSON-RPC 2.0 envelope parse/serialize, error codes.
//! - [`types`] — typed subset of the schema (client↔agent messages).

pub mod codec;
pub mod jsonrpc;
pub mod types;

/// Latest protocol version of the pinned schema (ACP meta "version": 1).
pub const LATEST_PROTOCOL_VERSION: u16 = 1;
