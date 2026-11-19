//! App-level event model (§4.2). The UI consumes these over IPC, the store
//! persists them append-only, and drivers normalize wire-level ACP messages
//! (see `protocol/`) into them. Unknown wire variants never become events.

use serde::{Deserialize, Serialize};

use crate::protocol::types::{deserialize_config_options, SessionConfigOption};

/// Execution status of a tool call (mirrors ACP `ToolCallStatus`).
pub const TOOL_STATUSES: [&str; 4] = ["pending", "in_progress", "completed", "failed"];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlanEntryStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    pub content: String,
    pub status: PlanEntryStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub option_id: String,
    pub name: String,
    /// ACP `PermissionOptionKind`: allow_once | allow_always | reject_once | reject_always.
    pub kind: String,
}

/// One slash command the agent advertised (`available_commands_update`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandInfo {
    pub name: String,
    pub description: String,
    /// Raw ACP `AvailableCommandInput` passthrough (schema hint shape, M6 UI).
    pub input: Option<serde_json::Value>,
}

/// Normalized, app-owned event stream.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    content = "payload",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum EventKind {
    UserMessage {
        text: String,
        /// Attached images (base64 data, mimeType) — composer chips.
        images: Vec<crate::store::records::ImageInput>,
    },
    AgentMessageDelta {
        delta: String,
    },
    AgentThoughtDelta {
        delta: String,
        /// Start of a coalesced thought block. `threads_get` merges back-to-back
        /// deltas of one run, so the merged event keeps the block's first
        /// timestamp here while `ts` stays the last one — the UI shows the real
        /// duration instead of 0 s. Absent on rows written before coalescing.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        started_at: Option<i64>,
    },
    ToolCall {
        tool_call_id: String,
        title: String,
        /// ACP `ToolKind`: read | edit | delete | move | search | execute | think | fetch |
        /// switch_mode | other.
        kind: String,
        status: String,
        locations: Vec<String>,
        raw_input: Option<serde_json::Value>,
        /// ACP `_meta` passthrough: provider-native subagent hints live here.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        meta: Option<serde_json::Value>,
    },
    ToolCallUpdate {
        tool_call_id: String,
        status: Option<String>,
        content: Option<serde_json::Value>,
        raw_output: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        meta: Option<serde_json::Value>,
    },
    Plan {
        entries: Vec<PlanEntry>,
    },
    ApprovalRequest {
        request_id: String,
        tool_call_id: Option<String>,
        title: String,
        options: Vec<PermissionOption>,
    },
    ApprovalResponse {
        request_id: String,
        option_id: Option<String>,
        /// True when the permission policy resolved this without the UI
        /// (§5.5: auto modes trace every resolution, never silent).
        #[serde(default)]
        auto: bool,
    },
    ModeChange {
        mode_id: String,
    },
    Notice {
        level: String,
        message: String,
    },
    /// Agent-requested input (elicitation/create): form schema or URL mode,
    /// raw detail — the UI renders the modal from it.
    ElicitationRequest {
        message: String,
        detail: serde_json::Value,
    },
    /// Slash commands the agent can execute (composer menu data source).
    CommandsUpdate {
        commands: Vec<CommandInfo>,
    },
    /// Partial session metadata; `title: Some` renames the thread in the store.
    SessionInfo {
        title: Option<String>,
    },
    /// The full session config option set (model, thought level, toggles...).
    ConfigOptions {
        #[serde(default, deserialize_with = "deserialize_config_options")]
        options: Vec<SessionConfigOption>,
    },
    /// Context compaction lifecycle. `status: Some` transitions the divider;
    /// `summary_replace` (update patch, `Some("")` clears) and `summary_append`
    /// (chunk) carry the user-displayable summary text.
    Compaction {
        status: Option<String>,
        compaction_id: Option<String>,
        summary_replace: Option<String>,
        summary_append: Option<String>,
    },
    Usage {
        detail: serde_json::Value,
    },
    /// A file the agent changed through the fs callbacks: unified diff for
    /// the "Changed files" projection (§5.4).
    FileChanged {
        path: String,
        diff: String,
        added: u64,
        removed: u64,
    },
    /// App-owned orchestration: a delegated child thread/run was created.
    SubagentSpawned {
        task_id: String,
        child_thread_id: String,
        child_run_id: Option<String>,
        title: String,
        role: Option<String>,
        target_instance_id: String,
        target_model: Option<String>,
        isolation: String,
    },
    /// Live status/tool preview for an inline subagent card.
    SubagentUpdated {
        task_id: String,
        status: String,
        child_run_id: Option<String>,
        active_tool_title: Option<String>,
        pending_request_title: Option<String>,
    },
    /// Terminal result of a delegated task.
    SubagentFinished {
        task_id: String,
        status: String,
        summary: Option<String>,
        error: Option<String>,
        duration_ms: Option<u64>,
        usage: Option<serde_json::Value>,
    },
    /// `error` carries the failure detail for crashed runs (diagnostics UI).
    RunFinished {
        stop_reason: String,
        #[serde(default)]
        error: Option<String>,
    },
}

