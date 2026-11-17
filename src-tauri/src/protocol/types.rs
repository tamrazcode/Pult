//! Typed subset of the pinned ACP schema v1.31.0 (`protocol/acp-schema.json`).
//!
//! Every type here mirrors a `$defs` entry; field names are camelCase on the
//! wire (`serde(rename_all = "camelCase")`), discriminator values snake_case.
//! Unknown fields are ignored by serde except `_meta`, which is preserved
//! where the schema defines it (§0.3). Input parsing is lenient (optional
//! fields with defaults); output serialization emits exactly what the schema
//! requires.

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/// `$defs/ProtocolVersion` — a u16 version identifier; v1 is the pinned one.
pub type ProtocolVersion = u16;

/// `$defs/Implementation` — agent/client info block.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Implementation {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

impl Implementation {
    pub fn new(name: &str, version: &str) -> Self {
        Self {
            name: name.to_string(),
            title: None,
            version: Some(version.to_string()),
            meta: None,
        }
    }
}

/// `$defs/ContentBlock` — text | image | audio | resource_link | resource.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ContentBlock {
    Text {
        text: String,
    },
    Image {
        data: String,
        mime_type: String,
    },
    Audio {
        data: String,
        mime_type: String,
    },
    ResourceLink {
        uri: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
    },
    Resource {
        uri: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        blob: Option<String>,
    },
}

impl ContentBlock {
    pub fn text(text: impl Into<String>) -> Self {
        ContentBlock::Text { text: text.into() }
    }
}

/// `$defs/ToolKind` — 10 values in schema v1.31.0 (note: includes switch_mode;
/// unknown future kinds degrade to `Other` instead of failing the update).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    Read,
    Edit,
    Delete,
    Move,
    Search,
    Execute,
    Think,
    Fetch,
    SwitchMode,
    #[serde(other)]
    Other,
}

/// `$defs/ToolCallStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

/// `$defs/PlanEntryStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanEntryStatus {
    Pending,
    InProgress,
    Completed,
}

/// `$defs/PlanEntry`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    pub content: String,
    pub status: PlanEntryStatus,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

/// `$defs/ToolCallLocation`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallLocation {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

/// `$defs/Diff` — file modification attached to a tool call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_text: Option<String>,
    pub new_text: String,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

/// `$defs/ToolCallContent` — content | diff | terminal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ToolCallContent {
    Content {
        content: ContentBlock,
    },
    Diff {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        old_text: Option<String>,
        new_text: String,
    },
    /// Terminal output content; fields mirror `$defs/ToolCallTerminal`-shaped
    /// payloads and are kept raw for M1 (full terminal UI lands in M5).
    Terminal {
        #[serde(flatten)]
        extra: Value,
    },
}

/// `$defs/PermissionOption`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub option_id: String,
    pub name: String,
    /// allow_once | allow_always | reject_once | reject_always (treated as an
    /// opaque string: unknown kinds render as generic buttons, §5.5).
    pub kind: String,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

// ---------------------------------------------------------------------------
// Client → agent (requests we send)
// ---------------------------------------------------------------------------

/// `$defs/FileSystemCapabilities`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSystemCapabilities {
    #[serde(default)]
    pub read_text_file: bool,
    #[serde(default)]
    pub write_text_file: bool,
}

/// `$defs/ClientCapabilities` (subset we advertise; unknown fields omitted).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCapabilities {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fs: Option<FileSystemCapabilities>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<ClientSessionCapabilities>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<AuthCapability>,
}

/// `$defs/AuthCapability`-shaped `{ terminal: bool }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthCapability {
    #[serde(default)]
    pub terminal: bool,
}

/// `$defs/ClientSessionCapabilities` (only what pult advertises).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientSessionCapabilities {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_options: Option<SessionConfigOptionsCapabilities>,
}

/// `$defs/SessionConfigOptionsCapabilities`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfigOptionsCapabilities {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boolean: Option<BooleanConfigOptionCapabilities>,
}

/// `$defs/BooleanConfigOptionCapabilities`: `{}` means boolean options are
/// supported (the agent may send them and the client may set them).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BooleanConfigOptionCapabilities {
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
}

