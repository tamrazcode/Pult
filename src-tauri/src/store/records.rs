//! IPC-facing row records (§5). Field names serialize as camelCase for TS.

use serde::{Deserialize, Serialize};

/// A conversation thread.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRecord {
    pub id: String,
    pub project_id: Option<String>,
    pub title: String,
    pub status: String,
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
    /// Session cwd for this thread (§4.4); `None` = the global workspace root.
    pub workspace: Option<String>,
    /// Parent repo when the thread works in a `git worktree` (M4).
    pub main_repo: Option<String>,
    pub worktree_name: Option<String>,
}

/// One agent run within a thread.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub id: String,
    pub thread_id: String,
    pub idx: i64,
    pub status: String,
    pub instance_id: String,
    pub model: Option<String>,
    pub mode: Option<String>,
    pub effort: Option<String>,
    pub started_at: i64,
    pub stopped_at: Option<i64>,
    pub stop_reason: Option<String>,
    /// Failure detail (crash diagnostics, §9); `None` for healthy runs.
    pub error: Option<String>,
}

/// An image attached to a prompt (base64 data URL payload, capability-gated
/// by the agent's `promptCapabilities.image`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImageInput {
    pub data: String,
    pub mime_type: String,
}

/// A queued message waiting for the thread's active run to finish.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub id: String,
    pub thread_id: String,
    pub instance_id: String,
    pub text: String,
    pub images: Vec<ImageInput>,
    pub created_at: i64,
}