/// Per-turn latency telemetry (in-memory only; emitted as `run:timing`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunTiming {
    pub run_id: String,
    pub thread_id: String,
    pub instance_id: String,
    pub pooled: bool,
    pub spawn_ms: u64,
    pub handshake_ms: u64,
    pub session_ms: u64,
    pub config_ms: u64,
    pub prompt_ms: u64,
    pub first_delta_ms: Option<u64>,
    pub total_ms: u64,
}

/// Targeted capability refresh emitted only when a cache entry changed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapsPayload {
    pub instance_id: String,
    pub prompt_image: bool,
    pub load_session: bool,
    /// Agent accepts live `_session/steering` messages mid-turn.
    #[serde(default)]
    pub steering_supported: bool,
    pub modes: Vec<crate::protocol::types::SessionMode>,
    pub config_options: Vec<SessionConfigOption>,
    pub auth_methods: Vec<crate::protocol::types::AuthMethod>,
    pub auth_hint: Option<String>,
}

/// Batch of run events fanned out as one Tauri event (streaming coalescing).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunEventsPayload {
    pub run_id: String,
    pub events: Vec<Event>,
}

/// One persisted event: app ids are primary; seq is per-run and append-only.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    pub run_id: String,
    pub seq: u64,
    pub ts: i64,
    #[serde(flatten)]
    pub kind: EventKind,
}

impl Event {
    /// Deterministic id: unique per run, stable across persistence round-trips.
    pub fn new(run_id: impl Into<String>, seq: u64, kind: EventKind) -> Self {
        let run_id = run_id.into();
        Self {
            id: format!("{run_id}-{seq}"),
            run_id,
            seq,
            ts: now_millis(),
            kind,
        }
    }
}

pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Collapses back-to-back text deltas of one run into a single event.
///
/// The transcript reducer appends every delta to the trailing block, so a long
/// thread ends up with a few thousand rows no matter how many deltas arrived
/// (55 036 events on disk fold into 2 771 rows). Shipping the deltas one by one
/// costs a serialization pass and an IPC object per chunk for text the UI glues
/// together anyway.
///
/// A merged event keeps the last `id`/`seq`/`ts` of its block — so a late
/// redelivery of the newest delta still dedupes against it — and carries the
/// block start in `started_at` for thought blocks.
///
/// `events` must be in transcript order (run `idx`, then `seq`). The run in
/// `skip_run` — the thread's live run — is left untouched: its deltas are still
/// arriving, and a merged event there would hide the ids a live batch dedupes
/// against. Returns the number of events merged away; idempotent.
pub fn coalesce_delta_events(events: &mut Vec<Event>, skip_run: Option<&str>) -> usize {
    let mut out: Vec<Event> = Vec::with_capacity(events.len());
    let mut merged = 0usize;
    for event in events.drain(..) {
        if skip_run == Some(event.run_id.as_str()) {
            out.push(event);
            continue;
        }
        let keeps_text_flow = out
            .last_mut()
            .is_some_and(|prev| merge_delta_into(prev, &event));
        if keeps_text_flow {
            merged += 1;
        } else {
            out.push(event);
        }
    }
    *events = out;
    merged
}