impl ClientCapabilities {
    /// What pult advertises: fs callbacks, terminal auth, boolean config options.
    pub fn pult_v1() -> Self {
        Self {
            fs: Some(FileSystemCapabilities {
                read_text_file: true,
                write_text_file: true,
            }),
            session: Some(ClientSessionCapabilities {
                config_options: Some(SessionConfigOptionsCapabilities {
                    boolean: Some(BooleanConfigOptionCapabilities::default()),
                }),
            }),
            terminal: Some(true),
            auth: Some(AuthCapability { terminal: true }),
        }
    }
}

/// `initialize` request params (`$defs/InitializeRequest`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub protocol_version: ProtocolVersion,
    pub client_capabilities: ClientCapabilities,
    pub client_info: Implementation,
}

/// `$defs/McpServer` — M1 always sends an empty list; http/sse variants kept
/// raw so we never mangle an agent that echoes them back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum McpServer {
    Http {
        #[serde(flatten)]
        extra: Value,
    },
    Sse {
        #[serde(flatten)]
        extra: Value,
    },
    Stdio {
        #[serde(flatten)]
        extra: Value,
    },
}

/// `session/new` request params (`$defs/NewSessionRequest`; subset: cwd + mcpServers).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSessionParams {
    pub cwd: String,
    /// Required by the schema even when empty — agents reject its absence.
    pub mcp_servers: Vec<McpServer>,
}

/// `session/load` request params (capability-gated by loadSession).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadSessionParams {
    pub session_id: String,
    pub cwd: String,
    /// Required by the schema even when empty.
    pub mcp_servers: Vec<McpServer>,
}

/// `session/prompt` request params (`$defs/PromptRequest`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptParams {
    pub session_id: String,
    pub prompt: Vec<ContentBlock>,
}

/// `session/cancel` notification params.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelParams {
    pub session_id: String,
}

/// `session/set_mode` request params.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetModeParams {
    pub session_id: String,
    pub mode_id: String,
}

// ---------------------------------------------------------------------------
// Session config options (§5.4 config pickers)
// ---------------------------------------------------------------------------

/// A selected config value: strings for `select`, booleans for toggles.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ConfigOptionValue {
    String(String),
    Bool(bool),
}

/// One value of a `select` option.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfigSelectOption {
    pub value: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

/// A titled group of select values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfigSelectGroup {
    pub group: String,
    pub name: String,
    #[serde(default, deserialize_with = "deserialize_select_options")]
    pub options: Vec<SessionConfigSelectOption>,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

/// Flat or grouped option values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SessionConfigSelectOptions {
    Flat(Vec<SessionConfigSelectOption>),
    Grouped(Vec<SessionConfigSelectGroup>),
}

/// The `type`-discriminated half of a config option.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionConfigOptionKind {
    Select {
        #[serde(rename = "currentValue")]
        current_value: String,
        options: SessionConfigSelectOptions,
    },
    Boolean {
        #[serde(rename = "currentValue")]
        current_value: bool,
    },
}

/// `$defs/SessionConfigOption`: one selector with its current value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfigOption {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
    #[serde(flatten)]
    pub kind: SessionConfigOptionKind,
}

/// Lenient `configOptions` deserializer: `null` → empty, invalid items are
/// skipped (old rows and future option types must not break the transcript).
pub fn deserialize_config_options<'de, D>(
    deserializer: D,
) -> Result<Vec<SessionConfigOption>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Option::<Vec<Value>>::deserialize(deserializer)?;
    Ok(raw
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| serde_json::from_value(item).ok())
        .collect())
}

/// Lenient one group's `options`: invalid entries are skipped, not fatal.
pub fn deserialize_select_options<'de, D>(
    deserializer: D,
) -> Result<Vec<SessionConfigSelectOption>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Option::<Vec<Value>>::deserialize(deserializer)?;
    Ok(raw
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| serde_json::from_value(item).ok())
        .collect())
}

/// `session/set_config_option` request params; `type` is only sent for
/// boolean values (strings are the schema's default shape).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetConfigOptionParams {
    pub session_id: String,
    pub config_id: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<&'static str>,
    pub value: Value,
}

impl SetConfigOptionParams {
    pub fn new(session_id: &str, config_id: &str, value: ConfigOptionValue) -> Self {
        let (kind, value) = match value {
            ConfigOptionValue::String(v) => (None, Value::String(v)),
            ConfigOptionValue::Bool(v) => (Some("boolean"), Value::Bool(v)),
        };
        Self {
            session_id: session_id.to_string(),
            config_id: config_id.to_string(),
            kind,
            value,
        }
    }
}

/// `session/set_config_option` response: the full updated option set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetConfigOptionResult {
    #[serde(default, deserialize_with = "deserialize_config_options")]
    pub config_options: Vec<SessionConfigOption>,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

/// `authenticate` request params.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticateParams {
    pub method_id: String,
}

// ---------------------------------------------------------------------------
// Agent → client (results we receive)
// ---------------------------------------------------------------------------

/// `$defs/StopReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    MaxTokens,
    MaxTurnRequests,
    Refusal,
    Cancelled,
}

/// `$defs/PromptCapabilities`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptCapabilities {
    #[serde(default)]
    pub image: bool,
    #[serde(default)]
    pub audio: bool,
    #[serde(default)]
    pub embedded_context: bool,
}

/// `$defs/AgentCapabilities` — everything optional; unknown extras ignored.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    #[serde(default)]
    pub load_session: bool,
    #[serde(default)]
    pub prompt_capabilities: PromptCapabilities,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_capabilities: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_capabilities: Option<Value>,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

/// Auth method entry (lenient: `type` discriminates terminal vs agent-managed).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthMethod {
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Terminal-auth argv appended to the configured agent invocation.
    #[serde(
        default,
        deserialize_with = "deserialize_null_string_vec",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub args: Vec<String>,
    /// Terminal-auth env overrides on top of the instance env.
    #[serde(
        default,
        deserialize_with = "deserialize_null_string_map",
        skip_serializing_if = "std::collections::BTreeMap::is_empty"
    )]
    pub env: std::collections::BTreeMap<String, String>,
    #[serde(flatten)]
    pub extra: Value,
}

impl AuthMethod {
    /// Terminal methods must run the CLI themselves and never go over RPC.
    pub fn is_terminal(&self) -> bool {
        self.kind.as_deref() == Some("terminal")
    }

    /// No `type` (schema default) or explicit `agent` means `authenticate`.
    pub fn is_agent(&self) -> bool {
        matches!(self.kind.as_deref(), None | Some("agent"))
    }
}

/// `authenticate` response (`$defs/AuthenticateResponse`; only `_meta`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticateResult {
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

fn deserialize_null_string_vec<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<Vec<String>>::deserialize(deserializer)?.unwrap_or_default())
}

fn deserialize_null_string_map<'de, D>(
    deserializer: D,
) -> Result<std::collections::BTreeMap<String, String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(
        Option::<std::collections::BTreeMap<String, String>>::deserialize(deserializer)?
            .unwrap_or_default(),
    )
}

fn deserialize_null_auth_methods<'de, D>(deserializer: D) -> Result<Vec<AuthMethod>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<Vec<AuthMethod>>::deserialize(deserializer)?.unwrap_or_default())
}

/// `initialize` response (`$defs/InitializeResponse`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub protocol_version: ProtocolVersion,
    #[serde(default)]
    pub agent_capabilities: AgentCapabilities,
    #[serde(
        default,
        deserialize_with = "deserialize_null_auth_methods",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub auth_methods: Vec<AuthMethod>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_info: Option<Implementation>,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

/// `$defs/SessionMode`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMode {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

/// `$defs/SessionModeState`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModeState {
    pub current_mode_id: String,
    #[serde(default)]
    pub available_modes: Vec<SessionMode>,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

/// `session/new` response (`$defs/NewSessionResponse`; configOptions kept
/// raw for M1 — pickers land with the agent matrix).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSessionResult {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modes: Option<SessionModeState>,
    #[serde(default, deserialize_with = "deserialize_config_options")]
    pub config_options: Vec<SessionConfigOption>,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

/// `session/load` response (`$defs/LoadSessionResponse`): no `sessionId` -
/// the client already knows the id it asked to load.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadSessionResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modes: Option<SessionModeState>,
    #[serde(default, deserialize_with = "deserialize_config_options")]
    pub config_options: Vec<SessionConfigOption>,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

/// `session/prompt` response (`$defs/PromptResponse`-shaped `{ stopReason }`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptResult {
    pub stop_reason: StopReason,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