/// Folds `next` into `prev` when both are the same kind of text delta of one
/// run and directly adjacent. Returns false when the pair is not mergeable.
fn merge_delta_into(prev: &mut Event, next: &Event) -> bool {
    if prev.run_id != next.run_id || prev.seq.checked_add(1) != Some(next.seq) {
        return false;
    }
    match (&mut prev.kind, &next.kind) {
        (EventKind::AgentMessageDelta { delta: into }, EventKind::AgentMessageDelta { delta }) => {
            into.push_str(delta);
        }
        (
            EventKind::AgentThoughtDelta {
                delta: into,
                started_at,
            },
            EventKind::AgentThoughtDelta {
                delta,
                started_at: next_start,
            },
        ) => {
            // The first merge pins the block start; later ones keep it. Reading
            // `prev.ts` here is still the block's first timestamp.
            let block_start = (*started_at).or(*next_start).unwrap_or(prev.ts);
            into.push_str(delta);
            *started_at = Some(block_start);
        }
        _ => return false,
    }
    prev.id = next.id.clone();
    prev.seq = next.seq;
    prev.ts = next.ts;
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_serializes_with_kind_tag_and_camel_case_fields() {
        let e = Event::new(
            "run-1",
            3,
            EventKind::ToolCall {
                tool_call_id: "t1".into(),
                title: "Read file".into(),
                kind: "read".into(),
                status: "in_progress".into(),
                locations: vec!["/repo/src/main.rs".into()],
                raw_input: None,
                meta: None,
            },
        );
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "tool_call");
        assert_eq!(v["payload"]["toolCallId"], "t1");
        assert_eq!(v["payload"]["rawInput"], serde_json::Value::Null);
        assert_eq!(v["runId"], "run-1");
        assert_eq!(v["seq"], 3);
        assert_eq!(v["id"], "run-1-3");
        let back: Event = serde_json::from_value(v).unwrap();
        assert_eq!(back, e);
    }

    #[test]
    fn event_kind_tags_are_snake_case() {
        assert_eq!(
            serde_json::to_value(EventKind::AgentMessageDelta { delta: "x".into() }).unwrap()
                ["kind"],
            "agent_message_delta"
        );
        assert_eq!(
            serde_json::to_value(EventKind::AgentThoughtDelta {
                delta: "x".into(),
                started_at: None,
            })
            .unwrap()["kind"],
            "agent_thought_delta"
        );
        assert_eq!(
            serde_json::to_value(EventKind::RunFinished {
                stop_reason: "end_turn".into(),
                error: None
            })
            .unwrap()["kind"],
            "run_finished"
        );
    }

    fn thought(run_id: &str, seq: u64, ts: i64, delta: &str) -> Event {
        let mut event = Event::new(
            run_id,
            seq,
            EventKind::AgentThoughtDelta {
                delta: delta.into(),
                started_at: None,
            },
        );
        event.ts = ts;
        event
    }

    fn message(run_id: &str, seq: u64, ts: i64, delta: &str) -> Event {
        let mut event = Event::new(
            run_id,
            seq,
            EventKind::AgentMessageDelta {
                delta: delta.into(),
            },
        );
        event.ts = ts;
        event
    }

    #[test]
    fn coalesce_merges_consecutive_thought_deltas() {
        let mut events = vec![
            thought("run-1", 0, 100, "a"),
            thought("run-1", 1, 150, "b"),
            thought("run-1", 2, 200, "c"),
        ];
        assert_eq!(coalesce_delta_events(&mut events, None), 2);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "run-1-2");
        assert_eq!(events[0].seq, 2);
        assert_eq!(events[0].ts, 200, "block end stays the last delta's ts");
        match &events[0].kind {
            EventKind::AgentThoughtDelta { delta, started_at } => {
                assert_eq!(delta, "abc");
                assert_eq!(*started_at, Some(100), "block start is the first delta");
            }
            other => panic!("unexpected kind: {other:?}"),
        }
    }

    #[test]
    fn coalesce_keeps_runs_gaps_and_kinds_apart() {
        let mut events = vec![
            thought("run-1", 0, 100, "a"),
            thought("run-2", 1, 110, "b"), // other run
            thought("run-2", 3, 120, "c"), // seq gap
            message("run-2", 4, 130, "d"), // other kind
            thought("run-2", 5, 140, "e"),
        ];
        assert_eq!(coalesce_delta_events(&mut events, None), 0);
        assert_eq!(events.len(), 5);
    }

    #[test]
    fn coalesce_merges_message_deltas_without_a_start_timestamp() {
        let mut events = vec![message("run-1", 0, 100, "he"), message("run-1", 1, 120, "llo")];
        assert_eq!(coalesce_delta_events(&mut events, None), 1);
        assert_eq!(events[0].ts, 120);
        assert_eq!(
            serde_json::to_value(&events[0]).unwrap()["payload"],
            serde_json::json!({ "delta": "hello" }),
            "no startedAt field leaks into plain message deltas"
        );
    }

    #[test]
    fn coalesce_leaves_the_live_run_alone() {
        // The thread's live run still streams: its ids must stay one-per-event
        // so a redelivered batch keeps deduping against `appliedEvents`.
        let mut events = vec![
            thought("run-live", 0, 100, "a"),
            thought("run-live", 1, 110, "b"),
            thought("run-done", 0, 120, "c"),
            thought("run-done", 1, 130, "d"),
        ];
        assert_eq!(coalesce_delta_events(&mut events, Some("run-live")), 1);
        assert_eq!(events.len(), 3, "live run keeps both of its deltas");
        assert_eq!(events[0].id, "run-live-0");
        assert_eq!(events[1].id, "run-live-1");
        assert_eq!(events[2].id, "run-done-1");
    }

    #[test]
    fn coalesce_is_idempotent() {
        let mut events = vec![
            thought("run-1", 0, 100, "a"),
            thought("run-1", 1, 150, "b"),
            message("run-1", 2, 160, "x"),
            message("run-1", 3, 170, "y"),
            thought("run-1", 4, 200, "z"),
        ];
        coalesce_delta_events(&mut events, None);
        let once = events.clone();
        assert_eq!(coalesce_delta_events(&mut events, None), 0);
        assert_eq!(events, once);
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].ts, 150);
        assert_eq!(events[1].ts, 170);
    }
}