// ---------------------------------------------------------------------------
// Notifications: session/update (all 14 variants of schema v1.31.0)
// ---------------------------------------------------------------------------

/// `$defs/SessionNotification`: `{ sessionId, update }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionNotification {
    pub session_id: String,
    pub update: SessionUpdate,
}

/// `$defs/SessionUpdate` — discriminated by the `sessionUpdate` field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "sessionUpdate",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SessionUpdate {
    UserMessageChunk {
        content: ContentBlock,
    },
    AgentMessageChunk {
        content: ContentBlock,
    },
    AgentThoughtChunk {
        content: ContentBlock,
    },
    ToolCall {
        tool_call_id: String,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kind: Option<ToolKind>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<ToolCallStatus>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<Vec<ToolCallContent>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        locations: Option<Vec<ToolCallLocation>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        raw_input: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        raw_output: Option<Value>,
        #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
        meta: Option<Value>,
    },
    ToolCallUpdate {
        tool_call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kind: Option<ToolKind>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<ToolCallStatus>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<Vec<ToolCallContent>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        locations: Option<Vec<ToolCallLocation>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        raw_input: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        raw_output: Option<Value>,
        #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
        meta: Option<Value>,
    },
    Plan {
        entries: Vec<PlanEntry>,
    },
    AvailableCommandsUpdate {
        #[serde(default)]
        available_commands: Vec<AvailableCommand>,
        #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
        meta: Option<Value>,
    },
    CurrentModeUpdate {
        current_mode_id: String,
        #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
        meta: Option<Value>,
    },
    ConfigOptionUpdate {
        #[serde(default, deserialize_with = "deserialize_config_options")]
        config_options: Vec<SessionConfigOption>,
    },
    SessionInfoUpdate {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        updated_at: Option<String>,
        #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
        meta: Option<Value>,
    },
    UsageUpdate {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        used: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cost: Option<Value>,
        #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
        meta: Option<Value>,
    },
    /// `$defs/Notice` — severity (info|warning|error|other) + title; kept
    /// lenient (schema also allows future severities as raw strings).
    Notice {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        severity: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<Value>,
        #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
        meta: Option<Value>,
    },
    CompactionUpdate {
        compaction_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<Value>,
        #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
        meta: Option<Value>,
    },
    CompactionSummaryChunk {
        compaction_id: String,
        content: ContentBlock,
        #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
        meta: Option<Value>,
    },
}

/// `$defs/AvailableCommand`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableCommand {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

// ---------------------------------------------------------------------------
// Client-side methods: requests we serve (agent → client)
// ---------------------------------------------------------------------------

/// `$defs/ToolCallUpdate` — the standalone tool-call description struct used
/// inside `session/request_permission` (distinct from the SessionUpdate
/// variant of the same name).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallUpdateData {
    pub tool_call_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<ToolKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<ToolCallStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<Vec<ToolCallContent>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locations: Option<Vec<ToolCallLocation>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_input: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_output: Option<Value>,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

/// `session/request_permission` params (`$defs/RequestPermissionRequest`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestPermissionParams {
    pub session_id: String,
    pub tool_call: ToolCallUpdateData,
    pub options: Vec<PermissionOption>,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

/// `session/request_permission` response (`$defs/RequestPermissionResponse`):
/// `{ outcome: { outcome: "selected", optionId } }` or `{ outcome: { outcome: "cancelled" } }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestPermissionOutcome {
    pub outcome: RequestPermissionOutcomeKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "outcome",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RequestPermissionOutcomeKind {
    Selected { option_id: String },
    Cancelled,
}

/// `fs/read_text_file` params (`$defs/ReadTextFileRequest`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadTextFileParams {
    pub session_id: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

/// `fs/read_text_file` result: `{ content }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadTextFileResult {
    pub content: String,
}

/// `fs/write_text_file` params (`$defs/WriteTextFileRequest`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteTextFileParams {
    pub session_id: String,
    pub path: String,
    pub content: String,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

/// `fs/write_text_file` result: empty object.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WriteTextFileResult {}

// ---------------------------------------------------------------------------
// Terminal callbacks (§5.5): the client runs processes for the agent.
// ---------------------------------------------------------------------------

/// One `env` entry of `terminal/create` (`$defs/EnvVariable`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvVariable {
    pub name: String,
    pub value: String,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

/// `terminal/create` params (`$defs/CreateTerminalRequest`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminalParams {
    pub session_id: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env: Vec<EnvVariable>,
    /// Byte cap for the retained output ring; truncation stays on a char
    /// boundary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_byte_limit: Option<u64>,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

/// `terminal/create` response (`$defs/CreateTerminalResponse`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminalResult {
    pub terminal_id: String,
}

/// Shared `{ sessionId, terminalId }` params (output / wait / kill / release).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRefParams {
    pub session_id: String,
    pub terminal_id: String,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

/// `terminal/output` response (`$defs/TerminalOutputResponse`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputResult {
    pub output: String,
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_status: Option<TerminalExitStatus>,
}

/// `$defs/TerminalExitStatus`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitStatus {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
}

/// `terminal/wait_for_exit` response (`$defs/WaitForTerminalExitResponse`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitForTerminalExitResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
}

/// `elicitation/create` params. Top level carries `message`; the mode branch
/// (`form` → `requestedSchema`, `url` → `url` + `elicitationId`) and the scope
/// (`sessionId` / `toolCallId`) stay raw — the UI renders from the JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateElicitationParams {
    pub message: String,
    #[serde(flatten)]
    pub detail: Value,
}

/// `elicitation/create` response (`$defs/CreateElicitationResponse`-shaped).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElicitationResult {
    pub action: ElicitationAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ElicitationAction {
    Accept,
    Decline,
    Cancel,
}

// ---------------------------------------------------------------------------
// Tests: every shape from the schema, exercised through serde
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse_update(v: Value) -> Result<SessionNotification, serde_json::Error> {
        serde_json::from_value(v)
    }

    #[test]
    fn all_14_session_update_variants_parse() {
        let cases: Vec<(Value, &str)> = vec![
            (
                json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"u"}}),
                "user chunk",
            ),
            (
                json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"a"}}),
                "agent chunk",
            ),
            (
                json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"t"}}),
                "thought chunk",
            ),
            (
                json!({"sessionUpdate":"tool_call","toolCallId":"t1","title":"Read","kind":"read","status":"in_progress","locations":[{"path":"/repo/a.rs","line":3}],"rawInput":{"x":1}}),
                "tool call",
            ),
            (
                json!({"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"completed","content":[{"type":"content","content":{"type":"text","text":"done"}}]}),
                "tool update",
            ),
            (
                json!({"sessionUpdate":"tool_call_update","toolCallId":"t1","content":[{"type":"diff","path":"/repo/b.rs","oldText":"a","newText":"b"}]}),
                "tool diff",
            ),
            (
                json!({"sessionUpdate":"plan","entries":[{"content":"step","status":"in_progress"}]}),
                "plan",
            ),
            (
                json!({"sessionUpdate":"available_commands_update","availableCommands":[{"name":"mock-echo","description":"Echo"}]}),
                "commands",
            ),
            (
                json!({"sessionUpdate":"current_mode_update","currentModeId":"architect"}),
                "mode",
            ),
            (
                json!({"sessionUpdate":"config_option_update","configOptions":[]}),
                "config",
            ),
            (
                json!({"sessionUpdate":"session_info_update","title":"New title"}),
                "info",
            ),
            (
                json!({"sessionUpdate":"usage_update","used":120,"size":200000,"cost":{"amount":0.01,"currency":"USD"}}),
                "usage",
            ),
            (
                json!({"sessionUpdate":"notice","severity":"info","title":"Hello","content":{"type":"text","text":"x"}}),
                "notice",
            ),
            (
                json!({"sessionUpdate":"compaction_update","compactionId":"c1","status":"completed"}),
                "compaction",
            ),
            (
                json!({"sessionUpdate":"compaction_summary_chunk","compactionId":"c1","content":{"type":"text","text":"sum"}}),
                "compaction chunk",
            ),
        ];
        for (v, name) in cases {
            let wrapped = json!({"sessionId": "s1", "update": v});
            let parsed = parse_update(wrapped).unwrap_or_else(|e| panic!("{name} failed: {e}"));
            let _ = parsed.update;
        }
    }

    #[test]
    fn terminal_callback_params_parse() {
        let create: CreateTerminalParams = serde_json::from_value(json!({
            "sessionId": "s1", "command": "bash", "args": ["-lc", "echo hi"],
            "cwd": "/repo", "env": [{"name": "A", "value": "b"}],
            "outputByteLimit": 4096
        }))
        .expect("create params");
        assert_eq!(create.command, "bash");
        assert_eq!(create.output_byte_limit, Some(4096));
        let out: TerminalOutputResult = serde_json::from_value(json!({
            "output": "hi
        ", "truncated": false,
            "exitStatus": {"exitCode": 0, "signal": null}
        }))
        .expect("output result");
        assert_eq!(out.exit_status.map(|s| s.exit_code), Some(Some(0)));
        let wait: WaitForTerminalExitResult =
            serde_json::from_value(json!({"exitCode": 2, "signal": null})).expect("wait result");
        assert_eq!(wait.exit_code, Some(2));
    }

    #[test]
    fn elicitation_params_parse_both_modes() {
        let form: CreateElicitationParams = serde_json::from_value(json!({
            "message": "Pick a color", "mode": "form",
            "requestedSchema": {
                "type": "object", "title": "Colors",
                "properties": {"color": {"type": "string", "enum": ["red", "blue"]}},
                "required": ["color"]
            },
            "sessionId": "s1"
        }))
        .expect("form elicitation");
        assert_eq!(form.message, "Pick a color");
        assert_eq!(
            form.detail["requestedSchema"]["properties"]["color"]["enum"][0],
            "red"
        );
        let url: CreateElicitationParams = serde_json::from_value(json!({
            "message": "Sign in", "mode": "url",
            "elicitationId": "e1", "url": "https://example.com/auth", "sessionId": "s1"
        }))
        .expect("url elicitation");
        assert_eq!(url.detail["url"], "https://example.com/auth");
    }

    #[test]
    fn unknown_update_variant_fails_and_unknown_fields_are_ignored() {
        // Unknown tag → parse error (caller logs + drops, stream survives).
        let wrapped = json!({"sessionId": "s1", "update": {"sessionUpdate": "hologram", "x": 1}});
        assert!(parse_update(wrapped).is_err());
        // Unknown extra fields are ignored, known ones still parse.
        let wrapped = json!({"sessionId": "s1", "update": {
            "sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "ok"},
            "futureField": {"weird": true}
        }});
        match parse_update(wrapped).unwrap().update {
            SessionUpdate::AgentMessageChunk { content } => {
                assert_eq!(content, ContentBlock::text("ok"));
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn tool_kind_has_switch_mode_and_other_catches_unknown() {
        let kind: ToolKind = serde_json::from_value(json!("switch_mode")).unwrap();
        assert_eq!(kind, ToolKind::SwitchMode);
        let kind: ToolKind = serde_json::from_value(json!("vibecode")).unwrap();
        assert_eq!(kind, ToolKind::Other);
    }

    #[test]
    fn stop_reason_matches_pinned_schema() {
        for v in [
            "end_turn",
            "max_tokens",
            "max_turn_requests",
            "refusal",
            "cancelled",
        ] {
            serde_json::from_value::<StopReason>(json!(v)).unwrap_or_else(|e| panic!("{v}: {e}"));
        }
    }

    #[test]
    fn permission_response_shape_matches_schema() {
        let selected = RequestPermissionOutcome {
            outcome: RequestPermissionOutcomeKind::Selected {
                option_id: "allow".into(),
            },
        };
        let v = serde_json::to_value(&selected).unwrap();
        assert_eq!(
            v,
            json!({"outcome": {"outcome": "selected", "optionId": "allow"}})
        );
        let cancelled = RequestPermissionOutcome {
            outcome: RequestPermissionOutcomeKind::Cancelled,
        };
        assert_eq!(
            serde_json::to_value(&cancelled).unwrap(),
            json!({"outcome": {"outcome": "cancelled"}})
        );
    }

    #[test]
    fn initialize_params_serialize_exactly_what_we_advertise() {
        let params = InitializeParams {
            protocol_version: 1,
            client_capabilities: ClientCapabilities::pult_v1(),
            client_info: Implementation::new("pult", "0.1.0"),
        };
        let v = serde_json::to_value(&params).unwrap();
        assert_eq!(v["protocolVersion"], 1);
        assert_eq!(v["clientCapabilities"]["fs"]["readTextFile"], true);
        assert_eq!(v["clientCapabilities"]["fs"]["writeTextFile"], true);
        assert_eq!(v["clientCapabilities"]["terminal"], true);
        assert_eq!(v["clientCapabilities"]["auth"]["terminal"], true);
        assert_eq!(v["clientInfo"]["name"], "pult");
    }

    #[test]
    fn initialize_result_parses_with_defaults() {
        let v = json!({
            "protocolVersion": 1,
            "agentCapabilities": {
                "loadSession": true,
                "promptCapabilities": {"image": true, "audio": false, "embeddedContext": false}
            },
            "authMethods": [{"type": "terminal", "id": "term", "name": "Sign in"}],
            "agentInfo": {"name": "mock-acp-agent", "version": "0.1.0"}
        });
        let r: InitializeResult = serde_json::from_value(v).unwrap();
        assert_eq!(r.protocol_version, 1);
        assert!(r.agent_capabilities.load_session);
        assert!(r.agent_capabilities.prompt_capabilities.image);
        assert_eq!(r.auth_methods.len(), 1);
        assert_eq!(r.agent_info.as_ref().unwrap().name, "mock-acp-agent");
    }

    #[test]
    fn new_session_result_parses_modes() {
        let v = json!({
            "sessionId": "mock-session-1",
            "modes": {
                "currentModeId": "code",
                "availableModes": [
                    {"id": "code", "name": "Code"},
                    {"id": "architect", "name": "Architect", "description": "Plan first"}
                ]
            }
        });
        let r: NewSessionResult = serde_json::from_value(v).unwrap();
        let modes = r.modes.unwrap();
        assert_eq!(modes.current_mode_id, "code");
        assert_eq!(modes.available_modes.len(), 2);
        assert_eq!(modes.available_modes[1].id, "architect");
    }

    #[test]
    fn new_session_params_always_send_mcp_servers() {
        let value = serde_json::to_value(NewSessionParams {
            cwd: "C:\\work".to_string(),
            mcp_servers: Vec::new(),
        })
        .unwrap();
        assert_eq!(value["mcpServers"], json!([]));
    }

    #[test]
    fn prompt_result_parses_stop_reason() {
        let r: PromptResult = serde_json::from_value(json!({"stopReason": "end_turn"})).unwrap();
        assert_eq!(r.stop_reason, StopReason::EndTurn);
    }

    #[test]
    fn content_block_text_roundtrip() {
        let block = ContentBlock::text("hello");
        let v = serde_json::to_value(&block).unwrap();
        assert_eq!(v, json!({"type": "text", "text": "hello"}));
        let back: ContentBlock = serde_json::from_value(v).unwrap();
        assert_eq!(back, block);
    }

    #[test]
    fn config_options_parse_flat_grouped_boolean_and_skip_unknown() {
        #[derive(serde::Deserialize)]
        struct Holder {
            #[serde(default, deserialize_with = "deserialize_config_options")]
            config_options: Vec<SessionConfigOption>,
        }
        let holder: Holder = serde_json::from_value(json!({
            "config_options": [
                {"id":"model","name":"Model","category":"model","type":"select","currentValue":"m1",
                 "options":[{"value":"m1","name":"M1"}]},
                {"id":"thought","name":"Thought","category":"thought_level","type":"select","currentValue":"low",
                 "options":[{"group":"main","name":"Main","options":[{"value":"low","name":"Low"},{"broken":true}]}]},
                {"id":"search","name":"Search","type":"boolean","currentValue":false},
                {"id":"future","name":"Future","type":"slider","currentValue":5}
            ]
        }))
        .unwrap();
        assert_eq!(holder.config_options.len(), 3);
        match &holder.config_options[1].kind {
            SessionConfigOptionKind::Select {
                current_value,
                options,
            } => {
                assert_eq!(current_value, "low");
                match options {
                    SessionConfigSelectOptions::Grouped(groups) => {
                        assert_eq!(groups[0].group, "main");
                        assert_eq!(groups[0].options[0].value, "low");
                    }
                    SessionConfigSelectOptions::Flat(_) => panic!("expected grouped options"),
                }
            }
            SessionConfigOptionKind::Boolean { .. } => panic!("expected select"),
        }

        let empty: Holder = serde_json::from_value(json!({"config_options": null})).unwrap();
        assert!(empty.config_options.is_empty());
    }

    #[test]
    fn set_config_option_params_serialize_select_and_boolean() {
        let string = serde_json::to_value(SetConfigOptionParams::new(
            "s1",
            "model",
            ConfigOptionValue::String("m1".into()),
        ))
        .unwrap();
        assert_eq!(
            string,
            json!({"sessionId":"s1","configId":"model","value":"m1"})
        );

        let boolean = serde_json::to_value(SetConfigOptionParams::new(
            "s1",
            "search",
            ConfigOptionValue::Bool(true),
        ))
        .unwrap();
        assert_eq!(
            boolean,
            json!({"sessionId":"s1","configId":"search","type":"boolean","value":true})
        );
    }

    #[test]
    fn client_capabilities_advertise_boolean_config_options() {
        let caps = serde_json::to_value(ClientCapabilities::pult_v1()).unwrap();
        assert!(
            caps["session"]["configOptions"]["boolean"].is_object(),
            "{caps}"
        );
    }

    #[test]
    fn auth_method_parses_agent_terminal_and_null_fields() {
        let agent: AuthMethod = serde_json::from_value(json!({"id":"a","name":"Agent"})).unwrap();
        assert!(agent.is_agent());
        assert!(!agent.is_terminal());
        assert!(agent.args.is_empty());

        let explicit: AuthMethod =
            serde_json::from_value(json!({"type":"agent","id":"b","name":"Agent B"})).unwrap();
        assert!(explicit.is_agent());

        let terminal: AuthMethod = serde_json::from_value(json!({
            "type":"terminal","id":"t","name":"Terminal",
            "args":["--login"],"env":{"MOCK_LOGIN":"1"}
        }))
        .unwrap();
        assert!(terminal.is_terminal());
        assert!(!terminal.is_agent());
        assert_eq!(terminal.args, vec!["--login".to_string()]);
        assert_eq!(
            terminal.env.get("MOCK_LOGIN").map(String::as_str),
            Some("1")
        );

        let nulls: AuthMethod = serde_json::from_value(json!({
            "id":"n","name":"Null","args":null,"env":null,"description":null
        }))
        .unwrap();
        assert!(nulls.args.is_empty());
        assert!(nulls.env.is_empty());

        let init: InitializeResult =
            serde_json::from_value(json!({"protocolVersion": 1, "authMethods": null})).unwrap();
        assert!(init.auth_methods.is_empty());
    }

    #[test]
    fn authenticate_params_and_result_wire_shape() {
        let params = serde_json::to_value(AuthenticateParams {
            method_id: "mock-token".into(),
        })
        .unwrap();
        assert_eq!(params, json!({"methodId": "mock-token"}));

        let _: AuthenticateResult = serde_json::from_value(json!({})).unwrap();
        let null: Option<AuthenticateResult> = serde_json::from_value(json!(null)).unwrap();
        assert!(null.is_none());
    }

    #[test]
    fn request_permission_params_parse_from_agent() {
        let v = json!({
            "sessionId": "s1",
            "toolCall": {"toolCallId": "t2", "title": "Edit file", "kind": "edit"},
            "options": [
                {"optionId": "allow", "name": "Allow", "kind": "allow_once"},
                {"optionId": "reject", "name": "Reject", "kind": "reject_once"}
            ]
        });
        let p: RequestPermissionParams = serde_json::from_value(v).unwrap();
        assert_eq!(p.tool_call.tool_call_id, "t2");
        assert_eq!(p.options.len(), 2);
        assert_eq!(p.options[0].kind, "allow_once");
    }
}

#[test]
fn new_session_params_serialize_injected_mcp_servers() {
    let params = NewSessionParams {
        cwd: "C:\\work".to_string(),
        mcp_servers: vec![McpServer::Http {
            extra: serde_json::json!({
                "name": "pult",
                "url": "http://127.0.0.1:4321/mcp",
                "headers": { "Authorization": "Bearer test" }
            }),
        }],
    };
    let value = serde_json::to_value(params).unwrap();
    assert_eq!(value["cwd"], "C:\\work");
    assert_eq!(value["mcpServers"][0]["type"], "http");
    assert_eq!(value["mcpServers"][0]["name"], "pult");
    assert_eq!(value["mcpServers"][0]["url"], "http://127.0.0.1:4321/mcp");
}
